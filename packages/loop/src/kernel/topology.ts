/**
 * kernel-topology.ts — drive a plan through a `KernelPort` while the DSH agent
 * loop owns each step.
 *
 * The kernel normally executes a node body and then returns a boundary. In the
 * live loop the node body is a DSH step, so control is inverted: the kernel is
 * compiled with a `pauseWhen` that stops **before** every node, the agent runs
 * the step, and `advance()` resumes the kernel with the step's outcome. The
 * kernel's node executor is a bridge that consumes that pending outcome, so the
 * kernel still owns routing, state folding and checkpoints.
 *
 * This adapter handles plans the kernel can route on one cursor: no subagent
 * nodes, and any fan-out/join is the widened class below. Every control-edge
 * condition (`artifact`, `noArtifact`, `fact`, `callFailed`, `budget` on the
 * step axis) is evaluated by the shared `evaluateCondition`, so a guarded route
 * is a real conditional edge, not a second code path outside the kernel.
 * Composed plans are kernel-driven.
 *
 * A step-executor fan-out/join is kernel-driven when it is acyclic, every
 * control edge is unconditional, the plan declares one terminal, and it fits
 * the journal (`readySetRoutable`). The runtime entered set the frontier keeps
 * is derived from `state.journal` on every route decision, so a split runs one
 * branch per step and the join waits until every entered predecessor completed.
 * A guarded or cyclic fan-out, subagent batches, a condition on a data edge and
 * engine-reserved node ids still use `FrontierTopology`.
 */

import { END, KernelError } from 'dsh-graph-loop-core/kernel'
import { GRAPH_STATE_LIMITS } from 'dsh-graph-loop-core/graph-schema'
import type { GraphState, Json, PlanEdge, PlanNode, TaskPlan } from 'dsh-graph-loop-core/graph-schema'
import type { RoutingArtifact } from 'dsh-graph-loop-core/condition'
import { evaluateCondition, routeOrder, type RoutingState } from 'dsh-graph-loop-core/condition'
import type { KernelResult, KernelRunHandle } from 'dsh-graph-loop-core/runtime'

import { createLangGraphKernel, isReservedPlanNodeId } from './langgraph.ts'
import { createMinimalKernel } from './minimal.ts'
import {
  MemoryCheckpointer,
  planInitialState,
  type KernelDeps,
  type PlanCheckpointer,
  type PlanExecutorPort,
  type PlanNodeOutcome,
} from './plan.ts'

/** What the DSH step reports back to the graph. */
export interface KernelAdvanceOutcome {
  readonly ok: boolean
  readonly failedTool?: string
  /** Facts folded from this step's tool results; the route hook reads them. */
  readonly facts?: Readonly<Record<string, Json>>
  /** Artifact refs produced by this step; the route hook reads them. */
  readonly artifacts?: readonly RoutingArtifact[]
  /** Session seq of the `step/end` that closed this node's boundary. */
  readonly atSeq?: number
}

export type KernelEngine = 'minimal' | 'langgraph'

export interface KernelTopologyOptions {
  readonly kind?: KernelEngine
  readonly taskHash?: string
  readonly maxSteps?: number
  /**
   * Folded state from the session log prefix. A resumed run enters at
   * `state.next` instead of the plan entry; a state that is not `running` (or
   * names no declared node) is ignored and the run starts fresh.
   */
  readonly state?: GraphState
  /**
   * Runtime checkpoint cache. The kernel persists one row per node boundary;
   * the adapter reads it back at the boundary. It is never the resume vehicle:
   * the session log fold owns that (C3/C5).
   */
  readonly checkpointer?: PlanCheckpointer
}

export class KernelTopology {
  private readonly plan: TaskPlan
  private readonly engine: KernelEngine
  private readonly handle: KernelRunHandle
  private readonly nodeById: Map<string, PlanNode>
  private readonly checkpointer: PlanCheckpointer
  private state: GraphState
  private currentId: string | undefined
  private stateStatus: 'running' | 'done' | 'failed' = 'running'
  private pending: PlanNodeOutcome | undefined
  private lastResult: KernelResult | undefined

