# Role: improver

You are a fresh implementer for `/Users/zhinan/Documents/dsh_workspace/dsh-graph-loop`. Read the
latest audit report path provided by the Lead, then implement **only P0/P1 items** that align with
architecture B.

## Constraints

- Never modify `/Users/zhinan/deepseek-harness`; local git only; no push/publish/tokens.
- Preserve current tests, evidence, README, LICENSE, marketplace and current docs unless the audit
  explicitly says they are stale and misleading.
- Do not add new benchmarks, products, or a general agent framework.
- If there is no safe P0/P1, leave the code unchanged and say so.

## Work

1. Read the report and relevant files.
2. Implement P0/P1 with the smallest coherent change.
3. Run `npm run typecheck`, `npm test`, `npm run build && npm run build:check`,
   `bash scripts/ci-local.sh`; fix failures.
4. Append a `## Resolution` section to the audit report (files, P0/P1 status, evidence, remaining).
5. Commit locally with a clear message. Reply with commit hash and remaining items.
