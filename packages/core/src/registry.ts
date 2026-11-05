/**
 * registry.ts — build the Layer-1 capability graph from live DSH registries.
 *
 * `design/graph-schema.ts` defines the graph model; this module is the pure,
 * deterministic builder that turns the injected registry facts (tools, prompt
 * sections, skills, presets, agents, plugins, subagent providers) into a
 * `RegistryGraph` snapshot. It performs no I/O and reads no clock: the only
 * import with a side-effect-free runtime dependency is `node:crypto` for the
 * snapshot digest. The same sources therefore always produce the same graph,
 * the same digest and (when nothing changed) the same `buildTick`.
 *
 * Facts that DSH does not expose as data — artifact pre/post conditions,
 * capability tags, permission class, risk — come from two places only:
 *   1. an explicit override on the injected source (a deployment may annotate
 *      its own tools), and
 *   2. the small curated table below for the standard DSH tools.
 * A tool with no curated entry and no override is still a node: it gets empty
 * `accepts`/`produces` and the `unmapped` tag, and — deliberately — no warning.
 * Blind spots that a consumer must know about (dynamic MCP tools, conditional
 * registrations) are surfaced through `graph.warnings`.
 *
 * Node ids are stable and namespaced: `tool:<name>`, `skill:<name>`,
 * `preset:<id>`, `agent:<id>`, `subagent:<provider>`, `plugin:<name>`,
 * `section:<id>`. Duplicate ids are resolved deterministically (non-dynamic,
 * non-conditional first, then lexicographic canonical JSON), so shuffling the
 * injected arrays cannot change the digest.
 */

import { createHash } from 'node:crypto'

import type {
  ArtifactSpec,
  ArtifactType,
  CapabilityKind,
  CostPrior,
  EdgeKind,
  ExecutorKind,
  GraphEdge,
  Json,
  NodeId,
  PermissionClass,
  PresetFacts,
  RegistryGraph,
  RegistryNode,
  RegistrySnapshotSource,
  SkillFacts,
  SubagentFacts,
  ToolFacts,
} from './graph-schema.ts'
import { validateRegistryGraph } from './graph-schema.ts'
import { canonicalJson } from './matching.ts'

// ---------------------------------------------------------------------------
// Public vocabulary
// ---------------------------------------------------------------------------

/** Annotation version stamped on every node; bump when the curated table changes. */
export const DEFAULT_ANNOTATION_VERSION = '2025-11.1'

/** Tag given to a capability with no curated annotation; never a warning by itself. */
export const UNMAPPED_TAG = 'unmapped'

/** Node id prefixes are part of the public surface; keep them stable. */
export const NODE_ID_PREFIX = {
  tool: 'tool:',
  skill: 'skill:',
  preset: 'preset:',
  agent: 'agent:',
  subagent: 'subagent:',
  plugin: 'plugin:',
  section: 'section:',
} as const

// ---------------------------------------------------------------------------
// Injected sources (all synchronous, all optional so a partial registry still builds)
// ---------------------------------------------------------------------------

/** One registered model-facing tool, as seen through `ctx.tools.schemas()`. */
export interface ToolSource {
  readonly name: string
  readonly packageName?: string
  readonly description?: string
  /** Raw JSON-Schema `parameters` object; parameter names and a token estimate derive from it. */
  readonly parameters?: Readonly<Record<string, unknown>>
  /** Explicit normalized parameter names; wins over `parameters` when both are present. */
  readonly parameterNames?: readonly string[]
  /** Measured model-facing schema size in tokens; wins over every estimate. */
  readonly schemaTokens?: number
  readonly executor?: ExecutorKind
  readonly permission?: PermissionClass
  readonly idempotent?: boolean
  /** Registered as `register(def, { when })`; may vanish between steps. */
  readonly conditional?: boolean
  /** Appears only after a runtime event (MCP connect, browser start, ...). */
  readonly dynamic?: boolean
  readonly accepts?: readonly ArtifactSpec[]
  readonly produces?: readonly ArtifactSpec[]
  readonly tags?: readonly string[]
}

/** One system-prompt section, modelled as a `surface` node. */
export interface SectionSource {
  readonly id: string
  readonly label?: string
  readonly description?: string
  readonly tokens?: number
  readonly dynamic?: boolean
  readonly tags?: readonly string[]
}

/** One catalog skill (`ctx.skills`). */
export interface SkillSource {
  readonly name: string
  readonly provider?: string
  readonly description?: string
  readonly modelInvocable?: boolean
  readonly userInvocable?: boolean
  readonly produces?: readonly ArtifactSpec[]
  readonly tokensPerCall?: number
  readonly tags?: readonly string[]
}

/** One agent preset (composition row: a tool universe + persona). */
export interface PresetSource {
  readonly id: string
  readonly label?: string
  readonly description?: string
  readonly tools?: readonly string[]
  readonly default?: boolean
  readonly tags?: readonly string[]
}

/** One agent role / registered agent in `ctx.agents`. */
export interface AgentSource {
  readonly id: string
  readonly label?: string
  readonly description?: string
  readonly presetId?: string
  readonly tags?: readonly string[]
}

/** One loaded plugin row. */
export interface PluginSource {
  readonly name: string
  readonly label?: string
  readonly description?: string
  readonly dynamic?: boolean
  readonly tags?: readonly string[]
}

/** One subagent provider registered on `ctx.subagents`. */
export interface SubagentProviderSource {
  readonly provider: string
  readonly toolName?: string
  readonly packageName?: string
  readonly description?: string
  readonly continuable?: boolean
  readonly supportsAgentPreset?: boolean
  readonly defaultMaxDepth?: number
  readonly tags?: readonly string[]
}

/**
 * The injected registry facts. Every field is optional: a headless test can
 * build from tools alone, and a deployment that does not mount a registry
 * simply omits it. Arrays are synchronous and readonly; this builder never
 * subscribes, awaits or mutates them.
 */
export interface RegistrySources {
  readonly tools?: readonly ToolSource[]
  readonly sections?: readonly SectionSource[]
  readonly skills?: readonly SkillSource[]
  readonly presets?: readonly PresetSource[]
  readonly agents?: readonly AgentSource[]
  readonly plugins?: readonly PluginSource[]
  readonly providers?: readonly SubagentProviderSource[]
  /** Version of the annotation set that supplied tags/artifacts/cost. */
  readonly annotationVersion?: string
}

