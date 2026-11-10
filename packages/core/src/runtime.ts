/**
 * runtime.ts — the `explore` driver contract: how a DSH turn becomes one graph run.
 *
 * This file is the seam between three concerns:
 *   - `packages/core/src/kernel.ts`: the kernel-agnostic graph interface. Concrete
 *     kernel adapters live in `packages/loop/src/kernel/`; this file consumes them
 *     by type only.
 *   - this file (`packages/core/src/runtime.ts`): the driver contract, node
 *     executors, DSH ports, the superstep -> session-event mapping, and the
 *     turn/step machine obligations.
 *   - `packages/loop`: implements the ports against real services, registers the
 *     AgentFactory, disables the `agent-loop` row, ships `explore`.
 *
 * Scope: the graph loop REPLACES the stock driver for `explore` sessions. It is
 * not a control plane around `dsh-agent-loop`. The graph decides which step runs;
 * the DSH per-step pipeline still makes that step (assembly, pre-step waterfall,
 * request header, tool pipeline, session logging), so every existing plugin that
 * listens to `agent/pre-step` or `tools/*` keeps working.
 *
 * Kernel constraints inherited from `kernel.ts` (do not relax):
 *   C1 state is JSON only; C2 node = one DSH step; C3 the session log is the only
 *   history (a checkpoint is never a source of model-visible facts); C4 interrupts
 *   live at node boundaries (prefer `ask_user_question`); C5 no mid-turn resume
 *   across processes (in-turn memory checkpointer only).
 */

import type { DeterminismHooks, JsonUpdate, JsonValue, KernelError, NodeContext, SuperstepBoundary } from './kernel.js'
import type { GraphState, NodeExecutor, PlanNode, PlanStatus, RegistryGraph, TaskPlan } from './graph-schema.js'
import type { RouteDecision } from './matching.js'

// ---------------------------------------------------------------------------
// State (C1: JSON only; this is what the checkpointer stores)
// ---------------------------------------------------------------------------

/**
 * One mutable view of the graph channels. Every field is JSON; symbols, Date,
 * Map, Set, class instances and `undefined` inside containers are rejected by
 * the kernel adapter before a checkpoint is written.
 */
export interface LoopState {
  readonly taskHash: string
  readonly planId: string
  readonly planVersion: number
  readonly superstep: number
  readonly next: string | null
  readonly status: PlanStatus
  readonly facts: { [key: string]: JsonValue }
  /** Artifacts by reference only: path + hash, never file bodies. */
  readonly artifacts: { type: string; ref: string; hash?: string; bytes?: number }[]
  readonly children: { nodeId: string; sessionId: string }[]
  readonly journal: { nodeId: string; superstep: number; outcome: 'ok' | 'failed' | 'skipped'; atSeq: number }[]
  readonly budget: { nodes: number; steps: number; tokens: number; wallMs: number }
  readonly replans: number
  /** Set when the run stopped at a human gate; cleared on resume. */
  readonly interrupt?: JsonValue
}

export function initialState(plan: TaskPlan, taskHash: string): LoopState {
  return {
    taskHash,
    planId: plan.id,
    planVersion: plan.version,
    superstep: 0,
    next: plan.entry,
    status: 'running',
    facts: {},
    artifacts: [],
    children: [],
    journal: [],
    budget: { nodes: 0, steps: 0, tokens: 0, wallMs: 0 },
    replans: 0,
  }
}

/** Adapter from the loop state to the schema-level GraphState (shared with matching/replan). */
export function toGraphState(state: LoopState): GraphState {
  return state as unknown as GraphState
}

// ---------------------------------------------------------------------------
// DSH ports
// ---------------------------------------------------------------------------

export interface ModelSelection {
  readonly provider: string
  readonly model: string
  readonly reasoningEffort?: string
}

/** `agent.model.select()` fixes the next unprepared step's route (agent README). */
export interface AgentPort {
  readonly id: string
  readonly sessionId: string
  selectModel(selection: ModelSelection): void
  currentModel(): ModelSelection | undefined
  inject(message: { readonly content: readonly { readonly type: 'text'; readonly text: string }[]; readonly source: { readonly kind: string } }): void
  cancel(cause: { readonly kind: 'graph-loop'; readonly reason: string }): void
}

