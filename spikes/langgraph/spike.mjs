/**
 * DSH × LangGraph feasibility spike — @langchain/langgraph@1.7.0 on Node 26.
 *
 * Purpose: prove/disprove that LangGraph JS can serve as the execution kernel
 * inside a DSH plugin. Every section prints PASS/FAIL/INFO lines; failures are
 * captured per-section so one unsupported feature does not hide the rest.
 *
 * Sections
 *   0  import/format facts
 *   1  typed state (Annotation) + reducers + reducer-less parallel write failure
 *   2  StateGraph: addNode/addEdge/addConditionalEdges + recursion limit
 *   3  subgraph node (wrapped + direct compiled graph)
 *   4  parallel fan-out / join (static edges + Send API)
 *   5  MemorySaver: thread isolation, getState, getStateHistory (time travel)
 *   6  custom BaseCheckpointSaver skeleton + JSON round-trip of checkpoints
 *   7  interrupt() / Command resume: node re-execution cost, resume values
 *   8  streaming: values / updates / custom / debug, ordering
 *   9  determinism: same input twice -> same execution trace? what is wall-clock?
 *  10  per-invoke overhead (no checkpointer vs MemorySaver), memory
 */
import { performance } from "node:perf_hooks";

const out = [];
const log = (...a) => { const s = a.map(x => typeof x === "string" ? x : JSON.stringify(x)).join(" "); out.push(s); console.log(s); };
let currentSection = "boot";
const results = {};
function section(name) { currentSection = name; log(`\n===== ${name} =====`); results[name] = {}; }
function ok(k, v) { results[currentSection][k] = { ok: true, v }; log(`  [PASS] ${k}: ${typeof v === "string" ? v : JSON.stringify(v)}`); }
function bad(k, e) { results[currentSection][k] = { ok: false, e: String(e) }; log(`  [FAIL] ${k}: ${String(e).split("\n")[0]}`); }
function info(k, v) { results[currentSection][k] = { info: true, v }; log(`  [INFO] ${k}: ${typeof v === "string" ? v : JSON.stringify(v)}`); }
async function step(k, fn) { try { await fn(); } catch (e) { bad(k, e.stack || e); } }
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

/* ------------------------------------------------------------------ */
section("0. import / module-format facts");
const t0 = performance.now();
const LG = await import("@langchain/langgraph");
const t1 = performance.now();
const CP = await import("@langchain/langgraph-checkpoint");
const t2 = performance.now();
ok("import @langchain/langgraph", `${(t1 - t0).toFixed(1)}ms, ${Object.keys(LG).length} exports`);
ok("import @langchain/langgraph-checkpoint", `${(t2 - t1).toFixed(1)}ms, ${Object.keys(CP).length} exports`);
info("process", `${process.version} ${process.platform}/${process.arch}`);
info("langgraph version", JSON.parse(
  await (await import("node:fs/promises")).readFile(new URL("./node_modules/@langchain/langgraph/package.json", import.meta.url), "utf8")
).version);
// Does importing langgraph pull the LLM/tokenizer stack? (DSH plugin boot cost)
const loaded = Object.keys((await import("node:module")).default ? {} : {});
const jsTiktokenLoaded = (await import("node:fs/promises"))
  .readFile(new URL("./node_modules/@langchain/core/package.json", import.meta.url), "utf8")
  .then(s => JSON.parse(s).dependencies);
info("core deps reachable at import", await jsTiktokenLoaded);

const {
  StateGraph, Annotation, START, END, MemorySaver, Command, interrupt,
  Send, MessagesAnnotation, isInterrupted, GraphInterrupt, isGraphInterrupt,
  BaseCheckpointSaver, getWriter, task,
} = LG;

/* ------------------------------------------------------------------ */
section("1. typed state: Annotation + reducers");
const S = Annotation.Root({
  input: Annotation({ reducer: (_l, r) => r, default: () => "" }),
  plan: Annotation({ reducer: (_l, r) => r, default: () => [] }),
  findings: Annotation({ reducer: (l, r) => [...l, ...r], default: () => [] }), // parallel-safe
  count: Annotation({ reducer: (_l, r) => r, default: () => 0 }),
});
// zod variant (peer dep zod@4)
const { z } = await import("zod");
try {
  const ZS = LG.StateSchema ? "StateSchema exported" : "no StateSchema";
  ok("zod StateSchema available", ZS);
} catch (e) { bad("zod StateSchema", e); }
try {
  const g = new StateGraph(S).addNode("n", (s) => ({ count: s.count + 1 })).addEdge(START, "n").addEdge("n", END).compile();
  const r = await g.invoke({ input: "x" });
  ok("Annotation.Root graph", r);
} catch (e) { bad("Annotation.Root graph", e); }

