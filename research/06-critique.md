# 06 — Red-team review of `docs/explore-mode-plan.zh.md`

> Snapshot reviewed: `md5 52f6a295039b52443d2c432eac72679f`, 861 lines, 2026-11-05 22:34.
> The plan changed throughout this review (521 → 861 lines); quotes were re-checked at this snapshot,
> section numbers are stable anchors, line numbers are omitted because they drift. Method: read the
> plan; re-read `research/00–05`, `design/*`, and re-ran every DSH citation against the read-only
> checkout `22ddee3792` (v`0.2.1-rc.3`). Severity: **BLOCKER** = misleads the user or blocks P2/P3;
> **SHOULD-FIX** = wrong/unsupported but not structural; **NIT** = wording/detail.

## Verdict

The seam work is strong and the core architecture is defensible: `agent-loop` really is one row
(`packages/bundle/base/cordis.patch.yml:513`), `setFactory` is exclusive
(`packages/core/agent/src/index.ts:383-385`), a preset cannot replace the host loop
(`agent-preset-registry/README.md:56`), and `design/conformance.ts` is a genuinely executable
contract. But the plan is **not yet safe to show the user** in three places: the token economics
are internally inconsistent, the package-count answer changed units mid-document, and the
P2/P3 contracts do not match the real APIs. The §4.11 agent-reuse answer is a good diagnosis
of the user's latest question, but it does not yet fix the observed behavior.

---

## 1. Numerical consistency

### 1.1 Break-even: “260–2,218” vs “~120” is two different price assumptions, and 120 is the optimistic one — BLOCKER

Plan quotes: intro and §1.3 “实测要 **260–2,218 步**才回本” / “实测盈亏平衡”;
§4.9 “按 live profile … 实测公式：**260–2,218 步**；按图形设计里的**保守参数**
（P=30k、ΔS=2.25k、hit ratio 0.1）：**~120 步**”.

Evidence:
- `research/04-tokens.md:223` uses `T* = (1−ρ)(P+H)/(ΔS·ρ)`, with **ρ = 0.02** (“hit:miss = 1:50”,
  `:129-131`). Scenarios at `:229-231`: **S1 946** (ΔS 2,545, P+H 49,150), **S2 2,218**
  (ΔS 3,354, P+H 151,848), **S3 260** (ΔS 28,600 = a 2-tool subset, P+H 151,848).
- `design/measurements.md:63-66` derives **120** with **c = 0.1**, P = 30,000, ΔS = 2,251, and
  explicitly labels `c = 0.1` **ESTIMATE — verify with the token-economist**.
- `research/02-graph.md:42` repeats “~120” while calling the pricing “DeepSeek-like”; that is
  inconsistent with `04-tokens`' 1:50, and `02-graph.md:532` then treats 120 as settled.

Correction: c = 0.1 is **5× more favorable to gating** than the measured 1:50 (0.02), and the 120
input P = 30,000 is below the measured fixed prefix alone (35,095) and far below the P+H values
(49,150–151,848) in `04-tokens`; it is an **optimistic best case**, not a “保守参数”:
- c = 0.1, P+H = 49,150 → **197** steps, not 120.
- c = 0.02, P = 30,000 → **653** steps; c = 0.02, P+H = 49,150, ΔS = 2,251 → **~1,070**;
  with the design's ΔS = 2,545 → **946** (S1).
The realistic range is **946–2,218**; 260 exists only for the extreme “drop to 2 tools” case. The
plan should print the S1/S2/S3 table with ΔS and P+H, drop 120 or label it “旧假设 / 乐观上界”,
and change “实测公式” to **DERIVED** (inputs measured, output arithmetic).
Also: “亏损 6–55×” (`:404`) is S1/S2/S3 against a 40-step task (24×/55×/6.5×); the 120 case is 3×
at 40 steps and 1.4× at 86, so it cannot be used with the 6–55× claim.

### 1.2 LangGraph size — SHOULD-FIX

