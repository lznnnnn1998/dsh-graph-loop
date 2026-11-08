# Smoke gate — 2026-11-08 (cycle `20261108-1055`)

Command: `OUT=bench/official/results/2026-11-08-smoke bash bench/official/terminal-bench/run-smoke.sh`
(writes only under this directory).

- Task: `smoke/answer-42` (synthetic; create `/app/answer.txt` containing `42`)
- Environment image: `tb-smoke-dsh:arm64` (shared-mode verifier), linux/arm64
- Harbor: 0.25.0
- Repo commit: `fb08b8d`
- Agent model: `deepseek/deepseek-flash`
- Plugin tarball: `dist/dsh-graph-loop-bench.tgz`, sha256 `de483a673e4ee5f0cbb8df3fc2be0c10db95e13b04c7dabd1ceea73b945f2278`

| arm | trial | score | runtime | job dir |
|---|---|---|---|---|
| oracle | 1/1 | **1.0** | 11 s | `jobs/smoke-oracle-192751` |
| graph (`dsh_agent:DshAgent`) | 1/1 | **1.0** | 54 s | `jobs/smoke-graph-192807` |
| stock (`DSH_STOCK=1`) | 1/1 | **1.0** | 20 s | `jobs/smoke-stock-192907` |

**Result: PASS** — oracle, graph and stock all 1.0. Raw `result.json`, `config.json`
and `job.log` per arm are kept in the job dirs above; per-arm stdout in `oracle.log`,
`graph.log`, `stock.log`.

This validates the harness plumbing (image, adapter install, model round-trip,
verifier scoring). It is a synthetic task and says nothing about real product20
task solvability; the real-task oracle control remains
`../2026-11-08-oracle-control/` (3/3 at 1.0).
