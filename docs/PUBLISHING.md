# Publishing 0.2

The three runtime packages are published separately; `dsh-graph-loop-core` is a private,
build-time library that esbuild bundles into them (it is not a runtime dependency and is never
published).

## Packages

| Package | Version in this release | Role |
|---|---|---|
| [`dsh-graph-loop`](https://www.npmjs.com/package/dsh-graph-loop) | 0.2.0 | Graph agent driver (replaces the stock `agent-loop` row) |
| [`dsh-graph-loop-ui`](https://www.npmjs.com/package/dsh-graph-loop-ui) | 0.2.0 | Graph tab in the DSH Web conversation view + `/graph-chat` API |
| [`dsh-graph-loop-mode`](https://www.npmjs.com/package/dsh-graph-loop-mode) | 0.2.0 | Explore preset + agent-reuse guard |

The npm registry may still serve the previous 0.1.x versions until this release is published;
the table above is the version in `main`, not a claim about the registry.

## Prerequisites

- Clean `main` at the release commit (`git status --porcelain` empty), with `main` pushed.
- `npm login` as a maintainer of the `dsh-graph-loop*` packages.
- Node 24+ and npm 11+ (the release was verified with Node 26 / npm 11).
- A DSH checkout for the end-to-end checks (`DSH_ROOT`; the e2e scripts default to a local checkout).

## Build and verify

```sh
npm ci
npm run typecheck
npm test                 # node:test unit suite, includes the graph-chat route tests
npm run build            # esbuild -> packages/{loop,graph-ui,mode}/lib
npm run build:check      # fresh temp build byte-compared with lib + every ./lib export exists
npm pack --dry-run -w packages/loop -w packages/graph-ui -w packages/mode
```

Each published workspace has a `prepack` script that rebuilds `lib/` and writes progress to
stderr, so `npm pack`/`npm publish` can never ship a tarball with a missing or stale entry point.
`lib/` stays gitignored on purpose: the source of truth is `packages/*/src`, and `prepack` is what
puts the bundle in the tarball.

`npm run verify` additionally runs the installed-bundle and tarball end-to-end checks, which need
the DSH checkout and a mock LLM server.

## Release order

Publish the driver first, then the UI and mode bundles, so the peer surface exists when the
dependants are installed:

```sh
npm publish -w packages/loop --access public
npm publish -w packages/graph-ui --access public
npm publish -w packages/mode --access public
```

Then verify the registry side, not just the local tarball:

```sh
npm view dsh-graph-loop@0.2.0 version dist.tarball gitHead
npm view dsh-graph-loop-ui@0.2.0 version dist.tarball gitHead
npm view dsh-graph-loop-mode@0.2.0 version dist.tarball gitHead
npm view dsh-graph-loop dist-tags
```

`gitHead` must equal the release commit. If any tarball is missing `lib/`, or `gitHead` points at
a different commit, stop and republish from the clean release commit.

## Tag and push

```sh
git tag -a v0.2.0 -m "dsh-graph-loop 0.2.0"
git push origin main
git push origin v0.2.0
```

Publish from the tagged commit. Do not rebuild between tagging and publishing: `prepack` rebuilds
from the same source, and `npm run build:check` proves the bundle matches it.

## Install (users)

```sh
dsh plugin --profile web add dsh-graph-loop
dsh plugin --profile web add dsh-graph-loop-ui
# optional preset/guard
dsh plugin --profile web add dsh-graph-loop-mode
```

Headless profiles need only the driver:

```sh
dsh plugin --profile headless add dsh-graph-loop
```

Registry installs resolve `@deepseek-ai/*` peers from the DSH installation; they are declared
optional peers and are not installed from npm. `@deepseek-ai/schemastery` is a value import in the
built loop bundle and is therefore declared as an optional peer — a DSH host always provides it.

## Version history

- `0.1.0` — first graph-loop driver.
- `0.1.1` — Graph tab + `/graph-chat`; Explore mode bundle. The loop `0.1.1` was staged by npm but
  did not finalize.
- `0.1.2` — first reliably resolvable loop version after 0.1.0.
- `0.2.0` — live envelope/composition, LangGraph kernel default, Explore mode default, benchmark
  split (product/stress), and the 2026-11-07 reliability/security fixes.
