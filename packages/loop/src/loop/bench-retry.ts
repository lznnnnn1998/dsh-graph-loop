/**
 * The loop-owned source for benchmark-guard retry corrections.
 *
 * The retry corrections are model-visible `user/message` events (a step must
 * see them), but they are synthetic producers, not human prompts. They are
 * gated behind `benchGuards` (default `false`); the dedicated source kind
 * keeps the stock `source.kind === 'user'` filters from reading a correction
 * as the human's question.
 * @module dsh-graph-loop/bench-retry
 */

import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { UserMessage } from '@deepseek-ai/dsh-session'
declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    'bench-retry': { kind: 'bench-retry' }
  }
}

/** Producer-owned source kind recorded on every benchmark retry correction. */
export const BENCH_RETRY_SOURCE = 'bench-retry'

/**
 * Build one benchmark-guard retry correction.
 * @param text - correction shown to the model for the retried step.
 * @returns a user-role message attributed to the benchmark retry guard.
 */
export function createBenchRetryCorrection(text: string): UserMessage {
  return createUserMessage({
    content: [{ type: 'text', text }],
    source: { kind: BENCH_RETRY_SOURCE },
  })
}
