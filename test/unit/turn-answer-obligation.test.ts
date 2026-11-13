/**
 * turn-answer-obligation.test.ts — a turn ends only on the typed answer record
 * an executed `graph_answer` call produced, and never on free assistant text;
 * a required work obligation must be satisfied for the record to be admitted.
 *
 * Case 1 (red on the parent tree): a plan declares a required `file.text`
 * artifact on its work node; the scripted work step names a file it never
 * created, and both answer steps print a tool-call envelope as *text* (the live
 * 809 B row). The typed gate refuses the terminal (no executed channel call),
 * spends one bounded recovery step, and fails the turn honestly.
 *
 * Case 4 (red on the parent tree): the live shape — the work node *does* leave
 * the artifact, so the obligation ledger is satisfied, and the answer step
 * prints a tool-call envelope as text. Completion must still be refused: the
 * channel gate is independent of the ledger. One recovery, then an honest error.
 *
 * Case 5 (control): the same plan with a real work artifact and the answer
 * submitted through `graph_answer`. The record's text is the submitted prose and
 * the turn completes exactly once. Prose and printed syntax are the same
 * assistant text, so a genuine answer means prose *through the channel*.
 *
 * Case 3 (bounded recovery): the first terminal is refused, the single recovery
 * step actually produces the owed artifact and discharges the obligation, and
 * the fresh answer (now submitted through the channel) completes. A recovery
 * that cannot do the work is bounded (Case 1/4), never cosmetic.
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

import type { StreamChunk, ToolCallId } from '@deepseek-ai/dsh-llm'
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

/** The answer a genuinely answered turn submits through the channel. */
const ANSWER_TEXT = 'Wrote out.txt with the requested content.'

/** The executed channel call the answer step makes (the record's only source). */
function answerCall(text = ANSWER_TEXT): {
  name: string
  callId: string
  isError: boolean
  arguments: string
} {
  return { name: 'graph_answer', callId: 'call-answer', isError: false, arguments: JSON.stringify({ text }) }
}

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

/**
 * How the scripted model answers and works:
 * - `blocked`: the work step leaves nothing; answer steps print the envelope.
 * - `dsml-satisfied`: the work step leaves the artifact (ledger satisfied, the
 *   live shape); answer steps print the envelope.
 * - `answered`: the work step leaves the artifact; answer steps submit the
 *   channel.
 * - `recovered`: the work step leaves nothing, the bounded recovery leaves the
 *   artifact, and the fresh answer submits the channel.
 */
type Mode = 'blocked' | 'dsml-satisfied' | 'answered' | 'recovered'

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
function answerHarness(engine: Engine, workspace: string, mode: Mode): Harness {
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
    // always create; answer steps either execute the channel or print syntax.
    step: async (decision: { messages: readonly { content: unknown }[] }) => {
      for (const message of decision.messages) session.append('user/message', { content: message.content })
      const node = driver.current()?.id
      if (node === 'recover.1.1' && mode === 'recovered') writeFileSync(outputPath, 'artifact content')
      if (node === 'n_inspect') {
        if (mode === 'answered' || mode === 'dsml-satisfied') writeFileSync(outputPath, 'artifact content')
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
      if (node === 'p_frame') {
        session.append('assistant/message', {
          message: { role: 'assistant', content: [{ type: 'text', text: 'Planning the turn.' }] },
        })
        return { kind: 'completed' as const }
      }
      // Every answer terminal (`n_answer`, `answer.1.2`).
      const throughChannel = mode === 'answered' || mode === 'recovered'
      session.append('assistant/message', {
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: throughChannel ? ANSWER_TEXT : PRINTED_CALL }],
        },
      })
      if (throughChannel) {
        session.append('tool/call', {
          callId: 'call-answer',
          name: 'graph_answer',
          arguments: JSON.stringify({ text: ANSWER_TEXT }),
        }, { surfaceOp: 'append' })
        session.append('tool/result', {
          message: { toolCallId: 'call-answer', source: { callId: 'call-answer' }, isError: false, content: [] },
        }, { surfaceOp: 'append' })
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
      assert.equal(h.driver.snapshot().answer, undefined, `engine=${engine}: no typed record was admitted`)
    } finally {
      rmSync(workspace, { recursive: true, force: true })
    }
  }
})

