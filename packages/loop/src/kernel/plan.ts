/**
 * plan.ts — the plan-shaped (Layer 2) kernel core shared by both engines.
 *
 * A `TaskPlan` is a graph whose nodes are `PlanNode`s executed by a
 * `NodeExecutorPort` (`step` = one DSH model step, `subagent` = one child
 * activation). `kernel.ts` deliberately keeps plan *policy* out of the kernel:
 * routing, the state fold and the durable boundary append are injected through
 * `LangGraphKernelDeps`-shaped callbacks. This file declares that same shape
 * without the LangGraph surface, plus the one-node execution step both the
 * minimal kernel and the LangGraph adapter reuse.
 *
 * The kernel owns topology + stepping + boundaries + checkpoints. It never
 * touches a DSH session (C3) and never evaluates plan `Condition`s.
 */

import { END, KernelError } from 'dsh-graph-loop-core/kernel'
import type {
  DeterminismHooks,
  JsonUpdate,
  JsonValue,
  NodeContext,
  NodeId,
} from 'dsh-graph-loop-core/kernel'
import type { GraphState, Json, PlanNode, TaskPlan } from 'dsh-graph-loop-core/graph-schema'
import { GRAPH_STATE_LIMITS } from 'dsh-graph-loop-core/graph-schema'
import type {
  KernelRunHandle,
  KernelResult,
  NodeFailure,
  NodeBoundaryRef,
  PauseReason,
} from 'dsh-graph-loop-core/runtime'

import {
  assertJson,
  asKernelError,
  createCheckpoint,
  hooksOf,
  isAborted,
  isJson,
  mergeState,
  stripPregelKeys,
} from './builder.ts'

/* ========================================================================== *
 * Injected ports (structurally `LangGraphKernelDeps` minus the LangGraph surface)
 * ========================================================================== */

/** Context handed to a plan-node executor. Superset of both core context shapes. */
export interface PlanNodeContext {
  readonly plan: TaskPlan
  readonly node: PlanNode
  readonly state: GraphState
  readonly turn: number
  readonly superstep: number
  readonly port: unknown
  readonly siblings: readonly string[]
}

/**
 * What an executor reports back.
 *
 * `kernel.ts`'s `KernelNodeExecutorPort` returns `{ ok, facts, artifacts, atSeq }`
 * (no `update`) while `runtime.ts`'s `NodeExecutorPort` returns `NodeOutcome`
 * with an `update`. Both are accepted: `update` wins when present, otherwise
 * `facts`/`artifacts` are folded over the current state.
 */
export interface PlanNodeOutcome {
  readonly nodeId?: string
  readonly ok: boolean
  readonly update?: JsonUpdate
  readonly facts?: { readonly [key: string]: JsonValue }
  readonly artifacts?: readonly { readonly type: string; readonly ref: string; readonly hash?: string }[]
  readonly failure?: NodeFailure
  readonly atSeq?: number
}

/**
 * One executor per `NodeExecutor` kind. `context` is deliberately permissive so
 * both core ports (`KernelNodeExecutorPort`, `NodeExecutorPort`) satisfy it.
 */
export interface PlanExecutorPort {
  readonly kind: 'step' | 'subagent'
  execute(node: PlanNode, context: any): Promise<PlanNodeOutcome> | PlanNodeOutcome
}

/** Boundary hook: the only place a host appends `step/end` + `step/start` (A1). */
export type AfterNodeHook = (input: {
  readonly plan: TaskPlan
  readonly node: PlanNode
  readonly state: GraphState
  readonly superstep: number
  /**
   * Session seq that closed this node's boundary, when the host reports one.
   * The kernel never reads a session (C3); it only carries the number.
   */
  readonly atSeq?: number
  /** Set only when the node ended the run unsuccessfully (no recovery route). */
  readonly failure?: NodeFailure
}) => Promise<{ readonly atSeq: number; readonly state: GraphState; readonly failure?: NodeFailure }>

/** Plan policy: successor of a finished node, or `END`. */
export type PlanRouteHook = (input: {
  readonly plan: TaskPlan
  readonly nodeId: string
  readonly state: GraphState
}) => string | typeof END

/** Cache-shaped checkpointer the driver owns (session log is authoritative). */
export interface PlanCheckpointer {
  load(sessionId: string, atSeq: number): Promise<GraphState | undefined>
  put(sessionId: string, atSeq: number, state: GraphState): Promise<void>
}

