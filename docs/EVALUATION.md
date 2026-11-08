# Evaluation — product20

Status: **instrument repaired, the pre-run diagnostic gate passes, and the full product20 is
running; no stock-vs-graph aggregate exists yet.** The first 2026-11-09 diagnostic failed on two
infrastructure faults; both were fixed and the four tasks were rerun
([final table](../bench/official/results/2026-11-09-prediag-fixes/README.md)): all eight rows have
`n_trials: 1` and `n_errors: 0`, including `vpp-loss-divergence` (4/5 both arms) and
`medical-claims-processing` (2/27 graph, 22/27 stock) on an arm64 sidecar. The full run started
2026-11-09 04:18:32 +08 as PID `38616` with OUT_DIR
`bench/official/results/2026-11-09-product20/`; its `rows.jsonl` grows per trial and is the canonical
partial record. Do not start a second run or run the smoke gate while it is live. No product claim
until all 20 tasks have valid stock and graph trials, and an oracle control shows the harness can
score a pass on the task. Readiness:
[`2026-11-09-product20-prep`](../bench/official/results/2026-11-09-product20-prep/README.md)
(historical snapshot from before the run).

## Suite

- Terminal-Bench 4.0, 10 easy + 10 medium.
- Manifest: [`bench/official/subsets/product20.json`](../bench/official/subsets/product20.json).
- Fixed before running; do not swap tasks after seeing scores. All 20 env and verifier images exist
  (including `formal-crypto`). `medical-claims-processing` now runs on an arm64-native
  `playwright-mcp` sidecar, so it produces valid `n_trials: 1` trials (expected 0 reward: DSH has no
  native SSE MCP client). Do not treat it as an infrastructure blocker; do not backfill a row for it.

## Arms

| Arm | What runs |
|---|---|
| `stock` | stock `agent-loop`, same model/tools/budget |
| `graph` | this bundle; dynamic mode uses envelope + composition |

Both arms use the same model, task image, tool policy, timeouts and agent timeout.

## Timeout policy

- Each task's `[agent].timeout_sec` in `task.toml` is the agent budget used by
  `bench/official/terminal-bench/run-subset.sh`.
- `DSH_AGENT_TIMEOUT_CAP` is an operator fail-fast override: when set, it replaces the task budget
  for every task. There is no other override.
- The adapter has the same 900 s fallback for direct Harbor use, but the runner always exports the
  task budget, so a run started through the scripts is task-driven.
- A timeout (or any `n_trials: 0` row) is an **infrastructure failure, not a score**. Do not average
  it, and do not report it as an agent 0.0.
- `--agent-setup-timeout-multiplier 5` is fixed in the runner: node/DSH install and plugin setup are
  allowed 5x the Harbor setup budget, separately from the agent turn.

The 2026-11-08 partial run predates the per-task policy: the runner then exported a fixed
`DSH_AGENT_TIMEOUT_SEC=900`, which is why most stock arms show `Command timed out after 900 seconds`.
That run's timeout class is therefore a harness-policy artifact, not a task outcome.

## Run protocol

1. `run-smoke.sh`: oracle/graph/stock must all be 1.0.
2. Build native arm64 task env + verifier images (see [`bench/README.md`](../bench/README.md)).
3. **Pre-run diagnostic (required before a full product20).** Run exactly these four tasks with a
   deliberate cap and a fresh output dir:

   ```sh
   TASKS="vpp-loss-divergence intrastat-meldung heat-pump-warranty medical-claims-processing" \
   DSH_AGENT_TIMEOUT_CAP=3600 \
   OUT_DIR=bench/official/results/$(date +%Y-%m-%d)-product20-diagnostic \
   bash bench/official/terminal-bench/run-subset.sh /tmp/tb-arm-dsh
   ```

   Also run the `formal-crypto` verifier directly (or one bounded `formal-crypto` trial) and record
   the command and output. Record `n_trials` and the criteria object for every diagnostic row.
   `n_trials: 0` is a real infrastructure failure — fix it or block and do **not** start the full
   run. A `0.0` with `n_trials >= 1` is a valid trial (a near-miss, not a pass) and does not block.
   This diagnostic is a readiness gate, not a new score.

   **Result of the 2026-11-09 attempt: the first run FAILED, then PASSED after fixes.** The first
   run is at [`2026-11-09-prediag-0122`](../bench/official/results/2026-11-09-prediag-0122/README.md):
   `intrastat-meldung` (graph 0/47, stock 42/47) and `heat-pump-warranty` (graph 1/21, stock 16/21)
   were valid; `vpp-loss-divergence` had `n_trials: 0` (legacy-builder heredoc drop) and
   `medical-claims-processing` had `n_trials: 0` (amd64 sidecar never healthy). Both were repaired
   and rerun; the final table is
   [`2026-11-09-prediag-fixes`](../bench/official/results/2026-11-09-prediag-fixes/README.md):
   vpp graph/stock 4/5, medical graph 2/27 / stock 22/27, plus the two earlier valid tasks. All
   eight rows have `n_trials: 1`, `n_errors: 0`; the gate passes. The direct `formal-crypto` verifier
   check passed (Python 3.12.14, SageMath 10.7). The full product20 has since been started
   (2026-11-09 04:18:32 +08, PID `38616`, OUT_DIR `bench/official/results/2026-11-09-product20/`) and
   is live. If that final table exists, do not repeat the diagnostic; if a benchmark is live, report
   "benchmark in progress" instead of starting another run.
