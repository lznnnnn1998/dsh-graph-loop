import assert from 'node:assert/strict'
import { test } from 'node:test'
import { buildRegistrySnapshot, type ToolSnapshot } from '../../packages/loop/src/registry.ts'
import { EXPLORE_TEMPLATES } from '../../packages/loop/src/router.ts'
import { createGraphTurnDriver } from '../../packages/loop/src/scheduler.ts'

const tools: ToolSnapshot[] = [
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
    templatesProvider: () => EXPLORE_TEMPLATES,
  })
  const started = driver.beginTurn({ text: 'read the README and explain what this project is' })
  assert.equal(started.templateId, 't_investigate')
  assert.equal(driver.current()?.id, 'n_discover')
  driver.advance({ ok: true })
  assert.equal(driver.current()?.id, 'n_read')
  driver.advance({ ok: true })
  assert.equal(driver.current()?.id, 'n_done')
  driver.advance({ ok: true })
  assert.equal(driver.done(), true)
  assert.deepEqual(driver.snapshot().visited, ['n_discover', 'n_read', 'n_done'])
})

test('without a registry the driver falls back to a single stock node', () => {
  const driver = createGraphTurnDriver({ fallbackInstruction: 'answer' })
  const started = driver.beginTurn({ text: 'hello' })
  assert.equal(started.fallback, true)
  assert.equal(driver.current()?.id, 'node:respond')
  driver.advance({ ok: true })
  assert.equal(driver.done(), true)
})
