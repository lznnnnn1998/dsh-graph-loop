/**
 * Graph turn driver: turns one user task into one graph run, with three
 * topology modes:
 *
 *   template  — pick a curated template (bootstrap / A/B control)
 *   dynamic   — synthesize an arbitrary DAG from the live capability graph
 *   propose   — start from a bootstrap frame and let the model author the
 *               topology through `graph_plan`; the harness validates it
 *
 * In every mode the driver exposes `current()/instruction()/advance()/done()`.
 * A model-authored proposal may replace the live topology between steps.
 */
import type { PlanNode, PlanStatus, RegistryGraph, TaskPlan } from 'dsh-graph-loop-core/graph-schema'
import {
  DEFAULT_WEIGHTS,
  extractFingerprint,
  match,
  type CooccurrenceEntry,
  type CooccurrenceTable,
  type RouteDecision,
  type RouteWeights,
  type TaskFingerprint,
  type TemplateLibrary,
} from 'dsh-graph-loop-core/matching'
import { FrontierTopology, bootstrapTopology, recoveryTopology, synthesizeTopology, type TopologyMode } from 'dsh-graph-loop-core/topology'
import { KernelTopology, canKernelDrive } from './kernel/topology.ts'
import { fallbackPlan } from 'dsh-graph-loop-core/step-graph'

export type { TopologyMode }

export interface TurnTask {
  readonly text: string
  readonly surface?: 'cli' | 'web' | 'api' | 'headless'
  readonly contextTokens?: number
  readonly visibleTools?: readonly string[]
  readonly workspace?: TaskFingerprint['workspace']
  readonly attachments?: readonly { readonly kind: 'image' | 'file' | 'url'; readonly name: string }[]
  readonly presetTools?: readonly string[]
  readonly presetId?: string
}

export interface GraphTurnSnapshot {
  readonly taskHash: string
  readonly templateId: string
  readonly planId: string
  readonly confidence: number
  readonly fallback: boolean
  readonly mode: TopologyMode
  readonly plan: TaskPlan
  readonly node: string | undefined
  readonly step: number
  readonly status: PlanStatus
  readonly visited: readonly string[]
  readonly rationale: readonly string[]
  /** One row per executed (or attempted) plan node, in run order. */
  readonly trail: readonly {
    readonly id: string
    readonly step: number
    readonly executor: string
    readonly status: 'ok' | 'failed'
    readonly tools?: readonly { readonly name: string; readonly callId: string; readonly isError: boolean }[]
  }[]
  readonly depth?: number
  readonly replans?: number
}

export interface GraphTurnDriver {
  beginTurn(task: TurnTask): Promise<GraphTurnSnapshot>
  current(): PlanNode | undefined
  instruction(): string | undefined
  /**
   * Tools compiled into the active plan. The agent narrows each step's admitted
   * tool set to this list, so the graph does not pay for tools its plan cannot
   * use. Optional for test doubles and drivers that expose no universe.
   */
  toolUniverse?(): readonly string[] | undefined
  advance(outcome: {
    readonly ok: boolean
    readonly failedTool?: string
    readonly tools?: readonly { readonly name: string; readonly callId: string; readonly isError: boolean }[]
  }): Promise<GraphTurnSnapshot>
  adopt(plan: TaskPlan): void
  /** Detach and return all queued subagent nodes (parallel batch). */
  takeSubagentBatch(): PlanNode[]
  /** Complete one node from a batch, with its outcome. */
  completeNode(id: string, ok: boolean): Promise<void>
  done(): boolean
  /** Called once by the driver after `turn/end`; flushes the trace. */
  endTurn(): void
  snapshot(): GraphTurnSnapshot
}

export type AdoptPolicy = 'start-only' | 'always' | 'on-failure'

