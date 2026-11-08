# product20 partial run — 2026-11-08

**Not a valid product aggregate.** 19 of 20 tasks were attempted; `formal-crypto` has no verifier
image. Raw rows: [`rows.jsonl`](rows.jsonl); counts: [`summary.json`](summary.json).

- 11 graph trials completed and scored **0.0**.
- Only 3 stock trials completed; most stock arms hit the 900 s timeout.
- Only **2 tasks** (`bun-sourcemap-leak`, `cargo-flight-dispatch`) have valid trials on both arms;
  both are **0.0/0.0**.
- Sidecar tasks (heat-pump, shadow, legacy, freight, etc.) ran amd64 images under qemu; their errors
  are infrastructure, not agent scores.
- Tasks requiring MCP servers fail because the DSH adapter does not declare/implement
  `mcp_servers`.

Conclusion: **no product claim**. Fix the adapter (MCP), sidecar arm64 images and timeout policy
before another full product20 run.
