/**
 * graph-router — task signature -> template scoring -> top-1 (SKELETON).
 *
 * Same contract as `@dsh/explore-mode/router`: deterministic, cached per turn,
 * hard filter before scoring, typed edges before embeddings, low confidence falls
 * back to the stock path.
 * @module @dsh/explore-loop/router
 */

/** Cordis plugin name; the row id is `graph-router`. */
export const name = 'graph-router'

/** Router reads the graph and the live tool inventory. */
export const inject = ['graphRegistry', 'tools']

const UNIMPLEMENTED = 'graph router skeleton: implement design/matching.ts before use'

/**
 * Provide `ctx.graphRouter` for the profile.
 * @param {import('@deepseek-ai/cordis').Context} ctx - host context.
 * @param {{confidenceThreshold?: number}} _config - row config.
 */
export function apply(ctx, _config) {
  const service = Object.freeze({
    match() { throw new Error(UNIMPLEMENTED) },
    describe() { return { digest: 'skeleton', threshold: _config?.confidenceThreshold ?? 0.55 } },
  })
  ctx.effect(() => ctx.provide('graphRouter', service), 'graph-router: service')
}
