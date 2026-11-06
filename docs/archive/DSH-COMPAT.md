# DSH compat: vitest + coverage in `/tmp/dsh-compat`

This is the closest honest answer to "would the DSH gates accept these packages?" without
modifying the DSH checkout. The harness copies `core` / `loop` / `mode` into `/tmp/dsh-compat`,
ports the `node:test` suite to Vitest, and resolves DSH packages through symlinks into the existing
DSH `node_modules` and workspace.

Run:

```sh
bash compat/run.sh                 # builds /tmp/dsh-compat, runs vitest + coverage
# or
bash compat/setup.sh && cd /tmp/dsh-compat && ./node_modules/.bin/vitest run
```

## Result (2026-11-06)

| Check | Result |
|---|---|
| Vitest v4.1.11, 8 spec files | **73/73 passed** |
| LangGraph adapter | 11 tests ran (not skipped) against `@langchain/langgraph@1.7.0` |
| Coverage provider | v8, DSH-style per-file 100% thresholds |
| Coverage gate | **FAIL** (`exit 1`) |
| Global coverage | statements **46.06%**, branches **42.71%**, functions **45.8%**, lines **47.47%** |
| `core/src` | lines 61.5% |
| `loop/src` | lines 40.61% |
| `loop/src/loop` (fork internals) | **0%** |

Files at 0% lines: `core/src/conformance.ts`, `core/src/replan.ts`, `core/src/runtime.ts`,
`loop/src/registry.ts`, `loop/src/router.ts`, `loop/src/runtime.ts`, `loop/src/tools.ts`,
`loop/src/loop/{agent,inbox,index,runtime-context,assistant-stream,constants}.ts`.

## Why the coverage gate fails

The unit suite exercises the pure core (matching, topology, registry, scheduler, kernels) but does
not boot Cordis services: `index.ts`, `agent.ts`, `inbox.ts`, `tools.ts`, `registry.ts`, and
`runtime.ts` need a real Loader/agent/session composition. The e2e suites do boot them, but Vitest
v8 unit coverage does not observe those subprocess runs, and DSH's coverage gate measures only
`packages/*/*/src` from unit specs.

Reaching DSH's per-file 100% requires real unit-composition tests for the forked loop internals
(agent lifecycle, inbox projection, assistant stream, tool registration, web routes) with mocked
services — or coverage exemptions, which are not appropriate for a published stable package.

## What this does and does not prove

- **Proves**: the code type-checks under the DSH package layout, runs on DSH's Vitest v4 runner,
  resolves DSH packages, and the 73 behavioral unit tests are green there.
- **Does not prove**: the official DSH full-workspace `pnpm test:coverage` gate. That gate also
  scans every DSH package and enforces per-file 100%; this harness scopes include to our packages.
- **Snapshot / benchmark**: not run yet. DSH's snapshot suite needs recorded fixtures and a
  profile adapter; its benchmark lane targets DSH user paths, not this driver.

## Next steps

1. Add Cordis-composition unit tests for `loop/src/loop/*` to move the 0% files (largest gap).
2. Add a recorded-session snapshot scenario for the graph loop (headless + Web) once fixtures exist.
3. Add a benchmark scenario for scheduler overhead (per-turn graph vs stock step) under
   `benchmarks/` only if upstreaming.
