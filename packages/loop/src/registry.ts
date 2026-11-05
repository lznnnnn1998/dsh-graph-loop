/**
 * Graph registry plugin row: builds and keeps the live capability graph.
 *
 * This file is the DSH-facing adapter around the pure builder. It reads the
 * real registries (`ctx.tools`, plus optional skills/presets when mounted),
 * rebuilds on `tools/change` / `system-prompt/change`, and exposes one service
 * (`ctx.graphRegistry`) that the matcher and the driver read.
 *
 * The graph is a *snapshot*, never a frozen init table: MCP tools appear after
 * `tools/change`, conditional registrations are marked, and dynamic tools are
 * excluded from strong matching by the router.
 */
import { createHash } from 'node:crypto'
import { Service, type Context } from '@deepseek-ai/cordis'
import type {
  ArtifactSpec,
  ArtifactType,
  GraphEdge,
  PermissionClass,
  RegistryGraph,
  RegistryNode,
  ToolFacts,
} from '@dsh/explore-core/graph-schema'

/** Minimal shape of one registered tool we need (avoid importing the full ToolDefinition). */
export interface ToolSnapshot {
  readonly name: string
  readonly description: string
  readonly parameters: unknown
  readonly conditional?: boolean
  readonly dynamic?: boolean
  readonly packageName?: string
}

/** Everything the builder reads, injected so unit tests need no Cordis context. */
export interface RegistrySources {
  readonly tools: readonly ToolSnapshot[]
  readonly warnings?: readonly string[]
}

/** Config for the registry row. */
export interface Config {
  /** Rebuild debounce in ms; 0 rebuilds synchronously. */
  snapshotTtlMs?: number
  /** Include a curated artifact layer for the shipped tools. */
  curatedArtifacts?: boolean
}

const ANNOTATION_VERSION = '2026-11.1'

/** Curated artifact effects for the shipped tool surface (the strongest routing signal). */
const CURATED: Readonly<Record<string, { accepts?: ArtifactType[]; produces?: ArtifactType[]; tags?: string[]; permission?: PermissionClass }>> = {
  read: { accepts: ['path.locator'], produces: ['file.text'], tags: ['filesystem', 'discovery'], permission: 'read-only' },
  read_image: { accepts: ['path.locator'], produces: ['file.image'], tags: ['filesystem', 'vision'], permission: 'read-only' },
  glob: { accepts: ['path.locator'], produces: ['path.list'], tags: ['filesystem', 'discovery'], permission: 'read-only' },
  grep: { accepts: ['path.locator'], produces: ['search.hits'], tags: ['filesystem', 'discovery'], permission: 'read-only' },
  write: { accepts: ['file.text'], produces: ['file.text'], tags: ['filesystem', 'mutating'], permission: 'mutating' },
  edit: { accepts: ['file.text'], produces: ['file.patch'], tags: ['filesystem', 'mutating'], permission: 'mutating' },
  str_replace_editor: { accepts: ['file.text'], produces: ['file.patch'], tags: ['filesystem', 'mutating'], permission: 'mutating' },
  bash: { accepts: ['path.locator'], produces: ['shell.output', 'test.result'], tags: ['shell', 'execution'], permission: 'mutating' },
  pwsh: { accepts: ['path.locator'], produces: ['shell.output', 'test.result'], tags: ['shell', 'execution'], permission: 'mutating' },
  web_search: { produces: ['web.snippet'], tags: ['web', 'research'], permission: 'network' },
  web_fetch: { accepts: ['path.locator'], produces: ['web.page'], tags: ['web', 'research'], permission: 'network' },
  skill: { produces: ['context.injected'], tags: ['skill'], permission: 'read-only' },
  ask_user_question: { accepts: ['question.answer'], produces: ['question.answer'], tags: ['human'], permission: 'read-only' },
  todo_write: { produces: ['plan'], tags: ['planning'], permission: 'read-only' },
  present: { accepts: ['file.text', 'file.image'], tags: ['delivery'], permission: 'read-only' },
  session_search: { produces: ['search.hits'], tags: ['session', 'research'], permission: 'read-only' },
  update_goal: { produces: ['plan'], tags: ['planning'], permission: 'mutating' },
}

/** Alternative capabilities: same slot, different executor/permission. */
const ALTERNATIVES: readonly (readonly [string, string])[] = [
  ['read', 'read_image'],
  ['write', 'edit'],
  ['edit', 'str_replace_editor'],
  ['bash', 'pwsh'],
  ['web_search', 'web_fetch'],
]

function permissionOf(name: string): PermissionClass {
  return CURATED[name]?.permission ?? 'read-only'
}

function artifacts(types: readonly ArtifactType[] | undefined): readonly ArtifactSpec[] {
  return (types ?? []).map(type => ({ type, required: false }))
}

function parameterNames(parameters: unknown): readonly string[] {
  const parsed = parameters as { properties?: Record<string, unknown> } | undefined
  return Object.keys(parsed?.properties ?? {}).sort()
}

function schemaTokens(parameters: unknown, description: string): number {
  // Lower-bound heuristic used by the repo's own token meter for undeclared routes.
  const bytes = JSON.stringify(parameters ?? {}).length + description.length
  return Math.max(16, Math.round(bytes / 4))
}

