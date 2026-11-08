#!/usr/bin/env bash
# Live graph-chat: boot the Web host, create a session through the graph-chat API,
# send one message, and assert the turn trace appears with a multi-node topology.
# Also captures a screenshot when Chrome is available.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DSH="${DSH_ROOT:-/Users/zhinan/deepseek-harness}"
PORT="${PORT:-3085}"
LLM_PORT="${LLM_PORT:-8174}"
HOME_DIR="${HOME_DIR:-$(mktemp -d /tmp/dsh-graph-chat.XXXXXX)}"
LOG="$HOME_DIR/host.log"
cleanup() {
  [ -n "${HOST_PID:-}" ] && kill "$HOST_PID" 2>/dev/null || true
  [ -n "${MOCK_PID:-}" ] && kill "$MOCK_PID" 2>/dev/null || true
}
trap cleanup EXIT

echo "== 1. mock LLM on :$LLM_PORT"
( cd "$DSH" && exec node --import tsx packages/test-support/llm-mock-server/src/bin.ts \
    --sequence success --repeat-last --success-text "graph chat ok" --port "$LLM_PORT" > "$HOME_DIR/mock.log" 2>&1 ) &
MOCK_PID=$!
for _ in $(seq 1 40); do grep -q '"type":"ready"' "$HOME_DIR/mock.log" && break; sleep 0.25; done
grep -q '"type":"ready"' "$HOME_DIR/mock.log" || { echo "mock failed"; cat "$HOME_DIR/mock.log"; exit 1; }

echo "== 2. web host with the graph-chat plugin on :$PORT"
( cd "$DSH" && exec env DSH_HOME="$HOME_DIR" DEEPSEEK_BASE_URL="http://127.0.0.1:$LLM_PORT" DEEPSEEK_API_KEY=mock \
    node --import tsx/esm apps/cli/src/bin.ts --profile web \
    --patch "$ROOT/packages/loop/dev.patch.yml" --port "$PORT" --no-open > "$LOG" 2>&1 ) &
HOST_PID=$!
for _ in $(seq 1 120); do grep -q "dsh web:" "$LOG" && break; sleep 0.5; done
grep -q "dsh web:" "$LOG" || { echo "host failed"; tail -30 "$LOG"; exit 1; }

echo "== 3. authenticate (every graph-chat route is behind the Connection trust fence)"
LAUNCH="$(grep -o 'dsh web: http://[^[:space:]]*' "$LOG" | head -1 | sed 's/^dsh web: //')"
[ -n "$LAUNCH" ] || { echo "FAIL: no launch url in host log"; tail -30 "$LOG"; exit 1; }
UNAUTH=$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:$PORT/graph-chat/api/state")
case "$UNAUTH" in
  401|403) echo "unauthenticated /api/state rejected with $UNAUTH" ;;
  *) echo "FAIL: unauthenticated request returned $UNAUTH (expected 401/403)"; exit 1 ;;
esac
# Exchange the one-shot launch token for the signed session cookie.
curl -sS -o /dev/null -c "$HOME_DIR/cookies.txt" "$LAUNCH" || { echo "FAIL: token exchange"; exit 1; }
grep -qv '^#' "$HOME_DIR/cookies.txt" || { echo "FAIL: no cookie issued"; exit 1; }
CURL=(curl -sf -b "$HOME_DIR/cookies.txt")

echo "== 4. page + API"
"${CURL[@]}" "http://127.0.0.1:$PORT/graph-chat" | grep -q "Graph Chat" || { echo "FAIL: page"; exit 1; }
NEW=$("${CURL[@]}" -X POST -H 'content-type: application/json' -d '{}' "http://127.0.0.1:$PORT/graph-chat/api/new")
SID=$(printf '%s' "$NEW" | node -e 'let d="";process.stdin.on("data",c=>d+=c);process.stdin.on("end",()=>console.log(JSON.parse(d).sessionId))')
[ -n "$SID" ] || { echo "FAIL: no session id"; exit 1; }
"${CURL[@]}" -X POST -H 'content-type: application/json' \
  -d "{\"sessionId\":\"$SID\",\"text\":\"explain how the config loader works\"}" \
  "http://127.0.0.1:$PORT/graph-chat/api/send" > /dev/null

echo "== 5. wait for the graph turn"
for _ in $(seq 1 40); do
  TURNS=$("${CURL[@]}" "http://127.0.0.1:$PORT/graph-chat/api/state?sessionId=$SID" | node -e 'let d="";process.stdin.on("data",c=>d+=c);process.stdin.on("end",()=>{const j=JSON.parse(d);console.log(j.turns.length)})')
  [ "$TURNS" -ge 1 ] && break
  sleep 0.5
done
[ "${TURNS:-0}" -ge 1 ] || { echo "FAIL: no turn trace"; tail -20 "$LOG"; exit 1; }

"${CURL[@]}" "http://127.0.0.1:$PORT/graph-chat/api/state?sessionId=$SID" > "$HOME_DIR/state.json"
node -e '
const j=require(process.argv[1]); const t=j.turns[0];
const ids=t.plan.nodes.map(n=>n.id);
console.log("mode="+t.mode, "nodes="+ids.join(","), "trail="+t.trail.map(x=>x.id+":"+x.status).join(","));
if (t.plan.nodes.length < 3) { console.error("FAIL: expected a multi-node topology"); process.exit(1) }
if (!t.trail.every(x => x.status === "ok")) { console.error("FAIL: a node failed"); process.exit(1) }
' "$HOME_DIR/state.json"

echo "== 6. screenshot (Chrome headless, best effort)"
CHROME="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
if [ -x "$CHROME" ]; then
  # The page needs the signed cookie, so the shot goes through the launch URL first.
  CHROME_PATH="$CHROME" node "$ROOT/scripts/graph-chat-shot.mjs" \
fi
echo "PASS  e2e live graph-chat  (home: $HOME_DIR)"
