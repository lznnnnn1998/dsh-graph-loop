/**
 * compose.ts — capability-driven plan synthesis (0.2 composition layer).
 *
 * The older synthesizer (`topology.ts`) and template library (`templates.ts`)
 * hardcode DSH tool names (`grep`, `read`, `write`, `bash`, ...), which makes
 * them useless for a craft, an MCP server or any third-party tool. This module
 * is the default synthesis path and does not make that assumption: it knows
 * *stages* and *artifact contracts*, and asks the registry which tool satisfies
 * them. The older paths remain live for `template` mode and as the dynamic
 * fallback.
 *
 * Stages are generic verbs:
 *
 *   discover → inspect → mutate → author → verify → answer
 *
 * Each stage is filled by a tool from the envelope universe using only data:
 * tags, `produces` / `accepts` artifact specs, permission class and cost. No
 * product name appears here. If no stage can be filled, the plan degrades to
 * the minimal turn skeleton (`orient` works, a distinct answer reports) that
 * still exposes the whole envelope — so an unannotated tool remains usable
 * instead of being dropped.
 *
 * Pure and deterministic: same (fingerprint, graph digest, envelope id,
 * requested artifacts) -> same compiled digest.
 */

import type {
  ArtifactSpec,
  ArtifactType,
  NodeEvidenceContract,
  PlanEdge,
  PlanNode,
  RegistryGraph,
  RegistryNode,
  TaskBudget,
  TaskPlan,
} from './graph-schema.ts'
import { validateTaskPlan } from './graph-schema.ts'
import type { CapabilityEnvelope } from './envelope.ts'
import { orientAnswerSkeleton } from './fallback.ts'
import { LOCATOR_PARAMETER_NAMES } from './condition.ts'
import { hash16, type TaskFingerprint } from './matching.ts'

// ---------------------------------------------------------------------------
// Inputs and outputs
// ---------------------------------------------------------------------------

export type ComposeStage = 'discover' | 'inspect' | 'mutate' | 'author' | 'verify'

export interface ComposeInput {
  readonly fingerprint: TaskFingerprint
  readonly graph: RegistryGraph
  readonly envelope: CapabilityEnvelope
  /**
   * Artifacts the caller wants produced when the fingerprint cannot infer them
   * (e.g. "make a deck" has no file extension). Templates and the router set
   * this explicitly; it is what keeps artifact binding generic.
   */
  readonly requestedArtifacts?: readonly ArtifactType[]
  readonly budget?: Partial<TaskBudget>
  readonly confidence?: number
  readonly maxSteps?: number
}

export interface ComposeStageRecord {
  readonly stage: ComposeStage
  readonly nodeId: string
  readonly capabilityId: string
  readonly toolName: string
  readonly reason: string
}

export type ComposeIssueCode = 'artifact-unresolved' | 'no-capability' | 'no-tools' | 'budget-capped'

export interface ComposeIssue {
  readonly code: ComposeIssueCode
  readonly severity: 'warning' | 'error'
  readonly detail: string
}

export interface ComposeResult {
  readonly plan: TaskPlan
  readonly stages: readonly ComposeStageRecord[]
  readonly issues: readonly ComposeIssue[]
  readonly rationale: readonly string[]
}

// ---------------------------------------------------------------------------
// Registry queries
// ---------------------------------------------------------------------------

/**
 * Pipeline order for placed stages. This is an explicit synthesis policy, not a
 * discovered exit: the emitted graph can leave a stage on budget, failure,
 * success or artifact evidence, but the order the stages appear in is chosen
 * here.
 */
const STAGE_ORDER: readonly ComposeStage[] = ['discover', 'inspect', 'mutate', 'author', 'verify']

/**
 * Steps reserved before the wrap-up answer. Every stage exits to `n_answer` when
 * this many steps remain, so the answer node always has room to run before
 * `budget.maxSteps` is reached.
 */
const ANSWER_RESERVE_STEPS = 1