Plan: “安装 65MB/19 包” (§4.4), R6 “65MB”, K6 “>100MB”. Correct, but under-specified:
`research/03-langgraph.md:26-29` measures **4.4 MB / 636 files for `@langchain/langgraph` alone**,
**65 MB for the isolated tree** (`langgraph + @langchain/core + zod`; js-tiktoken 21 MB, core 13 MB,
zod 8.1 MB, langsmith 7.6 MB, sdk 7.0 MB, langgraph 5.9 MB), **19 installed packages** (26 `npm ls`
entries minus 7 optional peers). Say which scope the number is, and that the profile delta after
pnpm dedupe may differ. K6's 100 MB threshold leaves only 35 MB headroom; state that.

### 1.3 Package count: four different answers to the user's Q2 — BLOCKER

Current text:
- Q2: “直接替换 **2 个包**（2,333 行源码），**41 个包**必须保持契约不变，**25 个包**原样复用，
  **1 个包**和 **5 类工具面**退役”.
- §3.1: same, plus “NEW **2–3 个 npm 包 / 8 个逻辑模块**”; §3.3 heading says the same.
- §5.2: “**一个包、多个 subpath 插件**：`@dsh/explore-loop` … profile 里只装一个包”.
- R9 still: “团队维护成本（**8 个新包**）”.
- §4.2–4.5 headings and the P0/P2 deliverables still name `@dsh/graph-registry`,
  `@dsh/graph-kernel`, `@dsh/graph-agent-loop` — none exist in `bundle/`; the installed package is
  `@dsh/explore-loop` with `./registry`, `./router`, `./runtime`, `./tools`.

Correction: one table, one answer: **2 fork** (`dsh-agent-loop`, `agent-loop-testkit`), **1 retire**
(`ui-settings-agent-loop`), **41 keep-contract**, **25 reuse**, **2–3 npm packages / 8 logical
modules** (the bundle is one package with subpath exports today). Then rewrite P0/P1/P2 file lists
to `@dsh/explore-loop/registry|router|runtime|tools` or explicitly say “these are module names,
not package names”. Delete “8 个新包” from R9.

### 1.4 Keep-contract counts are not the cited table — SHOULD-FIX

§3.4 says “**41 个包** … 完整表见 `research/01-seams.md` §6.3”. That table has **25 rows** and sums
to ≈**27.9k** LOC, not 41 / 47,545. Meanwhile §2.2 says 91 packages depend on `dsh-agent` and 145
on `dsh-session`. These are three different blast-radius denominators (code unchanged vs contract
consumers vs source importers); the plan never reconciles them. Also “131,661 行测试” has no
method/citation and the adjacent “17k 行” is wrong (below). Add a generated appendix with the 41
rows and a script, or drop the precise totals.

### 1.5 Smaller numeric errors — SHOULD-FIX / NIT

| Claim | Plan | Correct (evidence) | Severity |
|---|---|---|---|
| agent-loop tests | “17k 行” (P2, §7.1) | **15,108** TS lines / 29 files; 15,146 all files (`find packages/core/agent-loop/tests`) | SHOULD-FIX |
| cacheReadRatio baseline | “0.984（中位）” (§8.1) | 0.984 is **W2**; four-session median is **0.985** (`04-tokens.md:93-98`) | NIT |
| “每步平均 prompt 151,848” | §8.1 MEASURED | DERIVED: 10,477,530 / 69 (`04-tokens.md:96`) | NIT |
| `ui-settings-agent-loop` LOC | 314 | **273** `src/*.ts`; 314 is not the src count | NIT |
| package total | 363 | **363** `packages/*/*/package.json` — correct, keep the method | — |
| fork LOC | 2,122 | correct (738+837+232+169+140+6) | — |
| template count | P2 “4 个模板”; §4.3 lists 8 ids; design has 7 (incl. `t_stock`); 02-graph says “six” | pick 4 of 6 and say so; publish the 6-template library as an artifact | SHOULD-FIX |

---

## 2. Claims stronger than evidence

The header promises “所有数字标注 MEASURED / DERIVED / ESTIMATE”. That is not true: §4.9 and §8.1
are unlabelled, and §8.1 is titled “MEASURED” while mixing DERIVED numbers. All rows below are **SHOULD-FIX**.

