/**
 * envelope.ts — the per-turn capability envelope.
 *
 * The envelope is what the composition layer fixes before any step runs: the
 * router resolves abstract capability roles to concrete registry nodes and
 * compiles the result into an envelope that is fixed for the whole turn.
 *
 * Design constraints:
 *   - pure and deterministic: same (roles, registry digest, budget) -> same envelope
 *     id and identical tool order, so the request prefix is stable within a turn;
 *   - the envelope owns TOOLS and the prompt/skill/memory policy, not the plan;
 *   - conditional / dynamic tools are unstable by default and are dropped unless
 *     the caller opts in, because a vanishing schema invalidates the prefix;
 *   - failures are explicit: an unresolved required role or a missing explicit
 *     tool sets `fallbackToStock`, and the caller runs the stock single step.
 *
 * No I/O, no clock, no DSH imports: this module is consumed by the router, the
 * control plane and tests alike.
 */

import type {
  ArtifactType,
  CapabilityKind,
  NodeId,
  PermissionClass,
  RegistryGraph,
  RegistryNode,
} from './graph-schema.ts'
import { hash16, type IntentClass, type TaskFingerprint } from './matching.ts'
import { DEFAULT_ENVELOPE, type RunEnvelope } from './runtime.ts'

// ---------------------------------------------------------------------------
// Roles: the ecosystem binding vocabulary
// ---------------------------------------------------------------------------

/**
 * A predicate over registry nodes. Every present field is ANDed; `tags` are
 * ALL required, while `produces` / `accepts` / `permissions` / patterns are
 * any-of. Omitted fields place no constraint, so an empty match matches every
 * node of the requested kinds — callers should always narrow something.
 */
export interface RoleMatch {
  /** Capability kinds to consider. Defaults to `['tool']`. */
  readonly kinds?: readonly CapabilityKind[]
  /** Every one of these curated tags must be present. */
  readonly tags?: readonly string[]
  /** Allowed permission classes; a node outside the list is rejected. */
  readonly permissions?: readonly PermissionClass[]
  /** Regular-expression sources tested against the tool name. */
  readonly toolNamePatterns?: readonly string[]
  /** Regular-expression sources tested against the source package name. */
  readonly packagePatterns?: readonly string[]
  /** Any of these artifact types must be produced by the node. */
  readonly produces?: readonly string[]
  /** Any of these artifact types must be accepted by the node. */
  readonly accepts?: readonly string[]
}

/**
 * One role a template or router can ask for. `implementations` is the escape
 * hatch for names that are not annotated with tags: it matches the concrete
 * tool name, node id, package name, or a prefix of either.
 */
export interface CapabilityRoleSpec {
  readonly role: string
  readonly description?: string
  /** A missing required role blocks the envelope (fallback to stock). */
  readonly required?: boolean
  /** Maximum tools selected for this role; default 16. */
  readonly maxTools?: number
  readonly match?: RoleMatch
  readonly implementations?: readonly string[]
}

/** One concrete node a role resolved to. */
export interface RoleCandidate {
  readonly nodeId: NodeId
  readonly name: string
  readonly kind: CapabilityKind
  readonly packageName?: string
  readonly schemaTokens: number
  /** Registered conditionally or appearing only after a runtime event. */
  readonly unstable: boolean
}

export interface RoleResolution {
  readonly role: string
  readonly required: boolean
  readonly matched: readonly RoleCandidate[]
  readonly selected: readonly RoleCandidate[]
  readonly issues: readonly EnvelopeIssue[]
}

// ---------------------------------------------------------------------------
// Envelope
// ---------------------------------------------------------------------------

export type EnvelopeIssueCode =
  | 'role-unresolved'
  | 'role-empty'
  | 'role-truncated'
  | 'tool-not-found'
  | 'tool-denied'
  | 'tool-unstable-excluded'
  | 'max-tools-exceeded'
  | 'skill-not-found'
  | 'section-not-found'
  | 'envelope-empty'

