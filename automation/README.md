# Recurring four-role cycle

Every four hours the Lead runs four **fresh, separate** agents in this fixed order:

| Order | Role | Prompt | Deliverable |
|---|---|---|---|
| 1 | auditor | `automation/auditor.md` | `docs/audits/<UTC>.md` |
| 2 | improver | `automation/improver.md` | one coherent code/test/instrument commit + Resolution |
| 3 | evaluator | `automation/evaluator.md` | gate result + benchmark result under `bench/official/results/` |
| 4 | cleaner | `automation/cleaner.md` | cleanup commit or clean-tree report |

The Lead only orchestrates: create the lock, pass paths and one-line results, wait for each role,
remove the lock after the cleaner. It never performs a role, starts a benchmark, or edits product
code itself.

## Cycle contract

1. **Goal.** The cycle starts with a one-line goal (for example
   `make product20 trustworthy: repack, bounded pre-run, then decide`). Roles serve that goal; they
   must not invent a new product direction, a new benchmark, or a broad refactor.
2. **State first.** Every role runs `bash scripts/cycle-state.sh` before acting and quotes its
   output. Role prompts must not hard-code a HEAD, tarball sha, run directory or PID. If the script
   and a doc disagree, the script wins; correct the doc only if it would mislead an operator.
3. **Strict sequence.** Spawn role N+1 only after role N has returned. Never reuse an agent or run
   two roles concurrently. Handoff is a path plus a one-line result, never a transcript.
4. **One lock.** Create `docs/audits/.running` before the auditor. The cleaner removes it at the end.
   A cancelled cycle leaves it for the Lead to remove. The lock is role-level; a background
   benchmark is guarded by the live-run predicate, not by this lock.
5. **Small output.** Auditor: at most 8 findings. Improver: at most one P0 and one P1, one coherent
   commit. Evaluator: one gate decision, one run status. Cleaner: one cleanup commit. If a role finds
   nothing safe, it says "no-op" and stops; it does not manufacture work.
6. **Ownership.** Each finding names exactly one owner: `improver` (code/tests/instrument/docs that
   block reliability), `evaluator` (execution/validation), `cleaner` (hygiene), or `Lead`
   (schedule/lock/human decision). A role may not silently take another owner's finding.
7. **Benchmark execution.** Only the evaluator may start a benchmark. Only after the live-run
   predicate is false, the tarball matches HEAD, `scripts/ci-local.sh` passes, and the bounded
   post-HEAD gate passes. Start it in the background, record PID/log/OUT_DIR/rows, and return.
8. **Stop on blocker.** If the next step needs an unavailable image, a human decision, or a live run
   to finish, report the blocker and stop. Do not run a second benchmark, do not kill a live one,
   and do not append `_EXIT` unless the marker-close rule in `evaluator.md` is satisfied.
9. **Non-negotiables.** Architecture B (`packages/loop` replaces the stock `agent-loop` through
   `AgentFactory`); never edit `/Users/zhinan/deepseek-harness`; local git only; no push, publish or
   registry tokens; no fabricated scores; preserve current evidence, task images and the current
   tarball; never run `git clean` or `git add -A` while untracked run evidence exists.

## Handoff files

- Audit: `docs/audits/<UTC>.md`; its `## Resolution` is appended by the improver.
- Evaluation: `bench/official/results/<UTC>-eval/README.md` plus the run's `rows.jsonl`/`raw/`.
- Cleanup: a local commit; the cleaner reports the diff summary and what it preserved.
- State: `scripts/cycle-state.sh` output; stable environment facts live in
  `automation/ENVIRONMENT.md`.
