/**
 * @deprecated 0.1.x legacy. The 0.2 composition layer synthesizes plans from
 * capability facts in `compose.ts`; this module hardcodes DSH tool names and is
 * kept only for the frozen graph driver.
 *
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
  /** Child agents set this false so a fan-out cannot recurse into another fan-out. */
  readonly allowSubagents?: boolean
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

/**
 * Tools kept in every synthesized plan even when no node names them. Models
 * routinely reach for a list/inspect/create/verify tool before the stage's tool;
 * hiding it turns an ordinary first attempt into a failed node. The floor is
 * small and only contains tools available in the preset.
 */
const SAFE_TOOL_FLOOR = ['read', 'glob', 'grep', 'write', 'edit', 'bash', 'present'] as const

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

function node(id: string, tool: string, instruction: string, model?: PlanNode['model'], extraTools: readonly string[] = []): PlanNode {
  return {
    id,
    kind: 'tool-call',
    executor: 'step',
    capabilityId: `tool:${tool}`,
    instruction,
    toolAllow: [...new Set([tool, ...extraTools])],
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

  // Research fan-out keeps a planning entry; file/coding tasks start with work
  // so the graph does not pay one full model step just to restate the task.
  const needsEntry = wantsWeb
  const entry: PlanNode = {
    id: 'd_entry',
    kind: 'agent-step',
    executor: 'step',
    instruction: 'Restate the task in one sentence and name the artifact you will deliver. Then continue.',
  }
  let cursor: string | undefined
  if (needsEntry) {
    nodes.push(entry)
    cursor = entry.id
  }
  const connect = (to: string): void => {
    if (cursor !== undefined) link(cursor, to)
    cursor = to
  }

  const discoveryTool = firstAvailable(graph, presetTools, ['grep', 'glob'])
  if (!mutating && !wantsWeb && discoveryTool !== undefined) {
    const id = `d_${discoveryTool}`
    nodes.push(node(id, discoveryTool, toolInstruction(discoveryTool, 'discover')))
    connect(id)
    rationale.push(`discovery via ${discoveryTool} (intent ${fingerprint.intent})`)
  }

  if (mutating) {
    const reader = firstAvailable(graph, presetTools, ['read'])
    if (reader !== undefined) {
      const id = 'd_read'
      nodes.push(node(id, reader, toolInstruction(reader, 'inspect')))
      connect(id)
      rationale.push('inspect before mutating (read-before-write)')
    }
    const mutationTools = ['write', 'edit', 'str_replace_editor'].filter(name => presetTools.includes(name))
    const editor = firstAvailable(graph, presetTools, ['edit', 'write', 'str_replace_editor'])
    if (editor !== undefined) {
      const id = 'd_edit'
      const instruction = mutationTools.length > 1
        ? 'apply: create a new artifact with `write`, or modify an existing one with `edit`/`str_replace_editor`; keep the change minimal and explain it.'
        : toolInstruction(editor, 'apply')
      nodes.push(node(id, editor, instruction, undefined, mutationTools))
      connect(id)
      rationale.push(`mutation via ${editor}`)
    }
    const verifier = firstAvailable(graph, presetTools, ['bash', 'pwsh'])
    if (verifier !== undefined) {
      const id = 'd_verify'
      nodes.push(node(id, verifier, toolInstruction(verifier, 'verify')))
      connect(id)
      rationale.push(`verification via ${verifier}`)
    }
  } else if (wantsWeb) {
    const search = firstAvailable(graph, presetTools, ['web_search'])
    const fetch = firstAvailable(graph, presetTools, ['web_fetch'])
    // Arbitrary shape: fan out to two fresh-context subagent nodes, join at the answer.
    const allowSubagents = input.allowSubagents !== false
    const answerId = 'd_answer'
    if (!allowSubagents) {
      const searchId = 'd_search'
      nodes.push(node(searchId, search ?? firstAvailable(graph, presetTools, ['read']) ?? 'read', toolInstruction(search ?? 'read', 'research')))
      link(nodes[0]!.id, searchId)
      link(searchId, answerId)
      rationale.push('research in one context (child agent: no nested fan-out)')
      nodes.push({ id: answerId, kind: 'terminal', executor: 'step', instruction: 'Answer with the evidence gathered above.', toolAllow: [] })
      return finish(input, nodes, edges, nodes[0]!.id, [answerId], budget, rationale, 'dynamic')
    }
    if (search !== undefined && fetch !== undefined) {
      const searchId = 'd_search'
      const fetchId = 'd_fetch'
      nodes.push({ ...node(searchId, search, toolInstruction(search, 'research')), executor: 'subagent' })
      nodes.push({ ...node(fetchId, fetch, toolInstruction(fetch, 'research')), executor: 'subagent' })
      link(nodes[0]!.id, searchId)
      link(nodes[0]!.id, fetchId)
      rationale.push('parallel research fan-out (search + fetch subagents)')
      link(searchId, answerId)
      link(fetchId, answerId)
    } else {
      // No web tools in this preset: the same topology with two generic
      // investigator subagents, so parallel branches still work.
      const aId = 'd_research_a'
      const bId = 'd_research_b'
      nodes.push({ id: aId, kind: 'agent-step', executor: 'subagent', instruction: 'Investigate the first half of the research question. Report evidence with sources and uncertainty.' })
      nodes.push({ id: bId, kind: 'agent-step', executor: 'subagent', instruction: 'Investigate the second half of the research question. Report evidence with sources and uncertainty.' })
      link(nodes[0]!.id, aId)
      link(nodes[0]!.id, bId)
      rationale.push('parallel research fan-out (two investigator subagents)')
      link(aId, answerId)
      link(bId, answerId)
    }
    nodes.push({
      id: answerId,
      kind: 'terminal',
      executor: 'step',
      instruction: 'Synthesize the findings into the requested answer with citations; state uncertainty explicitly.',
      toolAllow: [],
    })
    return finish(input, nodes, edges, nodes[0]!.id, [answerId], budget, rationale, 'dynamic')
  } else {
    const reader = firstAvailable(graph, presetTools, ['read', 'read_image'])
    if (reader !== undefined) {
      const id = 'd_read'
      nodes.push(node(id, reader, toolInstruction(reader, 'inspect')))
      connect(id)
      rationale.push(`inspection via ${reader}`)
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
  if (cursor !== undefined) link(cursor, answerId)
  rationale.push(`terminal answer after ${nodes.length - 1} capability nodes`)
  return finish(input, nodes, edges, nodes[0]!.id, [answerId], budget, rationale, 'dynamic')
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
    toolUniverse: [...new Set([
      ...nodes.flatMap(node => node.toolAllow ?? []),
      ...SAFE_TOOL_FLOOR.filter(name => input.presetTools.includes(name)),
    ])],
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

  /** Peek the nodes currently queued (does not pop). */
  pendingNodes(): readonly PlanNode[] {
    return this.pending.map(id => this.nodeById.get(id)).filter((node): node is PlanNode => node !== undefined)
  }

  /** Remove a queued node so a batch can own its execution. */
  detach(id: string): PlanNode | undefined {
    const index = this.pending.indexOf(id)
    if (index === -1) return undefined
    this.pending.splice(index, 1)
    return this.nodeById.get(id)
  }

  /** Make an already-detached node the current one (used by parallel batches). */
  select(id: string): PlanNode | undefined {
    const node = this.nodeById.get(id)
    if (node === undefined) return undefined
    this.currentId = id
    return node
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


/**
 * Boundary replan: a small recovery graph built when a work node fails.
 * Diagnosis is deliberately separate from retry so the retry sees the failure.
 */
export function recoveryTopology(input: {
  readonly taskHash: string
  readonly failedNode: string
  readonly failedTool?: string
  readonly budget?: Partial<TopologyBudget>
}): TaskPlan {
  const budget = { ...budgetOf(input.budget), maxReplans: 0 }
  const nodes: PlanNode[] = [
    {
      id: 'r_diagnose',
      kind: 'agent-step',
      executor: 'step',
      instruction: `A previous node (${input.failedNode}${input.failedTool ? ` via ${input.failedTool}` : ''}) failed. Diagnose the cause from the last error and the workspace; do not retry blindly.`,
    },
    {
      id: 'r_retry',
      kind: 'agent-step',
      executor: 'step',
      instruction: 'Apply the smallest correction identified by the diagnosis, then continue the task.',
    },
    {
      id: 'r_answer',
      kind: 'terminal',
      executor: 'step',
      instruction: 'Report what failed, what you changed, and the verified outcome. State any remaining risk.',
      toolAllow: [],
    },
  ]
  return {
    id: `recovery:${input.taskHash}:${input.failedNode}`,
    templateId: 'recovery',
    version: 1,
    entry: 'r_diagnose',
    terminals: ['r_answer'],
    nodes,
    edges: [
      { from: 'r_diagnose', to: 'r_retry', kind: 'control' },
      { from: 'r_retry', to: 'r_answer', kind: 'control' },
    ],
    budget,
    toolUniverse: [],
    gatePolicy: 'cold',
    fallback: true,
    confidence: 0.4,
    compiledDigest: `recovery:${input.taskHash}:${input.failedNode}`,
  }
}
