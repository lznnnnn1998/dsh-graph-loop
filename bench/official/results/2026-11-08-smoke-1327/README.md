# Smoke gate — cycle `20261108-1327` (HEAD `823aa68`)

Fresh evaluator pass. Repo commit `823aa68` (`git rev-parse HEAD`), working tree clean.
Task: `smoke/answer-42` (synthetic; create `/app/answer.txt` containing exactly `42\n`).
Image: `tb-smoke-dsh:arm64` (shared-mode verifier), linux/arm64. Harbor 0.25.0.
Model: `deepseek/deepseek-flash`. Agent: `dsh_agent:DshAgent` (DSH `0.2.2-rc.1`, adapter pin).

## Plugin tarball used

`dist/dsh-graph-loop-bench.tgz` is **stale** for this commit: packed 11:00 (+08), 213,558 B,
sha256 `de483a67…`, its `lib/index.js` is 787,300 B while the current build is 798,959 B.
Running the default would have exercised pre-increment code, so this smoke used a fresh pack of
`packages/loop` at `823aa68`:

- `/tmp/dsh-bench-tarball/dsh-graph-loop-0.2.0.tgz`, 220,087 B,
  sha256 `499d89acb96471b4d8425e0cb8048a02abc5ec3df1b9a1f7b970e44f075487ff`
- packed after `bash scripts/ci-local.sh` rebuilt `lib/`; `package/lib/index.js` is code-identical
  to `packages/loop/lib/index.js`; esbuild entry comments differ cosmetically because `npm pack`
  rebuilds with package-relative paths. The smoke passed on exactly this tarball sha.
- `DSH_PLUGIN_TARBALL` was exported to the run; `run-smoke.sh` uses it in preference to
  `dist/`. No repo write outside this directory.

## Command

```bash
OUT="$PWD/bench/official/results/2026-11-08-smoke-1327" \
DSH_PLUGIN_TARBALL=/tmp/dsh-bench-tarball/dsh-graph-loop-0.2.0.tgz \
bash bench/official/terminal-bench/run-smoke.sh
```

## Result — PASS

| arm | score | runtime | job dir |
|---|---|---|---|
| oracle | **1.0** | 11 s | `jobs/smoke-oracle-221612` |
| graph (`dsh_agent:DshAgent`) | **1.0** | 1 m 22 s | `jobs/smoke-graph-221628` |
| stock (`DSH_STOCK=1`) | **1.0** | 20 s | `jobs/smoke-stock-221755` |

`PASS smoke: oracle, graph and stock all 1.0` (script exit 0). `verifier/reward.txt` is `1` for
each trial; raw `result.json`, `config.json`, `job.log` and the trial dirs are kept under
`jobs/`.

The graph arm's `smoke-task__9SZJ8mn/agent/dsh-stdout.log` shows the composed pipeline executing
live: an inspect node ("read relevant material"), a mutate node (bench-retry correction fired once
before the write), a verify node ("node specifically verify", shell `cmp` exit 0 → no repair) and
the answer. It scored 1.0, so the current composer/verify/step-fact code did not break the live
path.

This is a synthetic plumbing task: it validates image, adapter install, model round-trip and
verifier scoring. It says nothing about product20 solvability; the real-task validity baseline
remains `../2026-11-08-oracle-control/` (3/3 at 1.0).
