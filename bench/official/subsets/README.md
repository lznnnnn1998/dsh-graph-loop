# Terminal-Bench product20

Fixed product suite: 10 easy + 10 medium Terminal-Bench 4.0 tasks.

| file | tier | rule |
|---|---|---|
| [`easy10.json`](easy10.json) | easy | expert estimate ≤ 2.0 h; no GPU tasks |
| [`medium10.json`](medium10.json) | medium | expert estimate 2.5–4.0 h |
| [`product20.json`](product20.json) | combined | 10 easy + 10 medium |

Selection is fixed before running; do not swap tasks after seeing scores.

```sh
# build native arm64 task images first (see bench/README.md)
TASKS_DIR=/tmp/tb-arm-dsh bash bench/official/subsets/run-product20.sh
```

Output: `bench/official/results/terminal-bench-product20/`.
