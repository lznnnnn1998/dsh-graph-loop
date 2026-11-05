# 05 — Bundle / profile packaging: shipping `explore` without touching DSH source

Status: research/05 · author: bundle-architect · DSH `0.2.1-rc.3` @ `22ddee3792`
Legend: **MEASURED** = a command was run and its output is quoted; **ESTIMATE** = arithmetic
or judgement, flagged as such. Every DSH claim cites `path/to/file:LINE`.

---

## 0. Verdict

`explore` is shippable today as **two independent, out-of-tree bundles** plus one
developer overlay. No DSH source edit, no fork, no install into the checkout.

| unit | what it is | where it is installed | changes the loop? |
|---|---|---|---|
| **A** `bundle/a-preset` → `@dsh/explore-mode` | host-level graph kernel rows + one `@deepseek-ai/dsh-agent-preset` row = a **fifth mode** | the **existing `web` profile** | no |
| **B** `bundle/b-loop` → `@dsh/explore-loop` | disables the stock loop row and mounts a graph `AgentFactory` | a **dedicated `explore` profile** | yes |
| dev | `bundle/dev/overlay.patch.yml` | `--patch` on any base-backed profile | yes (dev only) |

Three outcomes worth stating up front:

1. **The "mode" part needs no profile fork at all.** A preset *is* a mode
   (`packages/bundle/web-app/presets/*.patch.yml` insert one `@deepseek-ai/dsh-agent-preset`
   row each), and any bundle may insert one more. So A installs into the profile the user
   already runs, and sessions/workspace/settings are shared by construction.
2. **The loop replacement cannot be a preset** — the host owns one loop
   (`packages/preset/agent-preset-registry/README.md:56`; `packages/core/agent/src/index.ts:383-392`).
   It is a *profile* concern, so B needs a profile of its own.
3. **A patch cannot repoint a row by name.** `name` on a patch entry is a guard
   (`vendor/include/src/index.ts:115-117`), so "replace the loop" = **disable + insert**,
   never "rename in place". This is the single most important packaging fact here.

MEASURED, on a throwaway home, `--dump-config` row counts for a profile created from the
shipped `web` template: 195 rows → **199** with A → 195 after `remove` → **200** with B, and
the stock row appears as `disabled: true` under a layer labelled
`# == @deepseek-ai/dsh-base, patched by @dsh/explore-loop` (`bundle/verify/verify.sh`).

---

## 1. The composition model this packaging rides on

```
$DSH_HOME/
  profiles/<name>/            one runnable composition   (packages/boot/app-boot/src/profile.ts:5,38)
    package.json              { dsh.profile.bundles: [bundle, …], dependencies }
    cordis.patch.yml          the user's own layer (applied last)
  sessions/                   SHARED by every profile     (packages/bundle/base/cordis.patch.yml:141)
  storages/                   SHARED (projection cache)   (packages/bundle/base/cordis.patch.yml:185)
```

- A **profile** = ordered bundle layers + user patch (`docs/user/develop/basic/publish.md`,
  "The loading order"): bundles in list order → profile patch → `$DSH_HOME/cordis.patch.yml`
  → `--patch` overlays. Later layers win per row, and a patched row's whole `config` is
  replaced rather than merged.
- A **bundle** = an npm package with `dsh.bundle.patch: "./cordis.patch.yml"`
  (`packages/util/package-manifest/src/types.ts:71-79`), installed into a profile with
  `dsh plugin --profile <p> add <pkg>`, which pnpm-links it and appends it to
  `dsh.profile.bundles`.
- A **surface** (`web`, `headless`, `acp`, `sdk`) is a *shipped profile template*
  (`packages/util/official-bundles/src/bundles.ts:10-26`). There is no `explore` template,
  and adding one is a source change (§11).
- A **mode** is an agent preset row (`packages/bundle/web-app/presets/standard.patch.yml:4-16`),
  scoped per session, with its own tool list and prompt sections. The host shares one loop.
- The **loop** is a host row: `- id: agent-loop` / `name: '@deepseek-ai/dsh-agent-loop'`
  (`packages/bundle/base/cordis.patch.yml:513`). It registers the sole `AgentFactory`
  (`packages/core/agent-loop/src/index.ts:291,336`).

Consequences for packaging:

