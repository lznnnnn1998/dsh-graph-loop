#!/usr/bin/env bash
# Cross-loop resume: a session written by the stock agent-loop must resume under
# the graph driver, and a session written by the graph driver must resume under
# the stock loop. Events are the only interface; both directions must work.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DSH="${DSH_ROOT:-/Users/zhinan/deepseek-harness}"
LLM_PORT="${LLM_PORT:-8207}"
HOME_DIR="${HOME_DIR:-$(mktemp -d /tmp/dsh-cross-loop.XXXXXX)}"
PATCH="$ROOT/packages/loop/dev-headless.patch.yml"
cleanup() { [ -n "${MOCK_PID:-}" ] && kill "$MOCK_PID" 2>/dev/null || true; }
trap cleanup EXIT

( cd "$DSH" && exec node --import tsx packages/test-support/llm-mock-server/src/bin.ts \
    --sequence success --repeat-last --success-text "cross ok" --port "$LLM_PORT" > "$HOME_DIR/mock.log" 2>&1 ) &
MOCK_PID=$!
for _ in $(seq 1 40); do grep -q '"type":"ready"' "$HOME_DIR/mock.log" && break; sleep 0.25; done
grep -q '"type":"ready"' "$HOME_DIR/mock.log" || { echo "mock failed"; exit 1; }

new_session() {
  local patch="${1:-}"
  local out
  if [ -n "$patch" ]; then
    out=$( cd "$DSH" && DSH_HOME="$HOME_DIR" DEEPSEEK_BASE_URL="http://127.0.0.1:$LLM_PORT" DEEPSEEK_API_KEY=mock \
      node --import tsx/esm apps/cli/src/bin.ts --profile headless --patch "$patch" --json "start here" 2>/dev/null )
  else
    out=$( cd "$DSH" && DSH_HOME="$HOME_DIR" DEEPSEEK_BASE_URL="http://127.0.0.1:$LLM_PORT" DEEPSEEK_API_KEY=mock \
      node --import tsx/esm apps/cli/src/bin.ts --profile headless --json "start here" 2>/dev/null )
  fi
  printf '%s' "$out" | head -1 | node -e 'let d="";process.stdin.on("data",c=>d+=c);process.stdin.on("end",()=>console.log(JSON.parse(d).sessionId))'
}

run_turn() {
  local id="$1"; local task="$2"; shift 2
  ( cd "$DSH" && DSH_HOME="$HOME_DIR" DEEPSEEK_BASE_URL="http://127.0.0.1:$LLM_PORT" DEEPSEEK_API_KEY=mock \
      node --import tsx/esm apps/cli/src/bin.ts --profile headless "$@" --session-id "$id" "$task" > /dev/null 2>&1 )
}

echo "== direction 1: stock -> graph"
ID1=$(new_session)
run_turn "$ID1" "continue under the graph driver" --patch "$PATCH"
LOG1=$(find "$HOME_DIR/sessions" -path "*$ID1*" -name "session.v4.jsonl.zstd" | head -1)
zstd -dc "$LOG1" | node -e '
let d="";process.stdin.on("data",c=>d+=c);process.stdin.on("end",()=>{
 const es=d.trim().split("\n").map(l=>{try{return JSON.parse(l)}catch{return null}}).filter(Boolean)
 const turns=es.filter(e=>e.type==="turn/start").length
 const nodes=es.filter(e=>e.type==="user/message"&&JSON.stringify(e.data).includes("[graph node")).length
 console.log({turns,nodes})
 if (turns < 2 || nodes < 1) { console.error("FAIL: stock->graph resume"); process.exit(1) }
})'
node "$ROOT/scripts/conformance-diff.mjs" "$LOG1" > /dev/null

echo "== direction 2: graph -> stock"
ID2=$(new_session "$PATCH")
run_turn "$ID2" "continue under the stock loop"
LOG2=$(find "$HOME_DIR/sessions" -path "*$ID2*" -name "session.v4.jsonl.zstd" | head -1)
zstd -dc "$LOG2" | node -e '
let d="";process.stdin.on("data",c=>d+=c);process.stdin.on("end",()=>{
 const es=d.trim().split("\n").map(l=>{try{return JSON.parse(l)}catch{return null}}).filter(Boolean)
 const turns=es.filter(e=>e.type==="turn/start").length
 console.log({turns})
 if (turns < 2) { console.error("FAIL: graph->stock resume"); process.exit(1) }
})'
node "$ROOT/scripts/conformance-diff.mjs" "$LOG2" > /dev/null
echo "PASS  cross-loop resume both directions (home: $HOME_DIR)"
