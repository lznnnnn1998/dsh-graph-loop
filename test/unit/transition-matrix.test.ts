/**
 * Transition matrix — the minimum cross-engine and end-to-end coverage the
 * 2026-11-08 audits asked for (P1-6).
 *
 *   1. the same plan and outcome stream through `FrontierTopology`, the minimal
 *      kernel and the default LangGraph kernel, compared node by node;
 *   2. fan-in joins: a shallow diamond and a **depth-2 diamond** run through all
 *      three engines (the acyclic all-unconditional class is kernel-owned), a
 *      depth-2 diamond inside a cycle and a research subagent batch stay on the
 *      frontier and each run the join once (once per iteration on a cycle);
 *   3. a composed verify stage that fails twice by shell exit code (not a tool
 *      error) and then succeeds, through the live turn driver on all three
 *      engines; a non-verify stage whose shell command exits 1 is not sent to
 *      repair;
 *   4. a third-party/MCP author's success, tool failure, no-artifact outcome,
 *      wrong-artifact outcome and step-scoped artifact credit;
 *   5. every composed stage classifies its own success: discover/inspect/mutate
 *      with no tool, a `file.image` author fed only `file.text`, and a verify
 *      that never ran all repair instead of advancing;
 *   6. the budget exit is evaluated before every failure exit at the answer reserve
 *      boundary, so a failed verify continues in the tool-enabled answer (a
 *      continuation, not a success claim) and its non-zero exit stays in the trail;
 *   7. the `budget` guard at `maxSteps - 1`, `maxSteps - 2` and the last
 *      planned step;
 *   8. removed token/wall budget axes and data-edge conditions are rejected
 *      instead of silently inert.
 */

import assert from 'node:assert/strict'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
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
import { available } from '../../packages/loop/src/kernel/index.ts'
import { KernelTopology, canKernelDrive } from '../../packages/loop/src/kernel/topology.ts'
import { createGraphTurnDriver } from '../../packages/loop/src/scheduler.ts'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** The three routing engines a plan can run on. */
type Engine = 'frontier' | 'minimal' | 'langgraph'

const ENGINES: readonly Engine[] = ['frontier', 'minimal', 'langgraph']

/**
 * LangGraph is an optional dependency. A skip is reported with an explicit
 * reason, never silently passed (the audit's P2-6); the minimal kernel and the
 * frontier never skip.
 */
const langgraphAvailable = await available()
const LANGGRAPH_SKIP = langgraphAvailable
  ? undefined
  : '@langchain/langgraph is not installed (or no longer satisfies the kernel surface); language-graph rows skipped'

function engineTest(name: string, engine: Engine, fn: () => Promise<void>): void {
  test(name, { skip: engine === 'langgraph' && !langgraphAvailable ? LANGGRAPH_SKIP : undefined }, fn)
}

/** The turn-driver `kernel` option for an engine. */
function kernelOption(engine: Engine): 'off' | 'minimal' | 'langgraph' {
  return engine === 'frontier' ? 'off' : engine
}

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
    : new KernelTopology(plan, { kind: engine, taskHash: 'transition-matrix' })
}

