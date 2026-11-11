/**
 * Turn-boundary contract tests for the graph loop: every started turn gets
 * exactly one `turn/end`, a failed plan ends the turn as `GRAPH_FAILED`, and a
 * plan that merely finishes keeps the turn open.
 *
 * Two harnesses are used:
 *  - a driver double pins the turn body's durable event order at the edges;
 *  - a real `createGraphTurnDriver` plus the real `ReactLoopAgent.turn()` body
 *    (with the model call stubbed) pins plan-state-versus-turn-state behavior:
 *    a finished plan runs stock steps with no graph node, a reached terminal
 *    ends the turn with no step after it.
 *
 * Run: node --import tsx --test test/unit/loop-turn.test.ts
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'

import type { TaskPlan } from '../../packages/core/src/graph-schema.ts'
import type { GraphTurnDriver, GraphTurnSnapshot } from '../../packages/loop/src/scheduler.ts'
import { createGraphTurnDriver } from '../../packages/loop/src/scheduler.ts'
import { ReactLoopAgent } from '../../packages/loop/src/loop/agent.ts'

interface RecordedEvent {
  readonly type: string
  readonly data: Record<string, unknown>
}

interface EmittedEvent {
  readonly name: string
  readonly payload: Record<string, unknown>
}

interface Harness {
  readonly agent: ReactLoopAgent
  readonly events: RecordedEvent[]
  readonly emitted: EmittedEvent[]
  readonly logs: string[]
}

/** Structural snapshot stub; turn() reads `node` and the boundary plan state. */
function snapshotStub(node?: string, planState = 'running'): GraphTurnSnapshot {
  return { node, planState } as unknown as GraphTurnSnapshot
}

/** A driver double that only implements what the exercised path reads. */
function driverStub(overrides: Partial<Record<keyof GraphTurnDriver, unknown>>): GraphTurnDriver {
  const driver: Record<string, unknown> = {
    beginTurn: async () => snapshotStub(),
    current: () => undefined,
    instruction: () => undefined,
    advance: async () => snapshotStub(),
    adopt: () => undefined,
    takeSubagentBatch: () => [],
    completeNode: async () => undefined,
    planState: () => 'running',
    planFinished: () => false,
    terminalReached: () => false,
    endTurn: () => undefined,
    snapshot: () => snapshotStub(),
    ...overrides,
  }
  return driver as unknown as GraphTurnDriver
}

/** Bind the real turn() body to fake loop state. */
function harness(driver: GraphTurnDriver, subagents?: unknown): Harness {
  const events: RecordedEvent[] = []
  const emitted: EmittedEvent[] = []
  const logs: string[] = []
  const agent = Object.create(ReactLoopAgent.prototype) as ReactLoopAgent
  Object.assign(agent, {
    phase: { kind: 'running', abort: new AbortController(), turn: 0, step: 0, wakeRequested: false },
    session: {
      id: 'session:test',
      append(type: string, data: Record<string, unknown>): { seq: number } {
        events.push({ type, data })
        return { seq: events.length }
      },
    },
    turnGraph: driver,
    dispatch: {
      emit(name: string, payload: Record<string, unknown>): void {
        emitted.push({ name, payload })
      },
      serial: async () => undefined,
      waterfall: async () => undefined,
    },
    inbox: {
      hasPending: false,
      nextTurn: [],
      nextStep: [],
      claim: () => [],
      splice: () => undefined,
      clear: () => undefined,
    },
    ctx: {
      logger: {
        warn(message: string): void {
          logs.push(message)
        },
      },
      on: () => () => undefined,
    },
    loopCtx: {
      get: (name: string) => name === 'subagents' ? subagents : undefined,
    },
  })
  return { agent, events, emitted, logs }
}

function callTurn(agent: ReactLoopAgent): Promise<boolean> {
  return (agent as unknown as { turn(): Promise<boolean> }).turn()
}

// ---------------------------------------------------------------------------
// Turn-body edges, with a driver double
// ---------------------------------------------------------------------------

test('a throwing beginTurn still closes the turn it opened exactly once', async () => {
  let ended = 0
  const driver = driverStub({
    beginTurn: async () => { throw new Error('graph start exploded') },
    endTurn: () => { ended += 1 },
  })
  const h = harness(driver)

  await assert.rejects(callTurn(h.agent), /graph start exploded/)

  assert.deepEqual(h.events.map(event => event.type), ['turn/start', 'turn/end'])
  const reason = h.events[1]?.data.reason as { kind: string; error?: { code: string } }
  assert.equal(reason.kind, 'error')
  assert.equal(reason.error?.code, 'UNKNOWN')
  assert.equal(h.emitted.filter(event => event.name === 'agent/error').length, 1)
  assert.equal(ended, 1, 'a half-initialized driver is still flushed exactly once')
})