/** A previously built snapshot, or just its graph, used for the monotonic counters. */
export type RegistrySnapshotCursor =
  | RegistrySnapshot
  | Pick<RegistryGraph, 'version' | 'digest' | 'buildTick'>

/** The value returned by {@link buildRegistrySnapshot}. */
export interface RegistrySnapshot {
  /** Monotonic snapshot version; bumps only when the digest changes. */
  readonly version: number
  /** sha256 over canonical nodes+edges (64 lowercase hex characters). */
  readonly digest: string
  readonly graph: RegistryGraph
  /** `graph.warnings`, hoisted for callers that only log snapshots. */
  readonly warnings: readonly string[]
}

// ---------------------------------------------------------------------------
// Deterministic JSON / hashing helpers
// ---------------------------------------------------------------------------

/** Deep-copy to a canonical JSON value; drops `undefined` object properties. */
function canonicalValue(value: unknown): Json | undefined {
  if (value === undefined) return undefined
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return value
  if (typeof value === 'number') return Number.isFinite(value) ? value : null
  if (Array.isArray(value)) {
    return value.map((item) => canonicalValue(item) ?? null)
  }
  if (typeof value === 'object') {
    const record = value as Readonly<Record<string, unknown>>
    const out: { [key: string]: Json } = {}
    for (const key of Object.keys(record).sort()) {
      const child = canonicalValue(record[key])
      if (child !== undefined) out[key] = child
    }
    return out
  }
  return undefined
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0
}

function uniqueSorted(values: readonly string[]): string[] {
  return [...new Set(values)].sort(compareText)
}

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, Number.isFinite(value) ? value : 0))
}

/**
 * Stable sha256 over canonical nodes and edges. Array order is irrelevant
 * (both are sorted by id first); optional `undefined` fields are dropped.
 * Warnings, version and buildTick are deliberately excluded: they are not part
 * of the capability graph, so a rebuild with identical facts keeps the digest.
 */
export function digestGraph(graph: Pick<RegistryGraph, 'nodes' | 'edges'>): string {
  const payload = canonicalValue({
    nodes: [...graph.nodes].sort((left, right) => compareText(left.id, right.id)),
    edges: [...graph.edges].sort((left, right) => compareText(left.id, right.id)),
  })
  return createHash('sha256').update(canonicalJson(payload as Json), 'utf8').digest('hex')
}

// ---------------------------------------------------------------------------
// Curated annotation table for the standard DSH tools
// ---------------------------------------------------------------------------
//
// MEASURED schema token counts: docs/tool-catalog.md in the DSH checkout,
// generated by booting every shipped tool plugin (chars / 4 heuristic, a lower
// bound; see design/measurements.md). Kept as data rather than computed at
// runtime so the builder stays pure and the snapshot reproducible offline.

const MEASURED_SCHEMA_TOKENS: Readonly<Record<string, number>> = {
  plugin_manager: 541,
  plugin_market: 276,
  list_mcp_resource_templates: 73,
  list_mcp_resources: 73,
  read_mcp_resource: 70,
  stagehand_act: 80,
  stagehand_extract: 272,
  stagehand_navigate: 76,
  stagehand_observe: 80,
  stagehand_screenshot: 79,
  stagehand_tabs: 259,
  propose_action: 141,
  ask_user_question: 443,
  run_code: 305,
  exit_plan_mode: 55,
  bash: 287,
  present: 173,
  pwsh: 287,
  cordis_inspect_list: 11,
  cordis_inspect_query: 159,
  str_replace_editor: 639,
  edit: 181,
  read: 111,
  read_image: 54,
  write: 96,
  glob: 137,
  grep: 139,
  terminal_close: 44,
  terminal_list: 11,
  terminal_open: 121,
  terminal_read: 103,
  terminal_send: 166,
  terminal_signal: 113,
  create_goal: 95,
  get_goal: 11,
  update_goal: 291,
  schedule_create: 934,
  schedule_delete: 40,
  schedule_list: 11,
  schedule_update: 800,
  lsp: 184,
  ralph: 93,
  skill: 50,
  session_event_read: 140,
  session_event_search: 300,
  session_event_trace: 75,
  session_search: 527,
  session_trace: 42,
  subagent_oar: 184,
  list_subagent_models: 63,
  subagent: 166,
  interrupt_agent: 59,
  list_agents: 102,
  send_message: 97,
  job_kill: 88,
  job_list: 11,
  job_output: 139,
  spawn_teammate: 168,
  team_task_create: 171,
  team_task_get: 42,
  team_task_list: 187,
  team_task_update: 330,
  wait_agent: 50,
  todo_write: 202,
  working_directory: 44,
  create_worktree: 88,
  workflow: 607,
  load_workspace_dependencies: 11,
  web_fetch: 43,
  web_search: 62,
} as const

const required = (type: ArtifactType, contract?: string): ArtifactSpec =>
  contract === undefined ? { type, required: true } : { type, required: true, contract }
const optional = (type: ArtifactType): ArtifactSpec => ({ type, required: false })

interface CuratedTool {
  readonly description: string
  readonly permission: PermissionClass
  readonly idempotent: boolean
  readonly tags: readonly string[]
  readonly parameterNames?: readonly string[]
  readonly accepts?: readonly ArtifactSpec[]
  readonly produces?: readonly ArtifactSpec[]
}

