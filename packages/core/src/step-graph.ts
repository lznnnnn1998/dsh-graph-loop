/**
 * Step graph: the smallest executable interpretation of a `TaskPlan`.
 *
 * A plan is a typed sub-graph (design/graph-schema.ts). The DSH driver runs one
 * DSH step per node, so the graph is advanced explicitly:
 *
 *   const graph = createStepGraph(plan)
 *   while (graph.current()) { run one step; graph.advance({ ok }) }
 *
 * This module is deliberately small and deterministic: no timers, no I/O, no
 * randomness. The LangGraph kernel (packages/loop/src/kernel) is the other
 * implementation of the same idea and can replace this executor later; the
 * driver depends only on `current/advance/done`, not on LangGraph types.
 */
import type {
  ArtifactType,
  Condition,
  PlanNode,
  PlanStatus,
  TaskPlan,
} from './graph-schema.ts'

/** What one executed node reports back to the graph. */
export interface StepOutcome {
  /** False when the step failed (model error, tool failure, validation failure). */
  readonly ok: boolean
  /** Deterministic facts produced by the step (used by `fact` conditions). */
  readonly facts?: Readonly<Record<string, string | number | boolean>>
  /** Artifacts produced by the step (used by `artifact` / `noArtifact` conditions). */
  readonly artifacts?: readonly ArtifactType[]
  /** Tools that failed during the step (used by `callFailed`). */
  readonly failedTools?: readonly string[]
  /** Budget readings for `budget` conditions. */
  readonly budgets?: { readonly steps: number; readonly tokens: number; readonly wall: number }
}

export interface StepGraph {
  readonly plan: TaskPlan
  /** Node to execute next, or undefined when the run is complete. */
  current(): PlanNode | undefined
  /** Record the outcome of `current()` and select the successor. */
  advance(outcome: StepOutcome): PlanNode | undefined
  done(): boolean
  status(): PlanStatus
  /** Visited node ids in execution order (bounded by maxSteps). */
  visited(): readonly string[]
  /** Number of completed nodes. */
  steps(): number
}

/** Condition evaluation context. */
interface ConditionContext {
  readonly facts: Readonly<Record<string, string | number | boolean>>
  readonly artifacts: ReadonlySet<ArtifactType>
  readonly failedTools: ReadonlySet<string>
  readonly budgets: { readonly steps: number; readonly tokens: number; readonly wall: number }
}

function conditionHolds(condition: Condition | undefined, context: ConditionContext): boolean {
  if (condition === undefined) return true
  switch (condition.op) {
    case 'always':
      return true
    case 'artifact':
      return context.artifacts.has(condition.type)
    case 'noArtifact':
      return !context.artifacts.has(condition.type)
    case 'fact':
      return context.facts[condition.key] === condition.equals
    case 'callFailed':
      return context.failedTools.has(condition.tool)
    case 'budget': {
      const remaining = condition.axis === 'steps'
        ? context.budgets.steps
        : condition.axis === 'tokens'
          ? context.budgets.tokens
          : context.budgets.wall
      return remaining <= condition.remainingAtMost
    }
    default:
      return false
  }
}

/**
 * Create the executable view of one compiled plan.
 * @param plan - a plan produced by `instantiate()`/`match()` or hand-authored.
 * @returns a deterministic step-by-step executor.
 */
export function createStepGraph(plan: TaskPlan): StepGraph {
  const byId = new Map(plan.nodes.map(node => [node.id, node]))
  const maxSteps = Math.max(1, plan.budget.maxSteps)
  let current: PlanNode | undefined = byId.get(plan.entry)
  let status: PlanStatus = current === undefined ? 'failed' : 'running'
  const visitedNodes: string[] = []
  let completed = 0
  const facts: Record<string, string | number | boolean> = {}
  const artifacts = new Set<ArtifactType>()
  const failedTools = new Set<string>()

  function finish(next: PlanStatus): void {
    status = next
    current = undefined
  }

  function successors(node: PlanNode): PlanNode | undefined {
    const outgoing = plan.edges.filter(edge => edge.from === node.id)
    if (outgoing.length === 0) return undefined
    const context: ConditionContext = { facts, artifacts, failedTools, budgets: { steps: maxSteps - completed, tokens: Number.MAX_SAFE_INTEGER, wall: Number.MAX_SAFE_INTEGER } }
    for (const edge of outgoing) {
      if (!conditionHolds(edge.when, context)) continue
      const next = byId.get(edge.to)
      if (next !== undefined) return next
    }
    return undefined
  }

  return {
    plan,
    current(): PlanNode | undefined {
      return current
    },
    advance(outcome: StepOutcome): PlanNode | undefined {
      const node = current
      if (node === undefined) return undefined
      visitedNodes.push(node.id)
      completed += 1
      if (outcome.facts !== undefined) Object.assign(facts, outcome.facts)
      for (const artifact of outcome.artifacts ?? []) artifacts.add(artifact)
      for (const tool of outcome.failedTools ?? []) failedTools.add(tool)
      if (!outcome.ok) {
        finish('failed')
        return undefined
      }
      if (completed >= maxSteps) {
        finish('done')
        return undefined
      }
      const next = successors(node)
      if (next === undefined) {
        finish(plan.terminals.includes(node.id) || plan.terminals.length === 0 ? 'done' : 'done')
        return undefined
      }
      current = next
      return current
    },
    done(): boolean {
      return current === undefined
    },
    status(): PlanStatus {
      return status
    },
    visited(): readonly string[] {
      return visitedNodes
    },
    steps(): number {
      return completed
    },
  }
}

/** Build a trivial two-node plan for a task when no template matched. */
export function fallbackPlan(input: {
  readonly id: string
  readonly instruction?: string
  readonly maxSteps?: number
}): TaskPlan {
  const entry: PlanNode = {
    id: 'node:respond',
    kind: 'agent-step',
    executor: 'step',
    instruction: input.instruction ?? 'Complete the user task. Use the available tools; report what you did.',
  }
  return {
    id: `plan:${input.id}`,
    templateId: 't_stock',
    version: 1,
    entry: entry.id,
    terminals: [entry.id],
    nodes: [entry],
    edges: [],
    budget: { maxNodes: 1, maxSteps: input.maxSteps ?? 8, maxTokens: 200_000, maxWallMs: 900_000, maxReplans: 0 },
    toolUniverse: [],
    gatePolicy: 'cold',
    fallback: true,
    confidence: 0,
    compiledDigest: `fallback:${input.id}`,
  } as TaskPlan
}
