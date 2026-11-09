/**
 * `dsh-graph-loop-core/kernel` — the kernel-agnostic graph interface a DSH agent
 * loop compiles against.
 *
 * This file is the boundary between the driver contract (`packages/core/src/runtime.ts`)
 * and whatever executes the graph. Two implementations satisfy it:
 *
 *   1. `LangGraphKernel`  — a thin adapter over `@langchain/langgraph@1.7.0`,
 *                           in `packages/loop/src/kernel/langgraph.ts`.
 *   2. `MinimalKernel`    — the vendored fallback in
 *                           `packages/loop/src/kernel/minimal.ts`, used when the
 *                           optional dependency is absent.
 *
 * Nothing here imports a third-party type. A graph author writes against this
 * file; swapping the kernel must not change call sites.
 *
 * ---------------------------------------------------------------------------
 * DSH-specific constraints that shaped this interface (do not relax casually)
 * ---------------------------------------------------------------------------
 *
 * C1. STATE IS JSON. DSH's source of truth is the append-only session log, and
 *     a checkpoint payload is *not* JSON-lossless (measured: a `Date` returns
 *     as a `string`, a `Map` as `{}` after `JSON.stringify`). Graph state is
 *     therefore restricted to `JsonValue`. No `Date`, `Map`, `Set`, class
 *     instances, functions, `undefined` inside containers, or `BigInt`.
 *     Use ISO-8601 strings, plain objects, and arrays.
 *
 * C2. NODE = ONE DSH STEP. A node body is exactly what
 *     `ReactLoopAgent.step()` does today: one model request plus the tool batch
 *     it emits (`packages/core/agent-loop/src/agent.ts` in the DSH checkout). A
 *     superstep boundary is `step/end` followed by the next `step/start`.
 *
 * C3. THE SESSION LOG IS THE ONLY HISTORY. The checkpointer is a *runtime*
 *     facility. It never replaces a session event, and the adapter must never
 *     reconstruct model history from a checkpoint: DSH derives it from the log
 *     (`deriveMessages()`), and a checkpoint that is not also in the log would
 *     make a model-visible fact invisible to restore/replay.
 *
 * C4. INTERRUPTS LIVE AT NODE BOUNDARIES. LangGraph re-executes a node body
 *     from the top after `Command({resume})` (measured: an expensive call
 *     before `interrupt()` ran twice). Any side effect before the pause point
 *     is therefore repeated. In DSH, a human gate is an ordinary tool call
 *     (`packages/interaction/tool-ask-user/src/index.ts`), which already pauses
 *     inside a step and feeds the answer back as a tool result. So:
 *       - prefer `ask_user_question` (a tool) over `ctx.interrupt()`;
 *       - if `ctx.interrupt()` is used anyway, the node must be *pure up to the
 *         pause point* and the pause must be the first statement that matters.
 *
 * C5. NO MID-TURN RESUME ACROSS PROCESSES. DSH closes an interrupted turn with
 *     synthetic closers on restore (`packages/core/session/src/repair.ts`,
 *     called from `packages/core/agent-loop/src/index.ts` in the DSH checkout).
 *     A graph run therefore never continues across a restart; a durable saver
 *     buys nothing for correctness and is only useful for in-turn time travel /
 *     debugging.
 */

import type { GraphState, Json, PlanNode, TaskPlan } from './graph-schema.js'

/**
 * NOTE ON LAYERING. `packages/core/src/runtime.ts` declares `KernelPort`,
 * `KernelRunHandle` and `NodeExecutorPort`; this file owns the kernel-facing
 * graph interface. Those names are deliberately **not** imported here: the
 * pieces this file needs from that contract are re-declared below,
 * structurally, and the two shapes are kept in conformance by the kernel tests.
 */

/* ========================================================================== *
 * JSON
 * ========================================================================== */

/** The only value domain graph state may use. See C1. */
export type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { [key: string]: JsonValue }

/** A partial state update. Nodes return one of these. */
export type JsonUpdate = { [key: string]: JsonValue }

/**
 * Shape constraint for a graph's state type.
 *
 * Deliberately `object`, not `JsonUpdate`: TypeScript gives interfaces no
 * implicit index signature, so `interface LoopState { … }` would not satisfy
 * `Record<string, JsonValue>` even when every field is JSON. JSON-ness is
 * therefore a *runtime* rule enforced by `validateJson` in development builds
 * and by the adapter (obligation A2), not a type-level one.
 */
export type StateObject = object

/** Structural test used by the adapter in development builds. */
export type JsonGuard = (value: unknown) => value is JsonValue

/* ========================================================================== *
 * Determinism
 * ========================================================================== */

/**
 * Injected sources of nondeterminism.
 *
 * LangGraph assigns checkpoint ids from a uuid6 generator and timestamps from
 * `new Date()` (`Checkpoint.id`, `Checkpoint.ts`). Traces still replay
 * logically, but ids differ between two identical runs. DSH wants A/B runs and
 * tests to be diffable, so every id/time the kernel produces comes from here.
 */
export interface DeterminismHooks {
  /** Monotonic-ish wall clock, milliseconds. */
  readonly now: () => number
  /** A fresh unique id (checkpoint ids, interrupt ids, task ids). */
  readonly newId: () => string
  /** Uniform [0, 1). Only used where the kernel needs randomisation. */
  readonly random: () => number
}

/** Deterministic defaults: fixed clock and a counter-based id. */
export function createDeterministicHooks(seed = 'dsh'): DeterminismHooks {
  let counter = 0
  return {
    now: () => 0,
    newId: () => `${seed}-${(counter++).toString(36).padStart(6, '0')}`,
    random: () => 0.5,
  }
}

