/**
 * topology.ts — dynamic topology synthesis and the frontier executor.
 *
 * `compose.ts` is the default plan synthesizer for the shipped driver. This
 * module is still live: `templates.ts`/`match()` handle `template` mode and the
 * dynamic fallback, and `FrontierTopology` executes every plan shape the kernel
 * adapter does not own (parallel fan-out/join, subagent batches, reserved or
 * nonconforming node ids). `synthesizeTopology` hardcodes DSH tool names, which
 * is why the composer is the default; it remains the conservative fallback.
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
  Condition,
  Json,
  PlanEdge,
  PlanNode,
  TaskPlan,
  RegistryGraph,
} from './graph-schema.ts'
import {
  evaluateCondition,
  routeOrder,
  type RoutingArtifact,
  type RoutingBudget,
  type RoutingState,
} from './condition.ts'
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

function node(id: string, tool: string, instruction: string, model?: PlanNode['model'], extraTools: readonly string[] = [], optional = false): PlanNode {
  return {
    id,
    kind: 'tool-call',
    executor: 'step',
    capabilityId: `tool:${tool}`,
    instruction,
    toolAllow: [...new Set([tool, ...extraTools])],
    ...(optional ? { optional: true } : {}),
    ...(model === undefined ? {} : { model }),
  }
}

/** The tool-agnostic step-failure guard both engines route on. */
const STAGE_FAILED: Condition = { op: 'fact', key: 'lastOk', equals: false }

/** True for a guard that already routes a failed step (`callFailed` / `lastOk=false` / `toolSucceeded=false`). */
function isStageFailureGuard(when: Condition | undefined): boolean {
  if (when === undefined) return false
  if (when.op === 'callFailed') return true
  return when.op === 'fact'
    && (when.key === 'lastOk' || when.key === 'toolSucceeded')
    && when.equals === false
}

/** Nearest declared terminal reachable from `from` over control edges. */
function nearestTerminal(edges: readonly PlanEdge[], from: string, terminals: ReadonlySet<string>): string | undefined {
  const seen = new Set<string>([from])
  const queue: string[] = [from]
  while (queue.length > 0) {
    const id = queue.shift() as string
    for (const edge of edges) {
      if (edge.from !== id || edge.kind !== 'control') continue
      if (terminals.has(edge.to)) return edge.to
      if (seen.has(edge.to)) continue
      seen.add(edge.to)
      queue.push(edge.to)
    }
  }
  return undefined
}

/**
 * Give every non-terminal stage a state-driven failure exit to a declared
 * terminal. Without it a failed stage can only walk its unconditional success
 * edge (or stop at the step cap / GRAPH_FAILED); both engines route
 * `lastOk=false` over a guarded edge, so the stage answers instead.
 *
 * An authored failure guard wins: it is not replaced, so a plan that escalates
 * keeps its own recovery path. The target is the nearest terminal reachable
 * from the node, which keeps each branch pointed at its own endpoint.
 */
