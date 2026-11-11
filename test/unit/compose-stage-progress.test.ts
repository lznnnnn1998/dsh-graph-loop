/**
 * A composed stage advances only on its own artifact/verifier evidence.
 *
 * Acceptance drill for audit 20261111-1200 F1-F4 and audit 20261111-1600 F1-F4:
 * a stage is satisfied by a *runtime-observed* artifact and, for verify, by the
 * node's declared verifier addressing that artifact through a typed locator
 * argument -- never by command text that merely names the path. The composed
 * plan is the real `synthesizeComposition` output, driven through the real
 * per-turn driver on every engine; the outcome stream is synthetic (no model,
 * no Docker), but every positive file is really created and every negative file
 * is really absent/removed, so the runtime's measurement is exercised.
 *
 * Run: node --import tsx --test test/unit/compose-stage-progress.test.ts
 */

import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test, type TestContext } from 'node:test'

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

/** A scratch directory per row, removed when the row ends. */
function workdir(t: TestContext): string {
  const dir = mkdtempSync(join(tmpdir(), 'compose-evidence-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  return dir
}

/** Create a real, non-empty file: the runtime measures artifacts in the world. */
function makeFile(dir: string, name: string, body = 'produced by the step under test\n'): string {
  const path = join(dir, name)
  writeFileSync(path, body, 'utf8')
  return path
}

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

/**
 * A composition whose verify stage can only be filled by a typed-locator
 * capability: the annotation declares `read_image` as this envelope's
 * verification capability. This is the false-negative guard -- the same
 * locator-addressed verifier call was accepted on the parent commit (by text)
 * and must still be accepted once attribution is structural.
 */
function locatorComposition(): { graph: RegistryGraph; plan: ReturnType<typeof synthesizeComposition>['plan'] } {
  const graph = graphOf({
    tools: [
      { name: 'read_image', tags: ['verification', 'filesystem', 'vision'] },
      { name: 'write' },
      { name: 'edit' },
    ],
  })
  const envelope = buildEnvelope({
    roles: [role('workspace-read'), role('workspace-write'), role('verification')],
  }, graph)
  assert.equal(envelope.fallbackToStock, false)
  const result = synthesizeComposition({
    fingerprint: fingerprint({ intent: 'code-change', mutating: true }),
    graph,
    envelope: envelope.envelope,
    budget: { maxSteps: 8 },
  })
  assert.deepEqual(result.stages.map(stage => stage.stage), ['inspect', 'mutate', 'verify'])
  return { graph, plan: result.plan }
}

function driverFor(engine: Engine, graph: RegistryGraph, plan: ReturnType<typeof coreComposition>['plan']): ReturnType<typeof createGraphTurnDriver> {
  const driver = createGraphTurnDriver({ kernel: kernelOption(engine), graphProvider: () => graph })
  driver.adopt(plan)
  return driver
}

/** The declared reader's own call on a real file: the inspect stage's evidence. */
function read(filePath: string): StepOutcome {
  return {
    ok: true,
    tools: [{ name: 'read', isError: false, arguments: JSON.stringify({ file_path: filePath }) }],
  }
}

function bash(command: string, output?: string): StepOutcome {
  return {
    ok: true,
    tools: [{ name: 'bash', isError: false, arguments: JSON.stringify({ command }), ...(output === undefined ? {} : { output }) }],
  }
}

function write(filePath: string): StepOutcome {
  return { ok: true, tools: [{ name: 'write', isError: false, arguments: JSON.stringify({ file_path: filePath }) }] }
}

function readImage(filePath: string): StepOutcome {
  return { ok: true, tools: [{ name: 'read_image', isError: false, arguments: JSON.stringify({ file_path: filePath }) }] }
}

// ---------------------------------------------------------------------------
// 0. Every composed stage declares its evidence contract, and verify is structural
// ---------------------------------------------------------------------------

test('every composed stage node declares the evidence contract it is gated on', () => {
  const { graph, plan } = coreComposition()
  const validation = validateTaskPlan(graph, plan)
  assert.equal(validation.ok, true, validation.errors.map(error => `${error.code} ${error.path}`).join('; '))
  const stageIds = ['n_inspect', 'n_inspect_repair', 'n_mutate', 'n_mutate_repair', 'n_verify', 'n_verify_repair']
  for (const id of stageIds) {
    const node = plan.nodes.find(candidate => candidate.id === id)
    assert.ok(node, `${id} must exist`)
    assert.ok(node.evidence !== undefined, `${id} must declare an evidence contract`)
  }
  assert.deepEqual(plan.nodes.find(node => node.id === 'n_verify')?.evidence, { verifier: true })
  const mutate = plan.nodes.find(node => node.id === 'n_mutate')
  assert.deepEqual(mutate?.evidence?.expects?.map(spec => spec.type), ['file.text'])
  // F4: the verify stage binds a capability that can address an artifact
  // through a declared locator parameter. A shell (free-text `command`) cannot.
  const verify = plan.nodes.find(node => node.id === 'n_verify')
  const capability = graph.nodes.find(node => node.id === verify?.capabilityId)
  assert.ok(
    (capability?.tool?.parameterNames ?? []).includes('file_path'),
    `verify capability ${String(capability?.tool?.name)} must declare a typed locator parameter`,
  )
})

// ---------------------------------------------------------------------------
// 1. Inspect: a successful unrelated call is not inspection; a measured read is
// ---------------------------------------------------------------------------

for (const engine of ENGINES) {
  engineTest(`an unrelated successful call cannot satisfy inspect [${engine}]`, engine, async (t) => {
    const dir = workdir(t)
    const input = makeFile(dir, 'input.txt')
    const { graph, plan } = coreComposition()
    const driver = driverFor(engine, graph, plan)

    assert.equal(driver.current()?.id, 'n_inspect')
    await driver.advance(bash('ls -la'))
    assert.equal(driver.current()?.id, 'n_inspect_repair',
      `engine=${engine}: a successful unrelated call must not advance inspect`)

    // The declared reader's own successful call on an existing file does.
    await driver.advance(read(input))
    assert.equal(driver.current()?.id, 'n_mutate',
      `engine=${engine}: the declared reader's measured read advances inspect`)

    driver.endTurn()
  })
}

// ---------------------------------------------------------------------------
// 2. Mutate: a declared path the world never saw is not an artifact
// ---------------------------------------------------------------------------

for (const engine of ENGINES) {
  engineTest(`a phantom write path cannot satisfy mutate [${engine}]`, engine, async (t) => {
    const dir = workdir(t)
    const input = makeFile(dir, 'input.txt')
    const { graph, plan } = coreComposition()
    const driver = driverFor(engine, graph, plan)

    await driver.advance(read(input))
    assert.equal(driver.current()?.id, 'n_mutate', `engine=${engine}`)

    // The `write` call succeeded but the path was never created: success is not
    // a world change, so the step has no artifact and must repair.
    const phantom = join(dir, 'phantom.txt')
    await driver.advance(write(phantom))
    assert.equal(existsSync(phantom), false, 'the drill must not create the phantom path')
    assert.equal(driver.current()?.id, 'n_mutate_repair',
      `engine=${engine}: a success credited to a path that does not exist must not advance mutate`)

    driver.endTurn()
  })
}

for (const engine of ENGINES) {
  engineTest(`an unattributed shell write cannot satisfy mutate [${engine}]`, engine, async (t) => {
    const dir = workdir(t)
    const input = makeFile(dir, 'input.txt')
    const { graph, plan } = coreComposition()
    const driver = driverFor(engine, graph, plan)

    await driver.advance(read(input))
    assert.equal(driver.current()?.id, 'n_mutate', `engine=${engine}`)

    await driver.advance(bash(`printf x > ${join(dir, 'scratch.txt')}`))
    assert.equal(driver.current()?.id, 'n_mutate_repair',
      `engine=${engine}: a shell write with no attributed artifact must not advance mutate`)

    driver.endTurn()
  })
}

// ---------------------------------------------------------------------------
// 3. Mutate positive: a writer's path artifact exists and satisfies the stage
// ---------------------------------------------------------------------------

for (const engine of ENGINES) {
  engineTest(`a writer's observed path artifact satisfies mutate [${engine}]`, engine, async (t) => {
    const dir = workdir(t)
    const input = makeFile(dir, 'input.txt')
    const { graph, plan } = coreComposition()
    const driver = driverFor(engine, graph, plan)

    await driver.advance(read(input))
    assert.equal(driver.current()?.id, 'n_mutate', `engine=${engine}`)

    const out = makeFile(dir, 'out.txt')
    await driver.advance(write(out))
    assert.equal(existsSync(out), true, 'the positive row must leave a real file behind')
    assert.equal(driver.current()?.id, 'n_verify',
      `engine=${engine}: an observed mutation of a declared artifact type advances mutate`)

    driver.endTurn()
  })
}

// ---------------------------------------------------------------------------
// 4. Verify: naming the artifact in command text is not verification
// ---------------------------------------------------------------------------

for (const engine of ENGINES) {
  engineTest(`echo naming the produced artifact cannot satisfy verify [${engine}]`, engine, async (t) => {
    const dir = workdir(t)
    const input = makeFile(dir, 'input.txt')
    const { graph, plan } = coreComposition()
    const driver = driverFor(engine, graph, plan)

    await driver.advance(read(input))
    const out = makeFile(dir, 'out.txt')
    await driver.advance(write(out))
    assert.equal(driver.current()?.id, 'n_verify', `engine=${engine}`)

    // The command text contains the ref and exits 0, but the declared verifier
    // (a typed-locator capability) did not address it: activity, not evidence.
    await driver.advance(bash(`echo ${out}`, '[exit code: 0]'))
    assert.equal(driver.current()?.id, 'n_verify_repair',
      `engine=${engine}: a command that merely names the artifact must not satisfy verify`)

    driver.endTurn()
  })
}

for (const engine of ENGINES) {
  engineTest(`rm of the produced artifact cannot satisfy verify [${engine}]`, engine, async (t) => {
    const dir = workdir(t)
    const input = makeFile(dir, 'input.txt')
    const { graph, plan } = coreComposition()
    const driver = driverFor(engine, graph, plan)

    await driver.advance(read(input))
    const out = makeFile(dir, 'out.txt')
    await driver.advance(write(out))
    assert.equal(driver.current()?.id, 'n_verify', `engine=${engine}`)

    // The step removes the file it is supposed to prove; the verifier's prior
    // refs are re-measured after the call, so the artifact is gone.
    rmSync(out)
    await driver.advance(bash(`rm -f ${out}`, '[exit code: 0]'))
    assert.equal(existsSync(out), false)
    assert.equal(driver.current()?.id, 'n_verify_repair',
      `engine=${engine}: removing the artifact must not satisfy verify`)

    driver.endTurn()
  })
}

for (const engine of ENGINES) {
  engineTest(`bash true cannot satisfy verify [${engine}]`, engine, async (t) => {
    const dir = workdir(t)
    const input = makeFile(dir, 'input.txt')
    const { graph, plan } = coreComposition()
    const driver = driverFor(engine, graph, plan)

    await driver.advance(read(input))
    const out = makeFile(dir, 'out.txt')
    await driver.advance(write(out))
    assert.equal(driver.current()?.id, 'n_verify', `engine=${engine}`)

    await driver.advance(bash('true', '[exit code: 0]'))
    assert.equal(driver.current()?.id, 'n_verify_repair',
      `engine=${engine}: an unrelated clean verifier call must not advance verify`)

    driver.endTurn()
  })
}

// ---------------------------------------------------------------------------
// 5. Verify positive: the declared verifier addresses the artifact in a typed field
// ---------------------------------------------------------------------------

for (const engine of ENGINES) {
  engineTest(`a typed-locator verifier addressing the artifact satisfies verify [${engine}]`, engine, async (t) => {
    const dir = workdir(t)
    const input = makeFile(dir, 'input.txt')
    const { graph, plan } = coreComposition()
    const driver = driverFor(engine, graph, plan)

    await driver.advance(read(input))
    const out = makeFile(dir, 'out.txt')
    await driver.advance(write(out))
    assert.equal(driver.current()?.id, 'n_verify', `engine=${engine}`)

    // The declared verifier names the produced ref in its declared locator
    // field and the ref is still observable after the call.
    await driver.advance(read(out))
    assert.equal(driver.current()?.id, 'n_answer',
      `engine=${engine}: the declared verifier addressing the artifact advances verify`)

    driver.endTurn()
  })
}

for (const engine of ENGINES) {
  engineTest(`a typed-locator verifier is still accepted (false-negative guard) [${engine}]`, engine, async (t) => {
    const dir = workdir(t)
    const image = makeFile(dir, 'input.png', 'image bytes that must not be inspected\n')
    const { graph, plan } = locatorComposition()
    const driver = driverFor(engine, graph, plan)

    await driver.advance(readImage(image))
    assert.equal(driver.current()?.id, 'n_mutate', `engine=${engine}`)
    const out = makeFile(dir, 'out.txt')
    await driver.advance(write(out))
    assert.equal(driver.current()?.id, 'n_verify', `engine=${engine}`)

    await driver.advance(readImage(out))
    assert.equal(driver.current()?.id, 'n_answer',
      `engine=${engine}: a locator-addressed verifier call is still accepted`)

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
