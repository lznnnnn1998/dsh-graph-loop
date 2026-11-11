import assert from 'node:assert/strict'
import { test } from 'node:test'
import { buildRegistrySnapshot, type ToolSource } from '../../packages/core/src/registry.ts'
import { TEMPLATE_LIBRARY } from '../../packages/core/src/templates.ts'
import type { TaskPlan } from '../../packages/core/src/graph-schema.ts'
import { createGraphTurnDriver } from '../../packages/loop/src/scheduler.ts'

const tools: ToolSource[] = [
  { name: 'read', description: 'Read a text file.', parameters: { type: 'object', properties: { path: { type: 'string' } } } },
  { name: 'glob', description: 'Find files by pattern.', parameters: { type: 'object', properties: { pattern: { type: 'string' } } } },
  { name: 'grep', description: 'Search file contents.', parameters: { type: 'object', properties: { pattern: { type: 'string' } } } },
  { name: 'edit', description: 'Edit a file.', parameters: { type: 'object', properties: { path: { type: 'string' } } } },
  { name: 'bash', description: 'Run a shell command.', parameters: { type: 'object', properties: { command: { type: 'string' } } } },
  { name: 'web_search', description: 'Search the web.', parameters: { type: 'object', properties: { query: { type: 'string' } } } },
  { name: 'web_fetch', description: 'Fetch a page.', parameters: { type: 'object', properties: { url: { type: 'string' } } } },
]

const registry = buildRegistrySnapshot({ tools })

test('registry is deterministic and marks the tool set', () => {
  const again = buildRegistrySnapshot({ tools })
  assert.equal(again.digest, registry.digest)
  assert.equal(registry.graph.nodes.length, tools.length)
  assert.ok(registry.graph.nodes.some(node => node.id === 'tool:read' && node.produces.some(spec => spec.type === 'file.text')))
})

test('a code question routes to t_investigate and walks its nodes', async () => {
  const driver = createGraphTurnDriver({
    graphProvider: () => registry.graph,
    templatesProvider: () => TEMPLATE_LIBRARY,
  })
  const started = await driver.beginTurn({ text: 'explain how the config loader works' })
  assert.equal(started.templateId, 't_investigate')
  assert.equal(driver.current()?.id, 'n_discover')
  await driver.advance({ ok: true })
  assert.equal(driver.current()?.id, 'n_inspect')
  await driver.advance({ ok: true })
  assert.equal(driver.current()?.id, 'n_done')
  await driver.advance({ ok: true })
  assert.equal(driver.planState(), 'terminal')
  assert.deepEqual(driver.snapshot().visited, ['n_discover', 'n_inspect', 'n_done'])
})

test('preset tool policy exposes the full tool set for benchmark harnesses', async () => {
  const driver = createGraphTurnDriver({
    graphProvider: () => registry.graph,
    toolPolicy: 'preset',
  })
  await driver.beginTurn({ text: 'explain how the config loader works' })
  assert.equal(driver.toolUniverse?.(), undefined)
})

test('plan tool policy narrows to the plan universe', async () => {
  const driver = createGraphTurnDriver({ graphProvider: () => registry.graph })
  await driver.beginTurn({ text: 'explain how the config loader works' })
  assert.ok(Array.isArray(driver.toolUniverse?.()))
})

test('without a registry the driver falls back to a single stock node', async () => {
  const driver = createGraphTurnDriver({ fallbackInstruction: 'answer' })
  const started = await driver.beginTurn({ text: 'hello' })
  assert.equal(started.fallback, true)
  assert.equal(driver.current()?.id, 'node:respond')
  await driver.advance({ ok: true })
  assert.equal(driver.planState(), 'terminal')
})

test('dynamic mode synthesizes a topology from the capability graph', async () => {
  const driver = createGraphTurnDriver({
    mode: 'dynamic',
    graphProvider: () => registry.graph,
  })
  const started = await driver.beginTurn({ text: 'explain how the config loader works' })
  assert.equal(started.templateId, 't_compose')
  assert.equal(started.fallback, false)
  assert.ok(started.rationale.some(line => line.includes('envelope')))
  let steps = 0
  while (!driver.planFinished() && steps < 10) {
    driver.current()
    await driver.advance({ ok: true })
    steps += 1
  }
  assert.ok(steps >= 2)
  assert.ok(driver.snapshot().rationale.some(line => line.includes('discovery') || line.includes('terminal')))
})

test('propose mode starts from a frame and adopts a model-authored topology at the first boundary', async () => {
  let proposal: import('../../packages/core/src/graph-schema.ts').TaskPlan | undefined
  const driver = createGraphTurnDriver({
    mode: 'propose',
    proposalSource: () => {
      const current = proposal
      proposal = undefined
      return current
    },
  })
  const started = await driver.beginTurn({ text: 'explain how the config loader works' })
  assert.equal(started.templateId, 'propose')
  assert.equal(driver.current()?.id, 'p_frame')
  proposal = {
    ...started.plan,
    id: 'proposed:test',
    templateId: 'proposed',
    entry: 'p1',
    terminals: ['p2'],
    nodes: [
      { id: 'p1', kind: 'agent-step', executor: 'step', instruction: 'work' },
      { id: 'p2', kind: 'terminal', executor: 'step', instruction: 'answer' },
    ],
    edges: [{ from: 'p1', to: 'p2', kind: 'control' }],
    compiledDigest: 'proposed:test',
  }
  await driver.advance({ ok: true })
  assert.equal(driver.current()?.id, 'p1')
  assert.ok(driver.snapshot().rationale.some(line => line.includes('adopted')))
})