/** Production hooks: `Date.now`, `crypto.randomUUID`, `Math.random`. */
export function createSystemHooks(): DeterminismHooks {
  return {
    now: () => Date.now(),
    newId: () => globalThis.crypto.randomUUID(),
    random: () => Math.random(),
  }
}

const DEFAULT_HOOKS: DeterminismHooks = createDeterministicHooks()

/* ========================================================================== *
 * Errors
 * ========================================================================== */

export type KernelErrorCode =
  /** A node returned a value rejected by the state schema. */
  | 'INVALID_UPDATE'
  /** The run exceeded `maxSteps`. DSH surfaces this as a step-budget stop. */
  | 'STEP_BUDGET_EXCEEDED'
  /** A conditional router named a node that is not declared in `ends`. */
  | 'UNDECLARED_TARGET'
  /** The graph is malformed (duplicate node, edge to a missing node, no entry). */
  | 'INVALID_GRAPH'
  /** A plan node id collides with a kernel channel or a reserved engine id. */
  | 'BAD_NODE_ID'
  /** A node threw, or its retry policy was exhausted. */
  | 'NODE_FAILED'
  /** `ctx.interrupt()` was called with no saver, or outside a node. */
  | 'INTERRUPT_UNSUPPORTED'
  /** The run was cancelled through its `AbortSignal`. */
  | 'ABORTED'
  /** A state value was not JSON (C1). Development builds only. */
  | 'NON_JSON_STATE'

export class KernelError extends Error {
  readonly code: KernelErrorCode
  readonly node: string | undefined

  constructor(message: string, code: KernelErrorCode, options?: { node?: string; cause?: unknown }) {
    super(message, options?.cause === undefined ? undefined : { cause: options.cause })
    this.name = 'KernelError'
    this.code = code
    this.node = options?.node
  }
}

/* ========================================================================== *
 * Nodes
 * ========================================================================== */

export type NodeId = string

/** Retry policy for a node. Maps to LangGraph's `RetryPolicy` 1:1. */
export interface RetryPolicy {
  /** Total attempts, including the first. */
  maxAttempts: number
  /** Initial backoff in ms; the kernel may grow it. */
  initialDelayMs?: number
  /** Multiplier applied per attempt. Default 2. */
  backoffFactor?: number
  /** Upper bound on a single delay. */
  maxDelayMs?: number
  /** Return `true` to retry this error. Default: retry everything but `ABORTED`. */
  retryOn?: (error: unknown) => boolean
}

/** Per-node execution constraints. */
export interface NodePolicy {
  retry?: RetryPolicy
  /** Hard wall-clock cap for one attempt. */
  timeoutMs?: number
  /**
   * Destinations this node may route to at runtime (LangGraph `ends`).
   *
   * Required when the node returns a {@link RouteCommand}; LangGraph rejects
   * undeclared destinations at `compile()` with `UNREACHABLE_NODE`. Declaring
   * them here keeps both kernels honest about the graph's static shape.
   */
  ends?: readonly NodeId[]
}

/** What a node body receives. */
export interface NodeContext<S extends StateObject = StateObject> {
  /** Frozen snapshot of the state at superstep entry. C4: never mutate. */
  readonly state: Readonly<S>
  readonly threadId: string
  /** 0-based superstep index inside this run. Equals the DSH step offset. */
  readonly step: number
  /** The run's cancellation signal — derived from the DSH turn abort controller. */
  readonly signal: AbortSignal
  /** Determinism hooks the node should use for any ids or timestamps it mints. */
  readonly determinism: DeterminismHooks
  /**
   * Emit a custom streaming chunk. Maps to LangGraph `streamMode: "custom"`;
   * the DSH adapter forwards it to the `agent/assistant-stream` live event.
   */
  emit(chunk: JsonValue): void
  /**
   * Pause the run and surface `payload` to the host (LangGraph `interrupt()`).
   *
   * C4 — the node body is re-entered from the top when the run resumes, so
   * everything before this call runs twice. Use it only when the node is pure
   * up to this point. Prefer the `ask_user_question` tool (see C4).
   */
  interrupt<T extends JsonValue>(payload: JsonValue): Promise<T>
}

/** A node body. Returns a partial state update. */
export type NodeFn<S extends StateObject = StateObject> = (ctx: NodeContext<S>) => JsonUpdate | Promise<JsonUpdate>

/**
 * Explicit routing returned from a node instead of a plain update
 * (LangGraph `Command({ goto, update })`).
 */
export interface RouteCommand {
  readonly goto: NodeId | typeof END
  readonly update?: JsonUpdate
}

/** The terminal marker (mirrors LangGraph's `END`). */
export const END = '__end__' as const
/** The entry marker (mirrors LangGraph's `START`). */
export const START = '__start__' as const
export type END = typeof END
export type START = typeof START

/* ========================================================================== *
 * Edges and fan-out
 * ========================================================================== */

/**
 * A conditional router. Returns exactly one destination.
 *
 * Returning several destinations is *not* a fan-out — it is an ambiguity. Use
 * {@link fanOut} for parallel branches.
 */
export type EdgeRouter<S extends StateObject = StateObject> = (state: Readonly<S>) => NodeId | typeof END

/**
 * One parallel branch (LangGraph `Send`).
 *
 * Measured: `Send[]` is valid **only** as the return value of a conditional
 * edge router. Returning it from a node body throws
 * `InvalidUpdateError: Expected node "x" to return an object or an array
 * containing at least one Command object, received array`. Fan-out width is
 * data-driven and unbounded (verified with 6 branches).
 */
