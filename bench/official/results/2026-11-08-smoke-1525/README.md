# Smoke gate — cycle `20261108-1525` (HEAD `f28de84`)

Fresh evaluator pass. Commit `f28de848b2c728272a8c7395e71b0987b15d7918`, working tree clean
(only new untracked evidence directories). Task `smoke/answer-42`, image `tb-smoke-dsh:arm64`
(shared verifier), model `deepseek/deepseek-flash`, agent `dsh_agent:DshAgent`.

> **Post-eval note.** A later commit `63b5f20` changes `verificationRan`; it was not part of this
> smoke, and `dist/dsh-graph-loop-bench.tgz` has not been repacked. This PASS is evidence for the
> `f28de84` tarball only, not for `63b5f20`.

## Tarball used

`dist/dsh-graph-loop-bench.tgz` — **223,372 B**, sha256
`4893f9344a1bbb62f1aaa7777f488c5e919cd9217ed6b1512fee1ea046f20749`. Repacked after `f28de84`
and not modified by this run. Extracted, `package/lib/index.js`, `scheduler.js` and
`kernel/index.js` are **code-identical** to the fresh `npm run build` output at `f28de84` after
stripping the 223/7 esbuild `//` entry-comment lines (same sha256 on the filtered bytes). It
contains the new `verificationRan` fact and the frontier barrier symbols (`entered`, `detached`,
`joinBlocked`, `pendingReaches`). `run-smoke.sh` defaults `DSH_PLUGIN_TARBALL` to this file and
no override was set, so the shipped tarball was the one installed into the task container.

## Command

```bash
OUT="$PWD/bench/official/results/2026-11-08-smoke-1525" \
bash bench/official/terminal-bench/run-smoke.sh
```

## Result — PASS

| arm | score | reward | runtime | job dir |
|---|---|---|---|---|
| oracle | **1.0** | 1 | ~0.2 s | `jobs/smoke-oracle-235557` |
| graph (`dsh_agent:DshAgent`) | **1.0** | 1 | 14 s | `jobs/smoke-graph-235612` |
| stock (`DSH_STOCK=1`) | **1.0** | 1 | ~4 s | `jobs/smoke-stock-235655` |

`PASS smoke: oracle, graph and stock all 1.0` (script exit 0). Raw `result.json`, `config.json`,
`job.log` and trial dirs are kept under `jobs/`.

## The graph arm exercised the new classifiers, not just a happy path

The graph trial's session (`jobs/smoke-graph-235612/smoke-task__Fcbd7XQ/agent/dsh-sessions/`,
decompressed) records this live node order:

```
n_inspect (write) -> n_inspect_repair (read)
-> n_inspect (final text, no tool) -> n_inspect_repair (read)
-> n_inspect (glob) -> n_mutate (write) -> n_verify (bash) -> n_answer
```

- `n_inspect` repaired **twice**: its step wrote the answer file on the first attempt (no
  `readFile`) and answered with no tool on the second (no `readFile`). It advanced only after a
  `glob`, which the reducer counts as a read. This is the new exclusive no-progress classifier
  (P1-4/P1-2) firing in the live adapter path.
- `n_mutate` advanced on `write` (`wroteFile`), `n_verify` advanced on a `bash` `od` check
  (`verificationRan=true`, no `[exit code: N]` failure), then `n_answer`.
- 8 graph steps, 6 tool calls, score 1.0. The previous smoke at `823aa68` could not have shown
  `n_inspect_repair` for this step because inspect had no failure guard then; its presence proves
  the `f28de84` code (not stale `lib/`) was installed.

## Join barrier

The smoke composition is linear (`inspect -> mutate -> verify -> answer`), so the smoke does not
exercise a fan-out join. Join ordering was checked separately:

- 66/66 transition-matrix rows, including depth-2/depth-3 diamonds, inverted declaration order,
  join-in-cycle and fan-out-with-retry (17 rows each on frontier/minimal/langgraph).
- A probe run against the **built bundle** (`packages/loop/lib/index.js`, byte-for-byte the
  tarball code) walked four legal frontier plans:
  - deep diamond: `a,b,c,c2,d` (join last, once);
  - inverted join: `a,b,d,c`;
  - join in a cycle: `a,b,c,c2,d,e,a,b,c,c2,d,e` (join once per iteration);
  - fan-out with retried branch: `entry,a,b,a,join,answer` (join once, after retry).

This is a synthetic plumbing task: it validates image, adapter install, tarball, model round-trip
and verifier scoring. It says nothing about product20 solvability.
