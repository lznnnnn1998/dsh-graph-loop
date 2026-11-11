/**
 * Route-level tests for `/graph-chat`.
 *
 * These cover the failure modes that used to take down the whole Web host: a
 * client that aborts mid-body, an oversized or mistyped body, a wrong method,
 * and a request the host trust fence rejects. They also pin the happy paths
 * (send, new session, page, SSE) so the guards cannot silently break the API.
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { Readable } from 'node:stream'
import type { IncomingMessage, ServerResponse } from 'node:http'

import { Context } from '@deepseek-ai/cordis'
import { GraphChat } from '../../packages/graph-ui/src/graph-chat.ts'

type Handler = (req: IncomingMessage, res: ServerResponse) => void | Promise<void>

interface HarnessOptions {
  readonly sessions?: unknown
  readonly agents?: unknown
  readonly runtime?: unknown
  readonly connection?: unknown
  readonly presets?: unknown
}

interface Harness {
  readonly ctx: Context
  readonly routes: Map<string, Handler>
}

async function harness(options: HarnessOptions = {}): Promise<Harness> {
  const ctx = new Context()
  const routes = new Map<string, Handler>()
  ctx.provide('webServer', {
    register(route: { path: string; handler: Handler }) {
      routes.set(route.path, route.handler)
      return () => { routes.delete(route.path) }
    },
  })
  ctx.provide('sessions', options.sessions ?? { list: () => [], get: () => undefined })
  ctx.provide('agents', options.agents ?? { get: () => undefined, list: () => [], create: async () => ({}) })
  if (options.presets !== undefined) ctx.provide('agentPresets', options.presets)
  if (options.runtime !== undefined) ctx.provide('graphRuntime', options.runtime)
  if (options.connection !== undefined) ctx.provide('connection', options.connection)
  await ctx.plugin(GraphChat)
  return { ctx, routes }
}

interface FakeResponse extends ServerResponse {
  statusCode: number
  body: string
  headers: Record<string, unknown>
  writableEnded: boolean
  headersSent: boolean
}

function response(): FakeResponse {
  const res = {
    statusCode: 0,
    body: '',
    headers: {} as Record<string, unknown>,
    writableEnded: false,
    headersSent: false,
    writeHead(status: number, headers: Record<string, unknown> = {}) {
      res.statusCode = status
      res.headersSent = true
      Object.assign(res.headers, headers)
      return res
    },
    setHeader(name: string, value: unknown) {
      res.headers[name.toLowerCase()] = value
    },
    write(chunk: unknown) {
      res.body += String(chunk)
      return true
    },
    end(chunk?: unknown) {
      if (chunk !== undefined) res.body += String(chunk)
      res.writableEnded = true
    },
    destroy() {
      res.writableEnded = true
    },
    on() {
      return res
    },
  }
  return res as unknown as FakeResponse
}

function request(
  method: string,
  url: string,
  body?: string | Buffer,
  headers: Record<string, string> = {},
): IncomingMessage {
  const stream = Readable.from(body === undefined ? [] : [Buffer.isBuffer(body) ? body : Buffer.from(body)])
  const req = stream as unknown as IncomingMessage & { setTimeout: unknown }
  req.method = method
  req.url = url
  req.headers = { 'content-type': 'application/json', ...headers }
  // `IncomingMessage.setTimeout` delegates to the socket; the readable stand-in
  // just needs a no-op so the handler's upload guard stays exercisable.
  req.setTimeout = () => req
  return req
}

/** A request whose body stream fails mid-upload, like a client that aborts. */
function abortingRequest(): IncomingMessage {
  const stream = new Readable({ read() {} })
  const req = stream as unknown as IncomingMessage & { setTimeout: unknown }
  req.method = 'POST'
  req.url = '/graph-chat/api/send'
  req.headers = { 'content-type': 'application/json' }
  req.setTimeout = () => req
  setImmediate(() => {
    stream.push('{"sessionId":"s1","text":"hello')
    stream.destroy(Object.assign(new Error('client dropped mid-body'), { code: 'ECONNRESET' }))
  })
  return req
}

async function call(route: Handler, req: IncomingMessage, res: FakeResponse): Promise<void> {
  await route(req, res)
}

test('an aborted upload answers 400 instead of rejecting the handler', async () => {
  const { routes } = await harness()
  const route = routes.get('/graph-chat/api/send')
  assert.ok(route !== undefined)
  const res = response()
  const pending = route(abortingRequest(), res as unknown as ServerResponse)
  assert.ok(pending instanceof Promise, 'the route must return its promise to the web server, not detach it')
  await pending
  assert.equal(res.statusCode, 400)
  assert.match(res.body, /could not be read/u)
})

test('an oversized body is refused with 413 after draining', async () => {
  const { routes } = await harness()
  const route = routes.get('/graph-chat/api/send')
  assert.ok(route !== undefined)
  const res = response()
  await call(route, request('POST', '/graph-chat/api/send', Buffer.alloc(70 * 1024, 0x61)), res)
  assert.equal(res.statusCode, 413)
})

test('a non-JSON content type is refused with 415', async () => {
  const { routes } = await harness()
  const route = routes.get('/graph-chat/api/send')
  assert.ok(route !== undefined)
  const res = response()
  await call(route, request('POST', '/graph-chat/api/send', '{}', { 'content-type': 'text/plain' }), res)
  assert.equal(res.statusCode, 415)
})

test('a wrong method is refused with 405 and an allow header', async () => {
  const { routes } = await harness()
  const route = routes.get('/graph-chat/api/new')
  assert.ok(route !== undefined)
  const res = response()
  await call(route, request('GET', '/graph-chat/api/new'), res)
  assert.equal(res.statusCode, 405)
  assert.equal(res.headers.allow, 'POST')
})

