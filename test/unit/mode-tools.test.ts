/**
 * Unit tests for the explore mode's model-facing tool row.
 *
 * The row must register `suggest_executor` only: `dsh-graph-loop` owns the live
 * `graph_status` tool, and DSH scoped tools shadow globals, so a preset duplicate
 * would hide the real plan/run from the model. No Cordis runtime is needed here —
 * `apply` only touches `ctx.tools.register` and `ctx.effect`.
 * Run with: `node --import tsx --test test/unit/mode-tools.test.ts`.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { Context } from '@deepseek-ai/cordis'
import { apply } from '../../packages/mode/src/tools.ts'

/** Collect the tool names one `apply` call registers. */
function registeringContext(): { ctx: Context; names: string[] } {
  const names: string[] = []
  const ctx = {
    tools: {
      register(tool: { name: string }): void {
        names.push(tool.name)
      },
    },
    // The guard waterfall is irrelevant to this test; never invoke its callback.
    effect: () => () => {},
  } as unknown as Context
  return { ctx, names }
}

test('the mode tool row registers suggest_executor and no graph_status', () => {
  const { ctx, names } = registeringContext()
  apply(ctx)
  assert.deepEqual(names, ['suggest_executor'])
  assert.ok(
    !names.includes('graph_status'),
    'graph_status is host-wide in dsh-graph-loop; a scoped duplicate would shadow the live plan/run',
  )
})

test('config never changes which tools the row registers', () => {
  const { ctx, names } = registeringContext()
  apply(ctx, { blockDuplicateSpawn: false, suggestThreshold: 0.2, reuseThreshold: 0.4 })
  assert.deepEqual(names, ['suggest_executor'], 'config never changes which tools the row registers')
})

test('the mode Config type no longer advertises a node list', () => {
  const { ctx, names } = registeringContext()
  // A stale `nodes` key from an old profile override must not resurrect graph_status.
  apply(ctx, { nodes: ['inspect', 'plan'] } as unknown as Parameters<typeof apply>[1])
  assert.deepEqual(names, ['suggest_executor'])
})
