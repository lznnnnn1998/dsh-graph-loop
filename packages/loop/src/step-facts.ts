/**
 * step-facts.ts — project one DSH step's observed tool calls into router state.
 *
 * The graph router must decide on what actually happened, not on which node the
 * plan intended to run. This reducer is deliberately generic: tool names and
 * argument names cover the filesystem tools the registry exposes today; an
 * unknown tool still contributes `hadToolCall` / per-tool success facts.
 * @module dsh-graph-loop/step-facts
 */

import type { RoutingArtifact } from 'dsh-graph-loop-core/condition'
import type { ArtifactType, Json, RegistryNode } from 'dsh-graph-loop-core/graph-schema'
import { mutationObserved, readObserved } from './loop/step-tools.ts'

/** One tool call as the agent loop reports it. */
export interface ObservedTool {
  readonly name: string
  readonly callId?: string
  readonly isError: boolean
  readonly arguments?: string
  /** Rendered tool result, used only for the `[exit code: N]` verification marker. */
  readonly output?: string
}

const MUTATION_TOOLS = new Set(['write', 'edit', 'str_replace_editor', 'multi_edit', 'apply_patch'])
const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg', '.bmp', '.tif', '.tiff'])
const PATCH_EXTENSIONS = new Set(['.patch', '.diff'])

function parseArguments(raw: string | undefined): Record<string, unknown> | undefined {
  if (raw === undefined) return undefined
  try {
    const parsed: unknown = JSON.parse(raw)
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : undefined
  } catch {
    return undefined
  }
}

function pathFromArguments(args: Record<string, unknown> | undefined): string | undefined {
  if (args === undefined) return undefined
  for (const key of ['file_path', 'filePath', 'path', 'target']) {
    const value = args[key]
    if (typeof value === 'string' && value.length > 0) return value
  }
  return undefined
}

function artifactTypeFor(path: string): ArtifactType {
  const lower = path.toLowerCase()
  const dot = lower.lastIndexOf('.')
  const extension = dot === -1 ? '' : lower.slice(dot)
  if (PATCH_EXTENSIONS.has(extension)) return 'file.patch'
  if (IMAGE_EXTENSIONS.has(extension)) return 'file.image'
  if (extension === '') return 'file.binary'
  return 'file.text'
}

/**
 * Fold tool outcomes into JSON facts. The `tool.<name>.ok` keys are stable
 * enough for plan guards; the aggregate keys keep simple plans simple.
 *
 * A shell that exits non-zero is not a tool-invocation error: DSH returns a
 * normal result whose text carries `[exit code: N]`. That is a *verification*
 * signal (`verificationFailed`), not a failed step: `lastOk` stays about tool
 * invocation so an inspect/mutate stage running `grep`/`diff` (exit 1) is not
 * sent to repair. The composed verify stage guards on `verificationRan` /
 * `verificationFailed`.
 *
 * Every fact here is step-scoped: `failedTool` is written on every step (false
 * when the step named no failing tool) so a stale tool name from an earlier step
 * cannot match a later `callFailed(<tool>)` guard, and `verificationRan` /
 * `verificationFailed` are both always present so the verify stage can classify
 * "ran and failed", "ran and passed" and "did not run" separately.
 *
 * `wroteFile` / `readFile` are not name sets: both delegate to `loop/step-tools.ts`
 * so the graph, the composer's stage guards and the benchmark retry agree on what
 * a mutation is, including shell writes and shell reads.
 */