test('a failed plan fails the turn with GRAPH_FAILED', async () => {
  const driver = driverStub({
    planState: () => 'failed',
    status: () => 'failed',
    snapshot: () => snapshotStub('n_verify', 'failed'),
  })
  const h = harness(driver)

  await assert.rejects(callTurn(h.agent), /graph run ended in "failed" status at node "n_verify"/)

  assert.deepEqual(h.events.map(event => event.type), ['turn/start', 'turn/end'])
  const reason = h.events[1]?.data.reason as { kind: string; error: { message: string; code: string } }
  assert.equal(reason.kind, 'error')
  assert.equal(reason.error.code, 'GRAPH_FAILED')
  assert.match(reason.error.message, /n_verify/)
  const errors = h.emitted.filter(event => event.name === 'agent/error')
  assert.equal(errors.length, 1, 'the failure is reported to the live boundary once')
})

test('a terminal plan closes the turn as completed without a step', async () => {
  const driver = driverStub({ planState: () => 'terminal', status: () => 'done' })
  const h = harness(driver)

  assert.equal(await callTurn(h.agent), false)
  assert.deepEqual(h.events.map(event => event.type), ['turn/start', 'turn/end'])
  assert.deepEqual(h.events[1]?.data.reason, { kind: 'completed' })
  assert.equal(h.emitted.filter(event => event.name === 'agent/error').length, 0)
})

test('a finished plan runs a stock step before the turn ends (double)', async () => {
  // `finished` is not a turn end: the loop must take one more step, and only a
  // step that completed (no tool calls left to run) ends the turn.
  const ends: ({ readonly kind: 'completed' | 'max-tokens' } | null)[] = [{ kind: 'completed' }]
  const driver = driverStub({
    planState: () => 'finished',
    status: () => 'done',
    advance: async () => snapshotStub(),
  })
  const h = harness(driver)
  let steps = 0
  Object.assign(h.agent, {
    // Mid-turn boundary: the empty-initial-turn rule does not apply.
    phase: { kind: 'running', abort: new AbortController(), turn: 0, step: 1, wakeRequested: false },
    preStep: async () => ({ kind: 'enter', messages: [], toolSet: { dispose: () => undefined } }),
    step: async () => {
      steps += 1
      return ends.shift() ?? null
    },
  })

  assert.equal(await callTurn(h.agent), false)
  assert.equal(steps, 1, 'the finished plan still gets a stock step')
  assert.deepEqual(h.events.map(event => event.type), ['turn/start', 'step/start', 'step/end', 'turn/end'])
  assert.deepEqual(h.events[3]?.data.reason, { kind: 'completed' })
})

test('a failed subagent is logged with its node id and completed as failed', async () => {
  const completed: { id: string; ok: boolean }[] = []
  let failed = false
  const node = { id: 's1', executor: 'subagent', instruction: 'do the first half' }
  const driver = driverStub({
    current: () => node,
    takeSubagentBatch: () => [node],
    completeNode: async (id: string, ok: boolean) => {
      completed.push({ id, ok })
      failed = !ok
    },
    planState: () => failed ? 'failed' : 'running',
    planFinished: () => failed,
    status: () => failed ? 'failed' : 'running',
    snapshot: () => snapshotStub('s1'),
  })
  const h = harness(driver, {
    startActivation: async () => { throw new Error('child crashed') },
  })

  await assert.rejects(callTurn(h.agent), /graph run ended in "failed" status/)

  assert.deepEqual(completed, [{ id: 's1', ok: false }], 'failure reaches the scheduler path instead of being swallowed')
  assert.ok(h.logs.some(line => line.includes('s1') && line.includes('child crashed')), h.logs.join('\n'))
  const reason = h.events[1]?.data.reason as { kind: string; error: { code: string } }
  assert.equal(reason.kind, 'error')
  assert.equal(reason.error.code, 'GRAPH_FAILED')
})

// ---------------------------------------------------------------------------
// Real driver + real turn() body: plan state is not turn state
// ---------------------------------------------------------------------------

type Engine = 'off' | 'minimal' | 'langgraph'
const ENGINES: readonly Engine[] = ['off', 'minimal', 'langgraph']

interface StepScript {
  readonly tools: readonly { readonly name: string; readonly isError: boolean }[]
  /** What the model step returns: `null` = tool calls executed, else the step end. */
  readonly end: { readonly kind: 'completed' | 'max-tokens' } | null
}

function budget(maxSteps = 8): TaskPlan['budget'] {
  return { maxNodes: 4, maxSteps, maxTokens: 10_000, maxWallMs: 60_000, maxReplans: 0 }
}