/** `ctx.tools` subset (docs/subsystems/tools.md#cordis-surface). */
export interface ToolsPort {
  resolve(context: { readonly agent: unknown; readonly modelSelection: ModelSelection; readonly signal: AbortSignal }): Promise<unknown>
  restrict(filter: { readonly allow?: readonly string[]; readonly deny?: readonly string[] }): () => void
  guard(guard: (call: { readonly name: string; readonly arguments: JsonValue }) => string | undefined): () => void
  execute(batch: {
    readonly calls: readonly { readonly id: string; readonly name: string; readonly arguments: JsonValue }[]
    readonly agent: unknown
    readonly toolSet: unknown
    readonly maxParallel?: number
  }): Promise<{
    readonly results: readonly {
      readonly id: string
      readonly name: string
      readonly isError: boolean
      readonly content: readonly { readonly type: string; readonly text?: string }[]
    }[]
  }>
  schemas(scope: unknown, toolSet: unknown): readonly JsonValue[]
}

/** `ctx.systemPrompt` subset; per-node text is injected as a user message, not a section. */
export interface SystemPromptPort {
  assemble(context: {
    readonly agent: unknown
    readonly modelSelection: ModelSelection
    readonly toolSet: unknown
    readonly signal: AbortSignal
  }): Promise<{ readonly sections: readonly unknown[]; readonly tools: readonly JsonValue[] }>
  section(section: { readonly name: string; readonly order: number; readonly text: string }): () => void
}

/** `ctx.subagents.startActivation` subset used by subagent nodes (docs/subsystems/subagent.md). */
export interface SubagentsPort {
  startActivation(spec: {
    readonly provider: string
    readonly label: string
    readonly request: {
      readonly parent: unknown
      readonly prompt: readonly { readonly type: 'text'; readonly text: string }[]
      readonly signal: AbortSignal
      readonly agentPreset?: string
      readonly agentOptions?: { readonly provider?: string; readonly model?: string }
      readonly outputSchema?: JsonValue
      readonly maxDepth?: number
    }
    readonly delivery: 'parent' | 'caller'
  }): Promise<{
    readonly childId: string
    readonly messageId?: string
    readonly result: Promise<{
      readonly output?: readonly { readonly type: 'text'; readonly text: string }[]
      readonly structured?: JsonValue
      readonly stopReason: 'completed' | 'failed' | 'cancelled' | 'limit'
    }>
    readonly dispose: () => Promise<void>
  }>
}

/** `ctx.sessions` subset; the driver is the only writer during an `explore` turn. */
export interface SessionPort {
  readonly seq: number
  append(type: string, data: JsonValue, options?: { readonly surfaceOp?: JsonValue }): void
  deriveMessages(): readonly unknown[]
  flush(): Promise<void>
}

export interface TokenMeterPort {
  measure(session: unknown): {
    readonly totalTokens: number
    readonly contextBreakdown?: { readonly systemTokens: number; readonly toolsTokens: number; readonly messageTokens: number }
  }
}

export interface DshPort {
  readonly agent: AgentPort
  readonly tools: ToolsPort
  readonly systemPrompt: SystemPromptPort
  readonly subagents: SubagentsPort
  readonly session: SessionPort
  readonly tokenMeter: TokenMeterPort
  readonly signal: AbortSignal
  readonly determinism: DeterminismHooks
  readonly log: (level: 'debug' | 'info' | 'warn' | 'error', message: string) => void
}

// ---------------------------------------------------------------------------
// Superstep <-> session event mapping (normative)
// ---------------------------------------------------------------------------

