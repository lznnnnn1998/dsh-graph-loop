import assert from 'node:assert/strict'
import { test } from 'node:test'
import { buildRegistrySnapshot, type ToolSource } from '../../packages/core/src/registry.ts'
import { extractFingerprint } from '../../packages/core/src/matching.ts'
import { FrontierTopology, synthesizeTopology } from '../../packages/core/src/topology.ts'
import { validateProposal } from '../../packages/core/src/proposal.ts'
import type { TaskPlan } from '../../packages/core/src/graph-schema.ts'

const tools: ToolSource[] = [
  { name: 'read', description: 'read', parameters: { type: 'object', properties: { path: { type: 'string' } } } },
  { name: 'glob', description: 'glob', parameters: { type: 'object', properties: { pattern: { type: 'string' } } } },
  { name: 'grep', description: 'grep', parameters: { type: 'object', properties: { pattern: { type: 'string' } } } },
  { name: 'edit', description: 'edit', parameters: { type: 'object', properties: { path: { type: 'string' } } } },
  { name: 'bash', description: 'bash', parameters: { type: 'object', properties: { command: { type: 'string' } } } },
  { name: 'web_search', description: 'search', parameters: { type: 'object', properties: { query: { type: 'string' } } } },
  { name: 'web_fetch', description: 'fetch', parameters: { type: 'object', properties: { url: { type: 'string' } } } },
]
const snapshot = buildRegistrySnapshot({ tools })
const presetTools = tools.map(tool => tool.name)

function fingerprint(text: string) {
  return extractFingerprint({
    text,
    surface: 'api',
    contextTokens: 0,
    attachments: [],
    workspace: { hasGit: false, hasPackageJson: false, hasTests: false, hasPython: false, languages: [] },
    visibleTools: presetTools,
  })
}

test('dynamic synthesis builds an arbitrary DAG for an investigation', () => {
  const fp = fingerprint('explain how the config loader works')
  const { plan, rationale } = synthesizeTopology({ taskHash: fp.hash, fingerprint: fp, graph: snapshot.graph, presetTools })
  assert.equal(plan.templateId, 'dynamic')
  assert.ok(plan.nodes.some(node => node.id === 'd_answer'))
  assert.ok(plan.nodes.some(node => ['d_grep', 'd_glob'].includes(node.id)))
  assert.ok(rationale.length > 0)
  assert.ok(plan.edges.length >= plan.nodes.length - 1)
})

test('merge-into tasks are mutating and get a mutation node', () => {
  const fp = fingerprint('Read a.txt, b.txt, and c.txt. Merge all lines into merged.txt, sorted alphabetically, with duplicates removed.')
  assert.equal(fp.mutating, true)
  assert.ok(fp.artifactsOut.includes('file.patch'))
  const { plan } = synthesizeTopology({ taskHash: fp.hash, fingerprint: fp, graph: snapshot.graph, presetTools })
  assert.ok(plan.nodes.some(node => node.id === 'd_edit'))
})

test('mutating tasks synthesize inspect → edit → verify', () => {
  const fp = fingerprint('fix the failing test in the loader')
  const { plan } = synthesizeTopology({ taskHash: fp.hash, fingerprint: fp, graph: snapshot.graph, presetTools })
  const ids = plan.nodes.map(node => node.id)
  assert.ok(ids.includes('d_read'))
  assert.equal(plan.nodes.find(node => node.id === 'd_read')?.optional, true)
  assert.ok(ids.includes('d_edit'))
  assert.ok(ids.includes('d_verify'))
})

test('research tasks fan out to search + fetch and join at the answer', () => {
  const fp = fingerprint('research the latest state of the art and compare approaches')
  const { plan } = synthesizeTopology({ taskHash: fp.hash, fingerprint: fp, graph: snapshot.graph, presetTools })
  // The fan-out and the join are the unconditional edges; every stage also owns
  // a guarded failure exit to the answer, so filter by condition.
  const fromEntry = plan.edges.filter(edge => edge.from === 'd_entry' && (edge.when === undefined || edge.when.op === 'always'))
  assert.equal(fromEntry.length, 2)
  const intoAnswer = plan.edges.filter(edge => edge.to === 'd_answer' && (edge.when === undefined || edge.when.op === 'always'))
  assert.equal(intoAnswer.length, 2)
})

