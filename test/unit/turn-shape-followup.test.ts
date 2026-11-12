/**
 * turn-shape-followup.test.ts — R4 drill: a follow-up message in an existing
 * session installs a multi-node turn skeleton (>= 2 nodes, entry != terminal,
 * exactly one answer-only terminal) and the turn produces an answer.
 *
 * A follow-up turn is planned from its own text, so a short "and then?" takes
 * the triage branch (`fallbackPlan`) and a longer follow-up that fills no
 * capability stage takes the generic composer (`synthesizeComposition`). On the
 * parent tree both install a single node whose entry is its only terminal, so
 * the first step is the turn's endpoint: a tool-calling first step ends the
 * turn with zero assistant text. This drill fails there and passes on the
 * producer + install-gate fix.
 *
 * The two plans route differently and both routes are asserted by name: the R4
 * skeleton ids contain `.`, so `canKernelDrive` keeps them on the frontier;
 * the generic composer's `n_*` ids are kernel-drivable, so `minimal` and
 * `langgraph` execute it through the kernel. The turn half runs all three
 * engine settings.
 *
 * Run: node --import tsx --test test/unit/turn-shape-followup.test.ts
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'

import type { RegistryGraph, TaskPlan } from '../../packages/core/src/graph-schema.ts'
import { validateTaskPlan } from '../../packages/core/src/graph-schema.ts'
import { buildRegistrySnapshot, type ToolSource } from '../../packages/core/src/registry.ts'
import { canKernelDrive } from '../../packages/loop/src/kernel/topology.ts'
import { ReactLoopAgent } from '../../packages/loop/src/loop/agent.ts'
import { createGraphTurnDriver } from '../../packages/loop/src/scheduler.ts'

const ENGINES = ['off', 'minimal', 'langgraph'] as const
type Engine = typeof ENGINES[number]

// The live-profile shape: annotated core tools plus unannotated MCP/craft tools.
const CORE_TOOL_NAMES = [
  'read', 'read_image', 'write', 'edit', 'glob', 'grep', 'bash', 'web_search',
  'web_fetch', 'todo_write', 'present', 'skill', 'ask_user_question', 'send_message',
  'list_agents', 'run_code', 'working_directory', 'workflow',
] as const
const CRAFT_FAMILIES = [
  'gridcraft', 'wordcraft', 'deckcraft', 'pdfcraft', 'cadcraft', 'vectorcraft',
  'photocraft', 'lightcraft', 'filmcraft', 'soundcraft', 'effectcraft',
  'designcraft', 'figcraft', 'texturecraft',
] as const
const CRAFT_TOOLS = 98

const CORE_TOOLS: readonly ToolSource[] = CORE_TOOL_NAMES.map(name => ({
  name,
  description: `Annotated core tool ${name}.`,
  parameters: { type: 'object', properties: {} },
}))
const CRAFT_TOOLS_SOURCES: readonly ToolSource[] = Array.from({ length: CRAFT_TOOLS }, (_, index) => ({
  name: `${CRAFT_FAMILIES[index % CRAFT_FAMILIES.length]!}_op${index}`,
  description: `Unannotated MCP tool ${index} from a craft package.`,
  parameters: { type: 'object', properties: {} },
}))
const registry = buildRegistrySnapshot({ tools: [...CORE_TOOLS, ...CRAFT_TOOLS_SOURCES] })
const graph = registry.graph

/** Follow-up classes: short (triage) and a longer one that fills no stage (compose). */
const CASE_A = 'and then?'
const CASE_B = 'so what should we do about that now?'

/** The R4 shape every follow-up turn must install. */
function assertTurnShape(plan: TaskPlan, label: string): void {
  assert.ok(plan.nodes.length >= 2, `${label}: the turn plan needs >= 2 nodes, got ${String(plan.nodes.length)}`)
  assert.equal(plan.terminals.length, 1, `${label}: exactly one terminal, got ${JSON.stringify(plan.terminals)}`)
  assert.equal(plan.terminals.includes(plan.entry), false, `${label}: the entry ${plan.entry} must not be the terminal`)
  const terminal = plan.nodes.find(node => node.id === plan.terminals[0])
  assert.ok(terminal, `${label}: the terminal ${String(plan.terminals[0])} must be a node`)
  assert.equal(terminal.kind, 'terminal', `${label}: the terminal must be an answer-only terminal node`)
  assert.deepEqual([...(terminal.toolAllow ?? [])], [], `${label}: the answer terminal must not allow tools`)
}