export interface EnvelopeIssue {
  readonly code: EnvelopeIssueCode
  readonly severity: 'error' | 'warning'
  readonly detail: string
  readonly role?: string
}

export interface EnvelopeMemory {
  /** `conversation-only` injects nothing; `selected` renders the selected context. */
  readonly mode: 'conversation-only' | 'selected'
  /** Upper bound on selected context bytes rendered into the node section. */
  readonly maxBytes: number
}

export interface EnvelopeModel {
  readonly provider: string
  readonly model: string
  readonly reasoningEffort?: string
}

export interface EnvelopeRequest {
  /** Optional stable id; when absent a content hash is used. */
  readonly id?: string
  readonly roles: readonly CapabilityRoleSpec[]
  /** Tools that are always included, on top of the roles (template pins). */
  readonly extraTools?: readonly string[]
  /** Tools removed after resolution (hard deny). */
  readonly denyTools?: readonly string[]
  /** Catalog skill names to make available. */
  readonly skills?: readonly string[]
  /** System-prompt section ids to keep available. */
  readonly promptSections?: readonly string[]
  readonly memory?: EnvelopeMemory
  readonly model?: EnvelopeModel
  readonly budget?: Partial<RunEnvelope>
  /** Total tool cap. Default 64; exceeding it is an error, never a silent truncation. */
  readonly maxTools?: number
  /** Include conditional/dynamic tools. Default false. */
  readonly allowUnstable?: boolean
}

export interface CapabilityEnvelope {
  /** Deterministic `env_<16 hex>` unless the request supplied an id. */
  readonly id: string
  readonly roles: readonly {
    readonly role: string
    readonly nodeIds: readonly NodeId[]
  }[]
  readonly tools: {
    /** Concrete tool names, sorted; this is `TaskPlan.toolUniverse`. */
    readonly universe: readonly string[]
    readonly deny: readonly string[]
    /** Sum of measured/estimated schema tokens for the selected tools. */
    readonly schemaTokens: number
    /** Selected tools that are conditional or dynamic (empty by default). */
    readonly unstable: readonly string[]
  }
  readonly skills: readonly string[]
  readonly promptSections: readonly string[]
  readonly memory: EnvelopeMemory
  readonly model?: EnvelopeModel
  readonly budget: RunEnvelope
  /** Every node the envelope selected (tools + skills + sections), for trace. */
  readonly capabilityIds: readonly NodeId[]
}

export interface EnvelopeDecision {
  readonly envelope: CapabilityEnvelope
  readonly roles: readonly RoleResolution[]
  readonly issues: readonly EnvelopeIssue[]
  /** True when any error issue fired; the caller must run the stock fallback. */
  readonly fallbackToStock: boolean
}

// ---------------------------------------------------------------------------
// Default role vocabulary
// ---------------------------------------------------------------------------

/**
 * Roles every deployment can resolve without annotations. This vocabulary is
 * deliberately tool-agnostic: it names capabilities (read, search, write,
 * shell, web, delegate, plan, deliver), never a product or a craft family.
 *
 * Any other tool participates through data, not through a new built-in role:
 *   - `TagSource.tags` / `ToolSource.tags` annotations,
 *   - `produces` / `accepts` artifact annotations (see `artifactRoleSpec`),
 *   - an explicit `implementations` list in a template,
 *   - a task hint naming the tool, or
 *   - the active preset's tool list.
 */
