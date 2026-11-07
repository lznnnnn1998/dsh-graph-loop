/**
 * kernel-core.test.ts — the core `KernelPort` adapter (`packages/core/src/kernel.ts`).
 *
 * H7: `LangGraphRun.updateState()` re-seeds a replanned run. It used to abort the
 * run's only stream controller, so every following `next()` opened an aborted
 * stream and threw (`KernelError: graph recompiled for a replan`) instead of
 * returning a `KernelResult`. The contract is `KernelRunHandle` in
 * `packages/core/src/runtime.ts`: `next()` resolves to a result, and a stream
 * failure is `{ kind: 'failed' }` with `onFailure` called — never a throw.
 *
 * These tests use the real `@langchain/langgraph` surface; when the optional
 * dependency is absent they skip with an explicit reason.
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import { assertLangGraphSurface, createLangGraphKernel as createCoreKernel } from '../../packages/core/src/kernel.ts'
import type { KernelNodeFailure, LangGraphSurface } from '../../packages/core/src/kernel.ts'
import type { PlanNode, TaskPlan } from '../../packages/core/src/graph-schema.ts'
import { loadLangGraph } from '../../packages/loop/src/kernel/langgraph.ts'
import { planInitialState } from '../../packages/loop/src/kernel/plan.ts'

const loaded = await loadLangGraph()
let lg: LangGraphSurface | undefined
if (loaded !== undefined) {
  assertLangGraphSurface(loaded)
  lg = loaded
}
const SKIP = '@langchain/langgraph is not installed; the core LangGraph adapter needs the real surface'

function plan(): TaskPlan {
  return {
    id: 'core-kernel-h7',
    templateId: 'test',
    version: 1,
    entry: 'n1',
    terminals: ['n2'],
    nodes: [
      { id: 'n1', kind: 'agent-step', executor: 'step', instruction: 'do n1' },
      { id: 'n2', kind: 'terminal', executor: 'step', instruction: 'answer', toolAllow: [] },
    ],
    edges: [{ from: 'n1', to: 'n2', kind: 'control' }],
    budget: { maxNodes: 2, maxSteps: 4, maxTokens: 10_000, maxWallMs: 60_000, maxReplans: 0 },
    toolUniverse: [],
    gatePolicy: 'cold',
    fallback: false,
    confidence: 1,
    compiledDigest: 'core-kernel-h7',
  }
}

const executor = {
  kind: 'step' as const,
  execute: async (node: PlanNode) => ({
    nodeId: node.id,
    ok: true,
    facts: { [`ran:${node.id}`]: true },
    artifacts: [],
    atSeq: 1,
  }),
}

const checkpointer = {
  load: async () => undefined,
  put: async () => undefined,
}

const afterNode = async ({ state }: { state: ReturnType<typeof planInitialState> }) => ({ atSeq: 1, state })

test('core kernel: updateState() then next() still returns a boundary, with and without runContext.signal (H7)', async (t) => {
  if (lg === undefined) {
    t.skip(SKIP)
    return
  }
  for (const withSignal of [false, true]) {
    const controller = new AbortController()
    const failures: KernelNodeFailure[] = []
    const kernel = createCoreKernel({
      lg,
      executors: [executor],
      checkpointer,
      afterNode,
      validateJson: false,
      onFailure: (failure) => failures.push(failure),
      ...(withSignal ? { runContext: { signal: controller.signal } } : {}),
    })
    const run = kernel.compile(plan(), planInitialState(plan()))
    try {
      // A replan caller: swap the state out, then continue the same handle.
      await run.updateState({ planVersion: 2 })
      const result = await run.next()
      assert.equal(result.kind, 'boundary', `withSignal=${withSignal}`)
      if (result.kind !== 'boundary') return
      assert.equal(result.state.planVersion, 2, 'the caller-patched state is kept')
      assert.deepEqual(failures, [], 'a replan is not a failure')
    } finally {
      await run.dispose()
    }
  }
})

test('core kernel: a failed stream becomes a failed result and calls onFailure, never a throw (H7)', async (t) => {
  if (lg === undefined) {
    t.skip(SKIP)
    return
  }
  const controller = new AbortController()
  controller.abort()
  const failures: KernelNodeFailure[] = []
  const kernel = createCoreKernel({
    lg,
    executors: [executor],
    checkpointer,
    afterNode,
    validateJson: false,
    runContext: { signal: controller.signal },
    onFailure: (failure) => failures.push(failure),
  })
  const run = kernel.compile(plan(), planInitialState(plan()))
  try {
    const result = await run.next()
    assert.equal(result.kind, 'failed')
    if (result.kind !== 'failed') return
    assert.equal(result.error.code, 'cancelled')
    assert.equal(failures.length, 1)
    assert.equal(failures[0]?.code, 'cancelled')
  } finally {
    await run.dispose()
  }
})