test('Case 4: a satisfied ledger does not admit printed tool-call syntax as the answer', async () => {
  for (const engine of ENGINES) {
    const workspace = mkdtempSync(join(tmpdir(), 'dsh-answer-obligation-'))
    try {
      const h = answerHarness(engine, workspace, 'dsml-satisfied')
      await assert.rejects(callTurn(h.agent), `engine=${engine}: printed syntax must not complete the turn`)

      // The live vpp shape: the work obligation is satisfied before the terminal
      // is reached, and the answer step prints a call envelope as text. The typed
      // channel, not the ledger, refuses it — one bounded recovery, then failure.
      assert.equal(h.driver.snapshot().obligations.find(entry => entry.nodeId === 'n_inspect')?.satisfied, true,
        `engine=${engine}: the work obligation really is satisfied`)
      const ends = h.events.filter(event => event.type === 'turn/end')
      assert.equal(ends.length, 1, `engine=${engine}: exactly one turn end`)
      const reason = ends[0]?.data.reason as { kind?: string; error?: { code?: string } } | undefined
      assert.notEqual(reason?.kind, 'completed', `engine=${engine}: printed syntax is never an answer`)
      assert.equal(reason?.kind, 'error', `engine=${engine}`)
      assert.equal(reason?.error?.code, 'GRAPH_FAILED', `engine=${engine}`)
      assert.equal(h.driver.planState(), 'failed', `engine=${engine}`)
      assert.equal(h.driver.terminalReached(), false, `engine=${engine}`)
      assert.equal(h.driver.snapshot().answer, undefined, `engine=${engine}: no typed record was admitted`)

      // Planning + work + answer + exactly one recover.1.1 + answer.1.2.
      assert.equal(stepCount(h.events), 5, `engine=${engine}: one bounded recovery, no loop`)
      const recoverySteps = userTexts(h.events).filter(text => text.includes('The answer step is blocked'))
      assert.equal(recoverySteps.length, 1, `engine=${engine}: one bounded recovery instruction`)
    } finally {
      rmSync(workspace, { recursive: true, force: true })
    }
  }
})

test('Case 5: an answer submitted through the channel completes with the submitted prose', async () => {
  for (const engine of ENGINES) {
    const workspace = mkdtempSync(join(tmpdir(), 'dsh-answer-obligation-'))
    try {
      const h = answerHarness(engine, workspace, 'answered')
      assert.equal(await callTurn(h.agent), false, `engine=${engine}`)

      const ends = h.events.filter(event => event.type === 'turn/end')
      assert.equal(ends.length, 1, `engine=${engine}: exactly one turn end`)
      assert.deepEqual(ends[0]?.data.reason, { kind: 'completed' }, `engine=${engine}`)

      // The admitted record is the executed call's argument text, not a scrape of
      // the transcript: this is the control that a genuine answer still answers.
      assert.equal(stepCount(h.events), 3, `engine=${engine}: a valid answer needs no recovery`)
      assert.deepEqual(h.driver.snapshot().answer, {
        text: ANSWER_TEXT,
        evidenceRefs: ['n_inspect'],
        toolCalls: 0,
      }, `engine=${engine}: the record's text is exactly the submitted prose`)
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
      // says who discharged it; the fresh answer submitted the channel text.
      assert.equal(stepCount(h.events), 5, `engine=${engine}: one work retry then one answer`)
      const recoverySteps = userTexts(h.events).filter(text => text.includes('The answer step is blocked'))
      assert.equal(recoverySteps.length, 1, `engine=${engine}: one bounded recovery instruction`)
      const ledger = h.driver.snapshot().obligations
      const inspected = ledger.find(entry => entry.nodeId === 'n_inspect')
      assert.equal(inspected?.satisfied, true, `engine=${engine}: the recovery produced the owed artifact`)
      assert.equal(inspected?.satisfiedBy, 'recover.1.1', `engine=${engine}: the discharging node is recorded`)
      assert.equal(h.driver.snapshot().answer?.text, ANSWER_TEXT, `engine=${engine}`)
      assert.equal(h.driver.snapshot().answer?.evidenceRefs.includes('n_inspect'), true, `engine=${engine}`)
    } finally {
      rmSync(workspace, { recursive: true, force: true })
    }
  }
})

