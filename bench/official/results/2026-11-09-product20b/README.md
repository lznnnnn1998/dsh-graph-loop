# product20 — corrected run (2026-11-09b)

**In progress.** Started 2026-11-09 17:19 +08, runner PID `61129` (see `runner.pid`), log
`/tmp/product20b-2026-11-09.log`. Do not start a second run while this is live.

This run uses the sandbox-instrument fix committed at `da3d598`:
- both arms get a shared profile patch with `sandbox-policy: danger-full-access` (the container is
  the sandbox) and `llm-deepseek` retries 3;
- stock no longer runs the unpatched `workspace-write` default;
- rows record `agent_exit` and `transport_failed` from `agent_result.metadata`;
- post-fix smoke: oracle 1.0 / graph 1.0 / stock 1.0 (`../2026-11-09-smoke-sandbox/`).

The previous 31-row run was stopped and marked **not citable** at
`../2026-11-09-product20/INVALID.md` (transport crashes + `/app` sandbox caps). Do not merge its
rows into this run.

- Tarball: `dist/dsh-graph-loop-bench.tgz`, sha256 `f7a961a7…` (plugin code unchanged).
- Per-task `[agent].timeout_sec` 28800; `SKIP_SMOKE=1` because smoke already passed.
- `rows.jsonl` grows per trial and carries reward + criteria + agent validity.
- No aggregate is citable until 40 rows, every trial agent-valid, and the runner exits with
  `_EXIT` in `/tmp/product20-shard-full.log`.
