/**
 * Stage-exit generality regression tests.
 *
 * The contract these cases encode:
 *
 *   - every non-terminal stage of a generated plan (dynamic synthesis,
 *     model-authored proposal, or the scheduler's recovery graphs) owns a
 *     state-driven failure exit to a declared terminal;
 *   - a stage that fails therefore answers in at most one step (`replans=0`)
 *     instead of walking its unconditional success edge to the step cap or
 *     ending the turn as GRAPH_FAILED.
 *
 * Every case runs the real driver on all three engines, like
 * `stage-routing-regression.test.ts`. No model, no Docker: the outcome stream
 * is synthetic.
 *
 * Run: node --import tsx --test test/unit/stage-exit-generality.test.ts
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'

import type { RegistryGraph, TaskPlan } from '../../packages/core/src/graph-schema.ts'
import type { TaskFingerprint } from '../../packages/core/src/matching.ts'
import { recoveryTopology, repairTopology, synthesizeTopology } from '../../packages/core/src/topology.ts'
import { validateProposal } from '../../packages/core/src/proposal.ts'
import { buildRegistrySnapshot, type RegistrySources, type ToolSource } from '../../packages/core/src/registry.ts'
import { available } from '../../packages/loop/src/kernel/index.ts'
import { createGraphTurnDriver, type GraphTurnDriver } from '../../packages/loop/src/scheduler.ts'

type Engine = 'frontier' | 'minimal' | 'langgraph'

const ENGINES: readonly Engine[] = ['frontier', 'minimal', 'langgraph']

const langgraphAvailable = await available()
const LANGGRAPH_SKIP = langgraphAvailable
  ? undefined
  : '@langchain/langgraph is not installed (or no longer satisfies the kernel surface); language-graph rows skipped'

function engineTest(name: string, engine: Engine, fn: () => Promise<void>): void {
  test(name, { skip: engine === 'langgraph' && !langgraphAvailable ? LANGGRAPH_SKIP : undefined }, fn)
}

function kernelOption(engine: Engine): 'off' | 'minimal' | 'langgraph' {
  return engine === 'frontier' ? 'off' : engine
}

function graphOf(sources: RegistrySources): RegistryGraph {
  return buildRegistrySnapshot(sources).graph
}

function fingerprint(overrides: Partial<TaskFingerprint> = {}): TaskFingerprint {
  return {
    hash: '0123456789abcdef',
    intent: 'other',
    artifactsIn: [],
    artifactsOut: [],
    mutating: false,
    parallelizable: false,
    risk: 'low',
    contextBucket: 0,
    surface: 'web',
    hints: [],
    workspace: { hasGit: true, hasPackageJson: true, hasTests: true, hasPython: false, languages: ['ts'] },
    textLength: 20,
    ...overrides,
  }
}

const CORE_TOOLS: ToolSource[] = [
  { name: 'read' },
  { name: 'glob' },
  { name: 'grep' },
  { name: 'write' },
  { name: 'edit' },
  { name: 'bash' },
  { name: 'present' },
]

const graph = graphOf({ tools: CORE_TOOLS })
const presetTools = CORE_TOOLS.map(tool => tool.name)

function driverFor(engine: Engine, plan: TaskPlan): GraphTurnDriver {
  const driver = createGraphTurnDriver({ kernel: kernelOption(engine), graphProvider: () => graph })
  driver.adopt(plan)
  return driver
}

function trace(driver: GraphTurnDriver): string {
  return driver.snapshot().trail.map(row => `${row.id}:${row.status}`).join(',')
}

/**
 * Fail the plan's first stage, then require the plan's own terminal to be the
 * next node: a state-driven failure edge was taken, no boundary replan ran, and
 * answering the terminal finishes the turn.
 */
async function failStageToTerminal(engine: Engine, plan: TaskPlan, terminal: string): Promise<void> {
  const driver = driverFor(engine, plan)
  assert.notEqual(driver.current()?.id, terminal, `[${engine}] the stage to fail must not already be the terminal`)
  assert.notEqual(driver.current(), undefined, `[${engine}] plan entry missing`)

  await driver.advance({ ok: false })

  assert.equal(driver.current()?.id, terminal,
    `[${engine}] a failed stage must take its state-driven exit to ${terminal}; trace=${trace(driver)} status=${driver.status?.()}`)
  assert.equal(driver.snapshot().replans, 0,
    `[${engine}] the plan's own exit must fire, not a boundary replan; trace=${trace(driver)}`)
  assert.equal(driver.snapshot().status, 'running', `[${engine}] the run continues to answer; trace=${trace(driver)}`)
  assert.ok(driver.snapshot().step <= 2,
    `[${engine}] the terminal must be reachable within two steps, got ${driver.snapshot().step}`)

  await driver.advance({ ok: true })
  assert.equal(driver.planState(), 'terminal', `[${engine}] answering the terminal must complete the turn`)
  assert.equal(driver.status?.(), 'done', `[${engine}] the answered turn is done; trace=${trace(driver)}`)
}

// ---------------------------------------------------------------------------
// 1. Dynamic synthesis: every stage answers on failure
// ---------------------------------------------------------------------------

for (const engine of ENGINES) {
  engineTest(`a failed dynamic stage reaches the synthesized terminal [${engine}]`, engine, async () => {
    const { plan } = synthesizeTopology({
      taskHash: 'dynamic-stage-exit',
      fingerprint: fingerprint({ intent: 'code-change', mutating: true }),
      graph,
      presetTools,
    })
    assert.deepEqual(plan.terminals, ['d_answer'])
    // d_read is the first non-terminal stage of the mutating plan.
    assert.equal(plan.entry, 'd_read', `[${engine}] fixture must start at the optional inspect stage`)
    await failStageToTerminal(engine, plan, 'd_answer')
  })
}

// ---------------------------------------------------------------------------
// 2. Model-authored proposal: the model's terminal is the failure exit
// ---------------------------------------------------------------------------

for (const engine of ENGINES) {
  engineTest(`a failed model-authored stage reaches the model terminal [${engine}]`, engine, async () => {
    const proposed = validateProposal({
      entry: 'n1',
      nodes: [
        { id: 'n1', tool: 'read', instruction: 'read the file' },
        { id: 'n2', kind: 'terminal', instruction: 'answer' },
      ],
      edges: [{ from: 'n1', to: 'n2' }],
    }, graph, presetTools)
    assert.equal(proposed.ok, true, proposed.errors.join('; '))
    assert.ok(proposed.plan)
    await failStageToTerminal(engine, proposed.plan, 'n2')
  })
}

// ---------------------------------------------------------------------------
// 3. Recovery graphs: a failed escalation stage answers, never GRAPH_FAILED
// ---------------------------------------------------------------------------

for (const engine of ENGINES) {
  engineTest(`a failed recovery node answers [${engine}]`, engine, async () => {
    const repair = repairTopology({
      taskHash: 'stage-exit-repair',
      failedNode: 'd_verify',
      failedTool: 'bash',
      budget: { maxSteps: 8 },
    })
    // Repair has an unconditional r_diagnose -> r_edit success edge; a failed
    // diagnosis must still reach r_answer instead of ending the run.
    await failStageToTerminal(engine, repair, 'r_answer')

    const recovery = recoveryTopology({
      taskHash: 'stage-exit-recovery',
      failedNode: 'd_read',
      budget: { maxSteps: 8 },
    })
    assert.deepEqual(recovery.terminals, ['r_answer'])
    await failStageToTerminal(engine, recovery, 'r_answer')
  })
}
