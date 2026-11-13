/**
 * Graph turn driver: turns one user task into one graph run, with three
 * topology modes:
 *
 *   template  — pick a curated template (bootstrap / A/B control)
 *   dynamic   — synthesize an arbitrary DAG from the live capability graph
 *   propose   — start from a bootstrap frame and let the model author the
 *               topology through `graph_plan`; the harness validates it
 *
 * In every mode the driver exposes `current()/instruction()/advance()/planState()`.
 * A model-authored proposal may replace the live topology between steps.
 */
import { statSync } from 'node:fs'

import type { GraphState, PlanNode, PlanRunState, PlanStatus, RegistryGraph, TaskBudget, TaskPlan } from 'dsh-graph-loop-core/graph-schema'
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
import { selectEnvelopeForTask, type EnvelopeIssue } from 'dsh-graph-loop-core/envelope'
import { KernelTopology, canKernelDrive } from './kernel/topology.ts'
import { deriveCapabilityFacts, deriveEvidenceCalls, deriveStepArtifactCandidates, deriveStepFacts, artifactTypeFor, type ArtifactCandidate } from './step-facts.ts'
import { diffWorld, inDeclaredRoot, observeWorld, type WorldObservation } from './world.ts'
import { ANSWER_TOOL, answerRecordFrom, type ChannelRefusal } from './answer-channel.ts'
import { DEFAULT_SHELL_TOOLS, isAnswerOnlyNode } from './loop/step-tools.ts'
import {
  answerRecordProblem,
  satisfiesNodeEvidence,
  type AnswerProblem,
  type RoutingArtifact,
} from 'dsh-graph-loop-core/condition'
import type { AnswerRecord, ArtifactType, Json, NodeEvidenceContract, ObligationRecord } from 'dsh-graph-loop-core/graph-schema'
import { fallbackPlan } from 'dsh-graph-loop-core/fallback'
import { validateTurnShape } from 'dsh-graph-loop-core/graph-schema'
import type { GraphResumeState } from './graph-state-log.ts'

export type { TopologyMode }

/**
 * Provenance of the plan a turn installed: the `beginTurn` branch that fired.
 * A `dynamic`-mode turn can end on any of several routes, and a live session
 * could previously not tell a composed plan (`compose`) from the legacy
 * synthesizer (`synthesized`) or a stock fallback. The label is decided by
 * which branch installed the plan, never inferred from the plan afterwards.
 */
export type PlanPath =
  | 'child-fallback'
  | 'resume'
  | 'propose'
  | 'triage'
  | 'compose'
  | 'synthesized'
  | 'template'
  | 'fallback'

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
  /**
   * Where the *plan* stands; orthogonal to the turn. `finished` means the plan
   * has no enabled node left but the turn is still open — the next step is a
   * stock DSH step with no graph node. Only `terminal` ends the turn.
   */
  readonly planState: PlanRunState
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
    /** The terminal admission refusal this node's step observed, if any. */
    readonly refusal?: ChannelRefusal
  }[]
  readonly depth?: number
  readonly replans?: number
  /**
   * Node-keyed work-obligation ledger: every node that declared an evidence
   * contract, with the recorded outcome of its own step. Completion consults
   * this record, never terminal reachability, so an abandoned obligation cannot
   * masquerade as satisfied work.
   */
  readonly obligations: readonly ObligationRecord[]
  /**
   * The typed answer record the terminal was admitted on, once one was. Absent
   * while the turn has not answered: the answer is the executed channel call's
   * own text, so nothing can stand in for it.
   */
  readonly answer?: AnswerRecord
  /** Envelope chosen by the live composition path, when it ran. */
  readonly envelopeId?: string
  /**
   * Issues the envelope selector reported for this turn. Empty when the turn
   * never reached the composition branch (triage, resume, propose, template);
   * otherwise every rejection/warning is visible instead of being swallowed by
   * the degrade to the legacy synthesizer.
   */
  readonly envelopeIssues: readonly EnvelopeIssue[]
  /** Provenance of `planId`: which `beginTurn` branch installed the plan. */
  readonly path: PlanPath
}

