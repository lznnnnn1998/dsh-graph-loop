# seam-probe — runnable probes against a read-only DSH checkout

Companion to `research/01-seams.md`. Nothing here modifies `/Users/zhinan/deepseek-harness`:
`node_modules/@deepseek-ai/*` are symlinks into the checkout, so the probes import the checkout's
**built** packages (`lib/`) exactly as an installed plugin would.

## Run

```sh
node src/probe-a-tool-gating.ts    # per-step tool + prompt gating on real registries (12 checks)
node src/probe-b-patch.ts          # bundle layer really swaps the agent-loop row (12 checks)
node src/probe-c-live-loop.ts      # a real headless turn on the stock loop (9 checks, no API key)
node /Users/zhinan/deepseek-harness/node_modules/typescript/bin/tsc -p tsconfig.json   # exit 0
```

Node 26 runs the `.ts` files directly (type stripping); every probe exits non-zero on failure.

## Files

| Path | What it is |
|---|---|
| `src/probe-a-tool-gating.ts` | `systemPrompt` + `tools` services, agent scope, `when` gates, `restrict`, `complete:true`, a `@ts-expect-error` proving `PreStepDecision` has no tool field |
| `src/probe-b-patch.ts` | `loadOverlayPatches` + `applyEntryPatches` (the boot/dump-config algorithm) over the real base layer; row surgery, the `name`-is-a-guard finding, migration hazards, `PROFILE_TEMPLATES` check |
| `src/probe-c-live-loop.ts` | real Context + real `AgentLoop`, scripted `LlmAdapter`; one turn, two steps, node-gated tool, per-step prompt, `request/header` + `developer/message` cost |
| `patches/graph-loop.patch.yml` | the bundle layer under test (disable stock row + insert graph row) |
| `plugin/graph-loop-factory.ts` | compile-only `AgentFactory` skeleton — the fork's entry contract, with citations |

## Deliberately not run

- `dsh --profile explore --dump-config`: `prepareProfile` writes `cordis.yml` into `$DSH_HOME`
  (`apps/cli/src/profile-boot.ts:198`), outside this task's write scope; probe B calls the same
  composition functions instead.
- Mounting a real graph `AgentFactory`: needs persistence + a driver; the skeleton is compile-only.
