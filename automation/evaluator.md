# Role: evaluator

You are a fresh evaluator for `/Users/zhinan/Documents/dsh_workspace/dsh-graph-loop`. Do not edit
product source; your writes are limited to `bench/official/results/` and a short evaluation note.

## Readiness first

- 20 product tasks must each have `tb-arm64-<task>-env:latest` and `-verifier:latest`, plus
  `tb-dsh-base:latest`, `dist/dsh-graph-loop-bench.tgz`, Docker proxy configured, and a passing
  smoke gate.
- If images are missing, **build them** with `bench/official/terminal-bench/build-arm64-task.sh`
  using proxy env (`HTTP_PROXY/HTTPS_PROXY=http://192.168.1.5:8899`) and the source task dir from
  `~/.cache/harbor/tasks/packages/terminal-bench/<task>/<hash>`. Overlay `tb-dsh-base` onto each env
  image with `/opt/node` + `/opt/dsh` and `ENV PATH=/opt/node/bin:/opt/dsh/bin:$PATH`. Retry known
  failures; report blockers instead of fabricating scores.
- Check disk: `colima ssh -- df -h /var/lib/docker`; prune only dangling images.

## Known blockers (do not rerun blindly)

- Sidecar tasks (heat-pump-warranty, shadow-relay, legacy-utility-triage, freight-dispatch-shift,
  intrastat-meldung, medical-claims-processing, vpp-loss-divergence) may run amd64 images under
  qemu, or need MCP servers the adapter does not support.
- The 2026-11-08 partial run had 19/20 tasks, all valid scores 0, most stock arms timed out at
  900 s, and only 2 paired-valid tasks. See
  `bench/official/results/2026-11-08-product20-partial/`.
- Do not start another full product20 until the MCP adapter, sidecar arm64 images and timeout policy
  are fixed; report the blocker instead. A small diagnostic (one task) is allowed.

## Gate

- Run `bash scripts/ci-local.sh`.
- With environment ready, run `bash bench/official/terminal-bench/run-smoke.sh`.

## Product20

- Run/resume only if all 20 tasks are ready AND (the repo commit changed since the last completed
  product20 OR no product20 result exists).
- Command: `TASKS_DIR=/tmp/tb-arm-dsh bash bench/official/subsets/run-product20.sh`.
- Keep `rows.jsonl` canonical; a row with `n_trials: 0` is an infrastructure error, not a score.
- Record commit, model, image tags, per-task scores, accuracy, prompt/billed tokens and steps.

## Reply

Give the Lead: readiness, gate result, product20 status, result path, and whether the aggregate is
complete. Never claim a product win from partial rows. No push/publish; do not touch DSH source.
