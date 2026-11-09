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
score a pass on the task. **"Valid" is the three-part test in [Trial validity](#trial-validity)**:
a Harbor trial, a healthy agent terminal, and writable declared artifact paths. `n_trials >= 1`
alone is not enough, and the live run already contains `TRANSPORT` crashes and
`workspace-write`-capped rows, so it is **not citable as it stands** (see
[Instrument defects](#instrument-defects-open)). Readiness:
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
  it, and do not report it as an agent 0.0. `n_trials: 0` is not the only infrastructure class — see
  [Trial validity](#trial-validity) for `TRANSPORT` failures and artifact-path caps.
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
   run. A `0.0` with `n_trials >= 1` is valid only when the trial also passes the agent-terminal and
   artifact-writable checks in [Trial validity](#trial-validity); otherwise it is infrastructure,
   not a near-miss. A fully valid `0.0` does not block. This diagnostic is a readiness gate, not a
   new score.

   **Result of the 2026-11-09 attempt: the first run FAILED, then PASSED after fixes.** The first
   run is at [`2026-11-09-prediag-0122`](../bench/official/results/2026-11-09-prediag-0122/README.md):
   `intrastat-meldung` (graph 0/47, stock 42/47) and `heat-pump-warranty` (graph 1/21, stock 16/21)
   were Harbor-valid (intrastat's counts are nevertheless capped by the file policy — see below);
   `vpp-loss-divergence` had `n_trials: 0` (legacy-builder heredoc drop) and
   `medical-claims-processing` had `n_trials: 0` (amd64 sidecar never healthy). Both were repaired
   and rerun; the final table is
   [`2026-11-09-prediag-fixes`](../bench/official/results/2026-11-09-prediag-fixes/README.md):
   vpp graph/stock 4/5, medical graph 2/27 / stock 22/27, plus the two earlier valid tasks. All
   eight rows have `n_trials: 1`, `n_errors: 0`; the gate passes. The direct `formal-crypto` verifier
   check passed (Python 3.12.14, SageMath 10.7). The full product20 has since been started
   (2026-11-09 04:18:32 +08, PID `38616`, OUT_DIR `bench/official/results/2026-11-09-product20/`) and
   is live. If that final table exists, do not repeat the diagnostic; if a benchmark is live, report
   "benchmark in progress" instead of starting another run.

   **Caveat on those eight rows (added 2026-11-09T13:35Z):** `intrastat-meldung` and
   `vpp-loss-divergence` fail the artifact-writable clause — both arms are denied
   `/workspace/out/reconciliation.json` and the installed-`site-packages` edit respectively — so
   intrastat's 0/47 / 42/47 and vpp's 4/5 are **ceilings, not capability near-misses**
   ([Instrument defects](#instrument-defects-open)). `heat-pump-warranty` and
   `medical-claims-processing` write inside `/app` and are valid; medical 2/27 / 22/27 is genuine
   diagnostic evidence, while the live run's graph medical 2/27 is a different, `TRANSPORT`-crashed
   row — do not conflate them.
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

## Trial validity

A row's `n_trials >= 1` is **necessary, not sufficient**. A trial is valid only when all three hold:

1. **Harbor trial.** `n_trials >= 1` and `n_errors: 0` for the row. A Harbor trial exception is
   infrastructure, not a score.
2. **Healthy agent terminal.** The DSH process exited 0, or exited 1 with `GRAPH_FAILED` — the
   loop's designed terminal when recovery/replan is exhausted (`packages/loop/src/loop/agent.ts`).
   `GRAPH_FAILED` is valid even when it co-occurs with a scored 1.0, so it must never be filtered.
   Any other agent exit 1 is infrastructure: in practice a
   `dsh: TRANSPORT: DeepSeek Messages transport failed` tail, or a few hundred bytes of stdout where
   the agent never started. **The row's `exit` field is Harbor's run status, not the agent's**, so
   `exit: 0` does not mean the trial was healthy.
3. **Writable declared artifacts.** The agent could write every artifact path its `task.toml`
   declares. A trial that cannot write outside `/app` is **capped** by the `workspace-write` file
   policy ([Instrument defects](#instrument-defects-open)), not a capability result.

`n_trials`/`n_errors`/`exit` are blind to (2) and (3). On 2026-11-09 the live product20 had 6 of 29
trials failing (2) as ordinary `0.0` rows and 6 of 29 capped by (3), with `n_errors: 0` and
`exit: 0` throughout. Read the trial's `jobs/<job>/<trial>/agent/dsh-stdout.log` tail for (2); for
(3), grep the trial output for the sandbox-denial quote and check the task's declared `artifacts`
against the paths the agent reports as writable.

**Citable-run gate.** A completed product20 is citable only when all 20 tasks have both arms,
every trial is valid under (1)–(3), and the marker ends `_EXIT`. A run that fails (2) or (3) is
**incomplete for citation**, not a completed reference: re-running the affected trials/tasks into a
**new `OUT_DIR`** is an infrastructure re-run (authorized without an instrument change, and not a
second product20). The live 2026-11-09 run is **not citable** while its transport-failed and
write-capped rows exist.

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

**Planned fields (deferred until `_EXIT`, not in the live runner):** `agent_exit` (the DSH process
code from the adapter's `result.return_code`), `transport_failed` (bool, or a `valid: false`
reason), and `write_capped`/`artifact_writable` (from the readiness check). Until they exist, keep
recording `n_trials`/`n_errors`/`exit` as they are — `exit` is Harbor's status — and use
[Trial validity](#trial-validity) to interpret the rows.

## Instrument defects (open)

These are harness defects, not agent results. They are documented now and **fixed only after the
live runner exits and its marker has `_EXIT`**, because the runner re-reads `run-subset.sh`
incrementally and re-imports `criteria.py` per row. Do not implement them while the benchmark is
live.

### 1. `workspace-write` caps artifacts outside `/app`

The Harbor adapter runs DSH with the default headless file policy, `workspace-write` rooted at the
session workspace `/app` (`bench/official/terminal-bench/dsh_agent.py` does `cd /app … dsh --profile
tb`; no config entry sets a file policy). Escalation needs an approval answerer and fails closed, so
bash writes are landlocked to `/app` as well.

| task | declared artifact | state |
|---|---|---|
| `intrastat-meldung` | `/workspace/out/reconciliation.json` | **capped, both arms** |
| `roy-polymorph-cn` | `/results/TB3_Conf_Answers.csv` | **capped, both arms** |
| `vpp-loss-divergence` | installed `/usr/local/lib/python3.11/site-packages/...` | **capped, both arms** (4/5 ceiling) |
| `freight-dispatch-shift` (not run yet) | `/workspace/dispatch` | **will be capped** |
| `shadow-relay` (not run yet) | `/tmp/agent.patch` | probably writable in `/tmp`; verify, do not assume |

The cap is symmetric (both arms), so it does not bias the arm comparison directly — but it makes the
absolute rate meaningless, burns 8–20 min of each capped trial on sandbox probing, and invalidates
step/time comparisons on exactly the tasks whose short graph runs otherwise look "efficient"
(`cargo` 2.5 vs 11.7 min, `interleaved` 16 vs 73.6 min are transport/crash effects, not speed).

**Fix (post-`_EXIT`, do not implement now).** In the adapter or the bench profile, grant the trial
write access to the task's declared artifact paths: either a container-scoped `danger-full-access`
file policy (the trial already runs inside a disposable Docker container) or an explicit allow-list
of the task's `task.toml` artifact paths — applied to **both** arms. Then re-verify one intrastat,
one roy and one vpp trial before the next full run. Add a **readiness check that every declared
artifact path is writable**; `n_trials`/`n_errors` cannot detect this defect.

### 2. The row has no agent-exit / transport / writability field

`bench/official/terminal-bench/run-subset.sh` writes `exit`, which is Harbor's process status;
`dsh_agent.py` logs `DSH exited {code}; verifier will score the workspace as-is` and returns
normally, so a transport crash becomes an ordinary `0.0` row with `n_errors: 0` and `exit: 0`. Fix
after `_EXIT`: add `agent_exit`, `transport_failed` and a `write_capped`/`artifact_writable` flag to
the row; treat a transport-failed trial as an **infrastructure retry** into a new `OUT_DIR` rather
than a score; keep `n_errors` for Harbor exceptions only and stop using it as a validity signal.

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
  runner exits. The **separate** `workspace-write` defect still caps `intrastat` and `vpp`; their
  counts here are ceilings ([Instrument defects](#instrument-defects-open)).
- Full product20 (live, 2026-11-09): started 04:18:32 +08, PID `38616`, OUT_DIR
  `bench/official/results/2026-11-09-product20/`, log `/tmp/product20-2026-11-09.log`, marker
  `/tmp/product20-shard-full.log` without `_EXIT`. `rows.jsonl` grows per trial; each row carries
  `commit 11fe18f…`, model, image tags, timeout, criteria and a durable `raw/` result. **No aggregate
  yet**; partial rows are not citable. A watcher appends `_EXIT` to the marker when the PID exits; if
  it is absent, append `_EXIT` by hand after confirming the PID is dead (see the run README).
  **Not citable:** at the 05:28Z audit (29/40 rows) 6 rows were `TRANSPORT` crashes and 6
  (`intrastat` ×2, `roy` ×2, `vpp` ×2) were capped by the file policy, so even a completed run
  cannot become the reference without an infrastructure re-run of those trials into a new
  `OUT_DIR` ([Trial validity](#trial-validity)).
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
