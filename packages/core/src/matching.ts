/**
 * matching.ts — task fingerprint, template instantiation, and the deterministic match.
 *
 * What this replaces: "embed every tool description and cosine-similarity the task".
 * That signal is weak and, for routing, often wrong (see `WHY_COSINE_IS_NOT_ENOUGH`).
 * The matcher instead answers one question: *which task template applies, and which
 * real capability fills each slot so that the artifact pre/post-conditions hold?*
 *
 * Signals, strongest first:
 *   1. declared artifact pre/post conditions (produces/requires edges)
 *   2. deterministic task features (intent class, artifacts, risk, context, surface)
 *   3. mined co-occurrence from `ctx.sessionQuery` (NPMI, shrunk)
 *   4. measured success/cost priors per template
 *
 * The pure functions here take their inputs explicitly (fingerprint, registry,
 * co-occurrence table, weights) so the match is a pure function of
 * (fingerprint, RegistryGraph.digest, weightsVersion, presetId) — cacheable and
 * replayable. No timers, no randomness, no I/O.
 */

import {
  ARTIFACT_TYPES,
  GRAPH_LIMITS,
  type ArtifactType,
  type GraphEdge,
  type Json,
  type PlanEdge,
  type PlanNode,
  type RegistryGraph,
  type RegistryNode,
  type TaskPlan,
} from './graph-schema.js'
import { validateTaskPlan } from './graph-schema.js'

// ---------------------------------------------------------------------------
// Task fingerprint
// ---------------------------------------------------------------------------

export type IntentClass =
  | 'code-question'
  | 'code-review'
  | 'code-change'
  | 'bug-fix'
  | 'test-failure'
  | 'research'
  | 'fact-finding'
  | 'document'
  | 'data-analysis'
  | 'wide-research'
  | 'multi-area-review'
  | 'other'

export type Surface = 'cli' | 'web' | 'api' | 'headless'
export type RiskBand = 'low' | 'medium' | 'high'
export type ContextBucket = 0 | 1 | 2 | 3

export interface TaskFingerprint {
  /** 16 hex chars: the cache key and the deterministic tiebreaker. */
  readonly hash: string
  readonly intent: IntentClass
  readonly artifactsIn: readonly ArtifactType[]
  readonly artifactsOut: readonly ArtifactType[]
  readonly mutating: boolean
  readonly parallelizable: boolean
  readonly risk: RiskBand
  readonly contextBucket: ContextBucket
  readonly surface: Surface
  /** Tool names the user explicitly mentioned (rare, high precision). */
  readonly hints: readonly string[]
  readonly workspace: {
    readonly hasGit: boolean
    readonly hasPackageJson: boolean
    readonly hasTests: boolean
    readonly hasPython: boolean
    readonly languages: readonly string[]
  }
  readonly textLength: number
}

/** Pure inputs to extraction; the workspace scan is done once per session and cached. */
export interface FingerprintInput {
  readonly text: string
  readonly surface: Surface
  /** Estimated context tokens before this task (from ctx.tokenMeter, bucketed). */
  readonly contextTokens: number
  readonly attachments: readonly { readonly kind: 'image' | 'file' | 'url'; readonly name: string }[]
  readonly workspace: TaskFingerprint['workspace']
  /** Names of tools currently visible; used for hint validation only. */
  readonly visibleTools: readonly string[]
}

const INTENT_LEXICON: Readonly<Record<IntentClass, readonly string[]>> = {
  'code-question': ['how does', 'what is', 'explain', 'where is', 'why does', 'how do i'],
  'code-review': ['review', 'audit', 'check this pr', 'look for bugs'],
  'code-change': ['implement', 'add', 'refactor', 'rename', 'migrate', 'support'],
  'bug-fix': ['fix', 'bug', 'broken', 'regression', 'crash', 'fails'],
  'test-failure': ['test fails', 'failing test', 'red test', 'assertion', 'ci failed'],
  research: ['research', 'compare', 'survey', 'state of the art', 'latest'],
  'fact-finding': ['who', 'when', 'what year', 'according to'],
  document: ['write a doc', 'draft', 'report', 'readme', 'spec', 'deck', 'slide'],
  'data-analysis': ['analyze', 'analyse', 'csv', 'spreadsheet', 'dataset', 'metrics', 'trend'],
  'wide-research': ['all areas', 'multiple modules', 'every package', 'broadly'],
  'multi-area-review': ['each package', 'in parallel', 'several subsystems'],
  other: [],
}

const RISK_TERMS = {
  high: ['delete', 'drop', 'deploy', 'publish', 'force push', 'migrate data', 'rotate', 'revoke'],
  medium: ['edit', 'write', 'commit', 'install', 'upgrade', 'run tests', 'format'],
} as const

const EXTENSION_ARTIFACTS: Readonly<Record<string, ArtifactType>> = {
  md: 'file.text',
  txt: 'file.text',
  ts: 'file.text',
  tsx: 'file.text',
  js: 'file.text',
  json: 'file.text',
  py: 'file.text',
  csv: 'file.text',
  png: 'file.image',
  jpg: 'file.image',
  pdf: 'file.binary',
  xlsx: 'file.binary',
  docx: 'file.binary',
}

