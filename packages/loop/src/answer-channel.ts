/**
 * answer-channel.ts — the typed answer channel.
 *
 * A turn answers by *executing* one `graph_answer` call: the terminal step's
 * answer text is that call's `text` argument, never the step's free assistant
 * text. An assistant message is display only, so printed tool-call syntax
 * cannot be a record. This module owns the channel name and the pure projection
 * from a step's observed tool calls to the {@link AnswerRecord} the boundary
 * gate admits; the tool registration, the driver and the admission rule share
 * it so the admitted tool and the read record cannot drift apart.
 */
import type { AnswerRecord } from 'dsh-graph-loop-core/graph-schema'

/** The one tool that can produce a turn's answer record. */
export const ANSWER_TOOL = 'graph_answer'

/** One tool call a step observably made (the driver's step outcome shape). */
export interface AnswerChannelCall {
  readonly name: string
  readonly isError: boolean
  readonly arguments?: string
}

/**
 * Project one terminal step's observed calls to the answer record.
 *
 * Exactly one successful `graph_answer` call is the answer; any other tool the
 * same step called is a real call the answer cannot hide, so it is counted in
 * `toolCalls` and the admission rule refuses the record. A call carrying no
 * usable `text` argument yields an empty-text record (the admission rule owns
 * the emptiness verdict); a step that made no successful channel call yields no
 * record at all, so the terminal is refused as `missing-record`.
 *
 * @param tools - every tool call the terminal step observably made.
 * @param evidenceRefs - obligation node ids the ledger records as satisfied.
 * @returns the typed record, or undefined when the step executed no channel call.
 */
export function answerRecordFrom(
  tools: readonly AnswerChannelCall[] | undefined,
  evidenceRefs: readonly string[],
): AnswerRecord | undefined {
  const calls = (tools ?? []).filter(tool => tool.name === ANSWER_TOOL && !tool.isError)
  if (calls.length !== 1) return undefined
  return {
    text: answerTextOf(calls[0].arguments),
    evidenceRefs,
    toolCalls: (tools ?? []).filter(tool => tool.name !== ANSWER_TOOL).length,
  }
}

/** The `text` argument of one executed channel call, or '' when it carries none. */
function answerTextOf(args: string | undefined): string {
  if (args === undefined) return ''
  try {
    const parsed: unknown = JSON.parse(args)
    if (typeof parsed !== 'object' || parsed === null) return ''
    const text = (parsed as { text?: unknown }).text
    return typeof text === 'string' ? text : ''
  } catch {
    return ''
  }
}
