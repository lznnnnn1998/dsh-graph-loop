/**
 * Unit tests for the shipped template library.
 *
 * Run: node --import tsx --test test/unit/core-*.test.ts
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'

import { GRAPH_LIMITS, validateTaskPlan, type TaskPlan } from '../../packages/core/src/graph-schema.ts'
import { DEFAULT_WEIGHTS, match, type TaskFingerprint, type TaskTemplate } from '../../packages/core/src/matching.ts'
import { buildRegistrySnapshot } from '../../packages/core/src/registry.ts'
import {
  FALLBACK_TEMPLATE_ID,
  TEMPLATE_LIBRARY,
  TEMPLATE_LIBRARY_TEMPLATES,
  templateById,
} from '../../packages/core/src/templates.ts'

const EXPECTED_IDS = ['t_investigate', 't_edit_test', 't_bugfix', 't_research', 't_doc', 't_stock'] as const
const ALL_TOOL_NAMES = [...new Set(TEMPLATE_LIBRARY_TEMPLATES.flatMap((template) => template.toolUniverse))]

/** A registry over every tool the library references (the `explore` preset's universe). */
const SAMPLE_GRAPH = buildRegistrySnapshot({ tools: ALL_TOOL_NAMES.map((name) => ({ name })) }).graph

function fingerprintFor(template: TaskTemplate): TaskFingerprint {
  return {
    hash: '0123456789abcdef',
    intent: template.appliesTo.intent[0] ?? 'other',
    artifactsIn: [...(template.appliesTo.artifactsIn ?? ['path.locator'])],
    artifactsOut: [...(template.appliesTo.artifactsOut ?? [])],
    mutating: template.appliesTo.mutating ?? false,
    parallelizable: false,
    risk: 'medium',
    contextBucket: 1,
    surface: 'cli',
    hints: [],
    workspace: { hasGit: true, hasPackageJson: true, hasTests: true, hasPython: false, languages: ['ts'] },
    textLength: 64,
  }
}

function instantiate(template: TaskTemplate): TaskPlan {
  const fingerprint = fingerprintFor(template)
  const result = match({
    fingerprint,
    graph: SAMPLE_GRAPH,
    library: { version: 1, templates: [template], fallbackId: template.id },
    cooccurrence: new Map(),
    weights: DEFAULT_WEIGHTS,
    presetId: 'explore',
    presetTools: template.toolUniverse,
  })
  return result.plan
}

test('library shape: six templates, cold gating, fallback present', () => {
  assert.equal(TEMPLATE_LIBRARY.templates.length, 6)
  assert.deepEqual(
    TEMPLATE_LIBRARY.templates.map((template) => template.id),
    [...EXPECTED_IDS],
  )
  assert.equal(TEMPLATE_LIBRARY.fallbackId, FALLBACK_TEMPLATE_ID)
  assert.equal(TEMPLATE_LIBRARY.fallbackId, 't_stock')
  assert.ok(TEMPLATE_LIBRARY.version >= 1)
  assert.deepEqual(templateById('t_edit_test')?.id, 't_edit_test')
  assert.equal(templateById('nope'), undefined)

  for (const template of TEMPLATE_LIBRARY_TEMPLATES) {
    assert.equal(template.gatePolicy, 'cold', `${template.id} must be cold-gated`)
    assert.ok(template.risk >= 0 && template.risk <= 1, `${template.id} risk in [0,1]`)
    assert.ok(template.appliesTo.intent.length > 0, `${template.id} declares intents`)
    assert.ok(template.label.length > 0)
  }
})

test('every template references real, visible tools and stays inside its own universe', () => {
  for (const template of TEMPLATE_LIBRARY_TEMPLATES) {
    assert.ok(template.toolUniverse.length > 0, `${template.id} has a tool universe`)
    for (const name of template.toolUniverse) {
      const node = SAMPLE_GRAPH.nodes.find((candidate) => candidate.kind === 'tool' && candidate.tool?.name === name)
      assert.ok(node, `${template.id} references missing tool ${name}`)
      assert.equal(node?.tool?.dynamic, false)
      assert.equal(node?.tool?.conditional, false)
    }
    for (const [slotName, spec] of Object.entries(template.slots)) {
      assert.ok(spec.choose.length > 0, `${template.id}.${slotName} has candidates`)
      for (const name of spec.choose) {
        assert.ok(template.toolUniverse.includes(name), `${template.id}.${slotName} candidate ${name} is in the universe`)
        assert.ok(
          SAMPLE_GRAPH.nodes.some((node) => node.kind === 'tool' && node.tool?.name === name),
          `${template.id}.${slotName} candidate ${name} is in the graph`,
        )
      }
    }
    // synthesizeNodes() chains slots in alphabetical order; the template must be authored for that.
    assert.deepEqual(Object.keys(template.slots), [...Object.keys(template.slots)].sort())
  }
  // The fallback can reach every tool any other template needs, so it can always stand in.
  const stock = templateById('t_stock')
  assert.ok(stock)
  for (const template of TEMPLATE_LIBRARY_TEMPLATES) {
    for (const name of template.toolUniverse) {
      assert.ok(stock?.toolUniverse.includes(name), `t_stock universe misses ${name} needed by ${template.id}`)
    }
  }
})

