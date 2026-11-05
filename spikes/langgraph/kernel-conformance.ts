/**
 * End-to-end conformance: run the real `@langchain/langgraph@1.7.0` through
 * `createLangGraphKernel` from `design/kernel.ts`.
 *
 * Proves three things at once:
 *   1. type-level  — 1.7.0 satisfies the `LangGraphSurface` port;
 *   2. runtime     — the symbols the adapter instantiates still exist;
 *   3. behavioural — a `TaskPlan` compiles into a StateGraph and the
 *      `KernelRunHandle` yields one durable boundary per node, then `done`.
 *
 * Run: node --experimental-strip-types kernel-conformance.ts
 */
import * as LG from "@langchain/langgraph";
import {
  assertLangGraphSurface,
  createLangGraphKernel,
  createDeterministicHooks,
  type LangGraphSurface,
} from "../../design/kernel.ts";
import type { GraphState, Json, PlanNode, TaskPlan } from "../../design/graph-schema.ts";

// ---- 1. type-level conformance ---------------------------------------------
// Fails to compile if 1.7.0 renames or moves a symbol the kernel depends on.
const surface: LangGraphSurface = LG;

// ---- 2. runtime conformance ------------------------------------------------
assertLangGraphSurface(LG);
console.log("[PASS] type + runtime: @langchain/langgraph@1.7.0 satisfies LangGraphSurface");

// ---- fixtures ---------------------------------------------------------------
const plan: TaskPlan = {
  id: "plan-1",
  templateId: "tmpl-1",
  version: 1,
  entry: "n1",
  terminals: ["n2"],
  nodes: [
    { id: "n1", kind: "agent-step", executor: "step" } as PlanNode,
    { id: "n2", kind: "terminal", executor: "step" } as PlanNode,
  ],
  edges: [{ from: "n1", to: "n2", kind: "control" }],
  budget: { maxNodes: 4, maxSteps: 4, maxTokens: 1000, maxWallMs: 10_000, maxReplans: 1 },
  toolUniverse: [],
  gatePolicy: "never",
  fallback: false,
  confidence: 1,
  compiledDigest: "deadbeefdeadbeef",
};

const initial: GraphState = {
  taskHash: "abcdabcdabcdabcd",
  planId: plan.id,
  planVersion: plan.version,
  superstep: 0,
  next: null,
  status: "running",
  facts: {},
  artifacts: [],
  children: [],
  journal: [],
  budget: { nodes: 0, steps: 0, tokens: 0, wallMs: 0 },
  replans: 0,
};

const executed: string[] = [];
let seq = 100;

const kernel = createLangGraphKernel({
  lg: surface,
  determinism: createDeterministicHooks("conformance"),
  checkpointer: {
    load: async () => undefined,
    put: async (_sessionId, _atSeq, state) => {
      // Assert C1 on every checkpoint write, exactly as the bundle will.
      const { assertJsonSafe } = await import("../../design/graph-schema.ts");
      const problem = assertJsonSafe(state);
      if (problem !== null) throw new Error(`checkpoint state is not JSON: ${problem}`);
    },
  },
  executors: [
    {
      kind: "step",
      execute: async (node, _context) => {
        executed.push(node.id);
        return {
          nodeId: node.id,
          ok: true,
          facts: { [`ran:${node.id}`]: true } as { [key: string]: Json },
          artifacts: [],
          atSeq: ++seq,
        };
      },
    },
  ],
  afterNode: async ({ node, state, superstep }) => {
    const nextState: GraphState = {
      ...state,
      superstep: superstep + 1,
      next: plan.terminals.includes(node.id) ? null : "n2",
      journal: [...state.journal, { nodeId: node.id, superstep, outcome: "ok" as const, atSeq: seq }],
      budget: { ...state.budget, nodes: state.budget.nodes + 1, steps: state.budget.steps + 1 },
    };
    return { atSeq: seq, state: nextState };
  },
});

// ---- 3. behavioural conformance --------------------------------------------
const handle = kernel.compile(plan, initial);
const results: string[] = [];
for (let i = 0; i < 10; i++) {
  const result = await handle.next();
  results.push(result.kind);
  if (result.kind === "boundary") {
    console.log(
      `[PASS] boundary ${i}: node=${result.nodeId} superstep=${result.boundary.superstep} atSeq=${result.boundary.atSeq}`,
    );
  }
  if (result.kind !== "boundary") break;
}

console.log("[INFO] result kinds:", results.join(" -> "));
console.log("[INFO] nodes executed:", executed.join(" -> "));
const finalState = handle.snapshot();
console.log(
  "[INFO] final state:",
  JSON.stringify({
    superstep: finalState.superstep,
    status: finalState.status,
    budget: finalState.budget,
    journal: finalState.journal.length,
  }),
);
await handle.dispose();

const ok =
  executed.join(",") === "n1,n2" &&
  results.join(",") === "boundary,boundary,done" &&
  finalState.superstep === 2 &&
  finalState.journal.length === 2;
console.log(ok ? "[PASS] kernel drove TaskPlan -> StateGraph -> 2 boundaries -> done" : "[FAIL] unexpected sequence");
if (!ok) throw new Error("kernel conformance failed");

// ---- 4. cross-file contract: kernel.ts output == runtime.ts KernelPort ------
// `design/runtime.ts` declares `KernelPort`; this asserts the implementation
// exported by `design/kernel.ts` is assignable to it. Pure type-level: emits no
// runtime code, so the file still executes under --experimental-strip-types.
import type { KernelPort } from "../../design/runtime.ts";

type AssertAssignable<A extends B, B> = A;
type _KernelPortSatisfiesRuntimePort = AssertAssignable<
  ReturnType<typeof createLangGraphKernel>,
  KernelPort
>;
export type { _KernelPortSatisfiesRuntimePort };