export interface GraphTurnDriver {
  /**
   * Open the turn's graph. `resume` is the folded state of a run that was still
   * in flight when the previous turn ended: the recorded plan is reused and the
   * first step runs `state.next` instead of a plan re-derived from the new
   * turn's text.
   */
  beginTurn(task: TurnTask, resume?: GraphResumeState): Promise<GraphTurnSnapshot>
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
    /** Session seq of the `step/end` that closed this node's boundary. */
    readonly atSeq?: number
  }): Promise<GraphTurnSnapshot>
  adopt(plan: TaskPlan): void
  /** Detach and return all queued subagent nodes (parallel batch). */
  takeSubagentBatch(): PlanNode[]
  /** Complete one node from a batch, with its outcome. */
  completeNode(id: string, ok: boolean): Promise<void>
  /**
   * Where the plan stands. Never a turn-end predicate: `finished` only changes
   * what the next step is planned from. `terminal` is the plan's endpoint and
   * the turn boundary ends the turn on it.
   */
  planState(): PlanRunState
  /** True when no enabled node is left (`finished` or `terminal`). */
  planFinished(): boolean
  /** True when a declared terminal completed. */
  terminalReached(): boolean
  /**
   * Current run status. `failed` means the graph ended unsuccessfully after
   * recovery/replan had its chance; the loop turns that into a failed turn.
   * Optional for test doubles that only exercise the stepping surface.
   */
  status?(): PlanStatus
  /** Called once by the driver after `turn/end`; flushes the trace. */
  endTurn(): void
  /**
   * Folded graph state at the current boundary, for the durable checkpoint
   * record. Absent for the frontier topology: only the kernel owns a state a
   * later turn can resume.
   */
  stateSnapshot?(): GraphState | undefined
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
  /**
   * Session workspace root for world-first artifact attribution. At every step
   * boundary the driver diffs its own bounded observations of this root and
   * credits files that appeared or changed, whatever tool (a writer tool, a
   * shell, a craft) produced them. Without a root the driver attributes only
   * the candidates a tool call names. Relative refs are measured as before.
   */
  readonly worldRoot?: string
  /** Shell tool names for effect/exit-code classification (defaults to bash/pwsh). */
  readonly shellTools?: readonly string[]
  /** Text length below which a trivial task gets the single-node plan. */
  readonly trivialChars?: number
  /** False for subagent children: no nested fan-out. */
  readonly allowSubagents?: boolean
  /** Force the minimal turn skeleton (used for subagent children). */
  readonly forceFallback?: boolean
  /** Delegation depth (0 for a root agent), included in the trace. */
  readonly depth?: number
  /**
   * Require the typed answer channel at the terminal. Default true: a turn ends
   * only on the record the terminal step produced by executing one
   * `graph_answer` call. A driver harness that exercises routing with no real
   * step sets false; text fidelity is then not claimable, while the obligation
   * ledger rule still holds.
   */
  readonly requireAnswerChannel?: boolean
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
    readonly atSeq?: number
  }): PlanNode | undefined | Promise<PlanNode | undefined>
  planState(): PlanRunState
  status(): 'running' | 'done' | 'failed'
  steps(): number
  snapshot(): TaskPlan
  /** Folded kernel state, when this topology owns one (the kernel does). */
  stateSnapshot?(): GraphState | undefined
  dispose?(): Promise<void> | void
}

/** One graph node outcome as the loop reports it after a step or subagent result. */
interface NodeOutcome {
  readonly ok: boolean
  readonly failedTool?: string
  /** Terminal admission refusal this step observed before dispatch (answer-only node). */
  readonly refusal?: ChannelRefusal
  readonly tools?: readonly { readonly name: string; readonly callId?: string; readonly isError: boolean; readonly arguments?: string; readonly output?: string }[]
  /** Session seq of the `step/end` that closed this node's boundary. */
  readonly atSeq?: number
}

/**
 * Whether a folded log state can resume instead of starting a new plan.
 *
 * The frontier topology has no inspectable state, so a seed that cannot be
 * installed as a `KernelTopology` would silently drop the completed nodes back
 * into the run. The fold already restricts the state to a running run of the
 * same plan version; `kernel: 'off'` is refused at the call site.
 */
function canResumePlan({ plan, state }: GraphResumeState): boolean {
  if (state.planId !== plan.id || state.planVersion !== plan.version) return false
  if (state.status !== 'running' || state.next === null) return false
  if (!plan.nodes.some(node => node.id === state.next)) return false
  return canKernelDrive(plan)
}

/**
 * Create a per-agent driver. State is process-local and scoped to one turn:
 * the session log remains the source of truth for history; the topology only
 * decides which step runs next.
 */
/**
 * Measure one candidate ref in the world at the step boundary. An artifact is
 * a path the runtime can stat as a non-empty file; everything else (a path the
 * tool never created, an empty file, a directory, a declared type with no path)
 * is not an observed artifact and cannot certify a node.
 */
function measureArtifact(candidate: ArtifactCandidate): RoutingArtifact | undefined {
  try {
    const stat = statSync(candidate.ref)
    if (!stat.isFile() || stat.size <= 0) return undefined
    return { type: candidate.type, ref: candidate.ref, bytes: stat.size }
  } catch {
    return undefined
  }
}

/**
 * Union artifact candidate sources, deduped by typed ref. The step's artifact
 * set is the union of what its tool calls address and what the world actually
 * changed; one source may miss what the other saw, and a duplicated ref would
 * only be measured twice.
 */
function mergeCandidates(...sources: readonly (readonly ArtifactCandidate[])[]): ArtifactCandidate[] {
  const seen = new Set<string>()
  const merged: ArtifactCandidate[] = []
  for (const source of sources) {
    for (const candidate of source) {
      const key = `${candidate.type}:${candidate.ref}`
      if (seen.has(key)) continue
      seen.add(key)
      merged.push(candidate)
    }
  }
  return merged
}

/**
 * Raised when a planning branch installs a plan that violates R4 (fewer than two
 * nodes, entry is a terminal, or not exactly one terminal). The branch catches
 * that wrap synthesis, so they rethrow it: a producer regression must fail the
 * turn, not silently degrade to a later branch.
 */
class TurnShapeViolation extends Error {}

/**
 * True when a node's declared contract promises an observable artifact, i.e.
 * the run owes that node's step a product. A verifier-only contract is a
 * routing guard on its stage, not a completion obligation of the turn.
 */
function producesObligation(contract: NodeEvidenceContract | undefined): contract is NodeEvidenceContract {
  return contract !== undefined && (contract.expects ?? []).length > 0
}

/** Template id of the channel-retry recovery shape (see `answerRecoveryPlan`). */
const CHANNEL_RETRY_TEMPLATE = 'answer-channel-retry'