export function withStageFailureExits(
  nodes: readonly PlanNode[],
  edges: readonly PlanEdge[],
  terminals: readonly string[],
): PlanEdge[] {
  const terminalSet = new Set(terminals)
  if (terminalSet.size === 0) return [...edges]
  const guarded = new Set(edges.filter(edge => isStageFailureGuard(edge.when)).map(edge => edge.from))
  const result = [...edges]
  for (const node of nodes) {
    if (terminalSet.has(node.id) || guarded.has(node.id)) continue
    const target = nearestTerminal(result, node.id, terminalSet)
    if (target === undefined) continue
    result.push({ from: node.id, to: target, kind: 'control', when: STAGE_FAILED })
  }
  return result
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
      nodes.push(node(id, reader, toolInstruction(reader, 'inspect'), undefined, [], true))
      connect(id)
      rationale.push('inspect before mutating (read-before-write)')
    }
    const mutationTools = ['write', 'edit', 'str_replace_editor'].filter(name => presetTools.includes(name))
    const editor = firstAvailable(graph, presetTools, ['edit', 'write', 'str_replace_editor'])
    if (editor !== undefined) {
      const id = 'd_edit'
      const shellHint = presetTools.includes('bash')
        ? ' For rename, move or delete, use bash (`mv`, `rm`, `mkdir`).'
        : ''
      const instruction = mutationTools.length > 1
        ? `apply: produce the requested mutation. For new content use \`write\`; for in-place content edits use \`edit\`/\`str_replace_editor\`.${shellHint} Keep the change minimal and explain it.`
        : `${toolInstruction(editor, 'apply')}${shellHint}`
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
      nodes.push(node(id, reader, toolInstruction(reader, 'inspect'), undefined, [], true))
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
    edges: withStageFailureExits(nodes, edges, terminals),
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
  /** Facts folded from this step's durable tool results (lastOk, failedTool, hadToolCall, ...). */
  readonly facts?: Readonly<Record<string, Json>>
  /** Artifact refs produced by this step; the router sees refs, never file bodies. */
  readonly artifacts?: readonly RoutingArtifact[]
  /** Remaining budget; an omitted axis stays unknown and makes that budget guard false. */
  readonly budget?: Partial<RoutingBudget>
}

export class FrontierTopology {
  private readonly nodeById: Map<string, PlanNode>
  private readonly adjacency: PlanEdge[]
  private readonly pending: string[] = []
  private readonly completed = new Set<string>()
  /** Nodes that ever entered the frontier (queued, detached or run). */
  private readonly entered = new Set<string>()
  /** Nodes detached for a parallel batch and not yet completed. */
  private readonly detached = new Set<string>()
  private currentId: string | undefined
  private state: 'running' | 'done' | 'failed' = 'running'
  private readonly maxSteps: number
  private stepCount = 0
  private facts: Record<string, Json> = {}
  private readonly artifacts: RoutingArtifact[] = []
  /** Every mutation is appended here so the run can be explained/replayed. */
  readonly mutations: string[] = []

  constructor(private readonly basePlan: TaskPlan) {
    this.nodeById = new Map(basePlan.nodes.map(node => [node.id, node]))
    this.adjacency = [...basePlan.edges]
    this.maxSteps = basePlan.budget.maxSteps
    if (this.nodeById.has(basePlan.entry)) this.pending.push(basePlan.entry)
    else this.state = 'failed'
    this.entered.add(basePlan.entry)
  }

  /**
   * Idempotent peek: the same node until `advance()` completes it.
   *
   * The frontier is not FIFO: a forward join is deferred until its inputs have
   * arrived (see `joinBlocked`). Deferring keeps the node queued, so the run is
   * not reported done while a join is still waiting for a branch.
   */
  current(): PlanNode | undefined {
    if (this.state !== 'running') return undefined
    if (this.currentId !== undefined) return this.nodeById.get(this.currentId)
    for (;;) {
      if (this.pending.length === 0) {
        // A detached batch node is still running; its completion is the next
        // arrival, so the frontier is waiting rather than done.
        if (this.detached.size > 0) return undefined
        // An empty frontier is not automatically success: a guarded edge that
        // did not match (or a plan with no exit) leaves work unfinished. Report
        // `done` only when a declared terminal actually ran, otherwise `failed`
        // so the turn is not reported completed without its endpoint.
        this.state = this.terminalsReached() ? 'done' : 'failed'
        return undefined
      }
      let index = this.pending.findIndex(id => !this.joinBlocked(id))
      if (index === -1) {
        if (this.detached.size > 0) return undefined
        // Nothing queued has all its inputs and nothing is in flight: run the
        // oldest node rather than deadlock. A predecessor that can never arrive
        // (a mutated-away node) must not stop the run; maxSteps still bounds it.
        index = 0
      }
      const id = this.pending.splice(index, 1)[0] as string
      const node = this.nodeById.get(id)
      if (node === undefined) continue
      this.currentId = id
      return node
    }
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
    this.detached.add(id)
    return this.nodeById.get(id)
  }

