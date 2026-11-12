/**
 * graph-schema.ts — the graph model for the DSH graph-native `explore` loop.
 *
 * One diagram, two uses:
 *
 * Layer 1 (RegistryGraph): the capability universe built from live DSH registries at
 * plugin init and kept live through `tools/change`, `system-prompt/change`,
 * `skills/change`, preset revisions and plugin rows. Nodes are *capabilities*
 * (tool / skill / subagent provider / preset / agent role / plugin), edges are typed
 * relations. It is the candidate universe the matcher searches; it is never executed.
 *
 * Layer 2 (TaskPlan): the executable sub-graph. The same plan document is
 * compiled by the kernel adapter into an executable graph that the driver runs
 * instead of the stock agent-loop, and it is the shape the composer, templates
 * and `graph_plan` proposals all validate against.
 * A node is one unit of work: one DSH step (executor `step`) or one child activation
 * (executor `subagent`). A graph run spans one turn; DSH closes an interrupted turn
 * on restore, and the in-memory checkpointer is only for in-run time travel.
 *
 * Everything here is dependency-free so it can live in an out-of-tree bundle
 * (no DSH source change) and be validated by the plugin's unit tests. The kernel
 * binding lives in `packages/loop/src/kernel/`; this file never imports LangGraph.
 *
 * Evidence for the facts encoded below (paths in the DSH checkout):
 * - docs/tool-catalog.md — real model-facing tool names and parameter schemas.
 * - packages/core/tools/README.md — `register(def,{when})`, `resolve()`, `restrict()`.
 * - packages/core/system-prompt/README.md — dynamic `text({scope, toolSet})` sections.
 * - packages/skill/skill/README.md — `ctx.skills` catalog + invocation policy.
 * - packages/subagent/subagent/README.md — `ctx.subagents.startActivation({...})`.
 * - packages/preset/agent-preset-registry/README.md — presets are composition rows.
 * - packages/core/agent-loop/src/agent.ts — resolve -> assemble -> pre-step order.
 * - packages/core/session/src/index.ts — `session/event` listeners run synchronously
 *   inside `append`, and `append` re-entry inside one is forbidden.
 */

// ---------------------------------------------------------------------------
// Identifiers and vocabularies
// ---------------------------------------------------------------------------

/** Stable id of a capability node inside one registry snapshot. */
export type NodeId = string
/** Stable id of an edge inside one registry snapshot. */
export type EdgeId = string
/** Monotonic registry snapshot version, bumped on every accepted change event. */
export type RegistryVersion = number

/** A capability that can appear as a graph node at init time. */
export type CapabilityKind =
  | 'tool'
  | 'skill'
  | 'subagent-provider'
  | 'preset'
  | 'agent-role'
  | 'plugin'
  | 'surface'

/** Executor that will run a tool call. Mirrors `ctx.tools` executor selection. */
export type ExecutorKind = 'native' | 'ptc'

/** Permission class derived from a tool's declared side effects, not from prose. */
export type PermissionClass = 'read-only' | 'mutating' | 'network' | 'privileged'

/**
 * Artifact vocabulary. Curated and closed on purpose: an open vocabulary makes
 * artifact matching (the strongest routing signal) impossible to calibrate.
 * Deployments may extend it, but every extension is a reviewed schema change.
 */
export const ARTIFACT_TYPES = [
  'file.text',
  'file.image',
  'file.binary',
  'file.patch',
  'path.locator',
  'path.list',
  'search.hits',
  'shell.output',
  'test.result',
  'web.page',
  'web.snippet',
  'plan',
  'question.answer',
  'child.report',
  'context.injected',
] as const
export type ArtifactType = (typeof ARTIFACT_TYPES)[number]

export interface ArtifactSpec {
  readonly type: ArtifactType
  /** False when the artifact only improves the node, true when the node needs it. */
  readonly required: boolean
  /** Free-form contract hint the node validator can enforce (e.g. "json:test-report"). */
  readonly contract?: string
}

/** A typed edge relation. Weights are probabilities/strengths in [0, 1]. */
export type EdgeKind =
  /** Plan-level only: ordinary sequencing. */
  | 'control'
  /** Plan-level only: artifact hand-off. */
  | 'data'
  /** Capability-level: `to` cannot run before `from` produced its artifact. */
  | 'requires'
  /** Capability-level: `from` outputs an artifact `to` consumes. */
  | 'produces'
  /** Alternative capabilities for the same slot (bash/pwsh, edit/write). */
  | 'substitutes'
  /** Weak resemblance; only ever a tiebreaker, never a routing reason. */
  | 'similar'
  /** Mutually exclusive at runtime (PTC vs native, platform, sandbox mode). */
  | 'conflicts'
  /** Permission/approval gate that must be satisfied to use `to`. */
  | 'permission'
  /** Cost relation: `to` is a cheaper alternative for the same artifact. */
  | 'budget'

/** Where an edge weight came from. `declared` > `measured` > `schema` > `mined` > `embedding`. */
export type EdgeProvenance = 'declared' | 'schema-derived' | 'mined' | 'measured' | 'embedding'

export interface EdgeEvidence {
  /** Number of observed sessions behind a mined edge (0 for declared edges). */
  readonly observations?: number
  /** NPMI or conditional probability that produced the weight. */
  readonly statistic?: number
  /** Human-readable justification shown by `graph_status` and in the bench report. */
  readonly note?: string
}

export interface GraphEdge {
  readonly id: EdgeId
  readonly from: NodeId
  readonly to: NodeId
  readonly kind: EdgeKind
  readonly weight: number
  readonly provenance: EdgeProvenance
  readonly evidence?: EdgeEvidence
  /** True when the same relation holds in both directions (similar/substitutes/conflicts). */
  readonly symmetric?: boolean
}

// ---------------------------------------------------------------------------
// Layer 1 — registry graph
// ---------------------------------------------------------------------------

export interface CostPrior {
  /** Measured median model-visible tokens this capability adds per request (schema) or per call (result). */
  readonly tokensPerRequest?: number
  readonly tokensPerCall?: number
  readonly p50LatencyMs?: number
  /** Failure rate observed from `tool/result` isError flags, 0..1. */
  readonly failureRate?: number
  /** 0..1, higher = riskier; derives from PermissionClass plus blast radius. */
  readonly risk: number
}

export interface ToolFacts {
  /** Exact model-facing name from docs/tool-catalog.md (read, write, edit, bash, glob, grep, ...). */
  readonly name: string
  /** Package that registers it, e.g. @deepseek-ai/dsh-tool-fs. */
  readonly packageName: string
  readonly executor: ExecutorKind
  readonly permission: PermissionClass
  readonly idempotent: boolean
  /** Normalized parameter names; used for schema overlap, never for text search. */
  readonly parameterNames: readonly string[]
  readonly accepts: readonly ArtifactSpec[]
  readonly produces: readonly ArtifactSpec[]
  /** True when the registration is conditional (`register(def,{when})`) and may vanish per step. */
  readonly conditional: boolean
  /** True when the tool only exists after a runtime event (MCP connect, browser start, ...). */
  readonly dynamic: boolean
  /** Measured model-facing schema size, tokens (data table in `registry.ts`). */
  readonly schemaTokens: number
}

