/**
 * Unit tests for the per-turn capability envelope (0.2 composition layer).
 *
 * Run: node --import tsx --test test/unit/core-envelope.test.ts
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  DEFAULT_ROLE_LIBRARY,
  artifactRoleSpec,
  buildEnvelope,
  defaultRole,
  resolveRole,
  selectEnvelopeForTask,
  type CapabilityRoleSpec,
} from '../../packages/core/src/envelope.ts'
import type { RegistryGraph } from '../../packages/core/src/graph-schema.ts'
import type { TaskFingerprint } from '../../packages/core/src/matching.ts'
import {
  applyAnnotations,
  buildRegistrySnapshot,
  type RegistrySources,
  type ToolSource,
} from '../../packages/core/src/registry.ts'

const CORE_TOOLS: ToolSource[] = [
  { name: 'read' },
  { name: 'glob' },
  { name: 'grep' },
  { name: 'write' },
  { name: 'bash' },
  { name: 'web_search' },
  { name: 'todo_write' },
  { name: 'present' },
]

function graphOf(sources: RegistrySources): RegistryGraph {
  return buildRegistrySnapshot(sources).graph
}

function coreGraph(extraTools: ToolSource[] = []): RegistryGraph {
  return graphOf({
    tools: [...CORE_TOOLS, ...extraTools],
    sections: [{ id: 'composition:node', tokens: 40 }],
    skills: [{ name: 'dsh-office' }],
    providers: [{ provider: 'spawn', toolName: 'subagent' }],
  })
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

function role(roleName: string): CapabilityRoleSpec {
  const found = defaultRole(roleName)
  assert.ok(found, `default role ${roleName} must exist`)
  return found
}

test('default roles resolve the core tools and a stable id', () => {
  const graph = coreGraph()
  const decision = buildEnvelope({ roles: [role('workspace-read'), role('workspace-search'), role('workspace-write'), role('shell')] }, graph)

  assert.equal(decision.fallbackToStock, false)
  assert.ok(decision.envelope.tools.universe.includes('read'))
  assert.ok(decision.envelope.tools.universe.includes('grep'))
  assert.ok(decision.envelope.tools.universe.includes('write'))
  assert.ok(decision.envelope.tools.universe.includes('bash'))
  assert.ok(decision.envelope.tools.schemaTokens >= 0)
  assert.match(decision.envelope.id, /^env_[0-9a-f]{16}$/)
  assert.equal(decision.envelope.budget.maxSteps, 40)
})

test('envelope id is deterministic under shuffled registry sources', () => {
  const forward = graphOf({ tools: CORE_TOOLS })
  const backward = graphOf({ tools: [...CORE_TOOLS].reverse() })
  const a = buildEnvelope({ roles: [role('workspace-read'), role('shell')] }, forward)
  const b = buildEnvelope({ roles: [role('workspace-read'), role('shell')] }, backward)
  assert.equal(a.envelope.id, b.envelope.id)
  assert.deepEqual(a.envelope.tools.universe, b.envelope.tools.universe)
})

test('implementations bind craft tools by name/package prefix', () => {
  const graph = coreGraph([
    { name: 'deckcraft_run', packageName: 'deckcraft', tags: ['authoring', 'presentation'], schemaTokens: 900 },
    { name: 'deckcraft_commands', packageName: 'deckcraft', tags: ['authoring', 'presentation'], schemaTokens: 300 },
    { name: 'unrelated_tool', packageName: 'other', schemaTokens: 10 },
  ])
  const spec: CapabilityRoleSpec = {
    role: 'presentation',
    required: true,
    implementations: ['deckcraft'],
  }
  const decision = buildEnvelope({ roles: [spec] }, graph)

  assert.equal(decision.fallbackToStock, false)
  assert.deepEqual(decision.envelope.tools.universe, ['deckcraft_commands', 'deckcraft_run'])
  assert.equal(decision.roles[0]?.selected.length, 2)
})

test('role resolution prefers the cheapest schema and truncates with a warning', () => {
  const graph = coreGraph([
    { name: 'extra_search', tags: ['search'], schemaTokens: 50 },
    { name: 'other_search', tags: ['search'], schemaTokens: 5 },
  ])
  const resolution = resolveRole(
    { role: 'search', match: { toolNamePatterns: ['^(extra|other)_search$'] }, maxTools: 1 },
    graph,
  )

  assert.equal(resolution.selected.length, 1)
  assert.ok(resolution.issues.some(issue => issue.code === 'role-truncated'))
  assert.equal(resolution.selected[0]?.name, 'other_search')
})

test('conditional and dynamic tools are excluded by default and reported', () => {
  const graph = coreGraph([
    { name: 'mcp_dynamic', tags: ['web'], dynamic: true },
    { name: 'conditional_web', tags: ['web'], conditional: true },
  ])
  const strict = buildEnvelope({ roles: [role('web')] }, graph)
  assert.equal(strict.fallbackToStock, false)
  assert.deepEqual(strict.envelope.tools.universe, ['web_search'])
  assert.ok(strict.issues.some(issue => issue.code === 'tool-unstable-excluded'))

  const relaxed = buildEnvelope({ roles: [role('web')], allowUnstable: true }, graph)
  assert.deepEqual(relaxed.envelope.tools.unstable, ['conditional_web', 'mcp_dynamic'])
  assert.equal(relaxed.envelope.tools.universe.length, 3)
})

test('a required unresolved role falls back to stock', () => {
  const graph = coreGraph()
  const decision = buildEnvelope(
    {
      roles: [
        role('workspace-read'),
        { role: 'impossible', required: true, match: { tags: ['does-not-exist'] } },
      ],
    },
    graph,
  )
  assert.equal(decision.fallbackToStock, true)
  assert.ok(decision.issues.some(issue => issue.code === 'role-unresolved' && issue.role === 'impossible'))
})

test('an optional unresolved role only warns', () => {
  const graph = coreGraph()
  const decision = buildEnvelope(
    { roles: [role('workspace-read'), { role: 'nice-to-have', match: { tags: ['does-not-exist'] } }] },
    graph,
  )
  assert.equal(decision.fallbackToStock, false)
  assert.ok(decision.issues.some(issue => issue.code === 'role-empty' && issue.severity === 'warning'))
})

test('explicit tools are validated, denied tools are removed, and the cap is enforced', () => {
  const graph = coreGraph()
  const missing = buildEnvelope({ roles: [role('workspace-read')], extraTools: ['nope'] }, graph)
  assert.equal(missing.fallbackToStock, true)
  assert.ok(missing.issues.some(issue => issue.code === 'tool-not-found'))

  const denied = buildEnvelope({ roles: [role('workspace-read')], denyTools: ['read'] }, graph)
  assert.equal(denied.fallbackToStock, false)
  assert.ok(!denied.envelope.tools.universe.includes('read'))
  assert.ok(denied.issues.some(issue => issue.code === 'tool-denied'))

  const capped = buildEnvelope(
    { roles: [role('workspace-read'), role('workspace-search'), role('workspace-write'), role('shell')], maxTools: 2 },
    graph,
  )
  assert.equal(capped.fallbackToStock, true)
  assert.ok(capped.issues.some(issue => issue.code === 'max-tools-exceeded'))
})

test('skills and prompt sections are validated and tracked', () => {
  const graph = coreGraph()
  const ok = buildEnvelope(
    { roles: [role('workspace-read')], skills: ['dsh-office'], promptSections: ['composition:node'] },
    graph,
  )
  assert.equal(ok.fallbackToStock, false)
  assert.deepEqual(ok.envelope.skills, ['dsh-office'])
  assert.deepEqual(ok.envelope.promptSections, ['composition:node'])
  assert.ok(ok.envelope.capabilityIds.includes('skill:dsh-office'))
  assert.ok(ok.envelope.capabilityIds.includes('section:composition:node'))

  const bad = buildEnvelope({ roles: [role('workspace-read')], skills: ['nope'], promptSections: ['nope'] }, graph)
  assert.equal(bad.fallbackToStock, true)
  assert.ok(bad.issues.some(issue => issue.code === 'skill-not-found'))
  assert.ok(bad.issues.some(issue => issue.code === 'section-not-found'))
})

test('delegation resolves the subagent provider node, not a tool', () => {
  const graph = coreGraph()
  const resolution = resolveRole(role('delegation'), graph)
  assert.equal(resolution.selected.length, 1)
  assert.equal(resolution.selected[0]?.kind, 'subagent-provider')
  assert.equal(resolution.selected[0]?.name, 'spawn')
})

test('selectEnvelopeForTask adds write/verify for a mutating code change', () => {
  const graph = coreGraph()
  const decision = selectEnvelopeForTask({
    fingerprint: fingerprint({ intent: 'code-change', mutating: true }),
    graph,
  })
  assert.equal(decision.fallbackToStock, false)
  for (const tool of ['read', 'grep', 'write', 'bash']) {
    assert.ok(decision.envelope.tools.universe.includes(tool), `expected ${tool}`)
  }
  assert.ok(!decision.envelope.tools.universe.includes('web_search'))
})

test('selectEnvelopeForTask adds web for research and keeps write out', () => {
  const graph = coreGraph()
  const decision = selectEnvelopeForTask({ fingerprint: fingerprint({ intent: 'research' }), graph })
  assert.equal(decision.fallbackToStock, false)
  assert.ok(decision.envelope.tools.universe.includes('web_search'))
  assert.ok(!decision.envelope.tools.universe.includes('write'))
})

test('selectEnvelopeForTask accepts template roles and budgets', () => {
  const graph = coreGraph([
    { name: 'deckcraft_run', packageName: 'deckcraft', tags: ['authoring', 'presentation'], schemaTokens: 800 },
  ])
  const decision = selectEnvelopeForTask({
    fingerprint: fingerprint({ intent: 'document' }),
    graph,
    templateRoles: [{ role: 'authoring:presentation', required: true, implementations: ['deckcraft'] }],
    budget: { maxSteps: 12 },
  })
  assert.equal(decision.fallbackToStock, false)
  assert.ok(decision.envelope.tools.universe.includes('deckcraft_run'))
  assert.equal(decision.envelope.budget.maxSteps, 12)
})

test('the default role library is internally consistent and tool-agnostic', () => {
  const names = DEFAULT_ROLE_LIBRARY.map(entry => entry.role)
  assert.equal(new Set(names).size, names.length)
  for (const entry of DEFAULT_ROLE_LIBRARY) {
    assert.ok(entry.match !== undefined || entry.implementations !== undefined, `${entry.role} must narrow something`)
    assert.ok(!entry.role.startsWith('authoring:'), 'no product-specific role belongs in the default library')
  }
})

test('a non-craft tool becomes routable through data-only annotations', () => {
  const annotated = applyAnnotations(
    [
      { name: 'acme_widget', packageName: '@acme/widgets' },
      { name: 'acme_render', packageName: '@acme/widgets' },
      { name: 'unrelated', packageName: '@other/pkg' },
    ],
    [
      {
        package: '@acme/widgets',
        tags: ['filesystem', 'search'],
        produces: [{ type: 'file.text', required: true }],
        permission: 'read-only',
      },
    ],
  )
  assert.equal(annotated.unmatched.length, 0)
  const graph = graphOf({ tools: annotated.tools })
  const decision = buildEnvelope({ roles: [artifactRoleSpec('file.text')] }, graph)

  assert.equal(decision.fallbackToStock, false)
  assert.deepEqual(decision.envelope.tools.universe, ['acme_render', 'acme_widget'])
})

test('task outputs bind generically by artifact, not by product', () => {
  const graph = graphOf({
    tools: [
      { name: 'read' },
      { name: 'acme_widget', packageName: '@acme/widgets', tags: ['filesystem'], produces: [{ type: 'file.text', required: true }] },
    ],
  })
  const decision = selectEnvelopeForTask({
    fingerprint: fingerprint({ artifactsOut: ['file.text'] }),
    graph,
  })
  assert.equal(decision.fallbackToStock, false)
  assert.ok(decision.envelope.tools.universe.includes('acme_widget'))
})

test('a task hint keeps an unannotated tool callable', () => {
  const graph = graphOf({ tools: [{ name: 'read' }, { name: 'acme_tool', packageName: '@acme/widgets' }] })
  const withHint = selectEnvelopeForTask({ fingerprint: fingerprint({ hints: ['acme_tool'] }), graph })
  assert.ok(withHint.envelope.tools.universe.includes('acme_tool'))

  const withoutHint = selectEnvelopeForTask({ fingerprint: fingerprint(), graph })
  assert.ok(!withoutHint.envelope.tools.universe.includes('acme_tool'))
})

test('the preset baseline can keep unannotated tools without annotations', () => {
  const graph = graphOf({ tools: [{ name: 'read' }, { name: 'acme_tool', packageName: '@acme/widgets' }] })
  const baseline = selectEnvelopeForTask({
    fingerprint: fingerprint(),
    graph,
    presetTools: ['read', 'acme_tool'],
    includePresetTools: true,
  })
  assert.ok(baseline.envelope.tools.universe.includes('acme_tool'))

  const narrow = selectEnvelopeForTask({
    fingerprint: fingerprint(),
    graph,
    presetTools: ['read', 'acme_tool'],
    includePresetTools: false,
  })
  assert.ok(!narrow.envelope.tools.universe.includes('acme_tool'))
})

test('an annotation that matches nothing is reported', () => {
  const result = applyAnnotations([{ name: 'read' }], [{ tool: 'ghost', tags: ['filesystem'] }])
  assert.equal(result.tools.length, 1)
  assert.equal(result.unmatched.length, 1)
})

test('selectEnvelopeForTask works on a registry with only MCP/web tools', () => {
  const graph = graphOf({
    tools: [
      { name: 'mcp_search', packageName: 'mcp:web', tags: ['web', 'search'], produces: [{ type: 'web.snippet', required: true }] },
      { name: 'mcp_fetch', packageName: 'mcp:web', tags: ['web'], produces: [{ type: 'web.page', required: true }] },
    ],
  })
  const decision = selectEnvelopeForTask({ fingerprint: fingerprint({ intent: 'research' }), graph })
  assert.equal(decision.fallbackToStock, false)
  assert.ok(decision.envelope.tools.universe.includes('mcp_search'))
  assert.ok(decision.envelope.tools.universe.includes('mcp_fetch'))
})
