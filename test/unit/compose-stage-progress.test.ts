/**
 * A composed stage advances only on its own artifact/verifier evidence.
 *
 * Acceptance drill for audit 20261111-1200 F1-F4. The composed plan is the real
 * `synthesizeComposition` output for a code-change task, driven through the real
 * per-turn driver on every engine; the outcome stream is synthetic (no model,
 * no Docker).
 *
 * The contract these rows pin:
 *
 *   - a step that called a tool but left no artifact of the node's declared type
 *     cannot satisfy the stage, even when the tool call succeeded (inspect and
 *     mutate negatives; on the parent commit both advanced);
 *   - a mutation attributed to a task file satisfies the mutate stage (positive);
 *   - a verifier that ran something unrelated to the artifact the run produced
 *     cannot satisfy verify (negative; on the parent commit it answered), while
 *     the declared verifier observing that artifact with a clean exit does
 *     (positive);
 *   - a no-tool step still repairs (the evidence gate must not be a step counter
 *     or a strictness regression).
 *
 * Run: node --import tsx --test test/unit/compose-stage-progress.test.ts
 */

import assert from 'node:assert/strict'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import { synthesizeComposition } from '../../packages/core/src/compose.ts'
import { buildEnvelope, defaultRole, type CapabilityRoleSpec } from '../../packages/core/src/envelope.ts'
import type { RegistryGraph } from '../../packages/core/src/graph-schema.ts'
import { validateTaskPlan } from '../../packages/core/src/graph-schema.ts'
import type { TaskFingerprint } from '../../packages/core/src/matching.ts'
import { buildRegistrySnapshot, type RegistrySources, type ToolSource } from '../../packages/core/src/registry.ts'
import { available } from '../../packages/loop/src/kernel/index.ts'
import { createGraphTurnDriver } from '../../packages/loop/src/scheduler.ts'

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

