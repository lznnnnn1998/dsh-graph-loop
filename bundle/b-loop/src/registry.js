/**
 * graph-registry — host-scoped capability-graph builder (SKELETON).
 *
 * Same contract as `@dsh/explore-mode/registry`: provide `ctx.graphRegistry`, build
 * from the live registries (`ctx.tools` + `tools/change`, `ctx.systemPrompt`,
 * `ctx.skills`, `ctx.agentPresets`, subagent providers), snapshot rebuild < 50 ms.
 * In a release both bundles depend on one `@dsh/graph-core`; the skeletons stay
 * dependency-free on purpose so they install and dump offline.
 * @module @dsh/explore-loop/registry
 */

/** Cordis plugin name; the row id is `graph-registry`. */
export const name = 'graph-registry'

/** Live registries the graph folds over. */
export const inject = ['tools', 'systemPrompt']

const UNIMPLEMENTED = 'graph registry skeleton: implement design/matching.ts before use'

/**
 * Provide `ctx.graphRegistry` for the profile.
 * @param {import('@deepseek-ai/cordis').Context} ctx - host context.
 * @param {{document?: string, snapshotTtlMs?: number}} _config - row config.
 */
export function apply(ctx, _config) {
  const service = Object.freeze({
    snapshot() { throw new Error(UNIMPLEMENTED) },
    templates() { throw new Error(UNIMPLEMENTED) },
    digest() { throw new Error(UNIMPLEMENTED) },
    subscribe() { return () => {} },
  })
  ctx.effect(() => ctx.provide('graphRegistry', service), 'graph-registry: service')
}