export interface GraphTurnDriverOptions {
  readonly mode?: TopologyMode
  /**
   * When a model-authored topology may replace the live one. The default is
   * `start-only`: a proposal is adopted only during the planning phase (before
   * the first work node completes), so the graph is fixed once real work starts.
   * Mid-run re-planning is opt-in and still bounded by the step budget.
   */
  readonly adoptPolicy?: AdoptPolicy
  /** Kernel engine for plans the kernel can route; `off` keeps the frontier. */
  readonly kernel?: 'langgraph' | 'minimal' | 'off'
  /**
   * Tool admission for a step. `plan` (default) narrows to the plan universe and
   * the safe floor; `preset` keeps the full preset tool set, which benchmark
   * harnesses need when their tools are not named in the synthesized plan.
   */
  readonly toolPolicy?: 'plan' | 'preset'
  readonly graph?: RegistryGraph
  readonly templates?: TemplateLibrary
  readonly graphProvider?: () => RegistryGraph | undefined | Promise<RegistryGraph | undefined>
  readonly templatesProvider?: () => TemplateLibrary | undefined
  readonly proposalSource?: () => TaskPlan | undefined
  readonly weights?: RouteWeights
  readonly cooccurrence?: CooccurrenceTable
  readonly presetId?: string
  readonly fallbackInstruction?: string
  readonly maxSteps?: number
  /** Text length below which a trivial task gets the single-node plan. */
  readonly trivialChars?: number
  /** False for subagent children: no nested fan-out. */
  readonly allowSubagents?: boolean
  /** Force the single-node fallback plan (used for subagent children). */
  readonly forceFallback?: boolean
  /** Delegation depth (0 for a root agent), included in the trace. */
  readonly depth?: number
  readonly onSnapshot?: (snapshot: GraphTurnSnapshot) => void
  readonly onTurnEnd?: (snapshot: GraphTurnSnapshot) => void
}

function emptyWorkspace(): TaskFingerprint['workspace'] {
  return { hasGit: false, hasPackageJson: false, hasTests: false, hasPython: false, languages: [] }
}

function toCooccurrenceTable(entries: Iterable<[string, CooccurrenceEntry]> | undefined): CooccurrenceTable {
  return new Map(entries ?? [])
}

interface TurnTopology {
  current(): PlanNode | undefined
  pendingNodes(): readonly PlanNode[]
  detach(id: string): PlanNode | undefined
  select(id: string): PlanNode | undefined
  advance(outcome: { readonly ok: boolean; readonly failedTool?: string }): PlanNode | undefined | Promise<PlanNode | undefined>
  done(): boolean
  status(): 'running' | 'done' | 'failed'
  steps(): number
  snapshot(): TaskPlan
  dispose?(): Promise<void> | void
}

/**
 * Create a per-agent driver. State is process-local and scoped to one turn:
 * the session log remains the source of truth for history; the topology only
 * decides which step runs next.
 */
