import assert from 'node:assert/strict'
import { test } from 'node:test'

import type { Condition, Json, TaskPlan } from '../../packages/core/src/graph-schema.ts'
import { FrontierTopology } from '../../packages/core/src/topology.ts'
import { createGraphTurnDriver } from '../../packages/loop/src/scheduler.ts'
import { deriveStepArtifactCandidates, deriveEvidenceCalls, deriveStepFacts } from '../../packages/loop/src/step-facts.ts'

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

  // Candidates only: the scheduler measures each path in the world before it
  // becomes evidence, so a path argument is not an artifact by itself.
  const candidates = deriveStepArtifactCandidates(tools)
  assert.deepEqual(candidates.map(candidate => [candidate.type, candidate.ref]), [
    ['file.text', '/app/src/x.ts'],
    ['file.patch', '/app/change.patch'],
    ['file.image', '/app/pic.png'],
  ])
})

test('a declared artifact type with no observable path is not evidence', () => {
  // A third-party author returning its artifact (rather than a path) leaves
  // nothing the runtime can measure, so it yields no candidate and cannot
  // certify a step (audit 20261111-1600 F2).
  const author = {
    id: 'tool:acme_render',
    kind: 'tool',
    label: 'acme_render',
    description: 'render an image',
    source: { registry: 'tools', dynamic: false },
    tool: { name: 'acme_render', packageName: 'acme', executor: 'native', permission: 'mutating', idempotent: false, parameterNames: ['prompt'], accepts: [], produces: [{ type: 'file.image', required: true }], conditional: false, dynamic: false, schemaTokens: 40 },
    accepts: [],
    produces: [{ type: 'file.image', required: true }],
    cost: { risk: 0.5 },
    tags: ['mutation'],
    annotationVersion: 'test',
  } as const
  const candidates = deriveStepArtifactCandidates([{ name: 'acme_render', isError: false }], author as never)
  assert.deepEqual(candidates, [])
})

test('evidence calls carry declared locator values, never free text', () => {
  const calls = deriveEvidenceCalls(
    [{ name: 'read', isError: false, arguments: JSON.stringify({ file_path: '/app/out.ts', offset: 0 }) }],
    undefined,
    ['file_path', 'offset'],
  )
  assert.deepEqual(calls[0]?.locators, ['/app/out.ts'])
  // Free text (arguments that are not a declared locator) is not projected.
  const bashCalls = deriveEvidenceCalls(
    [{ name: 'bash', isError: false, arguments: JSON.stringify({ command: 'echo /app/out.ts' }), output: '/app/out.ts\n[exit code: 0]' }],
    undefined,
    ['file_path', 'path'],
  )
  assert.equal(bashCalls[0]?.locators, undefined)
  assert.equal('text' in (bashCalls[0] ?? {}), false)
})

test('a non-zero shell exit is a verification failure, not a step failure', () => {
  const facts = deriveStepFacts(
    [{ name: 'bash', isError: false, output: 'FAIL tests/loader.test.ts\n[exit code: 1]' }],
    true,
  )
  // `lastOk` stays about tool invocation: an inspect/mutate stage running
  // `grep`/`diff` (exit 1) must not be sent to repair. The verify stage guards
  // on `verificationFailed`, which is step-scoped.
  assert.equal(facts['lastOk'], true)
  assert.equal(facts['verificationFailed'], true)
  assert.equal(facts['allToolsFailed'], false)
})

test('step facts are rewritten every step so stale values cannot route a later step (P2-1)', () => {
  const failed = deriveStepFacts([{ name: 'bash', isError: true }], false, 'bash')
  assert.equal(failed['failedTool'], 'bash')
  assert.equal(failed['verificationRan'], true)
  assert.equal(failed['verificationFailed'], false)

  // The next step fails without naming a tool: the previous step's name must be
  // cleared, or a later `callFailed(<other tool>)` guard could never fire.
  const nameless = deriveStepFacts([{ name: 'read', isError: true }], false)
  assert.equal(nameless['failedTool'], false)

  // A step that ran no tool has not verified anything, even though nothing
  // "failed" (`verificationFailed` is false).
  const noTool = deriveStepFacts([], true)
  assert.equal(noTool['verificationRan'], false)
  assert.equal(noTool['verificationFailed'], false)
  assert.equal(noTool['hadToolCall'], false)
})

test('a bare repair loop burns the budget and settles failed, never done-without-terminal', () => {
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
  assert.equal(topology.planState(), 'failed')
  // A cap without a reached terminal is not success (audit 2026-11-09 §4.3).
  assert.equal(topology.status(), 'failed')
})

test('step facts classify shell effects, arrows, read_image and toolSucceeded', () => {
  const shellRead = deriveStepFacts(
    [{ name: 'bash', isError: false, arguments: JSON.stringify({ command: 'cat README.md' }) }],
    true,
  )
  assert.equal(shellRead['readFile'], true, 'a shell cat is a read')
  assert.equal(shellRead['wroteFile'], false)
  assert.equal(shellRead['toolSucceeded'], true)

  const shellWrite = deriveStepFacts(
    [{ name: 'bash', isError: false, arguments: JSON.stringify({ command: 'printf x > out.txt' }) }],
    true,
  )
  assert.equal(shellWrite['wroteFile'], true, 'a shell redirect writes a file')
  assert.equal(shellWrite['readFile'], false)
  assert.equal(shellWrite['toolSucceeded'], true)

  const arrow = deriveStepFacts(
    [{ name: 'bash', isError: false, arguments: JSON.stringify({ command: 'python3 -c "print(\'a->b\')"' }) }],
    true,
  )
  assert.equal(arrow['wroteFile'], false, '-> is not a shell redirect')
  assert.equal(arrow['toolSucceeded'], true)

  const image = deriveStepFacts([{ name: 'read_image', isError: false }], true)
  assert.equal(image['readFile'], true, 'read_image is an inspect tool')
  assert.equal(image['wroteFile'], false, 'read_image must never satisfy a mutation stage')

  const failedOnly = deriveStepFacts([{ name: 'bash', isError: true }], false)
  assert.equal(failedOnly['toolSucceeded'], false, 'an all-error step succeeded at nothing')
  const mixed = deriveStepFacts(
    [{ name: 'bash', isError: true }, { name: 'present', isError: false }],
    true,
  )
  assert.equal(mixed['toolSucceeded'], true, 'any non-error tool is a success')
})
