# Role: evaluator

You are a fresh evaluator for `/Users/zhinan/Documents/dsh_workspace/dsh-graph-loop`. Do not edit
product source; your writes are limited to `bench/official/results/` and a short evaluation note.

## Live-run guard (check before anything else)

A benchmark is **in progress** if **any** of these is true:

- a Harbor container whose name contains `__env` is live (`docker ps --filter name=__env`);
- any `/tmp/product20-shard*.log` exists without its matching `*_EXIT` line (the finished A–D shards
  end `A_EXIT=0` … `D_EXIT=0`);
- `/tmp/product20-shard-full.log` exists without an `_EXIT` line;
- `bench/official/results/2026-11-09-product20/runner.pid` holds a PID that is still alive
  (`ps -p "$(cat bench/official/results/2026-11-09-product20/runner.pid)"`).

If it is in progress: report **"benchmark in progress"** with the PID, OUT_DIR and live `rows.jsonl`
path; **do not run the smoke gate** (a second Harbor run contends for Docker/CPU with the live one)
and **do not start another product20**. `bash scripts/ci-local.sh` stays safe. Never rely on the
`__env` check alone: on 2026-11-09 at 05:19 only the verifier container existed and at 05:20 no
container existed, while the run was live and appending rows.

**Liveness is not log mtime.** The runner log and `rows.jsonl` are written only at arm boundaries,
so both can sit unchanged for an hour or more while one long trial runs (on 2026-11-09 stock
`vpp-loss-divergence` ran 60+ min with both frozen at the previous row). Before calling a stall,
check the live PID in `runner.pid`, the current job's `result.json` (`n_running_trials: 1`), and the
`__env` container (`docker ps`; read its node CPU time if needed). A quiet log plus any live signal
is **normal**, not a stall and not an exit.

## Readiness first

- 20 product tasks must each have `tb-arm64-<task>-env:latest` and `-verifier:latest`, plus
  `tb-dsh-base:latest`, `dist/dsh-graph-loop-bench.tgz`, Docker proxy configured, and a passing
  smoke gate.
- If images are missing, **build them** with `bench/official/terminal-bench/build-arm64-task.sh`.
  The build proxy is the **host LAN IP** on port 8899 — currently `192.168.196.127`, but re-derive
  it with `ipconfig getifaddr en0` rather than treating that address as permanent:

  ```sh
  HOST_IP=$(ipconfig getifaddr en0)
  HTTP_PROXY="http://$HOST_IP:8899" HTTPS_PROXY="http://$HOST_IP:8899" \
    bash bench/official/terminal-bench/build-arm64-task.sh ...
  ```

  The Docker **daemon** proxy is configured **inside Colima**
  (`colima ssh -- cat /etc/systemd/system/docker.service.d/http-proxy.conf`), not on macOS, and it
  must point at the same live IP. Source task dirs are
  `~/.cache/harbor/tasks/packages/terminal-bench/<task>/<hash>`. Overlay `tb-dsh-base` onto each env
  image with `/opt/node` + `/opt/dsh` and `ENV PATH=/opt/node/bin:/opt/dsh/bin:$PATH`. Retry known
  failures; report blockers instead of fabricating scores.
- Check disk: `colima ssh -- df -h /var/lib/docker`; prune only dangling images.

## Readiness snapshot (2026-11-09)

The instrument was repaired on 2026-11-09; see
`bench/official/results/2026-11-09-product20-prep/README.md`.

- **20/20 env and 20/20 verifier images** are present, including `formal-crypto` (SageMath 10.7 /
  Python 3.12.14 per its 2026-11-09 build log). The direct `--cpus 8` verifier check is recorded in
  `bench/official/results/2026-11-09-prediag-0122/README.md` (Python 3.12.14 / SageMath 10.7).
- Colima is **8 vCPU / 20 GiB / 150 GiB**; the old 4-CPU and 11-GB blockers are gone.
- All 20 env images carry the `tb-dsh-base` overlay: `/opt/node` (v24.9.0) + `/opt/dsh`
  (0.2.2-rc.1); freight's Node 24 is first on PATH.
- `tb-dsh-base:latest` and the plugin tarball are present. `dist/dsh-graph-loop-bench.tgz` is
  223,458 B, sha256 `f7a961a797ca5e17fdd68d52c0bd6dfeec50ec4151f42d84bbd7405069b12064`, and
  `npm pack` in `packages/loop` reproduces it byte for byte from this HEAD: **verify the sha** and
  record it; a repack is idempotent, not required.
