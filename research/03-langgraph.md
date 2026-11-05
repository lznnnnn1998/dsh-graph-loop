# 03 — LangGraph as the DSH loop kernel: integration design

> **Status**: spike complete, decision made. Scope: the *execution kernel* of a
> graph-native `AgentFactory` that replaces `agent-loop` (not a wrapper around
> the stock loop).
>
> **Verdict (3 lines)**
> 1. **Use `@langchain/langgraph@1.7.0` (exact pin, MIT, ESM-clean on Node 26) as the execution kernel**, behind the boundary in [`design/kernel.ts`](../design/kernel.ts); do not vendor a StateGraph clone.
> 2. The kernel is *not* the hard part: LangGraph's `StateGraph` already gives node=step semantics, dynamic fan-out, retry/timeout, streaming and pause/resume. The hard part is the **seam**: turning superstep boundaries into DSH `step/end`+`step/start`, keeping graph state JSON-only, and confining human gates to tool calls or node boundaries.
> 3. Three constraints are non-negotiable (C1 JSON state, C4 no side effects before `interrupt()`, C5 no cross-process mid-turn resume); if any of them breaks, the fallback is the ~400-LOC `MinimalKernel` in §9, not a different LangGraph usage.

Everything numeric below is **MEASURED** in an isolated project at
[`spikes/langgraph/`](../spikes/langgraph/) (`node run-all.sh` → `output.txt`),
unless marked **ESTIMATE**. DSH citations are `path:line` against
`/Users/zhinan/deepseek-harness` @ `22ddee37`.

---

## 1. Install facts (MEASURED)

| Fact | Value |
|---|---|
| Resolved version | `@langchain/langgraph@1.7.0` (registry `latest` = 1.7.0 at install time) |
| Companion versions | `@langchain/core@1.3.4`, `@langchain/langgraph-checkpoint@1.2.2`, `@langchain/langgraph-sdk@1.13.0`, `zod@4.6.7` |
| License | MIT on every package in the tree |
| Unpacked size, `@langchain/langgraph` | 4.4 MB (636 files) |
| Unpacked size, tree | **65 MB on disk** for `@langchain/langgraph + @langchain/core + zod` |
| Installed packages | **19** (`npm ls --omit=dev` lists 26 entries; 7 are optional peers that are *not* installed: `openai`, `react`, `react-dom`, `ws`, 3× `@opentelemetry/*`) |
| Largest children | `js-tiktoken` ~21 MB, `@langchain/core` 13 MB, `zod` 8.1 MB, `langsmith` 7.6 MB, `@langchain/langgraph-sdk` 7.0 MB, `@langchain/langgraph` 5.9 MB |
| Module format | `"type": "module"` with **both** `import` and `require` export conditions on `langgraph`, `core`, `checkpoint`, `sdk`; `@langchain/protocol` and `langsmith` are CJS |
| Node 26 / ESM | `import("@langchain/langgraph")` → **OK**, 98 exports, 128 ms. Cold start of a bare process is 30–40 ms, so **~130 ms boot cost** |
| RSS | bare node 48 MB → import only **151 MB** → import + one graph run **177 MB** |
| TypeScript | strict-clean at the use site; state keys and `interrupt<T>` resume types are inferred; **`config.configurable.thread_id` is `unknown`**; `Send` payloads are `any`; `skipLibCheck: false` fails on `Symbol.asyncDispose` unless `lib` ≥ ESNext |

### 1.1 Things that break packages we would otherwise not notice

- **`langsmith` is a hard import-time dependency.** Hiding `node_modules/langsmith` makes `import("@langchain/langgraph")` fail with `ERR_MODULE_NOT_FOUND … imported from @langchain/core/dist/tracers/base.js`. Same for **`js-tiktoken`** (`@langchain/core/dist/utils/tiktoken.js`). Neither is optional, even though neither is *used* by a graph run.
- **Telemetry is off and makes no network call.** With no `LANGCHAIN_*`/`LANGSMITH_*` env vars set, a full graph run performs **0 `fetch` calls** (probe replaces `globalThis.fetch` with a recorder and waits 250 ms for background callbacks). Tracing is strictly opt-in via `LANGSMITH_TRACING`/`LANGCHAIN_TRACING_V2`. **No consent or egress problem** — only install-size cost.
- **Dual-package hazard is real but avoidable.** Because `langgraph` ships CJS + ESM builds, any mixed `require`/`import` of it in one process yields **two instances** of `Command`, `BaseCheckpointSaver`, `Send` — `instanceof` and `isCommand()` then fail across the boundary. DSH is ESM end-to-end (every `packages/*/*/package.json` checked, e.g. `@deepseek-ai/dsh-base`, sets `"type": "module"`), so we standardise on `import` and add a one-line startup assertion (`isCommand(new Command({})) === true`) that fails fast if a second copy appears.