  constructor(plan: TaskPlan, options: KernelTopologyOptions = {}) {
    this.plan = plan
    this.engine = options.kind ?? 'langgraph'
    this.nodeById = new Map(plan.nodes.map(node => [node.id, node]))
    this.checkpointer = options.checkpointer ?? new MemoryCheckpointer()
    // A folded state resumes at the node it names; only a running state that
    // points at a declared node continues a run. Anything else — a completed
    // run, a state from another plan — starts at the entry, not by replaying.
    const seed = resumableSeed(plan, this.nodeById, options.state)
    this.state = seed ?? planInitialState(plan, options.taskHash ?? plan.id)
    this.currentId = seed !== undefined && seed.next !== null
      ? seed.next
      : this.nodeById.get(plan.entry)?.id ?? plan.entry

    const executor = (kind: 'step' | 'subagent'): PlanExecutorPort => ({
      kind,
      execute: () => {
        const outcome = this.pending
        if (outcome === undefined) throw new Error(`kernel topology: no pending outcome for ${kind} node`)
        this.pending = undefined
        return outcome
      },
    })

    const deps: KernelDeps = {
      executors: [executor('step'), executor('subagent')],
      // The runtime checkpoint cache the engines persist each boundary into;
      // `advance()` reads the boundary row back below.
      checkpointer: this.checkpointer,
      // The only condition this adapter accepts; the route is a real branch
      // (success edge vs `callFailed` recovery edge) that the compiled graph
      // takes as a conditional edge.
      route: routeKernelPlan,
      // Stop before every node: the host has not run this step yet. Once an
      // outcome is pending, let the kernel execute the node's bridge executor.
      pauseWhen: () => (this.pending === undefined ? 'replan' : undefined),
      // A budget-guarded exit may route to a wrap-up node on the last planned
      // step. Both kernels check that cap before the pause hook, so the host
      // cannot slip an extra step in after the plan's budget has run out; the
      // reserve is the one step that still lets a budget-routed answer node run
      // and be folded. The plan budget decides routing; the reserve only keeps
      // that routed node affordable. Owning this here (not in the scheduler)
      // keeps direct adapter use and the live path on one rule.
      maxSteps: (options.maxSteps ?? plan.budget.maxSteps) + budgetReserveSteps(plan),
    }
    const kernel = (options.kind ?? 'langgraph') === 'minimal'
      ? createMinimalKernel(deps)
      : createLangGraphKernel(deps)
    this.handle = kernel.compile(plan, this.state)
  }

  /** Node the next DSH step must run. */
  current(): PlanNode | undefined {
    if (this.currentId === undefined) return undefined
    return this.nodeById.get(this.currentId)
  }

  /** Kernel mode does not expose parallel batches; plans with subagents use the frontier. */
  pendingNodes(): readonly PlanNode[] {
    return []
  }

  detach(): PlanNode | undefined {
    return undefined
  }

  select(id: string): PlanNode | undefined {
    const node = this.nodeById.get(id)
    if (node === undefined) return undefined
    this.currentId = id
    return node
  }

