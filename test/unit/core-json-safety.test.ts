/**
 * core-json-safety.test.ts — JSON-safety and checkpoint-key hardening.
 *
 * Two audit findings:
 *  - `assertJsonSafe()` recursed into a cyclic object until the stack overflowed;
 *    it must return an issue instead (it guards every checkpoint write).
 *  - `checkpointKey()` joined `(sessionId, turnId, namespace)` with `/` without
 *    escaping, so `('a/b', 'c')` and `('a', 'b/c')` collided in the KV table.
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import {
  InMemoryCheckpointStore,
  checkpointKey,
  validateCheckpoint,
  type GraphCheckpoint,
} from '../../packages/core/src/checkpoint.ts'
import { assertJsonSafe, type GraphState } from '../../packages/core/src/graph-schema.ts'

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

test('assertJsonSafe reports a cyclic object/array instead of overflowing the stack', () => {
  const cyclic: Record<string, unknown> = { name: 'circle' }
  cyclic['self'] = cyclic
  assert.equal(assertJsonSafe(cyclic), '$.self: cyclic reference')

  const cyclicArray: unknown[] = []
  cyclicArray.push(cyclicArray)
  assert.match(assertJsonSafe(cyclicArray) ?? '', /cyclic reference/u)

  // A shared (diamond) reference is legal JSON: only the current path matters.
  const shared = { n: 1 }
  assert.equal(assertJsonSafe({ a: shared, b: shared }), null)

  // A deep but acyclic value still validates.
  let deep: unknown = 1
  for (let index = 0; index < 1_000; index += 1) deep = { next: deep }
  assert.equal(assertJsonSafe(deep), null)

  // The pre-existing checks are unchanged.
  assert.equal(assertJsonSafe({ when: new Date() }), '$.when: non-plain object')
  assert.equal(assertJsonSafe({ n: Number.NaN }), '$.n: non-finite number')
  assert.equal(assertJsonSafe(undefined), '$: undefined is not JSON')
})

test('a cyclic checkpoint state is rejected as state-not-json, not as a crash', () => {
  const cyclicState = state() as GraphState & { self?: unknown }
  cyclicState.self = cyclicState
  const issues = validateCheckpoint(checkpoint({ state: cyclicState }))
  const issue = issues.find(candidate => candidate.code === 'state-not-json')
  assert.ok(issue !== undefined)
  assert.match(issue.detail, /cyclic reference/u)
})

test('checkpoint keys escape components so session/turn boundaries cannot be forged', async () => {
  // `('a/b', 'c')` and `('a', 'b/c')` used to join to the same key.
  const left = checkpointKey(checkpoint({ sessionId: 'a/b', turnId: 'c' }))
  const right = checkpointKey(checkpoint({ sessionId: 'a', turnId: 'b/c' }))
  assert.notEqual(left, right)
  assert.ok(left.includes('a%2Fb'))
  assert.ok(right.includes('b%2Fc'))

  // A literal `%2F` in an id cannot alias an escaped slash either.
  const literal = checkpointKey(checkpoint({ sessionId: 'a%2Fb', turnId: 'c' }))
  assert.notEqual(literal, left)

  // The unstressed format is unchanged (stable, zero-padded, lexicographic).
  assert.equal(checkpointKey(checkpoint({ seq: 42, nodeId: 'n9', boundary: 'node-start' })), 's1/t1/00000042/n9/node-start')

  // End to end: the two forged identities are two separate stored rows.
  const store = new InMemoryCheckpointStore()
  await store.put(checkpoint({ sessionId: 'a/b', turnId: 'c', nodeId: 'n1' }))
  await store.put(checkpoint({ sessionId: 'a', turnId: 'b/c', nodeId: 'n1' }))
  assert.equal(store.table.size, 2)
  assert.equal((await store.list('a/b', 'c')).length, 1)
  assert.equal((await store.list('a', 'b/c')).length, 1)
})
