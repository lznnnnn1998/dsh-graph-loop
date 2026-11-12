/**
 * turn-answer-obligation.test.ts — an answer terminal may not complete while a
 * required work obligation is unmet, and printed tool-call syntax is never
 * accepted as the turn's answer.
 *
 * Case 1 (red on the parent tree): a plan declares a required `file.text`
 * artifact on its work node; the scripted work step names a file it never
 * created, and the answer-only terminal prints a tool-call envelope as *text*
 * (the live 809 B row). On the parent tree the terminal is reached and the turn
 * ends `{kind:'completed'}` with the printed syntax as its answer. Here the
 * terminal must refuse: one bounded recovery step, then an honest error.
 *
 * Case 2 (control): the work step leaves a real artifact and the terminal
 * answers in prose; exactly one `turn/end {kind:'completed'}` and the logged
 * answer is the terminal step's own text.
 *
 * Case 3 (bounded recovery): the first terminal is refused, the single recovery
 * step actually produces the owed artifact and discharges the obligation, and
 * the fresh answer completes. A recovery that cannot do the work is bounded
 * (Case 1), never cosmetic.
 *
 * The plan ids are kernel-drivable, so `minimal`/`langgraph` execute the turn
 * through the kernel; the bounded recovery plan uses the R4 dotted ids and runs
 * on the frontier. All three engine settings run the same drill.
 *
 * Run: node --import tsx --test test/unit/turn-answer-obligation.test.ts
 */

import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import type { TaskPlan } from '../../packages/core/src/graph-schema.ts'
import { ReactLoopAgent } from '../../packages/loop/src/loop/agent.ts'
import { createGraphTurnDriver, type GraphTurnDriver } from '../../packages/loop/src/scheduler.ts'

const ENGINES = ['off', 'minimal', 'langgraph'] as const
type Engine = typeof ENGINES[number]

/** The live failure's answer text: a tool call printed as text, never accepted. */
const PRINTED_CALL = [
  '<｜｜DSML｜｜ calls>',
  '<｜｜DSML｜｜ invoke name="bash">',
  '<｜｜DSML｜｜ parameter name="command" string="true">cd /app && python3 - <<EOF ... EOF</｜｜DSML｜｜ parameter>',
  '<｜｜DSML｜｜ parameter name="description" string="true">Write the artifact</｜｜DSML｜｜ parameter>',
  '</｜｜DSML｜｜ invoke>',
  '</｜｜DSML｜｜ calls>',
].join(' ')

/** The answer a genuinely answered turn logs. */
const ANSWER_TEXT = 'Wrote out.txt with the requested content.'

/**
 * The drill plan: one work node that owes a `file.text` artifact, then a distinct
 * answer-only terminal. The work node has no guarded exit: a plan may route past
 * its own unmet evidence (the live shape); completion must still refuse.
 */
function drillPlan(): TaskPlan {
  return {
    id: 'drill:answer-obligation',
    templateId: 'drill',
    version: 1,
    entry: 'n_inspect',
    terminals: ['n_answer'],
    nodes: [
      {
        id: 'n_inspect',
        kind: 'agent-step',
        executor: 'step',
        instruction: 'Produce the file the task needs.',
        evidence: { expects: [{ type: 'file.text', required: true }] },
      },
      {
        id: 'n_answer',
        kind: 'terminal',
        executor: 'step',
        instruction: 'Answer the task. Do not start new work.',
        toolAllow: [],
      },
    ],
    edges: [{ from: 'n_inspect', to: 'n_answer', kind: 'control' }],
    budget: { maxNodes: 2, maxSteps: 8, maxTokens: 10_000, maxWallMs: 60_000, maxReplans: 0 },
    toolUniverse: ['write', 'bash'],
    gatePolicy: 'cold',
    fallback: true,
    confidence: 0,
    compiledDigest: 'drill:answer-obligation',
  }
}

interface RecordedEvent {
  readonly type: string
  readonly seq: number
  readonly data: Record<string, unknown>
}

/** The step's own assistant text, read from the log prefix a reader would see. */
function lastAssistantText(events: readonly RecordedEvent[], atSeq: number | undefined): string | undefined {
  if (atSeq === undefined) return undefined
  let text: string | undefined
  for (const event of events) {
    if (event.seq >= atSeq) break
    if (event.type !== 'assistant/message') continue
    const content = (event.data.message as { content?: readonly { type?: string; text?: string }[] }).content
    if (!Array.isArray(content)) continue
    const parts = content.filter(part => part.type === 'text' && typeof part.text === 'string').map(part => part.text as string)
    if (parts.length > 0) text = parts.join('\n')
  }
  return text
}