  /**
   * Resume the kernel with the DSH step outcome. Executes the node's bridge
   * executor, checkpoints, routes, and pauses before the next node.
   *
   * A failed step may still own a `callFailed` recovery edge. In that case the
   * kernel takes the recovery branch and the run continues; without a matching
   * edge the failed node closes the run as failed.
   *
   * The kernel compiles lazily, so a malformed plan (e.g. a node id colliding
   * with a LangGraph channel) first throws here rather than at construction.
   * That failure is recorded as `failed` and rethrown as a typed `KernelError`
   * so the scheduler can fall back to `FrontierTopology` instead of surfacing a
   * bare LangGraph error.
   */
  async advance(outcome: KernelAdvanceOutcome): Promise<PlanNode | undefined> {
    if (this.stateStatus !== 'running' || this.currentId === undefined) return undefined
    const nodeId = this.currentId
    this.pending = {
      nodeId,
      ok: outcome.ok,
      facts: {
        lastNode: nodeId,
        lastOk: outcome.ok,
        ...(outcome.failedTool === undefined ? {} : { failedTool: outcome.failedTool }),
        ...(outcome.facts ?? {}),
      },
      ...(outcome.artifacts === undefined ? {} : { artifacts: outcome.artifacts }),
      ...(outcome.atSeq === undefined ? {} : { atSeq: outcome.atSeq }),
      ...(outcome.ok
        ? {}
        : {
            failure: {
              code: 'tool-failed' as const,
              nodeId,
              message: `node ${nodeId} failed${outcome.failedTool === undefined ? '' : ` via ${outcome.failedTool}`}`,
              retryable: true,
            },
          }),
    }

    try {
      // LangGraph compiles lazily, so this is the first point where a reserved
      // node id is detectable. Refuse it with the exact code instead of letting
      // the engine throw its unstructured compile error.
      if (this.engine === 'langgraph') {
        const reserved = this.plan.nodes.find(node => isReservedPlanNodeId(node.id))?.id
        if (reserved !== undefined) {
          throw new KernelError(
            `plan node id "${reserved}" collides with a kernel channel or reserved id`,
            'BAD_NODE_ID',
            { node: reserved },
          )
        }
      }
      let result = await this.handle.next()

      // A failed node ends the run unless the plan routes it to a recovery node.
      // The route hook has already selected that branch, so a running boundary
      // with a successor is the `callFailed` edge being taken.
      if (!outcome.ok
        && (result.kind !== 'boundary'
          || result.state.status !== 'running'
          || result.state.next === null)) {
        this.lastResult = result
        this.state = result.state
        this.stateStatus = 'failed'
        this.currentId = undefined
        return undefined
      }

      // The kernel returns a boundary after executing the bridge node. Pause it
      // once more so `current()` points at the node the next DSH step must run.
      //
      // The engine persisted this boundary's checkpoint row before returning
      // the boundary (A1/A5). Read it back: the runtime saver is the authority
      // for the boundary state the adapter reports to the driver, so a host
      // that supplies its own cache sees exactly the row it will checkpoint.
      // The saver stays a runtime facility (C5); resuming a later turn folds
      // the session log, never this row (C3).
      let boundaryState: GraphState | undefined
      if (result.kind === 'boundary') {
        boundaryState = await this.checkpointer.load(this.plan.id, result.boundary.atSeq)
        if (result.state.next === null || result.state.status !== 'running') {
          this.lastResult = result
          this.state = boundaryState ?? result.state
          this.stateStatus = result.state.status === 'failed' ? 'failed' : 'done'
          this.currentId = undefined
          return undefined
        }
        result = await this.handle.next()
      }

      this.lastResult = result
      this.state = boundaryState ?? result.state
      if (result.kind === 'paused') {
        this.currentId = result.state.next ?? undefined
        if (this.currentId === undefined) this.stateStatus = 'done'
        return this.current()
      }
      if (result.kind === 'done') {
        this.stateStatus = 'done'
        this.currentId = undefined
        return undefined
      }
      if (result.kind === 'failed') {
        this.stateStatus = 'failed'
        this.currentId = undefined
        return undefined
      }
      this.currentId = result.state.next ?? undefined
      return this.current()
    } catch (error) {
      this.stateStatus = 'failed'
      this.currentId = undefined
      throw kernelTopologyError(error, nodeId, this.plan)
    }
  }

  done(): boolean {
    return this.stateStatus !== 'running'
  }

  status(): 'running' | 'done' | 'failed' {
    return this.stateStatus
  }

  steps(): number {
    return this.state.superstep
  }

  snapshot(): TaskPlan {
    return this.plan
  }

  /** Kernel state, for tests and the trace/projection. */
  stateSnapshot(): GraphState {
    return this.state
  }

  /** Last raw kernel result, for diagnostics. */
  result(): KernelResult | undefined {
    return this.lastResult
  }

  dispose(): Promise<void> {
    return this.handle.dispose()
  }
}

