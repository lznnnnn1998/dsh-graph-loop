/**
 * Unit tests for the kernel-backed topology adapter.
 *
 * The adapter pauses the kernel before a node, lets the host run the DSH step,
 * then resumes the kernel with the step outcome. These tests drive that cycle
 * without a session.
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'

import type { Condition, TaskPlan } from '../../packages/core/src/graph-schema.ts'
import { KernelError, available } from '../../packages/loop/src/kernel/index.ts'
import { LANGGRAPH_RESERVED_NODE_IDS, LANGGRAPH_STATE_CHANNELS } from '../../packages/loop/src/kernel/langgraph.ts'
import { KernelTopology, canKernelDrive } from '../../packages/loop/src/kernel/topology.ts'

const lgAvailable = await available()

function plan(): TaskPlan {
  return {
    id: 'kernel-topology-test',
    templateId: 'test',
    version: 1,
    entry: 'a',
    terminals: ['b'],
    nodes: [
      { id: 'a', kind: 'agent-step', executor: 'step', instruction: 'do a' },
      { id: 'b', kind: 'terminal', executor: 'step', instruction: 'answer', toolAllow: [] },
    ],
    edges: [{ from: 'a', to: 'b', kind: 'control' }],
    budget: { maxNodes: 2, maxSteps: 4, maxTokens: 10_000, maxWallMs: 60_000, maxReplans: 0 },
    toolUniverse: [],
    gatePolicy: 'cold',
    fallback: false,
    confidence: 1,
    compiledDigest: 'kernel-topology-test',
  }
}

/** The linear test plan with its first node rewritten to `id`. */
function planWithNodeId(id: string): TaskPlan {
  const base = plan()
  return {
    ...base,
    entry: id,
    nodes: [{ ...base.nodes[0]!, id }, base.nodes[1]!],
    edges: [{ from: id, to: 'b', kind: 'control' }],
  }
}

/**
 * A real branch: node `a` has a success edge to `c` and a `callFailed` recovery
 * edge to `b`; either branch continues to the terminal `d`. The kernel compiles
 * two destinations out of `a` and takes exactly one.
 */
function branchPlan(): TaskPlan {
  const base = plan()
  return {
    ...base,
    id: 'kernel-branch-test',
    entry: 'a',
    terminals: ['d'],
    nodes: [
      { id: 'a', kind: 'agent-step', executor: 'step', instruction: 'work' },
      { id: 'b', kind: 'agent-step', executor: 'step', instruction: 'recover' },
      { id: 'c', kind: 'agent-step', executor: 'step', instruction: 'continue' },
      { id: 'd', kind: 'terminal', executor: 'step', instruction: 'answer', toolAllow: [] },
    ],
    edges: [
      { from: 'a', to: 'b', kind: 'control', when: { op: 'callFailed', tool: 'bash' } },
      { from: 'a', to: 'c', kind: 'control' },
      { from: 'b', to: 'd', kind: 'control' },
      { from: 'c', to: 'd', kind: 'control' },
    ],
    budget: { ...base.budget, maxNodes: 4 },
  }
}

test('kernel topology pauses before each node and advances on the step outcome', async () => {
  const topology = new KernelTopology(plan(), { kind: 'minimal', taskHash: 't' })
  try {
    assert.equal(topology.current()?.id, 'a')
    assert.equal(topology.steps(), 0)

    const next = await topology.advance({ ok: true })
    assert.equal(next?.id, 'b')
    assert.equal(topology.steps(), 1)
    assert.equal(topology.status(), 'running')
    assert.equal(topology.stateSnapshot().facts.lastOk, true)

    assert.equal(await topology.advance({ ok: true }), undefined)
    assert.equal(topology.status(), 'done')
    assert.equal(topology.done(), true)
    assert.equal(topology.steps(), 2)
  } finally {
    await topology.dispose()
  }
})

test('kernel topology records a failed step outcome', async () => {
  const topology = new KernelTopology(plan(), { kind: 'minimal', taskHash: 't' })
  try {
    await topology.advance({ ok: false, failedTool: 'bash' })
    assert.equal(topology.status(), 'failed')
    assert.equal(topology.stateSnapshot().facts.failedTool, 'bash')
  } finally {
    await topology.dispose()
  }
})