| goal | mechanism | allowed? |
|---|---|---|
| add a mode | insert an `@deepseek-ai/dsh-agent-preset` row from a bundle | ✅ first-class (`packages/preset/agent-preset-registry/README.md:48`: *"A new preset … is a bundle patch: an `insert` … installed into the profile"*) |
| change the driver | disable `agent-loop`, insert a factory plugin | ✅ config composition |
| rename/repoint `agent-loop` | `- {id: agent-loop, name: '<other>'}` | ❌ skipped with a warning (`vendor/include/src/index.ts:115-117`) |
| register a second factory beside the stock one | `ctx.agents.setFactory` | ❌ throws (`packages/core/agent/src/index.ts:383-392`) |
| provide a graph service from *inside* a preset | preset child row | ❌ activation audit rejects globally leaked services (`packages/preset/agent-preset-registry/README.md:56-60`) |
| ship `explore` as a first-class template | `PROFILE_TEMPLATES` | ❌ literal (`bundles.ts:10-26`) |

That last but one row shaped Bundle A: the kernel rows are **host** rows; the preset only
*consumes* them (a row waiting for a Host service stays mounted —
`packages/preset/agent-preset-registry/README.md:56-60`).

---

## 2. Bundle A — `@dsh/explore-mode` (the mode)

Files: `bundle/a-preset/{package.json,cordis.patch.yml,src/*.js}`.

`cordis.patch.yml` inserts four rows:

| row id | row name | scope | purpose |
|---|---|---|---|
| `graph-registry` | `@dsh/explore-mode/registry` | host | live capability graph; provides `ctx.graphRegistry` |
| `graph-router` | `@dsh/explore-mode/router` | host | task signature → template → top-1, with fallback |
| `graph-runtime` | `@dsh/explore-mode/runtime` | host | node execution, replan, budget; `mode: off\|observe\|shadow\|active` |
| `preset-explore` | `@deepseek-ai/dsh-agent-preset` | registry | the fifth mode; children `explore-policy`, `explore-tools`, then the stock tool list |

Why the kernel is host-scoped: a preset declaration "eagerly creates a registry-owned
scope" and the activation audit rejects **globally leaked services**
(`packages/preset/agent-preset-registry/README.md:56-60`). A service *provider* inside a
preset would be a leak; a service *consumer* is normal (that is exactly how
`dsh-compaction-basic` works inside the shipped `standard` preset).

Why the preset child ids are copied verbatim from `standard`
(`packages/bundle/web-app/presets/standard.patch.yml`): the Web preset editor overrides
`config.plugins` **by id**, so keeping `persona`, `planning`, `compaction`, `delegation`, …
identical means a user override written for standard still applies to explore, and the
diff between modes stays reviewable.

What A can and cannot do:

- ✅ per-step guidance through `agent/pre-step` (messages only — the tool set is resolved
  before that waterfall: `packages/core/agent/src/runtime-types.ts:350`), developer
  messages, `agent/turn-stopping` steering, model selection per node, subagent fan-out
  with per-child presets (`packages/subagent/subagent/src/child-agent.ts:142-200`).
- ✅ session-level capability envelope: the preset's tool list *is* the envelope, and a
  stable envelope is the only token saving that does not fight the prefix cache
  (`packages/core/agent-loop/README.md#model-experience`).
- ⚠️ tool gating *between steps* is limited to `ctx.tools.restrict()` masks, which can only
  narrow and lift — a plugin cannot add `when` to another package's tool registration
  (`packages/core/tools/README.md:88`). Expect cache misses when the visible set
  changes mid-session.
- ❌ no true context isolation (history keeps growing), no parallel nodes, no durable graph
  state beyond `plugin:*` ignorable records (external plugins "must not" use
  `appendPluginRecord`).

## 3. Bundle B — `@dsh/explore-loop` (the driver)

Files: `bundle/b-loop/{package.json,cordis.patch.yml,src/*.js}`.

```yaml
- id: agent-loop                       # the only row patched in the whole composition
  name: '@deepseek-ai/dsh-agent-loop'  # guard: fails soft if upstream renames the owner
  disabled: true
- insert: [graph-registry, graph-router, graph-runtime, graph-loop, graph-tools]
```

The new driver must reproduce, exactly, what the stock one does. The contract is public and
finite:

| contract surface | source |
|---|---|
| `createAgent(ownerCtx, options)` / `resume(ownerCtx, options)` → `AgentHandle` | `packages/core/agent/src/index.ts:175-210` |
| `Agent`: `options, session, model, inbox, status, ctx, cancel, whenIdle, runMaintenance, send, followup, steer, inject` | `packages/core/agent/src/runtime-types.ts:191-269` |
| factory registration inside the construction effect; exclusive | `packages/core/agent-loop/src/index.ts:336`; `packages/core/agent/src/index.ts:383-392` |
| prerequisite services `agents, sessions, llm, tools, systemPrompt, sessionProjections` | `packages/core/agent-loop/src/index.ts:293` |
| register the `inbox` + `modelSelection` session projections for the service lifetime | `packages/core/agent-loop/src/index.ts:334-335` |
| live events `agent/created, agent/disposed, agent/status, agent/inbox/{inserted,claimed,discarded}, agent/pre-step, agent/request-error, agent/assistant-stream, agent/turn-stopping, agent/error` | `packages/core/agent/src/runtime-types.ts:290-420` |
| durable events the projections/UI fold (`turn/start … turn/end`, `request/header`, `request/context`, `system/message`, `developer/message`, `tool/call`, `tool/result`, `assistant/message`, `assistant/attempt`) | `packages/core/session/src/known-event-types.ts:22-80` |
| session write-handle choreography (`persistence.create` before publication, `open(id,'write')` on resume, repair closers, flush, close) | `packages/core/agent-loop/README.md#persistence-integration` |
| turn-boundary projection is **not** the loop's: `core/agent` owns it | `packages/core/agent/src/index.ts:298` |

