# 04 — Token & cache economics of the DSH loop

**Question.** Does "match a sub-graph and add/remove nodes" cut instruction assembly and token
consumption enough to justify replacing the stock loop with a LangGraph kernel?

**Short answer.** The *token count* of a request can be cut a lot; the *bill* barely moves, and
the mechanism the proposal names (dynamic per-node tool gating) is the one that costs money.
Two smaller mechanisms survive contact with the data: a lean preset chosen once per session,
and — only for long tasks — subagent nodes that stop the parent from accumulating history.
Numbers below; every one is labelled.

---

## 1. Method and labels

| Label | Meaning |
|---|---|
| **MEASURED** | Read from a real DSH session log written by the stock loop: `request/header.tools` (exact wire schemas), `system/message` text, `assistant/message.usage` (provider billing counters). |
| **MEASURED-DERIVED** | Those exact bytes/chars priced with DSH's own token heuristic (`chars/4` + fixed overheads). |
| **DERIVED** | Arithmetic on measured inputs (billed units, break-even steps, cost in USD). |
| **ESTIMATE** | A number whose *inputs* were not on the wire (preset surfaces reconstructed from YAML + summed measured tool bytes; unmounted tools sized from `docs/tool-catalog.md`). State of the art would be a live run of that preset. |

The token heuristic is not a guess: `packages/llm/token-meter/src/estimate.ts:12-19` fixes
`CHARS_PER_TOKEN = 4`, `BLOCK_OVERHEAD = 4`, `ROLE_OVERHEAD = 4`, and
`:117-122` prices the whole tool array as `ceil(JSON.length / 4) + 4`. The same file is the
`ctx.tokenMeter` implementation, so these are the harness's own numbers, not mine.

**What was measured.** Five real sessions from the live web profile (four with provider usage,
plus one headless control run), and one headless run repeated against a keyless mock wire
server (`packages/test-support/llm-mock-server`, Anthropic-Messages compatible, no API key).
The mock run proves the loop and the log; its usage counters are synthetic (`input_tokens: 3`),
so every token number from it is labelled heuristic. `packages/test-support/llm-replay` was not
needed: replay requires a recorded fixture and still yields no real usage, so it would not have
improved on the live logs.

---

## 2. Baseline: what one stock request contains

### 2.1 System prompt — 20,237 chars ≈ 5,064 tokens (MEASURED / MEASURED-DERIVED)

One `system/message` node, rendered once and kept byte-stable (that stability is the whole
cache story in §4). Sections are joined by blank lines, so the paragraph split is the section
split. Ownership is attributable because each tool package owns its own guidance section:

| Section owner | chars | % | tokens |
|---|---|---|---|
| Craft tool guidance, 14 families (`cadcraft_*` … `wordcraft_*`) | 12,621 | 62.4% | 3,156 |
| Agent Teams (`packages/experimental/tool-agent-team`) | 1,845 | 9.1% | 462 |
| `present` guidance | 1,305 | 6.4% | 327 |
| Web-surface context (`packages/context/harness-dev-context`) | 1,002 | 5.0% | 251 |
| goal guidance | 528 | 2.6% | 132 |
| working-directory context | 407 | 2.0% | 102 |
| jobs guidance | 382 | 1.9% | 96 |
| web guidance | 365 | 1.8% | 92 |
| subagent guidance | 265 | 1.3% | 67 |
| workflow guidance | 325 | 1.6% | 82 |
| fs/fs-search guidance | 598 | 3.0% | 150 |
| identity + persona (107), bash (92), runtime context (325) | 524 | 2.6% | 131 |
| section text total | 20,167 | — | — |
| blank-line separators between 36 sections | 70 | — | — |
| **rendered prompt** | **20,237** | | **5,064** |

The `personaPrefix` alone is 107 chars. **Instruction assembly is not the problem: 62% of the
system prompt is product-catalog text for 14 document applications.**

### 2.2 Tool schemas — 160 tools, 120,108 bytes ≈ 30,031 tokens (MEASURED)

Exactly what shipped in `request/header.tools` on the wire, in the user's live profile
(`standard` preset + agent-team bundle + 14 craft plugins):

| Group | tools | bytes | % of schema |
|---|---|---|---|
| Craft families (`*craft_commands`, `_run`, `_mcp_*` …) | 122 | 86,070 | 71.7% |
| Standard preset surface | 32 | 30,287 | 25.2% |
| Agent Teams | 6 | 3,751 | 3.1% |
| **total** | **160** | **120,108** | **30,031 tok** |

