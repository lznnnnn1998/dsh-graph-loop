/**
 * Transition matrix — the minimum cross-engine and end-to-end coverage the
 * 2026-11-08 audit asked for (P1-6).
 *
 *   1. the same plan and outcome stream through `FrontierTopology` and the
 *      kernel, compared node by node;
 *   2. fan-in joins: a diamond and a research subagent batch each run the join
 *      once;
 *   3. a composed verify stage that fails twice by shell exit code (not a tool
 *      error) and then succeeds, through the live turn driver; a non-verify
 *      stage whose shell command exits 1 is not sent to repair;
 *   4. a third-party/MCP author's success, tool failure, no-artifact outcome and
 *      wrong-tool outcome, plus step-scoped artifact credit;
 *   5. `artifact` / `noArtifact` routing in both engines;
 *   6. the `budget` guard at `maxSteps - 1`, `maxSteps - 2` and the last
 *      planned step;
 *   7. removed token/wall budget axes and data-edge conditions are rejected
 *      instead of silently inert.
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'

import { synthesizeComposition } from '../../packages/core/src/compose.ts'
import { buildEnvelope, defaultRole, type CapabilityRoleSpec } from '../../packages/core/src/envelope.ts'
import {
  validateTaskPlan,
  type ArtifactType,
  type Condition,
  type Json,
  type RegistryGraph,
  type TaskPlan,
} from '../../packages/core/src/graph-schema.ts'
import type { TaskFingerprint } from '../../packages/core/src/matching.ts'
import { validateProposal } from '../../packages/core/src/proposal.ts'
import {
  applyAnnotations,
  buildRegistrySnapshot,
  type RegistrySources,
  type ToolSource,
} from '../../packages/core/src/registry.ts'
import { FrontierTopology } from '../../packages/core/src/topology.ts'
import { KernelTopology, canKernelDrive } from '../../packages/loop/src/kernel/topology.ts'
import { createGraphTurnDriver } from '../../packages/loop/src/scheduler.ts'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type Engine = 'frontier' | 'kernel'

/** One node outcome as the engines accept it (facts/artifacts are pre-projected). */
interface Outcome {
  readonly ok: boolean
  readonly failedTool?: string
  readonly facts?: Readonly<Record<string, Json>>
  readonly artifacts?: readonly { readonly type: ArtifactType; readonly ref: string }[]
}

/** One DSH step outcome as the turn driver accepts it. */
interface StepOutcome {
  readonly ok: boolean
  readonly failedTool?: string
  readonly tools?: readonly { readonly name: string; readonly isError: boolean; readonly output?: string }[]
}

/** The slice of the two topology engines this matrix drives. */
interface Steppable {
  current(): { readonly id: string } | undefined
  advance(outcome: Outcome): unknown
  status(): string
  dispose?(): Promise<void> | void
}

function engineOf(engine: Engine, plan: TaskPlan): Steppable {
  return engine === 'frontier'
    ? new FrontierTopology(plan)
    : new KernelTopology(plan, { kind: 'minimal', taskHash: 'transition-matrix' })
}

/** Walk a plan to completion, recording the node id before each advance. */
async function walk(engine: Engine, plan: TaskPlan, stream: readonly Outcome[]): Promise<{ nodes: string[]; status: string }> {
  const topology = engineOf(engine, plan)
  const nodes: string[] = []
  try {
    for (const outcome of stream) {
      const current = topology.current()
      if (current === undefined) break
      nodes.push(current.id)
      await Promise.resolve(topology.advance(outcome))
    }
    // A stream may end before the plan; finish with plain successful steps so
    // the returned status is settled.
    while (topology.current() !== undefined && nodes.length < 50) {
      nodes.push(topology.current()!.id)
      await Promise.resolve(topology.advance({ ok: true }))
    }
    return { nodes, status: topology.status() }
  } finally {
    await topology.dispose?.()
  }
}

/** A four-node fixture: a branches to b/c, both join the terminal d. */
function branchPlan(when: Condition): TaskPlan {
  return planOf(
    [
      { from: 'a', to: 'b', kind: 'control', when },
      { from: 'a', to: 'c', kind: 'control' },
      { from: 'b', to: 'd', kind: 'control' },
      { from: 'c', to: 'd', kind: 'control' },
    ],
    { terminals: ['d'] },
  )
}