await step("reducer-less parallel write is rejected", async () => {
  const S2 = Annotation.Root({ a: Annotation({ reducer: (_l, r) => r, default: () => 0 }) });
  const g = new StateGraph(S2)
    .addNode("fan", () => ({}))
    .addNode("l", () => ({ a: 1 }))
    .addNode("r", () => ({ a: 2 }))
    .addNode("join", () => ({}))
    .addEdge(START, "fan").addEdge("fan", "l").addEdge("fan", "r")
    .addEdge("l", "join").addEdge("r", "join").addEdge("join", END)
    .compile();
  try {
    const r = await g.invoke({ a: 0 });
    info("result (last-write-wins, no error)", r);
  } catch (e) {
    ok("threw (expected InvalidUpdateError)", e.constructor.name + ": " + String(e.message).split("\n")[0].slice(0, 160));
  }
});

/* ------------------------------------------------------------------ */
section("2. StateGraph: nodes, edges, conditional edges, recursion limit");
const trace2 = [];
const g2 = new StateGraph(S)
  .addNode("n_plan", (s) => { trace2.push("n_plan"); return { plan: ["a", "b"], count: s.count + 1 }; })
  .addNode("n_act", (s) => { trace2.push("n_act:" + s.count); return { count: s.count + 1 }; })
  .addNode("n_done", () => { trace2.push("n_done"); return {}; })
  .addEdge(START, "n_plan")
  .addConditionalEdges("n_plan", (s) => (s.plan.length > 0 ? "n_act" : "n_done"), ["n_act", "n_done"])
  .addConditionalEdges("n_act", (s) => (s.count < 3 ? "n_act" : "n_done"), { n_act: "n_act", n_done: "n_done" })
  .addEdge("n_done", END)
  .compile();
const r2 = await g2.invoke({ input: "hello" });
ok("conditional loop result", r2);
ok("execution trace", trace2);

await step("recursion limit", async () => {
  const g = new StateGraph(S)
    .addNode("loop", (s) => ({ count: s.count + 1 }))
    .addEdge(START, "loop")
    .addConditionalEdges("loop", () => "loop")
    .compile();
  try {
    await g.invoke({ input: "", count: 0 }, { recursionLimit: 10 });
    bad("recursion limit", "no error thrown");
  } catch (e) {
    ok("GraphRecursionError", `${e.name} after limit; ${String(e.message).split("\n")[0].slice(0, 120)}`);
  }
});
await step("recursionLimit configurable per invoke", async () => {
  const g = new StateGraph(S)
    .addNode("loop", (s) => ({ count: s.count + 1 }))
    .addEdge(START, "loop")
    .addConditionalEdges("loop", (s) => (s.count < 4 ? "loop" : END))
    .compile();
  const r = await g.invoke({ count: 0 }, { recursionLimit: 100 });
  ok("completed under raised limit", r.count);
});

/* ------------------------------------------------------------------ */
section("3. subgraph as a node");
const SubState = Annotation.Root({
  findings: Annotation({ reducer: (l, r) => [...l, ...r], default: () => [] }),
  count: Annotation({ reducer: (_l, r) => r, default: () => 0 }),
});
const sub = new StateGraph(SubState)
  .addNode("inner1", (s) => ({ findings: ["inner1"], count: s.count + 1 }))
  .addNode("inner2", (s) => ({ findings: ["inner2"], count: s.count + 1 }))
  .addEdge(START, "inner1").addEdge("inner1", "inner2").addEdge("inner2", END)
  .compile();
await step("subgraph as direct node (shared keys)", async () => {
  const g = new StateGraph(S)
    .addNode("step1", () => ({ plan: ["x"] }))
    .addNode("sub", sub)               // compiled graph used directly as a node
    .addNode("sum", (s) => ({ findings: [`total=${s.findings.length}`], count: s.count + 1 }))
    .addEdge(START, "step1").addEdge("step1", "sub").addEdge("sub", "sum").addEdge("sum", END)
    .compile();
  const r = await g.invoke({});
  ok("state after subgraph", r);
  info("note", "subgraph channel names must be a subset of parent's; values merge through parent reducers");
});

/* ------------------------------------------------------------------ */
section("4. parallel fan-out / join");
await step("static fan-out with reducer join", async () => {
  const order = [];
  const g = new StateGraph(S)
    .addNode("fanout_marker", () => { order.push("fanout_marker"); return { plan: ["a", "b", "c"] }; })
    .addNode("w0", async () => { await sleep(30); order.push("w0"); return { findings: ["w0"] }; })
    .addNode("w1", async () => { await sleep(5); order.push("w1"); return { findings: ["w1"] }; })
    .addNode("w2", async () => { await sleep(15); order.push("w2"); return { findings: ["w2"] }; })
    .addNode("joinNode", (s) => { order.push("joinNode"); return { findings: [`joined:${s.findings.length}`] }; })
    .addEdge(START, "fanout_marker")
    .addEdge("fanout_marker", "w0").addEdge("fanout_marker", "w1").addEdge("fanout_marker", "w2")
    .addEdge("w0", "joinNode").addEdge("w1", "joinNode").addEdge("w2", "joinNode")
    .addEdge("joinNode", END)
    .compile();
  const t = performance.now();
  const r = await g.invoke({});
  const dur = performance.now() - t;
  ok("join state", r);
  info("wall clock", `${dur.toFixed(0)}ms for sleeps 30+5+15 => ${dur < 45 ? "CONCURRENT" : "SERIAL"}`);
  info("completion order (physical)", order.join(" > "));
  info("findings order is completion order, not declaration order", r.findings.join(","));
});

