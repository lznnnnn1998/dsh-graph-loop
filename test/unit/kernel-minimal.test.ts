/**
 * kernel-minimal.test.ts — contract tests for the vendored stepwise kernel.
 *
 * Covers the Definition of Done for task-8:
 *  - linear graph: one node per superstep, boundaries before the next node;
 *  - conditional branch: router picks the declared destination;
 *  - JSON violation: a non-JSON update is rejected and never checkpointed;
 *  - budget: `maxSteps` is a budget stop (KernelError / failed result);
 *  - resume: checkpoint history + `resume()` continues a paused plan;
 *  - Layer-2 step semantics: `next()` executes exactly one node per call;
 *  - `runPlan()` convenience loop.
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import {
  END,
  START,
  InTurnCheckpointer,
  KernelError,
  createGraph,
  createKernel,
  planInitialState,
  runPlan,
} from '../../packages/loop/src/kernel/index.ts'
import type { GraphBuilder, JsonUpdate, SuperstepBoundary } from '@dsh/explore-core/kernel'
import { assertJsonSafe } from '@dsh/explore-core/graph-schema'
import type { PlanNode, TaskPlan } from '@dsh/explore-core/graph-schema'
import type { PlanExecutorPort } from '../../packages/loop/src/kernel/index.ts'

/* ========================================================================== *
 * Fixtures
 * ========================================================================== */

interface State {
  n: number
  route: 'left' | 'right'
  hits: string[]
}

function freshState(overrides: Partial<State> = {}): State {
  return { n: 0, route: 'left', hits: [], ...overrides }
}

function linearGraph<S extends State>(
  builder: GraphBuilder<S>,
  run: { a: (n: number) => number; b: (n: number) => number },
): GraphBuilder<S> {
  return builder
    .addNode('a', (ctx) => ({ n: run.a(ctx.state.n), hits: [...ctx.state.hits, 'a'] }))
    .addNode('b', (ctx) => ({ n: run.b(ctx.state.n), hits: [...ctx.state.hits, 'b'] }))
    .addEdge(START, 'a')
    .addEdge('a', 'b')
    .addEdge('b', END)
}

function conditionalGraph(builder: GraphBuilder<State>): GraphBuilder<State> {
  return builder
    .addNode('entry', (ctx) => ({ hits: [...ctx.state.hits, 'entry'] }))
    .addNode('left', (ctx) => ({ hits: [...ctx.state.hits, 'left'] }))
    .addNode('right', (ctx) => ({ hits: [...ctx.state.hits, 'right'] }))
    .addNode('join', (ctx) => ({ hits: [...ctx.state.hits, 'join'] }))
    .addEdge(START, 'entry')
    .addConditionalEdge('entry', (state) => (state.route === 'left' ? 'left' : 'right'), ['left', 'right'])
    .addEdge('left', 'join')
    .addEdge('right', 'join')
    .addEdge('join', END)
}

function buildLinear(): GraphBuilder<State> {
  return linearGraph(createGraph<State>({ name: 'linear', initialState: freshState() }), {
    a: (n) => n + 1,
    b: (n) => n + 1,
  })
}

function planNode(id: string): PlanNode {
  return { id, kind: 'agent-step', executor: 'step' }
}

function makePlan(nodes: PlanNode[], edges: readonly (readonly [string, string])[], overrides: Partial<TaskPlan> = {}): TaskPlan {
  return {
    id: 'plan-1',
    templateId: 't-test',
    version: 1,
    entry: nodes[0]!.id,
    terminals: [nodes[nodes.length - 1]!.id],
    nodes,
    edges: edges.map(([from, to]) => ({ from, to, kind: 'control' as const })),
    budget: { maxNodes: 16, maxSteps: 16, maxTokens: 10_000, maxWallMs: 60_000, maxReplans: 2 },
    toolUniverse: [],
    gatePolicy: 'cold',
    fallback: false,
    confidence: 1,
    compiledDigest: 'digest-1',
    ...overrides,
  }
}