/**
 * THE MAPPING. One turn is one graph run; each superstep is one DSH step.
 *
 * DSH order (docs/architecture.md and packages/core/agent-loop/src/agent.ts in the
 * DSH checkout):
 *   turn/start -> [step/start -> request/header -> assistant/message
 *                  -> tool/call* -> tool/result* -> step/end]* -> turn/end
 *
 * Graph loop:
 *   run start                 driver appends turn/start, then step/start for superstep 0
 *   step node                 driver runs the step pipeline (below) inside the open step
 *   subagent node(s)          child activations run concurrently between parent steps; each
 *                             completion injects one `subagent-result` user message into
 *                             the parent, and no parent model request is logged for the batch
 *   onBoundary(superstep k)   step/end (closes k) + step/start (opens k+1); on run end only
 *                             step/end, then turn/end
 *   human gate                `ask_user_question` tool call inside a step (never kernel
 *                             `interrupt()`, which re-runs the node body — kernel C4)
 *   replan                    between runs of the same turn: kernel.withTopology + compact
 *                             user/message banner appended at the boundary
 *   run done                  turn/end; graph state is discarded (C5)
 *
 * The canonical table is `SUPERSTEP_EVENT_MAP` in `graph-schema.ts`; keep this
 * prose and that table in sync instead of adding a third copy.
 *
 * @deprecated Not consulted at runtime. The values below predate the shipped
 * subagent path (which emits DSH's `subagent/catalog`/`subagent/descriptor` and an
 * injected `subagent-result` message, not a synthetic `graph:delegate` tool call);
 * use `SUPERSTEP_EVENT_MAP` in `graph-schema.ts`.
 */
export const SUPERSTEP_MAPPING = {
  runStart: ['turn/start', 'step/start'],
  stepNode: ['request/header', 'assistant/message', 'tool/call', 'tool/result'],
  subagentNode: ['tool/call(graph:delegate)', 'subagent/catalog', 'tool/result(structured)'],
  boundary: ['step/end', 'step/start'],
  runEnd: ['step/end', 'turn/end'],
  humanGate: ['tool/call', 'tool/result'],
  replan: ['user/message'],
} as const

/**
 * The exact order a step executor must follow. Mirrors the stock loop so that
 * `agent/pre-step` listeners (compaction-basic, plan-mode, agent-instructions) and
 * every persisted event keep working. Deviation is a conformance bug.
 */
export const STEP_PIPELINE_ORDER = [
  'node.policy',
  'tools.resolve',
  'systemPrompt.assemble',
  'agent/pre-step',
  'step/start',
  'llm.prepareCall',
  'system/message',
  'user/message',
  'request/header',
  'request/context',
  'deriveMessages.freeze',
  'llm.stream',
  'tools.pre-execute',
  'tools.execute',
  'tools.post-execute',
  'tool/result',
  'step/end',
] as const

// ---------------------------------------------------------------------------
// Kernel port layer (implemented in packages/loop/src/kernel/)
// ---------------------------------------------------------------------------

/**
 * Why a run paused. A pause is only ever observed at a node boundary, never
 * inside one (kernel C4).
 */
export type PauseReason = 'user-input' | 'human-gate' | 'replan' | 'budget' | 'error'

/** Durable coordinates of the boundary a paused/finished run stopped at. */
export interface NodeBoundaryRef {
  readonly superstep: number
  /** Session seq after which the checkpoint is consistent. */
  readonly atSeq: number
  readonly closedBy: 'step-end' | 'injected-result' | 'turn-end' | 'fork'
}

export type KernelResult =
  | { readonly kind: 'boundary'; readonly nodeId: string; readonly boundary: NodeBoundaryRef; readonly state: GraphState }
  | { readonly kind: 'paused'; readonly reason: PauseReason; readonly state: GraphState }
  | { readonly kind: 'done'; readonly state: GraphState; readonly terminal: string }
  | { readonly kind: 'failed'; readonly state: GraphState; readonly error: NodeFailure }

/**
 * One running graph for one turn. `kernel.ts`'s `createLangGraphKernel` returns
 * this handle; the driver never touches a LangGraph object.
 */
export interface KernelRunHandle {
  readonly runId: string
  readonly planId: string
  /** Drive until the next boundary, pause, completion, or failure. */
  next(): Promise<KernelResult>
  /** Replan: swap topology and resume the same thread (kernel recompiles). */
  updateState(patch: Partial<GraphState>): Promise<void>
  snapshot(): GraphState
  dispose(): Promise<void>
}

