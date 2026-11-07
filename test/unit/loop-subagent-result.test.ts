/**
 * Source contract for injected subagent batch results.
 *
 * A child summary is model-visible `user/message` context, so it is logged as
 * one — but it must not claim the human `user` source: the stock Web API reads
 * the last `role === 'user' && source.kind === 'user'` message as the latest
 * question, and a synthetic child result would hijack it. These tests pin the
 * producer-owned source kind and reproduce the stock filter verbatim.
 *
 * Run: node --import tsx --test test/unit/loop-subagent-result.test.ts
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { Message } from '@deepseek-ai/dsh-llm'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import {
  createSubagentResult,
  SUBAGENT_RESULT_SOURCE,
} from '../../packages/loop/src/loop/subagent-result.ts'

/**
 * The stock DSH Web API's latest-question filter, reproduced verbatim from
 * `packages/web/web-deepseek-api/src/index.ts` (`latestUserQuestion`). It is
 * the exact consumer this source kind protects.
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

test('a subagent result is a user-role message with the subagent-result source', () => {
  const result = createSubagentResult('d_fetch', 'completed', 'child ok')

  assert.equal(result.role, 'user', 'the parent model still reads it as user-turn content')
  assert.equal(result.source.kind, 'subagent-result')
  assert.equal(result.source.kind === 'subagent-result' ? result.source.nodeId : undefined, 'd_fetch')
  assert.equal(textOf(result), '[subagent d_fetch] (completed) child ok', 'log/UI prefix is kept')
  assert.equal(SUBAGENT_RESULT_SOURCE, 'subagent-result')
})

test('an empty child output still records a readable, non-human result', () => {
  const result = createSubagentResult('d_search', undefined, '')

  assert.equal(textOf(result), '[subagent d_search] (undefined) (no output)')
  assert.notEqual(result.source.kind, 'user')
})

test('the Web latest-question filter ignores a later subagent result', () => {
  const human = humanMessage('research the latest state of the art and compare approaches')
  const child = createSubagentResult('d_fetch', 'completed', 'child ok')
  const messages = [human, child]

  // A role-only filter would pick the child summary: the source kind is the discriminator.
  assert.equal(messages.findLast(message => message.role === 'user'), child)
  assert.equal(latestUserQuestion(messages), 'research the latest state of the art and compare approaches')

  // The real human message still matches when it is the last user-role message.
  assert.equal(latestUserQuestion([child, human]), 'research the latest state of the art and compare approaches')
})

test('a batch of child results alone yields no human question', () => {
  const messages = [
    createSubagentResult('d_search', 'completed', 'search ok'),
    createSubagentResult('d_fetch', 'completed', 'child ok'),
  ]
  assert.equal(latestUserQuestion(messages), undefined)
})