const CURATED_TOOLS: Readonly<Record<string, CuratedTool>> = {
  read: {
    description: 'Read a UTF-8 text file.',
    permission: 'read-only',
    idempotent: true,
    tags: ['filesystem', 'discovery'],
    parameterNames: ['file_path', 'offset', 'limit'],
    accepts: [required('path.locator')],
    produces: [required('file.text', 'utf8-or-locator')],
  },
  read_image: {
    description: 'Read an image file and return it as an attachment.',
    permission: 'read-only',
    idempotent: true,
    tags: ['filesystem', 'vision'],
    parameterNames: ['file_path'],
    accepts: [required('path.locator')],
    produces: [required('file.image')],
  },
  write: {
    description: 'Create or fully replace a UTF-8 text file.',
    permission: 'mutating',
    idempotent: false,
    tags: ['filesystem', 'mutation'],
    parameterNames: ['file_path', 'content'],
    accepts: [required('path.locator'), optional('file.text')],
    produces: [required('file.text')],
  },
  edit: {
    description: 'Replace literal text inside one file (read-before-edit policy applies).',
    permission: 'mutating',
    idempotent: false,
    tags: ['filesystem', 'mutation'],
    parameterNames: ['file_path', 'old_string', 'new_string', 'replace_all'],
    accepts: [required('file.text')],
    produces: [required('file.patch')],
  },
  str_replace_editor: {
    description: 'View a file and apply one unique literal replace or a line insert.',
    permission: 'mutating',
    idempotent: false,
    tags: ['filesystem', 'mutation'],
    parameterNames: ['command', 'path', 'file_text', 'insert_line', 'new_str', 'old_str', 'view_range'],
    accepts: [required('file.text')],
    produces: [required('file.patch')],
  },
  glob: {
    description: 'Find files by path pattern.',
    permission: 'read-only',
    idempotent: true,
    tags: ['filesystem', 'discovery', 'search'],
    parameterNames: ['pattern', 'path'],
    accepts: [optional('path.locator')],
    produces: [required('path.list')],
  },
  grep: {
    description: 'Search file contents with a regular expression.',
    permission: 'read-only',
    idempotent: true,
    tags: ['filesystem', 'search'],
    parameterNames: ['pattern', 'path', 'include'],
    accepts: [optional('path.locator')],
    produces: [required('search.hits')],
  },
  bash: {
    description: 'Run a shell command in the session workspace.',
    permission: 'privileged',
    idempotent: false,
    tags: ['shell', 'verification'],
    parameterNames: ['description', 'command', 'timeoutMs', 'workdir', 'run_in_background'],
    accepts: [optional('path.locator')],
    produces: [required('shell.output'), optional('test.result')],
  },
  pwsh: {
    description: 'Run a PowerShell command in the session workspace.',
    permission: 'privileged',
    idempotent: false,
    tags: ['shell', 'verification'],
    parameterNames: ['description', 'command', 'timeoutMs', 'workdir', 'run_in_background'],
    accepts: [optional('path.locator')],
    produces: [required('shell.output'), optional('test.result')],
  },
  run_code: {
    description: 'Run code through the PTC executor with bridged tool calls.',
    permission: 'privileged',
    idempotent: false,
    tags: ['shell', 'ptc'],
    parameterNames: ['code', 'description', 'timeoutMs', 'sandbox_permissions', 'justification'],
    produces: [required('shell.output')],
  },
  todo_write: {
    description: 'Record or update the session todo checklist.',
    permission: 'mutating',
    idempotent: true,
    tags: ['planning'],
    parameterNames: ['todos'],
    produces: [required('plan')],
  },
  present: {
    description: 'Declare final deliverables for the user.',
    permission: 'mutating',
    idempotent: true,
    tags: ['delivery'],
    parameterNames: ['files'],
    accepts: [optional('file.text'), optional('file.patch'), optional('file.image'), optional('file.binary')],
    produces: [required('context.injected')],
  },
  skill: {
    description: 'Load a named skill body into the session.',
    permission: 'read-only',
    idempotent: true,
    tags: ['instruction', 'discovery'],
    parameterNames: ['name'],
    produces: [required('context.injected')],
  },
  ask_user_question: {
    description: 'Ask the user a question and wait for the answer.',
    permission: 'read-only',
    idempotent: true,
    tags: ['human-gate'],
    parameterNames: ['questions'],
    produces: [required('question.answer')],
  },
  web_search: {
    description: 'Search the web; returns snippets and source URLs.',
    permission: 'network',
    idempotent: true,
    tags: ['web', 'search'],
    parameterNames: ['queries'],
    produces: [required('web.snippet')],
  },
  web_fetch: {
    description: 'Fetch one URL and return decoded text.',
    permission: 'network',
    idempotent: true,
    tags: ['web'],
    parameterNames: ['url'],
    accepts: [optional('web.snippet')],
    produces: [required('web.page')],
  },
  subagent: {
    description: 'Delegate to a fresh child agent and return its report.',
    permission: 'mutating',
    idempotent: false,
    tags: ['orchestration'],
    parameterNames: ['cwd', 'description', 'prompt'],
    produces: [required('child.report')],
  },
  subagent_fork: {
    description: 'Delegate to a child agent that inherits this conversation.',
    permission: 'mutating',
    idempotent: false,
    tags: ['orchestration'],
    parameterNames: ['cwd', 'description', 'prompt'],
    produces: [required('child.report')],
  },
  workflow: {
    description: 'Run a JavaScript orchestration script that fans out subagents.',
    permission: 'mutating',
    idempotent: false,
    tags: ['orchestration'],
    parameterNames: ['script', 'meta', 'args', 'run_in_background'],
    produces: [required('child.report')],
  },
  ralph: {
    description: 'Run fixed fresh-child rounds under one immutable objective.',
    permission: 'mutating',
    idempotent: false,
    tags: ['orchestration'],
    parameterNames: ['objective', 'maxRounds'],
    produces: [required('child.report')],
  },
  subagent_oar: {
    description: 'Delegate to an external agent backend selected by alias.',
    permission: 'mutating',
    idempotent: false,
    tags: ['orchestration'],
    parameterNames: ['runtime', 'description', 'prompt', 'cwd'],
    produces: [required('child.report')],
  },
  session_search: {
    description: 'Search prior sessions for matching events.',
    permission: 'read-only',
    idempotent: true,
    tags: ['search', 'sessions'],
    parameterNames: ['query', 'session_ids', 'created_at_from', 'created_at_to', 'event_types'],
    produces: [required('search.hits')],
  },
  session_event_search: {
    description: 'Search the event stream of one session.',
    permission: 'read-only',
    idempotent: true,
    tags: ['search', 'sessions'],
    produces: [required('search.hits')],
  },
  lsp: {
    description: 'Query language-server diagnostics, symbols and definitions.',
    permission: 'read-only',
    idempotent: true,
    tags: ['code', 'diagnostics'],
    parameterNames: ['operation', 'file_path', 'line', 'character'],
    accepts: [optional('file.text')],
    produces: [required('search.hits')],
  },
  job_output: {
    description: 'Read the output of a background job.',
    permission: 'read-only',
    idempotent: true,
    tags: ['jobs', 'shell'],
    parameterNames: ['job_id', 'wait', 'timeout_ms'],
    produces: [required('shell.output')],
  },
  job_list: {
    description: 'List background jobs in this session.',
    permission: 'read-only',
    idempotent: true,
    tags: ['jobs'],
    parameterNames: [],
  },
  job_kill: {
    description: 'Request cancellation of a background job.',
    permission: 'mutating',
    idempotent: false,
    tags: ['jobs'],
    parameterNames: ['job_id', 'reason'],
  },
  terminal_list: {
    description: 'List PTY terminals owned by this session.',
    permission: 'read-only',
    idempotent: true,
    tags: ['terminal'],
    parameterNames: [],
  },
  terminal_read: {
    description: 'Read buffered output from a PTY terminal.',
    permission: 'read-only',
    idempotent: true,
    tags: ['terminal', 'shell'],
    parameterNames: ['sessionId', 'offset', 'count'],
    produces: [required('shell.output')],
  },
  terminal_send: {
    description: 'Send text or keys to a PTY terminal.',
    permission: 'privileged',
    idempotent: false,
    tags: ['terminal', 'shell'],
    parameterNames: ['sessionId', 'text', 'submit', 'run_in_background'],
    produces: [required('shell.output')],
  },
  terminal_close: {
    description: 'Close a PTY terminal.',
    permission: 'mutating',
    idempotent: false,
    tags: ['terminal'],
    parameterNames: ['sessionId'],
  },
  plugin_manager: {
    description: 'List, enable, disable, install or remove plugins and bundles.',
    permission: 'privileged',
    idempotent: false,
    tags: ['plugins', 'admin'],
    parameterNames: ['action', 'target', 'enabled', 'runtimeVersion', 'acceptRisk', 'approvedBuilds', 'registry', 'offset', 'limit'],
  },
  plugin_market: {
    description: 'Browse and operate the plugin market.',
    permission: 'privileged',
    idempotent: false,
    tags: ['plugins', 'admin'],
    parameterNames: ['action', 'target', 'name', 'query', 'offset', 'limit'],
  },
  create_goal: {
    description: 'Create a persisted goal that survives continuation rounds.',
    permission: 'mutating',
    idempotent: false,
    tags: ['goal'],
    parameterNames: ['objective', 'max_goal_rounds'],
    produces: [required('plan')],
  },
  get_goal: {
    description: 'Read the current session goal.',
    permission: 'read-only',
    idempotent: true,
    tags: ['goal'],
    parameterNames: [],
    produces: [required('plan')],
  },
  update_goal: {
    description: 'Update, pause, resume or complete the current goal.',
    permission: 'mutating',
    idempotent: false,
    tags: ['goal'],
    parameterNames: ['goal_id', 'revision', 'action', 'objective', 'max_goal_rounds', 'blocked_reason'],
    produces: [required('plan')],
  },
  schedule_create: {
    description: 'Create a session reminder.',
    permission: 'mutating',
    idempotent: false,
    tags: ['schedule'],
    parameterNames: ['prompt', 'title', 'after_seconds', 'every_seconds', 'daily', 'weekly', 'cron', 'at'],
    produces: [required('plan')],
  },
  schedule_delete: {
    description: 'Delete a session reminder.',
    permission: 'mutating',
    idempotent: false,
    tags: ['schedule'],
    parameterNames: ['id'],
  },
  schedule_list: {
    description: 'List active session reminders.',
    permission: 'read-only',
    idempotent: true,
    tags: ['schedule'],
    parameterNames: [],
    produces: [required('plan')],
  },
  schedule_update: {
    description: 'Update a session reminder in place.',
    permission: 'mutating',
    idempotent: false,
    tags: ['schedule'],
    parameterNames: ['id', 'title', 'prompt', 'every_seconds', 'daily', 'weekly', 'cron', 'at'],
  },
  list_agents: {
    description: 'List live agents and teammates reachable from this session.',
    permission: 'read-only',
    idempotent: true,
    tags: ['agents'],
    parameterNames: ['scope'],
  },
  send_message: {
    description: 'Send a message to another agent or teammate.',
    permission: 'mutating',
    idempotent: false,
    tags: ['agents'],
    parameterNames: ['agent_id', 'message'],
    produces: [required('context.injected')],
  },
  interrupt_agent: {
    description: 'Interrupt a live agent or teammate.',
    permission: 'mutating',
    idempotent: false,
    tags: ['agents'],
    parameterNames: ['agent_id'],
  },
  working_directory: {
    description: 'Read or change the session working directory.',
    permission: 'mutating',
    idempotent: false,
    tags: ['filesystem'],
    parameterNames: ['cd'],
    produces: [required('path.locator')],
  },
  exit_plan_mode: {
    description: 'Present a plan for approval and leave plan mode.',
    permission: 'mutating',
    idempotent: true,
    tags: ['planning', 'human-gate'],
    parameterNames: ['plan'],
    produces: [required('question.answer')],
  },
  propose_action: {
    description: 'Propose an action card and wait for the user decision.',
    permission: 'mutating',
    idempotent: false,
    tags: ['human-gate'],
    parameterNames: ['action', 'title', 'brief', 'details'],
    produces: [required('question.answer')],
  },
  create_worktree: {
    description: 'Create a git worktree and switch the session into it.',
    permission: 'privileged',
    idempotent: false,
    tags: ['git', 'filesystem'],
    parameterNames: ['name', 'from'],
    produces: [required('path.locator')],
  },
  load_workspace_dependencies: {
    description: 'Install or refresh workspace dependencies.',
    permission: 'privileged',
    idempotent: false,
    tags: ['workspace'],
    parameterNames: [],
  },
}

