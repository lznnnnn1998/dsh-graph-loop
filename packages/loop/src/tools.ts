/**
 * Model-facing graph tools (all cheap, read-only or plan-only).
 *
 * `graph_plan` is the creative seam: the model submits an arbitrary node/edge
 * topology; the harness validates it against the live capability graph and the
 * driver adopts it at the next step boundary. `graph_status` reports the run.
 */
import type { Context } from '@deepseek-ai/cordis'
import type { JsonSchemaNode, ToolDefinition } from '@deepseek-ai/dsh-tools'
import { GRAPH_PROPOSAL_SCHEMA, validateProposal } from '@dsh/explore-core/proposal'
import type { RegistryGraph } from '@dsh/explore-core/graph-schema'

export interface Config {
  enableTools?: boolean
}

export const name = 'explore-tools'

export const inject = ['tools']

/** Structural view of the services this row consumes. */
interface RegistryLike { snapshot(): { graph: RegistryGraph; digest: string; warnings: readonly string[] } }
interface RouterLike { templates(): { templates: { id: string }[] } }
interface RuntimeLike {
  setProposal(sessionId: string, plan: import('@dsh/explore-core/graph-schema').TaskPlan): void
  last(sessionId: string): { mode: string; node: string | undefined; step: number; planId: string; rationale: readonly string[] } | undefined
}

function service<T>(ctx: Context, key: string): T | undefined {
  return (ctx as unknown as { get(name: string): unknown }).get(key) as T | undefined
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
      const scoped = agent === undefined
        ? undefined
        : (ctx as unknown as { tools: { definitions(scope?: object): readonly { name: string }[] } }).tools
          .definitions(agent as unknown as object)
      if (scoped !== undefined && scoped.length > 0) {
        return Promise.resolve({
          mode: 'explore',
          graphTools: scoped.length,
          graphDigest: 'agent-scoped',
          warnings: ['digest unavailable for the agent-scoped view'],
          templates: (router?.templates().templates ?? []).map(template => template.id),
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
    parameters: GRAPH_PROPOSAL_SCHEMA as unknown as Record<string, unknown>,
    output: {
      schema: PLAN_SCHEMA,
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
    },
    execute: (args: unknown, exec): Promise<Record<string, unknown>> => {
      const registry = registryOf(ctx)
      const runtime = service<RuntimeLike>(ctx, 'graphRuntime')
      const sessionId = exec.agent?.session.id
      if (registry === undefined || runtime === undefined || sessionId === undefined) {
        return Promise.resolve({ ok: false, errors: ['graph runtime is not mounted for this agent'] })
      }
      const snapshot = registry.snapshot()
      const result = validateProposal(args, snapshot.graph, toolSchemas(snapshot.graph), { maxNodes: 12, maxSteps: 24 })
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
 * Register the tools when enabled.
 * @param ctx - host context.
 * @param config - row config.
 */
export function apply(ctx: Context, config: Config = {}): void {
  if (config.enableTools === false) return
  ctx.tools.register(buildStatus(ctx))
  ctx.tools.register(buildPlanTool(ctx))
}
