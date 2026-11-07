# Environment smoke test — answer-42

Trivial Terminal-Bench task used to validate Docker, Harbor, the verifier, the DSH adapter, and the
stock control **before** running a benchmark subset.

- Task: create `/app/answer.txt` containing `42` ([`smoke-task/`](../../terminal-bench/smoke-task/))
- Environment: native linux/arm64 `python:3.12-slim` with a baked DSH runtime (`/opt/dsh`)
- Model: `deepseek-flash` (V4.1-Flash-1017)
- Commands: [`run-smoke.sh`](../../terminal-bench/run-smoke.sh)

| arm | reward | runtime |
|---|---|---|
| oracle | **1.0** | 11 s |
| graph plugin | **1.0** | 24 s |
| stock DSH | **1.0** | 15 s |

This proves the harness and adapter are healthy. A subsequent hard-subset score of 0 is an agent
quality signal, not an environment failure.