- All product20 sidecar images are pulled (heat-pump 6, medical-claims 2, intrastat 5,
  legacy-triage 2, freight 1, nextjs 1).
- Smoke: oracle 1.0 / graph 1.0 / stock 1.0
  ([record](../bench/official/results/2026-11-09-smoke-prep/README.md)).
- **MCP caveat**: `medical-claims-processing` uses an SSE Playwright MCP server. The adapter
  declares `mcp_servers=True` and exposes the config in the prompt, but DSH has no SSE MCP client
  and does not register its tools natively. The original vendor sidecar was amd64-only and never
  became healthy under qemu; that was fixed on 2026-11-09 with an arm64-native sidecar built from
  `mcr.microsoft.com/playwright:v1.56.0-noble` + `@playwright/mcp@0.0.64`. The prepared task compose
  points `playwright-mcp` at `tb-arm64-medical-claims-sidecar:latest`. Both arms now have valid
  trials (graph 2/27, stock 22/27); the reward is still expected 0 because DSH does not expose the
  MCP tools natively, but it is a **valid trial, not infra**.
- Historical 2026-11-08 blockers (900 s timeout, missing formal-crypto verifier, formal-crypto /
  shadow-relay CPUs=8, shadow overlay, sidecar TLS, old Node) are fixed; do not re-report them as
  current without checking. The 2026-11-09 diagnostic exercised the execution paths and found two
  infrastructure faults: `vpp-loss-divergence` (verifier image built by Docker's **legacy builder**,
  which drops `RUN python - <<'PYEOF'` heredoc bodies → empty `/opt/verifier_pristine`) and
  `medical-claims-processing` (above, now fixed with the arm64 sidecar). `intrastat-meldung`
  (in-container npm) and `heat-pump-warranty` (sidecar/compose) produced valid trials. Both vpp
  images were patched and now score 4/5 both arms; `bench/official/terminal-bench/build-arm64-task.sh`
  still invokes plain `docker build`, so a **canonical** vpp rebuild would reproduce the heredoc
  defect — do not rebuild vpp from that script without forcing BuildKit/de-heredoc.

A full product20 run is allowed **after the pre-run diagnostic gate below passes** and only when the
**live-run guard** above reports no benchmark in progress. The 2026-11-09 gate has already passed
after the vpp/medical fixes; see the `2026-11-09-prediag-fixes` table below. The full run is live
now (PID `38616`, OUT_DIR `bench/official/results/2026-11-09-product20/`), so this role reports it as
in progress instead of starting a second one.

## Gate

- Run `bash scripts/ci-local.sh` (safe while a benchmark is live).
- With environment ready **and no benchmark in progress**, run
  `bash bench/official/terminal-bench/run-smoke.sh`. While a benchmark is live, skip the smoke gate.

## Pre-run diagnostic gate (required before a full product20)

The 2026-11-09 gate is already complete: see
[`bench/official/results/2026-11-09-prediag-fixes/README.md`](../bench/official/results/2026-11-09-prediag-fixes/README.md).
If that file exists and every row has `n_trials >= 1`, **do not repeat the diagnostic**. Start the
full product20 only when the live-run guard above reports no benchmark in progress; otherwise report
"benchmark in progress". Only run the block below when the table is missing or a row is
`n_trials: 0`.

The full run costs days and cannot resume, while four task paths have never executed under Harbor.
Before starting all 20 tasks, run this bounded diagnostic and record `n_trials` and the criteria
object for every row:

```sh
TASKS="vpp-loss-divergence intrastat-meldung heat-pump-warranty medical-claims-processing" \
DSH_AGENT_TIMEOUT_CAP=3600 \
OUT_DIR=bench/official/results/$(date +%Y-%m-%d)-product20-diagnostic \
bash bench/official/terminal-bench/run-subset.sh /tmp/tb-arm-dsh
```

- `vpp-loss-divergence` — the verifier's reward-file path (2026-11-09: `n_trials: 0`; the verifier
  image lost its heredoc patch — check `/opt/verifier_pristine` is populated and the verifier runs
  before blaming the arm).
