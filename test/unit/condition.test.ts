import assert from 'node:assert/strict'
import { test } from 'node:test'
import { evaluateCondition, routeOrder, type RoutingState } from '../../packages/core/src/condition.ts'
import type { Condition } from '../../packages/core/src/graph-schema.ts'

function state(overrides: Partial<RoutingState> = {}): RoutingState {
  return {
    facts: {},
    artifacts: [],
    budget: { stepsRemaining: 10, tokensRemaining: 1_000, wallMsRemaining: 60_000 },
    ...overrides,
  }
}

test('always is unconditional', () => {
  assert.equal(evaluateCondition(undefined, state()), true)
  assert.equal(evaluateCondition({ op: 'always' }, state()), true)
})

test('artifact and noArtifact read the projected artifact refs', () => {
  const withPatch = state({ artifacts: [{ type: 'file.patch', ref: 'a.patch' }] })
  assert.equal(evaluateCondition({ op: 'artifact', type: 'file.patch' }, withPatch), true)
  assert.equal(evaluateCondition({ op: 'artifact', type: 'file.text' }, withPatch), false)
  assert.equal(evaluateCondition({ op: 'noArtifact', type: 'file.text' }, withPatch), true)
  assert.equal(evaluateCondition({ op: 'noArtifact', type: 'file.patch' }, withPatch), false)
})

test('fact compares JSON primitives exactly', () => {
  const facts = state({ facts: { lastOk: true, failedTool: 'bash', count: 3 } })
  assert.equal(evaluateCondition({ op: 'fact', key: 'lastOk', equals: true }, facts), true)
  assert.equal(evaluateCondition({ op: 'fact', key: 'lastOk', equals: false }, facts), false)
  assert.equal(evaluateCondition({ op: 'fact', key: 'count', equals: 3 }, facts), true)
  assert.equal(evaluateCondition({ op: 'fact', key: 'missing', equals: false }, facts), false)
})

test('callFailed requires a failed step and matches the named tool', () => {
  const failed = state({ facts: { lastOk: false, failedTool: 'bash' } })
  const failedUnknownTool = state({ facts: { lastOk: false } })
  const ok = state({ facts: { lastOk: true, failedTool: 'bash' } })
  assert.equal(evaluateCondition({ op: 'callFailed', tool: 'bash' }, failed), true)
  assert.equal(evaluateCondition({ op: 'callFailed', tool: 'write' }, failed), false)
  assert.equal(evaluateCondition({ op: 'callFailed', tool: 'write' }, failedUnknownTool), true)
  assert.equal(evaluateCondition({ op: 'callFailed', tool: 'bash' }, ok), false)
})

test('budget compares each remaining axis', () => {
  const low = state({ budget: { stepsRemaining: 2, tokensRemaining: 100, wallMsRemaining: 1_000 } })
  assert.equal(evaluateCondition({ op: 'budget', axis: 'steps', remainingAtMost: 2 }, low), true)
  assert.equal(evaluateCondition({ op: 'budget', axis: 'steps', remainingAtMost: 1 }, low), false)
  assert.equal(evaluateCondition({ op: 'budget', axis: 'tokens', remainingAtMost: 100 }, low), true)
  assert.equal(evaluateCondition({ op: 'budget', axis: 'wall', remainingAtMost: 1_000 }, low), true)
  assert.equal(evaluateCondition({ op: 'budget', axis: 'tokens', remainingAtMost: 1 }, state()), false)
})

test('routeOrder puts specific guards before the unconditional fallback', () => {
  const edges: { id: string; when?: Condition }[] = [
    { id: 'fallback', when: { op: 'always' } },
    { id: 'repair', when: { op: 'fact', key: 'lastOk', equals: false } },
    { id: 'unconditional' },
    { id: 'budget', when: { op: 'budget', axis: 'steps', remainingAtMost: 2 } },
  ]
  assert.deepEqual(routeOrder(edges).map(edge => edge.id), ['repair', 'budget', 'fallback', 'unconditional'])
})
