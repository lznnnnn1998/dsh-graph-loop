/**
 * Graph-chat: a live chat surface where the per-turn topology is a first-class
 * part of the conversation.
 *
 * The host plugin serves a small standalone page plus a JSON API backed by the
 * graph runtime. It deliberately does not touch the Web client plugin system:
 * the page is plain HTML/JS, served over the existing `ctx.webServer`, so it
 * works with any profile and can be iterated without a client bundle build.
 *
 * Routes:
 *   GET  /graph-chat                  the page
 *   GET  /graph-chat/api/state        sessions + traces for one session
 *   GET  /graph-chat/api/messages     derived messages for one session
 *   POST /graph-chat/api/new          create a fresh session (needs a live root route)
 *   POST /graph-chat/api/send         enqueue a user message
 *   GET  /graph-chat/api/events       server-sent graph snapshots for one session
 *
 * Every route owns its response lifecycle end to end: the handler's promise is
 * returned to the web server, so a client that drops mid-body becomes a caught
 * failure (400) instead of a detached rejection that would trip the host's
 * fail-loud policy. Request bodies are bounded (64 KiB / 15 s), the route set is
 * behind the host Connection trust fence when that service is mounted, and each
 * method is pinned.
 */
import { readFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { Service, type Context } from '@deepseek-ai/cordis'
import { brandString } from '@deepseek-ai/dsh-brand'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { SessionId, UserMessage } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-host-webserver'
import type { TaskPlan } from 'dsh-graph-loop-core/graph-schema'

export interface Config {
  /** Exact page path. Default `/graph-chat`. */
  path?: string
  /** Fallback route for `New graph chat` when no live agent exists yet. */
  provider?: string
  model?: string
  /** Agent preset recorded on the new session (tools/persona composition). */
  preset?: string
  /** Working directory recorded on a new session; defaults to the host's cwd. */
  cwd?: string
}

export const name = 'explore-graph-chat'

export const inject = ['webServer', 'sessions', 'agents']

/** JSON bodies are tiny objects; anything larger is hostile. */
const MAX_BODY_BYTES = 64 * 1024
/** A stalled upload must not pin a handler forever. */
const BODY_TIMEOUT_MS = 15_000
/** Session ids and message text are bounded so one request cannot bloat a turn. */
const MAX_ID_CHARS = 200
const MAX_TEXT_CHARS = 32_000

const PAGE = (() => {
  const url = new URL('../assets/graph-chat.html', import.meta.url)
  try {
    return readFileSync(url, 'utf8')
  } catch (error) {
    throw new Error(`graph-chat: cannot read page asset ${url.pathname}; rebuild the package`, { cause: error })
  }
})()

interface RuntimeLike {
  traceHistory(sessionId: string): readonly unknown[]
  last(sessionId: string): unknown
  subscribe(sessionId: string, listener: (payload: { snapshot: unknown; turns: readonly unknown[] }) => void): () => void
}
/** The route-bearing face of a live agent; `session` is read only to prefer roots. */
interface LiveAgentLike {
  model?: { current(): { provider: string; model: string } | undefined }
  /** Live session header. A subagent's header records its creator; a root has none. */
  session?: { meta?: { parentSession?: unknown } }
}
interface AgentsLike {
  get(id: SessionId): { status?: string; model?: { current(): { provider: string; model: string } | undefined }; followup(message: UserMessage): void } | undefined
  /** `AgentRegistry.list()` is the only enumeration DSH exposes; there is no `roots()`. */
  list(): LiveAgentLike[]
  create(options: {
    sessionId: SessionId
    agentOptions: { provider: string; model: string }
    meta?: { agentPreset?: string; cwd?: string }
  }): Promise<unknown>
}
interface PresetsLike {
  /** Deployment default, e.g. Explore when the mode bundle is installed. */
  readonly defaultId: string
  select(agent: unknown, agentPreset: string): Promise<string>
}
interface SessionsLike {
  list(): { id: SessionId; deriveMessages(): readonly { role: string; content: readonly { type: string; text?: string }[] }[] }[]
  get(id: SessionId): { deriveMessages(): readonly { role: string; content: readonly { type: string; text?: string }[] }[] } | undefined
}
/** The host trust fence (Host/Origin checks plus browser authentication). */
interface ConnectionLike {
  requestRejection(request: IncomingMessage): number | undefined
}

/** Write JSON once; a response whose socket is already gone is skipped. */
function json(res: ServerResponse, status: number, value: unknown): void {
  if (res.writableEnded) return
  const body = JSON.stringify(value)
  try {
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
    res.end(body)
  } catch {
    res.destroy()
  }
}

/** 405 carrying the route's one supported method. */
function methodNotAllowed(res: ServerResponse, allow: 'GET' | 'POST'): void {
  res.setHeader('allow', allow)
  json(res, 405, { error: `method not allowed; use ${allow}` })
}

interface BodyOk {
  readonly ok: true
  readonly value: Record<string, unknown>
}
interface BodyFailure {
  readonly ok: false
  readonly status: number
  readonly error: string
}
type BodyRead = BodyOk | BodyFailure

/**
 * Read one bounded JSON object. Resolves a status instead of throwing so a
 * client abort, an oversized body and a malformed body all end in a readable
 * response rather than a detached rejection.
 */
async function readBody(req: IncomingMessage): Promise<BodyRead> {
  const contentType = req.headers['content-type'] ?? ''
  if (contentType !== '' && !/^application\/json\s*(?:;|$)/iu.test(contentType)) {
    return { ok: false, status: 415, error: 'content-type must be application/json' }
  }
  req.setTimeout(BODY_TIMEOUT_MS, () => { req.destroy(new Error('graph-chat: request body timed out')) })
  try {
    const chunks: Buffer[] = []
    let size = 0
    let tooLarge = false
    // Draining past the ceiling (instead of breaking) keeps the refusal a
    // readable response rather than a socket cut, and bounds retained memory.
    for await (const chunk of req as AsyncIterable<Buffer>) {
      size += chunk.byteLength
      if (size > MAX_BODY_BYTES) {
        tooLarge = true
        continue
      }
      chunks.push(chunk)
    }
    if (tooLarge) return { ok: false, status: 413, error: `request body exceeds ${MAX_BODY_BYTES} bytes` }
    const text = Buffer.concat(chunks).toString('utf8')
    if (text.trim() === '') return { ok: true, value: {} }
    let parsed: unknown
    try {
      parsed = JSON.parse(text)
    } catch {
      return { ok: false, status: 400, error: 'request body must be valid JSON' }
    }
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      return { ok: false, status: 400, error: 'request body must be a JSON object' }
    }
    return { ok: true, value: parsed as Record<string, unknown> }
  } catch {
    // A client that aborts mid-body (ECONNRESET / aborted) lands here.
    return { ok: false, status: 400, error: 'request body could not be read' }
  } finally {
    req.setTimeout(0)
  }
}