export const DEFAULT_ROLE_LIBRARY: readonly CapabilityRoleSpec[] = [
  {
    role: 'workspace-read',
    description: 'Read files and list the workspace (optional: not every task has a workspace).',
    match: { tags: ['filesystem'], permissions: ['read-only'] },
  },
  {
    role: 'workspace-search',
    description: 'Find files and search their contents (local workspace only).',
    match: { tags: ['search'], permissions: ['read-only'] },
  },
  {
    role: 'workspace-write',
    description: 'Create or edit workspace files.',
    match: { tags: ['mutation'] },
  },
  {
    role: 'shell',
    description: 'Run shell commands for build/test/inspection.',
    match: { tags: ['shell'] },
  },
  {
    role: 'verification',
    description: 'Prove a change worked (tests, checks, diagnostics).',
    match: { tags: ['verification'] },
  },
  {
    role: 'web',
    description: 'Search and read the web.',
    match: { tags: ['web'] },
  },
  {
    role: 'delegation',
    description: 'Start a child agent.',
    match: { kinds: ['subagent-provider'] },
  },
  {
    role: 'planning',
    description: 'Maintain a plan or todo list.',
    match: { tags: ['planning'] },
  },
  {
    role: 'delivery',
    description: 'Declare final deliverables.',
    match: { tags: ['delivery'] },
  },
]

/** Lookup a default role by name. */
export function defaultRole(role: string): CapabilityRoleSpec | undefined {
  return DEFAULT_ROLE_LIBRARY.find(candidate => candidate.role === role)
}

/**
 * A role addressable by artifact type rather than by product name. This is the
 * generic bridge between a task's declared outputs and any tool, annotated or
 * not: `produces:file.text` is resolvable by every tool that declares it
 * produces a text file, whatever package it comes from.
 */
export function artifactRoleSpec(
  type: ArtifactType,
  direction: 'produces' | 'accepts' = 'produces',
): CapabilityRoleSpec {
  return direction === 'produces'
    ? { role: `produces:${type}`, match: { produces: [type] } }
    : { role: `accepts:${type}`, match: { accepts: [type] } }
}

/** A role addressable by any curated/annotated tag: the escape hatch for new domains. */
export function tagRoleSpec(tag: string): CapabilityRoleSpec {
  return { role: `tag:${tag}`, match: { tags: [tag] } }
}

// ---------------------------------------------------------------------------
// Resolution
// ---------------------------------------------------------------------------

function nodeName(node: RegistryNode): string {
  return node.tool?.name ?? node.label ?? node.id
}

function nodePackage(node: RegistryNode): string | undefined {
  return node.source.packageName ?? node.tool?.packageName
}

function isUnstable(node: RegistryNode): boolean {
  return node.tool?.conditional === true || node.tool?.dynamic === true
}

function matchesImplementation(node: RegistryNode, implementation: string): boolean {
  const name = nodeName(node)
  const pkg = nodePackage(node)
  if (node.id === implementation || node.id === `tool:${implementation}`) return true
  for (const prefix of ['_', '.', ':', '/']) {
    if (name.startsWith(`${implementation}${prefix}`)) return true
  }
  if (name === implementation) return true
  if (pkg === undefined) return false
  if (pkg === implementation) return true
  if (pkg.startsWith(`${implementation}/`) || pkg.startsWith(`${implementation}-`)) return true
  if (pkg.includes(`/${implementation}`) || pkg.endsWith(`-${implementation}`)) return true
  return false
}

function matchesPatterns(value: string | undefined, patterns: readonly string[]): boolean {
  if (value === undefined) return false
  return patterns.some((source) => {
    try {
      return new RegExp(source, 'u').test(value)
    } catch {
      return false
    }
  })
}

function matchesRole(node: RegistryNode, match: RoleMatch): boolean {
  if (match.tags !== undefined && match.tags.length > 0) {
    if (!match.tags.every(tag => node.tags.includes(tag))) return false
  }
  if (match.permissions !== undefined && match.permissions.length > 0) {
    const permission = node.tool?.permission
    if (permission === undefined || !match.permissions.includes(permission)) return false
  }
  if (match.toolNamePatterns !== undefined && match.toolNamePatterns.length > 0) {
    if (!matchesPatterns(nodeName(node), match.toolNamePatterns)) return false
  }
  if (match.packagePatterns !== undefined && match.packagePatterns.length > 0) {
    if (!matchesPatterns(nodePackage(node), match.packagePatterns)) return false
  }
  if (match.produces !== undefined && match.produces.length > 0) {
    const produced = node.produces.map(spec => spec.type)
    if (!match.produces.some(type => produced.includes(type as ArtifactType))) return false
  }
  if (match.accepts !== undefined && match.accepts.length > 0) {
    const accepted = node.accepts.map(spec => spec.type)
    if (!match.accepts.some(type => accepted.includes(type as ArtifactType))) return false
  }
  return true
}

