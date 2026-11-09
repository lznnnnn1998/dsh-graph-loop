# Evaluation — product20

Status: **instrument fixed and smoke-verified, the pre-run diagnostic gate passed, and the corrected
full product20 is running; no stock-vs-graph aggregate exists yet.** The first 2026-11-09 diagnostic
failed on two infrastructure faults; both were fixed and the four tasks were rerun
([final table](../bench/official/results/2026-11-09-prediag-fixes/README.md)): all eight rows have
`n_trials: 1` and `n_errors: 0`, including `vpp-loss-divergence` (4/5 both arms) and
`medical-claims-processing` (2/27 graph, 22/27 stock) on an arm64 sidecar. The corrected run started
2026-11-09 17:19 +08 as PID `61129` with OUT_DIR
`bench/official/results/2026-11-09-product20b/`; its `rows.jsonl` grows per trial and is the canonical
partial record. Executed run commit `da3d598` (every row carries it); wrapper `b3e9af7` is
README-only and landed after the runner started; tarball sha256
`f7a961a797ca5e17fdd68d52c0bd6dfeec50ec4151f42d84bbd7405069b12064` (223,458 B). Do not start a second
run or run the smoke gate while it is live. The earlier 04:18:32 run (PID `38616`, OUT_DIR
`…/2026-11-09-product20/`) was **stopped at 31/40 and is NOT CITABLE**
([`INVALID.md`](../bench/official/results/2026-11-09-product20/INVALID.md)). No product claim until all
20 tasks have valid stock and graph trials, and an oracle control shows the harness can score a pass
on the task. **"Valid" is the three-part test in [Trial validity](#trial-validity)**: a Harbor trial,
a healthy agent terminal, and writable declared artifact paths. `n_trials >= 1` alone is not enough.
The `workspace-write` cap behind the third clause is **fixed at `da3d598`** (both arms run under
`sandbox-policy: danger-full-access`, verified by smoke); the per-trial `write_capped` field is still
deferred ([Instrument defects](#instrument-defects-open)). Readiness:
[`2026-11-09-product20-prep`](../bench/official/results/2026-11-09-product20-prep/README.md)
(historical snapshot from before the first run).

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
   were Harbor-valid (intrastat's counts were nevertheless capped by the file policy at the time —
   that defect is fixed at `da3d598`; see below);
   `vpp-loss-divergence` had `n_trials: 0` (legacy-builder heredoc drop) and
   `medical-claims-processing` had `n_trials: 0` (amd64 sidecar never healthy). Both were repaired
   and rerun; the final table is
   [`2026-11-09-prediag-fixes`](../bench/official/results/2026-11-09-prediag-fixes/README.md):
   vpp graph/stock 4/5, medical graph 2/27 / stock 22/27, plus the two earlier valid tasks. All
   eight rows have `n_trials: 1`, `n_errors: 0`; the gate passes. The direct `formal-crypto` verifier
   check passed (Python 3.12.14, SageMath 10.7). The first full product20 ran from 04:18:32 +08 (PID
   `38616`, OUT_DIR `bench/official/results/2026-11-09-product20/`) but was **stopped at 31/40 and is
   NOT CITABLE** ([`INVALID.md`](../bench/official/results/2026-11-09-product20/INVALID.md)); the
   corrected run is live (PID `61129`, OUT_DIR `bench/official/results/2026-11-09-product20b/`). If
   that final table exists, do not repeat the diagnostic; if a benchmark is live, report "benchmark in
   progress" instead of starting another run.

   **Caveat on those eight rows (added 2026-11-09T13:35Z, reworded after the fix):**
   `intrastat-meldung` and `vpp-loss-divergence` failed the artifact-writable clause **when measured**
   — both arms were then denied `/workspace/out/reconciliation.json` and the installed-`site-packages`
   edit respectively — so intrastat's 0/47 / 42/47 and vpp's 4/5 are **pre-fix ceilings, not
   capability near-misses**. That cap is fixed at `da3d598`; re-measure those tasks from the corrected
   run ([Instrument defects](#instrument-defects-open)). `heat-pump-warranty` and
   `medical-claims-processing` write inside `/app` and were unaffected; medical 2/27 / 22/27 is
   genuine diagnostic evidence, while the stopped run's graph medical 2/27 was a different,
   `TRANSPORT`-crashed row — do not conflate them.
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
   policy — **fixed at `da3d598`**; if it recurs, treat it as infrastructure, not a capability result
   ([Instrument defects](#instrument-defects-open)).

`n_trials`/`n_errors`/`exit` are blind to (2) and (3). The row now carries `agent_exit` and
`transport_failed` (`da3d598`), but read the trial's `jobs/<job>/<trial>/agent/dsh-stdout.log` tail to
confirm (2): the stopped 2026-11-09 run had 6 of 29 trials failing it as ordinary `0.0` rows and 6 of
29 capped by (3), with `n_errors: 0` and `exit: 0` throughout. For (3), grep the trial session for
`Current DSH file policy` and the sandbox-denial quote, and check the task's declared `artifacts`
against the paths the agent reports as writable — the per-trial `write_capped` field is still deferred.

**Citable-run gate.** A completed product20 is citable only when all 20 tasks have both arms,
every trial is valid under (1)–(3), and the marker ends `_EXIT`. A run that fails (2) or (3) is
**incomplete for citation**, not a completed reference: re-running the affected trials/tasks into a
**new `OUT_DIR`** is an infrastructure re-run (authorized without an instrument change, and not a
second product20). The stopped 2026-11-09 run is **not citable**
([`INVALID.md`](../bench/official/results/2026-11-09-product20/INVALID.md)); the corrected run
(`…/2026-11-09-product20b/`) becomes citable only when its own 40 rows pass (1)–(3) and its marker
closes. `GRAPH_FAILED` exit 1 is valid even alongside a scored 1.0 — `run-subset.sh`'s
`agent_invalid_rows` currently miscounts it (deferred code fix).

## Row schema

Every row written by `run-subset.sh` must carry:

| Field | Meaning |
|---|---|
| `task`, `arm`, `score`, `n_trials`, `n_errors`, `exit` | trial outcome |
| `agent_exit`, `transport_failed` | DSH's own process exit and transport flag from the adapter metadata (since `da3d598`); `null` means the adapter never returned, **not** "valid" |
| `commit` | `git rev-parse HEAD` at run start |
| `model` | model id used by both arms |
| `image_env`, `image_verifier` | task image tags actually used |
| `agent_timeout_sec` | task `[agent].timeout_sec` (or `DSH_AGENT_TIMEOUT_CAP`) |
| `agent_setup_timeout_multiplier` | Harbor setup multiplier |
| `result` | durable copy under `<OUT_DIR>/raw/`, not a `/tmp` job path |

A row missing any of these is not reportable. The 2026-11-08 partial rows predate the schema and
cannot be re-derived from their `/tmp` job trees (see the partial README); do not backfill invented
values.

**Fields added at `da3d598`:** `agent_exit` (the DSH process code from the adapter's
`result.return_code`) and `transport_failed` are written by **both** arms into
`agent_result.metadata`, and `run-subset.sh` copies them onto the row (the post-fix smoke shows
`{"agent_exit":0,"transport_failed":false}` on both arms). **Still deferred:** `write_capped` /
`artifact_writable` (from a readiness probe) is not in the row — grep each trial session for
`Current DSH file policy` and the sandbox-denial quote instead. The residual interpretation fixes
(`GRAPH_FAILED` exemption, `TRANSPORT` signature narrowing, fail-closed `null` metadata,
`write_capped`/`tarball_sha256` fields) are listed under
[Instrument defects](#instrument-defects-open).

<a id="instrument-defects-open"></a>
## Instrument defects (status)

These are harness defects, not agent results. **Defects 1 and 2 below were fixed at `da3d598` and
verified by the post-fix smoke**
([`2026-11-09-smoke-sandbox`](../bench/official/results/2026-11-09-smoke-sandbox/README.md): oracle /
graph / stock 1.0; both agent sessions print `Current DSH file policy: danger-full-access`; trial
metadata carries `agent_exit`/`transport_failed`). The policy fix lives in
`bench/official/terminal-bench/dsh_agent.py` and did not require a plugin repack. What remains
deferred is the code work listed under defect 2 — **do not edit the live runner while PID `61129`
runs**, because it re-reads `run-subset.sh` incrementally and re-imports `criteria.py` per row.

### 1. `workspace-write` capped artifacts outside `/app` — FIXED at `da3d598`

Before the fix the Harbor adapter ran DSH with the default headless file policy, `workspace-write`
rooted at the session workspace `/app` (`bench/official/terminal-bench/dsh_agent.py` did `cd /app …
dsh --profile tb`; no config entry set a file policy). Escalation needed an approval answerer and
failed closed, so bash writes were landlocked to `/app` as well.

| task | declared artifact | state before the fix |
|---|---|---|
| `intrastat-meldung` | `/workspace/out/reconciliation.json` | capped, both arms |
| `roy-polymorph-cn` | `/results/TB3_Conf_Answers.csv` | capped, both arms |
| `vpp-loss-divergence` | installed `/usr/local/lib/python3.11/site-packages/...` | capped, both arms (4/5 ceiling) |
| `freight-dispatch-shift` (not run in the stopped run) | `/workspace/dispatch` | would have been capped |
| `shadow-relay` | `/tmp/agent.patch` | probably writable in `/tmp`; unexercised |

The cap was symmetric (both arms), so it did not bias the arm comparison directly — but it made the
absolute rate meaningless, burned 8–20 min of each capped trial on sandbox probing, and invalidated
step/time comparisons on exactly the tasks whose short graph runs otherwise look "efficient"
(`cargo` 2.5 vs 11.7 min, `interleaved` 16 vs 73.6 min are transport/crash effects, not speed).

**Fix (applied at `da3d598`).** The adapter writes and applies a shared profile patch to **both** arms:
`sandbox-policy` → `mode: danger-full-access` (the trial already runs inside a disposable Docker
container) and `llm-deepseek` → `maxRetries: 3`; `--dump-config` plus fail-closed greps verify the
patch in-container. Both post-fix smoke sessions carry the policy in their runtime context. The
readiness numbers in `2026-11-09-prediag-fixes` were measured **before** this fix, so their
intrastat/vpp counts are pre-fix ceilings; re-verify one intrastat, one roy and one vpp trial from the
corrected run. A per-trial **`write_capped` / writable-artifact probe is still deferred** —
`n_trials`/`n_errors` cannot detect a regression, so grep each trial session for
`Current DSH file policy`.

### 2. The row had no agent-exit / transport field — FIXED at `da3d598`; probes deferred

Before the fix `run-subset.sh` wrote only `exit`, which is Harbor's process status; `dsh_agent.py`
logged `DSH exited {code}; verifier will score the workspace as-is` and returned normally, so a
transport crash became an ordinary `0.0` row with `n_errors: 0` and `exit: 0`. Since `da3d598` the
adapter writes `agent_exit`/`transport_failed` into `agent_result.metadata` for both arms, and
`run-subset.sh` copies them onto the row; smoke trials carry
`{"agent_exit":0,"transport_failed":false}`. **Deferred interpretation fixes (documented, do not
implement while live):**

- `run-subset.sh`'s `agent_invalid_rows` counts agent exit 1 + `GRAPH_FAILED` as invalid, although
  `GRAPH_FAILED` is the loop's designed terminal and valid — exempt it.
- `transport_failed` is still a whole-transcript `TRANSPORT` substring; narrow it to the
  `dsh: TRANSPORT: DeepSeek Messages transport failed` signature so a valid logistics transcript is
  not flagged.
- `agent_exit: null` means "no metadata was written" (a Harbor exception before the adapter
  returned), **not** "valid" — make the extraction fail-closed and stop taking the first job only.
- Add `write_capped`/`artifact_writable` and `tarball_sha256` to rows; treat a transport-failed or
  capped trial as an **infrastructure retry** into a new `OUT_DIR` rather than a score; keep
  `n_errors` for Harbor exceptions only and stop using it as a validity signal.

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
  runner exits. The **separate** `workspace-write` defect capped `intrastat` and `vpp` **before**
  `da3d598`; their counts here are pre-fix ceilings, and the defect itself is fixed
  ([Instrument defects](#instrument-defects-open)).
- Corrected full product20 (**live**, 2026-11-09): started 17:19 +08, PID `61129`, OUT_DIR
  `bench/official/results/2026-11-09-product20b/`, log `/tmp/product20b-2026-11-09.log`, marker
  `/tmp/product20-shard-full.log` without `_EXIT`. `rows.jsonl` grows per trial; rows carry
  `commit da3d598…`, `agent_exit`/`transport_failed`, model, image tags, timeout, criteria and a
  durable `raw/` result. Executed run commit `da3d598`; wrapper `b3e9af7` (README-only, after start);
  tarball
  `f7a961a797ca5e17…b12064`. **No aggregate yet**; partial rows are not citable. The marker's watcher
  closes it when PID `61129` exits — never append `_EXIT` because the **stopped** run's PID (`38616`)
  is dead; see the marker-close rule in
  [`automation/evaluator.md`](../automation/evaluator.md#product20).
- First full product20 (**stopped, not citable**): started 04:18:32 +08, PID `38616`, OUT_DIR
  `bench/official/results/2026-11-09-product20/`, 31/40 rows. It is invalid
  ([`INVALID.md`](../bench/official/results/2026-11-09-product20/INVALID.md)): at the 05:28Z audit
  6 rows were `TRANSPORT` crashes and 6 (`intrastat` ×2, `roy` ×2, `vpp` ×2) were capped by the file
  policy. Do not merge its rows into the corrected run; the instrument was fixed afterwards.
- Sandbox instrument fix (2026-11-09, `da3d598`): both arms receive a shared profile patch with
  `sandbox-policy: danger-full-access` (the container is the sandbox) and `llm-deepseek` retries 3;
  the adapter also records `agent_exit`/`transport_failed` in the trial metadata. Verified by the
  post-fix smoke ([record](../bench/official/results/2026-11-09-smoke-sandbox/README.md): oracle /
  graph / stock 1.0; both agent sessions print `Current DSH file policy: danger-full-access`). The
  plugin tarball is unchanged (the fix lives in `bench/`).
- Smoke (2026-11-09, this tree): **1.0** oracle / **1.0** graph / **1.0** stock on the synthetic
  `smoke/answer-42` task ([record](../bench/official/results/2026-11-09-smoke-prep/README.md));
  harness plumbing only, not product evidence. The raw `result.json` files live in that run's
  git-ignored `jobs/` dir. The 2026-11-08 smoke records are historical.
- Benchmark tarball: `dist/dsh-graph-loop-bench.tgz` is 223,458 B, sha256
  `f7a961a797ca5e17fdd68d52c0bd6dfeec50ec4151f42d84bbd7405069b12064`, and
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
