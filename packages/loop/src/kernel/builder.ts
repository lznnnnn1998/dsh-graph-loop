/**
 * builder.ts — the graph *definition* shared by both kernels.
 *
 * `createGraph` / `GraphBuilder` / `CompiledGraph` come from
 * `@dsh/explore-core/kernel`; that file only *declares* `createGraph` and
 * `InTurnCheckpointer`, so this package owns the runtime implementations. The
 * builder below is engine-agnostic: `compile()` delegates to a `GraphCompileFn`
 * which is `compileMinimal` (minimal.ts) or `compileLangGraph`
 * (langgraph.ts). That is what makes "the same builder calls" testable across
 * kernels.
 *
 * Kernel constraints honoured here:
 *  - C1: every state / update / chunk is checked with `assertJsonSafe` before it
 *    can reach a checkpoint (development default; `validateJson: false` opts out).
 *  - Determinism: checkpoint ids and timestamps come from `DeterminismHooks`,
 *    node order is the declaration order, routing is purely a function of state.
 */

import {
  END,
  KernelError,
  START,
  createDeterministicHooks,
} from '@dsh/explore-core/kernel'
import type {
  Checkpoint,
  CheckpointSaver,
  CompileOptions,
  CompiledGraph,
  DeterminismHooks,
  EdgeRouter,
  FanOutRouter,
  GraphBuilder,
  GraphOptions,
  InterruptRecord,
  JsonUpdate,
  NodeFn,
  NodeId,
  NodePolicy,
  StateObject,
} from '@dsh/explore-core/kernel'
import { assertJsonSafe } from '@dsh/explore-core/graph-schema'

/* ========================================================================== *
 * JSON guard (C1)
 * ========================================================================== */

/** Throw `NON_JSON_STATE` when `value` is not JSON. Returns the value for chaining. */
export function assertJson<T>(value: T, what: string, node?: NodeId): T {
  const problem = assertJsonSafe(value)
  if (problem !== null) {
    throw new KernelError(`${what} is not JSON (C1): ${problem}`, 'NON_JSON_STATE', node === undefined ? undefined : { node })
  }
  return value
}

/** True when `value` can be stored in a checkpoint. */
export function isJson(value: unknown): boolean {
  return assertJsonSafe(value) === null
}

/**
 * Shallow JSON merge: `{ ...state, ...update }`.
 *
 * The graph contract keeps reducers out of the builder (LangGraph `StateGraph`
 * reducers are per-channel; the minimal kernel deliberately has none), so a node
 * that owns an array returns the whole array. `applyDelta` in core/kernel.ts
 * does the same.
 */
export function mergeState<S extends StateObject>(state: S, update: JsonUpdate): S {
  return { ...(state as object), ...update } as unknown as S
}

/** Keys that must never reach a checkpoint (measured LangGraph channel leak). */
export const PREGEL_PREFIX = '__pregel'

/** Drop top-level `__pregel_*` channels from a state object (defensive, JSON only). */
export function stripPregelKeys<T extends StateObject>(state: T): T {
  const out: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(state as Record<string, unknown>)) {
    if (key.startsWith(PREGEL_PREFIX)) continue
    out[key] = value
  }
  return out as T
}

/** Convert any thrown value into a `KernelError` without losing the cause. */
export function asKernelError(error: unknown, node?: NodeId): KernelError {
  if (error instanceof KernelError) return error
  const message = error instanceof Error ? error.message : String(error)
  return new KernelError(message, 'NODE_FAILED', {
    ...(node === undefined ? {} : { node }),
    cause: error,
  })
}

/** Snapshot test that defeats control-flow narrowing of a mutable signal. */
export function isAborted(signal: AbortSignal | undefined): boolean {
  return signal !== undefined && signal.aborted
}

/** `AbortSignal` reason normalised to a string. */
export function abortMessage(signal: AbortSignal): string {
  const reason = signal.reason as unknown
  if (reason instanceof Error) return reason.message
  if (typeof reason === 'string' && reason.length > 0) return reason
  return 'run aborted'
}

