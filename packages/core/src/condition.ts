/**
 * condition.ts — the one runtime evaluator for plan edge guards.
 *
 * `Condition` is part of the plan schema, but a condition the runtime cannot
 * evaluate is worse than no condition: the edge silently never fires and the
 * graph degrades into a chain. This module is the single implementation used by
 * both `FrontierTopology` and the kernel route hook, so every declared operator
 * (artifact, noArtifact, fact, callFailed, budget, always) has the same meaning
 * in both engines.
 *
 * Pure and dependency-free: it reads a projected `RoutingState`, never the
 * session, the clock, or the filesystem.
 * @module dsh-graph-loop-core/condition
 */

import type { AnswerRecord, ArtifactType, Condition, Json, NodeEvidenceContract, ObligationRecord } from './graph-schema.ts'

/**
 * One artifact reference as the router sees it (never a file body).
 *
 * `bytes` is a runtime measurement: the loop observed this ref in the world
 * (statted the path at the step boundary). A ref without `bytes` was never
 * observed, so it cannot certify anything.
 */
export interface RoutingArtifact {
  readonly type: ArtifactType
  readonly ref: string
  readonly hash?: string
  readonly bytes?: number
}

/**
 * Parameter names that are typed locators: a capability declaring one of these
 * takes a path/artifact target in a named field. The runtime resolves the
 * field's value to an observed artifact; nothing else about a call's arguments
 * is ever read as evidence.
 */
export const LOCATOR_PARAMETER_NAMES: readonly string[] = ['file_path', 'filePath', 'path', 'target']

/**
 * Remaining capacity the `budget` condition compares against.
 *
 * Only the step axis has a producer: both engines derive `stepsRemaining` from
 * the plan's `maxSteps`. Token and wall capacity exist on the plan
 * (`TaskBudget.maxTokens` / `maxWallMs`) but nothing measures consumption at a
 * step boundary, so they are not routing axes. They were removed from
 * `Condition` rather than left as guards that can never fire.
 */
export interface RoutingBudget {
  readonly stepsRemaining: number
}

/** Projected state a route decision is allowed to read. */
export interface RoutingState {
  readonly facts: Readonly<Record<string, Json>>
  readonly artifacts: readonly RoutingArtifact[]
  readonly budget: RoutingBudget
}

/** True when the guard passes for this state. An absent guard is unconditional. */
export function evaluateCondition(when: Condition | undefined, state: RoutingState): boolean {
  if (when === undefined) return true
  switch (when.op) {
    case 'always':
      return true
    case 'artifact':
      return state.artifacts.some(artifact => artifact.type === when.type)
    case 'noArtifact':
      return !state.artifacts.some(artifact => artifact.type === when.type)
    case 'fact':
      return state.facts[when.key] === when.equals
    case 'callFailed': {
      if (state.facts['lastOk'] !== false) return false
      const failedTool = state.facts['failedTool']
      // A failed step without a tool name can take any recovery edge; when the
      // step names the tool, only the matching edge may fire. `failedTool` is
      // only projected for configured shell tools today, so for a non-shell
      // failure this is equivalent to `fact lastOk=false`; use that operator when
      // the failure should be tool-agnostic.
      return typeof failedTool !== 'string' || failedTool === when.tool
    }
    case 'budget':
      // `axis` is `steps` only: the token/wall axes have no producer, so they
      // are not part of the routing schema (see `RoutingBudget`).
      return state.budget.stepsRemaining <= when.remainingAtMost
    default: {
      // Exhaustiveness: a new operator added to `Condition` must be handled
      // here, not silently treated as false.
      const unreachable: never = when
      return unreachable
    }
  }
}

/** One tool call as the evidence evaluator sees it. */
export interface EvidenceCall {
  readonly tool: string
  readonly ok: boolean
  /** True when this tool reports a process exit status (`[exit code: N]`). */
  readonly reportsExit?: boolean
  /** Last exit status the tool reported; absent when it reported none. */
  readonly exitCode?: number
  /**
   * Values of this call's *declared locator parameters* (see
   * `LOCATOR_PARAMETER_NAMES`). A verifier is attributed to an artifact only
   * when one of these values is exactly an observed prior artifact ref; the
   * arguments' free text is never inspected.
   */
  readonly locators?: readonly string[]
}

/**
 * Node-scoped step evidence a node's declared evidence contract is evaluated
 * against. `produced` is what *this* step left behind; `prior` is what earlier
 * steps of the same run left behind, which is what a verifier must have touched.
 */
export interface NodeEvidenceView {
  readonly produced: readonly RoutingArtifact[]
  readonly prior: readonly RoutingArtifact[]
  readonly calls: readonly EvidenceCall[]
  /** Tool name of the node's declared capability, when the node names one. */
  readonly capabilityTool?: string
}

