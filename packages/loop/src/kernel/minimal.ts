/**
 * minimal.ts — the vendored stepwise kernel.
 *
 * Two surfaces, one engine:
 *
 *  1. Layer 1 (`createGraph` → `GraphBuilder` → `CompiledGraph`): a small
 *     StateGraph-compatible engine (~LangGraph semantics without the dep):
 *     nodes, unconditional/conditional edges, fan-out, END, checkpoints,
 *     `invoke`/`stream`.
 *  2. Layer 2 (`MinimalKernel implements KernelPort`): a `TaskPlan` run handle
 *     whose `next()` executes EXACTLY ONE plan node and returns a `boundary`
 *     result before the following node runs. This is the handle a DSH driver
 *     uses when it must interleave work (a model step) between nodes.
 *
 * Constraints:
 *  - C1: every value that can reach a checkpoint is checked with `assertJsonSafe`
 *    (default on; `validateJson: false` opts out in production).
 *  - C2: one node == one step; `next()` never runs two nodes.
 *  - `maxSteps` maps to the DSH step budget: Layer 2 returns
 *    `failed { code: 'budget-exceeded' }`, Layer 1 throws
 *    `KernelError('STEP_BUDGET_EXCEEDED')` (a budget stop, not a crash).
 */

import {
  END,
  KernelError,
  START,
  createDeterministicHooks,
} from '@dsh/explore-core/kernel'
import type {
  Checkpoint,
  CheckpointSnapshot,
  CompiledGraph,
  CompileOptions,
  DeterminismHooks,
  GraphBuilder,
  GraphEvent,
  GraphOptions,
  InterruptRecord,
  JsonUpdate,
  JsonValue,
  NodeContext,
  NodeId,
  NodePolicy,
  RunOptions,
  RunResult,
  StateObject,
  SuperstepBoundary,
} from '@dsh/explore-core/kernel'
import type { GraphState, PlanNode, TaskPlan } from '@dsh/explore-core/graph-schema'
import type { KernelPort, KernelResult, KernelRunHandle, NodeFailure, PauseReason } from '@dsh/explore-core/runtime'

import {
  GraphBuilderImpl,
  abortMessage,
  asKernelError,
  assertJson,
  cloneSpec,
  createCheckpoint,
  hooksOf,
  mergeState,
  rebuildBuilder,
  resolveTopology,
  successorTargets,
  fanOutBranches,
  type GraphCompileFn,
  type GraphSpec,
  type GraphTopology,
  type NodeSpec,
} from './builder.ts'
import {
  cancelledFailure,
  executePlanNode,
  failureOf,
  planInitialState,
  persist,
  resolveKernelDeps,
  type KernelDeps,
  type PlanCheckpointer,
  type ResolvedKernelDeps,
} from './plan.ts'

/* ========================================================================== *
 * Layer 1 — CompiledGraph over the minimal engine
 * ========================================================================== */

/** Build a graph for the minimal engine. Chainable, mutable, not thread-safe. */
export function createGraph<S extends StateObject>(options: GraphOptions<S>): GraphBuilder<S> {
  return new GraphBuilderImpl<S>(options, compileMinimal)
}

const MINIMAL_DEFAULT_MAX_STEPS = 64

