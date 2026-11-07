/**
 * Source contract for the per-step graph node directive.
 *
 * The directive stays a logged `user/message` because the model must see it and
 * DSH's admission contract is model-visible ⟺ logged. It must not claim the
 * human `user` source: that is what the stock Web API reads as the latest
 * question. These tests pin both halves of that contract.
 *
 * Run: node --import tsx --test test/unit/loop-graph-node.test.ts
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { Message } from '@deepseek-ai/dsh-llm'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import {
  createGraphNodeDirective,
  GRAPH_NODE_SOURCE,
} from '../../packages/loop/src/loop/graph-node.ts'

/**
 * The stock DSH Web API's latest-question filter, reproduced verbatim from
 * `packages/web/web-deepseek-api/src/index.ts` (`latestUserQuestion`). It is
 * one line so a copy cannot drift silently, and it is the exact consumer this
 * source kind protects.
 */
function latestUserQuestion(messages: readonly Message[]): string | undefined {
  const prompt = messages.findLast(message => message.role === 'user' && message.source.kind === 'user')
  if (prompt === undefined) return undefined
  return prompt.content.flatMap(block => block.type === 'text' ? [block.text] : []).join('\n')
}

function humanMessage(text: string): Message {
  return createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } })
}

function textOf(message: Message): string {
  return message.content.flatMap(block => block.type === 'text' ? [block.text] : []).join('\n')
}

test('a graph node directive is a user-role message with the graph-node source', () => {
  const directive = createGraphNodeDirective('n_verify', 'Verify the artifact.')

  assert.equal(directive.role, 'user', 'the model still reads it as user-turn content')
  assert.equal(directive.source.kind, 'graph-node')
  assert.equal(directive.source.kind === 'graph-node' ? directive.source.nodeId : undefined, 'n_verify')
  assert.equal(textOf(directive), '[graph node n_verify] Verify the artifact.', 'log/UI prefix is kept')
  assert.equal(GRAPH_NODE_SOURCE, 'graph-node')
})

test('the Web latest-question filter ignores a later graph node directive', () => {
  const human = humanMessage('explain how the config loader works')
  const directive = createGraphNodeDirective('n_mutate', 'Make the requested change.')
  const messages = [human, directive]

  // A role-only filter would pick the directive: the source kind is the discriminator.
  assert.equal(messages.findLast(message => message.role === 'user'), directive)
  assert.equal(latestUserQuestion(messages), 'explain how the config loader works')

  // The real human message still matches when it is the last user-role message.
  assert.equal(latestUserQuestion([directive, human]), 'explain how the config loader works')
})

test('a directive-only history yields no human question', () => {
  const messages = [
    createGraphNodeDirective('n_inspect', 'Inspect the workspace.'),
    createGraphNodeDirective('n_answer', 'Answer the task.'),
  ]
  assert.equal(latestUserQuestion(messages), undefined)
})
