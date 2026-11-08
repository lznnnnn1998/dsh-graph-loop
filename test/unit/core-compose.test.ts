/**
 * Unit tests for capability-driven plan synthesis (0.2 composition layer).
 *
 * Run: node --import tsx --test test/unit/core-compose.test.ts
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'

import { synthesizeComposition } from '../../packages/core/src/compose.ts'
import { buildEnvelope, defaultRole, type CapabilityRoleSpec } from '../../packages/core/src/envelope.ts'
import { validateTaskPlan, type RegistryGraph } from '../../packages/core/src/graph-schema.ts'
import type { TaskFingerprint } from '../../packages/core/src/matching.ts'
import {
  applyAnnotations,
  buildRegistrySnapshot,
  type RegistrySources,
  type ToolSource,
} from '../../packages/core/src/registry.ts'

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

test('a code change composes inspect → mutate → verify', () => {
  const graph = graphOf({ tools: CORE_TOOLS })
  const envelope = buildEnvelope({
    roles: [
      role('workspace-read'),
      role('workspace-search'),
      role('workspace-write'),
      role('shell'),
      role('verification'),
      role('delivery'),
    ],
  }, graph)
  assert.equal(envelope.fallbackToStock, false)

  const result = synthesizeComposition({
    fingerprint: fingerprint({ intent: 'code-change', mutating: true }),
    graph,
    envelope: envelope.envelope,
  })

  assert.equal(result.plan.templateId, 't_compose')
  assert.equal(result.plan.fallback, false)
  assert.deepEqual(result.stages.map(stage => stage.stage), ['inspect', 'mutate', 'verify'])
  const capabilityIds = new Set(result.stages.map(stage => stage.capabilityId))
  assert.ok(capabilityIds.has('tool:write') || capabilityIds.has('tool:edit'), 'mutate must use a mutation tool')
  for (const capability of ['tool:read', 'tool:bash']) {
    assert.ok(capabilityIds.has(capability), `expected ${capability} in ${[...capabilityIds].join(',')}`)
  }
  assert.equal(validateTaskPlan(graph, result.plan).ok, true)
})

test('craft-like third-party tools fill author stages without any hardcoded name', () => {
  const annotated = applyAnnotations(
    [
      { name: 'acme_read', packageName: '@acme/widgets' },
      { name: 'acme_render', packageName: '@acme/widgets' },
      { name: 'acme_deck', packageName: '@acme/widgets' },
      { name: 'present' },
    ],
    [
      {
        tool: 'acme_read',
        permission: 'read-only',
        tags: ['filesystem'],
        produces: [{ type: 'file.text', required: true }],
      },
      {
        tool: 'acme_render',
        tags: ['authoring', 'image'],
        produces: [{ type: 'file.image', required: true }],
      },
      {
        tool: 'acme_deck',
        tags: ['authoring', 'presentation'],
        produces: [{ type: 'file.binary', required: true }],
      },
    ],
  )
  assert.equal(annotated.unmatched.length, 0)
  const graph = graphOf({ tools: annotated.tools })
  const envelope = buildEnvelope({
    roles: [
      { role: 'read', implementations: ['acme_read'] },
      { role: 'render', implementations: ['acme_render'] },
      { role: 'deck', implementations: ['acme_deck'] },
      role('delivery'),
    ],
  }, graph)
  assert.equal(envelope.fallbackToStock, false)

  const result = synthesizeComposition({
    fingerprint: fingerprint({ intent: 'document' }),
    graph,
    envelope: envelope.envelope,
    requestedArtifacts: ['file.image', 'file.binary'],
  })

  assert.equal(result.plan.fallback, false)
  assert.ok(result.stages.some(stage => stage.capabilityId === 'tool:acme_render'))
  assert.ok(result.stages.some(stage => stage.capabilityId === 'tool:acme_deck'))
  assert.ok(!result.stages.some(stage => stage.toolName === 'write'))
  const authorNodes = result.plan.nodes.filter(node => node.id.startsWith('n_author_'))
  assert.equal(authorNodes.length, 2)
  assert.deepEqual(authorNodes.map(node => node.id), ['n_author_0', 'n_author_1'])
  assert.equal(validateTaskPlan(graph, result.plan).ok, true)
})

test('an MCP tool with only tags and artifacts composes without any core tool', () => {
  const graph = graphOf({
    tools: [
      { name: 'mcp_search', packageName: 'mcp:web', tags: ['web', 'search'], produces: [{ type: 'web.snippet', required: true }] },
      { name: 'mcp_fetch', packageName: 'mcp:web', tags: ['web'], produces: [{ type: 'web.page', required: true }] },
    ],
  })
  const envelope = buildEnvelope({
    roles: [{ role: 'web', match: { tags: ['web'] } }],
  }, graph)
  assert.equal(envelope.fallbackToStock, false)

  const result = synthesizeComposition({
    fingerprint: fingerprint({ intent: 'research' }),
    graph,
    envelope: envelope.envelope,
  })

  assert.equal(result.plan.fallback, false)
  assert.ok(result.stages.some(stage => stage.capabilityId === 'tool:mcp_search'))
  assert.equal(validateTaskPlan(graph, result.plan).ok, true)
})

test('an empty envelope degrades to a single generic step instead of dropping the task', () => {
  const graph = graphOf({ tools: [] })
  const envelope = buildEnvelope({ roles: [] }, graph)
  const result = synthesizeComposition({
    fingerprint: fingerprint(),
    graph,
    envelope: envelope.envelope,
  })

  assert.equal(result.plan.fallback, true)
  assert.equal(result.plan.templateId, 't_generic')
  assert.equal(result.plan.nodes.length, 1)
  assert.equal(result.plan.nodes[0]?.id, 'n_answer')
  assert.equal(validateTaskPlan(graph, result.plan).ok, true)
})

test('synthesis is deterministic and respects the envelope universe', () => {
  const graph = graphOf({ tools: CORE_TOOLS })
  const envelope = buildEnvelope({ roles: [role('workspace-read')] }, graph)
  const first = synthesizeComposition({
    fingerprint: fingerprint({ mutating: true }),
    graph,
    envelope: envelope.envelope,
  })
  const second = synthesizeComposition({
    fingerprint: fingerprint({ mutating: true }),
    graph,
    envelope: envelope.envelope,
  })

  assert.equal(first.plan.compiledDigest, second.plan.compiledDigest)
  assert.ok(!first.stages.some(stage => stage.capabilityId === 'tool:write'))
  assert.ok(!first.stages.some(stage => stage.capabilityId === 'tool:bash'))
  assert.equal(validateTaskPlan(graph, first.plan).ok, true)
})

test('the composed plan ends at a tool-enabled answer node and gives verify a repair exit', () => {
  const graph = graphOf({ tools: CORE_TOOLS })
  const envelope = buildEnvelope({
    roles: [
      role('workspace-read'),
      role('workspace-write'),
      role('shell'),
      role('verification'),
    ],
  }, graph)
  const result = synthesizeComposition({
    fingerprint: fingerprint({ intent: 'code-change', mutating: true }),
    graph,
    envelope: envelope.envelope,
  })

  assert.ok(result.stages.length > 0, 'the fixture must compose work stages')
  const answer = result.plan.nodes.find(node => node.id === 'n_answer')
  assert.ok(answer, 'composed plans end at n_answer')
  assert.equal(answer.kind, 'agent-step', 'an answer that can still act is an agent step, not a terminal')
  assert.equal(answer.toolAllow, undefined, 'the answer node must keep the tools needed to continue')
  const verifyOut = result.plan.edges.filter(edge => edge.from === 'n_verify')
  assert.ok(verifyOut.some(edge => edge.to === 'n_repair'
    && edge.when?.op === 'fact' && edge.when.key === 'lastOk' && edge.when.equals === false))
  assert.ok(verifyOut.some(edge => edge.to === 'n_answer'
    && edge.when?.op === 'fact' && edge.when.key === 'lastOk' && edge.when.equals === true))
  assert.ok(result.plan.nodes.some(node => node.id === 'n_repair'))
  assert.equal(validateTaskPlan(graph, result.plan).ok, true)
})

test('a generic single-step plan keeps the envelope: its terminal is also the work node', () => {
  const graph = graphOf({ tools: [] })
  const envelope = buildEnvelope({ roles: [] }, graph)
  const result = synthesizeComposition({
    fingerprint: fingerprint(),
    graph,
    envelope: envelope.envelope,
  })

  assert.equal(result.plan.templateId, 't_generic')
  assert.equal(result.plan.nodes.length, 1)
  assert.equal(result.plan.nodes[0]?.toolAllow, undefined, 'the escape hatch must keep its tools')
  assert.equal(validateTaskPlan(graph, result.plan).ok, true)
})

test('a maxSteps budget of one yields a single terminal node', () => {
  const graph = graphOf({ tools: CORE_TOOLS })
  const envelope = buildEnvelope({
    roles: [role('workspace-read'), role('workspace-write'), role('shell'), role('verification')],
  }, graph)
  const result = synthesizeComposition({
    fingerprint: fingerprint({ intent: 'code-change', mutating: true }),
    graph,
    envelope: envelope.envelope,
    budget: { maxSteps: 1 },
  })

  assert.equal(result.plan.budget.maxSteps, 1, 'the plan budget must match the enforced cap')
  assert.equal(result.plan.nodes.length, 1)
  assert.equal(result.plan.nodes[0]?.id, 'n_answer')
  assert.ok(result.issues.some(issue => issue.code === 'budget-capped'))
  assert.equal(validateTaskPlan(graph, result.plan).ok, true)
})

test('the legacy top-level maxSteps is honoured by the cap and the plan budget alike', () => {
  const graph = graphOf({ tools: CORE_TOOLS })
  const envelope = buildEnvelope({
    roles: [role('workspace-read'), role('workspace-write'), role('shell'), role('verification')],
  }, graph)
  const result = synthesizeComposition({
    fingerprint: fingerprint({ intent: 'code-change', mutating: true }),
    graph,
    envelope: envelope.envelope,
    maxSteps: 2,
  })

  assert.equal(result.plan.budget.maxSteps, 2)
  assert.equal(result.plan.nodes.length, 2, 'one work stage plus the terminal answer')
  assert.equal(validateTaskPlan(graph, result.plan).ok, true)
})