4. Run `bash bench/official/subsets/run-product20.sh`; each task runs graph and stock.
   `run-subset.sh` now defaults `TASKS` to the product20 manifest and `OUT_DIR` to
   `bench/official/results/terminal-bench-product20/`. Do not pass an ad-hoc task list except for the
   declared diagnostic above.
5. Keep `rows.jsonl` as the canonical rows; a `0.0` with `n_trials: 0` is an infrastructure error,
   not a score.

`run-subset.sh` truncates `<OUT_DIR>/rows.jsonl` at start and always iterates every task in `TASKS`:
there is **no resume**, so give each invocation its own `OUT_DIR`. A long product20 may run in the
background (see [`automation/evaluator.md`](../automation/evaluator.md)), but it is still one run,
not a resumable one.

## Row schema

Every row written by `run-subset.sh` must carry:

| Field | Meaning |
|---|---|
| `task`, `arm`, `score`, `n_trials`, `n_errors`, `exit` | trial outcome |
| `commit` | `git rev-parse HEAD` at run start |
| `model` | model id used by both arms |
| `image_env`, `image_verifier` | task image tags actually used |
| `agent_timeout_sec` | task `[agent].timeout_sec` (or `DSH_AGENT_TIMEOUT_CAP`) |
| `agent_setup_timeout_multiplier` | Harbor setup multiplier |
| `result` | durable copy under `<OUT_DIR>/raw/`, not a `/tmp` job path |

A row missing any of these is not reportable. The 2026-11-08 partial rows predate the schema and
cannot be re-derived from their `/tmp` job trees (see the partial README); do not backfill invented
values.

## Metrics

- Primary: accuracy parity, prompt tokens (mean and median), steps.
- Secondary: billed input/output/total, output tokens, wall time, errors.
- Record model, commit, harness and image tags with every result.

Rows do not carry token or step counts, and Harbor's `result.json` stats are null
(`n_input_tokens`, `n_output_tokens`, `cost_usd`). Extract them from each trial's session log
`<jobs-dir>/<job>/<task>__*/agent/dsh-sessions/**/session.v4.jsonl.zstd`:
`assistant/message.data.usage` carries `inputTokens`, `outputTokens`, `cacheReadTokens`,
`cacheWriteTokens` and `totalTokens`; `step/start` and `tool/call` records give step/tool counts, and
`turn/end` gives the terminal status. Cost is not in the session log: report it as unavailable or
compute it from the recorded token counts and a stated price basis, labelled as computed (not
measured).

## Success criteria

1. Accuracy parity with stock on the 20 tasks.
2. Lower prompt tokens (mean and median).
3. Steps parity or better.
4. No DSH source changes; installable/default-mode behavior verified.
5. The live path uses the graph driver, not only core tests.

## Current evidence

- Current tree: `ci-local.sh` PASS, `npm test` **256/256** (0 fail, 0 skipped), typecheck and
  `build:check` green; the transition matrix drives the frontier, the minimal kernel and the default
  LangGraph kernel.
- Readiness (2026-11-09): **20/20 env and 20/20 verifier** images, `formal-crypto` included (SageMath
  10.7 / Python 3.12.14; its direct `--cpus 8` check passed); the `tb-dsh-base` overlay (Node v24.9.0
  + DSH 0.2.2-rc.1) is on every env image; product20 sidecars are pulled; Colima is **8 vCPU /
  20 GiB / 150 GiB**; the daemon proxy inside Colima points at the current host LAN IP
  ([readiness](../bench/official/results/2026-11-09-product20-prep/README.md)).
- Pre-run diagnostic (2026-11-09, HEAD `5cae65c`): the first run **FAILED**
  ([result](../bench/official/results/2026-11-09-prediag-0122/README.md)) with valid trials for
  `intrastat-meldung` (graph 0/47 / stock 42/47 criteria) and `heat-pump-warranty` (graph 1/21 /
  stock 16/21), and `n_trials: 0` on both arms for `vpp-loss-divergence` (legacy-builder heredoc drop
  left `/opt/verifier_pristine` empty) and `medical-claims-processing` (amd64 `playwright-mcp`
  sidecar never healthy under qemu). Both faults were repaired and the four tasks reran
  ([final table](../bench/official/results/2026-11-09-prediag-fixes/README.md)): vpp 4/5 both arms
  (stock 56m57s), medical 2/27 / 22/27, all eight rows `n_trials: 1` / `n_errors: 0`; **the gate
  passes**. The repairs are local-only: `build-arm64-task.sh` still uses the legacy builder, so a
  canonical vpp rebuild reproduces the defect, and the medical compose tag is a local edit. Do not
  rebuild or reset either while the run is live; the code fixes and retests are deferred until the
  runner exits.
