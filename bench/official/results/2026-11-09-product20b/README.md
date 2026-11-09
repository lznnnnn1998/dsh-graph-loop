# product20 — corrected run (2026-11-09b)

**In progress.** Started 2026-11-09 17:19 +08, runner PID `61129` (see `runner.pid`), OUT_DIR
`bench/official/results/2026-11-09-product20b/`, log `/tmp/product20b-2026-11-09.log`. Do not start a
second run while this is live.

This run uses the sandbox-instrument fix committed at `da3d598`:
- both arms get a shared profile patch with `sandbox-policy: danger-full-access` (the container is
  the sandbox) and `llm-deepseek` retries 3;
- stock no longer runs the unpatched `workspace-write` default;
- rows record `agent_exit` and `transport_failed` from `agent_result.metadata`;
- post-fix smoke: oracle 1.0 / graph 1.0 / stock 1.0 (`../2026-11-09-smoke-sandbox/`), with both
  agent sessions printing `Current DSH file policy: danger-full-access`.

The previous 31-row run was stopped and marked **not citable** at
`../2026-11-09-product20/INVALID.md` (transport crashes + `/app` sandbox caps). Do not merge its
rows into this run.

## Identity

- Run commit (executed): `da3d598113449e62718e5b810e1d5ce77234585a` (`da3d598`) — HEAD when
  `run-subset.sh` started at 17:19; **every row carries this commit**. The wrapper commit
  `b3e9af7b25902aa49f2c94b61734f53010e71e80` (`b3e9af7`, which only added this README) was committed
  at 17:20:49, ~2 min **after** the runner started, so it is docs-only and is **not** the executed
  commit; read the run's identity from the rows' `commit` plus the tarball sha, not from the wrapper.
- Tarball: `dist/dsh-graph-loop-bench.tgz`, 223,458 B, sha256
  `f7a961a797ca5e17fdd68d52c0bd6dfeec50ec4151f42d84bbd7405069b12064` (plugin code unchanged since
  `63b5f20`; do not repack while this run is live).
- Per-task `[agent].timeout_sec` 28800; `SKIP_SMOKE=1` because the post-fix smoke already passed.

## Status and close

- `rows.jsonl` grows per trial and carries reward + criteria + agent validity; it is the canonical
  partial record. `raw/`, `jobs/` and `runner.pid` are this run's only durable progress record —
  never delete or rewrite them while it is live.
- No aggregate is citable until 40 rows (20 tasks × 2 arms), every trial agent-valid (no
  `TRANSPORT`, no agent exit 1 other than `GRAPH_FAILED`, every declared artifact path writable), and
  the runner exits with `_EXIT` in `/tmp/product20-shard-full.log`.
- Liveness is the marker text **plus the live PID it names**: read
  `/tmp/product20-shard-full.log` (`product20b running pid=61129 …`) and `ps -p 61129`. The marker is
  shared and truncated by each launcher, so it belongs to this run; a watcher appends `_EXIT` when
  PID `61129` dies.
- **Never append `_EXIT` from the stopped run's dead PID** (`…/2026-11-09-product20/runner.pid` =
  `38616`), and never while any `bench/official/results/*/runner.pid` names a live process. Append by
  hand only if this run's own PID is dead, no other runner is live, and the marker names this run;
  see the marker-close rule in
  [`automation/evaluator.md`](../../../../automation/evaluator.md#product20). Do not delete the
  marker.
