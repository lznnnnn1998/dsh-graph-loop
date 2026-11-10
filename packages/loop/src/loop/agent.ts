/**
 * Default Agent driver over queued turns and step-boundary input. Every request
 * is derived from the session log.
 * @module dsh-graph-loop/agent
 */

import type {
  Agent,
  AgentCancelCause,
  AgentEventDispatch,
  AgentOptions,
  AgentStatus,
  CancelOptions,
  ModelSelection,
  ModelSelectionProjectionState,
  InboxTarget,
  InboxState,
  PreStepDecision,
  RequestErrorAction,
} from '@deepseek-ai/dsh-agent'
import { AgentModel, agentEvents, assembleContextFor } from '@deepseek-ai/dsh-agent'
import type { GenerateOptions, LlmCallConfig, Message, PreparedLlmCall } from '@deepseek-ai/dsh-llm'
import {
  LlmError,
  createAssistantMessage,
  createDeveloperMessage,
  errorChain,
  markAgentLoopRequest,
} from '@deepseek-ai/dsh-llm'
import type { GraphTurnDriver } from '../scheduler.ts'
import { assertNever, deepFreeze } from '@deepseek-ai/dsh-util-values'
import type { Scope } from '@deepseek-ai/dsh-scope'
import { createScope } from '@deepseek-ai/dsh-scope'
import type { EpochHeader, RequestContext, Session, SessionId, SessionSeq, TurnEndReason, UserMessage } from '@deepseek-ai/dsh-session'
import { canonicalHeader, headerEquals, ToolCallRecovery } from '@deepseek-ai/dsh-session'
import { joinContextSections, renderContextSections, renderPrompt } from '@deepseek-ai/dsh-system-prompt'
import type { PromptAssembly } from '@deepseek-ai/dsh-system-prompt'
import { ToolActivationError, ToolBatchExecutionError } from '@deepseek-ai/dsh-tools'
import type { ResolvedToolSet } from '@deepseek-ai/dsh-tools'
import type { Context } from '@deepseek-ai/cordis'
import { ReactLoopInbox } from './inbox.ts'
import { createGraphNodeDirective } from './graph-node.ts'
import { createSubagentResult } from './subagent-result.ts'
import { createBenchRetryCorrection } from './bench-retry.ts'
import { RuntimeContextProjection } from './runtime-context.ts'
import { AssistantStreamAttempt } from './assistant-stream.ts'
import { SystemPromptProjection } from './runtime-context.ts'
import { isMutatingNode, mutationObserved, restrictToolSet, DEFAULT_SHELL_TOOLS, shellFailureTool } from './step-tools.ts'

/** Projected facts consumed by this driver; registration stays with the factory. */
interface LoopProjections {
  /** Current model selection, including pending changes. */
  readonly modelSelection: () => ModelSelectionProjectionState
  /** Current queued and claimed input. */
  readonly inbox: () => InboxState
}

type Phase =
  | { kind: 'idle'; lastTurn: number }
  | {
    kind: 'maintenance'
    abort: AbortController
    lastTurn: number
    wakeRequested: boolean
  }
  | { kind: 'running'; abort: AbortController; turn: number; step: number; wakeRequested: boolean }

type StepEndReason = Extract<TurnEndReason, { kind: 'completed' | 'max-tokens' }>

/** Structural plan-node shape the driver needs (kept local to avoid a cycle). */
interface PlanNodeLike {
  readonly id: string
  readonly executor?: 'step' | 'subagent'
  readonly instruction?: string
  /** Explicit per-node tools; `[]` means answer-only (no tools). */
  readonly toolAllow?: readonly string[]
}

/** Minimal structural view of `ctx.subagents` used by parallel graph nodes. */
interface SubagentsLike {
  startActivation(spec: {
    readonly provider: string
    readonly label: string
    readonly request: {
      readonly parent: Agent
      readonly prompt: readonly { readonly type: 'text'; readonly text: string }[]
      readonly signal: AbortSignal
    }
    readonly delivery: 'caller'
    readonly signal: AbortSignal
  }): Promise<{
    readonly childId: string
    readonly result: Promise<{
      readonly output: readonly { readonly type: string; readonly text?: string }[]
      readonly stopReason?: string
    }>
    dispose(): Promise<void>
  }>
}

/** Flatten the text of pending inbox messages into one routing task string. */
function inboxText(messages: readonly UserMessage[]): string {
  const parts: string[] = []
  for (const message of messages) {
    for (const block of message.content) {
      if (block.type === 'text') parts.push(block.text)
    }
  }
  return parts.join('\n').trim()
}

type PreparedStep =
  | { kind: 'reject' }
  | {
    kind: 'enter'
    messages: UserMessage[]
    startsRequestSeries?: true
    assembly: PromptAssembly
    selection: Readonly<ModelSelection>
    /** Admission shared by the step's declarations and dispatch; the turn disposes it after the step. */
    toolSet: ResolvedToolSet
  }

/** Remove adapter-derived values before plugins propose the next request config. */
function requestProposal(header: EpochHeader): LlmCallConfig {
  if (header.adapterDefaults === undefined) return header.config
  const proposal = { ...header.config }
  if (header.adapterDefaults.reasoningEffort === true) delete proposal.reasoningEffort
  if (header.adapterDefaults.maxTokens === true) delete proposal.maxTokens
  return proposal
}

/**
 * Read the cause `cancel()` passed when aborting a loop-owned signal, copying
 * only the fields `turn/end` records. The live reason stays the caller's
 * object, and Node's fetch assigns a `stack` onto it that `Session.append`
 * would either log or reject as data JSON cannot hold.
 * @param signal - a turn or maintenance signal this loop owns.
 * @returns the copied cause, or undefined while the signal is still live.
 */
