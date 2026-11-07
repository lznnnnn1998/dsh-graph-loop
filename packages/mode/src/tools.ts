/**
 * The explore mode's model-facing tools and its duplicate-spawn guard.
 *
 * `suggest_executor` is read-only. The one enforcement point is a `tools/pre-execute`
 * waterfall that refuses `spawn_teammate` when an *idle* teammate already matches the
 * proposed responsibility — the observed failure mode is a Lead that spawns a second
 * agent for work an existing teammate could resume.
 *
 * This row deliberately registers no `graph_status`: `dsh-graph-loop` owns that
 * host-wide tool and reports the live plan/run. A scoped duplicate here would shadow
 * the real one in this preset, so the mode only suggests executors.
 *
 * The guard is deliberately narrow and fail-open: it only inspects one tool, only when
 * the Agent Teams service is mounted, only when the call carries an Agent, and any
 * error falls through to `next()`. It never throws and never denies an unrelated tool.
 * @module dsh-graph-loop-mode/tools
 */

import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { defineTool, type PreToolDecision, type ToolExecution } from '@deepseek-ai/dsh-tools'
import { GUARDED_TOOL } from './constants.ts'
import {
  GUARD_THRESHOLD,
  SUGGEST_THRESHOLD,
  duplicateSpawnDecision,
  rankCandidates,
  shouldSuggestReuse,
  type ExecutorCandidate,
  type ScoredCandidate,
} from './reuse.ts'
import { listMembersSafely, teamsOf, teammates, type TeamMemberLike, type TeamsLike } from './teams.ts'

/** Cordis plugin name; the preset child row id is `explore-tools`. */
export const name = 'explore-tools'

/** The tool registry these tools and the guard hook into. */
export const inject = ['tools']

/** Row config. Absent keys use the defaults below. */
export interface Config {
  /** Deny a duplicate `spawn_teammate` when an idle teammate matches; defaults to true. */
  blockDuplicateSpawn?: boolean
  /** Minimum score for `suggest_executor` to list a candidate; defaults to 0.34. */
  suggestThreshold?: number
  /** Minimum score for a `reuse` recommendation and for the guard; defaults to 0.5. */
  reuseThreshold?: number
}

/** Fully resolved plugin settings. */
interface Settings {
  readonly blockDuplicateSpawn: boolean
  readonly suggestThreshold: number
  readonly reuseThreshold: number
}

/**
 * Register the mode's tools and the duplicate-spawn guard.
 * @param ctx - preset-scoped context.
 * @param config - row config.
 */
export function apply(ctx: Context, config: Config = {}): void {
  const settings = resolveSettings(config)

  ctx.tools.register(defineTool({
    name: 'suggest_executor',
    description: 'Rank idle Agent Teams teammates against a task description and recommend reusing one or spawning a new teammate. '
      + 'Read-only. Call it before spawn_teammate when a task could belong to an existing teammate.',
    parameters: {
      task: {
        type: 'string',
        required: true,
        description: 'Task or responsibility to route, in one or two sentences.',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          available: { type: 'boolean', required: true },
          recommendation: { type: 'string', enum: ['reuse', 'spawn'] },
          task: { type: 'string' },
          candidates: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                name: { type: 'string', required: true },
                description: { type: 'string' },
                status: { type: 'string' },
                score: { type: 'number', required: true },
              },
            },
          },
          reason: { type: 'string' },
        },
      },
      render: (_args, value) => [{ type: 'text', text: renderSuggestions(value) }],
    },
    async execute(args, exec) {
      const teams = teamsOf(ctx)
      if (teams === undefined || exec.agent === undefined) {
        return {
          available: false,
          candidates: [],
          reason: 'Agent Teams is not mounted in this deployment; spawning is the only option.',
        }
      }
      const candidates = rankCandidates(args.task, candidatesFor(teams, exec.agent))
      const listed = candidates
        .filter(candidate => candidate.score >= settings.suggestThreshold)
        .map(candidate => ({
          name: candidate.name,
          description: candidate.description,
          status: candidate.status,
          score: candidate.score,
        }))
      const best = listed[0]
      const recommendation: 'reuse' | 'spawn' = best !== undefined && best.score >= settings.reuseThreshold
        ? 'reuse'
        : 'spawn'
      return { available: true, task: args.task, recommendation, candidates: listed }
    },
  }))

  ctx.effect(() => ctx.on('tools/pre-execute', async (exec, next) => {
    const decision = duplicateSpawnGuard(ctx, exec, settings)
    return decision ?? await next()
  }), 'explore-tools: duplicate-spawn guard')
}

