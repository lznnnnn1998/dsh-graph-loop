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
 */
import { readFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { Service, type Context } from '@deepseek-ai/cordis'
import { brandString } from '@deepseek-ai/dsh-brand'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { SessionId, UserMessage } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-host-webserver'
import type { TaskPlan } from '@dsh/explore-core/graph-schema'

export interface Config {
  /** Exact page path. Default `/graph-chat`. */
  path?: string
  /** Fallback route for `New graph chat` when no live agent exists yet. */
  provider?: string
  model?: string
  /** Agent preset recorded on the new session (tools/persona composition). */
  preset?: string
}

export const name = 'explore-graph-chat'

export const inject = ['webServer', 'sessions', 'agents']

const PAGE = (() => {
  try {
    return readFileSync(new URL('../assets/graph-chat.html', import.meta.url), 'utf8')
  } catch {
    return '<!doctype html><h1>graph-chat asset missing</h1>'
  }
})()

interface RuntimeLike {
  traceHistory(sessionId: string): readonly unknown[]
  last(sessionId: string): unknown
}
interface AgentsLike {
  get(id: SessionId): { status?: string; model?: { current(): { provider: string; model: string } | undefined }; followup(message: UserMessage): void } | undefined
  roots(): { model?: { current(): { provider: string; model: string } | undefined } }[]
  create(options: { sessionId: SessionId; agentOptions: { provider: string; model: string }; meta?: { agentPreset?: string } }): Promise<unknown>
}
interface PresetsLike {
  select(agent: unknown, agentPreset: string): Promise<string>
}
interface SessionsLike {
  list(): { id: SessionId; deriveMessages(): readonly { role: string; content: readonly { type: string; text?: string }[] }[] }[]
  get(id: SessionId): { deriveMessages(): readonly { role: string; content: readonly { type: string; text?: string }[] }[] } | undefined
}

function json(res: ServerResponse, status: number, value: unknown): void {
  const body = JSON.stringify(value)
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  res.end(body)
}

async function readBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = []
  for await (const chunk of req) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>
  } catch {
    return {}
  }
}

function textOf(message: { content: readonly { type: string; text?: string }[] }): string {
  return message.content.map(block => block.type === 'text' ? block.text ?? '' : `[${block.type}]`).join('').trim()
}

function service<T>(ctx: Context, key: string): T | undefined {
  return (ctx as unknown as { get(name: string): unknown }).get(key) as T | undefined
}

/** Host-scoped graph-chat page and JSON API. */
export class GraphChat extends Service {
  private readonly base: string
  private readonly fallback: { provider: string; model: string } | undefined
  private readonly preset: string | undefined

  constructor(ctx: Context, config: Config = {}) {
    super(ctx, 'graphChat')
    this.base = config.path ?? '/graph-chat'
    this.fallback = config.provider !== undefined && config.model !== undefined
      ? { provider: config.provider, model: config.model }
      : undefined
    this.preset = config.preset
  }

  protected [Service.init](): void {
    const ctx = this.ctx
    const disposePage = ctx.webServer.register({
      kind: 'exact',
      path: this.base,
      handler: (_req, res) => {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
        res.end(PAGE)
      },
    })
    const disposeState = ctx.webServer.register({
      kind: 'exact',
      path: `${this.base}/api/state`,
      handler: (req, res) => { this.state(req, res) },
    })
    const disposeMessages = ctx.webServer.register({
      kind: 'exact',
      path: `${this.base}/api/messages`,
      handler: (req, res) => { this.messages(req, res) },
    })
    const disposeNew = ctx.webServer.register({
      kind: 'exact',
      path: `${this.base}/api/new`,
      handler: (req, res) => { void this.newChat(req, res) },
    })
    const disposeSend = ctx.webServer.register({
      kind: 'exact',
      path: `${this.base}/api/send`,
      handler: (req, res) => { void this.send(req, res) },
    })
    ctx.effect(() => () => { disposePage(); disposeState(); disposeMessages(); disposeNew(); disposeSend() }, 'graphChat.routes()')
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

  private messages(req: IncomingMessage, res: ServerResponse): void {
    const url = new URL(req.url ?? this.base, 'http://localhost')
    const sessionId = url.searchParams.get('sessionId')
    const sessions = this.sessions()
    const session = sessionId === null ? undefined : sessions?.get(brandString<SessionId>(sessionId))
    if (session === undefined) {
      json(res, 404, { error: 'session not found' })
      return
    }
    json(res, 200, {
      messages: session.deriveMessages().map(message => ({ role: message.role, text: textOf(message) })).filter(message => message.text !== ''),
      status: this.agents()?.get(brandString<SessionId>(sessionId as string))?.status ?? 'unknown',
    })
  }

  private async newChat(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const agents = this.agents()
    if (agents === undefined) {
      json(res, 503, { error: 'agents service is not mounted' })
      return
    }
    const body = await readBody(req)
    const route = typeof body.provider === 'string' && typeof body.model === 'string'
      ? { provider: body.provider, model: body.model }
      : agents.roots().map(root => root.model?.current()).find(selection => selection !== undefined) ?? this.fallback
    if (route === undefined || route.provider === '' || route.model === '') {
      json(res, 409, { error: 'no live agent route to inherit; open a normal chat once, then retry' })
      return
    }
    const sessionId = brandString<SessionId>(`graph-chat-${randomUUID()}`)
    try {
      const handle = await agents.create({
        sessionId,
        agentOptions: route,
        ...(this.preset === undefined ? {} : { meta: { agentPreset: this.preset } }),
      }) as { agent?: unknown }
      if (this.preset !== undefined && handle.agent !== undefined) {
        const presets = this.presets()
        if (presets !== undefined) await presets.select(handle.agent, this.preset)
      }
      json(res, 200, { sessionId })
    } catch (error) {
      json(res, 500, { error: String(error) })
    }
  }

  private async send(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const body = await readBody(req)
    const sessionId = typeof body.sessionId === 'string' ? body.sessionId : ''
    const text = typeof body.text === 'string' ? body.text.trim() : ''
    const agent = this.agents()?.get(brandString<SessionId>(sessionId))
    if (agent === undefined) {
      json(res, 404, { error: 'agent not found' })
      return
    }
    if (text === '') {
      json(res, 400, { error: 'text is required' })
      return
    }
    agent.followup(createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } }))
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
