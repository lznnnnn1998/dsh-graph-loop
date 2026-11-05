#!/usr/bin/env bash
# End-to-end through the INSTALLED bundle (no --patch): create a headless-backed
# `explore` profile, install packages/loop, run one task against the mock LLM.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DSH="${DSH_ROOT:-/Users/zhinan/deepseek-harness}"
PORT="${PORT:-8135}"
HOME_DIR="${HOME_DIR:-$(mktemp -d /tmp/dsh-explore-inst.XXXXXX)}"
LOG="$HOME_DIR/mock.log"
cleanup() { [ -n "${MOCK_PID:-}" ] && kill "$MOCK_PID" 2>/dev/null || true; }
trap cleanup EXIT

ds() { ( cd "$DSH" && DSH_HOME="$HOME_DIR" node --import tsx/esm apps/cli/src/bin.ts "$@" ); }

echo "== 1. create profile from the headless template"
ds --profile explore --from-default-profile headless --dump-config > /dev/null

echo "== 2. install the bundle"
ds plugin --profile explore add "$ROOT/packages/loop" > /dev/null
ds --profile explore --dump-config > "$HOME_DIR/dump.yml"
grep -q 'id: graph-loop' "$HOME_DIR/dump.yml" || { echo "FAIL: graph-loop row missing"; exit 1; }

echo "== 3. mock LLM"
( exec node --import tsx "$DSH/packages/test-support/llm-mock-server/src/bin.ts" \
    --sequence tool_call_success,success --repeat-last --success-text "Installed graph loop OK." \
    --tool-name read --tool-arguments '{"path":"README.md"}' --port "$PORT" > "$LOG" 2>&1 ) &
MOCK_PID=$!
for _ in $(seq 1 40); do grep -q '"type":"ready"' "$LOG" && break; sleep 0.25; done
grep -q '"type":"ready"' "$LOG" || { echo "mock failed"; cat "$LOG"; exit 1; }

echo "== 4. run one task"
DEEPSEEK_BASE_URL="http://127.0.0.1:$PORT" DEEPSEEK_API_KEY=mock \
  ds --profile explore "explain how the config loader works" > "$HOME_DIR/run.out" 2> "$HOME_DIR/run.err" || {
  echo "FAIL: dsh exited nonzero"; tail -20 "$HOME_DIR/run.err"; exit 1; }
cat "$HOME_DIR/run.out"

echo "== 5. assert graph steps"
SESSION=$(ls -t "$HOME_DIR"/sessions/*/*/session.v4.jsonl.zstd | head -1)
zstd -dc "$SESSION" > "$HOME_DIR/session.jsonl"
STEPS=$(grep -c '"type":"step/start"' "$HOME_DIR/session.jsonl" || true)
NODES=$(grep -c '\[graph node ' "$HOME_DIR/session.jsonl" || true)
echo "steps=$STEPS graph_node_messages=$NODES"
[ "$STEPS" -ge 2 ] || { echo "FAIL: expected >=2 steps"; exit 1; }
[ "$NODES" -ge 2 ] || { echo "FAIL: expected graph directives"; exit 1; }
echo "PASS  e2e installed bundle  (home: $HOME_DIR)"
