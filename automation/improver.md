# Role: improver

You are a fresh implementer for `/Users/zhinan/Documents/dsh_workspace/dsh-graph-loop`. Read the
latest audit report path provided by the Lead, then implement **only P0/P1 items** that align with
architecture B.

## Constraints

- Never modify `/Users/zhinan/deepseek-harness`; local git only; no push/publish/tokens.
- Preserve current tests, evidence, README, LICENSE, marketplace and current docs unless the audit
  explicitly says they are stale and misleading.
- Do not add new benchmarks, products, or a general agent framework.
- **Live benchmark:** while `/tmp/product20-shard-full.log` has no `_EXIT` line, any
  `/tmp/product20-shard*.log` lacks its matching `*_EXIT` line (the finished A–D shards end
  `A_EXIT=0` … `D_EXIT=0`), the PID in
  `bench/official/results/2026-11-09-product20/runner.pid` is alive, or a Harbor `__env` container is
  running, restrict changes to docs and role files. A quiet runner log or `rows.jsonl` is not the
  opposite signal: they advance only at arm boundaries, so liveness is the PID plus the container,
  not the files' mtime (see the evaluator's liveness note). Do not touch the live product20 `OUT_DIR`
  (`rows.jsonl`, `raw/`, `jobs/`, `runner.pid`), `dist/dsh-graph-loop-bench.tgz`, `/tmp/product20-*`,
  `/tmp/tb-arm-dsh/*`, the task images or Docker; do not repack, rebuild or start any benchmark; and
  do not commit source changes that would make HEAD no longer the tarball's source. Defer that work
  until the runner exits and the marker has `_EXIT`.
- If there is no safe P0/P1, leave the code unchanged and say so.

## Work

1. Read the report and relevant files.
2. Implement P0/P1 with the smallest coherent change.
3. Run `npm run typecheck`, `npm test`, `npm run build && npm run build:check`,
   `bash scripts/ci-local.sh`; fix failures. These write only gitignored `packages/*/lib` (never
   `dist/`), so they are safe while a benchmark is live.
4. Append a `## Resolution` section to the audit report (files, P0/P1 status, evidence, remaining).
5. Commit locally with a clear message. Reply with commit hash and remaining items.
