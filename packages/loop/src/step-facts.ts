/**
 * step-facts.ts — project one DSH step's observed tool calls into router state.
 *
 * The graph router must decide on what actually happened, not on which node the
 * plan intended to run. This reducer is deliberately generic: tool names and
 * argument names cover the filesystem tools the registry exposes today; an
 * unknown tool still contributes `hadToolCall` / per-tool success facts.
 * @module dsh-graph-loop/step-facts
 */

import { LOCATOR_PARAMETER_NAMES, type EvidenceCall } from 'dsh-graph-loop-core/condition'
import type { ArtifactType, Json, RegistryNode } from 'dsh-graph-loop-core/graph-schema'
import { DEFAULT_SHELL_TOOLS, mutationObserved, readObserved } from './loop/step-tools.ts'

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

/** Declared locator-parameter values carried by one call's arguments. */
function locatorValues(
  args: Record<string, unknown> | undefined,
  declared: readonly string[],
): string[] {
  if (args === undefined) return []
  const values: string[] = []
  for (const name of declared) {
    if (!LOCATOR_PARAMETER_NAMES.includes(name)) continue
    const value = args[name]
    if (typeof value === 'string' && value.length > 0) values.push(value)
  }
  return values
}

/** Artifact type a path's extension declares; the world-diff source uses it too. */
export function artifactTypeFor(path: string): ArtifactType {
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
 *
 * `channelRefused` is the one fact a terminal admission refusal writes: the step
 * completed, but a call was rejected before dispatch, so a guard can tell a
 * refused answer from an admitted one without reading any text.
 */
export function deriveStepFacts(
  tools: readonly ObservedTool[],
  ok: boolean,
  failedTool?: string,
  shellTools: ReadonlySet<string> = new Set(DEFAULT_SHELL_TOOLS),
  refused = false,
): Record<string, Json> {
  let exitFailure = false
  for (const tool of tools) {
    // An exit status belongs to a process. A `read`/`grep`/`web_fetch` result is
    // text that may quote a `[exit code: 1]` from a log; scanning every tool let
    // that text fail a verification step whose own shell exited 0.
    if (!shellTools.has(tool.name) && tool.name !== 'run_code') continue
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
    // Always written: a refused call is not a tool call, so the step still
    // completed; the fact lets a plan route on admission without text inspection.
    channelRefused: refused,
  }
  // Per-tool facts are step-scoped. Write both keys for every tool this step
  // called (false `failed` too), and make `.ok` mean "every call to it
  // succeeded": a fail-then-succeed sequence must not leave `.failed=true`,
  // and a later step's unrelated call must not inherit an earlier failure.
  const perTool = new Map<string, { ok: boolean; failed: boolean }>()
  for (const tool of tools) {
    const entry = perTool.get(tool.name) ?? { ok: true, failed: false }
    entry.ok = entry.ok && !tool.isError
    entry.failed = entry.failed || tool.isError
    perTool.set(tool.name, entry)
  }
  let failed = 0
  for (const tool of tools) {
    if (tool.isError) failed += 1
  }
  for (const [name, entry] of perTool) {
    facts[`tool.${name}.ok`] = entry.ok
    facts[`tool.${name}.failed`] = entry.failed
  }
  facts['failedToolCount'] = failed
  facts['allToolsFailed'] = tools.length > 0 && failed === tools.length
  // Effects come from ONE classifier shared with the retry guards
  // (`loop/step-tools.ts`): a successful writer tool or a mutating shell writes,
  // a successful reader tool or a reading shell reads. Two classifiers made the
  // graph route on the narrower one — a shell `cat > f`, `cp`, `sed -i` was a
  // real mutation the graph reported as `wroteFile=false`.
  facts['wroteFile'] = mutationObserved(tools, shellTools)
  facts['readFile'] = readObserved(tools, shellTools)
  // "Some call was answered" is the weakest durable signal that the step did
  // anything at all; unlike `lastOk` it survives an unrelated failing call.
  facts['toolSucceeded'] = tools.some(tool => !tool.isError)
  return facts
}

/**
 * Project one step's calls into the evidence view a node's declared contract is
 * evaluated against. Only runtime-owned facts are represented: the call's
 * success, its own process exit status (when the tool reports one) and the
 * values of the node capability's *declared locator parameters*. The call's
 * free text is never projected -- a command that merely names an artifact path
 * is not evidence about it.
 */
export function deriveEvidenceCalls(
  tools: readonly ObservedTool[],
  shellTools: ReadonlySet<string> = new Set(DEFAULT_SHELL_TOOLS),
  locatorParameters: readonly string[] = [],
): EvidenceCall[] {
  return tools.map(tool => {
    // An exit status belongs to a process. A `read`/`grep`/`web_fetch` result is
    // text that may quote a `[exit code: 1]` from a log, so only shell-like
    // tools are exit-status authorities (same rule as `deriveStepFacts`).
    const reportsExit = shellTools.has(tool.name) || tool.name === 'run_code'
    let exitCode: number | undefined
    if (reportsExit && !tool.isError && tool.output !== undefined) {
      for (const match of tool.output.matchAll(/\[exit code:\s*(-?\d+)\]/gu)) {
        const code = Number(match[1])
        // Any reported status counts; a non-zero one makes the call unclean.
        if (exitCode === undefined || code !== 0) exitCode = code
        if (code !== 0) break
      }
    }
    const locators = locatorValues(parseArguments(tool.arguments), locatorParameters)
    return {
      tool: tool.name,
      ok: !tool.isError,
      ...(reportsExit ? { reportsExit } : {}),
      ...(exitCode === undefined ? {} : { exitCode }),
      ...(locators.length === 0 ? {} : { locators }),
    }
  })
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

/** A typed ref one step may have produced; the scheduler measures it in the world. */
export interface ArtifactCandidate {
  readonly type: ArtifactType
  readonly ref: string
}

/**
 * Typed refs this step may have produced; never file bodies.
 *
 * Two structural sources, both data-driven:
 *
 *   1. A successful filesystem mutation tool names the path it wrote (an
 *      equivalent tool may fill a stage, so the tool name is not gated).
 *   2. A read-only observation capability observes each typed locator argument
 *      it was called with (an inspect/read stage's output is the observed file).
 *
 * A declared artifact type with no path (a craft/MCP author returning its
 * output) yields no candidate: the runtime cannot measure it, so it cannot
 * certify the step. Nothing here trusts a tool's success as a world change --
 * the scheduler stats every candidate and keeps only refs that exist with
 * content.
 */
export function deriveStepArtifactCandidates(
  tools: readonly ObservedTool[],
  capability?: RegistryNode,
): ArtifactCandidate[] {
  const seen = new Set<string>()
  const candidates: ArtifactCandidate[] = []
  const add = (type: ArtifactType, ref: string): void => {
    const key = `${type}:${ref}`
    if (seen.has(key)) return
    seen.add(key)
    candidates.push({ type, ref })
  }
  for (const tool of tools) {
    if (tool.isError || !MUTATION_TOOLS.has(tool.name)) continue
    const path = pathFromArguments(parseArguments(tool.arguments))
    if (path !== undefined) add(artifactTypeFor(path), path)
  }
  // A read-only capability observes, it does not author: the file it read is
  // the artifact it leaves behind only when the runtime can measure it.
  const declaredTool = capability?.tool
  if (declaredTool !== undefined && declaredTool.permission === 'read-only') {
    const locatorParameters = declaredTool.parameterNames.filter(name => LOCATOR_PARAMETER_NAMES.includes(name))
    if (locatorParameters.length > 0) {
      for (const tool of tools) {
        if (tool.isError || tool.name !== declaredTool.name) continue
        for (const ref of locatorValues(parseArguments(tool.arguments), locatorParameters)) {
          add(artifactTypeFor(ref), ref)
        }
      }
    }
  }
  return candidates
}