test('budgets are sane and fixed-node instructions are short', () => {
  for (const template of TEMPLATE_LIBRARY_TEMPLATES) {
    const budget = template.budget
    assert.ok(Number.isInteger(budget.maxNodes) && budget.maxNodes >= 1)
    assert.ok(budget.maxNodes <= GRAPH_LIMITS.maxPlanNodes, `${template.id} maxNodes within the plan ceiling`)
    assert.ok(Number.isInteger(budget.maxSteps) && budget.maxSteps >= 1)
    assert.ok(Number.isInteger(budget.maxTokens) && budget.maxTokens > 0)
    assert.ok(Number.isInteger(budget.maxWallMs) && budget.maxWallMs > 0)
    assert.ok(Number.isInteger(budget.maxReplans) && budget.maxReplans >= 0)
    for (const node of template.fixedNodes ?? []) {
      assert.ok((node.instruction?.length ?? 0) < 200, `${template.id}.${node.id} instruction stays under 200 chars`)
    }
  }
})

test('t_stock is a single-pass fallback graph with a terminal node', () => {
  const stock = templateById(FALLBACK_TEMPLATE_ID)
  assert.ok(stock)
  assert.deepEqual(stock?.slots, {})
  const nodes = stock?.fixedNodes ?? []
  assert.equal(nodes.length, 2)
  assert.equal(nodes[0]?.kind, 'agent-step')
  assert.equal(nodes[1]?.kind, 'terminal')
  const edges = stock?.fixedEdges ?? []
  assert.equal(edges.length, 1)
  assert.equal(edges[0]?.from, 'n_step')
  assert.equal(edges[0]?.to, 'n_end')
  assert.equal(edges[0]?.kind, 'control')
  const plan = instantiate(stock as TaskTemplate)
  assert.equal(plan.fallback, true, 'the fallback template is marked fallback')
  assert.equal(plan.templateId, FALLBACK_TEMPLATE_ID)
  assert.equal(validateTaskPlan(SAMPLE_GRAPH, plan).ok, true)
})

test('every template instantiates to a structurally valid plan', () => {
  for (const template of TEMPLATE_LIBRARY_TEMPLATES) {
    const plan = instantiate(template)
    const validation = validateTaskPlan(SAMPLE_GRAPH, plan)
    assert.equal(
      validation.ok,
      true,
      `${template.id}: ${validation.errors.map((error) => `${error.code} ${error.path}: ${error.message}`).join('; ')}`,
    )
    assert.equal(plan.templateId, template.id)
    assert.ok(plan.nodes.some((node) => node.id === plan.entry))
    assert.ok(plan.terminals.length >= 1, `${template.id} has a terminal`)
    for (const terminal of plan.terminals) {
      assert.equal(plan.edges.some((edge) => edge.from === terminal), false, `${template.id} terminal has no outgoing edge`)
    }
    assert.deepEqual([...plan.toolUniverse], [...template.toolUniverse])
    assert.equal(plan.gatePolicy, 'cold')

    const slotNodes = plan.nodes.filter((node) => node.kind === 'tool-call')
    assert.equal(slotNodes.length, Object.keys(template.slots).length, `${template.id} instantiates one node per slot`)
    for (const node of slotNodes) {
      const name = node.capabilityId?.replace(/^tool:/u, '') ?? ''
      assert.ok(template.toolUniverse.includes(name), `${template.id} binds ${name} inside its universe`)
      assert.ok(plan.toolUniverse.includes(name))
    }
  }
})

test('slot templates execute in declared order (read -> edit -> test, etc.)', () => {
  const editTest = instantiate(templateById('t_edit_test') as TaskTemplate)
  assert.deepEqual(
    editTest.nodes.filter((node) => node.kind !== 'terminal').map((node) => node.id),
    ['n_discover', 'n_patch', 'n_test'],
  )
  const bugfix = instantiate(templateById('t_bugfix') as TaskTemplate)
  assert.deepEqual(
    bugfix.nodes.filter((node) => node.kind !== 'terminal').map((node) => node.id),
    ['n_confirm', 'n_repair', 'n_test'],
  )
  const research = instantiate(templateById('t_research') as TaskTemplate)
  assert.deepEqual(
    research.nodes.filter((node) => node.kind !== 'terminal').map((node) => node.id),
    ['n_gather', 'n_read', 'n_report'],
  )
  const doc = instantiate(templateById('t_doc') as TaskTemplate)
  assert.deepEqual(
    doc.nodes.filter((node) => node.kind !== 'terminal').map((node) => node.id),
    ['n_gather', 'n_produce', 'n_send'],
  )
})