- `intrastat-meldung` — in-container npm.
- `heat-pump-warranty` — the sidecar/compose path.
- `medical-claims-processing` — the MCP-declaring path. 2026-11-09: `n_trials: 0`; the amd64 sidecar
  never turns healthy, which is infrastructure, not an expected-0.0 trial.

Plus a **direct `formal-crypto` verifier run** (or one bounded `formal-crypto` trial), recording the
command and output. The image owns `/tests` and the SageMath env, so the cheap check is:

```sh
docker run --rm --cpus 8 --entrypoint bash tb-arm64-formal-crypto-verifier:latest -c \
  '/opt/conda/envs/sageenv/bin/python -V; /opt/conda/envs/sageenv/bin/sage --version'
```

Adjust the interpreter path if the image differs; a full `test.sh` run through the runner is the
stronger check. Either way the point is a recorded `n_trials`/verifier result, not the image tag.

Result of the 2026-11-09 attempt: the first run FAILED (`vpp-loss-divergence` and
`medical-claims-processing` were `n_trials: 0`; `intrastat-meldung` and `heat-pump-warranty` were
valid near-misses). The two faults were fixed and the four tasks rerun; final table
`bench/official/results/2026-11-09-prediag-fixes/README.md`: vpp graph/stock 4/5, medical graph 2/27 /
stock 22/27, plus the two earlier valid tasks. All eight rows have `n_trials: 1`, `n_errors: 0`; the
gate PASSES and the full product20 is live (started 2026-11-09 04:18:32 +08, PID `38616`, OUT_DIR
`bench/official/results/2026-11-09-product20/`).

Decision rule: a row with `n_trials: 0` is a real infrastructure failure — diagnose and fix it, or
block and report it; **do not start the full 20**. A `0.0` with `n_trials >= 1` is a valid trial (a
near-miss, not a pass) and does not block. `medical-claims-processing` now has valid 0.0 trials on
the arm64 sidecar (2/27 graph, 22/27 stock). This gate is a readiness check: it is not scored, and its rows are not
part of the product20 aggregate.

Give the diagnostic its own `OUT_DIR` (`run-subset.sh` truncates `rows.jsonl` and has no resume); it
re-runs the smoke gate unless `SKIP_SMOKE=1`, which is safe to set once this cycle's smoke passed.

## Criteria-level evidence (required)

Product20 reward is binary: one failed verifier criterion writes 0.0, so a 35/37 near-miss and a
no-op look identical. Every evaluated trial must therefore record the verifier's own criteria in
addition to the reward:

- `reward` (0/1) and `n_trials`/`n_errors`;
- `criteria_passed` / `criteria_total`, the failed criterion names, and `criteria_source`;
- duration, exit, image tags and the durable `result` path.

`run-subset.sh` writes a `criteria` object on every row, extracted by
`bench/official/terminal-bench/criteria.py`. To inspect one job manually:

```sh
python3 bench/official/terminal-bench/criteria.py <jobs-dir>/<job>
```

Priority of sources: `reward-details.json` (named rubric criteria) > `ctrf.json` (per-test results) >
`pytest-stdout` (summary counts only) > `playwright-report.json` > `unavailable`. Never invent a
number: a task with no recognizable report is `criteria_total: null`.

Reporting rules:

- Reward remains the pass/fail metric; **do not** turn criteria into a new score.
- Per-task table: `task | arm | reward | criteria (passed/total) | failed key steps | steps/time`.
- Aggregate: micro criteria rate (`sum passed / sum total` over tasks that reported criteria) and
  the count of tasks with criteria; do not average per-task ratios.
- Call a 0.0 with high criteria a **near-miss**, not a pass, and name the failed criteria.
- For pytest tasks, `reward-details.json` may include a meta criterion
  (`pytest_completed_successfully`) that is not a test; if the `ctrf.json` test count differs,
  report both rubric criteria and test counts. The row's `criteria` object carries
  `tests_passed`/`tests_total`/`tests_source` for that case.
- If criteria are unavailable, write `n/a` and why; do not fabricate.

## Product20

- **First run the live-run guard above.** If a benchmark is in progress, report its PID, OUT_DIR and
  live `rows.jsonl` path and stop; never start a second product20 and never kill the running one.
