import assert from 'node:assert/strict'
import { test } from 'node:test'

import type { Condition, Json, TaskPlan } from '../../packages/core/src/graph-schema.ts'
import { FrontierTopology } from '../../packages/core/src/topology.ts'
import { createGraphTurnDriver } from '../../packages/loop/src/scheduler.ts'
import { deriveStepArtifacts, deriveStepFacts } from '../../packages/loop/src/step-facts.ts'

function plan(edges: TaskPlan['edges'], maxSteps = 6): TaskPlan {
  return {
    id: 'condition-routing',
    templateId: 'test',
    version: 1,
    entry: 'a',
    terminals: ['d'],
    nodes: [
      { id: 'a', kind: 'agent-step', executor: 'step', instruction: 'work' },
      { id: 'b', kind: 'agent-step', executor: 'step', instruction: 'guarded' },
      { id: 'c', kind: 'agent-step', executor: 'step', instruction: 'fallback' },
      { id: 'd', kind: 'agent-step', executor: 'step', instruction: 'done' },
    ],
    edges,
    budget: { maxNodes: 4, maxSteps, maxTokens: 10_000, maxWallMs: 60_000, maxReplans: 0 },
    toolUniverse: [],
    gatePolicy: 'cold',
    fallback: false,
    confidence: 1,
    compiledDigest: 'condition-routing',
  }
}

function fixture(guarded: Condition): TaskPlan {
  return plan([
    { from: 'a', to: 'b', kind: 'control', when: guarded },
    { from: 'a', to: 'c', kind: 'control' },
    { from: 'b', to: 'd', kind: 'control' },
    { from: 'c', to: 'd', kind: 'control' },
  ])
}

function firstAfter(base: TaskPlan, outcome: { ok: boolean; facts?: Record<string, Json>; artifacts?: { type: 'file.patch'; ref: string }[]; budget?: { stepsRemaining?: number } }): string | undefined {
  const topology = new FrontierTopology(base)
  const node = topology.current()
  assert.ok(node)
  topology.advance(outcome)
  return topology.current()?.id
}

test('artifact guard chooses the guarded exit and falls back when absent', () => {
  const base = fixture({ op: 'artifact', type: 'file.patch' })
  assert.equal(firstAfter(base, { ok: true }), 'c')
  assert.equal(firstAfter(base, { ok: true, artifacts: [{ type: 'file.patch', ref: 'x.patch' }] }), 'b')
})

test('fact guard routes both success and failure outcomes', () => {
  const base = fixture({ op: 'fact', key: 'lastOk', equals: false })
  assert.equal(firstAfter(base, { ok: true }), 'c')
  assert.equal(firstAfter(base, { ok: false }), 'b')
})

test('budget guard uses the remaining step budget', () => {
  const guarded = fixture({ op: 'budget', axis: 'steps', remainingAtMost: 2 })
  assert.equal(firstAfter(guarded, { ok: true }), 'c')
  const tight = fixture({ op: 'budget', axis: 'steps', remainingAtMost: 3 })
  const topology = new FrontierTopology(tight)
  const node = topology.current()
  assert.ok(node)
  // maxSteps 6, one advance -> 5 remaining, still above 3; use a 3-step plan.
  const tight3 = { ...tight, budget: { ...tight.budget, maxSteps: 3 } }
  const short = new FrontierTopology(tight3)
  const first = short.current()
  assert.ok(first)
  short.advance({ ok: true })
  assert.equal(short.current()?.id, 'b')
})

test('a node with two unconditional exits still fans out', () => {
  const parallel = plan([
    { from: 'a', to: 'b', kind: 'control' },
    { from: 'a', to: 'c', kind: 'control' },
  ])
  const topology = new FrontierTopology(parallel)
  const first = topology.current()
  assert.ok(first)
  topology.advance({ ok: true })
  assert.equal(topology.current()?.id, 'b')
  assert.deepEqual(topology.pendingNodes().map(node => node.id), ['c'])
})

test('step facts and artifacts are derived from observed tool calls', () => {
  const tools = [
    { name: 'write', isError: false, arguments: JSON.stringify({ file_path: '/app/src/x.ts' }) },
    { name: 'edit', isError: false, arguments: JSON.stringify({ file_path: '/app/change.patch' }) },
    { name: 'write', isError: false, arguments: JSON.stringify({ file_path: '/app/pic.png' }) },
    { name: 'bash', isError: true, arguments: JSON.stringify({ command: 'false' }) },
  ]
  const facts = deriveStepFacts(tools, true)
  assert.equal(facts['lastOk'], true)
  assert.equal(facts['hadToolCall'], true)
  assert.equal(facts['wroteFile'], true)
  assert.equal(facts['failedToolCount'], 1)
  assert.equal(facts['allToolsFailed'], false)
  assert.equal(facts['tool.write.ok'], true)
  assert.equal(facts['tool.bash.failed'], true)

  const artifacts = deriveStepArtifacts(tools)
  assert.deepEqual(artifacts.map(artifact => [artifact.type, artifact.ref]), [
    ['file.text', '/app/src/x.ts'],
    ['file.patch', '/app/change.patch'],
    ['file.image', '/app/pic.png'],
  ])
})

test('a registered third-party author produces its declared artifact', () => {
  const artifacts = deriveStepArtifacts(
    [{ name: 'acme_render', isError: false }],
    ['file.image'],
    'tool:acme_render',
  )
  assert.deepEqual(artifacts, [{ type: 'file.image', ref: 'tool:acme_render:file.image' }])
})

test('a non-zero shell exit is a failed verification even without isError', () => {
  const facts = deriveStepFacts(
    [{ name: 'bash', isError: false, output: 'FAIL tests/loader.test.ts\n[exit code: 1]' }],
    true,
  )
  assert.equal(facts['lastOk'], false)
  assert.equal(facts['verificationFailed'], true)
  assert.equal(facts['allToolsFailed'], false)
})

test('a verify/repair loop runs until maxSteps, not two visits', () => {
  const loop = plan([
    { from: 'a', to: 'b', kind: 'control', when: { op: 'fact', key: 'lastOk', equals: false } },
    { from: 'a', to: 'd', kind: 'control' },
    { from: 'b', to: 'a', kind: 'control' },
  ], 6)
  const topology = new FrontierTopology(loop)
  let advances = 0
  while (topology.current() !== undefined && advances < 20) {
    topology.advance({ ok: advances % 2 === 1 })
    advances += 1
  }
  assert.equal(advances, 6)
  assert.equal(topology.done(), true)
})

test('an exhausted plan continues while the model is still calling tools', async () => {
  const driver = createGraphTurnDriver({ mode: 'template', maxSteps: 4 })
  await driver.beginTurn({ text: 'keep working' })
  assert.equal(driver.current()?.id, 'node:respond')
  await driver.advance({ ok: true, tools: [{ name: 'bash', isError: false }] })
  assert.equal(driver.done(), false)
  assert.ok(driver.snapshot().rationale.some(line => line.includes('continuation')))
  await driver.advance({ ok: true })
  assert.equal(driver.done(), true)
})
