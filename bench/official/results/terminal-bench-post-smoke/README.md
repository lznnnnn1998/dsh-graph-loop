# Post-smoke Terminal-Bench subset (2026-11-07)

Sequence: **smoke first**, then this fixed 3-task subset.

1. Smoke `smoke/answer-42`: oracle **1.0**, graph **1.0**, stock **1.0** — Docker, Harbor,
   verifier and the DSH adapter are healthy.
   See [`../smoke-answer-42/`](../smoke-answer-42/).
2. Hard subset: `bun-sourcemap-leak`, `foodstuff-beta-activity`, `interleaved-vigenere`;
   native arm64; agent timeout capped at 900 s.

| task | stock | graph |
|---|---|---|
| bun-sourcemap-leak | 0.0 | 0.0 |
| foodstuff-beta-activity | timeout (invalid) | 0.0 |
| interleaved-vigenere | timeout (invalid) | 0.0 |

Graph: **3/3 clean scored trials, all 0.0**. Stock: **1/3 clean, 0.0**; two timeouts.

This confirms the 0.0 results are **agent-quality**, not environment failures. The smoke task
passes 1.0 in all three arms; the hard tasks do not.
