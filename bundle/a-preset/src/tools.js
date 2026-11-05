/**
 * explore-tools — model-facing graph tools (SKELETON).
 *
 * Registers two read-mostly tools inside the `explore` preset:
 *   - `graph_status` : the last match, the active node, the budget left
 *   - `graph_plan`   : ask for a re-match / explicit template for this turn
 *
 * A tool is model-visible ⇒ logged: both must write their call/result through
 * `ctx.tools` (done by the executor) and must not smuggle instructions outside the
 * session log.
 *
 * The `defineTool` import is dynamic so this skeleton still mounts on a host whose
 * `@deepseek-ai/dsh-tools` export map differs: a failure to resolve degrades to a
 * warning instead of failing the preset mount.
 * @module @dsh/explore-mode/tools
 */

/** Cordis plugin name; the child row id is `explore-tools`. */
export const name = 'explore-tools'

/** Tool registry plus the kernel services the descriptions read. */
export const inject = ['tools']

/**
 * Register the graph tools when the tool runtime is available.
 * @param {import('@deepseek-ai/cordis').Context} ctx - preset scope context.
 */
export async function apply(ctx) {
  let defineTool
  try {
    ({ defineTool } = await import('@deepseek-ai/dsh-tools'))
  } catch {
    ctx.logger?.warn?.('explore-tools: @deepseek-ai/dsh-tools unavailable; graph tools not registered')
    return
  }
  if (typeof defineTool !== 'function') {
    ctx.logger?.warn?.('explore-tools: defineTool missing from @deepseek-ai/dsh-tools; graph tools not registered')
    return
  }

  ctx.effect(() => ctx.tools.register(defineTool({
    name: 'graph_status',
    description: 'Report the graph match for the current turn, the active node, and the remaining budget.',
    // Parameters/output stay empty until the kernel lands: a schema that promises
    // fields the skeleton cannot produce would be worse than no tool at all.
    parameters: {},
    async execute() {
      throw new Error('graph_status skeleton: implement graph runtime before exposing this tool')
    },
  })), 'explore-tools: graph_status')
}