/** A chain fixture: a -> x, then x branches on the budget guard. */
function chainBudgetPlan(maxSteps: number, remainingAtMost: number): TaskPlan {
  return planOf(
    [
      { from: 'a', to: 'x', kind: 'control' },
      { from: 'x', to: 'b', kind: 'control', when: { op: 'budget', axis: 'steps', remainingAtMost } },
      { from: 'x', to: 'c', kind: 'control' },
    ],
    { terminals: ['b', 'c'], maxSteps, nodes: ['a', 'x', 'b', 'c'] },
  )
}

/** A one-hop budget fixture: a branches on the guard, otherwise the fallback. */
function budgetPlan(maxSteps: number, remainingAtMost: number): TaskPlan {
  return planOf(
    [
      { from: 'a', to: 'b', kind: 'control', when: { op: 'budget', axis: 'steps', remainingAtMost } },
      { from: 'a', to: 'c', kind: 'control' },
    ],
    { terminals: ['b', 'c'], maxSteps, nodes: ['a', 'b', 'c'] },
  )
}

function planOf(
  edges: TaskPlan['edges'],
  options: { readonly terminals?: readonly string[]; readonly maxSteps?: number; readonly nodes?: readonly string[] } = {},
): TaskPlan {
  const ids = options.nodes ?? ['a', 'b', 'c', 'd']
  return {
    id: 'transition-matrix',
    templateId: 'test',
    version: 1,
    entry: ids[0]!,
    terminals: options.terminals ?? [ids[ids.length - 1]!],
    nodes: ids.map(id => ({ id, kind: 'agent-step', executor: 'step', instruction: `run ${id}` })),
    edges,
    budget: {
      maxNodes: ids.length,
      maxSteps: options.maxSteps ?? 6,
      maxTokens: 10_000,
      maxWallMs: 60_000,
      maxReplans: 0,
    },
    toolUniverse: [],
    gatePolicy: 'cold',
    fallback: false,
    confidence: 1,
    compiledDigest: 'transition-matrix',
  }
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

const WEB_TOOLS: ToolSource[] = [
  ...CORE_TOOLS,
  { name: 'web_search', description: 'Search the web.', parameters: { type: 'object', properties: { query: { type: 'string' } } } },
  { name: 'web_fetch', description: 'Fetch a page.', parameters: { type: 'object', properties: { url: { type: 'string' } } } },
]

/** A composed code-change plan (inspect -> mutate -> verify -> answer). */
function coreComposition(): { graph: RegistryGraph; plan: TaskPlan } {
  const graph = graphOf({ tools: CORE_TOOLS })
  const envelope = buildEnvelope({
    roles: [role('workspace-read'), role('workspace-write'), role('shell'), role('verification')],
  }, graph)
  assert.equal(envelope.fallbackToStock, false)
  const result = synthesizeComposition({
    fingerprint: fingerprint({ intent: 'code-change', mutating: true }),
    graph,
    envelope: envelope.envelope,
  })
  assert.deepEqual(result.stages.map(stage => stage.stage), ['inspect', 'mutate', 'verify'])
  return { graph, plan: result.plan }
}

/**
 * A composed plan whose author is a third-party tool with a declared artifact.
 * With `intent: 'document'` the read tool also fills an inspect stage, so the
 * earlier stage can produce a run-cumulative artifact before the author runs.
 */
function thirdPartyComposition(
  intent: TaskFingerprint['intent'] = 'other',
  requestedArtifacts: readonly ArtifactType[] = ['file.image'],
): { graph: RegistryGraph; plan: TaskPlan } {
  const annotated = applyAnnotations(
    [
      { name: 'acme_read', packageName: '@acme/widgets' },
      { name: 'acme_render', packageName: '@acme/widgets' },
    ],
    [
      { tool: 'acme_read', permission: 'read-only', tags: ['filesystem'], produces: [{ type: 'file.text', required: true }] },
      { tool: 'acme_render', tags: ['authoring', 'image'], produces: [{ type: 'file.image', required: true }] },
    ],
  )
  assert.equal(annotated.unmatched.length, 0)
  const graph = graphOf({ tools: annotated.tools })
  const envelope = buildEnvelope({
    roles: [{ role: 'read', implementations: ['acme_read'] }, { role: 'render', implementations: ['acme_render'] }],
  }, graph)
  assert.equal(envelope.fallbackToStock, false)
  const result = synthesizeComposition({
    fingerprint: fingerprint({ intent }),
    graph,
    envelope: envelope.envelope,
    requestedArtifacts,
  })
  assert.ok(result.plan.nodes.some(node => node.id === 'n_author_0'), 'the fixture must compose an author stage')
  return { graph, plan: result.plan }
}

async function walkDriver(driver: ReturnType<typeof createGraphTurnDriver>, stream: readonly StepOutcome[]): Promise<string[]> {
  for (const outcome of stream) {
    await driver.advance(outcome)
  }
  return driver.snapshot().trail.map(row => row.id)
}

// ---------------------------------------------------------------------------
// 1. Cross-engine parity on the same plan and outcome stream
// ---------------------------------------------------------------------------

const artifactRef = (type: ArtifactType): { readonly type: ArtifactType; readonly ref: string }[] => [{ type, ref: `ref:${type}` }]

for (const parity of [
  {
    name: 'artifact hit takes the guarded exit',
    plan: branchPlan({ op: 'artifact', type: 'file.patch' }),
    stream: [{ ok: true, artifacts: artifactRef('file.patch') }, { ok: true }, { ok: true }] as Outcome[],
    expected: ['a', 'b', 'd'],
  },
  {
    name: 'artifact miss takes the fallback',
    plan: branchPlan({ op: 'artifact', type: 'file.patch' }),
    stream: [{ ok: true }, { ok: true }] as Outcome[],
    expected: ['a', 'c', 'd'],
  },
  {
    name: 'noArtifact hit takes the guarded exit',
    plan: branchPlan({ op: 'noArtifact', type: 'file.text' }),
    stream: [{ ok: true }, { ok: true }] as Outcome[],
    expected: ['a', 'b', 'd'],
  },
  {
    name: 'noArtifact miss takes the fallback',
    plan: branchPlan({ op: 'noArtifact', type: 'file.text' }),
    stream: [{ ok: true, artifacts: artifactRef('file.text') }, { ok: true }] as Outcome[],
    expected: ['a', 'c', 'd'],
  },
  {
    name: 'fact false takes the recovery exit',
    plan: branchPlan({ op: 'fact', key: 'lastOk', equals: false }),
    stream: [{ ok: false } as Outcome, { ok: true }, { ok: true }],
    expected: ['a', 'b', 'd'],
  },
  {
    name: 'fact true takes the success exit',
    plan: branchPlan({ op: 'fact', key: 'lastOk', equals: false }),
    stream: [{ ok: true }, { ok: true }, { ok: true }] as Outcome[],
    expected: ['a', 'c', 'd'],
  },
]) {
  test(`frontier and kernel agree: ${parity.name}`, async () => {
    const frontier = await walk('frontier', parity.plan, parity.stream)
    const kernel = await walk('kernel', parity.plan, parity.stream)
    assert.deepEqual(frontier.nodes, parity.expected)
    assert.deepEqual(kernel, frontier, 'the same plan/outcome stream must route identically')
  })
}

// ---------------------------------------------------------------------------
// 1b. Fan-in joins execute once (frontier fallback; the kernel rejects fan-out)
// ---------------------------------------------------------------------------

test('a diamond fan-in join executes the join node once', async () => {
  const diamond = planOf(
    [
      { from: 'a', to: 'b', kind: 'control' },
      { from: 'a', to: 'c', kind: 'control' },
      { from: 'b', to: 'd', kind: 'control' },
      { from: 'c', to: 'd', kind: 'control' },
    ],
    { terminals: ['d'] },
  )
  // Two unconditional edges out of `a` are a frontier shape; the kernel adapter
  // refuses fan-out, so this is the fallback engine's join.
  assert.equal(canKernelDrive(diamond), false)
  const route = await walk('frontier', diamond, [{ ok: true }])
  assert.deepEqual(route.nodes, ['a', 'b', 'c', 'd'], 'the join must not run twice after both branches')
  assert.equal(route.status, 'done')
})

test('a research fan-out reaches its answer node once (frontier, subagent batch)', async () => {
  const graph = graphOf({ tools: WEB_TOOLS })
  const driver = createGraphTurnDriver({
    mode: 'dynamic',
    composition: false,
    kernel: 'off',
    graphProvider: () => graph,
  })
  const started = await driver.beginTurn({ text: 'research the best database for this workload and compare the sources' })
  assert.ok(started.rationale.some(line => line.includes('fan-out')), started.rationale.join('; '))
  await driver.advance({ ok: true })
  const batch = driver.takeSubagentBatch()
  assert.deepEqual(batch.map(node => node.id).sort(), ['d_fetch', 'd_search'])
  for (const node of batch) await driver.completeNode(node.id, true)
  assert.equal(driver.current()?.id, 'd_answer')
  await driver.advance({ ok: true })
  assert.equal(driver.done(), true)
  const trail = driver.snapshot().trail.map(row => row.id)
  assert.equal(trail.filter(id => id === 'd_answer').length, 1, 'the join must run the answer step once')
  assert.deepEqual(trail, ['d_entry', 'd_search', 'd_fetch', 'd_answer'])
})

// ---------------------------------------------------------------------------
// 2. Composed verify fails twice by shell exit code, then succeeds
// ---------------------------------------------------------------------------

test('a composed verify stage fails twice by shell exit code, then passes (turn driver, both engines)', async () => {
  const { graph, plan } = coreComposition()
  assert.equal(canKernelDrive(plan), true, 'the composed plan must be kernel-drivable')
  const verifyFailure = (code: number): StepOutcome => ({
    // DSH reports a non-zero shell exit as a normal result: ok is true and the
    // rendered text carries `[exit code: N]`. The step facts, not `ok`, must
    // drive the verify -> repair exit.
    ok: true,
    tools: [{ name: 'bash', isError: false, output: `FAIL tests/loader.test.ts\n[exit code: ${code}]` }],
  })
  const stream: StepOutcome[] = [
    { ok: true, tools: [{ name: 'read', isError: false }] },     // inspect (readFile)
    { ok: true, tools: [{ name: 'edit', isError: false }] },     // mutate (wroteFile)
    verifyFailure(1),                                            // verify -> repair
    { ok: true },                                                // repair -> verify
    verifyFailure(2),                                            // verify -> repair again
    { ok: true },                                                // repair -> verify
    { ok: true, tools: [{ name: 'bash', isError: false, output: 'PASS\n[exit code: 0]' }] },
    { ok: true },                                                // answer
  ]
  const expected = [
    'n_inspect',
    'n_mutate',
    'n_verify',
    'n_verify_repair',
    'n_verify',
    'n_verify_repair',
    'n_verify',
    'n_answer',
  ]

  const kernelDriver = createGraphTurnDriver({ mode: 'dynamic', kernel: 'minimal', graphProvider: () => graph })
  const frontierDriver = createGraphTurnDriver({ mode: 'dynamic', kernel: 'off', graphProvider: () => graph })
  const routes: string[][] = []
  for (const driver of [kernelDriver, frontierDriver]) {
    const started = await driver.beginTurn({ text: 'fix the failing test in the loader' })
    assert.equal(started.templateId, 't_compose')
    const trail = await walkDriver(driver, stream)
    assert.deepEqual(trail, expected)
    assert.equal(driver.done(), true)
    assert.equal(driver.status?.(), 'done')
    assert.equal(driver.snapshot().replans, 0, 'the composed repair exit must not need a boundary replan')
    routes.push(trail)
    driver.endTurn()
  }
  assert.deepEqual(routes[1], routes[0], 'frontier and kernel drivers must walk the same composed plan identically')
})

test('a non-verify stage whose shell command exits 1 is not sent to repair (P1-3)', async () => {
  const { graph, plan } = coreComposition()
  for (const kernel of ['minimal', 'off'] as const) {
    const driver = createGraphTurnDriver({ kernel, graphProvider: () => graph })
    driver.adopt(plan)
    assert.equal(driver.current()?.id, 'n_inspect')
    await driver.advance({ ok: true, tools: [{ name: 'read', isError: false }] })
    assert.equal(driver.current()?.id, 'n_mutate')
    // A successful mutate step that happened to run a probe command: DSH reports
    // a normal result carrying `[exit code: 1]`. That is not a tool-invocation
    // failure and must not send a non-verify stage to repair.
    await driver.advance({ ok: true, tools: [{ name: 'bash', isError: false, output: 'no match\n[exit code: 1]' }] })
    assert.equal(driver.current()?.id, 'n_verify', `kernel=${kernel}: mutate must advance, not repair`)
    driver.endTurn()
  }
})

// ---------------------------------------------------------------------------
// 3. Third-party/MCP author outcomes
// ---------------------------------------------------------------------------

test('a third-party author succeeds when its declared artifact is observed', async () => {
  const { graph, plan } = thirdPartyComposition()
  const driver = createGraphTurnDriver({ kernel: 'minimal', graphProvider: () => graph })
  driver.adopt(plan)
  assert.equal(driver.current()?.id, 'n_author_0')
  await driver.advance({ ok: true, tools: [{ name: 'acme_render', isError: false }] })
  assert.equal(driver.current()?.id, 'n_answer')
  await driver.advance({ ok: true })
  assert.equal(driver.status?.(), 'done')
})

test('a third-party author that fails or produces nothing repairs instead of passing through', async () => {
  const { graph, plan } = thirdPartyComposition()

  // Tool-invocation failure: the step fails and the author's repair exit runs.
  const failed = createGraphTurnDriver({ kernel: 'minimal', graphProvider: () => graph })
  failed.adopt(plan)
  await failed.advance({ ok: false, failedTool: 'acme_render', tools: [{ name: 'acme_render', isError: true }] })
  assert.equal(failed.current()?.id, 'n_author_0_repair')
  await failed.advance({ ok: true, tools: [{ name: 'acme_render', isError: false }] })
  assert.equal(failed.current()?.id, 'n_author_0', 'the repair node must return to the author stage')
  await failed.advance({ ok: true, tools: [{ name: 'acme_render', isError: false }] })
  assert.equal(failed.current()?.id, 'n_answer')
  await failed.advance({ ok: true })
  assert.equal(failed.status?.(), 'done')

  // "Success" with no observable artifact (no tool ran): `producedArtifact` is
  // step-scoped and false, so the author repairs rather than silently skipping
  // its artifact contract.
  const empty = createGraphTurnDriver({ kernel: 'minimal', graphProvider: () => graph })
  empty.adopt(plan)
  await empty.advance({ ok: true })
  assert.equal(empty.current()?.id, 'n_author_0_repair')

  // A different successful tool is not the planned author tool: it must not be
  // credited with the declared artifact (P1-2).
  const wrongTool = createGraphTurnDriver({ kernel: 'minimal', graphProvider: () => graph })
  wrongTool.adopt(plan)
  await wrongTool.advance({ ok: true, tools: [{ name: 'read', isError: false }] })
  assert.equal(wrongTool.current()?.id, 'n_author_0_repair')
})

test('an earlier stage artifact cannot satisfy a later author (step-scoped, P1-4)', async () => {
  // `document` intent + a requested file.text composes inspect (acme_read) and
  // an author filled by the same tool. The inspect step produces file.text, so
  // the run-cumulative artifact array already contains it when the author runs;
  // the author's own step reports producedArtifact=false and must still repair.
  const { graph, plan } = thirdPartyComposition('document', ['file.text'])
  const stageIds = plan.nodes.filter(node => !node.id.endsWith('_repair')).map(node => node.id)
  assert.ok(stageIds.indexOf('n_inspect') !== -1 && stageIds.indexOf('n_inspect') < stageIds.indexOf('n_author_0'))

  const driver = createGraphTurnDriver({ kernel: 'minimal', graphProvider: () => graph })
  driver.adopt(plan)
  assert.equal(driver.current()?.id, 'n_inspect')
  await driver.advance({ ok: true, tools: [{ name: 'acme_read', isError: false }] })
  assert.equal(driver.current()?.id, 'n_author_0')
  await driver.advance({ ok: true })
  assert.equal(driver.current()?.id, 'n_author_0_repair', 'the run-cumulative file.text must not satisfy the author')
})

// ---------------------------------------------------------------------------
// 4. Budget at the boundary
// ---------------------------------------------------------------------------

test('the budget guard fires at maxSteps - 1 and maxSteps - 2 in both engines', async () => {
  // After one completed node the remaining count is maxSteps - 1.
  const afterOne = await Promise.all([
    walk('frontier', budgetPlan(4, 3), [{ ok: true }]),
    walk('kernel', budgetPlan(4, 3), [{ ok: true }]),
  ])
  for (const route of afterOne) assert.deepEqual(route.nodes, ['a', 'b'])
  const belowOne = await Promise.all([
    walk('frontier', budgetPlan(4, 2), [{ ok: true }]),
    walk('kernel', budgetPlan(4, 2), [{ ok: true }]),
  ])
  for (const route of belowOne) assert.deepEqual(route.nodes, ['a', 'c'])

  // After two completed nodes the remaining count is maxSteps - 2; the guard
  // that did not fire after `a` fires after `x` in both engines.
  const afterTwo = await Promise.all([
    walk('frontier', chainBudgetPlan(4, 2), [{ ok: true }, { ok: true }]),
    walk('kernel', chainBudgetPlan(4, 2), [{ ok: true }, { ok: true }]),
  ])
  for (const route of afterTwo) {
    assert.deepEqual(route.nodes, ['a', 'x', 'b'])
    assert.equal(route.status, 'done')
  }
})

test('the last planned step keeps its budget-routed wrap-up node (kernel adapter reserve)', async () => {
  // maxSteps 1: one planned step remains after `a`, so the guard's target `b`
  // would be a second step. The kernel adapter itself reserves one step for the
  // wrap-up node, so the node is folded and committed instead of being run by
  // the host and discarded at the budget boundary (P1-5).
  const topology = new KernelTopology(budgetPlan(1, 0), { kind: 'minimal', taskHash: 'matrix' })
  try {
    assert.equal(topology.current()?.id, 'a')
    assert.equal((await topology.advance({ ok: true }))?.id, 'b')
    assert.equal(await topology.advance({ ok: true }), undefined)
    assert.equal(topology.status(), 'done')
    assert.deepEqual(topology.stateSnapshot().journal.map(entry => entry.nodeId), ['a', 'b'])
  } finally {
    await topology.dispose()
  }

  // The driver uses the same rule; the scheduler no longer special-cases it.
  const driver = createGraphTurnDriver({ kernel: 'minimal' })
  driver.adopt(budgetPlan(1, 0))
  await driver.advance({ ok: true })
  assert.equal(driver.current()?.id, 'b')
  await driver.advance({ ok: true })
  assert.equal(driver.status?.(), 'done')
  assert.deepEqual(driver.snapshot().trail.map(row => row.id), ['a', 'b'])

  // The frontier is the fallback engine and stops at the plan's step cap: a
  // guard that fires only when zero steps remain cannot add a step. Composed
  // plans target `ANSWER_RESERVE_STEPS` (2), so the wrap-up has room there.
  const frontier = createGraphTurnDriver({ kernel: 'off' })
  frontier.adopt(budgetPlan(1, 0))
  await frontier.advance({ ok: true })
  assert.equal(frontier.done(), true)
  assert.deepEqual(frontier.snapshot().trail.map(row => row.id), ['a'])
})

// ---------------------------------------------------------------------------
// 5. Dead condition schema is rejected, not silently inert
// ---------------------------------------------------------------------------

test('a budget guard on a removed token/wall axis is rejected by validation', () => {
  const graph = graphOf({ tools: [] })
  const tokenGuard = planOf([
    { from: 'a', to: 'b', kind: 'control', when: { op: 'budget', axis: 'tokens', remainingAtMost: 1 } as never },
  ])
  const rejected = validateTaskPlan(graph, tokenGuard)
  assert.equal(rejected.ok, false)
  assert.ok(rejected.errors.some(error => error.code === 'P022'), rejected.errors.map(error => error.code).join(','))

  const stepGuard = planOf([
    { from: 'a', to: 'b', kind: 'control', when: { op: 'budget', axis: 'steps', remainingAtMost: 1 } },
  ])
  assert.equal(validateTaskPlan(graph, stepGuard).ok, true)
})

test('a condition on a data edge is rejected instead of silently inert', () => {
  const graph = graphOf({ tools: [] })
  const plan = planOf([
    { from: 'a', to: 'b', kind: 'data', when: { op: 'callFailed', tool: 'bash' } },
  ])
  const validation = validateTaskPlan(graph, plan)
  assert.equal(validation.ok, false)
  assert.ok(validation.errors.some(error => error.code === 'P023'))
})

test('a model-authored proposal with a token/wall budget guard is rejected', () => {
  const graph = graphOf({ tools: [] })
  const proposal = {
    entry: 'n1',
    nodes: [{ id: 'n1' }, { id: 'n2', kind: 'terminal' }],
    edges: [{ from: 'n1', to: 'n2', when: { op: 'budget', axis: 'wall', remainingAtMost: 1 } }],
  }
  const result = validateProposal(proposal, graph, [])
  assert.equal(result.ok, false)
  assert.ok(result.errors.some(error => error.includes('not a supported condition')), result.errors.join('; '))
})
