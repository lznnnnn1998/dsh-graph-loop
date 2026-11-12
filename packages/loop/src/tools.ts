/**
 * Model-facing graph tools (all cheap, read-only or plan-only).
 *
 * `graph_plan` is the creative seam: the model submits an arbitrary node/edge
 * topology; the harness validates it against the live capability graph and the
 * driver adopts it at the next step boundary. `graph_status` reports the run.
 * `graph_answer` is the typed answer channel: the terminal step's answer is the
 * `text` argument of one executed call, never its free assistant text.
 */
import type { Context } from '@deepseek-ai/cordis'
import { buildRegistrySnapshot } from 'dsh-graph-loop-core/registry'
import type { JsonSchemaNode, ToolDefinition } from '@deepseek-ai/dsh-tools'
import { GRAPH_PROPOSAL_SCHEMA, validateProposal } from 'dsh-graph-loop-core/proposal'
import type { RegistryGraph } from 'dsh-graph-loop-core/graph-schema'
import { ANSWER_TOOL } from './answer-channel.ts'

export interface Config {
  enableTools?: boolean
}

export const name = 'explore-tools'

export const inject = ['tools']

/** Structural view of the services this row consumes. */
interface RegistryLike { snapshot(): { graph: RegistryGraph; digest: string; warnings: readonly string[] } }
interface RouterLike { templates(): { templates: { id: string }[] } }
interface RuntimeLike {
  setProposal(sessionId: string, plan: import('dsh-graph-loop-core/graph-schema').TaskPlan): void
  last(sessionId: string): { mode: string; node: string | undefined; step: number; planId: string; rationale: readonly string[] } | undefined
}

function service<T>(ctx: Context, key: string): T | undefined {
  return ctx.get(key) as T | undefined
}

function toolSchemas(graph: RegistryGraph): string[] {
  return [...new Set(graph.nodes.filter(node => node.tool).map(node => node.tool!.name))].sort()
}

const STATUS_SCHEMA: JsonSchemaNode = {
  type: 'object',
  properties: {
    mode: { type: 'string' },
    graphTools: { type: 'number' },
    graphDigest: { type: 'string' },
    warnings: { type: 'array', items: { type: 'string' } },
    templates: { type: 'array', items: { type: 'string' } },
    lastRun: { type: 'object' },
    note: { type: 'string' },
  },
  required: ['mode', 'graphTools', 'graphDigest'],
  additionalProperties: false,
}

const PLAN_SCHEMA: JsonSchemaNode = {
  type: 'object',
  properties: {
    ok: { type: 'boolean' },
    planId: { type: 'string' },
    entry: { type: 'string' },
    nodes: { type: 'number' },
    edges: { type: 'number' },
    terminals: { type: 'array', items: { type: 'string' } },
    errors: { type: 'array', items: { type: 'string' } },
    warnings: { type: 'array', items: { type: 'string' } },
  },
  required: ['ok'],
  additionalProperties: false,
}

/** The typed answer channel's arguments: the answer text and nothing else. */
const ANSWER_PARAMS: JsonSchemaNode = {
  type: 'object',
  properties: {
    text: { type: 'string', description: 'The answer text for this turn.' },
  },
  required: ['text'],
  additionalProperties: false,
}

const ANSWER_RESULT_SCHEMA: JsonSchemaNode = {
  type: 'object',
  properties: {
    ok: { type: 'boolean' },
    text: { type: 'string' },
  },
  required: ['ok'],
  additionalProperties: false,
}

function registryOf(ctx: Context): RegistryLike | undefined {
  return service<RegistryLike>(ctx, 'graphRegistry')
}

function buildStatus(ctx: Context): ToolDefinition {
  return {
    name: 'graph_status',
    description: 'Report the capability graph and the last graph run for this session (read-only, cheap).',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    output: {
      schema: STATUS_SCHEMA,
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
    },
    execute: (_args: unknown, exec): Promise<Record<string, unknown>> => {
      const registry = registryOf(ctx)
      const router = service<RouterLike>(ctx, 'graphRouter')
      // Prefer the calling agent's scoped tool view; the host view can be empty
      // when every tool lives in a preset/agent scope.
      const agent = exec.agent
      const scoped = agent === undefined ? undefined : ctx.tools.definitions(agent)
      if (scoped !== undefined && scoped.length > 0) {
        const snapshot = buildRegistrySnapshot({
          tools: scoped.map(definition => ({
            name: definition.name,
            description: definition.description,
            parameters: definition.parameters as Readonly<Record<string, unknown>>,
          })),
        })
        // The scoped branch must still report the last run for this session;
        // `last('')` in the host branch can never match a real session id.
        const runtime = service<RuntimeLike>(ctx, 'graphRuntime')
        const sessionId = (agent as { readonly session?: { readonly id?: string } } | undefined)?.session?.id
        const run = sessionId === undefined ? undefined : runtime?.last(sessionId)
        return Promise.resolve({
          mode: 'explore',
          graphTools: snapshot.graph.nodes.length,
          graphDigest: snapshot.digest,
          warnings: snapshot.warnings,
          templates: (router?.templates().templates ?? []).map(template => template.id),
          ...(run === undefined ? {} : { lastRun: run }),
        })
      }
      if (registry === undefined) {
        return Promise.resolve({ mode: 'unavailable', graphTools: 0, graphDigest: 'none', note: 'graphRegistry is not mounted' })
      }
      const snapshot = registry.snapshot()
      // The agent is optional at this layer; the graph service records per session.
      const runtime = service<RuntimeLike>(ctx, 'graphRuntime')
      const run = runtime?.last('') ?? undefined
      return Promise.resolve({
        mode: 'explore',
        graphTools: snapshot.graph.nodes.length,
        graphDigest: snapshot.digest,
        warnings: [...snapshot.warnings],
        templates: (router?.templates().templates ?? []).map(template => template.id),
        ...(run === undefined ? {} : { lastRun: run }),
      })
    },
  }
}

