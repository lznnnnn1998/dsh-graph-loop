# Official benchmarks — plan, gates, and current status

Primary benchmarks chosen from the DeepSeek V4.1-Flash-1017 model card:

| Benchmark | Model-card score | Harness | Gate |
|---|---|---|---|
| **Terminal-Bench 4.0** | 42.3 | [Harbor](https://github.com/harbor-framework/terminal-bench) | Docker/Modal + a DSH Harbor agent adapter |
| **NL2Repo-Bench** | 68.2 | [OpenHands headless](https://github.com/multimodal-art-projection/NL2RepoBench) | Docker + an OpenHands→DSH adapter |

Adapter contract: [`adapter-contract.md`](adapter-contract.md).

The archived local 20-task benchmark in [`../archive/agent-eval/`](../archive/agent-eval/) is the
**old pre-signal** (superseded 2026-11-07). Official runs are gated on the missing pieces below; do
not report a model-card comparison until the exact harness version, task selection and agent
adapter are pinned.

## Current status (2026-11-07, after installing Docker)

- **Docker is installed** via Colima (`--vm-type vz`, 8 GB / 4 CPU); Docker Compose is installed.
- **Harbor is installed** (`uv tool install --python 3.12 'harbor[modal]'`), and the
  `terminal-bench/terminal-bench@latest` dataset (66 tasks) is downloaded. **The dataset is
  unpinned**: `@latest` was used and no digest was recorded, so these runs are not exactly
  reproducible; pin a digest before a reportable product run.
- **Terminal-Bench DSH adapter is implemented**:
  [`dsh_agent.py`](terminal-bench/dsh_agent.py) — `terminal-bench/preflight.sh` checks for it. It
  installs Node + DSH in the task container, installs the packed graph plugin, sets
  `toolPolicy: preset`, runs one DSH turn in `/app`, and can run the stock loop with `DSH_STOCK=1`.
- **Official trials are scored** (local arm64 adaptations): `html-js-filter` (both 0.0) and a fixed
  **7-task** subset attempt (0.0 on every clean trial; 2 clean stock / 5 clean graph trials, the rest
  timeouts or sidecar errors). Details:
  [`results/2026-11-07-html-js-filter/`](results/2026-11-07-html-js-filter/) and
  [`results/terminal-bench-subset/`](results/terminal-bench-subset/).
- **No nonzero task and no aggregate yet**; the harness is working, the agent is not solving these
  hard tasks. Use [`run-subset.sh`](terminal-bench/run-subset.sh) for a fixed subset.
- **Apple Silicon caveat**: published task images are amd64 and Node crashes under qemu
  (`uv__io_poll` assertion). Build a native arm64 copy with
  [`build-arm64-task.sh`](terminal-bench/build-arm64-task.sh) before running DSH. This changes the
  platform from the public amd64 leaderboard; record it.
- **NL2Repo-Bench is not adapted yet**: its harness is OpenHands-specific
  (`openhands/openhands_app.py`) and needs a DSH replacement.
- This is **not an aggregate Terminal-Bench score**; one task — or a handful — is not a benchmark.

## Product suite (10 easy + 10 medium)

The product line uses a fixed 20-task Terminal-Bench suite:
[`subsets/product20.json`](subsets/product20.json). It is separate from the hard stress subset.
Run:

```sh
bash bench/official/subsets/run-product20.sh
```

Task directories must be built natively under `/tmp/tb-arm-dsh` first. If a task cannot build
(sidecar/desktop dependency), record it as an infrastructure gap; do not substitute a different task.

## Smoke first (required)

```sh
bash bench/official/terminal-bench/build-smoke.sh
bash bench/official/terminal-bench/run-smoke.sh
```

Oracle, graph and stock must all score **1.0** on the trivial `answer-42` task before a benchmark
subset. Latest: [`results/smoke-answer-42/`](results/smoke-answer-42/).

## Evidence caveats (recorded, not hidden)

- **The smoke gate was added after the first runs.** The first `html-js-filter` trial and the first
  7-task subset attempt ran from 12:38 to 20:07; `run-smoke.sh` first ran at 21:29. Only
  [`results/terminal-bench-post-smoke/`](results/terminal-bench-post-smoke/) follows the smoke-first
  protocol. Earlier rows are not smoke-gated (the environment still ran end to end — Harbor started
  the tasks, ran the agent and scored with the real verifier).
- **Dataset unpinned.** `terminal-bench/terminal-bench@latest` (66 tasks) with no recorded digest;
  these runs are not exactly reproducible until a digest is pinned.
- **Graph arm retry policy.** The graph arm's profile patch also sets
  `llm-deepseek.retryPolicy.maxRetries: 1` (`terminal-bench/dsh_agent.py:121`); the stock arm uses
  the default. Arm deltas are therefore not purely the plugin effect.
- **Error rows in summaries.** `summary.json` serialises timeout/error rows as `score: 0.0` with
  `n_trials: 0` / `n_errors: 1`; those are placeholders, not valid 0 scores. `rows.jsonl` is
  canonical.

## Run protocol (when the gates pass)

1. Pin the model: `deepseek-flash` is the 1017 snapshot; record the provider/model and
   `reasoningEffort` in the run manifest.
2. Pin the harness commit/tag and dataset digest before the first run.
3. Pre-register a fixed task subset (do not select after seeing results). Start with 10–20 tasks;
   only run the full set after the probe is green.
4. Two arms, same harness and config:
   - **stock**: official DSH loop;
   - **graph**: this plugin, `toolPolicy: preset` so benchmark tools are never hidden by plan
     filtering.
5. Run `--reps 2` where the harness supports repetitions; report **mean and median** for steps,
   tool calls, prompt tokens, output tokens, wall time and score, plus success counts.
6. Report absolute score **and** delta vs stock. Only compare to the model card when the harness,
   prompt, tools, max steps and timeouts are identical to the card's setup.
7. Store raw rows and the exact command under `bench/official/results/<date>-<harness>/`.

## Terminal-Bench 4.0

```sh
bash bench/official/terminal-bench/preflight.sh

# pack the plugin once
npm pack ./packages/loop --pack-destination dist

# build one task natively for Apple Silicon (repeat per task)
bash bench/official/terminal-bench/build-arm64-task.sh \
  "$HOME/.cache/harbor/tasks/packages/terminal-bench/html-js-filter/<hash>" /tmp/tb-html-arm

# run graph (stock: add DSH_STOCK=1)
PYTHONPATH="$PWD/bench/official/terminal-bench" \
DSH_PLUGIN_TARBALL="$PWD/dist/dsh-graph-loop-0.1.2.tgz" \
harbor run --path /tmp/tb-html-arm --agent dsh_agent:DshAgent \
  --model deepseek/deepseek-flash --ae DEEPSEEK_API_KEY=... \
  --env docker --n-concurrent 1 --yes

# fixed subset (stock + graph, rows + summary)
bash bench/official/terminal-bench/run-subset.sh /tmp/tb-arm-dsh
```

The model card used 42.3; treat it as a reference, not a guarantee under a different harness,
platform, or subset.

## NL2Repo-Bench

```sh
bash bench/official/nl2repo/preflight.sh
git clone https://github.com/multimodal-art-projection/NL2RepoBench.git /tmp/nl2repo
cd /tmp/nl2repo
python3 -m pip install -r requirements.txt
# adapt openhands/openhands_app.py or supply a DSH agent; then:
python3 main.py
```

The repo has 104 tasks (`test_files/`), Docker images, and writes one result JSON per task under
`result/`. The model card used 68.2.

## What is deliberately not claimed

- No aggregate official benchmark has been run. Recorded so far: one single-task trial
  (`html-js-filter`), one fixed 7-task subset attempt (2 clean stock / 5 clean graph trials, all
  0.0, the rest errors), one 3-task post-smoke subset, and the smoke task (1.0 in all three arms).
  None of these is a benchmark score.
- The archived local 20-task suite is not Terminal-Bench/NL2Repo; it measures the same plugin seam
  on a cheaper harness (and its billed total rises — see `docs/EVALUATION.md` §1.2).
- A model-card score is **not** a baseline for this plugin until the adapter and harness match.
