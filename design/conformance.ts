/**
 * conformance.ts — what the `explore` driver must preserve, and what it may change.
 *
 * This file is executable design: the shipped bundle turns `CONFORMANCE_ITEMS`
 * into the test-suite manifest, and `validateDurableOrder` runs in the adapter's
 * development mode over every produced event stream. Keeping it typed means the
 * design doc and the tests cannot drift.
 *
 * Baseline: `@deepseek-ai/dsh-agent-loop` (packages/core/agent-loop). The graph
 * loop replaces the *driver*, never the session format, the prompt-admission
 * rules, or the tool pipeline semantics.
 */

export type ConformanceKind = 'preserved' | 'deliberate-delta'

export interface ConformanceItem {
  readonly id: string
  readonly kind: ConformanceKind
  readonly title: string
  readonly requirement: string
  /** Where the stock behavior is defined, for the reviewer and the test author. */
  readonly evidence: string
  /** How the test suite proves it. */
  readonly test: 'replay-diff' | 'unit' | 'integration' | 'property'
}

export const CONFORMANCE_ITEMS: readonly ConformanceItem[] = [
  // ---- preserved: event stream ------------------------------------------------
  {
    id: 'C01',
    kind: 'preserved',
    title: 'durable event order and enclosure',
    requirement:
      'Every model request lives inside exactly one open step: turn/start -> step/start -> request/header -> ... -> step/end -> turn/end. No surface event outside an open turn; no tool/call without its tool/result before step/end.',
    evidence: 'docs/architecture.md:83-104; docs/subsystems/session.md; packages/core/session/src/index.ts:401-406',
    test: 'replay-diff',
  },
  {
    id: 'C02',
    kind: 'preserved',
    title: 'request/header canonical snapshot',
    requirement:
      'Same fields (config, adapterDefaults, tools), same reason enum (initial|resume|change|series), same inheritance: unchanged steps/retries inherit the latest header; a changed route or tool declaration writes a new snapshot.',
    evidence: 'packages/core/session/README.md#request-headers',
    test: 'replay-diff',
  },
  {
    id: 'C03',
    kind: 'preserved',
    title: 'request/context only on route change',
    requirement: 'provider, model, contextWindow or systemPromptUpdate differ -> one request/context; otherwise none.',
    evidence: 'packages/core/agent-loop/README.md#request-headers-and-adapter-defaults',
    test: 'replay-diff',
  },
  {
    id: 'C04',
    kind: 'preserved',
    title: 'system prompt admission',
    requirement:
      'The rendered prompt is a system/message surface node. Head consolidation vs in-history append follows the prepared call capability; an empty rendering clears every active system node through logged empty replacements; no older prompt stays model-visible.',
    evidence: 'packages/core/agent-loop/README.md#turn-and-step-flow; packages/core/session/README.md',
    test: 'replay-diff',
  },
  {
    id: 'C05',
    kind: 'preserved',
    title: 'tool schema projection',
    requirement:
      'Model-visible schemas are the allowlisted projection of the visible definitions, in toolOrder (or lexicographic) order; no execution, timeout or presentation callbacks leak onto the wire.',
    evidence: 'packages/core/tools/README.md#design-concept; docs/subsystems/system-prompt.md',
    test: 'unit',
  },
  {
    id: 'C06',
    kind: 'preserved',
    title: 'tool result rendering and failure shape',
    requirement:
      'A denied or thrown call is exactly `Error: <message>`; PTC mode keeps its printed-line/return rendering; tool results keep model-order and are logged as tool/result with their presentation metadata.',
    evidence: 'packages/core/tools/README.md#model-experience',
    test: 'unit',
  },
  {
    id: 'C07',
    kind: 'preserved',
    title: 'developer/message on tool-set change',
    requirement:
      'When the visible tool names differ from the previous request header, one developer/message records additions (with headerSeq) and removals; nothing is emitted when they match.',
    evidence: 'docs/persistence-catalog.md#developermessage--surface',
    test: 'replay-diff',
  },
  {
    id: 'C08',
    kind: 'preserved',
    title: 'inbox and injection semantics',
    requirement:
      'followup/steer/inject keep their wake and claim semantics; every inbox mutation commits one agent/inbox/spliced event with the standard splice coordinates; injected context is claimed at the nearest later step boundary and may miss one already-claimed batch.',
    evidence: 'packages/core/agent/README.md#durable-inbox',
    test: 'integration',
  },
  {
    id: 'C09',
    kind: 'preserved',
    title: 'cancellation',
    requirement:
      'Cancellation aborts the active activity, records the cause in turn/end, finalizes streamed text, and emits synthetic tool/call + ABORTED_BEFORE_DISPATCH results for undispatched calls; keepInbox semantics unchanged.',
    evidence: 'packages/core/agent-loop/README.md#failure-and-cancellation',
    test: 'integration',
  },
  {
    id: 'C10',
    kind: 'preserved',
    title: 'failed-step recovery',
    requirement:
      'Before a failed step closes, each unanswered model tool call gets a durable result (TOOL_OUTCOME_UNKNOWN for a recorded call, TOOL_NOT_STARTED otherwise); committed results are never rewritten.',
    evidence: 'packages/core/agent-loop/README.md#failure-and-cancellation; packages/core/session/README.md#shared-recovery',
    test: 'integration',
  },
  {
    id: 'C11',
    kind: 'preserved',
    title: 'model selection is per-step and durable',
    requirement:
      'The route is fixed at step preparation and retained across retries; a change records model/selection and applies to the next prepared step; an absent reasoning effort uses adapter defaults.',
    evidence: 'packages/core/agent/README.md#model-selection',
    test: 'replay-diff',
  },
  {
    id: 'C12',
    kind: 'preserved',
    title: 'pre-step waterfall',
    requirement:
      'Assembly runs before agent/pre-step; the waterfall receives the claimed batch and returns reject or enter(messages, startsRequestSeries); a wrapped listener preserves the declaration. Compaction, plan-mode and instruction plugins keep working.',
    evidence: 'packages/core/agent/README.md#step-admission; packages/core/agent-loop/src/agent.ts:278-296',
    test: 'integration',
  },
  {
    id: 'C13',
    kind: 'preserved',
    title: 'compaction integration',
    requirement:
      'Automatic and manual condensation keep their brackets (compaction/start|summary|end), the single surface replacement, and the token meter decisions; the graph loop must not bypass compaction.',
    evidence: 'packages/compaction/compaction/README.md#the-surface-contract',
    test: 'integration',
  },
  {
    id: 'C14',
    kind: 'preserved',
    title: 'persistence lifecycle',
    requirement:
      'The driver is the write-handle acquisition point: persistence.create/open("write") before publication, closing events committed before handle close, session/flush barriers honored, interrupted-turn closers appended on resume.',
    evidence: 'packages/core/agent-loop/README.md#persistence-integration',
    test: 'integration',
  },
  {
    id: 'C15',
    kind: 'preserved',
    title: 'turn stopping and steering drain',
    requirement:
      'agent/turn-stopping runs when no tool or steering continuation exists, before one final steering drain; a listener may steer the turn open. A terminal graph node ends the turn through this path, not by skipping it.',
    evidence: 'docs/architecture.md:106; packages/core/agent/README.md',
    test: 'integration',
  },
  {
    id: 'C16',
    kind: 'preserved',
    title: 'live UI events',
    requirement:
      'agent/status transitions and agent/assistant-stream frames keep their shapes; the committed assistant/message embeds the compact stream before the end frame.',
    evidence: 'packages/core/agent/README.md#intercept-or-observe-work-in-flight',
    test: 'integration',
  },

  // ---- deliberate deltas ------------------------------------------------------
  {
    id: 'D01',
    kind: 'deliberate-delta',
    title: 'step selection is graph-driven',
    requirement:
      'After a step, the next step is chosen by the plan (node + edge), not by "continue until the model stops calling tools". The observable difference is which instruction, tool policy and model the next step gets.',
    evidence: 'design/runtime.ts#SUPERSTEP_MAPPING',
    test: 'replay-diff',
  },
  {
    id: 'D02',
    kind: 'deliberate-delta',
    title: 'per-node model selection',
    requirement:
      'A node may pin provider/model/effort. This produces more model/selection events and more request/header `change` snapshots than a stock session, and may reduce cache reuse across nodes.',
    evidence: 'design/graph-schema.ts#PlanNode.model',
    test: 'replay-diff',
  },
  {
    id: 'D03',
    kind: 'deliberate-delta',
    title: 'node instruction is a user message',
    requirement:
      'Each node appends one short user/message (source kind `graph-loop`) carrying its instruction, instead of rewriting the system prompt. Append-only so the prefix stays cached; costs ~80-150 tokens per node (measured target: < 120).',
    evidence: 'design/replan.ts#renderMutationBanner',
    test: 'replay-diff',
  },
  {
    id: 'D04',
    kind: 'deliberate-delta',
    title: 'synthetic delegation tool calls',
    requirement:
      'A subagent node runs inside one parent step with no model request: the driver logs one synthetic tool/call named `graph:delegate` per branch and one tool/result carrying the structured output. Consumers see a step whose call was loop-initiated.',
    evidence: 'design/runtime.ts#SUPERSTEP_MAPPING',
    test: 'unit',
  },
  {
    id: 'D05',
    kind: 'deliberate-delta',
    title: 'tool policy per plan (cold-gated)',
    requirement:
      'The visible tool set is the plan toolUniverse. It is applied at cold boundaries only by default; per-node narrowing is soft (guard denials), so the request prefix stays stable inside a run.',
    evidence: 'design/replan.ts#decideHardGate',
    test: 'replay-diff',
  },
  {
    id: 'D06',
    kind: 'deliberate-delta',
    title: 'early terminal turns',
    requirement:
      'A plan may route to a terminal node before the model would have stopped. The turn ends through agent/turn-stopping, with turn/end reason `completed`; the plan banner records why.',
    evidence: 'design/graph-schema.ts#PlanNodeKind',
    test: 'replay-diff',
  },
  {
    id: 'D07',
    kind: 'deliberate-delta',
    title: 'plan banner',
    requirement:
      'One ~40-token user/message at plan start and one per replan (`[graph] plan=… v… step=…`). Never per node.',
    evidence: 'design/runtime.ts',
    test: 'replay-diff',
  },
  {
    id: 'D08',
    kind: 'deliberate-delta',
    title: 'graph state is not logged',
    requirement:
      'Graph state lives only in the in-turn checkpointer (kernel C5) and is reconstructed by deterministic log fold when the driver restarts mid-turn; a checkpoint is never a source of model-visible facts.',
    evidence: 'design/kernel.ts C3/C5',
    test: 'property',
  },
]

