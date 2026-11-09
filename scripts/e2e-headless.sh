#!/usr/bin/env bash
# End-to-end: boot a real DSH headless profile with the graph driver, run one
# task against the scripted mock LLM server, and assert the session log shows
# graph-driven steps.
#
# Requires: a DSH source checkout with node_modules, zstd, and this workspace.
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
PORT="${PORT:-8130}"
HOME_DIR="${HOME_DIR:-$(mktemp -d "${TMPDIR:-/tmp}/dsh-explore-e2e.XXXXXX")}"
LOG="$HOME_DIR/mock.log"
# Committed dev overlay template -> absolute path in the temp dir (removed on exit).
. "$ROOT/scripts/lib/dev-patch.sh"
PATCH="$(materialize_dev_patch "$ROOT" dev-headless.patch.yml)"

cleanup() {
  [ -n "${MOCK_PID:-}" ] && kill "$MOCK_PID" 2>/dev/null || true
  rm -f "${PATCH:-}"
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