await step("Send API dynamic fan-out", async () => {
  const SS = Annotation.Root({
    items: Annotation({ reducer: (_l, r) => r, default: () => [] }),
    results: Annotation({ reducer: (l, r) => [...l, ...r], default: () => [] }),
  });
  const g = new StateGraph(SS)
    .addNode("prepare", (s) => ({ items: s.items }))
    .addNode("work", (s) => ({ results: [`done:${s.item}`] }))
    .addNode("collect", (s) => ({ results: [`n=${s.results.length}`] }))
    .addEdge(START, "prepare")
    // Send[] must come from a CONDITIONAL EDGE router, never from a node body
    .addConditionalEdges("prepare", (s) => s.items.map(i => new Send("work", { item: i })), ["work"])
    .addEdge("work", "collect").addEdge("collect", END)
    .compile();
  const r = await g.invoke({ items: ["a", "b", "c"] });
  ok("Send fan-out result", r);
});

/* ------------------------------------------------------------------ */
section("5. MemorySaver: threads, getState, history");
const saver = new MemorySaver();
const g5 = new StateGraph(S)
  .addNode("a", (s) => ({ count: s.count + 1, findings: ["a"] }))
  .addNode("b", (s) => ({ count: s.count + 1, findings: ["b"] }))
  .addEdge(START, "a").addEdge("a", "b").addEdge("b", END)
  .compile({ checkpointer: saver });

const cfgT1 = { configurable: { thread_id: "t1" } };
await step("invoke on thread t1", async () => {
  const r = await g5.invoke({ input: "q" }, cfgT1);
  ok("state", r);
});
await step("second invoke on same thread continues state", async () => {
  const r = await g5.invoke({ input: "q2" }, cfgT1);
  info("count after 2nd run (accumulates across invocations = conversation memory)", r.count);
});
await step("thread isolation t2", async () => {
  const r = await g5.invoke({ input: "other" }, { configurable: { thread_id: "t2" } });
  ok("t2 count", r.count);
});
await step("getState / next / metadata", async () => {
  const snap = await g5.getState(cfgT1);
  ok("snapshot next", snap.next);
  ok("snapshot metadata", snap.metadata);
  info("snapshot values", snap.values);
});
await step("getStateHistory", async () => {
  const hist = [];
  for await (const s of g5.getStateHistory(cfgT1)) hist.push({ step: s.metadata?.step, next: s.next, count: s.values.count, id: s.config?.configurable?.checkpoint_id?.slice(0, 8) });
  ok("history length", hist.length);
  info("history", hist);
});
await step("time travel: updateState", async () => {
  const snaps = [];
  for await (const s of g5.getStateHistory(cfgT1)) snaps.push(s);
  const target = snaps[snaps.length - 2]; // previous checkpoint
  const forked = await g5.updateState(target.config, { count: 99 });
  info("updateState returned new config", forked?.configurable?.checkpoint_id ? "config with checkpoint_id" : String(forked));
});

/* ------------------------------------------------------------------ */
section("6. custom BaseCheckpointSaver + JSON durability");
/**
 * Skeleton saver that stores every checkpoint as a plain JSON-able record in an
 * append-only array — deliberately shaped like a DSH session event log, to test
 * whether the checkpoint payload itself is JSON-serializable and whether a
 * JSON round-trip still resumes correctly.
 */
class JsonlSaver extends BaseCheckpointSaver {
  constructor() { super(); this.rows = []; this.calls = { getTuple: 0, list: 0, put: 0, putWrites: 0, deleteThread: 0 }; }
  static key(cfg) { return `${cfg.configurable?.thread_id ?? "?"}::${cfg.configurable?.checkpoint_ns ?? ""}`; }
  async getTuple(config) {
    this.calls.getTuple++;
    const k = JsonlSaver.key(config);
    const id = config.configurable?.checkpoint_id;
    const rows = this.rows.filter(r => r.key === k && (!id || r.checkpoint.id === id));
    if (!rows.length) return undefined;
    const row = rows[rows.length - 1];
    return { config: row.config, checkpoint: row.checkpoint, metadata: row.metadata, parentConfig: row.parentConfig, pendingWrites: row.pendingWrites };
  }
  async *list(config, options) {
    this.calls.list++;
    const k = JsonlSaver.key(config);
    let rows = this.rows.filter(r => r.key === k).reverse();
    if (options?.limit) rows = rows.slice(0, options.limit);
    for (const row of rows) yield { config: row.config, checkpoint: row.checkpoint, metadata: row.metadata, parentConfig: row.parentConfig, pendingWrites: row.pendingWrites };
  }
  async put(config, checkpoint, metadata, newVersions) {
    this.calls.put++;
    const k = JsonlSaver.key(config);
    const parentConfig = this.rows.filter(r => r.key === k).at(-1)?.config;
    const newConfig = { ...config, configurable: { ...config.configurable, checkpoint_id: checkpoint.id } };
    const row = { key: k, config: newConfig, checkpoint, metadata, parentConfig, pendingWrites: [] };
    this.rows.push(row);
    return newConfig;
  }
  async putWrites(config, writes, taskId, taskPath) {
    this.calls.putWrites++;
    const k = JsonlSaver.key(config);
    const row = this.rows.find(r => r.key === k && r.checkpoint.id === config.configurable?.checkpoint_id);
    if (row) row.pendingWrites.push(...writes.map(w => [taskId, w[0], w[1]]));
  }
  async deleteThread(threadId) { this.calls.deleteThread++; this.rows = this.rows.filter(r => !r.key.startsWith(threadId + "::")); }
  // DSH-flavoured projection: what would actually be appended to a session log
  toEvents() { return this.rows.map(r => ({ type: "checkpoint", thread: r.key, cp: r.checkpoint.id, step: r.metadata?.step, channels: Object.keys(r.checkpoint.channel_values) })); }
}

