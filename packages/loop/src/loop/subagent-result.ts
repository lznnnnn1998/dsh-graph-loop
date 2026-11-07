/**
 * The loop-owned source for a subagent batch result injected into the parent.
 *
 * A subagent node's summary is model-visible context for the next parent step,
 * so it is injected as a real `user/message` (model-visible ⟺ logged). It is
 * not a human prompt: declaring a dedicated source kind keeps the stock
 * `source.kind === 'user'` filters (for example the Web API's
 * `latestUserQuestion`) from reading a child result as the human's question,
 * while unknown consumers fall through to the generic user-role treatment.
 * @module dsh-graph-loop/subagent-result
 */

import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { UserMessage } from '@deepseek-ai/dsh-session'
declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    'subagent-result': { kind: 'subagent-result'; nodeId: string }
  }
}

/** Producer-owned source kind recorded on every injected subagent result. */
export const SUBAGENT_RESULT_SOURCE = 'subagent-result'

/**
 * Build the parent-visible summary of one finished subagent graph node.
 *
 * The `[subagent <id>]` prefix and the stop reason are kept for session-log
 * readability and for the e2e scripts that count child results; only the
 * source kind separates the result from a human prompt.
 * @param nodeId - plan node the child activation ran for.
 * @param stopReason - child stop reason, or `undefined` when it completed cleanly.
 * @param text - child output text, already trimmed and bounded by the caller.
 * @returns a user-role message attributed to the subagent batch producer.
 */
export function createSubagentResult(nodeId: string, stopReason: unknown, text: string): UserMessage {
  const body = text === '' ? '(no output)' : text
  return createUserMessage({
    content: [{ type: 'text', text: `[subagent ${nodeId}] (${String(stopReason)}) ${body}` }],
    source: { kind: SUBAGENT_RESULT_SOURCE, nodeId },
  })
}