// ---------------------------------------------------------------------------
// Case 6 / 6b: real dispatch at the answer terminal.
//
// The step is not stubbed here: the real `ReactLoopAgent.step()` dispatches to
// a fake executor that mirrors stock tool resolution (a name outside the step's
// admitted view is an `unknown tool` error). The live shape: the work node runs
// a read-only shell call that leaves the owed `file.text` unmet, the answer-only
// terminal calls `bash`, the bounded recovery writes the artifact, and the fresh
// answer submits the channel (Case 6) or repeats the breach (Case 6b).
// ---------------------------------------------------------------------------

/** One scripted tool call as the model emits it. */
interface ScriptedCall {
  readonly id: string
  readonly name: string
  readonly arguments: string
}

/** What the step after the first refusal does on the follow-up answer step. */
type TerminalRepeat = 'answer' | 'breach-again'

/** What the terminal itself calls: the breach (bash) or the channel. */
type TerminalCall = 'breach' | 'channel'

/** What the work node does: a read that leaves the owed artifact unmet, or the write. */
type WorkStep = 'read' | 'write'

/** One executed batch: the node, the calls, and the admitted view dispatch saw. */
interface ExecutedBatch {
  readonly node: string | undefined
  /** The DSH step number the batch ran at. */
  readonly step: number
  readonly names: readonly string[]
  /** The step's admitted tool names, exactly the view the tools executor received. */
  readonly admitted: readonly string[]
}

/** One graph node directive committed to the session log, keyed by its node. */
interface RecordedDirective {
  readonly nodeId: string
  readonly text: string
}

interface DispatchHarness {
  readonly agent: ReactLoopAgent
  readonly driver: GraphTurnDriver
  readonly events: RecordedEvent[]
  /** Every batch that reached the tools executor: the node it ran on and its names. */
  readonly executed: ExecutedBatch[]
  /** Every `[graph node <id>]` directive the step committed. */
  readonly directives: RecordedDirective[]
}

/**
 * The drill plan adopted at the first boundary plus a scripted model keyed by
 * the driver's current node. `loopCtx.llm` yields streams; `loopCtx.tools`
 * resolves names exactly like the stock pipeline: outside the step's admitted
 * view is an unknown-tool error result, a channel/write call succeeds.
 */