function buildPlanTool(ctx: Context): ToolDefinition {
  return {
    name: 'graph_plan',
    description:
      'Replace the remaining run topology with a node/edge graph over the available capabilities. '
      + 'Call it once the task shape is clear; the harness validates the graph and adopts it at the next step. '
      + 'Nodes are tool calls, agent steps or a terminal answer; edges may branch or loop (bounded by the step budget).',
    parameters: GRAPH_PROPOSAL_SCHEMA as Record<string, unknown>,
    output: {
      schema: PLAN_SCHEMA,
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
    },
    execute: (args: unknown, exec): Promise<Record<string, unknown>> => {
      const registry = registryOf(ctx)
      const runtime = service<RuntimeLike>(ctx, 'graphRuntime')
      const sessionId = exec.agent?.session.id
      // Validate against the graph this agent will actually execute against.
      // Preset/agent-scoped tools are registered inside the agent's scope, so the
      // host registry can be empty or a superset; either way the proposal and the
      // driver would disagree about which tools exist.
      const scoped = exec.agent === undefined ? undefined : ctx.tools.definitions(exec.agent)
      const snapshot = scoped !== undefined && scoped.length > 0
        ? buildRegistrySnapshot({
          tools: scoped.map(definition => ({
            name: definition.name,
            description: definition.description,
            parameters: definition.parameters as Readonly<Record<string, unknown>>,
          })),
        })
        : registry?.snapshot()
      if (snapshot === undefined || runtime === undefined || sessionId === undefined) {
        return Promise.resolve({ ok: false, errors: ['graph runtime is not mounted for this agent'] })
      }
      const agentLoop = ctx.get('agentLoop') as { readonly config?: { readonly maxSteps?: number } } | undefined
      const result = validateProposal(args, snapshot.graph, toolSchemas(snapshot.graph), {
        maxNodes: 12,
        // Clamp to the driver's configured cap, not a hardcoded 24: a proposal
        // adopted into a smaller turn must not claim a larger budget.
        maxSteps: agentLoop?.config?.maxSteps ?? 24,
      })
      if (!result.ok || result.plan === undefined) {
        return Promise.resolve({ ok: false, errors: [...result.errors], warnings: [...result.warnings] })
      }
      runtime.setProposal(sessionId, result.plan)
      return Promise.resolve({
        ok: true,
        planId: result.plan.id,
        entry: result.plan.entry,
        nodes: result.plan.nodes.length,
        edges: result.plan.edges.length,
        terminals: [...result.plan.terminals],
        warnings: [...result.warnings],
      })
    },
  }
}

/**
 * The typed answer channel. The terminal answer step is admitted exactly this
 * tool; the driver reads the record from the executed call's `text` argument,
 * so a printed tool call in assistant text can never be an answer.
 */
function buildAnswerTool(): ToolDefinition {
  return {
    name: ANSWER_TOOL,
    description:
      'Submit the turn\'s final answer text. At the answer step, call this tool with the answer; '
      + 'it is the only admissible answer channel. Printed tool-call, DSML or XML syntax is not an answer.',
    parameters: ANSWER_PARAMS as Record<string, unknown>,
    output: {
      schema: ANSWER_RESULT_SCHEMA,
      render: (_args, value) => {
        const text = typeof value === 'object' && value !== null ? (value as { text?: unknown }).text : undefined
        return [{ type: 'text', text: typeof text === 'string' ? text : 'answer recorded' }]
      },
    },
    execute: (args: unknown): Promise<Record<string, unknown>> => {
      const text = typeof args === 'object' && args !== null ? (args as { text?: unknown }).text : undefined
      return Promise.resolve(typeof text === 'string' ? { ok: true, text } : { ok: true })
    },
  }
}

/**
 * Register the tools when enabled.
 * @param ctx - host context.
 * @param config - row config.
 */
export function apply(ctx: Context, config: Config = {}): void {
  if (config.enableTools === false) return
  ctx.tools.register(buildStatus(ctx))
  ctx.tools.register(buildPlanTool(ctx))
  ctx.tools.register(buildAnswerTool())
}
