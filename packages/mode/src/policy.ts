/**
 * The explore mode's prompt contribution.
 *
 * Two registrations, both agent-scoped and both read-only:
 *   - a system **section** naming the current graph node and the routing policy;
 *   - a runtime **context** listing idle Agent Teams teammates, so the model can reuse
 *     a teammate instead of spawning a duplicate.
 *
 * This plugin is mounted *inside* an agent preset. It may consume host services but
 * must never provide one: preset activation auditing rejects globally leaked services
 * (packages/preset/agent-preset-registry/README.md:56-60). Every registration therefore
 * hangs off the Agent scope created for the session.
 * @module @dsh/explore-mode/policy
 */

import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-system-prompt'
import { DEFAULT_NODES, POLICY_SECTION, POLICY_SECTION_ORDER_FALLBACK, ROSTER_CONTEXT, ROSTER_CONTEXT_ORDER } from './constants.ts'
import { listMembersSafely, teamsOf, teammates, type TeamMemberLike } from './teams.ts'

/** Cordis plugin name; the preset child row id is `explore-policy`. */
export const name = 'explore-policy'

/** The prompt registry this row contributes to. */
export const inject = ['systemPrompt']

/** Row config. Absent keys use the defaults described in `./constants.ts`. */
export interface Config {
  /** Node names cycled once per step; defaults to `inspect → plan → act → verify`. */
  nodes?: string[]
  /** Whether the idle-roster context is contributed; defaults to true. */
  rosterContext?: boolean
}

/**
 * The standing policy text. Deliberately short: it is paid on every request, and the
 * graph itself carries the plan.
 * @param node - node name for this step.
 * @returns the policy section text.
 */
export function policyText(node: string): string {
  return [
    'Graph policy for this session (a mode over the standard tool set, not a separate loop):',
    `current node: ${node}.`,
    'Keep one node per step: state the node you are working, use only the tools it needs, and',
    'report a failure rather than silently widening scope. Reuse an idle teammate when the',
    'roster matches the next unit of work; spawn only for a genuinely new responsibility.',
    'Tracking detail belongs in todo_write — do not restate the graph to the user.',
  ].join(' ')
}

/**
 * Render idle teammates as one line each.
 * @param members - roster rows (lead excluded by {@link teammates}).
 * @returns a context body, or an empty string when nobody is idle.
 */
export function rosterText(members: readonly TeamMemberLike[]): string {
  const idle = teammates(members).filter(member => member.status === 'inactive')
  if (idle.length === 0) return ''
  const lines = idle.map(member => {
    const description = (member.description ?? '').trim()
    const clipped = description.length > 120 ? `${description.slice(0, 117)}...` : description
    return `- ${member.name}${clipped.length > 0 ? `: ${clipped}` : ''}`
  })
  return ['Idle teammates you can reuse with send_message instead of spawning a duplicate:', ...lines].join('\n')
}

/**
 * Register the policy for every Agent that runs this preset.
 * @param ctx - preset-scoped context.
 * @param config - row config.
 */
export function apply(ctx: Context, config: Config = {}): void {
  const nodes = normalizeNodes(config.nodes)
  const includeRoster = config.rosterContext ?? true
  const order = policySectionOrder(ctx)
  // A preset scope serves many Agents; each session gets its own node cursor and its
  // own roster, so the contributions are mounted on the Agent scope, not here.
  ctx.effect(() => ctx.on('agent/created', ({ agent }) => {
    mountAgentPolicy(ctx, agent, { nodes, includeRoster, order })
    return undefined
  }), 'explore-policy: agent sessions')
}

/** Inputs of one Agent's policy mount. */
interface AgentPolicyOptions {
  readonly nodes: readonly string[]
  readonly includeRoster: boolean
  readonly order: number
}

/**
 * Mount one Agent's section, roster context, and node cursor.
 *
 * Ordering note: the loop assembles the prompt *before* it runs `agent/pre-step`, so a
 * pre-step listener can only describe the **next** step. The cursor therefore advances
 * to `(step + 1) % nodes.length` and resets when the turn stops, which makes the
 * section show `nodes[step % nodes.length]` for every step after the first of a turn.
 * @param ctx - preset-scoped context (service lookup only).
 * @param agent - exact live Agent running this preset.
 * @param options - node cycle, roster toggle, section order.
 */
function mountAgentPolicy(ctx: Context, agent: Agent, options: AgentPolicyOptions): void {
  const cursor = { node: 0 }

  agent.ctx.effect(() => agent.ctx.systemPrompt.section({
    name: POLICY_SECTION,
    order: options.order,
    text: () => policyText(options.nodes[cursor.node] ?? options.nodes[0] ?? DEFAULT_NODES[0]),
  }), 'explore-policy: section')

  if (options.includeRoster) {
    agent.ctx.effect(() => agent.ctx.systemPrompt.context({
      name: ROSTER_CONTEXT,
      order: ROSTER_CONTEXT_ORDER,
      required: false,
      text: () => rosterText(rosterOf(ctx, agent)),
    }), 'explore-policy: roster')
  }

  agent.ctx.effect(() => agent.ctx.on('agent/pre-step', async (payload, next) => {
    cursor.node = (payload.step + 1) % options.nodes.length
    return await next()
  }), 'explore-policy: node cursor')

  agent.ctx.effect(() => agent.ctx.on('agent/turn-stopping', () => {
    cursor.node = 0
  }), 'explore-policy: cursor reset')
}

/** Read the roster for one Agent; empty when Agent Teams is absent. */
function rosterOf(ctx: Context, agent: Agent): readonly TeamMemberLike[] {
  const teams = teamsOf(ctx)
  return teams === undefined ? [] : listMembersSafely(teams, agent)
}

/**
 * Resolve the policy section order from the registry.
 *
 * `TOOL_GUIDANCE` is not a section name in this DSH release; `TEAM_POLICY` is the
 * policy slot, so a mode-level routing policy belongs there.
 */
function policySectionOrder(ctx: Context): number {
  try {
    const order = ctx.systemPrompt.getSectionOrder('TEAM_POLICY')
    return Number.isFinite(order) ? order : POLICY_SECTION_ORDER_FALLBACK
  } catch {
    return POLICY_SECTION_ORDER_FALLBACK
  }
}

/** Sanitize the configured node cycle. */
function normalizeNodes(nodes: string[] | undefined): readonly string[] {
  if (!Array.isArray(nodes)) return DEFAULT_NODES
  const cleaned = nodes
    .filter((node): node is string => typeof node === 'string' && node.trim().length > 0)
    .map(node => node.trim())
  return cleaned.length > 0 ? cleaned : DEFAULT_NODES
}
