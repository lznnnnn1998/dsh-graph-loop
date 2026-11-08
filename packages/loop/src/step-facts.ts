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
 */
export function deriveStepFacts(tools: readonly ObservedTool[], ok: boolean, failedTool?: string): Record<string, Json> {
  const facts: Record<string, Json> = {
    lastOk: ok,
    hadToolCall: tools.length > 0,
    toolCount: tools.length,
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

/** Artifact refs produced by successful filesystem mutations; never file bodies. */
export function deriveStepArtifacts(tools: readonly ObservedTool[]): RoutingArtifact[] {
  const seen = new Set<string>()
  const artifacts: RoutingArtifact[] = []
  for (const tool of tools) {
    if (tool.isError || !MUTATION_TOOLS.has(tool.name)) continue
    const path = pathFromArguments(parseArguments(tool.arguments))
    if (path === undefined) continue
    const type = artifactTypeFor(path)
    const key = `${type}:${path}`
    if (seen.has(key)) continue
    seen.add(key)
    artifacts.push({ type, ref: path })
  }
  return artifacts
}