Not the loop's job, and correctly left alone: `core/tools` (registry/executor),
`core/system-prompt`, `core/session`, `core/agent` (registry + projections), persistence,
compaction, plan-mode, goal, subagents, workflow, team, UI.

Row-order note: inserted rows land at the end of the composed list (`--dump-config`), so the
new `graph-loop` row activates *after* its kernel rows are requested — harmless when it
declares them in `inject` ("a row waiting for a service stays mounted",
`packages/boot/app-boot/README.md:94`). A release could also inline the kernel in the loop
package and skip the ordering question entirely.

Install rule: **A or B, never both in one profile** — both insert the same kernel row ids,
and the Loader keys entries by id (`vendor/loader/src/config/tree.ts:51-73`). `verify.sh`
asserts row-id uniqueness.

---

## 4. Exact install / upgrade / uninstall

`dsh` below means `pnpm dsh` in the checkout (`"dsh": "node --import tsx/esm apps/cli/src/bin.ts"`,
`package.json`) or the installed `dsh` binary.

### 4.1 A into the current profile (mode only)

```sh
# package it (one-time, from this workspace)
cd /Users/zhinan/Documents/dsh_workspace/dsh-graph-loop

# install into the profile the Web UI already runs
pnpm dsh plugin --profile web add /Users/zhinan/Documents/dsh_workspace/dsh-graph-loop/bundle/a-preset

# prove the layer before booting
pnpm dsh --profile web --dump-config \
  | grep -nE "id: (preset-explore|graph-registry|graph-router|graph-runtime)" -A4

# restart the server; the new-session chip lists “Explore (graph)”
pnpm dsh --profile web
```

Uninstall: `pnpm dsh plugin --profile web remove @dsh/explore-mode` (verified to restore the
composition exactly — `verify.sh` step 3).

### 4.2 B into a dedicated profile (driver)

```sh
pnpm dsh --profile explore --from-default-profile web --dump-config >/dev/null   # create
pnpm dsh plugin --profile explore add /Users/zhinan/Documents/dsh_workspace/dsh-graph-loop/bundle/b-loop                    # install
pnpm dsh --profile explore --dump-config | grep -nE "id: (agent-loop|graph-loop)" -A4
pnpm dsh --profile explore --no-open --port 3081
```

Upgrade: `remove` then `add` (or `add @dsh/explore-loop@<version>` from npm). Never re-run
`--from-default-profile explore` after installing — it deletes the profile directory,
including dependencies, `node_modules`, and the user patch
(`docs/upgrade-guide/v0.2.1-alpha.2/from-default-profile-replaces-target/guide.md`).

### 4.3 What the profile manifest looks like afterwards (MEASURED)

```json
{
  "name": "dsh-profile-explore",
  "private": true,
  "dsh": { "profile": { "bundles": ["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-web-app", "@dsh/explore-loop"] } },
  "dependencies": { "@dsh/explore-loop": "link:/…/bundle/b-loop" }
}
```

The user layer `cordis.patch.yml` stays `[]`; nothing else in `$DSH_HOME` is touched.

### 4.4 Manifest rules that actually bite

- `dsh.bundle.patch` is one path or an **ordered list**; the launcher applies them as one
  layer (`packages/boot/app-boot/README.md:50`). Web-app uses the list form to append its
  preset layers.
- `engines.dsh: "^0.2.1-rc.3"` — same shape as an already-working out-of-tree plugin on this
  machine (`~/.dsh/profiles/web/node_modules/dsh-artcraft-plugin-cadcraft/package.json`).
  Declaring `engines.dsh` **disables** the peer-range compatibility check
  (`packages/boot/app-boot/README.md:52`), so peers are about module identity only.