function compileMinimal<S extends StateObject>(
  spec: GraphSpec<S>,
  options: CompileOptions<S>,
): CompiledGraph<S> {
  const topology = resolveTopology(spec, options)
  const compileFn: GraphCompileFn<S> = (nextSpec, nextOptions) => compileMinimal(nextSpec, nextOptions)

  async function invoke(input: JsonUpdate, runOptions: RunOptions): Promise<RunResult<S>> {
    let result: RunResult<S> | undefined
    for await (const event of stream(input, runOptions)) {
      if (event.type === 'run/end') result = event.result
    }
    if (result === undefined) throw new KernelError('graph run produced no run/end event', 'INVALID_GRAPH')
    return result
  }

  async function* stream(input: JsonUpdate, runOptions: RunOptions): AsyncGenerator<GraphEvent<S>> {
    yield* runMinimalStream(topology, options, input, runOptions)
  }

  async function getState(threadId: string): Promise<CheckpointSnapshot<S> | undefined> {
    const checkpoint = await options.checkpointer?.get(threadId)
    if (checkpoint === undefined) return undefined
    const next = checkpoint.interrupt !== undefined
      ? [checkpoint.interrupt.node]
      : checkpoint.ranNodes.length === 0
        ? [topology.entry]
        : successorTargets(topology, checkpoint.ranNodes[checkpoint.ranNodes.length - 1]!, checkpoint.state)
    return { checkpoint, next }
  }

  async function* getStateHistory(threadId: string): AsyncIterable<CheckpointSnapshot<S>> {
    if (options.checkpointer === undefined) return
    for await (const checkpoint of options.checkpointer.list(threadId)) {
      yield { checkpoint, next: await nextOf(checkpoint) }
    }
  }

  async function nextOf(checkpoint: Checkpoint<S>): Promise<readonly NodeId[]> {
    if (checkpoint.interrupt !== undefined) return [checkpoint.interrupt.node]
    const last = checkpoint.ranNodes[checkpoint.ranNodes.length - 1]
    if (last === undefined) return [topology.entry]
    return successorTargets(topology, last, checkpoint.state)
  }

  function withTopology(edit: (builder: GraphBuilder<S>) => void): CompiledGraph<S> {
    const builder = rebuildBuilder(cloneSpec(spec), compileFn)
    edit(builder)
    return builder.compile<CompiledGraph<S>>(options)
  }

  return {
    name: spec.name,
    invoke,
    stream,
    getState,
    getStateHistory,
    withTopology,
    introspect: () => ({
      engine: 'minimal',
      name: spec.name,
      entry: topology.entry,
      nodes: spec.nodes.map((node) => node.id),
      edges: spec.edges.map((edge) => ({ from: edge.from, to: edge.to })),
      conditionals: spec.conditionals.map((edge) => ({ from: edge.from, ends: edge.ends ?? null })),
      fanOuts: spec.fanOuts.map((edge) => ({ from: edge.from, target: edge.target })),
    }),
  }
}

/* ========================================================================== *
 * Minimal engine — one superstep at a time
 * ========================================================================== */

