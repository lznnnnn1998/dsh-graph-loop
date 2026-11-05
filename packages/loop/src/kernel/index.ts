/**
 * `@dsh/explore-loop/kernel` — graph kernels for the `explore` loop.
 *
 * Two interchangeable implementations:
 *   - `minimal`   (default) — vendored stepwise engine, no third-party runtime;
 *   - `langgraph` — adapter over `@langchain/langgraph@1.7.0`, loaded lazily.
 *
 * Both expose Layer 1 (`createGraph` → `GraphBuilder` → `CompiledGraph`) and
 * Layer 2 (`KernelPort` → `KernelRunHandle.next()`, exactly one plan node per
 * call). `createKernel(kind)` is the factory the driver and `graph_run` use;
 * `Deps` are optional so pure topology stepping needs no wiring.
 *
 *   const kernel = createKernel('minimal')
 *   const run = kernel.compile(plan, state)
 *   for (;;) {
 *     const result = await run.next()   // one node, then a boundary
 *     if (result.kind !== 'boundary') break
 *   }
 */

import { END } from '@dsh/explore-core/kernel'
import type { RunResult } from '@dsh/explore-core/kernel'
import type { GraphState, TaskPlan } from '@dsh/explore-core/graph-schema'
import type { KernelPort, KernelResult, NodeFailure } from '@dsh/explore-core/runtime'

import { createMinimalKernel } from './minimal.ts'
import { createLangGraphKernel } from './langgraph.ts'
import { planInitialState, type KernelDeps, type PlanExecutorPort } from './plan.ts'

export * from './builder.ts'
export * from './plan.ts'
export { createGraph, MinimalKernel, createMinimalKernel, createMinimalRunHandle } from './minimal.ts'
export { available, createLangGraphGraph, createLangGraphKernel, loadLangGraph } from './langgraph.ts'
export {
  END,
  START,
  KernelError,
  createDeterministicHooks,
  createSystemHooks,
} from '@dsh/explore-core/kernel'

/** Which engine a run uses. `langgraph` degrades to `minimal` when absent. */
export type KernelKind = 'minimal' | 'langgraph'

/**
 * Create a kernel by kind.
 *
 * `deps` may be omitted: the minimal kernel then walks the plan topology with
 * no-op node bodies (useful for tests and the `graph_status` tool). Pass
 * `executors` (or `nodes`) to make nodes do work.
 */
export function createKernel(kind: KernelKind = 'minimal', deps?: KernelDeps): KernelPort {
  if (kind === 'langgraph') return createLangGraphKernel(deps)
  return createMinimalKernel(deps)
}

/** Result of {@link runPlan}; a `RunResult` plus the terminal kernel detail. */
export interface PlanRunResult extends RunResult<GraphState> {
  /** Set when `status === 'failed'`. */
  readonly error?: NodeFailure
  /** The last raw kernel result (boundary-free if the plan finished). */
  readonly result: KernelResult
}

export interface RunPlanOptions extends Omit<KernelDeps, 'executors'> {
  readonly executors?: readonly PlanExecutorPort[]
  readonly threadId?: string
  readonly taskHash?: string
  /** Seed state; defaults to `planInitialState(plan, taskHash ?? plan.id)`. */
  readonly state?: GraphState
  readonly kind?: KernelKind
}

/**
 * Convenience driver: compile a plan and call `next()` until it stops being a
 * boundary. One node per `next()` stays visible here — this helper does not
 * batch or skip nodes, it only removes the loop boilerplate.
 */
export async function runPlan(
  plan: TaskPlan,
  executors?: readonly PlanExecutorPort[],
  options?: RunPlanOptions,
): Promise<PlanRunResult> {
  const { state, taskHash, kind, executors: explicitExecutors, ...deps } = options ?? {}
  const kernel = createKernel(kind ?? 'minimal', {
    ...deps,
    executors: explicitExecutors ?? executors,
  })
  const initial = state ?? planInitialState(plan, taskHash ?? plan.id)
  const handle = kernel.compile(plan, initial)
  let result: KernelResult = { kind: 'done', state: initial, terminal: initial.next ?? END }
  const limit = Math.max(1, deps.maxSteps ?? 40) * 4
  try {
    for (let index = 0; index < limit; index += 1) {
      result = await handle.next()
      if (result.kind !== 'boundary') break
    }
  } finally {
    await handle.dispose()
  }
  const status: RunResult<GraphState>['status'] =
    result.kind === 'done'
      ? 'completed'
      : result.kind === 'paused'
        ? 'interrupted'
        : result.kind === 'failed' && result.error.code === 'cancelled'
          ? 'aborted'
          : 'failed'
  return {
    state: result.state,
    status,
    steps: result.state.superstep,
    result,
    ...(result.kind === 'failed' ? { error: result.error } : {}),
  }
}
