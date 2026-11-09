# Recurring five-role cycle

Every four hours the Lead runs five **fresh, separate** agents in this fixed order:

| Order | Role | Prompt | Deliverable |
|---|---|---|---|
| 1 | role-designer | `automation/role-designer.md` | contract correction (or `no-op`) + `role-design-<UTC>.md` |
| 2 | auditor | `automation/auditor.md` | `docs/audits/<UTC>.md` |
| 3 | improver | `automation/improver.md` | one coherent graph-loop code/test commit + Resolution |
| 4 | evaluator | `automation/evaluator.md` | graph-behavior evidence note + (only if needed) a bounded run |
| 5 | cleaner | `automation/cleaner.md` | cleanup commit or clean-tree report |

The Lead only orchestrates: create the lock, pass paths and one-line results, wait for each role,
remove the lock after the cleaner. It never performs a role, starts a benchmark, or edits product
code itself.

## North star

All five roles read [`INTENT.md`](INTENT.md) first. The product is the graph loop; **testing exists
to serve the loop**. Product20, smoke and the benchmark instrument are evidence, not the objective.
A cycle that only repacks tarballs, edits docs or polishes aggregate accounting without improving
graph-loop correctness/generality has failed.

## Cycle contract

1. **Goal.** Each cycle has one graph-loop goal, for example
   `make composed stages state-driven without losing the stock turn model`,
   `prove checkpoint/resume through the real driver`, or
   `diagnose why a real-model run ends in GRAPH_FAILED`. The goal is never "improve the score".
2. **State first.** Every role runs `bash scripts/cycle-state.sh` and quotes it. Role prompts must
   not hard-code HEAD, tarball sha, run directory or PID. If a doc and the script disagree, the
   script wins.
3. **Strict sequence.** Spawn role N+1 only after role N returns. Never reuse an agent or run two
   roles concurrently. Handoff is a path plus a one-line result, never a transcript.
4. **One lock.** Create `docs/audits/.running` before `role-designer`; the cleaner removes it. A
   cancelled cycle leaves it for the Lead. The lock is role-level; a benchmark is guarded by the
   live-run predicate, not by this lock.
5. **Small output.** Role-designer: one contract commit or `no-op`. Auditor: at most 8
   owner-tagged findings. Improver: at most one P0 and one P1, one commit. Evaluator: one evidence
   decision, one run status if a run is justified. Cleaner: one cleanup commit. No manufactured work.
6. **Ownership.** Each finding names one owner: `role-designer` (prompt/contract/handoff),
   `improver` (graph code/tests/instrument), `evaluator` (behavioral evidence/execution), `cleaner`
   (hygiene), or `Lead` (schedule/lock/human decision). A role may not take another's finding.
7. **Evidence before execution.** Prefer deterministic tests and three-engine drills. Run a real
   model only when the question needs model behavior, and then use a bounded task set first. Full
   product20 is for end-to-end evidence, not a default gate.
8. **Benchmark discipline (only when a run is used).** Only the evaluator may start a benchmark.
   Never start a second, never kill a live one, never append `_EXIT` unless the marker-close rule is
   satisfied. Validate rows before using them as evidence: `n_trials`, `n_errors`, agent terminal,
   `TRANSPORT`, file-policy cap, commit/tarball sha, criteria. A score is never a product claim.
9. **Stop on blocker.** If the next step needs an unavailable image, a human decision or a live run,
   report it and stop. Do not fill the cycle with documentation churn.
10. **Non-negotiables.** Architecture B; no DSH source edits; local git; no push/publish/tokens; no
    fabricated scores; preserve evidence, task images and the current tarball; never `git clean` or
    `git add -A` while untracked run evidence exists.

## Handoff files

- Role design: `docs/audits/role-design-<UTC>.md`; only the role-designer writes it.
- Audit: `docs/audits/<UTC>.md`; the improver appends `## Resolution`.
- Evaluation: `bench/official/results/<UTC>-eval/README.md` (plus rows/raw only if a run was used).
- Cleanup: a local commit; the cleaner reports the diff and what it preserved.
- State: `scripts/cycle-state.sh`; stable environment facts: `automation/ENVIRONMENT.md`.
