# Smoke after the sandbox-instrument fix — 2026-11-09

Adapter changes under test: both arms now run with a shared profile patch
(`sandbox-policy: danger-full-access`, `llm-deepseek` retries 3); the stock arm also receives the
patch instead of running the unpatched headless default.

```
oracle 1.0
graph  1.0
stock  1.0
```

**Both** arms' runtime context records `Current DSH file policy: danger-full-access` (stock
`jobs/smoke-stock-135646/…`, graph `jobs/smoke-graph-135432/…`;
`zstd -dc <session>.zstd | grep 'Current DSH file policy'` → twice each), so the patch is actually
applied to both arms, not just present in the patch file. Tarball: `dist/dsh-graph-loop-bench.tgz`
sha256 `f7a961a7…` (plugin code unchanged).

Trial metadata also lands for both arms: `agent_result.metadata` carries
`{"agent":"dsh","plugin":"stock|dsh-graph-loop","tool_policy":"preset","agent_exit":0,
"transport_failed":false}`. The oracle trial has `metadata: null` (expected — the oracle is not the
adapter and is not a row).
