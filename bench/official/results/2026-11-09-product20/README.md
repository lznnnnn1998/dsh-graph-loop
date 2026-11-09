# product20 — full run (2026-11-09) — **STOPPED / NOT CITABLE**

> **STOPPED 2026-11-09 13:51 +08 at 31/40 rows. NOT CITABLE — do not use any number from this
> directory.** The authoritative record is [`INVALID.md`](INVALID.md): 6 DSH `TRANSPORT` crashes and
> 6 file-policy-capped trials on the pre-fix instrument. The corrected run is
> [`../2026-11-09-product20b/`](../2026-11-09-product20b/README.md); do not merge these rows into it.

Started **2026-11-09 04:18:32 +08** (`ps -p 38616 -o lstart`; first job name `…-041832`; raw
`started_at` 04:18:36), PID `38616` (see `runner.pid`), runner log `/tmp/product20-2026-11-09.log`.
The Lead stopped it at 13:51 +08. Its 31 rows, `raw/` and `jobs/` are preserved as evidence of the
broken instrument, **not** as a product result.

- Runner: `bash bench/official/subsets/run-product20.sh` with `TASKS_DIR=/tmp/tb-arm-dsh`,
  `OUT_DIR=bench/official/results/2026-11-09-product20`, `SKIP_SMOKE=1`.
- Run commit: `11fe18f84eb4ef903f947eac05b58038442461f5` (HEAD at start; later commits are
  docs-only). Every row carries this commit.
- Tarball: `dist/dsh-graph-loop-bench.tgz`, 223,458 B,
  sha256 `f7a961a797ca5e17fdd68d52c0bd6dfeec50ec4151f42d84bbd7405069b12064`, packed from the plugin
  source (unchanged by this run).
- Smoke was already 1.0/1.0/1.0 in `../2026-11-09-smoke-prep/`; it was skipped because this benchmark
  was live and a second Harbor run would have contended with it.
- Timeout: per-task `[agent].timeout_sec` (28800 s) — no artificial cap.
- `rows.jsonl` holds **31/40** rows and is preserved as-is (do not append, truncate or rewrite it);
  each row carries `criteria` from `bench/official/terminal-bench/criteria.py` and a durable copy of
  the Harbor result under `raw/`.
- `jobs/`, `raw/`, `rows.jsonl` and `runner.pid` are this run's durable record and the evidence behind
  `INVALID.md`; do not delete or rewrite them.
- The pre-run diagnostic had passed (vpp both arms 4/5, medical 2/27 / 22/27). The vpp/medical
  repairs are local-only; do not rebuild or reset the task dirs now.

## Liveness and close (historical)

- This run is **dead**: `ps -p 38616` finds nothing; its watcher appended `_EXIT` when it was
  stopped. The shared marker `/tmp/product20-shard-full.log` was then **truncated** by the corrected
  run's launcher, so it no longer names this run (it now reads
  `product20b running pid=61129 …`) and is **not** this run's close record — `INVALID.md` is.
- **Do not append `_EXIT` on account of this run's dead PID.** The shared marker currently belongs to
  the live `product20b` run (PID `61129`); appending there would falsely close it. Follow the
  marker-close rule in [`automation/evaluator.md`](../../../../automation/evaluator.md#product20)
  (the marker names the run, that PID is dead, and no `bench/official/results/*/runner.pid` is live).
- Do not delete the marker, this OUT_DIR, `raw/`, `jobs/`, `rows.jsonl`, the tarball or the task
  images.

## Why this run is not citable

**No aggregate is citable from this directory.** `n_trials: 0` is an infrastructure error, and so are
two classes the row schema did not show ([trial validity](../../../../docs/EVALUATION.md#trial-validity)):

- **Transport crashes.** At the 29-row point (05:28Z audit) 6 trials were
  `dsh: TRANSPORT: DeepSeek Messages transport failed` crashes recorded as ordinary `0.0` rows with
  `n_errors: 0` and `exit: 0` — graph `cargo`, graph `medical`, stock `foodstuff`, stock
  `interleaved`, stock `pretrain`, stock `vpp`. They are **not trials**; do not score them 0.0 or
  read them as capability gaps. (`exit` is Harbor's run status, not the agent's.)
- **File-policy caps.** 6 rows (intrastat ×2, roy ×2, vpp ×2) could not write their declared
  `task.toml` artifacts because DSH ran under the default `workspace-write` policy rooted at `/app`
  (`/workspace/out`, `/results`, installed `site-packages`); `freight-dispatch-shift`
  (`/workspace/dispatch`) would have been capped the same way. Those criteria counts are **ceilings
  for both arms**, not capability results.

The instrument was fixed after this stop at `da3d598` (shared `sandbox-policy: danger-full-access`
for both arms, LLM retries 3, `agent_exit`/`transport_failed` metadata; `run-subset.sh` records those
fields) and verified by `../2026-11-09-smoke-sandbox/`. The fix and an **infrastructure re-run of the
affected trials into a new `OUT_DIR`** are required; the stopped rows themselves cannot become the
reference. Do not merge the ad-hoc vpp retests into this directory either.
