# product20 — full run (2026-11-09)

**In progress.** Started **2026-11-09 04:18:32 +08** (`ps -p 38616 -o lstart`; first job name
`…-041832`; raw `started_at` 04:18:36), PID `38616` (see `runner.pid`), runner log
`/tmp/product20-2026-11-09.log`. Do not start a second run while this is live.

- Runner: `bash bench/official/subsets/run-product20.sh` with `TASKS_DIR=/tmp/tb-arm-dsh`,
  `OUT_DIR=bench/official/results/2026-11-09-product20`, `SKIP_SMOKE=1`.
- Run commit: `11fe18f84eb4ef903f947eac05b58038442461f5` (HEAD at start; later commits are
  docs-only). Every row carries this commit.
- Tarball: `dist/dsh-graph-loop-bench.tgz`, 223,458 B,
  sha256 `f7a961a797ca5e17fdd68d52c0bd6dfeec50ec4151f42d84bbd7405069b12064`, packed from the plugin
  source. Do not repack or replace it while this run is live.
- Smoke was already 1.0/1.0/1.0 in `../2026-11-09-smoke-prep/`; it was skipped because this benchmark
  is live and a second Harbor run would contend with it (the default smoke `OUT` is
  `results/smoke-answer-42`, so overwriting the tracked record was not the reason).
- Timeout: per-task `[agent].timeout_sec` (28800 s) — no artificial cap.
- `rows.jsonl` is truncated at start and grows per trial (3 rows at the 05:24 audit; read the file for
  the current count); each row carries `criteria` from
  `bench/official/terminal-bench/criteria.py` and a durable copy of the Harbor result under `raw/`.
  `rows.jsonl` is the canonical live record.
- `jobs/`, `raw/`, `rows.jsonl` and `runner.pid` are this run's only durable progress record; never
  delete or rewrite them while it is live.
- The pre-run diagnostic passed: vpp both arms 4/5, medical 2/27 / 22/27, intrastat and heat-pump
  valid. See `../2026-11-09-prediag-fixes/README.md`. The vpp/medical repairs are local-only; do not
  rebuild either image or reset the task dirs while this run is live.

## Liveness and close protocol

- Live check:
  `ps -p "$(cat bench/official/results/2026-11-09-product20/runner.pid)"` and
  `grep -q '^_EXIT$' /tmp/product20-shard-full.log && echo finished || echo live`.
- A watcher is running (`bash -c 'while kill -0 38616 2>/dev/null; do sleep 60; done;
  echo "_EXIT" >> /tmp/product20-shard-full.log'`, PID `38728` at update time). When PID `38616`
  exits it appends `_EXIT` to `/tmp/product20-shard-full.log`; that `_EXIT` line is what tells the
  next cycle's evaluator the benchmark is no longer live.
- If the runner has exited and the marker still lacks `_EXIT` (watcher absent or killed), append it
  by hand **after confirming the PID is dead**:

  ```sh
  ps -p "$(cat bench/official/results/2026-11-09-product20/runner.pid)" || \
    echo "_EXIT" >> /tmp/product20-shard-full.log
  ```

- Do not delete the marker: a marker without `_EXIT` is read as "benchmark in progress" by every
  later cycle. Also do not delete this OUT_DIR, `raw/`, `jobs/`, `rows.jsonl`, the tarball, or the
  task images until the runner exits and the marker has `_EXIT`.

**No aggregate is citable until all 20 tasks have both arms, every trial is valid, and the runner
exits.** `n_trials: 0` is an infrastructure error, and so are two classes the row schema does not
show ([trial validity](../../../../docs/EVALUATION.md#trial-validity)):

- **Transport crashes.** At the 29-row point (05:28Z audit) 6 trials were
  `dsh: TRANSPORT: DeepSeek Messages transport failed` crashes recorded as ordinary `0.0` rows with
  `n_errors: 0` and `exit: 0` — graph `cargo`, graph `medical`, stock `foodstuff`, stock
  `interleaved`, stock `pretrain`, stock `vpp`. They are **not trials**; do not score them 0.0 or
  read them as capability gaps. (`exit` is Harbor's run status, not the agent's.)
- **File-policy caps.** 6 rows (intrastat ×2, roy ×2, vpp ×2) cannot write their declared
  `task.toml` artifacts because DSH runs under the default `workspace-write` policy rooted at `/app`
  (`/workspace/out`, `/results`, installed `site-packages`); `freight-dispatch-shift`
  (`/workspace/dispatch`) will be capped the same way. Those criteria counts are **ceilings for both
  arms**, not capability results.

A completed run that contains such rows is **incomplete for citation**, even at 40/40 rows. An
**infrastructure re-run** of the affected trials/tasks into a **new `OUT_DIR`** is authorized without
an instrument change and does not count as a second product20
([completed-run gate](../../../../docs/EVALUATION.md#trial-validity)). The fixes — adapter write
access for both arms, a row `agent_exit`/`transport_failed` field, and a readiness check that every
declared artifact path is writable — are deferred until `_EXIT`
([instrument defects](../../../../docs/EVALUATION.md#instrument-defects-open)); do not edit the live
runner. Do not merge the ad-hoc vpp retests into this run.