/* ========================================================================== *
 * Graph definition (engine-agnostic)
 * ========================================================================== */

export interface NodeSpec<S extends StateObject> {
  readonly id: NodeId
  readonly run: NodeFn<S>
  readonly policy?: NodePolicy
}

export interface EdgeSpec {
  readonly from: NodeId | typeof START
  readonly to: NodeId | typeof END
}

export interface ConditionalEdgeSpec<S extends StateObject> {
  readonly from: NodeId
  readonly router: EdgeRouter<S>
  /** Declared destinations; `undefined` means "any declared node or END". */
  readonly ends?: readonly NodeId[]
}

export interface FanOutSpec<S extends StateObject> {
  readonly from: NodeId
  readonly router: FanOutRouter<S>
  readonly target: NodeId
}

/** Immutable-ish description of one graph. Cloned on every `compile()`. */
export interface GraphSpec<S extends StateObject> {
  readonly name: string
  readonly validateJson: boolean
  readonly initialState?: S
  nodes: NodeSpec<S>[]
  edges: EdgeSpec[]
  conditionals: ConditionalEdgeSpec<S>[]
  fanOuts: FanOutSpec<S>[]
}

export type GraphCompileFn<S extends StateObject> = (
  spec: GraphSpec<S>,
  options: CompileOptions<S>,
) => CompiledGraph<S>

export function cloneSpec<S extends StateObject>(spec: GraphSpec<S>): GraphSpec<S> {
  return {
    name: spec.name,
    validateJson: spec.validateJson,
    ...(spec.initialState === undefined ? {} : { initialState: spec.initialState }),
    nodes: [...spec.nodes],
    edges: [...spec.edges],
    conditionals: [...spec.conditionals],
    fanOuts: [...spec.fanOuts],
  }
}

/** The chainable builder handed to graph authors. */
export class GraphBuilderImpl<S extends StateObject> implements GraphBuilder<S> {
  private readonly spec: GraphSpec<S>
  private readonly compileFn: GraphCompileFn<S>

  constructor(options: GraphOptions<S>, compileFn: GraphCompileFn<S>) {
    if (typeof options.name !== 'string' || options.name.length === 0) {
      throw new KernelError('graph name must be a non-empty string', 'INVALID_GRAPH')
    }
    this.spec = {
      name: options.name,
      // C1 is enforced by default; production builds opt out explicitly.
      validateJson: options.validateJson ?? true,
      ...(options.initialState === undefined ? {} : { initialState: options.initialState }),
      nodes: [],
      edges: [],
      conditionals: [],
      fanOuts: [],
    }
    this.compileFn = compileFn
  }

  addNode(id: NodeId, run: NodeFn<S>, policy?: NodePolicy): this {
    if (id === END || id === START) {
      throw new KernelError(`"${id}" is a reserved node id`, 'INVALID_GRAPH')
    }
    if (this.spec.nodes.some((node) => node.id === id)) {
      throw new KernelError(`duplicate node id "${id}"`, 'INVALID_GRAPH', { node: id })
    }
    if (typeof run !== 'function') {
      throw new KernelError(`node "${id}" has no run function`, 'INVALID_GRAPH', { node: id })
    }
    this.spec.nodes.push(policy === undefined ? { id, run } : { id, run, policy })
    return this
  }

  /**
   * Unconditional edge. Replaces any existing unconditional edge out of the
   * same `from` node (a graph has exactly one sequential successor), which is
   * what makes `withTopology()` able to splice a node into an existing edge.
   */
  addEdge(from: NodeId | typeof START, to: NodeId | typeof END): this {
    const existing = this.spec.edges.findIndex((edge) => edge.from === from)
    if (existing >= 0) this.spec.edges.splice(existing, 1)
    this.spec.edges.push({ from, to })
    return this
  }

  addConditionalEdge(from: NodeId, router: EdgeRouter<S>, ends?: readonly NodeId[]): this {
    this.spec.conditionals.push(ends === undefined ? { from, router } : { from, router, ends })
    return this
  }