/** Two stages with only unconditional success edges: the plan owns no failure exit. */
function plainPlan(maxReplans: number): TaskPlan {
  return {
    id: 'plan:plain',
    templateId: 'test',
    version: 1,
    entry: 'w1',
    terminals: ['w2'],
    nodes: [
      { id: 'w1', kind: 'agent-step', executor: 'step', instruction: 'work' },
      { id: 'w2', kind: 'terminal', executor: 'step', instruction: 'answer', toolAllow: [] },
    ],
    edges: [{ from: 'w1', to: 'w2', kind: 'control' }],
    budget: { maxNodes: 2, maxSteps: 4, maxTokens: 1_000, maxWallMs: 60_000, maxReplans },
    toolUniverse: [],
    gatePolicy: 'turn',
    fallback: false,
    confidence: 0.5,
    compiledDigest: 'test:plain',
  }
}

test('a failed work node triggers a boundary recovery plan', async () => {
  // Every generated plan now owns a failure exit, so the scheduler's replan is
  // the safety net for a plan that does not (e.g. a hand-written plan).
  const driver = createGraphTurnDriver({ kernel: 'off' })
  driver.adopt(plainPlan(2))
  await driver.advance({ ok: false, failedTool: 'bash' })
  const snapshot = driver.snapshot()
  assert.equal(snapshot.replans, 1)
  assert.equal(driver.current()?.id, 'r_diagnose')
  assert.ok(snapshot.rationale.some(line => line.includes('replan 1')))
})

test('a failed verify node follows the composed repair exit without a replan', async () => {
  const driver = createGraphTurnDriver({ mode: 'dynamic', graphProvider: () => registry.graph })
  await driver.beginTurn({ text: 'fix the failing test in the loader' })
  // Each stage's own success fact is load-bearing: inspect must actually read
  // and mutate must actually write, or the stage repairs instead of advancing.
  const stageOutcomes = [
    { id: 'n_inspect', tools: [{ name: 'read', isError: false }] },
    { id: 'n_mutate', tools: [{ name: 'edit', isError: false }] },
  ]
  for (const stage of stageOutcomes) {
    assert.equal(driver.current()?.id, stage.id)
    await driver.advance({ ok: true, tools: stage.tools })
  }
  assert.equal(driver.current()?.id, 'n_verify')
  await driver.advance({ ok: false, failedTool: 'bash' })
  assert.equal(driver.snapshot().replans, 0)
  assert.equal(driver.current()?.id, 'n_verify_repair')
  assert.equal(driver.snapshot().templateId, 't_compose')
})

test('triage keeps a trivial task at one step', async () => {
  const driver = createGraphTurnDriver({ mode: 'dynamic', graphProvider: () => registry.graph })
  const started = await driver.beginTurn({ text: 'hi' })
  assert.equal(started.plan.nodes.length, 1)
  assert.equal(driver.current()?.id, 'node:respond')
  assert.ok(started.rationale.some(line => line.includes('trivial')))
})

test('subagent children force the single-node fallback', async () => {
  const driver = createGraphTurnDriver({
    mode: 'dynamic',
    graphProvider: () => registry.graph,
    forceFallback: true,
    depth: 1,
  })
  const started = await driver.beginTurn({ text: 'investigate the first half of the research question' })
  assert.equal(started.plan.nodes.length, 1)
  assert.equal(started.depth, 1)
  assert.ok(started.rationale.some(line => line.includes('child agent')))
})

test('driver status reports a failed run as failed and a completed run as done', async () => {
  const failed = createGraphTurnDriver({ fallbackInstruction: 'answer' })
  await failed.beginTurn({ text: 'hello' })
  await failed.advance({ ok: false })
  assert.equal(failed.planState(), 'failed')
  assert.equal(failed.status?.(), 'failed')

  const completed = createGraphTurnDriver({ fallbackInstruction: 'answer' })
  await completed.beginTurn({ text: 'hello' })
  await completed.advance({ ok: true })
  assert.equal(completed.planState(), 'terminal')
  assert.equal(completed.status?.(), 'done')
})

test('forceFallback wins over propose mode: children stay single-node', async () => {
  const driver = createGraphTurnDriver({ mode: 'propose', forceFallback: true })
  const started = await driver.beginTurn({ text: 'investigate the first half of the research question' })
  assert.equal(started.templateId, 't_stock')
  assert.equal(started.plan.nodes.length, 1)
  assert.equal(driver.current()?.id, 'node:respond')
  assert.ok(started.rationale.some(line => line.includes('child agent')))
})

