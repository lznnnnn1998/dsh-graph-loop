#!/usr/bin/env bash
# Boundary replan: the verify node's `bash` command fails, the driver marks the
# node failed, and the scheduler installs a diagnosis→retry→answer recovery graph.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# Resolve the read-only DSH checkout: $DSH_REPO wins, then a sibling clone
# (../deepseek-harness) or ~/deepseek-harness. Fail clearly when none exists.
find_dsh() {
  local candidate
  for candidate in "${DSH_REPO:-}" "${DSH_ROOT:-}" "$ROOT/../deepseek-harness" "$HOME/deepseek-harness"; do
    if [ -n "$candidate" ] && [ -d "$candidate" ]; then
      (cd "$candidate" && pwd)
      return 0
    fi
  done
  return 1
}
if ! DSH="$(find_dsh)"; then
  echo "FAIL: no DSH checkout found; set DSH_REPO=/path/to/deepseek-harness" >&2
  echo "      (or place a clone next to this repo as ../deepseek-harness)" >&2
  exit 1
fi
PORT="${PORT:-8156}"
HOME_DIR="${HOME_DIR:-$(mktemp -d "${TMPDIR:-/tmp}/dsh-explore-replan.XXXXXX")}"
LOG="$HOME_DIR/mock.log"
# Committed dev overlay template -> absolute path in the temp dir (removed on exit).
. "$ROOT/scripts/lib/dev-patch.sh"
PATCH="$(materialize_dev_patch "$ROOT" dev-headless.patch.yml)"
cleanup() { [ -n "${MOCK_PID:-}" ] && kill "$MOCK_PID" 2>/dev/null || true; rm -f "${PATCH:-}"; }
trap cleanup EXIT

echo "== 1. mock LLM: three plain steps, then a failing bash call, then text"
( cd "$DSH" && exec node --import tsx packages/test-support/llm-mock-server/src/bin.ts \
    --sequence success,success,success,tool_call_success,success --repeat-last \
    --success-text "step ok" --tool-name bash --tool-arguments '{"command":"false"}' \
    --port "$PORT" > "$LOG" 2>&1 ) &
MOCK_PID=$!
for _ in $(seq 1 40); do grep -q '"type":"ready"' "$LOG" && break; sleep 0.25; done
grep -q '"type":"ready"' "$LOG" || { echo "mock failed"; cat "$LOG"; exit 1; }

echo "== 2. run a mutating task (entry → read → edit → verify)"
( cd "$DSH" && DSH_HOME="$HOME_DIR" DEEPSEEK_BASE_URL="http://127.0.0.1:$PORT" DEEPSEEK_API_KEY=mock \
    node --import tsx/esm apps/cli/src/bin.ts --profile headless --patch "$PATCH" \
    "fix the failing test in the config loader" ) > "$HOME_DIR/run.out" 2> "$HOME_DIR/run.err" || {
  echo "FAIL: dsh exited nonzero"; tail -20 "$HOME_DIR/run.err"; exit 1; }
cat "$HOME_DIR/run.out"

echo "== 3. assert the recovery graph ran"
SESSION=$(ls -t "$HOME_DIR"/sessions/*/*/session.v4.jsonl.zstd | head -1)
zstd -dc "$SESSION" > "$HOME_DIR/session.jsonl"
grep -q '\[graph node r_diagnose\]' "$HOME_DIR/session.jsonl" || { echo "FAIL: no recovery node"; exit 1; }
grep -q '\[graph node r_retry\]' "$HOME_DIR/session.jsonl" || { echo "FAIL: no retry node"; exit 1; }
STEPS=$(grep -c '"type":"step/start"' "$HOME_DIR/session.jsonl" || true)
echo "steps=$STEPS"
echo "PASS  e2e boundary replan  (home: $HOME_DIR)"
