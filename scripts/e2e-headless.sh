#!/usr/bin/env bash
# End-to-end: boot a real DSH headless profile with the graph driver, run one
# task against the scripted mock LLM server, and assert the session log shows
# graph-driven steps.
#
# Requires: a DSH source checkout with node_modules, zstd, and this workspace.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DSH="${DSH_ROOT:-/Users/zhinan/deepseek-harness}"
PORT="${PORT:-8130}"
HOME_DIR="${HOME_DIR:-$(mktemp -d /tmp/dsh-explore-e2e.XXXXXX)}"
LOG="$HOME_DIR/mock.log"
PATCH="$ROOT/packages/loop/dev-headless.patch.yml"

cleanup() {
  [ -n "${MOCK_PID:-}" ] && kill "$MOCK_PID" 2>/dev/null || true
}
trap cleanup EXIT

echo "== 1. mock LLM server on :$PORT"
( cd "$DSH" && exec node --import tsx packages/test-support/llm-mock-server/src/bin.ts \
    --sequence tool_call_success,success --repeat-last \
    --success-text "Graph done." \
    --tool-name read --tool-arguments '{"path":"README.md"}' \
    --port "$PORT" > "$LOG" 2>&1 ) &
MOCK_PID=$!
for _ in $(seq 1 40); do grep -q '"type":"ready"' "$LOG" && break; sleep 0.25; done
grep -q '"type":"ready"' "$LOG" || { echo "mock server failed"; cat "$LOG"; exit 1; }

echo "== 2. run one task through the graph driver"
set +e
( cd "$DSH" && DSH_HOME="$HOME_DIR" DEEPSEEK_BASE_URL="http://127.0.0.1:$PORT" DEEPSEEK_API_KEY=mock \
    node --import tsx/esm apps/cli/src/bin.ts --profile headless --patch "$PATCH" \
    "explain how the config loader works" ) > "$HOME_DIR/run.out" 2> "$HOME_DIR/run.err"
STATUS=$?
set -e
cat "$HOME_DIR/run.out"
[ "$STATUS" -eq 0 ] || { echo "dsh exited $STATUS"; cat "$HOME_DIR/run.err"; exit 1; }

echo "== 3. assert the session log"
SESSION=$(ls -t "$HOME_DIR"/sessions/*/*/session.v4.jsonl.zstd | head -1)
zstd -dc "$SESSION" > "$HOME_DIR/session.jsonl"
STEPS=$(grep -c '"type":"step/start"' "$HOME_DIR/session.jsonl" || true)
NODES=$(grep -c '\[graph node ' "$HOME_DIR/session.jsonl" || true)
echo "steps=$STEPS graph_node_messages=$NODES"
[ "$STEPS" -ge 2 ] || { echo "FAIL: expected >=2 graph steps"; exit 1; }
[ "$NODES" -ge 2 ] || { echo "FAIL: expected graph node directives"; exit 1; }
grep -q '"type":"turn/end"' "$HOME_DIR/session.jsonl" || { echo "FAIL: no turn/end"; exit 1; }
echo "PASS  e2e headless graph loop  (home: $HOME_DIR)"