/** Trimmed string at most `max` code units, else `''`. */
function boundedString(value: unknown, max: number): string {
  return typeof value === 'string' && value.length <= max ? value : ''
}

function textOf(message: { content: readonly { type: string; text?: string }[] }): string {
  return message.content.map(block => block.type === 'text' ? block.text ?? '' : `[${block.type}]`).join('').trim()
}

function service<T>(ctx: Context, key: string): T | undefined {
  return ctx.get(key) as T | undefined
}

/** Host-scoped graph-chat page and JSON API. */
export class GraphChat extends Service {
  static inject = ['webServer', 'sessions', 'agents']

  private readonly base: string
  private readonly fallback: { provider: string; model: string } | undefined
  private readonly preset: string | undefined
  private readonly cwd: string

  constructor(ctx: Context, config: Config = {}) {
    super(ctx, 'graphChat')
    this.base = config.path ?? '/graph-chat'
    this.fallback = config.provider !== undefined && config.model !== undefined
      ? { provider: config.provider, model: config.model }
      : undefined
    this.preset = config.preset
    this.cwd = config.cwd ?? process.cwd()
  }

  protected [Service.init](): void {
    const ctx = this.ctx
    const disposePage = ctx.webServer.register({
      kind: 'exact',
      path: this.base,
      handler: this.route('GET', (_req, res) => {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
        res.end(PAGE)
      }),
    })
    const disposeState = ctx.webServer.register({
      kind: 'exact',
      path: `${this.base}/api/state`,
      handler: this.route('GET', (req, res) => { this.state(req, res) }),
    })
    const disposeMessages = ctx.webServer.register({
      kind: 'exact',
      path: `${this.base}/api/messages`,
      handler: this.route('GET', (req, res) => { this.messages(req, res) }),
    })
    const disposeNew = ctx.webServer.register({
      kind: 'exact',
      path: `${this.base}/api/new`,
      handler: this.route('POST', (req, res) => this.newChat(req, res)),
    })
    const disposeSend = ctx.webServer.register({
      kind: 'exact',
      path: `${this.base}/api/send`,
      handler: this.route('POST', (req, res) => this.send(req, res)),
    })
    const disposeEvents = ctx.webServer.register({
      kind: 'exact',
      path: `${this.base}/api/events`,
      handler: this.route('GET', (req, res) => { this.events(req, res) }),
    })
    ctx.effect(() => () => { disposePage(); disposeState(); disposeMessages(); disposeNew(); disposeSend(); disposeEvents() }, 'graphChat.routes()')
  }

