# Official benchmark results

| run | benchmark | tasks | arms | score |
|---|---|---|---|---|
| [smoke-answer-42](smoke-answer-42/) | smoke | 1 | oracle, stock, graph | **1.0 / 1.0 / 1.0** |
| [terminal-bench-post-smoke](terminal-bench-post-smoke/) | Terminal-Bench 4.0 | 3 | stock, graph | 0.0 graph clean; stock timeouts |
| [2026-11-07-html-js-filter](2026-11-07-html-js-filter/) | Terminal-Bench 4.0 | 1 | stock, graph | 0.0 / 0.0 |
| [terminal-bench-subset](terminal-bench-subset/) | Terminal-Bench 4.0 | 7 attempted (2 clean pairs) | stock, graph | 0.0 on every clean trial |

None of these runs is an aggregate score. The environment was rebuilt for linux/arm64 on Apple
Silicon (the public images are amd64; Node crashes under qemu), so note the platform when comparing
to the public leaderboard.

Caveats, recorded rather than hidden:

- **Dataset unpinned:** `terminal-bench/terminal-bench@latest` (66 tasks) was used and no digest was
  recorded.
- **Smoke gate added later:** the `html-js-filter` trial and the first 7-task subset attempt predate
  `run-smoke.sh` (first smoke run 21:29); only `terminal-bench-post-smoke` is smoke-gated.
- **Graph arm retry policy:** the graph profile patch sets `llm-deepseek.retryPolicy.maxRetries: 1`;
  the stock arm uses the default.
- **Error rows:** `summary.json` writes timeout/error rows as `score: 0.0` with `n_trials: 0` /
  `n_errors: 1`; these are not valid 0 scores. `rows.jsonl` is canonical for validity.
