/**
 * Model-authored topology: the `graph_plan` tool accepts a free-form node/edge
 * proposal and the harness validates it against the live capability graph,
 * budget and safety invariants before it becomes an executable `TaskPlan`.
 *
 * This is the "creative" half of dynamic topology: the model may connect any
 * capabilities in any shape (DAG, fan-out, bounded loop), suggest per-node
 * models, and revise the graph later. The harness keeps only the invariants
 * that make the run observable and bounded.
 */
import type {
  ArtifactType,
  Condition,
  PlanEdge,
  PlanNode,
  TaskPlan,
} from './graph-schema.ts'
import type { RegistryGraph } from './graph-schema.ts'

export interface ProposalNode {
  readonly id: string
  /** Tool name from the live registry; omitted for agent-step / terminal nodes. */
  readonly tool?: string
  readonly kind?: 'tool-call' | 'agent-step' | 'terminal'
  readonly instruction?: string
  readonly model?: { readonly provider: string; readonly model: string; readonly reasoningEffort?: string }
}

export interface ProposalEdge {
  readonly from: string
  readonly to: string
  readonly when?: Condition
}

export interface GraphProposal {
  readonly rationale?: string
  readonly entry: string
  readonly nodes: readonly ProposalNode[]
  readonly edges: readonly ProposalEdge[]
  readonly terminals?: readonly string[]
}

export interface ProposalLimits {
  readonly maxNodes?: number
  readonly maxSteps?: number
  readonly maxInstructionChars?: number
}

export interface ProposalResult {
  readonly ok: boolean
  readonly plan?: TaskPlan
  readonly errors: readonly string[]
  readonly warnings: readonly string[]
}

const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/u
const DEFAULT_LIMITS: Required<ProposalLimits> = { maxNodes: 12, maxSteps: 24, maxInstructionChars: 600 }

function normalizeCondition(value: unknown): Condition | undefined {
  if (value === undefined) return undefined
  const condition = value as { op?: unknown }
  switch (condition.op) {
    case 'always': return { op: 'always' }
    case 'artifact': return { op: 'artifact', type: (value as { type: ArtifactType }).type }
    case 'noArtifact': return { op: 'noArtifact', type: (value as { type: ArtifactType }).type }
    case 'fact': {
      const fact = value as { key?: unknown; equals?: unknown }
      if (typeof fact.key !== 'string') return undefined
      return { op: 'fact', key: fact.key, equals: fact.equals as string | number | boolean }
    }
    case 'callFailed': {
      const call = value as { tool?: unknown }
      if (typeof call.tool !== 'string') return undefined
      return { op: 'callFailed', tool: call.tool }
    }
    case 'budget': {
      const b = value as { axis?: unknown; remainingAtMost?: unknown }
      if ((b.axis !== 'steps' && b.axis !== 'tokens' && b.axis !== 'wall') || typeof b.remainingAtMost !== 'number') return undefined
      return { op: 'budget', axis: b.axis, remainingAtMost: b.remainingAtMost }
    }
    default: return undefined
  }
}

/**
 * Validate and materialize a proposal.
 * @param proposal - untrusted model output (already parsed JSON).
 * @param graph - live capability graph.
 * @param presetTools - tool names the active preset can see.
 * @param limits - harness caps; the plan budget is clamped to them.
 * @returns a plan on success, otherwise errors a model can correct from.
 */
