/**
 * Dynamic topology: the run graph is *discovered*, not selected from a fixed
 * template library.
 *
 * Two things live here:
 *
 * 1. `synthesizeTopology(task, graph, ...)` builds an arbitrary DAG from the
 *    capability graph: it walks artifact pre/post-conditions and intent, can
 *    fan out (research) or chain (investigate → read → answer), and never
 *    requires a template. This is the deterministic floor for "free topology".
 *
 * 2. `FrontierTopology` executes/edits that graph. Unlike a linear cursor it
 *    keeps a frontier: one completed node can enqueue several successors, edges
 *    can be added or removed between steps, and cycles are allowed as long as
 *    the budget lasts. The driver only needs `current()/advance()/done()`.
 *
 * The registry graph is the substrate (what can be connected); the topology is
 * the created structure (what this task actually connects). The model can
 * replace or mutate the topology mid-turn through `graph_plan`; the harness
 * validates every edit against the registry + budget.
 */
import type {
  ArtifactType,
  PlanEdge,
  PlanNode,
  TaskPlan,
  RegistryGraph,
} from './graph-schema.ts'
import type { TaskFingerprint } from './matching.ts'

export type TopologyMode = 'template' | 'dynamic' | 'propose'

export interface TopologyBudget {
  readonly maxNodes: number
  readonly maxSteps: number
  readonly maxTokens: number
  readonly maxWallMs: number
  readonly maxReplans: number
}

export interface SynthesizeInput {
  readonly taskHash: string
  readonly fingerprint: TaskFingerprint
  readonly graph: RegistryGraph
  /** Tool names the active preset can actually see. */
  readonly presetTools: readonly string[]
  readonly budget?: Partial<TopologyBudget>
}

export interface SynthesizedTopology {
  readonly plan: TaskPlan
  readonly rationale: readonly string[]
}

const DEFAULT_BUDGET: TopologyBudget = {
  maxNodes: 10,
  maxSteps: 16,
  maxTokens: 250_000,
  maxWallMs: 900_000,
  maxReplans: 2,
}

function budgetOf(partial: Partial<TopologyBudget> | undefined): TopologyBudget {
  return { ...DEFAULT_BUDGET, ...partial }
}

/** Tool names that produce each artifact, filtered to what the preset can see. */
function producers(graph: RegistryGraph, presetTools: readonly string[], artifact: ArtifactType): string[] {
  return graph.nodes
    .filter(node => node.tool !== undefined
      && !node.tool.dynamic
      && presetTools.includes(node.tool.name)
      && node.produces.some(spec => spec.type === artifact))
    .map(node => node.tool!.name)
}

function firstAvailable(graph: RegistryGraph, presetTools: readonly string[], names: readonly string[]): string | undefined {
  const available = new Set(graph.nodes.filter(node => node.tool && presetTools.includes(node.tool.name)).map(node => node.tool!.name))
  return names.find(name => available.has(name))
}

function toolInstruction(name: string, slot: string): string {
  switch (name) {
    case 'glob':
    case 'grep':
      return `${slot}: locate the relevant files with \`${name}\`; keep the result list small and pass the paths forward.`
    case 'read':
    case 'read_image':
      return `${slot}: inspect the selected artifact with \`${name}\`; extract the facts needed by the next node.`
    case 'edit':
    case 'write':
    case 'str_replace_editor':
      return `${slot}: apply the requested change with \`${name}\`; keep the diff minimal and explain it.`
    case 'bash':
    case 'pwsh':
      return `${slot}: verify the change by running the narrowest check with \`${name}\`; report the exact command and outcome.`
    case 'web_search':
      return `${slot}: search with \`${name}\`; keep the top sources and their claims.`
    case 'web_fetch':
      return `${slot}: read the most relevant page with \`${name}\`; extract only task-relevant evidence.`
    case 'skill':
      return `${slot}: load the task-specific skill with \`${name}\` before acting.`
    default:
      return `${slot}: use \`${name}\` if it advances the task; otherwise continue with the next node.`
  }
}