- Full product20 (live, 2026-11-09): started 04:18:32 +08, PID `38616`, OUT_DIR
  `bench/official/results/2026-11-09-product20/`, log `/tmp/product20-2026-11-09.log`, marker
  `/tmp/product20-shard-full.log` without `_EXIT`. `rows.jsonl` grows per trial; each row carries
  `commit 11fe18f…`, model, image tags, timeout, criteria and a durable `raw/` result. **No aggregate
  yet**; partial rows are not citable. A watcher appends `_EXIT` to the marker when the PID exits; if
  it is absent, append `_EXIT` by hand after confirming the PID is dead (see the run README).
- Smoke (2026-11-09, this tree): **1.0** oracle / **1.0** graph / **1.0** stock on the synthetic
  `smoke/answer-42` task ([record](../bench/official/results/2026-11-09-smoke-prep/README.md));
  harness plumbing only, not product evidence. The raw `result.json` files live in that run's
  git-ignored `jobs/` dir. The 2026-11-08 smoke records are historical.
- Benchmark tarball: `dist/dsh-graph-loop-bench.tgz` is 223,458 B, sha256 `f7a961a797ca5e17…`, and
  `npm pack` in `packages/loop` reproduces it byte for byte at this HEAD — a repack is idempotent, so
  verify the sha rather than treating the artifact as stale. `packages/*/lib` matches a fresh build
  (`build:check` green). The tarball's `package/lib` differs from the checked-out `lib` only in
  esbuild source-path comments (0 non-comment differences).
- 2026-11-08 product20 partial (**historical**): 19/20 tasks attempted (`formal-crypto` had no
  verifier image); 11 graph / 3 stock valid; only 2 paired-valid (`bun-sourcemap-leak`,
  `cargo-flight-dispatch`); all valid scores 0.0. **Invalid as a product aggregate** — that run was
  taken on the pre-repair 4-CPU / 19-verifier instrument
  ([result](../bench/official/results/2026-11-08-product20-partial/README.md)). Reward is binary, so
  read criteria counts, not just reward: stock passed 35/37 on `bun-sourcemap-leak` (graph 18/37) and
  33/40 on `cargo-flight-dispatch` (graph 32/40). It also measured the **pre-fix** five-step plan
  whose `n_answer` removed every tool (80 vs 217 session records), so those graph scores measure
  premature termination, not loop quality. The plan shape has since changed (per-stage
  repair/budget exits, tool-enabled answer), so a rerun on the repaired instrument is required before
  any arm comparison; the partial numbers themselves remain historical and invalid.
- 2026-11-08 oracle control: oracle scores **1.0** on `html-js-filter`, `cargo-flight-dispatch` and
  `music-harmony` ([result](../bench/official/results/2026-11-08-oracle-control/README.md)). The
  task image, verifier and scoring path can pass those tasks, so the partial zeros are not a
  blanket harness artifact.
- `html-js-filter` has two task-level runs: the earlier both-arms-completed 0.0/0.0
  ([result](../bench/official/results/2026-11-08-html-js-filter/README.md)) and the partial run,
  where the stock arm timed out at 900 s. Cite both or cite the latest with that caveat.
- No aggregate. Do not cite older local-suite numbers; they are not in this tree.

## Reporting

Per-task table plus aggregate, with `n_trials`, `n_errors`, prompt/billed tokens and steps. Report
mean and median; identify task build failures separately. State the oracle control result for the
tasks under discussion; a 0.0 without an oracle pass on that task proves nothing about the loop.

Because reward is binary, also report **criteria-level correctness** for every trial: criteria
passed/total, the failed criterion names, and the source (`reward-details.json`, `ctrf.json`,
`pytest-stdout`, `playwright-report.json`, or `unavailable`). `run-subset.sh` writes a `criteria`
object on each row; `bench/official/terminal-bench/criteria.py <job-dir>` extracts it manually.
Report a micro criteria rate (`sum passed / sum total`) and call a 0.0 with high criteria a
near-miss, not a pass. Do not turn criteria into a new score. For pytest tasks, report the rubric
criteria and the `ctrf.json` test counts separately when they differ (a meta criterion such as
`pytest_completed_successfully` is not a test); the row's `criteria` object carries
`tests_passed`/`tests_total`/`tests_source` for that case.