function candidateOf(node: RegistryNode): RoleCandidate {
  return {
    nodeId: node.id,
    name: nodeName(node),
    kind: node.kind,
    ...(nodePackage(node) === undefined ? {} : { packageName: nodePackage(node) }),
    schemaTokens: node.tool?.schemaTokens ?? 0,
    unstable: isUnstable(node),
  }
}

/**
 * Resolve one role against a registry snapshot.
 *
 * Stable candidates are preferred; when `allowUnstable` is false the unstable
 * ones are dropped with a warning. Selection is deterministic: cheapest schema
 * first, then node id, capped by `maxTools`.
 */
export function resolveRole(
  spec: CapabilityRoleSpec,
  graph: RegistryGraph,
  options: { readonly allowUnstable?: boolean } = {},
): RoleResolution {
  const issues: EnvelopeIssue[] = []
  const kinds = spec.match?.kinds ?? ['tool']
  const allowUnstable = options.allowUnstable === true
  let matched = graph.nodes.filter(node => kinds.includes(node.kind))

  if (spec.implementations !== undefined && spec.implementations.length > 0) {
    matched = matched.filter(node => spec.implementations!.some(impl => matchesImplementation(node, impl)))
  } else if (spec.match !== undefined) {
    matched = matched.filter(node => matchesRole(node, spec.match!))
  } else {
    issues.push({
      code: 'role-unresolved',
      severity: 'error',
      role: spec.role,
      detail: `role ${spec.role} has neither match nor implementations`,
    })
    return { role: spec.role, required: spec.required === true, matched: [], selected: [], issues }
  }

  const unstable = matched.filter(isUnstable)
  if (!allowUnstable && unstable.length > 0) {
    matched = matched.filter(node => !isUnstable(node))
    issues.push({
      code: 'tool-unstable-excluded',
      severity: 'warning',
      role: spec.role,
      detail: `role ${spec.role} excluded ${unstable.length} conditional/dynamic tool(s)`,
    })
  }

  const candidates = matched
    .map(candidateOf)
    .sort((left, right) => left.schemaTokens - right.schemaTokens || (left.nodeId < right.nodeId ? -1 : left.nodeId > right.nodeId ? 1 : 0))

  const limit = spec.maxTools ?? 16
  const selected = candidates.slice(0, limit)
  if (candidates.length > limit) {
    issues.push({
      code: 'role-truncated',
      severity: 'warning',
      role: spec.role,
      detail: `role ${spec.role} matched ${candidates.length} tools; kept the ${limit} cheapest`,
    })
  }

  if (selected.length === 0) {
    const required = spec.required === true
    issues.push({
      code: required ? 'role-unresolved' : 'role-empty',
      severity: required ? 'error' : 'warning',
      role: spec.role,
      detail: required ? `required role ${spec.role} resolved to nothing` : `optional role ${spec.role} resolved to nothing`,
    })
  }

  return { role: spec.role, required: spec.required === true, matched: candidates, selected, issues }
}

// ---------------------------------------------------------------------------
// Envelope build
// ---------------------------------------------------------------------------

function envelopeHash(envelope: Omit<CapabilityEnvelope, 'id'>): string {
  return `env_${hash16(JSON.stringify({
    roles: envelope.roles,
    tools: envelope.tools.universe,
    deny: envelope.tools.deny,
    skills: envelope.skills,
    promptSections: envelope.promptSections,
    memory: envelope.memory,
    model: envelope.model ?? null,
    budget: envelope.budget,
  }))}`
}

/**
 * Compile an envelope from explicit roles. This is the pure core used by the
 * router and by tests; it performs no DSH I/O and falls back on any error.
 */
