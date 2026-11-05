/**
 * Graph router plugin row: owns the template library and the deterministic match.
 *
 * The templates live in `dsh-graph-loop-core/templates`; this row only exposes them
 * to the driver and the `graph_status` tool.
 */
import { Service, type Context } from '@deepseek-ai/cordis'
import { TEMPLATE_LIBRARY, templateById, FALLBACK_TEMPLATE_ID } from 'dsh-graph-loop-core/templates'
import type { TemplateLibrary } from 'dsh-graph-loop-core/matching'

export { TEMPLATE_LIBRARY, templateById, FALLBACK_TEMPLATE_ID }

type GraphRouterService = {
  templates(): TemplateLibrary
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    graphRouter: GraphRouterService
  }
}

/** Host-scoped template service. */
export class GraphRouter extends Service implements GraphRouterService {
  constructor(ctx: Context) {
    super(ctx, 'graphRouter')
  }

  templates(): TemplateLibrary {
    return TEMPLATE_LIBRARY
  }
}

export const name = 'explore-router'

/**
 * Mount the router service.
 * @param ctx - host context.
 */
export function apply(ctx: Context): void {
  ctx.plugin(GraphRouter)
}
