/**
 * Resume drill: a turn that ends mid-plan must resume at the pending node
 * instead of re-running the nodes it already completed.
 *
 * The drill goes through the real `createGraphTurnDriver` and the real
 * `ReactLoopAgent.turn()` body. Each completed node boundary closes a real
 * `step/end` in a real session log and records the folded graph state as a
 * `plugin:` record; the next turn folds that prefix and hands the plan + state
 * back to `beginTurn`. The resumed segment must execute `n_done` only, keep the
 * pinned plan identity (`t_investigate@g0`) and never replay `n_discover` or
 * `n_inspect`.
 *
 * Run: node --import tsx --test test/unit/driver-resume.test.ts
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'

import { Session, SessionId, pluginRecordOf } from '@deepseek-ai/dsh-session'

import type { GraphState, TaskPlan } from '../../packages/core/src/graph-schema.ts'
import { buildRegistrySnapshot, type ToolSource } from '../../packages/core/src/registry.ts'
import { TEMPLATE_LIBRARY } from '../../packages/core/src/templates.ts'
import { ReactLoopAgent } from '../../packages/loop/src/loop/agent.ts'
import type { GraphTurnDriver, GraphTurnSnapshot } from '../../packages/loop/src/scheduler.ts'
import { createGraphTurnDriver } from '../../packages/loop/src/scheduler.ts'
import { KernelTopology } from '../../packages/loop/src/kernel/topology.ts'
import { planInitialState, type PlanCheckpointer } from '../../packages/loop/src/kernel/plan.ts'
import {
  GRAPH_CHECKPOINT_RECORD,
  appendGraphCheckpoint,
  foldGraphCheckpoint,
  parseGraphCheckpoint,
  type GraphCheckpointRecord,
} from '../../packages/loop/src/graph-state-log.ts'

/** Same tool surface as the scheduler tests: it routes the task to `t_investigate`. */
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

const TASK = 'explain how the config loader works'
/** Answer text: alone it re-derives `t_stock`/`node:respond`, so the seed must pin the plan. */
const CONTINUATION = 'the loader lives in src/config.ts, go on'

function driverOptions() {
  return { graphProvider: () => registry.graph, templatesProvider: () => TEMPLATE_LIBRARY } as const
}

function session(label: string): Session {
  return Session.create(SessionId(`session:${label}`))
}

/** Close a step the way the agent does: the durable `step/end` precedes `advance()`. */
function closeStep(log: Session, turn: number, step: number): number {
  return log.append('step/end', { turn, step }).seq
}

/** Record the folded boundary the way the agent does: after `advance()` folded the node. */
function recordBoundary(log: Session, driver: GraphTurnDriver, atSeq: number): void {
  const state = driver.stateSnapshot?.()
  assert.ok(state !== undefined, 'the kernel topology exposes a folded state')
  appendGraphCheckpoint(log, driver.snapshot().plan, state, atSeq)
}

function checkpointRecords(log: Session): GraphCheckpointRecord[] {
  const records: GraphCheckpointRecord[] = []
  for (const event of log.snapshotEvents()) {
    const record = pluginRecordOf(event)
    if (record?.type !== GRAPH_CHECKPOINT_RECORD) continue
    const parsed = parseGraphCheckpoint(record.data)
    assert.ok(parsed !== undefined, 'every committed record keeps the validated payload shape')
    records.push(parsed)
  }
  return records
}