---

## 2. What the spike proves (MEASURED — `spikes/langgraph/output.txt`)

| Capability the design needs | Result | Note |
|---|---|---|
| Typed state (`Annotation`, `zod`) | ✅ | `Annotation.Root` + reducers; `StateSchema` (zod) also exported |
| `addNode` / `addEdge` / `addConditionalEdges` | ✅ | Conditional loop executed `n_plan → n_act×2 → n_done` |
| Node name may not equal a state channel | ⚠️ | `Error: plan is already being used as a state attribute` — a real ergonomic tax on graph authors |
| Recursion / step budget | ✅ | `GraphRecursionError` at `recursionLimit: 10`; configurable per invoke |
| Subgraph as a node | ✅ | Parent merges subgraph channels through its own reducers; subgraph-only channels are silently dropped in the parent (`secret` vanished) |
| Static parallel fan-out + join | ✅ | 30/5/15 ms sleeps completed in **32 ms** → genuinely concurrent; join ran once after all three |
| Parallel write ordering | ⚠️ | Writes land in **completion order** (`w1,w2,w0`), not declaration order — reducers must be order-insensitive or explicitly sorted |
| Dynamic fan-out (`Send`) | ✅ *in the right form* | see §3 |
| `MemorySaver` + thread isolation | ✅ | `count` accumulated across two invokes on `t1`; `t2` isolated |
| `getState` / `getStateHistory` / `updateState` (time travel) | ✅ | 8 checkpoints for a 2-invocation thread; `updateState` returned a fork config |
| Custom `BaseCheckpointSaver` | ✅ | Implemented `getTuple/list/put/putWrites/deleteThread` in ~40 lines; 4 `put` + 3 `putWrites` for a 2-node run |
| Checkpoint payload is JSON-safe | ❌ **fail** | `Date → String`, `Map → Object` after `JSON.stringify`; `__pregel_tasks` internal channel leaks into `channel_values` |
| Resume from JSON-hydrated saver | ✅ | A fresh saver + fresh graph resumed the thread from a JSON round-tripped log |
| `interrupt()` + `Command({resume})` | ✅ | Returns `__interrupt__` in the result *and* `getState().tasks[].interrupts[]`; `invoke` does **not** throw when a checkpointer is present |
| Interrupt without a checkpointer | ✅ fails fast | `GraphValueError: No checkpointer set` |
| **Node body re-executes after resume** | ❌ **cost** | A fake "model call" before `interrupt()` ran **twice** for one approved step |
| Multiple interrupts per node | ✅ | Addressed **positionally** (`Command({resume:'A'})`, then `'B'`) |
| Interrupt id stability | ⚠️ | `XXH3(checkpoint_ns \| index)`; stable for a stored checkpoint, **random across fresh runs** (checkpoint id is uuid6) |
| Recompile topology between turns | ✅ | Paused thread resumed into a graph where the tail node had been swapped (`tailA` → `tailB`); dropping a channel also survived |
| `Command({goto})` | ✅ but strict | Requires `addNode(..., { ends: [...] })`; otherwise `UnreachableNodeError` at compile |
| Add nodes after `compile()` | ❌ | `g.addNode is not a function` — topology is fixed per compiled instance |
| Streaming (`values`/`updates`/`custom`/`debug`/`tasks`/`checkpoints`) | ✅ | 5 chunks for a 2-node run, correctly ordered |
| Cancellation | ✅ | `AbortSignal` → `Error: user cancelled` |
| Per-invoke overhead | ✅ | **0.20 ms** (1 node), **0.52 ms** (5 nodes), **0.23 ms** checkpointed |
| Deterministic execution order | ✅ | Two identical runs produced an identical trace and state |

---

## 3. The `Send` failure: API misuse, not a limitation