export function buildEnvelope(request: EnvelopeRequest, graph: RegistryGraph): EnvelopeDecision {
  const issues: EnvelopeIssue[] = []
  const resolutions = request.roles.map(role => resolveRole(role, graph, { allowUnstable: request.allowUnstable === true }))
  for (const resolution of resolutions) issues.push(...resolution.issues)

  const byName = new Map<string, RegistryNode>()
  for (const node of graph.nodes) {
    if (node.kind === 'tool' && node.tool !== undefined) byName.set(node.tool.name, node)
  }

  const selectedTools = new Set<string>()
  const selectedIds = new Set<NodeId>()
  for (const resolution of resolutions) {
    for (const candidate of resolution.selected) {
      if (candidate.kind !== 'tool') {
        selectedIds.add(candidate.nodeId)
        continue
      }
      if (byName.has(candidate.name)) selectedTools.add(candidate.name)
      selectedIds.add(candidate.nodeId)
    }
  }

  for (const name of request.extraTools ?? []) {
    if (!byName.has(name)) {
      issues.push({ code: 'tool-not-found', severity: 'error', detail: `explicit tool ${name} is not registered` })
      continue
    }
    selectedTools.add(name)
    selectedIds.add(byName.get(name)!.id)
  }

  const deny = new Set(request.denyTools ?? [])
  for (const name of [...selectedTools]) {
    if (deny.has(name)) {
      selectedTools.delete(name)
      issues.push({ code: 'tool-denied', severity: 'warning', detail: `tool ${name} is denied by the envelope` })
    }
  }

  const universe = [...selectedTools].sort()
  const maxTools = request.maxTools ?? 64
  if (universe.length > maxTools) {
    issues.push({
      code: 'max-tools-exceeded',
      severity: 'error',
      detail: `envelope selected ${universe.length} tools, over the ${maxTools} cap`,
    })
  }
  if (universe.length === 0) {
    issues.push({ code: 'envelope-empty', severity: 'error', detail: 'envelope selected no tools' })
  }

  const skills = [...new Set(request.skills ?? [])].sort()
  for (const skill of skills) {
    if (!graph.nodes.some(node => node.id === `skill:${skill}`)) {
      issues.push({ code: 'skill-not-found', severity: 'error', detail: `skill ${skill} is not registered` })
    } else {
      selectedIds.add(`skill:${skill}`)
    }
  }

  const promptSections = [...new Set(request.promptSections ?? [])].sort()
  for (const section of promptSections) {
    if (!graph.nodes.some(node => node.id === `section:${section}`)) {
      issues.push({ code: 'section-not-found', severity: 'error', detail: `prompt section ${section} is not registered` })
    } else {
      selectedIds.add(`section:${section}`)
    }
  }

  const schemaTokens = universe.reduce((total, name) => total + (byName.get(name)?.tool?.schemaTokens ?? 0), 0)
  const unstableTools = universe.filter(name => isUnstable(byName.get(name)!))

  const memory: EnvelopeMemory = request.memory ?? { mode: 'conversation-only', maxBytes: 8_192 }
  const budget: RunEnvelope = { ...DEFAULT_ENVELOPE, ...(request.budget ?? {}) }

  const base: Omit<CapabilityEnvelope, 'id'> = {
    roles: resolutions.map(resolution => ({
      role: resolution.role,
      nodeIds: resolution.selected.map(candidate => candidate.nodeId),
    })),
    tools: { universe, deny: [...deny].sort(), schemaTokens, unstable: unstableTools },
    skills,
    promptSections,
    memory,
    ...(request.model === undefined ? {} : { model: request.model }),
    budget,
    capabilityIds: [...selectedIds].sort(),
  }
  const envelope: CapabilityEnvelope = { id: request.id ?? envelopeHash(base), ...base }

  return {
    envelope,
    roles: resolutions,
    issues,
    fallbackToStock: issues.some(issue => issue.severity === 'error'),
  }
}

// ---------------------------------------------------------------------------
// Task-driven selection
// ---------------------------------------------------------------------------