test('a follow-up turn installs the multi-node skeleton (triage + generic compose)', async () => {
  for (const [label, text, path] of [['A', CASE_A, 'triage'], ['B', CASE_B, 'compose']] as const) {
    const driver = createGraphTurnDriver({ requireAnswerChannel: false, mode: 'dynamic', graphProvider: () => graph })
    const snapshot = await driver.beginTurn({ text })
    assertTurnShape(snapshot.plan, label)
    assert.equal(snapshot.path, path, `${label}: branch provenance (${snapshot.rationale.join(' | ')})`)
  }
})

test('the skeleton and the generic composer keep different execution routes, by name', async () => {
  const triage = await createGraphTurnDriver({ requireAnswerChannel: false, mode: 'dynamic', graphProvider: () => graph })
    .beginTurn({ text: CASE_A })
  // R4 ids (`orient.1.1`, `answer.1.1`) contain `.`, so the kernel declines and
  // the frontier executes the skeleton on all three engine settings.
  assert.equal(canKernelDrive(triage.plan), false, 'the R4 skeleton stays on the frontier')
  const composed = await createGraphTurnDriver({ requireAnswerChannel: false, mode: 'dynamic', graphProvider: () => graph })
    .beginTurn({ text: CASE_B })
  assert.equal(canKernelDrive(composed.plan), true, 'the n_* generic plan is kernel-driven on minimal/langgraph')
})

test('R4 schema: a one-node plan is rejected under a new code', () => {
  const oneNode: TaskPlan = {
    id: 'drill:one-node',
    templateId: 'drill',
    version: 1,
    entry: 'node:respond',
    terminals: ['node:respond'],
    nodes: [{ id: 'node:respond', kind: 'agent-step', executor: 'step', instruction: 'do it' }],
    edges: [],
    budget: { maxNodes: 1, maxSteps: 8, maxTokens: 10_000, maxWallMs: 60_000, maxReplans: 0 },
    toolUniverse: [],
    gatePolicy: 'cold',
    fallback: true,
    confidence: 0,
    compiledDigest: 'drill:one-node',
  }
  const validation = validateTaskPlan(registry.graph, oneNode)
  assert.equal(validation.ok, false, 'a one-node plan violates the multi-node invariant')
  assert.ok(validation.errors.some(error => error.code === 'P031'), validation.errors.map(error => `${error.code} ${error.message}`).join('; '))
  assert.ok(validation.errors.some(error => error.code === 'P032'), 'the entry is also the terminal')
})

// ---------------------------------------------------------------------------
// Turn half: the terminal must be a distinct answer node, so the turn answers.
// ---------------------------------------------------------------------------

interface RecordedEvent {
  readonly type: string
  readonly data: Record<string, unknown>
}
interface StepScript {
  readonly tools: readonly { readonly name: string; readonly isError?: boolean }[]
  readonly end: { readonly kind: 'completed' } | null
  readonly text?: string
}