The first run failed with:

```
InvalidUpdateError: Expected node "dispatch" to return an object or an array
containing at least one Command object, received array
```

**Diagnosis (MEASURED, `spikes/langgraph/probe-send.mjs`):** `Send[]` is a
**router** return value, not a **node** return value.

- ❌ `addNode("dispatch", s => s.items.map(i => new Send("work", {item:i})))` → `InvalidUpdateError`.
- ✅ `addConditionalEdges("prepare", s => s.items.map(i => new Send("work", {item:i})), ["work"])` → `{results:["done:a","done:b","done:c","n=3"]}`.

The supported form is the documented map-reduce shape. Two caveats:
fan-out width is **data-driven** (verified with 6 branches, so it is a real
dynamic fan-out, not a fixed set); and `Send` payloads are **not type-checked**
against the state schema (`Args = any`), so the adapter must validate them.

**Does the design need it?** Not for DSH's parallel branches — DSH runs
*agents*, not parallel steps in one agent (§5.3), and the loop spawns child
subagents through `ctx.subagents`, not through `Send`. `Send` is kept in the
kernel interface (`addFanOut`) because it is cheap to support and is the right
primitive if we ever parallelise a *tool batch* inside one step. The loop's
default composition does not use it.

---

## 4. Determinism and replay facts

1. **Graph logic is deterministic.** Same input → same node order → same state (MEASURED).
2. **Ids and timestamps are not.** `Checkpoint.id` is uuid6 and `Checkpoint.ts` is wall-clock; interrupt ids hash the checkpoint namespace, so two identical *fresh* runs produce different ids. Resume identity is therefore `(thread_id, checkpoint_id, interrupt_index)` — **not** the display id. Any DSH record that references an interrupt must store the triple, or re-read `getState()`.
3. **Resume replays the node body from the top.** Everything before `interrupt()` runs twice. This is the single most consequential fact for a loop whose nodes make LLM calls (§7).
4. **Checkpoints are not JSON-lossless.** `Date`/`Map`/class instances do not survive `JSON.stringify`. This is why graph state is restricted to JSON (§6.1) and why a checkpoint can never be the session log.

---

## 5. Integration architecture

### 5.1 Where the compiled `StateGraph` sits

The graph **is** the agent loop's control flow. Concretely, a new bundle ships a
plugin that registers an `AgentFactory` (`packages/core/agent/src/index.ts:175-210`)
whose `createAgent`/`resume` build a `CompiledStateGraph` instead of a
`ReactLoopAgent`. `setFactory` throws if a factory is already registered
(`packages/core/agent/src/index.ts:383-392`), so the row must be **replaced**,
not added beside: the profile patch targets row id `agent-loop`
(`packages/bundle/base/cordis.patch.yml:513`) and the new bundle supplies the
row body. No DSH source change.

```
AgentFactory.createAgent(ownerCtx, options)
  └─ buildGraph(session, options)     // design/kernel.ts createGraph
       └─ compile({ checkpointer: new InTurnCheckpointer(), maxSteps })
  └─ agent.kick()                     // same public Agent surface: send/followup/steer/inject/cancel
       └─ graph.stream(input, { threadId: session.id, signal, onBoundary })
```

`Agent` stays the same interface, so `ctx.agents`, the ACP bridge, the UI and
the subagent tools keep working unchanged.

### 5.2 A node is one DSH step; a superstep boundary is `step/end` + `step/start`

`ReactLoopAgent.turn()` today (`packages/core/agent-loop/src/agent.ts:320-428`)
runs `turn/start` → loop { `preStep` → `step/start` → `step()` → `step/end` } →
`turn/end`. `step()` (`agent.ts:428-601`) does exactly one thing: one model
request, one assistant message, one tool batch.

That is precisely a graph node. So the adapter's **only structural obligation**
is the boundary (`design/kernel.ts` obligation A1):

| Graph event | DSH event appended | Where |
|---|---|---|
| run begins | `turn/start { turn }` | `onBoundary` before first step, or run start hook |
| node `model` running | (`request/header`, `user/message`, `assistant/message` inside the node, via the existing `ctx.llm.stream` + `session.append`) | node body |
| node `model` done, tools to run | `tool/call` … `tool/result` inside the *next* node | node body |
| **superstep boundary** | **`step/end {turn, step}` then `step/start {turn, step+1}`** | `RunOptions.onBoundary` |
| run ends | `turn/end { turn, reason }` | run end |

