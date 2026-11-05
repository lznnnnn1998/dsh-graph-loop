/**
 * `dsh-graph-loop` — the graph-native agent driver.
 *
 * This is a fork of `@deepseek-ai/dsh-agent-loop` (MIT) with one added seam:
 * every step's node comes from a compiled `TaskPlan`, and the turn ends when the
 * graph is done. Everything else (events, persistence, prompt admission, tool
 * pipeline, cancellation) keeps the stock behaviour so the rest of the harness
 * continues to work unchanged.
 */
export { AgentLoop, AgentLoop as default } from './loop/index.ts'
export * from './scheduler.ts'
