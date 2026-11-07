# Status — 2026-11-07

One-page snapshot of the repository. Decisions: [COMPOSITION.md](COMPOSITION.md). LangGraph merge
plan: [MERGE-LANGGRAPH.md](MERGE-LANGGRAPH.md). Evidence: archived local runs
[bench/archive/agent-eval/RESULTS.md](../bench/archive/agent-eval/RESULTS.md); active product suite
defined in [`bench/official/subsets/`](../bench/official/subsets/).

## What this is

A DSH composition/graph plugin, installed as a bundle: the stock `agent-loop` row is disabled, a
graph driver plus a LangGraph kernel runs the turn, the Graph tab shows the topology, and the
**Explore** mode is the default for new sessions. No DSH source files are modified.

## Works today

| Layer | State |
|---|---|
| Install | `bash scripts/install-explore.sh [profile]` (default `web`) installs driver + Graph tab + Explore mode; verifies `agent-loop` disabled, `preset-explore` present, `agent-preset-registry.default = explore` |
| Mode | Explore preset registered; new sessions default to it (explicit user selection still wins) |
| Kernel | `createKernel()` / `runPlan()` default to **LangGraph**; `MinimalKernel` fallback when the optional dependency is absent |
| Live driver | `KernelTopology` pauses the kernel before a node, DSH runs the step, the kernel resumes with the outcome. Linear plans with safe node ids use it; subagent/conditional plans fall back to `FrontierTopology` |
| Composition core | envelope / role resolution / capability composer **live in dynamic mode**; annotation layer + checkpoint contract; unit suite green |
| UI | Graph tab + `/graph-chat`; installed e2e passes |
| Packaging | tarball install + packed-loop runtime e2e passes (`scripts/e2e-tarball.sh`) |
| Benchmark | product: **Terminal-Bench easy10 + medium10** defined; 20-task run pending; legacy local 20 archived |
| Stress | Terminal-Bench smoke 1.0 all arms; hard subset 0.0 clean (not the gate) |
| Tests | **unit suite green**, typecheck clean, installed e2e + tarball e2e pass |

## Evidence

**Active product suite:** Terminal-Bench easy10 + medium10
([`bench/official/subsets/product20.json`](../bench/official/subsets/product20.json)). It is
**defined but not yet run** after the switch; smoke is 1.0 on oracle/graph/stock.

Archived local 20-task run on the live envelope/compose path (superseded; dirty worktree, not
commit-bound): 40/40 both, prompt **25,105 → 12,561 (−50.0% mean; −48.6% median)**, steps 4.2 → 4.0,
wall +9.4% / +4.2%. The earlier legacy-topology run in the same file (prompt −60.7%) is not
comparable. Cost is not a win: billed total **+16.8%** live (+44.6% legacy), because output tokens
rise +41.2% / +55.2%. See
[`bench/archive/agent-eval/RESULTS.md`](../bench/archive/agent-eval/RESULTS.md).

**Stress line:** Terminal-Bench hard subset 0.0 on clean trials; smoke 1.0. Not the product gate.

## Known gaps

1. **Kernel coverage is partial**: conditional/failure edges, subagent batches and plans with
   LangGraph-reserved node ids still use `FrontierTopology`.
2. **Checkpoints are in-memory** (`MemoryCheckpointer`); `storageDomain` persistence and
   `getStateHistory` are not wired.
3. **The Terminal-Bench product suite is defined but not run**; it needs native builds for the 20
   selected tasks (some have sidecars/desktop deps). The legacy local 20 result is historical.
4. **The stress line is 0.0 on hard tasks**; it is diagnostic, not the product gate.
5. **Fork duplication** remains: `packages/loop` is a source copy of DSH's loop. Version tracking is
   automated today; it is still maintenance debt.
6. **No push** unless asked; the tree is committed locally after this snapshot.

## Next, in order

1. Review and commit the current tree (local commit; no push unless asked).
2. Build and run the Terminal-Bench easy10 + medium10 product suite (stock vs composition).
3. Keep the smoke gate; do not substitute hard stress tasks.
4. Stress line only as needed: smoke, then a fixed subset; do not make it the default gate.
5. M3e: kernel routing for conditional/subagent plans; `storageDomain` checkpoint saver.

## Commands

```sh
bash scripts/install-explore.sh          # install into the web profile
npm test                                 # unit suite
npm run typecheck
bash scripts/e2e-installed.sh            # installed bundle e2e (mock LLM)
bash scripts/e2e-tarball.sh              # packed-tarball install path
bash scripts/verify-all.sh               # typecheck + tests + both e2e + links
bash bench/official/terminal-bench/run-smoke.sh
bash bench/official/terminal-bench/run-subset.sh /tmp/tb-arm-dsh   # product20, after native builds
bash bench/official/terminal-bench/preflight.sh  # READY: Docker + Harbor + DSH adapter
bash bench/official/terminal-bench/run-smoke.sh    # 1.0 oracle/graph/stock; run BEFORE subsets
bash bench/official/terminal-bench/build-arm64-task.sh <task-dir> /tmp/tb-arm64
bash bench/official/nl2repo/preflight.sh         # Docker present; DSH adapter still missing
```