/**
 * Decisions that are not covered by "preserve" or "delta" because they define the
 * mapping itself. They are the review checklist for the session-format owner.
 */
export interface ConformanceDecision {
  readonly id: string
  readonly title: string
  readonly decision: string
  readonly alternative: string
  readonly risk: string
}

export const CONFORMANCE_DECISIONS: readonly ConformanceDecision[] = [
  {
    id: 'CD-1',
    title: 'one superstep = one DSH step',
    decision: 'The kernel boundary callback emits step/end then step/start, so the log has exactly one open step at a time and the step index equals the superstep index.',
    alternative: 'Let nodes span steps or pack several supersteps into one step (breaks ToolCallRecovery and the UI step counter).',
    risk: 'A parallel superstep closes a step with several tool calls; recovery already handles unanswered calls.',
  },
  {
    id: 'CD-2',
    title: 'parallel branches are subagent nodes',
    decision: 'A parallel superstep contains only executor=subagent nodes; they run as concurrent child activations in one parent step.',
    alternative: 'Concurrent steps in one session (impossible today: the driver runs one step at a time).',
    risk: 'Child cost and UI clutter; bounded by maxActiveSubagents (default 8).',
  },
  {
    id: 'CD-3',
    title: 'delegation-only steps',
    decision: 'A subagent node runs inside a parent step with no model request: synthetic tool/call `graph:delegate` + tool/result(structured), then step/end.',
    alternative: 'No step at all for delegation-only supersteps (needs step-enclosure exceptions in ToolCallRecovery and the step counter).',
    risk: 'The Web UI renders a tool card for a call the model did not emit; verify rendering and approval display.',
  },
  {
    id: 'CD-4',
    title: 'plan banner is a user message',
    decision: 'One short user/message (source kind graph-loop) at plan start and per replan; append-only.',
    alternative: 'A system-prompt section rewritten per plan (invalidates the prefix from node 0).',
    risk: 'The banner appears in the user-visible transcript; keep it under ~40 tokens.',
  },
]

