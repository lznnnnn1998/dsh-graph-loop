# Changelog

## 0.2.0 (unreleased)

### Reliability and security hardening (2026-11-07 audit)

- **`/graph-chat` cannot kill the Web host**: route handlers return their promise to the web
  server instead of detaching it with `void`, so a client that aborts mid-body is a caught 400,
  not an unhandled rejection that trips the host's fail-loud policy.
- **Bounded request bodies**: 64 KiB ceiling (drained, then 413), 15 s upload timeout, JSON-only
  content type (415), valid-JSON-object body (400), 200-char session ids and 32 KiB messages.
- **Pinned methods and the host trust fence**: GET for page/state/messages/events, POST for
  new/send (405 otherwise); every route calls `connection.requestRejection` when that host service
  is mounted, so DNS-rebinding/cross-site requests are rejected before any side effect.
- **SSE hardening**: writes are guarded against a closed socket, a throwing subscriber is caught,
  and the runtime subscription is disposed exactly once on close.
- **Session working directory**: `/graph-chat` sessions record `meta.cwd`, so file tools do not
  silently fall back to the directory `dsh web` was launched from.
- **No preset override**: the UI bundle no longer pins `preset: standard`; graph-chat sessions
  inherit the profile default (Explore when the mode bundle is installed).

### Release engineering

- `npm run build` now runs the real bundle build (it previously pointed at a nonexistent
  `tsconfig.build.json` and always failed).
- Each published package has a `prepack` that rebuilds `lib/`, so a tarball can no longer ship
  without its entry points; build status goes to stderr so `npm pack --json` stays machine-readable.
- `npm run build:check` builds into a temp directory, byte-compares `packages/*/lib`, and verifies
  every `./lib/*` export exists. This caught `./kernel` exporting `lib/kernel.js` while the build
  wrote `lib/kernel/index.js`.
- `@deepseek-ai/schemastery` is declared as an optional peer (it is a value import in the built
  loop bundle); versions are bumped to 0.2.0 and the lockfile updated.
- `scripts/verify-all.sh` now builds and checks reproducibility before the end-to-end checks.

### Kernel and topology correctness

- **Kernel routing fails fast**: `canKernelDrive()` rejects LangGraph-reserved/state-channel node ids
  (`next`, `__end__`, …) and any node with more than one control out-edge, so model-authored plans
  the kernel cannot route fall back to `FrontierTopology` instead of crashing lazily or silently
  dropping a branch. Compile/wiring failures surface as typed `BAD_NODE_ID`/`INVALID_GRAPH` errors
  and a failed result instead of a bare throw.
- **Bounded failure recovery**: `FrontierTopology` checks the step budget before following a
  `callFailed` recovery edge, so a failed-node self-loop terminates instead of running forever.
- **Proposal validation**: invalid `when` conditions are errors (no silent downgrade to `always`);
  unconditional self-loops, edges out of terminals and unreachable nodes are rejected, and the
  proposal is additionally checked by `validateTaskPlan`.
- **Replan does not poison the next call**: core `LangGraphRun.updateState()` keeps a per-stream
  abort controller, and stream-open failures become `{kind:'failed'}` (with `onFailure`) rather than
  an `AbortError` escaping `next()`.
- **Checkpoint keys** escape session/turn/node ids, so `('a/b','c')` no longer collides with
  `('a','b/c')`; cyclic input to `assertJsonSafe` is reported as a violation instead of overflowing
  the stack.

### Turn outcome and scheduling

- **Failed graphs fail the turn**: a run that ends `failed` after recovery closes the turn as
  `{kind:'error', code:'GRAPH_FAILED'}` and emits `agent/error`; it is no longer recorded as a
  completed turn.
- **`beginTurn` inside the turn boundary**: every `turn/start` gets exactly one `turn/end` even when
  graph startup throws, so the durable event order cannot be left open.
- **Subagent failures are real failures**: batch completions share the trail/advance/recovery path
  with model steps, a failed child can trigger boundary replan, and child failures are logged with
  their node id instead of being swallowed.