function abortedCancelCause(signal: AbortSignal): AgentCancelCause | undefined {
  if (!signal.aborted) return undefined
  // `cancel()` is the only aborter of the signals this loop owns.
  const cause = signal.reason as AgentCancelCause
  switch (cause.kind) {
    case 'user':
    case 'parent':
    case 'disposed':
      return { kind: cause.kind }
    case 'hook':
      return { kind: 'hook', reason: cause.reason }
    /* v8 ignore next -- cancel accepts the closed AgentCancelCause union */
    default:
      return assertNever(cause)
  }
}

/**
 * A graph run that ended in `failed` status. Recovery/replan already had its
 * chance at the failed node's boundary; a run that is still failed after that
 * fails the turn with a structured `GRAPH_FAILED` reason instead of reporting
 * success.
 */
class GraphRunFailure extends Error {
  /** Stable turn-error code recorded with the `turn/end` reason. */
  readonly code = 'GRAPH_FAILED'

  constructor(message: string) {
    super(message)
    this.name = 'GraphRunFailure'
  }
}

/** Drives one session through turn and step boundaries. */
export class ReactLoopAgent implements Agent {
  readonly model: AgentModel
  readonly inbox: ReactLoopInbox
  private phase: Phase
  private activityDone: Promise<void> = Promise.resolve()

  /** The agent-scoped registration boundary; the lifecycle owner unwinds it after the driver exits. */
  readonly scope: Scope
  readonly ctx: Context

  /** Fused dispatcher, built once in the constructor so hot-path dispatches never allocate. */
  private readonly dispatch: AgentEventDispatch

  /** Whether this loop instance has appended its initial/resume request anchor. */
  private requestHeaderLogged = false
  /** Surface generation at attachment or the preceding built request. */
  private requestSurfaceGeneration: number
  private readonly runtimeContext: RuntimeContextProjection
  /** Process-local revision of assistant frames for this attached Session. */
  private assistantStreamRevision = 0
  private assistantAttemptCounter = 0
  private readonly systemPrompt: SystemPromptProjection
  /** Identities fully frozen by this loop; weak references do not retain replaced history. */
  private readonly frozenMessages = new WeakSet<Message>()

  /** Optional graph turn driver: when set, every step is one graph node. */
  private turnGraph: GraphTurnDriver | undefined
  /**
   * Benchmark-harness guards: DSML-printed-tool-call detection and the forced
   * mutation retry. Off by default — these encode a benchmark's failure modes
   * and are not generic loop behavior. The `graph-loop` row opts in with
   * `benchGuards: true`.
   */
  private benchGuards = false
  /**
   * Tools whose lone failed call fails the step's graph node. Configurable
   * because "the shell" is a deployment fact, not a graph semantic; the
   * default pair preserves the behaviour this fork had before the setting.
   */
  private shellTools: ReadonlySet<string> = new Set(DEFAULT_SHELL_TOOLS)

  constructor(
    private loopCtx: Context,
    public readonly id: SessionId,
    public readonly options: AgentOptions,
    public readonly session: Session,
    projections: LoopProjections,
    lastTurn: number,
  ) {
    this.requestSurfaceGeneration = session.surface.contentGeneration
    this.dispatch = agentEvents(loopCtx, this)
    this.scope = createScope(loopCtx, this)
    this.ctx = this.scope.ctx
    this.model = new AgentModel(projections.modelSelection, session, options)
    this.inbox = new ReactLoopInbox(projections.inbox, session, this.dispatch)
    this.phase = { kind: 'idle', lastTurn }
    this.runtimeContext = new RuntimeContextProjection(this.ctx, session)
    this.systemPrompt = new SystemPromptProjection(session)
  }

  /** `ctx.subagents` when the deployment mounts the delegation seam. */
  private subagentsService(): SubagentsLike | undefined {
    return this.loopCtx.get('subagents') as SubagentsLike | undefined
  }

  /**
   * Run one batch of graph subagent nodes concurrently inside the turn.
   * Children are fresh subagent activations; their summaries are injected as
   * model-visible context for the next parent step. No parent model request is
   * logged for the batch, so step boundaries stay real.
   */
  private async runSubagentBatch(batch: readonly PlanNodeLike[]): Promise<void> {
    const subagents = this.subagentsService()
    if (subagents === undefined) return
    const signal = this.phase.kind === 'running' ? this.phase.abort.signal : new AbortController().signal
    await Promise.all(batch.map(async (node) => {
      let activation: Awaited<ReturnType<SubagentsLike['startActivation']>> | undefined
      let completing = false
      try {
        activation = await subagents.startActivation({
          provider: 'spawn',
          label: node.id,
          request: {
            parent: this,
            prompt: [{ type: 'text', text: node.instruction ?? `Complete graph node ${node.id}.` }],
            signal,
          },
          delivery: 'caller',
          signal,
        })
        const result = await activation.result
        // A cancelled turn cleared its inbox on purpose; a child that resolves
        // with `aborted` instead of rejecting must not inject a model-visible
        // result into the next turn.
        if (signal.aborted) {
          this.ctx.logger.warn(`agent "${this.id}": subagent node "${node.id}" result dropped after cancel`)
          return
        }
        const text = result.output
          .map(block => block.type === 'text' ? block.text ?? '' : '')
          .join('\n')
          .trim()
          .slice(0, 4000)
        const ok = result.stopReason === undefined || result.stopReason === 'completed'
        if (!ok) {
          this.ctx.logger.warn(`agent "${this.id}": subagent node "${node.id}" ended with "${String(result.stopReason)}"`)
        }
        this.inject(createSubagentResult(node.id, result.stopReason, text))
        // Mark the completion before awaiting it: if the graph advance throws
        // after settling the node, the catch must not complete it a second time.
        completing = true
        await this.turnGraph?.completeNode(node.id, ok)
      } catch (error: unknown) {
        if (completing) {
          this.ctx.logger.warn(`agent "${this.id}": subagent node "${node.id}" completion failed: ${errorChain(error)}`)
          throw error
        }
        // A failed child is a failed graph node, not a silent success: the
        // scheduler decides whether recovery/replan can still save the turn.
        this.ctx.logger.warn(`agent "${this.id}": subagent node "${node.id}" failed: ${errorChain(error)}`)
        await this.turnGraph?.completeNode(node.id, false)
      } finally {
        await activation?.dispose().catch(() => undefined)
      }
    }))
  }