function recordingExecutor(log: string[]): PlanExecutorPort {
  return {
    kind: 'step',
    execute(node) {
      log.push(node.id)
      return {
        nodeId: node.id,
        ok: true,
        facts: { [`ran:${node.id}`]: true },
        artifacts: [],
        atSeq: log.length,
      }
    },
  }
}

/* ========================================================================== *
 * Layer 1 — CompiledGraph
 * ========================================================================== */

test('minimal: linear graph runs one superstep per node and emits boundaries before the next node', async () => {
  const graph = buildLinear()
  const boundaries: SuperstepBoundary[] = []
  const compiled = graph.compile()
  const result = await compiled.invoke({}, { threadId: 'linear-1', onBoundary: (boundary) => {
    boundaries.push(boundary)
  },
})

  assert.equal(result.status, 'completed')
  assert.equal(result.steps, 2)
  assert.deepEqual(result.state, { n: 2, route: 'left', hits: ['a', 'b'] })
  assert.deepEqual(
    boundaries.map((boundary) => ({ step: boundary.step, completed: boundary.completedNodes, next: boundary.next })),
    [
      { step: 1, completed: ['a'], next: ['b'] },
      { step: 2, completed: ['b'], next: [] },
    ],
  )
})

test('minimal: conditional edge picks the declared branch for each state', async () => {
  const left = conditionalGraph(createGraph<State>({ name: 'cond', initialState: freshState({ route: 'left' }) }))
  const right = conditionalGraph(createGraph<State>({ name: 'cond', initialState: freshState({ route: 'right' }) }))

  const leftResult = await left.compile().invoke({}, { threadId: 'left' })
  const rightResult = await right.compile().invoke({}, { threadId: 'right' })

  assert.deepEqual(leftResult.state.hits, ['entry', 'left', 'join'])
  assert.deepEqual(rightResult.state.hits, ['entry', 'right', 'join'])
})

test('minimal: a router may not return an undeclared destination', async () => {
  const graph = createGraph<State>({ name: 'bad-route', initialState: freshState() })
    .addNode('a', () => ({ hits: ['a'] }))
    .addNode('left', () => ({ hits: ['left'] }))
    .addNode('right', () => ({ hits: ['right'] }))
    .addEdge(START, 'a')
    .addConditionalEdge('a', () => 'missing', ['left', 'right'])

  await assert.rejects(
    graph.compile().invoke({}, { threadId: 'bad-route' }),
    (error: unknown) => error instanceof KernelError && error.code === 'UNDECLARED_TARGET',
  )
})

test('minimal: a non-JSON update is rejected and never checkpointed (C1)', async () => {
  const saver = new InTurnCheckpointer<State>()
  const graph = createGraph<State>({ name: 'json-guard', initialState: freshState() })
    .addNode('a', () => ({ when: new Date() }) as unknown as JsonUpdate)
    .addEdge(START, 'a')
    .addEdge('a', END)
  const compiled = graph.compile({ checkpointer: saver })

  await assert.rejects(
    compiled.invoke({}, { threadId: 'json-1' }),
    (error: unknown) => error instanceof KernelError && error.code === 'NON_JSON_STATE',
  )
  assert.equal(await compiled.getState('json-1'), undefined)
})

test('minimal: maxSteps is a step-budget stop (KernelError STEP_BUDGET_EXCEEDED)', async () => {
  const graph = createGraph<State>({ name: 'budget', initialState: freshState() })
    .addNode('a', (ctx) => ({ n: ctx.state.n + 1 }))
    .addNode('b', (ctx) => ({ n: ctx.state.n + 1 }))
    .addNode('c', (ctx) => ({ n: ctx.state.n + 1 }))
    .addEdge(START, 'a')
    .addEdge('a', 'b')
    .addEdge('b', 'c')
    .addEdge('c', END)

  await assert.rejects(
    graph.compile({ maxSteps: 2 }).invoke({}, { threadId: 'budget' }),
    (error: unknown) => error instanceof KernelError && error.code === 'STEP_BUDGET_EXCEEDED',
  )
})