test('canKernelDrive accepts a callFailed failure branch and excludes unsupported conditions', () => {
  const base = plan()
  assert.equal(canKernelDrive(base), true)

  const withSubagent: TaskPlan = {
    ...base,
    nodes: [{ ...base.nodes[0]!, executor: 'subagent' }, base.nodes[1]!],
  }
  assert.equal(canKernelDrive(withSubagent), false)

  // The supported branch: a success control edge plus a `callFailed` recovery
  // edge from the same node. Both have a single unconditional out-edge, so the
  // failure branch is the only branch and the kernel may route it.
  const withCondition: TaskPlan = {
    ...base,
    terminals: ['c'],
    nodes: [...base.nodes, { id: 'c', kind: 'terminal', executor: 'step', instruction: 'recover' }],
    edges: [
      { ...base.edges[0]!, when: { op: 'callFailed', tool: 'bash' } },
      { from: 'a', to: 'c', kind: 'control' },
    ],
  }
  assert.equal(canKernelDrive(withCondition), true)

  // Other condition kinds are not evaluated by the kernel route; keep them on
  // the frontier rather than silently ignoring the guard.
  const unsupported: readonly Condition[] = [
    { op: 'fact', key: 'lastOk', equals: true },
    { op: 'artifact', type: 'file.patch' },
    { op: 'noArtifact', type: 'file.patch' },
    { op: 'budget', axis: 'steps', remainingAtMost: 2 },
  ]
  for (const when of unsupported) {
    assert.equal(canKernelDrive({ ...base, edges: [{ ...base.edges[0]!, when }] }), false, when.op)
  }
  // A condition on a data edge cannot route; the kernel follows control edges.
  assert.equal(canKernelDrive({
    ...base,
    edges: [base.edges[0]!, { ...base.edges[0]!, kind: 'data', when: { op: 'callFailed', tool: 'bash' } }],
  }), false)

  const withReservedId: TaskPlan = {
    ...base,
    nodes: [{ ...base.nodes[0]!, id: 'node:respond' }, { ...base.nodes[1]!, id: 'b' }],
    entry: 'node:respond',
    edges: [{ from: 'node:respond', to: 'b', kind: 'control' }],
  }
  assert.equal(canKernelDrive(withReservedId), false)
})

test('canKernelDrive rejects kernel channels and engine-reserved ids (H1)', () => {
  // Every GraphState channel the LangGraph root compiles is unusable as a node.
  for (const id of LANGGRAPH_RESERVED_NODE_IDS) {
    assert.equal(canKernelDrive(planWithNodeId(id)), false, `expected "${id}" to keep the frontier`)
  }
  assert.deepEqual(
    [...LANGGRAPH_RESERVED_NODE_IDS],
    [...LANGGRAPH_STATE_CHANNELS, '__start__', '__end__'],
    'the reserved list derives from the compiled channels',
  )
  // Matching is case-sensitive, like LangGraph's channel names.
  assert.equal(canKernelDrive(planWithNodeId('Next')), true)
  assert.equal(canKernelDrive(planWithNodeId('__END__')), true)
})

test('canKernelDrive rejects a branching (diamond) plan and keeps linear plans (H2)', () => {
  const base = plan()
  const diamond: TaskPlan = {
    ...base,
    entry: 'a',
    terminals: ['d'],
    nodes: [
      { id: 'a', kind: 'agent-step', executor: 'step', instruction: 'start' },
      { id: 'b', kind: 'agent-step', executor: 'step', instruction: 'left' },
      { id: 'c', kind: 'agent-step', executor: 'step', instruction: 'right' },
      { id: 'd', kind: 'terminal', executor: 'step', instruction: 'join', toolAllow: [] },
    ],
    edges: [
      { from: 'a', to: 'b', kind: 'control' },
      { from: 'a', to: 'c', kind: 'control' },
      { from: 'b', to: 'd', kind: 'control' },
      { from: 'c', to: 'd', kind: 'control' },
    ],
  }
  assert.equal(canKernelDrive(diamond), false)
  // The single control out-edge per node keeps the linear plan kernel-driven.
  assert.equal(canKernelDrive(base), true)
  // A terminal-only plan has no out-edges at all and stays drivable.
  const terminalOnly: TaskPlan = {
    ...base,
    entry: 'b',
    nodes: [base.nodes[1]!],
    edges: [],
  }
  assert.equal(canKernelDrive(terminalOnly), true)
})