export interface SelectEnvelopeInput {
  readonly fingerprint: TaskFingerprint
  readonly graph: RegistryGraph
  /** Role library; defaults to `DEFAULT_ROLE_LIBRARY`. */
  readonly library?: readonly CapabilityRoleSpec[]
  /** Extra roles required by the matched template. */
  readonly templateRoles?: readonly CapabilityRoleSpec[]
  /**
   * The active preset's tool list, when the caller has it. With
   * `includePresetTools: true` those tools stay callable even when they are not
   * annotated; this is the generic safety net for unannotated third-party tools.
   */
  readonly presetTools?: readonly string[]
  readonly includePresetTools?: boolean
  readonly allowUnstable?: boolean
  readonly maxTools?: number
  readonly budget?: Partial<RunEnvelope>
  readonly model?: EnvelopeModel
  readonly promptSections?: readonly string[]
}

const RESEARCH_INTENTS: ReadonlySet<IntentClass> = new Set(['research', 'fact-finding', 'wide-research'])
const MUTATING_INTENTS: ReadonlySet<IntentClass> = new Set(['code-change', 'bug-fix', 'test-failure', 'document', 'data-analysis'])

/**
 * Choose roles from a task fingerprint, then compile the envelope.
 *
 * This is the deterministic first pass of the router. The rules are generic:
 * base workspace roles, write/shell/verify for mutating work, web for research,
 * and one `produces:<artifact>` role per declared output. No product or craft
 * name appears here. A template can add roles through `templateRoles`; tools
 * named by the user are carried through as hints; the preset list can be kept
 * as a generic baseline with `includePresetTools`.
 */
export function selectEnvelopeForTask(input: SelectEnvelopeInput): EnvelopeDecision {
  const library = new Map<string, CapabilityRoleSpec>()
  for (const role of [...(input.library ?? DEFAULT_ROLE_LIBRARY), ...(input.templateRoles ?? [])]) {
    library.set(role.role, role)
  }

  const roles: CapabilityRoleSpec[] = []
  const addSpec = (role: CapabilityRoleSpec): void => {
    if (!roles.some(existing => existing.role === role.role)) roles.push(role)
  }
  const add = (name: string): void => {
    const role = library.get(name)
    if (role === undefined) {
      addSpec({ role: name, required: true, match: { tags: [`role:${name}`] } })
      return
    }
    addSpec(role)
  }

  add('workspace-read')
  add('workspace-search')
  if (input.fingerprint.mutating || MUTATING_INTENTS.has(input.fingerprint.intent)) {
    add('workspace-write')
    add('shell')
    add('verification')
  }
  if (RESEARCH_INTENTS.has(input.fingerprint.intent)) add('web')

  // Generic artifact binding: any tool that declares it produces the artifact
  // type is a candidate, regardless of its name, package or craft family.
  for (const artifact of input.fingerprint.artifactsOut) addSpec(artifactRoleSpec(artifact))

  // Template roles are part of the envelope by definition, whether or not the
  // default library knows their name.
  for (const templateRole of input.templateRoles ?? []) addSpec(templateRole)

  const toolNames = new Set(input.graph.nodes.filter(node => node.kind === 'tool').map(node => node.tool?.name))
  const extraTools = new Set<string>()
  for (const hint of input.fingerprint.hints) {
    if (toolNames.has(hint)) extraTools.add(hint)
  }
  if (input.includePresetTools === true) {
    for (const name of input.presetTools ?? []) {
      if (toolNames.has(name)) extraTools.add(name)
    }
  }

  return buildEnvelope(
    {
      roles,
      ...(extraTools.size === 0 ? {} : { extraTools: [...extraTools].sort() }),
      allowUnstable: input.allowUnstable === true,
      ...(input.maxTools === undefined ? {} : { maxTools: input.maxTools }),
      ...(input.budget === undefined ? {} : { budget: input.budget }),
      ...(input.model === undefined ? {} : { model: input.model }),
      ...(input.promptSections === undefined ? {} : { promptSections: input.promptSections }),
    },
    input.graph,
  )
}
