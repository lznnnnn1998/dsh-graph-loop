/**
 * core-json-safety.test.ts — JSON-safety hardening for the kernel boundary.
 *
 * `assertJsonSafe()` once recursed into a cyclic object until the stack
 * overflowed; it must return an issue instead. It is live: the kernel's
 * `assertJson()` guards every update and checkpoint write with it.
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import { assertJsonSafe } from '../../packages/core/src/graph-schema.ts'

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
