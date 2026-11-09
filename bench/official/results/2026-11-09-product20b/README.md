# product20 — corrected run (2026-11-09b) — ABORTED at 5/40

**Aborted 2026-11-09 19:44 +08 at 5/40 rows; this is not a product run and it is not citable.**
Runner PID `61129` (see `runner.pid`) is dead, the shared marker `/tmp/product20-shard-full.log` ends
`_EXIT`, and there is no `summary.json`. See [`ABORTED.md`](ABORTED.md): the graph arm hit the
stage-routing bug fixed at `4561008` (the repair loop consumed the step budget and exited
`GRAPH_FAILED` at `n_mutate`), and the stock music trial never ran. The five rows are evidence of that
bug, not a graph-vs-stock measurement. Do not resume, merge, score or cite them; `run-subset.sh` has no
resume and truncates `rows.jsonl`, so never point a new `OUT_DIR` here.

## Identity

- Run commit (executed): `da3d598113449e62718e5b810e1d5ce77234585a` (`da3d598`) — HEAD when
  `run-subset.sh` started at 17:19; **every row carries this commit**. The wrapper commit
  `b3e9af7b25902aa49f2c94b61734f53010e71e80` (`b3e9af7`, which only added this README) was committed
  at 17:20:49, ~2 min **after** the runner started, so it is docs-only and is **not** the executed
  commit; read the run's identity from the rows' `commit` plus the tarball sha, not from the wrapper.
- Tarball: `dist/dsh-graph-loop-bench.tgz`, 223,458 B, sha256
  `f7a961a797ca5e17fdd68d52c0bd6dfeec50ec4151f42d84bbd7405069b12064` — the **pre-`4561008`** bundle
  (`toolSucceeded` absent). A HEAD pack is 225,595 B / sha256
  `45de85397ac0d07fa2b836290375bfec31c499c723bc4d98157b4d22b84070dc`; this run did not use it.
- Per-task `[agent].timeout_sec` 28800; `SKIP_SMOKE=1` because the post-fix smoke had passed (on the
  same pre-fix tarball).

## Status and close (closed)

- `rows.jsonl` (5 rows), `raw/` (5 files), `jobs/` (session logs) and `runner.pid` are this run's
  durable abort record — never delete or rewrite them.
- The marker is already closed with `_EXIT`; never append to or truncate it.
- This directory is **not** a resume target and its rows are **not** part of any aggregate. A future
  product20 needs a HEAD tarball repack, a bounded post-HEAD real-model pre-run and a new `OUT_DIR`
  (see [`automation/evaluator.md`](../../../../automation/evaluator.md#product20)).