const INVESTIGATIVE_INTENTS = new Set<TaskFingerprint['intent']>([
  'code-question',
  'code-review',
  'code-change',
  'bug-fix',
  'test-failure',
  'research',
  'fact-finding',
  'wide-research',
  'multi-area-review',
])

function envelopeTools(input: ComposeInput): RegistryNode[] {
  const universe = new Set(input.envelope.tools.universe)
  return input.graph.nodes.filter(
    node => node.kind === 'tool' && node.tool !== undefined && universe.has(node.tool.name),
  )
}

function hasTag(node: RegistryNode, tag: string): boolean {
  return node.tags.includes(tag)
}

function produces(node: RegistryNode, type: ArtifactType): boolean {
  return node.produces.some(spec => spec.type === type)
}

function accepts(node: RegistryNode, type: ArtifactType): boolean {
  return node.accepts.some(spec => spec.type === type)
}

function cheapest(nodes: readonly RegistryNode[]): RegistryNode | undefined {
  return [...nodes].sort((left, right) => {
    const cost = (left.tool?.schemaTokens ?? 0) - (right.tool?.schemaTokens ?? 0)
    return cost !== 0 ? cost : left.id < right.id ? -1 : left.id > right.id ? 1 : 0
  })[0]
}

function firstWithTag(tools: readonly RegistryNode[], tags: readonly string[]): RegistryNode | undefined {
  for (const tag of tags) {
    const found = cheapest(tools.filter(tool => hasTag(tool, tag)))
    if (found !== undefined) return found
  }
  return undefined
}

function firstProducing(tools: readonly RegistryNode[], type: ArtifactType): RegistryNode | undefined {
  // A reader also declares `produces: file.text` (its output is the file's
  // content), but it cannot author an artifact. An author stage needs a tool
  // that can write; otherwise a successful read satisfies `produced.<type>` and
  // the run reports a deliverable it never made.
  return cheapest(tools.filter(tool => tool.tool?.permission !== 'read-only' && produces(tool, type)))
}

/**
 * The structural verifier for a verify stage: a read-only capability whose
 * declared parameters include a typed locator field (see
 * `LOCATOR_PARAMETER_NAMES`). The runtime attributes such a verifier to a prior
 * artifact only when the locator's value is exactly an observed ref, so a shell
 * -- whose only target lives in free-text `command` -- cannot certify. Preference
 * order is over declared data only: a verifier that produces the artifact type
 * under verification, then one that accepts a path locator, then any locator
 * reader; the shell fallback keeps the stage present when the envelope has no
 * structural verifier (it will take the repair/answer exit, never pass).
 */
function firstLocatorVerifier(tools: readonly RegistryNode[], types: readonly ArtifactType[]): RegistryNode | undefined {
  const locatorReaders = tools.filter(tool =>
    tool.tool?.permission === 'read-only'
    && tool.tool.parameterNames.some(name => LOCATOR_PARAMETER_NAMES.includes(name)))
  const typed = locatorReaders.filter(tool => types.some(type => produces(tool, type)))
  return cheapest(typed)
    ?? cheapest(locatorReaders.filter(tool => accepts(tool, 'path.locator')))
    ?? cheapest(locatorReaders)
    ?? firstWithTag(tools, ['verification'])
}

function firstReadTool(tools: readonly RegistryNode[]): RegistryNode | undefined {
  return (
    cheapest(tools.filter(tool => tool.tool?.permission === 'read-only' && produces(tool, 'file.text'))) ??
    cheapest(tools.filter(tool => tool.tool?.permission === 'read-only' && produces(tool, 'file.image'))) ??
    cheapest(tools.filter(tool => tool.tool?.permission === 'read-only' && hasTag(tool, 'filesystem')))
  )
}

