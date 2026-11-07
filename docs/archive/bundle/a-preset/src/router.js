/**
 * graph-router — task signature -> template scoring -> top-1 (SKELETON).
 *
 * Contract it must honour when implemented:
 *   - provide `ctx.graphRouter`
 *   - input: a task signature (intent class, artifact types, surfaces, risk,
 *     context size, workspace facts) plus the registry digest
 *   - pipeline: hard filter (available/permitted/tool owner present) -> score
 *     declared templates -> top-1, or `fallback` when below
 *     `confidenceThreshold`
 *   - deterministic, cached per turn, every decision logged
 *   - NEVER embedding-only: typed edges first, features second, embeddings may
 *     only break `alternative` ties
 * @module @dsh/explore-mode/router
 */

/** Cordis plugin name; the row id is `graph-router`. */
export const name = 'graph-router'

/** Router reads the graph and the live tool inventory. */
export const inject = ['graphRegistry', 'tools']

const UNIMPLEMENTED = 'graph router skeleton: implement design/matching.ts before use'

/**
 * Provide `ctx.graphRouter` for the profile.
 * @param {import('@deepseek-ai/cordis').Context} ctx - host context.
 * @param {{confidenceThreshold?: number, fallbackOnLowConfidence?: boolean}} _config - row config.
 */
export function apply(ctx, _config) {
  const service = Object.freeze({
    /** @returns {never} always throws until implemented. */
    match() { throw new Error(UNIMPLEMENTED) },
    /** @returns {{digest: string, threshold: number}} router identity. */
    describe() {
      return { digest: 'skeleton', threshold: _config?.confidenceThreshold ?? 0.55 }
    },
  })
  ctx.effect(() => ctx.provide('graphRouter', service), 'graph-router: service')
}