Largest single schemas: `workflow` 3,389 B, `schedule_create` 3,143 B, `plugin_manager` 2,675 B,
`bash` 2,280 B. The catalog is generated from a real boot of every tool plugin
(`docs/tool-catalog.md`, `scripts/gen-tool-catalog.ts`), so it is a citable inventory — but
deployed config adds fields (e.g. `subagent` gains `modelSelection`/discovery, `bash` gains a
managed-environment paragraph), so wire bytes run up to ~25% above catalog bytes. Preset
numbers below use wire bytes wherever the tool was mounted.

**Fixed prefix = 5,064 + 30,031 = 35,095 tokens, resent on every step.**

### 2.3 Per-step resend — the growing term dominates (MEASURED)

Four live sessions, provider usage (`cacheReadTokens` are re-read prefix tokens, `missTokens`
are first-time tokens):

| Session | steps | step 0 prompt | last step prompt | prompt total | cache-read | hit ratio |
|---|---|---|---|---|---|---|
| W1 | 48 | 38,007 | 127,848 | 4,234,519 | 4,175,104 | 98.6% |
| W2 | 69 | 37,235 (cold) | 222,628 | 10,477,530 | 10,312,448 | 98.4% |
| W3 | 17 | 38,046 | 80,213 | 909,294 | 870,016 | 95.7% |
| W4 | 86 | 37,753 | 188,430 | 11,695,810 | 11,680,000 | 98.9% |

Two facts to keep:

1. **Step 0 costs the whole prefix.** W2 was a cold cache: 37,235 tokens at miss price
   ($0.0056). W1/W3/W4 hit 35,968 of it — the *same* prefix served from cache warmed by other
   sessions on the same account and model. Prefix identity, not prefix size, decides that.
2. **History re-read is linear in steps and dominant at the tail**: step 0 is 94% prefix, step
   68 is 84% history. In W2 the last request is 222,628 tokens of which 185,880 are accumulated
   messages.

### 2.4 Headless control — same loop, much smaller surface (MEASURED bytes, ESTIMATE tokens)

One real `dsh --profile headless` run against the keyless mock wire server (port 8124, task T8,
`bench/results/smoke-baseline.jsonl`):

| Measure | Value |
|---|---|
| tools / schema bytes / schema tokens | 24 / 19,106 / **4,781** |
| system chars / tokens | 2,688 / **676** |
| fixed prefix | **5,457** tokens |
| steps / tool calls | 1 / 0 |
| contextBreakdown step 0 (system / tools / messages) | 676 / 4,781 / 6,994 = 12,451 |

The mock reports synthetic usage (`input_tokens: 3`), so this row is `tokenSource: "heuristic"`.
Two things it proves: the runner works end to end without an API key, and the prefix is not a
constant of the harness — 5,457 tokens here, 35,095 in the web profile, entirely by composition.
That 6.4× spread is the whole "instruction assembly" argument in one line.

### 2.5 Where the billed input goes (DERIVED from §2.2–2.4)