export interface SkillFacts {
  readonly name: string
  readonly provider: string
  /** modelInvocable / userInvocable from the invocation policy. */
  readonly modelInvocable: boolean
  readonly userInvocable: boolean
  /** Artifact types the skill's instructions typically produce (curated). */
  readonly produces: readonly ArtifactSpec[]
}

export interface SubagentFacts {
  readonly provider: string
  readonly toolName: string
  /** True when the provider supports continuable children (spawn/fork), false for external one-shots. */
  readonly continuable: boolean
  readonly supportsAgentPreset: boolean
  readonly defaultMaxDepth: number
}

export interface PresetFacts {
  readonly id: string
  readonly tools: readonly string[]
  readonly default: boolean
}

export interface RegistryNode {
  readonly id: NodeId
  readonly kind: CapabilityKind
  readonly label: string
  readonly description: string
  /** Registry-true provenance. `dynamic` nodes are added after init and removed on change. */
  readonly source: {
    readonly registry: 'tools' | 'system-prompt' | 'skills' | 'presets' | 'subagents' | 'plugins' | 'agents'
    readonly packageName?: string
    readonly dynamic: boolean
  }
  readonly tool?: ToolFacts
  readonly skill?: SkillFacts
  readonly subagent?: SubagentFacts
  readonly preset?: PresetFacts
  /** Non-empty for most tools; empty only for orchestration-only nodes. */
  readonly accepts: readonly ArtifactSpec[]
  readonly produces: readonly ArtifactSpec[]
  readonly cost: CostPrior
  /** Curated capability tags (routing vocabulary), e.g. ["search","text"]. */
  readonly tags: readonly string[]
  /** Semver of the annotation set that supplied tags/artifacts/cost. */
  readonly annotationVersion: string
}

export interface RegistrySnapshotSource {
  readonly registry: string
  readonly count: number
  readonly lastChangeSeq: number
}

export interface RegistryGraph {
  readonly version: RegistryVersion
  /** sha256 over canonical JSON of nodes+edges; the cache key for matching. */
  readonly digest: string
  readonly nodes: readonly RegistryNode[]
  readonly edges: readonly GraphEdge[]
  readonly sources: readonly RegistrySnapshotSource[]
  /** Known blind spots at build time (dynamic MCP tools, conditional registrations, ...). */
  readonly warnings: readonly string[]
  /** Logical build counter, NOT wall-clock time (determinism for replay/tests). */
  readonly buildTick: number
}

// ---------------------------------------------------------------------------
// Layer 2 — task plan (executable sub-graph)
// ---------------------------------------------------------------------------

export type PlanNodeKind =
  | 'agent-step'
  | 'tool-call'
  | 'skill-load'
  | 'gate'
  | 'parallel'
  | 'human-interrupt'
  | 'subgraph'
  | 'map'
  | 'terminal'
  | 'replan'

export interface NodeBudget {
  readonly maxSteps?: number
  readonly maxTokens?: number
  readonly maxWallMs?: number
}

/**
 * How a node is executed.
 * - `step`: one in-session DSH step (one model request + its tool batch), node-scoped
 *   prompt fragment, tool policy and model selection. Produces the durable sequence
 *   step/start .. step/end in the parent session.
 * - `subagent`: one fresh child activation via `ctx.subagents.startActivation(...)`
 *   with `delivery: 'caller'` and an object-rooted `outputSchema`; the child owns its
 *   own session/prompt/tools, and the parent records `subagent/catalog` plus one
 *   compact injected result message. Required for every node in a parallel superstep.
 */
export type NodeExecutor = 'step' | 'subagent'

/** JSON-safe only: Date/Map/Set/undefined/class instances are rejected by assertJsonSafe. */
export type Json = null | boolean | number | string | Json[] | { [key: string]: Json }

export interface HandoffField {
  readonly name: string
  /** JSON type name; `object` and `array` require a nested `fields`/`items` shape. */
  readonly type: 'string' | 'number' | 'boolean' | 'object' | 'array'
  readonly maxBytes?: number
  readonly fields?: readonly HandoffField[]
  readonly items?: HandoffField
}

/**
 * State handed to a subagent node: the node's input object is serialized into one
 * text block of the child prompt. The output uses the same shape as an
 * object-rooted JSON Schema (`ctx.subagents` requires `assertObjectJsonSchema`).
 */
export interface HandoffSpec {
  readonly input: readonly HandoffField[]
  readonly output: readonly HandoffField[]
  /** Refuse the activation when the serialized input exceeds this size. */
  readonly maxInputBytes: number
  /** Refuse the result (and replan) when the structured output exceeds this size. */
  readonly maxOutputBytes: number
}

export interface SubagentNodeSpec {
  readonly handoff: HandoffSpec
  /** Provider name registered on `ctx.subagents` (spawn | fork | external ...). */
  readonly provider: string
  /** Optional independent preset; requires provider capabilities.agentPreset. */
  readonly agentPreset?: string
  readonly maxDepth?: number
  /** Model override for the child; in-process providers merge it over the parent options. */
  readonly agentOptions?: { readonly provider?: string; readonly model?: string }
}

/** One durable boundary the loop can resume from. */
export interface NodeBoundary {
  readonly planId: string
  readonly planVersion: number
  readonly superstep: number
  readonly nodeId: NodeId
  /** Session seq of the last durable event belonging to the node. */
  readonly atSeq: number
  /** Which DSH facts closed the boundary. */
  readonly closedBy: 'step-end' | 'injected-result' | 'turn-end' | 'fork'
}

/** Deterministic predicate over plan state; must be pure and serializable. */
export type Condition =
  | { readonly op: 'always' }
  | { readonly op: 'artifact'; readonly type: ArtifactType }
  | { readonly op: 'noArtifact'; readonly type: ArtifactType }
  | { readonly op: 'fact'; readonly key: string; readonly equals: string | number | boolean }
  | { readonly op: 'callFailed'; readonly tool: string }
  /**
   * Step budget guard. `axis` is `steps` only: the token and wall budget axes
   * have no producer at a step boundary, so a guard on them could never fire;
   * `validateTaskPlan` rejects them instead of leaving them silently inert.
   */
  | { readonly op: 'budget'; readonly axis: 'steps'; readonly remainingAtMost: number }

/**
 * Declared evidence contract for one plan node (audit 20261111-1200 F1-F4).
 *
 * A control edge out of a node may claim success only when this node's own step
 * satisfies the node's declared contract. The contract is data: it names the
 * artifact types the step must leave behind and/or that the node's declared
 * capability must verify an earlier artifact. It is not a tool-name, task-kind or
 * aggregate-step signal; an absent contract declares no evidence requirement, so
 * a node without one cannot emit an evidence-gated success exit.
 */
export interface NodeEvidenceContract {
  /**
   * Artifact types this node's step must leave behind. `required: true` specs
   * must all appear among the step's produced refs; with no required spec, at
   * least one declared type must appear (any-of).
   */
  readonly expects?: readonly ArtifactSpec[]
  /**
   * Artifact roots this node's evidence may be credited from (audit
   * 20261112-0000 F1-F4). An ambient world change is admissible for this node
   * only when it lies inside one of these roots; every other change is ignored.
   *
   * Each root is a *relative* path resolved against the session world root (the
   * session cwd fallback). The declaration is data -- never command text, tool
   * output, instruction prose, a glob or an environment expansion. An absent
   * declaration falls back to the whole session world root, so plans that
   * declare no root keep the cwd-wide credit they had before this field existed.
   * A root can only narrow credit; it never admits a ref outside the observed
   * world. Validation rejects an empty list, an empty entry, an absolute path
   * and any root that climbs above the world root.
   */
  readonly roots?: readonly string[]
  /**
   * Verify clause: the node's declared capability must run against a ref an
   * earlier step produced and report a clean status.
   */
  readonly verifier?: boolean
}