function node(id: string, tool: string, instruction: string, model?: PlanNode['model']): PlanNode {
  return {
    id,
    kind: 'tool-call',
    executor: 'step',
    capabilityId: `tool:${tool}`,
    instruction,
    toolAllow: [tool],
    ...(model === undefined ? {} : { model }),
  }
}

/**
 * Deterministic topology synthesis. This is deliberately *not* a template
 * lookup: the shape comes from (a) whether the task mutates, (b) which
 * artifacts it needs, and (c) which capabilities can produce them.
 */
export function synthesizeTopology(input: SynthesizeInput): SynthesizedTopology {
  const budget = budgetOf(input.budget)
  const { graph, presetTools, fingerprint } = input
  const rationale: string[] = []
  const nodes: PlanNode[] = []
  const edges: PlanEdge[] = []
  const link = (from: string, to: string, when?: PlanEdge['when']): void => {
    edges.push({ from, to, kind: 'control', ...(when === undefined ? {} : { when }) })
  }

  const wantsWeb = fingerprint.intent === 'research' || fingerprint.intent === 'wide-research' || fingerprint.intent === 'fact-finding'
  const mutating = fingerprint.mutating || fingerprint.intent === 'bug-fix' || fingerprint.intent === 'code-change' || fingerprint.intent === 'test-failure'
  const wantsDoc = fingerprint.intent === 'document' || fingerprint.artifactsOut.includes('file.text')

  // Front: entry node (the only synthetic node besides the answer).
  const entry: PlanNode = {
    id: 'd_entry',
    kind: 'agent-step',
    executor: 'step',
    instruction: 'Restate the task in one sentence and name the artifact you will deliver. Then continue.',
  }
  nodes.push(entry)
  let cursor = entry.id

  const discoveryTool = firstAvailable(graph, presetTools, ['grep', 'glob'])
  if (!mutating && !wantsWeb && discoveryTool !== undefined) {
    const id = `d_${discoveryTool}`
    nodes.push(node(id, discoveryTool, toolInstruction(discoveryTool, 'discover')))
    link(cursor, id)
    cursor = id
    rationale.push(`discovery via ${discoveryTool} (intent ${fingerprint.intent})`)
  }

  if (mutating) {
    const reader = firstAvailable(graph, presetTools, ['read'])
    if (reader !== undefined) {
      const id = 'd_read'
      nodes.push(node(id, reader, toolInstruction(reader, 'inspect')))
      link(cursor, id)
      cursor = id
      rationale.push('inspect before mutating (read-before-write)')
    }
    const editor = firstAvailable(graph, presetTools, ['edit', 'write', 'str_replace_editor'])
    if (editor !== undefined) {
      const id = 'd_edit'
      nodes.push(node(id, editor, toolInstruction(editor, 'act')))
      link(cursor, id)
      cursor = id
      rationale.push(`mutation via ${editor}`)
    }
    const verifier = firstAvailable(graph, presetTools, ['bash', 'pwsh'])
    if (verifier !== undefined) {
      const id = 'd_verify'
      nodes.push(node(id, verifier, toolInstruction(verifier, 'verify')))
      link(cursor, id)
      cursor = id
      rationale.push(`verification via ${verifier}`)
    }
  } else if (wantsWeb) {
    const search = firstAvailable(graph, presetTools, ['web_search'])
    const fetch = firstAvailable(graph, presetTools, ['web_fetch'])
    if (search !== undefined && fetch !== undefined) {
      // Arbitrary shape: fan out, then join at the answer.
      const searchId = 'd_search'
      const fetchId = 'd_fetch'
      nodes.push(node(searchId, search, toolInstruction(search, 'research')))
      nodes.push(node(fetchId, fetch, toolInstruction(fetch, 'research')))
      link(cursor, searchId)
      link(cursor, fetchId)
      rationale.push('parallel research fan-out (search + fetch)')
      const answerId = 'd_answer'
      nodes.push({
        id: answerId,
        kind: 'terminal',
        executor: 'step',
        instruction: 'Synthesize the findings into the requested answer with citations; state uncertainty explicitly.',
        toolAllow: [],
      })
      link(searchId, answerId)
      link(fetchId, answerId)
      return finish(input, nodes, edges, entry.id, [answerId], budget, rationale, 'dynamic')
    }
  } else {
    const reader = firstAvailable(graph, presetTools, ['read', 'read_image'])
    if (reader !== undefined) {
      const id = 'd_read'
      nodes.push(node(id, reader, toolInstruction(reader, 'inspect')))
      link(cursor, id)
      cursor = id
      rationale.push(`inspection via ${reader}`)
    }
  }

  if (wantsDoc) {
    const writer = firstAvailable(graph, presetTools, ['write', 'edit'])
    if (writer !== undefined && mutating === false) {
      const id = 'd_write'
      nodes.push(node(id, writer, toolInstruction(writer, 'deliver')))
      link(cursor, id)
      cursor = id
      rationale.push(`document delivery via ${writer}`)
    }
  }

  const answerId = 'd_answer'
  nodes.push({
    id: answerId,
    kind: 'terminal',
    executor: 'step',
    instruction: 'Answer the task using the artifacts produced above. Cite evidence and state what was not verified.',
    toolAllow: [],
  })
  link(cursor, answerId)
  rationale.push(`terminal answer after ${nodes.length - 1} capability nodes`)
  return finish(input, nodes, edges, entry.id, [answerId], budget, rationale, 'dynamic')
}