- Every `@deepseek-ai/*` import must be a declared **peer** (`docs/user/develop/basic/publish.md`,
  "resolution rules": peers resolve against the running installation's runtime resolution;
  a bare import resolves from the linked package's own `node_modules`). Mark them
  `optional: true` so `pnpm add` does not try to fetch `@deepseek-ai/*` from npm — the
  installed ArtCraft packages do exactly this.
- `dsh.bundle.listedByDefault: false` keeps the bundle out of GUI lists until it is enabled
  (`packages/util/package-manifest/src/types.ts:71-79`).
- A bundle that also wants a browser half declares `dsh.client` + a prebuilt `./client`
  export (`packages/client/modules/README.md:34,57`); `dsh-artcraft-preview-panel` is the
  working out-of-tree precedent.

### 4.5 Verification is composition-only, by design

`--dump-config` "shows the layer without booting" and is the documented pre-flight
(`docs/user/develop/basic/publish.md`; `docs/cli-help.md:43`). `bundle/verify/verify.sh`
automates it and additionally asserts: no duplicate top-level row ids, the stock loop
disabled, the graph driver enabled, and a clean uninstall.

---

## 5. Sessions, persistence, and cross-profile compatibility

Facts (all MEASURED or code-cited):

1. **Profiles are partitions of configuration, not of data.** Sessions live under the shared
   home: `root: !!js dshHomePath('sessions')` (`packages/bundle/base/cordis.patch.yml:141`),
   and `dshHomePath` joins the single resolved home (`packages/util/home-paths/src/index.ts:160`;
   `resolveDshHome` = configured → `$DSH_HOME` → `~/.dsh`). On this machine
   `~/.dsh/sessions/` holds one directory per normalized cwd for **both** installed
   surfaces, while profile configuration lives under `~/.dsh/profiles/web`.
2. The projection cache and attachments are shared too: `dshHomePath('storages')`
   (base:185), `attachment-local` under the same home (base:146).
3. The session log records which preset it ran, and a resumed session keeps that
   composition: "recovery after restart uses the current definition of that ID and rejects a
   missing definition" (`packages/preset/agent-preset-registry/README.md`); the rejection is
   `RemoteError('agent-preset/not-found', 'Unknown agent preset: …')`
   (`packages/preset/agent-preset-registry/src/index.ts:252`). A child agent mounts its
   preset the same way (`packages/subagent/subagent/src/child-agent.ts:191-200`).

Therefore:

| question | answer |
|---|---|
| Can the `explore` **profile** list sessions created by the `web` profile? | **Yes** — same `$DSH_HOME/sessions`, same cwd bucketing, same format version (same DSH build). MEASURED layout; listing is a filesystem+format read through `ctx.sessionPersistence`. |
| Can it **resume** them? | Yes for sessions whose recorded preset id exists in that profile. All four shipped ids exist in both (`web-app` provides them), so a stock session resumes under either profile. |
| Can a session created under `preset-explore` be resumed in a profile **without** bundle A? | **No** — `agent-preset/not-found`. This is the trap of installing A only into the fork. Installing A into the **same** profile (recommended) removes the problem. |
| Can a session created by B (graph loop) be resumed by the stock loop? | Only if B emitted the same durable events. The log is the interface, so any deviation is a one-way door; treat B as profile-locked until the conformance suite passes. |
| Do forks of a session work? | Subject to the same preset rule; `session/fork` copies events, and the preset projection follows (`packages/preset/agent-preset-registry/src/session.ts`). |
| What about `$DSH_HOME` differences? | Sessions are per home. Two different homes (e.g. this session's `bench/.dsh-home`) are two separate session stores. |

Operational guidance: keep A in `web` and B in `explore`; if a user needs to come back,
`pnpm dsh --profile web` opens the same sessions they left.

---

## 6. Settings card and Web UI blast radius

The card is `packages/client/ui-settings-agent-loop`. Its mechanics (code-cited):

- The page renders `whileServed(['agent-loop'], …)`, i.e. **only while the Host serves a
  settings namespace named `agent-loop`** (`src/client/index.ts:47`; `AGENT_LOOP_NS` at
  `src/client/agent-loop-card-controller.ts:13`).
- Settings namespaces are **profile entry ids whose plugin declares volatile fields**
  (`packages/settings/settings/src/index.ts:302-330`, `ns: entry.options.id`). The stock
  loop row id is `agent-loop`, and its only volatile field is `maxParallelToolCalls`
  (`packages/core/agent-loop/src/index.ts:258,296`).
- The card edits exactly one field (`maxParallelToolCalls`,
  `agent-loop-card-controller.ts:21-48`).

So:

| situation | result |
|---|---|
| A installed (stock loop untouched) | card unchanged, still works |
| B with row id `graph-loop` | namespace `agent-loop` disappears → **card disappears cleanly** (no error, no orphan UI) |
| B keeping row id `agent-loop` for the new plugin | card would keep rendering, but two rows with one id is ambiguous to id-addressed patches (`vendor/loader/src/config/tree.ts:51-73`) — rejected |
| B with `maxParallelToolCalls` on another namespace | field exists, no shipped card reads it → invisible until a card ships |

→ **No source change is needed for the settings card.** A graph settings page is an
out-of-tree **client** plugin (namespace `graph-loop`, `plugins.item` slot), which is the
same shape already installed on this machine: `dsh-artcraft-preview-panel` declares
`dsh.client { platform: 'web' }`, exports `./client` → a prebuilt `lib/client.js`
(`packages/client/modules/README.md:34`). ESTIMATE ~350 LOC + a build script. Until then,
graph knobs are profile YAML — which is the documented means anyway.

Other Web-surface checks: the mode chip label for a non-shipped preset is the preset's own
`name`, else its id (`packages/preset/agent-preset-registry/src/display.ts:60-77`), so
`name: Explore (graph)` displays without a locale change. The live chat path consumes
`agent/assistant-stream`, `agent/status`, and `session/event`
(`packages/api/session-controller/src/index.ts`), which is why §3's event list is
non-negotiable.

---

## 7. Inventory — what a loop replacement drags in

Categories: **REPLACE** = fork/rewrite; **KEEP-CONTRACT** = unchanged but depends on the
loop's event/persistence contract (it breaks silently if the contract slips);
**REUSE** = unchanged, no loop coupling; **RETIRE** = left dark or absorbed.
LOC = `src/**/*.ts` line count (MEASURED with `find … | xargs wc -l`), tests counted
separately to show the conformance wall.

### 7.1 Counts

| category | packages | src LOC | test LOC (in-tree suite that would notice) |
|---|---|---|---|
| REPLACE | 2 | **2 333** | 15 281 |
| KEEP-CONTRACT | 41 | **47 545** | 75 731 |
| REUSE | 25 | **24 938** | 40 419 |
| RETIRE | 1 | 314 | 230 |
| total covered | 69 | 75 130 | 131 661 |

The ratio is the whole story: the driver is **2.3k LOC**; the surface that *consumes* it is
**~72.8k LOC of production code** (2 333 + 47 545 + 24 938) with **~131k LOC of tests**
pinning it, and the fork's own package already carries **15.3k LOC of tests** for the
2.1k LOC it replaces.

### 7.2 REPLACE

| package | LOC | public surface | risk if wrong | packaging role |
|---|---|---|---|---|
| `core/agent-loop` | 2 122 (`agent.ts` 738 / `index.ts` 837 / `inbox.ts` 232 / `runtime-context.ts` 169 / `assistant-stream.ts` 140 / `constants.ts` 6) | the sole `AgentFactory`; `ctx.agentLoop.create/createAgent/resume`; owns `inbox` + `modelSelection` projections | session corruption, duplicate/lost announcements, lost pre-publication events, broken resume | row `agent-loop` disabled; `@dsh/explore-loop` inserted (B only) |
| `test-support/agent-loop-testkit` | 211 | mounts the **stock** `AgentLoop` and drives its inbox (`src/index.ts:31,103`) | cannot start a graph-loop conformance suite; in-tree tests keep testing the stock package only | fork into a graph testkit; not installed in any profile |

### 7.3 KEEP-CONTRACT (grouped; each row names the contract)

| packages | LOC | contract they consume | citation |
|---|---|---|---|
| `compaction/compaction` 505, `compaction-basic` 1 739, `command-compact` 108, `tool-result-pruner` 303, `image-offload` 197 | 2 852 | `agent/pre-step`, `agent/status`, `agent/request-error`, `turn/start`, `turn/end`, `system/message`, `assistant/message`, `compaction/*`, checkpoint marker; condensation runs through `runMaintenance` | `compaction-basic/src/index.ts:157,177,207,213,414` |
| `plan/plan-mode` | 538 | `agent/pre-step` gating, `request/header`, `plan/mode` | `plan-mode/src/index.ts:12,211` |
| `goal/goal` 1 306, `goal-round-driver` 503, `command-goal` 198, `tool-goal` 501 | 2 508 | `agent/created`, `agent/status`, `agent/inbox/*`, `agent/pre-step`, `turn/end`, goal rounds start new request series | `goal-round-driver/src/index.ts:268,348,380` |
| `subagent/subagent` 5 163, `tool-subagent` 1 030, `tool-subagent-control` 286, providers 59+83 | 6 621 | `ctx.agents.create/resume`, `runMaintenance`, `subagent/*` durable records, preset mount for children | `subagent/src/manager.ts:445,883-896`; `child-agent.ts:142-200` |
| `workflow/workflow` 383, `workflow-ptc` 1 336, `tool-workflow` 615 | 2 334 | child agents through the factory; `tool-workflow/*` records | `workflow/src/index.ts:159` |
| `experimental/agent-team` 2 172, `tool-agent-team` 432, `agent-team-profile` 8 | 2 612 | `agent/created`, `agent/disposed`, `agent/status`, `agent/inbox/spliced`, `team/*` | `tool-agent-team/src/index.ts:424` |
| `experimental/tool-ralph` 477, `ralph-bundle` 2 | 479 | injects `tools, workflowEngine, subagents, systemPrompt`; proves "custom loop as a plugin" with fresh structured children | `tool-ralph/src/index.ts:18` |
| `todo/tool-todo` 271, `interaction/tool-ask-user` 327 | 598 | tool + projection only | — |
| `preset/agent-preset-registry` | 1 083 | preset scopes, revisions, `agent-preset/selected`, `presetForSession` | `README.md:56`; `src/index.ts:89,252` |
| `session/session-title` 1 027, `-first-prompt-llm` 167, `session-stats` 299, `session-turn-outline` 229, `session-telemetry` 479, `-otel` 278, `session-log-deepseek` 337, `session-query-sqlite` 1 781 | 4 597 | fold durable events into projections/titles/telemetry/query | `session-title/src/*` (`request/header` + `user/message`) |
| `api/session-controller` | 8 320 | `agent/assistant-stream`, `agent/status`, `agent/pre-step`, `agent/created/disposed`, `session/event`, the `inbox` projection for cold reads, `agent-preset/selected` | `src/index.ts`; `src/client/sessions/session.ts:196,830` |
| `client/ui-agent-preset` | 2 502 | renders whatever roster the host serves; no loop coupling | `display.ts:60-77` |
| `experimental/hooks-claude-code` 488, `hooks-codex` 414, `auto-review` 863 | 1 765 | `agent/created`, `agent/pre-step`, `agent/turn-stopping`, `hook/*` | `hooks-claude-code/src/index.ts` |
| `extensions/tool-cordis` | 9 744 | publishes a **service catalog** that includes `agentLoop` with `create/createAgent/resume/config` (`src/api-catalog.ts:136-160`) — a renamed/absent `ctx.agentLoop` makes the Creator-mode catalog lie | `api-catalog.ts:136` |
| `bundle/headless` | 992 | consumes `turn/*`, `step/*`, `assistant/*`, `tool/*`, `agent/assistant-stream` for its JSON run events; calls `ctx.agents.create` | `src/index.ts:134,389` |

### 7.4 REUSE (unchanged)

`core/agent` 1 824 (factory slot, registry, `turnBoundary` projection, model selection),
`core/tools` 3 710, `core/system-prompt` 697, `core/session` 3 353,
`session/session-projection` 932, `session-projection-cache` 579, `session-persistence` 636,
`session-persistence-jsonl` 5 086, `session-checkpoint-policy` 83,
`interaction/{user-approval 429, user-questions 959, permission-presets 555, commands 692}`,
`guard/{repeat-tool-reminder 240, timeout-policy 81}`, `deliverables/tool-present 127`,
`llm/token-meter 1 621`, `core/{agent-default-model 97, agent-tool-presentation 54}`,
`preset/agent-preset` 30, `preset/persona` 75, `bundle/base` (patch; row `:513` is the swap point),
`bundle/web-app` (patch; presets + client roster), `client/ui-settings` 1 061,
`client/ui-settings-general` 1 584`.

### 7.5 RETIRE

| item | LOC | disposition |
|---|---|---|
| `client/ui-settings-agent-loop` | 314 | card auto-hides once the `agent-loop` namespace is gone (§6); superseded by an optional out-of-tree card for `graph-loop` |
| `bundle/base` row config `agents: []` (`:513-516`) | — | B accepts the same `agents` key on the new row, so overlays/fixtures that configure it keep a home; only the row id changes |

---

## 8. Blast radius, ranked

1. **Event-taxonomy fidelity (highest).** 41 packages and the entire Web UI fold
   `agent/*` + `session/event`. Missing `agent/assistant-stream` = no streaming; missing
   `agent/status` = a stuck "running" chip; missing `inbox` projection = broken cold reads
   (`api/session-controller/src/client/sessions/session.ts:196`).
2. **Persistence choreography.** `create` must store the durable identity and take the write
   handle *before* publication, `resume` must `open(id,'write')` and append crash closers,
   teardown must drain and close (`core/agent-loop/README.md#persistence-integration`). A
   miss here corrupts logs that outlive the profile.
3. **Preset-recorded sessions.** A session that ran `explore` cannot be resumed where that
   preset is absent (`agent-preset/not-found`). Install A where the sessions live.
4. **Settings card.** Disappears cleanly (no source change) — but users lose the parallelism
   knob until an out-of-tree card ships (§6).
5. **`tool-cordis` service catalog.** Creator mode documents `ctx.agentLoop`; a replacement
   that does not provide the same service name/methods makes the catalog wrong
   (`extensions/tool-cordis/src/api-catalog.ts:136`). Cheap fix: keep a service named
   `agentLoop` with `create/createAgent/resume` on the replacement.
6. **Overlays that target row id `agent-loop`.** Once B disables it, any such overlay lands
   on a disabled row and silently does nothing. Acceptable in a dedicated profile; document it.
7. **Compaction/plan-mode/goal.** They hook `agent/pre-step` at their own scope; a driver
   that skips the waterfall (or runs it after tool resolution) breaks condensation, plan
   gating, and goal rounds at once.
8. **Subagent/workflow/team.** They call `ctx.agents.create/resume`; any ownership or
   teardown deviation leaks child sessions and breaks parent waits.
9. **Two rows, one id.** Never keep `agent-loop` for the new plugin; duplicate ids make
   id-addressed patches ambiguous (`vendor/loader/src/config/tree.ts:51-73`).
10. **Bundle co-install.** A + B in one profile duplicates kernel row ids; assert before boot.

---

## 9. Work breakdown, sequencing, gates

ESTIMATE, from the code that already exists (`design/*.ts` = 4 439 LOC drafted) and the
2 333 LOC driver surface.

| step | deliverable | packages / files | LOC est. | gate |
|---|---|---|---|---|
| W0 | this packaging skeleton + verify script | `bundle/**` | ~600 (done) | `verify.sh` green |
| W1 | graph kernel: registry + snapshot/change tracking + graph document loader | `@dsh/graph-core` (`registry`) | 1 200 | covers ≥95% of `ctx.tools`; rebuild < 50 ms |
| W2 | router: signature, hard filter, typed-edge scoring, cache, `graph_status` | `@dsh/graph-core` (`router`,`tools`) | 1 000 | top-1 ≥ 80% on 40 labelled tasks; fallback < 20% |
| W3 | A-mode runtime: preset bridge, `agent/pre-step` policy, dev messages, turn steering, budget | `@dsh/explore-mode` (`runtime`,`policy`) | 900 | zero behaviour change in `mode: observe`; token A/B non-regression |
| W4 | B-mode driver: factory, turn/step machine, projections, persistence, cancellation | `@dsh/explore-loop` (`loop`) | 2 300 | conformance suite green (below); old sessions still readable |
| W5 | node executor = subagent: preset-bound children, artifact handoff, parallel fan-out | `@dsh/graph-core` (`runtime`) | 900 | ≥20% billed-input reduction on multi-step tasks |
| W6 | conformance suite: replay logs, event-by-event diff vs stock loop | `@dsh/graph-testkit` (fork of `agent-loop-testkit`) | 1 500 | event sequences byte-identical on the fixture corpus |
| W7 | optional client card for `graph-loop` | `@dsh/explore-ui` (`dsh.client`) | 350 + build | renders one field; disappears when the namespace is absent |

Sequencing: W1→W2→W3 (ship A behind `mode: observe`), then W5, then W4+W6 only if A/B show
measured value; W7 last. That matches the Lead's phase gates (`research/lead-analysis.md` §6).

## 10. Compatibility test matrix

| # | scenario | how | pass |
|---|---|---|---|
| T1 | A composed into `web` | `--dump-config` | 199 rows, `preset-explore` present, `agent-loop` enabled (MEASURED) |
| T2 | A removed | `plugin remove` + dump | byte-identical to baseline (`diff -q`, MEASURED) |
| T3 | B composed into `explore` | dump | stock row `disabled: true`, `graph-loop` present, unique ids (MEASURED) |
| T4 | dev overlay | `--patch … --dump-config` | absolute paths become `file://`, loop disabled (MEASURED) |
| T5 | boot A profile | `--no-open --port 3099` | URL printed, no startup diagnostics (MEASURED); mode chip lists Explore |
| T6 | preset activation audit | Settings → Agent presets | explore row healthy, not "broken" |
| T7 | resume stock session under B | open a pre-existing session | history renders; new turn runs graph driver |
| T8 | resume explore-preset session where A absent | open it | fails with `agent-preset/not-found` (documented, not a bug) |
| T9 | compaction under B | long session + `/compact` | summary lands, history continues |
| T10 | plan mode under B | `/plan` → `exit_plan_mode` | review dialog, approval, resume |
| T11 | goal rounds under B | `goal` tool + idle | one round per idle, cap respected |
| T12 | subagent under B | `subagent` / `subagent_fork` / `workflow` | children listed, results delivered, no leaked sessions |
| T13 | approvals/questions under B | risky tool path | dialog renders and resolves |
| T14 | cold read after restart | kill server, restart, open session | log renders from `session/event`, inbox projection correct |
| T15 | settings card | Plugins page | A: card present; B: card absent, no error |
| T16 | token A/B | `ctx.tokenMeter` + `contextPressure` | billed input (incl. cache read) non-regression |
| T17 | model-visible ⇔ logged | replay a graph run | every model input exists in the log |

## 11. What still requires a DSH source change

| # | need | why it is a source change | workaround shipped here |
|---|---|---|---|
| 1 | a shipped `explore` profile template | `PROFILE_TEMPLATES` is a literal (`packages/util/official-bundles/src/bundles.ts:10-26`) | create the profile once with `--from-default-profile web`, install B |
| 2 | showing the bundle in the plugin manager's optional list | `OPTIONAL_BUNDLES` / `ON_DEMAND_BUNDLES` literals (`bundles.ts:55-71`) + installation dependency | `dsh plugin add` (no GUI listing) |
| 3 | a shipped graph settings page | the only card is `ui-settings-agent-loop`, hard-wired to the `agent-loop` namespace | out-of-tree `dsh.client` card (W7); or YAML config |
| 4 | durable graph state that survives restart *as a session event* | unknown non-ignorable types are rejected on read; `appendPluginRecord` is "for `packages/experimental/` only" | per-turn in-memory state; durable artifacts through tools/files; or `ctx.storage` |
| 5 | deeper loop-introspection seams (skip a step, add a model call inside the stock loop) | the state machine is private (`core/agent-loop/src/agent.ts`) | B replaces the driver instead |

Everything else — the mode, the kernel, the driver, the tools, the profile — is
config composition plus published APIs.

## 12. Confidence

| claim | confidence | basis |
|---|---|---|
| A composes as a fifth mode without source changes | **high** | MEASURED composition; preset insertion is documented as the supported path (`agent-preset-registry/README.md:48`); label fallback verified in `display.ts` |
| A's kernel cannot live inside the preset | **high** | code + README audit rule (`agent-preset-registry/README.md:56-60`) |
| B's row surgery is disable+insert | **high** | measured in `verify.sh`; independent probe by the seam analyst (`research/01-seams.md` §5.3) |
| Sessions are shared across profiles | **high** | `dshHomePath('sessions')` + measured `~/.dsh/sessions`; per-profile config only |
| B can be a drop-in driver | **medium** | the contract is finite and enumerated, but 72.8k LOC of consumers and 131k LOC of tests pin it; only W6 can prove it |
| `verify.sh` on a fresh machine | **medium** | runs here against the source launcher; needs the checkout's `node_modules` |

**Not run, and the exact command for the Lead:**

1. Preset activation audit + mode chip (visual). Boot
   `DSH_HOME=/tmp/dsh-boot-verify pnpm dsh --profile explore --port 3099`, open the printed
   URL, check the new-session chip and Settings → Agent presets.
2. A real turn in explore mode (needs an API key): same profile, send one prompt, then
   `grep -n "agent-preset/selected"` in `$DSH_HOME/sessions/<cwd>/<id>/session.v4.jsonl.zstd`.
   That root is compressed by default; add `- id: session-persistence-jsonl` / `config: { compression: none }`
   to the profile patch if you want plain JSONL to grep.
3. `--dump-config-schema` **is** partly broken for preset rows even upstream: a pristine web
   profile exits 1 with four `unrecognized Loader tree carrier` errors, one per shipped
   preset row (`/191`–`/194`); our `preset-explore` adds a fifth of the same kind. Not caused
   by these bundles; do not use it as a packaging gate.
4. Windows: the preset copies `tool-pwsh`/`tool-bash` `!!js` platform guards from standard;
   untested here (macOS).

## Appendix — artifact map

```
bundle/
  README.md                     install flows, measured evidence, source-change list
  a-preset/package.json         @dsh/explore-mode  (dsh.bundle.patch, engines.dsh, peers)
  a-preset/cordis.patch.yml     inserts graph-registry/router/runtime + preset-explore
  a-preset/src/{index,registry,router,runtime,policy,tools}.js
  b-loop/package.json           @dsh/explore-loop
  b-loop/cordis.patch.yml       disables row agent-loop; inserts kernel + graph-loop + graph-tools
  b-loop/src/{index,registry,router,runtime,tools}.js
  dev/overlay.patch.yml         absolute-path --patch overlay (dev, no install)
  verify/verify.sh              throwaway-home composition + invariants
```
