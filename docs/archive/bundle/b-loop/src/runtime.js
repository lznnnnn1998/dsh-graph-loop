/**
 * graph-runtime — node execution, replan points and budget (SKELETON).
 *
 * With this bundle the graph runtime is *inside* the driver: node transitions are
 * step boundaries of the loop it replaces. Keep the same seam split as the
 * control-plane variant (`@dsh/explore-mode/runtime`) so a run can be compared
 * across both modes.
 * @module @dsh/explore-loop/runtime
 */

/** Cordis plugin name; the row id is `graph-runtime`. */
export const name = 'graph-runtime'

/** Kernel services plus the registries a run reads. */
export const inject = ['graphRegistry', 'graphRouter', 'agents', 'tools', 'systemPrompt']

const UNIMPLEMENTED = 'graph runtime skeleton: implement design/runtime.ts + kernel.ts before use'

/**
 * Provide `ctx.graphRuntime` for the profile.
 * @param {import('@deepseek-ai/cordis').Context} ctx - host context.
 * @param {{mode?: string, nodeExecutor?: string, maxReplans?: number, budget?: object}} _config - row config.
 */
export function apply(ctx, _config) {
  const service = Object.freeze({
    start() { throw new Error(UNIMPLEMENTED) },
    status() { throw new Error(UNIMPLEMENTED) },
  })
  ctx.effect(() => ctx.provide('graphRuntime', service), 'graph-runtime: service')
}
