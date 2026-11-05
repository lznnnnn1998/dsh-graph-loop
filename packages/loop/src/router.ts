/**
 * Graph router plugin row: owns the template library and the deterministic match.
 *
 * The templates are deliberately small and curated from REAL DSH tool names
 * (docs/tool-catalog.md). The same library is used by the preset (as a path
 * description) and by the driver (as the executable plan shape).
 */
import { Service, type Context } from '@deepseek-ai/cordis'
import type { TaskTemplate, TemplateLibrary } from '@dsh/explore-core/matching'
import type { PlanEdge, PlanNode } from '@dsh/explore-core/graph-schema'

const BUDGET = { maxNodes: 8, maxSteps: 12, maxTokens: 250_000, maxWallMs: 900_000, maxReplans: 2 }

const terminal: PlanNode = {
  id: 'n_done',
  kind: 'terminal',
  executor: 'step',
  instruction: 'Summarize what was done, the evidence, and any remaining risk. Do not repeat the full plan.',
  toolAllow: [],
}

const investigate: TaskTemplate = {
  id: 't_investigate',
  label: 'Locate and explain code',
  appliesTo: { intent: ['code-question', 'code-review', 'fact-finding', 'other'] },
  toolUniverse: ['glob', 'grep', 'read'],
  risk: 0.1,
  gatePolicy: 'cold',
  slots: {
    discover: { choose: ['glob', 'grep'], scoreBy: 'artifactMatch' },
    read: { choose: ['read'], scoreBy: 'artifactMatch' },
  },
  budget: BUDGET,
  fixedEdges: [
    { from: 'n_discover', to: 'n_read', kind: 'control' },
    { from: 'n_read', to: 'n_done', kind: 'control' },
  ] as PlanEdge[],
}

const editTest: TaskTemplate = {
  id: 't_edit_test',
  label: 'Change code and verify with tests',
  appliesTo: { intent: ['code-change', 'bug-fix', 'test-failure'], mutating: true },
  toolUniverse: ['read', 'grep', 'edit', 'write', 'bash'],
  risk: 0.5,
  gatePolicy: 'cold',
  slots: {
    inspect: { choose: ['read', 'grep'], scoreBy: 'artifactMatch' },
    edit: { choose: ['edit', 'write'], scoreBy: 'artifactMatch' },
    verify: { choose: ['bash'], scoreBy: 'artifactMatch' },
  },
  budget: BUDGET,
  fixedEdges: [
    { from: 'n_edit', to: 'n_inspect', kind: 'control' },
    { from: 'n_inspect', to: 'n_verify', kind: 'control' },
    { from: 'n_verify', to: 'n_done', kind: 'control' },
  ] as PlanEdge[],
}

const research: TaskTemplate = {
  id: 't_research',
  label: 'Web research and synthesis',
  appliesTo: { intent: ['research', 'wide-research'] },
  toolUniverse: ['web_search', 'web_fetch'],
  risk: 0.2,
  gatePolicy: 'cold',
  slots: {
    search: { choose: ['web_search'], scoreBy: 'intentMatch' },
    fetch: { choose: ['web_fetch'], scoreBy: 'artifactMatch' },
  },
  budget: BUDGET,
  fixedEdges: [
    { from: 'n_fetch', to: 'n_search', kind: 'control' },
    { from: 'n_search', to: 'n_done', kind: 'control' },
  ] as PlanEdge[],
}

const stock: TaskTemplate = {
  id: 't_stock',
  label: 'Direct answer (fallback)',
  appliesTo: { intent: ['other'] },
  toolUniverse: [],
  risk: 0.1,
  gatePolicy: 'never',
  slots: {},
  budget: BUDGET,
  fixedNodes: [{
    id: 'n_respond',
    kind: 'agent-step',
    executor: 'step',
    instruction: 'Complete the user task directly. Use the available tools; report what you did and the result.',
  }],
  fixedEdges: [],
}

/** Curated library; the fallback template must exist. */
export const EXPLORE_TEMPLATES: TemplateLibrary = {
  version: 1,
  templates: [editTest, investigate, research, stock],
  fallbackId: 't_stock',
}

/** Template ordering is stable (deterministic matching). */
export function templates(): TemplateLibrary {
  return EXPLORE_TEMPLATES
}

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
    return EXPLORE_TEMPLATES
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
