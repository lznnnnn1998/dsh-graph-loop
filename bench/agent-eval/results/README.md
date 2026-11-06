# Benchmark result files

All rows come from `bench/agent-eval/run.mjs`; each row carries `arm`, `task`, `rep`, `ok`, steps,
tool calls, usage tokens and wall time. Read both **mean and median**:
`node bench/agent-eval/summarize.mjs <file> --per-task`.

| file | suite | notes |
|---|---|---|
| `2026-11-07-local-20-2x.json` | 20 local tasks, 2 reps | final stock-vs-graph run after the optional-read/formatting/rename fixes |
| `2026-11-07-local-2x.json` | 6 local tasks, 2 reps | earlier inner-loop run |
| `2026-11-07-installed.json` | 6 local tasks | installed-profile path |
| `2026-11-07-kernel-live.json` | 6 local tasks | first kernel-live run; wall sample has 82–92 s API stalls |
| `2026-11-07-local.json` | 6 local tasks | first single-rep run |

Model: `deepseek-flash` = DeepSeek V4.1-Flash-1017. The official Terminal-Bench 4.0 and
NL2Repo-Bench scores are **not** in this directory; they are gated on Docker/Modal and the DSH
adapters described in [`../../official/README.md`](../../official/README.md).