export function validateProposal(
  proposal: unknown,
  graph: RegistryGraph,
  presetTools: readonly string[],
  limits: ProposalLimits = {},
): ProposalResult {
  const cap = { ...DEFAULT_LIMITS, ...limits }
  const errors: string[] = []
  const warnings: string[] = []
  const value = proposal as Partial<GraphProposal> | undefined
  if (value === undefined || typeof value !== 'object') {
    return { ok: false, errors: ['proposal must be a JSON object'], warnings }
  }
  const nodes = Array.isArray(value.nodes) ? value.nodes : []
  const edges = Array.isArray(value.edges) ? value.edges : []
  if (nodes.length === 0) errors.push('nodes must be a non-empty array')
  if (nodes.length > cap.maxNodes) errors.push(`nodes: ${nodes.length} exceeds maxNodes ${cap.maxNodes}`)
  if (typeof value.entry !== 'string') errors.push('entry must be a node id')
  if (!Array.isArray(edges)) errors.push('edges must be an array')

  const toolByName = new Map(
    graph.nodes.filter(node => node.tool !== undefined).map(node => [node.tool!.name, node]),
  )
  const seen = new Set<string>()
  const planNodes: PlanNode[] = []
  for (const [index, raw] of nodes.entries()) {
    const node = raw as ProposalNode
    if (typeof node.id !== 'string' || !ID.test(node.id)) {
      errors.push(`nodes[${index}].id is missing or invalid`)
      continue
    }
    if (seen.has(node.id)) {
      errors.push(`nodes[${index}].id "${node.id}" is duplicated`)
      continue
    }
    seen.add(node.id)
    const instruction = typeof node.instruction === 'string' ? node.instruction.trim() : ''
    if (instruction.length > cap.maxInstructionChars) {
      errors.push(`nodes[${index}].instruction exceeds ${cap.maxInstructionChars} characters`)
    }
    if (node.tool !== undefined) {
      const known = toolByName.get(node.tool)
      if (known === undefined) errors.push(`nodes[${index}].tool "${node.tool}" is not in the registry`)
      else if (!presetTools.includes(node.tool)) warnings.push(`nodes[${index}].tool "${node.tool}" is outside the preset tool set`)
      planNodes.push({
        id: node.id,
        kind: 'tool-call',
        executor: 'step',
        capabilityId: `tool:${node.tool}`,
        instruction: instruction || `Use \`${node.tool}\` if it advances the task.`,
        toolAllow: [node.tool],
        ...(node.model === undefined ? {} : { model: node.model }),
      })
      continue
    }
    const kind = node.kind === 'terminal' ? 'terminal' : 'agent-step'
    planNodes.push({
      id: node.id,
      kind,
      executor: 'step',
      instruction: instruction || (kind === 'terminal'
        ? 'Answer the task with the evidence gathered above.'
        : 'Continue the task. Use only capabilities that advance it.'),
      toolAllow: kind === 'terminal' ? [] : (presetTools as readonly string[]).slice(0, 0),
      ...(node.model === undefined ? {} : { model: node.model }),
    })
  }

  const planEdges: PlanEdge[] = []
  const edgeKeys = new Set<string>()
  for (const [index, raw] of edges.entries()) {
    const edge = raw as ProposalEdge
    if (typeof edge.from !== 'string' || typeof edge.to !== 'string') {
      errors.push(`edges[${index}] must have from/to`)
      continue
    }
    if (!seen.has(edge.from)) errors.push(`edges[${index}].from "${edge.from}" is not a declared node`)
    if (!seen.has(edge.to)) errors.push(`edges[${index}].to "${edge.to}" is not a declared node`)
    const key = `${edge.from}->${edge.to}`
    if (edgeKeys.has(key)) {
      warnings.push(`edges[${index}] duplicates ${key}; ignored`)
      continue
    }
    edgeKeys.add(key)
    planEdges.push({
      from: edge.from,
      to: edge.to,
      kind: 'control',
      ...(edge.when === undefined ? {} : { when: normalizeCondition(edge.when) ?? { op: 'always' } }),
    })
  }

  const entry = typeof value.entry === 'string' ? value.entry : ''
  if (!seen.has(entry)) errors.push(`entry "${entry}" is not a declared node`)
  const declaredTerminals = Array.isArray(value.terminals) ? value.terminals.filter((id): id is string => typeof id === 'string') : []
  for (const terminal of declaredTerminals) {
    if (!seen.has(terminal)) errors.push(`terminal "${terminal}" is not a declared node`)
  }
  const hasOutgoing = new Set(planEdges.map(edge => edge.from))
  const leaves = planNodes.map(node => node.id).filter(id => !hasOutgoing.has(id))
  const terminals = declaredTerminals.length > 0 ? declaredTerminals : leaves
  if (terminals.length === 0) errors.push('the topology has no terminal node')

  if (errors.length > 0) return { ok: false, errors, warnings }

  const plan: TaskPlan = {
    id: `proposed:${hashText(JSON.stringify(proposal)).slice(0, 12)}`,
    templateId: 'proposed',
    version: 1,
    entry,
    terminals,
    nodes: planNodes,
    edges: planEdges,
    budget: {
      maxNodes: planNodes.length,
      maxSteps: Math.min(cap.maxSteps, Math.max(planNodes.length, planNodes.length * 2)),
      maxTokens: 250_000,
      maxWallMs: 900_000,
      maxReplans: 2,
    },
    toolUniverse: [...new Set(planNodes.flatMap(node => node.toolAllow ?? []))],
    gatePolicy: 'cold',
    fallback: false,
    confidence: 0.9,
    compiledDigest: `proposed:${hashText(JSON.stringify({ nodes: planNodes, edges: planEdges })).slice(0, 16)}`,
  }
  return { ok: true, plan, errors: [], warnings }
}

function hashText(text: string): string {
  // FNV-1a is enough for a display/compiled digest; it is deterministic.
  let hash = 0xcbf29ce484222325n
  const prime = 0x100000001b3n
  const mask = 0xffffffffffffffffn
  for (let index = 0; index < text.length; index += 1) {
    hash ^= BigInt(text.charCodeAt(index))
    hash = (hash * prime) & mask
  }
  return hash.toString(16).padStart(16, '0')
}

/** JSON Schema for the `graph_plan` tool parameters (model-facing). */
export const GRAPH_PROPOSAL_SCHEMA = {
  type: 'object',
  properties: {
    rationale: { type: 'string', description: 'One sentence explaining the topology.' },
    entry: { type: 'string', description: 'Node id to start from.' },
    nodes: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          tool: { type: 'string', description: 'Tool name from the live registry. Omit for agent-step/terminal.' },
          kind: { type: 'string', enum: ['tool-call', 'agent-step', 'terminal'] },
          instruction: { type: 'string' },
        },
        required: ['id'],
      },
    },
    edges: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          from: { type: 'string' },
          to: { type: 'string' },
        },
        required: ['from', 'to'],
      },
    },
    terminals: { type: 'array', items: { type: 'string' } },
  },
  required: ['entry', 'nodes', 'edges'],
} as const