interface Harness {
  readonly agent: ReactLoopAgent
  readonly driver: GraphTurnDriver
  readonly events: RecordedEvent[]
}

/**
 * Bind the real `turn()` body to a real driver. `beginTurn` runs in propose mode
 * and the plan is adopted at the first boundary through `proposalSource`, the
 * same seam a model-authored topology uses. The scripted step reports the tool
 * calls and the end reason of one step; it is the only stub.
 */
function answerHarness(engine: Engine, workspace: string, mode: 'blocked' | 'answered' | 'recovered'): Harness {
  const events: RecordedEvent[] = []
  const listeners: ((session: unknown, event: { type: string; data: Record<string, unknown> }) => void)[] = []
  let proposed: TaskPlan | undefined = drillPlan()
  const driver = createGraphTurnDriver({
    mode: 'propose',
    kernel: engine === 'off' ? 'off' : engine,
    worldRoot: workspace,
    proposalSource: () => {
      const next = proposed
      proposed = undefined
      return next
    },
    answerText: atSeq => lastAssistantText(events, atSeq),
  })
  const outputPath = join(workspace, 'out.txt')
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
      hasPending: false,
      nextTurn: [{ content: [{ type: 'text', text: 'Create the file the task needs.' }] }],
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
    // One scripted step per graph node. The work node names a file it does not
    // always create; only the "answered" run lets that file exist.
    step: async (decision: { messages: readonly { content: unknown }[] }) => {
      for (const message of decision.messages) session.append('user/message', { content: message.content })
      const node = driver.current()?.id
      if (node === 'recover.1.1' && mode === 'recovered') writeFileSync(outputPath, 'artifact content')
      if (node === 'n_inspect') {
        if (mode === 'answered') writeFileSync(outputPath, 'artifact content')
        const position = { turn: 1, step: 2 }
        session.append('tool/call', {
          callId: 'call-2',
          name: 'write',
          arguments: JSON.stringify({ file_path: outputPath }),
          ...position,
        }, { surfaceOp: 'append' })
        session.append('tool/result', {
          message: { toolCallId: 'call-2', source: { callId: 'call-2' }, isError: false, content: [] },
          ...position,
        }, { surfaceOp: 'append' })
        return { kind: 'completed' as const }
      }
      const text = node === 'p_frame'
        ? 'Planning the turn.'
        : node === 'n_answer'
          ? (mode === 'answered' ? ANSWER_TEXT : PRINTED_CALL)
          : ANSWER_TEXT
      if (text !== undefined) {
        session.append('assistant/message', {
          message: { role: 'assistant', content: [{ type: 'text', text }] },
        })
      }
      return { kind: 'completed' as const }
    },
  })
  return { agent, driver, events }
}

function callTurn(agent: ReactLoopAgent): Promise<boolean> {
  return (agent as unknown as { turn(): Promise<boolean> }).turn()
}

function stepCount(events: readonly RecordedEvent[]): number {
  return events.filter(event => event.type === 'step/start').length
}

function userTexts(events: readonly RecordedEvent[]): string[] {
  return events
    .filter(event => event.type === 'user/message')
    .flatMap(event => (event.data.content as readonly { type?: string; text?: string }[] | undefined) ?? [])
    .filter(part => part.type === 'text' && typeof part.text === 'string')
    .map(part => part.text as string)
}

