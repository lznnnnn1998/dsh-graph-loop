/**
 * Regressions for defects found by reading the execution path, not by the
 * happy-path suite. Each test names the behavior it pins and fails on the
 * parent commit.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'

import { synthesizeComposition } from '../../packages/core/src/compose.ts'
import { buildEnvelope, defaultRole, selectEnvelopeForTask } from '../../packages/core/src/envelope.ts'
import { validateTaskPlan, type RegistryGraph, type TaskPlan } from '../../packages/core/src/graph-schema.ts'
import { extractFingerprint, isAdmissible, type TaskFingerprint } from '../../packages/core/src/matching.ts'
import { validateProposal } from '../../packages/core/src/proposal.ts'
import { applyAnnotations, buildRegistrySnapshot, type RegistrySources, type ToolSource } from '../../packages/core/src/registry.ts'
import { TEMPLATE_LIBRARY } from '../../packages/core/src/templates.ts'
import { createGraphTurnDriver } from '../../packages/loop/src/scheduler.ts'
import { canKernelDrive } from '../../packages/loop/src/kernel/topology.ts'
import { deriveStepFacts } from '../../packages/loop/src/step-facts.ts'
import { mutationObserved, readObserved } from '../../packages/loop/src/loop/step-tools.ts'

const CORE_TOOLS: ToolSource[] = [
  { name: 'read' }, { name: 'glob' }, { name: 'grep' }, { name: 'write' },
  { name: 'edit' }, { name: 'bash' }, { name: 'present' },
]

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

function planOf(
  edges: TaskPlan['edges'],
  options: { readonly terminals?: readonly string[]; readonly maxSteps?: number; readonly nodes?: readonly string[] } = {},
): TaskPlan {
  const ids = options.nodes ?? ['a', 'b', 'c', 'd']
  return {
    id: 'regression',
    templateId: 'test',
    version: 1,
    entry: ids[0]!,
    terminals: options.terminals ?? [ids[ids.length - 1]!],
    nodes: ids.map(id => ({ id, kind: 'agent-step', executor: 'step', instruction: `run ${id}` })),
    edges,
    budget: { maxNodes: ids.length, maxSteps: options.maxSteps ?? 6, maxTokens: 10_000, maxWallMs: 60_000, maxReplans: 0 },
    toolUniverse: [],
    gatePolicy: 'cold',
    fallback: false,
    confidence: 1,
    compiledDigest: 'regression',
  }
}

// ---------------------------------------------------------------------------
// Parallel batch completion
// ---------------------------------------------------------------------------

test('concurrent subagent completions advance each node once and leave the join current', async () => {
  const plan: TaskPlan = {
    ...planOf([], { nodes: ['p', 's1', 's2', 'ans'], terminals: ['ans'] }),
    id: 'batch-join',
    nodes: [
      { id: 'p', kind: 'agent-step', executor: 'step', instruction: 'plan' },
      { id: 's1', kind: 'agent-step', executor: 'subagent', instruction: 'branch one' },
      { id: 's2', kind: 'agent-step', executor: 'subagent', instruction: 'branch two' },
      { id: 'ans', kind: 'agent-step', executor: 'step', instruction: 'answer' },
    ],
    edges: [
      { from: 'p', to: 's1', kind: 'control' }, { from: 'p', to: 's2', kind: 'control' },
      { from: 's1', to: 'ans', kind: 'control' }, { from: 's2', to: 'ans', kind: 'control' },
    ],
  }
  const driver = createGraphTurnDriver({ kernel: 'off' })
  driver.adopt(plan)
  await driver.advance({ ok: true, tools: [] })
  const batch = driver.takeSubagentBatch()
  assert.deepEqual(batch.map(node => node.id), ['s1', 's2'])
  await Promise.all(batch.map(node => driver.completeNode(node.id, true)))
  // The two children settle the join; the answer has NOT run yet. The bug
  // completed the terminal with the wrong child's outcome and reported done.
  assert.equal(driver.planState(), 'running')
  assert.equal(driver.current()?.id, 'ans')
  assert.deepEqual(driver.snapshot().trail.map(row => row.id), ['p', 's1', 's2'])
  await driver.advance({ ok: true, tools: [] })
  assert.equal(driver.planState(), 'terminal')
  assert.deepEqual(driver.snapshot().trail.map(row => row.id), ['p', 's1', 's2', 'ans'])
})

// ---------------------------------------------------------------------------
// Model-authored plans
// ---------------------------------------------------------------------------

test('a proposed agent step keeps the plan universe instead of becoming answer-only', () => {
  const graph = graphOf({ tools: [{ name: 'read' }] })
  const result = validateProposal({
    entry: 'n1',
    nodes: [
      { id: 'n1', kind: 'agent-step', instruction: 'read and fix the bug' },
      { id: 'n2', kind: 'terminal' },
    ],
    edges: [{ from: 'n1', to: 'n2' }],
  }, graph, ['read'])
  assert.equal(result.ok, true, result.errors.join('; '))
  assert.equal(result.plan?.nodes.find(node => node.id === 'n1')?.toolAllow, undefined)
  assert.deepEqual(result.plan?.nodes.find(node => node.id === 'n2')?.toolAllow, [])
})

test('invalid condition payloads are proposal errors, not inert or always-true guards', () => {
  const graph = graphOf({ tools: [{ name: 'read' }] })
  const base = {
    entry: 'n1',
    nodes: [{ id: 'n1', tool: 'read' }, { id: 'n2', kind: 'terminal' }],
  }
  const missingEquals = validateProposal({
    ...base,
    edges: [{ from: 'n1', to: 'n2', when: { op: 'fact', key: 'testsPass' } }],
  }, graph, ['read'])
  assert.equal(missingEquals.ok, false)

  const badArtifact = validateProposal({
    ...base,
    edges: [{ from: 'n1', to: 'n2', when: { op: 'artifact', type: 'file.txt' } }],
  }, graph, ['read'])
  assert.equal(badArtifact.ok, false)

  const negativeBudget = validateProposal({
    ...base,
    edges: [{ from: 'n1', to: 'n2', when: { op: 'budget', axis: 'steps', remainingAtMost: -1 } }],
  }, graph, ['read'])
  assert.equal(negativeBudget.ok, false)
})

test('two guards on the same from/to edge are both kept', () => {
  const graph = graphOf({ tools: [{ name: 'read' }] })
  const result = validateProposal({
    entry: 'n1',
    nodes: [{ id: 'n1', tool: 'read' }, { id: 'n2', kind: 'terminal' }],
    edges: [
      { from: 'n1', to: 'n2', when: { op: 'callFailed', tool: 'bash' } },
      { from: 'n1', to: 'n2', when: { op: 'artifact', type: 'file.patch' } },
    ],
  }, graph, ['read'])
  assert.equal(result.ok, true, result.errors.join('; '))
  const guards = result.plan?.edges.filter(edge => edge.from === 'n1' && edge.to === 'n2') ?? []
  assert.equal(guards.length, 2)
})

// ---------------------------------------------------------------------------
// Terminal / dead-end semantics
// ---------------------------------------------------------------------------

test('a guarded exit that does not match drains the plan to finished, not failed, on every engine', async () => {
  // A plan that ran out of enabled work is not a failed run: no terminal ran,
  // so the plan is `finished` and the turn boundary — not the plan — decides
  // whether the turn keeps working. Only a bad outcome or an exhausted budget
  // stays `failed`.
  const plan = planOf(
    [{ from: 'b', to: 't', kind: 'control', when: { op: 'fact', key: 'never', equals: true } }],
    { nodes: ['b', 't'], terminals: ['t'] },
  )
  for (const engine of ['frontier', 'minimal', 'langgraph'] as const) {
    const driver = createGraphTurnDriver({ kernel: engine === 'frontier' ? 'off' : engine })
    driver.adopt(plan)
    await driver.advance({ ok: true, tools: [] })
    assert.equal(driver.planState(), 'finished', `engine=${engine}`)
    assert.notEqual(driver.status?.(), 'failed', `engine=${engine}`)
    assert.equal(driver.current(), undefined, `engine=${engine}`)
    assert.equal(driver.snapshot().planId, 'regression', `engine=${engine}: no plan was installed`)
    assert.equal(driver.snapshot().trail.length, 1, `engine=${engine}`)
    driver.endTurn()
  }
})

test('an unreachable terminal and duplicate node ids are validation errors', () => {
  const graph = graphOf({ tools: [] })
  const unreachable = planOf([], { nodes: ['a', 't'], terminals: ['t'] })
  const unreachableResult = validateTaskPlan(graph, unreachable)
  assert.equal(unreachableResult.ok, false)
  assert.ok(unreachableResult.errors.some(error => error.code === 'P025'), unreachableResult.errors.map(error => error.code).join(','))

  const duplicate = planOf([], { nodes: ['a', 'a', 't'], terminals: ['t'] })
  const duplicateResult = validateTaskPlan(graph, duplicate)
  assert.equal(duplicateResult.ok, false)
  assert.ok(duplicateResult.errors.some(error => error.code === 'P024'), duplicateResult.errors.map(error => error.code).join(','))
})

test('an Object.prototype name is not kernel-drivable', () => {
  const plan = planOf([{ from: 'constructor', to: 't', kind: 'control' }], { nodes: ['constructor', 't'], terminals: ['t'] })
  assert.equal(canKernelDrive(plan), false)
})

// ---------------------------------------------------------------------------
// Budgets
// ---------------------------------------------------------------------------

test('maxSteps bounds the turn across a replan, including a verify repair chain', async () => {
  const base = planOf(
    [
      { from: 'd_verify', to: 'd_verify', kind: 'control', when: { op: 'fact', key: 'lastOk', equals: false } },
      { from: 'd_verify', to: 't', kind: 'control' },
    ],
    { nodes: ['d_verify', 't'], terminals: ['t'], maxSteps: 2 },
  )
  // A verify failure installs a repair plan with its own maxReplans; without the
  // trail guard, the second repair could install another one-step plan and run
  // past maxSteps (trail 4 at maxSteps 3).
  const plan: TaskPlan = { ...base, budget: { ...base.budget, maxReplans: 2 } }
  const driver = createGraphTurnDriver({ kernel: 'off', maxSteps: 3 })
  driver.adopt(plan)
  for (let index = 0; index < 8 && !driver.planFinished(); index += 1) {
    await driver.advance({ ok: false, tools: [] })
  }
  assert.equal(driver.snapshot().trail.length, 3, 'the recovery plan must not reset the turn allowance')
  assert.equal(driver.status?.(), 'failed')
})

test('a composed plan runs all stages when maxSteps equals stages plus one', async () => {
  const graph = graphOf({ tools: CORE_TOOLS })
  const envelope = buildEnvelope({
    roles: ['workspace-read', 'workspace-search', 'workspace-write', 'shell', 'verification', 'delivery']
      .map(name => defaultRole(name)!)
      .filter(role => role !== undefined),
  }, graph)
  const composed = synthesizeComposition({
    fingerprint: fingerprint({ intent: 'code-change', mutating: true }),
    graph,
    envelope: envelope.envelope,
    budget: { maxSteps: 4 },
  })
  assert.deepEqual(composed.stages.map(stage => stage.stage), ['inspect', 'mutate', 'verify'])
  const driver = createGraphTurnDriver({ kernel: 'off', maxSteps: 4, graphProvider: () => graph })
  driver.adopt(composed.plan)
  await driver.advance({ ok: true, tools: [{ name: 'read', isError: false }] })
  await driver.advance({ ok: true, tools: [{ name: 'write', isError: false, arguments: '{"file_path":"out.txt"}' }] })
  assert.equal(driver.current()?.id, 'n_verify', 'the reserve must not skip the last stage')
  await driver.advance({ ok: true, tools: [{ name: 'bash', isError: false, output: '[exit code: 0]' }] })
  assert.equal(driver.current()?.id, 'n_answer')
  await driver.advance({ ok: true, tools: [] })
  assert.equal(driver.planState(), 'terminal')
})

// ---------------------------------------------------------------------------
// Selection and facts
// ---------------------------------------------------------------------------

test('unannotated preset tools stay in the dynamic envelope; curated tools still narrow', () => {
  const graph = graphOf({ tools: [{ name: 'read' }, { name: 'write' }, { name: 'acme_tool', packageName: '@acme/x' }] })
  const selection = selectEnvelopeForTask({
    fingerprint: fingerprint(),
    graph,
    presetTools: ['read', 'write', 'acme_tool'],
    includePresetTools: false,
  })
  assert.ok(selection.envelope.tools.universe.includes('acme_tool'))
  assert.ok(!selection.envelope.tools.universe.includes('write'))
})

test('compose does not fill an author stage with a read-only producer', () => {
  const annotated = applyAnnotations(
    [{ name: 'acme_read', packageName: '@acme/x' }, { name: 'write' }],
    [{ tool: 'acme_read', permission: 'read-only', tags: ['filesystem'], produces: [{ type: 'file.text', required: true }] }],
  )
  const graph = graphOf({ tools: annotated.tools })
  const envelope = buildEnvelope({ roles: [], extraTools: ['acme_read', 'write'] }, graph)
  const result = synthesizeComposition({
    fingerprint: fingerprint({ intent: 'document' }),
    graph,
    envelope: envelope.envelope,
    budget: { maxSteps: 8 },
  })
  const author = result.stages.find(stage => stage.stage === 'author')
  assert.ok(author !== undefined, 'the fixture must compose an author')
  assert.notEqual(author.toolName, 'acme_read')
})

test('lexicon terms are word-bounded, not substrings', () => {
  const at = (text: string): TaskFingerprint => extractFingerprint({
    text,
    surface: 'web',
    contextTokens: 0,
    attachments: [],
    workspace: { hasGit: true, hasPackageJson: true, hasTests: true, hasPython: false, languages: ['ts'] },
    visibleTools: [],
  })
  assert.notEqual(at('inspect the config').intent, 'document')
  assert.equal(at('explain how the credit system works').mutating, false)
  assert.notEqual(at('why does the address parser reject ipv6').intent, 'code-change')
  assert.equal(at('implement the fixture loader').intent, 'code-change')
})

test('a mutation template is not admissible for a read-only document task', () => {
  const graph = graphOf({ tools: CORE_TOOLS })
  const tDoc = TEMPLATE_LIBRARY.templates.find(template => template.id === 't_doc')
  assert.ok(tDoc !== undefined)
  assert.equal(isAdmissible(tDoc, fingerprint({ intent: 'document', mutating: false }), graph), false)
})

test('exit codes are read only from shell output; per-tool facts are explicit', () => {
  const readLog = deriveStepFacts([{ name: 'read', isError: false, output: 'a failed run left [exit code: 1] in the trail' }], true)
  assert.equal(readLog['verificationFailed'], false)
  const shellFail = deriveStepFacts([{ name: 'bash', isError: false, output: '[exit code: 1]' }], true)
  assert.equal(shellFail['verificationFailed'], true)

  const failed = deriveStepFacts([{ name: 'edit', isError: true }], false)
  assert.equal(failed['tool.edit.failed'], true)
  const recovered = deriveStepFacts([{ name: 'write', isError: false }], true)
  assert.equal(recovered['tool.write.failed'], false)
})

test('shell effects: open-read is not a write, split-flag -c is, heredoc body is data', () => {
  const bash = (command: string): { name: string; isError: boolean; arguments: string } =>
    ({ name: 'bash', isError: false, arguments: JSON.stringify({ command }) })
  const openRead = bash(`python3 -c "print(open('workspace.json').read())"`)
  assert.equal(mutationObserved([openRead]), false)
  assert.equal(mutationObserved([bash('bash -e -c "cat > f"')]), true)
  assert.equal(mutationObserved([bash("git commit -F - <<'EOF'\nfix: rm stale\nEOF")]), false)
})

test('the snapshot visited list is the run order, not the plan prefix', async () => {
  const plan: TaskPlan = {
    ...planOf([{ from: 'b', to: 't', kind: 'control' }], { nodes: ['a', 'b', 't'], terminals: ['t'] }),
    entry: 'b',
  }
  const driver = createGraphTurnDriver({ kernel: 'off' })
  driver.adopt(plan)
  await driver.advance({ ok: true, tools: [] })
  assert.deepEqual(driver.snapshot().visited, ['b'])
})