/** Allowed-diff normalizer ids used by the replay-diff harness. */
export const ALLOWED_DELTA_TYPES: readonly string[] = [
  'user/message:graph-instruction',
  'user/message:graph-banner',
  'tool/call:graph-delegate',
  'tool/result:graph-delegate',
  'model/selection',
  'request/header:tools',
  'developer/message:tools',
]

// ---------------------------------------------------------------------------
// Event-order validator (runs in dev builds and in the property test)
// ---------------------------------------------------------------------------

export interface OrderViolation {
  readonly code: string
  readonly index: number
  readonly message: string
}

/**
 * Check the durable event sequence produced by one turn against C01/C02/C10.
 * `types` are event type strings in append order. Pure; O(n).
 */
export function validateDurableOrder(types: readonly string[]): readonly OrderViolation[] {
  const violations: OrderViolation[] = []
  let turnOpen = false
  let stepOpen = false
  const openCalls = new Set<string>()
  let lastHeaderSeq = -1

  for (const [index, type] of types.entries()) {
    switch (type) {
      case 'turn/start':
        if (turnOpen) violations.push({ code: 'O01', index, message: 'turn/start inside an open turn' })
        turnOpen = true
        stepOpen = false
        break
      case 'step/start':
        if (!turnOpen) violations.push({ code: 'O02', index, message: 'step/start outside a turn' })
        if (stepOpen) violations.push({ code: 'O03', index, message: 'step/start inside an open step' })
        stepOpen = true
        break
      case 'request/header':
        if (!stepOpen) violations.push({ code: 'O04', index, message: 'request/header outside an open step' })
        lastHeaderSeq = index
        break
      case 'tool/call':
        if (!stepOpen) violations.push({ code: 'O05', index, message: 'tool/call outside an open step' })
        openCalls.add(`${index}`)
        break
      case 'tool/result':
        if (!stepOpen) violations.push({ code: 'O06', index, message: 'tool/result outside an open step' })
        openCalls.clear()
        break
      case 'step/end':
        if (!stepOpen) violations.push({ code: 'O07', index, message: 'step/end without an open step' })
        if (openCalls.size > 0) violations.push({ code: 'O08', index, message: 'step/end with unanswered tool calls' })
        stepOpen = false
        break
      case 'turn/end':
        if (!turnOpen) violations.push({ code: 'O09', index, message: 'turn/end without an open turn' })
        if (stepOpen) violations.push({ code: 'O10', index, message: 'turn/end with an open step' })
        turnOpen = false
        break
      default:
        break
    }
  }
  if (turnOpen) violations.push({ code: 'O11', index: types.length, message: 'turn left open' })
  void lastHeaderSeq
  return violations
}

/**
 * Replay-diff harness contract. The suite mounts `@deepseek-ai/dsh-llm-replay`
 * with the same fixture under the stock profile and the `explore` profile, then
 * diffs the two session logs:
 *
 *  1. decode both logs; drop the allowed-delta events (ALLOWED_DELTA_TYPES);
 *  2. normalize volatile envelopes (seq/time/ids) and tool schemas that differ
 *     only because of D05 (compare the tool *names* set, not the declaration order);
 *  3. require identical turn/start, step/start, assistant/message content,
 *     tool/call arguments, tool/result content, step/end, turn/end counts and order;
 *  4. report the first divergence with both payloads.
 *
 * Fixtures needed: a read-only question, a failing-test fix, a cancelled turn,
 * a compaction mid-run, an ask_user gate, and a subagent fan-out.
 */
export const REPLAY_DIFF_PLAN = {
  fixtures: ['read-only-question', 'failing-test-fix', 'cancelled-turn', 'compaction-mid-run', 'ask-user-gate', 'subagent-fanout'],
  normalizers: ['strip-volatile-envelope', 'strip-allowed-deltas', 'compare-tool-name-sets'],
  gate: 'zero divergence outside ALLOWED_DELTA_TYPES',
} as const
