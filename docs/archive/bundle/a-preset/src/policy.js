/**
 * explore-policy — preset-scoped prompt contribution (SKELETON).
 *
 * Why a preset row instead of host code: a preset cannot mount the prompt registry
 * itself, so a preset can change an agent's tools but not its identity or its standing
 * instructions unless it contributes a section of its own
 * (packages/preset/persona/src/index.ts:1-16 — the same reason `@deepseek-ai/dsh-persona`
 * exists as a row).
 *
 * A section registered here is agent-scoped: it shadows the host section only for
 * sessions running the `explore` preset, and it is rendered by
 * `ctx.systemPrompt.assemble(context)` before `agent/pre-step`.
 * @module @dsh/explore-mode/policy
 */

/** Cordis plugin name; the child row id is `explore-policy`. */
export const name = 'explore-policy'

/** The prompt registry this row contributes to. */
export const inject = ['systemPrompt']

/** Section id contributed to the prompt (`explore:policy`). */
export const SECTION = 'explore:policy'

// No `Config` export in the skeleton: the shipped modules declare Config with
// `@deepseek-ai/schemastery`, which must then appear in peerDependencies — a bare
// import resolves from THIS package's node_modules, not from the installation. The
// real module declares `@deepseek-ai/schemastery` as a peer and validates here.
/**
 * Register the node-policy section for this preset's agent scope.
 * @param {import('@deepseek-ai/cordis').Context} ctx - preset scope context.
 * @param {{section: string}} config - policy prose.
 */
export function apply(ctx, config) {
  ctx.effect(() => ctx.systemPrompt.section({
    name: SECTION,
    // After the deployment persona, before tool-owned guidance. `getSectionOrder`
    // returns the numeric order registered for a host section name; an unknown
    // name must be handled by the implementation (see systemPrompt README).
    order: ctx.systemPrompt.getSectionOrder?.('TOOLS') ?? 100,
    text: config.section,
  }), 'explore-policy: section')
}
