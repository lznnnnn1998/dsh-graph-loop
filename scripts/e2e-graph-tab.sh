#!/usr/bin/env bash
# Graph tab in the real Web chat UI: install the driver bundle + the Graph-tab
# client package into a throwaway web profile, boot, type a message, verify the
# Chat/Trajectory/Graph tabs and screenshot the Graph panel.
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
PORT="${PORT:-3074}"
LLM_PORT="${LLM_PORT:-8189}"
HOME_DIR="${HOME_DIR:-$(mktemp -d "${TMPDIR:-/tmp}/dsh-graph-tab.XXXXXX")}"
LOG="$HOME_DIR/host.log"
cleanup() {
  [ -n "${HOST_PID:-}" ] && kill "$HOST_PID" 2>/dev/null || true
  [ -n "${MOCK_PID:-}" ] && kill "$MOCK_PID" 2>/dev/null || true
}
trap cleanup EXIT

ds() { ( cd "$DSH" && DSH_HOME="$HOME_DIR" node --import tsx/esm apps/cli/src/bin.ts "$@" ); }

echo "== 1. mock LLM + web profile with both packages"
( cd "$DSH" && exec node --import tsx packages/test-support/llm-mock-server/src/bin.ts \
    --sequence tool_call_success,success --repeat-last --success-text "graph tab ok" --tool-name read --tool-arguments '{"path":"README.md"}' --port "$LLM_PORT" > "$HOME_DIR/mock.log" 2>&1 ) &
MOCK_PID=$!
for _ in $(seq 1 40); do grep -q '"type":"ready"' "$HOME_DIR/mock.log" && break; sleep 0.25; done
grep -q '"type":"ready"' "$HOME_DIR/mock.log" || { echo "mock failed"; cat "$HOME_DIR/mock.log"; exit 1; }

ds --profile web --dump-config > /dev/null
ds plugin --profile web add "$ROOT/packages/graph-ui" > /dev/null 2>&1
ds plugin --profile web add "$ROOT/packages/loop" > /dev/null 2>&1
ds --profile web --dump-config > "$HOME_DIR/dump.yml" 2>/dev/null
grep -q 'id: graph-ui' "$HOME_DIR/dump.yml" || { echo "FAIL: graph-ui row missing"; exit 1; }

echo "== 2. boot web on :$PORT"
( cd "$DSH" && exec env DSH_HOME="$HOME_DIR" DEEPSEEK_BASE_URL="http://127.0.0.1:$LLM_PORT" DEEPSEEK_API_KEY=mock \
    node --import tsx/esm apps/cli/src/bin.ts --profile web --port "$PORT" --no-open > "$LOG" 2>&1 ) &
HOST_PID=$!
for _ in $(seq 1 120); do grep -q "dsh web:" "$LOG" && break; sleep 0.5; done
grep -q "dsh web:" "$LOG" || { echo "host failed"; tail -30 "$LOG"; exit 1; }
TOKEN=$(grep -o 'token=[A-Za-z0-9_-]*' "$LOG" | head -1 | cut -d= -f2)

echo "== 3. drive the UI"
node "$ROOT/scripts/ui-graph-tab.mjs" "http://127.0.0.1:$PORT" "$TOKEN" "$PORT"
echo "PASS  e2e Graph tab (screenshot preview/graph-tab-live.png)"
