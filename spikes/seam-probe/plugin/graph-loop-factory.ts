/**
 * SKELETON — a graph-loop plugin that satisfies `AgentFactory`.
 *
 * This file is COMPILE-ONLY evidence for the contract list in
 * research/01-seams.md. It is never mounted by any probe: a running loop needs a
 * real model route, a persistence backend, and a driver, which is the whole
 * project. `npx tsc --noEmit` proves it satisfies the published interfaces.
 *
 * Every method below mirrors a step the stock loop performs; the citation on
 * each block is the source of truth a fork must re-implement. Anything without a
 * `public API` note is package-internal and must be copied from
 * packages/core/agent-loop/src/*.
 */
import { Context, Service } from '@deepseek-ai/cordis'
import type {
  Agent,
  AgentFactory,
  AgentHandle,
  CreateAgentOptions,
  ResumeAgentOptions,
} from '@deepseek-ai/dsh-agent'
import type { Session, SessionId } from '@deepseek-ai/dsh-session'
import type { SessionPersistence } from '@deepseek-ai/dsh-session-persistence'

/** Replacement rows read this; mirror the stock config where consumers depend on it. */
export interface GraphLoopConfig {
  /** Graph node registry: the registry graph from the user's proposal. */
  readonly nodes: readonly string[]
  /** Entry node id. */
  readonly entry: string
}

export class GraphLoop extends Service implements AgentFactory {
  // Same dependency set the stock loop declares (agent-loop/src/index.ts:292).
  // `agentLoop` service name is retained so `tool-cordis`'s catalog and any
  // `ctx.get('agentLoop')` consumer keep working; `AgentLoop` is the stock class.
  static inject = ['agents', 'sessions', 'llm', 'tools', 'systemPrompt', 'sessionProjections']

  static Config = undefined as unknown

  readonly config: GraphLoopConfig

  constructor(ctx: Context, config: GraphLoopConfig) {
    super(ctx, 'agentLoop')
    this.config = config
  }

  protected async [Service.init](): Promise<void> {
    // 1. Projections. `turnBoundary` is owned by AgentRegistry, not the loop
    //    (core/agent/src/index.ts:298), so `ctx.agents.turnBoundaryOf(session)`
    //    is available without forking. `modelSelectionProjectionDefinition` is
    //    exported (core/agent/src/index.ts:23). `inboxProjectionDefinition` is
    //    NOT exported from the agent-loop package root — and its export map
    //    forbids `./src/*` (ERR_PACKAGE_PATH_NOT_EXPORTED, measured) — so a
    //    replacement loop must COPY inbox.ts (232 LOC) or define its own fold
    //    for the `agent/inbox/spliced` event (dsh-agent/src/types.ts:110).
    // 2. Factory registration. setFactory throws when one is already registered
    //    (core/agent/src/index.ts:383-385), so the stock row MUST be disabled
    //    first (probe B).
    // 3. Prompt variables `provider`/`model` are expected by sections registered
    //    elsewhere (agent-loop/src/index.ts:337-338).
  }

  /** Create + publish an agent (core/agent/src/index.ts:197, agent-loop/src/index.ts:716). */
  async createAgent(_ownerCtx: Context, options: CreateAgentOptions): Promise<AgentHandle> {
    // CONTRACT (each line is a stock-loop responsibility):
    //   a. sessions.prepare(id, { seed, meta, inheritedEventCount })  -> SessionPreparation
    //   b. sessionPersistence.create(header, { inheritedEventCount, signal })
    //   c. build the driver + scope, then in order:
    //        appendUnstoredSuffix · sessions.enter/announce · setup(agent.ctx, agent)
    //        · agents.enter(agent, parentAgent) · agents.announce(agent, source, signal)
    //   d. return { agent, dispose } where dispose stops the driver, unwinds the
    //      scope, closes the write handle, then detaches both registries
    //      (agent-loop/src/index.ts:498-545).
    //   e. store any event appended before publication through the handle
    //      (agent-loop/src/index.ts:702-708), or it is lost on crash.
    throw new Error(`graph-loop skeleton: createAgent not implemented (no driver)`)
  }

  /** Resume on a persisted session (core/agent/src/index.ts:209, agent-loop/src/index.ts:753). */
  async resume(_ownerCtx: Context, options: ResumeAgentOptions): Promise<AgentHandle> {
    const persistence = this.ctx.get('sessionPersistence') as SessionPersistence | undefined
    if (persistence === undefined) throw new Error('cannot resume: session persistence is not configured')
    void options.resumeSessionId
    // CONTRACT: open(id,'write') FIRST (excludes concurrent resume), read(0, undefined),
    // append interruptedTurnClosers(persisted) — exported by dsh-session — then
    // seed a Session, append the unstored suffix, then createAgent's step (c).
    // agent-loop/src/index.ts:762-834.
    throw new Error('graph-loop skeleton: resume not implemented (no driver)')
  }
}

/** Reserved for the graph engine: per-node state the driver owns. */
export interface GraphNodeState {
  readonly id: string
  readonly session: Session
  readonly agent: Agent
}

export default GraphLoop
