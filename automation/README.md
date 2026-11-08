# Recurring agent cycle

Every two hours, four **separate fresh agents** run in this order. The Lead only orchestrates and
passes file paths; it must not do any of the four roles itself.

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
  (a live Harbor `__env` container) is what prevents a second benchmark, not the lock. A lock left in
  place by a finished cycle is cleared by the Lead.
- All four inherit the same non-negotiables: architecture B, no DSH source edits, local git only,
  no push/publish/tokens, no new benchmark or product line, preserve current evidence.