for (const kernel of ['langgraph', 'minimal'] as const) {
  test(`a folded log keeps the plan and resumes at its pending node (${kernel})`, async () => {
    const log = session(`resume-drill-${kernel}`)
    const paused = createGraphTurnDriver({ ...driverOptions(), kernel })
    const started = await paused.beginTurn({ text: TASK })
    assert.equal(started.planId, 't_investigate@g0')
    assert.equal(paused.current()?.id, 'n_discover')

    const discoverSeq = closeStep(log, 1, 1)
    await paused.advance({ ok: true, atSeq: discoverSeq })
    recordBoundary(log, paused, discoverSeq)
    assert.equal(paused.current()?.id, 'n_inspect')
    const inspectSeq = closeStep(log, 1, 2)
    await paused.advance({ ok: true, atSeq: inspectSeq })
    recordBoundary(log, paused, inspectSeq)
    assert.equal(paused.current()?.id, 'n_done')
    // The turn ends while the run is still paused mid-plan.
    paused.endTurn()

    const folded = foldGraphCheckpoint(log)
    assert.ok(folded !== undefined, 'two completed nodes fold into a resumable state')
    assert.equal(folded.plan.id, 't_investigate@g0', 'the record pins the plan identity')
    assert.equal(folded.state.next, 'n_done')

    // The continuation text alone re-derives a different stock plan. A drill
    // that resumed from text would run `node:respond`; the seed is what keeps
    // the paused plan, so this assertion proves the drill cannot pass by
    // abandoning it.
    const unseeded = createGraphTurnDriver({ ...driverOptions(), kernel })
    await unseeded.beginTurn({ text: CONTINUATION })
    assert.equal(unseeded.current()?.id, 'node:respond')

    const resumed = createGraphTurnDriver({ ...driverOptions(), kernel })
    const reopened = await resumed.beginTurn({ text: CONTINUATION }, folded)
    assert.equal(reopened.planId, 't_investigate@g0', 'the resumed turn keeps the paused plan')
    assert.equal(resumed.current()?.id, 'n_done', 'the resumed turn starts at the pending node')
    assert.deepEqual(resumed.snapshot().visited, [], 'no completed node is replayed into the new run')

    const doneSeq = closeStep(log, 2, 1)
    await resumed.advance({ ok: true, atSeq: doneSeq })
    recordBoundary(log, resumed, doneSeq)
    assert.deepEqual(resumed.snapshot().visited, ['n_done'], 'the resumed segment runs the pending node only')
    assert.equal(resumed.done(), true)
    resumed.endTurn()

    // A finished run is the previous turn's result, not a run to continue.
    assert.equal(foldGraphCheckpoint(log), undefined, 'a completed run is not resumed')
  })
}

test('a resume seed never replaces a plan the driver cannot resume', async () => {
  const paused = createGraphTurnDriver(driverOptions())
  await paused.beginTurn({ text: TASK })
  await paused.advance({ ok: true })
  const state = paused.stateSnapshot?.()
  assert.ok(state !== undefined)
  const seed = { plan: paused.snapshot().plan, state }

  // A subagent child is always the single-node fallback; it must not inherit a
  // parent-shaped plan through a forked log prefix.
  const child = createGraphTurnDriver({ ...driverOptions(), forceFallback: true })
  const childStart = await child.beginTurn({ text: CONTINUATION }, seed)
  assert.equal(childStart.fallback, true)
  assert.equal(child.current()?.id, 'node:respond')

  // The frontier topology owns no resumable state, so the seed is refused
  // instead of silently replaying the completed nodes.
  const frontier = createGraphTurnDriver({ ...driverOptions(), kernel: 'off' })
  const frontierStart = await frontier.beginTurn({ text: TASK }, seed)
  assert.equal(frontierStart.planId, 't_investigate@g0')
  assert.equal(frontier.current()?.id, 'n_discover')
})

/**
 * A three-node linear plan used to pin the kernel-level seam without a session:
 * the folded state names `n_done` as the pending node.
 */