export interface FanOutTarget {
  readonly node: NodeId
  /** Partial state handed to that branch. Not type-checked by LangGraph. */
  readonly input: JsonUpdate
}

/** A fan-out router: returns N branch spawns. */
export type FanOutRouter<S extends StateObject = StateObject> = (state: Readonly<S>) => readonly FanOutTarget[]

/* ========================================================================== *
 * Graph definition
 * ========================================================================== */

export interface GraphOptions<S extends StateObject = StateObject> {
  /** Human-readable graph name; appears in traces and session plugin records. */
  readonly name: string
  /** Validate every update against the JSON domain (C1). Off in production. */
  readonly validateJson?: boolean
  /** Initial state for a fresh thread. Must be JSON. */
  readonly initialState?: S
}

/** Builder handed to `createGraph`. Chainable, mutable, not thread-safe. */
export interface GraphBuilder<S extends StateObject> {
  addNode(id: NodeId, run: NodeFn<S>, policy?: NodePolicy): this
  /** Unconditional edge. `from` may be {@link START}. */
  addEdge(from: NodeId | typeof START, to: NodeId | typeof END): this
  /**
   * Conditional edge. Exactly one destination per evaluation.
   * `ends` is the declared target set; both kernels validate against it.
   */
  addConditionalEdge(from: NodeId, router: EdgeRouter<S>, ends?: readonly NodeId[]): this
  /**
   * Parallel fan-out: spawn 0..N branches of `target` in one superstep.
   * Results join through the state reducers at the next superstep.
   */
  addFanOut(from: NodeId, router: FanOutRouter<S>, target: NodeId): this
  compile<C extends CompiledGraph<S>>(options?: CompileOptions<S>): C
}

export interface CompileOptions<S extends StateObject = StateObject> {
  /**
   * Runtime checkpointer. Omit for a stateless run.
   *
   * DSH guidance (C5): use {@link InTurnCheckpointer} backed by memory. A
   * durable saver is only justified for debugging/time-travel, and even then it
   * must be a sidecar, never a session event.
   */
  checkpointer?: CheckpointSaver<S>
  /** Node ids that force a pause *before* execution (LangGraph `interruptBefore`). */
  interruptBefore?: readonly NodeId[]
  /** Node ids that force a pause *after* execution (LangGraph `interruptAfter`). */
  interruptAfter?: readonly NodeId[]
  /** Hard cap on supersteps per run. DSH's step budget. */
  maxSteps?: number
  /** Name of the entry node; defaults to the single node with no inbound edge. */
  entry?: NodeId
}

/* ========================================================================== *
 * Execution
 * ========================================================================== */

export interface RunOptions {
  readonly threadId: string
  /** Cancellation. Aborts the run with `ABORTED` at the next boundary. */
  readonly signal?: AbortSignal
  readonly determinism?: DeterminismHooks
  /** Resume a paused run with an answer to its interrupt (LangGraph `Command`). */
  readonly resume?: JsonValue
  /** Override the compiled `maxSteps`. */
  readonly maxSteps?: number
  /**
   * Receives every superstep boundary the kernel crosses, *before* it executes
   * the next node. This is where the DSH adapter appends `step/end`/`step/start`
   * so the log order matches execution order.
   */
  readonly onBoundary?: (boundary: SuperstepBoundary) => void | Promise<void>
}

export interface SuperstepBoundary {
  readonly step: number
  readonly completedNodes: readonly NodeId[]
  /** Nodes about to run. Empty when the run is finishing. */
  readonly next: readonly NodeId[]
}

/** The result of a finished run. */
export interface RunResult<S extends StateObject = StateObject> {
  readonly state: Readonly<S>
  readonly status: 'completed' | 'interrupted' | 'failed' | 'aborted'
  /** Set when `status === 'interrupted'`. */
  readonly interrupt?: InterruptRecord
  readonly steps: number
  readonly checkpointId?: string
}

/** A paused run awaiting an answer. */
export interface InterruptRecord {
  readonly id: string
  readonly node: NodeId
  readonly step: number
  readonly payload: JsonValue
}

/** Events a `stream()` consumer observes. Mirrors the DSH event vocabulary. */
export type GraphEvent<S extends StateObject = StateObject> =
  | { readonly type: 'run/start'; readonly threadId: string }
  | { readonly type: 'superstep/start'; readonly step: number; readonly nodes: readonly NodeId[] }
  | { readonly type: 'node/start'; readonly step: number; readonly node: NodeId }
  | { readonly type: 'node/end'; readonly step: number; readonly node: NodeId; readonly update: JsonUpdate }
  | { readonly type: 'node/error'; readonly step: number; readonly node: NodeId; readonly error: KernelError }
  | { readonly type: 'interrupt'; readonly interrupt: InterruptRecord }
  | { readonly type: 'custom'; readonly node: NodeId; readonly chunk: JsonValue }
  | { readonly type: 'run/end'; readonly result: RunResult<S> }

/** A compiled, immutable graph. Safe to share across threads. */
export interface CompiledGraph<S extends StateObject = StateObject> {
  readonly name: string
  /** Run to completion (or to the first interrupt). */
  invoke(input: JsonUpdate, options: RunOptions): Promise<RunResult<S>>
  /** Run, emitting every {@link GraphEvent} as it happens. */
  stream(input: JsonUpdate, options: RunOptions): AsyncIterable<GraphEvent<S>>
  /** Read the latest checkpoint for a thread. `undefined` when none exists. */
  getState(threadId: string): Promise<CheckpointSnapshot<S> | undefined>
  /** Walk a thread's checkpoint chain, newest first. Debugging only. */
  getStateHistory(threadId: string): AsyncIterable<CheckpointSnapshot<S>>
  /** Replace graph topology *between* runs by rebuilding and recompiling. */
  withTopology(edit: (builder: GraphBuilder<S>) => void): CompiledGraph<S>
  /**
   * LangGraph-materialise this graph as its own `StateGraph` for debugging in
   * LangGraph Studio. Never called in production.
   */
  introspect?: () => unknown
}