Billed input units: `miss + 0.02 × cacheRead` (DeepSeek flash off-peak list prices:
$0.003/M hit, $0.15/M miss, $0.60/M output — [pricing](https://api-docs.deepseek.com/quick_start/pricing);
hit:miss = 1:50).

| Session | prefix share | history re-read share | new content share | billed input | USD |
|---|---|---|---|---|---|
| W1 (48 steps) | 23.6% | 34.9% | 41.6% | 142,917 | $0.0435 |
| W2 (69 steps) | 13.0% | 42.5% | 44.5% | 371,331 | $0.0941 |
| W3 (17 steps) | 21.1% | 9.6% | 69.3% | 56,678 | $0.0124 |
| W4 (86 steps) | 16.8% | 47.6% | 35.6% | 359,170 | $0.0727 |

**The entire instruction+tool assembly is 13–24% of the input bill. New content — tool results,
file reads, model output — is 36–69%.** No loop architecture changes the second number; only
doing less work does. `cacheWriteTokens` was 0 in every session, i.e. this route reports no
cache-write premium, so a miss is paid once and then discounted 50×.

---

## 3. Preset surfaces: `standard` vs a lean `explore`

This is the Lead's requested comparison and it is the one place where the token saving is real
*and* cache-safe, because a preset is chosen when the session is created — one stable prefix for
the whole run.

### 3.1 Composition

`standard` (`packages/bundle/web-app/presets/standard.patch.yml`) mounts the coding surface plus
a `delegation` group (`:83-108`: `tool-subagent-control`, `subagent`, `subagent_fork`,
`workflow-ptc`, `tool-workflow`) and the rest of the everyday tools (`:109-127`).

A lean `explore` preset for the graph loop removes what the graph itself subsumes: `subagent`,
`subagent_fork`, `list_subagent_models`, `list_agents`, `send_message`, `interrupt_agent`,
`workflow`, plus `ralph` if it is ever mounted, plus the Agent Teams six. Delegation becomes a
graph edge, not a tool call.

### 3.2 Numbers

MEASURED tool bytes summed over preset membership; `exit_plan_mode` sized from the catalog
(472 B) because it was not mounted in the captured session; `ralph` (826 B) is absent everywhere.

| Surface | tools | schema bytes | schema tok | system chars | system tok | **fixed prefix** | vs standard |
|---|---|---|---|---|---|---|---|
| Live profile today (standard + teams + crafts) | 160 | 120,108 | 30,031 | 20,237 | 5,064 | **35,095** | — |
| `standard` preset alone | 33 | 30,759 | 7,703 | 5,771 | 1,447 | **9,150** | — |
| `explore` = standard − delegation/team/workflow | 26 | 22,941 | 5,746 | 5,181 | 1,300 | **7,046** | **−23.0%** |
| `explore` applied to today's live profile | 147 | 108,539 | 27,139 | 18,392 | 4,602 | **31,741** | −9.6% |

The honest framing: **−23% of a clean `standard` baseline, but only −9.6% of the profile the
user actually runs**, because crafts dominate that one. Against `minimal`
(`packages/bundle/web-app/presets/minimal.patch.yml`: a one-line `complete: true` persona,
`read_image` only, persistent bash) the same delta would be noise.

### 3.3 What the saving is worth

2,105 tokens × 0.02 × 40 steps ≈ **1,683 billed units ≈ $0.00025 per 40-step task**. In W2's
terms the whole prefix is 13% of the bill, so shaving 23% of the prefix is ≈ 3% of the bill.
**It is a token-count win and a rounding error in money.** Worth doing because it is cheap and
cache-stable; not worth a new agent kernel on its own.

### 3.4 A preset switch is a new session — do not compare it to a mid-session tool change

Switching preset changes `setup`/`sessionRecord.preset`, so it starts a new agent and a new
session. That is exactly the comparison we want (two cache-clean arms), and it is *not*
comparable to gating tools inside a running session: the first request of the new session pays
one cold miss of its prefix (W2 shows that costs $0.0056), and everything after is warm. Any
figure that mixes the two — "we cut 23% of the prefix by switching presets, so per-node gating
saves 23% too" — is wrong by the factor in §4.

---

## 4. The KV-cache trade-off, quantified

### 4.1 What the source says

- `packages/core/tools/README.md:187`, `:192`: append-only results follow the reusable prefix and
  do **not** invalidate KV entries.
- `packages/core/agent-loop/README.md:164`: "Changing a retained tool definition or rebuilding
  declarations invalidates reuse from the first altered request token."
- `packages/core/agent-loop/README.md:122`: a visible tool-schema change forces prompt
  consolidation **unless** the prepared route declares a `toolUpdate` capability.
- `packages/core/system-prompt/README.md:166`: "Schema tokens repeat on every request."
- The route we run declares `systemPromptUpdate: 'in-history'` and `toolUpdate: 'addition-only'`
  (`packages/llm/llm-deepseek/src/models.ts:14-16`; confirmed in `request/context` for
  `systemPromptUpdate`). **Additions are append-safe; removals are not.** `request/context`
  does not log `toolUpdate`, so a bench must record the resolved model info itself.

### 4.2 Break-even

Let `ΔS` = schema tokens removed, `P` = fixed-prefix tokens, `H` = history tokens at the change,
`ρ = 0.02` = cache-hit price ratio.

- saving while warm: `ΔS · ρ` per step
- cost of one invalidation (everything after the changed token re-reads at miss price):
  `(1 − ρ) · (P + H)`
- **break-even: `T* = (1 − ρ)(P + H) / (ΔS · ρ) ≈ 49 · (P + H) / ΔS` steps between changes**

### 4.3 Scenarios (DERIVED)

| Scenario | ΔS | P + H | saving/step | invalidation | `T*` | vs a 40-step task |
|---|---|---|---|---|---|---|
| S1 `explore` vs `standard`, clean baseline | 2,545 | 49,150 | 51 | 48,167 | **946 steps** | needs 24× more steps |
| S2 live profile, drop delegation+teams+workflow | 3,354 | 151,848 | 67 | 148,811 | **2,218 steps** | 55× |
| S3 in-session gating down to a 2-tool subset | 28,600 | 151,848 | 572 | 148,811 | **260 steps** | 6.5× |

Equivalently, at 1:50, **one invalidation costs as much as 28 warm steps of the entire session's
input bill** (W2: 148,811 units vs 5,382 units/step).

### 4.4 Verdict

**Dynamic per-node tool gating is a losing strategy at DeepSeek cache pricing**, by 6–55× in the
scenarios a 40-step task can actually pay for. It only wins if a tool-set version survives
~260+ consecutive steps, i.e. if "nodes" are enormous — which is the opposite of a fine-grained
LangGraph control plane. The more tools it removes (S3), the closer it gets, but it still needs
a 260-step node.

Two corollaries that matter for the design:

- **Do not rebuild tool declarations per node inside a session.** If the graph must vary the
  toolbox, do it at session start (preset) or *only add* tools (§4.5).
- The cost of a graph *control* step is small: a router step at 40k prompt is ~800 units, 0.2%
  of W2's bill. Graph overhead is not the enemy; cache destruction is.

### 4.5 The cache-safe variant: grow, never shrink

Because `toolUpdate: 'addition-only'` appends, a loop can start with a narrow tool surface and
activate tools as the task demands, paying a small append rather than a prefix rewrite. Measured
cost of an append: one `tool_addition` block + the new schema on subsequent requests (a 2k-token
schema costs 40 units/step while warm). This is the design to test if the graph wants dynamic
tools; "match and prune" should be replaced by "start minimal and add".

---

## 5. Graph modes: where the savings actually are

### 5.1 Two modes, two different economics

- **Mode A — graph as control plane, one session, history accumulates.** Same prompt as the stock
  loop plus a small routing section. Savings can only come from fewer steps or a smaller static
  surface; per-node gating is §4.4. Expect **−5% to +5%** on billed input, driven by step count.
- **Mode B — nodes are subagent sessions, fresh context each.** The parent stops accumulating
  node history; each node pays the fixed prefix once (cheap: it is the same cached prefix) plus
  an orientation cost. This is the only mode that attacks the 42.5% history-re-read term.

### 5.2 Model and results (DERIVED; calibrated to W1–W4)

Parameters: `P = 35,095`, new content 2,000 tok/step, node orientation 3,000 tok, parent keeps
summaries only (1,800 tok/step), dispatch+collect = 2 steps/node, K nodes split the same work.

| Decomposition of a 68-step task | parent steps | node steps | billed input | vs stock |
|---|---|---|---|---|
| stock loop | 68 | — | 278,929 | — |
| 2 nodes | 8 | 34 | 211,508 | −24.2% |
| 4 nodes | 12 | 17 | 199,341 | −28.5% |
| 8 nodes | 20 | 9 | 234,285 | −16.0% |

| nodes | break-even task length | saving at 200 steps |
|---|---|---|
| 2 | 34 steps | −48.0% |
| 4 | 39 steps | −60.6% |
| 8 | 53 steps | −62.0% |

The curve is superlinear because history re-read grows as `steps²` while a split divides it by K.
**Below ~35–55 steps (most one-shot coding tasks; two of the four measured sessions ran 17 and 48
steps) a split loses or ties; above ~100 steps it wins decisively.** The model under-predicts the measured baselines by
~10–20%, which makes the savings conservative.

### 5.3 Overheads that are small, and one that is not

Small: the per-node title call (~215 tokens, measured: a 600-char title system prompt + a
~150-char message), the routing prompt section (~1k tokens = 20 units/step), extra session
records (billed nowhere). Not small: **node orientation** — a node that re-reads files the parent
already read turns the win into a loss (at 3k tok/node, break-even moves from 34 to 39 steps; at
8k it moves past 60). Mode B's success is an information-passing problem before it is a token
problem.

---

## 6. A/B protocol, thresholds, kill criteria

Arms (pre-registered): `baseline` = stock loop + `standard`; `explore` = stock loop + lean preset;
`graph-control` = graph in one session; `graph-node` = graph with subagent nodes.
Dataset: `bench/tasks/tasks.jsonl` — 8 tasks across single-tool, multi-tool edit, research, doc
generation, bug fix, long refactor, multi-agent, no-tool. ≥3 repetitions per cell; report medians,
not means (the token distribution is heavy-tailed — W4 vs W3 differ 13×).

Metrics per row (`bench/schema/results.schema.json`): `tools`, `toolSchemaBytes/Tokens`,
`systemTokens`, `steps`, `toolCalls`, `promptTokens`, `cacheReadTokens`, `missTokens`,
**`cacheReadRatio`**, **`billedInputUnits`**, `billedCostUsd`, `sessionCount`, `wallTimeMs`,
`success`.

**Accept an arm** only if all of:
1. median **billed input units** per completed task ≤ −15% vs baseline;
2. median **prompt tokens** per completed task ≤ −25% (what the user perceives as token cost);
3. **cache-read ratio** drops ≤ 20 points (a bigger drop means the prefix was destroyed);
4. success rate ≥ baseline − 5 points;
5. wall time per completed task ≤ +30%.

**Kill criteria** (stop the line, do not "tune later"):
- **K1** — if `explore` gives < 15% billed-input drop and < 25% prompt-token drop, the
  instruction-assembly premise is dead; drop "matching reduces instruction cost" from the plan.
- **K2** — if any arm's `cacheReadRatio` falls below 0.78 (baseline median 0.984) while
  `billedInputUnits` rises, the arm is a cache-destroyer: abandon dynamic tool gating, keep
  presets only.
- **K3** — if graph mode needs > 40 extra steps or > 15% more output tokens per completed task,
  it is paying more model work for the same result; abandon.
- **K4** — if `graph-node` cannot beat `baseline` at 100+ steps (where the model says it must win
  by ≥48%), the isolation benefit is not real and only preset selection should ship.

`bench/scripts/aggregate.mjs` encodes 1–5 and prints PASS/FAIL per arm; editing `ACCEPT` after
seeing results is how an A/B stops being an A/B.

**What the bench cannot do yet** (see `bench/README.md`): the headless profile is not the web
`standard` preset; no `explore` preset exists; both graph arms refuse to run until the plugin
exists. The preset comparison in §3 is therefore DERIVED from measured per-tool bytes, not a live
A/B. That is the first experiment to run.

---

## 7. Conclusion — what the claim gets right, and what it does not

1. **"Reduces instruction assembly."** True for *token count*: the 160-tool, 14-craft surface is
   35,095 tokens, 62% of the system prompt and 72% of the schema bytes of which are catalog text
   for tools most tasks never call. A lean preset cuts 23% of it, cache-safely.
2. **"Reduces token consumption."** Only in narrow forms. In money, the prefix is 13–24% of the
   input bill; new content is 36–69%. Cutting the prefix by 23% buys ~3% of the bill.
3. **"Sub-graph selection"** — the *selection at session start* is sound: one stable prefix, one
   cold miss, then 50× discount. The *per-node mutation* is not: break-even needs 260–2,218
   steps per change.
4. **Where the real win is** is the mode the proposal treats as a side effect: **fresh-context
   nodes** for long tasks. −25% to −60% of billed input above ~40–100 steps, because that is the
   only mechanism that touches the history-re-read term. It trades token cost for an
   information-passing risk and must be measured, not assumed.
5. **Scale honesty**: these are $0.01–$0.10 sessions. A 20% saving is $0.02. The engineering case
   for a new kernel has to be capability (typed edges, resumable sub-graphs, multi-agent
   hand-off), not token cost; token cost justifies **presets + subagent nodes**, both of which
   already exist as seams (`ctx.agents.create`, `agent-preset`).

---

## 8. Reproduction

```sh
# measured inputs (the five rows cited above)
node bench/scripts/analyze-session.mjs ~/.dsh/sessions/*/*/session.v4.jsonl.zstd --arm baseline

# §2.4 decomposition, §3.3 value, §4.3 break-even, §5.2 mode model
node bench/scripts/cost-model.mjs --measured bench/results/measured-web-sessions.jsonl

# end-to-end proof that the runner works (keyless mock wire server, port 8124)
node bench/scripts/run-arm.mjs --arm baseline --tasks T8
node bench/scripts/aggregate.mjs bench/results/*.jsonl
```

Artifacts: `bench/baselines/tool-bytes.json` (per-tool wire bytes, 160 tools),
`bench/baselines/system-prompt.web.txt` (rendered prompt), `bench/results/measured-web-sessions.jsonl`
(five priced sessions), `bench/results/smoke-baseline.jsonl` (runner proof),
`bench/schema/results.schema.json`, `bench/tasks/tasks.jsonl`.