function dispatchHarness(
  engine: Engine,
  workspace: string,
  repeat: TerminalRepeat,
  options: { readonly work?: WorkStep; readonly terminalCall?: TerminalCall } = {},
): DispatchHarness {
  const events: RecordedEvent[] = []
  const listeners: ((session: unknown, event: { type: string; data: Record<string, unknown> }) => void)[] = []
  const executed: ExecutedBatch[] = []
  const directives: RecordedDirective[] = []
  const work = options.work ?? 'read'
  const terminalCall = options.terminalCall ?? 'breach'
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
  })
  const outputPath = join(workspace, 'out.txt')
  let header: unknown
  let context: unknown
  const session = {
    id: 'session:test',
    surface: { contentGeneration: 0 },
    requestHeader: () => header,
    requestContext: () => context,
    deriveMessages: () => [],
    toolHistory: () => ({ tools: [], updates: [] }),
    snapshotEvents: () => [],
    append(type: string, data: Record<string, unknown>, options?: Record<string, unknown>): { seq: number } {
      if (type === 'request/header') header = data.header
      if (type === 'request/context') context = data
      if (type === 'user/message') {
        const message = data as {
          readonly source?: { readonly kind?: string; readonly nodeId?: string }
          readonly content?: readonly { readonly type?: string; readonly text?: string }[]
        }
        if (message.source?.kind === 'graph-node') {
          directives.push({
            nodeId: message.source.nodeId ?? '',
            text: (message.content ?? []).filter(part => part.type === 'text').map(part => part.text ?? '').join(' '),
          })
        }
      }
      const seq = events.length + 1
      const event = { type, data, seq, time: seq, ...options }
      events.push(event)
      for (const listener of listeners) listener(session, event)
      return { seq }
    },
  }
  const definitions = new Map<string, unknown>(['bash', 'write', 'graph_answer', 'read']
    .map(name => [name, { name, description: name, parameters: { type: 'object' } }]))
  const resolved = {
    dispose: () => undefined,
    view: () => definitions,
  }
  const script = (node: string | undefined): readonly ScriptedCall[] => {
    if (node === 'n_inspect') {
      return work === 'write'
        ? [{ id: 'call-inspect', name: 'write', arguments: JSON.stringify({ file_path: outputPath }) }]
        : [{ id: 'call-inspect', name: 'bash', arguments: JSON.stringify({ command: 'cat out.txt' }) }]
    }
    if (node === 'n_answer') {
      return terminalCall === 'channel'
        ? [{ id: 'call-terminal-answer', name: 'graph_answer', arguments: JSON.stringify({ text: ANSWER_TEXT }) }]
        : [{ id: 'call-breach', name: 'bash', arguments: JSON.stringify({ command: 'cat out.txt' }) }]
    }
    if (node === 'recover.1.1') return [{ id: 'call-write', name: 'write', arguments: JSON.stringify({ file_path: outputPath }) }]
    if (node === 'answer.1.2') {
      return repeat === 'answer'
        ? [{ id: 'call-answer', name: 'graph_answer', arguments: JSON.stringify({ text: ANSWER_TEXT }) }]
        : [{ id: 'call-breach-2', name: 'bash', arguments: JSON.stringify({ command: 'cat out.txt' }) }]
    }
    return []
  }
  function* reply(): Generator<StreamChunk> {
    const calls = script(driver.current()?.id)
    const text = calls.length === 0 ? 'Working on the task.' : 'Calling a tool.'
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'text-delta', index: 0, text }
    yield { type: 'block-end', index: 0, block: { type: 'text', text } }
    let index = 1
    for (const call of calls) {
      const id = call.id as ToolCallId
      yield { type: 'block-start', index, blockType: 'tool-call' }
      yield { type: 'tool-call-delta', index, id, name: call.name, argumentsDelta: call.arguments }
      yield { type: 'block-end', index, block: { type: 'tool-call', id, name: call.name, arguments: call.arguments } }
      index += 1
    }
    yield { type: 'finish', reason: { kind: calls.length === 0 ? 'stop' : 'tool-calls' } }
  }
  const agent = Object.create(ReactLoopAgent.prototype) as ReactLoopAgent
  Object.assign(agent, {
    phase: { kind: 'running', abort: new AbortController(), turn: 0, step: 0, wakeRequested: false },
    options: {},
    session,
    shellTools: new Set(['bash']),
    turnGraph: driver,
    requestHeaderLogged: false,
    requestSurfaceGeneration: 0,
    frozenMessages: new WeakSet(),
    assistantAttemptCounter: 0,
    assistantStreamRevision: 0,
    systemPrompt: { project: () => [] },
    runtimeContext: { project: () => undefined },
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
          const at = listeners.indexOf(listener)
          if (at >= 0) listeners.splice(at, 1)
        }
      },
    },
    loopCtx: {
      get: () => undefined,
      tools: {
        resolve: async () => resolved,
        execute: async (input: {
          calls: readonly { id: string; name: string; arguments: string }[]
          log: { turn: number; step: number }
          toolSet?: { view(scope: undefined): ReadonlyMap<string, unknown> }
        }) => {
          executed.push({
            node: driver.current()?.id,
            step: input.log.step,
            names: input.calls.map(call => call.name),
            admitted: [...(input.toolSet?.view(undefined).keys() ?? [])],
          })
          for (const call of input.calls) {
            session.append('tool/call', {
              turn: input.log.turn, step: input.log.step, callId: call.id, name: call.name, arguments: call.arguments,
            }, { surfaceOp: 'append' })
            const admitted = input.toolSet?.view(undefined).has(call.name) === true
            if (!admitted) {
              session.append('tool/result', {
                turn: input.log.turn, step: input.log.step,
                message: {
                  toolCallId: call.id, source: { callId: call.id }, isError: true,
                  content: [{ type: 'text', text: `Error: unknown tool "${call.name}"` }],
                },
              }, { surfaceOp: 'append' })
              continue
            }
            if (call.name === 'write') writeFileSync(outputPath, 'artifact content')
            session.append('tool/result', {
              turn: input.log.turn, step: input.log.step,
              message: {
                toolCallId: call.id, source: { callId: call.id }, isError: false,
                content: [{ type: 'text', text: 'ok' }],
              },
            }, { surfaceOp: 'append' })
          }
          return { results: [], additionalContexts: [], concluded: false }
        },
      },
      systemPrompt: {
        assemble: async () => ({ sections: [], contexts: [], variables: {}, tools: [] }),
        refreshContext: (assembly: unknown) => assembly,
      },
      llm: {
        prepareCall: async (config: unknown) => ({ config, retryPolicy: {}, adapterDefaults: {}, stream: () => reply() }),
        stream: () => reply(),
      },
      agentLoop: { config: { maxParallelToolCalls: { get: () => undefined } } },
    },
    model: { current: () => ({ provider: 'test', model: 'test' }), select: () => undefined },
  })
  return { agent, driver, events, executed, directives }
}