/* ========================================================================== *
 * Checkpointing
 * ========================================================================== */

/** One stored checkpoint. JSON-only (C1). */
export interface Checkpoint<S extends StateObject = StateObject> {
  readonly id: string
  readonly threadId: string
  readonly step: number
  /** Id of the previous checkpoint on this thread, for time travel. */
  readonly parentId?: string
  /** ISO-8601 (`DeterminismHooks.now`). */
  readonly createdAt: string
  readonly state: S
  /** Nodes executed in the superstep that produced this checkpoint. */
  readonly ranNodes: readonly NodeId[]
  /** Pending pause, when the run stopped at an interrupt. */
  readonly interrupt?: InterruptRecord
}

export interface CheckpointSnapshot<S extends StateObject = StateObject> {
  readonly checkpoint: Checkpoint<S>
  readonly next: readonly NodeId[]
}

/**
 * Persistence port. Deliberately must be JSON round-trippable: the DSH
 * implementation of this interface stores its rows in a `ctx.storageDomain`
 * table, not in the session log (C3/C5).
 */
export interface CheckpointSaver<S extends StateObject = StateObject> {
  get(threadId: string, checkpointId?: string): Promise<Checkpoint<S> | undefined>
  put(checkpoint: Checkpoint<S>): Promise<void>
  list(threadId: string): AsyncIterable<Checkpoint<S>>
  deleteThread(threadId: string): Promise<void>
}

/** The only saver DSH needs by default (C5): process-local, in-turn. */
export declare class InTurnCheckpointer<S extends StateObject = StateObject> implements CheckpointSaver<S> {
  constructor(options?: { maxCheckpointsPerThread?: number })
  get(threadId: string, checkpointId?: string): Promise<Checkpoint<S> | undefined>
  put(checkpoint: Checkpoint<S>): Promise<void>
  list(threadId: string): AsyncIterable<Checkpoint<S>>
  deleteThread(threadId: string): Promise<void>
}

/* ========================================================================== *
 * Entry point
 * ========================================================================== */

/**
 * Create a graph builder. The kernel adapter owns the implementation.
 *
 * @example  // one node == one DSH step
 * const graph = createGraph<LoopState>({ name: 'react', initialState })
 *   .addNode('model', runModelStep, { retry: { maxAttempts: 3 } })
 *   .addNode('tools', runToolBatch)
 *   .addNode('finish', markDone)
 *   .addEdge(START, 'model')
 *   .addConditionalEdge('model', (s) => (s.toolCallCount > 0 ? 'tools' : 'finish'), ['tools', 'finish'])
 *   .addConditionalEdge('tools', () => 'model', ['model'])
 *   .addEdge('finish', END)
 *   .compile({ checkpointer: new InTurnCheckpointer(), maxSteps: 64 })
 */
export declare function createGraph<S extends StateObject>(
  options: GraphOptions<S>,
): GraphBuilder<S>

/* ========================================================================== *
 * Adapter obligations (normative)
 * ========================================================================== *
 *
 * A kernel adapter MUST:
 *   A1. Translate every superstep boundary into exactly one DSH
 *       `step/end` + `step/start` pair, emitted through
 *       `RunOptions.onBoundary`, so the session log never contains a model
 *       request outside its own step (C2).
 *   A2. Keep state JSON (C1) and reject non-JSON updates in development.
 *   A3. Never derive model history from a checkpoint (C3).
 *   A4. Treat `ctx.interrupt()` as legal only when the node is pure before the
 *       pause, and always prefer the `ask_user_question` tool (C4).
 *   A5. Fail the run rather than continue when the session append fails: the
 *       kernel must not advance state that the log does not record.
 *   A6. Map `maxSteps` to the DSH per-turn step budget (`GraphRecursionError`
 *       is a step-budget stop, not a crash).
 *   A7. Forward `AbortSignal` cancellation to the turn's abort controller and
 *       resolve as `status: 'aborted'` rather than throwing across the loop.
 */

/* ========================================================================== *
 * Layer 2 — the DSH-shaped kernel port (`packages/core/src/runtime.ts` calls this)
 * ========================================================================== *
 *
 * `packages/core/src/runtime.ts` owns `KernelPort` / `KernelRunHandle`; the
 * concrete adapters in `packages/loop/src/kernel/` satisfy them. The split
 * exists so `runtime.ts`, the node executors and the DSH bundle never see a
 * LangGraph type and can be compiled/tested without the dependency installed.
 *
 * The adapter takes the LangGraph module as a *structural port*
 * (`LangGraphSurface`) instead of importing it: `packages/core` stays
 * dependency-free, the bundle performs the single
 * `await import('@langchain/langgraph')`, and the kernel conformance test checks
 * that the real 1.7.0 module still satisfies this port.
 */

