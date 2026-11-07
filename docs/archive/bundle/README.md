# The `explore` bundles

Two installable bundles, three compositions. Nothing here edits the DeepSeek Harness
checkout; everything is a profile-level layer.

| # | You install | What changes | Row ids written | Where it belongs |
|---|---|---|---|---|
| **A** | `bundle/a-preset` (`@dsh/explore-mode`) | a fifth **mode** in the mode chip; the stock agent loop keeps running; the graph steers through public seams | inserts `graph-registry`, `graph-router`, `graph-runtime`, `preset-explore` | any **existing** profile, including the shipped `web` profile |
| **B** | `bundle/b-loop` (`@dsh/explore-loop`) | the **driver**: the stock loop row is disabled and a graph `AgentFactory` takes over | disables `agent-loop`, inserts `graph-registry`, `graph-router`, `graph-runtime`, `graph-loop`, `graph-tools` | a **dedicated** profile (`explore`) |
| dev | `bundle/dev/overlay.patch.yml` | same surgery as B, from a checkout, no install | same as B | `--patch` on any base-backed profile |

Install **A or B, never both in one profile**: both insert the same kernel row ids.

Layout:

```
bundle/
  a-preset/   @dsh/explore-mode   bundle + plugin modules (registry, router, runtime, policy, tools)
  b-loop/     @dsh/explore-loop   bundle + plugin modules (loop, registry, router, runtime, tools)
  dev/        overlay.patch.yml   absolute-path overlay for `--patch`
  verify/     verify.sh           composes throwaway profiles and asserts the invariants
```

The `src/*.js` modules are deliberately **skeletons**: they mount, expose the right
service names, and throw `… skeleton: implement …` when called. They are not the graph —
the real kernel is being designed in `design/` and measured in `research/`.

## Why a preset cannot replace the loop

- A preset is an agent-scoped plugin tree; the host keeps one loop:
  `packages/preset/agent-preset-registry/README.md:56` — *"The Host continues to share the
  Agent loop."*
- `ctx.agents.setFactory()` throws when a factory is already registered
  (`packages/core/agent/src/index.ts:383-392`), so the stock loop cannot be joined by a
  second one.
- A patch cannot repoint a row either: `name` on a patch entry is a **guard**; a mismatch
  warns and skips (`vendor/include/src/index.ts:115-117`). Hence B *disables* the row and
  *inserts* its own.

## Why the `explore` mode can be a preset

The Web "modes" are exactly preset rows: `packages/bundle/web-app/presets/*.patch.yml`
insert one `@deepseek-ai/dsh-agent-preset` row each. Any bundle may insert one more; a
non-shipped preset renders its own `name` instead of a locale key
(`packages/preset/agent-preset-registry/src/display.ts:60-77`). So A is a first-class
mode, not a hack, and it lives in the profile you already use — same sessions, same
workspace, no fork.

## Install A — a fifth mode in your existing `web` profile

```sh
cd /Users/zhinan/deepseek-harness                      # or wherever dsh runs from
pnpm dsh plugin --profile web add /Users/zhinan/Documents/dsh_workspace/dsh-graph-loop/bundle/a-preset
pnpm dsh --profile web --dump-config | grep -E 'preset-explore|graph-(registry|router|runtime)'   # layer check
pnpm dsh --profile web                                # restart; the chip now lists “Explore (graph)”
```

Uninstall: `pnpm dsh plugin --profile web remove @dsh/explore-mode`.

If your installation has the published package instead of a checkout:
`dsh plugin --profile web add @dsh/explore-mode`.

## Install B — a dedicated `explore` profile where the graph *is* the driver

```sh
# 1. create the profile from the shipped web template (custom name only)
pnpm dsh --profile explore --from-default-profile web --dump-config >/dev/null

# 2. install the driver bundle (bundles are appended to dsh.profile.bundles in order)
pnpm dsh plugin --profile explore add /Users/zhinan/Documents/dsh_workspace/dsh-graph-loop/bundle/b-loop

# 3. verify before booting: stock row disabled, graph rows present, unique ids
pnpm dsh --profile explore --dump-config | grep -nE "id: (agent-loop|graph-loop|graph-registry|graph-router|graph-runtime|graph-tools)" -A4
pnpm dsh --profile explore --no-open --port 3081
```

