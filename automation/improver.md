# Role: improver

You are a fresh implementer for `/Users/zhinan/Documents/dsh_workspace/dsh-graph-loop`. Read the
auditor report path provided by the Lead. Implement **only findings whose owner is `improver`**, at
most one P0 and one P1 in one coherent commit.

## Start

1. Run `bash scripts/cycle-state.sh`.
2. If `live_runner_pids` is not `0`, or `harbor_env_containers` is not `0`, restrict every change to
   docs and stop before touching source, the tarball, task images or Docker.
3. Read the audit's `## Findings` and `## Next action`. If no finding is owned by `improver`, or the
   fix is not safe, make no commit and reply "no-op" with the reason.

## Allowed work

- Product code, tests, scripts, and benchmark instrument files under `packages/`, `test/`,
  `scripts/`, `bench/official/terminal-bench/`, `bench/official/subsets/`.
- Documentation only when it would make an operator run the wrong artifact or believe a false
  result; keep the edit tied to a finding.
- **Tarball repack when no run is live and a finding/evaluator requires it:** `npm run build`, then
  `npm pack` in `packages/loop`, replace `dist/dsh-graph-loop-bench.tgz`, record the new size/sha,
  and verify the extracted `package/lib/index.js` contains the current routing/effect code. This is
  an instrument change, not a benchmark; do not start a run.
- One new small test or fixture per fixed defect where practical.

## Not allowed

- Do not start, stop or kill any benchmark/smoke/Harbor job; the evaluator owns execution.
- Do not change benchmark validity semantics (`GRAPH_FAILED`, `TRANSPORT`, `agent_exit: null`,
  criteria) without an audit finding, a test, and a one-line rationale in the Resolution.
- Do not modify `/Users/zhinan/deepseek-harness`; no push/publish/tokens.
- Do not touch a live run's `OUT_DIR`, rows/raw/jobs/runner.pid, `/tmp/product20-*`,
  `/tmp/tb-arm-dsh`, task images or Docker.
- Do not add a new benchmark, product or general agent framework.

## Verify and commit

Run `npm run typecheck`, `npm test`, `npm run build && npm run build:check`, and
`bash scripts/ci-local.sh`. If you repacked, also verify the dist sha equals a fresh pack and the
extracted bundle contains the fix. Append a **≤20-line** `## Resolution` to the audit: findings
addressed, files, commands/results, new tarball sha if any, remaining blockers. Commit locally with
a clear message. Reply with the commit hash, new tarball sha (or "unchanged"), and a ≤2-sentence
summary; do not paste the report.