/**
 * The folded state a resumed run may enter from, or undefined to start fresh.
 *
 * Only a `running` state of the same plan version that names a declared node is
 * a continuation. A completed or failed state describes the previous turn's
 * result; entering from its `next` would replay work nobody asked for.
 */
function resumableSeed(
  plan: TaskPlan,
  nodeById: ReadonlyMap<string, PlanNode>,
  seed: GraphState | undefined,
): GraphState | undefined {
  if (seed === undefined) return undefined
  if (seed.planId !== plan.id || seed.planVersion !== plan.version) return undefined
  if (seed.status !== 'running' || seed.next === null) return undefined
  return nodeById.has(seed.next) ? seed : undefined
}

/**
 * Route policy for kernel-drivable plans. Every control edge is evaluated with
 * the same `evaluateCondition` the frontier uses, so artifact/fact/budget
 * guards are not silently dropped by the kernel. A failed step only takes a
 * guarded recovery edge; `END` means no edge matched.
 *
 * The returned successor becomes `state.next`; the compiled graph then takes it
 * through a conditional edge, so a branch is a real graph branch, not a second
 * code path outside the kernel.
 *
 * A plan in the widened fan-out class (`readySetRoutable`) routes as a ready
 * set instead: every control edge is unconditional and acyclic, so the nodes
 * `state.journal` already completed decide which node is entered and which one
 * may run next. A split sibling is not a successor of the node that just ran,
 * but it is entered and ready; the join is held until every entered predecessor
 * completed, exactly like the frontier's barrier (`packages/core/src/topology.ts`).
 */
export function routeKernelPlan(input: {
  readonly plan: TaskPlan
  readonly nodeId: string
  readonly state: GraphState
}): string {
  const control = input.plan.edges.filter(edge => edge.from === input.nodeId && edge.kind === 'control')
  const routingState: RoutingState = {
    facts: input.state.facts,
    artifacts: input.state.artifacts,
    // `superstep` counts completed nodes at route time; subtract the node that
    // just ran so this matches the frontier's `maxSteps - completed` budget.
    budget: { stepsRemaining: Math.max(0, input.plan.budget.maxSteps - (input.state.superstep + 1)) },
  }
  // This branch is for tool-invocation failure (`lastOk=false`). A non-zero
  // shell exit is a normal result and is routed by the verify stage's
  // `verificationFailed` guard on the forward branch instead.
  if (input.state.facts['lastOk'] === false) {
    const recovery = routeOrder(control)
      .find(edge => edge.when !== undefined && edge.when.op !== 'always' && evaluateCondition(edge.when, routingState))
    return recovery?.to ?? END
  }
  if (readySetRoutable(input.plan)) return routeReadySet(input.plan, input.nodeId, input.state)
  const forward = routeOrder(control).find(edge => evaluateCondition(edge.when, routingState))
  return forward?.to ?? END
}

/** True when the kernel adapter can own routing for this plan. */
export function canKernelDrive(plan: TaskPlan): boolean {
  if (plan.nodes.some(node => node.executor === 'subagent')) return false
  // LangGraph node names reject reserved characters such as `:`; a plan with
  // such ids keeps the frontier engine rather than renaming nodes behind the
  // plan's back.
  if (plan.nodes.some(node => !/^[A-Za-z0-9_-]+$/u.test(node.id))) return false
  // Neither engine may use a kernel channel (`next`) or `__start__`/`__end__` as
  // a node name: LangGraph's compile rejects it on the first advance().
  if (plan.nodes.some(node => isReservedPlanNodeId(node.id))) return false
  // The route hook evaluates every operator; a condition on a data edge still
  // cannot route (the kernel follows control edges), so such plans stay on the
  // frontier rather than silently ignoring the guard.
  for (const edge of plan.edges) {
    if (edge.when === undefined || edge.when.op === 'always') continue
    if (edge.kind !== 'control') return false
  }
  // One unconditional out-edge per node is the classic kernel shape: the kernel
  // pauses before every node and a DSH step is sequential. A `callFailed` edge
  // may sit next to that single success edge, making the failure branch a
  // genuine two-destination conditional edge. A step-executor fan-out (more than
  // one unconditional out-edge) is drivable only in the widened class
  // `readySetRoutable` accepts; anything else keeps the frontier.
  if (hasFanOutSplit(plan) && !readySetRoutable(plan)) return false
  return true
}

