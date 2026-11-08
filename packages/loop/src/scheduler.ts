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
import { FrontierTopology, bootstrapTopology, recoveryTopology, repairTopology, synthesizeTopology, type TopologyMode } from 'dsh-graph-loop-core/topology'
import { synthesizeComposition } from 'dsh-graph-loop-core/compose'
import { selectEnvelopeForTask } from 'dsh-graph-loop-core/envelope'
import { KernelTopology, canKernelDrive } from './kernel/topology.ts'
import { deriveCapabilityFacts, deriveStepArtifacts, deriveStepFacts } from './step-facts.ts'
import type { RoutingArtifact } from 'dsh-graph-loop-core/condition'
import type { ArtifactType, Json } from 'dsh-graph-loop-core/graph-schema'
import { fallbackPlan } from 'dsh-graph-loop-core/fallback'

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
    readonly tools?: readonly { readonly name: string; readonly callId?: string; readonly isError: boolean; readonly arguments?: string; readonly output?: string }[]
  }[]
  readonly depth?: number
  readonly replans?: number
  /** Envelope chosen by the live composition path, when it ran. */
  readonly envelopeId?: string
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
    readonly tools?: readonly { readonly name: string; readonly callId?: string; readonly isError: boolean; readonly arguments?: string; readonly output?: string }[]
  }): Promise<GraphTurnSnapshot>
  adopt(plan: TaskPlan): void
  /** Detach and return all queued subagent nodes (parallel batch). */
  takeSubagentBatch(): PlanNode[]
  /** Complete one node from a batch, with its outcome. */
  completeNode(id: string, ok: boolean): Promise<void>
  done(): boolean
  /**
   * Current run status. `failed` means the graph ended unsuccessfully after
   * recovery/replan had its chance; the loop turns that into a failed turn.
   * Optional for test doubles that only exercise the stepping surface.
   */
  status?(): PlanStatus
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
  /** Use the envelope + capability composer in dynamic mode (default true). */
  readonly composition?: boolean
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
  advance(outcome: {
    readonly ok: boolean
    readonly failedTool?: string
    readonly facts?: Readonly<Record<string, Json>>
    readonly artifacts?: readonly RoutingArtifact[]
  }): PlanNode | undefined | Promise<PlanNode | undefined>
  done(): boolean
  status(): 'running' | 'done' | 'failed'
  steps(): number
  snapshot(): TaskPlan
  dispose?(): Promise<void> | void
}

