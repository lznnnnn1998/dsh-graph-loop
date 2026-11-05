/**
 * graph-runtime — node execution, replan points and budget (SKELETON).
 *
 * Contract it must honour when implemented:
 *   - provide `ctx.graphRuntime`
 *   - attach per-agent graph state on `agent/created` for agents whose preset is
 *     `explore` (`ctx.agentPresets.presetForSession(agent.session) === 'explore'`)
 *   - apply node policy in `agent/pre-step` (prompt/developer messages only; the
 *     step's tool set is already resolved there —
 *     packages/core/agent/src/runtime-types.ts:350)
 *   - keep the turn alive only through `agent/turn-stopping` + `agent.steer`
 *   - every node transition is visible: a `tool/call`+`tool/result` pair or a
 *     developer message, because model-visible ⇔ logged
 *   - budget: maxNodes / maxSteps / maxTokens / maxWallMs; exhaustion ends the
 *     turn, never the session
 *   - `mode` is the safety valve: off | observe | shadow | active
 * @module @dsh/explore-mode/runtime
 */

/** Cordis plugin name; the row id is `graph-runtime`. */
export const name = 'graph-runtime'

/** Runtime reads the kernel services and the agent/preset registries. */
export const inject = ['agents', 'agentPresets', 'graphRegistry', 'graphRouter', 'tools', 'systemPrompt']

const UNIMPLEMENTED = 'graph runtime skeleton: implement design/runtime.ts + kernel.ts before use'

/**
 * Provide `ctx.graphRuntime` and observe explore-mode agents.
 * @param {import('@deepseek-ai/cordis').Context} ctx - host context.
 * @param {{mode?: string, nodeExecutor?: string, maxReplans?: number, budget?: object}} _config - row config.
 */
export function apply(ctx, _config) {
  const service = Object.freeze({
    /** @returns {never} always throws until implemented. */
    start() { throw new Error(UNIMPLEMENTED) },
    /** @returns {never} always throws until implemented. */
    status() { throw new Error(UNIMPLEMENTED) },
  })
  ctx.effect(() => ctx.provide('graphRuntime', service), 'graph-runtime: service')

  // Attach state only to sessions that explicitly selected this mode. The preset id is
  // read from the log projection, so a resumed session re-attaches to the same composition
  // (packages/preset/agent-preset-registry/src/index.ts:89).
  ctx.effect(() => ctx.on('agent/created', ({ agent }) => {
    if (ctx.agentPresets.presetForSession(agent.session) !== 'explore') return
    // TODO(implementation): create per-agent GraphState here; observe mode logs only.
  }), 'graph-runtime: agent attachment')
}
