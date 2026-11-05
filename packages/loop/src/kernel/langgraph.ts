/**
 * langgraph.ts — `@langchain/langgraph@1.7.0` behind the same two surfaces as
 * the minimal kernel.
 *
 * The dependency is loaded with a **dynamic import** and never re-exported as a
 * type, so this package type-checks and runs when LangGraph is absent:
 * `available()` returns `false` and `createLangGraphKernel()` transparently falls
 * back to the minimal kernel. The bundle is the only place that pays for the
 * third-party module.
 *
 * Layer 1 (`createLangGraphGraph`) compiles the builder calls into a real
 * `StateGraph(Annotation.Root(...))`. The builder's state is arbitrary JSON, so
 * the graph carries a single `state` channel with a replace reducer; every node
 * wrapper returns `{ state: merged }`. Layer 2 (`createLangGraphKernel`) builds
 * one LangGraph node per `PlanNode` and drives the compiled stream one chunk per
 * `next()` call, so a node boundary is observable before the next node runs.
 *
 * Measured LangGraph facts this adapter depends on (spikes/langgraph/output.txt):
 *  - `streamMode: 'updates'` yields one chunk per node: `{ nodeId: update }`;
 *  - `recursionLimit` exhaustion throws `GraphRecursionError`;
 *  - `Command`/`interrupt()` re-execute a node from the top (C4 — not used);
 *  - checkpoint channel values may contain `__pregel_*` channels (stripped here);
 *  - `Send[]` is only valid from a conditional-edge router (fan-out path).
 */

import {
  END,
  KernelError,
  START,
  createDeterministicHooks,
} from 'dsh-graph-loop-core/kernel'
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
  RetryPolicy,
  RunOptions,
  RunResult,
  StateObject,
  SuperstepBoundary,
} from 'dsh-graph-loop-core/kernel'
import { assertLangGraphSurface } from 'dsh-graph-loop-core/kernel'
import type { GraphState, PlanNode, TaskPlan } from 'dsh-graph-loop-core/graph-schema'
import type { KernelPort, KernelResult, KernelRunHandle, NodeFailure, PauseReason } from 'dsh-graph-loop-core/runtime'

import {
  GraphBuilderImpl,
  abortMessage,
  asKernelError,
  assertJson,
  assertDestination,
  checkpointNext,
  cloneSpec,
  createCheckpoint,
  hooksOf,
  isAborted,
  mergeState,
  rebuildBuilder,
  resolveTopology,
  stripPregelKeys,
  successorTargets,
  type GraphCompileFn,
  type GraphSpec,
  type GraphTopology,
  type NodeSpec,
} from './builder.ts'
import {
  cancelledFailure,
  executePlanNode,
  failureOf,
  MemoryCheckpointer,
  persist,
  resolveKernelDeps,
  siblingsOf,
  type ExecutedNode,
  type KernelDeps,
  type PlanCheckpointer,
  type ResolvedKernelDeps,
} from './plan.ts'
import { createMinimalRunHandle } from './minimal.ts'

/* ========================================================================== *
 * Lazy module loading
 * ========================================================================== */

type LangGraphModule = Record<string, any>

let modulePromise: Promise<LangGraphModule | undefined> | undefined

/**
 * Load `@langchain/langgraph` once. Resolves `undefined` when the dependency is
 * not installed, so callers can degrade to the minimal kernel.
 */
export function loadLangGraph(): Promise<LangGraphModule | undefined> {
  modulePromise ??= import('@langchain/langgraph')
    .then((module) => module as unknown as LangGraphModule)
    .catch(() => undefined)
  return modulePromise
}

/** True when the installed LangGraph module satisfies the kernel's surface. */
export async function available(): Promise<boolean> {
  const lg = await loadLangGraph()
  if (lg === undefined) return false
  return surfaceOk(lg)
}

function surfaceOk(lg: LangGraphModule): boolean {
  try {
    assertLangGraphSurface(lg)
    return true
  } catch {
    return false
  }
}