  /** Make an already-detached node the current one (used by parallel batches). */
  select(id: string): PlanNode | undefined {
    const node = this.nodeById.get(id)
    if (node === undefined) return undefined
    this.currentId = id
    return node
  }

  /**
   * Queue a successor without duplicating a fan-in join.
   *
   * A forward edge to a node that is already queued or completed would run the
   * same join twice (every branch of a diamond pushes it). A back-edge — the
   * target can reach the source through control edges — is a retry/repair loop
   * and may re-enter until `maxSteps` bounds it.
   */
  private enqueue(target: string, source: string): void {
    if (!this.nodeById.has(target)) return
    if (this.pending.includes(target)) return
    if (this.completed.has(target) && !this.reaches(target, source)) return
    this.pending.push(target)
    this.entered.add(target)
  }

  /**
   * Join barrier: a forward join runs only after every input that has entered
   * the run has completed, and only when no queued node can still deliver one.
   *
   * The old dedupe only asked "is this target already queued/completed"; it did
   * not order a join after a *deeper* sibling, so `a -> b, c; b -> d; c -> c2;
   * c2 -> d` ran `d` before `c2` and then dropped the `c2 -> d` edge. Two rules
   * close that hole:
   *
   *  - A predecessor that has already entered the run (`entered`) must complete
   *    before the join can run. A predecessor that never entered — a guarded
   *    branch that did not fire — cannot deliver an input, so it must not block.
   *  - A queued node that can still reach the join means another input is on the
   *    way, even if the direct predecessor has not been enqueued yet (its parent
   *    is still queued).
   *
   * Neither rule asks whether the edge is part of a cycle. A join inside a cycle
   * still has to wait for the inputs of the current iteration; the re-entry is
   * ordered by the same barrier on the next pass, and `maxSteps` bounds the loop.
   */
  private joinBlocked(target: string): boolean {
    for (const edge of this.adjacency) {
      if (edge.kind !== 'control' || edge.to !== target) continue
      const predecessor = edge.from
      if (predecessor === target) continue
      if (this.completed.has(predecessor)) continue
      if (this.entered.has(predecessor)) return true
    }
    return this.pendingReaches(target)
  }

  /**
   * True when a queued node can still deliver an input to `target`.
   *
   * Only paths through nodes that have not completed count: a completed node
   * already ran in this pass, so work behind it is not an outstanding input to
   * this join (otherwise a join inside a cycle would wait for a downstream
   * sibling forever). This is what lets a depth-2 branch (`c -> c2 -> c3 -> d`)
   * hold the join until `c3` arrives while a cycle back through the entry does
   * not.
   */
  private pendingReaches(target: string): boolean {
    for (const start of this.pending) {
      if (start === target) continue
      const seen = new Set<string>([start])
      const stack: string[] = [start]
      while (stack.length > 0) {
        const id = stack.pop() as string
        for (const edge of this.adjacency) {
          if (edge.from !== id || edge.kind !== 'control') continue
          if (edge.to === target) return true
          if (this.completed.has(edge.to) || seen.has(edge.to)) continue
          seen.add(edge.to)
          stack.push(edge.to)
        }
      }
    }
    return false
  }

  /**
   * True when the run reached a valid endpoint. `TaskPlan.terminals` are
   * alternative endpoints — validation requires each to be a leaf, and a branch
   * plan legitimately reaches only one of them — so any reached terminal counts.
   * Using `every` would mark a branch completion as failed whenever a different
   * terminal stayed unreached.
   */
  private terminalsReached(): boolean {
    return this.basePlan.terminals.some(terminal => this.completed.has(terminal))
  }

