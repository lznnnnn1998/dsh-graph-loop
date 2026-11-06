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
 * This adapter handles plans the kernel can route without plan-condition
 * evaluation: no subagent nodes and no conditional edges. The scheduler falls
 * back to `FrontierTopology` for the rest until the kernel route hook and
 * parallel batching are wired.
 */

import type { GraphState, PlanNode, TaskPlan } from 'dsh-graph-loop-core/graph-schema'
import type { KernelResult, KernelRunHandle } from 'dsh-graph-loop-core/runtime'

import { createLangGraphKernel } from './langgraph.ts'
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
}

export type KernelEngine = 'minimal' | 'langgraph'

export interface KernelTopologyOptions {
  readonly kind?: KernelEngine
  readonly taskHash?: string
  readonly maxSteps?: number
}

export class KernelTopology {
  private readonly plan: TaskPlan
  private readonly handle: KernelRunHandle
  private readonly nodeById: Map<string, PlanNode>
  private state: GraphState
  private currentId: string | undefined
  private stateStatus: 'running' | 'done' | 'failed' = 'running'
  private pending: PlanNodeOutcome | undefined
  private lastResult: KernelResult | undefined

  constructor(plan: TaskPlan, options: KernelTopologyOptions = {}) {
    this.plan = plan
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
      },
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

    let result = await this.handle.next()

    // A failed plan node does not get a second chance in kernel mode: plans
    // with failure/conditional edges are routed through FrontierTopology.
    if (!outcome.ok) {
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

/** True when the kernel adapter can own routing for this plan. */
export function canKernelDrive(plan: TaskPlan): boolean {
  if (plan.nodes.some(node => node.executor === 'subagent')) return false
  // LangGraph node names reject reserved characters such as `:`; a plan with
  // such ids keeps the frontier engine rather than renaming nodes behind the
  // plan's back.
  if (plan.nodes.some(node => !/^[A-Za-z0-9_-]+$/u.test(node.id))) return false
  return plan.edges.every(edge => edge.when === undefined || edge.when.op === 'always')
}
