# Build progress — DSH `explore` graph loop

Local working repo. Nothing here edits the DSH checkout; it is loaded through
`--patch` (dev) or installed as a bundle (release).

## Status

- [x] Local git repo, npm workspace, TS toolchain, DSH package symlinks (`scripts/link-dsh.sh`)
- [x] Frozen core model: graph-schema / matching / replan / kernel / runtime / conformance (compiles)
- [x] Step graph executor (`packages/core/src/step-graph.ts`) + unit tests
- [x] Forked `agent-loop` (2,122 LOC) with graph turn driver seam
- [x] Registry row (live capability graph from `ctx.tools`, rebuild on `tools/change`)
- [x] Router row (curated template library: investigate / edit-test / research / stock fallback)
- [x] Graph driver row (`AgentLoop` + per-turn `createGraphTurnDriver`)
- [x] `graph_status` tool row
- [x] Dev overlay `packages/loop/dev.patch.yml` (absolute paths, no install)
- [x] **End-to-end**: headless profile + scripted mock LLM, 3 graph nodes (`n_discover → n_read → n_done`), `turn/end completed`
- [ ] Kernel: minimal stepwise + LangGraph adapter (impl-kernel)
- [ ] Core registry builder + template library (impl-core) — current fallback lives in `packages/loop/src/{registry,router}.ts`
- [ ] Bundle A: `explore` preset + policy + `suggest_executor` + spawn guard (bundle-architect)
- [ ] Bundle B: package install + `--dump-config` verification (needs built JS)
- [ ] Conformance suite (16 obligations) + replay diff
- [ ] Token A/B against baseline
- [ ] Docs: README quickstart, architecture, limitations

## Commands

```sh
bash scripts/link-dsh.sh                 # after any npm install
npx tsc -p tsconfig.json --noEmit        # typecheck
node --import tsx --test test/unit/*.test.ts
bash scripts/e2e-headless.sh             # real DSH headless + mock LLM
```

## Known gaps (honest)

- The driver currently injects each node instruction as a logged user message; a later
  iteration should use a scoped prompt section to avoid history growth.
- Tool gating is soft (instruction only); `toolAllow` is not enforced yet.
- Subagent nodes and replan are designed (`design/runtime.ts`, `design/replan.ts`) but not wired.
- The LangGraph adapter is being implemented behind `KernelPort`; the default is the minimal kernel.
- Bundle B still needs a JS build before it can be installed into a profile by package name;
  dev uses absolute `.ts` paths via the overlay.