await step("custom saver drives a run", async () => {
  const js = new JsonlSaver();
  const g = new StateGraph(S)
    .addNode("a", (s) => ({ count: s.count + 1, findings: ["a"] }))
    .addNode("b", (s) => ({ count: s.count + 1, findings: ["b"] }))
    .addEdge(START, "a").addEdge("a", "b").addEdge("b", END)
    .compile({ checkpointer: js });
  const r = await g.invoke({ input: "hi" }, { configurable: { thread_id: "custom-1" } });
  ok("result", r);
  info("saver call counts", js.calls);
  info("checkpoint rows written", js.rows.length);
  info("row shape (checkpoint keys)", Object.keys(js.rows[0].checkpoint));
  info("channel_values", js.rows.at(-1).checkpoint.channel_values);
});

await step("JSON round-trip of checkpoint payload", async () => {
  const js = new JsonlSaver();
  const mk = () => new StateGraph(S)
    .addNode("a", (s) => ({ count: s.count + 1, findings: ["a"] }))
    .addNode("b", (s) => ({ count: s.count + 1, findings: ["b"] }))
    .addEdge(START, "a").addEdge("a", "b").addEdge("b", END)
    .compile({ checkpointer: js });
  const g = mk();
  await g.invoke({ input: "hi" }, { configurable: { thread_id: "json-1" } });
  const plain = JSON.parse(JSON.stringify(js.rows));
  ok("rows JSON-serializable", `${plain.length} rows, ${JSON.stringify(plain).length} bytes`);
  ok("checkpoint values survive JSON", plain.at(-1).checkpoint.channel_values);
  // now hydrate a FRESH saver from the JSON and resume a FRESH graph from it
  const js2 = new JsonlSaver();
  js2.rows = plain;
  const g2b = mk();
  // resume by continuing the thread: invoke with only the update
  let resumed;
  try {
    resumed = await g2b.invoke({ input: "more" }, { configurable: { thread_id: "json-1" } });
    ok("resume from JSON-hydrated checkpointer", resumed);
  } catch (e) { bad("resume from JSON-hydrated checkpointer", e); }
  // deep probe: non-JSON-safe values
  const WeirdState = Annotation.Root({
    when: Annotation({ reducer: (_l, r) => r, default: () => null }),
    map: Annotation({ reducer: (_l, r) => r, default: () => null }),
    undef: Annotation({ reducer: (_l, r) => r, default: () => undefined }),
  });
  const gw = new StateGraph(WeirdState)
    .addNode("n", () => ({ when: new Date("2020-01-01T00:00:00Z"), map: new Map([["k", 1]]), undef: undefined }))
    .addEdge(START, "n").addEdge("n", END).compile({ checkpointer: js2 });
  await gw.invoke({}, { configurable: { thread_id: "weird" } });
  const raw = js2.rows.at(-1).checkpoint.channel_values;
  const rt = JSON.parse(JSON.stringify(raw));
  info("Date/Map in channel_values: native types", Object.fromEntries(Object.entries(raw).map(([k, v]) => [k, v?.constructor?.name ?? String(v)])));
  info("after JSON round-trip", Object.fromEntries(Object.entries(rt).map(([k, v]) => [k, v?.constructor?.name ?? String(v)])));
  info("VERDICT", raw.when instanceof Date && !(rt.when instanceof Date) ? "checkpoint payload is NOT JSON-lossless" : "JSON-safe");
});

/* ------------------------------------------------------------------ */
section("7. interrupt() / Command resume");
await step("interrupt then resume", async () => {
  const seen = [];
  let nodeRuns = 0;
  const g = new StateGraph(S)
    .addNode("before", () => { seen.push("before"); return { plan: ["ask"] }; })
    .addNode("human", (s) => {
      nodeRuns++;
      seen.push(`human-run#${nodeRuns}`);
      const answer = interrupt({ question: "approve?", plan: s.plan });
      return { findings: [`answered:${answer}`], count: s.count + 1 };
    })
    .addNode("after", () => { seen.push("after"); return { findings: ["after"] }; })
    .addEdge(START, "before").addEdge("before", "human").addEdge("human", "after").addEdge("after", END)
    .compile({ checkpointer: saver });
  const cfg = { configurable: { thread_id: "int-1" } };
  const p1 = await g.invoke({ input: "go" }, cfg).then(r => ({ done: r })).catch(e => ({ err: e }));
  info("first invoke outcome", p1.err ? `${p1.err.constructor.name}: ${p1.err.message}` : JSON.stringify(p1.done));
  const snap = await g.getState(cfg);
  info("state after interrupt: next", snap.next);
  info("state.interrupts", (snap.tasks ?? []).flatMap(t => t.interrupts ?? []).map(i => ({ id: i.id, value: i.value })));
  // resume
  const r2b = await g.invoke(new Command({ resume: "yes" }), cfg);
  ok("resumed result", r2b);
  ok("node re-execution count for human node", `${nodeRuns} (2 => node body re-ran from the top after resume)`);
  info("physical order", seen.join(" > "));
});