/** The step number of the first channel refusal committed to the session. */
function firstRefusalStep(events: readonly RecordedEvent[]): number {
  const refused = events.find(event => event.type === 'tool/result'
    && toolResultTexts([event]).some(text => text.includes('was not executed')))
  assert.notEqual(refused, undefined, 'a channel refusal was committed')
  return refused?.data.step as number
}

/** All tool-result texts the step or the executor committed. */
function toolResultTexts(events: readonly RecordedEvent[]): string[] {
  return events
    .filter(event => event.type === 'tool/result')
    .flatMap(event => {
      const message = event.data.message as { content?: readonly { type?: string; text?: string }[] } | undefined
      return (message?.content ?? []).filter(part => part.type === 'text').map(part => part.text ?? '')
    })
}

test('Case 6: an unmet work obligation sends the executed answer back to a work recovery', async () => {
  for (const engine of ENGINES) {
    const workspace = mkdtempSync(join(tmpdir(), 'dsh-answer-obligation-'))
    try {
      // The terminal submits through the channel while the run still owes the
      // work node's artifact: the gate refuses the record as `unmet-obligation`
      // and the bounded work recovery discharges the debt before answering.
      const h = dispatchHarness(engine, workspace, 'answer', { work: 'read', terminalCall: 'channel' })
      assert.equal(await callTurn(h.agent), false, `engine=${engine}`)

      const ends = h.events.filter(event => event.type === 'turn/end')
      assert.equal(ends.length, 1, `engine=${engine}: exactly one turn end`)
      assert.deepEqual(ends[0]?.data.reason, { kind: 'completed' }, `engine=${engine}`)

      // (i) The terminal dispatched the channel itself: this is the record path,
      // not a refusal, so the recovery is the one the ledger owes.
      const atTerminal = h.executed.filter(batch => batch.node === 'n_answer')
      assert.deepEqual(atTerminal.map(batch => batch.names), [['graph_answer']], `engine=${engine}`)
      assert.equal(h.executed.some(batch => batch.names.includes('bash') && batch.node === 'n_answer'), false,
        `engine=${engine}: no work tool is dispatched at the answer terminal`)

      // (ii) Exactly one bounded recovery, and its verdict is the ledger's.
      const recoverySteps = userTexts(h.events).filter(text => text.includes('The answer step is blocked'))
      assert.equal(recoverySteps.length, 1, `engine=${engine}: one bounded recovery instruction`)
      assert.equal(recoverySteps[0]?.includes('required work at n_inspect was not done'), true,
        `engine=${engine}: the recovery names the ledger verdict`)
      assert.deepEqual(h.driver.snapshot().visited, ['p_frame', 'n_inspect', 'n_answer', 'recover.1.1', 'answer.1.2'],
        `engine=${engine}: no generic recovery nodes`)

      // (iii) The work recovery discharged the debt and the fresh terminal answered.
      const ledger = h.driver.snapshot().obligations
      assert.equal(ledger.find(entry => entry.nodeId === 'n_inspect')?.satisfied, true, `engine=${engine}`)
      assert.equal(ledger.find(entry => entry.nodeId === 'n_inspect')?.satisfiedBy, 'recover.1.1', `engine=${engine}`)
      assert.equal(h.driver.snapshot().answer?.text, ANSWER_TEXT, `engine=${engine}`)
    } finally {
      rmSync(workspace, { recursive: true, force: true })
    }
  }
})

