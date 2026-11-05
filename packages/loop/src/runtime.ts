/**
 * Graph runtime service: the mutable, per-session side of the dynamic topology.
 *
 * The driver reads a model-authored proposal from here between steps, and writes
 * a small run record for `graph_status`. Everything is process-local: durable
 * truth stays in the session log; a restart re-discovers the topology.
 */
import { Service, type Context } from '@deepseek-ai/cordis'
import type { TaskPlan } from '@dsh/explore-core/graph-schema'
import type { TopologyMode } from '@dsh/explore-core/topology'

export interface GraphRunRecord {
  readonly mode: TopologyMode | 'unknown'
  readonly node: string | undefined
  readonly step: number
  readonly planId: string
  readonly rationale: readonly string[]
}

export interface Config {
  /** Maximum model-authored topology proposals kept per session (usually one). */
  maxProposals?: number
}

type GraphRuntimeService = {
  setProposal(sessionId: string, plan: TaskPlan): void
  takeProposal(sessionId: string): TaskPlan | undefined
  record(sessionId: string, record: GraphRunRecord): void
  last(sessionId: string): GraphRunRecord | undefined
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    graphRuntime: GraphRuntimeService
  }
}

/** Host-scoped runtime state. */
export class GraphRuntime extends Service implements GraphRuntimeService {
  private readonly proposals = new Map<string, TaskPlan>()
  private readonly records = new Map<string, GraphRunRecord>()
  private readonly maxProposals: number

  constructor(ctx: Context, config: Config = {}) {
    super(ctx, 'graphRuntime')
    this.maxProposals = config.maxProposals ?? 1
  }

  setProposal(sessionId: string, plan: TaskPlan): void {
    this.proposals.delete(sessionId)
    this.proposals.set(sessionId, plan)
    while (this.proposals.size > this.maxProposals) {
      const oldest = this.proposals.keys().next().value
      if (oldest === undefined) break
      this.proposals.delete(oldest)
    }
  }

  takeProposal(sessionId: string): TaskPlan | undefined {
    const plan = this.proposals.get(sessionId)
    if (plan !== undefined) this.proposals.delete(sessionId)
    return plan
  }

  record(sessionId: string, record: GraphRunRecord): void {
    this.records.set(sessionId, record)
  }

  last(sessionId: string): GraphRunRecord | undefined {
    return this.records.get(sessionId)
  }
}

export const name = 'explore-runtime'

/**
 * Mount the runtime service.
 * @param ctx - host context.
 * @param config - proposal capacity.
 */
export function apply(ctx: Context, config: Config = {}): void {
  ctx.plugin(GraphRuntime, config)
}