/**
 * One node-keyed work obligation (audit 20261112-0800 F1-F6).
 *
 * A node that declares an artifact expectation (`evidence.expects`) and is not
 * advisory (`optional`) owes the run that artifact. The driver records the
 * evaluation of the node's *own* step here, so "the node ran" (journal outcome
 * `ok`) is never confused with "the node's declared work is done". The record
 * keeps the contract so one bounded recovery step can attempt to discharge the
 * obligation and the ledger can be re-evaluated against that step's artifacts.
 */
export interface ObligationRecord {
  readonly nodeId: NodeId
  /** True only when the node's declared contract was satisfied by an observed step. */
  readonly satisfied: boolean
  /** 1-based trail position of the step whose boundary produced this record. */
  readonly step: number
  /** The node's own declared contract, so a recovery step can be held to it. */
  readonly contract: NodeEvidenceContract
  /** Recovery node that discharged an unmet obligation, when one did. */
  readonly satisfiedBy?: NodeId
}

/**
 * The typed answer a terminal step must form before the turn may complete.
 *
 * This is data, never prose: the runtime builds the record from what the step
 * observably did (its own text, its real tool calls, the obligation refs the
 * ledger records as satisfied). Admission is structural — non-empty text, zero
 * tool calls, an evidence ref for every required obligation — and the prose is
 * never inspected.
 */
export interface AnswerRecord {
  /** Final assistant text of the terminal step; must be non-empty. */
  readonly text: string
  /** Obligation node ids the answer rests on; must name every required obligation. */
  readonly evidenceRefs: readonly NodeId[]
  /** Real tool calls the answering step issued; an answer step issues none. */
  readonly toolCalls: number
}

export interface PlanNode {
  readonly id: NodeId
  readonly kind: PlanNodeKind
  /** Defaults to `step`; every node in a parallel superstep must be `subagent`. */
  readonly executor: NodeExecutor
  /** Binds to a RegistryNode id (tool/skill/subagent provider/preset). */
  readonly capabilityId?: NodeId
  /** Short instruction fragment rendered into the prompt for this node. */
  readonly instruction?: string
  /** Soft allowlist enforced by a tools guard; hardGate=true also removes schemas. */
  readonly toolAllow?: readonly string[]
  /** Advisory node: a failed tool does not fail the step (e.g. read-before-write). */
  readonly optional?: boolean
  /** Hard gating removes schemas from the request: see the replan gate policy. */
  readonly hardGate?: boolean
  /**
   * In-session nodes only: the model this node's step requests. Applying a different
   * route records `model/selection` and a new request/header.
   */
  readonly model?: { readonly provider: string; readonly model: string; readonly reasoningEffort?: string }
  /** Subagent nodes only: provider, presets, handoff sizes and schema. */
  readonly subagent?: SubagentNodeSpec
  readonly budget?: NodeBudget
  /** Post-condition validator id (host-side, deterministic). */
  readonly validate?: string
  /** Declared evidence this node's own step must produce before a success exit. */
  readonly evidence?: NodeEvidenceContract
  /** Mutating nodes must say how a retry is made safe. */
  readonly idempotency?: 'idempotent' | 'verify-before-retry' | 'manual'
  readonly retry?: { readonly maxAttempts: number; readonly backoffMs?: number }
  /** For `map`/`subgraph` nodes: bounded repetition (v1 forbids unbounded cycles). */
  readonly loop?: { readonly maxIterations: number }
}

export interface PlanEdge {
  readonly from: NodeId
  readonly to: NodeId
  readonly kind: Extract<EdgeKind, 'control' | 'data'>
  /** Guard evaluated before taking the edge; absent = unconditional. */
  readonly when?: Condition
}

export interface TaskBudget {
  readonly maxNodes: number
  /** The only budget axis the routing engines enforce today. */
  readonly maxSteps: number
  /** Declared capacity; no runtime consumption producer yet, so not routable. */
  readonly maxTokens: number
  /** Declared capacity; no runtime consumption producer yet, so not routable. */
  readonly maxWallMs: number
  readonly maxReplans: number
}

export interface TaskPlan {
  readonly id: string
  /** Template this plan was instantiated from (see matching.ts). */
  readonly templateId: string
  readonly version: number
  readonly entry: NodeId
  readonly terminals: readonly NodeId[]
  readonly nodes: readonly PlanNode[]
  readonly edges: readonly PlanEdge[]
  readonly budget: TaskBudget
  /**
   * The tool universe compiled into the plan. Stable for the whole run so the
   * request prefix (tool declarations) does not change between nodes; per-node
   * `toolAllow` narrows it softly through a guard instead of changing schemas.
   */
  readonly toolUniverse: readonly string[]
  /** `cold`: re-gate only at cold points. `turn`: allow per-turn re-gating. `never`: observe only. */
  readonly gatePolicy: 'cold' | 'turn' | 'never'
  /** True for the always-available conservative plan. */
  readonly fallback: boolean
  /** Routing confidence in [0,1] recorded for calibration. */
  readonly confidence: number
  /** Stable digest of the compiled graph shape; bumps on every recompile (replan). */
  readonly compiledDigest: string
}

/**
 * The LangGraph superstep <-> DSH durable event mapping. This table is
 * normative: the conformance suite diffs produced event streams against it,
 * and `packages/core/src/runtime.ts` implements it. Keep it in one place so docs,
 * kernel binding and tests cannot drift.
 *
 * LangGraph concept            DSH durable fact(s)
 * ---------------------------  -------------------------------------------------
 * run start (`invoke`)         turn/start (opens the turn that owns the run)
 * superstep node (executor=step)  step/start -> request/header -> assistant/message
 *                              -> tool/call* -> tool/result* -> step/end
 * superstep node (executor=subagent)  subagent/catalog + subagent/descriptor in the
 *                              parent, child events in the child session, then one
 *                              injected user/message carrying the structured result
 * parallel superstep (n nodes) n child activations concurrently, then one injected
 *                              summary user/message at the join
 * conditional edge             no event; the next step/start (or injected join) is
 *                              the observable consequence
 * checkpoint put               node boundary: after step/end or after the injected
 *                              result, never mid-step
 * checkpoint get / resume      fold of the session log prefix at run start
 * interrupt() / human gate     NOT used: a human gate is an `ask_user_question` tool
 *                              call (durable tool/call + tool/result) inside a step,
 *                              or a terminal `human-interrupt` node that ends the turn
 * updateState (replan)         one injected `user/message` (plan version + mutation)
 *                              appended at the next node boundary
 * run end                      turn/end (reason `completed` or `failed`)
 */
