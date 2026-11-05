/**
 * kernel-langgraph.test.ts — adapter tests for `@langchain/langgraph@1.7.0`.
 *
 * The same builder calls that produce the minimal graph are compiled through a
 * real `StateGraph(Annotation.Root(...))` and must produce the same execution
 * order, state, boundaries and JSON guarantees. When the dependency is missing
 * (or no longer satisfies the kernel surface) every test is SKIPPED with an
 * explicit reason — never silently passed.
 */

import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import path from 'node:path'
import test from 'node:test'

import {
  END,
  START,
  InTurnCheckpointer,
  KernelError,
  available,
  createGraph,
  createKernel,
  createLangGraphGraph,
  planInitialState,
  runPlan,
} from '../../packages/loop/src/kernel/index.ts'
import type { GraphBuilder, JsonUpdate, SuperstepBoundary } from '@dsh/explore-core/kernel'
import { assertJsonSafe } from '@dsh/explore-core/graph-schema'
import type { PlanNode, TaskPlan } from '@dsh/explore-core/graph-schema'
import type { PlanExecutorPort } from '../../packages/loop/src/kernel/index.ts'

interface State {
  n: number
  route: 'left' | 'right'
  hits: string[]
}

function freshState(overrides: Partial<State> = {}): State {
  return { n: 0, route: 'left', hits: [], ...overrides }
}

const lgAvailable = await available()

const SKIP_REASON = lgAvailable
  ? undefined
  : '@langchain/langgraph is not installed or no longer satisfies the kernel surface (available() === false)'

async function readLangGraphVersion(): Promise<string | undefined> {
  try {
    const require = createRequire(import.meta.url)
    const entry = require.resolve('@langchain/langgraph')
    const manifest = path.join(path.dirname(entry), '..', 'package.json')
    const parsed = JSON.parse(await readFile(manifest, 'utf8')) as { version?: unknown }
    return typeof parsed.version === 'string' ? parsed.version : undefined
  } catch {
    return undefined
  }
}

/** The builder calls every engine must accept identically. */
function linearBuilder(builder: GraphBuilder<State>): GraphBuilder<State> {
  return builder
    .addNode('a', (ctx) => ({ n: ctx.state.n + 1, hits: [...ctx.state.hits, 'a'] }))
    .addNode('b', (ctx) => ({ n: ctx.state.n + 1, hits: [...ctx.state.hits, 'b'] }))
    .addEdge(START, 'a')
    .addEdge('a', 'b')
    .addEdge('b', END)
}