function node(id: string, terminal = false): TaskPlan['nodes'][number] {
  return { id, kind: terminal ? 'terminal' : 'agent-step', executor: 'step', instruction: `run ${id}` }
}

function drillPlan(overrides: Partial<TaskPlan> & Pick<TaskPlan, 'id' | 'entry' | 'terminals' | 'nodes' | 'edges'>): TaskPlan {
  return {
    templateId: 'drill',
    version: 1,
    budget: budget(),
    toolUniverse: [],
    gatePolicy: 'cold',
    fallback: false,
    confidence: 1,
    compiledDigest: overrides.id,
    ...overrides,
  } as TaskPlan
}

/** A drained plan: the only out-edge is guarded on a fact that is never true. */
function drainedPlan(): TaskPlan {
  return drillPlan({
    id: 'drill:drained',
    entry: 'n_work',
    terminals: ['n_answer'],
    nodes: [node('n_work'), node('n_answer', true)],
    edges: [{ from: 'n_work', to: 'n_answer', kind: 'control', when: { op: 'fact', key: 'never', equals: true } }],
  })
}

/** A plan whose declared terminal runs after one work step. */
function terminalPlan(): TaskPlan {
  return drillPlan({
    id: 'drill:terminal',
    entry: 'n_work',
    terminals: ['n_answer'],
    nodes: [node('n_work'), node('n_answer', true)],
    edges: [{ from: 'n_work', to: 'n_answer', kind: 'control' }],
  })
}

/**
 * A real driver driven by the real turn body. `beginTurn` is narrowed to
 * install the drill plan deterministically; every other driver call is real.
 */
function graphHarness(plan: TaskPlan, engine: Engine, scripts: StepScript[]): Harness {
  const events: RecordedEvent[] = []
  const emitted: EmittedEvent[] = []
  const listeners: ((session: unknown, event: { type: string; data: Record<string, unknown> }) => void)[] = []
  const driver = createGraphTurnDriver({ kernel: engine === 'off' ? 'off' : engine })
  const turnGraph: GraphTurnDriver = {
    ...driver,
    beginTurn: async () => {
      driver.adopt(plan)
      return driver.snapshot()
    },
  }
  const session = {
    id: 'session:test',
    append(type: string, data: Record<string, unknown>, options?: Record<string, unknown>): { seq: number } {
      const seq = events.length + 1
      const event = { type, data, seq, time: seq, ...options }
      events.push(event)
      // A real Session notifies `session/event` listeners on every commit, which
      // is how the turn body projects the step's tool calls.
      for (const listener of listeners) listener(session, event)
      return { seq }
    },
  }
  let stepIndex = 0
  const agent = Object.create(ReactLoopAgent.prototype) as ReactLoopAgent
  Object.assign(agent, {
    phase: { kind: 'running', abort: new AbortController(), turn: 0, step: 0, wakeRequested: false },
    session,
    shellTools: new Set(['bash']),
    turnGraph,
    dispatch: {
      emit(name: string, payload: Record<string, unknown>): void {
        emitted.push({ name, payload })
      },
      serial: async () => undefined,
      // The real pre-step default decision; no middleware in this harness.
      waterfall: async (_name: string, _payload: unknown, fallback: () => Promise<unknown>) => await fallback(),
    },
    inbox: {
      hasPending: false,
      nextTurn: [],
      nextStep: [],
      claim: () => [],
      splice: () => undefined,
      clear: () => undefined,
    },
    ctx: {
      logger: { warn: () => undefined },
      on: (name: string, listener: (session: unknown, event: { type: string; data: Record<string, unknown> }) => void) => {
        if (name !== 'session/event') return () => undefined
        listeners.push(listener)
        return () => {
          const index = listeners.indexOf(listener)
          if (index >= 0) listeners.splice(index, 1)
        }
      },
    },
    loopCtx: {
      get: () => undefined,
      tools: { resolve: async () => ({ dispose: () => undefined }) },
      systemPrompt: { assemble: async () => ({ contexts: [], variables: {} }) },
    },
    model: { current: () => ({ provider: 'test', model: 'test' }) },
    runtimeContext: { project: () => undefined },
    // The model call is the only stubbed seam: the step reports the tool calls it
    // made and the reason it ended, exactly like the real step's contract.
    step: async (decision: { messages: readonly { content: unknown }[] }) => {
      for (const message of decision.messages) {
        session.append('user/message', { content: message.content })
      }
      const script = scripts[stepIndex] ?? { tools: [], end: { kind: 'completed' } }
      stepIndex += 1
      for (const [index, tool] of script.tools.entries()) {
        const callId = `call-${stepIndex}-${index}`
        const position = { turn: 1, step: stepIndex }
        session.append('tool/call', { callId, name: tool.name, ...position }, { surfaceOp: 'append' })
        session.append('tool/result', {
          message: { toolCallId: callId, source: { callId }, isError: tool.isError, content: [] },
          ...position,
        }, { surfaceOp: 'append' })
      }
      return script.end
    },
  })
  return { agent, events, emitted, logs: [] }
}

