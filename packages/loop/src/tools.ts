/**
 * Model-facing graph status tool (cheap, read-only).
 *
 * Registered by the driver bundle as a host row. It reports the last route and
 * the current graph snapshot; it never mutates the run. Set `enableTool: false`
 * in the row config to hide it from the model.
 */
import type { Context } from '@deepseek-ai/cordis'
import type { JsonSchemaNode, ToolDefinition } from '@deepseek-ai/dsh-tools'

export interface Config {
  enableTool?: boolean
}

export const name = 'explore-tools'

export const inject = ['tools']

const STATUS_SCHEMA: JsonSchemaNode = {
  type: 'object',
  properties: {
    mode: { type: 'string' },
    graphTools: { type: 'number' },
    graphDigest: { type: 'string' },
    warnings: { type: 'array', items: { type: 'string' } },
    templates: { type: 'array', items: { type: 'string' } },
    note: { type: 'string' },
  },
  required: ['mode', 'graphTools', 'graphDigest'],
  additionalProperties: false,
}

function buildTool(ctx: Context): ToolDefinition {
  return {
    name: 'graph_status',
    description: 'Report the capability graph summary used by the explore loop (read-only, cheap).',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    output: {
      schema: STATUS_SCHEMA,
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
    },
    execute: (): Promise<Record<string, unknown>> => {
      const registry = (ctx as unknown as { get(name: string): unknown }).get('graphRegistry') as
        { snapshot(): { graph: { digest: string; nodes: unknown[]; warnings: readonly string[] } } } | undefined
      const router = (ctx as unknown as { get(name: string): unknown }).get('graphRouter') as
        { templates(): { templates: { id: string }[] } } | undefined
      if (registry === undefined) {
        return Promise.resolve({ mode: 'unavailable', graphTools: 0, graphDigest: 'none', note: 'graphRegistry is not mounted' })
      }
      const snapshot = registry.snapshot()
      return Promise.resolve({
        mode: 'explore',
        graphTools: snapshot.graph.nodes.length,
        graphDigest: snapshot.graph.digest,
        warnings: [...snapshot.graph.warnings],
        templates: (router?.templates().templates ?? []).map(template => template.id),
      })
    },
  }
}

/**
 * Register the tool when enabled.
 * @param ctx - host context.
 * @param config - row config.
 */
export function apply(ctx: Context, config: Config = {}): void {
  if (config.enableTool === false) return
  ctx.tools.register(buildTool(ctx))
}
