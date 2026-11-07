/**
 * fallback.ts — the trivial single-node plan.
 *
 * This is the last-resort plan for a task that matched no template and that the
 * composer cannot stage (trivial text, subagent child, forced fallback). It is
 * live: `packages/loop/src/scheduler.ts` installs it. The legacy step-graph
 * walker that used to live beside it was test-only and has been removed.
 */
import type { PlanNode, TaskPlan } from './graph-schema.ts'

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