async function* runMinimalStream<S extends StateObject>(
  topology: GraphTopology<S>,
  options: CompileOptions<S>,
  input: JsonUpdate,
  runOptions: RunOptions,
): AsyncGenerator<GraphEvent<S>> {
  const spec = topology.spec
  const determinism: DeterminismHooks = hooksOf(runOptions.determinism)
  const saver = options.checkpointer
  const threadId = runOptions.threadId
  const signal = runOptions.signal
  const validate = spec.validateJson
  const maxSteps = runOptions.maxSteps ?? options.maxSteps ?? MINIMAL_DEFAULT_MAX_STEPS
  const before = new Set(options.interruptBefore ?? [])
  const after = new Set(options.interruptAfter ?? [])

  const base = (spec.initialState ?? {}) as S
  let state = mergeState(base, input)
  if (validate) assertJson(state, 'initial state')

  let current: NodeId | null = topology.entry
  let stepIndex = 0
  let steps = 0
  let status: RunResult<S>['status'] = 'completed'
  let pendingInterrupt: InterruptRecord | undefined
  let parentId: NodeId | undefined
  let checkpointId: string | undefined

  yield { type: 'run/start', threadId }

  const save = async (ranNodes: readonly NodeId[], interrupt?: InterruptRecord): Promise<void> => {
    if (saver === undefined) return
    const checkpoint = createCheckpoint<S>({
      state,
      threadId,
      step: steps,
      ranNodes,
      determinism,
      ...(parentId === undefined ? {} : { parentId }),
      ...(interrupt === undefined ? {} : { interrupt }),
    })
    if (validate) assertJson(checkpoint.state, `checkpoint ${checkpoint.id} state`)
    await saver.put(checkpoint)
    parentId = checkpoint.id
    checkpointId = checkpoint.id
  }

  const emitInterrupt = (interrupt: InterruptRecord): GraphEvent<S> => ({ type: 'interrupt', interrupt })

  while (current !== null) {
    if (signal?.aborted === true) {
      status = 'aborted'
      break
    }
    if (steps >= maxSteps) {
      throw new KernelError(
        `step budget exhausted: ${steps} of ${maxSteps} supersteps used`,
        'STEP_BUDGET_EXCEEDED',
        { node: current },
      )
    }

    const node = spec.nodes.find((candidate) => candidate.id === current)
    if (node === undefined) {
      throw new KernelError(`graph has no node "${current}"`, 'INVALID_GRAPH', { node: current })
    }

    if (before.has(current)) {
      if (saver === undefined) {
        throw new KernelError('interruptBefore requires a checkpointer', 'INTERRUPT_UNSUPPORTED', { node: current })
      }
      pendingInterrupt = {
        id: determinism.newId(),
        node: current,
        step: steps,
        payload: null,
      }
      await save([], pendingInterrupt)
      yield emitInterrupt(pendingInterrupt)
      status = 'interrupted'
      break
    }

    yield { type: 'superstep/start', step: stepIndex, nodes: [current] }
    yield { type: 'node/start', step: stepIndex, node: current }

    let update: JsonUpdate
    try {
      const run = nodeRunStream(spec, node, state, stepIndex, signal, validate, determinism, threadId)
      let next = await run.next()
      while (next.done !== true) {
        yield { type: 'custom', node: current, chunk: next.value }
        next = await run.next()
      }
      update = next.value
    } catch (error) {
      const kernelError = asKernelError(error, current)
      yield { type: 'node/error', step: stepIndex, node: current, error: kernelError }
      if (signal?.aborted === true) {
        status = 'aborted'
        break
      }
      throw kernelError
    }

    if (validate) assertJson(update, `update from "${current}"`, current)
    let merged = mergeState(state, update)
    if (validate) assertJson(merged, `state after "${current}"`, current)

    const ranNodes: NodeId[] = [current]

    // Fan-out: every branch runs in THIS superstep (same step index), in
    // declaration order, so the minimal engine stays deterministic.
    for (const branch of fanOutBranches(topology, current, merged)) {
      const branchNode = spec.nodes.find((candidate) => candidate.id === branch.node)
      if (branchNode === undefined) {
        throw new KernelError(`fan-out target "${branch.node}" is not declared`, 'UNDECLARED_TARGET', {
          node: current,
        })
      }
      const branchState = mergeState(merged, branch.input)
      const branchUpdate = await runNodeOnce(spec, branchNode, branchState, stepIndex, signal, validate, determinism, threadId)
      merged = mergeState(merged, branchUpdate)
      if (validate) assertJson(merged, `state after fan-out branch "${branch.node}"`, branch.node)
      ranNodes.push(branchNode.id)
      yield { type: 'node/end', step: stepIndex, node: branchNode.id, update: branchUpdate }
    }

    state = merged
    yield { type: 'node/end', step: stepIndex, node: current, update }

    steps += 1
    const nextTargets = successorTargets(topology, current, state)
    const boundary: SuperstepBoundary = {
      step: stepIndex + 1,
      completedNodes: ranNodes,
      next: nextTargets,
    }
    // A1: the boundary is emitted BEFORE the next node runs.
    await runOptions.onBoundary?.(boundary)
    await save(ranNodes)

    if (after.has(current)) {
      if (saver === undefined) {
        throw new KernelError('interruptAfter requires a checkpointer', 'INTERRUPT_UNSUPPORTED', { node: current })
      }
      pendingInterrupt = {
        id: determinism.newId(),
        node: nextTargets[0] ?? current,
        step: steps,
        payload: null,
      }
      await save(ranNodes, pendingInterrupt)
      yield emitInterrupt(pendingInterrupt)
      status = 'interrupted'
      break
    }

    stepIndex += 1
    current = nextTargets.length > 0 ? nextTargets[0]! : null
  }

  const result: RunResult<S> = {
    state,
    status,
    steps,
    ...(pendingInterrupt === undefined ? {} : { interrupt: pendingInterrupt }),
    ...(checkpointId === undefined ? {} : { checkpointId }),
  }
  yield { type: 'run/end', result }
}

/* ========================================================================== *
 * Layer 1 node execution (retry, timeout, custom chunks)
 * ========================================================================== */

type NodeRunnerSpec<S extends StateObject> = NodeSpec<S>

function makeNodeContext<S extends StateObject>(
  node: NodeSpec<S>,
  state: S,
  step: number,
  signal: AbortSignal | undefined,
  determinism: DeterminismHooks,
  threadId: string,
  emit: (chunk: JsonValue) => void,
  validate: boolean,
): NodeContext<S> {
  return {
    state: Object.freeze({ ...(state as object) }) as Readonly<S>,
    threadId,
    step,
    signal: signal ?? new AbortController().signal,
    determinism,
    emit: (chunk) => {
      if (validate) assertJson(chunk, 'emit chunk', node.id)
      emit(chunk)
    },
    interrupt: async () => {
      // C4: interrupts belong at node boundaries; DSH uses ask_user_question.
      throw new KernelError(
        `node "${node.id}" called ctx.interrupt(); use the ask_user_question tool instead (C4)`,
        'INTERRUPT_UNSUPPORTED',
        { node: node.id },
      )
    },
  }
}