/**
 * The driver-facing kernel. `packages/loop/src/kernel/` owns the LangGraph
 * adapter that satisfies it (`createLangGraphKernel(deps): KernelPort`) and the
 * structural `LangGraphSurface` port that keeps `packages/core` dependency-free.
 *
 * Required semantics (from kernel.ts and the kernel tests):
 * - `compile` is pure and deterministic for a given plan + compiledDigest;
 * - checkpoint payloads are JSON only, enforced before writes;
 * - `updateState` + a recompiled graph is the ONLY way to add/remove nodes;
 * - no `interrupt()` inside a node body: human gates are DSH tool calls or terminals.
 */
export interface KernelPort {
  compile(plan: TaskPlan, state: GraphState): KernelRunHandle
  resume(plan: TaskPlan, state: GraphState): KernelRunHandle
  /** Authoritative log-fold checkpointer; the storage-domain rows are a cache. */
  readonly checkpointer: {
    load(sessionId: string, atSeq: number): Promise<GraphState | undefined>
    put(sessionId: string, atSeq: number, state: GraphState): Promise<void>
  }
}

// ---------------------------------------------------------------------------
// Node executors
// ---------------------------------------------------------------------------

export interface NodeOutcome {
  readonly ok: boolean
  readonly update: JsonUpdate
  readonly facts: { readonly [key: string]: JsonValue }
  readonly artifacts: readonly { readonly type: string; readonly ref: string; readonly hash?: string }[]
  readonly failure?: NodeFailure
  /** Session seq range written by this node. */
  readonly atSeq: number
}

export interface NodeFailure {
  readonly code: 'tool-failed' | 'validation-failed' | 'context-overflow' | 'budget-exceeded' | 'subagent-failed' | 'cancelled' | 'graph-error'
  readonly nodeId: string
  readonly message: string
  readonly retryable: boolean
}

export interface NodeExecuteContext {
  readonly plan: TaskPlan
  readonly node: PlanNode
  readonly state: LoopState
  readonly superstep: number
  readonly port: DshPort
  readonly siblings: readonly string[]
}

/**
 * A node body bound to the real per-step pipeline (`step`) or a child activation
 * (`subagent`). The kernel adapter takes one executor per kind
 * (`LangGraphKernelDeps.executors`) and calls `execute` for the matching node.
 */
export interface NodeExecutorPort {
  readonly kind: NodeExecutor
  execute(node: PlanNode, context: NodeExecuteContext): Promise<NodeOutcome>
}

/** @deprecated use NodeExecutorPort */
export type NodeRunner = NodeExecutorPort

/** The step-level policy the driver applies before preparing the step. */
export interface StepNodePolicy {
  readonly nodeId: string
  readonly model?: ModelSelection
  readonly instruction: string
  readonly toolAllow: readonly string[]
  readonly hardGate: boolean
  readonly validate?: string
}

export function policyOf(node: PlanNode): StepNodePolicy {
  return {
    nodeId: node.id,
    ...(node.model ? { model: node.model } : {}),
    instruction: node.instruction ?? '',
    toolAllow: node.toolAllow ?? [],
    hardGate: node.hardGate === true,
    ...(node.validate ? { validate: node.validate } : {}),
  }
}

/**
 * Build the subagent node body: handoff in, structured result out, sized and JSON-only.
 * Rejecting oversized handoffs *before* activation is what keeps checkpoint state bounded.
 */
export function buildHandoffPrompt(node: PlanNode, input: JsonValue): { readonly text: string; readonly bytes: number } {
  if (!node.subagent) throw new Error(`node ${node.id} has no subagent spec`)
  const text = `[graph:${node.id}] input=${JSON.stringify(input)}`
  return { text, bytes: new TextEncoder().encode(text).length }
}

// ---------------------------------------------------------------------------
// Driver contract
// ---------------------------------------------------------------------------

