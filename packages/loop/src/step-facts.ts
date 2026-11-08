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
import type { ArtifactType, Json } from 'dsh-graph-loop-core/graph-schema'

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
const READ_TOOLS = new Set(['read', 'read_image', 'glob', 'grep'])
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
 * normal result whose text carries `[exit code: N]`. Treat that as a failed
 * step so the verify -> repair exit actually fires on a failing test.
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
  const effectiveOk = ok && !exitFailure
  const facts: Record<string, Json> = {
    lastOk: effectiveOk,
    hadToolCall: tools.length > 0,
    toolCount: tools.length,
    verificationFailed: exitFailure,
  }
  if (failedTool !== undefined) facts['failedTool'] = failedTool
  let failed = 0
  let mutated = false
  let read = false
  for (const tool of tools) {
    if (tool.isError) failed += 1
    if (MUTATION_TOOLS.has(tool.name) && !tool.isError) mutated = true
    if (READ_TOOLS.has(tool.name) && !tool.isError) read = true
    facts[`tool.${tool.name}.ok`] = !tool.isError
    if (tool.isError) facts[`tool.${tool.name}.failed`] = true
  }
  facts['failedToolCount'] = failed
  facts['allToolsFailed'] = tools.length > 0 && failed === tools.length
  facts['wroteFile'] = mutated
  facts['readFile'] = read
  return facts
}

/**
 * Artifact refs produced by this step; never file bodies.
 *
 * Path extraction is a best-effort enrichment for the DSH filesystem tools. The
 * authoritative source is the plan node's registered capability: any tool that
 * declares `produces` (including third-party/MCP author tools) yields that
 * artifact type when the step succeeds. Without this second source, a generic
 * `artifact(...)` success guard can never fire for a craft/MCP author.
 */
export function deriveStepArtifacts(
  tools: readonly ObservedTool[],
  declaredTypes: readonly ArtifactType[] = [],
  refPrefix = 'step',
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
  if (tools.length > 0 && tools.some(tool => !tool.isError)) {
    for (const type of declaredTypes) add(type, `${refPrefix}:${type}`)
  }
  return artifacts
}