export function deriveStepFacts(tools: readonly ObservedTool[], ok: boolean, failedTool?: string): Record<string, Json> {
  let exitFailure = false
  for (const tool of tools) {
    if (tool.isError || tool.output === undefined) continue
    for (const match of tool.output.matchAll(/\[exit code:\s*(-?\d+)\]/gu)) {
      if (Number(match[1]) !== 0) {
        exitFailure = true
        break
      }
    }
    if (exitFailure) break
  }
  const facts: Record<string, Json> = {
    lastOk: ok,
    hadToolCall: tools.length > 0,
    toolCount: tools.length,
    // "A tool was invoked" is the strongest cross-tool signal that a
    // verification step actually performed work: the verify stage may be filled
    // by `bash`, `pwsh` or a third-party verifier, so the composer cannot guard
    // on one tool name.
    verificationRan: tools.length > 0,
    verificationFailed: exitFailure,
    // Always written (false = no named failing tool) so a stale `failedTool`
    // from a previous step cannot satisfy a later `callFailed` guard.
    failedTool: failedTool ?? false,
  }
  let failed = 0
  for (const tool of tools) {
    if (tool.isError) failed += 1
    facts[`tool.${tool.name}.ok`] = !tool.isError
    if (tool.isError) facts[`tool.${tool.name}.failed`] = true
  }
  facts['failedToolCount'] = failed
  facts['allToolsFailed'] = tools.length > 0 && failed === tools.length
  // Effects come from ONE classifier shared with the benchmark retry
  // (`loop/step-tools.ts`): a successful writer tool or a mutating shell writes,
  // a successful reader tool or a reading shell reads. Two classifiers made the
  // graph route on the narrower one — a shell `cat > f`, `cp`, `sed -i` was a
  // real mutation the graph reported as `wroteFile=false` (audit 2026-11-09 §4.2).
  facts['wroteFile'] = mutationObserved(tools)
  facts['readFile'] = readObserved(tools)
  // "Some call was answered" is the weakest durable signal that the step did
  // anything at all; unlike `lastOk` it survives an unrelated failing call.
  facts['toolSucceeded'] = tools.some(tool => !tool.isError)
  return facts
}

/**
 * Aggregate facts for a planned capability whose tool name is not one of the
 * DSH names the reducer knows.
 *
 * `deriveStepFacts` classifies by the shared effect classifier (`read`/`grep`/
 * shell readers read, `write`/`edit`/shell mutations write). A composed inspect
 * or mutate stage can be filled by a third-party or
 * MCP tool, so the capability's own contract supplies the same step-scoped
 * signal when *that* tool ran successfully: a read-only filesystem producer
 * counts as reading, and a `mutation`-tagged tool counts as writing. Without
 * this, a composed stage filled by anything but the core tools could never
 * satisfy its success guard.
 */
export function deriveCapabilityFacts(
  tools: readonly ObservedTool[],
  capability: RegistryNode | undefined,
): Record<string, Json> {
  const tool = capability?.tool
  if (capability === undefined || tool === undefined) return {}
  if (!tools.some(candidate => candidate.name === tool.name && !candidate.isError)) return {}
  const produces = capability.produces.map(spec => spec.type)
  const facts: Record<string, Json> = {}
  if (tool.permission === 'read-only'
    && (capability.tags.includes('filesystem') || produces.includes('file.text') || produces.includes('file.image'))) {
    facts['readFile'] = true
  }
  if (capability.tags.includes('mutation')) facts['wroteFile'] = true
  return facts
}

/**
 * Artifact refs produced by this step; never file bodies.
 *
 * Path extraction is a best-effort enrichment for the DSH filesystem tools. The
 * authoritative source is the plan node's registered capability: a tool that
 * declares `produces` (including third-party/MCP author tools) yields that
 * artifact type when the planned tool itself ran successfully. Without this
 * second source, a generic `artifact(...)` success guard can never fire for a
 * craft/MCP author; without the planned-tool check, any unrelated successful
 * call in the step would fake the artifact.
 */
export function deriveStepArtifacts(
  tools: readonly ObservedTool[],
  declaredTypes: readonly ArtifactType[] = [],
  refPrefix = 'step',
  realizedBy?: string,
): RoutingArtifact[] {
  const seen = new Set<string>()
  const artifacts: RoutingArtifact[] = []
  const add = (type: ArtifactType, ref: string): void => {
    const key = `${type}:${ref}`
    if (seen.has(key)) return
    seen.add(key)
    artifacts.push({ type, ref })
  }
  for (const tool of tools) {
    if (tool.isError || !MUTATION_TOOLS.has(tool.name)) continue
    const path = pathFromArguments(parseArguments(tool.arguments))
    if (path !== undefined) add(artifactTypeFor(path), path)
  }
  // The declared contract belongs to the planned capability's tool. A step that
  // only called something else (a read, a probe) did not produce that artifact.
  const realized = tools.some(tool => !tool.isError && (realizedBy === undefined || tool.name === realizedBy))
  if (realized) {
    for (const type of declaredTypes) add(type, `${refPrefix}:${type}`)
  }
  return artifacts
}