test('frontier walks the synthesized graph and stops', () => {
  const fp = fingerprint('explain how the config loader works')
  const { plan } = synthesizeTopology({ taskHash: fp.hash, fingerprint: fp, graph: snapshot.graph, presetTools })
  const topology = new FrontierTopology(plan)
  let steps = 0
  while (topology.current() !== undefined && steps < 10) {
    topology.advance({ ok: true })
    steps += 1
  }
  assert.equal(topology.done(), true)
  assert.ok(steps >= 2 && steps <= plan.nodes.length)
})

test('frontier supports runtime node/edge mutation and bounded cycles', () => {
  const fp = fingerprint('explain how the config loader works')
  const { plan } = synthesizeTopology({ taskHash: fp.hash, fingerprint: fp, graph: snapshot.graph, presetTools })
  const topology = new FrontierTopology({ ...plan, budget: { ...plan.budget, maxSteps: 3 } })
  topology.current()
  topology.addNode({ id: 'm_extra', kind: 'agent-step', executor: 'step', instruction: 'extra' }, ['d_answer'])
  topology.addEdge({ from: 'd_answer', to: 'm_extra', kind: 'control' })
  assert.ok(topology.snapshot().nodes.some(node => node.id === 'm_extra'))
  topology.removeNode('m_extra')
  assert.ok(!topology.snapshot().nodes.some(node => node.id === 'm_extra'))
})

test('proposal validation accepts a free-form topology and rejects invalid ones', () => {
  const good = validateProposal({
    entry: 'n1',
    nodes: [
      { id: 'n1', tool: 'read', instruction: 'read the file' },
      { id: 'n2', tool: 'bash', instruction: 'run the narrow test' },
      { id: 'n3', kind: 'terminal', instruction: 'answer' },
    ],
    edges: [{ from: 'n1', to: 'n2' }, { from: 'n2', to: 'n3' }],
  }, snapshot.graph, presetTools)
  assert.equal(good.ok, true)
  assert.equal(good.plan?.nodes.length, 3)
  assert.equal(good.plan?.entry, 'n1')

  const badTool = validateProposal({ entry: 'n1', nodes: [{ id: 'n1', tool: 'nope' }], edges: [] }, snapshot.graph, presetTools)
  assert.equal(badTool.ok, false)
  assert.ok(badTool.errors.some(error => error.includes('not in the registry')))

  const duplicate = validateProposal({ entry: 'n1', nodes: [{ id: 'n1' }, { id: 'n1' }], edges: [] }, snapshot.graph, presetTools)
  assert.equal(duplicate.ok, false)

  const missingEntry = validateProposal({ entry: 'zz', nodes: [{ id: 'n1' }], edges: [] }, snapshot.graph, presetTools)
  assert.equal(missingEntry.ok, false)
})

test('frontier bounds a callFailed self-loop by maxSteps (H3)', () => {
  const plan: TaskPlan = {
    id: 'retry-loop',
    templateId: 'test',
    version: 1,
    entry: 'a',
    terminals: ['a'],
    nodes: [{ id: 'a', kind: 'agent-step', executor: 'step', instruction: 'retry the call' }],
    edges: [{ from: 'a', to: 'a', kind: 'control', when: { op: 'callFailed', tool: 'bash' } }],
    budget: { maxNodes: 1, maxSteps: 3, maxTokens: 1_000, maxWallMs: 1_000, maxReplans: 0 },
    toolUniverse: [],
    gatePolicy: 'cold',
    fallback: false,
    confidence: 1,
    compiledDigest: 'retry-loop',
  }
  const topology = new FrontierTopology(plan)
  let advances = 0
  while (topology.current() !== undefined && advances < 10) {
    topology.advance({ ok: false, failedTool: 'bash' })
    advances += 1
  }
  assert.equal(topology.done(), true)
  assert.equal(topology.status(), 'failed')
  // maxSteps counts the failed attempts: 3 advances, then the recovery edge is
  // not queued again.
  assert.equal(advances, 3)
  assert.equal(topology.steps(), 3)
})

