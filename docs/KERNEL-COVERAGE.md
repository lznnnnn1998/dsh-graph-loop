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
| Acyclic all-unconditional fan-out / join (one declared terminal, plan ≤ `maxJournal` nodes) | LangGraph (Minimal accepts the same class) | `packages/loop/src/kernel/topology.ts` (`routeReadySet`; entered set derived from `state.journal`) | `test/unit/kernel-topology.test.ts`, `test/unit/transition-matrix.test.ts` (driver drill on frontier + minimal + langgraph) |
| Fan-out with a guarded arm, a cycle, more than one terminal, an unreachable predecessor, or more nodes than the journal | `FrontierTopology` | `packages/core/src/topology.ts` (join barrier) | `test/unit/transition-matrix.test.ts`, `test/unit/topology.test.ts`, `test/unit/kernel-topology.test.ts` |
| Subagent batches | `FrontierTopology` | `packages/loop/src/scheduler.ts`; `packages/core/src/topology.ts` | `test/unit/scheduler.test.ts`, `test/unit/transition-matrix.test.ts` |
| Condition on a data edge | Neither engine routes it; `validateTaskPlan` rejects the plan (`P023`) | `packages/core/src/graph-schema.ts` | `test/unit/transition-matrix.test.ts` |
| Reserved or nonconforming node ids | `FrontierTopology` | `packages/loop/src/kernel/topology.ts` (`canKernelDrive`) | `test/unit/kernel-topology.test.ts` |
| `budget` on the token or wall axis | Rejected by validation (`P022`); only the step axis has a producer | `packages/core/src/graph-schema.ts`, `packages/core/src/condition.ts` | `test/unit/transition-matrix.test.ts` |

`canKernelDrive` rejects a plan with a `subagent` node executor, a node id outside
`[A-Za-z0-9_-]+`, a kernel-reserved id, a condition on a data edge, or a fan-out outside the
ready-set class below (`packages/loop/src/kernel/topology.ts`).

## Fan-out / join on the kernel

A step-executor fan-out needs no parallel steps: a DSH step is sequential, so the kernel pauses
before every node and routes one node at a time. The route is therefore a **ready-set decision**, not
a single-edge pick. The journal is the only completed-node record the kernel owns, so:

- **completed** = the node ids in `state.journal` plus the node that just ran;
- **entered** = a control-edge target of a completed node — the frontier's `entered` set, rebuilt
  from the journal because folded `GraphState` does not carry it;
- **ready** = entered, not completed, and every control predecessor completed;
- the first ready node in declared control-edge order runs next; the join is held until its last
  entered predecessor completed, and a branch that already ran is never run twice.

`canKernelDrive` accepts this route only for the class where the journal is sufficient:
every control edge unconditional, acyclic, one declared terminal, at most `GRAPH_STATE_LIMITS.maxJournal`
nodes, and every control predecessor reachable from the entry. Each bound is a correctness condition — a
guarded arm cannot be reconstructed from the journal, a cycle would make a completed node pending
again, a trimmed journal would release a join on stale data, a second terminal branch cannot run on a
cursor that ends at a declared terminal, and an unreachable predecessor could never complete. Plans
outside the class keep `FrontierTopology`.

The kernel may interleave the branches of a wider DAG differently from the frontier (declared
control-edge order versus queue order), but it visits every entered node once and the join once. The
three-engine drill for the diamond and the depth-2 diamond is in `test/unit/transition-matrix.test.ts`.

## Composed routing contract

Defined in `packages/core/src/compose.ts`. Each stage declares its exits in evaluation order:

1. a **budget exit** to the answer-only `n_answer` when `ANSWER_RESERVE_STEPS` (1) step remains;
2. its failure exits — `callFailed`, `lastOk = false`, and its own no-progress guard — to **one**
   repair node;
3. its success guard to the next stage, or to `n_answer`.

The repair node mirrors the budget/failure exits to `n_answer`, carries the same success edge, and
ends with an unconditional answer fallback. There is **no repair → stage back-edge**: one repair
attempt per stage, then the answer continues abandoned work.

Success does not follow from step activity: each composed node carries a declared
`NodeEvidenceContract` (`PlanNode.evidence`) and its success guard is the node-scoped fact
`evidence.ok`. `synthesizeComposition` fills the contract from capability data only — the artifact
types the stage's capability declares for discover/inspect/mutate (each ref must be measured in the
world at the step boundary, so a phantom write certifies nothing), the author's one required
artifact type, and for verify a verifier clause (the declared verifier must carry, in one of its
declared locator parameters, the exact ref of an artifact an earlier step produced, with a clean
status; free text is never read as evidence). `satisfiesNodeEvidence`
(`packages/core/src/condition.ts`) evaluates it over that node's own step projection
(`packages/loop/src/step-facts.ts`). A stage with no declared contract emits no success exit;
`verificationFailed` remains the verify failure exit. A non-zero shell exit
(`[exit code: N]`) is a normal DSH result, not a tool-invocation error: it is folded into
`verificationFailed`, while `lastOk` stays about tool invocation, so an inspect step running
`grep`/`diff` is not sent to repair.

**Reserve boundary.** Because the budget exit is evaluated first, a stage that cannot succeed at the
answer reserve goes to `n_answer` instead of repairing forever. `n_answer` is a **continuation, not
a success claim**: the run reports `done` only when the abandoned work owed no artifact obligation,
but the failed verify step and its `[exit code: N]` output remain in the node trail and session log.
Both engines reserve one extra step for a budget-routed wrap-up node when the `budget` edge targets
a declared terminal; a non-terminal that runs out of matching exits settles `finished` (the run
status stays `done`), not `failed` (`packages/loop/src/kernel/topology.ts`,
`packages/core/src/topology.ts`). An abandoned artifact-producing stage leaves an unmet completion
obligation: the answer terminal refuses completion and installs the turn's one bounded recovery when
the plan has steps for it, failing the run when the recovery is refused or does not fit
(`GRAPH_FAILED`; `packages/loop/src/scheduler.ts`).

No claim is made that LangGraph executes arbitrary graphs. The kernel checkpointer is a per-run
cache (`MemoryCheckpointer` in `packages/loop/src/kernel/plan.ts`); `storageDomain` durability is
not wired. A completed node boundary is recorded durably in the session log
(`plugin:graph-loop/checkpoint`), so a resumed kernel-driven turn continues at `state.next`; a
frontier-owned plan records no checkpoint and starts a fresh plan.
