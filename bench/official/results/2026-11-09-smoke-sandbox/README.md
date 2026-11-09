# Smoke after the sandbox-instrument fix — 2026-11-09

Adapter changes under test: both arms now run with a shared profile patch
(`sandbox-policy: danger-full-access`, `llm-deepseek` retries 3); the stock arm also receives the
patch instead of running the unpatched headless default.

```
oracle 1.0
graph  1.0
stock  1.0
```

The stock session's runtime context records `Current DSH file policy: danger-full-access`, so the
patch is actually applied. Tarball: `dist/dsh-graph-loop-bench.tgz` sha256 `f7a961a7…` (plugin code
unchanged).