/** Fallback settings used when the guard is called without a resolved config. */
const DEFAULT_SETTINGS: Settings = Object.freeze({
  blockDuplicateSpawn: true,
  suggestThreshold: SUGGEST_THRESHOLD,
  reuseThreshold: GUARD_THRESHOLD,
})

/**
 * The guard decision for one call, or undefined to let it proceed.
 * Exported for tests and for a future host-side policy audit.
 * @param ctx - preset-scoped context.
 * @param exec - pending call.
 * @param settings - resolved settings (or the defaults when omitted).
 * @returns a deny decision, or undefined.
 */
export function duplicateSpawnGuard(
  ctx: Context,
  exec: ToolExecution,
  settings: Pick<Settings, 'blockDuplicateSpawn' | 'reuseThreshold'> = DEFAULT_SETTINGS,
): PreToolDecision | undefined {
  try {
    if (!settings.blockDuplicateSpawn) return undefined
    if (exec.name !== GUARDED_TOOL) return undefined
    const agent = exec.agent
    if (agent === undefined) return undefined
    const teams = teamsOf(ctx)
    if (teams === undefined) return undefined
    const task = spawnDescription(exec.arguments)
    if (task === undefined) return undefined
    const decision = duplicateSpawnDecision(
      task,
      candidatesFor(teams, agent),
      settings.reuseThreshold,
      settings.blockDuplicateSpawn,
    )
    if (!decision.deny || decision.reason === undefined) return undefined
    return { kind: 'deny', reason: decision.reason }
  } catch {
    // Fail open: a guard bug must never block a legitimate spawn or an unrelated tool.
    return undefined
  }
}

/** Roster rows this mode can reuse, read without throwing. */
function candidatesFor(teams: TeamsLike | undefined, agent: Agent): TeamMemberLike[] {
  if (teams === undefined) return []
  return teammates(listMembersSafely(teams, agent))
}

/**
 * Extract the text a spawn is about. `description` is required by the tool schema;
 * `name` is included so a repeated name also registers as a duplicate.
 */
function spawnDescription(args: unknown): string | undefined {
  if (args === null || typeof args !== 'object') return undefined
  const record = args as Record<string, unknown>
  const parts = [record.description, record.name]
    .filter((part): part is string => typeof part === 'string' && part.trim().length > 0)
    .map(part => part.trim())
  return parts.length === 0 ? undefined : parts.join(' ')
}

/** Value shape `suggest_executor` renders (matches its output schema exactly). */
interface SuggestValue {
  available: boolean
  recommendation?: 'reuse' | 'spawn'
  task?: string
  candidates?: readonly { name: string; description?: string; status?: string; score: number }[]
  reason?: string
}

/** Text rendering for `suggest_executor`. */
function renderSuggestions(value: SuggestValue): string {
  if (!value.available) return value.reason ?? 'Agent Teams is not available.'
  const candidates = value.candidates ?? []
  if (candidates.length === 0) return 'No idle teammate matches this task. Recommendation: spawn.'
  const lines = candidates.map(candidate => `- ${candidate.name} (${candidate.score.toFixed(2)})${(candidate.description ?? '').length > 0 ? `: ${candidate.description}` : ''}`)
  return [`Recommendation: ${value.recommendation ?? 'spawn'}`, ...lines].join('\n')
}

/** Resolve config once so every call sees the same thresholds. */
function resolveSettings(config: Config): Settings {
  return {
    blockDuplicateSpawn: config.blockDuplicateSpawn ?? DEFAULT_SETTINGS.blockDuplicateSpawn,
    suggestThreshold: clampThreshold(config.suggestThreshold, SUGGEST_THRESHOLD),
    reuseThreshold: clampThreshold(config.reuseThreshold, GUARD_THRESHOLD),
  }
}

/** Clamp a configured threshold into `0..1`, falling back when it is not a finite number. */
function clampThreshold(value: number | undefined, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback
  return Math.min(1, Math.max(0, value))
}

/** Re-export the pure ranking helpers so tool consumers can import them here. */
export { rankCandidates, shouldSuggestReuse, type ExecutorCandidate, type ScoredCandidate }
