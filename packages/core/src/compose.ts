/**
 * compose.ts — capability-driven plan synthesis (0.2 composition layer).
 *
 * The 0.1.x synthesizer (`topology.ts`) and template library (`templates.ts`)
 * hardcode DSH tool names (`grep`, `read`, `write`, `bash`, ...), which makes
 * them useless for a craft, an MCP server or any third-party tool. This module
 * replaces that assumption: it knows *stages* and *artifact contracts*, and asks
 * the registry which tool satisfies them.
 *
 * Stages are generic verbs:
 *
 *   discover → inspect → mutate → author → verify → answer
 *
 * Each stage is filled by a tool from the envelope universe using only data:
 * tags, `produces` / `accepts` artifact specs, permission class and cost. No
 * product name appears here. If no stage can be filled, the plan degrades to a
 * single generic step that still exposes the whole envelope — so an
 * unannotated tool remains usable instead of being dropped.
 *
 * Pure and deterministic: same (fingerprint, graph digest, envelope id,
 * requested artifacts) -> same compiled digest.
 */

import type {
  ArtifactType,
  PlanEdge,
  PlanNode,
  RegistryGraph,
  RegistryNode,
  TaskBudget,
  TaskPlan,
} from './graph-schema.ts'
import { validateTaskPlan } from './graph-schema.ts'
import type { CapabilityEnvelope } from './envelope.ts'
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
const ANSWER_RESERVE_STEPS = 2

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
  return cheapest(tools.filter(tool => produces(tool, type)))
}