`onBoundary` is called **before** the next node executes, so the log order equals
execution order, and no model request can ever land outside a step (the current
loop's invariant — `agent.ts:354` appends `step/start` before `this.step()`).

The node's return value is the graph delta *and* the step outcome: a node that
made tool calls returns `{ toolCalls: n }`, so the conditional edge
`(s) => s.toolCalls > 0 ? 'tools' : 'finish'` reproduces the stock
"tool calls → next step, otherwise finish" decision
(`agent.ts:580-590`). Retry stays where it is: LangGraph's `retryPolicy` on the
node replaces the inner `while(true)` retry loop in `step()` (`agent.ts:437-560`),
and `agent/request-error` maps onto `retryOn`.

`maxSteps` maps to the per-turn step budget; `GraphRecursionError` must be
translated to `KernelError{code:'STEP_BUDGET_EXCEEDED'}`, not surfaced as a
crash.

### 5.3 Parallel branches are child subagents, not parallel steps

A DSH agent executes steps **serially** (`turn()` awaits `this.step()`); the
only concurrency inside a step is the tool batch
(`maxParallelToolCalls`, `agent.ts:581-585`). So a graph fan-out does **not** mean
"two model requests at once in this agent". It means: **spawn N child agents**
(one per branch) via `ctx.subagents` / `ctx.agents.create({setup})`, then join.
Each branch is its own session, its own log, its own `thread_id`. The parent
graph node is a thin `runSubagent` node that awaits the child and returns a
summary delta.

That keeps the invariants the session log depends on: one model request at a
time per session, one `step/start` per request, and no interleaved writes.

Implementing it: `addFanOut` is available but the default composition uses a
**fixed** parallel node with an internal `Promise.all` over child agents, because
`Send` would create pseudo-steps in the parent session that never had a model
request — violating C2. (If a future design wants N branches to share the parent
session, `Send` is the mechanism; today it is not.)

### 5.4 Mapping table

| LangGraph | DSH | Mismatch / rule |
|---|---|---|
| State object | session log + `deriveMessages()` | **Mismatch.** LangGraph carries a mutable snapshot; DSH derives history from an append-only log. Rule C3: state is a *projection index* (step counters, ids, flags), never the transcript. The transcript is the log. |
| `thread_id` | `SessionId` | 1:1, use `session.id` verbatim. |
| Checkpointer | session-persistence + projections | **Mismatch.** Checkpoints are opaque snapshots, not events; they cannot be replayed, projected, forked or compacted by DSH tooling. Sidecar only (§6). |
| `interrupt()` / `Command` | `ask_user_question` tool + inbox | **Mismatch.** DSH pauses *inside a step* on a tool call and resumes from the inbox; LangGraph pauses *between nodes* and replays the node body. Prefer the tool (§7). |
| Parallel branches | child subagents | Serial per-agent execution is an invariant; fan-out = child sessions (§5.3). |
| Node | step (or subagent run) | 1:1 (§5.2). |
| Subgraph | a step-kind selection from the registry match | 1:1 — the "matched sub-graph" from the user's proposal is literally a compiled subgraph. |
| `getStateHistory` / `updateState` | `session.fork` | Different mechanisms; do not expose LangGraph time travel as DSH fork. |

---

## 6. Checkpointing

### 6.1 Graph state must be JSON-only (C1)

MEASURED: `Date → String`, `Map → Object` after a JSON round-trip of
`checkpoint.channel_values`, and an internal `__pregel_tasks` channel appears in
the payload. Consequences:

- `design/kernel.ts` restricts state to `JsonValue`; use ISO-8601 strings for
  timestamps and `Record<string, JsonValue>` instead of `Map`.
- The adapter validates every node update in development
  (`validateJson: true`) and strips `__pregel_*` channels before anything is
  persisted or logged.
- Never put a `Message[]`, `Uint8Array`, `AbortSignal`, or a client handle in
  graph state. Message content stays in the log; the graph holds `messageId`
  references.

### 6.2 MemorySaver vs a custom saver

The spike implements both. The custom `BaseCheckpointSaver` is ~40 lines
(`getTuple/list/put/putWrites/deleteThread`) and works, including resume after a
JSON round-trip. **We still choose `MemorySaver`-equivalent behaviour**, because:

- DSH **closes interrupted turns** on restore: `interruptedTurnClosers()`
  (`packages/core/session/src/repair.ts:209`) synthesises `tool/result`,
  `step/end`, `turn/end` for an unbalanced tail, and `resume()` appends them
  before publishing (`packages/core/agent-loop/src/index.ts:801-806`).
- Therefore **a graph run never continues across a restart.** Durable
  checkpoints cannot buy correctness that DSH deliberately gives up, and a
  durable store that disagrees with the log is a bug source, not a feature.
- `interrupt()` frames the same turn: `ask_user_question` waits inside the tool
  call (`packages/interaction/tool-ask-user/src/index.ts:1-6` — "pauses until a
  UI provider returns a human answer, then feeds that answer back into the agent
  loop as an ordinary tool result"), i.e. resume happens **inside the live
  process**, not after a restart.

So: **`InTurnCheckpointer` (in-memory, per-turn, dropped at `turn/end`)** is the
default and the only one on the critical path.

### 6.3 If we ever need durability: sidecar, not session events

A durable saver would be implemented over `ctx.storageDomain`
(`packages/experimental/claude-code-mods/src/host-ops.ts:170` shows the
`storageDomain.get(name)` / `.table(...)` pattern; `packages/schedule/schedule`
uses it for its own tables) in a table like `graph_checkpoint(thread_id,
checkpoint_id, parent_id, step, created_at, state_json, ran_nodes)`. Never a
session event: checkpoints are not model-visible facts, and inventing a
`plugin:` event type would leak an implementation detail into the log that
`deriveMessages()` must then ignore. This is off by default and behind a config
flag.

### 6.4 Does the design need a saver at all?

**Yes, but only one thing needs it: `interrupt()`.** LangGraph refuses
`interrupt()` without a checkpointer (`GraphValueError: No checkpointer set`,
MEASURED), because the pause is implemented as "stop the superstep, persist,
return". If the loop never calls `ctx.interrupt()` — because human gates are
`ask_user_question` tool calls and subagent approvals are inbox messages — then
the graph can run with **no saver at all** and save 0.2 ms/invoke plus a class
of state bugs. Recommendation: ship `InTurnCheckpointer` enabled for
observability (`getState()` in tests, step traces), treat it as disposable, and
treat "graph cannot be resumed after a process restart" as **designed**, not a
gap.

### 6.5 Topology changes between turns

MEASURED: a paused thread resumed into a **recompiled** graph (a node replaced,
a channel dropped). So the user's "add/remove nodes on demand" is satisfiable
**between runs**, by compiling a new `StateGraph` over the same
`CheckpointSaver` — *provided channel names and versions do not change*. It is
**not** satisfiable *during* a run: `addNode` does not exist on a compiled graph,
and even `Command({goto})` requires compile-time `ends` declarations. The
"registry match picks a sub-graph" step therefore happens at `compile()` time,
once per pick, before the run starts — which is exactly when the user's proposal
needs it. `CompiledGraph.withTopology()` in `design/kernel.ts` is that seam.

### 6.6 The kernel port: `design/kernel.ts` ⇄ `design/runtime.ts`

`design/kernel.ts` has two layers:

- **Layer 1 — graph primitives** (`createGraph` / `addNode` / `addEdge` /
  `addConditionalEdge` / `addFanOut` / `compile` / `invoke` / `stream` /
  `CheckpointSaver` / `interrupt` / `DeterminismHooks`). Both the LangGraph
  adapter and the vendored fallback satisfy this; it is what a graph author
  writes against.
- **Layer 2 — the DSH-shaped port** (`KernelPortLike`, `KernelRunHandleLike`,
  `KernelResultLike`, `KernelCheckpointerPort`), which is the shape
  `design/runtime.ts` declares as `KernelPort`. `createLangGraphKernel(deps)`
  is a **real implementation**, not a stub.

The adapter takes `@langchain/langgraph` through a **structural port**
(`LangGraphSurface`) rather than importing it. Three benefits: `design/` and
`design/runtime.ts` stay dependency-free and unit-testable without the package
installed; the bundle performs the single `await import(...)`; and a version bump
is caught by one small file.

**MEASURED — `spikes/langgraph/kernel-conformance.ts` (end-to-end, real 1.7.0):**

```
[PASS] type + runtime: @langchain/langgraph@1.7.0 satisfies LangGraphSurface
[PASS] boundary 0: node=n1 superstep=1 atSeq=102
[PASS] boundary 1: node=n2 superstep=2 atSeq=102
[INFO] result kinds: boundary -> boundary -> done
[PASS] kernel drove TaskPlan -> StateGraph -> 2 boundaries -> done
```

That run compiles a real `TaskPlan` from `design/graph-schema.ts` into a
`StateGraph`, executes nodes through an injected `NodeExecutorPort`, reports one
boundary per node through `afterNode`, asserts `assertJsonSafe` on every
checkpoint write, and finishes. It is the closest thing to a vertical slice we
have without a DSH session.

**Cross-file contract (MEASURED, same file):**

```ts
const asRuntimePort: KernelPort = createLangGraphKernel(kernelDeps) // design/runtime.ts
```

compiles — so the object `design/kernel.ts` exports is assignable to the
`KernelPort` that `design/runtime.ts` declares.

The reverse direction also holds: `design/runtime.ts` imports
`DeterminismHooks, JsonUpdate, JsonValue, KernelError, NodeContext,
SuperstepBoundary` from `./kernel`, and `tsc --strict` on `runtime.ts` exits 0.
Both sides of the seam are verified.

Two deliberate couplings, both reported to the Lead:

1. `design/kernel.ts` re-declares the four port shapes (`KernelPortLike`,
   `KernelRunHandleLike`, `KernelResultLike`, `KernelCheckpointerPort`)
   locally instead of importing them from `design/runtime.ts`, so it stays
   checkable while that file is edited in parallel. The conformance assertion
   above is what keeps the duplicate honest; once `runtime.ts` is frozen the
   duplicate can be deleted and `KernelPortLike` aliased to `KernelPort`.
2. The kernel does **not** evaluate plan `Condition`s. `route()` is injected;
   the default is "first `control` edge, else `END`". Plan semantics stay in
   `design/`, which is what keeps the kernel swappable.

---

## 7. Interrupts: the rule

> **A node body must be pure up to its first `interrupt()` call. Human gates go
> in a tool call or at a node boundary. Never put a side effect before a pause.**

Why (MEASURED): resuming re-executes the node from the top — a fake model call
placed before `interrupt()` ran **twice** for one approved step. In a loop where
a node is a model step, that means a **duplicated model request**, which is both
a token-cost bug and a state bug (two `request/header` events for one step).

Concretely, in order of preference:

1. **Use `ask_user_question`** (`packages/interaction/tool-ask-user/src/index.ts`).
   It is an ordinary tool: the step makes the model request, the tool batch
   blocks, the UI answers, the result is appended as `tool/result`, the next
   step continues. No replay, no saver required, fully visible in the log and
   in `deriveMessages()`. This covers virtually every approval/interview gate.
2. **Terminal node boundary**: model a gate as `graph` ending at a node that
   returns `{status:'awaiting_human'}`; the loop ends the turn, and the answer
   arrives as a new user message (DSH inbox) that starts a new run. No
   `interrupt()` either — the *turn* is the pause.
3. **`interrupt()`** only for a pause whose node is *pure* (e.g. a decision node
   with no model call and no log writes). It is a convenience, not the primary
   mechanism, and the adapter must document the purity requirement at every call
   site.

This also settles the DSH mismatch: LangGraph's interrupt is a *process-local
continuation*; DSH's appropval flow is *an event in the log*. Option 1 keeps the
approval where DSH can see it, which is the whole point of the event-sourced
model.

---

## 8. Dependency and packaging decision

**Pin `@langchain/langgraph@1.7.0` exactly** alongside `@langchain/core@1.3.4`
and `@langchain/langgraph-checkpoint@1.2.2`; `zod@4.6.7` as a peer.

| Option | Verdict |
|---|---|
| **Dependency (chosen)** — `dependencies: { "@langchain/langgraph": "1.7.0" }` in the bundle | 65 MB install, ~130 ms boot, 19 packages. Acceptable for a feature bundle; the loop is the product. |
| Optional peer | Rejected. If the host does not install it, the loop cannot start; an agent loop without its kernel is not a degraded mode, it is broken. |
| Vendored clone (~400 LOC) | Kept as a **fallback** (§9), not the default: it would have to re-implement retry/timeout policies, subgraph namespacing, streaming modes, checkpoint versioning and the `Send`/`Command` protocol — all of which the spike shows working. |

Packaging specifics (`docs/user/develop/basic/publish.md`):

- The bundle declares `dsh.bundle` + `cordis.patch.yml`, and its patch **replaces** row `agent-loop` by id (`packages/bundle/base/cordis.patch.yml:513`) — restating every key the row needs, because a patch replaces `config` wholesale.
- Keep LangGraph under `dependencies` (it is an independently versioned third-party package, which is exactly the rule the doc gives for `dependencies` vs `peerDependencies`); keep `@deepseek-ai/dsh-*` under **both** `peerDependencies` and `devDependencies`.
- Set `engines.dsh` (e.g. `>=0.2.0 <0.3.0`) so the bundle refuses to install on an incompatible host.
- Installation: `dsh plugin --profile <name> add ./dsh-graph-loop-bundle` (or a `pnpm pack` tarball). The 65 MB are installed into the **profile**, not into DSH — the DSH checkout stays untouched.
- ESM only: the bundle is `"type": "module"` and must never `require()` LangGraph (§1.1). Add the startup assertion.

**Version churn**: LangGraph is on v1.x after the 0.x → 1.0 stabilisation; the
spike pinned 1.7.0 and its API surface relevant to us (`StateGraph`,
`Annotation`, `MemorySaver`, `BaseCheckpointSaver`, `interrupt`, `Command`,
`Send`) is the stable core. Mitigation: the adapter is the only file that
imports the package, the kernel interface has no LangGraph types, and the
conformance map at the bottom of `design/kernel.ts` is the upgrade checklist.

---

## 9. Kill criteria and fallback

Abandon LangGraph for the vendored `MinimalKernel` (§400 LOC, same
`design/kernel.ts`) if **any** of these becomes true:

1. **A DSH-required behaviour cannot be expressed.** Specifically: superstep
   boundaries cannot be made to coincide with `step/start`/`step/end` without
   double-logging; or a node cannot be prevented from writing session events
   before the boundary commits.
2. **State cannot stay JSON.** If the loop needs a non-JSON value in state
   (streaming buffers, class instances) in a way that cannot be projected into
   `messageId` references — because then the checkpoint/log split rots.
3. **Interrupt replay is unavoidable in the critical path.** If a design change
   forces `interrupt()` *inside* a model step (so the model request is
   re-issued), the cost model breaks and we must own the pause semantics.
4. **Upstream breaks the pinned surface** without a migration path for two
   consecutive minors (e.g. `BaseCheckpointSaver` shape, `Annotation`,
   `Command`), or drops Node 26/ESM.
5. **Install/boot budget is exceeded**: > 100 MB installed for the kernel, or
   > 300 ms cold-start, on the target machine.
6. **A security review rejects `langsmith`/`js-tiktoken` as hard
   import-time dependencies**, even though they are not loaded on a code path we
   use and make no network call (MEASURED 0 fetches).

The fallback is scoped, not a rewrite: the graph authors and the loop's node
bodies are written against `design/kernel.ts`, so swapping the adapter does not
touch them. That is why the interface exists on day one rather than after a
second implementation.

---

## 10. LangGraph features we would NOT use (and why)

| Feature | Why not |
|---|---|
| `RemoteGraph`, `langgraph-sdk`, LangGraph Platform/Studio deployment | We run in-process inside a DSH profile; server deployment is a different product. The SDK is installed as a transitive dependency and never imported. |
| `MessagesAnnotation` / `messagesStateReducer` / chat-model `streamMode:"messages"` | DSH owns message history and token streaming (`AssistantStreamAttempt`, `agent/assistant-stream`). Reusing LangGraph's message channel would create a second transcript that `deriveMessages()` cannot see (C3). |
| `BaseStore` / `InMemoryStore` (long-term memory) | DSH has `ctx.sessionQuery`, projections and session persistence. A second memory store would fork the source of truth. |
| LangSmith tracing / `LANGCHAIN_TRACING_V2` | Off by default (MEASURED). We keep it off: session events are the trace, and shipping prompt text to a third party without explicit consent is not acceptable for an agent harness. |
| `DeltaChannel` / `Overwrite` / per-node `cachePolicy` / `CachePolicy` | Not needed for a per-turn loop; caching model steps would be a correctness hazard. |
| `RetryPolicy` beyond `maxAttempts`/`retryOn` (backoff tuning) | DSH already has request-error retry semantics (`agent/request-error`); the adapter maps one to one and does not duplicate the policy. |
| `interruptBefore` / `interruptAfter` as the approval mechanism | Replaced by `ask_user_question` (§7). Kept in the interface for tests only. |
| `withTopology` at runtime (mid-run) | Not possible in LangGraph (`addNode` absent on a compiled graph) and not needed: topology changes happen between runs (§6.5). |
| `getStateHistory`/`updateState` as user-facing fork | DSH fork is `session.fork` over the log. LangGraph time travel is a debugging tool only. |
| Zod schemas as the state definition (`StateSchema`) | Works, but `Annotation` is simpler and the JSON guard (C1) is the real validation we need. Zod stays a peer dependency because `interrupt({responseSchema})` uses it. |

---

## 11. What this spike does **not** prove

- **No real LLM call inside a node.** The node bodies are synthetic; the
  adapter's `ctx.llm.stream` wiring is designed, not measured. Next step: run
  the factory against `packages/test-support/llm-replay`.
- **No session-log integration.** The `afterNode` → `session.append` seam is
  designed against `agent.ts:354` and exercised with a stub, but not against a
  real `Session`.
- **No KV-cache measurement.** Whether sub-graph selection actually saves tokens
  is task-2's question, not this one; this document only establishes that the
  kernel does not *add* cost (0.2–0.5 ms/invoke).
- **No multi-agent fan-out test.** Child-agent fan-out is designed (§5.3), not
  measured.
- **Tool executor integration** (`ctx.tools.execute` with a `ResolvedToolSet`,
  `agent.ts:583-587`) is not exercised.
- **Parallel supersteps.** `buildLangGraph` emits one conditional edge per node
  and computes `siblings` for subagent nodes, but a parallel superstep has not
  been run end-to-end; `Send` fan-out is only proven at the LangGraph level
  (§2, §3).

---

## Appendix A — reproduce

```sh
cd spikes/langgraph
npm install            # @langchain/langgraph@1.7.0, @langchain/core@1.3.4, zod@4.6.7
node run-all.sh        # writes output.txt (sections 0-13 + Send diagnosis + telemetry)
```

Files: [`spike.mjs`](../spikes/langgraph/spike.mjs) (15 sections),
[`probe-send.mjs`](../spikes/langgraph/probe-send.mjs),
[`probe-telemetry.mjs`](../spikes/langgraph/probe-telemetry.mjs),
[`probe-loader.mjs`](../spikes/langgraph/probe-loader.mjs),
[`spike-results.json`](../spikes/langgraph/spike-results.json),
[`kernel-consumer.ts`](../spikes/langgraph/kernel-consumer.ts) (proves
`design/kernel.ts` type-checks for a real loop state).

## Appendix B — DSH evidence index

| Claim | Evidence |
|---|---|
| Factory seam to implement | `packages/core/agent/src/index.ts:175-210` |
| `setFactory` throws if already registered | `packages/core/agent/src/index.ts:383-392` |
| Loop mounted as row `agent-loop` | `packages/bundle/base/cordis.patch.yml:513` |
| Turn loop (`turn/start`, `step/start`, `step/end`, `turn/end`) | `packages/core/agent-loop/src/agent.ts:320-428` |
| Step = one model request + one tool batch | `packages/core/agent-loop/src/agent.ts:428-601` |
| Serial steps, parallel tool batch | `packages/core/agent-loop/src/agent.ts:581-585` |
| Interrupted turns are closed on restore | `packages/core/session/src/repair.ts:209`; `packages/core/agent-loop/src/index.ts:801-806` |
| Human gate is a tool that resumes in-turn | `packages/interaction/tool-ask-user/src/index.ts:1-6` |
| `ctx.storageDomain` pattern for a sidecar table | `packages/experimental/claude-code-mods/src/host-ops.ts:170` |
| Bundle/profile packaging rules | `docs/user/develop/basic/publish.md` |
