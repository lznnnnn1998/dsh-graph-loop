/**
 * replan.ts — dynamic node add/remove for the graph loop, and the tool-gating policy.
 *
 * Two facts shape this file:
 *  1. LangGraph graphs are compiled: you cannot splice nodes into a running graph.
 *     "Add/remove a node" therefore means: mutate the plan document, recompile it
 *     (kernel.compile), and resume from the current checkpoint via updateState.
 *     The kernel port in design/runtime.ts exposes exactly that.
 *  2. Every node boundary is already a durable DSH event (step/end or an injected
 *     result message), so a replan can only be *committed* at a boundary. A replan is
 *     never applied mid-step, and a checkpoint is never written mid-step.
 *
 * Determinism: `decideReplan` is a pure function of (plan, state, observation, policy).
 * The runtime calls it at a boundary, records the outcome in the checkpoint, and
 * appends one short injected message describing the mutation (model-visible = logged).
 */

import type {
  ArtifactType,
  GraphState,
  Json,
  NodeId,
  PlanNode,
  TaskPlan,
} from './graph-schema'
import { GRAPH_STATE_LIMITS, assertJsonSafe } from './graph-schema'

// ---------------------------------------------------------------------------
// Triggers
// ---------------------------------------------------------------------------

export type ReplanTrigger =
  | { readonly kind: 'tool-failed'; readonly nodeId: NodeId; readonly tool: string; readonly code: string; readonly attempts: number }
  | { readonly kind: 'validation-failed'; readonly nodeId: NodeId; readonly validator: string; readonly detail: string }
  | { readonly kind: 'no-progress'; readonly nodeId: NodeId; readonly repeatedTool: string; readonly count: number }
  | { readonly kind: 'budget-exhausted'; readonly axis: 'steps' | 'tokens' | 'wall' | 'nodes'; readonly used: number; readonly limit: number }
  | { readonly kind: 'user-steer'; readonly textHash: string; readonly intentChanged: boolean }
  | { readonly kind: 'subagent-failed'; readonly nodeId: NodeId; readonly stopReason: string }
  | { readonly kind: 'graph-error'; readonly nodeId: NodeId; readonly message: string }

export interface ReplanObservation {
  /** Superstep that just closed; replans are only legal at boundaries. */
  readonly superstep: number
  readonly state: GraphState
  readonly triggers: readonly ReplanTrigger[]
  /** Wall-clock and token usage measured by the driver (monotonic). */
  readonly usage: { readonly steps: number; readonly tokens: number; readonly wallMs: number }
}

export interface ReplanPolicy {
  readonly maxReplans: number
  /** After this many failed replans the run falls back to the conservative plan. */
  readonly maxConsecutiveFailures: number
  /** Hard ceiling on plan nodes after every mutation. */
  readonly maxNodes: number
  /** Mutating nodes may only be retried when verification is possible. */
  readonly allowMutatingRetry: boolean
}

export const DEFAULT_REPLAN_POLICY: ReplanPolicy = {
  maxReplans: 3,
  maxConsecutiveFailures: 2,
  maxNodes: 12,
  allowMutatingRetry: false,
}

// ---------------------------------------------------------------------------
// Mutations
// ---------------------------------------------------------------------------

export type PlanMutation =
  | { readonly op: 'insert-node'; readonly node: PlanNode; readonly before: NodeId; readonly reason: string }
  | { readonly op: 'remove-node'; readonly nodeId: NodeId; readonly reason: string }
  | { readonly op: 'swap-binding'; readonly nodeId: NodeId; readonly capabilityId: string; readonly reason: string }
  | { readonly op: 'relax-tools'; readonly nodeId: NodeId; readonly add: readonly string[]; readonly reason: string }
  | { readonly op: 'escalate-model'; readonly nodeId: NodeId; readonly model: { readonly provider: string; readonly model: string; readonly reasoningEffort?: string }; readonly reason: string }
  | { readonly op: 'force-terminal'; readonly reason: string }
  | { readonly op: 'abort'; readonly reason: string }

export interface ReplanDecision {
  readonly action: 'continue' | 'mutate' | 'fallback' | 'abort'
  readonly mutations: readonly PlanMutation[]
  /** Next plan version; equals the current version when action is `continue`. */
  readonly nextVersion: number
  /** One short line appended to the session as a user message (model-visible = logged). */
  readonly banner: string
  readonly exhausted: boolean
}

/**
 * Decide what to do at a node boundary. Pure and total: every input maps to one
 * decision. Complexity O(triggers + plan nodes); trivially cheap because it runs
 * once per boundary, not per token.
 */