/** Structural port of the `@langchain/langgraph` exports this kernel uses. */
export interface LangGraphSurface {
  /** `new StateGraph(Annotation.Root({...}))` */
  readonly StateGraph: new (annotation: any) => LangGraphStateGraphLike
  /** Callable annotation factory, plus `.Root({...})` for a state definition. */
  readonly Annotation: { (fields?: any): any; Root(fields: Record<string, any>): any }
  readonly START: string
  readonly END: string
  /** `new MemorySaver()` — the in-turn checkpointer (C5). */
  readonly MemorySaver: new () => any
  /** `new Command({ resume })` for resuming a paused run. */
  readonly Command: new (args: {
    resume?: unknown
    goto?: string
    update?: Record<string, unknown> | [string, unknown][]
  }) => any
  /** `interrupt(payload)` inside a node. Forbidden in DSH node bodies (C4). */
  readonly interrupt: (payload: unknown) => unknown
  /** `new Send(node, input)` for dynamic fan-out. */
  readonly Send: new (node: string, input: unknown) => any
}

export interface LangGraphStateGraphLike {
  addNode(id: string, run: (state: any, config?: any) => any, options?: { ends?: readonly string[] }): this
  addEdge(from: string, to: string): this
  addConditionalEdges(from: string, router: (state: any) => any, ends?: readonly string[]): this
  compile(options?: { checkpointer?: any }): LangGraphCompiledLike
}

export interface LangGraphCompiledLike {
  invoke(input: any, options?: any): Promise<any>
  stream(input: any, options?: any): Promise<AsyncIterable<any>>
  getState(config: any): Promise<{ values: any; next?: readonly string[] }>
  updateState(config: any, values: any, asNode?: string): Promise<any>
}

/**
 * The checkpointer the driver owns: the session log is authoritative, this is a
 * cache keyed by `(sessionId, atSeq)`. Structurally identical to
 * `packages/core/src/runtime.ts` `KernelPort['checkpointer']`.
 */
export interface KernelCheckpointerPort {
  load(sessionId: string, atSeq: number): Promise<GraphState | undefined>
  put(sessionId: string, atSeq: number, state: GraphState): Promise<void>
}

/** Why a run paused, so the next turn can resume the same graph. */
export type KernelPauseReason = 'user-input' | 'human-gate' | 'replan' | 'budget' | 'error'

/** A node failure in the shape `packages/core/src/runtime.ts` `NodeFailure` uses. */
export interface KernelNodeFailure {
  readonly code:
    | 'tool-failed'
    | 'validation-failed'
    | 'context-overflow'
    | 'budget-exceeded'
    | 'subagent-failed'
    | 'cancelled'
    | 'graph-error'
  readonly nodeId: string
  readonly message: string
  readonly retryable: boolean
}

/** One executor per `NodeExecutor` kind. Structurally `runtime.ts` `NodeExecutorPort`. */
export interface KernelNodeExecutorPort {
  readonly kind: 'step' | 'subagent'
  execute(
    node: PlanNode,
    context: {
      readonly plan: TaskPlan
      readonly state: GraphState
      readonly turn: number
      readonly superstep: number
      readonly port: unknown
      readonly siblings: readonly string[]
    },
  ): Promise<{
    readonly nodeId: string
    readonly ok: boolean
    readonly facts: { readonly [key: string]: Json }
    readonly artifacts: readonly { readonly type: string; readonly ref: string; readonly hash?: string }[]
    readonly failure?: KernelNodeFailure
    readonly atSeq: number
  }>
}

/** Everything the adapter needs from its host. Supplied by the DSH bundle. */
export interface LangGraphKernelDeps {
  readonly lg: LangGraphSurface
  /** One executor per `NodeExecutor` kind, e.g. `step` and `subagent`. */
  readonly executors: readonly KernelNodeExecutorPort[]
  /** Authoritative log-fold checkpointer (structurally `KernelPort['checkpointer']`). */
  readonly checkpointer: KernelCheckpointerPort
  /**
   * Called at every node boundary, after the node's durable effects are logged
   * and before the next node runs. Returns the session seq that closed the
   * boundary. This is the ONLY place a boundary appends session events
   * (obligation A1); node bodies append their own model-visible facts.
   */
  readonly afterNode: (input: {
    readonly plan: TaskPlan
    readonly node: PlanNode
    readonly state: GraphState
    readonly superstep: number
  }) => Promise<{ readonly atSeq: number; readonly state: GraphState; readonly failure?: KernelNodeFailure }>
  /**
   * Plan policy: which node runs after `nodeId` finished, or `END`.
   *
   * The kernel deliberately does NOT evaluate plan `Condition`s — that is plan
   * policy owned by `condition.ts` and the kernel adapter. Supplying this keeps
   * the kernel a *kernel*: topology, stepping, boundaries and checkpoints, with
   * no plan semantics inside. Default: the first `control` edge leaving
   * `nodeId`, else `END`.
   */
  readonly route?: (input: {
    readonly plan: TaskPlan
    readonly nodeId: string
    readonly state: GraphState
  }) => string | typeof END
  /** Per-run context the driver knows but `compile(plan, state)` does not carry. */
  readonly runContext?: { readonly turn?: number; readonly signal?: AbortSignal }
  /** Signals the run should pause *before* the next node (budget, replan, gate). */
  readonly pauseWhen?: (state: GraphState) => KernelPauseReason | undefined
  /** Called when a node throws or its executor reports a failure. */
  readonly onFailure?: (failure: KernelNodeFailure) => void
  /** Determinism hooks. Defaults to `createSystemHooks()`. */
  readonly determinism?: DeterminismHooks
  /** Fail fast when a graph state value is not JSON (C1). Default: true in dev. */
  readonly validateJson?: boolean
}