  /** True when `to` is reachable from `from` over control edges (back-edge test). */
  private reaches(from: string, to: string): boolean {
    const seen = new Set<string>()
    const stack: string[] = [from]
    while (stack.length > 0) {
      const id = stack.pop() as string
      if (id === to) return true
      if (seen.has(id)) continue
      seen.add(id)
      for (const edge of this.adjacency) {
        if (edge.from === id && edge.kind === 'control') stack.push(edge.to)
      }
    }
    return false
  }

  advance(outcome: FrontierAdvance): PlanNode | undefined {
    const id = this.currentId
    this.currentId = undefined
    if (id === undefined) return undefined
    this.completed.add(id)
    this.detached.delete(id)
    this.stepCount += 1
    const folded: Record<string, Json> = { ...this.facts, ...(outcome.facts ?? {}) }
    // Compatibility: an advance that reports only `ok`/`failedTool` still
    // projects the two facts every `callFailed` guard reads.
    if (folded['lastOk'] === undefined) folded['lastOk'] = outcome.ok
    if (folded['failedTool'] === undefined && outcome.failedTool !== undefined) folded['failedTool'] = outcome.failedTool
    this.facts = folded
    if (outcome.artifacts !== undefined) this.artifacts.push(...outcome.artifacts)
    const routingState: RoutingState = {
      facts: this.facts,
      artifacts: this.artifacts,
      // Only the step axis has a producer; see `RoutingBudget`. A caller can
      // override the remaining count (tests), but cannot supply token/wall.
      budget: { stepsRemaining: outcome.budget?.stepsRemaining ?? Math.max(0, this.maxSteps - this.stepCount) },
    }

    if (!outcome.ok) {
      // The step budget bounds recovery too: a condition-led recovery loop is
      // still a loop, so it must terminate when `maxSteps` is exhausted (H3).
      if (this.stepCount >= this.maxSteps) {
        this.state = 'failed'
        return undefined
      }
      // A failed node only continues on an explicit guarded edge. An
      // unconditional success edge must not mask the failure.
      const recovery = routeOrder(this.adjacency.filter(edge => edge.from === id && edge.kind === 'control'))
        .find(edge => edge.when !== undefined && edge.when.op !== 'always' && evaluateCondition(edge.when, routingState))
      if (recovery === undefined) {
        this.state = 'failed'
        return undefined
      }
      this.enqueue(recovery.to, id)
      return this.current()
    }

    if (this.stepCount >= this.maxSteps) {
      // The step cap is not success. Report done only when the plan actually
      // reached a terminal; otherwise the run stops mid-plan and must settle as
      // failed. Treating the cap as done reported a truncated run as a
      // completed turn.
      //
      // One-step reserve: a matching `budget` edge to a declared terminal is the
      // plan's own wrap-up. The kernel adapter already grants this step (it
      // checks the cap before the pause hook); without it the frontier failed
      // where the kernel ran the answer, and the engines disagreed for the same
      // plan.
      const budgetExit = routeOrder(this.adjacency.filter(edge => edge.from === id && edge.kind === 'control'))
        .find(edge => edge.when?.op === 'budget'
          && this.basePlan.terminals.includes(edge.to)
          && evaluateCondition(edge.when, routingState))
      if (budgetExit !== undefined && this.nodeById.has(budgetExit.to)) {
        this.enqueue(budgetExit.to, id)
        return this.current()
      }
      this.state = this.terminalsReached() ? 'done' : 'failed'
      return undefined
    }
    // A guarded edge is an alternative, not a parallel branch: at most one
    // guarded exit is taken, and a matching guard suppresses the unconditional
    // fan-out below (the kernel refuses plans with >1 unconditional out-edge,
    // so this combination only reaches the frontier).
    const outgoing = this.adjacency.filter(edge => edge.from === id && edge.kind === 'control')
    const guarded = outgoing.filter(edge => edge.when !== undefined && edge.when.op !== 'always')
    if (guarded.length > 0) {
      const selected = routeOrder(guarded).find(edge => evaluateCondition(edge.when, routingState))
      if (selected !== undefined && this.nodeById.has(selected.to)) {
        this.enqueue(selected.to, id)
        return this.current()
      }
    }
    const fallback = routeOrder(outgoing.filter(edge => edge.when === undefined || edge.when.op === 'always'))
    for (const edge of fallback) {
      // Retries are bounded by maxSteps, not by a visit counter: a verify ->
      // repair loop must be able to run until the budget is gone, while a
      // fan-in join must not run twice.
      this.enqueue(edge.to, id)
    }
    return this.current()
  }