  /** Attach the per-turn graph driver; the factory sets this before the first wake. */
  setTurnGraph(driver: GraphTurnDriver | undefined): void {
    this.turnGraph = driver
  }

  /** Enable benchmark-only retry guards (default off). */
  setBenchGuards(enabled: boolean): void {
    this.benchGuards = enabled
  }

  /**
   * Choose the shell/verification tools whose lone failure fails a node.
   * Defaults to `bash`/`pwsh`; a deployment with differently named shells
   * overrides this from `AgentLoop.Config.shellTools`.
   */
  setShellTools(tools: readonly string[]): void {
    this.shellTools = new Set(tools)
  }

  get status(): AgentStatus {
    return this.phase.kind === 'idle' || this.phase.kind === 'maintenance' ? 'idle' : 'running'
  }

  /** Commit a phase and publish its externally visible status transition. */
  private setPhase(next: Phase): void {
    const previousStatus = this.status
    this.phase = next
    const status = this.status
    if (status !== previousStatus) {
      this.dispatch.emit('agent/status', { status })
    }
  }

  send(message: UserMessage, target: InboxTarget, wakeup: boolean): void {
    // Waking input cannot join an aborted activity, so it starts the next turn.
    // Captured before the insertion so a reentrant cancel from a splice observer cannot reclassify it.
    const wakingAfterAbort = wakeup && this.phase.kind !== 'idle' && this.phase.abort.signal.aborted
    const resolvedTarget = wakingAfterAbort ? 'next-turn' : target
    this.inbox.splice(resolvedTarget, Infinity, 0, [message])
    if (wakeup) this.wakeDriver(wakingAfterAbort)
  }

  followup(input: UserMessage): void {
    this.send(input, 'next-turn', true)
  }

  steer(input: UserMessage): void {
    this.send(input, 'next-step', true)
  }

  inject(input: UserMessage): void {
    this.send(input, 'next-step', false)
  }

  cancel(cause: AgentCancelCause, options: CancelOptions = {}): void {
    if (!options.keepInbox) {
      this.inbox.clear()
      if (this.phase.kind !== 'idle') this.phase.wakeRequested = false
    }
    if (this.phase.kind !== 'idle') this.phase.abort.abort(cause)
  }

  runMaintenance<T>(job: (signal: AbortSignal) => Promise<T>): Promise<T> {
    if (this.phase.kind !== 'idle') throw new Error(`agent "${this.id}" already has active work`)
    const done = Promise.withResolvers<void>()
    const maintenance: Phase = {
      kind: 'maintenance',
      abort: new AbortController(),
      lastTurn: this.phase.lastTurn,
      wakeRequested: false,
    }
    this.setPhase(maintenance)
    this.activityDone = done.promise
    return (async () => {
      try {
        return await job(maintenance.abort.signal)
      } finally {
        this.setPhase({ kind: 'idle', lastTurn: maintenance.lastTurn })
        const cause = abortedCancelCause(maintenance.abort.signal)
        if (cause?.kind !== 'disposed' && maintenance.wakeRequested && this.inbox.hasPending) this.wakeDriver()
        done.resolve()
      }
    })()
  }

  /**
   * Start one driver, or latch its wake behind maintenance or an aborted
   * activity. A wake sent while idle always opens its turn boundary, even
   * when its message was cleared; only a latched replay is suppressed when
   * the queue no longer holds the wake.
   * @param wakeAfterAbort - the {@link send} classification, captured before
   *   the inbox insertion so a reentrant cancel cannot reclassify it.
   */
  private wakeDriver(wakeAfterAbort = false): void {
    if (this.phase.kind !== 'idle') {
      // Maintenance and aborted drivers cannot deliver the wake: latch it for
      // replay at convergence. Live drivers claim queued work themselves;
      // disposal never latches, so teardown waits on no model turn.
      const reason = abortedCancelCause(this.phase.abort.signal)
      if (reason?.kind !== 'disposed' && (this.phase.kind === 'maintenance' || wakeAfterAbort)) {
        this.phase.wakeRequested = true
      }
      return
    }
    const driver = Promise.withResolvers<void>()
    this.activityDone = driver.promise
    this.setPhase({
      kind: 'running',
      abort: new AbortController(),
      turn: this.phase.lastTurn,
      step: 0,
      wakeRequested: false,
    })
    this.loopCtx.agents.withInitiator(this, () => this.kick()).then(driver.resolve, driver.reject)
  }

  async whenIdle(): Promise<void> {
    let activity: Promise<void>
    do {
      await (activity = this.activityDone)
    } while (activity !== this.activityDone)
  }

  /** Report one failure at its live boundary, then preserve it for driver containment. */
  private throwError(error: unknown): never {
    const turn = this.phase.kind === 'running' ? this.phase.turn : this.phase.lastTurn
    const step = this.phase.kind === 'running' ? this.phase.step : 0
    this.dispatch.emit('agent/error', { turn, step, error })
    throw error
  }

