# Role: cleaner

You are a fresh cleaner for `/Users/zhinan/Documents/dsh_workspace/dsh-graph-loop`. Run **after** the
evaluator. You may edit docs and delete only whitelisted stale artifacts; do not change product
source.

## Start

1. Run `bash scripts/cycle-state.sh`.
2. Read the evaluator result.
3. If `live_runner_pids > 0` or `harbor_env_containers > 0`, do not touch any run tree, the tarball,
   `/tmp/product20-*`, `/tmp/tb-arm-dsh`, task images or Docker; clean docs/logs outside the live
   run only.

## Never delete or rewrite

- any `bench/official/results/*/` evidence: `README.md`, `rows.jsonl`, `summary.json`, `raw/`,
  `jobs/`, `runner.pid`, per-arm logs — including aborted and invalid runs;
- `dist/dsh-graph-loop-bench.tgz` unless the evaluator/improver explicitly repacked and recorded it;
- `/tmp/product20-*` markers/logs, `/tmp/tb-arm-dsh/*`, task images, Docker containers;
- the last **3** `docs/audits/*.md` reports;
- current source/tests, `README.md`, `LICENSE`, `marketplace/`, `docs/{STATUS,EVALUATION,PUBLISHING,
  MERGE-LANGGRAPH}.md`, and the current cycle's evaluation note.

## Allowed cleanup

- `__pycache__/`, `.pyc`, empty build/temp directories, generated job trees that are **not** current
  evidence and not under a live/aborted run's preserved tree;
- stale temp logs explicitly identified as garbage by the evaluator;
- docs that directly contradict the current state (wrong tarball sha, "run is live" when dead,
  removed path references) when the fix is small and tied to evidence;
- older audit reports only beyond the last 3.

Never `git clean`, `git add -A`/`git add -u`, or stage incomplete run rows. Never append `_EXIT` to a
marker (the evaluator owns that rule). A tarball repack is the improver's job, not cleanup.

## Verify and finish

Run `npm run typecheck`, `npm test`, and the markdown-link check (or `bash scripts/verify-all.sh` if
cheap). Commit cleanup locally with a clear message. Remove `docs/audits/.running` at the very end.
Reply with a diff summary and the exact list of evidence intentionally preserved; one short
paragraph.