export interface KernelDeps {
  /** One executor per `NodeExecutor` kind. Omit for pure topology stepping. */
  readonly executors?: readonly PlanExecutorPort[]
  /** Direct node bodies by `PlanNode.id`, for tests and simple graphs. */
  readonly nodes?: Readonly<Record<NodeId, (ctx: NodeContext<GraphState>) => JsonUpdate | Promise<JsonUpdate>>>
  readonly afterNode?: AfterNodeHook
  readonly route?: PlanRouteHook
  readonly checkpointer?: PlanCheckpointer
  readonly runContext?: { readonly turn?: number; readonly signal?: AbortSignal }
  /** Pause *before* the next node (budget, replan, human gate). */
  readonly pauseWhen?: (state: GraphState) => PauseReason | undefined
  readonly onFailure?: (failure: NodeFailure) => void
  /** Receives `ctx.emit()` chunks of `nodes`-style node bodies. */
  readonly onCustom?: (event: { readonly nodeId: NodeId; readonly chunk: JsonValue }) => void
  readonly determinism?: DeterminismHooks
  /** C1 guard on every update. Default true; set false in production. */
  readonly validateJson?: boolean
  /** Step budget; default 40 (DSH per-turn envelope). */
  readonly maxSteps?: number
  /**
   * When true, a plan node with no registered executor fails instead of
   * stepping as a no-op. Default false: `createKernel('minimal')` with zero deps
   * must be able to walk a topology.
   */
  readonly strictExecutors?: boolean
}

/** Normalised deps used by the handles. */
export interface ResolvedKernelDeps {
  readonly executors: readonly PlanExecutorPort[]
  readonly nodes: Readonly<Record<NodeId, (ctx: NodeContext<GraphState>) => JsonUpdate | Promise<JsonUpdate>>> | undefined
  readonly afterNode: AfterNodeHook
  readonly route: PlanRouteHook
  readonly checkpointer: PlanCheckpointer
  readonly pauseWhen: ((state: GraphState) => PauseReason | undefined) | undefined
  readonly onFailure: ((failure: NodeFailure) => void) | undefined
  readonly onCustom: ((event: { readonly nodeId: NodeId; readonly chunk: JsonValue }) => void) | undefined
  readonly determinism: DeterminismHooks
  readonly validateJson: boolean
  readonly maxSteps: number
  readonly turn: number
  readonly signal: AbortSignal | undefined
  readonly strictExecutors: boolean
}

/** In-memory `PlanCheckpointer` used when the host does not supply one. */
export class MemoryCheckpointer implements PlanCheckpointer {
  private readonly rows = new Map<string, Map<number, GraphState>>()

  async load(sessionId: string, atSeq: number): Promise<GraphState | undefined> {
    return this.rows.get(sessionId)?.get(atSeq)
  }

  async put(sessionId: string, atSeq: number, state: GraphState): Promise<void> {
    const thread = this.rows.get(sessionId) ?? new Map<number, GraphState>()
    thread.set(atSeq, state)
    this.rows.set(sessionId, thread)
  }

  /** Latest row for a thread (test/debug helper). */
  latest(sessionId: string): GraphState | undefined {
    const thread = this.rows.get(sessionId)
    if (thread === undefined || thread.size === 0) return undefined
    let last: GraphState | undefined
    for (const [, state] of thread) last = state
    return last
  }
}

export function resolveKernelDeps(deps?: KernelDeps): ResolvedKernelDeps {
  const determinism = hooksOf(deps?.determinism)
  return {
    executors: deps?.executors ?? [],
    nodes: deps?.nodes,
    afterNode: deps?.afterNode ?? defaultAfterNode,
    route: deps?.route ?? ((input) => defaultRoute(input.plan, input.nodeId)),
    checkpointer: deps?.checkpointer ?? new MemoryCheckpointer(),
    pauseWhen: deps?.pauseWhen,
    onFailure: deps?.onFailure,
    onCustom: deps?.onCustom,
    determinism,
    validateJson: deps?.validateJson ?? true,
    maxSteps: Math.max(1, deps?.maxSteps ?? 40),
    turn: deps?.runContext?.turn ?? 0,
    signal: deps?.runContext?.signal,
    strictExecutors: deps?.strictExecutors ?? false,
  }
}

/* ========================================================================== *
 * State helpers (GraphState is JSON; see C1)
 * ========================================================================== */

