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
 * This adapter handles plans the kernel can route without the frontier's
 * parallel batching: no subagent nodes, and only the `callFailed` condition —
 * the failure branch is a real LangGraph conditional edge (two declared
 * destinations, one taken). Plans with artifact/fact/budget conditions, a
 * parallel fan-out, or subagent batches still use `FrontierTopology`.
 */

import { END, KernelError } from 'dsh-graph-loop-core/kernel'
import type { GraphState, Json, PlanNode, TaskPlan } from 'dsh-graph-loop-core/graph-schema'
import type { RoutingArtifact } from 'dsh-graph-loop-core/condition'
import { evaluateCondition, routeOrder, type RoutingState } from 'dsh-graph-loop-core/condition'
import type { KernelResult, KernelRunHandle } from 'dsh-graph-loop-core/runtime'

import { createLangGraphKernel, isReservedPlanNodeId } from './langgraph.ts'
import { createMinimalKernel } from './minimal.ts'
import {
  planInitialState,
  type KernelDeps,
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
}

export type KernelEngine = 'minimal' | 'langgraph'

export interface KernelTopologyOptions {
  readonly kind?: KernelEngine
  readonly taskHash?: string
  readonly maxSteps?: number
}

export class KernelTopology {
  private readonly plan: TaskPlan
  private readonly engine: KernelEngine
  private readonly handle: KernelRunHandle
  private readonly nodeById: Map<string, PlanNode>
  private state: GraphState
  private currentId: string | undefined
  private stateStatus: 'running' | 'done' | 'failed' = 'running'
  private pending: PlanNodeOutcome | undefined
  private lastResult: KernelResult | undefined

  constructor(plan: TaskPlan, options: KernelTopologyOptions = {}) {
    this.plan = plan
    this.engine = options.kind ?? 'langgraph'
    this.nodeById = new Map(plan.nodes.map(node => [node.id, node]))
    this.state = planInitialState(plan, options.taskHash ?? plan.id)
    this.currentId = this.nodeById.get(plan.entry)?.id ?? plan.entry

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
      // The only condition this adapter accepts; the route is a real branch
      // (success edge vs `callFailed` recovery edge) that the compiled graph
      // takes as a conditional edge.
      route: routeKernelPlan,
      // Stop before every node: the host has not run this step yet. Once an
      // outcome is pending, let the kernel execute the node's bridge executor.
      pauseWhen: () => (this.pending === undefined ? 'replan' : undefined),
      maxSteps: options.maxSteps ?? plan.budget.maxSteps,
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
      if (result.kind === 'boundary') {
        if (result.state.next === null || result.state.status !== 'running') {
          this.lastResult = result
          this.state = result.state
          this.stateStatus = result.state.status === 'failed' ? 'failed' : 'done'
          this.currentId = undefined
          return undefined
        }
        result = await this.handle.next()
      }

      this.lastResult = result
      this.state = result.state
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
 * Route policy for kernel-drivable plans. Every control edge is evaluated with
 * the same `evaluateCondition` the frontier uses, so artifact/fact/budget
 * guards are not silently dropped by the kernel. A failed step only takes a
 * guarded recovery edge; `END` means no edge matched.
 *
 * The returned successor becomes `state.next`; the compiled graph then takes it
 * through a conditional edge, so a branch is a real graph branch, not a second
 * code path outside the kernel.
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
    budget: { stepsRemaining: Math.max(0, input.plan.budget.maxSteps - input.state.superstep) },
  }
  if (input.state.facts['lastOk'] === false) {
    const recovery = routeOrder(control)
      .find(edge => edge.when !== undefined && edge.when.op !== 'always' && evaluateCondition(edge.when, routingState))
    return recovery?.to ?? END
  }
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
  // One unconditional out-edge per node: the kernel pauses before every node and
  // a DSH step is sequential, so a parallel diamond cannot run here. A
  // `callFailed` edge may sit next to that single success edge, making the
  // failure branch a genuine two-destination conditional edge.
  const unconditionalOut = new Map<string, number>()
  for (const edge of plan.edges) {
    if (edge.kind !== 'control') continue
    if (edge.when !== undefined && edge.when.op !== 'always') continue
    unconditionalOut.set(edge.from, (unconditionalOut.get(edge.from) ?? 0) + 1)
  }
  for (const count of unconditionalOut.values()) {
    if (count > 1) return false
  }
  return true
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