async function requireLangGraph(): Promise<LangGraphModule> {
  const lg = await loadLangGraph()
  if (lg === undefined) {
    throw new KernelError(
      '@langchain/langgraph is not installed; the minimal kernel is the fallback',
      'INVALID_GRAPH',
    )
  }
  if (!surfaceOk(lg)) {
    throw new KernelError(
      '@langchain/langgraph no longer satisfies the kernel surface (see research/03-langgraph.md §9.4)',
      'INVALID_GRAPH',
    )
  }
  return lg
}

/* ========================================================================== *
 * Layer 1 — GraphBuilder over StateGraph
 * ========================================================================== */

/** Build a graph compiled by LangGraph. Async because the import is dynamic. */
export async function createLangGraphGraph<S extends StateObject>(
  options: GraphOptions<S>,
): Promise<GraphBuilder<S>> {
  const lg = await requireLangGraph()
  return new GraphBuilderImpl<S>(options, (spec, compileOptions) =>
    compileLangGraph(lg, spec, compileOptions),
  )
}

const LANGGRAPH_DEFAULT_MAX_STEPS = 64

function compileLangGraph<S extends StateObject>(
  lg: LangGraphModule,
  spec: GraphSpec<S>,
  options: CompileOptions<S>,
): CompiledGraph<S> {
  const topology = resolveTopology(spec, options)
  if ((options.interruptBefore?.length ?? 0) > 0 || (options.interruptAfter?.length ?? 0) > 0) {
    // Honest limitation: pausing in the LangGraph adapter needs a real
    // checkpointer + resume protocol, and C4 forbids interrupts inside a node.
    throw new KernelError(
      'interruptBefore/interruptAfter are not supported by the LangGraph adapter; use the minimal kernel or a human-gate node',
      'INTERRUPT_UNSUPPORTED',
    )
  }
  const validate = spec.validateJson
  const maxSteps = options.maxSteps ?? LANGGRAPH_DEFAULT_MAX_STEPS
  const compileFn: GraphCompileFn<S> = (nextSpec, nextOptions) => compileLangGraph(lg, nextSpec, nextOptions)
  const initialState = (spec.initialState ?? {}) as S

  const root = lg.Annotation.Root({
    // One channel carries the whole JSON state; arbitrary keys stay arbitrary.
    state: lg.Annotation({
      reducer: (_left: S, right: S) => right,
      default: () => initialState,
    }),
  })
  const builder = new lg.StateGraph(root)

  for (const node of spec.nodes) {
    const action = async (incoming: { state: S }, config?: any): Promise<{ state: S }> => {
      const current = (incoming?.state ?? {}) as S
      const configurable = (config?.configurable ?? {}) as Record<string, unknown>
      const stepBox = configurable['dshStep'] as { value: number } | undefined
      const signal = configurable['dshSignal'] as AbortSignal | undefined
      const runDeterminism = (configurable['dshDeterminism'] as DeterminismHooks | undefined) ?? createDeterministicHooks()
      const budget = configurable['dshBudget'] as { used: number; limit: number } | undefined
      if (budget !== undefined && budget.used >= budget.limit) {
        throw new KernelError(
          `step budget exhausted: ${budget.used} of ${budget.limit} supersteps used`,
          'STEP_BUDGET_EXCEEDED',
          { node: node.id },
        )
      }
      const context = langGraphNodeContext(node, current, stepBox?.value ?? 0, signal, runDeterminism, validate)
      const update = await node.run(context)
      if (validate) assertJson(update, `update from "${node.id}"`, node.id)
      const merged = mergeState(current, update)
      if (validate) assertJson(merged, `state after "${node.id}"`, node.id)
      if (budget !== undefined) budget.used += 1
      return { state: merged }
    }
    const nodeOptions = langGraphNodeOptions(node.policy)
    if (nodeOptions === undefined) builder.addNode(node.id, action)
    else builder.addNode(node.id, action, nodeOptions)
  }

  for (const node of spec.nodes) {
    const fanOuts = spec.fanOuts.filter((candidate) => candidate.from === node.id)
    if (fanOuts.length > 0) {
      const targets = [...new Set(fanOuts.map((fanOut) => fanOut.target))]
      builder.addConditionalEdges(
        node.id,
        (incoming: { state: S }) => {
          const state = incoming.state
          const sends: unknown[] = []
          for (const fanOut of fanOuts) {
            for (const target of fanOut.router(state)) {
              if (!topology.nodeIds.has(target.node)) {
                throw new KernelError(
                  `fan-out from "${node.id}" returned undeclared target "${target.node}"`,
                  'UNDECLARED_TARGET',
                  { node: node.id },
                )
              }
              sends.push(new lg.Send(target.node, { state: mergeState(state, target.input) }))
            }
          }
          return sends
        },
        targets,
      )
      continue
    }

    const conditional = spec.conditionals.find((candidate) => candidate.from === node.id)
    if (conditional !== undefined) {
      builder.addConditionalEdges(
        node.id,
        (incoming: { state: S }) => {
          const destination = conditional.router(incoming.state)
          assertDestination(topology, node.id, destination, conditional.ends)
          return destination === END ? lg.END : destination
        },
        conditional.ends === undefined ? undefined : [...conditional.ends],
      )
      continue
    }

    const next = topology.successor.get(node.id) ?? END
    builder.addEdge(node.id, next === END ? lg.END : next)
  }
  builder.addEdge(lg.START, topology.entry)

  // No LangGraph checkpointer: C5 (in-turn memory only) and C4 (no interrupts).
  // Checkpoints are written by this adapter through the injected `CheckpointSaver`.
  const compiled = builder.compile({})

  async function invoke(input: JsonUpdate, runOptions: RunOptions): Promise<RunResult<S>> {
    let result: RunResult<S> | undefined
    for await (const event of stream(input, runOptions)) {
      if (event.type === 'run/end') result = event.result
    }
    if (result === undefined) throw new KernelError('LangGraph run produced no run/end event', 'INVALID_GRAPH')
    return result
  }

  async function* stream(input: JsonUpdate, runOptions: RunOptions): AsyncGenerator<GraphEvent<S>> {
    const runHooks = runOptions.determinism ?? createDeterministicHooks()
    const saver = options.checkpointer
    const threadId = runOptions.threadId
    const signal = runOptions.signal
    const stepBox = { value: 0 }
    const budget = { used: 0, limit: maxSteps }
    let state = mergeState(initialState, input)
    if (validate) assertJson(state, 'initial state')
    let status: RunResult<S>['status'] = 'completed'
    let steps = 0
    let pendingInterrupt: InterruptRecord | undefined
    let parentId: NodeId | undefined
    let checkpointId: string | undefined
    let lastNode: NodeId | undefined

    yield { type: 'run/start', threadId }

    const save = async (ranNodes: readonly NodeId[], interrupt?: InterruptRecord): Promise<void> => {
      if (saver === undefined) return
      const checkpoint = createCheckpoint<S>({
        state,
        threadId,
        step: steps,
        ranNodes,
        determinism: runHooks,
        ...(parentId === undefined ? {} : { parentId }),
        ...(interrupt === undefined ? {} : { interrupt }),
      })
      if (validate) assertJson(checkpoint.state, `checkpoint ${checkpoint.id} state`)
      await saver.put(checkpoint)
      parentId = checkpoint.id
      checkpointId = checkpoint.id
    }

    let iterable: AsyncIterable<any>
    try {
      iterable = await compiled.stream(state, {
        streamMode: 'updates',
        recursionLimit: Math.max(2, maxSteps + 2),
        configurable: {
          thread_id: threadId,
          dshStep: stepBox,
          ...(signal === undefined ? {} : { dshSignal: signal }),
          dshDeterminism: runHooks,
          dshBudget: budget,
        },
        ...(signal === undefined ? {} : { signal }),
      })
    } catch (error) {
      throw mapStreamError(error, layerOneNext(state) ?? '')
    }

    try {
      for await (const chunk of iterable) {
        if (isAborted(signal)) {
          status = 'aborted'
          break
        }
        if (isInterruptChunk(chunk)) {
          const interrupt = interruptOf(chunk, lastNode ?? topology.entry, steps, runHooks)
          pendingInterrupt = interrupt
          await save([], interrupt)
          yield { type: 'interrupt', interrupt }
          status = 'interrupted'
          break
        }
        const [nodeId, payload] = pickNodeChunk(chunk)
        if (nodeId === '') continue
        if (!topology.nodeIds.has(nodeId)) {
          throw new KernelError(`LangGraph ran undeclared node "${nodeId}"`, 'UNDECLARED_TARGET', { node: nodeId })
        }
        const nextStateValue = (payload as { state?: S } | undefined)?.state
        if (nextStateValue === undefined) continue
        const cleaned = stripPregelKeys(nextStateValue)
        if (validate) assertJson(cleaned, `state after "${nodeId}"`, nodeId)
        const update = shallowDelta(state, cleaned)
        state = cleaned
        lastNode = nodeId
        steps += 1
        yield { type: 'superstep/start', step: stepBox.value, nodes: [nodeId] }
        yield { type: 'node/start', step: stepBox.value, node: nodeId }
        yield { type: 'node/end', step: stepBox.value, node: nodeId, update }
        const next = successorTargets(topology, nodeId, state)
        const boundary: SuperstepBoundary = {
          step: stepBox.value + 1,
          completedNodes: [nodeId],
          next,
        }
        await runOptions.onBoundary?.(boundary)
        stepBox.value += 1
        await save([nodeId])
      }
    } catch (error) {
      if (isAborted(signal)) {
        status = 'aborted'
      } else {
        throw mapStreamError(error, lastNode ?? layerOneNext(state) ?? '')
      }
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

  async function getState(threadId: string): Promise<CheckpointSnapshot<S> | undefined> {
    const checkpoint = await options.checkpointer?.get(threadId)
    if (checkpoint === undefined) return undefined
    return { checkpoint, next: checkpointNext(topology, checkpoint) }
  }

  async function* getStateHistory(threadId: string): AsyncIterable<CheckpointSnapshot<S>> {
    if (options.checkpointer === undefined) return
    for await (const checkpoint of options.checkpointer.list(threadId)) {
      yield { checkpoint, next: checkpointNext(topology, checkpoint) }
    }
  }

  function withTopology(edit: (next: GraphBuilder<S>) => void): CompiledGraph<S> {
    const nextBuilder = rebuildBuilder(cloneSpec(spec), compileFn)
    edit(nextBuilder)
    return nextBuilder.compile<CompiledGraph<S>>(options)
  }

  return {
    name: spec.name,
    invoke,
    stream,
    getState,
    getStateHistory,
    withTopology,
    introspect: () => ({
      engine: 'langgraph',
      name: spec.name,
      entry: topology.entry,
      nodes: spec.nodes.map((node) => node.id),
      edges: spec.edges.map((edge) => ({ from: edge.from, to: edge.to })),
    }),
  }
}

/* ========================================================================== *
 * Layer 1 helpers
 * ========================================================================== */

function langGraphNodeOptions(policy: NodePolicy | undefined): Record<string, unknown> | undefined {
  if (policy === undefined) return undefined
  const options: Record<string, unknown> = {}
  if (policy.retry !== undefined) options['retryPolicy'] = toLangGraphRetry(policy.retry)
  if (policy.timeoutMs !== undefined) options['timeout'] = policy.timeoutMs
  return Object.keys(options).length === 0 ? undefined : options
}

function toLangGraphRetry(retry: RetryPolicy): Record<string, unknown> {
  // LangGraph 1.7.0 RetryPolicy: { initialInterval?, backoffFactor?, maxInterval?, maxAttempts? }
  return {
    ...(retry.maxAttempts === undefined ? {} : { maxAttempts: retry.maxAttempts }),
    ...(retry.initialDelayMs === undefined ? {} : { initialInterval: retry.initialDelayMs }),
    ...(retry.backoffFactor === undefined ? {} : { backoffFactor: retry.backoffFactor }),
    ...(retry.maxDelayMs === undefined ? {} : { maxInterval: retry.maxDelayMs }),
  }
}

function langGraphNodeContext<S extends StateObject>(
  node: NodeSpec<S>,
  state: S,
  step: number,
  signal: AbortSignal | undefined,
  determinism: DeterminismHooks,
  validate: boolean,
): NodeContext<S> {
  return {
    state: Object.freeze({ ...(state as object) }) as Readonly<S>,
    threadId: node.id,
    step,
    signal: signal ?? new AbortController().signal,
    determinism,
    emit: (chunk) => {
      // Custom chunks are not forwarded through the LangGraph Layer-1 adapter
      // (no stable writer surface in 1.7.0 without a chat model run). The
      // chunk is still validated so a non-JSON emit fails loudly.
      if (validate) assertJson(chunk, 'emit chunk', node.id)
    },
    interrupt: async () => {
      throw new KernelError(
        `node "${node.id}" called ctx.interrupt(); use the ask_user_question tool instead (C4)`,
        'INTERRUPT_UNSUPPORTED',
        { node: node.id },
      )
    },
  }
}

function pickNodeChunk(chunk: unknown): [NodeId, Record<string, unknown> | undefined] {
  if (typeof chunk !== 'object' || chunk === null) return ['', undefined]
  const keys = Object.keys(chunk as Record<string, unknown>)
  if (keys.length === 0) return ['', undefined]
  const nodeId = keys[0]!
  const payload = (chunk as Record<string, unknown>)[nodeId]
  if (typeof payload !== 'object' || payload === null) return [nodeId, undefined]
  return [nodeId, payload as Record<string, unknown>]
}

function isInterruptChunk(chunk: unknown): boolean {
  return typeof chunk === 'object' && chunk !== null && '__interrupt__' in (chunk as Record<string, unknown>)
}

function interruptOf(
  chunk: unknown,
  nodeId: NodeId,
  step: number,
  determinism: DeterminismHooks,
): InterruptRecord {
  const raw = (chunk as { __interrupt__?: unknown }).__interrupt__
  const first = Array.isArray(raw) ? (raw[0] as { id?: unknown; value?: unknown } | undefined) : undefined
  const id = typeof first?.id === 'string' ? first.id : determinism.newId()
  const payload = first?.value === undefined ? null : (first.value as JsonValue)
  return { id, node: nodeId, step, payload }
}

/** Layer-1 states are arbitrary JSON; only plan-shaped states carry `next`. */
function layerOneNext<S extends StateObject>(state: S): string | null | undefined {
  const next = (state as { next?: unknown }).next
  return typeof next === 'string' || next === null ? next : undefined
}

function shallowDelta<S extends StateObject>(previous: S, next: S): JsonUpdate {
  const delta: Record<string, JsonValue> = {}
  const previousRecord = previous as Record<string, unknown>
  const nextRecord = next as Record<string, unknown>
  for (const [key, value] of Object.entries(nextRecord)) {
    if (previousRecord[key] !== value) delta[key] = value as JsonValue
  }
  for (const key of Object.keys(previousRecord)) {
    if (!(key in nextRecord)) delta[key] = null
  }
  return delta
}

function mapStreamError(error: unknown, nodeId: NodeId): KernelError {
  const name = (error as { name?: unknown } | undefined)?.name
  if (name === 'GraphRecursionError') {
    return new KernelError(
      'LangGraph recursion limit reached (step budget exhausted)',
      'STEP_BUDGET_EXCEEDED',
      { node: nodeId },
    )
  }
  if (name === 'AbortError' || name === 'TimeoutError') {
    return new KernelError(
      error instanceof Error ? error.message : 'run aborted',
      'ABORTED',
      { node: nodeId, cause: error },
    )
  }
  return asKernelError(error, nodeId)
}

/* ========================================================================== *
 * Layer 2 — stepwise plan kernel over a LangGraph StateGraph
 * ========================================================================== */

/**
 * `KernelPort` backed by LangGraph. Construction stays synchronous; the module
 * is loaded (and the surface verified) on the first `next()`. When LangGraph is
 * absent the run degrades to the minimal kernel instead of failing.
 */
export function createLangGraphKernel(deps?: KernelDeps): KernelPort {
  const resolved = resolveKernelDeps(deps)
  return {
    checkpointer: resolved.checkpointer,
    compile: (plan, state) => new LazyLangGraphRun(resolved, plan, state, false),
    resume: (plan, state) => new LazyLangGraphRun(resolved, plan, state, true),
  }
}

class LazyLangGraphRun implements KernelRunHandle {
  readonly runId: string
  readonly planId: string
  private readonly deps: ResolvedKernelDeps
  private readonly plan: TaskPlan
  private state: GraphState
  private inner: KernelRunHandle | undefined
  private finished = false
  private skipPauseOnce: boolean

  constructor(deps: ResolvedKernelDeps, plan: TaskPlan, state: GraphState, resumed: boolean) {
    this.deps = deps
    this.plan = plan
    this.state = state
    this.planId = plan.id
    this.skipPauseOnce = resumed
    this.runId = `${plan.id}#${deps.determinism.newId()}`
  }

  private async ensure(): Promise<KernelRunHandle> {
    if (this.inner !== undefined) return this.inner
    const lg = await loadLangGraph()
    this.inner = lg !== undefined && surfaceOk(lg)
      ? new LangGraphPlanRun(lg, this.deps, this.plan, this.state, this.skipPauseOnce)
      : createMinimalRunHandle(this.deps, this.plan, this.state, this.skipPauseOnce)
    return this.inner
  }

  async next(): Promise<KernelResult> {
    const inner = await this.ensure()
    return inner.next()
  }

  async updateState(patch: Partial<GraphState>): Promise<void> {
    if (this.inner !== undefined) {
      await this.inner.updateState(patch)
      return
    }
    this.state = mergeState(this.state, patch as JsonUpdate)
    if (this.deps.validateJson) assertJson(this.state, 'state after updateState')
    this.finished = false
    this.skipPauseOnce = true
  }

  snapshot(): GraphState {
    return this.inner?.snapshot() ?? this.state
  }

  async dispose(): Promise<void> {
    this.finished = true
    await this.inner?.dispose()
  }
}

interface QueuedBoundary {
  readonly nodeId: NodeId
  readonly after: {
    readonly atSeq: number
    readonly state: GraphState
    readonly failure?: NodeFailure
  }
}

class LangGraphPlanRun implements KernelRunHandle {
  readonly runId: string
  readonly planId: string
  private readonly lg: LangGraphModule
  private readonly deps: ResolvedKernelDeps
  private readonly plan: TaskPlan
  private state: GraphState
  private compiled: any
  private iterator: AsyncIterator<any> | undefined
  private queue: QueuedBoundary[] = []
  private streamDone = false
  private finished = false
  private finalResult: KernelResult | undefined
  private readonly abort = new AbortController()
  private skipPauseOnce = false
  /**
   * Measured LangGraph 1.7.0 behaviour: the runner starts superstep N+1 while
   * the consumer is still receiving the chunk for superstep N (one-node
   * lookahead). `next()` must not let that happen, so every node body first
   * awaits a gate that is released by the *following* `next()` call. The chunk
   * for the finished node is already queued by then, so there is no deadlock.
   */
  private gate: ((allow: boolean) => void) | undefined
  private gatePromise: Promise<boolean> | undefined

  constructor(
    lg: LangGraphModule,
    deps: ResolvedKernelDeps,
    plan: TaskPlan,
    state: GraphState,
    resumed: boolean,
  ) {
    this.lg = lg
    this.deps = deps
    this.plan = plan
    this.state = state
    this.planId = plan.id
    this.skipPauseOnce = resumed
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

  private doneResult(): KernelResult {
    return { kind: 'done', state: this.state, terminal: this.state.next ?? END }
  }

  private async ensureStream(): Promise<void> {
    if (this.iterator !== undefined) return
    const lg = this.lg
    const plan = this.plan
    const ids = plan.nodes.map((node) => node.id)
    const initial = this.state
    const replace = <T>(value: T) => ({ reducer: (_left: T, right: T) => right, default: () => value })
    const root = lg.Annotation.Root({
      taskHash: lg.Annotation(replace(initial.taskHash)),
      planId: lg.Annotation(replace(initial.planId)),
      planVersion: lg.Annotation(replace(initial.planVersion)),
      superstep: lg.Annotation(replace(initial.superstep)),
      next: lg.Annotation(replace(initial.next)),
      status: lg.Annotation(replace(initial.status)),
      facts: lg.Annotation(replace(initial.facts)),
      artifacts: lg.Annotation(replace(initial.artifacts)),
      children: lg.Annotation(replace(initial.children)),
      journal: lg.Annotation(replace(initial.journal)),
      budget: lg.Annotation(replace(initial.budget)),
      replans: lg.Annotation(replace(initial.replans)),
    })
    const builder = new lg.StateGraph(root)
    for (const node of plan.nodes) {
      builder.addNode(node.id, async (incoming: GraphState) => this.runPlanNode(node.id, incoming))
    }
    for (const node of plan.nodes) {
      if (plan.terminals.includes(node.id)) {
        builder.addEdge(node.id, lg.END)
        continue
      }
      builder.addConditionalEdges(
        node.id,
        (incoming: GraphState) => incoming.next ?? lg.END,
        [...ids, lg.END],
      )
    }
    // A resumed/recompiled run enters at `state.next` when the checkpoint
    // already consumed earlier nodes; a fresh run enters at `plan.entry`.
    const startNode = initial.next !== null && ids.includes(initial.next) ? initial.next : plan.entry
    builder.addEdge(lg.START, startNode)
    this.compiled = builder.compile({})
    const iterable = await this.compiled.stream(this.state, {
      streamMode: 'updates',
      recursionLimit: Math.max(2, this.deps.maxSteps + 2),
      configurable: { thread_id: plan.id },
      ...(this.deps.signal === undefined ? {} : { signal: this.deps.signal }),
    })
    this.iterator = iterable[Symbol.asyncIterator]()
  }

  /** Block until the consumer asks for the next boundary (strict stepping). */
  private async passGate(): Promise<void> {
    if (this.gatePromise === undefined) return
    const allowed = await this.gatePromise
    if (!allowed) throw new KernelError('graph run disposed or recompiled', 'ABORTED')
  }

  private blockNextNode(): void {
    this.gatePromise = new Promise<boolean>((resolve) => {
      this.gate = resolve
    })
  }

  /**
   * Release the gated node. `allow: false` makes it abort without side effects
   * (pause/dispose/replan) instead of running a stale successor.
   */
  private releaseGate(allow = true): void {
    const resolve = this.gate
    this.gate = undefined
    this.gatePromise = undefined
    resolve?.(allow)
  }

  /** One LangGraph node = one plan node; the durable boundary is appended here. */
  private async runPlanNode(nodeId: NodeId, incoming: GraphState): Promise<GraphState> {
    await this.passGate()
    const executed: ExecutedNode = await executePlanNode({
      deps: this.deps,
      plan: this.plan,
      state: incoming,
      nodeId,
      step: incoming.superstep,
    })
    const cleaned = stripPregelKeys(executed.after.state)
    await persist(this.deps, this.plan, executed.after.atSeq, cleaned)
    this.state = cleaned
    this.queue.push({
      nodeId,
      after: {
        atSeq: executed.after.atSeq,
        state: cleaned,
        ...(executed.after.failure === undefined ? {} : { failure: executed.after.failure }),
      },
    })
    // Do not let LangGraph start the following node until the next `next()`.
    if (!this.streamDone) this.blockNextNode()
    return cleaned as unknown as GraphState
  }

  /** Return one already-executed boundary (kept in superstep order). */
  private popQueued(): KernelResult {
    const entry = this.queue.shift()!
    if (entry.after.failure !== undefined) {
      this.deps.onFailure?.(entry.after.failure)
      return this.settle({ kind: 'failed', state: entry.after.state, error: entry.after.failure })
    }
    return {
      kind: 'boundary',
      nodeId: entry.nodeId,
      boundary: {
        superstep: entry.after.state.superstep,
        atSeq: entry.after.atSeq,
        closedBy: 'step-end',
      },
      state: entry.after.state,
    }
  }

  async next(): Promise<KernelResult> {
    if (this.finished) return this.finalResult ?? this.doneResult()
    // A parallel superstep can queue more than one boundary; never lose one to
    // a pause/budget decision taken at the same boundary.
    if (this.queue.length > 0) return this.popQueued()
    const signal = this.signal

    if (signal.aborted) {
      return this.settle({ kind: 'failed', state: this.state, error: cancelledFailure(this.state.next ?? '', abortMessage(signal)) })
    }

    // A plan state with `next: null` after at least one node has finished has
    // no node left to run; pauseWhen is only consulted before a real node.
    if (this.queue.length === 0 && this.state.next === null && this.state.superstep > 0) {
      // The last node already produced its boundary; nothing left to run.
      return this.settle(this.doneResult())
    }

    if (!this.skipPauseOnce) {
      const pause = this.deps.pauseWhen?.(this.state)
      if (pause !== undefined) return { kind: 'paused', reason: pause, state: this.state }
    }
    this.skipPauseOnce = false

    if (this.state.superstep >= this.deps.maxSteps) {
      return this.settle({
        kind: 'failed',
        state: this.state,
        error: {
          code: 'budget-exceeded',
          nodeId: this.state.next ?? '',
          message: `step budget exhausted: ${this.state.superstep} of ${this.deps.maxSteps} supersteps used`,
          retryable: false,
        },
      })
    }

    while (this.queue.length === 0) {
      if (this.streamDone) return this.settle(this.doneResult())
      // Let the gated next node start only now that the caller asked again.
      this.releaseGate(true)
      await this.ensureStream()
      let step: IteratorResult<any>
      try {
        step = await this.iterator!.next()
      } catch (error) {
        if (signal.aborted) {
          return this.settle({
            kind: 'failed',
            state: this.state,
            error: cancelledFailure(this.state.next ?? '', abortMessage(signal)),
          })
        }
        const kernelError = mapStreamError(error, this.state.next ?? '')
        const failure = failureOf(kernelError, this.state.next ?? '')
        this.deps.onFailure?.(failure)
        return this.settle({ kind: 'failed', state: this.state, error: failure })
      }
      if (step.done === true) {
        this.streamDone = true
        return this.settle(this.doneResult())
      }
      if (isInterruptChunk(step.value)) {
        // C4: plan node bodies must not call interrupt(); reaching this branch
        // means the executor (not the kernel) paused.
        return this.settle({ kind: 'paused', reason: 'human-gate', state: this.state })
      }
      // The node wrapper already appended its boundary to `queue`; loop only if
      // LangGraph produced a chunk that did not correspond to a plan node.
    }

    return this.popQueued()
  }

  async updateState(patch: Partial<GraphState>): Promise<void> {
    this.state = mergeState(this.state, patch as JsonUpdate)
    if (this.deps.validateJson) assertJson(this.state, 'state after updateState')
    this.releaseGate(false)
    await this.iterator?.return?.().catch?.(() => {})
    this.iterator = undefined
    this.compiled = undefined
    this.queue = []
    this.streamDone = false
    this.finished = false
    this.finalResult = undefined
    this.skipPauseOnce = true
  }

  snapshot(): GraphState {
    return this.state
  }

  async dispose(): Promise<void> {
    this.finished = true
    this.releaseGate(false)
    this.abort.abort()
    try {
      await this.iterator?.return?.()
    } catch {
      // A gated successor may reject with ABORTED while unwinding; disposal is
      // best-effort and must not throw across the loop (A7).
    }
    this.iterator = undefined
    this.compiled = undefined
  }
}

/* Re-exports kept for symmetry with the minimal module. */
export { END, START, MemoryCheckpointer, resolveKernelDeps, siblingsOf }
export type { PlanNode, PauseReason, PlanCheckpointer, TaskPlan }