/** Known substitute pairs; the edge is emitted in both directions when both nodes exist. */
const SUBSTITUTE_PAIRS: readonly { readonly a: string; readonly b: string; readonly weight: number; readonly note: string }[] = [
  { a: 'bash', b: 'str_replace_editor', weight: 0.55, note: 'both can change files; shell is general, editor is constrained to one literal replace' },
  { a: 'read', b: 'read_image', weight: 0.5, note: 'same verb, different artifact type; embedding cosine cannot tell them apart' },
  { a: 'edit', b: 'write', weight: 0.7, note: 'same file.text artifact; edit preserves the rest of the file, write replaces it' },
  { a: 'edit', b: 'str_replace_editor', weight: 0.8, note: 'same file.patch artifact, different uniqueness/precondition contract' },
  { a: 'bash', b: 'pwsh', weight: 0.85, note: 'same shell artifact; mutually exclusive by platform' },
  { a: 'subagent', b: 'subagent_fork', weight: 0.8, note: 'same child.report artifact; fresh context vs inherited context' },
  { a: 'glob', b: 'grep', weight: 0.6, note: 'both discovery tools; path list vs content hits' },
]

/** Declared prerequisite pairs (artifact or observation policy). */
const REQUIRES_PAIRS: readonly { readonly from: string; readonly to: string; readonly weight: number; readonly note: string }[] = [
  { from: 'read', to: 'edit', weight: 1, note: 'fs-observation-policy: read before edit' },
  { from: 'read', to: 'write', weight: 1, note: 'fs-observation-policy: read before overwriting an existing file' },
  { from: 'read', to: 'str_replace_editor', weight: 1, note: 'fs-observation-policy: view before a unique replace' },
]

