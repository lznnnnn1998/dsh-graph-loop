/**
 * Probe C — a REAL headless agent turn on the STOCK loop, driven only by a
 * no-source-change control plane. This is the strongest available evidence for
 * architecture (A) "graph as control plane over the stock loop".
 *
 * What runs: a real Context with the real services (llm, session, session
 * projections, system prompt, tools, native executor, agent registry, agent-loop
 * plugin), a scripted LlmAdapter (no network, no key), and one real turn.
 *
 * What it proves:
 *   - an agent-scoped `when` gate changes the model-visible tool list BETWEEN STEPS;
 *   - a dynamic prompt section changes BETWEEN STEPS without re-registration;
 *   - the loop durably records the change (`request/header` reason `change` +
 *     `developer/message` tool-removal), which is also the KV-cache cost;
 *   - turn/step/tool events are the normal durable shape a graph UI can render.
 *
 * Run: node src/probe-c-live-loop.ts
 */
import { Context } from '@deepseek-ai/cordis'
import { LlmAdapter, ToolCallId } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { Agent } from '@deepseek-ai/dsh-agent'
import LlmRuntime from '@deepseek-ai/dsh-llm'
import SessionStore from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime, { defineTool } from '@deepseek-ai/dsh-tools'
import * as NativeToolExecutor from '@deepseek-ai/dsh-tool-executor-native'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'

