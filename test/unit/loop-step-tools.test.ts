/**
 * Unit tests for per-step tool admission and node-intent derivation.
 *
 * Run: node --import tsx --test test/unit/loop-step-tools.test.ts
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { ResolvedToolSet, ToolDefinition } from '@deepseek-ai/dsh-tools'
import {
  DEFAULT_SHELL_TOOLS,
  isMutatingNode,
  mutationObserved,
  restrictToolSet,
  shellFailureTool,
} from '../../packages/loop/src/loop/step-tools.ts'

function toolSetOf(names: readonly string[]): ResolvedToolSet & { disposed: number } {
  const definitions = new Map<string, ToolDefinition>(
    names.map(name => [name, { name } as unknown as ToolDefinition]),
  )
  const set = {
    disposed: 0,
    dispose(): void {
      set.disposed += 1
    },
    view: () => definitions,
  }
  return set
}

test('an empty plan intersection admits no tools instead of widening to the preset', () => {
  const base = toolSetOf(['read', 'write', 'bash'])
  const admitted = restrictToolSet(base, new Set(['missing']))
  assert.equal(admitted.view(undefined).size, 0)
  admitted.dispose()
  assert.equal(base.disposed, 1, 'disposal still closes the base admission')
})

test('a non-empty intersection stays narrowed and never widens', () => {
  const base = toolSetOf(['read', 'write', 'bash'])
  const admitted = restrictToolSet(base, new Set(['write']))
  assert.deepEqual([...admitted.view(undefined).keys()], ['write'])
})

test('the empty-intersection handler reports the visible tools exactly once', () => {
  const base = toolSetOf(['read', 'bash'])
  const reported: (readonly string[])[] = []
  const admitted = restrictToolSet(base, new Set(['missing']), visible => reported.push(visible))
  admitted.view(undefined)
  admitted.view(undefined)
  assert.deepEqual(reported, [['read', 'bash']])
})

test('an empty allowlist still reports the visible tools to the handler', () => {
  const base = toolSetOf(['read', 'bash'])
  const reported: (readonly string[])[] = []
  const admitted = restrictToolSet(base, new Set(), visible => reported.push(visible))
  assert.equal(admitted.view(undefined).size, 0)
  assert.deepEqual(reported, [['read', 'bash']], 'the handler fires for an explicit empty allowlist too')
})

test('mutation intent is derived from the node, not a hardcoded id', () => {
  const dynamicEdit = {
    id: 'd_edit',
    kind: 'tool-call',
    capabilityId: 'tool:edit',
    instruction: 'apply: produce the requested mutation. For new content use `write`.',
    toolAllow: ['edit', 'write'],
  }
  const composedMutate = {
    id: 'n_mutate',
    kind: 'agent-step',
    capabilityId: 'tool:write',
    instruction: 'Apply the required change with write.',
  }
  assert.equal(isMutatingNode(dynamicEdit), true)
  assert.equal(isMutatingNode(composedMutate), true)
  assert.equal(isMutatingNode({ id: 'n_mutate' }), true, 'a mutation stage id is enough')
  assert.equal(isMutatingNode({
    id: 'n_apply',
    kind: 'agent-step',
    capabilityId: 'tool:bash',
    instruction: 'Apply the rename with bash.',
    toolAllow: ['bash'],
  }), true, 'a shell node asked to change something is mutating')
})

test('inspection, verification and answer nodes are not mutations', () => {
  assert.equal(isMutatingNode({
    id: 'd_read',
    kind: 'tool-call',
    capabilityId: 'tool:read',
    instruction: 'inspect the selected artifact with `read`; extract the facts needed by the next node.',
    toolAllow: ['read'],
  }), false)
  assert.equal(isMutatingNode({
    id: 'd_verify',
    kind: 'tool-call',
    capabilityId: 'tool:bash',
    instruction: 'verify the change by running the narrowest check with `bash`; report the exact command and outcome.',
    toolAllow: ['bash'],
  }), false, 'a verification shell node must not be retried as a mutation')
  assert.equal(isMutatingNode({
    id: 'n_verify',
    kind: 'agent-step',
    capabilityId: 'tool:bash',
    instruction: 'Verify the result with bash; report failures explicitly.',
  }), false)
  assert.equal(isMutatingNode({ id: 'n_answer', kind: 'terminal', instruction: 'Summarize what was produced.', toolAllow: [] }), false)
})

test('mutationObserved recognizes writer tools and real shell mutations only', () => {
  assert.equal(mutationObserved([{ name: 'write', isError: false }]), true)
  assert.equal(mutationObserved([{ name: 'str_replace_editor', isError: false, arguments: '{}' }]), true)
  assert.equal(mutationObserved([{ name: 'write', isError: true }]), false, 'a failed write is not a mutation')
  assert.equal(mutationObserved([{ name: 'bash', isError: false, arguments: 'mv old.ts new.ts' }]), true)
  assert.equal(mutationObserved([{ name: 'bash', isError: false, arguments: "sed -i 's/a/b/' src/x.ts" }]), true)
  assert.equal(mutationObserved([{ name: 'bash', isError: false, arguments: 'echo hi > out.txt' }]), true)
  assert.equal(mutationObserved([{ name: 'bash', isError: false, arguments: 'npm test' }]), false)
  assert.equal(mutationObserved([{ name: 'bash', isError: false, arguments: 'echo debug > /dev/null' }]), false)
  assert.equal(mutationObserved([]), false)
})

test('the shell-failure set is configurable, defaulting to bash/pwsh', () => {
  const defaults = new Set(DEFAULT_SHELL_TOOLS)
  assert.deepEqual(DEFAULT_SHELL_TOOLS, ['bash', 'pwsh'])
  assert.equal(shellFailureTool('bash', defaults), 'bash')
  assert.equal(shellFailureTool('pwsh', defaults), 'pwsh')
  assert.equal(shellFailureTool('write', defaults), undefined, 'a non-shell failure stays a normal step error')
  assert.equal(shellFailureTool(undefined, defaults), undefined, 'a result without a matching call is not a failure')

  const custom = new Set(['zsh'])
  assert.equal(shellFailureTool('zsh', custom), 'zsh', 'a deployment shell is honoured')
  assert.equal(shellFailureTool('bash', custom), undefined, 'the default pair is not hardcoded once configured')
})
