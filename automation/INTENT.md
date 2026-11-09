# Intent (north star)

**Product:** a graph-native agent loop for DSH. `packages/loop` replaces the stock `agent-loop`
through `AgentFactory` (architecture B). Keep the stock strengths — session/turn/step, tools,
persistence, approvals, UI — and add the LangGraph strengths: typed state, conditional edges,
checkpoints, and a parallel/kernel execution model.

**Quality bar:** every stage must classify from typed state and observed facts, not from a fixed
chain or a prompt instruction. A composed plan may be bounded, but it must have reachable,
state-driven exits; a failed stage must escalate or answer, never livelock until `GRAPH_FAILED`.
Dynamic/model-authored topology, checkpoint/resume, replan, fan-out/join and kernel parity are part
of the product, not optional decorations.

**Evidence hierarchy (highest first):**

1. deterministic tests and three-engine drills against the real driver;
2. real session traces (node visits, step facts, tool effects, repair/answer transitions);
3. a bounded real-model diagnostic on a small task set, when a change needs model behavior;
4. a full product20 aggregate, only as **evidence** that the loop behaves well end to end.

**Testing serves the loop.** Product20, smoke and the benchmark instrument exist to measure the
loop's behavior; they are not the goal. A cycle that only repacks tarballs, repairs docs or polishes
benchmark accounting without improving graph-loop correctness/generality has failed its intent.

**Non-goals:** a new product, a new benchmark line, a general agent framework, reopening
architecture A/B, score maximization without behavioral evidence, and edits to
`/Users/zhinan/deepseek-harness`.

**Guardrails:** local git only; no push/publish/tokens; never fabricate a score; preserve current
evidence; never run `git clean` or `git add -A` while untracked run evidence exists.