/** True for a control edge that routes unconditionally (an `always` guard is one). */
function isUnconditionalControlEdge(edge: PlanEdge): boolean {
  return edge.kind === 'control' && (edge.when === undefined || edge.when.op === 'always')
}

/** True when some node declares more than one unconditional control out-edge. */
function hasFanOutSplit(plan: TaskPlan): boolean {
  const unconditionalOut = new Map<string, number>()
  for (const edge of plan.edges) {
    if (!isUnconditionalControlEdge(edge)) continue
    const count = (unconditionalOut.get(edge.from) ?? 0) + 1
    if (count > 1) return true
    unconditionalOut.set(edge.from, count)
  }
  return false
}

/**
 * True when a plan is in the widened fan-out class the kernel can own.
 *
 * The entered set the frontier keeps at runtime is the one thing folded
 * `GraphState` does not carry, so the ready-set route derives it from
 * `state.journal`: a node is entered when a completed node has a control edge to
 * it. That derivation is only exact under these bounds, and each is a
 * correctness condition, not a taste:
 *
 *  - every control edge is unconditional — a guarded branch that did not fire
 *    must not look entered, and the journal cannot tell which arm was taken;
 *  - acyclic — a completed node would be both done and pending again, which a
 *    single `next` cannot express (`validateTaskPlan` P013 already bans an
 *    unconditional cycle, but the gate must not depend on validation running);
 *  - at most `maxJournal` nodes — the journal is trimmed to its newest
 *    entries, so a larger plan would lose a completed predecessor and hold (or
 *    release) a join on stale data;
 *  - one declared terminal — both kernels end the run at a declared terminal
 *    (LangGraph wires it to `END`), so a second terminal branch could not run
 *    on the cursor engine. Such plans keep the frontier, which can run every
 *    terminal branch;
 *  - every control predecessor is control-reachable from the entry — a
 *    predecessor that never runs can never complete, and the journal cannot tell
 *    "never entered" from "not entered yet". The frontier distinguishes them
 *    (`entered`), so these plans stay there.
 */
function readySetRoutable(plan: TaskPlan): boolean {
  if (!hasFanOutSplit(plan)) return false
  if (plan.terminals.length !== 1) return false
  if (plan.nodes.length > GRAPH_STATE_LIMITS.maxJournal) return false
  if (plan.edges.some(edge => edge.kind === 'control' && !isUnconditionalControlEdge(edge))) return false
  const reachable = controlReachableFromEntry(plan)
  if (plan.edges.some(edge => edge.kind === 'control' && !reachable.has(edge.from))) return false
  return !hasControlCycle(plan)
}

/**
 * Nodes the entry can reach over control edges. An edge out of a node outside
 * this set can never fire, so its target would never be entered.
 */
function controlReachableFromEntry(plan: TaskPlan): ReadonlySet<string> {
  const reachable = new Set<string>()
  const stack = [plan.entry]
  while (stack.length > 0) {
    const id = stack.pop() as string
    if (reachable.has(id)) continue
    reachable.add(id)
    for (const target of controlOutgoing(plan, id)) stack.push(target)
  }
  return reachable
}

/** Control-edge targets declared out of `id`. */
function controlOutgoing(plan: TaskPlan, id: string): string[] {
  const targets: string[] = []
  for (const edge of plan.edges) {
    if (edge.kind === 'control' && edge.from === id) targets.push(edge.to)
  }
  return targets
}

