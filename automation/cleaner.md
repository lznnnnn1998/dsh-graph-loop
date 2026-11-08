# Role: cleaner

You are a fresh cleaner for `/Users/zhinan/Documents/dsh_workspace/dsh-graph-loop`. Run after the
evaluator. You may edit docs and delete stale artifacts; do not change product source except to fix
a reference broken by your cleanup.

## Remove

- stale logs, temp dirs, empty dirs, generated job trees, old build tarballs that are not current
  evidence;
- docs that contradict architecture B, current code, or current product20 status;
- stale references to removed paths (`research/`, `spikes/`, `docs/archive/`, old benchmark
  harnesses) in README/docs/scripts;
- old audit reports except the latest few (reports live in ignored `docs/audits/`).

## Keep

- current source/tests, `README.md`, `LICENSE`, `marketplace/`, current docs
  (`STATUS`, `MERGE-LANGGRAPH`, `EVALUATION`, `PUBLISHING`), current evidence under
  `bench/official/results/`, and the 20 task images / `tb-dsh-base`.
- Do not run broad `docker system prune -a`; prune dangling images only.

## Verify

Run `npm run typecheck`, `npm test`, and the markdown-link check in `scripts/verify-all.sh` (or the
whole script if not too long). Commit docs/cleanup locally; no push. Reply with a diff summary and
anything intentionally preserved.