| Plan claim | Wording | What the evidence is | Correct label |
|---|---|---|---|
| 68-step task, 2–4 nodes saves 24–28% | §4.5 “**实测** 68 步任务拆 2–4 节点省 24–28%” | `04-tokens.md:272-282` is a **DERIVED** model calibrated to W1–W4, not a run | DERIVED |
| break-even 260–2,218 | “**实测**公式” | arithmetic on measured prices/prompts | DERIVED |
| clean `standard` 9,150 → explore 7,046 (−23%) | §4.9 rule 2 | `04-tokens.md:340-343`: §3 preset comparison is **DERIVED** from per-tool bytes; the explore preset does not exist yet | DERIVED/ESTIMATE |
| crafts removed: 35,095 → ~7k (−80%) | §4.9 rule 2 | craft removal alone ≈ **10.4k** (35,095 − 24,673); ~7.07k requires **also** the lean explore preset (31,741 − 24,673) | ESTIMATE, show both cuts |
| “无准确率回退 / 成功率不低于 baseline” | P1/P3 acceptance | targets, no baseline accuracy on the 8-task bench | target, not result |
| “3 组可运行 PoC” implies a working graph loop | header | `03-langgraph.md:455-473`: no real LLM call in a node, no session-log integration, no tool executor, no fan-out; the vertical slice is unproven | say “seam + kernel + token PoCs; integration unproven” |

The architecture conclusion (“图循环的正当性是能力 + 长任务成本，不是 instruction 组装”) is a
reasonable **hypothesis**, not a measurement; say the P2/P3 gates exist to test it. The negative
claim (per-step gating loses) is well supported and should stay.

---

## 3. P2/P3 implementation blockers