export const SUPERSTEP_EVENT_MAP = {
  runStart: ['turn/start'],
  stepNode: ['step/start', 'request/header', 'assistant/message', 'tool/call', 'tool/result', 'step/end'],
  subagentNode: ['subagent/descriptor', 'subagent/catalog', 'user/message'],
  parallelJoin: ['user/message'],
  checkpointPut: ['step/end', 'user/message'],
  humanGate: ['tool/call', 'tool/result'],
  replan: ['user/message'],
  runEnd: ['turn/end'],
} as const


export type PlanStatus = 'pending' | 'running' | 'replanning' | 'done' | 'failed' | 'aborted'

/**
 * Where the *plan* stands, as a dimension of its own.
 *
 * Plan state is not turn state: a plan can be `finished` while the turn is still
 * working (a stock step with no node), and only a declared `terminal` ends the
 * turn by plan. `PlanStatus` above is the persistence-facing status; this type
 * is the routing/turn-boundary view and has no `pending`/`replanning`/`aborted`
 * values because those are not observable at a step boundary.
 *
 *  - `running`  — an enabled node exists and the next step runs it.
 *  - `finished` — no enabled node is left and no terminal ran; the plan has no
 *                 internal work left. The turn stays open.
 *  - `terminal` — a declared terminal completed; the plan reached its endpoint
 *                 and the turn ends once.
 *  - `failed`   — no recovery path, or a guard/budget failure; the turn fails.
 */
export type PlanRunState = 'running' | 'finished' | 'terminal' | 'failed'

export interface PlanState {
  readonly planId: string
  readonly planVersion: number
  readonly status: PlanStatus
  readonly cursor: NodeId | null
  readonly artifacts: readonly ArtifactSpec[]
  readonly facts: Readonly<Record<string, string | number | boolean>>
  readonly replans: number
  readonly stepsUsed: number
  readonly tokensUsed: number
  readonly history: readonly PlanTransition[]
}

export interface PlanTransition {
  readonly from: NodeId
  readonly to: NodeId
  readonly atStep: number
  readonly reason: 'edge' | 'replan' | 'fallback' | 'terminal' | 'abort'
}

/**
 * LangGraph channels, JSON-only. The spike showed checkpoint payloads survive
 * natively as Date/Map but not a JSON round-trip, so every channel below is
 * plain JSON and `assertJsonSafe` is enforced before any checkpoint write.
 */
export interface GraphState {
  /** Task fingerprint hash (16 hex chars) and chosen plan identity. */
  readonly taskHash: string
  readonly planId: string
  readonly planVersion: number
  /** Superstep counter, monotonic within one run. */
  readonly superstep: number
  /** Node the graph will execute next; null before entry, terminal after. */
  readonly next: NodeId | null
  readonly status: PlanStatus
  /** Facts extracted from durable tool results by deterministic validators. */
  readonly facts: { readonly [key: string]: Json }
  /** Artifacts by reference only: path + hash, never file bodies. */
  readonly artifacts: readonly {
    readonly type: ArtifactType
    readonly ref: string
    readonly hash?: string
    readonly bytes?: number
  }[]
  /**
   * Node-keyed work obligations recorded so far (audit 20261112-0800 F1-F6).
   * Old folds omit it; an empty ledger means no node declared work.
   */
  readonly obligations?: readonly ObligationRecord[]
  /** Child session ids spawned by subagent nodes, for resume/fork traversal. */
  readonly children: readonly { readonly nodeId: NodeId; readonly sessionId: string }[]
  /** Bounded journal of node transitions; trimmed to the newest `maxJournal`. */
  readonly journal: readonly {
    readonly nodeId: NodeId
    readonly superstep: number
    readonly outcome: 'ok' | 'failed' | 'skipped'
    readonly atSeq: number
  }[]
  readonly budget: {
    readonly nodes: number
    readonly steps: number
    readonly tokens: number
    readonly wallMs: number
  }
  readonly replans: number
}

export const GRAPH_STATE_LIMITS = {
  /** Refuse a checkpoint larger than this; keeps resume cost and storage bounded. */
  maxCheckpointBytes: 64 * 1024,
  /** Journal length; older entries are dropped (log fold is the full record). */
  maxJournal: 64,
  /** Subagent input/output caps, enforced before activation and on result. */
  maxHandoffInputBytes: 16 * 1024,
  maxHandoffOutputBytes: 8 * 1024,
} as const

/**
 * JSON-safety check used before every checkpoint write. Returns the offending
 * path, or `null` when the value is JSON.
 *
 * A cyclic object/array is reported as an issue instead of recursing until the
 * stack overflows. `ancestors` holds the objects on the current path only, so a
 * shared (diamond) reference is still legal JSON.
 */
export function assertJsonSafe(value: unknown, path = '$'): string | null {
  return jsonProblem(value, path, new Set())
}

function jsonProblem(value: unknown, path: string, ancestors: Set<object>): string | null {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return null
  if (typeof value === 'number') return Number.isFinite(value) ? null : `${path}: non-finite number`
  if (Array.isArray(value)) {
    if (ancestors.has(value)) return `${path}: cyclic reference`
    ancestors.add(value)
    for (const [index, item] of value.entries()) {
      const problem = jsonProblem(item, `${path}[${index}]`, ancestors)
      if (problem) {
        ancestors.delete(value)
        return problem
      }
    }
    ancestors.delete(value)
    return null
  }
  if (typeof value === 'object') {
    if (ancestors.has(value)) return `${path}: cyclic reference`
    const proto = Object.getPrototypeOf(value)
    if (proto !== Object.prototype && proto !== null) return `${path}: non-plain object`
    ancestors.add(value)
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      const problem = jsonProblem(item, `${path}.${key}`, ancestors)
      if (problem) {
        ancestors.delete(value)
        return problem
      }
    }
    ancestors.delete(value)
    return null
  }
  return `${path}: ${typeof value} is not JSON`
}


// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

export interface ValidationIssue {
  readonly code: string
  readonly path: string
  readonly message: string
}

export interface ValidationResult {
  readonly ok: boolean
  readonly errors: readonly ValidationIssue[]
  readonly warnings: readonly ValidationIssue[]
}

export const GRAPH_LIMITS = {
  /** Beam width for plan search (deterministic). */
  beamWidth: 8,
  /** Maximum tool candidates considered per plan slot. */
  slotCandidates: 6,
  /** Hard ceiling on nodes per plan; keeps search and replay bounded. */
  maxPlanNodes: 24,
  /** Hard ceiling on registered capabilities in one snapshot. */
  maxRegistryNodes: 4096,
} as const

const NODE_ID_RE = /^[a-z0-9][a-z0-9._:-]{0,127}$/u
const ARTIFACT_SET: ReadonlySet<string> = new Set(ARTIFACT_TYPES)
const SUBSTITUTABLE_KINDS: ReadonlySet<CapabilityKind> = new Set<CapabilityKind>([
  'tool',
  'skill',
  'subagent-provider',
  'preset',
])

function isFinite01(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1
}

