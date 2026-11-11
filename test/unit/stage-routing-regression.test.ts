/**
 * Stage-routing regression tests for the stage -> repair routing contract.
 *
 * The contract these cases encode:
 *
 *   - a repair step that performs the stage's work advances to the next stage;
 *     a repair that does not perform it exits to the tool-enabled answer;
 *   - `wroteFile` counts real shell mutations (`printf x > out.txt`), and does
 *     not count a mere `->` inside a Python argument;
 *   - `read_image` is a read, never a write;
 *   - `toolSucceeded` is the generic "some call was answered" classifier;
 *   - a stage that keeps failing at the cap reaches `n_answer`, not GRAPH_FAILED.
 *
 * Every case runs on all three engines, like `transition-matrix.test.ts`.
 * No model, no Docker: the outcome stream is synthetic.
 *
 * Run: node --import tsx --test test/unit/stage-routing-regression.test.ts
 */

import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test, type TestContext } from 'node:test'

import { synthesizeComposition } from '../../packages/core/src/compose.ts'
import { buildEnvelope, defaultRole, type CapabilityRoleSpec } from '../../packages/core/src/envelope.ts'
import type { RegistryGraph } from '../../packages/core/src/graph-schema.ts'
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

function engineTest(name: string, engine: Engine, fn: (t: TestContext) => Promise<void>): void {
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

/** A scratch directory per row, removed when the row ends. */
function workdir(t: TestContext): string {
  const dir = mkdtempSync(join(tmpdir(), 'stage-routing-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  return dir
}

function makeFile(dir: string, name: string): string {
  const path = join(dir, name)
  writeFileSync(path, 'observed content\n', 'utf8')
  return path
}

/** The declared reader's own call on a real file: the inspect stage's evidence. */
function read(filePath: string): StepOutcome {
  return { ok: true, tools: [{ name: 'read', isError: false, arguments: JSON.stringify({ file_path: filePath }) }] }
}

function bash(command: string): StepOutcome {
  return { ok: true, tools: [{ name: 'bash', isError: false, arguments: JSON.stringify({ command }) }] }
}

function write(filePath: string): StepOutcome {
  return { ok: true, tools: [{ name: 'write', isError: false, arguments: JSON.stringify({ file_path: filePath }) }] }
}

// ---------------------------------------------------------------------------
// 1. A repair step that performs the stage's work advances to the next stage
// ---------------------------------------------------------------------------

for (const engine of ENGINES) {
  engineTest(`repair work advances the stage instead of restarting it [${engine}]`, engine, async (t) => {
    const input = makeFile(workdir(t), 'input.txt')
    const { graph, plan } = coreComposition()
    const driver = driverFor(engine, graph, plan)

    assert.equal(driver.current()?.id, 'n_inspect')
    // A failing inspect step gets exactly one repair attempt.
    await driver.advance({ ok: false })
    assert.equal(driver.current()?.id, 'n_inspect_repair', `engine=${engine}`)

    // The repair step does the stage's work (a measured read). It must
    // advance to n_mutate; returning to n_inspect is the audit's dead end.
    await driver.advance(read(input))
    assert.equal(driver.current()?.id, 'n_mutate',
      `engine=${engine}: a successful repair read must advance, not restart inspect`)

    driver.endTurn()
  })
}

// ---------------------------------------------------------------------------
// 2. A mutation advances only with an artifact attributed to the stage
// ---------------------------------------------------------------------------

for (const engine of ENGINES) {
  engineTest(`a shell mutation still has to be attributed to a task artifact [${engine}]`, engine, async (t) => {
    const dir = workdir(t)
    const input = makeFile(dir, 'input.txt')
    const { graph, plan } = coreComposition()
    const driver = driverFor(engine, graph, plan)

    await driver.advance(read(input))
    assert.equal(driver.current()?.id, 'n_mutate', `engine=${engine}`)

    // `printf x > out.txt` is a real file write, but the stage cannot attribute
    // it to any artifact of its declared contract, so it is activity, not the
    // stage's evidence (audit 20261111-1200 F3).
    await driver.advance(bash('printf x > out.txt'))
    assert.equal(driver.current()?.id, 'n_mutate_repair',
      `engine=${engine}: an unattributed shell write must not advance mutate`)

    // The writer's path artifact is the stage's evidence when it exists.
    const out = makeFile(dir, 'out.txt')
    await driver.advance(write(out))
    assert.equal(driver.current()?.id, 'n_verify',
      `engine=${engine}: an attributed write advances mutate`)

    driver.endTurn()
  })
}

// ---------------------------------------------------------------------------
// 3. `->` inside a Python argument is not a mutation; a real write repairs
// ---------------------------------------------------------------------------

for (const engine of ENGINES) {
  engineTest(`a Python -> is not a mutation, and a real write repairs [${engine}]`, engine, async (t) => {
    const dir = workdir(t)
    const input = makeFile(dir, 'input.txt')
    const { graph, plan } = coreComposition()
    const driver = driverFor(engine, graph, plan)

    await driver.advance(read(input))
    assert.equal(driver.current()?.id, 'n_mutate', `engine=${engine}`)

    // `->` is not a shell redirect. The stage made no write, so it repairs.
    await driver.advance(bash('python3 -c "print(\'a->b\')"'))
    assert.equal(driver.current()?.id, 'n_mutate_repair',
      `engine=${engine}: an arrow inside an argument is not a redirect`)

    // The repair step performs the actual mutation; it advances to verify.
    const out = makeFile(dir, 'out.ts')
    await driver.advance(write(out))
    assert.equal(driver.current()?.id, 'n_verify',
      `engine=${engine}: a successful repair write must advance, not restart mutate`)

    driver.endTurn()
  })
}

// ---------------------------------------------------------------------------
// 4. A stage that keeps failing reaches the answer, not GRAPH_FAILED
// ---------------------------------------------------------------------------

for (const engine of ENGINES) {
  engineTest(`a stage that keeps failing reaches the answer at the cap [${engine}]`, engine, async () => {
    const { graph, plan } = coreComposition(6)
    const driver = driverFor(engine, graph, plan)

    // Fail every step until the driver either answers or runs out. The budget
    // edge is evaluated first, so a stage that never succeeds still reaches
    // the tool-enabled answer instead of cycling to a kernel failure.
    let guard = 0
    while (driver.current() !== undefined && driver.current()?.id !== 'n_answer' && guard < 12) {
      await driver.advance({ ok: false })
      guard += 1
    }

    assert.equal(driver.current()?.id, 'n_answer',
      `engine=${engine}: repeated stage failures must reach n_answer, not GRAPH_FAILED`)
    assert.notEqual(driver.status?.(), 'failed',
      `engine=${engine}: classifier exhaustion is an answer, not a failed turn`)

    // The answer is a normal agent step: completing it ends the turn.
    await driver.advance({ ok: true })
    assert.equal(driver.planState(), 'terminal', `engine=${engine}: the answer must complete the turn`)
    assert.equal(driver.status?.(), 'done', `engine=${engine}: the answered turn is done`)

    driver.endTurn()
  })
}

// ---------------------------------------------------------------------------
// 5. read_image is a read, never a write; a no-op repair answers
// ---------------------------------------------------------------------------

for (const engine of ENGINES) {
  engineTest(`read_image in mutate repairs, and a no-op repair answers [${engine}]`, engine, async (t) => {
    const input = makeFile(workdir(t), 'input.txt')
    const { graph, plan } = coreComposition()
    const driver = driverFor(engine, graph, plan)

    await driver.advance(read(input))
    assert.equal(driver.current()?.id, 'n_mutate', `engine=${engine}`)

    // read_image is a read tool: it satisfies inspect, never mutate.
    await driver.advance({ ok: true, tools: [{ name: 'read_image', isError: false }] })
    assert.equal(driver.current()?.id, 'n_mutate_repair',
      `engine=${engine}: read_image must not satisfy wroteFile`)

    // A repair that performs no work must go to the answer, not back to the
    // stage: the repair node has no repair -> stage edge in the fix.
    await driver.advance({ ok: true })
    assert.equal(driver.current()?.id, 'n_answer',
      `engine=${engine}: a no-op repair must answer, not restart the stage`)

    driver.endTurn()
  })
}