| # | Finding | Evidence | Plan status / required fix |
|---|---|---|---|
| 3.1 | **BLOCKER** — `startActivation` call shape in §4.5 is wrong | Real type is `{provider, label, request:{parent, prompt, signal, agentPreset?, agentOptions?, outputSchema?, maxDepth?}, delivery}`; `label` is required (`subagent/src/types.ts:31-46`), mirrored in `design/runtime.ts:132-158`. Plan writes a flat `{provider, parent, prompt, …}` | Fix the signature in the plan; add a compile-only fixture against `SubagentsPort` |
| 3.2 | **SHOULD-FIX** — handoff limit name/units | Plan §4.5 says `maxHandoffChars`; design is bytes: `GRAPH_STATE_LIMITS.maxHandoffInputBytes = 16 KiB`, `maxHandoffOutputBytes = 8 KiB` (`graph-schema.ts:513-520`); `buildHandoffPrompt` returns `bytes` (`runtime.ts:380`) | Rename and state “fail, never truncate” in bytes |
| 3.3 | **BLOCKER** — subagent nodes cannot ask/approve | `captureDelegatedPolicyOverrides` pins `approvalPolicy: 'never'` (`subagent/src/child-agent.ts:243-253`); child docs say approval-requiring operations are rejected (`:173`). C4 says prefer `ask_user_question`, but that only works in the parent session | State: gate nodes must run in the parent; subagent presets must exclude `tool-ask-user` and approval-requiring tools, or P3 will fail on approval tasks. R10 “审批走父 inbox” needs this rule |
| 3.4 | **BLOCKER** — startup self-check is not implementable as promised | Plan §2.3 says “explore profile 必须自带启动自检（见 §6 P2）”; P2 has no such task/test. `AgentRegistry.requireFactory` is **private** (`core/agent/src/index.ts:402-406`); no public has-factory probe. If the disable patch is skipped by the `name` guard (upstream rename), the graph row's `setFactory` throws, the graph row goes inactive, and the **stock loop silently keeps running** | Move the check to composition time (`bundle/verify/verify.sh`, `--dump-config`) and make it a release gate; add a visible diagnostic. Do not promise a boot-time check that the public API cannot do |
| 3.5 | **BLOCKER** — graph modes and default are wrong in one of the two docs | Plan §5.2: `off → observe → shadow → active`, “默认 `mode: observe`”. Design: `GraphMode = 'off' \| 'observe' \| 'stock' \| 'explore'`, `DEFAULT_GRAPH_CONFIG.mode = 'explore'` (`design/runtime.ts:462,480-486`); `bundle/b-loop/cordis.patch.yml` sets `mode: observe` | Pick one enum. If the design default is used by the implementation, a fresh install is **active**, contradicting the safety claim. Add a test that `DEFAULT_GRAPH_CONFIG.mode === 'observe'` |
| 3.6 | **SHOULD-FIX** — `inbox`/projection re-registration not scheduled | `inboxProjectionDefinition` is exported only from `inbox.ts:26`, not the package root (`agent-loop/src/index.ts:203` exports only `DEFAULT_MAX_PARALLEL_TOOL_CALLS`); export map is root-only (`agent-loop/package.json:19-24`) | The fork is acknowledged, but P2 deliverables do not list re-registering `inbox` + `modelSelection` (and checking `turnBoundary`, registry-owned) or a projection golden test. Add them |
| 3.7 | **SHOULD-FIX** — settings namespace == profile entry id | `SettingsForms.describe()` keys forms by `entry.options.id` (`settings/src/index.ts:300,315,327`). With row id `graph-loop`, the stock card (which waits on `agent-loop`) hides — the plan says this correctly in §5.3. But §5.2's YAML comment “保留 stock 配置键，设置卡/overlay 兼容” is false: keeping `maxParallelToolCalls` in `graph-loop` does not create the `agent-loop` namespace | Delete the comment or keep the row id `agent-loop` (and own the duplicate-id hazard from `vendor/loader/src/config/tree.ts:51-73`). Also name the graph settings namespace (`graph-loop`) and the card’s owner |
| 3.8 | **SHOULD-FIX** — cross-loop session resume is asserted, not tested | Plan §5.3 says old sessions replay and the new turn uses the graph loop; §7.2 says “跨 profile 打开” only. A stock-written session has never been resumed by a different `AgentFactory` | Add a fixture: stock `web` session → `explore` profile → `resume` → first graph turn; assert C01–C16 and a fork. The current “B 的 session 是 profile-locked” note is honest for the reverse direction, but this direction is the actual migration path |
| 3.9 | **SHOULD-FIX** — JSON guard is weaker than C1 claims | C1 says the adapter validates **every** checkpoint write and strips `__pregel_*`. Design has `assertJsonSafe` (`graph-schema.ts:523`) and a kernel `validateJson` option explicitly “**Off in production**” (`kernel.ts:290-291`); no `__pregel_*` strip hook exists in `design/*.ts` | Define dev-only vs always-on, add a `sanitizeCheckpoint`/strip hook to the kernel port, and a test that a `Date`/`Map`/`__pregel_tasks` payload is rejected/stripped |
| 3.10 | **SHOULD-FIX** — `ask_user_question` inside a child is unspecified | `user-questions` queues replies **per session** (`interaction/user-questions/src/index.ts:96-130`); whether the Web client surfaces a child session’s question is not stated. If the child preset has the tool, the parent may wait on an unanswerable question; if it does not, a subagent node cannot gate | Declare gate nodes parent-only (same as 3.3) and exclude the tool from subagent presets |
| 3.11 | **SHOULD-FIX** — reuse of a **running** agent steers into its current turn | `send_message` “A running target receives it at the nearest step boundary” (`tool-agent-team/src/index.ts:222-233`); “inactive” is only “no turn is executing” (`:240`) | Define reuse only for `status === 'inactive'`, re-check immediately before send, and handle `provisioning`/`failed`. The current “一个 agent 同时只能跑一个 turn” does not prevent contamination |
| 3.12 | **SHOULD-FIX** — P2 package names / file layout do not match the bundle | P2 says `@dsh/graph-agent-loop`, `agent-loop/{factory,turn,…}.ts`, TS; `bundle/b-loop` is `@dsh/explore-loop` with `.js` skeletons (`package.json`, README: “deliberately skeletons”) | Align the P2 deliverable with the shipped skeleton, or state “the skeleton is JS; P2 replaces it with TS” |

Not blockers (verified): `agent-loop` internals sealed (fork acknowledged), `ui-settings` auto-hide
(§5.3 correct), `required-id` disabled-is-ignored (`app-boot/src/index.ts:1140`; the “no agent factory
registered” error is real at `core/agent/src/index.ts:213`), `tool-cordis` catalog (§5.3 notes it),
preset-session `agent-preset/not-found` (`agent-preset-registry/src/index.ts:252`).

---

## 4. Actionability for an engineer who has not read the research

