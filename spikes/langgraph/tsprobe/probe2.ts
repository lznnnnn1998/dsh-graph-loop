import { StateGraph, Annotation, START, END, MemorySaver, interrupt } from "@langchain/langgraph";

const S = Annotation.Root({
  input: Annotation<string>({ reducer: (_l, r) => r, default: () => "" }),
  count: Annotation<number>({ reducer: (_l, r) => r, default: () => 0 }),
});

const g = new StateGraph(S)
  .addNode("a", (s) => ({ count: s.count + 1 }))
  .addEdge(START, "a")
  .addEdge("a", END)
  .compile({ checkpointer: new MemorySaver() });

const r = await g.invoke({ input: "hi" });
// A: is state inferred from the graph?
const okNum: number = r.count;
const okStr: string = r.input;

// B: does an unknown state key error?
const bogus1 = r.nonexistent;

// C: wrong type on node return
const g2 = new StateGraph(S)
  .addNode("bad", (s) => ({ count: "not-a-number" }))
  .addEdge(START, "bad");

// D: unknown key on node return
const g3 = new StateGraph(S)
  .addNode("bad2", (s) => ({ nope: 1 }))
  .addEdge(START, "bad2");

// E: interrupt generic
const g4 = new StateGraph(S).addNode("h", () => {
  const v = interrupt<{ q: string }, string>({ q: "ok?" });
  const check: string = v;
  const badCheck: number = v;
  return {};
}).addEdge(START, "h");

// F: config typing in node
const g5 = new StateGraph(S).addNode("cfg", (s, cfg) => {
  const tid: string | undefined = cfg?.configurable?.thread_id;
  return {};
}).addEdge(START, "cfg");

export { okNum, okStr, bogus1, g2, g3, g4, g5 };