function linearPlan(): TaskPlan {
  return {
    id: 'resume-kernel-plan',
    templateId: 'test',
    version: 1,
    entry: 'n_discover',
    terminals: ['n_done'],
    nodes: [
      { id: 'n_discover', kind: 'agent-step', executor: 'step', instruction: 'discover' },
      { id: 'n_inspect', kind: 'agent-step', executor: 'step', instruction: 'inspect' },
      { id: 'n_done', kind: 'terminal', executor: 'step', instruction: 'answer', toolAllow: [] },
    ],
    edges: [
      { from: 'n_discover', to: 'n_inspect', kind: 'control' },
      { from: 'n_inspect', to: 'n_done', kind: 'control' },
    ],
    budget: { maxNodes: 3, maxSteps: 4, maxTokens: 10_000, maxWallMs: 60_000, maxReplans: 0 },
    toolUniverse: [],
    gatePolicy: 'cold',
    fallback: false,
    confidence: 1,
    compiledDigest: 'resume-kernel-plan',
  }
}

/** The kernel's runtime saver, observed: it must be read back at the boundary. */
class RecordingCheckpointer implements PlanCheckpointer {
  private readonly rows = new Map<string, Map<number, GraphState>>()
  readonly loads: { readonly sessionId: string; readonly atSeq: number }[] = []

  async load(sessionId: string, atSeq: number): Promise<GraphState | undefined> {
    this.loads.push({ sessionId, atSeq })
    return this.rows.get(sessionId)?.get(atSeq)
  }

  async put(sessionId: string, atSeq: number, state: GraphState): Promise<void> {
    const rows = this.rows.get(sessionId) ?? new Map<number, GraphState>()
    rows.set(atSeq, state)
    this.rows.set(sessionId, rows)
  }
}

test('the kernel enters at the folded state next node and journals the session seq', async () => {
  const plan = linearPlan()
  const saver = new RecordingCheckpointer()
  const seed: GraphState = {
    ...planInitialState(plan, 'task'),
    superstep: 2,
    next: 'n_done',
    journal: [
      { nodeId: 'n_discover', superstep: 1, outcome: 'ok', atSeq: 4 },
      { nodeId: 'n_inspect', superstep: 2, outcome: 'ok', atSeq: 7 },
    ],
  }
  const topology = new KernelTopology(plan, { kind: 'minimal', state: seed, checkpointer: saver })
  assert.equal(topology.current()?.id, 'n_done', 'a folded state enters at its pending node')
  assert.equal(topology.steps(), 2, 'the resumed run keeps the completed supersteps')

  await topology.advance({ ok: true, atSeq: 11 })
  assert.equal(topology.done(), true)
  assert.deepEqual(saver.loads, [{ sessionId: plan.id, atSeq: 11 }], 'the boundary row is read back from the runtime saver')
  const boundary = topology.stateSnapshot().journal.at(-1)
  assert.equal(boundary?.nodeId, 'n_done')
  assert.equal(boundary?.atSeq, 11, 'the journal records the step/end seq, not the superstep')
})

test('a completed seed starts a new run instead of replaying the plan', async () => {
  const plan = linearPlan()
  const completed: GraphState = { ...planInitialState(plan, 'task'), next: 'n_done', status: 'done' }
  const topology = new KernelTopology(plan, { kind: 'minimal', state: completed, checkpointer: new RecordingCheckpointer() })
  assert.equal(topology.current()?.id, 'n_discover', 'a finished state is not a resume point')
  assert.equal(topology.steps(), 0)
})

/* ========================================================================== *
 * Agent turn wiring: the fold happens at turn start and every completed node
 * records its folded state beside the `step/end` it closed.
 * ========================================================================== */

interface TurnHarness {
  readonly agent: ReactLoopAgent
  /** Replace the waking input the way a real wake would before the next turn. */
  nextTurn(text: string): void
}

/** The structural user message `inboxText()` reads. */
function incoming(text: string): unknown {
  return { content: [{ type: 'text', text }] }
}

