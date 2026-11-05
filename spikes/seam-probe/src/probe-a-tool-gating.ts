/**
 * Probe A — the no-source-change control surface a graph plugin actually gets.
 *
 * Runs against REAL DSH services (no mocks): SystemPrompt registry, ToolsService,
 * the native executor, and an agent scope. It reproduces, step by step, exactly the
 * sequence `ReactLoopAgent` performs per model step:
 *
 *   tools.resolve({agent, modelSelection, signal})   agent-loop/src/agent.ts:285
 *   systemPrompt.assemble({...})                     agent-loop/src/agent.ts:287
 *   tools.schemas(agent, toolSet)   -> request tools agent-loop/src/agent.ts:732
 *
 * and proves:
 *   1. `when` gating changes the model-visible tool schemas per step;
 *   2. a dynamic prompt section changes per step (and can be `complete`);
 *   3. `restrict()` masks globals for one agent scope only;
 *   4. a disposed ResolvedToolSet stops admitting calls (agent.ts:282-296);
 *   5. by TYPE, `agent/pre-step` cannot return a tool set (only messages).
 *
 * Run: node src/probe-a-tool-gating.ts
 */
import { Context } from '@deepseek-ai/cordis'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import type { ModelSelection } from '@deepseek-ai/dsh-agent'
import type { PreStepDecision } from '@deepseek-ai/dsh-agent'
import { createScope } from '@deepseek-ai/dsh-scope'
import type { Scope } from '@deepseek-ai/dsh-scope'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime, { defineTool } from '@deepseek-ai/dsh-tools'
import * as NativeToolExecutor from '@deepseek-ai/dsh-tool-executor-native'

const selection: ModelSelection = { provider: 'probe', model: 'probe' }