/** Structural validation of a registry snapshot. Pure; safe to run on every change batch. */
export function validateRegistryGraph(graph: RegistryGraph): ValidationResult {
  const errors: ValidationIssue[] = []
  const warnings: ValidationIssue[] = []
  const ids = new Map<string, RegistryNode>()

  if (!Number.isInteger(graph.version) || graph.version < 0) {
    errors.push({ code: 'R001', path: 'version', message: 'version must be a non-negative integer' })
  }
  if (graph.nodes.length > GRAPH_LIMITS.maxRegistryNodes) {
    errors.push({ code: 'R002', path: 'nodes', message: `node count exceeds ${GRAPH_LIMITS.maxRegistryNodes}` })
  }

  for (const [index, node] of graph.nodes.entries()) {
    const path = `nodes[${index}]`
    if (!NODE_ID_RE.test(node.id)) {
      errors.push({ code: 'R003', path: `${path}.id`, message: `invalid node id "${node.id}"` })
    }
    if (ids.has(node.id)) {
      errors.push({ code: 'R004', path: `${path}.id`, message: `duplicate node id "${node.id}"` })
    }
    ids.set(node.id, node)
    if (!isFinite01(node.cost.risk)) {
      errors.push({ code: 'R005', path: `${path}.cost.risk`, message: 'risk must be in [0,1]' })
    }
    for (const artifact of [...node.accepts, ...node.produces]) {
      if (!ARTIFACT_SET.has(artifact.type)) {
        warnings.push({
          code: 'W001',
          path: `${path}.artifacts`,
          message: `artifact type "${artifact.type}" is outside the curated vocabulary`,
        })
      }
    }
    if (node.kind === 'tool' && node.tool === undefined) {
      errors.push({ code: 'R006', path: `${path}.tool`, message: 'tool node requires tool facts' })
    }
    if (node.source.dynamic && !node.source.registry) {
      errors.push({ code: 'R007', path: `${path}.source`, message: 'dynamic nodes must name their registry' })
    }
  }

  const edgeIds = new Set<string>()
  for (const [index, edge] of graph.edges.entries()) {
    const path = `edges[${index}]`
    if (edgeIds.has(edge.id)) {
      errors.push({ code: 'R008', path: `${path}.id`, message: `duplicate edge id "${edge.id}"` })
    }
    edgeIds.add(edge.id)
    if (!ids.has(edge.from)) {
      errors.push({ code: 'R009', path: `${path}.from`, message: `unknown node "${edge.from}"` })
    }
    if (!ids.has(edge.to)) {
      errors.push({ code: 'R010', path: `${path}.to`, message: `unknown node "${edge.to}"` })
    }
    if (!isFinite01(edge.weight)) {
      errors.push({ code: 'R011', path: `${path}.weight`, message: 'weight must be in [0,1]' })
    }
    const from = ids.get(edge.from)
    const to = ids.get(edge.to)
    if (edge.kind === 'substitutes' && from && to && !SUBSTITUTABLE_KINDS.has(from.kind)) {
      errors.push({ code: 'R012', path: `${path}.from`, message: 'substitutes edge must join substitutable kinds' })
    }
    if (edge.kind === 'substitutes' && from && to && from.kind !== to.kind) {
      errors.push({ code: 'R013', path: `${path}`, message: 'substitutes edge must join the same capability kind' })
    }
    if (edge.symmetric) {
      const reverse = graph.edges.some((other) => other.from === edge.to && other.to === edge.from && other.kind === edge.kind)
      if (!reverse) {
        warnings.push({ code: 'W002', path: `${path}`, message: `symmetric edge has no reverse (${edge.to} -> ${edge.from})` })
      }
    }
  }

  return { ok: errors.length === 0, errors, warnings }
}

/**
 * True when a declared evidence root can be resolved against the session world
 * root without leaving it (audit 20261112-0000 F1-F4).
 *
 * The root is a plan declaration, so only its syntax is checkable here; the
 * loop resolves a relative root against the world root at the step boundary.
 * An absolute root, or a relative one whose `..` segments climb above its own
 * base, would scope credit outside the observed session world, so the plan is
 * rejected instead of the root being silently denied at runtime.
 */
function isSafeEvidenceRoot(root: string): boolean {
  if (root.trim() === '' || root.includes('\0')) return false
  // POSIX absolute, Windows drive-absolute and Windows rooted/UNC paths all
  // name a place outside a world-relative root.
  if (root.startsWith('/') || root.startsWith('\\') || /^[A-Za-z]:[\\/]/.test(root)) return false
  let depth = 0
  for (const segment of root.split(/[\\/]+/)) {
    if (segment === '' || segment === '.') continue
    if (segment === '..') {
      depth -= 1
      if (depth < 0) return false
      continue
    }
    depth += 1
  }
  return true
}

/**
 * R4 turn-shape validation: every turn plan is a multi-node graph with a
 * distinct entry and exactly one terminal.
 *
 * Split out of {@link validateTaskPlan} so a caller that installs a plan can
 * enforce the invariant without a registry snapshot at hand (the scheduler's
 * `install()`); `validateTaskPlan` merges these errors so producer-side
 * validation rejects the same shapes. P001-P030 keep their meaning; P031-P033
 * are the R4 codes.
 */
export function validateTurnShape(plan: TaskPlan): ValidationResult {
  const errors: ValidationIssue[] = []
  if (plan.nodes.length < 2) {
    errors.push({ code: 'P031', path: 'nodes', message: 'a turn plan needs at least two nodes' })
  }
  if (plan.terminals.includes(plan.entry)) {
    errors.push({ code: 'P032', path: 'entry', message: `entry "${plan.entry}" is also a terminal` })
  }
  if (plan.terminals.length !== 1) {
    errors.push({ code: 'P033', path: 'terminals', message: `a turn plan needs exactly one terminal, got ${plan.terminals.length}` })
  }
  return { ok: errors.length === 0, errors, warnings: [] }
}