/**
 * The artifact types a capability can leave behind as its node's own outcome.
 *
 * `produces` is the tool's declared output. `accepts` is included for mutating
 * capabilities because an `edit` mutates its accepted `file.text` while
 * declaring `produces: file.patch` — either is a real mutation outcome, so the
 * contract is any-of rather than "produces[0]". No tool name or artifact type is
 * special-cased: the vocabulary comes from the registry declaration.
 */
function outcomeSpecs(tool: RegistryNode): ArtifactSpec[] {
  const types: ArtifactType[] = []
  for (const spec of tool.produces) types.push(spec.type)
  for (const spec of tool.accepts) {
    if (spec.type.startsWith('file.')) types.push(spec.type)
  }
  return [...new Set(types)].map(type => ({ type, required: false }))
}

/**
 * Derive a stage's evidence contract from the capability that fills it, never
 * from a literal tool name, a task-kind branch or `produces[0]`.
 *
 *   discover/inspect  an observation capability must leave its declared output
 *                     (a read leaves `file.text`, a grep `search.hits`).
 *   mutate/author     the step must leave a file artifact the capability can
 *                     touch (an author names its one required artifact type).
 *   verify            the declared verifier must run against an artifact an
 *                     earlier step produced, with a clean status.
 */
function evidenceFor(stage: ComposeStage, tool: RegistryNode, artifact?: ArtifactType): NodeEvidenceContract | undefined {
  if (stage === 'verify') return { verifier: true }
  if (stage === 'author') {
    return artifact === undefined ? undefined : { expects: [{ type: artifact, required: true }] }
  }
  const expects = outcomeSpecs(tool)
  return expects.length === 0 ? undefined : { expects }
}

// ---------------------------------------------------------------------------
// Stage planning
// ---------------------------------------------------------------------------

interface StagePlan {
  readonly stage: ComposeStage
  readonly tool: RegistryNode
  readonly reason: string
  /** Author nodes declare the artifact they produce; it becomes their success guard. */
  readonly artifact?: ArtifactType
  /**
   * The stage's declared evidence contract, derived from capability data only.
   * It becomes the node's `evidence` and therefore its success guard. A stage
   * whose capability declares no outcome type has no contract and emits no
   * success exit at all.
   */
  readonly evidence?: NodeEvidenceContract
}

/**
 * Step budget for the whole composition. The explicit `budget.maxSteps` wins
 * over the legacy top-level `maxSteps`; both the node cap and `budgetOf` read
 * this one value so the emitted plan never claims a smaller/bigger step budget
 * than the synthesizer enforced.
 */
function stepBudgetOf(input: ComposeInput): number {
  return input.budget?.maxSteps ?? input.maxSteps ?? 12
}