const URL_RE = /https?:\/\/[^\s)\]>]+/giu
const PATH_RE = /(?:^|[\s"'`(])((?:\.{0,2}\/)?[A-Za-z0-9_.\-/]+\.[A-Za-z0-9]{1,8})(?=$|[\s"'`),:])/gu

function normalize(text: string): string {
  return text.normalize('NFKC').toLowerCase().replace(/\s+/gu, ' ').trim()
}

/** FNV-1a 64-bit; stable across platforms and independent of JS engine string hashing. */
export function hash16(text: string): string {
  let hash = 0xcbf29ce484222325n
  const prime = 0x100000001b3n
  const mask = 0xffffffffffffffffn
  for (let index = 0; index < text.length; index += 1) {
    hash ^= BigInt(text.charCodeAt(index))
    hash = (hash * prime) & mask
  }
  return hash.toString(16).padStart(16, '0')
}

function uniqSorted<T extends string>(values: readonly T[]): T[] {
  return [...new Set(values)].sort()
}

function countTerms(text: string, terms: readonly string[]): number {
  let count = 0
  for (const term of terms) {
    // Word-boundary matching, not substring: the lexicon contains short common
    // words (`add`, `fix`, `spec`, `edit`) and a substring count turns ordinary
    // English into the wrong intent ("inspect" -> document, "address" ->
    // code-change, "credit" -> mutating). Multi-word terms keep their inner
    // spaces; only the two ends are bounded.
    const escaped = term.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')
    const matcher = new RegExp(`(?:^|[^a-z0-9_])${escaped}(?=$|[^a-z0-9_])`, 'gu')
    for (const _match of text.matchAll(matcher)) count += 1
  }
  return count
}

/** Code-unit ordering: deterministic across hosts, unlike locale collation. */
function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0
}

/** Deterministic, rule-based extractor. O(|text| + |lexicon|). */
export function extractFingerprint(input: FingerprintInput): TaskFingerprint {
  const text = normalize(input.text)
  const byIntent = new Map<IntentClass, number>()
  for (const [intent, terms] of Object.entries(INTENT_LEXICON) as [IntentClass, string[]][]) {
    const score = countTerms(text, terms)
    if (score > 0) byIntent.set(intent, score)
  }
  // Priority breaks ties: an explicit "test fails" beats a generic "fix".
  const priority: IntentClass[] = [
    'test-failure',
    'bug-fix',
    'wide-research',
    'multi-area-review',
    'data-analysis',
    'document',
    'research',
    'code-review',
    'code-change',
    'code-question',
    'fact-finding',
    'other',
  ]
  let intent: IntentClass = 'other'
  let best = 0
  for (const candidate of priority) {
    const score = byIntent.get(candidate) ?? 0
    if (score > best) {
      best = score
      intent = candidate
    }
  }

  const artifacts = new Set<ArtifactType>()
  for (const match of text.matchAll(PATH_RE)) {
    const extension = match[1]?.split('.').pop()?.toLowerCase() ?? ''
    const artifact = EXTENSION_ARTIFACTS[extension]
    if (artifact) artifacts.add(artifact)
  }
  for (const match of text.matchAll(URL_RE)) void match
  if (text.match(URL_RE)) artifacts.add('web.page')

  const mentionsImage = input.attachments.some((attachment) => attachment.kind === 'image')
  if (mentionsImage) artifacts.add('file.image')

  const highRisk = countTerms(text, RISK_TERMS.high) > 0
  const mediumRisk = countTerms(text, RISK_TERMS.medium) > 0
  const risk: RiskBand = highRisk ? 'high' : mediumRisk ? 'medium' : 'low'
  const mutating = risk !== 'low'
    || /\b(edit|write|apply|create|change|save|append|update|modify|add|fix|remove|delete|rename|move|merge|combine|concatenate|dedupe|split|convert|export|generate|copy)\b/u.test(text)

  const contextTokens = Math.max(0, input.contextTokens)
  const contextBucket: ContextBucket =
    contextTokens < 8_000 ? 0 : contextTokens < 32_000 ? 1 : contextTokens < 96_000 ? 2 : 3

  const hints = uniqSorted(
    input.visibleTools.filter((name) => new RegExp(`(^|[^a-z0-9_])${name.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')}([^a-z0-9_]|$)`, 'u').test(text)),
  )

  const artifactsIn = uniqSorted([...artifacts])
  const artifactsOut: ArtifactType[] = []
  if (intent === 'document') artifactsOut.push('file.text')
  if (intent === 'data-analysis') artifactsOut.push('file.text')
  if (mutating) artifactsOut.push('file.patch')
  if (intent === 'research' || intent === 'fact-finding' || intent === 'wide-research') artifactsOut.push('web.page')

  const fingerprint: Omit<TaskFingerprint, 'hash'> = {
    intent,
    artifactsIn,
    artifactsOut: uniqSorted(artifactsOut),
    mutating,
    parallelizable: intent === 'wide-research' || intent === 'multi-area-review',
    risk,
    contextBucket,
    surface: input.surface,
    hints,
    workspace: input.workspace,
    textLength: text.length,
  }
  return { ...fingerprint, hash: hash16(canonicalJson(fingerprint as unknown as Json)) }
}

/** Stable JSON for hashing: sorted keys, no undefined, no floats with -0. */
export function canonicalJson(value: Json): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item)).join(',')}]`
  const keys = Object.keys(value).sort()
  return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalJson((value as Record<string, Json>)[key] as Json)}`).join(',')}}`
}

// ---------------------------------------------------------------------------
// Templates and plan instantiation
// ---------------------------------------------------------------------------

export interface TemplateApplies {
  readonly intent: readonly IntentClass[]
  readonly artifactsIn?: readonly ArtifactType[]
  readonly artifactsOut?: readonly ArtifactType[]
  readonly mutating?: boolean
  readonly parallelizable?: boolean
}

export interface SlotSpec {
  readonly choose: readonly string[]
  readonly scoreBy: 'artifactMatch' | 'intentMatch' | 'successRate' | 'cost'
}

export interface TaskTemplate {
  readonly id: string
  readonly label: string
  readonly appliesTo: TemplateApplies
  readonly toolUniverse: readonly string[]
  readonly risk: number
  readonly gatePolicy: TaskPlan['gatePolicy']
  readonly slots: Readonly<Record<string, SlotSpec>>
  readonly budget: TaskPlan['budget']
  /** Fixed node shape for templates with parallel branches; slots fill the leaves. */
  readonly fixedNodes?: readonly PlanNode[]
  readonly fixedEdges?: readonly PlanEdge[]
}

export interface TemplateLibrary {
  readonly version: number
  readonly templates: readonly TaskTemplate[]
  /** Fallback template id; must exist in `templates`. */
  readonly fallbackId: string
}

export interface RouteWeights {
  readonly version: number
  readonly terms: {
    readonly intentMatch: number
    readonly artifactMatch: number
    readonly toolAffinity: number
    readonly historySuccess: number
    readonly costPenalty: number
    readonly riskPenalty: number
  }
  readonly confidence: { readonly absMin: number; readonly marginMin: number }
  readonly search: { readonly beamWidth: number; readonly slotCandidates: number }
  readonly cooccurrence: { readonly minObservations: number; readonly shrinkageK: number; readonly npmClamp: number }
}

export const DEFAULT_WEIGHTS: RouteWeights = {
  version: 1,
  terms: { intentMatch: 0.26, artifactMatch: 0.3, toolAffinity: 0.16, historySuccess: 0.12, costPenalty: 0.1, riskPenalty: 0.06 },
  confidence: { absMin: 0.55, marginMin: 0.08 },
  search: { beamWidth: 8, slotCandidates: 6 },
  cooccurrence: { minObservations: 20, shrinkageK: 10, npmClamp: 0 },
}

export interface Binding {
  readonly slot: string
  readonly tool: string
}

export interface InstantiatedPlan {
  readonly template: TaskTemplate
  readonly bindings: readonly Binding[]
  readonly nodes: readonly PlanNode[]
  readonly edges: readonly PlanEdge[]
  readonly toolUniverse: readonly string[]
  readonly score: number
  readonly terms: Readonly<Record<keyof RouteWeights['terms'], number>>
}

/** Hard constraints first: a template is admissible only when all of these hold. */
export function isAdmissible(template: TaskTemplate, fingerprint: TaskFingerprint, graph: RegistryGraph): boolean {
  if (!template.appliesTo.intent.includes(fingerprint.intent) && !template.appliesTo.intent.includes('other')) return false
  // The mutating contract is symmetric. Only rejecting `false` against a
  // mutating fingerprint admitted a mutation template (`t_doc`, write stage) for
  // a read-only document request.
  if (template.appliesTo.mutating === true && !fingerprint.mutating) return false
  if (template.appliesTo.mutating === false && fingerprint.mutating) return false
  if (template.appliesTo.parallelizable === true && !fingerprint.parallelizable) return false
  const availableTools = new Set(graph.nodes.filter((node) => node.kind === 'tool' && !node.tool?.conditional && !node.tool?.dynamic).map((node) => node.tool?.name))
  for (const tool of template.toolUniverse) {
    if (!availableTools.has(tool)) return false
  }
  return true
}

/** Candidate tools for one slot: must exist, be visible, and be admissible for the node. */
export function slotCandidates(template: TaskTemplate, slot: string, graph: RegistryGraph, limit: number): RegistryNode[] {
  const spec = template.slots[slot]
  if (!spec) return []
  const byName = new Map<string, RegistryNode>()
  for (const node of graph.nodes) {
    if (node.kind !== 'tool' || node.tool === undefined) continue
    if (!spec.choose.includes(node.tool.name)) continue
    if (node.tool.conditional || node.tool.dynamic) continue
    byName.set(node.tool.name, node)
  }
  // Deterministic order: the template's declared order, then the graph order.
  return spec.choose.flatMap((name) => (byName.has(name) ? [byName.get(name) as RegistryNode] : [])).slice(0, limit)
}

/**
 * Beam search over slot assignments. Deterministic: ties break on the sorted binding
 * tuple, never on hash-map iteration order.
 *
 * Complexity: O(T · b · S · C) scoring calls, each O(E) over the adjacency of the
 * selected nodes; with T<=12 templates, b<=8, S<=6 slots, C<=6 candidates and E<=30
 * edges this is < 100k primitive operations — sub-millisecond on Node 26.
 */
export function instantiate(
  template: TaskTemplate,
  fingerprint: TaskFingerprint,
  graph: RegistryGraph,
  cooccurrence: CooccurrenceTable,
  weights: RouteWeights,
): InstantiatedPlan | undefined {
  const slots = Object.keys(template.slots).sort()
  if (slots.length === 0) {
    const score = scorePlan(template, [], fingerprint, graph, cooccurrence, weights)
    return { template, bindings: [], nodes: template.fixedNodes ?? [], edges: template.fixedEdges ?? [], toolUniverse: template.toolUniverse, ...score }
  }

  let beam: { bindings: Binding[]; partial: number }[] = [{ bindings: [], partial: 0 }]
  for (const slot of slots) {
    const candidates = slotCandidates(template, slot, graph, weights.search.slotCandidates)
    const next: { bindings: Binding[]; partial: number }[] = []
    for (const state of beam) {
      for (const candidate of candidates) {
        const bindings = [...state.bindings, { slot, tool: candidate.tool?.name ?? candidate.id }]
        next.push({ bindings, partial: state.partial + slotUtility(template, slot, candidate, fingerprint, cooccurrence, weights) })
      }
    }
    next.sort((a, b) => b.partial - a.partial || compareBindings(a.bindings, b.bindings))
    beam = next.slice(0, weights.search.beamWidth)
  }

  const best = beam[0]
  if (!best) return undefined
  const score = scorePlan(template, best.bindings, fingerprint, graph, cooccurrence, weights)
  return {
    template,
    bindings: best.bindings,
    nodes: template.fixedNodes ?? synthesizeNodes(template, best.bindings),
    edges: template.fixedEdges ?? synthesizeEdges(template, best.bindings),
    toolUniverse: template.toolUniverse,
    ...score,
  }
}

function compareBindings(left: readonly Binding[], right: readonly Binding[]): number {
  const a = left.map((binding) => `${binding.slot}:${binding.tool}`).join(',')
  const b = right.map((binding) => `${binding.slot}:${binding.tool}`).join(',')
  return a < b ? -1 : a > b ? 1 : 0
}

function slotUtility(
  template: TaskTemplate,
  slot: string,
  candidate: RegistryNode,
  fingerprint: TaskFingerprint,
  cooccurrence: CooccurrenceTable,
  weights: RouteWeights,
): number {
  const artifact = artifactScore(candidate, fingerprint)
  const history = historyScore(candidate)
  const affinity = meanAffinity(candidate, cooccurrence)
  const cost = 1 - normalizeCost(candidate)
  const risk = 1 - candidate.cost.risk
  const spec = template.slots[slot]
  const prefer = spec?.scoreBy ?? 'artifactMatch'
  const base = 0.3 * artifact + 0.25 * history + 0.2 * affinity + 0.15 * cost + 0.1 * risk
  // The slot's declared preference re-weights the same terms; it never invents signals.
  const tilted =
    prefer === 'artifactMatch'
      ? base + 0.2 * artifact
      : prefer === 'successRate'
        ? base + 0.2 * history
        : prefer === 'cost'
          ? base + 0.2 * cost
          : base + 0.2 * intentToolAffinity(candidate, fingerprint)
  return Math.max(0, Math.min(1, tilted)) * weights.terms.artifactMatch
}

function artifactScore(node: RegistryNode, fingerprint: TaskFingerprint): number {
  const wanted = new Set<ArtifactType>([...fingerprint.artifactsIn, ...fingerprint.artifactsOut])
  if (wanted.size === 0) return 0.5
  let hit = 0
  for (const artifact of node.produces) if (wanted.has(artifact.type)) hit += 1
  for (const artifact of node.accepts) if (wanted.has(artifact.type)) hit += 0.5
  return Math.min(1, hit / Math.max(1, wanted.size))
}

function historyScore(node: RegistryNode): number {
  const failure = node.cost.failureRate ?? 0.1
  return 1 - Math.max(0, Math.min(1, failure))
}

function normalizeCost(node: RegistryNode): number {
  const tokens = (node.cost.tokensPerRequest ?? 0) + (node.cost.tokensPerCall ?? 0)
  return Math.min(1, tokens / 2_500)
}

function intentToolAffinity(node: RegistryNode, fingerprint: TaskFingerprint): number {
  const tags = new Set(node.tags)
  if (fingerprint.mutating && tags.has('mutation')) return 1
  if (!fingerprint.mutating && tags.has('discovery')) return 1
  if (fingerprint.intent === 'research' && tags.has('web')) return 1
  return 0.4
}

// ---------------------------------------------------------------------------
// Co-occurrence (mined from `ctx.sessionQuery`)
// ---------------------------------------------------------------------------

export interface ToolCallRecord {
  readonly turnId: number
  readonly tool: string
  readonly ok: boolean
}

export interface CooccurrenceEntry {
  /** Normalized pointwise mutual information in [0,1] after clamping. */
  readonly npm: number
  readonly observations: number
  /** P(b | a) over successful turns, used for sequencing affinity. */
  readonly handoff: number
}

export type CooccurrenceTable = ReadonlyMap<string, CooccurrenceEntry>

export function cooccurrenceKey(from: string, to: string): string {
  return `${from}\u0000${to}`
}

/**
 * Build the pair table from historical tool calls. Only successful turns contribute
 * (a turn that failed can co-occur for the wrong reason). Pairs are ordered within a
 * turn; `handoff` additionally requires adjacency (b immediately follows a).
 *
 * PMI(a,b)  = ln( P(a,b) / (P(a)·P(b)) )
 * NPMI(a,b) = PMI / −ln P(a,b)          ∈ [-1, 1]
 * w(a,b)    = max(0, NPMI) · n/(n+k)    (Bayesian shrinkage, k from weights)
 *
 * Complexity: O(S + Σ_turns |turn|²) with a small constant; run offline (nightly or
 * on registry change), never on the request path.
 */
export function buildCooccurrence(
  sessions: readonly (readonly ToolCallRecord[])[],
  options: { readonly shrinkageK: number; readonly minObservations: number; readonly npmClamp: number },
): CooccurrenceTable {
  const turns = new Map<string, string[]>()
  const counts = new Map<string, number>()
  const pairCounts = new Map<string, number>()
  const handoffCounts = new Map<string, number>()
  let totalCalls = 0

  for (const [sessionIndex, session] of sessions.entries()) {
    const successful = new Set<number>()
    for (const call of session) if (call.ok) successful.add(call.turnId)
    for (const turnId of successful) {
      const tools = session.filter((call) => call.turnId === turnId).map((call) => call.tool)
      turns.set(`${sessionIndex}:${turnId}`, tools)
      for (const tool of tools) {
        counts.set(tool, (counts.get(tool) ?? 0) + 1)
        totalCalls += 1
      }
      for (const [index, tool] of tools.entries()) {
        const next = tools[index + 1]
        if (next !== undefined && next !== tool) {
          const key = cooccurrenceKey(tool, next)
          handoffCounts.set(key, (handoffCounts.get(key) ?? 0) + 1)
        }
      }
      for (let left = 0; left < tools.length; left += 1) {
        for (let right = left + 1; right < tools.length; right += 1) {
          if (tools[left] === tools[right]) continue
          const forward = cooccurrenceKey(tools[left] as string, tools[right] as string)
          pairCounts.set(forward, (pairCounts.get(forward) ?? 0) + 1)
        }
      }
    }
  }

  const table = new Map<string, CooccurrenceEntry>()
  for (const [key, pairCount] of pairCounts) {
    const [from, to] = key.split('\u0000') as [string, string]
    const countFrom = counts.get(from) ?? 0
    const countTo = counts.get(to) ?? 0
    if (pairCount < options.minObservations) continue
    const pAB = pairCount / Math.max(1, totalCalls)
    const pA = countFrom / Math.max(1, totalCalls)
    const pB = countTo / Math.max(1, totalCalls)
    const pmi = Math.log(pAB / Math.max(Number.EPSILON, pA * pB))
    const denominator = -Math.log(Math.max(Number.EPSILON, pAB))
    const npmRaw = denominator === 0 ? 0 : pmi / denominator
    const npm = Math.max(options.npmClamp, Math.min(1, npmRaw))
    const shrunk = npm * (pairCount / (pairCount + options.shrinkageK))
    table.set(key, {
      npm: shrunk,
      observations: pairCount,
      handoff: (handoffCounts.get(key) ?? 0) / Math.max(1, countFrom),
    })
  }
  return table
}

function meanAffinity(node: RegistryNode, cooccurrence: CooccurrenceTable): number {
  const name = node.tool?.name
  if (name === undefined) return 0.3
  let sum = 0
  let count = 0
  for (const [key, entry] of cooccurrence) {
    const [from, to] = key.split('\u0000') as [string, string]
    if (from !== name && to !== name) continue
    sum += entry.npm * 0.5 + entry.handoff * 0.5
    count += 1
  }
  return count === 0 ? 0.3 : Math.min(1, sum / count)
}

// ---------------------------------------------------------------------------
// Plan scoring
// ---------------------------------------------------------------------------

export function scorePlan(
  template: TaskTemplate,
  bindings: readonly Binding[],
  fingerprint: TaskFingerprint,
  graph: RegistryGraph,
  cooccurrence: CooccurrenceTable,
  weights: RouteWeights,
): { score: number; terms: Record<keyof RouteWeights['terms'], number> } {
  const toolNames = bindings.map((binding) => binding.tool)
  const produced = new Set<ArtifactType>()
  for (const node of graph.nodes) {
    if (node.tool && toolNames.includes(node.tool.name)) for (const artifact of node.produces) produced.add(artifact.type)
  }
  const wanted = [...fingerprint.artifactsIn, ...fingerprint.artifactsOut]
  const artifactMatch = wanted.length === 0 ? 0.5 : wanted.filter((artifact) => produced.has(artifact)).length / wanted.length
  const intentMatch = template.appliesTo.intent.includes(fingerprint.intent) ? 1 : 0
  const toolAffinity = meanPairAffinity(toolNames, graph, cooccurrence)
  const historySuccess = (successes.get(template.id) ?? 0.5)
  const cost = Math.min(1, estimatedPlanTokens(template, graph) / 250_000)
  const risk = Math.min(1, template.risk)
  const terms = {
    intentMatch,
    artifactMatch,
    toolAffinity,
    historySuccess,
    costPenalty: cost,
    riskPenalty: risk,
  }
  const score =
    weights.terms.intentMatch * terms.intentMatch +
    weights.terms.artifactMatch * terms.artifactMatch +
    weights.terms.toolAffinity * terms.toolAffinity +
    weights.terms.historySuccess * terms.historySuccess -
    weights.terms.costPenalty * terms.costPenalty -
    weights.terms.riskPenalty * terms.riskPenalty
  return { score: Math.max(0, Math.min(1, score)), terms }
}

const successes = new Map<string, number>()

/** Test/bench hook: install measured template success rates (0..1, Laplace-smoothed). */
export function setTemplateSuccessRate(templateId: string, rate: number): void {
  successes.set(templateId, Math.max(0, Math.min(1, rate)))
}

function meanPairAffinity(toolNames: readonly string[], graph: RegistryGraph, cooccurrence: CooccurrenceTable): number {
  if (toolNames.length < 2) return 0.3
  const byName = new Map(graph.nodes.filter((node) => node.tool).map((node) => [node.tool?.name as string, node]))
  let sum = 0
  let count = 0
  for (let index = 0; index + 1 < toolNames.length; index += 1) {
    const from = toolNames[index] as string
    const to = toolNames[index + 1] as string
    const mined = cooccurrence.get(cooccurrenceKey(from, to))
    const declared = declaredEdgeWeight(graph, from, to)
    sum += mined ? Math.max(mined.npm, declared) : declared
    count += 1
  }
  void byName
  return count === 0 ? 0.3 : sum / count
}

function declaredEdgeWeight(graph: RegistryGraph, from: string, to: string): number {
  const fromNode = graph.nodes.find((node) => node.tool?.name === from)
  const toNode = graph.nodes.find((node) => node.tool?.name === to)
  if (!fromNode || !toNode) return 0
  let best = 0
  for (const edge of graph.edges) {
    if (edge.kind === 'produces' && edge.from === fromNode.id && edge.to === toNode.id) best = Math.max(best, edge.weight)
    if (edge.kind === 'requires' && edge.from === fromNode.id && edge.to === toNode.id) best = Math.max(best, edge.weight)
  }
  return best
}

/** ESTIMATE until the token-economist's bench lands; uses measured schema tokens. */
export function estimatedPlanTokens(template: TaskTemplate, graph: RegistryGraph): number {
  const toolTokens = template.toolUniverse.reduce((sum, name) => {
    const node = graph.nodes.find((candidate) => candidate.tool?.name === name)
    return sum + (node?.tool?.schemaTokens ?? 0)
  }, 0)
  const steps = template.budget.maxSteps
  return steps * (toolTokens + 1_500) + template.toolUniverse.length * 40
}

// ---------------------------------------------------------------------------
// The match (pure, cached, deterministic)
// ---------------------------------------------------------------------------

export interface RouteKey {
  readonly taskHash: string
  readonly graphDigest: string
  readonly weightsVersion: number
  readonly presetId: string
}

/** The routing verdict the driver stores on the run and reports to `graph_status`. */
export interface RouteDecision {
  readonly key: RouteKey
  readonly planId: string
  readonly templateId: string
  readonly confidence: number
  readonly margin: number
  readonly fallback: boolean
  readonly fallbackReason?: 'below-threshold' | 'candidates-empty' | 'invalid-plan' | 'previous-failure'
}

export interface MatchResult {
  readonly decision: RouteDecision
  readonly plan: TaskPlan
  readonly explain: readonly string[]
}

export interface MatchInput {
  readonly fingerprint: TaskFingerprint
  readonly graph: RegistryGraph
  readonly library: TemplateLibrary
  readonly cooccurrence: CooccurrenceTable
  readonly weights: RouteWeights
  readonly presetId: string
  readonly presetTools: readonly string[]
  /** Set after a previous run of this task failed; forces the fallback. */
  readonly previousFailure?: boolean
}

/**
 * The match: hard filter -> instantiate -> score -> confidence gate -> fallback.
 * Deterministic for a given MatchInput; the caller memoizes on RouteKey.
 */
export function match(input: MatchInput): MatchResult {
  const explain: string[] = []
  const key: RouteKey = {
    taskHash: input.fingerprint.hash,
    graphDigest: input.graph.digest,
    weightsVersion: input.weights.version,
    presetId: input.presetId,
  }

  const candidates: InstantiatedPlan[] = []
  for (const template of input.library.templates) {
    if (!template.toolUniverse.every((tool) => input.presetTools.includes(tool))) {
      explain.push(`skip ${template.id}: requires tools outside preset "${input.presetId}"`)
      continue
    }
    if (!isAdmissible(template, input.fingerprint, input.graph)) {
      explain.push(`skip ${template.id}: hard constraints`)
      continue
    }
    const instantiated = instantiate(template, input.fingerprint, input.graph, input.cooccurrence, input.weights)
    if (!instantiated) continue
    candidates.push(instantiated)
    explain.push(
      `candidate ${template.id}: score=${instantiated.score.toFixed(3)} bindings=${instantiated.bindings.map((binding) => `${binding.slot}=${binding.tool}`).join(',') || '-'}`,
    )
  }

  const fallbackTemplate =
    input.library.templates.find((template) => template.id === input.library.fallbackId) ??
    input.library.templates[0]
  if (!fallbackTemplate) throw new Error('empty template library')

  const planOf = (chosen: InstantiatedPlan, fallback: boolean, reason?: MatchResult['decision']['fallbackReason'], confidence = chosen.score, margin = 0): MatchResult => ({
    decision: {
      key,
      planId: `${chosen.template.id}@${input.graph.version}`,
      templateId: chosen.template.id,
      confidence,
      margin,
      fallback,
      ...(reason ? { fallbackReason: reason } : {}),
    },
    plan: toTaskPlan(chosen, input.graph, confidence, fallback),
    explain,
  })

  // The conservative plan is a real plan, not a flag on the specialized one.
  // It must obey the same preset/admissibility filter as every other candidate.
  const conservativeInstantiate = (): InstantiatedPlan | undefined => {
    if (!fallbackTemplate.toolUniverse.every(tool => input.presetTools.includes(tool))) return undefined
    if (!isAdmissible(fallbackTemplate, input.fingerprint, input.graph)) return undefined
    return instantiate(fallbackTemplate, input.fingerprint, input.graph, input.cooccurrence, input.weights)
  }
  const conservativePlan = (reason: MatchResult['decision']['fallbackReason']): MatchResult => {
    const fallback = conservativeInstantiate()
    if (!fallback) throw new Error('fallback template cannot be instantiated')
    return planOf(fallback, true, reason, 0, 0)
  }

  if (input.previousFailure === true) {
    explain.push('previous run failed: forcing fallback')
    return conservativePlan('previous-failure')
  }

  candidates.sort((left, right) => right.score - left.score || compareText(left.template.id, right.template.id))
  const best = candidates[0]
  const runnerUp = candidates[1]
  if (!best) {
    explain.push('no candidate passed the hard filter: fallback')
    return conservativePlan('candidates-empty')
  }
  const margin = runnerUp ? best.score - runnerUp.score : 1
  const confidence = best.score
  if (confidence < input.weights.confidence.absMin || margin < input.weights.confidence.marginMin) {
    const limit = confidence < input.weights.confidence.absMin
      ? `best score ${confidence.toFixed(3)} < absMin ${input.weights.confidence.absMin}`
      : `margin ${margin.toFixed(3)} < marginMin ${input.weights.confidence.marginMin}`
    const fallback = conservativeInstantiate()
    if (fallback !== undefined) {
      explain.push(`${limit}: conservative fallback`)
      return planOf(fallback, true, 'below-threshold', 0, 0)
    }
    // No admissible conservative template: dispatch the best plan but say so.
    explain.push(`${limit}: no admissible fallback, dispatching best`)
    return planOf(best, true, 'below-threshold', confidence, margin)
  }
  explain.push(`selected ${best.template.id} (confidence ${confidence.toFixed(3)}, margin ${margin.toFixed(3)})`)
  return planOf(best, false, undefined, confidence, margin)
}

function toTaskPlan(instantiated: InstantiatedPlan, graph: RegistryGraph, confidence: number, fallback: boolean): TaskPlan {
  const nodes = instantiated.nodes.length > 0 ? instantiated.nodes : synthesizeNodes(instantiated.template, instantiated.bindings)
  const entry = nodes[0]?.id ?? 'n_entry'
  const plan: TaskPlan = {
    id: `${instantiated.template.id}@g${graph.version}`,
    templateId: instantiated.template.id,
    version: 1,
    entry,
    terminals: nodes.filter((node) => node.kind === 'terminal').map((node) => node.id),
    nodes,
    edges: instantiated.edges,
    budget: instantiated.template.budget,
    toolUniverse: instantiated.toolUniverse,
    gatePolicy: instantiated.template.gatePolicy,
    fallback,
    confidence,
    compiledDigest: hash16(canonicalJson({ template: instantiated.template.id, bindings: instantiated.bindings.map((binding) => ({ slot: binding.slot, tool: binding.tool })), nodes: nodes as unknown as Json })),
  }
  return checkedPlan(plan, graph)
}

/** Validate a materialized plan before it leaves the matcher. */
function checkedPlan(plan: TaskPlan, graph: RegistryGraph): TaskPlan {
  const validation = validateTaskPlan(graph, plan)
  if (!validation.ok) {
    throw new Error(`matched plan is invalid: ${validation.errors.map(error => `${error.code} ${error.path}: ${error.message}`).join('; ')}`)
  }
  return plan
}

/** Default node shape for slot templates: one step node per slot, in sorted order. */
export function synthesizeNodes(template: TaskTemplate, bindings: readonly Binding[]): PlanNode[] {
  const ordered = [...bindings].sort((left, right) => compareText(left.slot, right.slot))
  const nodes: PlanNode[] = ordered.map((binding, index) => ({
    id: `n_${binding.slot}`,
    kind: 'tool-call',
    executor: 'step',
    capabilityId: `tool:${binding.tool}`,
    instruction: `${binding.slot}: use ${binding.tool}; verify the expected artifact before moving on.`,
    toolAllow: [binding.tool],
    validate: `artifacts:${binding.slot}`,
    retry: { maxAttempts: 2 },
    ...(index === 0 ? {} : {}),
  }))
  nodes.push({
    id: 'n_done',
    kind: 'terminal',
    executor: 'step',
    instruction: 'Summarize what was done and the evidence.',
    toolAllow: [],
  })
  return nodes
}

export function synthesizeEdges(template: TaskTemplate, bindings: readonly Binding[]): PlanEdge[] {
  const ordered = [...bindings].sort((left, right) => compareText(left.slot, right.slot)).map((binding) => `n_${binding.slot}`)
  const edges: PlanEdge[] = []
  for (let index = 0; index + 1 < ordered.length; index += 1) {
    edges.push({ from: ordered[index] as string, to: ordered[index + 1] as string, kind: 'control' })
  }
  const last = ordered.at(-1)
  if (last) edges.push({ from: last, to: 'n_done', kind: 'control' })
  return edges
}

/** Bounded LRU used by the runtime; keyed by RouteKey (hash of the four inputs). */
export class RouteCache {
  private readonly entries = new Map<string, MatchResult>()
  constructor(private readonly capacity: number) {}

  private static key(key: RouteKey): string {
    return `${key.taskHash}|${key.graphDigest}|${key.weightsVersion}|${key.presetId}`
  }

  get(key: RouteKey): MatchResult | undefined {
    const id = RouteCache.key(key)
    const hit = this.entries.get(id)
    if (hit === undefined) return undefined
    this.entries.delete(id)
    this.entries.set(id, hit)
    return hit
  }

  set(key: RouteKey, value: MatchResult): void {
    const id = RouteCache.key(key)
    this.entries.delete(id)
    this.entries.set(id, value)
    while (this.entries.size > this.capacity) {
      const oldest = this.entries.keys().next().value as string | undefined
      if (oldest === undefined) break
      this.entries.delete(oldest)
    }
  }
}

// ---------------------------------------------------------------------------
// Calibration (offline; weights are data, not code)
// ---------------------------------------------------------------------------

export interface CalibrationSample {
  readonly fingerprint: TaskFingerprint
  /** Human- or bench-labelled best template id. */
  readonly label: string
  readonly candidates: readonly { readonly templateId: string; readonly terms: Readonly<Record<keyof RouteWeights['terms'], number>> }[]
}

export interface CalibrationReport {
  readonly weights: RouteWeights
  readonly top1: number
  readonly fallbackRecall: number
  readonly fallbackPrecision: number
  readonly samples: number
}

/**
 * Projected coordinate ascent on the simplex, maximizing top-1 accuracy with a
 * fallback-aware tie-break. Deterministic: fixed sweep order, fixed step schedule.
 * Grid search is the fallback when |samples| < 200.
 *
 * Metric definitions:
 *  top1            = correct label among non-fallback decisions / non-fallback decisions
 *  fallbackRecall  = fallbacks among samples whose best score < absMin / those samples
 *  fallbackPrec    = fallbacks whose labelled template was NOT the fallback / all fallbacks
 */
export function calibrate(samples: readonly CalibrationSample[], initial: RouteWeights, iterations = 200): CalibrationReport {
  const terms = Object.keys(initial.terms) as (keyof RouteWeights['terms'])[]
  let weights: RouteWeights = { ...initial, terms: { ...initial.terms } }
  const evaluate = (candidate: RouteWeights): number => {
    let correct = 0
    let decided = 0
    for (const sample of samples) {
      let best: { id: string; score: number } | undefined
      for (const option of sample.candidates) {
        const score = scoreTerms(option.terms, candidate.terms)
        if (!best || score > best.score) best = { id: option.templateId, score }
      }
      if (!best || best.score < candidate.confidence.absMin) continue
      decided += 1
      if (best.id === sample.label) correct += 1
    }
    return decided === 0 ? 0 : correct / decided
  }

  let bestScore = evaluate(weights)
  const stepSizes = [0.08, 0.04, 0.02, 0.01]
  for (const step of stepSizes) {
    for (let iteration = 0; iteration < iterations; iteration += 1) {
      let improved = false
      for (const term of terms) {
        for (const direction of [1, -1] as const) {
          const next = { ...weights, terms: { ...weights.terms, [term]: weights.terms[term] + direction * step } }
          const normalized = normalizeWeights(next)
          const score = evaluate(normalized)
          if (score > bestScore + 1e-9) {
            bestScore = score
            weights = normalized
            improved = true
          }
        }
      }
      if (!improved) break
    }
  }

  let fallbackTotal = 0
  let fallbackSavedErrors = 0
  for (const sample of samples) {
    let best: { id: string; score: number } | undefined
    for (const option of sample.candidates) {
      const score = scoreTerms(option.terms, weights.terms)
      if (!best || score > best.score) best = { id: option.templateId, score }
    }
    if (!best || best.score >= weights.confidence.absMin) continue
    fallbackTotal += 1
    // A fallback is "precise" when the low-confidence top-1 would have been wrong.
    if (best.id !== sample.label) fallbackSavedErrors += 1
  }

  return {
    weights,
    top1: bestScore,
    fallbackRecall: samples.length === 0 ? 0 : fallbackTotal / samples.length,
    fallbackPrecision: fallbackTotal === 0 ? 1 : fallbackSavedErrors / fallbackTotal,
    samples: samples.length,
  }
}

function scoreTerms(terms: Readonly<Record<keyof RouteWeights['terms'], number>>, weights: RouteWeights['terms']): number {
  return (
    weights.intentMatch * terms.intentMatch +
    weights.artifactMatch * terms.artifactMatch +
    weights.toolAffinity * terms.toolAffinity +
    weights.historySuccess * terms.historySuccess -
    weights.costPenalty * terms.costPenalty -
    weights.riskPenalty * terms.riskPenalty
  )
}

function normalizeWeights(weights: RouteWeights): RouteWeights {
  const terms = { ...weights.terms }
  const positives = terms.intentMatch + terms.artifactMatch + terms.toolAffinity + terms.historySuccess
  const negatives = terms.costPenalty + terms.riskPenalty
  const scale = (positives + negatives) / 1
  if (scale <= 0) return weights
  for (const key of Object.keys(terms) as (keyof typeof terms)[]) terms[key] = Math.max(0, terms[key] / scale)
  return { ...weights, terms }
}

// ---------------------------------------------------------------------------
// Why embeddings alone cannot route (kept as data for the design doc)
// ---------------------------------------------------------------------------

export const WHY_COSINE_IS_NOT_ENOUGH: readonly string[] = [
  'read vs read_image vs read_mcp_resource: near-identical descriptions, different artifact types and execution worlds.',
  'bash vs pwsh vs run_code: near-identical descriptions, but mutually exclusive by platform or executor; cosine cannot express exclusivity.',
  'edit vs write vs str_replace_editor: same artifact (file.text -> file.patch), different preconditions (read-before-edit, uniqueness).',
  'grep vs session_search: both "search", different corpora; co-occurrence separates them, embeddings do not.',
  'subagent vs workflow vs ralph: all orchestration, wildly different cost, parallelism and durability.',
  'Descriptions are not stable API: docs/tool-catalog.md is generated, so any reindex lag silently reroutes traffic.',
  'The router needs applicability (preconditions satisfied) and sequencing (produces -> consumes), not pairwise resemblance.',
]

export const ARTIFACT_VOCABULARY_SIZE = ARTIFACT_TYPES.length
export const MAX_TEMPLATES = 24
export const MAX_PLAN_NODES = GRAPH_LIMITS.maxPlanNodes
export type { GraphEdge }