test('Case 1: an unmet work obligation refuses the answer terminal and ends honestly', async () => {
  for (const engine of ENGINES) {
    const workspace = mkdtempSync(join(tmpdir(), 'dsh-answer-obligation-'))
    try {
      const h = answerHarness(engine, workspace, 'blocked')
      await assert.rejects(callTurn(h.agent), `engine=${engine}: a blocked answer must fail the turn, not complete it`)

      const ends = h.events.filter(event => event.type === 'turn/end')
      assert.equal(ends.length, 1, `engine=${engine}: exactly one turn end`)
      const reason = ends[0]?.data.reason as { kind?: string; error?: { code?: string } } | undefined
      assert.notEqual(reason?.kind, 'completed', `engine=${engine}: an unmet obligation must not complete the turn`)
      assert.equal(reason?.kind, 'error', `engine=${engine}: the blocked answer ends as a structured error`)
      assert.equal(reason?.error?.code, 'GRAPH_FAILED', `engine=${engine}`)

      // Bounded recovery: the plan runs planning + work + answer + exactly one
      // recovery step + the second answer. No loop, no third attempt.
      assert.equal(stepCount(h.events), 5, `engine=${engine}: at most one bounded recovery step`)
      const recoverySteps = userTexts(h.events).filter(text => text.includes('The answer step is blocked'))
      assert.equal(recoverySteps.length, 1, `engine=${engine}: one bounded recovery instruction`)

      // The obligation ledger, not terminal reachability, is the completion
      // signal: it still records the unmet work and the run settles failed.
      const ledger = h.driver.snapshot().obligations
      assert.equal(ledger.find(entry => entry.nodeId === 'n_inspect')?.satisfied, false, `engine=${engine}`)
      assert.equal(h.driver.planState(), 'failed', `engine=${engine}`)
      assert.equal(h.driver.terminalReached(), false, `engine=${engine}`)
    } finally {
      rmSync(workspace, { recursive: true, force: true })
    }
  }
})

test('Case 3: one bounded recovery discharges the obligation and the fresh answer completes', async () => {
  for (const engine of ENGINES) {
    const workspace = mkdtempSync(join(tmpdir(), 'dsh-answer-obligation-'))
    try {
      const h = answerHarness(engine, workspace, 'recovered')
      assert.equal(await callTurn(h.agent), false, `engine=${engine}`)

      const ends = h.events.filter(event => event.type === 'turn/end')
      assert.equal(ends.length, 1, `engine=${engine}: exactly one turn end`)
      assert.deepEqual(ends[0]?.data.reason, { kind: 'completed' }, `engine=${engine}`)

      // The recovery step ran exactly once, did the owed work, and the ledger
      // says who discharged it; the logged answer is the fresh answer's text.
      assert.equal(stepCount(h.events), 5, `engine=${engine}: one work retry then one answer`)
      const recoverySteps = userTexts(h.events).filter(text => text.includes('The answer step is blocked'))
      assert.equal(recoverySteps.length, 1, `engine=${engine}: one bounded recovery instruction`)
      const ledger = h.driver.snapshot().obligations
      const inspected = ledger.find(entry => entry.nodeId === 'n_inspect')
      assert.equal(inspected?.satisfied, true, `engine=${engine}: the recovery produced the owed artifact`)
      assert.equal(inspected?.satisfiedBy, 'recover.1.1', `engine=${engine}: the discharging node is recorded`)
      const assistant = h.events.filter(event => event.type === 'assistant/message')
      const answer = assistant.at(-1)?.data.message as { content?: readonly { type?: string; text?: string }[] } | undefined
      assert.deepEqual(answer?.content, [{ type: 'text', text: ANSWER_TEXT }], `engine=${engine}`)
    } finally {
      rmSync(workspace, { recursive: true, force: true })
    }
  }
})

test('Case 2: an evidenced answer still completes exactly once with its own text', async () => {
  for (const engine of ENGINES) {
    const workspace = mkdtempSync(join(tmpdir(), 'dsh-answer-obligation-'))
    try {
      const h = answerHarness(engine, workspace, 'answered')
      assert.equal(await callTurn(h.agent), false, `engine=${engine}`)

      const ends = h.events.filter(event => event.type === 'turn/end')
      assert.equal(ends.length, 1, `engine=${engine}: exactly one turn end`)
      assert.deepEqual(ends[0]?.data.reason, { kind: 'completed' }, `engine=${engine}`)

      // No recovery ran, and the logged answer is the terminal step's own text.
      assert.equal(stepCount(h.events), 3, `engine=${engine}: a valid answer needs no recovery`)
      const assistant = h.events.filter(event => event.type === 'assistant/message')
      const answer = assistant.at(-1)?.data.message as { content?: readonly { type?: string; text?: string }[] } | undefined
      assert.deepEqual(answer?.content, [{ type: 'text', text: ANSWER_TEXT }], `engine=${engine}`)

    } finally {
      rmSync(workspace, { recursive: true, force: true })
    }
  }
})
