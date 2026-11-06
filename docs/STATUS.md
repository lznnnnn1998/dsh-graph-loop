# Status — 2026-11-07

One-page snapshot of the repository. Decisions: [COMPOSITION.md](COMPOSITION.md). LangGraph merge
plan: [MERGE-LANGGRAPH.md](MERGE-LANGGRAPH.md). Evidence: [bench/agent-eval/RESULTS.md](../bench/agent-eval/RESULTS.md).

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
| Composition core | envelope / role resolution, capability-driven synthesis, annotation layer, checkpoint contract — pure core, 25 focused tests |
| UI | Graph tab + `/graph-chat`; installed e2e passes |
| Packaging | tarball install + packed-loop runtime e2e passes (`scripts/e2e-tarball.sh`) |
| Benchmark | local 20-task stock-vs-graph suite (2 reps) + validated fixtures; official preflights are NOT READY here |
| Tests | **115 unit tests**, typecheck clean, installed e2e + tarball e2e pass |

## Evidence (real model, `deepseek-flash`, `reasoningEffort: high`)

| Run | success | prompt tokens mean / median | steps mean / median | wall mean / median |
|---|---|---|---|---|
| stock, 20 tasks × 2 reps | 40/40 | 24,454 / 23,556 | 4.1 / 4 | 11.3 s / 9.87 s |
| graph, 20 tasks × 2 reps | 40/40 | **9,612 / 9,538** | **4.0 / 4** | 12.0 s / 9.14 s |
| delta | parity | **−60.7% / −59.5%** | −3.0% / 0 | +5.9% / −7.4% |

The token and step wins hold for mean and median. **Wall time is not a win**: the mean is +5.9% and
the median −7.4%; one graph run took 49 s. Earlier 6-task runs (installed and kernel-live) are in
[`bench/agent-eval/RESULTS.md`](../bench/agent-eval/RESULTS.md).

## Known gaps

1. **Kernel coverage is partial**: conditional/failure edges, subagent batches and plans with
   LangGraph-reserved node ids still use `FrontierTopology`.
2. **Checkpoints are in-memory** (`MemoryCheckpointer`); `storageDomain` persistence and
   `getStateHistory` are not wired.
3. **Accuracy is parity**, not better on the easy suite. The local suite is now **20 tasks**; the
   official Terminal-Bench 4.0 / NL2Repo-Bench runs are gated on Docker plus DSH agent adapters.
4. **No official benchmark score is measured**; the preflights in `bench/official/` exit NOT READY
   on this machine (no Docker/Modal).
5. **Fork duplication** remains: `packages/loop` is a source copy of DSH's loop. Version tracking is
   automated today; it is still maintenance debt.
6. **OfficeBench probe is not executed**; it is now a secondary benchmark.
7. **No push** unless asked; the tree is committed locally after this snapshot.

## Next, in order

1. Review and commit the current tree (local commit; no push unless asked).
2. Build the DSH agent adapters and run Terminal-Bench 4.0 + NL2Repo-Bench on a Docker/Modal
   machine; publish the head-to-head report.
3. M3e: kernel routing for conditional/subagent plans; `storageDomain` checkpoint saver.
4. Optional: OfficeBench office-app probe; control-plane path to remove the fork duplication.

## Commands

```sh
bash scripts/install-explore.sh          # install into the web profile
npm test                                 # 115 unit tests
npm run typecheck
bash scripts/e2e-installed.sh            # installed bundle e2e (mock LLM)
bash scripts/e2e-tarball.sh              # packed-tarball install path
bash scripts/verify-all.sh               # typecheck + tests + both e2e + links
bash bench/agent-eval/run-real.sh --arm both --reps 2
node bench/agent-eval/summarize.mjs bench/agent-eval/results/2026-11-07-local-2x.json --per-task
bash bench/official/terminal-bench/preflight.sh  # official; NOT READY without Docker/Modal
bash bench/official/nl2repo/preflight.sh         # official; NOT READY without Docker
scripts/officebench-preflight.sh                 # secondary office probe
```