  done(): boolean {
    return this.state !== 'running'
      || (this.pending.length === 0 && this.currentId === undefined && this.detached.size === 0)
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
    if (this.pending.length === 0) {
      this.pending.push(node.id)
      this.entered.add(node.id)
    }
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
    // A removed node can no longer deliver an input: forgetting it unblocks a
    // join that was waiting for it. `entered` only marks live inputs.
    this.entered.delete(id)
    this.detached.delete(id)
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
 * Linear boundary-recovery graph for a failed verification node
 * (diagnose -> edit -> re-verify -> answer). It is the scheduler's safety net
 * when the failed plan had no composed repair exit; its retry allowance is the
 * scheduler's `maxReplans`, not a condition edge inside this graph.
 */
export function repairTopology(input: {
  readonly taskHash: string
  readonly failedNode: string
  readonly failedTool?: string
  readonly budget?: Partial<TopologyBudget>
}): TaskPlan {
  const budget = { ...budgetOf(input.budget), maxReplans: input.budget?.maxReplans ?? 2 }
  const nodes: PlanNode[] = [
    {
      id: 'r_diagnose',
      kind: 'agent-step',
      executor: 'step',
      instruction: `Verification (${input.failedNode}${input.failedTool ? ` via ${input.failedTool}` : ''}) failed. Diagnose the exact failure from the last output; identify the smallest fix.`,
    },
    {
      id: 'r_edit',
      kind: 'agent-step',
      executor: 'step',
      instruction: 'Apply the smallest fix identified by the diagnosis. Do not rewrite unrelated work.',
    },
    {
      id: 'r_verify',
      kind: 'agent-step',
      executor: 'step',
      instruction: 'Re-run the verification that failed. Report the exact command and its result; do not claim success without it.',
    },
    {
      id: 'r_answer',
      kind: 'terminal',
      executor: 'step',
      instruction: 'Report what failed, what was repaired, the verification result, and any remaining risk.',
      toolAllow: [],
    },
  ]
  return {
    id: `repair:${input.taskHash}:${input.failedNode}`,
    templateId: 'repair',
    version: 1,
    entry: 'r_diagnose',
    terminals: ['r_answer'],
    nodes,
    edges: withStageFailureExits(nodes, [
      { from: 'r_diagnose', to: 'r_edit', kind: 'control' },
      { from: 'r_edit', to: 'r_verify', kind: 'control' },
      { from: 'r_verify', to: 'r_answer', kind: 'control' },
    ], ['r_answer']),
    budget,
    toolUniverse: [],
    gatePolicy: 'cold',
    fallback: true,
    confidence: 0.5,
    compiledDigest: `repair:${input.taskHash}:${input.failedNode}`,
  }
}

/**
 * Linear boundary-recovery graph for a non-verification failure
 * (diagnose -> retry -> answer). Like `repairTopology` it is a safety net for a
 * plan that had no matching exit; `maxReplans: 0` means it runs once.
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
    edges: withStageFailureExits(nodes, [
      { from: 'r_diagnose', to: 'r_retry', kind: 'control' },
      { from: 'r_retry', to: 'r_answer', kind: 'control' },
    ], ['r_answer']),
    budget,
    toolUniverse: [],
    gatePolicy: 'cold',
    fallback: true,
    confidence: 0.4,
    compiledDigest: `recovery:${input.taskHash}:${input.failedNode}`,
  }
}