- **Per-turn replan allowance**: `replans` and the adoption window reset in `beginTurn`, so early
  turns can no longer permanently disable boundary recovery.
- **Deterministic child fallback and budgets**: `forceFallback` wins over `propose` for subagent
  children; composition with `maxSteps = 1` yields exactly one node; composed terminals are
  answer-only (`toolAllow: []`) except the single-step generic escape hatch. An empty
  plan-universe ∩ visible-tools intersection stays empty instead of widening to the whole preset.

### Explore preset and installer

- **One `graph_status`**: removed the mode-scoped duplicate that shadowed the live plan/run tool.
- **One node narrative**: when the graph driver is mounted the Explore policy omits its fixed
  inspect→plan→act→verify "current node" line, leaving the loop's real plan node as the only one.
- **Reuse guard**: generic-word stoplist, conservative suffix folding and a text-only floor; the
  idle-status bonus can no longer deny a spawn on its own. The README now states that the guard
  blocks, and documents the thresholds.
- **Installer profile safety**: profile existence is read from `$DSH_HOME/profiles/<name>` on disk,
  never inferred from a failed `--dump-config`; an existing profile is never recreated over, each
  `plugin add` is verified immediately, the profile manifest/lockfile is backed up and restored on
  failure, and `--dry-run` reports without writing.

### 0.2 features

- **LangGraph kernel is the default**: `createKernel()`/`runPlan()` use `langgraph` when available,
  with `MinimalKernel` fallback. The live scheduler drives kernel-drivable plans through
  `KernelTopology` (pause-before-node bridge; one superstep per DSH step).
- **Explore mode default**: the one-command installer adds the mode bundle and sets
  `agent-preset-registry.default = explore`; the stock `agent-loop` row is disabled, not removed.
- **Tool policy**: `toolPolicy: preset` keeps the full preset tool set for benchmark harnesses so
  plan filtering cannot hide benchmark tools; `plan` remains the token-saving default.
- **Composition switch**: `composition: false` on the loop row keeps the legacy
  `synthesizeTopology` path (used by the parallel-subagent e2e); the live envelope/compose path
  remains the default.
- **Optional read node**: read-before-write is advisory; a missing input file no longer fails the
  turn and triggers a recovery plan.
- **Formatting retry**: an assistant response that prints tool-call/DSML syntax as text is retried
  on the same graph node instead of advancing without the file.
- **Mutation detection**: `merge`/`combine`/`concatenate`/`split`/`convert`/`export`/`generate`/
  `copy` now mark a task as mutating, so merge-into-file tasks get an edit node.
- **Rename guidance**: the mutation node tells the model to use `bash` (`mv`/`rm`/`mkdir`) for
  rename/move/delete, not to create a copy with `write` and leave the original.
- **Mutation enforcement**: any node whose own intent is mutating (dynamic `d_edit`, composed
  `n_mutate`, or a write-capable stage) that explores without writing gets one corrective retry;
  real mutating bash commands count. A `> /dev/null` redirect is not a mutation. Formatting (DSML)
  retries are capped at one. The Terminal-Bench profile caps provider retries at one.
- **Benchmark**: local suite expanded to 20 tasks with mean/median reporting, fixture validation,
  run manifests, and a packed-tarball install/runtime test. Added Terminal-Bench 4.0 and
  NL2Repo-Bench preflights/runbooks. Docker + Harbor + a DSH Terminal-Bench adapter now run a real
  task end to end; the first trial scored 0.0 on both arms (no aggregate yet).
- **Docs**: status/decision/merge/evaluation docs, a docs index, and archived 0.1 history.

## 0.1.2

- LangGraph/Minimal kernel adapters; graph runtime and Graph tab; graph driver bundle.
- One-command install, Explore preset, per-plan tool admission, dynamic topology.

## 0.1.1

- Graph tab + `/graph-chat`; Explore mode bundle; local conformance tests.

## 0.1.0

- First graph-loop driver: per-turn topology, templates, scheduler, session projections.
