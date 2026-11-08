# Status — 2026-11-08

Architecture: **B**. `packages/loop` is a dedicated graph-loop plugin that replaces the stock
`agent-loop` through `AgentFactory`. No DSH source file is modified.

## Works today

| Layer | State |
|---|---|
| Install | `bash scripts/install-explore.sh [profile]` (default `web`) installs driver + Graph tab + Explore mode; verifies `agent-loop` disabled and `preset-explore` default |
| Mode | Explore preset registered; new sessions default to it |
| Kernel | `createKernel()` / `runPlan()` default to **LangGraph**; `MinimalKernel` fallback |
| Live driver | `KernelTopology` pauses before a node; DSH runs the step; kernel resumes. Coverage below |
| Composition | envelope / role resolution / capability composer live in dynamic mode |
| UI | Graph tab + `/graph-chat`; installed e2e passes |
| Packaging | tarball install + packed-loop runtime e2e passes; `build:check` reproducible |

## Kernel coverage (exact)

| Plan shape | Engine | Evidence |
|---|---|---|
| Linear chain | **LangGraph** | `test/unit/kernel-topology.test.ts` |
| Linear + one `callFailed` branch | **LangGraph** (real conditional edge; `routeKernelPlan` selects `state.next`) | `test/unit/kernel-topology.test.ts` |
| Parallel fan-out / join | `FrontierTopology` | `test/unit/topology.test.ts` |
| Subagent batches | `FrontierTopology` | `test/unit/scheduler.test.ts` |
| `artifact`/`noArtifact`/`fact`/`budget` conditions | `FrontierTopology` | `canKernelDrive()` rejects them |
| Reserved node ids | `FrontierTopology` | `canKernelDrive()` rejects them |

No claim is made that LangGraph executes arbitrary graphs.

## Evidence

**Product evidence is not complete.** The active suite is Terminal-Bench easy10 + medium10
([`bench/official/subsets/product20.json`](../bench/official/subsets/product20.json)). Image builds
and trials are in progress. One member, `html-js-filter`, has a real tracked trial:
**graph 0.0 / stock 0.0**, one task, both arms completed — not an aggregate and not a product claim
([result](../bench/official/results/2026-11-08-html-js-filter/README.md)).

The former local 20-task run is not part of this tree and is not citable as current evidence.

## Known gaps

1. **Durable checkpoints**: `MemoryCheckpointer` only; no `storageDomain` saver, no restart resume.
   The blocker is the consumer (replay/time-travel), not storage availability.
2. **Kernel breadth**: parallel fan-out/join, subagent batches and non-`callFailed` conditions still
   use `FrontierTopology`.
3. **Product20 not finished**: native arm64 task images and trials are still running.
4. **Fork debt**: source copy of DSH's loop; enforced by `scripts/diff-upstream.sh --check`.
5. **Benchmark heuristics off by default** (`benchGuards: false`); they are harness-specific.

## Next

1. Finish product20 images and run stock vs graph for all 20 tasks.
2. Report aggregate accuracy, prompt tokens, billed cost and steps.
3. Only after those numbers exist: decide whether the graph loop has a product claim.
4. Then durable checkpoint consumer and kernel breadth.

## Commands

```sh
npm run typecheck
npm test
npm run build && npm run build:check
bash scripts/ci-local.sh
bash scripts/install-explore.sh
bash scripts/verify-all.sh
bash scripts/diff-upstream.sh --check
bash bench/official/terminal-bench/preflight.sh
bash bench/official/terminal-bench/run-smoke.sh
TASKS_DIR=/tmp/tb-arm-dsh bash bench/official/subsets/run-product20.sh
```