  addFanOut(from: NodeId, router: FanOutRouter<S>, target: NodeId): this {
    this.spec.fanOuts.push({ from, router, target })
    return this
  }

  compile<C extends CompiledGraph<S>>(options?: CompileOptions<S>): C {
    const compiled = this.compileFn(cloneSpec(this.spec), options ?? {})
    return compiled as C
  }
}

/** Re-create a builder seeded with an existing spec (used by `withTopology`). */
export function rebuildBuilder<S extends StateObject>(
  spec: GraphSpec<S>,
  compileFn: GraphCompileFn<S>,
): GraphBuilder<S> {
  const builder = new GraphBuilderImpl<S>(
    {
      name: spec.name,
      validateJson: spec.validateJson,
      ...(spec.initialState === undefined ? {} : { initialState: spec.initialState }),
    },
    compileFn,
  )
  for (const node of spec.nodes) builder.addNode(node.id, node.run, node.policy)
  for (const edge of spec.edges) builder.addEdge(edge.from, edge.to)
  for (const conditional of spec.conditionals) {
    builder.addConditionalEdge(conditional.from, conditional.router, conditional.ends)
  }
  for (const fanOut of spec.fanOuts) builder.addFanOut(fanOut.from, fanOut.router, fanOut.target)
  return builder
}

/* ========================================================================== *
 * Topology validation + routing (shared by both kernels)
 * ========================================================================== */

export interface GraphTopology<S extends StateObject> {
  readonly spec: GraphSpec<S>
  readonly entry: NodeId
  readonly nodeIds: ReadonlySet<NodeId>
  /** Unconditional successor per node (`END` when the node has none). */
  readonly successor: ReadonlyMap<NodeId, NodeId | typeof END>
}

/** Validate the graph and resolve its entry node. Throws `INVALID_GRAPH`. */
export function resolveTopology<S extends StateObject>(
  spec: GraphSpec<S>,
  options: CompileOptions<S>,
): GraphTopology<S> {
  const nodeIds = new Set(spec.nodes.map((node) => node.id))
  if (nodeIds.size === 0) throw new KernelError(`graph "${spec.name}" has no nodes`, 'INVALID_GRAPH')

  const successor = new Map<NodeId, NodeId | typeof END>()
  const outgoing = new Map<NodeId, number>()

  const bump = (from: NodeId): void => {
    outgoing.set(from, (outgoing.get(from) ?? 0) + 1)
  }

  for (const edge of spec.edges) {
    if (edge.from !== START && !nodeIds.has(edge.from)) {
      throw new KernelError(`edge from unknown node "${edge.from}"`, 'INVALID_GRAPH', { node: edge.from })
    }
    if (edge.to !== END && !nodeIds.has(edge.to)) {
      throw new KernelError(`edge to unknown node "${edge.to}"`, 'INVALID_GRAPH', {
        node: edge.from === START ? edge.to : edge.from,
      })
    }
    if (edge.from === START) continue
    if (successor.has(edge.from) && successor.get(edge.from) !== edge.to) {
      throw new KernelError(
        `node "${edge.from}" has more than one unconditional edge; use addConditionalEdge`,
        'INVALID_GRAPH',
        { node: edge.from },
      )
    }
    successor.set(edge.from, edge.to)
    bump(edge.from)
  }

  for (const conditional of spec.conditionals) {
    if (!nodeIds.has(conditional.from)) {
      throw new KernelError(`conditional edge from unknown node "${conditional.from}"`, 'INVALID_GRAPH', {
        node: conditional.from,
      })
    }
    for (const end of conditional.ends ?? []) {
      if (end !== END && !nodeIds.has(end)) {
        throw new KernelError(`conditional edge names undeclared target "${end}"`, 'UNDECLARED_TARGET', {
          node: conditional.from,
        })
      }
    }
    bump(conditional.from)
  }

  for (const fanOut of spec.fanOuts) {
    if (!nodeIds.has(fanOut.from)) {
      throw new KernelError(`fan-out from unknown node "${fanOut.from}"`, 'INVALID_GRAPH', { node: fanOut.from })
    }
    if (!nodeIds.has(fanOut.target)) {
      throw new KernelError(`fan-out names undeclared target "${fanOut.target}"`, 'UNDECLARED_TARGET', {
        node: fanOut.from,
      })
    }
    bump(fanOut.from)
  }

  for (const [nodeId, count] of outgoing) {
    if (count > 1) {
      throw new KernelError(
        `node "${nodeId}" has ${count} outbound routes; a kernel step must be unambiguous`,
        'INVALID_GRAPH',
        { node: nodeId },
      )
    }
  }

  return { spec, entry: resolveEntry(spec, options, nodeIds), nodeIds, successor }
}