  /**
   * Wrap one handler with the trust fence, the method pin and a rejection sink.
   * The returned promise is what the web server awaits, so nothing is detached:
   * a failure answers 500 (or closes the response) and is logged.
   */
  private route(supported: 'GET' | 'POST', handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void>) {
    return (req: IncomingMessage, res: ServerResponse): void | Promise<void> => {
      if (this.rejected(req, res)) return
      const method = (req.method ?? 'GET').toUpperCase()
      const matched = method === supported || (supported === 'GET' && method === 'HEAD')
      if (!matched) {
        methodNotAllowed(res, supported)
        return
      }
      try {
        return Promise.resolve(handler(req, res)).catch((error: unknown) => { this.fail(req, res, error) })
      } catch (error: unknown) {
        this.fail(req, res, error)
        return
      }
    }
  }

  /** Apply the host's Host/Origin/authentication fence when it is mounted. */
  private rejected(req: IncomingMessage, res: ServerResponse): boolean {
    const connection = service<ConnectionLike>(this.ctx, 'connection')
    if (connection === undefined) return false
    const rejection = connection.requestRejection(req)
    if (rejection === undefined) return false
    try {
      res.writeHead(rejection)
      res.end()
    } catch {
      res.destroy()
    }
    return true
  }

  private fail(req: IncomingMessage, res: ServerResponse, error: unknown): void {
    this.ctx.logger?.warn?.(`graph-chat: ${req.method ?? 'GET'} ${req.url ?? ''} failed: ${error instanceof Error ? error.message : String(error)}`)
    if (res.headersSent) {
      if (!res.writableEnded) res.end()
      return
    }
    json(res, 500, { error: 'internal error' })
  }

  /**
   * Model route to inherit for a new session, read from the live registry.
   *
   * Root agents are preferred: a subagent's session header records its creator
   * (`parentSession`), so it is a poor default for a new top-level chat. When no
   * root carries a route, any live route still beats falling back to config.
   */
  private inheritedRoute(agents: AgentsLike): { provider: string; model: string } | undefined {
    const live = agents.list()
    const roots = live.filter(agent => agent.session?.meta?.parentSession === undefined)
    const firstRoute = (candidates: readonly LiveAgentLike[]) =>
      candidates.map(agent => agent.model?.current()).find(selection => selection !== undefined)
    return firstRoute(roots) ?? firstRoute(live)
  }

  private sessions(): SessionsLike | undefined {
    return service<SessionsLike>(this.ctx, 'sessions')
  }

  private agents(): AgentsLike | undefined {
    return service<AgentsLike>(this.ctx, 'agents')
  }

  private runtime(): RuntimeLike | undefined {
    return service<RuntimeLike>(this.ctx, 'graphRuntime')
  }

  private presets(): PresetsLike | undefined {
    return service<PresetsLike>(this.ctx, 'agentPresets')
  }

  private state(req: IncomingMessage, res: ServerResponse): void {
    const url = new URL(req.url ?? this.base, 'http://localhost')
    const sessions = this.sessions()
    const agents = this.agents()
    const runtime = this.runtime()
    const rows = (sessions?.list() ?? []).map(session => ({
      id: session.id,
      status: agents?.get(session.id)?.status ?? 'unknown',
      turns: runtime?.traceHistory(session.id) ?? [],
    }))
    const requested = url.searchParams.get('sessionId')
    const selected = requested ?? rows[0]?.id
    json(res, 200, {
      sessions: rows.map(row => ({ id: row.id, status: row.status, turnCount: row.turns.length })),
      sessionId: selected ?? null,
      turns: selected === undefined ? [] : (runtime?.traceHistory(selected) ?? []),
    })
  }

