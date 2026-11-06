# Local agent evaluation — result

Status: **reproducible inner-loop result**, two repetitions for the main run. This is not the
OfficeBench probe ([`docs/EVALUATION.md`](../../docs/EVALUATION.md)); it is the fast before/after
signal.

- Date: 2026-11-07
- Model: `deepseek-official` / `deepseek-flash`, `reasoningEffort: high`
- DSH: local source checkout; stock `agent-loop` vs the graph driver
- Tasks: 6 local file/coding tasks ([`tasks.json`](tasks.json))
- Raw rows: [`results/2026-11-07-local-2x.json`](results/2026-11-07-local-2x.json) (2 reps),
  [`results/2026-11-07-installed.json`](results/2026-11-07-installed.json),
  [`results/2026-11-07-kernel-live.json`](results/2026-11-07-kernel-live.json),
  [`results/2026-11-07-local.json`](results/2026-11-07-local.json)

**Both mean and median are reported.** Means are sensitive to long-tail API stalls; medians are
robust. A result counts only when the direction holds for both, or when the difference is explained
by an identified outlier.

## Result (2 repetitions, 12 runs per arm)

| arm | success | steps mean / median | prompt tokens mean / median | wall mean / median |
|---|---|---|---|---|
| stock | 12/12 | 4.0 / 4 | 23,723 / 23,466 | 16.3 s / 14.9 s |
| graph | 12/12 | 4.0 / 4 | **9,352 / 9,237** | 21.8 s / 14.8 s |
| delta | parity | 0 / 0 | **−60.6% / −60.6%** | +34% / −0.7% |

Per-task **means** across the two repetitions:

| task | stock prompt / steps | graph prompt / steps |
|---|---|---|
| read-summary | 26,626 / 4.5 | 9,515 / 4.0 |
| edit-config | 26,707 / 4.5 | 9,235 / 4.0 |
| fix-test | 30,864 / 5.0 | 9,816 / 4.0 |
| search-file | 20,258 / 3.5 | 9,312 / 4.0 |
| write-answer | 11,364 / 2.0 | 9,073 / 4.0 |
| multi-step | 26,523 / 4.5 | 9,162 / 4.0 |

The token win holds for both statistics. The wall-time mean is inflated by one graph run at 87 s;
the medians are effectively tied.

## Installed-bundle confirmation (1 repetition, 6 tasks)

A throwaway DSH home with a stock `headless` profile and the installed graph profile
(no `--patch`, no DSH source changes):

| arm | success | steps mean / median | prompt mean / median | wall mean / median |
|---|---|---|---|---|
| stock `headless` | 6/6 | 4.5 / 4.5 | 26,986 / 26,733 | 19.2 s / 15.6 s |
| graph `explore` (installed) | 6/6 | **4.0 / 4.0** | **9,349 / 9,267** | 24.1 s / 17.9 s |
| delta | parity | **−0.5 / −0.5 step** | **−65.4% / −65.3%** | +25.6% / +14.8% |

Raw rows: [`results/2026-11-07-installed.json`](results/2026-11-07-installed.json).

Wall time is again outlier-sensitive (one graph run at 45 s); tokens and steps reproduce.

## Kernel-live confirmation (1 repetition, 6 tasks)

The live scheduler runs kernel-drivable plans through `KernelTopology` (LangGraph default,
`MinimalKernel` fallback); the frontier is reserved for subagent/conditional plans and unsafe node
ids.

| arm | success | steps mean / median | prompt mean / median | wall mean / median |
|---|---|---|---|---|
| stock | 6/6 | 4.3 / 4.0 | 25,865 / 23,516 | 5.8 s / 5.6 s |
| graph (kernel-live) | 6/6 | **4.0 / 4.0** | **9,265 / 9,128** | 47.3 s / 46.0 s |

Raw rows: [`results/2026-11-07-kernel-live.json`](results/2026-11-07-kernel-live.json).

**Do not cite wall time from this sample.** Three graph runs stalled 82–92 s inside a single model
call (API/queue latency), while the same tasks completed in 6–8 s on other runs. Tokens and steps
reproduce; the wall mean and median are both dominated by those stalls.

## What produced the token win

The graph narrows each step's admitted tool set to the plan's tool universe plus a small safe floor
(`read`, `glob`, `grep`, `write`, `edit`, `bash`, `present`). Stock exposes the full headless tool
surface on every step. The prompt-token drop is the tool-schema/prefix drop, not fewer model calls:
the mean and median step counts are identical (4.0 / 4).

## What is still worse or unproven

- **Wall time is not a reliable win.** Means are inflated by API stalls; medians are parity in the
  2-rep run and worse where stalls dominate. Output tokens remain higher on several tasks.
- **Accuracy is parity, not better.** All runs passed; these tasks are too easy to show a quality
  edge. The public claim still requires OfficeBench and the three-arm protocol.
- **Small sample.** Six synthetic local tasks, one machine; only the main run has two repetitions.
- **Kernel coverage is partial.** Plans with subagent nodes, conditional/failure edges or unsafe node
  ids still use `FrontierTopology`; checkpoints are in-memory, not `storageDomain`.

## Reproduce

```sh
bash bench/agent-eval/run-real.sh --arm both --reps 2
node bench/agent-eval/summarize.mjs results/<file>.json --per-task
```

Runs land in `/tmp/dsh-agent-eval/<stamp>`; copy `results.json` here to keep a record. The runner
reads the model key from the DSH credential store and never prints it.
