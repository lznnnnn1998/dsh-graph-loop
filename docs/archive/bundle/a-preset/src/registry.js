/**
 * graph-registry — host-scoped capability-graph builder (SKELETON).
 *
 * Contract it must honour when implemented:
 *   - provide `ctx.graphRegistry`
 *   - build the graph from the LIVE registries (`ctx.tools` + `tools/change`,
 *     `ctx.systemPrompt`, `ctx.skills`, `ctx.agentPresets`, subagent providers),
 *     never from a frozen artifact
 *   - snapshot rebuild budget < 50 ms (P0 gate in research/lead-analysis.md §6)
 *   - expose `snapshot()`, `templates()`, `digest()`, `subscribe(listener)`
 *
 * The implementation lives in `design/matching.ts` + `design/registry` (see
 * design/example-graph.yaml for the document schema).
 * @module @dsh/explore-mode/registry
 */

/** Cordis plugin name; the row id is `graph-registry`. */
export const name = 'graph-registry'

/** Live registries the graph folds over. `sessions` is optional (co-occurrence mining). */
export const inject = ['tools', 'systemPrompt']

/** The service shape `ctx.graphRegistry` must satisfy. */
const UNIMPLEMENTED = 'graph registry skeleton: implement design/matching.ts + registry before use'

/**
 * Provide `ctx.graphRegistry` for the profile.
 * @param {import('@deepseek-ai/cordis').Context} ctx - host context.
 * @param {{document?: string, snapshotTtlMs?: number, includeMcpResources?: boolean}} _config - row config.
 */
export function apply(ctx, _config) {
  const service = Object.freeze({
    /** @returns {never} always throws until implemented. */
    snapshot() { throw new Error(UNIMPLEMENTED) },
    /** @returns {never} always throws until implemented. */
    templates() { throw new Error(UNIMPLEMENTED) },
    /** @returns {never} always throws until implemented. */
    digest() { throw new Error(UNIMPLEMENTED) },
    /** @returns {() => void} no-op unsubscribe. */
    subscribe() { return () => {} },
  })
  ctx.effect(() => ctx.provide('graphRegistry', service), 'graph-registry: service')
}