function planStages(input: ComposeInput): { stages: StagePlan[]; issues: ComposeIssue[]; rationale: string[] } {
  const tools = envelopeTools(input)
  const stages: StagePlan[] = []
  const issues: ComposeIssue[] = []
  const rationale: string[] = []

  if (tools.length === 0) {
    issues.push({ code: 'no-tools', severity: 'warning', detail: 'envelope selected no tools; generic step only' })
    return { stages, issues, rationale }
  }

  const add = (stage: ComposeStage, tool: RegistryNode | undefined, reason: string, unique = true, artifact?: ArtifactType): void => {
    if (tool === undefined) return
    if (unique && stages.some(existing => existing.stage === stage)) return
    stages.push({
      stage,
      tool,
      reason,
      ...(artifact === undefined ? {} : { artifact }),
      ...(evidenceFor(stage, tool, artifact) === undefined ? {} : { evidence: evidenceFor(stage, tool, artifact) }),
    })
    rationale.push(`${stage}: ${tool.id} (${reason})`)
  }

  const investigative = INVESTIGATIVE_INTENTS.has(input.fingerprint.intent)
  const wantsMutation = input.fingerprint.mutating

  // Discovery is exploratory work, not a mutation prerequisite. A mutating
  // task goes straight to inspect → mutate → verify; this keeps the product
  // plan at four steps instead of paying an extra model call.
  if (investigative && !wantsMutation) {
    add('discover', firstWithTag(tools, ['search', 'discovery']), 'tag:search|discovery')
  }
  if (investigative || input.fingerprint.intent === 'document' || input.fingerprint.intent === 'data-analysis') {
    add('inspect', firstReadTool(tools), 'read-only filesystem producer')
  }

  if (wantsMutation) {
    add('mutate', firstWithTag(tools, ['mutation']), 'tag:mutation')
    if (!stages.some(stage => stage.stage === 'inspect')) add('inspect', firstReadTool(tools), 'read before write')
  }

  const requested = [...new Set<ArtifactType>([
    ...input.fingerprint.artifactsOut,
    ...(input.requestedArtifacts ?? []),
  ])]
  for (const artifact of requested) {
    if (wantsMutation && (artifact === 'file.patch' || stages.some(stage => stage.stage === 'mutate' && produces(stage.tool, artifact)))) continue
    const producer = firstProducing(tools, artifact)
    if (producer === undefined) {
      issues.push({
        code: 'artifact-unresolved',
        severity: 'warning',
        detail: `no tool in the envelope produces ${artifact}`,
      })
      continue
    }
    // One author node per requested artifact: a task may need a report, an
    // image and a deck, and each contract is resolved independently.
    add('author', producer, `produces:${artifact}`, false, artifact)
  }
  if (requested.length === 0 && input.fingerprint.intent === 'document' && !wantsMutation) {
    // The declared artifact must be the type the chosen capability actually
    // produces: the author's step-scoped `produced.<type>` guard is derived from
    // this, and a mismatch would leave both exits inert.
    const textProducer = firstProducing(tools, 'file.text')
    const binaryProducer = textProducer === undefined ? firstProducing(tools, 'file.binary') : undefined
    const producer = textProducer ?? binaryProducer
    if (producer !== undefined) {
      add('author', producer, 'document intent', true, textProducer === undefined ? 'file.binary' : 'file.text')
    }
  }

  if (wantsMutation || input.fingerprint.intent === 'test-failure' || input.fingerprint.intent === 'bug-fix') {
    // Verify must be structural: a capability that can address an earlier
    // artifact through a typed locator field, not a shell whose target is text.
    const verifiedTypes: ArtifactType[] = []
    for (const stage of stages) {
      for (const spec of stage.evidence?.expects ?? []) verifiedTypes.push(spec.type)
      if (stage.artifact !== undefined) verifiedTypes.push(stage.artifact)
    }
    add('verify', firstLocatorVerifier(tools, verifiedTypes), 'locator-observation verifier')
  }

  if (stages.length === 0) {
    issues.push({ code: 'no-capability', severity: 'warning', detail: 'no stage matched; generic step only' })
  }

  const maxSteps = stepBudgetOf(input)
  // Reserve one step for the answer: at the stage exit, remaining == 1 means
  // the answer can still run (the frontier checks its cap after the answer).
  // Reserving two skipped the last admitted stage (3 stages at maxSteps 4 ran
  // inspect -> mutate -> answer and never verify) and disagreed with the cap.
  const maxStages = Math.max(0, maxSteps - ANSWER_RESERVE_STEPS)
  if (stages.length > maxStages) {
    // Trim the least goal-critical stages first: discovery, then inspection, then
    // extra authors, then mutation/verification. Splicing from the tail used to
    // drop the artifact-producing author and the verify stage before discovery.
    const dropOrder: readonly ComposeStage[] = ['discover', 'inspect', 'verify', 'author', 'mutate']
    while (stages.length > maxStages) {
      const stageToDrop = dropOrder.find(candidate => stages.some(stage => stage.stage === candidate))
      if (stageToDrop === undefined) break
      const index = stageToDrop === 'author'
        ? stages.map(stage => stage.stage).lastIndexOf('author')
        : stages.findIndex(stage => stage.stage === stageToDrop)
      const [dropped] = stages.splice(index, 1)
      if (dropped !== undefined) {
        issues.push({ code: 'budget-capped', severity: 'warning', detail: `dropped ${dropped.stage} stage to fit ${maxSteps} steps` })
      }
    }
  }

  return { stages: stages.sort((left, right) => STAGE_ORDER.indexOf(left.stage) - STAGE_ORDER.indexOf(right.stage)), issues, rationale }
}

