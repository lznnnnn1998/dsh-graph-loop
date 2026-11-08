# Evaluation — product20

Status: **instrument repaired 2026-11-09; full product20 run pending.** The suite is fixed; no
full stock-vs-graph aggregate exists. No product claim until all 20 tasks have valid stock and graph
trials, and an oracle control shows the harness can score a pass on the task. Readiness:
[`2026-11-09-product20-prep`](../bench/official/results/2026-11-09-product20-prep/README.md).

## Suite

- Terminal-Bench 4.0, 10 easy + 10 medium.
- Manifest: [`bench/official/subsets/product20.json`](../bench/official/subsets/product20.json).
- Fixed before running; do not swap tasks after seeing scores. All 20 verifier images exist
  (including `formal-crypto`); `medical-claims-processing` is a known MCP-SSE limitation.

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
3. Run `bash bench/official/subsets/run-product20.sh`; each task runs graph and stock.
   `run-subset.sh` now defaults `TASKS` to the product20 manifest and `OUT_DIR` to
   `bench/official/results/terminal-bench-product20/`. Do not pass an ad-hoc task list unless it is a
   declared diagnostic.
4. Keep `rows.jsonl` as the canonical rows; a `0.0` with `n_trials: 0` is an infrastructure error,
   not a score.

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

## Success criteria

1. Accuracy parity with stock on the 20 tasks.
2. Lower prompt tokens (mean and median).
3. Steps parity or better.
4. No DSH source changes; installable/default-mode behavior verified.
5. The live path uses the graph driver, not only core tests.

## Current evidence

- Current tree: `npm test` **256/256** (0 fail, 0 skipped), typecheck and `build:check` green; the
  transition matrix drives the frontier, the minimal kernel and the default LangGraph kernel.
- Readiness and gate (2026-11-08, HEAD `f28de84`): 20/20 env images, 19/20 verifier images
  (`formal-crypto` missing), `ci-local.sh` PASS at **253/253** tests; product20 not run.
  `formal-crypto` and `shadow-relay` request `cpus = 8` on a 4-CPU VM, so the suite is not runnable
  end to end ([evaluation](../bench/official/results/2026-11-08-eval-1525/README.md)).
- Post-eval fix (HEAD `63b5f20`, not yet through the evaluator gate or smoke): `verificationRan`
  requires the node's planned verification tool, so a verify step that ran only `read` repairs;
  **256/256** at the cheap gate (`npm run typecheck`, `npm test`).
- Smoke (2026-11-08, `f28de84`): **1.0** oracle / **1.0** graph / **1.0** stock on the synthetic
  `smoke/answer-42` task, run with the `f28de84` tarball packed from `packages/loop`
  ([result](../bench/official/results/2026-11-08-smoke-1525/README.md)); harness plumbing only.
  The smoke did **not** run on `63b5f20`.
- Benchmark tarball: `packages/*/lib` matches a fresh build of the current `63b5f20` source
  (`build:check` green), while `dist/dsh-graph-loop-bench.tgz` is still the `f28de84` tarball
  (223,372 B, sha256 `4893f934…`); it was not repacked for `63b5f20`. `run-smoke.sh` and
  `run-subset.sh` default to it without a rebuild step, so repack and re-run the smoke before any
  product20 run.
- 2026-11-08 product20 partial: 19/20 tasks attempted (`formal-crypto` has no verifier image);
  11 graph / 3 stock valid; only 2 paired-valid (`bun-sourcemap-leak`, `cargo-flight-dispatch`); all
  valid scores 0.0. **Invalid as a product aggregate; the instrument is unvalidated for the full
  suite** ([result](../bench/official/results/2026-11-08-product20-partial/README.md)). Reward is
  binary, so read criteria counts, not just reward: stock passed 35/37 on `bun-sourcemap-leak`
  (graph 18/37) and 33/40 on `cargo-flight-dispatch` (graph 32/40). That run measured the **pre-fix**
  five-step plan whose `n_answer` removed every tool (80 vs 217 session records), so those graph
  scores measure premature termination, not loop quality. The plan shape has since changed
  (per-stage repair/budget exits, tool-enabled answer), so a rerun is required before any arm
  comparison; the partial numbers themselves remain invalid.
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