/** Parallel-subagent plan: p branches into s1 and s2. */
function subagentPlan(maxReplans: number): TaskPlan {
  return {
    id: 'plan:batch',
    templateId: 'test',
    version: 1,
    entry: 'p',
    terminals: ['s1', 's2'],
    nodes: [
      { id: 'p', kind: 'agent-step', executor: 'step', instruction: 'plan the batch' },
      { id: 's1', kind: 'agent-step', executor: 'subagent', instruction: 'first half' },
      { id: 's2', kind: 'agent-step', executor: 'subagent', instruction: 'second half' },
    ],
    edges: [
      { from: 'p', to: 's1', kind: 'control' },
      { from: 'p', to: 's2', kind: 'control' },
    ],
    budget: { maxNodes: 3, maxSteps: 5, maxTokens: 1000, maxWallMs: 1000, maxReplans },
    toolUniverse: [],
    gatePolicy: 'turn',
    fallback: false,
    confidence: 0.5,
    compiledDigest: 'test:batch',
  }
}

test('a failed subagent node triggers the same boundary recovery as a failed step', async () => {
  const driver = createGraphTurnDriver({ kernel: 'off' })
  driver.adopt(subagentPlan(1))
  await driver.advance({ ok: true })
  const batch = driver.takeSubagentBatch()
  assert.deepEqual(batch.map(node => node.id), ['s1', 's2'])
  await driver.completeNode('s1', false)
  const snapshot = driver.snapshot()
  assert.equal(snapshot.replans, 1)
  assert.equal(driver.status?.(), 'running')
  assert.equal(driver.current()?.id, 'r_diagnose')
  assert.ok(snapshot.rationale.some(line => line.includes('replan 1: recovery')))
  assert.deepEqual(snapshot.trail.map(entry => [entry.id, entry.status]), [['p', 'ok'], ['s1', 'failed']])
})

test('a failed subagent with no replan budget leaves the run failed', async () => {
  const driver = createGraphTurnDriver({ kernel: 'off' })
  driver.adopt(subagentPlan(0))
  await driver.advance({ ok: true })
  driver.takeSubagentBatch()
  await driver.completeNode('s1', false)
  assert.equal(driver.snapshot().replans, 0)
  assert.equal(driver.status?.(), 'failed')
  assert.equal(driver.planState(), 'failed')
})

test('each turn gets its own replan allowance', async () => {
  const driver = createGraphTurnDriver({ kernel: 'off' })
  for (let turn = 1; turn <= 3; turn += 1) {
    await driver.beginTurn({ text: 'fix the failing test in the loader' })
    // A plan without its own failure exit relies on the scheduler replan.
    driver.adopt(plainPlan(2))
    await driver.advance({ ok: false, failedTool: 'bash' })
    assert.equal(driver.snapshot().replans, 1, `turn ${turn} must start with a fresh replan budget`)
    assert.equal(driver.current()?.id, 'r_diagnose', `turn ${turn} must install the recovery plan`)
    driver.endTurn()
  }
})

test('a batch node superseded by a recovery replan does not advance the recovery plan', async () => {
  const driver = createGraphTurnDriver({ kernel: 'off' })
  driver.adopt(subagentPlan(1))
  await driver.advance({ ok: true })
  driver.takeSubagentBatch()
  await driver.completeNode('s1', false)
  assert.equal(driver.current()?.id, 'r_diagnose')
  const stepsAfterReplan = driver.snapshot().step
  // The sibling completion still arrives after the replan replaced the
  // topology; it must settle without running the recovery diagnosis step.
  await driver.completeNode('s2', true)
  assert.equal(driver.current()?.id, 'r_diagnose')
  assert.equal(driver.snapshot().step, stepsAfterReplan)
  assert.equal(driver.snapshot().replans, 1)
  assert.deepEqual(driver.snapshot().trail.map(entry => entry.id), ['p', 's1'])
})

test('a budget-guarded wrap-up node is not discarded by the kernel step cap', async () => {
  const plan: TaskPlan = {
    id: 'budget-wrap',
    templateId: 'test',
    version: 1,
    entry: 'a',
    terminals: ['b'],
    nodes: [
      { id: 'a', kind: 'agent-step', executor: 'step', instruction: 'work' },
      { id: 'b', kind: 'terminal', executor: 'step', instruction: 'answer', toolAllow: [] },
    ],
    edges: [{ from: 'a', to: 'b', kind: 'control', when: { op: 'budget', axis: 'steps', remainingAtMost: 1 } }],
    budget: { maxNodes: 2, maxSteps: 2, maxTokens: 1_000, maxWallMs: 60_000, maxReplans: 0 },
    toolUniverse: [],
    gatePolicy: 'cold',
    fallback: false,
    confidence: 1,
    compiledDigest: 'budget-wrap',
  }
  const driver = createGraphTurnDriver({ kernel: 'minimal' })
  driver.adopt(plan)
  assert.equal(driver.current()?.id, 'a')
  await driver.advance({ ok: true })
  assert.equal(driver.current()?.id, 'b')
  await driver.advance({ ok: true })
  assert.equal(driver.planState(), 'terminal')
  assert.deepEqual(driver.snapshot().trail.map(row => row.id), ['a', 'b'])
})
