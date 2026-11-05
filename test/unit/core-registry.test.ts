/**
 * Unit tests for the capability-graph registry builder.
 *
 * Run: node --import tsx --test test/unit/core-*.test.ts
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'

import { validateRegistryGraph, type GraphEdge, type RegistryGraph, type RegistryNode } from '../../packages/core/src/graph-schema.ts'
import {
  DEFAULT_ANNOTATION_VERSION,
  UNMAPPED_TAG,
  buildRegistrySnapshot,
  digestGraph,
  estimateSchemaTokens,
  inferIdempotent,
  inferPermissionClass,
  type RegistrySources,
} from '../../packages/core/src/registry.ts'

const FIXTURE: RegistrySources = {
  tools: [
    { name: 'read', packageName: '@deepseek-ai/dsh-tool-fs', parameters: { type: 'object', properties: { file_path: {}, offset: {}, limit: {} } } },
    { name: 'read_image' },
    { name: 'write' },
    { name: 'edit' },
    { name: 'str_replace_editor' },
    { name: 'glob' },
    { name: 'grep' },
    { name: 'bash', packageName: '@deepseek-ai/dsh-tool-bash' },
    { name: 'present' },
    { name: 'workspace_status', packageName: '@deepseek-ai/dsh-tool-demo' },
  ],
  sections: [{ id: 'persona', label: 'explore persona', tokens: 120 }],
  skills: [{ name: 'dsh-office', provider: 'office', tokensPerCall: 1_200 }],
  presets: [{ id: 'explore', tools: ['read', 'edit', 'bash'], default: true }],
  agents: [{ id: 'explorer', presetId: 'explore' }],
  plugins: [{ name: '@deepseek-ai/dsh-tool-fs' }],
  providers: [{ provider: 'spawn', toolName: 'subagent', packageName: '@deepseek-ai/dsh-subagent-spawn-in-process' }],
  annotationVersion: 'test-annotations/1',
}

function toolNames(graph: RegistryGraph): string[] {
  return graph.nodes.filter((node) => node.kind === 'tool' && node.tool !== undefined).map((node) => (node.tool as NonNullable<RegistryNode['tool']>).name)
}

test('build is deterministic and keeps the tick when the digest is unchanged', () => {
  const first = buildRegistrySnapshot(FIXTURE)
  const second = buildRegistrySnapshot(FIXTURE)
  assert.equal(first.digest, second.digest)
  assert.equal(first.version, 0)
  assert.equal(first.graph.buildTick, 0)
  assert.match(first.digest, /^[0-9a-f]{64}$/)

  // Same sources, previous snapshot supplied: version and tick must not move.
  const third = buildRegistrySnapshot(FIXTURE, first)
  assert.equal(third.digest, first.digest)
  assert.equal(third.version, first.version)
  assert.equal(third.graph.buildTick, first.graph.buildTick)

  // Input array order is irrelevant: nodes/edges are sorted before hashing.
  const reversed = buildRegistrySnapshot({
    ...FIXTURE,
    tools: [...(FIXTURE.tools ?? [])].reverse(),
  })
  assert.equal(reversed.digest, first.digest)
  assert.deepEqual(reversed.graph.nodes.map((node) => node.id), first.graph.nodes.map((node) => node.id))
})

test('version and buildTick bump only when the capability graph changes', () => {
  const first = buildRegistrySnapshot(FIXTURE)
  const changed = buildRegistrySnapshot({ ...FIXTURE, tools: [...(FIXTURE.tools ?? []), { name: 'new_tool' }] }, first)
  assert.notEqual(changed.digest, first.digest)
  assert.equal(changed.version, first.version + 1)
  assert.equal(changed.graph.buildTick, first.graph.buildTick + 1)

  const stable = buildRegistrySnapshot({ ...FIXTURE, tools: [...(FIXTURE.tools ?? []), { name: 'new_tool' }] }, changed)
  assert.equal(stable.digest, changed.digest)
  assert.equal(stable.version, changed.version)
  assert.equal(stable.graph.buildTick, changed.graph.buildTick)

  // A raw RegistryGraph is accepted as the previous cursor too.
  const fromGraph = buildRegistrySnapshot({ tools: [{ name: 'read' }] }, first.graph)
  assert.equal(fromGraph.version, 1)
  assert.equal(fromGraph.graph.buildTick, 1)
})

test('digestGraph covers node and edge facts and ignores array order', () => {
  const graph = buildRegistrySnapshot(FIXTURE).graph
  const reversed: Pick<RegistryGraph, 'nodes' | 'edges'> = {
    nodes: [...graph.nodes].reverse(),
    edges: [...graph.edges].reverse(),
  }
  assert.equal(digestGraph(reversed), graph.digest)

  const mutatedNodes = graph.nodes.map((node) =>
    node.id === 'tool:bash' ? { ...node, cost: { ...node.cost, risk: 0.99 } } : node,
  )
  assert.notEqual(digestGraph({ nodes: mutatedNodes, edges: graph.edges }), graph.digest)

  const mutatedEdges = graph.edges.map((edge) => (edge.kind === 'requires' ? { ...edge, weight: 0.01 } : edge))
  assert.notEqual(digestGraph({ nodes: graph.nodes, edges: mutatedEdges }), graph.digest)

  assert.equal(digestGraph({ nodes: [], edges: [] }), buildRegistrySnapshot({}).digest)
})

test('maps every injected source kind to stable, valid node ids', () => {
  const snapshot = buildRegistrySnapshot(FIXTURE)
  const ids = new Set(snapshot.graph.nodes.map((node) => node.id))
  for (const expected of [
    'tool:read',
    'skill:dsh-office',
    'preset:explore',
    'agent:explorer',
    'plugin:deepseek-ai_dsh-tool-fs',
    'subagent:spawn',
    'section:persona',
  ]) {
    assert.ok(ids.has(expected), `missing node ${expected}`)
  }
  const validation = validateRegistryGraph(snapshot.graph)
  assert.equal(validation.ok, true, validation.errors.map((error) => `${error.code} ${error.path}: ${error.message}`).join('\n'))
  for (const node of snapshot.graph.nodes) assert.equal(node.annotationVersion, 'test-annotations/1')
})

test('tool facts: curated artifacts, parameter names, schema tokens, permission heuristic', () => {
  const snapshot = buildRegistrySnapshot(FIXTURE)
  const byName = new Map(snapshot.graph.nodes.filter((node) => node.tool !== undefined).map((node) => [node.tool?.name, node]))

  const read = byName.get('read')
  assert.ok(read?.tool)
  assert.equal(read.tool.permission, 'read-only')
  assert.equal(read.tool.idempotent, true)
  assert.deepEqual(read.tool.parameterNames, ['file_path', 'limit', 'offset'])
  assert.equal(read.tool.schemaTokens, estimateSchemaTokens('read', undefined, FIXTURE.tools?.[0]?.parameters))
  assert.deepEqual(read.produces.map((artifact) => artifact.type), ['file.text'])

  const bash = byName.get('bash')
  assert.ok(bash?.tool)
  assert.equal(bash.tool.permission, 'privileged')
  assert.equal(bash.tool.idempotent, false)
  assert.ok(bash.cost.risk >= 0.5, 'privileged tools carry a high risk prior')
  assert.deepEqual(bash.tags, ['shell', 'verification'])

  // Explicit facts win over the heuristic and the measured table.
  const explicit = buildRegistrySnapshot({
    tools: [{ name: 'bash', permission: 'read-only', idempotent: true, schemaTokens: 7, parameterNames: ['command'] }],
  }).graph.nodes[0]
  assert.ok(explicit?.tool)
  assert.equal(explicit.tool.permission, 'read-only')
  assert.equal(explicit.tool.idempotent, true)
  assert.equal(explicit.tool.schemaTokens, 7)
  assert.deepEqual(explicit.tool.parameterNames, ['command'])

  const curated = buildRegistrySnapshot({ tools: [{ name: 'read' }] }).graph.nodes[0]
  assert.ok(curated?.tool)
  assert.equal(curated.tool.schemaTokens, 111, 'measured catalog default applies when no schema is injected')
  assert.equal(curated.annotationVersion, DEFAULT_ANNOTATION_VERSION)
})

test('an uncurated tool still becomes a node with empty artifacts and an unmapped tag, without warnings', () => {
  const snapshot = buildRegistrySnapshot({ tools: [{ name: 'frobnicate' }] })
  assert.equal(snapshot.graph.nodes.length, 1)
  const node = snapshot.graph.nodes[0]
  assert.ok(node?.tool)
  assert.equal(node.id, 'tool:frobnicate')
  assert.deepEqual(node.accepts, [])
  assert.deepEqual(node.produces, [])
  assert.deepEqual(node.tags, [UNMAPPED_TAG])
  assert.deepEqual(snapshot.warnings, [])
  assert.equal(inferPermissionClass('frobnicate'), 'mutating', 'unknown tools are assumed to mutate')
})

test('warns about dynamic and conditional tools', () => {
  const snapshot = buildRegistrySnapshot({
    tools: [
      { name: 'mcp__demo__ping', dynamic: true },
      { name: 'read_image', conditional: true },
      { name: 'read' },
    ],
  })
  assert.equal(snapshot.warnings.length, 2)
  assert.ok(snapshot.warnings.some((warning) => warning.includes('mcp__demo__ping') && warning.includes('dynamic')))
  assert.ok(snapshot.warnings.some((warning) => warning.includes('read_image') && warning.includes('conditional')))
  assert.deepEqual([...snapshot.warnings].sort(), snapshot.warnings, 'warnings are sorted deterministically')
  const dynamic = snapshot.graph.nodes.find((node) => node.id === 'tool:mcp__demo__ping')
  assert.equal(dynamic?.tool?.dynamic, true)
  assert.equal(dynamic?.source.dynamic, true)
})

test('duplicate ids dedupe deterministically and prefer the unconditional registration', () => {
  const left = buildRegistrySnapshot({
    tools: [
      { name: 'read', description: 'alpha' },
      { name: 'read', description: 'beta', conditional: true },
      { name: 'read', description: 'gamma' },
    ],
  })
  const right = buildRegistrySnapshot({
    tools: [
      { name: 'read', description: 'gamma' },
      { name: 'read', description: 'beta', conditional: true },
      { name: 'read', description: 'alpha' },
    ],
  })
  assert.equal(left.graph.nodes.length, 1)
  assert.equal(left.digest, right.digest, 'shuffling duplicate sources cannot change the digest')
  assert.equal(left.graph.nodes[0]?.tool?.conditional, false)
  assert.equal(left.warnings.length, 0)
})

test('builds the declared edge relations', () => {
  const graph = buildRegistrySnapshot(FIXTURE).graph
  const has = (kind: GraphEdge['kind'], from: string, to: string): boolean =>
    graph.edges.some((edge) => edge.kind === kind && edge.from === from && edge.to === to)

  assert.ok(has('requires', 'tool:read', 'tool:edit'), 'read-before-edit policy')
  assert.ok(has('requires', 'tool:read', 'tool:write'), 'read-before-write policy')
  assert.ok(has('requires', 'tool:bash', 'tool:bash'), 'sandbox/approval gate is recorded on privileged tools')
  assert.ok(has('substitutes', 'tool:read', 'tool:read_image'))
  assert.ok(has('substitutes', 'tool:read_image', 'tool:read'))
  assert.ok(has('substitutes', 'tool:bash', 'tool:str_replace_editor'))
  assert.ok(has('produces', 'tool:read', 'tool:edit'), 'file.text hand-off')
  assert.ok(has('produces', 'tool:write', 'tool:present'), 'file.text delivery hand-off')
  assert.ok(has('produces', 'tool:read', 'tool:present'), 'read file.text delivery hand-off')

  const readWrite = graph.edges.find((edge) => edge.kind === 'similar' && edge.from === 'tool:read' && edge.to === 'tool:write')
  assert.ok(readWrite, 'shared filesystem tag produces a same-domain edge')
  assert.equal(readWrite.symmetric, true)
  assert.ok(graph.edges.some((edge) => edge.kind === 'similar' && edge.from === 'tool:write' && edge.to === 'tool:read'))
  for (const edge of graph.edges) {
    assert.ok(edge.weight >= 0 && edge.weight <= 1)
    assert.ok(edge.evidence?.note !== undefined && edge.evidence.note.length > 0)
  }
})

test('empty and malformed sources still build a valid snapshot', () => {
  const empty = buildRegistrySnapshot({})
  assert.equal(empty.graph.nodes.length, 0)
  assert.equal(empty.graph.edges.length, 0)
  assert.deepEqual(empty.warnings, [])
  assert.equal(validateRegistryGraph(empty.graph).ok, true)

  const partial = buildRegistrySnapshot({
    tools: [{ name: '   ' }, { name: 'read' }],
    skills: [{ name: '' }],
    presets: [{ id: '  ' }],
    providers: [{ provider: '' }],
  })
  assert.deepEqual(toolNames(partial.graph), ['read'])
  assert.equal(validateRegistryGraph(partial.graph).ok, true)
})

test('permission and idempotency heuristics', () => {
  assert.equal(inferPermissionClass('bash'), 'privileged')
  assert.equal(inferPermissionClass('pwsh'), 'privileged')
  assert.equal(inferPermissionClass('run_code'), 'privileged')
  assert.equal(inferPermissionClass('plugin_manager'), 'privileged')
  assert.equal(inferPermissionClass('web_search'), 'network')
  assert.equal(inferPermissionClass('web_fetch'), 'network')
  assert.equal(inferPermissionClass('edit'), 'mutating')
  assert.equal(inferPermissionClass('read'), 'read-only')
  assert.equal(inferPermissionClass('list_things'), 'read-only')
  assert.equal(inferPermissionClass('mcp__demo__write'), 'mutating')

  assert.equal(inferIdempotent('read', 'read-only'), true)
  assert.equal(inferIdempotent('web_search', 'network'), true)
  assert.equal(inferIdempotent('bash', 'privileged'), false)
  assert.equal(inferIdempotent('custom_writer', 'mutating'), false)
})
