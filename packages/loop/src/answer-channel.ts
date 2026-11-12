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
 * One non-channel call a declared answer terminal refused before dispatch.
 *
 * The refusal is a name-set decision against the admitted set the terminal
 * computed before the request: the call is answered with its own result and
 * never reaches tool resolution, so it cannot become an unknown-tool error, an
 * `AnswerRecord` or a tool call the step is judged on.
 */
export interface ChannelRefusal {
  /** Why the call was refused; the only refusal outcome a terminal can report. */
  readonly code: 'channel-refused'
  /** The tool name the model asked for; the call was never dispatched. */
  readonly tool: string
  /** The declared terminal node that owns the admission decision. */
  readonly nodeId: string
}

/**
 * The model-facing result of one refused call.
 *
 * Not an error result: the terminal completed and the channel is still open.
 * The text names the one admitted tool so the model can answer, and states
 * that the call was not executed. No call argument, output or assistant text
 * is ever read.
 * @param tool - the refused tool name, as the model sent it.
 * @returns the tool-result text answering that call.
 */
export function channelRefusalText(tool: string): string {
  return `Tool "${tool}" was not executed: this answer terminal admits only the \`${ANSWER_TOOL}\` tool. Call \`${ANSWER_TOOL}\` with the answer text; any other call is refused before it runs.`
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