test('Case 6b: a second refusal at the fresh work-recovery answer terminal fails the turn honestly', async () => {
  for (const engine of ENGINES) {
    const workspace = mkdtempSync(join(tmpdir(), 'dsh-answer-obligation-'))
    try {
      const h = dispatchHarness(engine, workspace, 'breach-again', { work: 'read', terminalCall: 'channel' })
      await assert.rejects(callTurn(h.agent), `engine=${engine}: a second refusal must fail the turn`)

      const ends = h.events.filter(event => event.type === 'turn/end')
      assert.equal(ends.length, 1, `engine=${engine}: exactly one turn end`)
      assert.equal((ends[0]?.data.reason as { kind?: string } | undefined)?.kind, 'error', `engine=${engine}`)
      assert.equal(h.driver.terminalReached(), false, `engine=${engine}: a blocked answer is not a completion`)
      const texts = toolResultTexts(h.events)
      assert.equal(texts.some(text => text.includes('unknown tool') || text.includes('UNKNOWN_TOOL')), false,
        `engine=${engine}: the second breach is still a refusal, not an unknown tool`)
      assert.equal(texts.filter(text => text.includes('was not executed')).length, 1,
        `engine=${engine}: the fresh answer terminal refused the breach before dispatch`)
      assert.deepEqual(h.executed.filter(batch => batch.node === 'answer.1.2').map(batch => batch.names), [],
        `engine=${engine}: the breach never reached tool resolution`)
      assert.equal(h.driver.snapshot().answer, undefined, `engine=${engine}`)
    } finally {
      rmSync(workspace, { recursive: true, force: true })
    }
  }
})

// ---------------------------------------------------------------------------
// Case 7 / 7b: a refusal at the answer-only terminal selects the next shape.
//
// The work node already discharged its obligation before the terminal, so the
// only open problem is the channel. The refusal verdict must install the
// channel-retry step (a distinct agent step that admits exactly the channel)
// and not a work-retry step whose admission is the whole tool universe; the
// terminal directive must be derived from that same admission rule.
// ---------------------------------------------------------------------------

