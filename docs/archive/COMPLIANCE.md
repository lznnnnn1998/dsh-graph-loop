# DSH plugin compliance audit

Audit of this out-of-tree project against the DeepSeek Harness rules that apply to external
bundles/plugins. It is deliberately conservative: 「未确认」 and 「偏离」 are listed as gaps, not
hidden behind the green e2e suite.

## Specs read

- root `AGENTS.md` (repo-wide conventions, extension points, model-visible ⟺ logged, config rules)
- `packages/AGENTS.md` (plugin exports, `ctx.get`, effects, capability seams, package READMEs)
- `packages/README.md` (package naming, README contracts, dependency direction)
- `packages/bundle/README.md` (profile bundles, `dsh.bundle.patch`, out-of-tree install)
- `packages/client/modules/README.md` (`dsh.client`, `exports["./client"]`, one active Loader source)
- `packages/client/AGENTS.md` / client authoring rules (shared module baseline, `dsh.client.external`)
- `docs/architecture.md` (loop is replaceable, session event plane, where new behavior goes)
- `docs/testing.md` (real composition, snapshots, coverage gate)

## Status

| Area | Requirement | Status | Evidence / gap |
|---|---|---|---|
| Plugin form | Function plugins export `name`/`inject`/`Config`/`apply`, no default | ✅ | `registry`, `router`, `runtime`, `tools`, `mode`, `graph-ui` |
| Plugin form | Service packages default-export the class | ✅ | `loop` (matches stock `agent-loop`) |
| Service access | Optional services via `ctx.get` | ✅ | `graph-chat`, `tools`, `loop` runtime services |
| Registrations | Contributions go through effects | ✅ | webServer routes, slots, locale, registry, policy sections |
| Loop extension | Do not change stock loop; replace via `AgentFactory` | ✅ | stock `agent-loop` row disabled, forked driver inserted |
| Session plane | Model-visible ⟺ logged | ✅ | node directives are `user/message`; tool calls/results logged |
| Session plane | No new `SessionEventMap` members | ✅ | reuses user/assistant/tool/step/turn events |
| Persistence | No `SESSION_FORMAT_VERSION` change needed | ✅ | no new discriminators |
| Cross-loop | Stock ↔ graph resume | ✅ | `scripts/e2e-cross-loop.sh` both directions |
| Conformance | Event invariants on real logs | ✅ | `scripts/e2e-conformance.sh` |
| Real composition | Product-visible test through Loader/app | ✅ | headless CLI + Web host, only LLM mocked |
| Client package | `dsh.client.platform`, `./client` export | ✅ | `graph-ui`; built `lib/client.js` |
| Client package | One active Loader source per client package | ✅ | one `graph-ui` row owns host + client; fixed after the two-row failure |
| Client copy | Locale-owned UI copy | ✅ | `ctx.locale` dictionaries `en`/`zh`; no hardcoded labels |
| Client build | Built bundle, not source export | ✅ | `client/graph-view.js` copied to `lib/client.js`; export points at `lib` |
| Bundle | `dsh.bundle.patch`, out-of-tree install | ✅ | `loop`, `graph-ui`, `mode`; `install-explore.sh` |
| Package docs | README: purpose/config/extension/Model Experience/limitations | ✅ | all four packages now have one |
| Package naming | Official namespace `@deepseek-ai/dsh-*` | ⚠️ | uses `@dsh/*`; fine for a local prototype, must rename before publishing |
| Package metadata | `engines.dsh`, peer deps, license | ✅ | `engines.dsh`; MIT root license; peer deps declared |
| Config | Deployment-varying values are validated config fields | ⚠️ | `topology` enum, `trivialChars`, `maxSteps`, `traceLimit` now config; scoring weights/templates/`maxReplans` still constants |
| Type safety | No new `as unknown` assertions | ⚠️ | plugin-level casts removed; 9 remain in core JSON boundaries, LangGraph adapter, and the forked inbox (legacy baseline) |
| Error handling | Misconfiguration fails loud | ✅ | missing page asset throws with path; malformed JSON body → 400 |
| Model-facing text | Snapshot/fixture coverage | ❌ | no DSH snapshot harness; e2e asserts structure, not pinned text |
| Tests | Coverage gate / vitest | ❌ | `node:test` only; no per-file 100% coverage |
| Checks | `pnpm lint`, `publint`, `hygiene`, `doc-sync`, `build:check` | ⚠️ | `publint` run on all four packages: `loop`/`mode`/`core` clean, `graph-ui` has the same CJS-interpreted client-bundle warning as official `ui-trajectory`/`ui-chat`; other DSH gates are workspace-scoped and not runnable as-is |
| Client build | tsdown client preset (source map, CSS/assets pipeline) | ⚠️ | hand-authored closure factory; runtime contract verified, build pipeline not |
| Snapshot | Keyless recorded-session snapshot | ❌ | not implemented |
| Naming/i18n docs | Bilingual package docs | ⚠️ | English READMEs only; external workspace, not DSH docs tree |

## Checks actually run

- `publint` on `packages/core`, `packages/loop`, `packages/mode`, `packages/graph-ui` — three clean;
  `graph-ui` warns that `lib/client.js` is CJS-interpreted, which official client packages also warn
  about (same closure-factory envelope). One stale `loop` export was found and removed.
- DSH's own `vitest` suite (sample: `packages/core/agent-loop/tests/contract-regressions.spec.ts`) —
  44/44 passed, proving the harness; it does not include this external package.
- `npx tsc -p tsconfig.json --noEmit` — 0 errors
- `npm test` — 73/73
- 10 e2e: headless dynamic, propose, subagents, replan, installed bundle, graph-chat page, Graph tab
  (Puppeteer), conformance, cross-loop, plus structural A/B
- `node scripts/build-bundles.mjs` — loop + graph-ui + mode artifacts
- `dsh plugin --profile web add ...` / `install-explore.sh` — profile composition
- `dsh --dump-config` — rows, no headless `webServer` warning after moving the Web surface
- `dsh plugin` install of `graph-ui` — one client Loader source, bundle served

## Not run (and why)

- DSH repo gates (`pnpm lint`, `hygiene`, `doc-sync`, `test:coverage`, `test:snapshot`): this project is
  outside the DSH workspace and symlinks DSH packages; the gates do not see these packages.
- Full DSH test suite: not modified, but the fork is not in its workspace.
- Real-model A/B: `DEEPSEEK_API_KEY` is not available in this environment; the harness is ready
  (`AB_REAL=1 bash scripts/ab-structural.sh`).

## Known deviations to fix before publishing

1. Rename `@dsh/*` packages to a publishable namespace and add `publint` to the release script.
2. Replace the hand-written client bundle with the tsdown client preset (source map, CSS/assets,
   locale JSON files).
3. Configure scoring weights/templates/maxReplans instead of constants.
4. Remove the remaining `as unknown` casts at the JSON boundary by validating once and returning typed
   values; keep the forked inbox casts only if they match the stock baseline exactly.
5. Add recorded-session snapshots and a coverage gate for the core package.
