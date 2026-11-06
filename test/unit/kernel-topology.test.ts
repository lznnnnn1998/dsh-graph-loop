/**
 * Unit tests for the kernel-backed topology adapter.
 *
 * The adapter pauses the kernel before a node, lets the host run the DSH step,
 * then resumes the kernel with the step outcome. These tests drive that cycle
 * without a session.
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'

import type { TaskPlan } from '../../packages/core/src/graph-schema.ts'
import { KernelTopology, canKernelDrive } from '../../packages/loop/src/kernel/topology.ts'

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

test('canKernelDrive excludes subagents and conditional edges', () => {
  const base = plan()
  assert.equal(canKernelDrive(base), true)

  const withSubagent: TaskPlan = {
    ...base,
    nodes: [{ ...base.nodes[0]!, executor: 'subagent' }, base.nodes[1]!],
  }
  assert.equal(canKernelDrive(withSubagent), false)

  const withCondition: TaskPlan = {
    ...base,
    edges: [{ ...base.edges[0]!, when: { op: 'callFailed', tool: 'bash' } }],
  }
  assert.equal(canKernelDrive(withCondition), false)

  const withReservedId: TaskPlan = {
    ...base,
    nodes: [{ ...base.nodes[0]!, id: 'node:respond' }, { ...base.nodes[1]!, id: 'b' }],
    entry: 'node:respond',
    edges: [{ from: 'node:respond', to: 'b', kind: 'control' }],
  }
  assert.equal(canKernelDrive(withReservedId), false)
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