test('the trust fence rejects before any handler side effect', async () => {
  let created = 0
  const { routes } = await harness({
    connection: { requestRejection: () => 403 },
    agents: {
      get: () => undefined,
      list: () => [],
      create: async () => { created += 1; return {} },
    },
  })
  const route = routes.get('/graph-chat/api/new')
  assert.ok(route !== undefined)
  const res = response()
  await call(route, request('POST', '/graph-chat/api/new', '{}', { host: 'evil.example' }), res)
  assert.equal(res.statusCode, 403)
  assert.equal(created, 0)
})

test('send enqueues the message and answers 202', async () => {
  const seen: { text: string }[] = []
  const { routes } = await harness({
    agents: {
      get: () => ({
        status: 'running',
        followup: (message: { content: { text?: string }[] }) => { seen.push({ text: message.content[0]?.text ?? '' }) },
      }),
      list: () => [],
      create: async () => ({}),
    },
  })
  const route = routes.get('/graph-chat/api/send')
  assert.ok(route !== undefined)
  const res = response()
  await call(route, request('POST', '/graph-chat/api/send', JSON.stringify({ sessionId: 's1', text: '  hello  ' })), res)
  assert.equal(res.statusCode, 202)
  assert.deepEqual(seen, [{ text: 'hello' }])
})

test('new chat inherits the deployment default preset and records cwd', async () => {
  const created: unknown[] = []
  const selected: string[] = []
  const { routes } = await harness({
    agents: {
      get: () => undefined,
      list: () => [{ session: { meta: {} }, model: { current: () => ({ provider: 'p', model: 'm' }) } }],
      create: async (options: unknown) => { created.push(options); return { agent: {} } },
    },
    presets: {
      defaultId: 'explore',
      select: async (_agent: unknown, id: string) => { selected.push(id); return id },
    },
  })
  const route = routes.get('/graph-chat/api/new')
  assert.ok(route !== undefined)
  const res = response()
  await call(route, request('POST', '/graph-chat/api/new', '{}'), res)
  assert.equal(res.statusCode, 200)
  const options = created[0] as { meta: { cwd: string; agentPreset?: string } }
  assert.equal(options.meta.cwd, process.cwd())
  // No hardcoded `standard`: the registry default is inherited and mounted.
  assert.equal(options.meta.agentPreset, 'explore')
  assert.deepEqual(selected, ['explore'])
})

test('new chat inherits a live root route through AgentRegistry.list(), not roots()', async () => {
  const created: unknown[] = []
  // A subagent (its session records a parent) sorts before the root; the new
  // top-level chat must inherit the root's route, and `list()` is the only
  // enumeration the current registry exposes — a `roots()` call throws here.
  const { routes } = await harness({
    agents: {
      get: () => undefined,
      list: () => [
        { session: { meta: { parentSession: 'parent-1' } }, model: { current: () => ({ provider: 'child-provider', model: 'child-model' }) } },
        { session: { meta: {} }, model: { current: () => ({ provider: 'root-provider', model: 'root-model' }) } },
      ],
      create: async (options: unknown) => { created.push(options); return {} },
    },
  })
  const route = routes.get('/graph-chat/api/new')
  assert.ok(route !== undefined)
  const res = response()
  await call(route, request('POST', '/graph-chat/api/new', '{}'), res)
  assert.equal(res.statusCode, 200)
  const options = created[0] as { agentOptions: { provider: string; model: string } }
  assert.deepEqual(options.agentOptions, { provider: 'root-provider', model: 'root-model' })
})

test('new chat answers 409 when no live agent carries a model route', async () => {
  let created = 0
  const { routes } = await harness({
    agents: {
      get: () => undefined,
      list: () => [{ session: { meta: {} } }],
      create: async () => { created += 1; return {} },
    },
  })
  const route = routes.get('/graph-chat/api/new')
  assert.ok(route !== undefined)
  const res = response()
  await call(route, request('POST', '/graph-chat/api/new', '{}'), res)
  assert.equal(res.statusCode, 409)
  assert.match(res.body, /no live agent route to inherit/u)
  assert.equal(created, 0, 'no session is created without a route')
})

test('the page is served as HTML', async () => {
  const { routes } = await harness()
  const route = routes.get('/graph-chat')
  assert.ok(route !== undefined)
  const res = response()
  await call(route, request('GET', '/graph-chat'), res)
  assert.equal(res.statusCode, 200)
  assert.match(String(res.headers['content-type']), /text\/html/u)
  assert.match(res.body, /Graph Chat/u)
})

test('SSE streams one graph event and unsubscribes on close', async () => {
  let listener: ((payload: unknown) => void) | undefined
  let unsubscribed = 0
  const { routes } = await harness({
    runtime: {
      traceHistory: () => [],
      last: () => undefined,
      subscribe: (_id: string, next: (payload: unknown) => void) => {
        listener = next
        return () => { unsubscribed += 1 }
      },
    },
  })
  const route = routes.get('/graph-chat/api/events')
  assert.ok(route !== undefined)
  const req = request('GET', '/graph-chat/api/events?sessionId=s1')
  const res = response()
  await call(route, req, res)
  assert.equal(res.statusCode, 200)
  listener?.({ snapshot: { planId: 'p' }, turns: [] })
  assert.match(res.body, /event: graph/u)
  assert.match(res.body, /"sessionId":"s1"/u)
  ;(req as unknown as Readable).emit('close')
  assert.equal(unsubscribed, 1)
})
