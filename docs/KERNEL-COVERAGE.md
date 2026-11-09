# Kernel coverage

`createKernel()` defaults to **LangGraph** (`packages/loop/src/kernel/index.ts`). A plan the kernel
adapter cannot own is executed by `FrontierTopology` (`packages/core/src/topology.ts`). Both engines
evaluate every edge condition with the same evaluator (`packages/core/src/condition.ts`), so a guard
cannot mean one thing on one engine and something else on the other.

The live driver chooses the engine per plan: `KernelTopology` when
`canKernelDrive(plan)` accepts it, otherwise `FrontierTopology`
(`packages/loop/src/scheduler.ts`, `packages/loop/src/kernel/topology.ts`).

## Plan shape → engine

| Plan shape | Engine | Behavior source | Test evidence |
|---|---|---|---|
| Linear chain | LangGraph | `packages/loop/src/kernel/topology.ts` (`routeKernelPlan`) | `test/unit/kernel-topology.test.ts` |
| Any control-edge condition: `artifact`, `noArtifact`, `fact`, `callFailed`, `budget` (step axis), `always` | LangGraph, through the shared evaluator | `packages/core/src/condition.ts`; `packages/loop/src/kernel/topology.ts` | `test/unit/kernel-topology.test.ts`, `test/unit/transition-matrix.test.ts` (frontier + minimal + langgraph) |
| Composed plans (per-stage success, no-progress, repair and budget exits) | LangGraph | `packages/core/src/compose.ts` | `test/unit/transition-matrix.test.ts`, `test/unit/stage-routing-regression.test.ts`, `test/unit/scheduler.test.ts` |
| Parallel fan-out / join | `FrontierTopology` | `packages/core/src/topology.ts` (join barrier) | `test/unit/transition-matrix.test.ts`, `test/unit/topology.test.ts` |
| Subagent batches | `FrontierTopology` | `packages/loop/src/scheduler.ts`; `packages/core/src/topology.ts` | `test/unit/scheduler.test.ts`, `test/unit/transition-matrix.test.ts` |
| Condition on a data edge | Neither engine routes it; `validateTaskPlan` rejects the plan (`P023`) | `packages/core/src/graph-schema.ts` | `test/unit/transition-matrix.test.ts` |
| Reserved or nonconforming node ids | `FrontierTopology` | `packages/loop/src/kernel/topology.ts` (`canKernelDrive`) | `test/unit/kernel-topology.test.ts` |
| `budget` on the token or wall axis | Rejected by validation (`P022`); only the step axis has a producer | `packages/core/src/graph-schema.ts`, `packages/core/src/condition.ts` | `test/unit/transition-matrix.test.ts` |

`canKernelDrive` rejects a plan with a `subagent` node executor, a node id outside
`[A-Za-z0-9_-]+`, a kernel-reserved id, a condition on a data edge, or more than one unconditional
out-edge per node (`packages/loop/src/kernel/topology.ts`).

## Composed routing contract

Defined in `packages/core/src/compose.ts`. Each stage declares its exits in evaluation order:

1. a **budget exit** to the tool-enabled `n_answer` when `ANSWER_RESERVE_STEPS` (2) steps remain;
2. its failure exits — `callFailed`, `lastOk = false`, and its own no-progress guard — to **one**
   repair node;
3. its success guard to the next stage, or to `n_answer`.

The repair node mirrors the budget/failure exits to `n_answer`, carries the same success edge, and
ends with an unconditional answer fallback. There is **no repair → stage back-edge**: one repair
attempt per stage, then the answer continues abandoned work.

Success guards are step-scoped, computed from what the step actually did
(`packages/loop/src/step-facts.ts`): `toolSucceeded` for discover/inspect (any successful tool
call), the shell-aware `wroteFile` for mutate, `produced.<type>` for author (only when the planned
producer tool ran), and `verificationRan`/`verificationFailed` for verify. A non-zero shell exit
(`[exit code: N]`) is a normal DSH result, not a tool-invocation error: it is folded into
`verificationFailed`, while `lastOk` stays about tool invocation, so an inspect step running
`grep`/`diff` is not sent to repair.

**Reserve boundary.** Because the budget exit is evaluated first, a stage that cannot succeed at the
answer reserve goes to `n_answer` instead of repairing forever. `n_answer` is a **continuation, not
a success claim**: the run reports `done`, but the failed verify step and its `[exit code: N]`
output remain in the node trail and session log. The kernel adapter reserves one extra step for a
budget-routed wrap-up node; the frontier stops at the plan's step cap and reports `done` only when a
terminal was reached, otherwise `failed` (`packages/loop/src/kernel/topology.ts`,
`packages/core/src/topology.ts`).

No claim is made that LangGraph executes arbitrary graphs. Checkpoints are in-memory
(`MemoryCheckpointer` in `packages/loop/src/kernel/plan.ts`); `storageDomain` durability is not
wired.
