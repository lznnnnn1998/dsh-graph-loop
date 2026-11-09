#!/usr/bin/env bash
# Run the same task through stock agent-loop and the graph driver, then check the
# documented event invariants on both session logs. Step counts may differ.
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
LLM_PORT="${LLM_PORT:-8198}"
STOCK_HOME="${STOCK_HOME:-$(mktemp -d "${TMPDIR:-/tmp}/dsh-conf-stock.XXXXXX")}"
GRAPH_HOME="${GRAPH_HOME:-$(mktemp -d "${TMPDIR:-/tmp}/dsh-conf-graph.XXXXXX")}"
# Committed dev overlay template -> absolute path in the temp dir (removed on exit).
. "$ROOT/scripts/lib/dev-patch.sh"
PATCH="$(materialize_dev_patch "$ROOT" dev-headless.patch.yml)"
cleanup() { [ -n "${MOCK_PID:-}" ] && kill "$MOCK_PID" 2>/dev/null || true; rm -f "${PATCH:-}"; }
trap cleanup EXIT

start_mock() {
  ( cd "$DSH" && exec node --import tsx packages/test-support/llm-mock-server/src/bin.ts \
      --sequence tool_call_success,success --repeat-last --success-text "done" \
      --tool-name read --tool-arguments '{"path":"README.md"}' --port "$1" > "$2" 2>&1 ) &
  MOCK_PID=$!
  for _ in $(seq 1 40); do grep -q '"type":"ready"' "$2" && break; sleep 0.25; done
  grep -q '"type":"ready"' "$2" || { echo "mock failed"; cat "$2"; exit 1; }
}

echo "== stock loop"
start_mock "$LLM_PORT" "$STOCK_HOME/mock.log"
( cd "$DSH" && DSH_HOME="$STOCK_HOME" DEEPSEEK_BASE_URL="http://127.0.0.1:$LLM_PORT" DEEPSEEK_API_KEY=mock \
    node --import tsx/esm apps/cli/src/bin.ts --profile headless "read the README and summarize" > /dev/null 2>&1 )
kill "$MOCK_PID" 2>/dev/null || true

echo "== graph driver"
start_mock "$((LLM_PORT + 1))" "$GRAPH_HOME/mock.log"
( cd "$DSH" && DSH_HOME="$GRAPH_HOME" DEEPSEEK_BASE_URL="http://127.0.0.1:$((LLM_PORT + 1))" DEEPSEEK_API_KEY=mock \
    node --import tsx/esm apps/cli/src/bin.ts --profile headless \
    --patch "$PATCH" "read the README and summarize" > /dev/null 2>&1 )

STOCK_LOG=$(ls -t "$STOCK_HOME"/sessions/*/*/session.v4.jsonl.zstd | head -1)
GRAPH_LOG=$(ls -t "$GRAPH_HOME"/sessions/*/*/session.v4.jsonl.zstd | head -1)
echo "== invariants"
node "$ROOT/scripts/conformance-diff.mjs" "$STOCK_LOG"
node "$ROOT/scripts/conformance-diff.mjs" "$GRAPH_LOG"
echo "PASS  conformance invariants on both loops"