/** Bind the real `turn()` body to a real session and a real graph driver. */
function turnHarness(driver: GraphTurnDriver, log: Session, text: string): TurnHarness {
  const inbox = {
    hasPending: false,
    nextTurn: [incoming(text)],
    nextStep: [] as unknown[],
    claim: (): unknown[] => [],
    splice: (): void => undefined,
    clear: (): void => undefined,
  }
  const agent = Object.create(ReactLoopAgent.prototype) as ReactLoopAgent
  Object.assign(agent, {
    id: 'agent:resume-test',
    phase: { kind: 'running', abort: new AbortController(), turn: 0, step: 0, wakeRequested: false },
    session: log,
    turnGraph: driver,
    dispatch: {
      emit(): void {},
      serial: async (): Promise<void> => undefined,
      waterfall: async (): Promise<undefined> => undefined,
    },
    inbox,
    ctx: {
      logger: { warn(): void {}, info(): void {} },
      on: (): (() => undefined) => () => undefined,
    },
    loopCtx: { get: (): undefined => undefined },
  })
  return {
    agent,
    nextTurn(next: string): void {
      inbox.nextTurn = [incoming(next)]
    },
  }
}

/** The minimal admission shape `turn()` passes to the (stubbed) step. */
function enterDecision(): unknown {
  return {
    kind: 'enter',
    messages: [{ type: 'user-message' }],
    assembly: {},
    selection: { provider: 'mock', model: 'mock' },
    toolSet: { dispose(): void {} },
  }
}

function callTurn(agent: ReactLoopAgent): Promise<boolean> {
  return (agent as unknown as { turn(): Promise<boolean> }).turn()
}

test('the agent folds the log at turn start and records each completed node', async () => {
  const log = session('agent-resume')
  const snapshots: GraphTurnSnapshot[] = []
  const driver = createGraphTurnDriver({
    ...driverOptions(),
    onSnapshot: snapshot => snapshots.push(snapshot),
  })
  const { agent, nextTurn } = turnHarness(driver, log, TASK)
  let calls = 0
  const nodesSeen: (string | undefined)[] = []
  Object.assign(agent, {
    preStep: async () => {
      calls += 1
      // After two completed nodes the turn ends with the graph still paused.
      if (calls === 3) return { kind: 'reject' }
      nodesSeen.push(driver.current()?.id)
      return enterDecision()
    },
    step: async () => ({ kind: 'completed' }),
  })

  assert.equal(await callTurn(agent), false, 'the blocked turn ends without waking another')
  assert.deepEqual(nodesSeen, ['n_discover', 'n_inspect'])
  const paused = snapshots.at(-1)
  assert.ok(paused !== undefined)
  assert.equal(paused.planId, 't_investigate@g0')
  assert.deepEqual(paused.visited, ['n_discover', 'n_inspect'])
  assert.equal(paused.status, 'running', 'the turn ended with the graph still paused')
  assert.equal(paused.node, 'n_done')

  const records = checkpointRecords(log)
  const stepEndSeqs = log.snapshotEvents().filter(event => event.type === 'step/end').map(event => event.seq)
  assert.equal(records.length, 2, 'one durable record per completed node')
  assert.deepEqual(records.map(record => record.atSeq), stepEndSeqs, 'each record names the step/end seq that closed its node')
  assert.equal(records[1]?.plan.id, 't_investigate@g0')
  assert.equal(records[1]?.state.next, 'n_done')

  calls = 0
  nodesSeen.length = 0
  nextTurn(CONTINUATION)
  assert.equal(await callTurn(agent), false, 'the resumed turn completes and ends')
  assert.deepEqual(nodesSeen, ['n_done'], 'the resumed turn starts at the pending node')
  const finished = snapshots.at(-1)
  assert.ok(finished !== undefined)
  assert.equal(finished.planId, 't_investigate@g0', 'the second turn kept the pinned plan')
  assert.deepEqual(finished.visited, ['n_done'], 'no completed node re-ran')
  assert.equal(finished.status, 'done')
  assert.equal(checkpointRecords(log).length, 3, 'the final node also records its boundary')
})