function count(events: readonly RecordedEvent[], type: string): number {
  return events.filter(event => event.type === type).length
}

function textOf(events: readonly RecordedEvent[]): string {
  return JSON.stringify(events)
}

test('(b) a finished plan keeps the turn open: the next steps run with no graph node', async () => {
  const plan = drainedPlan()
  const h = graphHarness(plan, 'off', [
    { tools: [{ name: 'bash', isError: false }], end: null },   // n_work: tool call drains the plan
    { tools: [{ name: 'bash', isError: false }], end: null },   // stock step, no node
    { tools: [], end: { kind: 'completed' } },                  // stock step, no tool calls -> turn ends
  ])

  assert.equal(await callTurn(h.agent), false)

  assert.equal(count(h.events, 'step/start'), 3, 'the finished plan does not end the turn')
  assert.equal(count(h.events, 'turn/end'), 1, 'exactly one turn end')
  assert.deepEqual(h.events.find(event => event.type === 'turn/end')?.data.reason, { kind: 'completed' })
  const directives = h.events.filter(event => event.type === 'user/message' && JSON.stringify(event.data).includes('[graph node'))
  assert.equal(directives.length, 1, 'only the plan node step gets a graph directive')
  assert.ok(JSON.stringify(directives[0]?.data).includes('[graph node n_work]'))
  assert.ok(!textOf(h.events).includes('continue:'), 'no synthetic continuation node id reaches the log')
  assert.ok(!textOf(h.events).includes('current plan is exhausted'), 'no continuation instruction is injected')
  assert.equal(h.emitted.filter(event => event.name === 'agent/error').length, 0)
})

test('(c) a reached terminal ends the turn exactly once, with no step after it', async () => {
  for (const engine of ENGINES) {
    const h = graphHarness(terminalPlan(), engine, [
      { tools: [{ name: 'bash', isError: false }], end: null },  // n_work
      { tools: [{ name: 'bash', isError: false }], end: null },  // terminal gathers evidence
      { tools: [], end: { kind: 'completed' } },                 // must never run
    ])

    assert.equal(await callTurn(h.agent), false, `engine=${engine}`)

    assert.equal(count(h.events, 'step/start'), 2, `engine=${engine}: no step after the terminal`)
    assert.equal(count(h.events, 'turn/end'), 1, `engine=${engine}: exactly one turn end`)
    assert.deepEqual(h.events.find(event => event.type === 'turn/end')?.data.reason, { kind: 'completed' }, `engine=${engine}`)
    assert.ok(!textOf(h.events).includes('continue:'), `engine=${engine}: no continuation plan`)
    assert.ok(!textOf(h.events).includes('current plan is exhausted'), `engine=${engine}`)
    const directives = h.events.filter(event => event.type === 'user/message' && JSON.stringify(event.data).includes('[graph node'))
    assert.deepEqual(
      directives.map(event => JSON.stringify(event.data).match(/\[graph node ([^\]]+)\]/)?.[1]),
      ['n_work', 'n_answer'],
      `engine=${engine}`,
    )
  }
})

test('(d) a failed plan ends the turn once with GRAPH_FAILED', async () => {
  for (const engine of ENGINES) {
    const h = graphHarness(drillPlan({
      id: 'drill:failed',
      entry: 'n_work',
      terminals: ['n_answer'],
      nodes: [node('n_work'), node('n_answer', true)],
      edges: [{ from: 'n_work', to: 'n_answer', kind: 'control', when: { op: 'callFailed', tool: 'other' } }],
    }), engine, [
      { tools: [{ name: 'bash', isError: true }], end: null },
    ])

    await assert.rejects(callTurn(h.agent), /graph run ended in "failed" status/, `engine=${engine}`)

    assert.equal(count(h.events, 'step/start'), 1, `engine=${engine}`)
    assert.equal(count(h.events, 'turn/end'), 1, `engine=${engine}: exactly one turn end`)
    const reason = h.events.find(event => event.type === 'turn/end')?.data.reason as { kind: string; error: { code: string } }
    assert.equal(reason.kind, 'error', `engine=${engine}`)
    assert.equal(reason.error.code, 'GRAPH_FAILED', `engine=${engine}`)
    assert.equal(h.emitted.filter(event => event.name === 'agent/error').length, 1, `engine=${engine}`)
  }
})
