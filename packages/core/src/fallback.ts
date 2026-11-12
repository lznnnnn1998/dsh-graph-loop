/**
 * fallback.ts — the turn skeleton and the last-resort plan.
 *
 * R4: every turn is a multi-node graph. `orientAnswerSkeleton` is the single
 * producer of the minimal turn shape (`orient` works, a distinct answer-only
 * `terminal` reports), so no producer — fallback, generic composition or the
 * no-capability synthesizer — can emit a one-node plan whose entry is also the
 * terminal. The legacy step-graph walker that used to live beside this file was
 * test-only and has been removed.
 */
import type { PlanEdge, PlanNode, TaskPlan } from './graph-schema.ts'

/** The minimal turn skeleton: one work node and a distinct answer-only terminal. */
export interface OrientAnswerSkeleton {
  readonly nodes: PlanNode[]
  readonly edges: PlanEdge[]
  readonly entry: string
  readonly terminals: string[]
}

/**
 * Build the `orient → answer` skeleton.
 *
 * The caller owns the id dialect of its plan, so the two node ids are passed in
 * rather than minted here. The terminal is always `kind: 'terminal'` with no
 * tools: the answer is a report, so the last step cannot end on a tool call and
 * leave the turn with no assistant text. Work that must continue belongs to the
 * orient node, not to the terminal.
 */
export function orientAnswerSkeleton(input: {
  readonly orientId: string
  readonly answerId: string
  readonly orientInstruction?: string
  readonly answerInstruction?: string
}): OrientAnswerSkeleton {
  const orient: PlanNode = {
    id: input.orientId,
    kind: 'agent-step',
    executor: 'step',
    instruction: input.orientInstruction ?? 'Complete the user task. Use the available tools; report what you did.',
  }
  const answer: PlanNode = {
    id: input.answerId,
    kind: 'terminal',
    executor: 'step',
    instruction: input.answerInstruction ?? 'Report what you did, what you verified, and any remaining risk. Do not start new work.',
    toolAllow: [],
  }
  return {
    nodes: [orient, answer],
    edges: [{ from: orient.id, to: answer.id, kind: 'control' }],
    entry: orient.id,
    terminals: [answer.id],
  }
}

/**
 * Build the last-resort turn plan for a task when nothing composed it.
 *
 * The ids follow the R4 grammar (`<kind>.<stage>.<attempt>`); the kernel rejects
 * dotted node names, so these plans run on the frontier on every engine.
 */
export function fallbackPlan(input: {
  readonly id: string
  readonly instruction?: string
  readonly maxSteps?: number
}): TaskPlan {
  const skeleton = orientAnswerSkeleton({
    orientId: 'orient.1.1',
    answerId: 'answer.1.1',
    ...(input.instruction === undefined ? {} : { orientInstruction: input.instruction }),
  })
  return {
    id: `plan:${input.id}`,
    templateId: 'turn',
    version: 1,
    entry: skeleton.entry,
    terminals: skeleton.terminals,
    nodes: skeleton.nodes,
    edges: skeleton.edges,
    budget: { maxNodes: 2, maxSteps: input.maxSteps ?? 8, maxTokens: 200_000, maxWallMs: 900_000, maxReplans: 0 },
    toolUniverse: [],
    gatePolicy: 'cold',
    fallback: true,
    confidence: 0,
    compiledDigest: `fallback:${input.id}`,
  } as TaskPlan
}
