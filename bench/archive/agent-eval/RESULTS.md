# Local agent evaluation — result

Status: **archived local pre-signal**, 20 tasks × 2 arms × 2 repetitions on the **live
envelope/compose** path. The active product suite moved to Terminal-Bench easy10 + medium10; this
directory is kept as history. Terminal-Bench is the separate stress line
([`../../official/README.md`](../../official/README.md)).

> **Provenance (post-hoc, 2026-11-07 audit).** The live manifest records `pluginCommit: 388f1f1`,
> but that commit contains no live composition code: `packages/loop/src/scheduler.ts` at 388f1f1
> calls `synthesizeTopology` only and has zero `selectEnvelopeForTask`/`synthesizeComposition`
> calls. The run started `2026-11-07T23:11:22+08:00` and wrote its raw rows at 23:21; the live
> envelope/compose code was committed as `b861a52` at 23:22:21, **after** the run. Both 20-task
> runs therefore executed on **dirty worktrees** (the legacy manifest already recorded
> `"pluginWorktree": "dirty at run time; final code committed after this run"`). Neither is
> reproducible from its recorded commit and neither should be cited as commit-bound evidence. Raw
> result JSON is unchanged; the live manifest now carries a post-hoc `provenanceNote`.

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
- Prompt tokens fall on both statistics: about **−50% prompt tokens**.
- Wall mean/median slightly worse (+9.4% / +4.2%); do not call wall a win.
- Tool calls: stock 3.7 / 3.5, graph 4.0 / 4.0. Output tokens: stock 352 / 324, graph 497 / 480.
- **Cost is not a win:** only prompt tokens fall. Billed input −8.6% and billed total **+16.8%**;
  output tokens +41.2%, which triggers the repo's K3 abandon criterion. See
  [Billed cost](#billed-cost--both-runs-recomputed) below.

## Legacy dynamic synthesis (pre-composition, history)

The previous run used `synthesizeTopology` and is kept for comparison; it is not the current path.

## Legacy result (20 tasks, 2 repetitions, 40 runs per arm, old path)

| arm | success | steps mean / median | prompt tokens mean / median | wall mean / median |
|---|---|---|---|---|
| stock | 40/40 | 4.1 / 4 | 24,454 / 23,556 | 11.3 s / 9.87 s |
| graph | 40/40 | **4.0 / 4** | **9,612 / 9,538** | 12.0 s / 9.14 s |
| delta | parity | −3.0% / 0 | **−60.7% / −59.5%** | +5.9% / −7.4% |

The graph wins the prompt-token and step comparison on both statistics. Wall time is mixed: the
mean is slightly worse, the median slightly better; one graph run took 49 s. Do not call wall a win.

Other metrics (legacy run):

| | stock mean / median | graph mean / median |
|---|---|---|
| tool calls | 3.6 / 3.0 | 3.5 / 3.0 |
| output tokens | 339 / 325 | 526 / 472 |
| cache-read tokens | 23,590 / 22,780 | 7,984 / 7,936 |

The graph spends fewer prompt tokens but more output tokens (node instructions and per-node
answers). **Only prompt tokens fall.** Billed input rises in the legacy run and falls only slightly
in the live run, and billed total rises in both — the earlier claim that "the prompt reduction
dominates the billed input" was wrong. Both runs are recomputed below.

## Billed cost — both runs (recomputed)

`bench/scripts/cost-model.mjs` is the price authority: cache hit $0.003/M, cache miss $0.15/M,
output $0.60/M, i.e. `billedInput = miss + 0.02 × cacheRead` and
`billedTotal = billedInput + 4 × output` (one output token bills as four miss tokens; the script
prints the same 1:50 ratio for `--what break-even`). The raw rows carry `inputTokens` (miss) and
`cacheReadTokens` (hit). `cost-model.mjs --measured` expects the runner's JSONL row shape with
`systemTokens`/`toolSchemaTokens`; these archived rows do not carry those fields, so the same
formulas are applied directly below. Per-run means over 40 runs per arm:

| run | arm | prompt tokens | billed input units | output tokens | billed total units | USD/run |
|---|---|---|---|---|---|---|
| legacy (`synthesizeTopology`) | stock | 24,454 | 1,335.7 | 339.1 | 2,691.9 | 0.00040 |
| legacy (`synthesizeTopology`) | graph | 9,612 | 1,787.6 | 526.3 | 3,892.9 | 0.00058 |
| **legacy delta** | | **−60.7%** | **+33.8%** | **+55.2%** | **+44.6%** | +44.6% |
| live (envelope/compose) | stock | 25,105 | 1,353.5 | 352.0 | 2,761.4 | 0.00041 |
| live (envelope/compose) | graph | 12,561 | 1,237.1 | 497.0 | 3,225.0 | 0.00048 |
| **live delta** | | **−50.0%** | **−8.6%** | **+41.2%** | **+16.8%** | +16.8% |

- **Only prompt tokens fall.** Billed input is not the prompt-token count: fresh (miss-priced) node
  content replaces cheap cache reads, so billed input rises +33.8% in the legacy run and falls only
  −8.6% live. Billed total (input + output) rises +44.6% legacy and +16.8% live.
- **K3 triggers in both runs.** [`research/04-tokens.md:332`](../../../research/04-tokens.md) says
  graph mode that needs **>15% more output tokens** is "paying more model work for the same result;
  abandon". Output rises +55.2% (legacy) and +41.2% (live) while steps do not rise; the output
  condition alone is met on both runs. The prompt-token reduction is a context-size win, not a cost
  win.
- Totals (not per run): legacy billed input 53,429.74 → 71,505.20, live 54,138.86 → 49,484.16;
  legacy billed total 107,677.74 → 155,717.20, live 110,454.86 → 129,000.16.
- These reproduce the 2026-11-07 audit figures at its precision (legacy 1,336 → 1,788 billed input,
  +44.6% billed total, +55% output; live −8.6% billed input, +41% output, +16.8% billed total).
  No discrepancy found.

Recompute the table from the tracked rows (prices/formula copied from
[`bench/scripts/cost-model.mjs`](../../../bench/scripts/cost-model.mjs)):

```sh
node --input-type=module <<'JS'
import { readFileSync } from 'node:fs'
const HIT = 0.003 / 0.15   // cost-model.mjs HIT_RATIO
const OUT = 0.6 / 0.15     // cost-model.mjs OUTPUT_RATIO
const usd = units => units * 0.15 / 1e6
for (const [run, file] of [
  ['legacy', 'bench/archive/agent-eval/results/2026-11-07-local-20-2x.json'],
  ['live', 'bench/archive/agent-eval/results/2026-11-07-compose-live-20-2x.json'],
]) {
  const rows = JSON.parse(readFileSync(file, 'utf8'))
  const perRun = arm => {
    const r = rows.filter(row => row.arm === arm)
    const sum = key => r.reduce((a, row) => a + row[key], 0)
    const billed = sum('inputTokens') + HIT * sum('cacheReadTokens')
    return {
      prompt: sum('promptTokens') / r.length,
      billed: billed / r.length,
      output: sum('outputTokens') / r.length,
      total: (billed + OUT * sum('outputTokens')) / r.length,
    }
  }
  const s = perRun('stock'), g = perRun('graph')
  for (const [arm, x] of [['stock', s], ['graph', g]]) {
    console.log(run, arm, x.prompt.toFixed(0), x.billed.toFixed(1), x.output.toFixed(1),
      x.total.toFixed(1), usd(x.total).toFixed(5))
  }
  const pct = (a, b) => ((b / a - 1) * 100).toFixed(1) + '%'
  console.log(run, 'delta', pct(s.prompt, g.prompt), pct(s.billed, g.billed),
    pct(s.output, g.output), pct(s.total, g.total))
}
JS
```

## Per-task means (legacy run, 2 reps)

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
tool-schema/prefix drop, not fewer model calls: the graph has the same or fewer steps in both runs
(live 4.0 vs 4.2 mean, legacy 4.0 vs 4.1; both 4 median).

## What is still worse or unproven

- **Wall time is not a reliable win.** Live run: +9.4% mean / +4.2% median. Legacy run: +5.9% mean /
  −7.4% median, with one 49 s graph run. Report both, do not cite wall as a win.
- **Output tokens are higher, so the bill is higher.** +55.2% legacy, +41.2% live; billed total
  rises +44.6% / +16.8% and the repo's own K3 abandon criterion triggers on both runs (see the cost
  section).
- **Provenance is not commit-bound.** Both 20-task runs executed on dirty worktrees (see the note at
  the top); usable as measured local data, not as reproducible commit-bound evidence.
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
bash bench/archive/agent-eval/run-real.sh --arm both --reps 2
node bench/archive/agent-eval/summarize.mjs bench/archive/agent-eval/results/2026-11-07-local-20-2x.json --per-task
node bench/archive/agent-eval/validate-tasks.mjs
```

Runs land in `/tmp/dsh-agent-eval/<stamp>`; copy `results.json` here to keep a record. The runner
reads the model key from the DSH credential store and never prints it. Use
`--tool-policy preset` to keep the full preset tool set for a benchmark harness:
`bash bench/archive/agent-eval/run-real.sh --arm graph --tool-policy preset --task write-answer`.