test('minimal: checkpoints are JSON, chained, and readable newest-first', async () => {
  const saver = new InTurnCheckpointer<State>()
  const compiled = buildLinear().compile({ checkpointer: saver })

  await compiled.invoke({}, { threadId: 'cp-1' })
  const snapshot = await compiled.getState('cp-1')
  assert.ok(snapshot !== undefined)
  assert.equal(assertJsonSafe(snapshot.checkpoint.state), null)
  assert.deepEqual(snapshot.checkpoint.state, { n: 2, route: 'left', hits: ['a', 'b'] })
  assert.deepEqual(snapshot.next, [])

  const history = []
  for await (const entry of compiled.getStateHistory('cp-1')) history.push(entry)
  assert.equal(history.length, 2)
  assert.equal(history[0]!.checkpoint.step, 2)
  assert.equal(history[0]!.checkpoint.parentId, history[1]!.checkpoint.id)
})

test('minimal: withTopology() splices a node into an existing edge', async () => {
  const base = createGraph<State>({ name: 'topology', initialState: freshState() })
    .addNode('a', (ctx) => ({ n: ctx.state.n + 1 }))
    .addEdge(START, 'a')
    .addEdge('a', END)
  const compiled = base.compile()

  const extended = compiled.withTopology((builder) => {
    builder.addNode('b', (ctx) => ({ n: ctx.state.n * 10 }))
    builder.addEdge('a', 'b')
    builder.addEdge('b', END)
  })
  const result = await extended.invoke({}, { threadId: 'topology' })

  assert.equal(result.status, 'completed')
  assert.equal(result.steps, 2)
  assert.equal(result.state.n, 10)
  // The original topology is untouched (compiled graphs are immutable).
  assert.equal((await compiled.invoke({}, { threadId: 'topology-2' })).state.n, 1)
})

/* ========================================================================== *
 * Layer 2 — stepwise KernelPort
 * ========================================================================== */

test('minimal: next() executes exactly ONE plan node per call and returns a boundary first', async () => {
  const plan = makePlan([planNode('n1'), planNode('n2'), planNode('n3')], [['n1', 'n2'], ['n2', 'n3']])
  const log: string[] = []
  const kernel = createKernel('minimal', { executors: [recordingExecutor(log)] })
  const run = kernel.compile(plan, planInitialState(plan))

  const first = await run.next()
  assert.equal(first.kind, 'boundary')
  if (first.kind !== 'boundary') return
  assert.deepEqual(log, ['n1']) // nothing else has run yet
  assert.deepEqual(
    { superstep: first.boundary.superstep, atSeq: first.boundary.atSeq, closedBy: first.boundary.closedBy },
    { superstep: 1, atSeq: 1, closedBy: 'step-end' },
  )
  assert.equal(first.state.next, 'n2')

  const second = await run.next()
  assert.equal(second.kind, 'boundary')
  assert.deepEqual(log, ['n1', 'n2'])
  assert.equal(second.state.next, 'n3')

  const third = await run.next()
  assert.equal(third.kind, 'boundary')
  assert.deepEqual(log, ['n1', 'n2', 'n3'])
  assert.equal(third.state.next, null)

  const fourth = await run.next()
  assert.equal(fourth.kind, 'done')
  assert.deepEqual(log, ['n1', 'n2', 'n3']) // a done call executes no node
  await run.dispose()
})

test('minimal: zero-dep kernel walks a plan topology with no-op nodes', async () => {
  const plan = makePlan([planNode('n1'), planNode('n2')], [['n1', 'n2']])
  const run = createKernel('minimal').compile(plan, planInitialState(plan))

  assert.equal((await run.next()).kind, 'boundary')
  assert.equal((await run.next()).kind, 'boundary')
  assert.equal((await run.next()).kind, 'done')
  await run.dispose()
})

