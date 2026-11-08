# medical-claims-processing — arm64 sidecar retest (2026-11-09)

The vendor `playwright-mcp` sidecar is amd64-only and never turned healthy under qemu (Chrome never
opened CDP 9222), so the original trials were `n_trials: 0`. A native arm64 sidecar was built from
`mcr.microsoft.com/playwright:v1.56.0-noble` + `@playwright/mcp@0.0.64` with TigerVNC/noVNC/fluxbox
and a `pwuser` home. The prepared task compose now uses
`tb-arm64-medical-claims-sidecar:latest`.

Harbor retest (both arms valid):

- graph: score 0.0, `n_trials: 1`, `n_errors: 0`, criteria **2/27**
- stock: score 0.0, `n_trials: 1`, `n_errors: 0`, criteria **22/27**

DSH still has no SSE MCP client, so the reward is expected 0; the trial is valid, not infra.
Diagnostic evidence, not a product score.
