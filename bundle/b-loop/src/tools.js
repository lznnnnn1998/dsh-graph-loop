/**
 * graph-tools — model-facing graph tools at host scope (SKELETON).
 *
 * Host-scoped because this bundle drives every session in its profile; the
 * control-plane bundle registers the same tools inside its preset instead, so they
 * exist only for explore-mode sessions.
 * @module @dsh/explore-loop/tools
 */

/** Cordis plugin name; the row id is `graph-tools`. */
export const name = 'graph-tools'

/** Tool registry plus the kernel service the descriptions read. */
export const inject = ['tools', 'graphRuntime']

/**
 * Register `graph_status` when the tool runtime is available.
 * @param {import('@deepseek-ai/cordis').Context} ctx - host context.
 */
export async function apply(ctx) {
  let defineTool
  try {
    ({ defineTool } = await import('@deepseek-ai/dsh-tools'))
  } catch {
    ctx.logger?.warn?.('graph-tools: @deepseek-ai/dsh-tools unavailable; graph tools not registered')
    return
  }
  if (typeof defineTool !== 'function') {
    ctx.logger?.warn?.('graph-tools: defineTool missing; graph tools not registered')
    return
  }
  ctx.effect(() => ctx.tools.register(defineTool({
    name: 'graph_status',
    description: 'Report the graph match for the current turn, the active node, and the remaining budget.',
    parameters: {},
    async execute() {
      throw new Error('graph_status skeleton: implement graph runtime before exposing this tool')
    },
  })), 'graph-tools: graph_status')
}