interface StepOutcome {
  readonly ok: boolean
  readonly failedTool?: string
  readonly tools?: readonly {
    readonly name: string
    readonly isError: boolean
    readonly arguments?: string
    readonly output?: string
  }[]
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

function role(name: string): CapabilityRoleSpec {
  const found = defaultRole(name)
  assert.ok(found, `default role ${name} must exist`)
  return found
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

/** The composed code-change plan: n_inspect -> n_mutate -> n_verify -> n_answer. */
function coreComposition(maxSteps = 8): { graph: RegistryGraph; plan: ReturnType<typeof synthesizeComposition>['plan'] } {
  const graph = graphOf({ tools: CORE_TOOLS })
  const envelope = buildEnvelope({
    roles: [role('workspace-read'), role('workspace-write'), role('shell'), role('verification')],
  }, graph)
  assert.equal(envelope.fallbackToStock, false)
  const result = synthesizeComposition({
    fingerprint: fingerprint({ intent: 'code-change', mutating: true }),
    graph,
    envelope: envelope.envelope,
    budget: { maxSteps },
  })
  assert.deepEqual(result.stages.map(stage => stage.stage), ['inspect', 'mutate', 'verify'])
  return { graph, plan: result.plan }
}

function driverFor(engine: Engine, graph: RegistryGraph, plan: ReturnType<typeof coreComposition>['plan']): ReturnType<typeof createGraphTurnDriver> {
  const driver = createGraphTurnDriver({ kernel: kernelOption(engine), graphProvider: () => graph })
  driver.adopt(plan)
  return driver
}

/** A plain `read` call: the inspect stage's declared capability, nothing else. */
const read: StepOutcome = { ok: true, tools: [{ name: 'read', isError: false }] }

const inDir = (name: string): string => join(tmpdir(), name)

function bash(command: string, output?: string): StepOutcome {
  return {
    ok: true,
    tools: [{ name: 'bash', isError: false, arguments: JSON.stringify({ command }), ...(output === undefined ? {} : { output }) }],
  }
}

function write(filePath: string): StepOutcome {
  return { ok: true, tools: [{ name: 'write', isError: false, arguments: JSON.stringify({ file_path: filePath }) }] }
}

// ---------------------------------------------------------------------------
// 0. Every composed stage declares its evidence contract (F2)
// ---------------------------------------------------------------------------

test('every composed stage node declares the evidence contract it is gated on', () => {
  const { graph, plan } = coreComposition()
  // F2: the contract is plan data, not a composer-local table re-derived at
  // runtime, and the plan carrying it validates.
  const validation = validateTaskPlan(graph, plan)
  assert.equal(validation.ok, true, validation.errors.map(error => `${error.code} ${error.path}`).join('; '))
  const stageIds = ['n_inspect', 'n_inspect_repair', 'n_mutate', 'n_mutate_repair', 'n_verify', 'n_verify_repair']
  for (const id of stageIds) {
    const node = plan.nodes.find(candidate => candidate.id === id)
    assert.ok(node, `${id} must exist`)
    assert.ok(node.evidence !== undefined, `${id} must declare an evidence contract`)
  }
  // The verify contract is a verifier clause, not an artifact-type list.
  assert.deepEqual(plan.nodes.find(node => node.id === 'n_verify')?.evidence, { verifier: true })
  // The mutate contract is derived from the capability's declared output type.
  const mutate = plan.nodes.find(node => node.id === 'n_mutate')
  assert.deepEqual(mutate?.evidence?.expects?.map(spec => spec.type), ['file.text'])
})

// ---------------------------------------------------------------------------
// 1. Inspect: a successful unrelated tool call is not inspection
// ---------------------------------------------------------------------------

for (const engine of ENGINES) {
  engineTest(`an unrelated successful call cannot satisfy inspect [${engine}]`, engine, async () => {
    const { graph, plan } = coreComposition()
    const driver = driverFor(engine, graph, plan)

    assert.equal(driver.current()?.id, 'n_inspect')
    // `ls -la` is a successful tool call, but it left no artifact of the
    // declared inspect type and was not the declared capability's call.
    await driver.advance(bash('ls -la'))
    assert.equal(driver.current()?.id, 'n_inspect_repair',
      `engine=${engine}: a successful unrelated call must not advance inspect`)

    // The false-negative guard: the declared capability's own successful call
    // does satisfy the inspect stage.
    await driver.advance(read)
    assert.equal(driver.current()?.id, 'n_mutate',
      `engine=${engine}: the declared reader's own successful call advances inspect`)

    driver.endTurn()
  })
}

// ---------------------------------------------------------------------------
// 2. Mutate: a shell write to a scratch path is not a task-artifact change
// ---------------------------------------------------------------------------

for (const engine of ENGINES) {
  engineTest(`an unattributed shell write cannot satisfy mutate [${engine}]`, engine, async () => {
    const { graph, plan } = coreComposition()
    const driver = driverFor(engine, graph, plan)

    await driver.advance(read)
    assert.equal(driver.current()?.id, 'n_mutate', `engine=${engine}`)

    // A `printf x > scratch.txt` shell redirect writes a file, but the step's
    // mutation is not attributable to any artifact of the stage's declared type.
    await driver.advance(bash(`printf x > ${inDir('scratch.txt')}`))
    assert.equal(driver.current()?.id, 'n_mutate_repair',
      `engine=${engine}: a shell write with no attributed artifact must not advance mutate`)

    driver.endTurn()
  })
}

// ---------------------------------------------------------------------------
// 3. Mutate positive: a writer's path artifact satisfies the stage
// ---------------------------------------------------------------------------

for (const engine of ENGINES) {
  engineTest(`a writer's path artifact satisfies mutate [${engine}]`, engine, async () => {
    const { graph, plan } = coreComposition()
    const driver = driverFor(engine, graph, plan)

    await driver.advance(read)
    assert.equal(driver.current()?.id, 'n_mutate', `engine=${engine}`)

    await driver.advance(write(inDir('out.txt')))
    assert.equal(driver.current()?.id, 'n_verify',
      `engine=${engine}: a mutation attributed to a declared artifact type advances mutate`)

    driver.endTurn()
  })
}

// ---------------------------------------------------------------------------
// 4. Verify: a verifier that observed nothing the run produced is not verification
// ---------------------------------------------------------------------------

for (const engine of ENGINES) {
  engineTest(`a verifier unrelated to the produced artifact cannot satisfy verify [${engine}]`, engine, async () => {
    const { graph, plan } = coreComposition()
    const driver = driverFor(engine, graph, plan)

    await driver.advance(read)
    await driver.advance(write(inDir('out.txt')))
    assert.equal(driver.current()?.id, 'n_verify', `engine=${engine}`)

    // The declared verifier ran and succeeded, but it observed nothing this run
    // produced and reported no exit status: activity, not verification.
    await driver.advance(bash('find /root/.cache'))
    assert.equal(driver.current()?.id, 'n_verify_repair',
      `engine=${engine}: an unrelated verifier call must not advance verify`)

    driver.endTurn()
  })
}

// ---------------------------------------------------------------------------
// 5. Verify positive: the declared verifier observes the artifact with a clean exit
// ---------------------------------------------------------------------------

for (const engine of ENGINES) {
  engineTest(`a verifier observing the produced artifact with a clean exit satisfies verify [${engine}]`, engine, async () => {
    const { graph, plan } = coreComposition()
    const driver = driverFor(engine, graph, plan)

    await driver.advance(read)
    await driver.advance(write(inDir('out.txt')))
    assert.equal(driver.current()?.id, 'n_verify', `engine=${engine}`)

    await driver.advance(bash(`test -s ${inDir('out.txt')}`, '[exit code: 0]'))
    assert.equal(driver.current()?.id, 'n_answer',
      `engine=${engine}: a verifier that observed the produced artifact and exited 0 advances verify`)

    driver.endTurn()
  })
}

// ---------------------------------------------------------------------------
// 6. A no-tool step still repairs (gate is evidence, not a step counter)
// ---------------------------------------------------------------------------

for (const engine of ENGINES) {
  engineTest(`a no-tool step repairs [${engine}]`, engine, async () => {
    const { graph, plan } = coreComposition()
    const driver = driverFor(engine, graph, plan)

    await driver.advance({ ok: true })
    assert.equal(driver.current()?.id, 'n_inspect_repair',
      `engine=${engine}: a step with no tool call has no evidence and must repair`)

    driver.endTurn()
  })
}