/**
 * The one predicate for "did this node's own step satisfy the evidence it
 * declared" (F1-F4, audit 20261111-1200).
 *
 * A node's success is never an aggregate step signal: it is the node's declared
 * contract (`PlanNode.evidence`) evaluated against the refs and calls attributed
 * to that node's own step. No contract means no satisfiable evidence, so an
 * undeclared node cannot certify success.
 *
 * - `expects`: every spec with `required: true` needs one *observed* produced
 *   ref of that type; with no required spec, at least one declared type must
 *   appear. This is any-of on purpose: an `edit` mutates a `file.text` and
 *   produces a `file.patch`, and either is a real mutation outcome. A ref the
 *   runtime never measured in the world is not an outcome.
 * - `verifier`: the node's declared capability must have run this step with a
 *   clean status and addressed a ref an *earlier* step produced through one of
 *   its declared locator parameters, by exact value. A tool call that does not
 *   name the run's artifact in a typed field is activity, not verification --
 *   even when the artifact's path appears in its free text.
 */
export function satisfiesNodeEvidence(
  contract: NodeEvidenceContract | undefined,
  view: NodeEvidenceView,
): boolean {
  if (contract === undefined) return false
  const expects = contract.expects ?? []
  if (expects.length > 0) {
    const producedTypes = new Set(view.produced
      .filter(artifact => artifact.bytes !== undefined)
      .map(artifact => artifact.type))
    const required = expects.filter(spec => spec.required)
    const satisfied = required.length > 0
      ? required.every(spec => producedTypes.has(spec.type))
      : expects.some(spec => producedTypes.has(spec.type))
    if (!satisfied) return false
  }
  if (contract.verifier === true) {
    if (view.prior.length === 0) return false
    const verified = view.calls.some(call => {
      if (!call.ok) return false
      // The node's declared capability is the only verifier whose run can
      // certify the node; an unrelated clean call is activity, not proof.
      if (view.capabilityTool !== undefined && call.tool !== view.capabilityTool) return false
      // A tool that reports an exit status must report zero; a tool without
      // exit status (MCP/craft verifier) has only its own result as status.
      if (call.reportsExit === true && call.exitCode !== 0) return false
      // Attribution is typed and exact: a declared locator argument must name
      // an artifact the run observed. A shell whose target lives in free-text
      // `command` has no locator, so it can never be attributed.
      const locators = call.locators ?? []
      if (locators.length === 0) return false
      return view.prior.some(artifact =>
        artifact.bytes !== undefined
        && artifact.ref.length > 0
        && locators.some(locator => locator === artifact.ref))
    })
    return verified
  }
  return expects.length > 0
}

/**
 * The typed answer rule (audit 20261112-0800 F5).
 *
 * A turn may complete only on an {@link AnswerRecord}: non-empty text, no real
 * tool calls in the answering step, and an evidence ref for every obligation the
 * run recorded as satisfied. The terminal's prose is never inspected — printed
 * tool-call syntax carries no evidence refs and is refused by the refs rule, not
 * by a keyword scan.
 *
 * @param record - the record the driver built from the terminal step, if any.
 * @param obligations - every obligation the run recorded (required by construction).
 * @param requiresText - false for callers with no session-backed text reader, where
 *   text fidelity is not claimable; the refs and tool-call rules still apply.
 * @returns the first structural problem, or undefined when the record is admissible.
 */
export function answerRecordProblem(
  record: AnswerRecord | undefined,
  obligations: readonly ObligationRecord[],
  requiresText: boolean,
): AnswerProblem | undefined {
  if (record === undefined) {
    return { code: 'missing-record', detail: 'the terminal step produced no answer record' }
  }
  if (requiresText && record.text.trim().length === 0) {
    return { code: 'empty-text', detail: 'the terminal step produced no answer text' }
  }
  if (record.toolCalls !== 0) {
    return { code: 'tool-calls', detail: `the answering step issued ${String(record.toolCalls)} tool call(s)` }
  }
  for (const obligation of obligations) {
    if (!obligation.satisfied) {
      return { code: 'unmet-obligation', detail: `required work at ${obligation.nodeId} was not done` }
    }
    if (!record.evidenceRefs.includes(obligation.nodeId)) {
      return { code: 'missing-ref', detail: `the answer does not cite ${obligation.nodeId}` }
    }
  }
  return undefined
}

/** One structural reason the terminal answer was refused. */
export interface AnswerProblem {
  readonly code: 'missing-record' | 'empty-text' | 'tool-calls' | 'unmet-obligation' | 'missing-ref'
  readonly detail: string
}

/**
 * Order edges for evaluation without changing the author's relative order:
 * specific guards first, an unconditional fallback last. A failed step uses
 * only guarded edges (an `always` edge must not mask a real failure branch).
 */
export function routeOrder<T extends { readonly when?: Condition }>(edges: readonly T[]): readonly T[] {
  return [...edges].sort((left, right) => {
    const leftFallback = left.when === undefined || left.when.op === 'always'
    const rightFallback = right.when === undefined || right.when.op === 'always'
    return Number(leftFallback) - Number(rightFallback)
  })
}