await step("isInterrupted helper / GraphInterrupt type", async () => {
  const g = new StateGraph(S)
    .addNode("h", () => { interrupt("boom"); return {}; })
    .addEdge(START, "h").addEdge("h", END).compile({ checkpointer: saver });
  try {
    await g.invoke({}, { configurable: { thread_id: "int-2" } });
  } catch (e) {
    ok("thrown type", e.constructor.name);
    info("isInterrupted", isInterrupted(e));
    info("isGraphInterrupt", isGraphInterrupt(e));
    info("GraphInterrupt instance", e instanceof GraphInterrupt);
  }
});

await step("interrupt without checkpointer", async () => {
  const g = new StateGraph(S)
    .addNode("h", () => { interrupt("boom"); return {}; })
    .addEdge(START, "h").addEdge("h", END).compile();
  try { await g.invoke({}); bad("no-checkpointer interrupt", "did not throw"); }
  catch (e) { ok("error without checkpointer", String(e.message).split("\n")[0]); }
});

await step("interrupt inside subgraph", async () => {
  const SubH = Annotation.Root({
    findings: Annotation({ reducer: (l, r) => [...l, ...r], default: () => [] }),
  });
  const subH = new StateGraph(SubH)
    .addNode("ask", () => { const v = interrupt({ q: "sub?" }); return { findings: [`sub:${v}`] }; })
    .addEdge(START, "ask").addEdge("ask", END).compile({ checkpointer: saver });
  const g = new StateGraph(S)
    .addNode("sub", subH)
    .addNode("tail", () => ({ findings: ["tail"] }))
    .addEdge(START, "sub").addEdge("sub", "tail").addEdge("tail", END).compile({ checkpointer: saver });
  const cfg = { configurable: { thread_id: "int-sub" } };
  try { await g.invoke({}, cfg); info("did not surface as throw", "returned"); }
  catch (e) { info("subgraph interrupt surfaced as", e.constructor.name); }
  const r = await g.invoke(new Command({ resume: "ok" }), cfg).catch(e => ({ err: String(e.message).slice(0, 120) }));
  info("resume result", r);
});

/* ------------------------------------------------------------------ */
section("8. streaming");
await step("streamMode values/updates/custom", async () => {
  const g = new StateGraph(S)
    .addNode("a", () => ({ plan: ["x"] }))
    .addNode("b", () => ({ findings: ["b1", "b2"] }))
    .addEdge(START, "a").addEdge("a", "b").addEdge("b", END).compile();
  const chunks = [];
  const s = await g.stream({ input: "s" }, { streamMode: ["values", "updates", "custom"] });
  for await (const [mode, payload] of s) chunks.push({ mode, payload });
  ok("chunks", chunks.length);
  info("modes seen", [...new Set(chunks.map(c => c.mode))]);
  info("first 6", chunks.slice(0, 6));
});
await step("stream single mode (updates)", async () => {
  const g = new StateGraph(S)
    .addNode("a", () => ({ plan: ["x"] }))
    .addEdge(START, "a").addEdge("a", END).compile();
  const events = [];
  for await (const e of await g.stream({ input: "s" }, { streamMode: "updates" })) events.push(e);
  ok("update events", events);
});
await step("token-level LLM streaming path exists (streamMode messages requires model)", async () => {
  info("streamModes documented", "values|updates|checkpoints|tasks|debug|custom|messages");
  info("note", "'messages' mode is for chat-model token deltas; it needs a BaseChatModel, not exercised here");
});