/** Bind the real turn() body to a real driver whose real beginTurn plans the follow-up. */
function followupHarness(engine: Engine, text: string): {
  readonly agent: ReactLoopAgent
  readonly events: RecordedEvent[]
} {
  const events: RecordedEvent[] = []
  const listeners: ((session: unknown, event: { type: string; data: Record<string, unknown> }) => void)[] = []
  const driver = createGraphTurnDriver({ requireAnswerChannel: false,
    mode: 'dynamic',
    kernel: engine === 'off' ? 'off' : engine,
    graphProvider: () => graph,
  })
  const scripts: readonly StepScript[] = [
    // orient: the follow-up opens with a tool call, then needs another step.
    { tools: [{ name: 'bash', isError: false }], end: null },
    // answer: prose only, so the turn has a real answer to log.
    { tools: [], end: { kind: 'completed' }, text: 'Here is the answer to the follow-up.' },
  ]
  const session = {
    id: 'session:test',
    append(type: string, data: Record<string, unknown>, options?: Record<string, unknown>): { seq: number } {
      const seq = events.length + 1
      const event = { type, data, seq, time: seq, ...options }
      events.push(event)
      for (const listener of listeners) listener(session, event)
      return { seq }
    },
  }
  let stepIndex = 0
  const agent = Object.create(ReactLoopAgent.prototype) as ReactLoopAgent
  Object.assign(agent, {
    phase: { kind: 'running', abort: new AbortController(), turn: 0, step: 0, wakeRequested: false },
    session,
    shellTools: new Set(['bash']),
    turnGraph: driver,
    dispatch: {
      emit: () => undefined,
      serial: async () => undefined,
      waterfall: async (_name: string, _payload: unknown, fallback: () => Promise<unknown>) => await fallback(),
    },
    inbox: {
      // `hasPending` only decides whether turn() asks for another turn; the
      // pending follow-up below is the input this turn plans from.
      hasPending: false,
      nextTurn: [{ content: [{ type: 'text', text }] }],
      nextStep: [],
      claim: () => [],
      splice: () => undefined,
      clear: () => undefined,
    },
    ctx: {
      logger: { warn: () => undefined },
      on: (name: string, listener: (session: unknown, event: { type: string; data: Record<string, unknown> }) => void) => {
        if (name !== 'session/event') return () => undefined
        listeners.push(listener)
        return () => {
          const index = listeners.indexOf(listener)
          if (index >= 0) listeners.splice(index, 1)
        }
      },
    },
    loopCtx: {
      get: () => undefined,
      tools: { resolve: async () => ({ dispose: () => undefined }) },
      systemPrompt: { assemble: async () => ({ contexts: [], variables: {} }) },
    },
    model: { current: () => ({ provider: 'test', model: 'test' }) },
    runtimeContext: { project: () => undefined },
    // The model call is the only stub: it reports the tool calls and the end
    // reason of a step, exactly like the real step's contract.
    step: async (decision: { messages: readonly { content: unknown }[] }) => {
      for (const message of decision.messages) session.append('user/message', { content: message.content })
      const script = scripts[stepIndex] ?? { tools: [], end: { kind: 'completed' as const } }
      stepIndex += 1
      for (const [index, tool] of script.tools.entries()) {
        const callId = `call-${stepIndex}-${index}`
        const position = { turn: 1, step: stepIndex }
        session.append('tool/call', { callId, name: tool.name, ...position }, { surfaceOp: 'append' })
        session.append('tool/result', {
          message: { toolCallId: callId, source: { callId }, isError: tool.isError ?? false, content: [] },
          ...position,
        }, { surfaceOp: 'append' })
      }
      if (script.text !== undefined) {
        session.append('assistant/message', {
          message: { role: 'assistant', content: [{ type: 'text', text: script.text }] },
        })
      }
      return script.end
    },
  })
  return { agent, events }
}

function callTurn(agent: ReactLoopAgent): Promise<boolean> {
  return (agent as unknown as { turn(): Promise<boolean> }).turn()
}

test('a follow-up turn runs the skeleton and answers, on all three engine settings', async () => {
  for (const engine of ENGINES) {
    for (const label of ['A', 'B'] as const) {
      const text = label === 'A' ? CASE_A : CASE_B
      const h = followupHarness(engine, text)
      assert.equal(await callTurn(h.agent), false, `${label} engine=${engine}`)

      const starts = h.events.filter(event => event.type === 'step/start')
      assert.equal(starts.length, 2, `${label} engine=${engine}: orient and answer each run one step`)
      const ends = h.events.filter(event => event.type === 'turn/end')
      assert.equal(ends.length, 1, `${label} engine=${engine}: exactly one turn end`)
      assert.deepEqual(ends[0]?.data.reason, { kind: 'completed' }, `${label} engine=${engine}`)
      const assistant = h.events.filter(event => event.type === 'assistant/message')
      assert.ok(assistant.length >= 1, `${label} engine=${engine}: the turn must log an assistant message`)
      const textOfAnswer = JSON.stringify(assistant[0]?.data.message)
      assert.ok(textOfAnswer.includes('Here is the answer'), `${label} engine=${engine}: the terminal step is the answer`)
    }
  }
})
