# Evaluation — product20

Status: **in progress.** The suite is fixed; results are not complete. No product claim until all
20 tasks have valid stock and graph trials.

## Suite

- Terminal-Bench 4.0, 10 easy + 10 medium.
- Manifest: [`bench/official/subsets/product20.json`](../bench/official/subsets/product20.json).
- Fixed before running; do not swap tasks after seeing scores.

## Arms

| Arm | What runs |
|---|---|
| `stock` | stock `agent-loop`, same model/tools/budget |
| `graph` | this bundle; dynamic mode uses envelope + composition |

Both arms use the same model, task image, tool policy, timeouts and agent timeout.

## Run protocol

1. `run-smoke.sh`: oracle/graph/stock must all be 1.0.
2. Build native arm64 task env + verifier images (see [`bench/README.md`](../bench/README.md)).
3. Run `run-product20.sh`; each task runs graph and stock.
4. Keep `rows.jsonl` as the canonical rows; a `0.0` with `n_trials: 0` is an infrastructure error,
   not a score.

## Metrics

- Primary: accuracy parity, prompt tokens (mean and median), steps.
- Secondary: billed input/output/total, output tokens, wall time, errors.
- Record model, commit, harness and image tags with every result.

## Success criteria

1. Accuracy parity with stock on the 20 tasks.
2. Lower prompt tokens (mean and median).
3. Steps parity or better.
4. No DSH source changes; installable/default-mode behavior verified.
5. The live path uses the graph driver, not only core tests.

## Current evidence

- Smoke: 1.0 oracle/graph/stock.
- `html-js-filter`: graph 0.0 / stock 0.0, one task, both arms completed
  ([result](../bench/official/results/2026-11-08-html-js-filter/README.md)).
- No aggregate. Do not cite older local-suite numbers; they are not in this tree.

## Reporting

Per-task table plus aggregate, with `n_trials`, `n_errors`, prompt/billed tokens and steps. Report
mean and median; identify task build failures separately.