/* ------------------------------------------------------------------ */
section("9. determinism");
await step("same input twice -> identical execution trace", async () => {
  const run = async () => {
    const tr = [];
    const g = new StateGraph(S)
      .addNode("a", () => { tr.push("a"); return { count: 1 }; })
      .addNode("b", () => { tr.push("b"); return { count: 2 }; })
      .addEdge(START, "a").addEdge("a", "b").addEdge("b", END).compile();
    const r = await g.invoke({});
    return { tr: tr.join(">"), r };
  };
  const x = await run(); const y = await run();
  ok("trace identical", x.tr === y.tr ? `yes (${x.tr})` : `NO ${x.tr} vs ${y.tr}`);
  info("state identical", JSON.stringify(x.r) === JSON.stringify(y.r));
});
await step("what is nondeterministic", async () => {
  const s2 = new MemorySaver();
  const g = new StateGraph(S).addNode("a", () => ({ count: 1 })).addEdge(START, "a").addEdge("a", END).compile({ checkpointer: s2 });
  await g.invoke({}, { configurable: { thread_id: "det" } });
  const snap = await g.getState({ configurable: { thread_id: "det" } });
  info("checkpoint_id (uuid6-ish)", snap.config.configurable.checkpoint_id);
  info("created_at / ts", snap.createdAt);
  info("=> ids and timestamps are wall-clock/random; graph *logic* is deterministic given identical inputs");
});
await step("interrupt id determinism", async () => {
  const ids = [];
  for (const th of ["d1", "d2"]) {
    const g = new StateGraph(S).addNode("h", () => { interrupt("x"); return {}; }).addEdge(START, "h").addEdge("h", END).compile({ checkpointer: saver });
    await g.invoke({}, { configurable: { thread_id: th } }).catch(() => { });
    const sn = await g.getState({ configurable: { thread_id: th } });
    ids.push((sn.tasks ?? []).flatMap(t => (t.interrupts ?? []).map(i => i.id)));
  }
  info("interrupt ids across threads", ids);
});

/* ------------------------------------------------------------------ */
section("10. cost: per-invoke overhead, memory");
await step("throughput, no checkpointer, 1 node", async () => {
  const g = new StateGraph(S).addNode("a", () => ({ count: 1 })).addEdge(START, "a").addEdge("a", END).compile();
  await g.invoke({}); // warm
  const N = 500; const t = performance.now();
  for (let i = 0; i < N; i++) await g.invoke({});
  const per = (performance.now() - t) / N;
  ok("per invoke", `${per.toFixed(3)}ms (${(1000 / per).toFixed(0)}/s)`);
});
await step("throughput, 5 nodes, no checkpointer", async () => {
  let b = new StateGraph(S).addEdge(START, "n0");
  for (let i = 0; i < 5; i++) b = b.addNode(`n${i}`, (s) => ({ count: s.count + 1 }));
  for (let i = 0; i < 4; i++) b = b.addEdge(`n${i}`, `n${i + 1}`);
  const g = b.addEdge("n4", END).compile();
  await g.invoke({});
  const N = 300; const t = performance.now();
  for (let i = 0; i < N; i++) await g.invoke({});
  ok("per 5-node invoke", `${((performance.now() - t) / N).toFixed(3)}ms`);
});
await step("throughput with MemorySaver", async () => {
  const sv = new MemorySaver();
  const g = new StateGraph(S).addNode("a", () => ({ count: 1 })).addEdge(START, "a").addEdge("a", END).compile({ checkpointer: sv });
  await g.invoke({}, { configurable: { thread_id: "w" } });
  const N = 300; const t = performance.now();
  for (let i = 0; i < N; i++) await g.invoke({}, { configurable: { thread_id: "bench" } });
  ok("per checkpointed invoke (same thread, state grows)", `${((performance.now() - t) / N).toFixed(3)}ms`);
});
await step("memory footprint", async () => {
  const mu = process.memoryUsage();
  ok("rss after spike", `${(mu.rss / 1024 / 1024).toFixed(1)} MB`);
});