export function decideReplan(
  plan: TaskPlan,
  observation: ReplanObservation,
  policy: ReplanPolicy = DEFAULT_REPLAN_POLICY,
): ReplanDecision {
  const replans = observation.state.replans
  const remaining = plan.budget.maxReplans - replans
  if (remaining <= 0) {
    return {
      action: 'abort',
      mutations: [],
      nextVersion: plan.version,
      banner: `[graph] replan budget exhausted (${replans}/${plan.budget.maxReplans}); stopping with a report`,
      exhausted: true,
    }
  }

  const hard = observation.triggers.find((trigger) => trigger.kind === 'graph-error' || trigger.kind === 'budget-exhausted')
  if (hard) {
    return {
      action: 'fallback',
      mutations: [{ op: 'force-terminal', reason: hard.kind === 'budget-exhausted' ? 'budget' : 'graph error' }],
      nextVersion: plan.version + 1,
      banner: `[graph] ${hard.kind}; switching to the conservative fallback plan`,
      exhausted: false,
    }
  }

  const mutations: PlanMutation[] = []
  for (const trigger of observation.triggers) {
    switch (trigger.kind) {
      case 'tool-failed': {
        if (trigger.attempts >= 2) {
          mutations.push({
            op: 'swap-binding',
            nodeId: trigger.nodeId,
            capabilityId: `tool:${alternativeFor(plan, trigger.tool)}`,
            reason: `${trigger.tool} failed ${trigger.attempts}x (${trigger.code})`,
          })
        } else if (policy.allowMutatingRetry) {
          mutations.push({ op: 'relax-tools', nodeId: trigger.nodeId, add: [], reason: `retry ${trigger.tool}` })
        }
        break
      }
      case 'validation-failed': {
        mutations.push({
          op: 'insert-node',
          before: trigger.nodeId,
          node: {
            id: `n_check_${observation.superstep}`,
            kind: 'gate',
            executor: 'step',
            instruction: `Diagnose why the post-condition failed (${trigger.validator}): ${trigger.detail}. Do not repeat the same action.`,
            toolAllow: ['read', 'grep', 'glob'],
            validate: 'gate.diagnosed',
          },
          reason: trigger.detail,
        })
        break
      }
      case 'no-progress': {
        mutations.push({
          op: 'escalate-model',
          nodeId: trigger.nodeId,
          model: { provider: 'deepseek', model: 'deepseek-v4-pro', reasoningEffort: 'high' },
          reason: `${trigger.repeatedTool} repeated ${trigger.count}x`,
        })
        break
      }
      case 'user-steer': {
        if (trigger.intentChanged) {
          mutations.push({ op: 'force-terminal', reason: 'user changed intent' })
        }
        break
      }
      case 'subagent-failed': {
        mutations.push({
          op: 'relax-tools',
          nodeId: trigger.nodeId,
          add: ['read', 'grep'],
          reason: `child stopped: ${trigger.stopReason}`,
        })
        break
      }
      default:
        break
    }
  }

  if (mutations.length === 0) {
    return { action: 'continue', mutations: [], nextVersion: plan.version, banner: '', exhausted: false }
  }
  if (observation.state.replans >= plan.budget.maxReplans) {
    return {
      action: 'abort',
      mutations: [],
      nextVersion: plan.version,
      banner: '[graph] replan budget exhausted',
      exhausted: true,
    }
  }
  return {
    action: 'mutate',
    mutations,
    nextVersion: plan.version + 1,
    banner: renderMutationBanner(plan, mutations),
    exhausted: false,
  }
}

function alternativeFor(plan: TaskPlan, tool: string): string {
  // Declared substitutes are the only legal source of an alternative; the runtime
  // passes them through the plan's toolUniverse (built from the template library).
  const alts: Readonly<Record<string, string>> = { bash: 'run_code', edit: 'write', write: 'edit', glob: 'grep', grep: 'glob' }
  const candidate = alts[tool] ?? tool
  return plan.toolUniverse.includes(candidate) ? candidate : tool
}

/** Short, stable, model-visible. Bounded to one line (~40 tokens) per replan. */
export function renderMutationBanner(plan: TaskPlan, mutations: readonly PlanMutation[]): string {
  const parts = mutations.map((mutation) => {
    switch (mutation.op) {
      case 'insert-node':
        return `+${mutation.node.id}`
      case 'remove-node':
        return `-${mutation.nodeId}`
      case 'swap-binding':
        return `${mutation.nodeId}->${mutation.capabilityId}`
      case 'relax-tools':
        return `${mutation.nodeId}+tools`
      case 'escalate-model':
        return `${mutation.nodeId}->${mutation.model.model}`
      case 'force-terminal':
        return 'end'
      case 'abort':
        return 'abort'
    }
  })
  return `[graph] replan v${plan.version}->v${plan.version + 1} ${parts.join(' ')}`
}

