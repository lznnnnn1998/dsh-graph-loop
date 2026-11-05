/** Which packages does importing @langchain/langgraph actually load? */
import { register } from "node:module";
register("./probe-hook.mjs", import.meta.url);
const t = performance.now();
await import("@langchain/langgraph");
console.error(`\n[import wall clock: ${(performance.now() - t).toFixed(0)}ms]`);
