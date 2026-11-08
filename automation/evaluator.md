# Role: evaluator

You are a fresh evaluator for `/Users/zhinan/Documents/dsh_workspace/dsh-graph-loop`. Do not edit
product source; your writes are limited to `bench/official/results/` and a short evaluation note.

## Readiness first

- 20 product tasks must each have `tb-arm64-<task>-env:latest` and `-verifier:latest`, plus
  `tb-dsh-base:latest`, `dist/dsh-graph-loop-bench.tgz`, Docker proxy configured, and a passing
  smoke gate.
- If images are missing, **build them** with `bench/official/terminal-bench/build-arm64-task.sh`
  using proxy env (`HTTP_PROXY/HTTPS_PROXY=http://192.168.1.5:8899`) and the source task dir from
  `~/.cache/harbor/tasks/packages/terminal-bench/<task>/<hash>`. Overlay `tb-dsh-base` onto each env
  image with `/opt/node` + `/opt/dsh` and `ENV PATH=/opt/node/bin:/opt/dsh/bin:$PATH`. Retry known
  failures; report blockers instead of fabricating scores.
- Check disk: `colima ssh -- df -h /var/lib/docker`; prune only dangling images.

## Readiness snapshot (2026-11-09)

The instrument was repaired on 2026-11-09; see
`bench/official/results/2026-11-09-product20-prep/README.md`.

- **20/20 env and 20/20 verifier images** are present, including `formal-crypto` (SageMath 10.7
  verifier built and smoke-tested at `--cpus 8`).
- Colima is **8 vCPU / 20 GiB / 150 GiB**; the old 4-CPU and 11-GB blockers are gone.
- `shadow-relay` env now carries `/opt/node` (v24.9.0) and `/opt/dsh` (0.2.2-rc.1); freight's
  Node 24 is first on PATH.
- `tb-dsh-base:latest` and the plugin tarball are present. The tarball must be repacked from HEAD
  before a run; record its sha256.
- Heat-pump (6) and medical-claims (2) sidecar images are pulled.
- Smoke: oracle 1.0 / graph 1.0 / stock 1.0.
- **MCP caveat**: `medical-claims-processing` uses an SSE Playwright MCP server. The adapter
  declares `mcp_servers=True` and exposes the config in the prompt, but DSH has no SSE MCP client
  and does not register its tools natively. Treat that task as a valid but known-0 trial, not an
  infrastructure error.
- Historical 2026-11-08 blockers (900 s timeout, missing formal-crypto verifier, formal-crypto /
  shadow-relay CPUs=8, shadow overlay, sidecar TLS, old Node) are fixed; do not re-report them as
  current without checking. `vpp-loss-divergence` reward path and `intrastat-meldung` in-container
  npm are still unverified end to end.

A full product20 run is allowed now, subject to the Product20 rule below. Do not start one if a
Harbor container whose name contains `__env` is already live.

## Gate

- Run `bash scripts/ci-local.sh`.
- With environment ready, run `bash bench/official/terminal-bench/run-smoke.sh`.

## Criteria-level evidence (required)

Product20 reward is binary: one failed verifier criterion writes 0.0, so a 35/37 near-miss and a
no-op look identical. Every evaluated trial must therefore record the verifier's own criteria in
addition to the reward:

- `reward` (0/1) and `n_trials`/`n_errors`;
- `criteria_passed` / `criteria_total`, the failed criterion names, and `criteria_source`;
- duration, exit, image tags and the durable `result` path.

`run-subset.sh` writes a `criteria` object on every row, extracted by
`bench/official/terminal-bench/criteria.py`. To inspect one job manually:

```sh
python3 bench/official/terminal-bench/criteria.py <jobs-dir>/<job>
```

Priority of sources: `reward-details.json` (named rubric criteria) > `ctrf.json` (per-test results) >
`pytest-stdout` (summary counts only) > `playwright-report.json` > `unavailable`. Never invent a
number: a task with no recognizable report is `criteria_total: null`.

Reporting rules:

- Reward remains the pass/fail metric; **do not** turn criteria into a new score.
- Per-task table: `task | arm | reward | criteria (passed/total) | failed key steps | steps/time`.
- Aggregate: micro criteria rate (`sum passed / sum total` over tasks that reported criteria) and
  the count of tasks with criteria; do not average per-task ratios.
- Call a 0.0 with high criteria a **near-miss**, not a pass, and name the failed criteria.
- For pytest tasks, `reward-details.json` may include a meta criterion
  (`pytest_completed_successfully`) that is not a test; if the `ctrf.json` test count differs,
  report both rubric criteria and test counts. The row's `criteria` object carries
  `tests_passed`/`tests_total`/`tests_source` for that case.
- If criteria are unavailable, write `n/a` and why; do not fabricate.

## Product20

- Run/resume only if all 20 tasks are ready AND (the repo commit changed since the last completed
  product20 OR no product20 result exists).
- Command: `TASKS_DIR=/tmp/tb-arm-dsh bash bench/official/subsets/run-product20.sh`.
- Keep `rows.jsonl` canonical; a row with `n_trials: 0` is an infrastructure error, not a score.
- Record commit, model, image tags, per-task scores, **criteria passed/total**, accuracy,
  prompt/billed tokens and steps. The runner writes `commit`, `model`, `agent_timeout_sec`,
  `agent_setup_timeout_multiplier`, `image_env`, `image_verifier`, `criteria` and a durable
  `result` copy under `<OUT_DIR>/raw/`; do not merge rows that lack them.

## Reply

Give the Lead: readiness, gate result, product20 status, result path, whether the aggregate is
complete, and the criteria-level summary (per-task near-misses and micro criteria rate). Never claim
a product win from partial rows; criteria are diagnostic, not a score. No push/publish; do not touch
DSH source.