function finish(
  input: SynthesizeInput,
  nodes: PlanNode[],
  edges: PlanEdge[],
  entry: string,
  terminals: string[],
  budget: TopologyBudget,
  rationale: readonly string[],
  mode: TopologyMode,
): SynthesizedTopology {
  const plan: TaskPlan = {
    id: `dyn:${input.taskHash}`,
    templateId: 'dynamic',
    version: 1,
    entry,
    terminals,
    nodes,
    edges,
    budget,
    toolUniverse: [...new Set(nodes.flatMap(node => node.toolAllow ?? []))],
    gatePolicy: 'cold',
    fallback: false,
    confidence: 0.5,
    compiledDigest: `dyn:${input.taskHash}:${nodes.length}`,
  }
  void mode
  return { plan, rationale }
}

/** A bootstrap graph for `propose` mode: the model authors the topology. */
export function bootstrapTopology(taskHash: string, budget?: Partial<TopologyBudget>): TaskPlan {
  const b = budgetOf(budget)
  return {
    id: `bootstrap:${taskHash}`,
    templateId: 'propose',
    version: 1,
    entry: 'p_frame',
    terminals: ['p_frame'],
    nodes: [{
      id: 'p_frame',
      kind: 'agent-step',
      executor: 'step',
      instruction: 'Author the run topology for this task. Call the `graph_plan` tool with nodes and edges that use the available capabilities, then continue. Keep it minimal; you may add or remove nodes later.',
    }],
    edges: [],
    budget: b,
    toolUniverse: [],
    gatePolicy: 'never',
    fallback: true,
    confidence: 0,
    compiledDigest: `bootstrap:${taskHash}`,
  }
}

// ---------------------------------------------------------------------------
// Frontier executor with runtime mutation
// ---------------------------------------------------------------------------

export interface FrontierAdvance {
  readonly ok: boolean
  readonly failedTool?: string
}

export class FrontierTopology {
  private readonly nodeById: Map<string, PlanNode>
  private readonly adjacency: PlanEdge[]
  private readonly pending: string[] = []
  private readonly completed = new Set<string>()
  private readonly visits = new Map<string, number>()
  private currentId: string | undefined
  private state: 'running' | 'done' | 'failed' = 'running'
  private readonly maxSteps: number
  private stepCount = 0
  /** Every mutation is appended here so the run can be explained/replayed. */
  readonly mutations: string[] = []

