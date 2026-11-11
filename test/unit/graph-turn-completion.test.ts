/**
 * R3 drills — plan completion and turn completion are separate states.
 *
 * The driver no longer answers "is the turn over?" (`done()`), and a plan that
 * drains while the model is still acting is not a failed run and is not
 * extended with a synthetic continuation node. Each drill drives the real
 * `createGraphTurnDriver` on every engine and asserts the plan state at the
 * boundary, the plan identity and the absence of the removed substitute.
 *
 * Turn-level behavior (one `turn/end`, no step after a terminal) is drilled on
 * the real `ReactLoopAgent.turn()` body in `loop-turn.test.ts`.
 *
 * Run: node --import tsx --test test/unit/graph-turn-completion.test.ts
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'

import type { TaskPlan } from '../../packages/core/src/graph-schema.ts'
import { createGraphTurnDriver, type GraphTurnDriver } from '../../packages/loop/src/scheduler.ts'

const ENGINES = ['off', 'minimal', 'langgraph'] as const
type Engine = typeof ENGINES[number]

function driverFor(engine: Engine, maxSteps = 8): GraphTurnDriver {
  return createGraphTurnDriver({
    kernel: engine === 'off' ? 'off' : engine,
    maxSteps,
  })
}

function budget(maxSteps = 8): TaskPlan['budget'] {
  return { maxNodes: 4, maxSteps, maxTokens: 10_000, maxWallMs: 60_000, maxReplans: 0 }
}

function node(id: string, instruction = id): TaskPlan['nodes'][number] {
  return {
    id,
    kind: id.startsWith('n_answer') ? 'terminal' : 'agent-step',
    executor: 'step',
    instruction,
  }
}

function plan(overrides: Partial<TaskPlan> & Pick<TaskPlan, 'id' | 'entry' | 'terminals' | 'nodes' | 'edges'>): TaskPlan {
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

/**
 * A plan whose enabled set drains without a terminal: `n_work`'s only out-edge
 * is guarded on a fact that is never true, so a successful step leaves no node
 * and no declared terminal ran.
 */
function drainedPlan(): TaskPlan {
  return plan({
    id: 'drill:drained',
    entry: 'n_work',
    terminals: ['n_answer'],
    nodes: [node('n_work'), node('n_answer')],
    edges: [{ from: 'n_work', to: 'n_answer', kind: 'control', when: { op: 'fact', key: 'never', equals: true } }],
  })
}

/** A plan that ends at its declared terminal after one more step. */
function terminalPlan(): TaskPlan {
  return plan({
    id: 'drill:terminal',
    entry: 'n_work',
    terminals: ['n_answer'],
    nodes: [node('n_work'), node('n_answer')],
    edges: [{ from: 'n_work', to: 'n_answer', kind: 'control' }],
  })
}

/** The shipped `t_stock` shape: one node that is both entry and terminal. */
function stockPlan(): TaskPlan {
  return plan({
    id: 'drill:stock',
    templateId: 't_stock',
    entry: 'n_respond',
    terminals: ['n_respond'],
    nodes: [node('n_respond')],
    edges: [],
    budget: budget(4),
  })
}

function toolCall(name = 'bash') {
  return { name, isError: false }
}

test('(a) a drained plan settles finished, with no continuation plan installed', async () => {
  for (const engine of ENGINES) {
    const driver = driverFor(engine)
    const original = drainedPlan()
    driver.adopt(original)
    assert.equal(driver.planState(), 'running', `engine=${engine}`)

    const after = await driver.advance({ ok: true, tools: [toolCall()] })

    assert.equal(after.planState, 'finished', `engine=${engine}: ${after.rationale.join('; ')}`)
    assert.equal(driver.planState(), 'finished', `engine=${engine}`)
    assert.equal(driver.planFinished(), true, `engine=${engine}`)
    assert.equal(driver.terminalReached(), false, `engine=${engine}: no terminal ran`)
    assert.equal(after.planId, original.id, `engine=${engine}: the plan identity must not change`)
    assert.equal(after.templateId, original.templateId, `engine=${engine}`)
    assert.equal(after.plan.id, original.id, `engine=${engine}`)
    assert.ok(!after.planId.includes(':continue:'), `engine=${engine}: no synthetic continuation id`)
    assert.ok(!after.rationale.some(line => line.includes('continuation')),
      `engine=${engine}: operator rationale must not mention a continuation: ${after.rationale.join('; ')}`)
    assert.equal(driver.current(), undefined, `engine=${engine}: a finished plan has no node to run`)
    assert.equal(driver.instruction(), undefined, `engine=${engine}: a finished plan injects no instruction`)
    assert.equal(after.trail.length, 1, `engine=${engine}`)
    driver.endTurn()
  }
})