/** One graph node outcome as the loop reports it after a step or subagent result. */
interface NodeOutcome {
  readonly ok: boolean
  readonly failedTool?: string
  readonly tools?: readonly { readonly name: string; readonly callId?: string; readonly isError: boolean; readonly arguments?: string; readonly output?: string }[]
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
    tools?: readonly { name: string; callId?: string; isError: boolean; arguments?: string }[]
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
  let envelopeId: string | undefined
  /**
   * Artifact types this run has ever produced, used to reset the step-scoped
   * `produced.<type>` facts on every step. Without the reset a guard such as the
   * author's `produced.file.image == false` could be satisfied by an artifact
   * from an earlier stage.
   */
  let producedTypes = new Set<ArtifactType>()

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
      ...(envelopeId === undefined ? {} : { envelopeId }),
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
      // `KernelTopology` owns its step-budget reserve for a budget-routed
      // wrap-up node, so the driver does not special-case the plan budget.
      topology = kernelMode !== 'off' && canKernelDrive(next)
        ? new KernelTopology(next, { kind: kernelMode, taskHash: next.id })
        : new FrontierTopology(next)
    } catch {
      topology = new FrontierTopology(next)
    }
    lastNode = topology.current()?.id
  }

  /** Append one executed node to the run trail. */
  function recordTrail(id: string, executor: string | undefined, outcome: NodeOutcome): void {
    trail.push({
      id,
      step: (topology?.steps() ?? 0) + 1,
      executor: executor ?? 'step',
      status: outcome.ok ? 'ok' : 'failed',
      ...(outcome.tools === undefined || outcome.tools.length === 0 ? {} : { tools: outcome.tools }),
    })
  }

  /**
   * Boundary replan: a failed work node gets a small diagnosis/retry graph.
   * Shared by model steps and subagent batch completions so a failed child can
   * trigger the same recovery a failed step can.
   */
  async function recoverAfterFailure(outcome: NodeOutcome): Promise<void> {
    if (outcome.ok || topology === undefined || topology.status() !== 'failed') return
    const maxReplans = plan?.budget.maxReplans ?? 0
    if (replans >= maxReplans) return
    replans += 1
    const failedNode = lastNode ?? 'unknown'
    const graph = await liveGraph()
    const planNode = plan?.nodes.find(node => node.id === failedNode)
    const capability = planNode?.capabilityId === undefined
      ? undefined
      : graph?.nodes.find(node => node.id === planNode.capabilityId)
    // Classify by the registry capability, not by a node-id regex. Composed
    // plans carry capabilityId; a plan without one keeps the readable fallback.
    const verifyFailure = capability?.tags.includes('verification')
      ?? /verify/i.test(failedNode)
    const next = verifyFailure
      ? repairTopology({
        taskHash: plan?.id ?? 'unknown',
        failedNode,
        ...(outcome.failedTool === undefined ? {} : { failedTool: outcome.failedTool }),
        budget: plan?.budget,
      })
      : recoveryTopology({
        taskHash: plan?.id ?? 'unknown',
        failedNode,
        ...(outcome.failedTool === undefined ? {} : { failedTool: outcome.failedTool }),
        budget: plan?.budget,
      })
    install(next)
    rationale = [...rationale, `replan ${replans}: ${verifyFailure ? 'verify repair' : 'recovery'} after ${lastNode ?? 'failure'}`]
  }

  /**
   * A model-authored proposal can arrive between steps. The default policy
   * treats topology as a turn-start decision: adopt only before the first
   * work node completes. `always` is an explicit opt-in to mid-run edits.
   */
  function adoptProposalAtBoundary(): void {
    if (options.proposalSource === undefined) return
    const proposed = options.proposalSource()
    if (proposed === undefined) return
    const steps = topology?.steps() ?? 0
    const allowed = adoptPolicy === 'always'
      || (adoptPolicy === 'start-only' && steps <= 1)
      || (adoptPolicy === 'on-failure' && topology?.status() === 'failed')
    if (allowed) {
      install(proposed)
      adoptedAtStep = steps
      rationale = [...rationale, 'adopted model-authored topology']
    } else {
      rationale = [...rationale, 'proposal ignored: topology is fixed after the first work node']
    }
  }

  /**
   * Record one node outcome, advance the topology, then run boundary recovery.
   * `record` is absent when `advance()` has no current node: the run still
   * settles its boundary, without inventing a trail row.
   */
  async function advanceNode(
    record: { readonly id: string; readonly executor?: string; readonly capabilityId?: string } | undefined,
    lastNodeId: string | undefined,
    outcome: NodeOutcome,
    adoptProposal: boolean,
  ): Promise<void> {
    if (topology === undefined) return
    if (record !== undefined) recordTrail(record.id, record.executor, outcome)
    lastNode = lastNodeId ?? lastNode
    const observed = outcome.tools ?? []
    const facts = deriveStepFacts(observed, outcome.ok, outcome.failedTool)
    const graph = await liveGraph()
    const capability = record?.capabilityId === undefined
      ? undefined
      : graph?.nodes.find(node => node.id === record.capabilityId)
    const declaredTypes = capability?.produces.map(spec => spec.type) ?? []
    // Credit the capability's declared artifacts only when that capability's
    // tool actually ran; an unrelated successful call does not fulfill the
    // node's artifact contract.
    const artifacts = deriveStepArtifacts(
      observed,
      declaredTypes,
      record?.capabilityId ?? record?.id ?? 'step',
      capability?.tool?.name,
    )
    // A planned third-party/MCP capability supplies the same read/write signal
    // the tool-name heuristics in `deriveStepFacts` give the core tools, so a
    // composed inspect/mutate stage is classifiable whatever fills it.
    Object.assign(facts, deriveCapabilityFacts(observed, capability))
    // A verify node has a planned verification capability. "Something ran" is
    // not enough: a read/glob/explore call must not count as a verification.
    if (capability?.tags.includes('verification')) {
      const verificationTool = capability.tool?.name
      facts['verificationRan'] = verificationTool === undefined
        ? observed.length > 0
        : observed.some(tool => tool.name === verificationTool && !tool.isError)
    }
    // `artifact` stays run-cumulative by design; stage success must be
    // step-scoped, otherwise an earlier stage's file can satisfy a later
    // author's guard. The boolean is always written so an author's
    // `producedArtifact=false` repair exit can fire when the step produced
    // nothing (an absent fact would make both author exits false).
    facts['producedArtifact'] = artifacts.length > 0
    // Type-scoped and step-scoped: every type this run has ever produced, plus
    // the node's declared types, is reset to false before this step's artifacts
    // are marked true. A stale `produced.file.text` must not satisfy a later
    // guard, and the author's own type must be present (false) on its first
    // step or its no-progress exit could never fire.
    for (const type of declaredTypes) facts[`produced.${type}`] = false
    for (const type of producedTypes) facts[`produced.${type}`] = false
    for (const artifact of artifacts) {
      facts[`produced.${artifact.type}`] = true
      producedTypes.add(artifact.type)
    }
    await Promise.resolve(topology.advance({
      ok: outcome.ok,
      ...(outcome.failedTool === undefined ? {} : { failedTool: outcome.failedTool }),
      facts,
      ...(artifacts.length === 0 ? {} : { artifacts }),
    }))
    await recoverAfterFailure(outcome)
    if (adoptProposal) adoptProposalAtBoundary()
    // The plan is a policy, not a script. If it runs out while the model is
    // still calling tools, extend it with one neutral continuation node instead
    // of ending the turn as if the work were finished. The turn still stops when
    // the model stops calling tools or the per-turn step budget is exhausted.
    if (outcome.ok
      && observed.length > 0
      && topology.done()
      && trail.length < maxSteps) {
      const remaining = Math.max(1, maxSteps - trail.length)
      install(fallbackPlan({
        id: `${plan?.id ?? 'continue'}:continue:${trail.length}`,
        instruction: 'The current plan is exhausted but the task is not necessarily finished. Continue with the next concrete step using the available tools; when the work is complete, stop calling tools.',
        maxSteps: remaining,
      }))
      rationale = [...rationale, 'plan exhausted while the model was still acting: continuation step']
    }
  }

  return {
    async beginTurn(task: TurnTask): Promise<GraphTurnSnapshot> {
      plan = undefined
      decision = undefined
      topology = undefined
      lastNode = undefined
      rationale = []
      envelopeId = undefined
      trail = []
      producedTypes = new Set<ArtifactType>()
      // Per-turn state: a new turn gets its own replan allowance and adoption
      // window. Leaving these to accumulate permanently disables boundary
      // recovery once an early turn exhausts the plan's replan budget.
      replans = 0
      adoptedAtStep = undefined
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

      // A subagent child is always the single-node fallback, even in propose
      // mode: children must not fork their own topology or nested fan-out.
      if (options.forceFallback === true) {
        install(fallbackPlan({ id: fingerprint.hash, instruction: options.fallbackInstruction, maxSteps }))
        rationale = ['child agent: single-node fallback']
        return emit()
      }

      if (mode === 'propose') {
        install(bootstrapTopology(fingerprint.hash, { maxSteps }))
        rationale = ['bootstrap frame: the model authors the topology']
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

      if (mode === 'dynamic' && graph !== undefined && options.composition !== false) {
        try {
          const selected = selectEnvelopeForTask({
            fingerprint,
            graph,
            presetTools: presetToolsOf(graph, task),
            includePresetTools: false,
          })
          if (!selected.fallbackToStock) {
            const composed = synthesizeComposition({
              fingerprint,
              graph,
              envelope: selected.envelope,
              budget: { maxSteps, maxReplans: 2 },
            })
            install(composed.plan)
            envelopeId = selected.envelope.id
            rationale = [
              `envelope ${selected.envelope.id}`,
              ...composed.rationale,
            ]
            return emit()
          }
        } catch {
          // fall through to legacy dynamic synthesis
        }
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
    readonly tools?: readonly { readonly name: string; readonly callId?: string; readonly isError: boolean; readonly arguments?: string; readonly output?: string }[]
  }): Promise<GraphTurnSnapshot> {
      if (topology === undefined) return snapshot()
      const node = topology.current()
      await advanceNode(node, node?.id, outcome, true)
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
      // A batch node superseded by a recovery replan no longer exists in the
      // live topology. Ignore it instead of advancing a node its completion
      // never ran; the remaining batch members settle the same way.
      if (node === undefined) return
      // A batch completion is still a graph boundary: route it through the same
      // trail/advance/replan path as a model step so a failed subagent can
      // trigger recovery instead of silently advancing the topology. A
      // model-authored proposal is not adopted mid-batch; that stays a step
      // boundary decision.
      await advanceNode(node, id, { ok }, false)
      options.onSnapshot?.(snapshot())
    },
    done(): boolean {
      return topology === undefined || topology.done()
    },
    status(): PlanStatus {
      return topology?.status() ?? 'failed'
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
