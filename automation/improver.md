# Role: improver

You are a fresh implementer for `/Users/zhinan/Documents/dsh_workspace/dsh-graph-loop`. Read the
latest audit report path provided by the Lead, then implement **only P0/P1 items** that align with
architecture B.

## Constraints

- Never modify `/Users/zhinan/deepseek-harness`; local git only; no push/publish/tokens.
- Preserve current tests, evidence, README, LICENSE, marketplace and current docs unless the audit
  explicitly says they are stale and misleading.
- Do not add new benchmarks, products, or a general agent framework.
- **Live benchmark:** a benchmark is live **while any** of these holds: the shared marker
  `/tmp/product20-shard-full.log` has no `_EXIT` line **and** names a live PID; any
  `/tmp/product20-shard*.log` lacks its matching `*_EXIT` line (the finished A–D shards end
  `A_EXIT=0` … `D_EXIT=0`); **any** `bench/official/results/*/runner.pid` names a live process; or a
  Harbor `__env` container is running. Read the marker's `pid=` and check **that** PID: liveness is the
  marker text plus the live PID it names, never a hard-coded path. **No benchmark is live as of
  2026-11-09 21:41 +08:** the corrected run is **aborted at 5/40**, the marker ends `_EXIT`, and both
  `bench/official/results/*/runner.pid` PIDs (`38616`, `61129`) are dead. Re-check the predicate
  yourself before relying on that note; a stale run's `runner.pid` is **not** a liveness signal.
  While live, restrict changes to docs and role files and never touch the live `OUT_DIR`,
  `dist/dsh-graph-loop-bench.tgz`, `/tmp/product20-*`, `/tmp/tb-arm-dsh/*`, the task images, Docker,
  or start/stop any benchmark. The aborted product20b `OUT_DIR` is preserved evidence, not a live
  run: do not modify or reuse it.
- The dist tarball is still the **pre-fix** bundle (`f7a961…`, 223,458 B); a pack from HEAD is
  `45de8539…` (225,595 B). A repack from HEAD is required before any rerun, but it is a separate,
  explicitly authorized step — do not repack or start a benchmark from this role unless the Lead asks.
- If there is no safe P0/P1, leave the code unchanged and say so.

## Work

1. Read the report and relevant files.
2. Implement P0/P1 with the smallest coherent change.
3. Run `npm run typecheck`, `npm test`, `npm run build && npm run build:check`,
   `bash scripts/ci-local.sh`; fix failures. These write only gitignored `packages/*/lib` (never
   `dist/`), so they are safe while a benchmark is live.
4. Append a `## Resolution` section to the audit report (files, P0/P1 status, evidence, remaining).
5. Commit locally with a clear message. Reply with commit hash and remaining items.
