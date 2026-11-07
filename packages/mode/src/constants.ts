/**
 * Shared defaults and stable ids for the explore mode plugins.
 *
 * Plain data only: this module is imported by both `./policy.ts` (a Cordis plugin)
 * and `./reuse.ts` (pure scoring), so it must stay free of DSH imports.
 * @module dsh-graph-loop-mode/constants
 */

/**
 * Fallback node cycle for the preset's own policy text, used only when no host
 * graph driver is mounted. The policy section names the node for the current step;
 * when `graphRuntime` is present the loop owns node naming and the preset omits its
 * own cycle, so the model is never told two different current nodes.
 */
export const DEFAULT_NODES = Object.freeze(['inspect', 'plan', 'act', 'verify'])

/** Prompt section id contributed by `./policy.ts`. */
export const POLICY_SECTION = 'explore:policy'

/** Prompt context id carrying the idle Agent Teams roster. */
export const ROSTER_CONTEXT = 'explore:roster'

/**
 * Order of the roster context. Runtime contexts occupy 100–210; this one sorts after
 * them so the roster reads as the last piece of situational context in the request.
 */
export const ROSTER_CONTEXT_ORDER = 900

/**
 * Fallback prompt-section order when the registry cannot answer.
 * `TOOL_GUIDANCE` is not a section name in this DSH release; `TEAM_POLICY` (600) is
 * the policy slot, which is where a mode-level routing policy belongs.
 */
export const POLICY_SECTION_ORDER_FALLBACK = 600

/** One-line form of the policy section, kept well under a paragraph. */
export const POLICY_CONTEXT_SIZE = 800

/** The tool the duplicate-spawn guard inspects. */
export const GUARDED_TOOL = 'spawn_teammate'