/** Fresh `GraphState` for a plan. Mirrors `runtime.initialState` (kept local so
 *  the kernel does not depend on the driver module at runtime). */
export function planInitialState(plan: TaskPlan, taskHash = ''): GraphState {
  return {
    taskHash,
    planId: plan.id,
    planVersion: plan.version,
    superstep: 0,
    next: plan.entry,
    status: 'running',
    facts: {},
    artifacts: [],
    children: [],
    journal: [],
    budget: { nodes: 0, steps: 0, tokens: 0, wallMs: 0 },
    replans: 0,
  }
}

/** First `control` edge out of `nodeId`, else `END` (the default kernel route). */
export function defaultRoute(plan: TaskPlan, nodeId: NodeId): string {
  const edge = plan.edges.find((candidate) => candidate.from === nodeId && candidate.kind === 'control')
  return edge?.to ?? END
}

/** Plan successors of a node: the injected router, else the first control edge. */
export function routeNext(
  deps: ResolvedKernelDeps,
  plan: TaskPlan,
  nodeId: NodeId,
  state: GraphState,
): NodeId | typeof END {
  const destination = deps.route({ plan, nodeId, state })
  if (destination === END) return END
  if (typeof destination !== 'string' || !plan.nodes.some((node) => node.id === destination)) {
    throw new KernelError(
      `plan route from "${nodeId}" returned undeclared node "${String(destination)}"`,
      'UNDECLARED_TARGET',
      { node: nodeId },
    )
  }
  return destination
}

/** Default fold: append journal, count the node, advance nothing else. */
export const defaultAfterNode: AfterNodeHook = async ({ node, state, superstep, atSeq, failure }) => {
  // A durable session seq when the host reports one; the superstep is only the
  // fallback for hosts that append no session event (the kernel never reads a
  // session, C3). Without this the journal claimed a step counter was a Session
  // seq and every checkpoint row was keyed by the wrong coordinate.
  const boundarySeq = atSeq ?? superstep
  const journalEntry = {
    nodeId: node.id,
    superstep,
    outcome: failure === undefined ? 'ok' as const : 'failed' as const,
    atSeq: boundarySeq,
  }
  const priorJournal = Array.isArray(state.journal) ? state.journal : []
  const journal = [...priorJournal, journalEntry].slice(-GRAPH_STATE_LIMITS.maxJournal)
  const budget = {
    nodes: (state.budget?.nodes ?? 0) + 1,
    steps: (state.budget?.steps ?? 0) + 1,
    tokens: state.budget?.tokens ?? 0,
    wallMs: state.budget?.wallMs ?? 0,
  }
  const candidate: GraphState = { ...state, journal, budget }
  return { atSeq: boundarySeq, state: candidate }
}

/* ========================================================================== *
 * One-node execution (shared by both engines)
 * ========================================================================== */

export interface ExecutedNode {
  readonly nodeId: NodeId
  readonly update: JsonUpdate
  readonly after: { readonly atSeq: number; readonly state: GraphState; readonly failure?: NodeFailure }
}

/** Deep-freeze the snapshot a node body sees (C4: never mutate). */
function frozen<S extends object>(state: S): Readonly<S> {
  const snapshot = { ...(state as object) } as S
  return Object.freeze(snapshot)
}

function nodeContext(
  deps: ResolvedKernelDeps,
  plan: TaskPlan,
  node: PlanNode,
  state: GraphState,
  step: number,
  emitted: JsonValue[],
): NodeContext<GraphState> {
  return {
    state: frozen(state),
    threadId: plan.id,
    step,
    signal: deps.signal ?? new AbortController().signal,
    determinism: deps.determinism,
    emit: (chunk) => {
      if (deps.validateJson) assertJson(chunk, 'emit chunk', node.id)
      emitted.push(chunk)
      deps.onCustom?.({ nodeId: node.id, chunk })
    },
    interrupt: async () => {
      // C4: a DSH human gate is an ordinary tool call, never an interrupt.
      throw new KernelError(
        `node "${node.id}" called ctx.interrupt(); use the ask_user_question tool instead (C4)`,
        'INTERRUPT_UNSUPPORTED',
        { node: node.id },
      )
    },
  }
}