test('frontier cap reports done when one alternative terminal was reached', () => {
  // `terminals` are alternative endpoints, not a checklist: a branch reaches
  // only one of them. At the exact cap, that reached terminal is a successful
  // run even though its sibling branch never executed (audit 2026-11-09 §4.4).
  const plan: TaskPlan = {
    id: 'branch-at-cap',
    templateId: 'test',
    version: 1,
    entry: 'a',
    terminals: ['b', 'c'],
    nodes: [
      { id: 'a', kind: 'agent-step', executor: 'step', instruction: 'choose a branch' },
      { id: 'b', kind: 'terminal', executor: 'step', instruction: 'branch b' },
      { id: 'c', kind: 'terminal', executor: 'step', instruction: 'branch c' },
    ],
    edges: [
      { from: 'a', to: 'b', kind: 'control' },
      { from: 'a', to: 'c', kind: 'control' },
    ],
    budget: { maxNodes: 3, maxSteps: 2, maxTokens: 1_000, maxWallMs: 1_000, maxReplans: 0 },
    toolUniverse: [],
    gatePolicy: 'cold',
    fallback: false,
    confidence: 1,
    compiledDigest: 'branch-at-cap',
  }
  const topology = new FrontierTopology(plan)
  assert.equal(topology.current()?.id, 'a')
  topology.advance({ ok: true })             // a -> branch b (c stays pending)
  assert.equal(topology.current()?.id, 'b')
  topology.advance({ ok: true })             // b at the cap; c is still unreached
  assert.equal(topology.status(), 'done')
  assert.equal(topology.done(), true)
})

test('proposal validation rejects unsafe shapes and keeps a bounded retry loop', () => {
  const invalidWhen = validateProposal({
    entry: 'n1',
    nodes: [{ id: 'n1' }, { id: 'n2', kind: 'terminal' }],
    edges: [{ from: 'n1', to: 'n2', when: { op: 'nope' } as never }],
  }, snapshot.graph, presetTools)
  assert.equal(invalidWhen.ok, false)
  assert.ok(invalidWhen.errors.some(error => error.includes('when')))

  const selfLoop = validateProposal({
    entry: 'n1',
    nodes: [{ id: 'n1' }, { id: 'n2', kind: 'terminal' }],
    edges: [{ from: 'n1', to: 'n1' }, { from: 'n1', to: 'n2' }],
  }, snapshot.graph, presetTools)
  assert.equal(selfLoop.ok, false)
  assert.ok(selfLoop.errors.some(error => error.includes('self-loop')))

  // The guarded verify -> retry loop stays legal: the frontier only follows the
  // conditional edge on a matching outcome.
  const retry = validateProposal({
    entry: 'n1',
    nodes: [{ id: 'n1', tool: 'bash' }, { id: 'n2', kind: 'terminal' }],
    edges: [
      { from: 'n1', to: 'n2' },
      { from: 'n1', to: 'n1', when: { op: 'callFailed', tool: 'bash' } },
    ],
  }, snapshot.graph, presetTools)
  assert.equal(retry.ok, true, retry.errors.join('; '))
  assert.ok(retry.plan?.edges.some(edge => edge.when?.op === 'callFailed'))

  const terminalOut = validateProposal({
    entry: 'n1',
    nodes: [{ id: 'n1' }, { id: 'n2', kind: 'terminal' }],
    edges: [{ from: 'n1', to: 'n2' }, { from: 'n2', to: 'n1' }],
    terminals: ['n2'],
  }, snapshot.graph, presetTools)
  assert.equal(terminalOut.ok, false)
  assert.ok(terminalOut.errors.some(error => error.includes('terminal')))

  const unreachable = validateProposal({
    entry: 'n1',
    nodes: [{ id: 'n1' }, { id: 'orphan' }, { id: 'n2', kind: 'terminal' }],
    edges: [{ from: 'n1', to: 'n2' }],
  }, snapshot.graph, presetTools)
  assert.equal(unreachable.ok, false)
  assert.ok(unreachable.errors.some(error => error.includes('unreachable')))

  // validateTaskPlan() is merged in: a structural schema violation (P018, empty
  // model provider) is reported alongside the proposal-specific checks.
  const badModel = validateProposal({
    entry: 'n1',
    nodes: [{ id: 'n1', model: { provider: '', model: 'x' } }, { id: 'n2', kind: 'terminal' }],
    edges: [{ from: 'n1', to: 'n2' }],
  }, snapshot.graph, presetTools)
  assert.equal(badModel.ok, false)
  assert.ok(badModel.errors.some(error => error.includes('P018')))
})
