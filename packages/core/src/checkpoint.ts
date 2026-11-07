/**
 * checkpoint.ts — the authoritative graph checkpoint contract (0.2 composition layer).
 *
 * A checkpoint is a JSON-safe snapshot of `GraphState` taken at a node boundary.
 * It is the authority for graph state; the session log remains the conversation
 * of record. Storage is pluggable:
 *
 *   - `CheckpointStore` is the port (put / latest / list / prune);
 *   - `TableCheckpointStore` adapts a key-value table shaped like
 *     `@deepseek-ai/dsh-storage-domain`'s `KvTable` (get / entries / put /
 *     deleteMany). The actual domain is opened by the bundle row, so this module
 *     has no DSH dependency;
 *   - `InMemoryCheckpointStore` is the deterministic test/development store.
 *
 * Invariants:
 *   - writes happen only at node boundaries (`node-start` / `node-end`);
 *   - a checkpoint is JSON-only and capped by `GRAPH_STATE_LIMITS`;
 *   - `latest` is deterministic: highest seq, `node-end` wins a tie, then node id;
 *   - `prune` keeps the newest N turns by checkpoint time.
 */

import {
  GRAPH_STATE_LIMITS,
  assertJsonSafe,
  type GraphState,
} from './graph-schema.ts'

// ---------------------------------------------------------------------------
// Contract
// ---------------------------------------------------------------------------

export type CheckpointBoundary = 'node-start' | 'node-end'

export interface GraphCheckpoint {
  readonly sessionId: string
  readonly turnId: string
  readonly nodeId: string
  /** Monotonic within a turn; ties are resolved by boundary then node id. */
  readonly seq: number
  readonly boundary: CheckpointBoundary
  /** Typed graph channels; JSON-only and size-capped. */
  readonly state: GraphState
  readonly planDigest: string
  readonly envelopeId: string
  /** Wall-clock ms, used only for pruning and display, never for ordering nodes. */
  readonly createdAt: number
}

export interface CheckpointStore {
  put(checkpoint: GraphCheckpoint): Promise<void>
  latest(sessionId: string, turnId: string): Promise<GraphCheckpoint | undefined>
  list(sessionId: string, turnId: string): Promise<readonly GraphCheckpoint[]>
  /** Keep the newest `keepTurns` turns for a session; returns how many records were removed. */
  prune(sessionId: string, keepTurns: number): Promise<number>
  close?(): Promise<void>
}

export type CheckpointIssueCode =
  | 'invalid-id'
  | 'invalid-seq'
  | 'invalid-boundary'
  | 'invalid-time'
  | 'missing-digest'
  | 'state-not-json'
  | 'state-too-large'

export interface CheckpointIssue {
  readonly code: CheckpointIssueCode
  readonly detail: string
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

const BOUNDARIES: readonly CheckpointBoundary[] = ['node-start', 'node-end']

function nonEmpty(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0
}

/** Serialized size in bytes; UTF-8, matching DSH's byte-based limits. */
export function checkpointBytes(checkpoint: GraphCheckpoint): number {
  return new TextEncoder().encode(JSON.stringify(checkpoint)).length
}

/** Validate one checkpoint against the contract; an empty array means valid. */
export function validateCheckpoint(checkpoint: GraphCheckpoint): readonly CheckpointIssue[] {
  const issues: CheckpointIssue[] = []
  if (!nonEmpty(checkpoint.sessionId)) issues.push({ code: 'invalid-id', detail: 'sessionId must be a non-empty string' })
  if (!nonEmpty(checkpoint.turnId)) issues.push({ code: 'invalid-id', detail: 'turnId must be a non-empty string' })
  if (!nonEmpty(checkpoint.nodeId)) issues.push({ code: 'invalid-id', detail: 'nodeId must be a non-empty string' })
  if (!Number.isInteger(checkpoint.seq) || checkpoint.seq < 0) {
    issues.push({ code: 'invalid-seq', detail: 'seq must be a non-negative integer' })
  }
  if (!BOUNDARIES.includes(checkpoint.boundary)) {
    issues.push({ code: 'invalid-boundary', detail: 'boundary must be node-start or node-end' })
  }
  if (!Number.isFinite(checkpoint.createdAt) || checkpoint.createdAt < 0) {
    issues.push({ code: 'invalid-time', detail: 'createdAt must be a non-negative finite number' })
  }
  if (!nonEmpty(checkpoint.planDigest)) issues.push({ code: 'missing-digest', detail: 'planDigest must be non-empty' })
  if (!nonEmpty(checkpoint.envelopeId)) issues.push({ code: 'missing-digest', detail: 'envelopeId must be non-empty' })

  const jsonIssue = assertJsonSafe(checkpoint.state)
  if (jsonIssue !== null) issues.push({ code: 'state-not-json', detail: jsonIssue })
  else if (checkpointBytes(checkpoint) > GRAPH_STATE_LIMITS.maxCheckpointBytes) {
    issues.push({
      code: 'state-too-large',
      detail: `checkpoint is ${checkpointBytes(checkpoint)} bytes; limit is ${GRAPH_STATE_LIMITS.maxCheckpointBytes}`,
    })
  }
  return issues
}

/**
 * Escape one key component so a `/` inside it cannot forge a different key:
 * `('a/b', 'c')` and `('a', 'b/c')` must not collide.
 */
function escapeKeyComponent(component: string): string {
  return encodeURIComponent(component)
}

/** Stable storage key; zero-padded seq keeps lexicographic order meaningful. */
export function checkpointKey(checkpoint: GraphCheckpoint): string {
  return [
    escapeKeyComponent(checkpoint.sessionId),
    escapeKeyComponent(checkpoint.turnId),
    String(checkpoint.seq).padStart(8, '0'),
    escapeKeyComponent(checkpoint.nodeId),
    checkpoint.boundary,
  ].join('/')
}

function compareCheckpoints(left: GraphCheckpoint, right: GraphCheckpoint): number {
  if (left.seq !== right.seq) return left.seq - right.seq
  const order = (boundary: CheckpointBoundary): number => (boundary === 'node-end' ? 1 : 0)
  if (order(left.boundary) !== order(right.boundary)) return order(left.boundary) - order(right.boundary)
  return left.nodeId < right.nodeId ? -1 : left.nodeId > right.nodeId ? 1 : 0
}

function assertValid(checkpoint: GraphCheckpoint): void {
  const issues = validateCheckpoint(checkpoint)
  if (issues.length === 0) return
  throw new Error(`invalid graph checkpoint: ${issues.map(issue => `${issue.code}: ${issue.detail}`).join('; ')}`)
}

// ---------------------------------------------------------------------------
// Key-value table adapter (storageDomain-shaped)
// ---------------------------------------------------------------------------

/**
 * The subset of `@deepseek-ai/dsh-storage-domain`'s `KvTable` this port needs.
 * Structural on purpose: the bundle row opens the real domain and passes its
 * table here, while tests use `MemoryCheckpointTable`.
 */
export interface CheckpointTable {
  get(key: string): GraphCheckpoint | undefined
  entries(): IterableIterator<[string, GraphCheckpoint]>
  put(key: string, value: GraphCheckpoint): Promise<void>
  deleteMany(keys: readonly string[]): Promise<number>
}

export class TableCheckpointStore implements CheckpointStore {
  constructor(private readonly table: CheckpointTable) {}