// ---------------------------------------------------------------------------
// Plan construction
// ---------------------------------------------------------------------------

function instructionFor(stage: ComposeStage, tool: RegistryNode): string {
  const label = tool.label ?? tool.tool?.name ?? tool.id
  switch (stage) {
    case 'discover':
      return `Find the files and facts this task needs using ${label}.`
    case 'inspect':
      return `Read the relevant material and extract what the task needs using ${label}.`
    case 'mutate':
      return `Apply the required change with ${label}.`
    case 'author':
      return `Produce the requested artifact with ${label}.`
    case 'verify':
      return `Verify the result with ${label}; report failures explicitly.`
  }
}

function budgetOf(input: ComposeInput): TaskBudget {
  const requested = input.budget ?? {}
  return {
    maxNodes: requested.maxNodes ?? 12,
    maxSteps: stepBudgetOf(input),
    maxTokens: requested.maxTokens ?? 200_000,
    maxWallMs: requested.maxWallMs ?? 15 * 60_000,
    maxReplans: requested.maxReplans ?? 1,
  }
}

function digestOf(plan: Omit<TaskPlan, 'compiledDigest'>): string {
  return hash16(JSON.stringify({
    entry: plan.entry,
    terminals: plan.terminals,
    nodes: plan.nodes,
    edges: plan.edges,
    budget: plan.budget,
    toolUniverse: plan.toolUniverse,
  }))
}

/**
 * Synthesize a plan from capability facts only.
 *
 * The result always validates against `TaskPlan` invariants. When no stage can
 * be filled it returns the minimal `orient → answer` skeleton (`t_generic`)
 * that exposes the whole envelope; this is the generic escape hatch that keeps
 * unannotated tools usable without collapsing the turn into one node.
 */
