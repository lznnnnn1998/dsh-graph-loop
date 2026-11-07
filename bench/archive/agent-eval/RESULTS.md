# Local agent evaluation — result

Status: **product-line run**, 20 tasks × 2 arms × 2 repetitions on the **live envelope/compose**
path. This is the product signal; Terminal-Bench is a separate stress line
([`../../official/README.md`](../../official/README.md)).

- Date: 2026-11-07
- Model: `deepseek-flash` = **DeepSeek V4.1-Flash-1017**, `reasoningEffort: high`
- DSH: local source checkout; stock `agent-loop` vs the graph driver
- Tasks: 20 file/coding tasks ([`tasks.json`](tasks.json)), checks validated to fail on the initial
  fixture and pass on a verified solution
- Raw rows: [`results/2026-11-07-compose-live-20-2x.json`](results/2026-11-07-compose-live-20-2x.json)
- Manifest: [`results/2026-11-07-compose-live-20-2x.manifest.json`](results/2026-11-07-compose-live-20-2x.manifest.json)

**Mean and median are both reported.** Means are sensitive to long-tail API stalls; medians are
robust. A result counts only when the direction holds for both or the difference is explained.

## Live composition result (20 tasks, 2 repetitions)

The scheduler used `selectEnvelopeForTask` + `synthesizeComposition` in dynamic mode; the graph
plan is `inspect → mutate → verify → answer` (no redundant discover/author/deliver node).

| arm | success | steps mean / median | prompt tokens mean / median | wall mean / median |
|---|---|---|---|---|
| stock | 40/40 | 4.2 / 4 | 25,105 / 23,741 | 5.8 s / 5.9 s |
| graph | 40/40 | **4.0 / 4** | **12,561 / 12,201** | 6.3 s / 6.2 s |
| delta | parity | **−4.8% / 0** | **−50.0% / −48.6%** | +9.4% / +4.2% |

- Accuracy parity; steps median parity and mean slightly better.
- Token win holds on both statistics: about **−50% prompt tokens**.
- Wall mean/median slightly worse (+9.4% / +4.2%); do not call wall a win.
- Tool calls: stock 3.7 / 3.5, graph 4.0 / 4.0. Output tokens: stock 352 / 324, graph 497 / 480.

## Legacy dynamic synthesis (pre-composition, history)

The previous run used `synthesizeTopology` and is kept for comparison; it is not the current path.

## Legacy result (20 tasks, 2 repetitions, 40 runs per arm, old path)

| arm | success | steps mean / median | prompt tokens mean / median | wall mean / median |
|---|---|---|---|---|
| stock | 40/40 | 4.1 / 4 | 24,454 / 23,556 | 11.3 s / 9.87 s |
| graph | 40/40 | **4.0 / 4** | **9,612 / 9,538** | 12.0 s / 9.14 s |
| delta | parity | −3.0% / 0 | **−60.7% / −59.5%** | +5.9% / −7.4% |

The graph wins the token and step comparison on both statistics. Wall time is mixed: the mean is
slightly worse, the median slightly better; one graph run took 49 s. Do not call wall a win.

Other metrics:

| | stock mean / median | graph mean / median |
|---|---|---|
| tool calls | 3.6 / 3.0 | 3.5 / 3.0 |
| output tokens | 339 / 325 | 526 / 472 |
| cache-read tokens | 23,590 / 22,780 | 7,984 / 7,936 |

The graph spends fewer prompt tokens but more output tokens (node instructions and per-node
answers). The prompt reduction dominates the billed input.

## Per-task means (2 reps)

| task | stock prompt / steps | graph prompt / steps |
|---|---|---|
| read-summary | 20,385 / 3.5 | 9,564 / 4.0 |
| edit-config | 23,542 / 4.0 | 9,403 / 4.0 |
| fix-test | 30,628 / 5.0 | 9,868 / 4.0 |
| search-file | 20,279 / 3.5 | 9,767 / 4.0 |
| write-answer | 17,348 / 3.0 | 9,415 / 4.0 |
| multi-step | 29,624 / 5.0 | 9,548 / 4.0 |
| rename-file | 17,531 / 3.0 | 9,647 / 4.0 |
| append-log | 23,339 / 4.0 | 9,316 / 4.0 |
| json-filter | 23,557 / 4.0 | 9,500 / 4.0 |
| csv-max | 17,278 / 3.0 | 9,393 / 4.0 |
| multi-file | 24,285 / 4.0 | 10,326 / 4.0 |
| bug-hunt | 27,554 / 4.5 | 10,277 / 4.0 |
| grep-count | 23,434 / 4.0 | 9,534 / 4.0 |
| sort-unique | 29,818 / 5.0 | 9,542 / 4.0 |
| env-config | 23,559 / 4.0 | 9,484 / 4.0 |
| mkdir-nested | 29,837 / 5.0 | 9,231 / 4.0 |
| calc-script | 29,961 / 5.0 | 9,562 / 4.0 |
| replace-all | 23,472 / 4.0 | 9,373 / 4.0 |
| validate-json | 26,718 / 4.5 | 9,488 / 4.0 |
| long-chain | 26,927 / 4.5 | 10,006 / 4.0 |

## What produced the token win

The graph narrows each step's admitted tool set to the plan's tool universe plus a small safe floor.
Stock exposes the full headless tool surface on every step. The prompt-token drop is the
tool-schema/prefix drop, not fewer model calls: the graph has the same or fewer steps (4.0 vs 4.1
mean; both 4 median).

## What is still worse or unproven

- **Wall time is not a reliable win.** The mean is +5.9%, the median −7.4%; the sample includes a
  49 s graph run. Report both, do not cite wall as a win.
- **Output tokens are higher.** The graph pays for node directives and per-node answers; billed input
  still drops because prompt tokens dominate.
- **Accuracy is parity, not better.** All 40 runs passed on this suite; the tasks are too easy to show
  a quality edge. Official benchmarks are required for a public accuracy claim.
- **Small sample.** 20 synthetic tasks, one machine, two reps; not a substitute for Terminal-Bench or
  NL2Repo-Bench.
- **Kernel coverage is partial.** Subagent/conditional plans and reserved node ids use
  `FrontierTopology`; checkpoints are in-memory.

## Earlier 6-task runs (history)

The 6-task inner-loop run (2 reps) measured stock **12/12**, graph **12/12**, median prompt
**23,466 → 9,237 (−61%)**, median steps 4 = 4. The installed-profile run measured 6/6 both arms,
median prompt **26,733 → 9,267 (−65%)**, median steps 5 → 4. Kernel-live 6-task sample: 6/6 both,
median prompt **23,516 → 9,128 (−61%)**, wall dominated by 82–92 s API stalls. Raw files are in
[`results/`](results/).

## Reproduce

```sh
bash bench/agent-eval/run-real.sh --arm both --reps 2
node bench/agent-eval/summarize.mjs bench/agent-eval/results/2026-11-07-local-20-2x.json --per-task
node bench/agent-eval/validate-tasks.mjs
```

Runs land in `/tmp/dsh-agent-eval/<stamp>`; copy `results.json` here to keep a record. The runner
reads the model key from the DSH credential store and never prints it. Use
`--tool-policy preset` to keep the full preset tool set for a benchmark harness:
`bash bench/agent-eval/run-real.sh --arm graph --tool-policy preset --task write-answer`.