  /**
   * Fail the turn when the graph ended in `failed` status. The scheduler's
   * recovery/replan pass runs at the failed node's boundary, so a run that is
   * still failed here has no recovery left: report it instead of counting the
   * turn as completed.
   */
  private throwGraphFailure(): void {
    if (this.turnGraph?.status?.() !== 'failed') return
    const node = this.turnGraph.snapshot().node
    throw new GraphRunFailure(node === undefined
      ? 'graph run ended in "failed" status'
      : `graph run ended in "failed" status at node "${node}"`)
  }

  private async kick(): Promise<void> {
    try {
      while (await this.turn()) {}
    } catch (_error) {
      // Reported failures and cancellation are contained at the driver boundary.
    } finally {
      /* v8 ignore next -- kick owns a running phase until this driver boundary */
      if (this.phase.kind === 'running') {
        const { turn, wakeRequested } = this.phase
        this.setPhase({ kind: 'idle', lastTurn: turn })
        if (wakeRequested && this.inbox.hasPending) this.wakeDriver()
      }
    }
  }

  private async preStep(target: InboxTarget, position: { turn: number; step: number }): Promise<PreparedStep> {
    /* v8 ignore next -- private callers establish the running phase before proposing a step */
    if (this.phase.kind !== 'running') throw new Error(`agent "${this.id}": pre-step outside running phase`)
    const signal = this.phase.abort.signal
    const claimed = this.inbox.claim(target, position.turn)
    const node = this.turnGraph?.current()
    const directive = node === undefined
      ? undefined
      : `${this.turnGraph?.instruction() ?? `Execute graph node \`${node.id}\` and advance the task.`}\nTool calls must use the tool-call interface; never print tool-call, DSML or XML syntax as text.`
    const admitted = directive === undefined
      ? claimed
      : [...claimed, createGraphNodeDirective(node?.id ?? 'unknown', directive)]
    const selection = this.model.current()
    if (selection === undefined) {
      throw new Error(`agent "${this.id}" has no provider/model: set AgentOptions.provider and AgentOptions.model or record a model selection`)
    }
    const toolSet = await this.loopCtx.tools.resolve({ agent: this, modelSelection: selection, signal })
    const nodeToolAllow = node?.toolAllow
    const universe = this.turnGraph?.toolUniverse?.()
    // Per-node tools matter for one case: a terminal `toolAllow: []` is an
    // answer-only node. Every other node uses the plan universe, which already
    // contains the safe tool floor. An empty intersection stays empty: widening
    // back to the full preset would silently undo the plan's narrowing, so the
    // step runs with no tools and the mismatch is logged instead.
    const answerOnly = nodeToolAllow !== undefined && nodeToolAllow.length === 0
    const allowed = answerOnly
      ? new Set<string>()
      : universe !== undefined && universe.length > 0
        ? new Set(universe)
        : undefined
    const admittedToolSet = allowed !== undefined
      ? restrictToolSet(toolSet, allowed, answerOnly
        ? undefined
        : (visible) => {
          this.ctx.logger.warn(`agent "${this.id}": node "${node?.id ?? 'unknown'}" admits none of its visible tools (${visible.join(', ')}); starting the step with no tools`)
        })
      : toolSet
    try {
      const assembly = await this.loopCtx.systemPrompt.assemble({ ...assembleContextFor(this, signal), modelSelection: selection, toolSet: admittedToolSet })
      signal.throwIfAborted()
      const decision = await this.dispatch.waterfall(
        'agent/pre-step', { messages: admitted, ...position, signal, modelSelection: selection },
        (): Promise<PreStepDecision> => {
          const sections = renderContextSections(assembly)
          const context = this.runtimeContext.project(joinContextSections(sections), sections)
          return Promise.resolve<PreStepDecision>({
            kind: 'enter',
            messages: context === undefined ? admitted : [...admitted, context],
          })
        },
      )
      signal.throwIfAborted()
      if (decision.kind === 'reject') {
        admittedToolSet.dispose()
        return decision
      }
      return { ...decision, assembly, selection, toolSet: admittedToolSet }
    } catch (error: unknown) {
      admittedToolSet.dispose()
      throw error
    }
  }

  /** Whether the assembled tool schemas differ from the logged request header's. */
  private toolsChanged(tools: PromptAssembly['tools']): boolean {
    const baseline = this.session.requestHeader()
    if (baseline === undefined) return false
    return !headerEquals(baseline, canonicalHeader({ ...baseline, tools: [...tools] }))
  }

  /** Open one turn before claiming its first proposed step. */
  private async turn(): Promise<boolean> {
    if (this.phase.kind !== 'running') {
      this.throwError(new Error(`agent "${this.id}": turn without driver reservation`))
    }
    const phase = this.phase
    const { signal } = phase.abort
    signal.throwIfAborted()
    const turn = phase.turn + 1
    try {
      this.session.append('turn/start', { turn })
    } catch (error: unknown) {
      this.throwError(error)
    }
    phase.turn = turn
    let turnEnds: TurnEndReason | null = null
    const formatRetries = new Map<string, number>()
    // Per-node, not per-turn: a turn can visit several mutating nodes (a plan's
    // `n_*_mutate` stages, then a repair node), and one node's retry must not
    // consume a later node's correction. Keyed by node id; each node gets one.
    const mutationRetries = new Map<string, number>()
    let target: InboxTarget = 'next-turn'
    try {
      // beginTurn runs inside the turn boundary: a failing graph start must
      // still close the turn it opened, exactly once, through the catch below.
      if (this.turnGraph !== undefined) {
        // The turn can be opened by a `next-step` steer (idle agent); planning
        // from `next-turn` alone would synthesize the graph from an empty task
        // even though the first step is about to claim the steered message.
        const pending = [...this.inbox.nextStep, ...this.inbox.nextTurn]
        await this.turnGraph.beginTurn({ text: inboxText(pending), surface: 'api' })
      }
      while (true) {
        signal.throwIfAborted()
        if (this.turnGraph?.done() === true) {
          // A graph that completed before a step still owns the turn end; a
          // failed one fails it instead of being reported as a completion.
          this.throwGraphFailure()
          if (turnEnds === null) turnEnds = { kind: 'completed' }
          break
        }
        const graphNode = this.turnGraph?.current()
        if (graphNode?.model !== undefined) {
          const { provider, model, reasoningEffort } = graphNode.model
          this.model.select((reasoningEffort === undefined
            ? { provider, model }
            : { provider, model, reasoningEffort }) as Readonly<ModelSelection>)
        }
        if (graphNode?.executor === 'subagent' && this.subagentsService() !== undefined) {
          const batch = this.turnGraph?.takeSubagentBatch() ?? []
          if (batch.length > 0) {
            await this.runSubagentBatch(batch)
            if (this.turnGraph?.done() === true) {
              this.throwGraphFailure()
              if (turnEnds === null) turnEnds = { kind: 'completed' }
              await this.dispatch.serial('agent/turn-stopping', { turn, signal })
              signal.throwIfAborted()
              break
            }
            continue
          }
        }
        const step = phase.step + 1
        const decision = await this.preStep(target, { turn, step })
        if (decision.kind === 'reject') {
          turnEnds = { kind: 'blocked' }
          return false
        }
        let stepFailedTool: string | undefined
        let stepEnd: StepEndReason | null = null
        let stepDsml = false
        const stepTools: { name: string; callId: string; isError: boolean; arguments?: string; output?: string }[] = []
        try {
          if (turnEnds && decision.messages.length === 0) break
          // A removed waking message or an enter decision rewritten to empty
          // still owns the initial turn boundary, but it spends no model call.
          if (phase.step === 0 && decision.messages.length === 0) {
            turnEnds = { kind: 'completed' }
            return false
          }
          signal.throwIfAborted()
          this.session.append('step/start', { turn, step })
          phase.step = step
          const toolRecovery = new ToolCallRecovery()
          const toolNames = new Map<string, string>()
          const stopRecovery = this.ctx.on('session/event', (session, event) => {
            if (session !== this.session) return
            toolRecovery.observe(event)
            if (event.type === 'assistant/message') {
              if (this.benchGuards) {
                const content = event.data.message.content
                if (JSON.stringify(content).includes('DSML')) stepDsml = true
              }
            } else if (event.type === 'tool/call') {
              toolNames.set(event.data.callId, event.data.name)
              stepTools.push({ name: event.data.name, callId: event.data.callId, isError: false, arguments: typeof event.data.arguments === 'string' ? event.data.arguments : undefined })
            } else if (event.type === 'tool/result') {
              const name = toolNames.get(event.data.message.toolCallId)
              const entry = stepTools.find(tool => tool.callId === event.data.message.toolCallId)
              if (entry !== undefined) {
                entry.isError = event.data.message.isError === true
                const content = event.data.message.content
                entry.output = Array.isArray(content)
                  ? content.map(part => part.type === 'text' ? part.text : '').join('\n')
                  : ''
              }
              if (event.data.message.isError === true) {
                const failed = shellFailureTool(name, this.shellTools)
                if (failed !== undefined) stepFailedTool = failed
              }
            }
          })
          try {
            // max-tokens is sticky: once any step hits the ceiling, later steps
            // that complete normally must not downgrade the turn outcome.
            stepEnd = await this.step(decision)
            // max-tokens stays sticky: a later completed step must not
            // downgrade the turn outcome.
            if (turnEnds === null || turnEnds.kind !== 'max-tokens') turnEnds = stepEnd
          } catch (error: unknown) {
            try {
              for (const event of toolRecovery.results()) {
                this.session.append('tool/result', event.data, {
                  surfaceOp: 'append',
                  ...event.sourceEventSeqs === undefined ? {} : { sourceEventSeqs: event.sourceEventSeqs },
                })
              }
            } catch (recoveryError: unknown) {
              throw new AggregateError([error, recoveryError], 'Step failed and its pending tool results could not be recorded', { cause: error })
            }
            throw error
          } finally {
            stopRecovery()
            this.session.append('step/end', { turn, step })
          }
        } finally {
          // Admission closes once the step's tool batch settles or no step opens.
          decision.toolSet.dispose()
        }
        // Tool-call markup printed as text is a formatting failure, not a
        // completed node. Retry the same node once or twice with a correction;
        // the graph must not advance without the file the node was asked to write.
        const retryNode = this.turnGraph?.current()
        if (this.benchGuards
          && this.turnGraph !== undefined
          && stepDsml
          && stepTools.length === 0
          && retryNode !== undefined
          && (formatRetries.get(retryNode.id) ?? 0) < 1
          && (retryNode.toolAllow?.length ?? 1) > 0) {
          formatRetries.set(retryNode.id, (formatRetries.get(retryNode.id) ?? 0) + 1)
          this.inject(createBenchRetryCorrection('Your previous response printed a tool call as text. Re-issue the same tool call through the actual tool-call interface; do not print tool-call, DSML or XML syntax.'))
          // The retry is another step of this turn: it must not claim a queued
          // next-turn prompt (the loop's bottom assignment is skipped by continue).
          target = 'next-step'
          continue
        }
        // A mutation node must actually mutate. Exploration on a mutation node
        // is a common failure on long tasks: the model lists files and never
        // writes. Retry the same node once with a direct correction instead of
        // advancing; the node's own intent decides, so the composed `n_mutate`
        // is enforced exactly like the dynamic `d_edit`. The budget is per node
        // id: a plan that visits several mutating nodes still corrects each of
        // them, instead of spending the turn's single retry on the first one.
        if (this.benchGuards
          && this.turnGraph !== undefined
          && retryNode !== undefined
          && isMutatingNode(retryNode)
          && !mutationObserved(stepTools, this.shellTools)
          && (mutationRetries.get(retryNode.id) ?? 0) < 1
          && !signal.aborted) {
          mutationRetries.set(retryNode.id, (mutationRetries.get(retryNode.id) ?? 0) + 1)
          this.inject(createBenchRetryCorrection('This node must perform the requested change. Call a mutating tool (`write` for a new artifact, `edit`/`str_replace_editor` for an in-place change) or a shell mutation now; do not run more exploratory commands.'))
          target = 'next-step'
          continue
        }
        signal.throwIfAborted()
        if (this.turnGraph !== undefined) {
          // A step is a graph node, but a node is not failed by every tool error:
          // the model routinely tries an unavailable tool and then succeeds with
          // another one in the same step. Fail the node only when the step did not
          // complete, or when every tool it called failed.
          // The node is complete only when this step completed. `turnEnds` is
          // sticky for max-tokens (a later step must not downgrade the turn),
          // so it cannot answer "did this node finish"; use the step's own result.
          const stepCompleted = stepEnd === null || stepEnd.kind === 'completed'
          const allToolsFailed = stepTools.length > 0 && stepTools.every(tool => tool.isError)
          const noToolAfterFailure = stepTools.length === 0 && stepFailedTool !== undefined
          // A read-before-write node is advisory: a missing input file must not
          // fail the turn and trigger a recovery plan; the mutation node follows.
          const optional = this.turnGraph.current()?.optional === true
          const ok = optional ? stepCompleted : stepCompleted && !allToolsFailed && !noToolAfterFailure
          await this.turnGraph.advance({
            ok,
            ...(stepFailedTool === undefined ? {} : { failedTool: stepFailedTool }),
            tools: stepTools,
          })
        }
        if (this.turnGraph !== undefined) {
          if (this.turnGraph.done()) {
            // A finished graph owns the turn end. If its terminal node ended on a
            // tool call rather than free text, the step result is null; the turn
            // still completed successfully, so do not log a null reason. A run
            // that ended failed is the one exception: recovery/replan already
            // had its chance, so the turn ends with a structured error.
            this.throwGraphFailure()
            if (turnEnds === null) turnEnds = { kind: 'completed' }
            await this.dispatch.serial('agent/turn-stopping', { turn, signal })
            signal.throwIfAborted()
            break
          }
        } else if (turnEnds && this.inbox.nextStep.length === 0) {
          await this.dispatch.serial('agent/turn-stopping', { turn, signal })
          signal.throwIfAborted()
          if (turnEnds && this.inbox.nextStep.length === 0) break
        }
        target = 'next-step'
      }
    } catch (error: unknown) {
      // A cause is present exactly while the signal is aborted.
      const cause = abortedCancelCause(signal)
      if (cause !== undefined) {
        turnEnds = { kind: 'aborted', reason: cause }
        throw error
      }
      // Every failure is structured: an `LlmError` keeps its facts, a tool
      // activation failure keeps its code, a failed graph run reports
      // `GRAPH_FAILED`, and anything else flattens to `errorChain` text under
      // the `UNKNOWN` code.
      turnEnds = {
        kind: 'error',
        error: error instanceof GraphRunFailure
          ? { message: error.message, code: error.code }
          : error instanceof LlmError
            ? error.failure
            : { message: errorChain(error), code: error instanceof ToolActivationError ? error.code : 'UNKNOWN' },
      }
      this.throwError(error)
    } finally {
      try {
        // oxlint-disable-next-line typescript/no-non-null-assertion -- every exit assigns a turn ending
        this.session.append('turn/end', { turn, reason: turnEnds! })
      } catch (error: unknown) {
        this.throwError(error)
      }
      try {
        this.turnGraph?.endTurn()
      } catch {
        // Tracing must never fail a completed turn.
      }
    }
    if (!this.inbox.hasPending) return false
    phase.abort = new AbortController()
    // A fresh controller makes a latch set on the old one stale: the live driver claims the queue itself.
    phase.wakeRequested = false
    phase.step = 0
    return true
  }

  private async step(decision: Extract<PreparedStep, { kind: 'enter' }>): Promise<StepEndReason | null> {
    /* v8 ignore next -- private callers establish the running phase before executing a step */
    if (this.phase.kind !== 'running') throw new Error(`agent "${this.id}": step outside running phase`)
    const { turn, step, abort: { signal } } = this.phase
    signal.throwIfAborted()

    const { assembly } = decision
    const renderedPrompt = renderPrompt(assembly)
    let firstAttempt = true
    while (true) {
      const { config, preparedCall } = await this.prepareRequest(turn, step, decision.selection, signal)
      const currentContext = this.loopCtx.systemPrompt.refreshContext(assembly, {
        ...assembleContextFor(this, signal), modelSelection: decision.selection,
      })
      const sections = renderContextSections(currentContext)
      const context = this.runtimeContext.project(joinContextSections(sections), sections)
      signal.throwIfAborted()
      const startsRequestSeries = firstAttempt && decision.startsRequestSeries === true
      const commits = this.systemPrompt.project(renderedPrompt, {
        inHistory: preparedCall?.systemPromptUpdate === 'in-history',
        startsSeries: startsRequestSeries
          || this.requestSurfaceGeneration !== this.session.surface.contentGeneration
          || (preparedCall?.toolUpdate === undefined && this.toolsChanged(assembly.tools)),
      })
      for (const { message, intent } of commits) {
        this.session.append('system/message', { turn, step, message }, intent)
      }
      let contextAdmitted = false
      if (firstAttempt) {
        for (const message of decision.messages) {
          if (message.source.kind === 'runtime-context') {
            if (context !== undefined && !contextAdmitted) {
              this.session.append('user/message', context, { surfaceOp: 'append' })
              contextAdmitted = true
            }
          } else {
            this.session.append('user/message', message, { surfaceOp: 'append' })
          }
        }
      }
      if (context !== undefined && !contextAdmitted) {
        this.session.append('user/message', context, { surfaceOp: 'append' })
      }
      firstAttempt = false
      const request = this.buildRequest(config, preparedCall, assembly.tools, { turn, step }, startsRequestSeries, signal)
      const live = new AssistantStreamAttempt(
        this.session.id,
        ++this.assistantAttemptCounter,
        () => ++this.assistantStreamRevision,
        turn,
        step,
        (frame) => { this.dispatch.emit('agent/assistant-stream', { frame }) },
      )
      let started = false
      try {
        const stream = preparedCall?.stream(request) ?? this.loopCtx.llm.stream(request)
        signal.throwIfAborted()
        live.start()
        started = true
        for await (const chunk of stream) {
          signal.throwIfAborted()
          live.push(chunk)
        }
        signal.throwIfAborted()
      } catch (error: unknown) {
        if (!started) throw error
        try {
          if (signal.aborted) {
            const content = live.interruptedBlocks()
            if (content.length > 0) {
              live.settle('assistant/message', () => this.session.append('assistant/message', {
                turn,
                step,
                message: createAssistantMessage({
                  content,
                  source: {
                    provider: request.provider,
                    model: request.model,
                    ...live.replayState === undefined ? {} : { replayState: live.replayState },
                  },
                }),
                interrupted: true,
                ...live.usage === undefined ? {} : { usage: live.usage },
                stream: live.stream,
              }, { surfaceOp: 'append' }).seq)
            } else {
              live.settle(
                'assistant/attempt',
                () => this.session.append('assistant/attempt', { turn, step, stream: live.stream }).seq,
              )
            }
          } else {
            live.settle(
              'assistant/attempt',
              () => this.session.append('assistant/attempt', { turn, step, stream: live.stream }).seq,
            )
          }
        } catch (settlementError: unknown) {
          throw new AggregateError(
            [error, settlementError],
            'Assistant stream failed and its durable settlement was rejected',
            { cause: error },
          )
        }
        throw error
      }
      try {
        const finish = live.finish
        if (finish.kind === 'error' || finish.kind === 'aborted') {
          live.settle(
            'assistant/attempt',
            () => this.session.append('assistant/attempt', { turn, step, stream: live.stream }).seq,
          )
          const action = await this.dispatch.waterfall(
            'agent/request-error', {
              turn,
              step,
              provider: request.provider,
              failure: finish.failure,
              retryPolicy: preparedCall?.retryPolicy,
              signal,
            },
            () => Promise.resolve<RequestErrorAction>(undefined),
          )
          signal.throwIfAborted()
          if (action?.kind !== 'retry') {
            throw new LlmError(finish.failure.message, finish.failure.code, finish.failure)
          }
          continue
        }

        const message = createAssistantMessage({
          content: live.blocks(),
          source: {
            provider: request.provider,
            model: request.model,
            ...live.replayState !== undefined ? { replayState: live.replayState } : {},
          },
        })
        live.settle(
          'assistant/message',
          () => this.session.append('assistant/message', {
            turn,
            step,
            message,
            ...live.usage === undefined ? {} : { usage: live.usage },
            stream: live.stream,
          }, { surfaceOp: 'append' }).seq,
        )
        if (finish.kind === 'max-tokens') return { kind: 'max-tokens' }

        const toolCalls = message.content.filter(block => block.type === 'tool-call')
        if (toolCalls.length === 0) return { kind: 'completed' }
        const maxParallelToolCalls = this.loopCtx.agentLoop.config.maxParallelToolCalls.get()
        try {
          const result = await this.loopCtx.tools.execute({
            calls: toolCalls, signal, agent: this, log: { turn, step },
            maxParallelToolCalls, toolSet: decision.toolSet,
          })
          for (const context of result.additionalContexts) {
            this.inbox.splice('next-step', this.inbox.nextStep.length, 0, [context])
          }
          return result.concluded ? { kind: 'completed' } : null
        } catch (error: unknown) {
          if (!(error instanceof ToolBatchExecutionError)) throw error
          for (const context of error.partial.additionalContexts) {
            this.inbox.splice('next-step', this.inbox.nextStep.length, 0, [context])
          }
          throw error.cause
        }
      } catch (error: unknown) {
        if (!live.ended) live.abandon()
        throw error
      }
    }
  }

  /** Resolve request config for the step's selection and bind its adapter before admitting model-visible input. */
  private async prepareRequest(
    turn: number,
    step: number,
    selection: Readonly<ModelSelection>,
    signal: AbortSignal,
  ): Promise<{ config: LlmCallConfig; preparedCall?: PreparedLlmCall }> {
    const { session } = this

    // A loop instance seeds output controls from its options until it logs its
    // own header; later steps re-resolve marked defaults.
    const maxTokens = this.options.maxTokens
    const persisted: Partial<LlmCallConfig> = this.requestHeaderLogged
      // oxlint-disable-next-line typescript/no-non-null-assertion -- the instance logged the header it now folds
      ? requestProposal(session.requestHeader()!)
      : maxTokens === undefined ? {} : { maxTokens }
    const { provider: _provider, model: _model, reasoningEffort: _effort, ...controls } = persisted
    const seedConfig = deepFreeze(structuredClone({ ...controls, ...selection }))
    const proposedConfig = await this.dispatch.waterfall(
      'agent/request', { turn, step, signal },
      () => Promise.resolve(seedConfig),
    )
    signal.throwIfAborted()
    if (proposedConfig.provider !== selection.provider || proposedConfig.model !== selection.model) {
      throw new Error(`agent "${this.id}": agent/request proposed "${proposedConfig.provider}/${proposedConfig.model}" after step preparation fixed "${selection.provider}/${selection.model}"; use agent.model.select() before step preparation`)
    }
    if (proposedConfig.reasoningEffort !== selection.reasoningEffort) {
      throw new Error(`agent "${this.id}": agent/request proposed reasoning effort "${proposedConfig.reasoningEffort ?? 'adapter default'}" after step preparation fixed "${selection.reasoningEffort ?? 'adapter default'}"; use agent.model.select() before step preparation`)
    }
    let config: LlmCallConfig
    let preparedCall: PreparedLlmCall | undefined
    try {
      preparedCall = await this.loopCtx.llm.prepareCall(proposedConfig, signal)
      config = preparedCall.config
    } catch (error: unknown) {
      // Middleware may serve an unregistered route; terminal dispatch still requires an adapter.
      if (!(error instanceof LlmError) || error.code !== 'NO_ADAPTER') throw error
      config = proposedConfig
    }
    signal.throwIfAborted()
    return { config, ...preparedCall === undefined ? {} : { preparedCall } }
  }

  /** Log the resolved envelope and derive a frozen request from the admitted surface. */
  private buildRequest(
    config: LlmCallConfig,
    preparedCall: PreparedLlmCall | undefined,
    tools: GenerateOptions['tools'] & object,
    position: { turn: number; step: number },
    startsRequestSeries: boolean,
    signal: AbortSignal,
  ): GenerateOptions {
    const { session } = this
    const surfaceGeneration = session.surface.contentGeneration
    const header = canonicalHeader({
      config,
      ...preparedCall === undefined ? {} : { adapterDefaults: preparedCall.adapterDefaults },
      ...tools.length > 0 ? { tools } : {},
    })
    const baseline = this.session.requestHeader()
    const startsSeries = startsRequestSeries
      || this.requestSurfaceGeneration !== surfaceGeneration
    let headerSeq: SessionSeq | undefined
    if (!this.requestHeaderLogged) {
      // Compaction during the first resumed pre-step must still mark a new series.
      headerSeq = this.session.append('request/header', {
        header,
        reason: baseline === undefined ? 'initial' : 'resume',
        ...startsSeries ? { startsSeries: true } : {},
      }).seq
      this.requestHeaderLogged = true
    } else if (baseline === undefined || !headerEquals(baseline, header)) {
      headerSeq = this.session.append('request/header', {
        header,
        reason: 'change',
        ...startsSeries ? { startsSeries: true } : {},
      }).seq
    } else if (startsSeries) {
      this.session.append('request/header', { header, reason: 'series' })
    }
    if (baseline !== undefined && headerSeq !== undefined) {
      const previousNames = new Set(baseline.tools?.map(tool => tool.name))
      const currentNames = new Set(tools.map(tool => tool.name))
      const additions = tools.filter(tool => !previousNames.has(tool.name))
        .map(tool => ({ type: 'tool-addition' as const, toolName: tool.name }))
      const removals = (baseline.tools ?? []).filter(tool => !currentNames.has(tool.name))
        .map(tool => ({ type: 'tool-removal' as const, toolName: tool.name }))
      if (additions.length > 0 || removals.length > 0) {
        session.append('developer/message', {
          ...position,
          message: createDeveloperMessage({ source: { kind: 'tool-registry' }, content: [...additions, ...removals] }),
          ...additions.length > 0 ? { headerSeq } : {},
        }, { surfaceOp: 'append' })
      }
    }
    this.requestSurfaceGeneration = surfaceGeneration

    const contextWindow = preparedCall?.context?.contextWindow
    const systemPromptUpdate = preparedCall?.systemPromptUpdate
    const requestContext: RequestContext = {
      provider: config.provider,
      model: config.model,
      ...contextWindow === undefined ? {} : { contextWindow },
      ...systemPromptUpdate === undefined ? {} : { systemPromptUpdate },
    }
    const previousContext = session.requestContext()
    if (previousContext?.provider !== requestContext.provider
      || previousContext.model !== requestContext.model
      || previousContext.contextWindow !== requestContext.contextWindow
      || previousContext.systemPromptUpdate !== requestContext.systemPromptUpdate) {
      session.append('request/context', requestContext)
    }
    signal.throwIfAborted()

    // canonicalHeader is shallow; append logs a detached snapshot, not these local values.
    deepFreeze(header)
    const boundaryMessages = session.deriveMessages()
    for (const message of boundaryMessages) {
      if (this.frozenMessages.has(message)) continue
      deepFreeze(message)
      this.frozenMessages.add(message)
    }
    Object.freeze(boundaryMessages)
    const request = markAgentLoopRequest(Object.freeze({
      ...header.config,
      messages: boundaryMessages,
      toolHistory: session.toolHistory(),
      ...header.tools !== undefined ? { tools: header.tools } : {},
      sessionId: this.session.id,
      signal,
    }))
    return request
  }
}
