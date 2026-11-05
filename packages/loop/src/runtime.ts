/**
 * Graph runtime service: the mutable, per-session side of the dynamic topology.
 *
 * The driver reads a model-authored proposal from here between steps, and writes
 * a small run record for `graph_status`. Everything is process-local: durable
 * truth stays in the session log; a restart re-discovers the topology.
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
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
  /** Directory for per-turn topology traces consumed by `scripts/preview.mjs`. Empty disables. */
  traceDir?: string
}

type GraphRuntimeService = {
  setProposal(sessionId: string, plan: TaskPlan): void
  takeProposal(sessionId: string): TaskPlan | undefined
  record(sessionId: string, record: GraphRunRecord): void
  last(sessionId: string): GraphRunRecord | undefined
  /** Persist one turn trace when `traceDir` is configured (for the preview panel). */
  recordTurn(sessionId: string, snapshot: unknown): void
  /** In-memory turn traces for the live graph-chat panel. */
  traceHistory(sessionId: string): readonly unknown[]
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
  private readonly traces = new Map<string, unknown[]>()
  private readonly maxProposals: number
  private readonly traceDir: string

  constructor(ctx: Context, config: Config = {}) {
    super(ctx, 'graphRuntime')
    this.maxProposals = config.maxProposals ?? 1
    this.traceDir = config.traceDir ?? ''
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

  traceHistory(sessionId: string): readonly unknown[] {
    return this.traces.get(sessionId) ?? []
  }

  recordTurn(sessionId: string, snapshot: unknown): void {
    const history = this.traces.get(sessionId) ?? []
    history.push(snapshot)
    while (history.length > 20) history.shift()
    this.traces.set(sessionId, history)
    if (this.traceDir === '') return
    try {
      mkdirSync(this.traceDir, { recursive: true })
      const stamp = new Date().toISOString().replaceAll(':', '-')
      writeFileSync(join(this.traceDir, `${sessionId}-${stamp}.json`), `${JSON.stringify({
        sessionId,
        at: new Date().toISOString(),
        ...(snapshot as Record<string, unknown>),
      }, null, 2)}\n`)
    } catch {
      // Tracing is best-effort and must not affect the turn.
    }
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