/** Structural validation of an instantiated plan against its registry snapshot. */
export function validateTaskPlan(graph: RegistryGraph, plan: TaskPlan): ValidationResult {
  const errors: ValidationIssue[] = []
  const warnings: ValidationIssue[] = []
  const nodeById = new Map<string, PlanNode>(plan.nodes.map((node) => [node.id, node]))
  const registryIds = new Set(graph.nodes.map((node) => node.id))

  if (plan.nodes.length > GRAPH_LIMITS.maxPlanNodes) {
    errors.push({ code: 'P001', path: 'nodes', message: `plan exceeds ${GRAPH_LIMITS.maxPlanNodes} nodes` })
  }
  if (!nodeById.has(plan.entry)) {
    errors.push({ code: 'P002', path: 'entry', message: `unknown entry node "${plan.entry}"` })
  }
  if (plan.terminals.length === 0) {
    errors.push({ code: 'P003', path: 'terminals', message: 'plan needs at least one terminal node' })
  }
  // R4: one multi-node shape for every producer (no one-node turn plans).
  errors.push(...validateTurnShape(plan).errors)
  if (!Number.isInteger(plan.budget.maxSteps) || plan.budget.maxSteps < 1) {
    errors.push({ code: 'P026', path: 'budget.maxSteps', message: 'maxSteps must be a positive integer' })
  }
  if (!Number.isInteger(plan.budget.maxNodes) || plan.budget.maxNodes < 1) {
    errors.push({ code: 'P026', path: 'budget.maxNodes', message: 'maxNodes must be a positive integer' })
  }

  const seenNodeIds = new Set<string>()
  for (const [index, node] of plan.nodes.entries()) {
    const path = `nodes[${index}]`
    if (seenNodeIds.has(node.id)) {
      errors.push({ code: 'P024', path: `${path}.id`, message: `duplicate node id "${node.id}"` })
    }
    seenNodeIds.add(node.id)
    if (node.capabilityId !== undefined && !registryIds.has(node.capabilityId)) {
      errors.push({ code: 'P004', path: `${path}.capabilityId`, message: `unknown capability "${node.capabilityId}"` })
    }
    if (node.executor === 'subagent' && node.subagent === undefined) {
      errors.push({ code: 'P005', path: `${path}.subagent`, message: 'subagent executor requires a subagent spec' })
    }
    if (node.executor === 'subagent' && node.kind !== 'tool-call' && node.kind !== 'agent-step') {
      errors.push({ code: 'P014', path, message: 'subagent executor only supports agent-step/tool-call nodes' })
    }
    if (node.subagent) {
      const { maxInputBytes, maxOutputBytes, output } = node.subagent.handoff
      if (maxInputBytes <= 0 || maxInputBytes > GRAPH_STATE_LIMITS.maxHandoffInputBytes) {
        errors.push({ code: 'P015', path: `${path}.subagent.handoff`, message: 'handoff input cap out of range' })
      }
      if (maxOutputBytes <= 0 || maxOutputBytes > GRAPH_STATE_LIMITS.maxHandoffOutputBytes) {
        errors.push({ code: 'P016', path: `${path}.subagent.handoff`, message: 'handoff output cap out of range' })
      }
      if (output.length === 0) {
        errors.push({ code: 'P017', path: `${path}.subagent.handoff`, message: 'handoff needs at least one output field' })
      }
    }
    if (node.executor === 'step' && node.model !== undefined && node.model.provider === '') {
      errors.push({ code: 'P018', path: `${path}.model`, message: 'empty provider on a step model override' })
    }
    if (node.kind === 'map' && (node.loop === undefined || node.loop.maxIterations <= 0)) {
      errors.push({ code: 'P006', path: `${path}.loop`, message: 'map nodes require a positive maxIterations' })
    }
    if (node.kind === 'terminal' && (node.toolAllow?.length ?? 0) > 0) {
      errors.push({ code: 'P007', path: `${path}.toolAllow`, message: 'terminal nodes cannot allow tools' })
    }
    if (node.toolAllow && node.toolAllow.length > 0) {
      for (const name of node.toolAllow) {
        const exists = graph.nodes.some((candidate) => candidate.kind === 'tool' && candidate.tool?.name === name)
        if (!exists) {
          errors.push({ code: 'P008', path: `${path}.toolAllow`, message: `tool "${name}" is not in this registry snapshot` })
        }
      }
    }
    if (node.evidence !== undefined) {
      // A declared evidence contract must be able to certify something. An
      // empty declaration would let a success edge look evidence-gated while it
      // accepted anything, so it is rejected rather than treated as absent.
      const expects = node.evidence.expects ?? []
      if (expects.length === 0 && node.evidence.verifier !== true) {
        errors.push({ code: 'P027', path: `${path}.evidence`, message: 'node evidence contract declares neither expects nor verifier' })
      }
      for (const spec of expects) {
        if (!(ARTIFACT_TYPES as readonly string[]).includes(spec.type)) {
          errors.push({ code: 'P028', path: `${path}.evidence.expects`, message: `unknown artifact type "${String(spec.type)}"` })
        }
      }
      // Roots are the typed place-scope of the node's evidence. A malformed or
      // world-escaping declaration is rejected rather than silently ignored:
      // an ignored `roots` would look scoped while crediting the whole world,
      // and an escaping root would scope credit outside the observed session.
      const roots = (node.evidence as { readonly roots?: unknown }).roots
      if (roots !== undefined) {
        if (!Array.isArray(roots) || roots.length === 0) {
          errors.push({ code: 'P029', path: `${path}.evidence.roots`, message: 'evidence roots must be a non-empty array of relative paths' })
        } else {
          for (const root of roots) {
            if (typeof root !== 'string' || root.trim() === '' || root.includes('\0')) {
              errors.push({ code: 'P029', path: `${path}.evidence.roots`, message: 'evidence root must be a non-empty string' })
            } else if (!isSafeEvidenceRoot(root)) {
              errors.push({ code: 'P030', path: `${path}.evidence.roots`, message: `evidence root "${root}" must be relative and stay inside the session world root` })
            }
          }
        }
      }
    }
    if (node.validate === undefined && node.kind === 'tool-call') {
      const capability = node.capabilityId ? graph.nodes.find((candidate) => candidate.id === node.capabilityId) : undefined
      if (capability?.tool?.permission === 'mutating') {
        warnings.push({ code: 'W003', path, message: 'mutating tool-call node without a post-condition validator' })
      }
    }
  }

  const outgoing = new Map<string, PlanEdge[]>()
  for (const [index, edge] of plan.edges.entries()) {
    const path = `edges[${index}]`
    if (!nodeById.has(edge.from)) {
      errors.push({ code: 'P009', path: `${path}.from`, message: `unknown node "${edge.from}"` })
    }
    if (!nodeById.has(edge.to)) {
      errors.push({ code: 'P010', path: `${path}.to`, message: `unknown node "${edge.to}"` })
    }
    if (edge.when !== undefined) {
      // Only the `steps` budget axis has a runtime producer. Reject the removed
      // token/wall axes instead of leaving a guard that can never fire.
      const axis = (edge.when as { readonly axis?: unknown }).axis
      if (edge.when.op === 'budget' && axis !== 'steps') {
        errors.push({ code: 'P022', path: `${path}.when`, message: 'budget condition supports only the "steps" axis; tokens/wall have no producer' })
      }
      // A guard on a data edge is inert: the frontier routes control edges only
      // and the kernel refuses plans with data-edge conditions. Reject it.
      if (edge.kind === 'data') {
        errors.push({ code: 'P023', path: `${path}.when`, message: 'a condition on a data edge is not routed by either engine' })
      }
    }
    const list = outgoing.get(edge.from) ?? []
    list.push(edge)
    outgoing.set(edge.from, list)
  }

  // A parallel superstep runs concurrent child activations, never concurrent steps
  // in one session: every branch of a parallel node must use the subagent executor.
  for (const node of plan.nodes) {
    if (node.kind !== 'parallel') continue
    const branches = (outgoing.get(node.id) ?? []).map((edge) => nodeById.get(edge.to))
    if (branches.length < 2) {
      errors.push({ code: 'P019', path: `nodes.${node.id}`, message: 'parallel node needs at least two branches' })
    }
    for (const branch of branches) {
      if (branch && branch.executor !== 'subagent') {
        errors.push({
          code: 'P020',
          path: `nodes.${branch.id}`,
          message: 'a parallel branch must use the subagent executor (one step at a time per session)',
        })
      }
    }
  }

  for (const name of plan.toolUniverse) {
    const exists = graph.nodes.some((candidate) => candidate.kind === 'tool' && candidate.tool?.name === name)
    if (!exists) {
      errors.push({ code: 'P021', path: 'toolUniverse', message: `tool "${name}" is not in this registry snapshot` })
    }
  }

  for (const terminal of plan.terminals) {
    if (!nodeById.has(terminal)) {
      errors.push({ code: 'P011', path: 'terminals', message: `unknown terminal "${terminal}"` })
    }
    if ((outgoing.get(terminal)?.length ?? 0) > 0) {
      errors.push({ code: 'P012', path: `terminals.${terminal}`, message: 'terminal node has outgoing edges' })
    }
  }

  // Reachability: a node the entry cannot reach is dead weight in the plan.
  const reachable = new Set<string>()
  const stack: string[] = plan.entry && nodeById.has(plan.entry) ? [plan.entry] : []
  while (stack.length > 0) {
    const current = stack.pop() as string
    if (reachable.has(current)) continue
    reachable.add(current)
    for (const edge of outgoing.get(current) ?? []) {
      if (nodeById.has(edge.to)) stack.push(edge.to)
    }
  }
  for (const node of plan.nodes) {
    if (!reachable.has(node.id)) {
      warnings.push({ code: 'W004', path: `nodes.${node.id}`, message: 'unreachable from entry' })
    }
  }

  // A terminal the entry can only reach over a data edge is not an endpoint
  // either engine can run: both engines route control edges only. Reject it
  // instead of letting the run stop with `done` and no terminal executed.
  if (plan.entry !== '' && nodeById.has(plan.entry)) {
    const controlReachable = new Set<string>([plan.entry])
    const controlStack: string[] = [plan.entry]
    while (controlStack.length > 0) {
      const current = controlStack.pop() as string
      for (const edge of outgoing.get(current) ?? []) {
        if (edge.kind !== 'control' || controlReachable.has(edge.to) || !nodeById.has(edge.to)) continue
        controlReachable.add(edge.to)
        controlStack.push(edge.to)
      }
    }
    for (const terminal of plan.terminals) {
      if (nodeById.has(terminal) && !controlReachable.has(terminal)) {
        errors.push({
          code: 'P025',
          path: `terminals.${terminal}`,
          message: `terminal "${terminal}" is not reachable from entry over control edges`,
        })
      }
    }
  }

  // Cycle check: only map nodes may close an *unconditional* cycle, and only
  // with a bound. A cycle that needs a conditional edge (the bounded
  // verify -> retry loop) is guarded by that condition — the frontier only
  // follows it on the matching outcome — so it is not an unconditional loop;
  // `maxSteps` still bounds it.
  const reportedCycles = new Set<string>()
  const visiting = new Set<string>()
  const visited = new Set<string>()
  const unconditional = (edge: PlanEdge): boolean => edge.when === undefined || edge.when.op === 'always'
  const walk = (id: string): void => {
    if (visiting.has(id)) {
      const key = `${id}`
      if (!reportedCycles.has(key)) {
        reportedCycles.add(key)
        const node = nodeById.get(id)
        if (node && node.kind !== 'map') {
          errors.push({ code: 'P013', path: `nodes.${id}`, message: 'unconditional cycle outside a bounded map node' })
        }
      }
      return
    }
    if (visited.has(id)) return
    visiting.add(id)
    for (const edge of outgoing.get(id) ?? []) {
      if (!unconditional(edge)) continue
      walk(edge.to)
    }
    visiting.delete(id)
    visited.add(id)
  }
  if (plan.entry && nodeById.has(plan.entry)) walk(plan.entry)

  return { ok: errors.length === 0, errors, warnings }
}

