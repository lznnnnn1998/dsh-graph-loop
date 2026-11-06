import assert from 'node:assert/strict'
import { test } from 'node:test'
import { buildRegistrySnapshot, type ToolSource } from '../../packages/core/src/registry.ts'
import { TEMPLATE_LIBRARY } from '../../packages/core/src/templates.ts'
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
  assert.equal(driver.done(), true)
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
  assert.equal(driver.done(), true)
})

test('dynamic mode synthesizes a topology from the capability graph', async () => {
  const driver = createGraphTurnDriver({
    mode: 'dynamic',
    graphProvider: () => registry.graph,
  })
  const started = await driver.beginTurn({ text: 'explain how the config loader works' })
  assert.equal(started.templateId, 'dynamic')
  assert.equal(started.fallback, false)
  let steps = 0
  while (!driver.done() && steps < 10) {
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

test('a failed work node triggers a boundary recovery plan', async () => {
  const driver = createGraphTurnDriver({
    mode: 'dynamic',
    graphProvider: () => registry.graph,
  })
  const started = await driver.beginTurn({ text: 'fix the failing test in the loader' })
  assert.equal(started.templateId, 'dynamic')
  assert.equal(driver.current()?.id, 'd_read')
  await driver.advance({ ok: true })
  // Fail the next work node; the scheduler must install a recovery topology.
  await driver.advance({ ok: false, failedTool: 'bash' })
  const snapshot = driver.snapshot()
  assert.equal(snapshot.replans, 1)
  assert.equal(driver.current()?.id, 'r_diagnose')
  assert.ok(snapshot.rationale.some(line => line.includes('replan 1')))
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
