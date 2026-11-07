# Changelog

## Unreleased — 0.2.0

- **LangGraph kernel is the default**: `createKernel()`/`runPlan()` use `langgraph` when available,
  with `MinimalKernel` fallback. The live scheduler drives kernel-drivable plans through
  `KernelTopology` (pause-before-node bridge; one superstep per DSH step).
- **Explore mode default**: the one-command installer adds the mode bundle and sets
  `agent-preset-registry.default = explore`; the stock `agent-loop` row is disabled, not removed.
- **Tool policy**: `toolPolicy: preset` keeps the full preset tool set for benchmark harnesses so
  plan filtering cannot hide benchmark tools; `plan` remains the token-saving default.
- **Optional read node**: read-before-write is advisory; a missing input file no longer fails the
  turn and triggers a recovery plan.
- **Formatting retry**: an assistant response that prints tool-call/DSML syntax as text is retried
  on the same graph node instead of advancing without the file.
- **Mutation detection**: `merge`/`combine`/`concatenate`/`split`/`convert`/`export`/`generate`/
  `copy` now mark a task as mutating, so merge-into-file tasks get an edit node.
- **Rename guidance**: the mutation node tells the model to use `bash` (`mv`/`rm`/`mkdir`) for
  rename/move/delete, not to create a copy with `write` and leave the original.
- **Mutation enforcement**: a `d_edit` node that explores without writing gets one corrective
  retry; real mutating bash commands count. Formatting (DSML) retries are capped at one. The
  Terminal-Bench profile caps provider retries at one.
- **Benchmark**: local suite expanded to 20 tasks with mean/median reporting, fixture validation,
  run manifests, and a packed-tarball install/runtime test. Added Terminal-Bench 4.0 and
  NL2Repo-Bench preflights/runbooks. Docker + Harbor + a DSH Terminal-Bench adapter now run a real
  task end to end; the first trial scored 0.0 on both arms (no aggregate yet).
- **Docs**: status/decision/merge/evaluation docs, a docs index, and archived 0.1 history.

## 0.1.2

- LangGraph/Minimal kernel adapters; graph runtime and Graph tab; graph driver bundle.
- One-command install, Explore preset, per-plan tool admission, dynamic topology.

## 0.1.1

- Graph tab + `/graph-chat`; Explore mode bundle; local conformance tests.

## 0.1.0

- First graph-loop driver: per-turn topology, templates, scheduler, session projections.