function resolveEntry<S extends StateObject>(
  spec: GraphSpec<S>,
  options: CompileOptions<S>,
  nodeIds: ReadonlySet<NodeId>,
): NodeId {
  if (options.entry !== undefined) {
    if (!nodeIds.has(options.entry)) {
      throw new KernelError(`entry node "${options.entry}" is not declared`, 'INVALID_GRAPH', { node: options.entry })
    }
    return options.entry
  }
  const startEdges = spec.edges.filter((edge) => edge.from === START)
  if (startEdges.length === 1) return startEdges[0]!.to as NodeId
  if (startEdges.length > 1) {
    throw new KernelError('more than one START edge; pass compile({ entry })', 'INVALID_GRAPH')
  }
  const targets = new Set<NodeId>()
  for (const edge of spec.edges) if (edge.from !== START) targets.add(edge.to as NodeId)
  const roots = spec.nodes.filter((node) => !targets.has(node.id)).map((node) => node.id)
  if (roots.length === 1) return roots[0]!
  if (roots.length === 0) {
    throw new KernelError('no entry node: every node has an inbound edge; pass compile({ entry })', 'INVALID_GRAPH')
  }
  throw new KernelError(`ambiguous entry (${roots.join(', ')}); pass compile({ entry })`, 'INVALID_GRAPH')
}

/** Resolve the conditional router of `nodeId`, if any. */
export function conditionalOf<S extends StateObject>(
  spec: GraphSpec<S>,
  nodeId: NodeId,
): ConditionalEdgeSpec<S> | undefined {
  return spec.conditionals.find((conditional) => conditional.from === nodeId)
}

/** Validate a router's answer against the declared target set. */
export function assertDestination<S extends StateObject>(
  topology: GraphTopology<S>,
  from: NodeId,
  destination: NodeId | typeof END,
  ends?: readonly NodeId[],
): void {
  if (destination === END) return
  if (typeof destination !== 'string' || !topology.nodeIds.has(destination)) {
    throw new KernelError(
      `router from "${from}" returned undeclared target "${String(destination)}"`,
      'UNDECLARED_TARGET',
      { node: from },
    )
  }
  if (ends !== undefined && !ends.includes(destination)) {
    throw new KernelError(
      `router from "${from}" returned "${destination}", which is not in its declared ends`,
      'UNDECLARED_TARGET',
      { node: from },
    )
  }
}

/**
 * Nodes about to run after `nodeId`, ignoring fan-out branches (their targets
 * are spawned in the same superstep, not stepped to next).
 */
export function successorTargets<S extends StateObject>(
  topology: GraphTopology<S>,
  nodeId: NodeId,
  state: Readonly<S>,
): readonly NodeId[] {
  const conditional = conditionalOf(topology.spec, nodeId)
  if (conditional !== undefined) {
    const destination = conditional.router(state)
    assertDestination(topology, nodeId, destination, conditional.ends)
    return destination === END ? [] : [destination]
  }
  const next = topology.successor.get(nodeId) ?? END
  return next === END ? [] : [next]
}