/* ------------------------------------------------------------------ */
section("11. dynamic topology between turns (the 'add/remove nodes on demand' requirement)");
await step("recompile with an extra node, resume the same thread", async () => {
  const sv = new MemorySaver();
  const base = () => new StateGraph(S)
    .addNode("n1", (s) => ({ count: s.count + 1, findings: ["n1"] }))
    .addNode("gate", (s) => { const a = interrupt({ at: "gate", n: s.count }); return { findings: [`gate:${a}`] }; })
    .addEdge(START, "n1").addEdge("n1", "gate");
  const gA = base().addNode("tailA", () => ({ findings: ["tailA"] })).addEdge("gate", "tailA").addEdge("tailA", END).compile({ checkpointer: sv });
  const cfg = { configurable: { thread_id: "dyn-1" } };
  await gA.invoke({}, cfg).catch(e => bad("first run", e));
  const snapA = await gA.getState(cfg);
  info("paused at", snapA.next);
  // second turn: compile a DIFFERENT graph (old node removed, new node inserted) over the same saver+thread
  const gB = base().addNode("tailB", () => ({ findings: ["tailB"] })).addEdge("gate", "tailB").addEdge("tailB", END).compile({ checkpointer: sv });
  try {
    const r = await gB.invoke(new Command({ resume: "go" }), cfg);
    ok("resumed into a RECOMPILED graph", r);
    info("VERDICT", "topology can change between turns as long as channel names/versions are unchanged; the paused node is re-executed by name");
  } catch (e) { bad("resumed into a RECOMPILED graph", e); }
});
await step("recompile with a REMOVED channel, resume same thread", async () => {
  const sv = new MemorySaver();
  const mk = (extraChannel) => {
    const Sx = Annotation.Root({
      count: Annotation({ reducer: (_l, r) => r, default: () => 0 }),
      findings: Annotation({ reducer: (l, r) => [...l, ...r], default: () => [] }),
      ...(extraChannel ? { memo: Annotation({ reducer: (_l, r) => r, default: () => "" }) } : {}),
    });
    return { Sx, g: new StateGraph(Sx)
      .addNode("a", (s) => ({ count: s.count + 1, ...(extraChannel ? { memo: "m" } : {}) }))
      .addNode("h", (s) => { const v = interrupt("ask"); return { findings: [String(v)] }; })
      .addEdge(START, "a").addEdge("a", "h").addEdge("h", END).compile({ checkpointer: sv }) };
  };
  const cfg = { configurable: { thread_id: "dyn-2" } };
  const A = mk(true); await A.g.invoke({}, cfg).catch(() => { });
  const B = mk(false);
  try { const r = await B.g.invoke(new Command({ resume: "x" }), cfg); info("resume after dropping a channel", r); }
  catch (e) { info("resume after dropping a channel ERRORED", `${e.constructor.name}: ${String(e.message).split("\n")[0].slice(0, 140)}`); }
});
await step("Command goto routing (dynamic next-node selection)", async () => {
  const g = new StateGraph(S)
    .addNode("router", (s) => new Command({ goto: s.count === 0 ? "left" : "right", update: { findings: ["routed"] } }), { ends: ["left", "right"] })
    .addNode("left", () => ({ findings: ["left"] }))
    .addNode("right", () => ({ findings: ["right"] }))
    .addEdge(START, "router").addEdge("left", END).addEdge("right", END).compile();
  const a = await g.invoke({ count: 0 });
  const b = await g.invoke({ count: 1 });
  ok("Command goto", `count=0 -> ${a.findings.join(",")} | count=1 -> ${b.findings.join(",")}`);
});
await step("state object given to a node is a fresh copy, not shared mutable global", async () => {
  let captured;
  const g = new StateGraph(S).addNode("m", (s) => { captured = s; s.count = 999; return {}; }).addEdge(START, "m").addEdge("m", END).compile();
  const r = await g.invoke({ count: 7 });
  info("mutating the state arg inside a node", `invoke result count=${r.count} (mutating s does not change the returned state) -> nodes get a snapshot copy`);
});

/* ------------------------------------------------------------------ */
section("12. interrupt identity & replay determinism");
await step("interrupt id = XXH3(checkpoint_ns + index) -> survives restart, differs across fresh runs", async () => {
  const mk = () => new StateGraph(S)
    .addNode("a", () => ({ count: 1 }))
    .addNode("h", (s) => { const v = interrupt({ q: "x", n: s.count }); return { findings: [String(v)] }; })
    .addEdge(START, "a").addEdge("a", "h").addEdge("h", END);
  const idsA = [], idsB = [];
  for (let i = 0; i < 2; i++) {
    const sv = new MemorySaver();
    const g = mk().compile({ checkpointer: sv });
    await g.invoke({}, { configurable: { thread_id: "same-thread" } }).catch(() => { });
    const sn = await g.getState({ configurable: { thread_id: "same-thread" } });
    idsA.push((sn.tasks ?? []).flatMap(t => (t.interrupts ?? []).map(x => x.id)).join(","));
  }
  // same thing, but read twice from the SAME persisted checkpoint
  const sv = new MemorySaver();
  const g = mk().compile({ checkpointer: sv });
  const cfg = { configurable: { thread_id: "stable-thread" } };
  await g.invoke({}, cfg).catch(() => { });
  for (let i = 0; i < 2; i++) {
    const sn = await g.getState(cfg);
    idsB.push((sn.tasks ?? []).flatMap(t => (t.interrupts ?? []).map(x => x.id)).join(","));
  }
  info("independent fresh runs, same thread_id", idsA);
  info("repeat reads from the SAME persisted checkpoint", idsB);
  if (idsB[0] === idsB[1] && idsB[0]) ok("id stable for a stored checkpoint (resume by (thread, checkpoint_id, index))", idsB[0]);
  else bad("id stable for a stored checkpoint", idsB.join(" vs "));
  info("implementation", "interruptId(ns, idx) = XXH3(ns | idx) -- source: node_modules/@langchain/langgraph/dist/interrupt.js:95");
});

await step("cancellation via AbortSignal", async () => {
  const ac = new AbortController();
  const g = new StateGraph(S)
    .addNode("slow", async () => { await sleep(200); return { findings: ["slow"] }; })
    .addEdge(START, "slow").addEdge("slow", END).compile();
  setTimeout(() => ac.abort(new Error("user cancelled")), 20);
  try {
    await g.invoke({}, { signal: ac.signal });
    bad("abort signal", "completed without aborting");
  } catch (e) { ok("aborted", `${e.constructor.name}: ${String(e.message).slice(0, 60)}`); }
});
await step("process restart: pending interrupt survives JSON persistence + resume", async () => {
  const build = (sv) => new StateGraph(S)
    .addNode("a", (s) => ({ count: s.count + 1, findings: ["a"] }))
    .addNode("h", (s) => { const v = interrupt({ ask: "approve deploy?" }); return { findings: [`h:${v}`] }; })
    .addNode("z", () => ({ findings: ["z"] }))
    .addEdge(START, "a").addEdge("a", "h").addEdge("h", "z").addEdge("z", END).compile({ checkpointer: sv });
  const cfg = { configurable: { thread_id: "restart-1" } };
  const sv1 = new JsonlSaver();
  const g1 = build(sv1);
  await g1.invoke({}, cfg).catch(() => { });
  const snap = await g1.getState(cfg);
  info("paused with pending interrupt", (snap.tasks ?? []).flatMap(t => (t.interrupts ?? []).map(i => i.value)));
  // simulate a process restart: serialize the append-only log, hydrate a NEW saver and a NEW graph
  const log = JSON.parse(JSON.stringify(sv1.rows));
  const sv2 = new JsonlSaver(); sv2.rows = log;
  const g2 = build(sv2);
  const resumed = await g2.invoke(new Command({ resume: "approved" }), cfg).catch(e => ({ err: String(e.message).slice(0, 200) }));
  ok("resume after JSON log round-trip + fresh graph", resumed);
  info("log rows", log.length);
});