// ---------------------------------------------------------------------------
// JSON Schema (wire/document form)
// ---------------------------------------------------------------------------

/**
 * JSON Schema (draft 2020-12) for the on-disk example and for `graph_status`
 * output. The TypeScript types above are the source of truth; this document is
 * the wire/document form for external consumers.
 */
export const REGISTRY_GRAPH_JSON_SCHEMA = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  $id: 'https://dsh.example/graph/registry-graph.schema.json',
  title: 'RegistryGraph',
  type: 'object',
  required: ['version', 'digest', 'nodes', 'edges', 'sources', 'warnings', 'buildTick'],
  additionalProperties: false,
  properties: {
    version: { type: 'integer', minimum: 0 },
    digest: { type: 'string', pattern: '^[0-9a-f]{16,64}$' },
    buildTick: { type: 'integer', minimum: 0 },
    warnings: { type: 'array', items: { type: 'string' } },
    sources: {
      type: 'array',
      items: {
        type: 'object',
        required: ['registry', 'count', 'lastChangeSeq'],
        additionalProperties: false,
        properties: {
          registry: { type: 'string' },
          count: { type: 'integer', minimum: 0 },
          lastChangeSeq: { type: 'integer', minimum: 0 },
        },
      },
    },
    nodes: {
      type: 'array',
      items: {
        type: 'object',
        required: ['id', 'kind', 'label', 'description', 'source', 'accepts', 'produces', 'cost', 'tags', 'annotationVersion'],
        additionalProperties: false,
        properties: {
          id: { type: 'string', pattern: '^[a-z0-9][a-z0-9._:-]{0,127}$' },
          kind: {
            enum: ['tool', 'skill', 'subagent-provider', 'preset', 'agent-role', 'plugin', 'surface'],
          },
          label: { type: 'string' },
          description: { type: 'string' },
          annotationVersion: { type: 'string' },
          tags: { type: 'array', items: { type: 'string' }, uniqueItems: true },
          source: {
            type: 'object',
            required: ['registry', 'dynamic'],
            additionalProperties: false,
            properties: {
              registry: { type: 'string' },
              packageName: { type: 'string' },
              dynamic: { type: 'boolean' },
            },
          },
          accepts: { $ref: '#/$defs/artifacts' },
          produces: { $ref: '#/$defs/artifacts' },
          cost: {
            type: 'object',
            required: ['risk'],
            additionalProperties: false,
            properties: {
              tokensPerRequest: { type: 'number', minimum: 0 },
              tokensPerCall: { type: 'number', minimum: 0 },
              p50LatencyMs: { type: 'number', minimum: 0 },
              failureRate: { type: 'number', minimum: 0, maximum: 1 },
              risk: { type: 'number', minimum: 0, maximum: 1 },
            },
          },
          tool: {
            type: 'object',
            required: ['name', 'packageName', 'executor', 'permission', 'idempotent', 'parameterNames', 'accepts', 'produces', 'conditional', 'dynamic', 'schemaTokens'],
            additionalProperties: false,
            properties: {
              name: { type: 'string' },
              packageName: { type: 'string' },
              executor: { enum: ['native', 'ptc'] },
              permission: { enum: ['read-only', 'mutating', 'network', 'privileged'] },
              idempotent: { type: 'boolean' },
              conditional: { type: 'boolean' },
              dynamic: { type: 'boolean' },
              schemaTokens: { type: 'integer', minimum: 0 },
              parameterNames: { type: 'array', items: { type: 'string' }, uniqueItems: true },
              accepts: { $ref: '#/$defs/artifacts' },
              produces: { $ref: '#/$defs/artifacts' },
            },
          },
          skill: {
            type: 'object',
            required: ['name', 'provider', 'modelInvocable', 'userInvocable', 'produces'],
            additionalProperties: false,
            properties: {
              name: { type: 'string' },
              provider: { type: 'string' },
              modelInvocable: { type: 'boolean' },
              userInvocable: { type: 'boolean' },
              produces: { $ref: '#/$defs/artifacts' },
            },
          },
          subagent: {
            type: 'object',
            required: ['provider', 'toolName', 'continuable', 'supportsAgentPreset', 'defaultMaxDepth'],
            additionalProperties: false,
            properties: {
              provider: { type: 'string' },
              toolName: { type: 'string' },
              continuable: { type: 'boolean' },
              supportsAgentPreset: { type: 'boolean' },
              defaultMaxDepth: { type: 'integer', minimum: 0 },
            },
          },
          preset: {
            type: 'object',
            required: ['id', 'tools', 'default'],
            additionalProperties: false,
            properties: {
              id: { type: 'string' },
              tools: { type: 'array', items: { type: 'string' }, uniqueItems: true },
              default: { type: 'boolean' },
            },
          },
        },
      },
    },
    edges: {
      type: 'array',
      items: {
        type: 'object',
        required: ['id', 'from', 'to', 'kind', 'weight', 'provenance'],
        additionalProperties: false,
        properties: {
          id: { type: 'string' },
          from: { type: 'string' },
          to: { type: 'string' },
          kind: {
            enum: ['control', 'data', 'requires', 'produces', 'substitutes', 'similar', 'conflicts', 'permission', 'budget'],
          },
          weight: { type: 'number', minimum: 0, maximum: 1 },
          provenance: { enum: ['declared', 'schema-derived', 'mined', 'measured', 'embedding'] },
          symmetric: { type: 'boolean' },
          evidence: {
            type: 'object',
            additionalProperties: false,
            properties: {
              observations: { type: 'integer', minimum: 0 },
              statistic: { type: 'number' },
              note: { type: 'string' },
            },
          },
        },
      },
    },
  },
  $defs: {
    artifacts: {
      type: 'array',
      items: {
        type: 'object',
        required: ['type', 'required'],
        additionalProperties: false,
        properties: {
          type: { enum: [...ARTIFACT_TYPES] },
          required: { type: 'boolean' },
          contract: { type: 'string' },
        },
      },
    },
  },
} as const

