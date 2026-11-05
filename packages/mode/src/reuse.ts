/**
 * Pure reuse scoring for the explore mode: who on the Agent Teams roster could
 * take this task instead of spawning a new teammate.
 *
 * The module deliberately has **no DSH imports** and no ambient state, so the
 * ranking and the guard decision can be unit-tested without a Cordis context.
 * @module @dsh/explore-mode/reuse
 */

/** Lifecycle states a roster row may report. */
export type ExecutorStatus = 'running' | 'inactive' | 'provisioning' | 'failed' | (string & {})

/** One candidate the scorer can rank. Structurally satisfied by a Team roster row. */
export interface ExecutorCandidate {
  /** Model-facing name (`lower-kebab-case` for Agent Teams teammates). */
  readonly name: string
  /** What this candidate is for; the main similarity signal. */
  readonly description?: string
  /** Lifecycle state; only `inactive` is a real reuse opportunity. */
  readonly status?: ExecutorStatus
  /** Optional model hint, echoed back for the caller. */
  readonly model?: string
}

/** A candidate with its score attached. */
export interface ScoredCandidate {
  readonly name: string
  readonly description: string
  readonly status: string
  readonly model?: string
  /** `0..1`, rounded to three decimals so tests and logs are stable. */
  readonly score: number
}

/** Outcome of the duplicate-spawn guard. */
export interface GuardDecision {
  /** Whether the guarded call should be denied. */
  readonly deny: boolean
  /** Model-facing denial reason; present exactly when {@link deny} is true. */
  readonly reason?: string
  /** Ranked matches that caused the decision (empty when allowed). */
  readonly matches: ScoredCandidate[]
}

/** Lower bound used by `suggest_executor` when it lists candidates. */
export const SUGGEST_THRESHOLD = 0.34

/** Lower bound used by the duplicate-spawn guard. */
export const GUARD_THRESHOLD = 0.5

/** At most this many candidates are reported. */
export const MAX_CANDIDATES = 5

/** A one-token task is too ambiguous to justify blocking a spawn. */
export const MIN_TASK_TOKENS = 2

/** Share of the score that comes from text similarity. */
const TEXT_WEIGHT = 0.75
/** Share of the score that comes from lifecycle state. */
const STATUS_WEIGHT = 0.25
/** Status weight when the candidate reports no status at all. */
const UNKNOWN_STATUS_WEIGHT = 0.5

const STATUS_SCORES: Readonly<Record<string, number>> = Object.freeze({
  inactive: 1,
  running: 0.35,
  provisioning: 0.1,
  failed: 0,
})

/** Words that carry no routing signal in English task descriptions. */
const STOPWORDS: ReadonlySet<string> = new Set([
  'a', 'an', 'and', 'are', 'as', 'at', 'be', 'by', 'for', 'from', 'in', 'into',
  'is', 'it', 'of', 'on', 'or', 'that', 'the', 'to', 'with', 'this', 'these',
  'those', 'then', 'than', 'so', 'we', 'you', 'your', 'our', 'its', 'will',
  'should', 'would', 'can', 'could', 'may', 'might', 'do', 'does', 'did', 'not',
  'no', 'yes', 'use', 'using', 'used', 'make', 'makes', 'made', 'one', 'two',
])

/** Han/Hangul/Kana runs are scored as bigrams because they carry no word spaces. */
const CJK = /[\u3040-\u30FF\u3400-\u4DBF\u4E00-\u9FFF\uF900-\uFAFF\uAC00-\uD7AF]/u

/**
 * Normalize text into comparison tokens.
 *
 * Latin text is lowercased, split on non-letter/non-digit runs, and stripped of
 * stopwords and one-character fragments. A CJK run is split into character bigrams
 * (a one-character run stays a unigram) so Chinese descriptions still overlap.
 * @param text - arbitrary task or candidate text.
 * @returns comparable tokens; empty for text without signal.
 */
export function normalize(text: string): string[] {
  const tokens: string[] = []
  for (const raw of text.toLowerCase().split(/[^\p{L}\p{N}]+/u)) {
    if (raw.length === 0) continue
    if (CJK.test(raw)) {
      const characters = [...raw]
      if (characters.length === 1) {
        tokens.push(characters[0] as string)
        continue
      }
      for (let index = 0; index + 1 < characters.length; index += 1) {
        tokens.push(`${characters[index]}${characters[index + 1]}`)
      }
      continue
    }
    if (raw.length >= 2 && !STOPWORDS.has(raw)) tokens.push(raw)
  }
  return tokens
}

/**
 * Containment overlap: the share of `task` tokens that also occur in `reference`.
 *
 * Asymmetric on purpose — a short task must be *fully described* by a long roster
 * description, while a long description must not be penalized for extra words.
 * @param task - text being routed.
 * @param reference - candidate name plus description.
 * @returns `0..1`.
 */