/** True when the control-edge subgraph has a cycle (data edges do not route). */
function hasControlCycle(plan: TaskPlan): boolean {
  const outgoing = new Map<string, string[]>()
  for (const edge of plan.edges) {
    if (edge.kind !== 'control') continue
    const targets = outgoing.get(edge.from)
    if (targets === undefined) outgoing.set(edge.from, [edge.to])
    else targets.push(edge.to)
  }
  const visiting = new Set<string>()
  const visited = new Set<string>()
  const walk = (id: string): boolean => {
    if (visiting.has(id)) return true
    if (visited.has(id)) return false
    visiting.add(id)
    for (const target of outgoing.get(id) ?? []) if (walk(target)) return true
    visiting.delete(id)
    visited.add(id)
    return false
  }
  for (const node of plan.nodes) if (walk(node.id)) return true
  return false
}

/**
 * Ready-set route for the widened fan-out class.
 *
 * `completed` is the journal plus the node that just ran (the journal entry for
 * it is appended after routing). A node is entered when a completed node has a
 * control edge to it, and ready when every control predecessor is completed; the
 * first ready node in declared control-edge order wins, which makes the branch
 * interleaving deterministic and identical on both kernel engines.
 *
 * Non-terminal nodes are preferred over the terminal: a terminal ends the run,
 * so taking it while another entered branch is still ready would drop that
 * branch. With one declared terminal the preference also keeps the two engines
 * from disagreeing about `state.next` at the terminal boundary.
 */
function routeReadySet(plan: TaskPlan, nodeId: string, state: GraphState): string | typeof END {
  const completed = new Set<string>()
  for (const entry of state.journal) completed.add(entry.nodeId)
  completed.add(nodeId)
  const entered = new Set<string>()
  for (const edge of plan.edges) {
    if (edge.kind === 'control' && completed.has(edge.from)) entered.add(edge.to)
  }
  const predecessors = new Map<string, string[]>()
  for (const edge of plan.edges) {
    if (edge.kind !== 'control') continue
    const sources = predecessors.get(edge.to)
    if (sources === undefined) predecessors.set(edge.to, [edge.from])
    else sources.push(edge.from)
  }
  let terminal: string | undefined
  const seen = new Set<string>()
  for (const edge of plan.edges) {
    if (edge.kind !== 'control') continue
    const target = edge.to
    // First declared edge wins, so a node reached by several edges is ordered
    // by its earliest predecessor declaration.
    if (seen.has(target)) continue
    seen.add(target)
    if (completed.has(target) || !entered.has(target)) continue
    const sources = predecessors.get(target) ?? []
    if (!sources.every(source => completed.has(source))) continue
    if (plan.terminals.includes(target)) {
      if (terminal === undefined) terminal = target
      continue
    }
    return target
  }
  return terminal ?? END
}

/**
 * One extra kernel step when the plan can route on the step budget. Both
 * kernels check their cap before pausing, so this reserve is what lets a
 * budget-routed wrap-up node still execute once the plan decides to wrap up;
 * without it the last affordable node would be routed but never run.
 */
function budgetReserveSteps(plan: TaskPlan): number {
  // Only a budget edge to a declared terminal is the wrap-up the reserve exists
  // for. Reserving on any budget edge (including an inert one) let the kernel
  // run one superstep past a plan that never routes on the budget.
  return plan.edges.some(edge => edge.when?.op === 'budget' && plan.terminals.includes(edge.to)) ? 1 : 0
}

/**
 * Map a lazy-compile/runtime throw from the kernel handle to a typed
 * `KernelError`. A plan whose node ids collide with engine-reserved names is the
 * known cause (`BAD_NODE_ID`); anything else is an unusable graph.
 */
function kernelTopologyError(error: unknown, nodeId: string, plan: TaskPlan): KernelError {
  if (error instanceof KernelError) return error
  const reserved = plan.nodes.find(node => isReservedPlanNodeId(node.id))?.id
  if (reserved !== undefined) {
    return new KernelError(
      `plan node id "${reserved}" collides with a kernel channel or reserved id`,
      'BAD_NODE_ID',
      { node: reserved, cause: error },
    )
  }
  const message = error instanceof Error ? error.message : String(error)
  return new KernelError(`kernel cannot drive this plan: ${message}`, 'INVALID_GRAPH', { node: nodeId, cause: error })
}
