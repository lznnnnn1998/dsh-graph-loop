/** Minimal diagnosis: is `Send[]` a node return value or a conditional-edge router result? */
import { StateGraph, Annotation, START, END, Send } from "@langchain/langgraph";

const S = Annotation.Root({
  items: Annotation({ reducer: (_l, r) => r, default: () => [] }),
  results: Annotation({ reducer: (l, r) => [...l, ...r], default: () => [] }),
});

console.log("--- A. node body returns Send[] (the failing form) ---");
try {
  const wrong = new StateGraph(S)
    .addNode("dispatch", (s) => s.items.map((i) => new Send("work", { item: i })))
    .addNode("work", (s) => ({ results: [`done:${s.item}`] }))
    .addNode("collect", (s) => ({ results: [`n=${s.results.length}`] }))
    .addEdge(START, "dispatch")
    .addConditionalEdges("dispatch", () => ["work"], ["work"])   // edge exists, so it compiles
    .addEdge("work", "collect").addEdge("collect", END)
    .compile();
  await wrong.invoke({ items: ["a"] });
  console.log("A: NO ERROR");
} catch (e) {
  console.log(`A: ${e.constructor.name}: ${String(e.message).split("\n")[0]}`);
}

console.log("--- B. conditional-edge router returns Send[] (the supported form) ---");
const right = new StateGraph(S)
  .addNode("prepare", (s) => ({ items: s.items }))
  .addNode("work", (s) => ({ results: [`done:${s.item}`] }))
  .addNode("collect", (s) => ({ results: [`n=${s.results.length}`] }))
  .addEdge(START, "prepare")
  .addConditionalEdges("prepare", (s) => s.items.map((i) => new Send("work", { item: i })), ["work"])
  .addEdge("work", "collect").addEdge("collect", END)
  .compile();
console.log("B:", JSON.stringify(await right.invoke({ items: ["a", "b", "c"] })));

console.log("--- C. fan-out width is data-driven, not graph-driven ---");
const n = 6;
const wide = await new StateGraph(S)
  .addNode("prepare", (s) => ({ items: s.items }))
  .addNode("work", (s) => ({ results: [`done:${s.item}`] }))
  .addNode("collect", (s) => ({ results: [`n=${s.results.length}`] }))
  .addEdge(START, "prepare")
  .addConditionalEdges("prepare", (s) => s.items.map((i) => new Send("work", { item: i })), ["work"])
  .addEdge("work", "collect").addEdge("collect", END)
  .compile().invoke({ items: Array.from({ length: n }, (_, i) => `i${i}`) });
console.log(`C: ${n} branches ->`, JSON.stringify(wide.results));
console.log("C: Send payload keys are not type-checked against the graph state (`Args = any`)");