/** The LangGraph-backed `KernelPort`. */
export function createLangGraphKernel(deps: LangGraphKernelDeps): KernelPortLike {
  const checkpointer = deps.checkpointer
  return {
    checkpointer,
    compile: (plan, state) => new LangGraphRun(deps, plan, state),
    // `resume` differs from `compile` only in that the caller passes the state
    // folded from the log; the graph is rebuilt from the (possibly replanned)
    // plan, which is how nodes are added or removed between runs (C6.5).
    resume: (plan, state) => new LangGraphRun(deps, plan, state),
  }
}

/** One live run. Public only through `createLangGraphKernel`. */
class LangGraphRun implements KernelRunHandleLike {
  readonly runId: string
  readonly planId: string
  private readonly deps: LangGraphKernelDeps
  private readonly plan: TaskPlan
  private state: GraphState
  private compiled: LangGraphCompiledLike | undefined
  private iterator: AsyncIterator<any> | undefined
  private finished = false
  /**
   * One controller per stream. A replan retires the current stream and installs
   * a fresh controller, so the next stream is never opened on an aborted signal
   * (H7: an aborted controller made every post-replan `next()` throw AbortError).
   */
  private abort = new AbortController()

  constructor(deps: LangGraphKernelDeps, plan: TaskPlan, state: GraphState) {
    this.deps = deps
    this.plan = plan
    this.state = state
    this.planId = plan.id
    this.runId = `${plan.id}#${this.determinism.newId()}`
  }

  private get determinism(): DeterminismHooks {
    return this.deps.determinism ?? DEFAULT_HOOKS
  }

  private executorFor(kind: 'step' | 'subagent'): KernelNodeExecutorPort {
    const found = this.deps.executors.find((e) => e.kind === kind)
    if (!found) throw new KernelError(`no executor registered for kind "${kind}"`, 'INVALID_GRAPH')
    return found
  }

  private graph(): LangGraphCompiledLike {
    this.compiled ??= buildLangGraph(this.deps, this.plan, this.state)
    return this.compiled
  }

  /** Lazily open the LangGraph stream; `updates` mode yields one chunk per node. */
  private async ensureStream(): Promise<void> {
    if (this.iterator !== undefined) return
    const compiled = this.graph()
    const stream = await compiled.stream(this.state, {
      configurable: { thread_id: this.state.planId },
      streamMode: 'updates',
      recursionLimit: Math.max(25, this.plan.budget.maxNodes * 2),
      signal: this.deps.runContext?.signal ?? this.abort.signal,
    })
    this.iterator = stream[Symbol.asyncIterator]()
  }

  async next(): Promise<KernelResultLike> {
    if (this.finished) return { kind: 'done', state: this.state, terminal: this.state.next ?? END }

    const pause = this.deps.pauseWhen?.(this.state)
    if (pause !== undefined) {
      this.finished = true
      return { kind: 'paused', reason: pause, state: this.state }
    }

    // Both opening the stream and pulling one chunk can fail (aborted signal,
    // recompile, malformed graph). A kernel failure is a `{ kind: 'failed' }`
    // result plus `onFailure`, never an unstructured throw across the driver (A7).
    let step: IteratorResult<any>
    try {
      await this.ensureStream()
      step = await this.iterator!.next()
    } catch (error) {
      this.finished = true
      const aborted = this.deps.runContext?.signal?.aborted === true || this.abort.signal.aborted
      const failure: KernelNodeFailure = {
        code: aborted ? 'cancelled' : 'graph-error',
        nodeId: this.state.next ?? '',
        message: error instanceof Error ? error.message : String(error),
        retryable: false,
      }
      this.deps.onFailure?.(failure)
      return { kind: 'failed', state: this.state, error: failure }
    }

    if (step.done === true) {
      this.finished = true
      return { kind: 'done', state: this.state, terminal: this.state.next ?? END }
    }

    const chunk = step.value
    if (typeof chunk === 'object' && chunk !== null && '__interrupt__' in chunk) {
      // C4: DSH node bodies must not call `interrupt()`. Reaching this branch is
      // a node-executor bug, not a supported pause; the driver decides what to do.
      this.finished = true
      return { kind: 'paused', reason: 'human-gate', state: this.state }
    }

    const [nodeId, update] = pickUpdate(chunk)
    const node = this.plan.nodes.find((n) => n.id === nodeId)
    if (node === undefined) {
      throw new KernelError(`graph produced an unknown node "${String(nodeId)}"`, 'UNDECLARED_TARGET')
    }
    const merged = applyDelta(this.state, update)
    const after = await this.deps.afterNode({
      plan: this.plan,
      node,
      state: merged,
      superstep: merged.superstep,
    })
    this.state = after.state
    await this.deps.checkpointer.put(this.state.planId, after.atSeq, this.state)

    if (after.failure !== undefined) {
      this.finished = true
      this.deps.onFailure?.(after.failure)
      return { kind: 'failed', state: this.state, error: after.failure }
    }

    return {
      kind: 'boundary',
      nodeId,
      boundary: { superstep: this.state.superstep, atSeq: after.atSeq, closedBy: 'step-end' },
      state: this.state,
    }
  }

  async updateState(patch: Partial<GraphState>): Promise<void> {
    // The measured way to add/remove nodes: mutate the plan, recompile, and
    // seed the new graph with the current state. Keep the caller's patched state,
    // retire the current stream's controller, and install a fresh one so the next
    // `next()` opens a live stream (H7). The caller's runContext signal is never
    // aborted here: it belongs to the turn, not to this run handle.
    this.state = { ...this.state, ...patch }
    this.abort.abort(new KernelError('graph recompiled for a replan', 'INVALID_GRAPH'))
    this.abort = new AbortController()
    this.compiled = undefined
    this.iterator = undefined
    this.finished = false
  }