  constructor(private readonly basePlan: TaskPlan) {
    this.nodeById = new Map(basePlan.nodes.map(node => [node.id, node]))
    this.adjacency = [...basePlan.edges]
    this.maxSteps = basePlan.budget.maxSteps
    if (this.nodeById.has(basePlan.entry)) this.pending.push(basePlan.entry)
    else this.state = 'failed'
  }

  /** Idempotent peek: the same node until `advance()` completes it. */
  current(): PlanNode | undefined {
    if (this.state !== 'running') return undefined
    if (this.currentId !== undefined) return this.nodeById.get(this.currentId)
    while (this.pending.length > 0) {
      const id = this.pending.shift() as string
      const node = this.nodeById.get(id)
      if (node === undefined) continue
      this.currentId = id
      return node
    }
    this.state = 'done'
    return undefined
  }

  advance(outcome: FrontierAdvance): PlanNode | undefined {
    const id = this.currentId
    this.currentId = undefined
    if (id === undefined) return undefined
    this.completed.add(id)
    this.stepCount += 1
    const visits = (this.visits.get(id) ?? 0) + 1
    this.visits.set(id, visits)
    if (!outcome.ok) {
      // A failed node only continues when an explicit failed-tool edge exists.
      const recovery = this.adjacency.find(edge => edge.from === id
        && edge.when?.op === 'callFailed'
        && (edge.when.tool === outcome.failedTool || outcome.failedTool === undefined))
      if (recovery === undefined) {
        this.state = 'failed'
        return undefined
      }
      this.pending.push(recovery.to)
      return this.current()
    }
    if (this.stepCount >= this.maxSteps) {
      this.state = 'done'
      return undefined
    }
    const outgoing = this.adjacency.filter(edge => edge.from === id)
    // Insertion order is the author's intent; dedupe already-visited nodes unless
    // the edge is an explicit loop (target visited < 2 times and budget remains).
    for (const edge of outgoing) {
      const target = edge.to
      if (!this.nodeById.has(target)) continue
      const targetVisits = this.visits.get(target) ?? 0
      if (this.completed.has(target) && targetVisits >= 2) continue
      if (edge.when !== undefined && edge.when.op !== 'always') continue
      this.pending.push(target)
    }
    return this.current()
  }

  done(): boolean {
    return this.state !== 'running' || (this.pending.length === 0 && this.currentId === undefined)
  }

  status(): 'running' | 'done' | 'failed' {
    return this.state
  }

  steps(): number {
    return this.stepCount
  }

  // -- mutation (used by graph_plan / replan) --------------------------------

  addNode(node: PlanNode, from?: readonly string[]): void {
    this.nodeById.set(node.id, node)
    this.mutations.push(`add:${node.id}`)
    if (this.pending.length === 0) this.pending.push(node.id)
    for (const source of from ?? []) {
      if (this.nodeById.has(source)) this.adjacency.push({ from: source, to: node.id, kind: 'control' })
    }
  }

  removeNode(id: string): void {
    if (id === this.basePlan.entry) return
    this.nodeById.delete(id)
    for (let index = this.adjacency.length - 1; index >= 0; index -= 1) {
      const edge = this.adjacency[index] as PlanEdge
      if (edge.from === id || edge.to === id) this.adjacency.splice(index, 1)
    }
    const pendingIndex = this.pending.indexOf(id)
    if (pendingIndex !== -1) this.pending.splice(pendingIndex, 1)
    this.mutations.push(`remove:${id}`)
  }

  addEdge(edge: PlanEdge): void {
    if (!this.nodeById.has(edge.from) || !this.nodeById.has(edge.to)) return
    this.adjacency.push(edge)
    this.mutations.push(`edge:${edge.from}->${edge.to}`)
  }

  snapshot(): TaskPlan {
    return {
      ...this.basePlan,
      nodes: [...this.nodeById.values()],
      edges: [...this.adjacency],
      compiledDigest: `${this.basePlan.compiledDigest}:v${this.mutations.length}`,
    }
  }
}