/**
 * One bounded recovery plan for an answer terminal whose answer was refused
 * (audit 20261112-0800 F5, 20261113-0000 F3/F4). The refusal verdict selects
 * the shape:
 *
 * - `channel-refused` — the only open problem is the channel, so the recovery is
 *   a distinct agent step whose `toolAllow` is empty (exactly the answer
 *   channel) followed by a fresh declared terminal. A genuine channel call at
 *   the retry step is the run's answer and ends the turn there; a step that
 *   makes no call falls through to the declared terminal, which may answer.
 * - every other verdict — the owed work, so the recovery re-runs it and returns
 *   to a fresh answer-only terminal; the driver credits that recovery step
 *   against the unmet nodes' own contracts, so a second answer is admissible
 *   only when the work actually got done.
 *
 * Ids follow the R4 grammar (`<kind>.<stage>.<attempt>`), so the recovery runs
 * on the frontier and never resets a kernel plan's state.
 */
function answerRecoveryPlan(input: {
  readonly taskHash: string
  readonly unmet: readonly string[]
  readonly problem: string
  readonly code: AnswerProblem['code']
  readonly toolAllow: readonly string[]
  readonly budget: TaskBudget
}): TaskPlan {
  if (input.code === 'channel-refused') {
    // The retry step is answer-only by the same declaration a terminal uses, so
    // its admission and its directive both come from the one name-set rule.
    const retry: PlanNode = {
      id: 'answer.1.2',
      kind: 'agent-step',
      executor: 'step',
      instruction: `The answer step is blocked (${input.problem}). Answer now through the channel: call the \`${ANSWER_TOOL}\` tool with the answer text. Only \`${ANSWER_TOOL}\` is admitted at this step; any other call is refused before it runs.`,
      toolAllow: [],
    }
    const answer: PlanNode = {
      id: 'answer.1.3',
      kind: 'terminal',
      executor: 'step',
      instruction: 'Answer the task from the evidence that now exists. Do not start new work.',
      toolAllow: [],
    }
    return {
      id: `recover:${input.taskHash}`,
      templateId: CHANNEL_RETRY_TEMPLATE,
      version: 1,
      entry: retry.id,
      terminals: [answer.id],
      nodes: [retry, answer],
      edges: [{ from: retry.id, to: answer.id, kind: 'control' }],
      // Two steps at most: one channel retry, one fall-through answer. The
      // driver's install() further clamps it to the steps the turn has left.
      budget: { ...input.budget, maxSteps: Math.min(2, input.budget.maxSteps), maxReplans: 0 },
      toolUniverse: [ANSWER_TOOL],
      gatePolicy: 'cold',
      fallback: true,
      confidence: 0,
      compiledDigest: `recover:${input.taskHash}:channel-refused`,
    }
  }
  const work = input.unmet.length === 0
    ? `Answer the task by calling the \`${ANSWER_TOOL}\` tool with the answer text. Printed tool-call syntax is not an answer.`
    : `Do the required work at ${input.unmet.join(', ')} now using the available tools; a fresh answer step follows. Do not describe work you are not doing.`
  const recover: PlanNode = {
    id: 'recover.1.1',
    kind: 'agent-step',
    executor: 'step',
    instruction: `The answer step is blocked (${input.problem}). ${work}`,
  }
  const answer: PlanNode = {
    id: 'answer.1.2',
    kind: 'terminal',
    executor: 'step',
    instruction: 'Answer the task from the evidence that now exists. Do not start new work.',
    toolAllow: [],
  }
  return {
    id: `recover:${input.taskHash}`,
    templateId: 'answer-recovery',
    version: 1,
    entry: recover.id,
    terminals: [answer.id],
    nodes: [recover, answer],
    edges: [{ from: recover.id, to: answer.id, kind: 'control' }],
    // Two steps at most: one work retry, one answer. The driver's install()
    // further clamps it to the steps the turn has left.
    budget: { ...input.budget, maxSteps: Math.min(2, input.budget.maxSteps), maxReplans: 0 },
    toolUniverse: [...input.toolAllow],
    gatePolicy: 'cold',
    fallback: true,
    confidence: 0,
    compiledDigest: `recover:${input.taskHash}:${input.unmet.join(',')}`,
  }
}

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
  const shellTools = new Set(options.shellTools ?? DEFAULT_SHELL_TOOLS)
  const trivialChars = options.trivialChars ?? 32
  const worldRoot = options.worldRoot
  const liveGraph = async (): Promise<RegistryGraph | undefined> => await options.graphProvider?.() ?? currentGraph
  const liveTemplates = (): TemplateLibrary | undefined => options.templatesProvider?.() ?? currentTemplates

  let plan: TaskPlan | undefined
  let decision: RouteDecision | undefined
  let topology: TurnTopology | undefined
  let lastNode: string | undefined
  let rationale: readonly string[] = []
  let envelopeId: string | undefined
  /** Envelope issues from the composition attempt; empty until one runs. */
  let envelopeIssues: readonly EnvelopeIssue[] = []
  /** Which branch installed the current plan (provenance of `planId`). */
  let planPath: PlanPath = 'fallback'
  /**
   * Reasons earlier planning branches declined this turn, in order. They are
   * prepended to the rationale of the branch that does install the plan, so a
   * degrade (capacity, throw, empty envelope) is observable in the snapshot and
   * in the per-session run record instead of vanishing into a `catch {}`.
   */
  let pathReasons: string[] = []
  /**
   * Artifact types this run has ever produced, used to reset the step-scoped
   * `produced.<type>` facts on every step. Without the reset a guard such as the
   * author's `produced.file.image == false` could be satisfied by an artifact
   * from an earlier stage.
   */
  let producedTypes = new Set<ArtifactType>()
  /**
   * Artifact refs earlier steps of this turn produced. A verifier's evidence is
   * the artifact it observed, so the refs must belong to an earlier step, not to
   * the verifying step's own call.
   */
  let producedRefs: RoutingArtifact[] = []
  /**
   * Last bounded observation of the session workspace, taken at the previous
   * step boundary. The step's world-observed artifacts are the diff against it.
   * `undefined` until the first plan is installed (or the first boundary, for a
   * driver that never calls `beginTurn`), and when no world root is configured.
   */
  let worldBefore: WorldObservation | undefined
  /**
   * Node-keyed work obligations recorded this turn (audit 20261112-0800 F1-F6).
   * A node that declared an evidence contract and is not advisory owes the run
   * that evidence; the record holds the evaluation of the node's own step, so
   * "ran" is never confused with "satisfied". The answer terminal consults this
   * ledger, not terminal reachability.
   */
  let obligations = new Map<string, ObligationRecord>()
  /**
   * Recovery node id → the unmet obligations it is allowed to discharge. A
   * bounded recovery step is credited against the original node's own contract;
   * it cannot mint a new obligation, and it cannot satisfy one by declaring a
   * different one.
   */
  let recoveryTargets = new Map<string, readonly ObligationRecord[]>()
  /** True once the turn spent its one bounded answer recovery. */
  let answerRecoveryUsed = false
  /** True when an answer terminal tried to complete with required work unmet. */
  let answerBlocked = false
  /** The typed answer record the current turn's terminal was admitted on. */
  let acceptedAnswer: AnswerRecord | undefined
  /**
   * True between `beginTurn` and `endTurn`: the driver is driving a *turn*.
   * Engine-level branch drills install a plan with `adopt()` and never open a
   * turn; their plan-routing assertions stay ungated (audit 20261112-0800
   * "adopt() and engine-level branch drills stay ungated"). A turn's completion
   * rule is not a plan-routing property.
   */
  let turnActive = false

  /**
   * Artifact candidates the step's *effects* explain: paths that appeared or
   * changed in the session workspace between the previous boundary's observation
   * and this one. The first boundary of a driver that never established a
   * baseline only records it. An incomplete observation (a capped walk) credits
   * nothing, because it cannot tell "unchanged" from "unobserved".
   *
   * `roots` is the current node's declared evidence scope: when it declares
   * roots, only changes inside them are candidates; without a declaration the
   * whole world root is credited (the documented fallback). This filter applies
   * to the ambient world channel only -- a ref a tool call addresses in a typed
   * argument is measured for its own step regardless of place.
   */
  function worldCandidates(roots?: readonly string[]): ArtifactCandidate[] {
    const root = worldRoot
    if (root === undefined) return []
    const after = observeWorld(root)
    const changes = diffWorld(worldBefore, after)
    worldBefore = after
    if (changes === undefined) return []
    const admitted = roots === undefined ? changes : changes.filter(change => inDeclaredRoot(root, roots, change.path))
    return admitted.map(change => ({ type: artifactTypeFor(change.path), ref: change.path }))
  }
  /** Executed node ids in run order; the snapshot's `visited` must describe the run, not the plan. */
  let visited: string[] = []
  /** Tool names this turn has seen, so a later step can reset their step-scoped facts. */
  const knownToolNames = new Set<string>()
  /** Serializes batch completions: `completeNode` selects shared topology state across an await. */
  let completeQueue: Promise<unknown> = Promise.resolve()

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
      planState: currentPlanState(),
      status: topology?.status() ?? 'failed',
      visited: [...visited],
      rationale,
      trail: [...trail],
      replans,
      depth: options.depth ?? 0,
      obligations: [...obligations.values()].sort((left, right) => left.step - right.step),
      ...(acceptedAnswer === undefined ? {} : { answer: acceptedAnswer }),
      ...(envelopeId === undefined ? {} : { envelopeId }),
      envelopeIssues,
      path: planPath,
    }
  }

  /** Rationale for the installed plan, with any earlier branch decline in front. */
  function rationaleWith(lines: readonly string[]): string[] {
    return [...pathReasons, ...lines]
  }

  /** Plan state at the current boundary; no plan means no plan work left. */
  function currentPlanState(): PlanRunState {
    // A terminal that reached its answer endpoint with a required obligation
    // still unmet is not a completion. It stays blocked until the bounded
    // recovery resolves the debt or settles the run as failed; the turn then
    // ends honestly (the loop turns `failed` into a structured error).
    if (answerBlocked) return 'failed'
    // The channel-retry step is not a declared terminal, but an admitted answer
    // executed there is the turn's endpoint: report it so the turn ends exactly
    // once on the record and never spends a step on a node nobody asked for.
    if (acceptedAnswer !== undefined) return 'terminal'
    return topology?.planState() ?? 'finished'
  }

  function emit(): GraphTurnSnapshot {
    const snap = snapshot()
    options.onSnapshot?.(snap)
    return snap
  }

  function install(next: TaskPlan, resume?: GraphState, gate?: 'turn'): void {
    adoptedAtStep = undefined
    // R4 gate: every plan a turn plans for itself is a multi-node graph with a
    // distinct, single terminal. `adopt()` and runtime recovery installs skip it
    // (engine-level branch drills author their own plans).
    if (gate === 'turn') {
      const shape = validateTurnShape(next)
      if (!shape.ok) {
        throw new TurnShapeViolation(
          `turn plan violates R4: ${shape.errors.map(error => `${error.code} ${error.path}: ${error.message}`).join('; ')}`,
        )
      }
    }
    // A caller that installs a plan without `beginTurn` (a harness adopting a
    // plan directly) still gets a baseline: the first work step is diffed from
    // the world as it was when the plan was installed, not from an empty world.
    if (worldBefore === undefined && worldRoot !== undefined) worldBefore = observeWorld(worldRoot)
    // `maxSteps` is a per-turn cap, not a per-plan one. A replan/recovery plan or
    // a model-authored proposal that arrives after N steps must not reset the
    // allowance and run another full budget; clamp the installed plan to the
    // steps this turn has left. (Each plan still owns its own earlier cap.)
    const remaining = Math.max(1, maxSteps - trail.length)
    const bounded = next.budget.maxSteps <= remaining
      ? next
      : { ...next, budget: { ...next.budget, maxSteps: remaining } }
    plan = bounded
    const kernelMode = options.kernel ?? 'langgraph'
    try {
      // `KernelTopology` owns its step-budget reserve for a budget-routed
      // wrap-up node, so the driver does not special-case the plan budget.
      topology = kernelMode !== 'off' && canKernelDrive(bounded)
        ? new KernelTopology(bounded, {
            kind: kernelMode,
            taskHash: bounded.id,
            ...(resume === undefined ? {} : { state: resume }),
          })
        : new FrontierTopology(bounded)
    } catch {
      topology = new FrontierTopology(bounded)
    }
    lastNode = topology.current()?.id
  }

  /** Append one executed node to the run trail. */
  function recordTrail(id: string, executor: string | undefined, outcome: NodeOutcome): void {
    visited.push(id)
    trail.push({
      id,
      step: (topology?.steps() ?? 0) + 1,
      executor: executor ?? 'step',
      status: outcome.ok ? 'ok' : 'failed',
      ...(outcome.tools === undefined || outcome.tools.length === 0 ? {} : { tools: outcome.tools }),
      ...(outcome.refusal === undefined ? {} : { refusal: outcome.refusal }),
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
    // No room left in the turn: installing a recovery plan with a forced
    // one-step budget ran past `maxSteps`. Leave the run failed; the turn
    // reports GRAPH_FAILED instead of spending another step.
    if (trail.length >= maxSteps) return
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
    if (trail.length >= maxSteps) {
      rationale = [...rationale, 'proposal ignored: no step budget left']
      return
    }
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
   * The answer boundary gate (audit 20261112-0800 F1-F6; 20261112-1200 F1-F4).
   *
   * A declared terminal is where the turn wants to end, but it may end only on
   * an admissible {@link AnswerRecord} the terminal step *executed*: exactly one
   * successful `graph_answer` call whose `text` argument is the answer, no other
   * real tool calls, and an evidence ref for every obligation the run recorded.
   * Assistant text is display only, so a step that merely printed a tool call
   * has no record and cannot answer. Terminal reachability is not completion;
   * the node-keyed ledger decides.
   *
   * A refusal spends the turn's one bounded recovery step. The verdict selects
   * its shape (see `answerRecoveryPlan`): a channel refusal retries the channel
   * at an answer-only agent step, while an unmet-work verdict retries the work.
   * A second refusal settles the run blocked, which the loop reports as a
   * structured failure — never a completed turn.
   *
   * The gate also judges the channel-retry step itself. It is not a declared
   * terminal, so terminal reachability cannot be its trigger: the run node is
   * the trigger, and an admissible channel call there is the answer. A retry
   * step that makes no call is not a record — the declared terminal after it
   * asks once more.
   * @param outcome - the just-closed step's observed outcome.
   * @param runNodeId - the plan node that step executed.
   */
  function settleAnswerBoundary(outcome: NodeOutcome, runNodeId: string | undefined): void {
    if (!turnActive) return
    if (topology === undefined || plan === undefined) return
    const answeringRetry = plan.templateId === CHANNEL_RETRY_TEMPLATE
      && runNodeId !== undefined
      && runNodeId === plan.entry
    if (!answeringRetry && topology.planState() !== 'terminal') return
    const recorded = [...obligations.values()].sort((left, right) => left.step - right.step)
    const evidenceRefs = recorded.filter(entry => entry.satisfied).map(entry => entry.nodeId)
    const typed = options.requireAnswerChannel !== false
    // A routing harness that never ran a real step cannot execute the channel;
    // it keeps the ledger rule with text fidelity unclaimed (never a text read).
    const answer = typed
      ? answerRecordFrom(outcome.tools, evidenceRefs)
      : { text: '', evidenceRefs, toolCalls: outcome.tools?.length ?? 0 }
    // A refusal is authoritative over any record: the step called a tool its
    // answer-only node does not admit, so it cannot complete even if the ledger
    // is met.
    const problem = outcome.refusal === undefined
      ? answerRecordProblem(answer, recorded, typed)
      : {
        code: 'channel-refused' as const,
        detail: `channel-refused: the answer step refused \`${outcome.refusal.tool}\`; only \`${ANSWER_TOOL}\` is admitted`,
      }
    if (problem === undefined) {
      acceptedAnswer = answer
      return
    }
    if (answeringRetry) {
      // The one bounded recovery is already spent on this retry: it is the
      // last attempt. No call at all is not a record — the declared terminal
      // after it may answer once. Any real call that is not an admitted answer
      // settles the run blocked instead of retrying the channel again.
      if (outcome.refusal === undefined && (outcome.tools?.length ?? 0) === 0) return
      answerBlocked = true
      rationale = [...rationale, `answer retry blocked (${problem.code}): ${problem.detail}`]
      return
    }
    if (!answerRecoveryUsed && trail.length + 2 <= maxSteps && topology.status() !== 'failed') {
      answerRecoveryUsed = true
      const unmet = recorded.filter(entry => !entry.satisfied)
      recoveryTargets = new Map()
      // Only the work-retry plan credits a recovery step against the ledger.
      if (unmet.length > 0 && problem.code !== 'channel-refused') recoveryTargets.set('recover.1.1', unmet)
      const next = answerRecoveryPlan({
        taskHash: plan.id,
        unmet: unmet.map(entry => entry.nodeId),
        problem: problem.detail,
        code: problem.code,
        toolAllow: plan.toolUniverse,
        budget: plan.budget,
      })
      install(next)
      rationale = [...rationale, `answer blocked (${problem.code}): one bounded recovery step`]
      return
    }
    // The bounded recovery is spent (or cannot fit). The plan did not answer:
    // settle blocked so the turn ends with a structured failure, not success.
    answerBlocked = true
    rationale = [...rationale, `answer blocked (${problem.code}): ${problem.detail}`]
  }

  /**
   * Record one node outcome, advance the topology, then run boundary recovery.
   * `record` is absent when `advance()` has no current node: the run still
   * settles its boundary, without inventing a trail row.
   */
  async function advanceNode(
    record: {
      readonly id: string
      readonly executor?: string
      readonly capabilityId?: string
      readonly evidence?: PlanNode['evidence']
      readonly optional?: boolean
    } | undefined,
    lastNodeId: string | undefined,
    outcome: NodeOutcome,
    adoptProposal: boolean,
  ): Promise<void> {
    if (topology === undefined) return
    // The boundary's world observation is taken first, before any await: it
    // must describe the workspace the step left behind, not one the harness
    // touched while resolving the graph.
    const worldObserved = worldCandidates(record?.evidence?.roots)
    if (record !== undefined) recordTrail(record.id, record.executor, outcome)
    lastNode = lastNodeId ?? lastNode
    const observed = outcome.tools ?? []
    const facts = deriveStepFacts(observed, outcome.ok, outcome.failedTool, shellTools, outcome.refusal !== undefined)
    // Tool facts are step-scoped: a tool that failed in an earlier step must not
    // leave `tool.<name>.failed=true` (or a stale `.ok`) for a later step that
    // never called it. Reset every name this turn has seen, then let this step's
    // values win.
    for (const name of knownToolNames) {
      if (observed.some(tool => tool.name === name)) continue
      facts[`tool.${name}.ok`] = false
      facts[`tool.${name}.failed`] = false
    }
    for (const tool of observed) knownToolNames.add(tool.name)
    const graph = await liveGraph()
    const capability = record?.capabilityId === undefined
      ? undefined
      : graph?.nodes.find(node => node.id === record.capabilityId)
    // A reader declares its *output* (`produces: file.text`), but a read cannot
    // author an artifact. Never credit a read-only capability's declared types to
    // an author stage; the composer also refuses to bind an author to one.
    const declaredTypes = capability?.tool?.permission === 'read-only'
      ? []
      : capability?.produces.map(spec => spec.type) ?? []
    // Every candidate ref is measured in the world at the step boundary: only a
    // path that exists with content is an artifact. A tool's success, a path
    // argument the tool never created, and a declared type with no path are not
    // evidence of a change. The candidate set is the union of the refs this
    // step's tool calls address and the files its *effects* changed in the
    // session workspace; a shell write names no artifact in any typed field but
    // still changed the world, which is the only thing that counts here.
    const artifacts = mergeCandidates(
      deriveStepArtifactCandidates(observed, capability),
      worldObserved,
    )
      .map(measureArtifact)
      .filter((artifact): artifact is RoutingArtifact => artifact !== undefined)
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
    // The node's own declared evidence contract, evaluated against this step's
    // attributed artifacts and calls (F1-F4). It is written on every step so a
    // composed success edge (`evidence.ok == true`) and its failure exit
    // (`evidence.ok == false`) are both decidable; an undeclared node is false,
    // because a node that declared no evidence cannot certify success.
    // Node-scoped evidence is measured, not declared: `produced` is exactly the
    // refs this step left in the world, and `prior` is re-measured *after* this
    // step's call so a verifier that deleted the artifact (a shell `rm`) cannot
    // pass. A declared type with no observable ref certifies nothing.
    const declaredTool = capability?.tool?.name
    const priorObserved = producedRefs
      .map(artifact => measureArtifact(artifact))
      .filter((artifact): artifact is RoutingArtifact => artifact !== undefined)
    const view = {
      produced: artifacts,
      prior: priorObserved,
      calls: deriveEvidenceCalls(observed, shellTools, capability?.tool?.parameterNames ?? []),
      ...(declaredTool === undefined ? {} : { capabilityTool: declaredTool }),
    }
    // The node's own declared contract decides whether its step satisfied the
    // work it owed. The outcome is node-keyed and kept for the whole turn: a
    // plan that routes past an unsatisfied node leaves a recorded debt instead
    // of a `visited` entry that later looks like success.
    let evidenceOk = satisfiesNodeEvidence(record?.evidence, view)
    // A bounded recovery step is credited against the obligations it was
    // installed for, each evaluated with its *original* contract: it can
    // discharge the debt, but it cannot substitute a cheaper one.
    const recovered = record === undefined ? undefined : recoveryTargets.get(record.id)
    if (recovered !== undefined && recovered.length > 0) {
      for (const target of recovered) {
        if ((obligations.get(target.nodeId)?.satisfied ?? target.satisfied)) continue
        if (!satisfiesNodeEvidence(target.contract, view)) continue
        obligations.set(target.nodeId, {
          ...target,
          satisfied: true,
          step: trail.length,
          ...(record === undefined ? {} : { satisfiedBy: record.id }),
        })
      }
      evidenceOk = recovered.every(target => obligations.get(target.nodeId)?.satisfied === true)
    }
    facts['evidence.ok'] = evidenceOk
    // Only an artifact-production contract is a *completion* obligation: the
    // node promised an observable artifact and the run owes it. A verifier-only
    // contract stays a routing guard on its own stage (backlog #4), so this
    // cycle does not change the verify/repair endpoint semantics.
    if (record !== undefined && producesObligation(record.evidence) && record.optional !== true) {
      obligations.set(record.id, {
        nodeId: record.id,
        satisfied: evidenceOk,
        step: trail.length,
        contract: record.evidence,
      })
    }
    // Older steps' refs become `prior` for the next step; the current step's own
    // refs must not certify its own verification.
    producedRefs = [...producedRefs, ...artifacts]
    await Promise.resolve(topology.advance({
      ok: outcome.ok,
      ...(outcome.failedTool === undefined ? {} : { failedTool: outcome.failedTool }),
      facts,
      ...(artifacts.length === 0 ? {} : { artifacts }),
      ...(outcome.atSeq === undefined ? {} : { atSeq: outcome.atSeq }),
    }))
    await recoverAfterFailure(outcome)
    if (adoptProposal) adoptProposalAtBoundary()
    // The terminal boundary is gated last: after the node-keyed ledger and any
    // runtime recovery have settled, the run may end only on an admissible
    // answer record. A refusal replaces the endpoint with the one bounded
    // recovery plan; a second refusal marks the run blocked (see
    // `settleAnswerBoundary`). The executed node is the gate's trigger at the
    // channel-retry step, which is an agent step, not a declared terminal.
    settleAnswerBoundary(outcome, record?.id)
    // No continuation plan is installed here. A plan that drains while the
    // model is still acting settles `finished`; the turn boundary keeps the
    // turn open and runs the next step with no graph node. The turn ends on a
    // turn-level condition (terminal, a final step with no tool calls, failure,
    // abort), never because a plan ran out of nodes.
  }

  return {
    async beginTurn(task: TurnTask, resume?: GraphResumeState): Promise<GraphTurnSnapshot> {
      // The turn opens here: its terminal will be held to the answer rule.
      turnActive = true
      // The turn's world baseline, taken before any branch returns (child
      // fallback, resume, propose, triage): the first step of every plan path is
      // diffed from the workspace as this turn found it.
      worldBefore = worldRoot === undefined ? undefined : observeWorld(worldRoot)
      plan = undefined
      decision = undefined
      topology = undefined
      lastNode = undefined
      rationale = []
      envelopeId = undefined
      envelopeIssues = []
      planPath = 'fallback'
      pathReasons = []
      trail = []
      producedTypes = new Set<ArtifactType>()
      producedRefs = []
      visited = []
      knownToolNames.clear()
      obligations = new Map()
      recoveryTargets = new Map()
      answerRecoveryUsed = false
      answerBlocked = false
      acceptedAnswer = undefined
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

      // A subagent child is always the minimal turn skeleton, even in propose
      // mode: children must not fork their own topology or nested fan-out.
      if (options.forceFallback === true) {
        install(fallbackPlan({ id: fingerprint.hash, instruction: options.fallbackInstruction, maxSteps }), undefined, 'turn')
        planPath = 'child-fallback'
        rationale = ['child agent: multi-node turn skeleton fallback']
        return emit()
      }

      // A turn that starts from a folded graph state continues the paused plan.
      // Re-deriving a plan from the new turn's text replaced the paused graph
      // with a fresh one (the continuation text matched `t_stock`), so the seed
      // carries both the plan identity and the node the next step must run.
      // The log fold only offers a `running` state; a completed or failed run
      // falls through and starts a new plan.
      if (resume !== undefined && (options.kernel ?? 'langgraph') !== 'off' && canResumePlan(resume)) {
        // The folded state carries the obligation ledger the paused run left
        // behind; re-deriving it from an empty map would let a resumed answer
        // terminal complete on work the previous segment never evidenced.
        for (const record of resume.state.obligations ?? []) obligations.set(record.nodeId, record)
        install(resume.plan, resume.state)
        planPath = 'resume'
        rationale = [`resume ${resume.plan.id} at ${String(resume.state.next)}`]
        return emit()
      }

      if (mode === 'propose') {
        install(bootstrapTopology(fingerprint.hash, { maxSteps }), undefined, 'turn')
        planPath = 'propose'
        rationale = ['bootstrap frame: the model authors the topology']
        return emit()
      }

      // Triage: a trivial task does not deserve a synthesized graph. The
      // minimal skeleton keeps short chats at two steps instead of paying plan
      // synthesis overhead, while still giving the turn a real answer node.
      const trivial = task.text.trim().length > 0 && task.text.trim().length < trivialChars
        && fingerprint.intent === 'other'
        && !fingerprint.mutating
        && fingerprint.artifactsIn.length === 0
        && fingerprint.artifactsOut.length === 0
      if (mode !== 'template' && trivial) {
        install(fallbackPlan({ id: fingerprint.hash, instruction: options.fallbackInstruction, maxSteps }), undefined, 'turn')
        planPath = 'triage'
        rationale = ['triage: trivial task, minimal turn skeleton']
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
          // The envelope issues are the observable record of this decision: the
          // baseline admission and any rejection are kept even when the branch
          // degrades, so a `dyn:*` plan can explain itself afterwards.
          envelopeIssues = selected.issues
          if (!selected.fallbackToStock) {
            const composed = synthesizeComposition({
              fingerprint,
              graph,
              envelope: selected.envelope,
              budget: { maxSteps, maxReplans: 2 },
            })
            install(composed.plan, undefined, 'turn')
            envelopeId = selected.envelope.id
            planPath = 'compose'
            rationale = [
              `envelope ${selected.envelope.id}`,
              ...composed.rationale,
            ]
            return emit()
          }
          const rejection = selected.issues.find(issue => issue.severity === 'error')
          pathReasons.push(`envelope rejected: ${rejection?.code ?? 'envelope-not-usable'}`)
        } catch (error: unknown) {
          if (error instanceof TurnShapeViolation) throw error
          pathReasons.push(`envelope failed: ${error instanceof Error ? error.message : String(error)}`)
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
          install(synthesized.plan, undefined, 'turn')
          planPath = 'synthesized'
          rationale = rationaleWith(synthesized.rationale)
          return emit()
        } catch (error: unknown) {
          if (error instanceof TurnShapeViolation) throw error
          pathReasons.push(`dynamic synthesis failed: ${error instanceof Error ? error.message : String(error)}`)
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
          install(result.plan, undefined, 'turn')
          planPath = 'template'
          rationale = rationaleWith([result.decision.fallback ? 'template fallback' : `template ${result.decision.templateId}`])
          return emit()
        } catch (error: unknown) {
          if (error instanceof TurnShapeViolation) throw error
          plan = undefined
          pathReasons.push(`template match failed: ${error instanceof Error ? error.message : String(error)}`)
        }
      }
      install(fallbackPlan({ id: fingerprint.hash, instruction: options.fallbackInstruction, maxSteps }), undefined, 'turn')
      planPath = 'fallback'
      rationale = rationaleWith(['multi-node fallback skeleton'])
      return emit()
    },
    current(): PlanNode | undefined {
      return topology?.current()
    },
    instruction(): string | undefined {
      const node = topology?.current()
      if (node === undefined || !isAnswerOnlyNode(node)) return node?.instruction
      // One home with `admitStepTools`: a node whose admission is exactly the
      // channel is told so, at any node kind, so the directive cannot drift
      // from the set dispatch enforces.
      const instruction = node.instruction ?? 'Answer the task.'
      return `${instruction} Submit the turn's answer by calling the \`${ANSWER_TOOL}\` tool with the answer text; printed tool-call syntax is not an answer.`
    },
    toolUniverse(): readonly string[] | undefined {
      if ((options.toolPolicy ?? 'plan') === 'preset') return undefined
      return topology?.snapshot().toolUniverse ?? plan?.toolUniverse
    },
    async advance(outcome: {
    readonly ok: boolean
    readonly failedTool?: string
    /** Terminal admission refusal this step observed before dispatch. */
    readonly refusal?: ChannelRefusal
    readonly tools?: readonly { readonly name: string; readonly callId?: string; readonly isError: boolean; readonly arguments?: string; readonly output?: string }[]
    /** Session seq of the `step/end` that closed this node's boundary. */
    readonly atSeq?: number
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
    completeNode(id: string, ok: boolean): Promise<void> {
      const run = async (): Promise<void> => {
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
      }
      // `completeNode` selects `currentId`, then awaits `liveGraph()` before
      // `topology.advance()`. Two concurrent completions (the agent's
      // `Promise.all` over a subagent batch) would interleave and advance the
      // wrong node — including marking the terminal complete without running it.
      // Serialize completions for this turn.
      const result = completeQueue.then(run, run)
      completeQueue = result.then(() => undefined, () => undefined)
      return result
    },
    planState(): PlanRunState {
      return currentPlanState()
    },
    planFinished(): boolean {
      return currentPlanState() !== 'running'
    },
    terminalReached(): boolean {
      return !answerBlocked && currentPlanState() === 'terminal'
    },
    status(): PlanStatus {
      if (answerBlocked) return 'failed'
      return topology?.status() ?? 'failed'
    },
    stateSnapshot(): GraphState | undefined {
      const state = topology?.stateSnapshot?.()
      if (state === undefined) return undefined
      // The ledger travels with the durable checkpoint so a resumed turn cannot
      // mistake an abandoned obligation for satisfied work.
      return { ...state, obligations: [...obligations.values()].sort((left, right) => left.step - right.step) }
    },
    endTurn(): void {
      const finishing = topology
      const finalSnapshot = snapshot()
      topology = undefined
      turnActive = false
      void finishing?.dispose?.()
      options.onTurnEnd?.(finalSnapshot)
    },
    snapshot,
  }
}