/** Run one node body with its retry policy. */
async function runNodeBody(
  deps: ResolvedKernelDeps,
  plan: TaskPlan,
  node: PlanNode,
  state: GraphState,
  step: number,
): Promise<{ update: JsonUpdate; failure?: NodeFailure; atSeq?: number }> {
  const inline = deps.nodes?.[node.id]
  if (inline !== undefined) {
    const emitted: JsonValue[] = []
    const update = await inline(nodeContext(deps, plan, node, state, step, emitted))
    if (deps.validateJson) assertJson(update, `update from "${node.id}"`, node.id)
    return { update }
  }

  const executor = deps.executors.find((candidate) => candidate.kind === node.executor)
  if (executor === undefined) {
    if (deps.strictExecutors) {
      throw new KernelError(`no executor registered for node kind "${node.executor}"`, 'INVALID_GRAPH', {
        node: node.id,
      })
    }
    // Zero-deps mode: pure topology walk, no side effects.
    return { update: {} }
  }

  const retry = retryPolicyOf(node, deps)
  let attempt = 0
  for (;;) {
    attempt += 1
    try {
      deps.signal?.throwIfAborted()
      const outcome = await executor.execute(node, {
        plan,
        node,
        state,
        turn: deps.turn,
        superstep: state.superstep,
        port: undefined,
        siblings: siblingsOf(plan, node.id),
      })
      const update = updateOf(outcome, state, deps.validateJson, node.id)
      // Carry the reported failure to the boundary fold. Dropping it folded a
      // failed node as a success and let the run end `done`. The reported
      // `atSeq` is the durable boundary coordinate the host logged.
      return {
        update,
        ...(outcome.failure === undefined ? {} : { failure: outcome.failure }),
        ...(outcome.atSeq === undefined ? {} : { atSeq: outcome.atSeq }),
      }
    } catch (error) {
      const retryable = retry.retryOn(error)
      if (!retryable || attempt >= retry.maxAttempts) throw asKernelError(error, node.id)
      const delay = Math.min(retry.maxDelayMs, retry.initialDelayMs * retry.backoffFactor ** (attempt - 1))
      if (delay > 0) await sleep(delay)
    }
  }
}

function updateOf(
  outcome: PlanNodeOutcome | undefined,
  state: GraphState,
  validate: boolean,
  nodeId: NodeId,
): JsonUpdate {
  if (outcome === undefined) return {}
  let update: JsonUpdate
  if (outcome.update !== undefined) {
    update = outcome.update
  } else {
    update = {}
    if (outcome.facts !== undefined) update = { ...update, facts: { ...state.facts, ...outcome.facts } }
    if (outcome.artifacts !== undefined) update = { ...update, artifacts: [...state.artifacts, ...outcome.artifacts] }
  }
  if (validate) assertJson(update, `update from "${nodeId}"`, nodeId)
  return update
}

interface ResolvedRetry {
  readonly maxAttempts: number
  readonly initialDelayMs: number
  readonly backoffFactor: number
  readonly maxDelayMs: number
  readonly retryOn: (error: unknown) => boolean
}

