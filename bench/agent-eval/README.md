# Local agent evaluation harness

Fast inner-loop comparison of the stock DSH loop and the graph driver. This is **not** the
Terminal-Bench subset — it exists to tell us whether a change moves success, steps, tokens or wall time
before paying for a public benchmark.

- Protocol and public evaluation: [`docs/EVALUATION.md`](../../docs/EVALUATION.md)
- Latest result: [`RESULTS.md`](RESULTS.md)
- Raw rows: [`results/`](results/) (what each file is: [`results/README.md`](results/README.md))

## What it runs

Twenty small file/coding tasks (`tasks.json`, fixtures under `tasks/`), each with a shell check.
Every check was validated twice: it fails on the initial fixture and passes on a verified solution.

| category | examples |
|---|---|
| read / write / search | `read-summary`, `search-file`, `grep-count` |
| edit / repair | `edit-config`, `validate-json`, `replace-all` |
| multi-file | `multi-file`, `long-chain`, `rename-file` |
| data processing | `json-filter`, `csv-max`, `sort-unique` |
| script authoring | `calc-script`, `bug-hunt` |
| environment / paths | `env-config`, `mkdir-nested` |
| multi-step | `multi-step`, `append-log` |
| arithmetic | `write-answer` |

Each run measures: task success, steps, tool calls, input/output/cache/prompt tokens (from
`assistant/message` usage in the session log), and end-to-end wall time.

Before running, check the negative case:

```sh
node bench/agent-eval/validate-tasks.mjs
```

## Run with the real model

```sh
# Reads DEEPSEEK_API_KEY from the DSH credential store; never prints it.
bash bench/agent-eval/run-real.sh --arm both --reps 2
# benchmark compatibility: keep the full preset tool set
bash bench/agent-eval/run-real.sh --arm graph --tool-policy preset --task write-answer
```

Results land in `/tmp/dsh-agent-eval/<stamp>/results.json`.

## Run against the installed bundle

This is the installable-plugin path: a throwaway DSH home gets a stock `headless` profile and an
`explore` profile with `dsh plugin add packages/loop`; no DSH source is modified.

```sh
bash bench/agent-eval/prepare-installed.sh /tmp/dsh-agent-eval/installed-home
bash bench/agent-eval/run-real.sh --installed --home /tmp/dsh-agent-eval/installed-home --arm both
```

`--installed` omits the dev `--patch`; the graph arm boots the profile that has the bundle installed.

## Notes

- The harness runs the DSH CLI through `cli-wrapper.mjs` so module resolution uses the DSH checkout
  while the agent's file tools use the task workspace. This is test tooling only; the plugin itself
  is loaded by the profile.
- Do not treat one run as a measurement. Use repetitions and read **both the mean and the median**;
  wall time in particular is noisy. `summarize.mjs <results.json> --per-task` prints both for every
  metric.
