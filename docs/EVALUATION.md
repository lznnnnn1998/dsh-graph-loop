# Evaluation — OfficeBench probe and public head-to-head

Status: **protocol defined; probe not started.** Related: [`docs/COMPOSITION.md`](COMPOSITION.md)
§0 and §5 (D14/D15).

## 1. What we are testing

**Hypothesis (accuracy first).** The composition layer — per-turn capability envelope plus a
capability-driven graph — produces better task outcomes than the DSH default experience, with no
speed or cost regression that would make it unattractive.

Accuracy is the headline. Speed and experience are secondary and are recorded in the same runs, not
optimized separately.

## 2. Arms

| Arm | What runs | Purpose |
|---|---|---|
| `official` | DSH default profile as shipped | The user-facing claim: “better than the official experience.” |
| `stock` | Stock `agent-loop` + the same model, tools and `max_iter` as `composition` | Attribution: isolates orchestration from preset/tool differences. |
| `composition` | This bundle (control plane + envelope + graph) | The candidate. |

All arms use the same model, the same OfficeBench tasks, the same `max_iter`, and the same container
image. Record the DSH commit, bundle version, model id and container digest for every run.

## 3. Probe (M4)

- **Five single-app tasks**, one or two from each of Word, Excel and PDF. OfficeBench has no
  PowerPoint app, so PowerPoint is explicitly out of the probe. Fixed task ids live in
  [`bench/officebench/probe-tasks.json`](../bench/officebench/probe-tasks.json) and are pinned with
  the OfficeBench commit `b978b808667c32b52ce19a67ce1def1de9ae02b7`.
- **Why single-app:** the probe validates the infrastructure (container, action mapping, evaluator)
  before adding cross-app workflows.
- **Run all three arms on all five tasks** (15 task-runs).
- **Pass criteria:**
  1. all three arms complete all five tasks;
  2. the OfficeBench evaluator returns a score for every one of the 15 runs;
  3. no harness crash that requires a manual restart.
- **The probe does not require composition to win.** It only proves the loop is measurable.
- **Gate:** after the probe, decide **continue / change benchmark / stop**. This is the first hard
  decision point in the project.

## 4. Full head-to-head (M5)

- **Fixed subset, registered before running.** Suggested stratification: 10 single-app, 10 two-app
  and 10 three-app tasks (30 total). The exact task ids and seed are committed before the first run.
- All three arms on the same subset.
- **Primary metric:** OfficeBench evaluator score per task and aggregate success rate.
- **Secondary metrics:** steps, tool calls, billed input, `cacheReadRatio`, p50/p95 latency, wall
  time, crash count. Report **both the mean and the median** for every metric; long-tail latency
  makes the mean alone misleading, and a single median can hide a heavy tail.
- **Report:** per-task table plus aggregate, with the exact command, config, commit and model.
  Raw results in `bench/results/officebench-<date>/`.
- **Pre-register the acceptance before the full run** (after the probe calibrates variance):
  `composition` must not be worse than `official` on the primary score, must beat `stock` on the
  primary score, and must not regress latency or billed input beyond the agreed band.
- **Publish the report whether it wins or loses.** A negative result is a valid outcome and feeds
  the hedge decision.

## 5. Task and environment mapping

- OfficeBench runs in its Docker image with its own action API (`read_file`, `send_email`, …).
- The adapter path is chosen by the probe:
  - **Docker bridge:** expose OfficeBench actions as DSH tools/MCP and run DSH as the agent; or
  - **file-level reimplementation:** use DSH document/spreadsheet/presentation tools on the task
    files and reuse the evaluator where possible.
- Record the action mapping and every unsupported action as a known limitation.
- Same container image, same task files, same seed for all three arms.
- Setup and pinned version: [`bench/officebench/README.md`](../bench/officebench/README.md).

## 6. Confounds and threats

| Threat | Handling |
|---|---|
| Default profile has different tools/presets | The `stock` arm isolates orchestration. |
| OfficeBench actions do not map 1:1 to DSH tools | The probe is exactly this check; unsupported actions are recorded. |
| Small probe sample | The probe is an infrastructure check, not a statistical claim. |
| Warm/cold cache and run order | Randomize arm order per task; record cache metrics. |
| Retries and partial failures | Log every attempt; a crash is a failure, not a silent retry. |
| Evaluator version drift | Pin the OfficeBench commit and evaluator version. |

## 7. Decision gates

1. **Probe gate (M4):** pass = three arms × five tasks completed and scored. Fail = change
   benchmark or stop; do not scale.
2. **Report gate (M5):** if `composition` does not beat `official` on accuracy after the full
   subset, pivot to the hedge (Graph tab + composition contract) instead of extending the benchmark
   indefinitely.
3. **No 1.0 gate.** The project is milestone-driven; a pivot is a legitimate outcome.

## 8. Artifacts

- [`bench/officebench/probe-tasks.json`](../bench/officebench/probe-tasks.json) — the fixed 5-task
  probe, pinned to the OfficeBench commit.
- `scripts/officebench-preflight.sh` — environment/commit/task check before the probe.
- `bench/results/officebench-<date>/` — raw scores, logs, config, container digest.
- A public report (README link or `docs/reports/`) with the task list, commands, results and
  limitations.
- This document is updated with the actual commands once the probe runs.