test('(b) the plan stays finished across further tool-calling boundaries', async () => {
  for (const engine of ENGINES) {
    const driver = driverFor(engine)
    driver.adopt(drainedPlan())
    await driver.advance({ ok: true, tools: [toolCall()] })
    assert.equal(driver.planState(), 'finished', `engine=${engine}`)

    // The frontier settles a drained plan on advance; a further boundary with no
    // node to run must not resurrect work, fail the plan or install anything.
    const again = await driver.advance({ ok: true, tools: [toolCall()] })
    assert.equal(again.planState, 'finished', `engine=${engine}`)
    assert.equal(driver.planState(), 'finished', `engine=${engine}`)
    assert.equal(driver.snapshot().planId, 'drill:drained', `engine=${engine}`)
    // No node ran, so no second trail row is invented; the plan is untouched.
    assert.equal(driver.snapshot().trail.length, 1, `engine=${engine}`)
    driver.endTurn()
  }
})

test('(c) a reached terminal is the plan endpoint, on every engine', async () => {
  for (const engine of ENGINES) {
    const driver = driverFor(engine)
    const original = terminalPlan()
    driver.adopt(original)
    await driver.advance({ ok: true, tools: [toolCall()] })
    assert.equal(driver.planState(), 'running', `engine=${engine}: the terminal node still has to run`)
    assert.equal(driver.current()?.id, 'n_answer', `engine=${engine}`)

    // The terminal's own step may gather evidence (it calls a tool); it is still
    // the last step, and the plan settles `terminal` instead of draining.
    const after = await driver.advance({ ok: true, tools: [toolCall()] })
    assert.equal(after.planState, 'terminal', `engine=${engine}: ${after.rationale.join('; ')}`)
    assert.equal(driver.terminalReached(), true, `engine=${engine}`)
    assert.equal(driver.planFinished(), true, `engine=${engine}`)
    assert.equal(after.planId, original.id, `engine=${engine}: the plan identity must not change`)
    assert.ok(!after.planId.includes(':continue:'), `engine=${engine}`)
    assert.equal(driver.current(), undefined, `engine=${engine}`)
    driver.endTurn()
  }
})

test('(c) the shipped t_stock single-node plan settles terminal after one tool-calling step', async () => {
  // `node:respond` is not a kernel-drivable node id, so the driver keeps the
  // frontier; this is the shape a trivial/fallback turn actually installs.
  const driver = createGraphTurnDriver({ kernel: 'off' })
  driver.adopt(stockPlan())
  assert.equal(driver.current()?.id, 'n_respond')
  const after = await driver.advance({ ok: true, tools: [toolCall()] })
  assert.equal(after.planState, 'terminal')
  assert.equal(after.templateId, 't_stock')
  assert.ok(!after.rationale.some(line => line.includes('continuation')))
  driver.endTurn()
})

test('(d) a failed plan stays failed, on every engine', async () => {
  for (const engine of ENGINES) {
    const driver = driverFor(engine)
    driver.adopt(terminalPlan())
    await driver.advance({ ok: false, failedTool: 'bash' })
    assert.equal(driver.planState(), 'failed', `engine=${engine}`)
    assert.equal(driver.planFinished(), true, `engine=${engine}`)
    assert.notEqual(driver.status?.(), 'done', `engine=${engine}`)
    driver.endTurn()
  }
})

test('(d) a failed step that takes its guarded recovery edge keeps the plan running', async () => {
  // `failed` is a plan that has no recovery path, not the first bad step: a
  // `callFailed` edge to a repair node keeps the run going on every engine.
  const withRecovery = plan({
    id: 'drill:recovery',
    entry: 'n_work',
    terminals: ['n_answer'],
    nodes: [node('n_work'), node('n_repair'), node('n_answer')],
    edges: [
      { from: 'n_work', to: 'n_repair', kind: 'control', when: { op: 'callFailed', tool: 'bash' } },
      { from: 'n_repair', to: 'n_answer', kind: 'control' },
    ],
  })
  for (const engine of ENGINES) {
    const driver = driverFor(engine)
    driver.adopt(withRecovery)
    await driver.advance({ ok: false, failedTool: 'bash' })
    assert.equal(driver.planState(), 'running', `engine=${engine}`)
    assert.equal(driver.current()?.id, 'n_repair', `engine=${engine}`)
    driver.endTurn()
  }
})
