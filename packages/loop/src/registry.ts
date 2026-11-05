/**
 * Graph registry plugin row: builds and keeps the live capability graph.
 *
 * The snapshot builder itself lives in `dsh-graph-loop-core/registry`; this file is
 * only the DSH adapter: read `ctx.tools`, rebuild on `tools/change` and
 * `system-prompt/change`, expose `ctx.graphRegistry`.
 *
 * The graph is a *snapshot*, never a frozen init table: MCP tools appear after
 * `tools/change`, conditional registrations are marked, and dynamic tools are
 * excluded from strong matching by the router.
 */
import { Service, type Context } from '@deepseek-ai/cordis'
import { buildRegistrySnapshot, type RegistrySnapshot, type ToolSource } from 'dsh-graph-loop-core/registry'

/** Config for the registry row. */
export interface Config {
  /** Rebuild debounce in ms; 0 rebuilds synchronously. */
  snapshotTtlMs?: number
}

type GraphRegistryService = {
  snapshot(): RegistrySnapshot
  rebuild(): RegistrySnapshot
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    graphRegistry: GraphRegistryService
  }
}

/** Host-scoped service that owns the live snapshot. */
export class GraphRegistry extends Service implements GraphRegistryService {
  static inject = ['tools']
  private current: RegistrySnapshot | undefined
  private pending: ReturnType<typeof setTimeout> | undefined
  private readonly delay: number

  constructor(ctx: Context, config: Config = {}) {
    super(ctx, 'graphRegistry')
    this.delay = config.snapshotTtlMs ?? 25
  }

  protected [Service.init](): void {
    this.rebuild()
    this.ctx.on('tools/change', () => { this.scheduleRebuild() })
    this.ctx.on('system-prompt/change', () => { this.scheduleRebuild() })
    this.ctx.effect(() => () => {
      if (this.pending !== undefined) clearTimeout(this.pending)
    }, 'graphRegistry.timer()')
  }

  private scheduleRebuild(): void {
    if (this.delay <= 0) {
      this.rebuild()
      return
    }
    if (this.pending !== undefined) return
    this.pending = setTimeout(() => {
      this.pending = undefined
      this.rebuild()
    }, this.delay)
  }

  /** Read the latest snapshot, building it on first use. */
  snapshot(): RegistrySnapshot {
    this.current ??= this.rebuild()
    return this.current
  }

  /** Force a rebuild from the live tool registry. */
  rebuild(): RegistrySnapshot {
    const tools: ToolSource[] = this.ctx.tools.definitions().map(definition => ({
      name: definition.name,
      description: definition.description,
      parameters: definition.parameters as Readonly<Record<string, unknown>>,
    }))
    this.current = buildRegistrySnapshot({ tools }, this.current)
    return this.current
  }
}

/** Cordis plugin entry. */
export const name = 'explore-registry'

/**
 * Mount the host-scoped registry service.
 * @param ctx - host context.
 * @param config - snapshot options.
 */
export function apply(ctx: Context, config: Config = {}): void {
  ctx.plugin(GraphRegistry, config)
}
