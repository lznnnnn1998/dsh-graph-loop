# Docs

Current documents only. Historical plans, audits and volatile run state are local-only and are not
tracked here.

| Doc | Purpose |
|---|---|
| [KERNEL-COVERAGE.md](KERNEL-COVERAGE.md) | Plan shape → engine → test, with the source files that define each behavior |
| [MERGE-LANGGRAPH.md](MERGE-LANGGRAPH.md) | DSH / LangGraph / repo ownership and what remains to absorb |
| [PUBLISHING.md](PUBLISHING.md) | package names, build checks and release steps |
| [../README.md](../README.md) | product overview, install, requirements and limitations |

Package docs: [`core`](../packages/core/README.md), [`loop`](../packages/loop/README.md),
[`graph-ui`](../packages/graph-ui/README.md), [`mode`](../packages/mode/README.md).

## Docs contract

Tracked docs describe the current code and stay pointer-based: one fact lives in one file, and other
files link to it instead of copying it. Do not put volatile state in tracked docs — no scores,
benchmark narration, commit ids, tarball hashes, PIDs, run directories, dates, machine paths, or
"currently running/blocked" statements. That state belongs in local-only paths or in the tool or
script that owns it. History belongs in `git log`, not in prose. When code and a doc disagree, fix
the doc; if a claim cannot be checked against code, delete it rather than guessing.
