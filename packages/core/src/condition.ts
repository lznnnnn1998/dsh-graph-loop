/**
 * condition.ts — the one runtime evaluator for plan edge guards.
 *
 * `Condition` is part of the plan schema, but a condition the runtime cannot
 * evaluate is worse than no condition: the edge silently never fires and the
 * graph degrades into a chain. This module is the single implementation used by
 * both `FrontierTopology` and the kernel route hook, so every declared operator
 * (artifact, noArtifact, fact, callFailed, budget, always) has the same meaning
 * in both engines.
 *
 * Pure and dependency-free: it reads a projected `RoutingState`, never the
 * session, the clock, or the filesystem.
 * @module dsh-graph-loop-core/condition
 */

import type { ArtifactType, Condition, Json } from './graph-schema.ts'

/** One artifact reference as the router sees it (never a file body). */
export interface RoutingArtifact {
  readonly type: ArtifactType
  readonly ref: string
  readonly hash?: string
  readonly bytes?: number
}

/**
 * Remaining capacity the `budget` condition compares against.
 *
 * Only the step axis has a producer: both engines derive `stepsRemaining` from
 * the plan's `maxSteps`. Token and wall capacity exist on the plan
 * (`TaskBudget.maxTokens` / `maxWallMs`) but nothing measures consumption at a
 * step boundary, so they are not routing axes. They were removed from
 * `Condition` rather than left as guards that can never fire.
 */
export interface RoutingBudget {
  readonly stepsRemaining: number
}

/** Projected state a route decision is allowed to read. */
export interface RoutingState {
  readonly facts: Readonly<Record<string, Json>>
  readonly artifacts: readonly RoutingArtifact[]
  readonly budget: RoutingBudget
}

/** True when the guard passes for this state. An absent guard is unconditional. */
export function evaluateCondition(when: Condition | undefined, state: RoutingState): boolean {
  if (when === undefined) return true
  switch (when.op) {
    case 'always':
      return true
    case 'artifact':
      return state.artifacts.some(artifact => artifact.type === when.type)
    case 'noArtifact':
      return !state.artifacts.some(artifact => artifact.type === when.type)
    case 'fact':
      return state.facts[when.key] === when.equals
    case 'callFailed': {
      if (state.facts['lastOk'] !== false) return false
      const failedTool = state.facts['failedTool']
      // A failed step without a tool name can take any recovery edge; when the
      // step names the tool, only the matching edge may fire. `failedTool` is
      // only projected for configured shell tools today, so for a non-shell
      // failure this is equivalent to `fact lastOk=false`; use that operator when
      // the failure should be tool-agnostic.
      return typeof failedTool !== 'string' || failedTool === when.tool
    }
    case 'budget':
      // `axis` is `steps` only: the token/wall axes have no producer, so they
      // are not part of the routing schema (see `RoutingBudget`).
      return state.budget.stepsRemaining <= when.remainingAtMost
    default: {
      // Exhaustiveness: a new operator added to `Condition` must be handled
      // here, not silently treated as false.
      const unreachable: never = when
      return unreachable
    }
  }
}

/**
 * Order edges for evaluation without changing the author's relative order:
 * specific guards first, an unconditional fallback last. A failed step uses
 * only guarded edges (an `always` edge must not mask a real failure branch).
 */
export function routeOrder<T extends { readonly when?: Condition }>(edges: readonly T[]): readonly T[] {
  return [...edges].sort((left, right) => {
    const leftFallback = left.when === undefined || left.when.op === 'always'
    const rightFallback = right.when === undefined || right.when.op === 'always'
    return Number(leftFallback) - Number(rightFallback)
  })
}