  private events(req: IncomingMessage, res: ServerResponse): void {
    const url = new URL(req.url ?? this.base, 'http://localhost')
    const sessionId = url.searchParams.get('sessionId')
    const runtime = this.runtime()
    if (sessionId === null || sessionId.length > MAX_ID_CHARS || runtime === undefined) {
      json(res, 404, { error: 'sessionId and graphRuntime are required' })
      return
    }
    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-store',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    })
    let closed = false
    let unsubscribe: (() => void) | undefined
    const heartbeat = setInterval(() => {
      if (closed || res.writableEnded) return
      try {
        res.write(': keepalive\n\n')
      } catch {
        close()
      }
    }, 15_000)
    const close = (): void => {
      if (closed) return
      closed = true
      clearInterval(heartbeat)
      try {
        unsubscribe?.()
      } catch {
        // A listener that throws on dispose must not fail the request teardown.
      }
      if (!res.writableEnded) res.end()
    }
    const send = (payload: { snapshot: unknown; turns: readonly unknown[] }): void => {
      if (closed || res.writableEnded) return
      try {
        res.write(`event: graph\ndata: ${JSON.stringify({ sessionId, ...payload })}\n\n`)
      } catch {
        close()
      }
    }
    try {
      unsubscribe = runtime.subscribe(sessionId, send)
    } catch (error: unknown) {
      json(res, 500, { error: 'graph runtime subscribe failed' })
      this.ctx.logger?.warn?.(`graph-chat: subscribe failed: ${error instanceof Error ? error.message : String(error)}`)
      close()
      return
    }
    req.on('close', close)
    req.on('error', close)
    res.on('error', close)
  }

  private messages(req: IncomingMessage, res: ServerResponse): void {
    const url = new URL(req.url ?? this.base, 'http://localhost')
    const sessionId = url.searchParams.get('sessionId')
    if (sessionId === null || sessionId.length > MAX_ID_CHARS) {
      json(res, 400, { error: 'sessionId is required' })
      return
    }
    const sessions = this.sessions()
    const session = sessions?.get(brandString<SessionId>(sessionId))
    if (session === undefined) {
      json(res, 404, { error: 'session not found' })
      return
    }
    json(res, 200, {
      messages: session.deriveMessages().map(message => ({ role: message.role, text: textOf(message) })).filter(message => message.text !== ''),
      status: this.agents()?.get(brandString<SessionId>(sessionId))?.status ?? 'unknown',
    })
  }

  private async newChat(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const agents = this.agents()
    if (agents === undefined) {
      json(res, 503, { error: 'agents service is not mounted' })
      return
    }
    const body = await readBody(req)
    if (!body.ok) {
      json(res, body.status, { error: body.error })
      return
    }
    const route = boundedString(body.value.provider, MAX_ID_CHARS) !== '' && boundedString(body.value.model, MAX_ID_CHARS) !== ''
      ? { provider: body.value.provider as string, model: body.value.model as string }
      : this.inheritedRoute(agents) ?? this.fallback
    if (route === undefined || route.provider === '' || route.model === '') {
      json(res, 409, { error: 'no live agent route to inherit; open a normal chat once, then retry' })
      return
    }
    const sessionId = brandString<SessionId>(`graph-chat-${randomUUID()}`)
    // No hardcoded preset: an explicit config value wins, otherwise the session
    // inherits the deployment default (Explore when the mode bundle is
    // installed, `standard` otherwise). DSH does not mount a preset for a root
    // agent by itself, so this must be selected before the first turn.
    const presets = this.presets()
    const presetId = this.preset ?? presets?.defaultId
    try {
      const handle = await agents.create({
        sessionId,
        agentOptions: route,
        meta: {
          ...(presetId === undefined ? {} : { agentPreset: presetId }),
          cwd: this.cwd,
        },
      }) as { agent?: unknown }
      if (presetId !== undefined && presets !== undefined && handle.agent !== undefined) {
        await presets.select(handle.agent, presetId)
      }
      json(res, 200, { sessionId })
    } catch (error) {
      this.ctx.logger?.warn?.(`graph-chat: create session failed: ${error instanceof Error ? error.message : String(error)}`)
      json(res, 500, { error: 'could not create a graph-chat session' })
    }
  }

  private async send(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const body = await readBody(req)
    if (!body.ok) {
      json(res, body.status, { error: body.error })
      return
    }
    const sessionId = boundedString(body.value.sessionId, MAX_ID_CHARS)
    const text = boundedString(body.value.text, MAX_TEXT_CHARS).trim()
    if (sessionId === '') {
      json(res, 400, { error: 'sessionId is required' })
      return
    }
    const agent = this.agents()?.get(brandString<SessionId>(sessionId))
    if (agent === undefined) {
      json(res, 404, { error: 'agent not found' })
      return
    }
    if (text === '') {
      json(res, 400, { error: 'text is required' })
      return
    }
    try {
      agent.followup(createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } }))
    } catch (error) {
      this.ctx.logger?.warn?.(`graph-chat: followup failed: ${error instanceof Error ? error.message : String(error)}`)
      json(res, 500, { error: 'could not enqueue the message' })
      return
    }
    json(res, 202, { ok: true })
  }
}

/**
 * Mount the page and API.
 * @param ctx - host context.
 * @param config - optional page path.
 */
export function apply(ctx: Context, config: Config = {}): void {
  ctx.plugin(GraphChat, config)
}