test('Case 7: a refusal is followed by an answer-only step that names the channel and answers', async () => {
  for (const engine of ENGINES) {
    const workspace = mkdtempSync(join(tmpdir(), 'dsh-answer-obligation-'))
    try {
      const h = dispatchHarness(engine, workspace, 'answer', { work: 'write', terminalCall: 'breach' })
      assert.equal(await callTurn(h.agent), false, `engine=${engine}`)

      // (i) The step after the refusal admits exactly the channel: the refusal
      // verdict, not the original plan's universe, decides the next admission.
      const afterRefusal = h.executed.filter(batch => batch.step > firstRefusalStep(h.events))
      assert.notEqual(afterRefusal.length, 0, `engine=${engine}: a step follows the refusal`)
      assert.deepEqual(afterRefusal[0]?.admitted, ['graph_answer'],
        `engine=${engine}: the step after the refusal admits exactly the channel`)
      assert.deepEqual(afterRefusal[0]?.names, ['graph_answer'], `engine=${engine}: the channel is the call that ran`)
      assert.equal(afterRefusal.length, 1, `engine=${engine}: exactly one step dispatches after the refusal`)

      // (ii) The directive is admission-derived: the step is answer-only, so the
      // composed directive names the channel even though the node is not a
      // declared terminal. The recovery prose alone cannot satisfy this.
      const retryNode = afterRefusal[0]?.node ?? ''
      const directive = h.directives.find(entry => entry.nodeId === retryNode)
      assert.notEqual(directive, undefined, `engine=${engine}: the retry step has a graph node directive`)
      assert.equal(directive?.text.includes("Submit the turn's answer by calling"), true,
        `engine=${engine}: the directive carries the admission-derived channel sentence`)
      assert.equal(directive?.text.includes('graph_answer'), true, `engine=${engine}: the directive names the channel`)

      // (iii) The genuine channel call completed the turn once, with the ledger met.
      const ends = h.events.filter(event => event.type === 'turn/end')
      assert.equal(ends.length, 1, `engine=${engine}: exactly one turn end`)
      assert.deepEqual(ends[0]?.data.reason, { kind: 'completed' }, `engine=${engine}`)
      assert.equal(h.driver.snapshot().answer?.text, ANSWER_TEXT, `engine=${engine}`)
      assert.equal(h.driver.terminalReached(), true, `engine=${engine}: the accepted record is the endpoint`)
      assert.equal(h.driver.snapshot().obligations.find(entry => entry.nodeId === 'n_inspect')?.satisfied, true,
        `engine=${engine}: the work was already evidenced before the terminal`)
    } finally {
      rmSync(workspace, { recursive: true, force: true })
    }
  }
})

test('Case 7b: a second non-channel call at the retried step fails the turn honestly', async () => {
  for (const engine of ENGINES) {
    const workspace = mkdtempSync(join(tmpdir(), 'dsh-answer-obligation-'))
    try {
      const h = dispatchHarness(engine, workspace, 'breach-again', { work: 'write', terminalCall: 'breach' })
      await assert.rejects(callTurn(h.agent), `engine=${engine}: a second refusal must fail the turn`)

      // The step after the refusal dispatches nothing: the breach is refused
      // against the same name-set the directive names, never resolved.
      assert.deepEqual(h.executed.filter(batch => batch.step > firstRefusalStep(h.events)), [],
        `engine=${engine}: the retried step's non-channel call is refused before dispatch`)

      const ends = h.events.filter(event => event.type === 'turn/end')
      assert.equal(ends.length, 1, `engine=${engine}: exactly one turn end`)
      assert.equal((ends[0]?.data.reason as { kind?: string } | undefined)?.kind, 'error', `engine=${engine}`)
      assert.equal(h.driver.terminalReached(), false, `engine=${engine}: a blocked retry is not a completion`)
      const texts = toolResultTexts(h.events)
      assert.equal(texts.some(text => text.includes('unknown tool') || text.includes('UNKNOWN_TOOL')), false,
        `engine=${engine}: both breaches are refusals, not unknown tools`)
      assert.equal(texts.filter(text => text.includes('was not executed')).length, 2,
        `engine=${engine}: the terminal and the retried step both refused`)
      assert.equal(h.driver.snapshot().answer, undefined, `engine=${engine}: no typed record was admitted`)
    } finally {
      rmSync(workspace, { recursive: true, force: true })
    }
  }
})