/** Weight of a `produces` edge, by artifact type. */
const ARTIFACT_EDGE_WEIGHTS: Readonly<Record<ArtifactType, number>> = {
  'file.text': 0.8,
  'file.image': 0.8,
  'file.binary': 0.6,
  'file.patch': 0.75,
  'path.locator': 0.6,
  'path.list': 0.55,
  'search.hits': 0.9,
  'shell.output': 0.5,
  'test.result': 0.7,
  'web.page': 0.65,
  'web.snippet': 0.6,
  plan: 0.3,
  'question.answer': 0.4,
  'child.report': 0.5,
  'context.injected': 0.5,
}

/** Tags that must never create `similar` edges (too generic to mean anything). */
const GENERIC_TAGS: ReadonlySet<string> = new Set([UNMAPPED_TAG])

// ---------------------------------------------------------------------------
// Heuristics (exported so the driver/tests can explain a classification)
// ---------------------------------------------------------------------------

const EXACT_PERMISSION: Readonly<Record<string, PermissionClass>> = {
  // Shells, executors, host installs and anything that changes the process sandbox.
  bash: 'privileged',
  pwsh: 'privileged',
  run_code: 'privileged',
  terminal_open: 'privileged',
  terminal_send: 'privileged',
  terminal_signal: 'privileged',
  create_worktree: 'privileged',
  load_workspace_dependencies: 'privileged',
  plugin_manager: 'privileged',
  plugin_market: 'privileged',
  // Network I/O.
  web_search: 'network',
  web_fetch: 'network',
  stagehand_act: 'network',
  stagehand_extract: 'network',
  stagehand_navigate: 'network',
  stagehand_observe: 'network',
  stagehand_screenshot: 'network',
  stagehand_tabs: 'network',
  // Reads (filesystem, session, registry, inspection).
  read: 'read-only',
  read_image: 'read-only',
  glob: 'read-only',
  grep: 'read-only',
  list_agents: 'read-only',
  list_subagent_models: 'read-only',
  list_mcp_resources: 'read-only',
  list_mcp_resource_templates: 'read-only',
  read_mcp_resource: 'read-only',
  session_search: 'read-only',
  session_event_read: 'read-only',
  session_event_search: 'read-only',
  session_event_trace: 'read-only',
  session_trace: 'read-only',
  get_goal: 'read-only',
  job_list: 'read-only',
  job_output: 'read-only',
  terminal_list: 'read-only',
  terminal_read: 'read-only',
  cordis_inspect_list: 'read-only',
  cordis_inspect_query: 'read-only',
  lsp: 'read-only',
  ask_user_question: 'read-only',
  skill: 'read-only',
  // Everything that writes session, filesystem, schedule or agent state.
  edit: 'mutating',
  write: 'mutating',
  str_replace_editor: 'mutating',
  present: 'mutating',
  todo_write: 'mutating',
  subagent: 'mutating',
  subagent_fork: 'mutating',
  workflow: 'mutating',
  ralph: 'mutating',
  subagent_oar: 'mutating',
  spawn_teammate: 'mutating',
  send_message: 'mutating',
  interrupt_agent: 'mutating',
  team_task_create: 'mutating',
  team_task_update: 'mutating',
  team_task_get: 'read-only',
  team_task_list: 'read-only',
  wait_agent: 'read-only',
  create_goal: 'mutating',
  update_goal: 'mutating',
  schedule_create: 'mutating',
  schedule_delete: 'mutating',
  schedule_update: 'mutating',
  schedule_list: 'read-only',
  exit_plan_mode: 'mutating',
  propose_action: 'mutating',
  working_directory: 'mutating',
  job_kill: 'mutating',
  terminal_close: 'mutating',
}

const READ_PREFIXES = ['read', 'list', 'get', 'inspect', 'search', 'trace', 'find', 'show', 'view', 'describe', 'query'] as const
const NETWORK_PREFIXES = ['web_', 'web-', 'fetch', 'http'] as const
const PRIVILEGED_PREFIXES = ['bash', 'pwsh', 'shell', 'exec', 'run', 'terminal', 'plugin', 'install', 'worktree'] as const

/**
 * Permission class heuristic. Explicit source facts always win; this is the
 * fallback for a tool the annotation layer has never seen. Conservative:
 * unknown mutates, so routing never assumes a write tool is safe by accident.
 */
export function inferPermissionClass(name: string): PermissionClass {
  const normalized = name.trim().toLowerCase()
  const exact = EXACT_PERMISSION[normalized]
  if (exact !== undefined) return exact
  if (PRIVILEGED_PREFIXES.some((prefix) => normalized.startsWith(prefix))) return 'privileged'
  if (NETWORK_PREFIXES.some((prefix) => normalized.startsWith(prefix))) return 'network'
  if (READ_PREFIXES.some((prefix) => normalized.startsWith(prefix))) return 'read-only'
  return 'mutating'
}

/** Idempotency heuristic: reads are safe to repeat, writes are assumed unsafe unless annotated. */
export function inferIdempotent(name: string, permission: PermissionClass): boolean {
  const curated = CURATED_TOOLS[name]?.idempotent
  if (curated !== undefined) return curated
  return permission === 'read-only' || permission === 'network'
}

/** Risk prior from permission class and retry safety; clamped to [0, 1]. */
function riskFor(permission: PermissionClass, idempotent: boolean): number {
  const base = permission === 'read-only' ? 0.02 : permission === 'network' ? 0.1 : permission === 'mutating' ? 0.45 : 0.62
  return clamp01(base + (idempotent ? 0 : 0.03))
}

/** Stable, validation-safe id fragment (`[a-z0-9._:-]`, at most 96 chars). */
function idFragment(raw: string): string {
  const lowered = raw.trim().toLowerCase().replace(/[^a-z0-9._:-]+/gu, '_').replace(/^_+|_+$/gu, '')
  const safe = lowered.length === 0 ? 'unnamed' : lowered
  return safe.slice(0, 96)
}

/** Sort/canonicalize injected tag lists without changing declared order elsewhere. */
function normalizeTags(tags: readonly string[] | undefined, fallback: readonly string[]): string[] {
  if (tags === undefined) return [...fallback]
  const cleaned = tags.map((tag) => tag.trim()).filter((tag) => tag.length > 0)
  return cleaned.length === 0 ? [UNMAPPED_TAG] : [...new Set(cleaned)]
}

