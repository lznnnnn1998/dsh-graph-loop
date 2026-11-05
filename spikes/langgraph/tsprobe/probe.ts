import { StateGraph, Annotation, START, END, MemorySaver, interrupt, Command, Send, type CompiledStateGraph, type LangGraphRunnableConfig } from "@langchain/langgraph";

const S = Annotation.Root({
  input: Annotation<string>({ reducer: (_l, r) => r, default: () => "" }),
  findings: Annotation<string[]>({ reducer: (l, r) => [...l, ...r], default: () => [] }),
  count: Annotation<number>({ reducer: (_l, r) => r, default: () => 0 }),
});
type State = typeof S.State;
type Update = typeof S.Update;

// 1. do node return types get checked?
const g = new StateGraph(S)
  .addNode("a", (s: State): Update => ({ count: s.count + 1 }))
  .addNode("b", (_s) => ({ findings: ["x"], bogus: 1 }))   // <- wrong field: should error
  .addEdge(START, "a")
  .addConditionalEdges("a", (s) => (s.count > 0 ? "b" : END), ["b", END])
  .addEdge("b", END);

const compiled: CompiledStateGraph<any, any, any> = g.compile({ checkpointer: new MemorySaver() });

// 2. invoke typing
const r = await compiled.invoke({ input: "hi" }, { configurable: { thread_id: "t" } });
const n: number = r.count;

// 3. interrupt generic inference
const g2 = new StateGraph(S).addNode("h", (s) => {
  const v = interrupt<{ q: string }, string>({ q: "ok?" });
  return { findings: [v.toUpperCase()] };
}).addEdge(START, "h");

// 4. custom saver must satisfy abstract class
import { BaseCheckpointSaver } from "@langchain/langgraph-checkpoint";
class MySaver extends BaseCheckpointSaver {
  async getTuple(_c: any) { return undefined; }
  async *list(_c: any) {}
  async put(_c: any, _ck: any, _md: any, _nv: any) { return _c; }
  async putWrites(_c: any, _w: any, _t: string) {}
  async deleteThread(_t: string) {}
}

export { n };