function retrySettings(policy: NodePolicy | undefined): {
  readonly maxAttempts: number
  readonly initialDelayMs: number
  readonly backoffFactor: number
  readonly maxDelayMs: number
  readonly retryOn: (error: unknown) => boolean
} {
  const retry = policy?.retry
  return {
    maxAttempts: Math.max(1, retry?.maxAttempts ?? 1),
    initialDelayMs: Math.max(0, retry?.initialDelayMs ?? 0),
    backoffFactor: retry?.backoffFactor ?? 2,
    maxDelayMs: retry?.maxDelayMs ?? 5_000,
    retryOn: (error) => {
      if (error instanceof KernelError && error.code === 'ABORTED') return false
      return retry?.retryOn?.(error) ?? true
    },
  }
}

async function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * Yield the node body's `emit()` chunks as they happen, then return its update.
 * The sentinel queue keeps streaming live without polling.
 */
async function* nodeRunStream<S extends StateObject>(
  spec: GraphSpec<S>,
  node: NodeSpec<S>,
  state: S,
  step: number,
  signal: AbortSignal | undefined,
  validate: boolean,
  determinism: DeterminismHooks,
  threadId: string,
): AsyncGenerator<JsonValue, JsonUpdate, void> {
  const queue: Array<JsonValue | null> = []
  let wake: (() => void) | undefined
  let settled = false
  let failure: unknown
  let update: JsonUpdate | undefined

  const push = (chunk: JsonValue | null): void => {
    queue.push(chunk)
    wake?.()
    wake = undefined
  }

  const task = (async () => {
    try {
      const settings = retrySettings(node.policy)
      let attempt = 0
      for (;;) {
        attempt += 1
        const attemptSignal = signalFor(signal, node.policy?.timeoutMs)
        const context = makeNodeContext(node, state, step, attemptSignal, determinism, threadId, push, validate)
        try {
          signal?.throwIfAborted()
          update = await node.run(context)
          return update
        } catch (error) {
          if (!settings.retryOn(error) || attempt >= settings.maxAttempts) throw error
          const delay = Math.min(
            settings.maxDelayMs,
            settings.initialDelayMs * settings.backoffFactor ** (attempt - 1),
          )
          if (delay > 0) await sleep(delay)
        }
      }
    } catch (error) {
      failure = error
      throw error
    } finally {
      settled = true
      push(null)
    }
  })()
  task.catch(() => {})

  while (!settled || queue.length > 0) {
    if (queue.length === 0) {
      await new Promise<void>((resolve) => {
        wake = resolve
      })
    }
    while (queue.length > 0) {
      const item = queue.shift()!
      if (item !== null) yield item
    }
  }
  await task.catch(() => {})
  if (failure !== undefined) throw failure
  return update ?? {}
}

async function runNodeOnce<S extends StateObject>(
  spec: GraphSpec<S>,
  node: NodeRunnerSpec<S>,
  state: S,
  step: number,
  signal: AbortSignal | undefined,
  validate: boolean,
  determinism: DeterminismHooks,
  threadId: string,
): Promise<JsonUpdate> {
  const run = nodeRunStream(spec, node, state, step, signal, validate, determinism, threadId)
  let next = await run.next()
  while (next.done !== true) next = await run.next()
  if (validate) assertJson(next.value, `update from "${node.id}"`, node.id)
  return next.value
}

function signalFor(signal: AbortSignal | undefined, timeoutMs: number | undefined): AbortSignal | undefined {
  if (timeoutMs === undefined || timeoutMs <= 0) return signal
  const timeout = AbortSignal.timeout(timeoutMs)
  return signal === undefined ? timeout : AbortSignal.any([signal, timeout])
}

/* ========================================================================== *
 * Layer 2 — the stepwise plan kernel (`KernelPort`)
 * ========================================================================== */

/**
 * `KernelPort` implementation: `compile(plan, state)` returns a run handle whose
 * `next()` executes one plan node. Held by the `graph_run` tool and subagent
 * plan execution; the turn driver keeps its own control-inverted scheduler.
 */
export class MinimalKernel implements KernelPort {
  private readonly deps: ResolvedKernelDeps

  constructor(deps?: KernelDeps) {
    this.deps = resolveKernelDeps(deps)
  }

