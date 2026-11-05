/** Is LangSmith tracing active by default? Does a bare graph run make any network call? */
const calls = [];
const realFetch = globalThis.fetch;
globalThis.fetch = (...args) => { calls.push(String(args[0]).slice(0, 120)); return Promise.reject(new Error("network disabled in probe")); };

const envBefore = Object.fromEntries(
  ["LANGCHAIN_TRACING_V2", "LANGSMITH_TRACING", "LANGCHAIN_TRACING", "LANGCHAIN_API_KEY", "LANGSMITH_API_KEY",
   "LANGCHAIN_ENDPOINT", "LANGSMITH_ENDPOINT", "LANGCHAIN_PROJECT", "LANGCHAIN_CALLBACKS_BACKGROUND"]
    .map(k => [k, process.env[k] ?? "(unset)"])
);
console.log("env at boot:", JSON.stringify(envBefore));

const { StateGraph, Annotation, START, END } = await import("@langchain/langgraph");
const S = Annotation.Root({ x: Annotation({ reducer: (_l, r) => r, default: () => 0 }) });
const g = new StateGraph(S).addNode("n", () => ({ x: 1 })).addEdge(START, "n").addEdge("n", END).compile();
await g.invoke({});
await new Promise(r => setTimeout(r, 250)); // let any background callback flush

console.log("fetch calls during a bare graph run:", calls.length, calls);
globalThis.fetch = realFetch;

// what the tracer would need
const { getEnvironmentVariable } = await import("@langchain/core/utils/env");
console.log("tracing enabled by default?", getEnvironmentVariable("LANGCHAIN_TRACING_V2") ?? getEnvironmentVariable("LANGSMITH_TRACING") ?? "(unset => tracing off)");
console.log("langsmith module reachable:", await import("langsmith").then(m => Object.keys(m).length + " exports").catch(e => "ERR " + e.message));
