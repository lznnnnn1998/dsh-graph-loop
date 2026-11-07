/**
 * Turn-boundary contract tests for the graph loop: every started turn gets
 * exactly one `turn/end`, and a failed graph run ends the turn as an error.
 *
 * The tests drive the real `ReactLoopAgent.turn()` body on a harness rather
 * than standing up Cordis: `turn()` only touches a handful of members, so an
 * object inheriting the prototype with fake session/dispatch/driver is enough
 * to pin the durable event order.
 *
 * Run: node --import tsx --test test/unit/loop-turn.test.ts
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { GraphTurnDriver, GraphTurnSnapshot } from '../../packages/loop/src/scheduler.ts'
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

/** Structural snapshot stub; turn() only reads `node`. */
function snapshotStub(node?: string): GraphTurnSnapshot {
  return { node } as unknown as GraphTurnSnapshot
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
    done: () => false,
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

test('a graph that ended failed fails the turn with GRAPH_FAILED', async () => {
  const driver = driverStub({
    done: () => true,
    status: () => 'failed',
    snapshot: () => snapshotStub('n_verify'),
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

test('a graph that ended done still closes the turn as completed', async () => {
  const driver = driverStub({ done: () => true, status: () => 'done' })
  const h = harness(driver)

  assert.equal(await callTurn(h.agent), false)
  assert.deepEqual(h.events.map(event => event.type), ['turn/start', 'turn/end'])
  assert.deepEqual(h.events[1]?.data.reason, { kind: 'completed' })
  assert.equal(h.emitted.filter(event => event.name === 'agent/error').length, 0)
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
    done: () => failed,
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