Never re-run `--from-default-profile explore` after installing: it **deletes** the profile
directory, including its `package.json`, `node_modules`, and `cordis.patch.yml`
(`docs/upgrade-guide/v0.2.1-alpha.2/from-default-profile-replaces-target/guide.md`).
To reset, reinstall.

Upgrade = reinstall: `pnpm dsh plugin --profile explore remove @dsh/explore-loop && pnpm dsh plugin --profile explore add /Users/zhinan/Documents/dsh_workspace/dsh-graph-loop/bundle/b-loop`,
or install a published version.

## Dev loop with no install

```sh
cd /Users/zhinan/deepseek-harness
pnpm dsh --profile web --patch /Users/zhinan/Documents/dsh_workspace/dsh-graph-loop/bundle/dev/overlay.patch.yml --dump-config
pnpm dsh --profile web --patch /Users/zhinan/Documents/dsh_workspace/dsh-graph-loop/bundle/dev/overlay.patch.yml
```

Absolute paths in `insert` rows become `file://` URLs at patch load
(`packages/boot/app-boot/README.md:65`), which is how a checkout drives the loop from
source. Point the overlay at your `.ts` entries once the real packages exist; the source
launcher already runs `node --import tsx/esm`.

## Manifests

Both packages are ordinary bundles: `package.json` declares
`"dsh": { "bundle": { "patch": "./cordis.patch.yml" } }`
(`docs/user/develop/basic/publish.md`, "The bundle manifest"). Key fields:

- `engines.dsh: "^0.2.1-rc.3"` — the range the running installation satisfies today, the
  same shape a shipped out-of-tree plugin already uses
  (`~/.dsh/profiles/web/node_modules/dsh-artcraft-plugin-cadcraft/package.json`). When
  `engines.dsh` is declared, `peerDependencies` are **not** used for the compatibility
  check (`packages/boot/app-boot/README.md:52`).
- `peerDependencies` + `peerDependenciesMeta.optional` for every `@deepseek-ai/*` module
  the rows import. **Rule:** an out-of-tree module may only import `@deepseek-ai/*`
  packages it declares as peers — a bare import resolves from the linked package's own
  `node_modules`, not from the installation (`docs/user/develop/basic/publish.md`,
  "resolution rules"). Optional peers keep `pnpm add` from trying to fetch
  `@deepseek-ai/*` from npm.
- `engines.dsh` is *not* a sandbox; it is a composition-boundary check only.

## Verify

```sh
bundle/verify/verify.sh                    # writes /tmp/dsh-explore-verify, boots nothing
```

Measured on 2026-11-05 with DSH `0.2.1-rc.3` (`22ddee3792`):

| step | top-level rows | evidence |
|---|---|---|
| `--profile explore --from-default-profile web` | 195 | `- id: agent-loop` at dump line 395, enabled, `agents: []` |
| install A | 199 | `graph-registry` line 1234; `preset-explore` line 1256; stock loop untouched |
| remove A | 195 | no `preset-explore` left |
| install B | 200 | stock row `disabled: true` (line 399); `# == @deepseek-ai/dsh-base, patched by @dsh/explore-loop` (line 394); `graph-loop` line 1258 |
| duplicate-id invariant | 200 unique / 200 | stock loop disabled, graph driver enabled |

A headless boot of the A profile (`--no-open --port 3099`) printed its URL and no
diagnostics. The preset's **activation audit** and the mode chip are visual checks:
open that URL, then Settings → Agent presets must list “Explore (graph)” as a healthy row.

## What still needs a source change

1. A shipped `explore` entry in `PROFILE_TEMPLATES`
   (`packages/util/official-bundles/src/bundles.ts:10-26`) — the profile is created by hand
   instead.
2. Showing the bundle in the plugin manager's *optional bundles* list requires
   `OPTIONAL_BUNDLES` (`bundles.ts:62-77`) plus the package as an installation dependency —
   `dsh plugin add` is the path that needs neither.
3. A graph-loop settings page. The stock card is driven by the settings namespace, which is
   the **profile entry id** (`packages/settings/settings/src/index.ts:302-330`); B's row id
   is `graph-loop`, so the stock `agent-loop` card simply disappears. A replacement card is
   an out-of-tree client plugin (`dsh.client` + a prebuilt `lib/client.js`), the same shape
   as the already-installed `dsh-artcraft-preview-panel`. No source change, ~350 LOC.