function retryPolicyOf(node: PlanNode, deps: ResolvedKernelDeps): ResolvedRetry {
  const retry = node.retry
  return {
    maxAttempts: Math.max(1, retry?.maxAttempts ?? 1),
    initialDelayMs: Math.max(0, retry?.backoffMs ?? 0),
    backoffFactor: 2,
    maxDelayMs: 5_000,
    retryOn: (error) => {
      if (isAborted(deps.signal)) return false
      const kernelError = error instanceof KernelError ? error : undefined
      if (kernelError?.code === 'ABORTED') return false
      return true
    },
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/** Other nodes in the same parallel superstep (only `subagent` nodes parallelise). */
export function siblingsOf(plan: TaskPlan, nodeId: NodeId): readonly string[] {
  const node = plan.nodes.find((candidate) => candidate.id === nodeId)
  if (node === undefined || node.executor !== 'subagent') return []
  const inbound = plan.edges.filter((edge) => edge.to === nodeId).map((edge) => edge.from)
  return plan.nodes
    .filter((candidate) => candidate.id !== nodeId && candidate.executor === 'subagent')
    .filter((candidate) => plan.edges.some((edge) => edge.to === candidate.id && inbound.includes(edge.from)))
    .map((candidate) => candidate.id)
}

/**
 * Execute exactly one plan node and fold the result.
 *
 * Ordering (obligations A1/A5): node → JSON guard → route → `afterNode` (which
 * appends the durable boundary and returns the folded state) → checkpoint.
 * Throws only for kernel-fatal conditions; an executor-reported failure is
 * surfaced through `after.failure`.
 */
export async function executePlanNode(input: {
  readonly deps: ResolvedKernelDeps
  readonly plan: TaskPlan
  readonly state: GraphState
  readonly nodeId: NodeId
  readonly step: number
}): Promise<ExecutedNode> {
  const { deps, plan, nodeId } = input
  const node = plan.nodes.find((candidate) => candidate.id === nodeId)
  if (node === undefined) {
    throw new KernelError(`plan has no node "${nodeId}"`, 'UNDECLARED_TARGET', { node: nodeId })
  }
  const state = input.state
  const { update, failure, atSeq } = await runNodeBody(deps, plan, node, state, input.step)

  const merged = mergeState(state, update)
  if (deps.validateJson) assertJson(merged, `state after "${nodeId}"`, nodeId)

  const destination = routeNext(deps, plan, nodeId, merged)
  // Reaching END without a declared terminal is the plan running out of enabled
  // work, not a failed run: it settles `done` in the folded state and the
  // adapter classifies it as plan state `finished`, so the turn boundary — not
  // the plan — decides whether the turn keeps working. Only a reported executor
  // failure at END fails the run instead of folding as ok.
  const ended = destination === END
  const runFailed = ended && failure !== undefined
  const candidate: GraphState = stripPregelKeys({
    ...merged,
    superstep: merged.superstep + 1,
    next: ended ? null : destination,
    status: runFailed ? 'failed' : ended ? 'done' : 'running',
  })
  if (deps.validateJson) assertJson(candidate, `state handed to afterNode after "${nodeId}"`, nodeId)

  const after = await deps.afterNode({
    plan,
    node,
    state: candidate,
    superstep: candidate.superstep,
    ...(atSeq === undefined ? {} : { atSeq }),
    ...(runFailed && failure !== undefined ? { failure } : {}),
  })
  if (deps.validateJson) assertJson(after.state, `checkpoint state after "${nodeId}"`, nodeId)
  return { nodeId, update, after }
}

/* ========================================================================== *
 * Result helpers
 * ========================================================================== */

export function failedResult(state: GraphState, failure: NodeFailure): KernelResult {
  return { kind: 'failed', state, error: failure }
}

/** Map a kernel error to the Layer-2 `NodeFailure` vocabulary. */
export function failureOf(error: unknown, nodeId: NodeId): NodeFailure {
  const kernelError = error instanceof KernelError ? error : undefined
  const code: NodeFailure['code'] =
    kernelError?.code === 'STEP_BUDGET_EXCEEDED'
      ? 'budget-exceeded'
      : kernelError?.code === 'ABORTED'
        ? 'cancelled'
        : kernelError?.code === 'NON_JSON_STATE' || kernelError?.code === 'INVALID_UPDATE'
          ? 'validation-failed'
          : 'graph-error'
  return {
    code,
    nodeId,
    message: kernelError?.message ?? (error instanceof Error ? error.message : String(error)),
    retryable: false,
  }
}

export function cancelledFailure(nodeId: NodeId, message: string): NodeFailure {
  return { code: 'cancelled', nodeId, message, retryable: false }
}

export function boundaryRef(superstep: number, atSeq: number): NodeBoundaryRef {
  return { superstep, atSeq, closedBy: 'step-end' }
}

/** Persist a plan state through the injected checkpointer cache. */
export async function persist(
  deps: ResolvedKernelDeps,
  plan: TaskPlan,
  atSeq: number,
  state: GraphState,
): Promise<void> {
  if (deps.validateJson) assertJson(state, 'checkpoint state')
  await deps.checkpointer.put(plan.id, atSeq, state)
}

/** Build a kernel `Checkpoint`-shaped record for `CheckpointSaver` hosts. */
export function planCheckpoint(deps: ResolvedKernelDeps, plan: TaskPlan, state: GraphState) {
  const nodeIds = state.journal.slice(-1).map((entry) => entry.nodeId)
  return createCheckpoint({
    state,
    threadId: plan.id,
    step: state.superstep,
    ranNodes: nodeIds,
    determinism: deps.determinism,
  })
}

/** True when a value is a plain JSON object (used by the LangGraph channel adapter). */
export function isJsonObject(value: unknown): value is Record<string, JsonValue> {
  return typeof value === 'object' && value !== null && !Array.isArray(value) && isJson(value)
}

/** Narrowed `KernelRunHandle` contract used by `runPlan`. */
export type PlanRunHandle = KernelRunHandle