export function createGraphTurnDriver(options: GraphTurnDriverOptions = {}): GraphTurnDriver {
  const mode: TopologyMode = options.mode ?? 'template'
  const adoptPolicy: AdoptPolicy = options.adoptPolicy ?? 'start-only'
  let adoptedAtStep: number | undefined
  let trail: {
    id: string
    step: number
    executor: string
    status: 'ok' | 'failed'
    tools?: readonly { name: string; callId: string; isError: boolean }[]
  }[] = []
  let replans = 0
  let currentGraph = options.graph
  let currentTemplates = options.templates
  const weights = options.weights ?? DEFAULT_WEIGHTS
  const cooccurrence = toCooccurrenceTable(options.cooccurrence)
  const presetId = options.presetId ?? 'explore'
  const maxSteps = options.maxSteps ?? 24
  const trivialChars = options.trivialChars ?? 32
  const liveGraph = async (): Promise<RegistryGraph | undefined> => await options.graphProvider?.() ?? currentGraph
  const liveTemplates = (): TemplateLibrary | undefined => options.templatesProvider?.() ?? currentTemplates

  let plan: TaskPlan | undefined
  let decision: RouteDecision | undefined
  let topology: TurnTopology | undefined
  let lastNode: string | undefined
  let rationale: readonly string[] = []

  function presetToolsOf(graph: RegistryGraph, task: TurnTask): readonly string[] {
    if (task.presetTools !== undefined) return task.presetTools
    return [...new Set(graph.nodes.filter(node => node.tool).map(node => node.tool!.name))]
  }

  function snapshot(): GraphTurnSnapshot {
    const currentPlan = plan ?? fallbackPlan({ id: 'empty', instruction: options.fallbackInstruction, maxSteps })
    return {
      taskHash: decision?.key.taskHash ?? currentPlan.id,
      templateId: currentPlan.templateId,
      planId: currentPlan.id,
      confidence: currentPlan.confidence,
      fallback: currentPlan.fallback,
      mode,
      plan: topology?.snapshot() ?? currentPlan,
      node: topology?.current()?.id ?? lastNode,
      step: topology?.steps() ?? 0,
      status: topology?.status() ?? 'failed',
      visited: [...(topology?.snapshot().nodes.map(node => node.id) ?? [])].slice(0, topology?.steps() ?? 0),
      rationale,
      trail: [...trail],
      replans,
      depth: options.depth ?? 0,
    }
  }

  function emit(): GraphTurnSnapshot {
    const snap = snapshot()
    options.onSnapshot?.(snap)
    return snap
  }

  function install(next: TaskPlan): void {
    adoptedAtStep = undefined
    plan = next
    const kernelMode = options.kernel ?? 'langgraph'
    try {
      topology = kernelMode !== 'off' && canKernelDrive(next)
        ? new KernelTopology(next, { kind: kernelMode, taskHash: next.id, maxSteps: next.budget.maxSteps })
        : new FrontierTopology(next)
    } catch {
      topology = new FrontierTopology(next)
    }
    lastNode = topology.current()?.id
  }

  return {
    async beginTurn(task: TurnTask): Promise<GraphTurnSnapshot> {
      plan = undefined
      decision = undefined
      topology = undefined
      lastNode = undefined
      rationale = []
      trail = []
      const graph = await liveGraph()
      const surface = task.surface ?? 'api'
      const fingerprint = extractFingerprint({
        text: task.text,
        surface,
        contextTokens: task.contextTokens ?? 0,
        attachments: task.attachments ?? [],
        workspace: task.workspace ?? emptyWorkspace(),
        visibleTools: task.visibleTools ?? [],
      })

      if (mode === 'propose') {
        install(bootstrapTopology(fingerprint.hash, { maxSteps }))
        rationale = ['bootstrap frame: the model authors the topology']
        return emit()
      }

      if (options.forceFallback === true) {
        install(fallbackPlan({ id: fingerprint.hash, instruction: options.fallbackInstruction, maxSteps }))
        rationale = ['child agent: single-node fallback']
        return emit()
      }

      // Triage: a trivial task does not deserve a synthesized graph. One step
      // keeps short chats at stock-loop cost instead of paying plan overhead.
      const trivial = task.text.trim().length > 0 && task.text.trim().length < trivialChars
        && fingerprint.intent === 'other'
        && !fingerprint.mutating
        && fingerprint.artifactsIn.length === 0
        && fingerprint.artifactsOut.length === 0
      if (mode !== 'template' && trivial) {
        install(fallbackPlan({ id: fingerprint.hash, instruction: options.fallbackInstruction, maxSteps }))
        rationale = ['triage: trivial task, single-node plan']
        return emit()
      }

      if (mode === 'dynamic' && graph !== undefined) {
        try {
          const synthesized = synthesizeTopology({
            taskHash: fingerprint.hash,
            fingerprint,
            graph,
            presetTools: presetToolsOf(graph, task),
            allowSubagents: options.allowSubagents !== false,
            budget: { maxSteps },
          })
          install(synthesized.plan)
          rationale = synthesized.rationale
          return emit()
        } catch {
          // fall through to the template/fallback path
        }
      }

      const templates = liveTemplates()
      if (graph !== undefined && templates !== undefined) {
        try {
          const result = match({
            fingerprint,
            graph,
            library: templates,
            cooccurrence,
            weights,
            presetId,
            presetTools: presetToolsOf(graph, task),
          })
          plan = result.plan
          decision = result.decision
          install(result.plan)
          rationale = [result.decision.fallback ? 'template fallback' : `template ${result.decision.templateId}`]
          return emit()
        } catch {
          plan = undefined
        }
      }
      install(fallbackPlan({ id: fingerprint.hash, instruction: options.fallbackInstruction, maxSteps }))
      rationale = ['single-node fallback']
      return emit()
    },
    current(): PlanNode | undefined {
      return topology?.current()
    },
    instruction(): string | undefined {
      return topology?.current()?.instruction
    },
    toolUniverse(): readonly string[] | undefined {
      if ((options.toolPolicy ?? 'plan') === 'preset') return undefined
      return topology?.snapshot().toolUniverse ?? plan?.toolUniverse
    },
    async advance(outcome: {
    readonly ok: boolean
    readonly failedTool?: string
    readonly tools?: readonly { readonly name: string; readonly callId: string; readonly isError: boolean }[]
  }): Promise<GraphTurnSnapshot> {
      if (topology === undefined) return snapshot()
      const node = topology.current()
      lastNode = node?.id ?? lastNode
      if (node !== undefined) {
        trail.push({
          id: node.id,
          step: topology.steps() + 1,
          executor: node.executor ?? 'step',
          status: outcome.ok ? 'ok' : 'failed',
          ...(outcome.tools === undefined || outcome.tools.length === 0 ? {} : { tools: outcome.tools }),
        })
      }
      await Promise.resolve(topology.advance({ ok: outcome.ok, ...(outcome.failedTool === undefined ? {} : { failedTool: outcome.failedTool }) }))
      // Boundary replan: a failed work node gets a small diagnosis/retry graph.
      if (!outcome.ok && topology.status() === 'failed') {
        const maxReplans = plan?.budget.maxReplans ?? 0
        if (replans < maxReplans) {
          replans += 1
          install(recoveryTopology({
            taskHash: plan?.id ?? 'unknown',
            failedNode: lastNode ?? 'unknown',
            ...(outcome.failedTool === undefined ? {} : { failedTool: outcome.failedTool }),
            budget: plan?.budget,
          }))
          rationale = [...rationale, `replan ${replans}: recovery after ${lastNode ?? 'failure'}`]
        }
      }
      // A model-authored proposal can arrive between steps. The default policy
      // treats topology as a turn-start decision: adopt only before the first
      // work node completes. `always` is an explicit opt-in to mid-run edits.
      if (options.proposalSource !== undefined) {
        const proposed = options.proposalSource()
        if (proposed !== undefined) {
          const steps = topology.steps()
          const allowed = adoptPolicy === 'always'
            || (adoptPolicy === 'start-only' && steps <= 1)
            || (adoptPolicy === 'on-failure' && topology.status() === 'failed')
          if (allowed) {
            install(proposed)
            adoptedAtStep = steps
            rationale = [...rationale, 'adopted model-authored topology']
          } else {
            rationale = [...rationale, 'proposal ignored: topology is fixed after the first work node']
          }
        }
      }
      return emit()
    },
    adopt(next: TaskPlan): void {
      install(next)
      rationale = [...rationale, 'topology replaced']
    },
    takeSubagentBatch(): PlanNode[] {
      if (topology === undefined) return []
      const detached: PlanNode[] = []
      // The node already peeked as current is the batch leader; the frontier's
      // queued subagent nodes are the rest of the parallel branch.
      const leader = topology.current()
      if (leader?.executor === 'subagent') detached.push(leader)
      for (const node of topology.pendingNodes()) {
        if (node.executor !== 'subagent') continue
        const taken = topology.detach(node.id)
        if (taken !== undefined) detached.push(taken)
      }
      return detached
    },
    async completeNode(id: string, ok: boolean): Promise<void> {
      if (topology === undefined) return
      const node = topology.select(id)
      if (node !== undefined) {
        trail.push({ id, step: topology.steps() + 1, executor: node.executor ?? 'step', status: ok ? 'ok' : 'failed' })
      }
      await Promise.resolve(topology.advance({ ok }))
      lastNode = id
      options.onSnapshot?.(snapshot())
    },
    done(): boolean {
      return topology === undefined || topology.done()
    },
    endTurn(): void {
      const finishing = topology
      const finalSnapshot = snapshot()
      topology = undefined
      void finishing?.dispose?.()
      options.onTurnEnd?.(finalSnapshot)
    },
    snapshot,
  }
}