function nodeForTool(tool: ToolSnapshot): RegistryNode {
  const curated = CURATED[tool.name]
  const facts: ToolFacts = {
    name: tool.name,
    packageName: tool.packageName ?? 'unknown',
    executor: 'native',
    permission: permissionOf(tool.name),
    idempotent: permissionOf(tool.name) === 'read-only',
    parameterNames: parameterNames(tool.parameters),
    accepts: artifacts(curated?.accepts),
    produces: artifacts(curated?.produces),
    conditional: tool.conditional === true,
    dynamic: tool.dynamic === true,
    schemaTokens: schemaTokens(tool.parameters, tool.description),
  }
  return {
    id: `tool:${tool.name}`,
    kind: 'tool',
    label: tool.name,
    description: tool.description,
    source: { registry: 'tools', packageName: tool.packageName, dynamic: tool.dynamic === true },
    tool: facts,
    accepts: facts.accepts,
    produces: facts.produces,
    cost: { tokensPerRequest: facts.schemaTokens, risk: facts.permission === 'mutating' ? 0.35 : facts.permission === 'network' ? 0.2 : 0.05 },
    tags: curated?.tags ?? ['tool'],
    annotationVersion: ANNOTATION_VERSION,
  }
}

function edge(from: string, to: string, kind: GraphEdge['kind'], weight: number, symmetric = false): GraphEdge {
  return {
    id: `${kind}:${from}->${to}`,
    from,
    to,
    kind,
    weight,
    provenance: 'declared',
    symmetric,
  }
}

/** Canonical, order-insensitive JSON used for the digest. */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  if (value !== null && typeof value === 'object') {
    const record = value as Record<string, unknown>
    return `{${Object.keys(record).sort().map(key => `${JSON.stringify(key)}:${canonical(record[key])}`).join(',')}}`
  }
  return JSON.stringify(value)
}

function buildGraph(sources: RegistrySources, buildTick: number): RegistryGraph {
  const nodes = [...sources.tools]
    .sort((left, right) => left.name.localeCompare(right.name))
    .map(nodeForTool)
  const byName = new Map(nodes.map(node => [node.tool?.name ?? node.label, node]))
  const edges: GraphEdge[] = []
  for (const [a, b] of ALTERNATIVES) {
    const left = byName.get(a)
    const right = byName.get(b)
    if (left === undefined || right === undefined) continue
    edges.push(edge(left.id, right.id, 'substitutes', 0.8, true))
  }
  // producible -> consumer relationships, one hop; a cheap but useful prior.
  for (const producer of nodes) {
    for (const artifact of producer.produces) {
      for (const consumer of nodes) {
        if (consumer.id === producer.id) continue
        if (!consumer.accepts.some(spec => spec.type === artifact.type)) continue
        edges.push(edge(producer.id, consumer.id, 'produces', 0.5))
      }
    }
  }
  const warnings = [...(sources.warnings ?? [])]
  if (nodes.some(node => node.tool?.dynamic === true)) warnings.push('dynamic tools present: excluded from strong matching')
  if (nodes.some(node => node.tool?.conditional === true)) warnings.push('conditional tools present: admission may vary per step')
  const dedupedEdges = [...new Map(edges.map(item => [item.id, item])).values()].sort((left, right) => left.id.localeCompare(right.id))
  const digest = createHash('sha256').update(canonical({ nodes, edges: dedupedEdges })).digest('hex').slice(0, 16)
  return {
    version: buildTick,
    digest,
    nodes,
    edges: dedupedEdges,
    sources: [{ registry: 'tools', count: nodes.length, lastChangeSeq: buildTick }],
    warnings,
    buildTick,
  }
}

export interface RegistrySnapshot {
  readonly graph: RegistryGraph
  readonly digest: string
  readonly version: number
  readonly warnings: readonly string[]
}

/** Pure snapshot builder (exported for tests and for the preset-scoped observer). */
export function buildRegistrySnapshot(sources: RegistrySources, previous?: RegistrySnapshot): RegistrySnapshot {
  const tick = (previous?.version ?? 0) + 1
  const graph = buildGraph(sources, tick)
  if (previous !== undefined && previous.digest === graph.digest) {
    return { ...previous, warnings: graph.warnings }
  }
  return { graph, digest: graph.digest, version: tick, warnings: graph.warnings }
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
  private readonly config: Required<Config>

  constructor(ctx: Context, config: Config = {}) {
    super(ctx, 'graphRegistry')
    this.config = { snapshotTtlMs: config.snapshotTtlMs ?? 25, curatedArtifacts: config.curatedArtifacts ?? true }
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
    if (this.config.snapshotTtlMs <= 0) {
      this.rebuild()
      return
    }
    if (this.pending !== undefined) return
    this.pending = setTimeout(() => {
      this.pending = undefined
      this.rebuild()
    }, this.config.snapshotTtlMs)
  }

  /** Read the latest snapshot, building it on first use. */
  snapshot(): RegistrySnapshot {
    this.current ??= this.rebuild()
    return this.current
  }

  /** Force a rebuild from the live tool registry. */
  rebuild(): RegistrySnapshot {
    const tools: ToolSnapshot[] = this.ctx.tools.definitions().map(definition => ({
      name: definition.name,
      description: definition.description,
      parameters: definition.parameters,
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