export function tokenOverlap(task: string, reference: string): number {
  const taskTokens = new Set(normalize(task))
  if (taskTokens.size === 0) return 0
  const referenceTokens = new Set(normalize(reference))
  if (referenceTokens.size === 0) return 0
  let shared = 0
  for (const token of taskTokens) {
    if (referenceTokens.has(token)) shared += 1
  }
  return shared / taskTokens.size
}

/**
 * Score one candidate for one task.
 *
 * `0.75 * textSimiairity + 0.25 * statusWeight`, where an idle teammate is worth a
 * full status term and a running one keeps a partial term so the ranking still
 * suggests busy-but-relevant teammates.
 * @param task - text being routed.
 * @param candidate - roster row.
 * @returns `0..1`, rounded to three decimals.
 */
export function scoreExecutor(task: string, candidate: ExecutorCandidate): number {
  const text = `${candidate.name} ${candidate.description ?? ''}`.trim()
  const textScore = tokenOverlap(task, text)
  const statusScore = candidate.status === undefined
    ? UNKNOWN_STATUS_WEIGHT
    : STATUS_SCORES[candidate.status] ?? 0
  return round(TEXT_WEIGHT * textScore + STATUS_WEIGHT * statusScore)
}

/**
 * Score and sort every candidate, best first.
 * @param task - text being routed.
 * @param candidates - roster rows.
 * @returns a new array; the input is not mutated.
 */
export function rankCandidates(task: string, candidates: readonly ExecutorCandidate[]): ScoredCandidate[] {
  return candidates
    .map(candidate => ({ ...toScored(candidate, scoreExecutor(task, candidate)) }))
    .sort((left, right) => right.score - left.score || left.name.localeCompare(right.name))
}

/**
 * Idle candidates worth reusing for this task.
 * @param task - text being routed.
 * @param candidates - roster rows.
 * @param threshold - minimum score, inclusive; defaults to {@link SUGGEST_THRESHOLD}.
 * @param limit - maximum rows returned; defaults to {@link MAX_CANDIDATES}.
 * @returns ranked idle candidates at or above the threshold.
 */
export function shouldSuggestReuse(
  task: string,
  candidates: readonly ExecutorCandidate[],
  threshold: number = SUGGEST_THRESHOLD,
  limit: number = MAX_CANDIDATES,
): ScoredCandidate[] {
  return rankCandidates(task, candidates)
    .filter(candidate => candidate.status === 'inactive' && candidate.score >= threshold)
    .slice(0, Math.max(0, limit))
}

/**
 * Decide whether a `spawn_teammate` call duplicates an idle teammate.
 *
 * Denies only when the guard is enabled, the task carries enough tokens to compare,
 * and an idle teammate scores at or above `threshold`. The decision never throws:
 * malformed candidates are simply scored as non-matching.
 * @param task - the proposed teammate description.
 * @param candidates - roster rows (the caller should exclude the lead).
 * @param threshold - minimum score that blocks the spawn; defaults to {@link GUARD_THRESHOLD}.
 * @param block - whether the guard is enabled at all.
 * @returns the decision plus the matches that produced it.
 */
export function duplicateSpawnDecision(
  task: string,
  candidates: readonly ExecutorCandidate[],
  threshold: number = GUARD_THRESHOLD,
  block: boolean = true,
): GuardDecision {
  if (!block) return { deny: false, matches: [] }
  if (normalize(task).length < MIN_TASK_TOKENS) return { deny: false, matches: [] }
  const matches = shouldSuggestReuse(task, candidates, threshold, MAX_CANDIDATES)
  if (matches.length === 0) return { deny: false, matches: [] }
  return { deny: true, reason: duplicateSpawnReason(matches), matches }
}

/**
 * Model-facing denial text. Names the match so the model can reuse it directly.
 * @param matches - non-empty ranked matches.
 * @returns one sentence plus a remediation hint.
 */
export function duplicateSpawnReason(matches: readonly ScoredCandidate[]): string {
  const names = matches.map(match => match.name).join(', ')
  return `An idle teammate matches this task: ${names}. `
    + 'Reuse via send_message, or pass a clearly different name/description to spawn a new one.'
}

/** Round to three decimals for stable output and comparisons. */
function round(value: number): number {
  const clamped = Math.min(1, Math.max(0, value))
  return Math.round(clamped * 1000) / 1000
}

/** Project a candidate plus its score into the reported shape. */
function toScored(candidate: ExecutorCandidate, score: number): ScoredCandidate {
  return {
    name: candidate.name,
    description: candidate.description ?? '',
    status: candidate.status ?? 'unknown',
    ...candidate.model === undefined ? {} : { model: candidate.model },
    score,
  }
}
