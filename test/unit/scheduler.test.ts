import assert from 'node:assert/strict'
import { test } from 'node:test'
import { buildRegistrySnapshot, type ToolSource } from '../../packages/core/src/registry.ts'
import { TEMPLATE_LIBRARY } from '../../packages/core/src/templates.ts'
import { createGraphTurnDriver } from '../../packages/loop/src/scheduler.ts'

const tools: ToolSource[] = [
  { name: 'read', description: 'Read a text file.', parameters: { type: 'object', properties: { path: { type: 'string' } } } },
  { name: 'glob', description: 'Find files by pattern.', parameters: { type: 'object', properties: { pattern: { type: 'string' } } } },
  { name: 'grep', description: 'Search file contents.', parameters: { type: 'object', properties: { pattern: { type: 'string' } } } },
  { name: 'edit', description: 'Edit a file.', parameters: { type: 'object', properties: { path: { type: 'string' } } } },
  { name: 'bash', description: 'Run a shell command.', parameters: { type: 'object', properties: { command: { type: 'string' } } } },
  { name: 'web_search', description: 'Search the web.', parameters: { type: 'object', properties: { query: { type: 'string' } } } },
  { name: 'web_fetch', description: 'Fetch a page.', parameters: { type: 'object', properties: { url: { type: 'string' } } } },
]

const registry = buildRegistrySnapshot({ tools })

test('registry is deterministic and marks the tool set', () => {
  const again = buildRegistrySnapshot({ tools })
  assert.equal(again.digest, registry.digest)
  assert.equal(registry.graph.nodes.length, tools.length)
  assert.ok(registry.graph.nodes.some(node => node.id === 'tool:read' && node.produces.some(spec => spec.type === 'file.text')))
})

test('a code question routes to t_investigate and walks its nodes', () => {
  const driver = createGraphTurnDriver({
    graphProvider: () => registry.graph,
    templatesProvider: () => TEMPLATE_LIBRARY,
  })
  const started = driver.beginTurn({ text: 'explain how the config loader works' })
  assert.equal(started.templateId, 't_investigate')
  assert.equal(driver.current()?.id, 'n_discover')
  driver.advance({ ok: true })
  assert.equal(driver.current()?.id, 'n_inspect')
  driver.advance({ ok: true })
  assert.equal(driver.current()?.id, 'n_done')
  driver.advance({ ok: true })
  assert.equal(driver.done(), true)
  assert.deepEqual(driver.snapshot().visited, ['n_discover', 'n_inspect', 'n_done'])
})

test('without a registry the driver falls back to a single stock node', () => {
  const driver = createGraphTurnDriver({ fallbackInstruction: 'answer' })
  const started = driver.beginTurn({ text: 'hello' })
  assert.equal(started.fallback, true)
  assert.equal(driver.current()?.id, 'node:respond')
  driver.advance({ ok: true })
  assert.equal(driver.done(), true)
})
