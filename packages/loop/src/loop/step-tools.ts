/** Per-step tool admission and node-intent rules shared by the graph loop. */

import type { ResolvedToolSet, ToolDefinition } from '@deepseek-ai/dsh-tools'

/** Tools whose successful call is the mutation the node exists to perform. */
const MUTATION_TOOLS = new Set(['write', 'edit', 'str_replace_editor', 'apply_patch', 'multi_edit'])

/** Shells can mutate too, but only on a node that is asked to mutate. */
const SHELL_TOOLS = new Set(['bash', 'pwsh'])

/** A stage word appears in the node id or its instruction. */
const MUTATION_STAGE = /(?:^|[_\s:/-])(?:mutate|mutation|edit|write|patch|apply)(?=$|[_\s:/-])/iu

/**
 * Shell commands that mutate the workspace. Plain `>` is excluded when it only
 * discards output; every other redirect writes a file.
 */
const MUTATION_COMMAND = /(?:^|[\s;&|])(?:mv|rm|mkdir|cp|tee|truncate|dd)\s|sed\s+-i|perl\s+-pi|>(?!\s*(?:\/dev\/null|&))|open\([^)]*['"]w/u

/**
 * Structural subset of `PlanNode` that decides whether a node must mutate.
 * Kept local so this module stays independent of the schema package.
 */
export interface NodeIntent {
  readonly id: string
  readonly kind?: string
  readonly capabilityId?: string
  readonly instruction?: string
  readonly toolAllow?: readonly string[]
}

/** One executed tool call as the loop records it for the node outcome. */
export interface StepTool {
  readonly name: string
  readonly isError: boolean
  readonly arguments?: string
}

/** Called once per admission when a non-empty plan universe admits no visible tool. */
export type EmptyAdmissionHandler = (visible: readonly string[]) => void

/**
 * Narrow the step's admitted tool set to the active node's tools.
 *
 * The plan already decided which capabilities are relevant; keeping the full
 * schema surface in every request would charge the graph for tools it cannot
 * use and would defeat the per-turn token win. An intersection that resolves to
 * nothing stays empty: widening back to the full preset would silently undo the
 * plan's narrowing (a stale plan is a routing bug to report, not to paper over).
 * A terminal node with an explicit empty `toolAllow` is answer-only, so its
 * empty admission is the intended result, not a resolution failure.
 *
 * @param base - the turn's resolved tool admission.
 * @param allowed - tool names the plan and node admit.
 * @param onEmpty - reports the visible set once when the intersection is empty.
 * @returns a view that exposes only `allowed` names, never the full preset.
 */
export function restrictToolSet(
  base: ResolvedToolSet,
  allowed: ReadonlySet<string>,
  onEmpty?: EmptyAdmissionHandler,
): ResolvedToolSet {
  let reported = false
  return {
    dispose: () => base.dispose(),
    view: (scope) => {
      const visible = base.view(scope)
      const filtered = new Map<string, ToolDefinition>()
      for (const [name, definition] of visible) {
        if (allowed.has(name)) filtered.set(name, definition)
      }
      if (filtered.size === 0 && visible.size > 0 && !reported) {
        reported = true
        onEmpty?.([...visible.keys()])
      }
      return filtered
    },
  }
}

/**
 * Whether the node's job is a mutation. Derived from the node itself rather
 * than a hardcoded id so the dynamic (`d_edit`) and composed (`n_mutate`)
 * synthesizers are treated alike:
 *
 * - a declared mutation capability (`tool:write`, `tool:edit`, ...),
 * - a mutation tool in the node's allowlist,
 * - a mutation stage word in the node id, or
 * - a shell node whose instruction asks for a change.
 *
 * A verification shell node (`d_verify`, `n_verify`) is deliberately not a
 * mutation: retrying it as one would tell the model not to run more checks.
 * @param node - the active plan node (structural subset).
 * @returns true when the node must produce a workspace mutation.
 */
export function isMutatingNode(node: NodeIntent): boolean {
  const capability = (node.capabilityId ?? '').toLowerCase()
  if (MUTATION_TOOLS.has(capability.slice(capability.lastIndexOf(':') + 1))) return true
  const tools = node.toolAllow ?? []
  if (tools.some(name => MUTATION_TOOLS.has(name))) return true
  if (MUTATION_STAGE.test(node.id)) return true
  return tools.some(name => SHELL_TOOLS.has(name)) && MUTATION_STAGE.test(node.instruction ?? '')
}

/**
 * Whether any successful tool call mutated the workspace.
 * @param tools - the step's recorded tool calls.
 * @returns true when a writer tool ran, or a shell call contained a mutating command.
 */
export function mutationObserved(tools: readonly StepTool[]): boolean {
  return tools.some(tool => !tool.isError && (
    MUTATION_TOOLS.has(tool.name)
    || (SHELL_TOOLS.has(tool.name) && MUTATION_COMMAND.test(tool.arguments ?? ''))
  ))
}

/**
 * Verification tools whose lone failed call fails the step's graph node. The
 * pair is a default, not a hardcoded rule: a deployment with differently named
 * shells overrides it through `AgentLoop.Config.shellTools`.
 */
export const DEFAULT_SHELL_TOOLS: readonly string[] = ['bash', 'pwsh']

/**
 * The failed tool name when that error belongs to a configured verification
 * tool. A step that calls such a tool, gets an error, and then makes no other
 * tool call is a failed node even though every call was answered; any other
 * tool's error still lets the step succeed when it completed.
 * @param name - the failed call's tool name, from the step's `tool/call` event.
 * @param shellTools - configured verification tool names.
 * @returns the name to report as `failedTool`, or `undefined` when the tool is
 * not a configured verification tool.
 */
export function shellFailureTool(name: string | undefined, shellTools: ReadonlySet<string>): string | undefined {
  return name !== undefined && shellTools.has(name) ? name : undefined
}