test('minimal: cancel through AbortSignal surfaces as a failed cancelled result (A7)', async () => {
  const plan = makePlan([planNode('n1'), planNode('n2')], [['n1', 'n2']])
  const controller = new AbortController()
  const log: string[] = []
  const kernel = createKernel('minimal', {
    executors: [recordingExecutor(log)],
    runContext: { signal: controller.signal },
  })
  const run = kernel.compile(plan, planInitialState(plan))

  controller.abort('user cancelled')
  const result = await run.next()
  assert.equal(result.kind, 'failed')
  assert.equal(result.kind === 'failed' ? result.error.code : undefined, 'cancelled')
  assert.deepEqual(log, [])
  await run.dispose()
})

test('minimal: pauseWhen pauses at a node boundary and resume(plan, state) continues', async () => {
  const plan = makePlan([planNode('n1'), planNode('n2')], [['n1', 'n2']])
  const log: string[] = []
  const kernel = createKernel('minimal', {
    executors: [recordingExecutor(log)],
    pauseWhen: (state) => (state.superstep >= 1 ? 'replan' : undefined),
  })
  const run = kernel.compile(plan, planInitialState(plan))

  assert.equal((await run.next()).kind, 'boundary')
  const paused = await run.next()
  assert.equal(paused.kind, 'paused')
  assert.equal(paused.kind === 'paused' ? paused.reason : undefined, 'replan')
  assert.deepEqual(log, ['n1'])

  // Resume from the paused snapshot: pauseWhen would still fire, but an explicit
  // resume skips it once.
  const resumed = kernel.resume(plan, run.snapshot())
  const next = await resumed.next()
  assert.equal(next.kind, 'boundary')
  assert.deepEqual(log, ['n1', 'n2'])
  assert.equal((await resumed.next()).kind, 'done')
  await run.dispose()
  await resumed.dispose()
})

test('minimal: runPlan() drives next() to completion without extra nodes', async () => {
  const plan = makePlan([planNode('n1'), planNode('n2')], [['n1', 'n2']])
  const log: string[] = []
  const result = await runPlan(plan, [recordingExecutor(log)])

  assert.equal(result.status, 'completed')
  assert.equal(result.steps, 2)
  assert.equal(result.result.kind, 'done')
  assert.deepEqual(log, ['n1', 'n2'])
  assert.deepEqual(result.state.journal.map((entry) => entry.nodeId), ['n1', 'n2'])
})

test('minimal: runPlan() reports budget exhaustion as failed/budget-exceeded', async () => {
  const plan = makePlan([planNode('n1'), planNode('n2'), planNode('n3')], [['n1', 'n2'], ['n2', 'n3']])
  const result = await runPlan(plan, [recordingExecutor([])], { maxSteps: 2 })

  assert.equal(result.status, 'failed')
  assert.equal(result.error?.code, 'budget-exceeded')
  assert.equal(result.state.superstep, 2)
})

/* ========================================================================== *
 * Type-level guards (kept in the test so a bad refactor fails fast)
 * ========================================================================== */

test('minimal: exported types describe a KernelPort-compatible factory', () => {
  const kernel = createKernel('minimal')
  assert.equal(typeof kernel.compile, 'function')
  assert.equal(typeof kernel.resume, 'function')
  assert.equal(typeof kernel.checkpointer.load, 'function')
  assert.equal(typeof kernel.checkpointer.put, 'function')
})

test('minimal: GraphState journal stays bounded', async () => {
  const nodes = Array.from({ length: 40 }, (_, index) => planNode(`n${index}`))
  const edges = nodes.slice(1).map((node, index) => [nodes[index]!.id, node.id] as const)
  const plan = makePlan(nodes, edges)
  const result = await runPlan(plan, [recordingExecutor([])], { maxSteps: 100 })
  assert.equal(result.status, 'completed')
  assert.ok(result.state.journal.length <= 64)
})
