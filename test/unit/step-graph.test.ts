import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createStepGraph, fallbackPlan } from '../../packages/core/src/step-graph.ts'
import type { TaskPlan } from '../../packages/core/src/graph-schema.ts'

function plan(): TaskPlan {
  const base = fallbackPlan({ id: 't', instruction: 'go', maxSteps: 5 })
  return {
    ...base,
    entry: 'a',
    terminals: ['c'],
    nodes: [
      { id: 'a', kind: 'agent-step', executor: 'step', instruction: 'a' },
      { id: 'b', kind: 'agent-step', executor: 'step', instruction: 'b' },
      { id: 'c', kind: 'agent-step', executor: 'step', instruction: 'c' },
    ],
    edges: [
      { from: 'a', to: 'b', kind: 'control' },
      { from: 'b', to: 'c', kind: 'control' },
    ],
    budget: { maxNodes: 3, maxSteps: 5, maxTokens: 1000, maxWallMs: 1000, maxReplans: 0 },
  }
}

test('step graph walks control edges and completes', () => {
  const graph = createStepGraph(plan())
  assert.equal(graph.current()?.id, 'a')
  assert.equal(graph.advance({ ok: true })?.id, 'b')
  assert.equal(graph.advance({ ok: true })?.id, 'c')
  assert.equal(graph.advance({ ok: true }), undefined)
  assert.equal(graph.done(), true)
  assert.equal(graph.status(), 'done')
  assert.deepEqual(graph.visited(), ['a', 'b', 'c'])
})

test('failed node closes the run as failed', () => {
  const graph = createStepGraph(plan())
  graph.advance({ ok: true })
  graph.advance({ ok: false })
  assert.equal(graph.done(), true)
  assert.equal(graph.status(), 'failed')
  assert.deepEqual(graph.visited(), ['a', 'b'])
})

test('maxSteps caps a cyclic plan', () => {
  const cyclic = plan()
  const graph = createStepGraph({
    ...cyclic,
    budget: { ...cyclic.budget, maxSteps: 2 },
    edges: [{ from: 'a', to: 'b', kind: 'control' }, { from: 'b', to: 'a', kind: 'control' }],
    terminals: [],
  })
  graph.advance({ ok: true })
  graph.advance({ ok: true })
  assert.equal(graph.done(), true)
  assert.equal(graph.steps(), 2)
})