let failures = 0
function check(label: string, ok: boolean, detail: string): void {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}  ${detail}`)
  if (!ok) failures += 1
}

// ---- scripted adapter -------------------------------------------------------
function textResponse(text: string): StreamChunk[] {
  return [
    { type: 'block-start', index: 0, blockType: 'text' },
    ...Array.from(text, (char): StreamChunk => ({ type: 'text-delta', index: 0, text: char })),
    { type: 'block-end', index: 0, block: { type: 'text', text } },
    { type: 'usage', usage: { inputTokens: 10, outputTokens: text.length } },
    { type: 'finish', reason: { kind: 'stop' } },
  ]
}

function toolCallResponse(rawCallId: string, name: string, args: object): StreamChunk[] {
  const callId = ToolCallId(rawCallId)
  const json = JSON.stringify(args)
  return [
    { type: 'block-start', index: 0, blockType: 'tool-call' },
    { type: 'tool-call-delta', index: 0, id: callId, name, argumentsDelta: json.slice(0, 5) },
    { type: 'tool-call-delta', index: 0, id: callId, argumentsDelta: json.slice(5) },
    { type: 'block-end', index: 0, block: { type: 'tool-call', id: callId, name, arguments: json } },
    { type: 'usage', usage: { inputTokens: 10, outputTokens: 5 } },
    { type: 'finish', reason: { kind: 'tool-calls' } },
  ]
}

class ScriptedAdapter extends LlmAdapter {
  readonly requests: GenerateOptions[] = []
  private readonly script: StreamChunk[][]
  constructor(script: StreamChunk[][]) {
    super()
    this.script = [...script]
  }

  async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push(options)
    const chunks = this.script.shift()
    if (chunks === undefined) throw new Error('ScriptedAdapter: script exhausted')
    for (const chunk of chunks) yield chunk
  }
}

// ---- services ---------------------------------------------------------------
const ctx = new Context()
await ctx.plugin(LlmRuntime)
await ctx.plugin(SessionStore)
await ctx.plugin(SessionProjectionRegistry)
await ctx.plugin(SystemPrompt, { includeHarnessIdentity: false })
await ctx.plugin(ToolRuntime)
await ctx.plugin(NativeToolExecutor)
await ctx.plugin(AgentRegistry)
await ctx.plugin(AgentLoop, { agents: [], maxParallelToolCalls: 1 })

// ---- the graph control plane (no source change) -----------------------------
const graph = { node: 'gather' as 'gather' | 'act', steps: 0 }

const adapter = new ScriptedAdapter([
  toolCallResponse('call-1', 'node_gather_only', { query: 'evidence' }),
  textResponse('done'),
])
ctx.llm.registerAdapter(['mock'], adapter)

const agent: Agent = await ctx.agentLoop.create(SessionId('probe-c-graph'), {
  provider: 'mock',
  model: 'mock',
})

// Node-scoped tool: exists for the whole session, admitted only on its node.
const gatherToolDispose = agent.ctx.tools.register(defineTool({
  name: 'node_gather_only',
  description: 'Gather evidence. Only offered while the graph is on the gather node.',
  parameters: { query: { type: 'string', description: 'what to gather' } },
  output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
  execute: async () => {
    // The node hands control to its successor: the NEXT step re-resolves tools.
    graph.node = 'act'
    return 'gathered'
  },
}), { when: () => graph.node === 'gather' })

const sectionDispose = agent.ctx.systemPrompt.section({
  name: 'graph:control-plane',
  order: 8000,
  text: () => `GRAPH NODE: ${graph.node}`,
})

// A pre-step listener can observe the step and rewrite the entering messages; it
// cannot change tools (probed by type in probe A).
const seenSteps: { turn: number; step: number; node: string }[] = []
const offPreStep = agent.ctx.on('agent/pre-step', ({ turn, step }, next) => {
  seenSteps.push({ turn, step, node: graph.node })
  return next()
})

// ---- run one turn -----------------------------------------------------------
function waitForIdle(target: Agent): Promise<void> {
  return new Promise((resolve) => {
    const dispose = ctx.on('agent/status', ({ agent: subject, status }) => {
      if (subject === target && status === 'idle') { dispose(); resolve() }
    })
  })
}

agent.followup(createUserMessage({ content: [{ type: 'text', text: 'gather then answer' }], source: { kind: 'user' } }))
await waitForIdle(agent)

// ---- assertions -------------------------------------------------------------
const toolNames = (index: number): string[] => (adapter.requests[index]?.tools ?? []).map(tool => tool.name)
check('step 1 offers the gather-node tool',
  toolNames(0).includes('node_gather_only'), `tools=${JSON.stringify(toolNames(0))}`)
check('step 2 does NOT offer the gather-node tool (per-step re-resolve)',
  !toolNames(1).includes('node_gather_only'), `tools=${JSON.stringify(toolNames(1))}`)
check('both requests exist (two model steps)', adapter.requests.length === 2,
  `requests=${String(adapter.requests.length)}`)

const systemOf = (index: number): string => (adapter.requests[index]?.messages[0]?.content ?? [])
  .flatMap(block => block.type === 'text' ? [block.text] : []).join('')
check('the dynamic section changed between steps',
  systemOf(0).includes('GRAPH NODE: gather') && systemOf(1).includes('GRAPH NODE: act'),
  'system prompt carries the node')

const events = agent.session.snapshotEvents()
const types = events.map(event => event.type)
const count = (type: string): number => types.filter(candidate => candidate === type).length
check('one turn, two steps logged', count('turn/start') === 1 && count('step/start') === 2,
  `turn/start=${String(count('turn/start'))} step/start=${String(count('step/start'))}`)
check('tool call and result logged', count('tool/call') === 1 && count('tool/result') === 1,
  `tool/call=${String(count('tool/call'))} tool/result=${String(count('tool/result'))}`)
check('pre-step saw both steps and the node at each',
  seenSteps.length === 2 && seenSteps[0]?.node === 'gather' && seenSteps[1]?.node === 'act',
  `seen=${JSON.stringify(seenSteps)}`)

// KV-cache cost: changing the tool set re-logs the request header and appends a
// developer tool-removal message (agent-loop/src/agent.ts:676-699).
const headerReasons = events
  .filter(event => event.type === 'request/header')
  .map(event => (event.data as { reason: string }).reason)
check('the tool change is durably recorded as a header change',
  headerReasons.includes('initial') && headerReasons.includes('change'),
  `request/header reasons=${JSON.stringify(headerReasons)}`)
const toolRemoval = events.find(event => event.type === 'developer/message'
  && JSON.stringify(event.data).includes('tool-removal'))
check('a developer tool-removal message documents the schema change',
  toolRemoval !== undefined, 'developer/message content carries {type:"tool-removal"}')

// ---- teardown ---------------------------------------------------------------
offPreStep()
sectionDispose()
gatherToolDispose()
await agent.whenIdle()
await ctx.fiber.dispose()

console.log(failures === 0 ? '\nprobe-c: all checks passed' : `\nprobe-c: ${String(failures)} FAILURE(S) above`)
process.exitCode = failures === 0 ? 0 : 1