  snapshot(): GraphState {
    return this.state
  }

  async dispose(): Promise<void> {
    this.finished = true
    this.abort.abort()
    this.iterator = undefined
    this.compiled = undefined
  }
}

/** `{ [nodeId]: update }` from a LangGraph `updates`-mode chunk. */
function pickUpdate(chunk: unknown): [string, Record<string, unknown>] {
  if (Array.isArray(chunk) && chunk.length === 2 && typeof chunk[1] === 'object') {
    const inner = chunk[1] as Record<string, unknown>
    const key = Object.keys(inner)[0]
    if (key !== undefined) return [key, (inner[key] as Record<string, unknown>) ?? {}]
  }
  if (typeof chunk === 'object' && chunk !== null) {
    const key = Object.keys(chunk)[0]
    if (key !== undefined) return [key, (chunk as Record<string, unknown>)[key] as Record<string, unknown> ?? {}]
  }
  return ['', {}]
}

/** Shallow JSON merge; the caller's `afterNode` hook owns the real fold. */
function applyDelta(state: GraphState, update: Record<string, unknown>): GraphState {
  return { ...state, ...(update as Partial<GraphState>) }
}

/**
 * The driver-facing kernel surface. Structurally identical to
 * `packages/core/src/runtime.ts` `KernelPort` (asserted by the kernel tests);
 * declared here so this file has no type dependency on the driver module.
 */
export interface KernelPortLike {
  compile(plan: TaskPlan, state: GraphState): KernelRunHandleLike
  resume(plan: TaskPlan, state: GraphState): KernelRunHandleLike
  readonly checkpointer: KernelCheckpointerPort
}

/** One live run. `next()` drives the graph until the next durable boundary. */
export interface KernelRunHandleLike {
  readonly runId: string
  readonly planId: string
  next(): Promise<KernelResultLike>
  updateState(patch: Partial<GraphState>): Promise<void>
  snapshot(): GraphState
  dispose(): Promise<void>
}

export type KernelResultLike =
  | { readonly kind: 'boundary'; readonly nodeId: string; readonly boundary: KernelBoundaryRef; readonly state: GraphState }
  | { readonly kind: 'paused'; readonly reason: KernelPauseReason; readonly state: GraphState }
  | { readonly kind: 'done'; readonly state: GraphState; readonly terminal: string }
  | { readonly kind: 'failed'; readonly state: GraphState; readonly error: KernelNodeFailure }

/** Where a node boundary sits in the session log. */
export interface KernelBoundaryRef {
  readonly superstep: number
  /** Session seq after which the checkpoint is consistent. */
  readonly atSeq: number
  readonly closedBy: 'step-end' | 'injected-result' | 'turn-end' | 'fork'
}

/**
 * Build the LangGraph `StateGraph` for a plan.
 *
 * Topology rules (each is a design decision, not an implementation detail):
 *  - one LangGraph node per `PlanNode`, named by `PlanNode.id`;
 *  - `plan.entry` is reached from `START`; every `plan.terminals` node edges to `END`;
 *  - `control` edges become conditional edges whose router reads
 *    `GraphState.next`, because the plan — not the graph — decides control flow
 *    after a replan (`runtime.ts` owns that decision);
 *  - sibling `executor: 'subagent'` nodes sharing a predecessor are fanned out
 *    with `Send` in one superstep (C2 stays intact: they are child sessions);
 *  - `updateState` + a **recompiled** graph is the only way to add or remove
 *    nodes (measured: `addNode` does not exist on a compiled graph).
 */
export function buildLangGraph(
  deps: LangGraphKernelDeps,
  plan: TaskPlan,
  state: GraphState,
): LangGraphCompiledLike {
  const { lg } = deps
  const ids = plan.nodes.map((n) => n.id)
  const terminals = new Set(plan.terminals)

  // Channel reducers. State is JSON-only (C1); `afterNode` owns the real fold,
  // these exist so routing sees a coherent snapshot inside the graph.
  const replace = <T>(initial: T) => ({ reducer: (_l: T, r: T) => r, default: () => initial })
  const concat = <T>(initial: readonly T[]) => ({
    reducer: (l: readonly T[], r: readonly T[]) => [...l, ...r],
    default: () => initial,
  })

  const root = lg.Annotation.Root({
    taskHash: lg.Annotation(replace(state.taskHash)),
    planId: lg.Annotation(replace(state.planId)),
    planVersion: lg.Annotation(replace(state.planVersion)),
    superstep: lg.Annotation(replace(state.superstep)),
    next: lg.Annotation(replace(state.next)),
    status: lg.Annotation(replace(state.status)),
    facts: lg.Annotation({
      reducer: (l: Record<string, Json>, r: Record<string, Json>) => ({ ...l, ...r }),
      default: () => state.facts,
    }),
    artifacts: lg.Annotation(concat(state.artifacts)),
    children: lg.Annotation(concat(state.children)),
    journal: lg.Annotation(concat(state.journal)),
    budget: lg.Annotation(replace(state.budget)),
    replans: lg.Annotation(replace(state.replans)),
  })

  const builder = new lg.StateGraph(root)

  for (const node of plan.nodes) {
    builder.addNode(node.id, async (s: GraphState) => {
      const executor = deps.executors.find((e) => e.kind === node.executor)
      if (executor === undefined) {
        throw new KernelError(`no executor for node kind "${node.executor}"`, 'INVALID_GRAPH', { node: node.id })
      }
      const outcome = await executor.execute(node, {
        plan,
        state: s,
        turn: deps.runContext?.turn ?? 0,
        superstep: s.superstep,
        port: undefined,
        siblings: siblingsOf(plan, node.id),
      })
      // A failure is reported, not thrown: `afterNode` decides whether it is
      // fatal (runtime.ts owns the retry/replan policy).
      // Superstep is NOT advanced here: `afterNode` owns the fold (runtime.ts),
      // so a parallel superstep of N subagent nodes still counts as one.
      return { facts: outcome.facts, artifacts: outcome.artifacts }
    })
  }

  for (const node of plan.nodes) {
    if (terminals.has(node.id)) {
      builder.addEdge(node.id, lg.END)
      continue
    }
    builder.addConditionalEdges(
      node.id,
      (s: GraphState) => deps.route?.({ plan, nodeId: node.id, state: s }) ?? defaultNext(plan, node.id),
      [...ids, lg.END],
    )
  }

  builder.addEdge(lg.START, plan.entry)
  // No LangGraph checkpointer: C5 — a run never continues across a process
  // restart, and `interrupt()` is forbidden in node bodies (C4). Supply
  // `new lg.MemorySaver()` only for a node that genuinely must pause.
  return builder.compile({})
}

