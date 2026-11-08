# product20 — full run (2026-11-09)

**In progress.** Started 2026-11-09 04:24 +08, PID `38616` (see `runner.pid`), log
`/tmp/product20-2026-11-09.log`. Do not start a second run while this is live.

- Runner: `bash bench/official/subsets/run-product20.sh` with `TASKS_DIR=/tmp/tb-arm-dsh`,
  `OUT_DIR=bench/official/results/2026-11-09-product20`, `SKIP_SMOKE=1`.
- Tarball: `dist/dsh-graph-loop-bench.tgz`, 223,458 B,
  sha256 `f7a961a797ca5e17fdd68d52c0bd6dfeec50ec4151f42d84bbd7405069b12064`.
- Smoke was already 1.0/1.0/1.0 in `../2026-11-09-smoke-prep/`; skipped here to avoid overwriting
  tracked smoke evidence.
- Timeout: per-task `[agent].timeout_sec` (28800 s) — no artificial cap.
- `rows.jsonl` is truncated at start and grows per trial; each row carries `criteria` from
  `bench/official/terminal-bench/criteria.py`.
- The pre-run diagnostic passed: vpp both arms 4/5, medical 2/27 / 22/27, intrastat and heat-pump
  valid. See `../2026-11-09-prediag-fixes/README.md`.

**No aggregate is citable until all 20 tasks have `n_trials >= 1` and the runner exits.** A
`n_trials: 0` row is an infrastructure error. Do not merge the ad-hoc vpp retests into this run.
