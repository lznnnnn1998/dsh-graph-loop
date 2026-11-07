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
 *   discover → inspect → mutate → author → verify → deliver → answer
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

export type ComposeStage = 'discover' | 'inspect' | 'mutate' | 'author' | 'verify' | 'deliver'

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

const STAGE_ORDER: readonly ComposeStage[] = ['discover', 'inspect', 'mutate', 'author', 'verify', 'deliver']

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

  const add = (stage: ComposeStage, tool: RegistryNode | undefined, reason: string, unique = true): void => {
    if (tool === undefined) return
    if (unique && stages.some(existing => existing.stage === stage)) return
    stages.push({ stage, tool, reason })
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
    add('author', producer, `produces:${artifact}`, false)
  }
  if (requested.length === 0 && input.fingerprint.intent === 'document' && !wantsMutation) {
    add('author', firstProducing(tools, 'file.text') ?? firstProducing(tools, 'file.binary'), 'document intent')
  }

  if (wantsMutation || input.fingerprint.intent === 'test-failure' || input.fingerprint.intent === 'bug-fix') {
    add('verify', firstWithTag(tools, ['verification']), 'tag:verification')
  }

  if (stages.length === 0) {
    issues.push({ code: 'no-capability', severity: 'warning', detail: 'no stage matched; generic step only' })
  }

  const maxSteps = stepBudgetOf(input)
  // Every composed plan spends one step on the terminal answer node. Capping
  // the stages at maxSteps - 1 (never below zero) keeps nodes <= maxSteps even
  // for maxSteps === 1, where the answer node is the only step.
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
    case 'deliver':
      return `Declare the final deliverables with ${label}.`
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
 * be filled it returns a single generic `step` terminal (`t_generic`) that
 * exposes the whole envelope; this is the generic escape hatch that keeps
 * unannotated tools usable.
 */
export function synthesizeComposition(input: ComposeInput): ComposeResult {
  const { stages, issues, rationale } = planStages(input)
  const budget = budgetOf(input)
  const nodes: PlanNode[] = []
  const edges: PlanEdge[] = []
  const records: ComposeStageRecord[] = []

  let previous: string | undefined
  let authorIndex = 0
  for (const planned of stages) {
    const nodeId = planned.stage === 'author' ? `n_author_${authorIndex++}` : `n_${planned.stage}`
    nodes.push({
      id: nodeId,
      kind: 'agent-step',
      executor: 'step',
      capabilityId: planned.tool.id,
      instruction: instructionFor(planned.stage, planned.tool),
      budget: { maxSteps: 1 },
    })
    if (previous !== undefined) edges.push({ from: previous, to: nodeId, kind: 'control' })
    previous = nodeId
    records.push({
      stage: planned.stage,
      nodeId,
      capabilityId: planned.tool.id,
      toolName: planned.tool.tool?.name ?? planned.tool.id,
      reason: planned.reason,
    })
  }

  const answerId = 'n_answer'
  const generic = stages.length === 0
  nodes.push({
    id: answerId,
    kind: 'terminal',
    executor: 'step',
    instruction: generic
      ? 'Complete the task using the available tools and report the result.'
      : 'Summarize what was produced, what was verified, and any remaining risk.',
    // The terminal step answers from what the previous nodes produced; it must
    // not carry the full preset tool surface. A generic single-step plan is the
    // exception: there the terminal node is also the work node, so it keeps the
    // envelope the escape hatch exists to expose.
    ...(generic ? {} : { toolAllow: [] }),
    budget: { maxSteps: 1 },
  })
  if (previous !== undefined) edges.push({ from: previous, to: answerId, kind: 'control' })

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
