#!/usr/bin/env bash
# End-to-end for model-authored topology: the scripted model calls `graph_plan`
# with a two-node graph; the harness validates it and the driver executes it.
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
PORT="${PORT:-8147}"
HOME_DIR="${HOME_DIR:-$(mktemp -d "${TMPDIR:-/tmp}/dsh-explore-propose.XXXXXX")}"
LOG="$HOME_DIR/mock.log"
# Committed dev overlay template -> absolute path in the temp dir (removed on exit).
. "$ROOT/scripts/lib/dev-patch.sh"
PATCH="$(materialize_dev_patch "$ROOT" dev-propose.patch.yml)"
cleanup() { [ -n "${MOCK_PID:-}" ] && kill "$MOCK_PID" 2>/dev/null || true; rm -f "${PATCH:-}"; }
trap cleanup EXIT

PROPOSAL='{"rationale":"read then answer","entry":"p1","nodes":[{"id":"p1","tool":"read","instruction":"Read the README and extract the project summary."},{"id":"p2","kind":"terminal","instruction":"Answer with the summary."}],"edges":[{"from":"p1","to":"p2"}]}'

echo "== 1. mock LLM (graph_plan tool call, then a final answer)"
( cd "$DSH" && exec node --import tsx packages/test-support/llm-mock-server/src/bin.ts \
    --sequence tool_call_success,success --repeat-last --success-text "Proposed topology done." \
    --tool-name graph_plan --tool-arguments "$PROPOSAL" --port "$PORT" > "$LOG" 2>&1 ) &
MOCK_PID=$!
for _ in $(seq 1 40); do grep -q '"type":"ready"' "$LOG" && break; sleep 0.25; done
grep -q '"type":"ready"' "$LOG" || { echo "mock failed"; cat "$LOG"; exit 1; }

echo "== 2. run the propose-mode profile"
( cd "$DSH" && DSH_HOME="$HOME_DIR" DEEPSEEK_BASE_URL="http://127.0.0.1:$PORT" DEEPSEEK_API_KEY=mock \
    node --import tsx/esm apps/cli/src/bin.ts --profile headless --patch "$PATCH" \
    "summarize this project" ) > "$HOME_DIR/run.out" 2> "$HOME_DIR/run.err" || {
  echo "FAIL: dsh exited nonzero"; tail -20 "$HOME_DIR/run.err"; exit 1; }
cat "$HOME_DIR/run.out"

echo "== 3. assert the model-authored nodes ran"
SESSION=$(ls -t "$HOME_DIR"/sessions/*/*/session.v4.jsonl.zstd | head -1)
zstd -dc "$SESSION" > "$HOME_DIR/session.jsonl"
STEPS=$(grep -c '"type":"step/start"' "$HOME_DIR/session.jsonl" || true)
grep -q '\[graph node p1\]' "$HOME_DIR/session.jsonl" || { echo "FAIL: adopted node p1 never ran"; exit 1; }
grep -q '\[graph node p2\]' "$HOME_DIR/session.jsonl" || { echo "FAIL: adopted node p2 never ran"; exit 1; }
echo "steps=$STEPS"
echo "PASS  e2e model-authored topology  (home: $HOME_DIR)"
