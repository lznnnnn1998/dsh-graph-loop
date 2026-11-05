/**
 * Graph turn driver: turns one user task into one compiled graph run.
 *
 * This is the seam between the forked DSH agent driver and the pure routing /
 * planning code in `@dsh/explore-core`:
 *
 *   driver.beginTurn({ text })  -> plan (match + instantiate, or fallback)
 *   driver.current()            -> the node to execute as the next DSH step
 *   driver.instruction()        -> the text injected for that node
 *   driver.advance({ ok })      -> select the successor
 *   driver.done()               -> close the turn
 *
 * The driver never depends on LangGraph types. A LangGraph kernel can replace
 * `createStepGraph` implementation later; the contract stays `current/advance`.
 */
import type { PlanNode, RegistryGraph, TaskPlan, PlanStatus } from '@dsh/explore-core/graph-schema'
import {
  DEFAULT_WEIGHTS,
  cooccurrenceKey,
  extractFingerprint,
  match,
  type CooccurrenceEntry,
  type CooccurrenceTable,
  type RouteDecision,
  type RouteWeights,
  type TaskFingerprint,
} from '@dsh/explore-core/matching'
import type { TemplateLibrary } from '@dsh/explore-core/matching'
import { createStepGraph, fallbackPlan } from '@dsh/explore-core/step-graph'

/** The task text plus the facts the fingerprint needs. */
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

/** What the driver exposes to the loop for `graph_status` and logging. */
export interface GraphTurnSnapshot {
  readonly taskHash: string
  readonly templateId: string
  readonly planId: string
  readonly confidence: number
  readonly fallback: boolean
  readonly plan: TaskPlan
  readonly node: string | undefined
  readonly step: number
  readonly status: PlanStatus
  readonly visited: readonly string[]
}

/** The driver consumed by the forked agent. */
export interface GraphTurnDriver {
  beginTurn(task: TurnTask): GraphTurnSnapshot
  current(): PlanNode | undefined
  instruction(): string | undefined
  advance(outcome: { readonly ok: boolean }): GraphTurnSnapshot
  done(): boolean
  snapshot(): GraphTurnSnapshot
}

export interface GraphTurnDriverOptions {
  /** Current registry graph, or undefined when the observer only wants fallback behaviour. */
  readonly graph?: RegistryGraph
  readonly templates?: TemplateLibrary
  /** Live providers; preferred over the static fields so a `tools/change` rebuild is picked up. */
  readonly graphProvider?: () => RegistryGraph | undefined
  readonly templatesProvider?: () => TemplateLibrary | undefined
  readonly weights?: RouteWeights
  readonly cooccurrence?: CooccurrenceTable
  readonly presetId?: string
  readonly fallbackInstruction?: string
  readonly maxSteps?: number
}

function emptyWorkspace(): TaskFingerprint['workspace'] {
  return { hasGit: false, hasPackageJson: false, hasTests: false, hasPython: false, languages: [] }
}

function toCooccurrenceTable(entries: Iterable<[string, CooccurrenceEntry]> | undefined): CooccurrenceTable {
  return new Map(entries ?? [])
}

/**
 * Create a per-agent driver. State is process-local and scoped to one turn:
 * the session log remains the source of truth for history; the graph only
 * decides which step runs next.
 */
export function createGraphTurnDriver(options: GraphTurnDriverOptions = {}): GraphTurnDriver {
  let currentGraph = options.graph
  let currentTemplates = options.templates
  const liveGraph = (): RegistryGraph | undefined => options.graphProvider?.() ?? currentGraph
  const liveTemplates = (): TemplateLibrary | undefined => options.templatesProvider?.() ?? currentTemplates
  const weights = options.weights ?? DEFAULT_WEIGHTS
  const cooccurrence = toCooccurrenceTable(options.cooccurrence)
  const presetId = options.presetId ?? 'explore'
  const maxSteps = options.maxSteps ?? 24

  let plan: TaskPlan | undefined
  let decision: RouteDecision | undefined
  let stepGraph: ReturnType<typeof createStepGraph> | undefined
  let lastNode: string | undefined

  function snapshot(): GraphTurnSnapshot {
    return {
      taskHash: decision?.key.taskHash ?? plan?.id ?? 'unknown',
      templateId: plan?.templateId ?? 't_stock',
      planId: plan?.id ?? 'none',
      confidence: plan?.confidence ?? 0,
      fallback: plan?.fallback ?? true,
      plan: plan ?? fallbackPlan({ id: 'empty' }),
      node: stepGraph?.current()?.id ?? lastNode,
      step: stepGraph?.steps() ?? 0,
      status: stepGraph?.status() ?? 'failed',
      visited: stepGraph?.visited() ?? [],
    }
  }

  return {
    beginTurn(task: TurnTask): GraphTurnSnapshot {
      plan = undefined
      decision = undefined
      lastNode = undefined
      stepGraph = undefined
      const surface = task.surface ?? 'api'
      const fingerprint = extractFingerprint({
        text: task.text,
        surface,
        contextTokens: task.contextTokens ?? 0,
        attachments: task.attachments ?? [],
        workspace: task.workspace ?? emptyWorkspace(),
        visibleTools: task.visibleTools ?? [],
      })
      const graph = liveGraph()
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
            presetTools: task.presetTools ?? [...new Set(graph.nodes.filter(node => node.tool).map(node => node.tool!.name))],
          })
          plan = result.plan
          decision = result.decision
        } catch {
          plan = undefined
        }
      }
      if (plan === undefined) {
        plan = fallbackPlan({ id: fingerprint.hash, instruction: options.fallbackInstruction, maxSteps })
      }
      stepGraph = createStepGraph(plan)
      lastNode = stepGraph.current()?.id
      return snapshot()
    },
    current(): PlanNode | undefined {
      return stepGraph?.current()
    },
    instruction(): string | undefined {
      return stepGraph?.current()?.instruction
    },
    advance(outcome: { readonly ok: boolean }): GraphTurnSnapshot {
      if (stepGraph === undefined) return snapshot()
      lastNode = stepGraph.current()?.id ?? lastNode
      stepGraph.advance({ ok: outcome.ok })
      return snapshot()
    },
    done(): boolean {
      return stepGraph === undefined || stepGraph.done()
    },
    snapshot,
  }
}

/** Update the graph/templates after a `tools/change` event rebuilds the registry. */
export function updateGraphTurnDriver(
  driver: GraphTurnDriver,
  graph: RegistryGraph,
  templates?: TemplateLibrary,
): void {
  // The driver keeps these private; a fresh driver is cheap. This helper exists
  // so the plugin row can document the intended update path without reaching in.
  void driver
  void graph
  void templates
}

export { cooccurrenceKey }
