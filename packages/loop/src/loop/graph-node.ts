/**
 * The loop-owned source for the per-step graph node directive.
 *
 * The directive is a real `user/message` in the session log, because the model
 * must see it and DSH's admission contract is model-visible ⟺ logged. It is
 * not a human prompt: declaring a dedicated source kind keeps the stock
 * `source.kind === 'user'` filters (for example the Web API's
 * `latestUserQuestion`) from reading the latest node as the human's question,
 * while unknown consumers fall through to the generic user-role treatment.
 * @module dsh-graph-loop/graph-node
 */

import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { UserMessage } from '@deepseek-ai/dsh-session'
declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    'graph-node': { kind: 'graph-node'; nodeId: string }
  }
}

/** Producer-owned source kind recorded on every graph node directive. */
export const GRAPH_NODE_SOURCE = 'graph-node'

/**
 * Build the one directive that steers the next step at one graph node.
 *
 * The `[graph node <id>]` prefix is kept for session-log readability and for
 * the e2e scripts that count node directives; only the source kind separates
 * the directive from a human prompt.
 * @param nodeId - plan node the next step executes.
 * @param directive - node instruction plus the tool-call-interface reminder.
 * @returns a user-role message attributed to the graph node producer.
 */
export function createGraphNodeDirective(nodeId: string, directive: string): UserMessage {
  return createUserMessage({
    content: [{ type: 'text', text: `[graph node ${nodeId}] ${directive}` }],
    source: { kind: GRAPH_NODE_SOURCE, nodeId },
  })
}