/** Walk a plan to completion, recording the node id before each advance. */
async function walk(engine: Engine, plan: TaskPlan, stream: readonly Outcome[]): Promise<{ nodes: string[]; status: string }> {
  const topology = engineOf(engine, plan)
  const nodes: string[] = []
  // Both engines merge facts cumulatively; a direct adapter caller is the source
  // of the step-scoped facts (the scheduler derives them with `deriveStepFacts`).
  // Spelling `lastOk`/`failedTool` out on every advance keeps a stale value from
  // a previous step out of the next route decision.
  const stepFacts = (outcome: Outcome, ok: boolean): Record<string, Json> => ({
    lastOk: ok,
    ...(outcome.failedTool === undefined ? {} : { failedTool: outcome.failedTool }),
    ...outcome.facts,
  })
  try {
    for (const outcome of stream) {
      const current = topology.current()
      if (current === undefined) break
      nodes.push(current.id)
      await Promise.resolve(topology.advance({ ...outcome, facts: stepFacts(outcome, outcome.ok) }))
    }
    // A stream may end before the plan; finish with plain successful steps so
    // the returned status is settled.
    while (topology.current() !== undefined && nodes.length < 50) {
      nodes.push(topology.current()!.id)
      await Promise.resolve(topology.advance({ ok: true, facts: stepFacts({ ok: true }, true) }))
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
      { tool: 'acme_render', tags: ['authoring', 'image'], produces: [{ type: 'file.image', required: true }, { type: 'file.text', required: true }] },
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
  for (const engine of ENGINES) {
    engineTest(`parity [${engine}]: ${parity.name}`, engine, async () => {
      const route = await walk(engine, parity.plan, parity.stream)
      assert.deepEqual(route.nodes, parity.expected)
    })
  }
}

test('all available engines route the same plan/outcome stream identically', async () => {
  const plan = branchPlan({ op: 'fact', key: 'lastOk', equals: false })
  const stream: Outcome[] = [{ ok: false }, { ok: true }, { ok: true }]
  const routes: { engine: Engine; nodes: string[] }[] = []
  for (const engine of ENGINES) routes.push({ engine, nodes: (await walk(engine, plan, stream)).nodes })
  const expected = ['a', 'b', 'd']
  for (const route of routes) {
    assert.deepEqual(route.nodes, expected, `${route.engine} diverged`)
  }
})

// ---------------------------------------------------------------------------
// 1b. Fan-in joins execute once (the widened kernel class owns the acyclic split)
// ---------------------------------------------------------------------------

test('a diamond fan-out/join runs through the kernel on all three engines', async () => {
  const diamond = planOf(
    [
      { from: 'a', to: 'b', kind: 'control' },
      { from: 'a', to: 'c', kind: 'control' },
      { from: 'b', to: 'd', kind: 'control' },
      { from: 'c', to: 'd', kind: 'control' },
    ],
    { terminals: ['d'] },
  )
  // An acyclic all-unconditional split is the widened class. Asserting the gate
  // first keeps the drill from passing on the frontier fallback: `adopt` below
  // picks the engine with `canKernelDrive`, so a false here means the frontier
  // ran the diamond and the kernel claims below would not be exercised.
  assert.equal(canKernelDrive(diamond), true, 'the all-unconditional diamond must be kernel-driven')
  const graph = graphOf({ tools: CORE_TOOLS })
  for (const engine of ENGINES) {
    const driver = createGraphTurnDriver({
      mode: 'dynamic',
      composition: false,
      kernel: kernelOption(engine),
      graphProvider: () => graph,
    })
    await driver.beginTurn({ text: 'run the diamond plan' })
    driver.adopt(diamond)
    assert.equal(driver.current()?.id, 'a', `${engine} must start at the entry`)
    for (let step = 0; step < 6 && !driver.done(); step += 1) await driver.advance({ ok: true })
    const snapshot = driver.snapshot()
    assert.deepEqual(snapshot.visited, ['a', 'b', 'c', 'd'], `${engine} diverged on the diamond`)
    assert.equal(snapshot.visited.filter(id => id === 'd').length, 1, `${engine} must run the join once`)
    assert.equal(snapshot.status, 'done', `${engine} must settle at the terminal`)
    const state = driver.stateSnapshot?.()
    if (engine === 'frontier') {
      assert.equal(state, undefined, 'the frontier exposes no kernel state')
    } else {
      // Kernel-driven, not a frontier fallback: the folded state exists and its
      // journal is the visit order.
      assert.ok(state !== undefined, `${engine} must expose the folded kernel state`)
      assert.deepEqual(state.journal.map(entry => entry.nodeId), ['a', 'b', 'c', 'd'],
        `${engine} journal must match the visit order`)
    }
    driver.endTurn()
  }
})

test('a depth-2 diamond join waits for the deep branch on all three engines (P1-1)', async () => {
  const deep = planOf(
    [
      { from: 'a', to: 'b', kind: 'control' },
      { from: 'a', to: 'c', kind: 'control' },
      { from: 'b', to: 'd', kind: 'control' },
      { from: 'c', to: 'c2', kind: 'control' },
      { from: 'c2', to: 'd', kind: 'control' },
    ],
    { terminals: ['d'], nodes: ['a', 'b', 'c', 'c2', 'd'], maxSteps: 8 },
  )
  assert.equal(validateTaskPlan(graphOf({ tools: [] }), deep).ok, true, 'the deep diamond is a legal plan')
  assert.equal(canKernelDrive(deep), true, 'the acyclic all-unconditional split is kernel-driven')
  for (const engine of ENGINES) {
    const route = await walk(engine, deep, [{ ok: true }])
    assert.deepEqual(route.nodes, ['a', 'b', 'c', 'c2', 'd'],
      `${engine}: the join must wait for c2; running on b and dropping the c2 -> d edge is the P1-1 bug`)
    assert.equal(route.status, 'done')
  }
})

test('a depth-3 branch still holds the join (P1-1)', async () => {
  // The direct predecessor of the join is two levels below the split, so the
  // queue cannot see it directly; the pending reachability rule must hold `d`.
  const deep = planOf(
    [
      { from: 'a', to: 'b', kind: 'control' },
      { from: 'a', to: 'c', kind: 'control' },
      { from: 'b', to: 'd', kind: 'control' },
      { from: 'c', to: 'c2', kind: 'control' },
      { from: 'c2', to: 'c3', kind: 'control' },
      { from: 'c3', to: 'd', kind: 'control' },
    ],
    { terminals: ['d'], nodes: ['a', 'b', 'c', 'c2', 'c3', 'd'], maxSteps: 10 },
  )
  const route = await walk('frontier', deep, [{ ok: true }])
  assert.deepEqual(route.nodes, ['a', 'b', 'c', 'c2', 'c3', 'd'])
})

test('a join whose dependency is inverted in the declaration order still runs last (P1-1)', async () => {
  // Legal DAG: `c` is a join of `a` and `d`. The old FIFO frontier popped `c`
  // before `d` (its predecessor) and then never re-ran it.
  const inverted = planOf(
    [
      { from: 'a', to: 'b', kind: 'control' },
      { from: 'a', to: 'c', kind: 'control' },
      { from: 'b', to: 'd', kind: 'control' },
      { from: 'd', to: 'c', kind: 'control' },
    ],
    { terminals: ['c'], maxSteps: 8 },
  )
  assert.equal(validateTaskPlan(graphOf({ tools: [] }), inverted).ok, true)
  const route = await walk('frontier', inverted, [{ ok: true }])
  assert.deepEqual(route.nodes, ['a', 'b', 'd', 'c'], 'the join must run after its predecessor d')
})

test('a join inside a cycle runs once per iteration, never before its deep branch (P1-1)', async () => {
  const loop = planOf(
    [
      { from: 'a', to: 'b', kind: 'control' },
      { from: 'a', to: 'c', kind: 'control' },
      { from: 'b', to: 'd', kind: 'control' },
      { from: 'c', to: 'c2', kind: 'control' },
      { from: 'c2', to: 'd', kind: 'control' },
      { from: 'd', to: 'e', kind: 'control' },
      { from: 'e', to: 'a', kind: 'control' },
    ],
    { terminals: ['e'], nodes: ['a', 'b', 'c', 'c2', 'd', 'e'], maxSteps: 12 },
  )
  const route = await walk('frontier', loop, [{ ok: true }])
  // Two full iterations: the join runs once per iteration and only after c2.
  assert.deepEqual(route.nodes, ['a', 'b', 'c', 'c2', 'd', 'e', 'a', 'b', 'c', 'c2', 'd', 'e'])
  assert.equal(route.nodes.filter(id => id === 'd').length, 2, 'the loop re-enters the join exactly once per pass')
})

test('a fan-out with a retried branch runs its join once, after the retry settles (P1-1)', async () => {
  const retry = planOf(
    [
      { from: 'entry', to: 'a', kind: 'control' },
      { from: 'entry', to: 'b', kind: 'control' },
      { from: 'a', to: 'a', kind: 'control', when: { op: 'callFailed', tool: 'bash' } },
      { from: 'a', to: 'join', kind: 'control' },
      { from: 'b', to: 'join', kind: 'control' },
      { from: 'join', to: 'answer', kind: 'control' },
    ],
    { terminals: ['answer'], nodes: ['entry', 'a', 'b', 'join', 'answer'], maxSteps: 10 },
  )
  assert.equal(validateTaskPlan(graphOf({ tools: [] }), retry).ok, true)
  const route = await walk('frontier', retry, [
    { ok: true },                            // entry fans out
    { ok: false, failedTool: 'bash' },       // a fails -> retry a
    { ok: true },                            // a succeeds
    { ok: true },                            // b
    { ok: true },                            // join
    { ok: true },                            // answer
  ])
  assert.deepEqual(route.nodes, ['entry', 'a', 'b', 'a', 'join', 'answer'],
    'the retried branch runs (the queued sibling may go first), and the join still waits for it')
  assert.equal(route.nodes.filter(id => id === 'join').length, 1, 'the retried branch must not double the join')
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

for (const engine of ENGINES) {
  engineTest(`a composed verify failure repairs once, and the repair work answers [${engine}]`, engine, async () => {
    const { graph, plan } = coreComposition()
    assert.equal(canKernelDrive(plan), true, 'the composed plan must be kernel-drivable')
    const verifyFailure = (code: number): StepOutcome => ({
      // DSH reports a non-zero shell exit as a normal result: ok is true and the
      // rendered text carries `[exit code: N]`. The step facts, not `ok`, must
      // drive the verify -> repair exit.
      ok: true,
      tools: [{ name: 'bash', isError: false, output: `FAIL tests/loader.test.ts\n[exit code: ${code}]` }],
    })
    const verifyPass = (): StepOutcome => ({
      ok: true,
      tools: [{ name: 'bash', isError: false, output: 'PASS\n[exit code: 0]' }],
    })
    const stream: StepOutcome[] = [
      { ok: true, tools: [{ name: 'read', isError: false }] },     // inspect (toolSucceeded)
      { ok: true, tools: [{ name: 'edit', isError: false }] },     // mutate (wroteFile)
      verifyFailure(1),                                            // verify -> repair
      verifyPass(),                                                // repair does the work -> answer
      { ok: true },                                                // answer
    ]
    const expected = ['n_inspect', 'n_mutate', 'n_verify', 'n_verify_repair', 'n_answer']

    const driver = createGraphTurnDriver({ mode: 'dynamic', kernel: kernelOption(engine), graphProvider: () => graph })
    const started = await driver.beginTurn({ text: 'fix the failing test in the loader' })
    assert.equal(started.templateId, 't_compose')
    const trail = await walkDriver(driver, stream)
    assert.deepEqual(trail, expected)
    assert.equal(driver.done(), true)
    assert.equal(driver.status?.(), 'done')
    assert.equal(driver.snapshot().replans, 0, 'the composed repair exit must not need a boundary replan')
    driver.endTurn()
  })
}

for (const engine of ENGINES) {
  engineTest(`a no-op repair of a failed verify answers instead of returning to verify [${engine}]`, engine, async () => {
    const { graph, plan } = coreComposition()
    assert.equal(canKernelDrive(plan), true, 'the composed plan must be kernel-drivable')
    const stream: StepOutcome[] = [
      { ok: true, tools: [{ name: 'read', isError: false }] },     // inspect
      { ok: true, tools: [{ name: 'edit', isError: false }] },     // mutate
      { ok: true, tools: [{ name: 'bash', isError: false, output: 'FAIL\n[exit code: 1]' }] }, // verify -> repair
      { ok: true },                                                // repair: no tool, no progress -> answer
      { ok: true },                                                // answer
    ]
    const expected = ['n_inspect', 'n_mutate', 'n_verify', 'n_verify_repair', 'n_answer']

    const driver = createGraphTurnDriver({ mode: 'dynamic', kernel: kernelOption(engine), graphProvider: () => graph })
    await driver.beginTurn({ text: 'fix the failing test in the loader' })
    const trail = await walkDriver(driver, stream)
    assert.deepEqual(trail, expected, `engine=${engine}: a no-op repair must answer, not retry verify`)
    assert.equal(driver.done(), true)
    assert.equal(driver.status?.(), 'done')
    driver.endTurn()
  })
}

test('a non-verify stage whose shell command exits 1 is not sent to repair', async () => {
  const { graph, plan } = coreComposition()
  for (const engine of ENGINES) {
    const driver = createGraphTurnDriver({ kernel: kernelOption(engine), graphProvider: () => graph })
    driver.adopt(plan)
    assert.equal(driver.current()?.id, 'n_inspect')
    await driver.advance({ ok: true, tools: [{ name: 'read', isError: false }] })
    assert.equal(driver.current()?.id, 'n_mutate')
    // A successful mutate step that happened to run a probe command: DSH reports
    // a normal result carrying `[exit code: 1]`. That is not a tool-invocation
    // failure and must not send a non-verify stage to repair. The edit is the
    // stage's own progress fact; without it the stage repairs for a different
    // reason (no mutation happened), which is not what this test is about.
    await driver.advance({ ok: true, tools: [
      { name: 'edit', isError: false },
      { name: 'bash', isError: false, output: 'no match\n[exit code: 1]' },
    ] })
    assert.equal(driver.current()?.id, 'n_verify', `engine=${engine}: mutate must advance, not repair`)
    driver.endTurn()
  }
})

// ---------------------------------------------------------------------------
// 2b. Every composed stage classifies its own progress (P1-2/P1-3/P1-4)
// ---------------------------------------------------------------------------

for (const engine of ENGINES) {
  engineTest(`a composed mutate step with no tool repairs instead of advancing [${engine}]`, engine, async () => {
    const { graph, plan } = coreComposition()
    const driver = createGraphTurnDriver({ kernel: kernelOption(engine), graphProvider: () => graph })
    driver.adopt(plan)
    await driver.advance({ ok: true, tools: [{ name: 'read', isError: false }] })
    assert.equal(driver.current()?.id, 'n_mutate')
    // No tool call at all: the stage made no progress. The old success edge and
    // the unconditional fallback both pointed at `n_verify`, so this advanced
    // silently (P1-4).
    await driver.advance({ ok: true })
    assert.equal(driver.current()?.id, 'n_mutate_repair')
  })
}

for (const engine of ENGINES) {
  engineTest(`a composed inspect step with no tool repairs instead of advancing [${engine}]`, engine, async () => {
    const { graph, plan } = coreComposition()
    const driver = createGraphTurnDriver({ kernel: kernelOption(engine), graphProvider: () => graph })
    driver.adopt(plan)
    assert.equal(driver.current()?.id, 'n_inspect')
    await driver.advance({ ok: true })
    assert.equal(driver.current()?.id, 'n_inspect_repair')
  })
}

for (const engine of ENGINES) {
  engineTest(`a composed discover step with no tool repairs instead of advancing [${engine}]`, engine, async () => {
    // An investigative, non-mutating task composes discover -> inspect.
    const graph = graphOf({ tools: CORE_TOOLS })
    const envelope = buildEnvelope({ roles: [role('workspace-read'), role('workspace-search')] }, graph)
    const result = synthesizeComposition({
      fingerprint: fingerprint({ intent: 'code-question' }),
      graph,
      envelope: envelope.envelope,
    })
    assert.deepEqual(result.stages.map(stage => stage.stage), ['discover', 'inspect'])
    const driver = createGraphTurnDriver({ kernel: kernelOption(engine), graphProvider: () => graph })
    driver.adopt(result.plan)
    assert.equal(driver.current()?.id, 'n_discover')
    await driver.advance({ ok: true })
    assert.equal(driver.current()?.id, 'n_discover_repair')
  })
}

for (const engine of ENGINES) {
  engineTest(`a composed verify step that ran no tool repairs instead of answering [${engine}]`, engine, async () => {
    const { graph, plan } = coreComposition()
    const driver = createGraphTurnDriver({ kernel: kernelOption(engine), graphProvider: () => graph })
    driver.adopt(plan)
    await driver.advance({ ok: true, tools: [{ name: 'read', isError: false }] })
    await driver.advance({ ok: true, tools: [{ name: 'edit', isError: false }] })
    assert.equal(driver.current()?.id, 'n_verify')
    // `verificationFailed` is false when no verification ran; the verify success
    // exit must additionally require `verificationRan` (P1-3).
    await driver.advance({ ok: true })
    assert.equal(driver.current()?.id, 'n_verify_repair')
  })
}

for (const engine of ENGINES) {
  engineTest(`an author contracted for file.image repairs when only write(file.text) ran [${engine}]`, engine, async () => {
    const { graph, plan } = thirdPartyComposition()
    const driver = createGraphTurnDriver({ kernel: kernelOption(engine), graphProvider: () => graph })
    driver.adopt(plan)
    assert.equal(driver.current()?.id, 'n_author_0')
    // The step succeeded and produced a path artifact — but of the wrong type.
    // The author guard is the stage's own artifact contract (P1-2).
    await driver.advance({ ok: true, tools: [
      { name: 'write', isError: false, arguments: JSON.stringify({ file_path: join(tmpdir(), 'notes.txt') }) },
    ] })
    assert.equal(driver.current()?.id, 'n_author_0_repair')
  })
}

for (const engine of ENGINES) {
  engineTest(`an author contracted for file.image succeeds when that type is produced [${engine}]`, engine, async () => {
    const { graph, plan } = thirdPartyComposition()
    const driver = createGraphTurnDriver({ kernel: kernelOption(engine), graphProvider: () => graph })
    driver.adopt(plan)
    await driver.advance({ ok: true, tools: [
      { name: 'write', isError: false, arguments: JSON.stringify({ file_path: join(tmpdir(), 'render.png') }) },
    ] })
    assert.equal(driver.current()?.id, 'n_answer')
  })
}

for (const engine of ENGINES) {
  engineTest(`at maxSteps 5 a failed verify reaches the answer, not a repair dead end [${engine}]`, engine, async () => {
    // maxSteps 5: inspect, mutate, verify (fails with exit 1) leaves two steps:
    // one repair and the answer. The repair runs, then the budget exit hands the
    // last step to the tool-enabled answer.
    const graph = graphOf({ tools: CORE_TOOLS })
    const envelope = buildEnvelope({
      roles: [role('workspace-read'), role('workspace-write'), role('shell'), role('verification')],
    }, graph)
    const composed = synthesizeComposition({
      fingerprint: fingerprint({ intent: 'code-change', mutating: true }),
      graph,
      envelope: envelope.envelope,
      budget: { maxSteps: 5, maxReplans: 2 },
    })
    const driver = createGraphTurnDriver({ kernel: kernelOption(engine), maxSteps: 5, graphProvider: () => graph })
    driver.adopt(composed.plan)
    await driver.advance({ ok: true, tools: [{ name: 'read', isError: false }] })
    await driver.advance({ ok: true, tools: [{ name: 'edit', isError: false }] })
    await driver.advance({ ok: true, tools: [{ name: 'bash', isError: false, output: 'FAIL\n[exit code: 1]' }] })
    // Two steps remain at the failed verify: one repair, then the answer. The
    // failed verify and its non-zero exit remain observable in the trail even
    // though the turn eventually reports `done` (see docs/KERNEL-COVERAGE.md,
    // "Reserve boundary").
    assert.equal(driver.current()?.id, 'n_verify_repair', `engine=${engine}`)
    const verifyTrail = driver.snapshot().trail.find(row => row.id === 'n_verify')
    assert.match(verifyTrail?.tools?.[0]?.output ?? '', /\[exit code: 1\]/u)
    await driver.advance({ ok: true })
    assert.equal(driver.current()?.id, 'n_answer', `engine=${engine}`)
    assert.notEqual(driver.status?.(), 'failed')
    await driver.advance({ ok: true })
    assert.equal(driver.status?.(), 'done', `engine=${engine}`)
    driver.endTurn()
  })
}

test('failedTool is step-scoped: a nameless failure does not reuse the previous step name (P2-1)', async () => {
  // `b` has a `callFailed(read)` recovery edge and a tool-agnostic
  // `lastOk=false` edge. A step that fails without naming a tool must reach the
  // read edge; a sticky `failedTool=bash` from the previous step used to block
  // it and fall to `d`.
  const plan = planOf(
    [
      { from: 'a', to: 'b', kind: 'control', when: { op: 'callFailed', tool: 'bash' } },
      { from: 'a', to: 'd', kind: 'control', when: { op: 'fact', key: 'lastOk', equals: false } },
      { from: 'b', to: 'c', kind: 'control', when: { op: 'callFailed', tool: 'read' } },
      { from: 'b', to: 'd', kind: 'control', when: { op: 'fact', key: 'lastOk', equals: false } },
    ],
    { terminals: ['c', 'd'], maxSteps: 6 },
  )
  assert.equal(validateTaskPlan(graphOf({ tools: [] }), plan).ok, true)
  for (const engine of ENGINES) {
    const driver = createGraphTurnDriver({ kernel: kernelOption(engine) })
    driver.adopt(plan)
    assert.equal(driver.current()?.id, 'a')
    // Step 1 fails through bash, so `a` names the failing tool.
    await driver.advance({ ok: false, failedTool: 'bash' })
    assert.equal(driver.current()?.id, 'b')
    // Step 2 fails with no named tool: `callFailed(read)` must match.
    await driver.advance({ ok: false })
    assert.equal(driver.current()?.id, 'c', `engine=${engine}: the stale bash failure name must not block the read recovery`)
    driver.endTurn()
  }
})

// ---------------------------------------------------------------------------
// 3. Third-party/MCP author outcomes
// ---------------------------------------------------------------------------

for (const engine of ENGINES) {
  engineTest(`a third-party author succeeds when its declared artifact is observed [${engine}]`, engine, async () => {
    const { graph, plan } = thirdPartyComposition()
    const driver = createGraphTurnDriver({ kernel: kernelOption(engine), graphProvider: () => graph })
    driver.adopt(plan)
    assert.equal(driver.current()?.id, 'n_author_0')
    await driver.advance({ ok: true, tools: [{ name: 'acme_render', isError: false }] })
    assert.equal(driver.current()?.id, 'n_answer')
    await driver.advance({ ok: true })
    assert.equal(driver.status?.(), 'done')
    driver.endTurn()
  })
}

for (const engine of ENGINES) {
  engineTest(`a third-party author that fails or produces nothing repairs instead of passing through [${engine}]`, engine, async () => {
    const { graph, plan } = thirdPartyComposition()

    // Tool-invocation failure: the step fails and the author's repair exit runs.
    const failed = createGraphTurnDriver({ kernel: kernelOption(engine), graphProvider: () => graph })
    failed.adopt(plan)
    await failed.advance({ ok: false, failedTool: 'acme_render', tools: [{ name: 'acme_render', isError: true }] })
    assert.equal(failed.current()?.id, 'n_author_0_repair')
    // The repair performs the author's work: it has the same success exit and
    // advances to the next node (the answer), not back to the author stage.
    await failed.advance({ ok: true, tools: [{ name: 'acme_render', isError: false }] })
    assert.equal(failed.current()?.id, 'n_answer', 'repair success must advance, not restart the author')
    await failed.advance({ ok: true })
    assert.equal(failed.status?.(), 'done')
    failed.endTurn()

    // "Success" with no observable artifact (no tool ran): the author's own
    // step produced nothing, so it repairs rather than silently skipping its
    // artifact contract.
    const empty = createGraphTurnDriver({ kernel: kernelOption(engine), graphProvider: () => graph })
    empty.adopt(plan)
    await empty.advance({ ok: true })
    assert.equal(empty.current()?.id, 'n_author_0_repair')
    empty.endTurn()

    // A different successful tool is not the planned author tool: it must not be
    // credited with the declared artifact (P1-2).
    const wrongTool = createGraphTurnDriver({ kernel: kernelOption(engine), graphProvider: () => graph })
    wrongTool.adopt(plan)
    await wrongTool.advance({ ok: true, tools: [{ name: 'read', isError: false }] })
    assert.equal(wrongTool.current()?.id, 'n_author_0_repair')
    wrongTool.endTurn()
  })
}

for (const engine of ENGINES) {
  engineTest(`an earlier stage artifact cannot satisfy a later author [${engine}]`, engine, async () => {
    // `document` intent + a requested file.text composes inspect (acme_read) and
    // an author filled by the same tool. The inspect step produces file.text, so
    // the run-cumulative artifact array already contains it when the author runs;
    // the author's own step produced no artifact and must still repair.
    const { graph, plan } = thirdPartyComposition('document', ['file.text'])
    const stageIds = plan.nodes.filter(node => !node.id.endsWith('_repair')).map(node => node.id)
    assert.ok(stageIds.indexOf('n_inspect') !== -1 && stageIds.indexOf('n_inspect') < stageIds.indexOf('n_author_0'))

    const driver = createGraphTurnDriver({ kernel: kernelOption(engine), graphProvider: () => graph })
    driver.adopt(plan)
    assert.equal(driver.current()?.id, 'n_inspect')
    await driver.advance({ ok: true, tools: [{ name: 'acme_read', isError: false }] })
    assert.equal(driver.current()?.id, 'n_author_0')
    await driver.advance({ ok: true })
    assert.equal(driver.current()?.id, 'n_author_0_repair', 'the earlier stage file.text must not satisfy the author')
    driver.endTurn()
  })
}

// ---------------------------------------------------------------------------
// 4. Budget at the boundary
// ---------------------------------------------------------------------------

test('the budget guard fires at maxSteps - 1 and maxSteps - 2 on every engine', async () => {
  // After one completed node the remaining count is maxSteps - 1.
  for (const engine of ENGINES) {
    const route = await walk(engine, budgetPlan(4, 3), [{ ok: true }])
    assert.deepEqual(route.nodes, ['a', 'b'], `engine=${engine}`)
  }
  for (const engine of ENGINES) {
    const route = await walk(engine, budgetPlan(4, 2), [{ ok: true }])
    assert.deepEqual(route.nodes, ['a', 'c'], `engine=${engine}`)
  }
  // After two completed nodes the remaining count is maxSteps - 2; the guard
  // that did not fire after `a` fires after `x` on every engine.
  for (const engine of ENGINES) {
    const route = await walk(engine, chainBudgetPlan(4, 2), [{ ok: true }, { ok: true }])
    assert.deepEqual(route.nodes, ['a', 'x', 'b'], `engine=${engine}`)
    assert.equal(route.status, 'done')
  }
})

test('the last planned step keeps its budget-routed wrap-up node (frontier and kernel reserve)', async () => {
  // maxSteps 1: after `a`, the budget guard (remainingAtMost 0) routes to the
  // terminal `b`. Both engines grant the one step that lets that wrap-up run,
  // so the same plan has the same route and status on every engine.
  for (const engine of ENGINES) {
    const driver = createGraphTurnDriver({ kernel: engine === 'frontier' ? 'off' : engine })
    driver.adopt(budgetPlan(1, 0))
    await driver.advance({ ok: true })
    assert.equal(driver.current()?.id, 'b', `engine=${engine}`)
    await driver.advance({ ok: true })
    assert.equal(driver.status?.(), 'done', `engine=${engine}`)
    assert.deepEqual(driver.snapshot().trail.map(row => row.id), ['a', 'b'], `engine=${engine}`)
    driver.endTurn()
  }
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

  const stepGuard = planOf(
    [{ from: 'a', to: 'b', kind: 'control', when: { op: 'budget', axis: 'steps', remainingAtMost: 1 } }],
    { nodes: ['a', 'b'], terminals: ['b'] },
  )
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

for (const engine of ENGINES) {
  engineTest(`a composed verify step that ran only read repairs instead of answering [${engine}]`, engine, async () => {
    const { graph, plan } = coreComposition()
    const driver = createGraphTurnDriver({ kernel: kernelOption(engine), graphProvider: () => graph })
    driver.adopt(plan)
    await driver.advance({ ok: true, tools: [{ name: 'read', isError: false }] })
    await driver.advance({ ok: true, tools: [{ name: 'edit', isError: false }] })
    assert.equal(driver.current()?.id, 'n_verify')
    // "A tool ran" is not "the verification ran": the planned capability is
    // `bash`, so a read-only step must repair rather than pass.
    await driver.advance({ ok: true, tools: [{ name: 'read', isError: false }] })
    assert.equal(driver.current()?.id, 'n_verify_repair')
  })
}