// ---------------------------------------------------------------------------
// Applying mutations (pure: plan + mutations -> next plan, or an error)
// ---------------------------------------------------------------------------

export interface ApplyResult {
  readonly ok: boolean
  readonly plan?: TaskPlan
  readonly error?: string
  readonly warnings: readonly string[]
}

export function applyMutations(plan: TaskPlan, mutations: readonly PlanMutation[], policy: ReplanPolicy = DEFAULT_REPLAN_POLICY): ApplyResult {
  const warnings: string[] = []
  let nodes = [...plan.nodes]
  let edges = [...plan.edges]

  for (const mutation of mutations) {
    switch (mutation.op) {
      case 'insert-node': {
        if (nodes.length >= policy.maxNodes) return { ok: false, error: 'maxNodes', warnings }
        const at = nodes.findIndex((node) => node.id === mutation.before)
        if (at === -1) return { ok: false, error: `unknown anchor ${mutation.before}`, warnings }
        const inbound = edges.filter((edge) => edge.to === mutation.before)
        const outbound = edges.filter((edge) => edge.from === mutation.before)
        nodes = [...nodes.slice(0, at), mutation.node, ...nodes.slice(at)]
        edges = [...edges.filter((edge) => edge.to !== mutation.before && edge.from !== mutation.before)]
        for (const edge of inbound) edges.push({ ...edge, to: mutation.node.id })
        edges.push({ from: mutation.node.id, to: mutation.before, kind: 'control' })
        for (const edge of outbound) edges.push(edge)
        break
      }
      case 'remove-node': {
        if (plan.terminals.includes(mutation.nodeId)) return { ok: false, error: 'cannot remove a terminal', warnings }
        if (mutation.nodeId === plan.entry) return { ok: false, error: 'cannot remove the entry', warnings }
        const inbound = edges.filter((edge) => edge.to === mutation.nodeId)
        const outbound = edges.filter((edge) => edge.from === mutation.nodeId)
        nodes = nodes.filter((node) => node.id !== mutation.nodeId)
        edges = edges.filter((edge) => edge.to !== mutation.nodeId && edge.from !== mutation.nodeId)
        for (const edge of inbound) for (const next of outbound) edges.push({ from: edge.from, to: next.to, kind: 'control' })
        break
      }
      case 'swap-binding': {
        nodes = nodes.map((node) => (node.id === mutation.nodeId ? { ...node, capabilityId: mutation.capabilityId } : node))
        break
      }
      case 'relax-tools': {
        nodes = nodes.map((node) =>
          node.id === mutation.nodeId ? { ...node, toolAllow: [...new Set([...(node.toolAllow ?? []), ...mutation.add])] } : node,
        )
        break
      }
      case 'escalate-model': {
        nodes = nodes.map((node) => (node.id === mutation.nodeId ? { ...node, model: mutation.model } : node))
        break
      }
      case 'force-terminal': {
        const terminal = nodes.find((node) => node.kind === 'terminal')
        if (!terminal) return { ok: false, error: 'no terminal to force', warnings }
        edges = edges.filter((edge) => edge.from !== plan.entry || edge.to === terminal.id)
        for (const node of nodes) {
          if (node.id !== terminal.id && node.kind !== 'terminal') {
            if (!edges.some((edge) => edge.from === node.id && edge.to === terminal.id)) {
              edges.push({ from: node.id, to: terminal.id, kind: 'control' })
            }
          }
        }
        break
      }
      case 'abort':
        return { ok: false, error: 'abort', warnings }
    }
  }

  const terminals = nodes.filter((node) => node.kind === 'terminal').map((node) => node.id)
  if (terminals.length === 0) return { ok: false, error: 'plan lost its terminal', warnings }
  for (const node of nodes) {
    if (node.kind !== 'terminal' && !edges.some((edge) => edge.from === node.id)) {
      warnings.push(`${node.id} has no outgoing edge; forcing to terminal`)
    }
  }
  return {
    ok: true,
    plan: { ...plan, version: plan.version + 1, nodes, edges, terminals },
    warnings,
  }
}

// ---------------------------------------------------------------------------
// Invariants (checked before every updateState; violations block the replan)
// ---------------------------------------------------------------------------

export interface InvariantViolation {
  readonly code: string
  readonly message: string
}