function firstReadTool(tools: readonly RegistryNode[]): RegistryNode | undefined {
  return (
    cheapest(tools.filter(tool => tool.tool?.permission === 'read-only' && produces(tool, 'file.text'))) ??
    cheapest(tools.filter(tool => tool.tool?.permission === 'read-only' && produces(tool, 'file.image'))) ??
    cheapest(tools.filter(tool => tool.tool?.permission === 'read-only' && hasTag(tool, 'filesystem')))
  )
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
    stages.push({ stage, tool, reason, ...(artifact === undefined ? {} : { artifact }) })
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
    add('verify', firstWithTag(tools, ['verification']), 'tag:verification')
  }

  if (stages.length === 0) {
    issues.push({ code: 'no-capability', severity: 'warning', detail: 'no stage matched; generic step only' })
  }

  const maxSteps = stepBudgetOf(input)
  // Every composed plan spends one step on the answer node. Capping the stages
  // at maxSteps - 1 leaves that step. A stage owns two nodes (work + repair), so
  // the plan may declare more nodes than maxSteps; maxSteps bounds executed
  // steps through the budget/repair exits, not the declared node count.
  const maxStages = Math.max(0, maxSteps - 1)
  if (stages.length > maxStages) {
    stages.splice(maxStages)
    issues.push({ code: 'budget-capped', severity: 'warning', detail: `stages capped at ${maxStages}` })
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
 * be filled it returns a single generic `step` answer node (`t_generic`) that
 * exposes the whole envelope; this is the generic escape hatch that keeps
 * unannotated tools usable.
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
      budget: { maxSteps: 1 },
    })
    nodes.push({
      id: repairId,
      kind: 'agent-step',
      executor: 'step',
      capabilityId: planned.tool.id,
      instruction: `The ${planned.stage} step failed. Diagnose the exact failure from the last output and retry the ${planned.stage} work with ${toolName}; do not repeat unrelated steps.`,
      budget: { maxSteps: 1 },
    })
    stageNodes.push({
      stage: planned.stage,
      id: nodeId,
      toolName,
      ...(planned.artifact === undefined ? {} : { artifact: planned.artifact }),
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
  nodes.push({
    id: answerId,
    // A terminal node may not allow tools (P007), so this stays an agent step:
    // the model can keep acting at the end of the plan. The scheduler extends
    // an exhausted plan when the model is still calling tools.
    kind: 'agent-step',
    executor: 'step',
    instruction: generic
      ? 'Complete the task using the available tools and report the result.'
      : 'Summarize what was produced, what was verified, and any remaining risk. If the task still needs work, continue with the available tools; otherwise answer.',
    budget: { maxSteps: 1 },
  })

  // Every stage gets a real exit table, not one hardcoded successor:
  //   tool error                  -> stage repair -> stage (bounded by maxSteps)
  //   stage-specific failure      -> stage repair (evaluated BEFORE the budget)
  //   budget exhausted            -> answer
  //   stage-specific success      -> next stage
  // The guards are generic facts/artifacts the runtime folds from tool calls;
  // no task-kind branch appears here. The failure exits are declared first: both
  // engines take the first matching edge, so at the answer reserve boundary a
  // failed stage must still repair instead of being reported as the answer.
  const successGuard = (node: (typeof stageNodes)[number]): PlanEdge['when'] => {
    switch (node.stage) {
      case 'discover':
        // Discovery's contract is "look something up", not a specific artifact.
        return { op: 'fact', key: 'hadToolCall', equals: true }
      case 'inspect':
        return { op: 'fact', key: 'readFile', equals: true }
      case 'mutate':
        return { op: 'fact', key: 'wroteFile', equals: true }
      case 'author':
        // Step- AND type-scoped: a run-cumulative `artifact` (or a boolean for
        // any artifact type) would let an earlier stage's file — or a different
        // tool's output — satisfy this author's contract. The runtime writes
        // `produced.<type>` for the node's declared types on every step.
        return node.artifact === undefined
          ? { op: 'fact', key: 'producedArtifact', equals: true }
          : { op: 'fact', key: `produced.${node.artifact}`, equals: true }
      case 'verify':
        // A non-zero shell exit is a normal tool result, so `lastOk` cannot be
        // the verification signal, and "no tool ran" must not read as a pass:
        // `verificationRan` requires the step to have invoked something and
        // `verificationFailed` carries the `[exit code: N]` result.
        return { op: 'fact', key: 'verificationRan', equals: true }
    }
  }
  /**
   * The stage's own negative classifier(s), in evaluation order. These are the
   * no-progress exits that make the success guard exclusive: every fact below is
   * written by the runtime on every step, so a false success cannot fall through
   * to the next stage through an unconditional edge.
   */
  const failureGuards = (node: (typeof stageNodes)[number]): PlanEdge['when'][] => {
    switch (node.stage) {
      case 'discover':
        return [{ op: 'fact', key: 'hadToolCall', equals: false }]
      case 'inspect':
        return [{ op: 'fact', key: 'readFile', equals: false }]
      case 'mutate':
        return [{ op: 'fact', key: 'wroteFile', equals: false }]
      case 'author':
        return [node.artifact === undefined
          ? { op: 'fact', key: 'producedArtifact', equals: false }
          : { op: 'fact', key: `produced.${node.artifact}`, equals: false }]
      case 'verify':
        return [
          { op: 'fact', key: 'verificationFailed', equals: true },
          // Completion is not verification: a verify step that called no tool
          // has not verified anything and must repair.
          { op: 'fact', key: 'verificationRan', equals: false },
        ]
    }
  }
  for (const [index, node] of stageNodes.entries()) {
    const next = stageNodes[index + 1]?.id ?? answerId
    edges.push({ from: node.id, to: node.repairId, kind: 'control', when: { op: 'callFailed', tool: node.toolName } })
    edges.push({ from: node.id, to: node.repairId, kind: 'control', when: { op: 'fact', key: 'lastOk', equals: false } })
    for (const failure of failureGuards(node)) {
      edges.push({ from: node.id, to: node.repairId, kind: 'control', when: failure })
    }
    // Only after the failure exits: a stage that failed at the reserve boundary
    // repairs rather than becoming the answer.
    edges.push({ from: node.id, to: answerId, kind: 'control', when: { op: 'budget', axis: 'steps', remainingAtMost: ANSWER_RESERVE_STEPS } })
    const success = successGuard(node)
    if (success !== undefined) edges.push({ from: node.id, to: next, kind: 'control', when: success })
    // No unconditional edge off a stage: success and failure guards are
    // exhaustive on every step the live path drives, so "nothing matched" would
    // mean a missing fact, and silently advancing would hide that. The repair
    // node keeps its unconditional return edge to the stage.
    edges.push({ from: node.repairId, to: node.id, kind: 'control' })
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
    budget,
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
      ...(stages.length === 0 ? ['no capability stage matched; generic single step'] : []),
    ],
  }
}