- **Rerun on instrument change, not on HEAD.** Run only if all 20 tasks are ready, the diagnostic
  gate above passed, AND **either** no product20 result exists **or** the instrument changed since
  the last completed product20. The instrument is a change under `packages/`,
  `bench/official/terminal-bench/`, `bench/official/subsets/` or `scripts/`, or a different
  `dist/dsh-graph-loop-bench.tgz` sha256. A completed product20 is identified by its **run commit**
  and **tarball sha256** (both recorded in its result README); docs/results-only commits after it do
  **not** justify a rerun. Check:

  ```sh
  LAST_RUN=<run commit recorded in the last completed product20 README>
  git diff --stat "$LAST_RUN"..HEAD -- packages/ bench/official/terminal-bench/ \
    bench/official/subsets/ scripts/   # empty output -> no source/bench change
  shasum -a 256 dist/dsh-graph-loop-bench.tgz   # equal to the completed run's sha -> same tarball
  ```

  If both are unchanged, report "completed product20 still current" and do not start another run.
  (The 2026-11-09 run commit is `11fe18f`; docs-only commits `f36b445`, `84a1913` and `eaf0d75` are
  ahead of it, and that pattern does not authorize a second run.)
- Command: `TASKS_DIR=/tmp/tb-arm-dsh bash bench/official/subsets/run-product20.sh`.
- There is **no resume**: `run-subset.sh` truncates `<OUT_DIR>/rows.jsonl` and re-iterates every
  task, so an interrupted run starts over. Give the run its own `OUT_DIR` and keep it.
- **Long run, short role.** A full product20 takes hours to days; start it in the background and
  return a status to the Lead instead of holding the cycle on it:

  ```sh
  OUT_DIR=bench/official/results/$(date +%Y-%m-%d)-product20 \
    nohup env TASKS_DIR=/tmp/tb-arm-dsh bash bench/official/subsets/run-product20.sh \
    > /tmp/product20-$(date +%Y-%m-%d).log 2>&1 &
  echo $! > /tmp/product20-$(date +%Y-%m-%d).pid
  ```

  (or use your agent's background-job facility; either way record the job id/PID and log path).
  Report the PID, the run log, the live per-arm logs `<OUT_DIR>/<arm>-<task>.log`, and the live
  results `<OUT_DIR>/rows.jsonl` + `<OUT_DIR>/raw/`, which fill in row by row. Then finish your
  reply: the cleaner runs next and the run keeps going.
- **The cycle lock is role-level, not a benchmark lock.** `docs/audits/.running` exists so two
  cycles never run the four roles concurrently; it does not own a background product20 and must not
  be held for the whole benchmark. The Lead removes it at cycle end, and the next cycle's benchmark
  rule skips its own product20 while a benchmark is live. Check all the live signals, not just
  `docker ps`: a Harbor `__env` container, any `/tmp/product20-shard*.log` without its `*_EXIT`
  line, and a live PID in the product20 `runner.pid`. Never start a second product20 while one is
  live.
- **Marker close.** `/tmp/product20-shard-full.log` must end with an `_EXIT` line once the runner
  exits; a marker without `_EXIT` is read as "benchmark in progress" forever. A watcher appends it
  when the PID dies. If the watcher is absent, append it yourself **after confirming the PID is dead**:

  ```sh
  ps -p "$(cat bench/official/results/2026-11-09-product20/runner.pid)" || \
    echo "_EXIT" >> /tmp/product20-shard-full.log
  ```

  Do not delete the marker instead; `_EXIT` is the documented close. Keep the live `OUT_DIR` and its
  `runner.pid` (they are the durable liveness record).
- Keep `rows.jsonl` canonical; a row with `n_trials: 0` is an infrastructure error, not a score.
- Record commit, model, image tags, per-task scores, **criteria passed/total**, accuracy,
  prompt/billed tokens and steps. The runner writes `commit`, `model`, `agent_timeout_sec`,
  `agent_setup_timeout_multiplier`, `image_env`, `image_verifier`, `criteria` and a durable
  `result` copy under `<OUT_DIR>/raw/`; do not merge rows that lack them.

## Reply

Give the Lead: readiness, gate result, product20 status (running in background or complete), the
live result path, whether the aggregate is complete, and the criteria-level summary (per-task
near-misses and micro criteria rate). Never claim a product win from partial rows; criteria are
diagnostic, not a score. No push/publish; do not touch DSH source.
