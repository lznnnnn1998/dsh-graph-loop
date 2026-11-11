/**
 * Unit tests for the kernel-backed topology adapter.
 *
 * The adapter pauses the kernel before a node, lets the host run the DSH step,
 * then resumes the kernel with the step outcome. These tests drive that cycle
 * without a session.
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'

import type { Condition, GraphState, TaskPlan } from '../../packages/core/src/graph-schema.ts'
import { END } from '../../packages/core/src/kernel.ts'
import { KernelError, available } from '../../packages/loop/src/kernel/index.ts'
import { LANGGRAPH_RESERVED_NODE_IDS, LANGGRAPH_STATE_CHANNELS } from '../../packages/loop/src/kernel/langgraph.ts'
import { KernelTopology, canKernelDrive, routeKernelPlan } from '../../packages/loop/src/kernel/topology.ts'
import { planInitialState } from '../../packages/loop/src/kernel/plan.ts'

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

/**
 * A step-executor fan-out/join: `a` splits unconditionally to `b` and `c`, and
 * both branches join the terminal `d`. Every control edge is unconditional and
 * acyclic, so this is the class the kernel route owns (the frontier used to be
 * the only engine that could run it).
 */
function diamondPlan(): TaskPlan {
  const base = plan()
  return {
    ...base,
    id: 'kernel-diamond-test',
    entry: 'a',
    terminals: ['d'],
    nodes: [
      { id: 'a', kind: 'agent-step', executor: 'step', instruction: 'split' },
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
    assert.equal(topology.planState(), 'terminal')
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

test('canKernelDrive accepts every condition the shared evaluator handles', () => {
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

  // Every condition operator is evaluated by the kernel route hook, so the
  // adapter no longer sends these plans to the frontier.
  const supported: readonly Condition[] = [
    { op: 'fact', key: 'lastOk', equals: true },
    { op: 'artifact', type: 'file.patch' },
    { op: 'noArtifact', type: 'file.patch' },
    { op: 'budget', axis: 'steps', remainingAtMost: 2 },
  ]
  for (const when of supported) {
    assert.equal(canKernelDrive({ ...base, edges: [{ ...base.edges[0]!, when }] }), true, when.op)
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

test('canKernelDrive owns an acyclic all-unconditional diamond and keeps the unsafe fan-out shapes on the frontier (H2)', () => {
  const base = plan()
  const diamond = diamondPlan()
  // The widened class: one declared terminal, every control edge unconditional,
  // acyclic, and small enough that the journal holds every completed node.
  assert.equal(canKernelDrive(diamond), true, 'the all-unconditional diamond must be kernel-driven')
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

  // A guard alongside a split cannot be reconstructed from the journal: a
  // branch that did not fire must not look entered, so the plan keeps the
  // frontier. (A guard that replaces one split arm is not a split — the old
  // single-unconditional-edge rule already accepts that conditional branch.)
  const guardedElsewhere: TaskPlan = {
    ...diamond,
    nodes: [...diamond.nodes, { id: 'e', kind: 'agent-step', executor: 'step', instruction: 'recover' }],
    edges: [...diamond.edges, { from: 'b', to: 'e', kind: 'control', when: { op: 'callFailed', tool: 'bash' } }],
  }
  assert.equal(canKernelDrive(guardedElsewhere), false, 'a guarded arm alongside a fan-out stays frontier-owned')

  // A cycle would make a completed node pending again; one `next` cannot say that.
  const cyclic: TaskPlan = {
    ...diamond,
    edges: [...diamond.edges, { from: 'd', to: 'a', kind: 'control' }],
  }
  assert.equal(canKernelDrive(cyclic), false, 'a cyclic fan-out stays frontier-owned')

  // Two terminal branches: both engines end a run at a declared terminal, so a
  // second reachable terminal cannot run on the cursor engine.
  const twoTerminals: TaskPlan = {
    ...diamond,
    terminals: ['c', 'd'],
    edges: diamond.edges.filter(edge => !(edge.from === 'c' && edge.to === 'd')),
  }
  assert.equal(canKernelDrive(twoTerminals), false, 'multiple terminals keep the frontier')

  // A control predecessor the entry cannot reach never runs, so its join could
  // never become ready; the frontier treats a never-entered input as
  // non-blocking, which the journal cannot distinguish from "not yet entered".
  const unreachableInput: TaskPlan = {
    ...diamond,
    nodes: [...diamond.nodes, { id: 'x', kind: 'agent-step', executor: 'step', instruction: 'orphan' }],
    edges: [...diamond.edges, { from: 'x', to: 'd', kind: 'control' }],
  }
  assert.equal(canKernelDrive(unreachableInput), false, 'an unreachable join input keeps the frontier')

  // A plan larger than the journal can lose a completed predecessor when the
  // journal is trimmed, so the join would be released on stale data.
  const wide = 65
  const oversized: TaskPlan = {
    ...base,
    entry: 'n0',
    terminals: [`n${wide - 1}`],
    nodes: Array.from({ length: wide }, (_, index) => ({
      id: `n${index}`,
      kind: index === wide - 1 ? 'terminal' as const : 'agent-step' as const,
      executor: 'step' as const,
      instruction: `node ${index}`,
      ...(index === wide - 1 ? { toolAllow: [] } : {}),
    })),
    edges: [
      { from: 'n0', to: 'n1', kind: 'control' },
      { from: 'n0', to: 'n2', kind: 'control' },
      { from: 'n1', to: `n${wide - 1}`, kind: 'control' },
      { from: 'n2', to: `n${wide - 1}`, kind: 'control' },
    ],
  }
  assert.equal(canKernelDrive(oversized), false, 'a fan-out larger than the journal keeps the frontier')
})

test('kernel route picks the next ready node from the journal and holds the join (fan-out class)', () => {
  const diamond = diamondPlan()
  const stateAfter = (nodeIds: readonly string[]): GraphState => ({
    ...planInitialState(diamond),
    facts: { lastOk: true },
    journal: nodeIds.map((nodeId, index) => ({ nodeId, superstep: index + 1, outcome: 'ok' as const, atSeq: index + 1 })),
  })
  // `a` split: both branches are entered; declared control-edge order picks `b`.
  assert.equal(routeKernelPlan({ plan: diamond, nodeId: 'a', state: stateAfter(['a']) }), 'b')
  // `b` completed: its successor `d` is a join whose other input `c` is entered
  // but incomplete, so the only ready node is the sibling `c`.
  assert.equal(routeKernelPlan({ plan: diamond, nodeId: 'b', state: stateAfter(['a', 'b']) }), 'c')
  assert.equal(routeKernelPlan({ plan: diamond, nodeId: 'c', state: stateAfter(['a', 'b', 'c']) }), 'd')
  assert.equal(routeKernelPlan({ plan: diamond, nodeId: 'd', state: stateAfter(['a', 'b', 'c', 'd']) }), END)

  // A deeper branch: the join's direct predecessor is below the split, so the
  // journal must hold `d` until `c2` arrives (the P1-1 defect).
  const deep: TaskPlan = {
    ...diamond,
    nodes: [...diamond.nodes.slice(0, 3), { id: 'c2', kind: 'agent-step', executor: 'step', instruction: 'deep' }, diamond.nodes[3]!],
    edges: [
      { from: 'a', to: 'b', kind: 'control' },
      { from: 'a', to: 'c', kind: 'control' },
      { from: 'b', to: 'c2', kind: 'control' },
      { from: 'c', to: 'd', kind: 'control' },
      { from: 'c2', to: 'd', kind: 'control' },
    ],
  }
  assert.equal(routeKernelPlan({ plan: deep, nodeId: 'a', state: stateAfter(['a']) }), 'b')
  assert.equal(routeKernelPlan({ plan: deep, nodeId: 'b', state: stateAfter(['a', 'b']) }), 'c',
    'the deep branch must be picked before its join')
  assert.equal(routeKernelPlan({ plan: deep, nodeId: 'c', state: stateAfter(['a', 'b', 'c']) }), 'c2')
  assert.equal(routeKernelPlan({ plan: deep, nodeId: 'c2', state: stateAfter(['a', 'b', 'c', 'c2']) }), 'd')
})

for (const kind of ['langgraph', 'minimal'] as const) {
  test(`kernel topology runs an all-unconditional diamond once per node on one cursor (${kind})`, async (t) => {
    if (kind === 'langgraph' && !lgAvailable) {
      t.skip('@langchain/langgraph is not installed; skipping the LangGraph diamond test')
      return
    }
    const diamond = diamondPlan()
    assert.equal(canKernelDrive(diamond), true)
    const topology = new KernelTopology(diamond, { kind, taskHash: 'diamond' })
    try {
      const visited: string[] = []
      let node = topology.current()
      while (node !== undefined && visited.length < 8) {
        visited.push(node.id)
        node = await topology.advance({ ok: true })
      }
      assert.deepEqual(visited, ['a', 'b', 'c', 'd'], 'one branch per step; the join last and once')
      assert.equal(visited.filter(id => id === 'd').length, 1, 'the join must not run twice')
      assert.equal(topology.status(), 'done')
      assert.deepEqual(topology.stateSnapshot().journal.map(entry => entry.nodeId), ['a', 'b', 'c', 'd'])
    } finally {
      await topology.dispose()
    }
  })
}

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
    assert.equal(topology.planState(), 'failed')
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
    assert.equal(topology.planState(), 'failed')
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


test('kernel route evaluates artifact, fact and budget guards', () => {
  const base = plan()
  const branch: TaskPlan = {
    ...base,
    id: 'kernel-guard-test',
    terminals: ['c'],
    nodes: [
      { id: 'a', kind: 'agent-step', executor: 'step', instruction: 'work' },
      { id: 'b', kind: 'agent-step', executor: 'step', instruction: 'guarded' },
      { id: 'c', kind: 'agent-step', executor: 'step', instruction: 'fallback' },
    ],
    edges: [],
    budget: { ...base.budget, maxSteps: 10, maxNodes: 3 },
  }
  const route = (when: Condition, facts: Record<string, unknown>, artifacts: { type: 'file.patch' | 'file.text'; ref: string }[] = [], superstep = 1): string => {
    const state = {
      ...planInitialState(branch),
      superstep,
      facts: facts as never,
      artifacts: artifacts as never,
    }
    const guarded: TaskPlan = {
      ...branch,
      edges: [
        { from: 'a', to: 'b', kind: 'control', when },
        { from: 'a', to: 'c', kind: 'control' },
      ],
    }
    return routeKernelPlan({ plan: guarded, nodeId: 'a', state })
  }

  assert.equal(route({ op: 'artifact', type: 'file.patch' }, { lastOk: true }), 'c')
  assert.equal(route({ op: 'artifact', type: 'file.patch' }, { lastOk: true }, [{ type: 'file.patch', ref: 'a.patch' }]), 'b')
  assert.equal(route({ op: 'fact', key: 'lastOk', equals: false }, { lastOk: true }), 'c')
  assert.equal(route({ op: 'fact', key: 'lastOk', equals: false }, { lastOk: false }), 'b')
  assert.equal(route({ op: 'budget', axis: 'steps', remainingAtMost: 2 }, { lastOk: true }, [], 1), 'c')
  assert.equal(route({ op: 'budget', axis: 'steps', remainingAtMost: 2 }, { lastOk: true }, [], 9), 'b')
})