/** First `control` edge out of `nodeId`, else `END`. */
function defaultNext(plan: TaskPlan, nodeId: string): string {
  const edge = plan.edges.find((e) => e.from === nodeId && e.kind === 'control')
  return edge?.to ?? END
}

/** Other nodes in the same parallel superstep (only `subagent` nodes parallelise). */
function siblingsOf(plan: TaskPlan, nodeId: string): readonly string[] {
  const node = plan.nodes.find((n) => n.id === nodeId)
  if (node === undefined || node.executor !== 'subagent') return []
  const inbound = plan.edges.filter((e) => e.to === nodeId).map((e) => e.from)
  return plan.nodes
    .filter((n) => n.id !== nodeId && n.executor === 'subagent')
    .filter((n) => plan.edges.some((e) => e.to === n.id && inbound.includes(e.from)))
    .map((n) => n.id)
}

/**
 * Runtime conformance probe for a LangGraph module. Throws when the installed
 * version has moved a symbol this kernel depends on. Call it once at plugin
 * activation.
 */
export function assertLangGraphSurface(candidate: unknown): asserts candidate is LangGraphSurface {
  if (typeof candidate !== 'object' || candidate === null) {
    throw new KernelError('@langchain/langgraph did not load as an ES module namespace', 'INVALID_GRAPH')
  }
  const c = candidate as Record<string, unknown>
  const required = ['StateGraph', 'Annotation', 'START', 'END', 'MemorySaver', 'Command', 'interrupt', 'Send'] as const
  const missing = required.filter((name) => c[name] === undefined)
  if (missing.length > 0) {
    throw new KernelError(
      `@langchain/langgraph is missing kernel symbols: ${missing.join(', ')} — see docs/MERGE-LANGGRAPH.md`,
      'INVALID_GRAPH',
    )
  }
  const annotation = c['Annotation'] as Record<string, unknown> | undefined
  if (typeof annotation?.['Root'] !== 'function') {
    // `Annotation.Root` is the only state-definition entry point this kernel uses.
    throw new KernelError('@langchain/langgraph Annotation.Root is not a function', 'INVALID_GRAPH')
  }
  if (typeof c['START'] !== 'string' || typeof c['END'] !== 'string') {
    throw new KernelError('@langchain/langgraph START/END must be strings', 'INVALID_GRAPH')
  }
}

/* ========================================================================== *
 * LangGraph conformance map (implementation 1)
 * ========================================================================== *
 *
 * kernel                     | @langchain/langgraph@1.7.0
 * ---------------------------|-----------------------------------------------
 * createGraph                | `new StateGraph(AnnotationRoot)`
 * addNode                    | `.addNode(id, fn, { retryPolicy, ends })`
 * addEdge                    | `.addEdge(from, to)`
 * addConditionalEdge         | `.addConditionalEdges(from, router, ends[])`
 * addFanOut                  | `.addConditionalEdges(from, s => Send[], [target])`
 * compile                    | `.compile({ checkpointer })`
 * invoke                     | `.invoke(input, { configurable: { thread_id } })`
 * stream                     | `.stream(input, { streamMode: ['values','updates','custom'] })`
 * onBoundary                 | `streamMode: 'updates'` + `metadata.step` of each chunk
 * NodeContext.state          | node's first argument (a frozen copy — measured)
 * NodeContext.interrupt      | `interrupt(payload)` + `new Command({ resume })`
 * NodeContext.emit           | `getWriter()` / `streamMode: 'custom'`
 * maxSteps                   | `recursionLimit` (default 25)
 * RouteCommand               | `new Command({ goto, update })` + declared `ends`
 * CheckpointSaver            | `BaseCheckpointSaver` (`getTuple/list/put/putWrites/deleteThread`)
 * InTurnCheckpointer         | `MemorySaver`
 * getState/getStateHistory   | `.getState()` / `.getStateHistory()`
 * withTopology               | rebuild a `StateGraph` and re-`compile()`; verified
 *                              that a paused thread resumes into a recompiled
 *                              graph as long as channel names/versions match
 *
 * Known gaps (documented, accepted):
 *   - `Send` payloads are `any` — no type check against the state schema.
 *   - `config.configurable.thread_id` is typed `unknown`; the adapter casts.
 *   - `Command` requires compile-time `ends` declarations, so "add nodes on
 *     demand" means recompiling between runs, never at runtime.
 */
