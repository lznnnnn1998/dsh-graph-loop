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
import type { PlanNode, PlanStatus, RegistryGraph, TaskPlan } from '@dsh/explore-core/graph-schema'
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
} from '@dsh/explore-core/matching'
import { FrontierTopology, bootstrapTopology, synthesizeTopology, type TopologyMode } from '@dsh/explore-core/topology'
import { fallbackPlan } from '@dsh/explore-core/step-graph'

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
}

export interface GraphTurnDriver {
  beginTurn(task: TurnTask): GraphTurnSnapshot
  current(): PlanNode | undefined
  instruction(): string | undefined
  advance(outcome: { readonly ok: boolean }): GraphTurnSnapshot
  adopt(plan: TaskPlan): void
  done(): boolean
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
  readonly graph?: RegistryGraph
  readonly templates?: TemplateLibrary
  readonly graphProvider?: () => RegistryGraph | undefined
  readonly templatesProvider?: () => TemplateLibrary | undefined
  readonly proposalSource?: () => TaskPlan | undefined
  readonly weights?: RouteWeights
  readonly cooccurrence?: CooccurrenceTable
  readonly presetId?: string
  readonly fallbackInstruction?: string
  readonly maxSteps?: number
  readonly onSnapshot?: (snapshot: GraphTurnSnapshot) => void
}

function emptyWorkspace(): TaskFingerprint['workspace'] {
  return { hasGit: false, hasPackageJson: false, hasTests: false, hasPython: false, languages: [] }
}

function toCooccurrenceTable(entries: Iterable<[string, CooccurrenceEntry]> | undefined): CooccurrenceTable {
  return new Map(entries ?? [])
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
  let currentGraph = options.graph
  let currentTemplates = options.templates
  const weights = options.weights ?? DEFAULT_WEIGHTS
  const cooccurrence = toCooccurrenceTable(options.cooccurrence)
  const presetId = options.presetId ?? 'explore'
  const maxSteps = options.maxSteps ?? 24
  const liveGraph = (): RegistryGraph | undefined => options.graphProvider?.() ?? currentGraph
  const liveTemplates = (): TemplateLibrary | undefined => options.templatesProvider?.() ?? currentTemplates

  let plan: TaskPlan | undefined
  let decision: RouteDecision | undefined
  let topology: FrontierTopology | undefined
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
    topology = new FrontierTopology(next)
    lastNode = topology.current()?.id
  }

  return {
    beginTurn(task: TurnTask): GraphTurnSnapshot {
      plan = undefined
      decision = undefined
      topology = undefined
      lastNode = undefined
      rationale = []
      const graph = liveGraph()
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

      if (mode === 'dynamic' && graph !== undefined) {
        try {
          const synthesized = synthesizeTopology({
            taskHash: fingerprint.hash,
            fingerprint,
            graph,
            presetTools: presetToolsOf(graph, task),
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
    advance(outcome: { readonly ok: boolean }): GraphTurnSnapshot {
      if (topology === undefined) return snapshot()
      lastNode = topology.current()?.id ?? lastNode
      topology.advance({ ok: outcome.ok })
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
    done(): boolean {
      return topology === undefined || topology.done()
    },
    snapshot,
  }
}