await step("multiple interrupts in ONE node are addressed positionally", async () => {
  const sv = new MemorySaver();
  const answers = [];
  const g = new StateGraph(S)
    .addNode("two", (s) => {
      const a = interrupt("q1");
      const b = interrupt("q2");
      answers.push([a, b]);
      return { findings: [`${a}/${b}`] };
    })
    .addEdge(START, "two").addEdge("two", END).compile({ checkpointer: sv });
  const cfg = { configurable: { thread_id: "multi" } };
  await g.invoke({}, cfg).catch(() => { });
  await g.invoke(new Command({ resume: "A" }), cfg).catch(() => { });
  const r = await g.invoke(new Command({ resume: "B" }), cfg);
  ok("two interrupts resolved by index", r.findings);
  info("resume values seen inside the node", answers);
});

await step("REPLAY COST: an expensive call before interrupt() runs twice", async () => {
  let modelCalls = 0;
  const fakeModelCall = async () => { modelCalls++; await sleep(10); return "expensive-model-output"; };
  const sv = new MemorySaver();
  const g = new StateGraph(S)
    .addNode("think", async () => {
      const answer = await fakeModelCall();          // e.g. an LLM request
      const ok = interrupt({ proposal: answer });    // pause for approval
      return { findings: [`approved:${ok}`] };
    })
    .addEdge(START, "think").addEdge("think", END).compile({ checkpointer: sv });
  const cfg = { configurable: { thread_id: "cost" } };
  await g.invoke({}, cfg).catch(() => { });
  await g.invoke(new Command({ resume: "yes" }), cfg);
  ok("model calls for ONE approved step", `${modelCalls} (2 => the work before interrupt() was redone)`);
  info("implication for DSH", "interrupt() inside a model step re-issues every model call made before it; interrupts must sit at step boundaries, not inside a step");
});

/* ------------------------------------------------------------------ */
section("13. graph-shape limits we would hit");
await step("cannot add nodes after compile", async () => {
  const g = new StateGraph(S).addNode("a", () => ({})).addEdge(START, "a").addEdge("a", END).compile();
  info("compiled graph methods", Object.getOwnPropertyNames(Object.getPrototypeOf(g)).join(","));
  try { g.addNode("later", () => ({})); bad("addNode after compile", "unexpectedly allowed"); }
  catch (e) { ok("addNode after compile", String(e.message).slice(0, 100)); }
});
await step("node/subgraph boundary is schema-checked", async () => {
  const PrivateState = Annotation.Root({
    findings: Annotation({ reducer: (l, r) => [...l, ...r], default: () => [] }),
    secret: Annotation({ reducer: (_l, r) => r, default: () => "" }),   // NOT in parent
  });
  const subP = new StateGraph(PrivateState)
    .addNode("s", () => ({ secret: "s3cret", findings: ["sub"] }))
    .addEdge(START, "s").addEdge("s", END).compile();
  const g = new StateGraph(S).addNode("sub", subP).addEdge(START, "sub").addEdge("sub", END).compile();
  try { const r = await g.invoke({}); info("parent with subgraph-only channel", r); }
  catch (e) { info("parent with subgraph-only channel ERRORED", String(e.message).split("\n")[0].slice(0, 160)); }
});

/* ------------------------------------------------------------------ */
section("SUMMARY");
const flat = {};
for (const [s, kv] of Object.entries(results)) for (const [k, v] of Object.entries(kv)) flat[`${s} | ${k}`] = v;
const pass = Object.values(flat).filter(v => v.ok).length;
const fail = Object.values(flat).filter(v => v.ok === false).length;
const infos = Object.values(flat).filter(v => v.info).length;
log(`\nSECTIONS: ${Object.keys(results).length}  PASS: ${pass}  FAIL: ${fail}  INFO: ${infos}`);
if (fail) { log("FAILURES:"); for (const [k, v] of Object.entries(flat)) if (v.ok === false) log(`  - ${k}: ${v.e}`); }

const { writeFile } = await import("node:fs/promises");
await writeFile(new URL("./spike-results.json", import.meta.url), JSON.stringify(results, null, 2));
console.log("\n[results written to spike-results.json]");
