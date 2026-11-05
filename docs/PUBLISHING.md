# Publishing 0.1

## Published packages (npm)

| Package | Latest | Role |
|---|---|---|
| [`dsh-graph-loop`](https://www.npmjs.com/package/dsh-graph-loop) | 0.1.2 | Graph agent driver (replaces the stock `agent-loop` row) |
| [`dsh-graph-loop-ui`](https://www.npmjs.com/package/dsh-graph-loop-ui) | 0.1.1 | Graph tab in the DSH Web conversation view + `/graph-chat` API |
| [`dsh-graph-loop-mode`](https://www.npmjs.com/package/dsh-graph-loop-mode) | 0.1.1 | Explore preset + agent-reuse guard |

`@dsh/explore-core` remains private: it is a build-time library bundled into the two runtime
packages, not a runtime dependency.

## Install

```sh
dsh plugin --profile web add dsh-graph-loop-ui
dsh plugin --profile web add dsh-graph-loop
# optional preset/guard
dsh plugin --profile web add dsh-graph-loop-mode
```

Headless profiles need only the driver:

```sh
dsh plugin --profile headless add dsh-graph-loop
```

## Version note

`dsh-graph-loop@0.1.1` was staged by npm but did not finalize before the next release; `0.1.2`
is the first reliably resolvable loop version after 0.1.0. UI and mode are 0.1.1.