  get checkpointer(): PlanCheckpointer {
    return this.deps.checkpointer
  }

  compile(plan: TaskPlan, state: GraphState): KernelRunHandle {
    return new MinimalRunHandle(this.deps, plan, state)
  }

  resume(plan: TaskPlan, state: GraphState): KernelRunHandle {
    return new MinimalRunHandle(this.deps, plan, state)
  }
}

export function createMinimalKernel(deps?: KernelDeps): MinimalKernel {
  return new MinimalKernel(deps)
}

class MinimalRunHandle implements KernelRunHandle {
  readonly runId: string
  readonly planId: string
  private readonly deps: ResolvedKernelDeps
  private readonly plan: TaskPlan
  private state: GraphState
  private finished = false
  private finalResult: KernelResult | undefined
  private readonly abort = new AbortController()
  private skipPauseOnce = false

  constructor(deps: ResolvedKernelDeps, plan: TaskPlan, state: GraphState) {
    this.deps = deps
    this.plan = plan
    this.state = state
    this.planId = plan.id
    this.runId = `${plan.id}#${deps.determinism.newId()}`
  }

  private get signal(): AbortSignal {
    return this.deps.signal ?? this.abort.signal
  }

  private settle(result: KernelResult): KernelResult {
    this.finished = true
    this.finalResult = result
    return result
  }

  async next(): Promise<KernelResult> {
    if (this.finished) {
      return this.finalResult ?? { kind: 'done', state: this.state, terminal: this.state.next ?? END }
    }
    const signal = this.signal

    if (signal.aborted) {
      return this.settle(
        this.failed(cancelledFailure(this.state.next ?? '', abortMessage(signal))),
      )
    }

    if (!this.skipPauseOnce) {
      const pause = this.deps.pauseWhen?.(this.state)
      if (pause !== undefined) {
        return { kind: 'paused', reason: pause, state: this.state }
      }
    }
    this.skipPauseOnce = false

    if (this.state.superstep >= this.deps.maxSteps) {
      return this.settle(
        this.failed({
          code: 'budget-exceeded',
          nodeId: this.state.next ?? '',
          message: `step budget exhausted: ${this.state.superstep} of ${this.deps.maxSteps} supersteps used`,
          retryable: false,
        }),
      )
    }

    const nodeId = this.currentNodeId()
    if (nodeId === null) {
      return this.settle({ kind: 'done', state: this.state, terminal: END })
    }

    let executed
    try {
      executed = await executePlanNode({
        deps: this.deps,
        plan: this.plan,
        state: this.state,
        nodeId,
        step: this.state.superstep,
      })
    } catch (error) {
      if (signal.aborted) {
        return this.settle(this.failed(cancelledFailure(nodeId, abortMessage(signal))))
      }
      const failure = failureOf(error, nodeId)
      this.deps.onFailure?.(failure)
      return this.settle(this.failed(failure))
    }

    this.state = executed.after.state
    await persist(this.deps, this.plan, executed.after.atSeq, this.state)

    if (executed.after.failure !== undefined) {
      this.deps.onFailure?.(executed.after.failure)
      return this.settle(this.failed(executed.after.failure))
    }

    return {
      kind: 'boundary',
      nodeId,
      boundary: {
        superstep: this.state.superstep,
        atSeq: executed.after.atSeq,
        closedBy: 'step-end',
      },
      state: this.state,
    }
  }

  private currentNodeId(): NodeId | null {
    const declared = this.state.next
    if (declared !== null && declared !== undefined) return declared
    if (this.state.superstep === 0) return this.plan.entry
    return null
  }

  private failed(failure: NodeFailure): KernelResult {
    return { kind: 'failed', state: this.state, error: failure }
  }

  async updateState(patch: Partial<GraphState>): Promise<void> {
    this.state = mergeState(this.state, patch as JsonUpdate)
    if (this.deps.validateJson) assertJson(this.state, 'state after updateState')
    // A replan re-seeds the run; the next `next()` continues from `state.next`.
    this.finished = false
    this.finalResult = undefined
    this.skipPauseOnce = true
  }

  snapshot(): GraphState {
    return this.state
  }

  async dispose(): Promise<void> {
    this.finished = true
    this.abort.abort()
  }
}

/* ========================================================================== *
 * Small helpers exported for tests
 * ========================================================================== */

export { planInitialState }
export type { PlanNode, PauseReason }
export { START, END, createDeterministicHooks }