/** One graph run == one DSH turn. Built once per turn by the Agent. */
export interface TurnRun {
  readonly runId: string
  readonly plan: TaskPlan
  readonly handle: KernelRunHandle
  readonly route: RouteDecision
  /** Drives the run to its next boundary, interrupt, or completion. */
  step(): Promise<KernelResult>
  /** Replan between segments: recompile the plan and resume the same thread. */
  replan(nextPlan: TaskPlan): Promise<void>
  dispose(): Promise<void>
}

/**
 * The driver the AgentFactory returns. Everything DSH-specific that the loop owns
 * (session write handle, inbox, turn queue, injections) stays outside the graph;
 * this object only owns the graph lifecycle.
 */
export interface GraphLoopDriver {
  /** Begin a turn: match once, compile the plan, append turn/start, open step 0. */
  beginTurn(input: {
    readonly taskText: string
    readonly presetId: string
    readonly taskHash: string
    readonly port: DshPort
  }): Promise<TurnRun>
  /** Resume a paused run at the next turn boundary with new user input. */
  resumeTurn(run: TurnRun, input: { readonly text: string; readonly port: DshPort }): Promise<TurnRun>
  /** Build the kernel for one plan. Pure; deterministic for a compiledDigest. */
  buildKernel(plan: TaskPlan, registry: RegistryGraph, port: DshPort): KernelPort
  /** Called by the kernel between supersteps; owns step/end + step/start appends. */
  onBoundary(run: TurnRun, boundary: SuperstepBoundary): Promise<void>
}

/** Kernel errors that end a turn rather than a node. */
export function isFatalKernelError(error: KernelError): boolean {
  return error.code === 'ABORTED' || error.code === 'INVALID_GRAPH' || error.code === 'STEP_BUDGET_EXCEEDED'
    || error.code === 'BAD_NODE_ID'
}

/** Kernel step counter is the DSH step index inside the turn (kernel NodeContext.step). */
export function dshStepOf(context: NodeContext<LoopState>): number {
  return context.step
}

// ---------------------------------------------------------------------------
// Budgets and configuration
// ---------------------------------------------------------------------------

export interface RunEnvelope {
  readonly maxSupersteps: number
  readonly maxSteps: number
  readonly maxTokens: number
  readonly maxWallMs: number
  readonly maxReplans: number
}

export const DEFAULT_ENVELOPE: RunEnvelope = {
  maxSupersteps: 40,
  maxSteps: 40,
  maxTokens: 400_000,
  maxWallMs: 30 * 60_000,
  maxReplans: 3,
}

/**
 * `explore` is a bundle + profile mode. An out-of-tree plugin cannot add a
 * SessionEventMap type, and the factory slot is process-global (`setFactory`
 * throws when occupied — packages/core/agent/src/index.ts), so a profile patch
 * disables the `agent-loop` row and mounts `dsh-graph-loop`. `stock` runs the
 * degenerate single-node graph (t_stock) and is the in-process A/B control arm:
 * same driver, same seam usage, no routing.
 */
export type GraphMode = 'off' | 'observe' | 'stock' | 'explore'

export interface GraphLoopConfig {
  readonly mode: GraphMode
  readonly plan: 'stock' | 'explore'
  readonly registry: { readonly refreshDebounceMs: number; readonly annotationPath?: string }
  readonly routing: {
    readonly confidenceAbsMin: number
    readonly confidenceMarginMin: number
    readonly fallbackTemplate: string
    readonly cacheEntries: number
  }
  readonly gatePolicy: 'cold' | 'turn' | 'never'
  readonly envelope: RunEnvelope
  /** Kernel checkpointer is in-turn memory (kernel C5); persistence is debugging only. */
  readonly checkpoint: { readonly kind: 'in-turn-memory'; readonly maxCheckpointsPerThread: number }
}

export const DEFAULT_GRAPH_CONFIG: GraphLoopConfig = {
  mode: 'explore',
  plan: 'explore',
  registry: { refreshDebounceMs: 50 },
  routing: { confidenceAbsMin: 0.55, confidenceMarginMin: 0.08, fallbackTemplate: 't_default', cacheEntries: 256 },
  gatePolicy: 'cold',
  envelope: DEFAULT_ENVELOPE,
  checkpoint: { kind: 'in-turn-memory', maxCheckpointsPerThread: 64 },
}