/** Branch targets spawned by a fan-out node, in declaration order. */
export function fanOutBranches<S extends StateObject>(
  topology: GraphTopology<S>,
  nodeId: NodeId,
  state: Readonly<S>,
): readonly { readonly node: NodeId; readonly input: JsonUpdate }[] {
  const branches: { node: NodeId; input: JsonUpdate }[] = []
  for (const fanOut of topology.spec.fanOuts.filter((candidate) => candidate.from === nodeId)) {
    for (const target of fanOut.router(state)) {
      if (!topology.nodeIds.has(target.node)) {
        throw new KernelError(
          `fan-out from "${nodeId}" returned undeclared target "${target.node}"`,
          'UNDECLARED_TARGET',
          { node: nodeId },
        )
      }
      branches.push({ node: target.node, input: target.input })
    }
  }
  return branches
}

/* ========================================================================== *
 * In-memory checkpointer (C5: the only saver DSH needs by default)
 * ========================================================================== */

/**
 * Concrete `CheckpointSaver`: process-local, per-thread ring buffer.
 *
 * `@dsh/explore-core/kernel` only *declares* this class (`declare class`), which
 * emits no value, so the runtime implementation lives here. It is deliberately
 * JSON-only: rows are plain objects and callers must have validated already.
 */
export class InTurnCheckpointer<S extends StateObject = StateObject> implements CheckpointSaver<S> {
  private readonly threads = new Map<string, Checkpoint<S>[]>()
  private readonly maxCheckpointsPerThread: number

  constructor(options?: { maxCheckpointsPerThread?: number }) {
    this.maxCheckpointsPerThread = Math.max(1, options?.maxCheckpointsPerThread ?? 64)
  }

  async get(threadId: string, checkpointId?: string): Promise<Checkpoint<S> | undefined> {
    const rows = this.threads.get(threadId)
    if (rows === undefined || rows.length === 0) return undefined
    if (checkpointId !== undefined) return rows.find((row) => row.id === checkpointId)
    return rows[rows.length - 1]
  }

  async put(checkpoint: Checkpoint<S>): Promise<void> {
    assertJson(checkpoint.state, `checkpoint ${checkpoint.id} state`, checkpoint.ranNodes[0])
    const rows = this.threads.get(checkpoint.threadId) ?? []
    rows.push(checkpoint)
    while (rows.length > this.maxCheckpointsPerThread) rows.shift()
    this.threads.set(checkpoint.threadId, rows)
  }

  async *list(threadId: string): AsyncIterable<Checkpoint<S>> {
    const rows = this.threads.get(threadId) ?? []
    for (let index = rows.length - 1; index >= 0; index -= 1) yield rows[index]!
  }

  async deleteThread(threadId: string): Promise<void> {
    this.threads.delete(threadId)
  }
}

/* ========================================================================== *
 * Checkpoint helpers
 * ========================================================================== */

/** Build a `Checkpoint` with deterministic ids/timestamps. */
export function createCheckpoint<S extends StateObject>(input: {
  readonly state: S
  readonly threadId: string
  readonly step: number
  readonly ranNodes: readonly NodeId[]
  readonly parentId?: string
  readonly interrupt?: InterruptRecord
  readonly determinism: DeterminismHooks
}): Checkpoint<S> {
  const checkpoint: Checkpoint<S> = {
    id: input.determinism.newId(),
    threadId: input.threadId,
    step: input.step,
    createdAt: new Date(input.determinism.now()).toISOString(),
    state: input.state,
    ranNodes: input.ranNodes,
    ...(input.parentId === undefined ? {} : { parentId: input.parentId }),
    ...(input.interrupt === undefined ? {} : { interrupt: input.interrupt }),
  }
  return checkpoint
}

/** `next` for a stored checkpoint, recomputed from the graph's routing function. */
export function checkpointNext<S extends StateObject>(
  topology: GraphTopology<S>,
  checkpoint: Checkpoint<S>,
): readonly NodeId[] {
  if (checkpoint.interrupt !== undefined) return [checkpoint.interrupt.node]
  const last = checkpoint.ranNodes[checkpoint.ranNodes.length - 1]
  if (last === undefined) return [topology.entry]
  return successorTargets(topology, last, checkpoint.state)
}

/** The deterministic hooks to use for a run (never `Date.now` by accident). */
export function hooksOf(hooks: DeterminismHooks | undefined): DeterminismHooks {
  return hooks ?? createDeterministicHooks()
}