function parameterNamesOf(parameters: Readonly<Record<string, unknown>> | undefined): string[] {
  if (parameters === undefined) return []
  const properties = parameters.properties
  if (properties === null || typeof properties !== 'object' || Array.isArray(properties)) return []
  return Object.keys(properties as Readonly<Record<string, unknown>>).sort(compareText)
}

/** Deterministic schema-size estimate: measured > explicit > parameters > description > floor. */
export function estimateSchemaTokens(
  name: string,
  description: string | undefined,
  parameters: Readonly<Record<string, unknown>> | undefined,
): number {
  if (parameters !== undefined) return Math.max(1, Math.ceil(JSON.stringify(parameters).length / 4))
  const text = `${name}${description ?? ''}`
  return Math.max(40, Math.ceil(text.length / 4) + 24)
}

function normalizeTokens(value: number | undefined): number | undefined {
  if (value === undefined || !Number.isFinite(value) || value < 0) return undefined
  return Math.round(value)
}

// ---------------------------------------------------------------------------
// Node builders
// ---------------------------------------------------------------------------

function toolNode(source: ToolSource, annotationVersion: string): RegistryNode | undefined {
  const name = source.name.trim()
  if (name.length === 0) return undefined
  const curated = CURATED_TOOLS[name]
  const permission = source.permission ?? curated?.permission ?? inferPermissionClass(name)
  const idempotent = source.idempotent ?? curated?.idempotent ?? inferIdempotent(name, permission)
  const schemaTokens =
    normalizeTokens(source.schemaTokens) ??
    (source.parameters === undefined ? undefined : estimateSchemaTokens(name, source.description, source.parameters)) ??
    MEASURED_SCHEMA_TOKENS[name] ??
    estimateSchemaTokens(name, source.description ?? curated?.description, source.parameters)
  const parameterNames =
    source.parameterNames !== undefined
      ? uniqueSorted(source.parameterNames)
      : source.parameters !== undefined
        ? parameterNamesOf(source.parameters)
        : [...(curated?.parameterNames ?? [])]
  const accepts = [...(source.accepts ?? curated?.accepts ?? [])]
  const produces = [...(source.produces ?? curated?.produces ?? [])]
  const tags = normalizeTags(source.tags, curated?.tags ?? [UNMAPPED_TAG])
  const facts: ToolFacts = {
    name,
    packageName: source.packageName ?? 'unknown',
    executor: source.executor ?? (name === 'run_code' ? 'ptc' : 'native'),
    permission,
    idempotent,
    parameterNames,
    accepts,
    produces,
    conditional: source.conditional === true,
    dynamic: source.dynamic === true,
    schemaTokens,
  }
  const cost: CostPrior = { tokensPerRequest: schemaTokens, risk: riskFor(permission, idempotent) }
  return {
    id: `${NODE_ID_PREFIX.tool}${idFragment(name)}`,
    kind: 'tool',
    label: name,
    description: source.description ?? curated?.description ?? `Tool ${name}.`,
    source: { registry: 'tools', ...(source.packageName === undefined ? {} : { packageName: source.packageName }), dynamic: facts.dynamic },
    tool: facts,
    accepts,
    produces,
    cost,
    tags,
    annotationVersion,
  }
}

function skillNode(source: SkillSource, annotationVersion: string): RegistryNode | undefined {
  const name = source.name.trim()
  if (name.length === 0) return undefined
  const produces = [...(source.produces ?? [])]
  const facts: SkillFacts = {
    name,
    provider: source.provider ?? 'unknown',
    modelInvocable: source.modelInvocable ?? true,
    userInvocable: source.userInvocable ?? true,
    produces,
  }
  return {
    id: `${NODE_ID_PREFIX.skill}${idFragment(name)}`,
    kind: 'skill',
    label: name,
    description: source.description ?? `Skill ${name}.`,
    source: { registry: 'skills', dynamic: false },
    skill: facts,
    accepts: [],
    produces,
    cost: { tokensPerCall: normalizeTokens(source.tokensPerCall) ?? 0, risk: 0.05 },
    tags: normalizeTags(source.tags, ['skill']),
    annotationVersion,
  }
}

function presetNode(source: PresetSource, annotationVersion: string): RegistryNode | undefined {
  const id = source.id.trim()
  if (id.length === 0) return undefined
  const facts: PresetFacts = {
    id,
    tools: [...(source.tools ?? [])].filter((tool) => tool.trim().length > 0),
    default: source.default === true,
  }
  return {
    id: `${NODE_ID_PREFIX.preset}${idFragment(id)}`,
    kind: 'preset',
    label: source.label ?? id,
    description: source.description ?? `Preset ${id}.`,
    source: { registry: 'presets', dynamic: false },
    preset: facts,
    accepts: [],
    produces: [],
    cost: { risk: 0 },
    tags: normalizeTags(source.tags, ['mode']),
    annotationVersion,
  }
}

function agentNode(source: AgentSource, annotationVersion: string): RegistryNode | undefined {
  const id = source.id.trim()
  if (id.length === 0) return undefined
  return {
    id: `${NODE_ID_PREFIX.agent}${idFragment(id)}`,
    kind: 'agent-role',
    label: source.label ?? id,
    description: source.description ?? `Agent role ${id}.`,
    source: { registry: 'agents', dynamic: false },
    accepts: [],
    produces: [],
    cost: { risk: 0.1 },
    tags: normalizeTags(source.tags, ['agent']),
    annotationVersion,
  }
}

function pluginNode(source: PluginSource, annotationVersion: string): RegistryNode | undefined {
  const name = source.name.trim()
  if (name.length === 0) return undefined
  return {
    id: `${NODE_ID_PREFIX.plugin}${idFragment(name)}`,
    kind: 'plugin',
    label: source.label ?? name,
    description: source.description ?? `Plugin ${name}.`,
    source: { registry: 'plugins', packageName: name, dynamic: source.dynamic === true },
    accepts: [],
    produces: [],
    cost: { risk: 0.05 },
    tags: normalizeTags(source.tags, ['plugin']),
    annotationVersion,
  }
}

