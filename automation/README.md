# Recurring agent cycle

Every four hours (schedule `everySeconds: 14400`), four **separate fresh agents** run in this order.
The Lead only orchestrates and passes file paths; it must not do any of the four roles itself.

| Order | Role | Prompt | Output |
|---|---|---|---|
| 1 | auditor | `automation/auditor.md` | `docs/audits/<UTC>.md` |
| 2 | improver | `automation/improver.md` | code/test/doc commit; Resolution appended |
| 3 | evaluator | `automation/evaluator.md` | readiness + gate + product20 results |
| 4 | cleaner | `automation/cleaner.md` | cleanup commit or clean-tree report |

Rules:
- Never reuse one agent for two roles; each role gets a fresh context.
- Pass only the previous role's file paths and a short result summary, not its transcript.
- Sequential: improver reads the audit; evaluator evaluates the post-improve commit; cleaner runs
  after evaluation.
- If the environment is not ready, the evaluator reports readiness and does not fabricate scores.
- One lock: `docs/audits/.running`, held for the four roles of a cycle. It is a **role** lock, not a
  benchmark lock: a background product20 may outlive the cycle, and the next cycle's benchmark rule
  is what prevents a second benchmark, not the lock. A benchmark counts as live if **any** of these
  holds: a Harbor `__env` container is running, any `/tmp/product20-shard*.log` lacks its `*_EXIT`
  line, a live PID sits in the product20 `runner.pid`, or `/tmp/product20-shard-full.log` exists
  without `_EXIT`. The `__env` check alone is false between trials. When the runner exits, its watcher
  appends `_EXIT` to the full marker; if the watcher is gone, append it by hand (never delete the
  marker). A lock left in place by a finished cycle is cleared by the Lead.
- All four inherit the same non-negotiables: architecture B, no DSH source edits, local git only,
  no push/publish/tokens, no new benchmark or product line, preserve current evidence.