for (const kind of ['langgraph', 'minimal'] as const) {
  test(`kernel topology takes the callFailed branch on a failed step (${kind})`, async (t) => {
    if (kind === 'langgraph' && !lgAvailable) {
      t.skip('@langchain/langgraph is not installed; skipping the LangGraph branch test')
      return
    }
    assert.equal(canKernelDrive(branchPlan()), true)
    const topology = new KernelTopology(branchPlan(), { kind, taskHash: 't' })
    try {
      assert.equal(topology.current()?.id, 'a')
      // The failed step takes `a -> b`; the success edge `a -> c` is not run.
      assert.equal((await topology.advance({ ok: false, failedTool: 'bash' }))?.id, 'b')
      assert.equal(topology.status(), 'running')
      assert.equal((await topology.advance({ ok: true }))?.id, 'd')
      assert.equal(await topology.advance({ ok: true }), undefined)
      assert.equal(topology.status(), 'done')
      assert.deepEqual(topology.stateSnapshot().journal.map(entry => entry.nodeId), ['a', 'b', 'd'])
    } finally {
      await topology.dispose()
    }
  })

  test(`kernel topology follows the success edge and skips the recovery branch (${kind})`, async (t) => {
    if (kind === 'langgraph' && !lgAvailable) {
      t.skip('@langchain/langgraph is not installed; skipping the LangGraph branch test')
      return
    }
    const topology = new KernelTopology(branchPlan(), { kind, taskHash: 't' })
    try {
      assert.equal(topology.current()?.id, 'a')
      assert.equal((await topology.advance({ ok: true }))?.id, 'c')
      assert.equal((await topology.advance({ ok: true }))?.id, 'd')
      assert.equal(await topology.advance({ ok: true }), undefined)
      assert.equal(topology.status(), 'done')
      assert.deepEqual(topology.stateSnapshot().journal.map(entry => entry.nodeId), ['a', 'c', 'd'])
    } finally {
      await topology.dispose()
    }
  })
}

test('kernel topology fails when a failed step has no matching callFailed edge', async (t) => {
  if (!lgAvailable) {
    t.skip('@langchain/langgraph is not installed; skipping the LangGraph branch test')
    return
  }
  const topology = new KernelTopology(branchPlan(), { kind: 'langgraph', taskHash: 't' })
  try {
    // The recovery edge is guarded on `bash`; a `read` failure takes no branch.
    assert.equal(await topology.advance({ ok: false, failedTool: 'read' }), undefined)
    assert.equal(topology.status(), 'failed')
    assert.equal(topology.done(), true)
    assert.deepEqual(topology.stateSnapshot().journal.map(entry => entry.nodeId), ['a'])
  } finally {
    await topology.dispose()
  }
})

test('kernel topology turns a reserved-id compile failure into a typed KernelError (H1)', async (t) => {
  if (!lgAvailable) {
    t.skip('@langchain/langgraph is not installed; the minimal fallback accepts any node id')
    return
  }
  // canKernelDrive() already keeps this plan on the frontier; constructing the
  // adapter directly still must fail with a typed error, not a bare throw.
  const topology = new KernelTopology(planWithNodeId('next'), { kind: 'langgraph' })
  try {
    await assert.rejects(
      () => topology.advance({ ok: true }),
      (error: unknown) => error instanceof KernelError && error.code === 'BAD_NODE_ID',
    )
    assert.equal(topology.status(), 'failed')
    assert.equal(topology.done(), true)
    assert.equal(topology.current(), undefined)
  } finally {
    await topology.dispose()
  }
})

test('kernel topology defaults to the LangGraph engine', async () => {
  const topology = new KernelTopology(plan(), { taskHash: 't' })
  try {
    assert.equal(topology.current()?.id, 'a')
    assert.equal((await topology.advance({ ok: true }))?.id, 'b')
  } finally {
    await topology.dispose()
  }
})
