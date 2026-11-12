/**
 * The fallback plan is live: the scheduler installs it for trivial tasks,
 * subagent children and forced fallbacks. R4: it is the minimal turn skeleton
 * (`orient -> answer`), never one node that is also its own terminal.
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'

import { fallbackPlan } from '../../packages/core/src/fallback.ts'
import { canKernelDrive } from '../../packages/loop/src/kernel/topology.ts'

test('fallback plan is the two-node turn skeleton with an answer-only terminal', () => {
  const plan = fallbackPlan({ id: 'task-1', instruction: 'do the task', maxSteps: 5 })
  assert.equal(plan.entry, 'orient.1.1')
  assert.deepEqual(plan.terminals, ['answer.1.1'])
  assert.equal(plan.nodes.length, 2)
  assert.equal(plan.nodes[0]?.kind, 'agent-step')
  assert.equal(plan.nodes[1]?.kind, 'terminal')
  assert.deepEqual(plan.nodes[1]?.toolAllow, [], 'the answer terminal is answer-only')
  assert.deepEqual(plan.edges, [{ from: 'orient.1.1', to: 'answer.1.1', kind: 'control' }])
  assert.equal(plan.budget.maxSteps, 5)
  assert.equal(plan.nodes[0]?.instruction, 'do the task')
  assert.equal(plan.fallback, true)
  // R4 ids contain `.`, which LangGraph rejects as node names, so the kernel
  // declines and the frontier executes the skeleton on every engine.
  assert.equal(canKernelDrive(plan), false)
})

test('fallback plan defaults its instruction and budget', () => {
  const plan = fallbackPlan({ id: 'task-2' })
  assert.equal(plan.budget.maxSteps, 8)
  assert.match(plan.nodes[0]?.instruction ?? '', /Complete the user task/u)
})
