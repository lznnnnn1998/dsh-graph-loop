/**
 * graph-loop — the graph AgentFactory (SKELETON).
 *
 * This row replaces the stock driver. It must implement the public contract only:
 * `createAgent(ownerCtx, options)` and `resume(ownerCtx, options)` returning an
 * `AgentHandle` (packages/core/agent/src/index.ts:175-210), and the `Agent` shape in
 * packages/core/agent/src/runtime-types.ts:206-268 (`options`, `session`, `model`,
 * `inbox`, `status`, `ctx`, `cancel`, `whenIdle`, `runMaintenance`, `send`,
 * `followup`, `steer`, `inject`).
 *
 * Non-negotiables for a drop-in driver (each is what breaks if skipped):
 *   1. `ctx.agents.setFactory(this)` inside the construction effect — exclusive, throws
 *      if another factory registered (packages/core/agent/src/index.ts:383-392).
 *   2. Register the `inbox` and `modelSelection` session projections for the service
 *      lifetime (packages/core/agent-loop/src/index.ts:334-335). The Web session
 *      controller folds `inbox` for cold reads
 *      (packages/api/session-controller/src/client/sessions/session.ts:196,830).
 *   3. Emit the full live event taxonomy: agent/created, agent/disposed, agent/status,
 *      agent/inbox/{inserted,claimed,discarded}, agent/pre-step (waterfall),
 *      agent/request-error, agent/assistant-stream, agent/turn-stopping, agent/error
 *      (packages/core/agent/src/runtime-types.ts:290-420).
 *   4. Append the durable event types the projections and the UI fold, and nothing
 *      unknown: turn/start, step/start, request/header, request/context,
 *      system/message, developer/message, user/message, assistant/message,
 *      assistant/attempt, tool/call, tool/result, step/end, turn/end
 *      (packages/core/session/src/known-event-types.ts:22-80).
 *   5. Acquire session write handles through `ctx.sessionPersistence` exactly like the
 *      stock driver (packages/core/agent-loop/README.md#persistence-integration).
 *
 * Reuse `ctx.agents`, never fork it: every consumer talks to the registry
 * (packages/api/session-controller/src/agent.ts, packages/subagent/subagent/src,
 * packages/bundle/headless/src/index.ts).
 * @module @dsh/explore-loop
 */

/** Cordis plugin name; the row id is `graph-loop`. */
export const name = 'graph-loop'

/** Same prerequisite set as the stock driver (packages/core/agent-loop/src/index.ts:293). */
export const inject = ['agents', 'sessions', 'llm', 'tools', 'systemPrompt', 'sessionProjections']

/**
 * Row config keys accepted by `graph-loop` (documentation only — no `Config` export
 * in the skeleton). The real module declares a schemastery schema with
 * `maxParallelToolCalls` marked `.volatile()` (packages/core/agent-loop/src/
 * index.ts:296) and lists `@deepseek-ai/schemastery` in peerDependencies.
 */
export const CONFIG_KEYS = Object.freeze([
  'maxParallelToolCalls', // volatile; the field a settings card edits
  'agents',
  'document',
  'mode',
  'maxReplans',
])

/**
 * Announce the skeleton. The real factory registers itself here.
 * @param {import('@deepseek-ai/cordis').Context} ctx - host context.
 * @param {object} _config - row config.
 */
export function apply(ctx, _config) {
  // Deliberately does NOT call ctx.agents.setFactory(): a false factory would advertise
  // a driver that cannot drive. With the stock row disabled and no factory registered,
  // `ctx.agents.create()` fails with the documented
  // "no agent factory registered (load an agent-loop plugin)" message
  // (packages/core/agent/src/index.ts:210) — a loud, correct failure for a skeleton.
  ctx.logger?.warn?.(
    'graph-loop: skeleton mounted without an AgentFactory; sessions cannot start until the driver is implemented',
  )
}
