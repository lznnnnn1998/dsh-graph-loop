/**
 * Unit tests for the graph checkpoint contract (0.2 composition layer).
 *
 * Run: node --import tsx --test test/unit/core-checkpoint.test.ts
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  InMemoryCheckpointStore,
  MemoryCheckpointTable,
  TableCheckpointStore,
  checkpointBytes,
  checkpointKey,
  validateCheckpoint,
  type GraphCheckpoint,
} from '../../packages/core/src/checkpoint.ts'
import type { GraphState } from '../../packages/core/src/graph-schema.ts'

function state(overrides: Partial<GraphState> = {}): GraphState {
  return {
    taskHash: '0123456789abcdef',
    planId: 'p1',
    planVersion: 1,
    superstep: 0,
    next: null,
    status: 'pending',
    facts: {},
    artifacts: [],
    children: [],
    journal: [],
    budget: { nodes: 0, steps: 0, tokens: 0, wallMs: 0 },
    replans: 0,
    ...overrides,
  }
}

function checkpoint(overrides: Partial<GraphCheckpoint> = {}): GraphCheckpoint {
  return {
    sessionId: 's1',
    turnId: 't1',
    nodeId: 'n1',
    seq: 0,
    boundary: 'node-end',
    state: state(),
    planDigest: 'digest-1',
    envelopeId: 'env_0123456789abcdef',
    createdAt: 1_000,
    ...overrides,
  }
}

test('put/latest/list order checkpoints deterministically', async () => {
  const store = new InMemoryCheckpointStore()
  await store.put(checkpoint({ nodeId: 'n2', seq: 1, boundary: 'node-end', createdAt: 1_200 }))
  await store.put(checkpoint({ nodeId: 'n1', seq: 0, boundary: 'node-start', createdAt: 1_000 }))
  await store.put(checkpoint({ nodeId: 'n1', seq: 0, boundary: 'node-end', createdAt: 1_100 }))

  const listed = await store.list('s1', 't1')
  assert.deepEqual(
    listed.map(entry => `${entry.seq}:${entry.boundary}:${entry.nodeId}`),
    ['0:node-start:n1', '0:node-end:n1', '1:node-end:n2'],
  )
  assert.equal((await store.latest('s1', 't1'))?.nodeId, 'n2')
  assert.equal((await store.latest('s1', 'other'))?.nodeId, undefined)
})

test('same key upserts instead of duplicating', async () => {
  const store = new InMemoryCheckpointStore()
  const first = checkpoint()
  const second = checkpoint({ planDigest: 'digest-2', createdAt: 2_000 })
  await store.put(first)
  await store.put(second)

  assert.equal(store.table.size, 1)
  assert.equal((await store.latest('s1', 't1'))?.planDigest, 'digest-2')
})

test('a tie on seq prefers node-end over node-start', async () => {
  const store = new InMemoryCheckpointStore()
  await store.put(checkpoint({ boundary: 'node-end', nodeId: 'a' }))
  await store.put(checkpoint({ boundary: 'node-start', nodeId: 'b' }))
  assert.equal((await store.latest('s1', 't1'))?.boundary, 'node-end')
})

test('non-JSON state is rejected before it reaches the table', async () => {
  const store = new InMemoryCheckpointStore()
  const bad = checkpoint({ state: state({ facts: { when: new Date() as never } }) })
  const issues = validateCheckpoint(bad)
  assert.ok(issues.some(issue => issue.code === 'state-not-json'))
  await assert.rejects(store.put(bad), /state-not-json/)
  assert.equal(store.table.size, 0)
})

test('oversized checkpoints are rejected at the byte limit', async () => {
  const store = new InMemoryCheckpointStore()
  const bad = checkpoint({ state: state({ facts: { blob: 'x'.repeat(70_000) } }) })
  assert.ok(checkpointBytes(bad) > 64 * 1024)
  const issues = validateCheckpoint(bad)
  assert.ok(issues.some(issue => issue.code === 'state-too-large'))
  await assert.rejects(store.put(bad), /state-too-large/)
})

test('invalid identity, seq, boundary and time are reported', () => {
  const bad = checkpoint({
    sessionId: '',
    turnId: '',
    nodeId: '',
    seq: -1,
    boundary: 'middle' as never,
    createdAt: -5,
    planDigest: '',
    envelopeId: '',
  })
  const codes = new Set(validateCheckpoint(bad).map(issue => issue.code))
  for (const code of ['invalid-id', 'invalid-seq', 'invalid-boundary', 'invalid-time', 'missing-digest']) {
    assert.ok(codes.has(code as never), `expected ${code}`)
  }
})

test('prune keeps the newest turns and removes the rest', async () => {
  const store = new InMemoryCheckpointStore()
  for (const [turnId, time] of [['t1', 100], ['t2', 200], ['t3', 300]] as const) {
    await store.put(checkpoint({ turnId, nodeId: `${turnId}-a`, createdAt: time }))
    await store.put(checkpoint({ turnId, nodeId: `${turnId}-b`, createdAt: time + 10 }))
  }
  const removed = await store.prune('s1', 2)
  assert.equal(removed, 2)
  assert.equal((await store.list('s1', 't1')).length, 0)
  assert.equal((await store.list('s1', 't2')).length, 2)
  assert.equal((await store.list('s1', 't3')).length, 2)
})

test('prune(0) removes every checkpoint for the session only', async () => {
  const store = new InMemoryCheckpointStore()
  await store.put(checkpoint({ sessionId: 's1', turnId: 't1' }))
  await store.put(checkpoint({ sessionId: 's2', turnId: 't1' }))
  assert.equal(await store.prune('s1', 0), 1)
  assert.equal((await store.list('s1', 't1')).length, 0)
  assert.equal((await store.list('s2', 't1')).length, 1)
})

test('TableCheckpointStore works against a plain storageDomain-shaped table', async () => {
  const table = new MemoryCheckpointTable()
  const store = new TableCheckpointStore(table)
  await store.put(checkpoint())
  assert.equal((await store.list('s1', 't1')).length, 1)
  assert.equal(table.size, 1)
})

test('checkpoint keys are stable and zero-padded', () => {
  const key = checkpointKey(checkpoint({ seq: 42, nodeId: 'n9', boundary: 'node-start' }))
  assert.equal(key, 's1/t1/00000042/n9/node-start')
})
