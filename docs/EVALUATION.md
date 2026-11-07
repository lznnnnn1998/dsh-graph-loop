# Evaluation — official benchmarks + local pre-signal

Status: **protocol defined; local pre-signal runnable; official benchmarks gated on container
runtime and agent adapters.** Related: [`docs/COMPOSITION.md`](COMPOSITION.md) §0/§5 and
[`docs/MERGE-LANGGRAPH.md`](MERGE-LANGGRAPH.md).

## 1. What we are testing

**Hypothesis.** The graph/plugin path — graph planning, per-plan tool admission and the LangGraph
kernel — produces equal or better task outcomes than the stock DSH loop, with lower prompt tokens
and no unacceptable latency regression.

Accuracy is the headline. Tokens, steps and wall time are recorded in the same runs; both **mean and
median** are reported because API stalls create a heavy tail.

## 2. Benchmarks

| Tier | Benchmark | Status |
|---|---|---|
| Primary | **Terminal-Bench 4.0** | **Runnable**: Docker + Harbor + DSH adapter; one task scored (0.0), no aggregate yet |
| Primary | **NL2Repo-Bench** | Harness public; OpenHands-only + Docker, so a DSH adapter is required |
| Pre-signal | [local 20-task suite](../bench/agent-eval/tasks.json) | **Runnable now**; stock vs graph, real model |
| Secondary | [OfficeBench 5-task probe](../bench/officebench/probe-tasks.json) | Prepared; needs Docker/OfficeBench |

The model is `deepseek-flash`, which is the **DeepSeek V4.1-Flash-1017** snapshot. Model-card scores
(Terminal-Bench 4.0: 42.3, NL2Repo-Bench: 68.2) are references, not baselines, unless the harness,
prompt, tools, max steps and timeouts match the card exactly.

## 3. Arms

| Arm | What runs | Purpose |
|---|---|---|
| `official` | DSH default profile as shipped | User-facing claim |
| `stock` | Stock `agent-loop` + same model/tools/budget | Attribution |
| `composition` | This bundle (graph driver + kernel) | Candidate |

All arms use the same model, tasks, `max_iter`, container image and harness version.

For benchmark runs the graph arm must set **`toolPolicy: preset`** on the `agent-loop` row. The
default `plan` policy narrows tools to the plan universe; a benchmark harness may register tools the
synthesized plan does not name, and silently hiding them would invalidate the comparison. See
[`packages/loop/README.md`](../packages/loop/README.md).

## 4. Primary: Terminal-Bench 4.0

- Harness: [`harbor-framework/terminal-bench`](https://github.com/harbor-framework/terminal-bench),
  run through [Harbor](https://harborframework.com/docs).
- Preflight: `bash bench/official/terminal-bench/preflight.sh` (currently **READY**).
- Docker is installed via Colima; the DSH adapter is
  [`bench/official/terminal-bench/dsh_agent.py`](../bench/official/terminal-bench/dsh_agent.py).
- On Apple Silicon, build task images natively with `build-arm64-task.sh`; the published amd64
  images crash Node under qemu.
- Exact command and adapter requirement: [`bench/official/README.md`](../bench/official/README.md).
- Target: model-card 42.3. Run a fixed 10–20-task subset first; full set only after the probe.
- Environment smoke: `smoke/answer-42` — oracle **1.0**, graph **1.0**, stock **1.0**. Run
  `run-smoke.sh` before any subset; it proves Docker/Harbor/verifier/adapter health.
- Hard subset: 7 tasks, **0.0 on every clean trial** (see `bench/official/results/terminal-bench-subset/`).
  This is an agent-quality result, not an environment failure.
- Gate: run a pre-registered 10–20-task subset on native images before claiming a Terminal-Bench
  number.

## 5. Primary: NL2Repo-Bench

- Harness: [`multimodal-art-projection/NL2RepoBench`](https://github.com/multimodal-art-projection/NL2RepoBench),
  104 tasks, OpenHands headless, Docker images `openhands:0.56` and `runtime:0.56-nikolaik`.
- Preflight: `bash bench/official/nl2repo/preflight.sh`.
- Target: model-card 68.2.
- Gate: the harness must be adapted from OpenHands to DSH (or DSH must be wrapped as an OpenHands
  agent). Until then the score is not measured.

## 6. Pre-signal: local 20-task suite

- Tasks: [`bench/agent-eval/tasks.json`](../bench/agent-eval/tasks.json), fixtures under
  `bench/agent-eval/tasks/<id>/`. Each check fails on the initial fixture and passes on a verified
  solution.
- Run: `bash bench/agent-eval/run-real.sh --arm both --reps 2`.
- Metrics: success, steps, tool calls, billed input, output, cache read, prompt tokens, wall time.
- Report both mean and median; save `results.json` under `bench/agent-eval/results/` and summarize
  with `node bench/agent-eval/summarize.mjs <file> --per-task`.
- Latest: **40/40 both arms**, prompt **24,454 → 9,612 (−60.7% mean; −59.5% median)**, steps
  4.1 → 4.0; wall mixed (+5.9% mean / −7.4% median). Full rows in
  [`bench/agent-eval/RESULTS.md`](../bench/agent-eval/RESULTS.md).
- This suite is **not** Terminal-Bench/NL2Repo; it is the cheap signal for the plugin seam.

## 7. Secondary: OfficeBench

The original 5-task single-app probe is still valid for office-app fidelity, but it is not in the
primary benchmark set. It needs Docker/OfficeBench; see
[`bench/officebench/README.md`](../bench/officebench/README.md). OfficeBench has no PowerPoint app.

## 8. Metrics and reporting

- **Primary:** task score / success per benchmark, aggregate.
- **Secondary:** steps, tool calls, billed input, `cacheReadRatio`, output tokens, p50/p95 latency,
  wall time, crash count.
- Report **mean and median** for every metric; identify outliers and do not cite a mean-dominated
  wall time as a win.
- Per-task table + aggregate + exact command/config/commit/model/harness digest.
- Raw rows in `bench/agent-eval/results/` (local) or `bench/official/results/` (official).

## 9. Decision gates

1. **Local pre-signal:** 20 tasks × 2 arms; graph must not lose success, must keep the token
   reduction, and must not show an unexplained wall regression.
2. **Official probe:** Terminal-Bench 4.0 fixed subset, three arms. All arms must complete and be
   scored; then decide continue / change benchmark / stop.
3. **Full head-to-head:** only after the probe; pre-register the subset and acceptance before the
   first full run.
4. Publish the report whether it wins or loses.

## 10. Artifacts

- `bench/agent-eval/` — local harness, tasks, results, mean/median summarizer.
- `bench/official/` — official preflights and runbooks.
- `bench/officebench/` — OfficeBench probe manifest and preflight.
- `docs/STATUS.md` — current snapshot and gaps.