function conditionalBuilder(builder: GraphBuilder<State>): GraphBuilder<State> {
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

function planNode(id: string): PlanNode {
  return { id, kind: 'agent-step', executor: 'step' }
}

function makePlan(nodes: PlanNode[], edges: readonly (readonly [string, string])[]): TaskPlan {
  return {
    id: 'plan-lg',
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
    compiledDigest: 'digest-lg',
  }
}

function recordingExecutor(log: string[]): PlanExecutorPort {
  return {
    kind: 'step',
    execute(node) {
      log.push(node.id)
      return { nodeId: node.id, ok: true, facts: { [`ran:${node.id}`]: true }, artifacts: [], atSeq: log.length }
    },
  }
}

async function collectBoundaries(
  compiled: { invoke: (input: JsonUpdate, options: { threadId: string; onBoundary: (boundary: SuperstepBoundary) => void }) => Promise<unknown> },
): Promise<SuperstepBoundary[]> {
  const boundaries: SuperstepBoundary[] = []
  await compiled.invoke({}, { threadId: `bound-${Math.random()}`, onBoundary: (boundary) => { boundaries.push(boundary) } })
  return boundaries
}

/* ========================================================================== *
 * Availability
 * ========================================================================== */

test('langgraph: adapter reports availability and the pinned version', async (t) => {
  const version = await readLangGraphVersion()
  if (version !== undefined) t.diagnostic(`@langchain/langgraph ${version}`)
  if (!lgAvailable) {
    t.skip(SKIP_REASON)
    return
  }
  assert.equal(lgAvailable, true)
  if (version !== undefined) {
    assert.equal(version, '1.7.0')
  }
})

test('langgraph: createLangGraphGraph() builds the same StateGraph from the same builder calls', async (t) => {
  if (!lgAvailable) {
    t.skip(SKIP_REASON)
    return
  }
  const minimal = linearBuilder(createGraph<State>({ name: 'linear', initialState: freshState() }))
  const langgraph = linearBuilder(await createLangGraphGraph<State>({ name: 'linear', initialState: freshState() }))

  const minimalResult = await minimal.compile().invoke({}, { threadId: 'min-linear' })
  const lgResult = await langgraph.compile().invoke({}, { threadId: 'lg-linear' })

  assert.equal(lgResult.status, 'completed')
  assert.equal(lgResult.steps, minimalResult.steps)
  assert.deepEqual(lgResult.state, minimalResult.state)
  assert.deepEqual(lgResult.state, { n: 2, route: 'left', hits: ['a', 'b'] })

  const minimalBoundaries = await collectBoundaries(minimal.compile())
  const lgBoundaries = await collectBoundaries(langgraph.compile())
  assert.deepEqual(lgBoundaries, minimalBoundaries)
  assert.deepEqual(
    lgBoundaries.map((boundary) => boundary.next),
    [['b'], []],
  )
})

test('langgraph: conditional edge picks the same branch as the minimal kernel', async (t) => {
  if (!lgAvailable) {
    t.skip(SKIP_REASON)
    return
  }
  const leftGraph = conditionalBuilder(await createLangGraphGraph<State>({ name: 'cond-l', initialState: freshState({ route: 'left' }) }))
  const rightGraph = conditionalBuilder(await createLangGraphGraph<State>({ name: 'cond-r', initialState: freshState({ route: 'right' }) }))

  const left = await leftGraph.compile().invoke({}, { threadId: 'lg-left' })
  const right = await rightGraph.compile().invoke({}, { threadId: 'lg-right' })

  assert.deepEqual(left.state.hits, ['entry', 'left', 'join'])
  assert.deepEqual(right.state.hits, ['entry', 'right', 'join'])
})

test('langgraph: non-JSON state is rejected and never checkpointed (C1)', async (t) => {
  if (!lgAvailable) {
    t.skip(SKIP_REASON)
    return
  }
  const saver = new InTurnCheckpointer<State>()
  const graph = (await createLangGraphGraph<State>({ name: 'json-guard', initialState: freshState() }))
    .addNode('a', () => ({ when: new Date() }) as unknown as JsonUpdate)
    .addEdge(START, 'a')
    .addEdge('a', END)
  const compiled = graph.compile({ checkpointer: saver })

  await assert.rejects(
    compiled.invoke({}, { threadId: 'lg-json' }),
    (error: unknown) => error instanceof KernelError && error.code === 'NON_JSON_STATE',
  )
  assert.equal(await compiled.getState('lg-json'), undefined)
})

test('langgraph: checkpoint state is JSON and carries no __pregel_* channels', async (t) => {
  if (!lgAvailable) {
    t.skip(SKIP_REASON)
    return
  }
  const saver = new InTurnCheckpointer<State>()
  const graph = linearBuilder(await createLangGraphGraph<State>({ name: 'cp', initialState: freshState() }))
  const compiled = graph.compile({ checkpointer: saver })

  await compiled.invoke({}, { threadId: 'lg-cp' })
  const snapshot = await compiled.getState('lg-cp')
  assert.ok(snapshot !== undefined)
  assert.equal(assertJsonSafe(snapshot.checkpoint.state), null)
  assert.deepEqual(snapshot.checkpoint.state, { n: 2, route: 'left', hits: ['a', 'b'] })
  assert.equal(Object.keys(snapshot.checkpoint.state).some((key) => key.startsWith('__pregel')), false)
  assert.deepEqual(snapshot.next, [])

  const history = []
  for await (const entry of compiled.getStateHistory('lg-cp')) history.push(entry)
  assert.equal(history.length, 2)
  assert.equal(history[0]!.checkpoint.parentId, history[1]!.checkpoint.id)
})

test('langgraph: maxSteps is a step-budget stop, not a crash (GraphRecursionError mapping)', async (t) => {
  if (!lgAvailable) {
    t.skip(SKIP_REASON)
    return
  }
  const graph = createGraph<State>({ name: 'never-run', initialState: freshState() })
    .addNode('noop', (ctx) => ({ hits: [...ctx.state.hits, 'noop'] }))
    .addEdge(START, 'noop')
    .addEdge('noop', END)
  const compiled = (await createLangGraphGraph<State>({ name: 'budget-lg', initialState: freshState() }))
    .addNode('a', (ctx) => ({ n: ctx.state.n + 1 }))
    .addNode('b', (ctx) => ({ n: ctx.state.n + 1 }))
    .addNode('c', (ctx) => ({ n: ctx.state.n + 1 }))
    .addEdge(START, 'a')
    .addEdge('a', 'b')
    .addEdge('b', 'c')
    .addEdge('c', END)
    .compile({ maxSteps: 2 })

  await assert.rejects(
    compiled.invoke({}, { threadId: 'lg-budget' }),
    (error: unknown) => error instanceof KernelError && error.code === 'STEP_BUDGET_EXCEEDED',
  )
  void graph
})

test('langgraph: withTopology() recompiles a spliced node', async (t) => {
  if (!lgAvailable) {
    t.skip(SKIP_REASON)
    return
  }
  const compiled = linearBuilder(await createLangGraphGraph<State>({ name: 'topo-lg', initialState: freshState() })).compile()
  const extended = compiled.withTopology((builder) => {
    builder.addNode('c', (ctx) => ({ n: ctx.state.n * 100 }))
    builder.addEdge('b', 'c')
    builder.addEdge('c', END)
  })
  const result = await extended.invoke({}, { threadId: 'lg-topo' })

  assert.equal(result.status, 'completed')
  assert.equal(result.state.n, 200)
  assert.equal(result.steps, 3)
})

/* ========================================================================== *
 * Layer 2 — stepwise plan kernel
 * ========================================================================== */

test('langgraph: next() on a plan returns one boundary per node, then done', async (t) => {
  if (!lgAvailable) {
    t.skip(SKIP_REASON)
    return
  }
  const plan = makePlan([planNode('n1'), planNode('n2')], [['n1', 'n2']])
  const log: string[] = []
  const kernel = createKernel('langgraph', { executors: [recordingExecutor(log)] })
  const run = kernel.compile(plan, planInitialState(plan))

  const first = await run.next()
  assert.equal(first.kind, 'boundary')
  if (first.kind !== 'boundary') return
  assert.deepEqual(log, ['n1']) // boundary returned before the next node runs
  assert.equal(first.boundary.superstep, 1)
  assert.equal(first.state.next, 'n2')

  const second = await run.next()
  assert.equal(second.kind, 'boundary')
  assert.deepEqual(log, ['n1', 'n2'])
  assert.equal(second.state.next, null)

  const third = await run.next()
  assert.equal(third.kind, 'done')
  assert.deepEqual(log, ['n1', 'n2'])
  await run.dispose()
})

test('langgraph: pauseWhen pauses at a boundary and resume() continues without re-running the node', async (t) => {
  if (!lgAvailable) {
    t.skip(SKIP_REASON)
    return
  }
  const plan = makePlan([planNode('n1'), planNode('n2')], [['n1', 'n2']])
  const log: string[] = []
  const kernel = createKernel('langgraph', {
    executors: [recordingExecutor(log)],
    pauseWhen: (state) => (state.superstep >= 1 ? 'replan' : undefined),
  })
  const run = kernel.compile(plan, planInitialState(plan))

  assert.equal((await run.next()).kind, 'boundary')
  const paused = await run.next()
  assert.equal(paused.kind, 'paused')
  assert.equal(paused.kind === 'paused' ? paused.reason : undefined, 'replan')
  assert.deepEqual(log, ['n1'])

  const resumed = kernel.resume(plan, run.snapshot())
  const continued = await resumed.next()
  assert.equal(continued.kind, 'boundary')
  assert.deepEqual(log, ['n1', 'n2']) // node n2 ran once, on the resumed handle
  assert.equal((await resumed.next()).kind, 'done')

  await run.dispose() // gated successor aborts, does not re-run
  await resumed.dispose()
  assert.deepEqual(log, ['n1', 'n2'])
})

test('langgraph: runPlan(kind: langgraph) matches the minimal kernel node-for-node', async (t) => {
  if (!lgAvailable) {
    t.skip(SKIP_REASON)
    return
  }
  const plan = makePlan([planNode('n1'), planNode('n2'), planNode('n3')], [['n1', 'n2'], ['n2', 'n3']])
  const minimalLog: string[] = []
  const langgraphLog: string[] = []

  const minimal = await runPlan(plan, [recordingExecutor(minimalLog)], { kind: 'minimal' })
  const langgraph = await runPlan(plan, [recordingExecutor(langgraphLog)], { kind: 'langgraph' })

  assert.equal(langgraph.status, 'completed')
  assert.equal(langgraph.steps, minimal.steps)
  assert.deepEqual(langgraphLog, minimalLog)
  assert.deepEqual(
    langgraph.state.journal.map((entry) => entry.nodeId),
    minimal.state.journal.map((entry) => entry.nodeId),
  )
})

test('langgraph: zero-dep kernel walks a plan topology with no-op nodes', async (t) => {
  if (!lgAvailable) {
    t.skip(SKIP_REASON)
    return
  }
  const plan = makePlan([planNode('n1'), planNode('n2')], [['n1', 'n2']])
  const run = createKernel('langgraph').compile(plan, planInitialState(plan))
  assert.equal((await run.next()).kind, 'boundary')
  assert.equal((await run.next()).kind, 'boundary')
  assert.equal((await run.next()).kind, 'done')
  await run.dispose()
})
