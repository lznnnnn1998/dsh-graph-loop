# Official benchmark results

| run | benchmark | tasks | arms | score |
|---|---|---|---|---|
| [smoke-answer-42](smoke-answer-42/) | smoke | 1 | oracle, stock, graph | **1.0 / 1.0 / 1.0** |
| [terminal-bench-post-smoke](terminal-bench-post-smoke/) | Terminal-Bench 4.0 | 3 | stock, graph | 0.0 graph clean; stock timeouts |
| [2026-11-07-html-js-filter](2026-11-07-html-js-filter/) | Terminal-Bench 4.0 | 1 | stock, graph | 0.0 / 0.0 |
| [terminal-bench-subset](terminal-bench-subset/) | Terminal-Bench 4.0 | 5 attempted, 2 clean pairs | stock, graph | 0.0 on every clean trial |

Neither run is an aggregate. The environment was rebuilt for linux/arm64 on Apple Silicon (the
public images are amd64; Node crashes under qemu), so note the platform when comparing to the public
leaderboard. The subset's timeouts/errors are recorded in `rows.jsonl`; they are not valid scores.