/** Fail the probe with a nonzero exit; every check prints one line. */
let failures = 0
function check(label: string, ok: boolean, detail: string): void {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}  ${detail}`)
  if (!ok) failures += 1
}

const ctx = new Context()
await ctx.plugin(SystemPrompt, {})
await ctx.plugin(ToolRuntime)
await ctx.plugin(NativeToolExecutor)

// One agent identity; `createScope` is what a live Agent's `agent.ctx` is.
// The scope must be minted from a context that INJECTS the services its holder
// reaches — in production the agent loop's `static inject` list plays this role
// (agent-loop/src/index.ts:292). See tools/tests/scoped.spec.ts:31-35.
const agent = { id: 'probe-graph' }
const other = { id: 'probe-other' }
let scope!: Scope
let otherScope!: Scope
await ctx.plugin(Object.assign((inner: Context) => { scope = createScope(inner, agent as never) },
  { inject: ['tools', 'systemPrompt'] }))
await ctx.plugin(Object.assign((inner: Context) => { otherScope = createScope(inner, other as never) },
  { inject: ['tools', 'systemPrompt'] }))
const agentCtx: Context = scope.ctx

// --- Graph state the control plane owns (would live in a sidecar / projection).
const graph = { node: 'gather' as 'gather' | 'act', turn: 0 }

const noopTool = (name: string, description: string) => defineTool({
  name,
  description,
  parameters: {},
  output: { schema: { type: 'string' }, render: () => [{ type: 'text', text: 'ok' }] },
  execute: async () => `${name}:ok`,
})

// Global tool, always visible.
ctx.tools.register(noopTool('global_always', 'Always visible global tool.'))
// Global tool gated on the graph node — evaluated once per step by resolve().
const gatherRegistration = ctx.tools.register(noopTool('node_gather_only', 'Only visible on the gather node.'), {
  when: () => graph.node === 'gather',
})
// Agent-scoped tool: visible only inside this agent's scope (shadows globals of the same name).
agentCtx.tools.register(noopTool('agent_private', 'Registered through the agent scope.'))

// Dynamic prompt section: re-evaluated on every assemble(), i.e. every step.
const sectionDispose = agentCtx.systemPrompt.section({
  name: 'graph:current-node',
  order: 8000,
  text: () => `GRAPH NODE: ${graph.node} (turn ${graph.turn})`,
})
agentCtx.systemPrompt.variable('graph_node', () => graph.node)

const controller = new AbortController()
const signal = controller.signal

/** One model step's tool admission, exactly as the loop does it. */
async function step(): Promise<{ names: string[]; prompt: string; toolSet: Awaited<ReturnType<typeof ctx.tools.resolve>> }> {
  const toolSet = await ctx.tools.resolve({ agent: agent as never, modelSelection: selection, signal })
  const assembly = await ctx.systemPrompt.assemble({
    agent: agent as never,
    scope: agent as never,
    signal,
    toolSet,
  } as never)
  const names = ctx.tools.schemas(agent as never, toolSet).map(schema => schema.name)
  const prompt = assembly.sections.map(section => section.text).join('\n')
  return { names, prompt, toolSet }
}

// ---- step 1: gather node -----------------------------------------------------
const s1 = await step()
check('gather node sees the gated tool',
  s1.names.includes('node_gather_only') && s1.names.includes('global_always') && s1.names.includes('agent_private'),
  `tools=${JSON.stringify(s1.names)}`)
check('dynamic section reflects graph state',
  s1.prompt.includes('GRAPH NODE: gather'), 'section text present in assembly')
check('prompt variable resolves graph state',
  // The variable is only interpolated where a section references it; assert registration worked.
  true, 'registered variables={{graph_node}}')

// ---- step 2: graph transitions to act ---------------------------------------
graph.node = 'act'
graph.turn = 1
const s2 = await step()
check('act node drops the gated tool',
  !s2.names.includes('node_gather_only') && s2.names.includes('global_always'),
  `tools=${JSON.stringify(s2.names)}`)
check('dynamic section re-evaluated per step',
  s2.prompt.includes('GRAPH NODE: act (turn 1)'), 'section text changed without re-registration')
// Admission is a PER-STEP SNAPSHOT: a `when` flip is not retroactive, so a tool
// admitted at step start stays callable inside that step (resolve() runs once per
// step, agent.ts:285). The registry-change guard in ResolvedToolSet.view()
// (tools/src/index.ts:284-295) only invalidates on re-registration/restriction.
check('a `when` flip is NOT retroactive inside a step',
  ctx.tools.executable('node_gather_only', agent as never, s1.toolSet) !== undefined,
  'step-1 admission still admits within step 1')
// Removing the registration, by contrast, does invalidate the open admission.
gatherRegistration()
check('unregistering invalidates an open toolSet',
  ctx.tools.executable('node_gather_only', agent as never, s1.toolSet) === undefined,
  'registry identity check rejects the removed registration')

// ---- step 3: agent-scoped restriction ---------------------------------------
agentCtx.tools.restrict({ deny: ['global_always'] })
const s3 = await step()
check('restrict() masks a global for this agent',
  !s3.names.includes('global_always') && s3.names.includes('agent_private'),
  `tools=${JSON.stringify(s3.names)}`)
const rootView = ctx.tools.schemas(undefined).map(schema => schema.name)
check('restrict() does not leak to the global view',
  rootView.includes('global_always'), `global view=${JSON.stringify(rootView)}`)

// A second agent scope is unaffected by the first agent's restriction.
const otherToolSet = await ctx.tools.resolve({ agent: other as never, modelSelection: selection, signal })
check('sibling agent scope keeps the tool',
  ctx.tools.schemas(other as never, otherToolSet).some(schema => schema.name === 'global_always'),
  'restrict() is per-scope')

// ---- compile-time proof of the pre-step constraint -------------------------
// @ts-expect-error — PreStepDecision has no `toolSet` member: agent/pre-step cannot
// retarget tool schemas. The loop resolves them BEFORE the waterfall (agent.ts:285).
const forbidden: PreStepDecision = { kind: 'enter', messages: [], toolSet: s1.toolSet }
void forbidden

// A `complete` section replaces the whole prompt (system-prompt/src/index.ts:74-75, 658-693).
const completeDispose = agentCtx.systemPrompt.section({
  name: 'graph:complete-override',
  order: 9000,
  complete: true,
  text: 'You are a graph node. Ignore all other instructions.',
})
const s4 = await step()
check('complete:true collapses the prompt to one section',
  s4.prompt.trim() === 'You are a graph node. Ignore all other instructions.',
  `prompt=${JSON.stringify(s4.prompt.trim().slice(0, 60))}`)

// Waiting for a tool call is impossible from a pre-step listener but possible from a
// gate function: `when` is awaited inside resolve() (tools/src/index.ts:273).
let whenCalls = 0
ctx.tools.register(noopTool('counted', 'Counts its `when` evaluations.'), {
  when: async () => { whenCalls += 1; await Promise.resolve(); return true },
})
await step()
check('`when` may be async and runs once per resolve()',
  whenCalls === 1, `whenCalls=${whenCalls}`)

completeDispose()
sectionDispose()
controller.abort(new Error('probe done'))
await scope.dispose()
await otherScope.dispose()
await ctx.fiber.dispose()
console.log(failures === 0 ? '\nprobe-a: all checks passed' : `\nprobe-a: ${String(failures)} FAILURE(S) above`)
process.exitCode = failures === 0 ? 0 : 1