**P0 can start** from the plan: `ctx.tools.definitions()` / `schemas()` (`core/tools/src/index.ts:305,316`),
`ctx.skills` (`super(ctx,'skills')`, `skill/src/index.ts:374`), `systemPrompt`, presets, `tools/change`.
Missing: the snapshot/digest schema, the “digest changes on X” event table, and a 50 ms harness.

**P1 can start** the router: `design/matching.ts` has fingerprint/templates/score/calibrate. Missing:
- a **template library artifact** (the YAML has 7 templates; there is no TS loader in `design/`);
- the 40-task annotation set — `bench/tasks/tasks.jsonl` has 8 tasks;
- the two confidence thresholds (`absMin 0.55`, `marginMin 0.08` in `matching.ts:310`) vs the
  single `confidenceThreshold: 0.55` in the bundle patch;
- **executor/agent binding types** (see §5): `SlotSpec` has `choose: readonly string[]`,
  `Binding` is `{slot, tool}` (`matching.ts:266-269,315-320`), and `instantiate()` binds
  `candidate.tool?.name ?? candidate.id` — there is no place to put `reuse(agentId)`.

**P2 cannot start reliably as written.** There is no `AgentFactory` skeleton or mapping from
`CreateAgentOptions`/`ResumeAgentOptions`; no event-append adapter (C01–C16 is a test spec, not an
implementation contract); no projection re-registration list; the mode enum and package names
disagree; the bundle is JS skeletons while P2 names TS files. Add one **vertical slice** before fork
parity: `createAgent → one turn → one step → step/end → turn/end` against a mock LLM, with
C01/C02/C04/C07 asserted, and a `resume` of that session. The fork suite only proves compatibility
after it.

**Rollout/rollback** is good: profile switch, `mode: observe`, `verify.sh`, `engines.dsh`. Missing: a
runtime toggle (mode is row config, so switching needs a restart), a user-visible canary flag, and
the LangGraph single-copy assertion (`03-langgraph.md:39`) + install/boot budget (`>100 MB` /
`>300 ms`) as P2 gates.

**Test fixtures** missing: 40-task annotation set (P1), golden traces for resume/fork/compaction
(P2), a 4-profile smoke (`web/headless/acp/sdk` — `sdk-minimal` is a fifth template), an
approval-required task (P3), and an MCP dynamic-tool fixture (P0). `design/conformance.ts` (16
preserved C01–C16 + 8 deliberate D01–D08) is the right manifest; the plan references it, but
`design/measurements.md` and `conformance.ts` are still absent from Appendix B.

