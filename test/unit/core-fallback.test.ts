/**
 * The fallback plan is live: the scheduler installs it for trivial tasks,
 * subagent children and forced fallbacks. It must stay a valid, single-node
 * plan when the composition layer cannot stage a task.
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'

import { fallbackPlan } from '../../packages/core/src/fallback.ts'
import { canKernelDrive } from '../../packages/loop/src/kernel/topology.ts'

test('fallback plan is a valid single-node terminal plan', () => {
  const plan = fallbackPlan({ id: 'task-1', instruction: 'do the task', maxSteps: 5 })
  assert.equal(plan.entry, 'node:respond')
  assert.deepEqual(plan.terminals, ['node:respond'])
  assert.equal(plan.nodes.length, 1)
  assert.equal(plan.edges.length, 0)
  assert.equal(plan.budget.maxSteps, 5)
  assert.equal(plan.nodes[0]?.instruction, 'do the task')
  assert.equal(plan.fallback, true)
  // The fallback's `node:respond` id contains `:`, so the kernel adapter keeps
  // it on the frontier. The fallback is the one shape that never needs routing.
  assert.equal(canKernelDrive(plan), false)
})

test('fallback plan defaults its instruction and budget', () => {
  const plan = fallbackPlan({ id: 'task-2' })
  assert.equal(plan.budget.maxSteps, 8)
  assert.match(plan.nodes[0]?.instruction ?? '', /Complete the user task/u)
})
