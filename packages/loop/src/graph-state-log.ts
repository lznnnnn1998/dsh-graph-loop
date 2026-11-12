/**
 * graph-state-log.ts — durable graph boundaries for a resumed turn.
 *
 * The kernel's checkpointer is a per-run cache (C5): it never carries a graph
 * across a turn boundary, and the session log is the only authoritative history
 * (C3). This module writes one `plugin:` record per completed node boundary and
 * folds the log prefix back into the plan + state a new turn resumes from. The
 * record is ignorable and never enters the model-visible surface; a reader that
 * does not recognize it skips it, and fork/resume carry it with the rest of the
 * log.
 *
 * The payload is a plain-JSON snapshot because graph state is JSON by contract
 * (C1); a restored record is validated before use, since it may have been
 * written by an earlier build of this owner.
 */

import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import { appendPluginRecord, pluginRecordOf } from '@deepseek-ai/dsh-session'
import type { GraphState, TaskPlan } from 'dsh-graph-loop-core/graph-schema'

/** Record name; the owning package declares its payload in {@link PluginRecordMap}. */
export const GRAPH_CHECKPOINT_RECORD = 'plugin:graph-loop/checkpoint' as const

/** One durable node boundary: the `step/end` seq, the plan and the folded state. */
export interface GraphCheckpointRecord {
  /** Session seq of the `step/end` this boundary closed. */
  readonly atSeq: number
  /** Plan the boundary belongs to, so a resumed turn keeps the same identity. */
  readonly plan: TaskPlan
  /** Kernel state after the node; `next` names the node the resumed turn runs. */
  readonly state: GraphState
}

/** A folded graph boundary the next turn can resume. */
export interface GraphResumeState {
  readonly plan: TaskPlan
  readonly state: GraphState
}

declare module '@deepseek-ai/dsh-session/types' {
  interface PluginRecordMap {
    /** A completed graph node boundary, durable enough to resume the plan. */
    'plugin:graph-loop/checkpoint': GraphCheckpointRecord
  }
}

/**
 * Append one completed node boundary to the session log.
 *
 * @param session - the session whose log receives the record.
 * @param plan - plan the boundary belongs to.
 * @param state - kernel state after the node.
 * @param atSeq - session seq of the `step/end` that closed the node.
 * @returns the record's own session seq.
 */
export function appendGraphCheckpoint(
  session: Session,
  plan: TaskPlan,
  state: GraphState,
  atSeq: number,
): number {
  return appendPluginRecord(session, GRAPH_CHECKPOINT_RECORD, { atSeq, plan, state })
}

/**
 * Fold the newest checkpoint out of the session log prefix.
 *
 * The log is append-only and each record carries the state after its node, so a
 * later record supersedes an earlier one. Only a run that is still `running` and
 * names a declared `next` node resumes: a completed or failed run is the
 * previous turn's result, not a run to continue.
 *
 * @param session - session whose log prefix is folded.
 * @returns the plan + state to resume, or undefined when no run is in flight.
 */
export function foldGraphCheckpoint(session: Session): GraphResumeState | undefined {
  try {
    // oxlint-disable-next-line typescript/no-deprecated -- One prefix fold at run start; the synchronous read is migrated later like runtime-context.ts.
    return foldGraphCheckpointEvents(session.snapshotEvents())
  } catch {
    // A log that cannot be folded is history without graph state, not a reason
    // to fail the turn that was about to start.
    return undefined
  }
}

/** Minimal structural view of the graph driver a boundary record is read from. */
export interface GraphBoundarySource {
  readonly stateSnapshot?: () => GraphState | undefined
  snapshot(): { readonly plan: TaskPlan }
}

/**
 * Record the driver's current boundary, when the topology owns a resumable
 * state (the kernel does; the frontier does not).
 *
 * A rejected append never fails the step whose `step/end` is already logged:
 * the turn continues and the next turn starts a fresh plan.
 *
 * @returns true when a record was committed.
 */
export function recordGraphBoundary(
  session: Session,
  source: GraphBoundarySource,
  atSeq: number | undefined,
): boolean {
  if (atSeq === undefined) return false
  const state = source.stateSnapshot?.()
  if (state === undefined) return false
  try {
    appendGraphCheckpoint(session, source.snapshot().plan, state, atSeq)
    return true
  } catch {
    return false
  }
}

/**
 * Fold checkpoint records out of an explicit event prefix.
 *
 * Kept separate from the session read so the fold is a pure, testable function
 * of the log.
 *
 * @param events - the session events to fold, oldest first.
 * @returns the resumable plan + state, or undefined.
 */
export function foldGraphCheckpointEvents(events: readonly SessionEvent[]): GraphResumeState | undefined {
  let folded: GraphResumeState | undefined
  for (const event of events) {
    const record = pluginRecordOf(event)
    if (record === undefined || record.type !== GRAPH_CHECKPOINT_RECORD) continue
    const payload = parseGraphCheckpoint(record.data)
    if (payload === undefined) continue
    folded = { plan: payload.plan, state: payload.state }
  }
  return folded !== undefined && resumable(folded) ? folded : undefined
}

/** True when a folded boundary names a node the next turn can actually run. */
function resumable({ plan, state }: GraphResumeState): boolean {
  if (state.planId !== plan.id || state.planVersion !== plan.version) return false
  if (state.status !== 'running' || state.next === null) return false
  return plan.nodes.some(node => node.id === state.next)
}

/**
 * Validate one committed record payload.
 *
 * A restored record is untrusted input: the owner checks the shape it reads
 * instead of letting a malformed payload reach routing.
 */
export function parseGraphCheckpoint(data: unknown): GraphCheckpointRecord | undefined {
  if (!isRecord(data)) return undefined
  const atSeq = data['atSeq']
  if (typeof atSeq !== 'number' || !Number.isSafeInteger(atSeq) || atSeq < 0) return undefined
  const plan = data['plan']
  const state = data['state']
  if (!isPlan(plan) || !isGraphState(state)) return undefined
  return { atSeq, plan, state }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isPlan(value: unknown): value is TaskPlan {
  if (!isRecord(value)) return false
  if (typeof value['id'] !== 'string' || typeof value['version'] !== 'number') return false
  if (typeof value['entry'] !== 'string') return false
  const nodes = value['nodes']
  if (!Array.isArray(nodes) || nodes.length === 0) return false
  if (!nodes.every(node => isRecord(node) && typeof node['id'] === 'string' && typeof node['executor'] === 'string')) {
    return false
  }
  const edges = value['edges']
  if (!Array.isArray(edges)) return false
  if (!edges.every(edge => isRecord(edge) && typeof edge['from'] === 'string' && typeof edge['to'] === 'string')) {
    return false
  }
  const terminals = value['terminals']
  if (!Array.isArray(terminals) || !terminals.every(terminal => typeof terminal === 'string')) return false
  const budget = value['budget']
  return isRecord(budget) && typeof budget['maxSteps'] === 'number'
}

function isGraphState(value: unknown): value is GraphState {
  if (!isRecord(value)) return false
  if (typeof value['planId'] !== 'string' || typeof value['planVersion'] !== 'number') return false
  if (typeof value['taskHash'] !== 'string' || typeof value['superstep'] !== 'number') return false
  if (value['status'] !== 'running' && value['status'] !== 'done' && value['status'] !== 'failed') return false
  const next = value['next']
  if (next !== null && typeof next !== 'string') return false
  if (!isRecord(value['facts'])) return false
  if (!Array.isArray(value['journal']) || !Array.isArray(value['artifacts'])) return false
  return isRecord(value['budget'])
}