**Observability contradiction** — SHOULD-FIX: §4.10 registers a `graphRun` **session projection** but
also says graph events are “进程内、不落盘”. A projection is a pure fold over committed session events
(`01-seams.md` #19); with no durable graph events it cannot show a node sequence after reload. Either
say the view is live-only (fold `step/*` + `tool/*`) or log a small durable projection input. Also
`02-graph.md:13.6` advises **not** making `graph_status` a model-facing tool; §4.10 does. Pick one.

---

## 5. Agent reuse — does the plan answer the user's latest question?

The diagnosis in §4.11 is correct: `spawn_teammate` takes only `name/description/prompt/context`
(`tool-agent-team/src/index.ts:193-207`); `list_agents` returns identity/role/status/description/
provider/context/model/diagnostics — no task history or success rate (`agent-team/src/types.ts:59-69`;
diagnostics are only error strings, `roster.ts:135,153`); tasks are unowned at creation;
`send_message` wakes an inactive member (`:222-233`); the Lead can always spawn instead. But the
proposed fix does **not** yet address the observed behavior:

1. **No enforcement point — BLOCKER.** `suggest_executor(task)` is another advisory tool; the same model that
   chose to spawn can ignore it. The cheap, source-free fix is a `tools.guard` /
   `tools/pre-execute` intercept on `spawn_teammate` (public seams, `01-seams.md` #8;
   `core/tools/src/index.ts:384`) that rejects the spawn with the idle candidate list, and/or a
   `systemPrompt.context` roster injection each step. Neither is in P1's deliverables.
2. **No data model — BLOCKER.** `RegistryNode` has no live-agent status/history (`graph-schema.ts:200-230`);
   `CapabilityKind` has `'agent-role'` and `source.registry` includes `'agents'`, but there is no
   `AgentFacts`, no `reuse` binding, and `RouteWeights.terms` has no executor/affinity term
   (`matching.ts:292-313`). The claim “和工具槽位同构” is false at the type level: `Binding` is
   `{slot, tool}`. P1's `router/executor-match.ts` needs new types, a new registry source
   (`ctx.agentTeams.listMembers` + `agent/created`/`agent/disposed` or team roster changes), and
   a cold-start policy.
3. **Wrong pool — BLOCKER.** Graph subagent nodes use `ctx.subagents.startActivation` with the `spawn`/`fork`
   providers — always a fresh child; there is no idle pool. Idle agents exist only as Agent Teams
   members, whose six tools §3.5 **retires**. If retired, the user's “Lead spawns a duplicate”
   scenario disappears in explore (no model spawn), but the graph loses the roster; if kept, the
   graph must bind to the team roster. §4.11 item 4 says “ctx.agents/ctx.agentTeams.sendMessage or
   ctx.subagents.sendMessage”; `ctx.agents` is a registry, not a messaging API — pick one pool.
4. **Cold start defeats the score — SHOULD-FIX.** New teammates have empty `history{completedTasks,…}`; the first
   reuse decision has only `name/description`, which is exactly the weak signal the plan rejects
   for tools. State a rule: reuse only within the same team/product line, or after a completed task
   with a matching artifact; do not promise a learned affinity before N tasks.
5. **Metrics are not in the bench — SHOULD-FIX.** `spawnsPerTask`, `reuseRate`, `duplicateOrientationTokens`,
   `timeToFirstToken` are absent from §7.3 and `bench/schema/results.schema.json`; P1's “重复 spawn
   率下降 ≥30%” has no fixture or baseline. Add a two-task shared-product-line scenario + schema.
6. **Scope honesty — SHOULD-FIX.** The observed Lead runs in the stock `web` profile, not `explore`; the graph fix
   lands in P1/P3. Today's answer is “guard + roster visibility in the existing Agent Teams surface,
   then the graph”. Without that, §4.11 reads as a fix that is already available.
7. **Race — SHOULD-FIX.** Status can change between match and send; reuse must re-check `inactive` and handle
   `provisioning`/`failed` (`list_agents` semantics), and a running target is steered, not queued.

Bottom line: §4.11 is a good future design but does not fix the observed behavior yet; it needs a
deterministic enforcement point, an agent-binding type/roster source, and a bench metric first.

---

## Top 5 changes before showing the user

1. **Replace the 120 / 260–2,218 story with one assumptions table**: S1 946, S2 2,218, S3 260;
   measured ρ = 0.02 (1:50); the old 120 used c = 0.1 and P-only and is the optimistic best case, not
   “保守”; label it DERIVED. Fix “实测” in the intro and §4.5's 24–28% (DERIVED model).
2. **Make the package answer one answer**: 2 fork + 1 retire + 41 keep + 25 reuse + 2–3 npm
   packages (8 modules); rewrite R9, §3.3/§5.2, and P0/P1/P2 names to `@dsh/explore-loop/<subpath>`;
   replace the 17k test line with 15,108.
3. **Fix the P2/P3 interface contract**: nested `startActivation({provider, label, request, delivery})`,
   bytes not `maxHandoffChars`, one `GraphMode` enum with default `observe` (not design's `explore`),
   child approval `never` ⇒ gates parent-only, and a `sanitizeCheckpoint` hook for `__pregel_*`.
4. **Add an enforceable agent-reuse fix now**: `tools.guard`/`pre-execute` on `spawn_teammate` +
   roster `systemPrompt.context`; then new `AgentFacts`/`AgentBinding`/`executorAffinity` types and a
   `ctx.agentTeams` registry source; add `spawnsPerTask`/`reuseRate` to the bench. Do not claim P1
   reuse until it is measured.
5. **Replace the boot-time self-check with a composition gate**: `verify.sh` / `--dump-config`
   assertion that `agent-loop` is disabled and `graph-loop` is present and active, plus a visible
   diagnostic for the silent-stock fallback (`requireFactory` is private; the name guard can skip).