export function synthesizeComposition(input: ComposeInput): ComposeResult {
  const { stages, issues, rationale } = planStages(input)
  const budget = budgetOf(input)
  const nodes: PlanNode[] = []
  const edges: PlanEdge[] = []
  const records: ComposeStageRecord[] = []

  let authorIndex = 0
  const stageNodes: {
    readonly stage: ComposeStage
    readonly id: string
    readonly toolName: string
    readonly artifact?: ArtifactType
    readonly evidence?: NodeEvidenceContract
    readonly repairId: string
  }[] = []
  for (const planned of stages) {
    const nodeId = planned.stage === 'author' ? `n_author_${authorIndex++}` : `n_${planned.stage}`
    const repairId = `${nodeId}_repair`
    const toolName = planned.tool.tool?.name ?? planned.tool.id
    nodes.push({
      id: nodeId,
      kind: 'agent-step',
      executor: 'step',
      capabilityId: planned.tool.id,
      instruction: instructionFor(planned.stage, planned.tool),
      ...(planned.evidence === undefined ? {} : { evidence: planned.evidence }),
      budget: { maxSteps: 1 },
    })
    nodes.push({
      id: repairId,
      kind: 'agent-step',
      executor: 'step',
      capabilityId: planned.tool.id,
      // The repair attempt carries the same declared contract: an equivalent
      // tool may satisfy it, but only by producing the stage's evidence.
      ...(planned.evidence === undefined ? {} : { evidence: planned.evidence }),
      // One repair attempt only. It may use an equivalent tool: the stage
      // contract is the outcome, not a literal tool name. If it still cannot
      // complete, the tool-enabled answer node finishes the abandoned work.
      instruction: `Last attempt at the ${planned.stage} step: diagnose the exact failure, then retry the ${planned.stage} work with ${toolName} or an equivalent tool. If it still cannot complete, the answer step will finish the work.`,
      budget: { maxSteps: 1 },
    })
    stageNodes.push({
      stage: planned.stage,
      id: nodeId,
      toolName,
      ...(planned.artifact === undefined ? {} : { artifact: planned.artifact }),
      ...(planned.evidence === undefined ? {} : { evidence: planned.evidence }),
      repairId,
    })
    records.push({
      stage: planned.stage,
      nodeId,
      capabilityId: planned.tool.id,
      toolName,
      reason: planned.reason,
    })
  }

  const answerId = 'n_answer'
  const generic = stages.length === 0
  if (generic) {
    // R4: a plan that filled no stage is still a turn, not one node that works
    // and answers at once. `orient` does the work with the envelope's tools;
    // the answer terminal reports it and cannot call tools, so the last step
    // always produces assistant text instead of ending the turn on a tool call.
    const skeleton = orientAnswerSkeleton({
      orientId: 'n_orient',
      answerId,
      orientInstruction: 'Complete the task using the available tools and report the result.',
      answerInstruction: 'Answer the task from what the previous step produced: what you did, what remains unverified, and any remaining risk. Do not start new work.',
    })
    nodes.push(...skeleton.nodes)
    edges.push(...skeleton.edges)
  } else {
    nodes.push({
      id: answerId,
      // Answer-only terminal: the stage work is the plan's work, and the last
      // step must be prose (a tool call there would end the turn with no answer).
      kind: 'terminal',
      executor: 'step',
      instruction: 'Summarize what was produced, what was verified, and any remaining risk. Do not start new work.',
      toolAllow: [],
      budget: { maxSteps: 1 },
    })
  }

  // Every stage gets a reachable exit table, evaluated in declaration order by
  // both engines:
  //   budget exhausted            -> answer (FIRST)
  //   tool error / lastOk=false   -> one repair attempt
  //   stage-specific failure      -> the same repair attempt
  //   stage-specific success      -> next stage (or the answer)
  // The budget edge is declared first on purpose: at
  // the answer reserve boundary a stage that keeps failing must be able to
  // leave, otherwise its failure guard wins forever and the kernel ends the run
  // as GRAPH_FAILED with the work unfinished. The guards are generic
  // facts/artifacts the runtime folds from tool calls; no task-kind branch
  // appears here. The repair node never returns to its stage: exactly one
  // attempt per stage, then the tool-enabled answer node continues any
  // unfinished work. Escalation is the answer, not a livelock.
  // The success guard is uniform and does not branch on stage kind: the node's
  // own declared evidence contract must be satisfied by its own step. The
  // runtime evaluates the contract against that step's attributed artifact refs
  // and verifier calls and writes the single node-scoped fact `evidence.ok`.
  // No stage-activity aggregate (`toolSucceeded`, `wroteFile`, `verificationRan`,
  // `produced.<type>`) can satisfy a stage, and a stage with no declared
  // contract emits no success exit at all.
  const successGuard = (node: (typeof stageNodes)[number]): PlanEdge['when'] | undefined =>
    node.evidence === undefined ? undefined : { op: 'fact', key: 'evidence.ok', equals: true }
  /**
   * The stage's own negative classifier(s), in evaluation order. The evidence
   * fact is written on every step of a composed node, so a step that did not
   * satisfy its contract cannot fall through to the next stage.
   */
  const failureGuards = (node: (typeof stageNodes)[number]): PlanEdge['when'][] => {
    const guards: PlanEdge['when'][] = []
    if (node.evidence !== undefined) guards.push({ op: 'fact', key: 'evidence.ok', equals: false })
    // A verifier that ran and failed must repair even though its evidence was
    // not satisfied either: the failure exit is the same attempt.
    if (node.stage === 'verify') guards.push({ op: 'fact', key: 'verificationFailed', equals: true })
    return guards
  }
  for (const [index, node] of stageNodes.entries()) {
    const next = stageNodes[index + 1]?.id ?? answerId
    const success = successGuard(node)
    const budgetExit: PlanEdge['when'] = { op: 'budget', axis: 'steps', remainingAtMost: ANSWER_RESERVE_STEPS }
    // 1. Budget first: it must outrank every failure guard so a stage that
    //    never succeeds still reaches the answer instead of looping to failure.
    edges.push({ from: node.id, to: answerId, kind: 'control', when: budgetExit })
    // 2. Tool-invocation failure and an explicitly failed step: one repair try.
    edges.push({ from: node.id, to: node.repairId, kind: 'control', when: { op: 'callFailed', tool: node.toolName } })
    edges.push({ from: node.id, to: node.repairId, kind: 'control', when: { op: 'fact', key: 'lastOk', equals: false } })
    // 3. Stage-specific no-progress (the failure guards make success exclusive).
    for (const failure of failureGuards(node)) {
      edges.push({ from: node.id, to: node.repairId, kind: 'control', when: failure })
    }
    // 4. Success -> next stage, or the tool-enabled answer.
    if (success !== undefined) edges.push({ from: node.id, to: next, kind: 'control', when: success })

    // Repair node: exactly one attempt. Priority mirrors the stage so the
    // success predicate cannot mask a failure: budget and every failure exit
    // answer first; only then may a clean success advance. A verify repair that
    // ran a check which exited non-zero has verificationRan=true AND
    // verificationFailed=true, so failure must win over success. There is
    // deliberately no repair -> stage back-edge.
    edges.push({ from: node.repairId, to: answerId, kind: 'control', when: budgetExit })
    edges.push({ from: node.repairId, to: answerId, kind: 'control', when: { op: 'callFailed', tool: node.toolName } })
    edges.push({ from: node.repairId, to: answerId, kind: 'control', when: { op: 'fact', key: 'lastOk', equals: false } })
    for (const failure of failureGuards(node)) {
      edges.push({ from: node.repairId, to: answerId, kind: 'control', when: failure })
    }
    if (success !== undefined) edges.push({ from: node.repairId, to: next, kind: 'control', when: success })
    // No-progress fallback: if no guard above matched, answer rather than stall.
    edges.push({ from: node.repairId, to: answerId, kind: 'control' })
  }

  const toolUniverse = [...input.envelope.tools.universe].sort()
  const confidence = input.confidence ?? (stages.length === 0 ? 0.2 : 0.75)
  const base: Omit<TaskPlan, 'compiledDigest'> = {
    id: `plan_${hash16(JSON.stringify({ envelope: input.envelope.id, stages: records.map(record => record.nodeId) }))}`,
    templateId: stages.length === 0 ? 't_generic' : 't_compose',
    version: 1,
    entry: nodes[0]!.id,
    terminals: [answerId],
    nodes,
    edges,
    // The declared node cap must describe this plan. `budgetOf` defaults to 12
    // but multi-artifact plans can emit more nodes, and no engine enforces the
    // field; claiming a cap below the node count makes the budget fiction.
    budget: { ...budget, maxNodes: nodes.length },
    toolUniverse,
    gatePolicy: 'turn',
    fallback: stages.length === 0,
    confidence,
  }
  const plan: TaskPlan = { ...base, compiledDigest: digestOf(base) }

  const validation = validateTaskPlan(input.graph, plan)
  if (!validation.ok) {
    // A synthesized plan that violates the contract is a bug in this module,
    // not something to hand to the loop. Fail loudly; the caller can fall back.
    throw new Error(
      `synthesized plan is invalid: ${validation.errors.map(error => `${error.code} ${error.path}: ${error.message}`).join('; ')}`,
    )
  }

  return {
    plan,
    stages: records,
    issues,
    rationale: [
      ...rationale,
      ...(stages.length === 0 ? ['no capability stage matched; generic orient + answer'] : []),
    ],
  }
}
