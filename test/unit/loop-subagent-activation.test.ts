/**
 * The graph subagent batch must speak the flat `SubagentActivationSpec`.
 *
 * `SubagentsLike` in agent.ts is a local structural interface, so `tsc` cannot
 * see a field change in the DSH seam: a nested `request` object compiles fine
 * and fails only at runtime, when the real manager refuses the unknown shape.
 * This test drives the real `runSubagentBatch` call site with a double that
 * rejects a nested `request` and pins `parent`/`prompt`/`signal`/`delivery` at
 * the top level.
 *
 * Run: node --import tsx --test test/unit/loop-subagent-activation.test.ts
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'

import { ReactLoopAgent } from '../../packages/loop/src/loop/agent.ts'

interface NodeLike {
  readonly id: string
  readonly executor: 'subagent'
  readonly instruction: string
}

/** Bind the private batch runner to a fake loop state. */
function harness(): {
  readonly agent: ReactLoopAgent
  run(node: NodeLike): Promise<void>
  readonly specs: Record<string, unknown>[]
  readonly completed: { id: string; ok: boolean }[]
  readonly injected: unknown[]
  readonly logs: string[]
  readonly signal: AbortSignal
  disposes(): number
} {
  const specs: Record<string, unknown>[] = []
  const completed: { id: string; ok: boolean }[] = []
  const injected: unknown[] = []
  const logs: string[] = []
  let disposed = 0
  const signal = new AbortController().signal
  const service = {
    startActivation(spec: Record<string, unknown>) {
      // The real spec is flat: a nested `request` is an unknown field the
      // manager refuses, so the pre-fix call shape must reject here.
      if ('request' in spec) throw new TypeError('SubagentActivationSpec has no nested "request"')
      specs.push(spec)
      return Promise.resolve({
        childId: 'child-1',
        result: Promise.resolve({ output: [{ type: 'text', text: 'child ok' }], stopReason: 'completed' }),
        dispose: async () => { disposed += 1 },
      })
    },
  }
  const agent = Object.create(ReactLoopAgent.prototype) as ReactLoopAgent
  Object.assign(agent, {
    id: 'session:test',
    phase: { kind: 'running', abort: { signal } },
    loopCtx: { get: (name: string) => name === 'subagents' ? service : undefined },
    ctx: { logger: { warn: (message: string) => { logs.push(message) } } },
    inject: (message: unknown) => { injected.push(message) },
    turnGraph: { completeNode: async (id: string, ok: boolean) => { completed.push({ id, ok }) } },
  })
  const run = async (node: NodeLike): Promise<void> => {
    const runner = agent as unknown as { runSubagentBatch(batch: readonly NodeLike[]): Promise<void> }
    await runner.runSubagentBatch([node])
  }
  return { agent, run, specs, completed, injected, logs, signal, disposes: () => disposed }
}

test('a graph subagent activation spec is flat, not wrapped in request', async () => {
  const h = harness()

  await h.run({ id: 's1', executor: 'subagent', instruction: 'branch one' })

  assert.equal(h.logs.length, 0, `the batch must not log a failure: ${h.logs.join('\n')}`)
  assert.equal(h.specs.length, 1, 'the call site sends exactly one flat activation spec')
  const spec = h.specs[0] as Record<string, unknown>
  assert.equal('request' in spec, false)
  assert.equal(spec.provider, 'spawn')
  assert.equal(spec.label, 's1')
  assert.equal(spec.delivery, 'caller')
  assert.equal(spec.parent, h.agent)
  assert.deepEqual(spec.prompt, [{ type: 'text', text: 'branch one' }])
  assert.ok(spec.signal instanceof AbortSignal)
  assert.equal(spec.signal, h.signal, 'the turn signal is the activation cancellation channel')
  assert.deepEqual(h.completed, [{ id: 's1', ok: true }], 'the node completes through the scheduler')
  assert.equal(h.injected.length, 1, 'the child result reaches the next parent step')
  assert.equal(h.disposes(), 1, 'the activation is disposed exactly once')
})