/**
 * JSON Schema (draft 2020-12) for a TaskPlan. `explore` presets may ship templates
 * as YAML validated by this document; the compiled driver only ever sees the
 * TypeScript type, so the two cannot diverge in behavior.
 */
export const TASK_PLAN_JSON_SCHEMA = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  $id: 'https://dsh.example/graph/task-plan.schema.json',
  title: 'TaskPlan',
  type: 'object',
  required: ['id', 'templateId', 'version', 'entry', 'terminals', 'nodes', 'edges', 'budget', 'toolUniverse', 'gatePolicy', 'fallback', 'confidence', 'compiledDigest'],
  additionalProperties: false,
  properties: {
    id: { type: 'string' },
    templateId: { type: 'string' },
    version: { type: 'integer', minimum: 1 },
    compiledDigest: { type: 'string' },
    entry: { type: 'string' },
    fallback: { type: 'boolean' },
    confidence: { type: 'number', minimum: 0, maximum: 1 },
    gatePolicy: { enum: ['cold', 'turn', 'never'] },
    terminals: { type: 'array', minItems: 1, items: { type: 'string' } },
    toolUniverse: { type: 'array', items: { type: 'string' }, uniqueItems: true },
    budget: {
      type: 'object',
      required: ['maxNodes', 'maxSteps', 'maxTokens', 'maxWallMs', 'maxReplans'],
      additionalProperties: false,
      properties: {
        maxNodes: { type: 'integer', minimum: 1 },
        maxSteps: { type: 'integer', minimum: 1 },
        maxTokens: { type: 'integer', minimum: 1 },
        maxWallMs: { type: 'integer', minimum: 1 },
        maxReplans: { type: 'integer', minimum: 0 },
      },
    },
    nodes: {
      type: 'array',
      minItems: 1,
      items: {
        type: 'object',
        required: ['id', 'kind', 'executor'],
        additionalProperties: false,
        properties: {
          id: { type: 'string' },
          kind: { enum: ['agent-step', 'tool-call', 'skill-load', 'gate', 'parallel', 'human-interrupt', 'subgraph', 'map', 'terminal', 'replan'] },
          executor: { enum: ['step', 'subagent'] },
          capabilityId: { type: 'string' },
          instruction: { type: 'string' },
          toolAllow: { type: 'array', items: { type: 'string' } },
          optional: { type: 'boolean' },
          hardGate: { type: 'boolean' },
          validate: { type: 'string' },
          evidence: {
            type: 'object',
            additionalProperties: false,
            properties: {
              expects: { type: 'array', items: { $ref: '#/$defs/artifactSpec' } },
              verifier: { type: 'boolean' },
            },
          },
          idempotency: { enum: ['idempotent', 'verify-before-retry', 'manual'] },
          loop: {
            type: 'object',
            required: ['maxIterations'],
            additionalProperties: false,
            properties: { maxIterations: { type: 'integer', minimum: 1, maximum: 32 } },
          },
          model: {
            type: 'object',
            required: ['provider', 'model'],
            additionalProperties: false,
            properties: { provider: { type: 'string' }, model: { type: 'string' }, reasoningEffort: { type: 'string' } },
          },
          subagent: {
            type: 'object',
            required: ['provider', 'handoff'],
            additionalProperties: false,
            properties: {
              provider: { type: 'string' },
              agentPreset: { type: 'string' },
              maxDepth: { type: 'integer', minimum: 0 },
              agentOptions: {
                type: 'object',
                additionalProperties: false,
                properties: { provider: { type: 'string' }, model: { type: 'string' } },
              },
              handoff: {
                type: 'object',
                required: ['input', 'output', 'maxInputBytes', 'maxOutputBytes'],
                additionalProperties: false,
                properties: {
                  maxInputBytes: { type: 'integer', minimum: 1 },
                  maxOutputBytes: { type: 'integer', minimum: 1 },
                  input: { type: 'array', items: { $ref: '#/$defs/handoffField' } },
                  output: { type: 'array', items: { $ref: '#/$defs/handoffField' } },
                },
              },
            },
          },
        },
      },
    },
    edges: {
      type: 'array',
      items: {
        type: 'object',
        required: ['from', 'to', 'kind'],
        additionalProperties: false,
        properties: {
          from: { type: 'string' },
          to: { type: 'string' },
          kind: { enum: ['control', 'data'] },
          when: {
            type: 'object',
            required: ['op'],
            additionalProperties: true,
            properties: { op: { enum: ['always', 'artifact', 'noArtifact', 'fact', 'callFailed', 'budget'] } },
          },
        },
      },
    },
  },
  $defs: {
    artifactSpec: {
      type: 'object',
      required: ['type', 'required'],
      additionalProperties: false,
      properties: {
        type: { enum: [...ARTIFACT_TYPES] },
        required: { type: 'boolean' },
        contract: { type: 'string' },
      },
    },
    handoffField: {
      type: 'object',
      required: ['name', 'type'],
      additionalProperties: false,
      properties: {
        name: { type: 'string', pattern: '^[A-Za-z_][A-Za-z0-9_]{0,63}$' },
        type: { enum: ['string', 'number', 'boolean', 'object', 'array'] },
        maxBytes: { type: 'integer', minimum: 1 },
        fields: { type: 'array', items: { $ref: '#/$defs/handoffField' } },
        items: { $ref: '#/$defs/handoffField' },
      },
    },
  },
} as const
