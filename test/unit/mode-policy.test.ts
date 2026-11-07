/**
 * Unit tests for the explore mode's prompt policy and its node narrative.
 *
 * Two node narratives must never reach the model at once: the graph driver injects
 * `[graph node <plan node>]` per step, while the preset can name its own
 * inspect→plan→act→verify cycle. The preset therefore skips its node line when the
 * host `graphRuntime` service is mounted, resolved lazily at render time. These tests
 * pin both branches and the mount wiring without a Cordis runtime.
 * Run with: `node --import tsx --test test/unit/mode-policy.test.ts`.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { apply, graphDriverActive, policyText } from '../../packages/mode/src/policy.ts'

/** The section registration this test reads back. */
interface CapturedSection {
  name: string
  order: number
  text: () => string
}

/** A fake Agent that records the section the policy mounts on it. */
function fakeAgent(): { agent: Agent; section: () => CapturedSection } {
  let captured: CapturedSection | undefined
  const agent = {
    ctx: {
      effect(fn: () => unknown): void {
        fn()
      },
      systemPrompt: {
        section(shape: CapturedSection): () => void {
          captured = shape
          return () => {}
        },
        context: () => () => {},
      },
      on: () => () => {},
    },
  } as unknown as Agent
  return {
    agent,
    section(): CapturedSection {
      assert.ok(captured !== undefined, 'the policy section was mounted')
      return captured
    },
  }
}

/**
 * A fake preset context whose service lookup reads a mutable map, so a test can
 * simulate the graph driver mounting after the preset.
 */
function fakePresetContext(services: Record<string, unknown>): { ctx: Context; createAgent: (agent: Agent) => void } {
  let created: ((payload: { agent: Agent }) => void) | undefined
  const ctx = {
    get: (name: string) => services[name],
    systemPrompt: { getSectionOrder: () => 600 },
    effect(fn: () => unknown): void {
      fn()
    },
    on(event: string, handler: (payload: { agent: Agent }) => void): () => void {
      if (event === 'agent/created') created = handler
      return () => {}
    },
  } as unknown as Context
  return {
    ctx,
    createAgent(agent: Agent): void {
      assert.ok(created !== undefined, 'apply subscribed to agent/created')
      created({ agent })
    },
  }
}

test('policyText names the node and stays short', () => {
  const text = policyText('verify')
  assert.match(text, /current node: verify/)
  assert.match(text, /Graph policy/)
  assert.ok(text.length < 800, `policy section is ${text.length} chars`)
})

test('policyText drops only the node line when the graph driver is active', () => {
  const preset = policyText('inspect', false)
  const driven = policyText('inspect', true)
  assert.match(preset, /current node: inspect/)
  assert.doesNotMatch(driven, /current node:/)
  assert.match(driven, /Graph policy for this session/)
  assert.match(driven, /Keep one node per step/)
  assert.match(driven, /Reuse an idle teammate/)
  assert.match(driven, /Tracking detail belongs in todo_write/)
  assert.ok(driven.length < preset.length, 'omitting the node line makes the section shorter')
})

test('graphDriverActive resolves the host service defensively', () => {
  assert.equal(graphDriverActive({ get: () => ({ last: () => undefined }) }), true)
  assert.equal(graphDriverActive({ get: () => undefined }), false)
  assert.equal(graphDriverActive({ get: (name: string) => name === 'graphRuntime' ? {} : undefined }), true)
  assert.equal(graphDriverActive({ get: () => { throw new Error('teams exploded') } }), false, 'a throwing lookup is inert')
  assert.equal(graphDriverActive({}), false)
  assert.equal(graphDriverActive(null), false)
  assert.equal(graphDriverActive('graphRuntime'), false)
})

test('the mounted section defers node naming to the graph driver at render time', () => {
  const services: Record<string, unknown> = {}
  const preset = fakePresetContext(services)
  apply(preset.ctx, { rosterContext: false })
  const { agent, section } = fakeAgent()
  preset.createAgent(agent)

  const mounted = section()
  assert.equal(mounted.name, 'explore:policy')
  assert.equal(mounted.order, 600)
  assert.match(mounted.text(), /current node: inspect/, 'without a driver the preset owns the node cycle')

  // The driver may mount after the preset; the text function must re-resolve.
  services.graphRuntime = { last: () => undefined }
  assert.doesNotMatch(mounted.text(), /current node:/, 'with a driver the loop owns the node narrative')
  assert.match(mounted.text(), /Graph policy for this session/)
})

test('a custom node cycle still drives the preset branch', () => {
  const preset = fakePresetContext({})
  apply(preset.ctx, { nodes: ['frame', 'solve', 'check'], rosterContext: false })
  const { agent, section } = fakeAgent()
  preset.createAgent(agent)
  assert.match(section().text(), /current node: frame/)
})