  async put(checkpoint: GraphCheckpoint): Promise<void> {
    assertValid(checkpoint)
    await this.table.put(checkpointKey(checkpoint), checkpoint)
  }

  async latest(sessionId: string, turnId: string): Promise<GraphCheckpoint | undefined> {
    const records = await this.list(sessionId, turnId)
    return records.at(-1)
  }

  async list(sessionId: string, turnId: string): Promise<readonly GraphCheckpoint[]> {
    const records: GraphCheckpoint[] = []
    for (const [, checkpoint] of this.table.entries()) {
      if (checkpoint.sessionId === sessionId && checkpoint.turnId === turnId) records.push(checkpoint)
    }
    return records.sort(compareCheckpoints)
  }

  async prune(sessionId: string, keepTurns: number): Promise<number> {
    const keep = Number.isInteger(keepTurns) && keepTurns > 0 ? keepTurns : 0
    const byTurn = new Map<string, { newest: number; keys: string[] }>()
    for (const [key, checkpoint] of this.table.entries()) {
      if (checkpoint.sessionId !== sessionId) continue
      const group = byTurn.get(checkpoint.turnId) ?? { newest: 0, keys: [] }
      group.newest = Math.max(group.newest, checkpoint.createdAt)
      group.keys.push(key)
      byTurn.set(checkpoint.turnId, group)
    }
    const ordered = [...byTurn.entries()].sort((left, right) => right[1].newest - left[1].newest)
    const doomed = ordered.slice(keep).flatMap(([, group]) => group.keys)
    if (doomed.length === 0) return 0
    return this.table.deleteMany(doomed)
  }
}

// ---------------------------------------------------------------------------
// In-memory table + store
// ---------------------------------------------------------------------------

/** Minimal table used by tests, the preview tooling and development profiles. */
export class MemoryCheckpointTable implements CheckpointTable {
  private readonly records = new Map<string, GraphCheckpoint>()

  get(key: string): GraphCheckpoint | undefined {
    return this.records.get(key)
  }

  entries(): IterableIterator<[string, GraphCheckpoint]> {
    return [...this.records.entries()][Symbol.iterator]()
  }

  async put(key: string, value: GraphCheckpoint): Promise<void> {
    this.records.set(key, value)
  }

  async deleteMany(keys: readonly string[]): Promise<number> {
    let removed = 0
    for (const key of keys) {
      if (this.records.delete(key)) removed += 1
    }
    return removed
  }

  get size(): number {
    return this.records.size
  }
}

/** Convenience store backed by an in-memory table; used by tests and previews. */
export class InMemoryCheckpointStore implements CheckpointStore {
  readonly table: MemoryCheckpointTable
  private readonly store: TableCheckpointStore

  constructor(table: MemoryCheckpointTable = new MemoryCheckpointTable()) {
    this.table = table
    this.store = new TableCheckpointStore(table)
  }

  put(checkpoint: GraphCheckpoint): Promise<void> {
    return this.store.put(checkpoint)
  }

  latest(sessionId: string, turnId: string): Promise<GraphCheckpoint | undefined> {
    return this.store.latest(sessionId, turnId)
  }

  list(sessionId: string, turnId: string): Promise<readonly GraphCheckpoint[]> {
    return this.store.list(sessionId, turnId)
  }

  prune(sessionId: string, keepTurns: number): Promise<number> {
    return this.store.prune(sessionId, keepTurns)
  }
}