export function checkInvariants(plan: TaskPlan, state: GraphState): readonly InvariantViolation[] {
  const violations: InvariantViolation[] = []
  const nodes = new Map(plan.nodes.map((node) => [node.id, node]))
  if (!nodes.has(plan.entry)) violations.push({ code: 'I001', message: 'entry missing' })
  if (state.replans > plan.budget.maxReplans) violations.push({ code: 'I002', message: 'replan budget exceeded' })
  if (state.superstep > plan.budget.maxNodes * 2) violations.push({ code: 'I003', message: 'superstep cap exceeded' })
  if (state.next !== null && !nodes.has(state.next)) violations.push({ code: 'I004', message: `next node ${state.next} not in plan` })
  const problem = assertJsonSafe(state as unknown as Json)
  if (problem) violations.push({ code: 'I005', message: `state is not JSON-safe at ${problem}` })
  const size = JSON.stringify(state).length
  if (size > GRAPH_STATE_LIMITS.maxCheckpointBytes) {
    violations.push({ code: 'I006', message: `checkpoint ${size}B exceeds ${GRAPH_STATE_LIMITS.maxCheckpointBytes}B` })
  }
  for (const node of plan.nodes) {
    if (node.kind === 'terminal') continue
    if (node.executor === 'step' && (node.toolAllow?.length ?? 0) > 0) {
      for (const tool of node.toolAllow ?? []) {
        if (!plan.toolUniverse.includes(tool)) {
          violations.push({ code: 'I007', message: `${node.id} allows "${tool}" outside the plan tool universe` })
        }
      }
    }
    if (node.idempotency === 'manual' && node.kind === 'tool-call') {
      violations.push({ code: 'I008', message: `${node.id} is manual-only and cannot be auto-replanned` })
    }
  }
  return violations
}

// ---------------------------------------------------------------------------
// Tool gating policy: the KV-cache break-even that decides hard vs soft gating
// ---------------------------------------------------------------------------

export interface GateInputs {
  /** Tool-schema tokens visible before gating (measured: ctx.tokenMeter contextBreakdown.toolsTokens). */
  readonly baseToolTokens: number
  /** Tool-schema tokens after gating (sum of plan.toolUniverse schemaTokens). */
  readonly gatedToolTokens: number
  /** Tokens already in the request prefix (system + tools + history). */
  readonly prefixTokens: number
  /** Expected remaining steps in this run. */
  readonly plannedSteps: number
  /** Cache-read price as a fraction of a full input token (0.1 for DeepSeek cache hits). */
  readonly cacheReadFactor: number
}

export interface GateDecision {
  readonly hardGate: boolean
  /** First-run saving if the prefix is cold anyway (new session / post-compaction / fork). */
  readonly coldSavingTokens: number
  /** Full-price-equivalent saving per later step. */
  readonly warmSavingPerStep: number
  /** Steps needed to amortize one prefix miss; Infinity when gating saves nothing. */
  readonly breakEvenSteps: number
  readonly reason: string
}

/**
 * Hard gating changes the visible tool declarations, which invalidates prefix reuse
 * from the first changed schema token (packages/core/tools/README.md#kv-cache-effect).
 * The saving per step is therefore only the cached portion of the removed schemas;
 * the cost is one full-prefix miss.
 *
 *   save/step      = (B - G) * c
 *   miss cost      = (P) * (1 - c)
 *   break-even N*  = ceil( P * (1 - c) / ((B - G) * c) )
 *
 * With DeepSeek cache pricing c ~= 0.1 (ESTIMATE, verify with token-economist):
 *   B-G = 2_251 (measured base coding subset), P = 30_000 -> N* = ceil(27_000 / 225) = 120 steps.
 * That is why the default is `cold`: gate when the prefix is cold anyway, not per turn.
 */
export function decideHardGate(inputs: GateInputs): GateDecision {
  const delta = Math.max(0, inputs.baseToolTokens - inputs.gatedToolTokens)
  const coldSavingTokens = delta
  const warmSavingPerStep = delta * inputs.cacheReadFactor
  const missCost = inputs.prefixTokens * (1 - inputs.cacheReadFactor)
  const breakEvenSteps = warmSavingPerStep <= 0 ? Number.POSITIVE_INFINITY : Math.ceil(missCost / warmSavingPerStep)
  const hardGate = inputs.plannedSteps >= breakEvenSteps && delta > 0
  return {
    hardGate,
    coldSavingTokens,
    warmSavingPerStep,
    breakEvenSteps,
    reason: hardGate
      ? `gate: ${inputs.plannedSteps} planned steps >= ${breakEvenSteps} break-even`
      : `keep stable schemas: ${inputs.plannedSteps} planned steps < ${breakEvenSteps} break-even`,
  }
}

/** Cold points where a hard gate is free: no reusable prefix exists yet. */
export function isColdBoundary(kind: 'session-create' | 'resume' | 'fork' | 'compaction-end' | 'model-switch' | 'turn'): boolean {
  return kind !== 'turn'
}

export type { ArtifactType }