function subagentNode(source: SubagentProviderSource, annotationVersion: string): RegistryNode | undefined {
  const provider = source.provider.trim()
  if (provider.length === 0) return undefined
  const facts: SubagentFacts = {
    provider,
    toolName: source.toolName ?? 'subagent',
    continuable: source.continuable ?? true,
    supportsAgentPreset: source.supportsAgentPreset ?? true,
    defaultMaxDepth: source.defaultMaxDepth ?? 1,
  }
  const produces = [required('child.report')]
  return {
    id: `${NODE_ID_PREFIX.subagent}${idFragment(provider)}`,
    kind: 'subagent-provider',
    label: provider,
    description: source.description ?? `Subagent provider ${provider}.`,
    source: { registry: 'subagents', ...(source.packageName === undefined ? {} : { packageName: source.packageName }), dynamic: false },
    subagent: facts,
    accepts: [],
    produces,
    cost: { risk: 0.2 },
    tags: normalizeTags(source.tags, ['orchestration']),
    annotationVersion,
  }
}

function sectionNode(source: SectionSource, annotationVersion: string): RegistryNode | undefined {
  const id = source.id.trim()
  if (id.length === 0) return undefined
  return {
    id: `${NODE_ID_PREFIX.section}${idFragment(id)}`,
    kind: 'surface',
    label: source.label ?? id,
    description: source.description ?? `System-prompt section ${id}.`,
    source: { registry: 'system-prompt', dynamic: source.dynamic === true },
    accepts: [],
    produces: [],
    cost: { tokensPerRequest: normalizeTokens(source.tokens) ?? 0, risk: 0 },
    tags: normalizeTags(source.tags, ['prompt-section']),
    annotationVersion,
  }
}

// ---------------------------------------------------------------------------
// Deterministic dedupe / ordering
// ---------------------------------------------------------------------------

function nodeRank(node: RegistryNode): number[] {
  return [node.tool?.dynamic === true ? 1 : 0, node.tool?.conditional === true ? 1 : 0]
}

function compareNodes(left: RegistryNode, right: RegistryNode): number {
  const byId = compareText(left.id, right.id)
  if (byId !== 0) return byId
  const leftRank = nodeRank(left)
  const rightRank = nodeRank(right)
  for (let index = 0; index < leftRank.length; index += 1) {
    const difference = (leftRank[index] as number) - (rightRank[index] as number)
    if (difference !== 0) return difference
  }
  return compareText(canonicalJson(canonicalValue(left) as Json), canonicalJson(canonicalValue(right) as Json))
}

function dedupeNodes(nodes: readonly RegistryNode[]): RegistryNode[] {
  const byId = new Map<string, RegistryNode>()
  for (const node of nodes) {
    const current = byId.get(node.id)
    if (current === undefined || compareNodes(node, current) < 0) byId.set(node.id, node)
  }
  return [...byId.values()].sort((left, right) => compareText(left.id, right.id))
}

// ---------------------------------------------------------------------------
// Edge builders
// ---------------------------------------------------------------------------

interface EdgeDraft {
  readonly from: NodeId
  readonly to: NodeId
  readonly kind: EdgeKind
  readonly weight: number
  readonly provenance: GraphEdge['provenance']
  readonly note: string
  readonly symmetric: boolean
}

function edgeIdDraft(draft: EdgeDraft): string {
  return `e:${draft.kind}:${draft.from}->${draft.to}`
}

function buildEdges(nodes: readonly RegistryNode[]): GraphEdge[] {
  const byId = new Map(nodes.map((node) => [node.id, node] as const))
  const tools = nodes.filter((node) => node.kind === 'tool' && node.tool !== undefined)
  const toolByName = new Map(tools.map((node) => [(node.tool as ToolFacts).name, node] as const))
  const drafts = new Map<string, EdgeDraft>()

  const add = (draft: EdgeDraft): void => {
    const id = edgeIdDraft(draft)
    const current = drafts.get(id)
    if (current === undefined || draft.weight > current.weight) drafts.set(id, draft)
  }

  // 1. Artifact contracts: producer -> consumer (`produces`).
  for (const producer of tools) {
    const produces = (producer.tool as ToolFacts).produces
    if (produces.length === 0) continue
    for (const consumer of tools) {
      if (consumer.id === producer.id) continue
      const accepted = new Set((consumer.tool as ToolFacts).accepts.map((artifact) => artifact.type))
      let best: { readonly type: ArtifactType; readonly weight: number } | undefined
      for (const artifact of produces) {
        if (!accepted.has(artifact.type)) continue
        const weight = ARTIFACT_EDGE_WEIGHTS[artifact.type]
        if (best === undefined || weight > best.weight) best = { type: artifact.type, weight }
      }
      if (best === undefined) continue
      add({
        from: producer.id,
        to: consumer.id,
        kind: 'produces',
        weight: best.weight,
        provenance: 'declared',
        note: `artifact ${best.type}`,
        symmetric: false,
      })
    }
  }

  // 2. Declared prerequisites (read-before-edit/write policy).
  for (const pair of REQUIRES_PAIRS) {
    const from = toolByName.get(pair.from)
    const to = toolByName.get(pair.to)
    if (from === undefined || to === undefined) continue
    add({ from: from.id, to: to.id, kind: 'requires', weight: pair.weight, provenance: 'declared', note: pair.note, symmetric: false })
  }

  // 3. Sandbox/approval gates: a privileged call requires its own gate.
  //    Self-edges keep the relation in the graph without inventing a fake node;
  //    the matcher ignores them for affinity, but `graph_status` and a consumer
  //    that traverses requires-edges can surface the gate.
  for (const node of tools) {
    const facts = node.tool as ToolFacts
    if (facts.permission !== 'privileged') continue
    add({
      from: node.id,
      to: node.id,
      kind: 'requires',
      weight: 1,
      provenance: 'declared',
      note: 'sandbox/approval gate: every call passes ctx.sandboxPolicy and the approval policy',
      symmetric: false,
    })
  }

  // 4. Known substitutes, both directions (symmetric typed relation).
  for (const pair of SUBSTITUTE_PAIRS) {
    const left = toolByName.get(pair.a)
    const right = toolByName.get(pair.b)
    if (left === undefined || right === undefined) continue
    add({ from: left.id, to: right.id, kind: 'substitutes', weight: pair.weight, provenance: 'declared', note: pair.note, symmetric: true })
    add({ from: right.id, to: left.id, kind: 'substitutes', weight: pair.weight, provenance: 'declared', note: pair.note, symmetric: true })
  }

  // 5. Weak same-domain clustering by curated tag (tiebreaker only).
  const tagIndex = new Map<string, RegistryNode[]>()
  for (const node of tools) {
    for (const tag of new Set(node.tags)) {
      if (GENERIC_TAGS.has(tag)) continue
      const members = tagIndex.get(tag) ?? []
      members.push(node)
      tagIndex.set(tag, members)
    }
  }
  const pairTags = new Map<string, { readonly left: RegistryNode; readonly right: RegistryNode; readonly tags: string[] }>()
  for (const tag of [...tagIndex.keys()].sort(compareText)) {
    const members = (tagIndex.get(tag) ?? []).sort((left, right) => compareText(left.id, right.id))
    for (let left = 0; left < members.length; left += 1) {
      for (let right = left + 1; right < members.length; right += 1) {
        const first = members[left] as RegistryNode
        const second = members[right] as RegistryNode
        const key = `${first.id}|${second.id}`
        const entry = pairTags.get(key) ?? { left: first, right: second, tags: [] }
        entry.tags.push(tag)
        pairTags.set(key, entry)
      }
    }
  }
  for (const key of [...pairTags.keys()].sort(compareText)) {
    const { left, right, tags } = pairTags.get(key) as { readonly left: RegistryNode; readonly right: RegistryNode; readonly tags: string[] }
    const shared = [...new Set(tags)].sort(compareText)
    const weight = Math.min(0.5, 0.25 + 0.05 * (shared.length - 1))
    const note = `same-domain tags: ${shared.join(', ')}`
    add({ from: left.id, to: right.id, kind: 'similar', weight, provenance: 'declared', note, symmetric: true })
    add({ from: right.id, to: left.id, kind: 'similar', weight, provenance: 'declared', note, symmetric: true })
  }

  return [...drafts.entries()]
    .sort(([left], [right]) => compareText(left, right))
    .map(([id, draft]) => ({
      id,
      from: draft.from,
      to: draft.to,
      kind: draft.kind,
      weight: clamp01(draft.weight),
      provenance: draft.provenance,
      evidence: { note: draft.note },
      ...(draft.symmetric ? { symmetric: true } : {}),
    }))
}

// ---------------------------------------------------------------------------
// Snapshot builder
// ---------------------------------------------------------------------------

function previousCursor(previous: RegistrySnapshotCursor | undefined): { version: number; digest: string; buildTick: number } | undefined {
  if (previous === undefined) return undefined
  if ('graph' in previous) return { version: previous.version, digest: previous.digest, buildTick: previous.graph.buildTick }
  return { version: previous.version, digest: previous.digest, buildTick: previous.buildTick }
}

function snapshotSources(sources: RegistrySources): RegistrySnapshotSource[] {
  const entries: RegistrySnapshotSource[] = []
  const push = (registry: string, count: number | undefined): void => {
    if (count !== undefined) entries.push({ registry, count, lastChangeSeq: 0 })
  }
  push('tools', sources.tools?.length)
  push('system-prompt', sources.sections?.length)
  push('skills', sources.skills?.length)
  push('presets', sources.presets?.length)
  push('subagents', sources.providers?.length)
  push('plugins', sources.plugins?.length)
  push('agents', sources.agents?.length)
  return entries
}

/**
 * Build a complete capability-graph snapshot from the injected registries.
 *
 * Pure and deterministic: identical sources always produce an identical
 * digest. `previous` only supplies the monotonic counters: `version` and
 * `buildTick` are kept when the digest is unchanged and bumped by one when the
 * capability graph actually changed. The first build starts at version 0 /
 * buildTick 0.
 *
 * @param sources - synchronous registry facts; any subset may be omitted.
 * @param previous - the last snapshot (or cursor), used for the counters.
 * @returns snapshot with a validated graph, digest and warnings.
 * @throws when the constructed graph would violate `validateRegistryGraph`
 *         (a bug in this builder or an id collision it cannot resolve).
 */
export function buildRegistrySnapshot(
  sources: RegistrySources,
  previous?: RegistrySnapshotCursor,
): RegistrySnapshot {
  const annotationVersion = sources.annotationVersion ?? DEFAULT_ANNOTATION_VERSION
  const candidates: RegistryNode[] = []
  for (const source of sources.tools ?? []) {
    const node = toolNode(source, annotationVersion)
    if (node !== undefined) candidates.push(node)
  }
  for (const source of sources.sections ?? []) {
    const node = sectionNode(source, annotationVersion)
    if (node !== undefined) candidates.push(node)
  }
  for (const source of sources.skills ?? []) {
    const node = skillNode(source, annotationVersion)
    if (node !== undefined) candidates.push(node)
  }
  for (const source of sources.presets ?? []) {
    const node = presetNode(source, annotationVersion)
    if (node !== undefined) candidates.push(node)
  }
  for (const source of sources.agents ?? []) {
    const node = agentNode(source, annotationVersion)
    if (node !== undefined) candidates.push(node)
  }
  for (const source of sources.plugins ?? []) {
    const node = pluginNode(source, annotationVersion)
    if (node !== undefined) candidates.push(node)
  }
  for (const source of sources.providers ?? []) {
    const node = subagentNode(source, annotationVersion)
    if (node !== undefined) candidates.push(node)
  }

  const nodes = dedupeNodes(candidates)
  const edges = buildEdges(nodes)
  const digest = digestGraph({ nodes, edges })
  const cursor = previousCursor(previous)
  const changed = cursor !== undefined && cursor.digest !== digest
  const version = cursor === undefined ? 0 : changed ? cursor.version + 1 : cursor.version
  const buildTick = cursor === undefined ? 0 : changed ? cursor.buildTick + 1 : cursor.buildTick

  const warnings: string[] = []
  for (const node of nodes) {
    if (node.kind !== 'tool' || node.tool === undefined) continue
    if (node.tool.dynamic) {
      warnings.push(
        `dynamic tool "${node.tool.name}" is discovered after a runtime event; it is excluded from static matching`,
      )
    }
    if (node.tool.conditional) {
      warnings.push(
        `conditional tool "${node.tool.name}" is registered per step; its availability depends on the resolved tool set`,
      )
    }
  }
  warnings.sort(compareText)

  const graph: RegistryGraph = {
    version,
    digest,
    nodes,
    edges,
    sources: snapshotSources(sources),
    warnings,
    buildTick,
  }
  const validation = validateRegistryGraph(graph)
  if (!validation.ok) {
    const first = validation.errors[0]
    throw new Error(`registry snapshot invariant violated: ${first ? `${first.code} ${first.path}: ${first.message}` : 'unknown error'}`)
  }
  return { version, digest, graph, warnings }
}
