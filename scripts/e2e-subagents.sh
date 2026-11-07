#!/usr/bin/env bash
# Parallel subagent nodes: a research task fans out to {d_search, d_fetch},
# both run as fresh child agents concurrently, then join at the answer.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DSH="${DSH_ROOT:-/Users/zhinan/deepseek-harness}"
PORT="${PORT:-8157}"
HOME_DIR="${HOME_DIR:-$(mktemp -d /tmp/dsh-explore-sub.XXXXXX)}"
LOG="$HOME_DIR/mock.log"
PATCH="$ROOT/packages/loop/dev-subagents.patch.yml"
cleanup() { [ -n "${MOCK_PID:-}" ] && kill "$MOCK_PID" 2>/dev/null || true; }
trap cleanup EXIT

echo "== 1. mock LLM"
( cd "$DSH" && exec node --import tsx packages/test-support/llm-mock-server/src/bin.ts \
    --sequence success --repeat-last --success-text "child ok" --port "$PORT" > "$LOG" 2>&1 ) &
MOCK_PID=$!
for _ in $(seq 1 40); do grep -q '"type":"ready"' "$LOG" && break; sleep 0.25; done
grep -q '"type":"ready"' "$LOG" || { echo "mock failed"; cat "$LOG"; exit 1; }

echo "== 2. run a research task"
( cd "$DSH" && DSH_HOME="$HOME_DIR" DEEPSEEK_BASE_URL="http://127.0.0.1:$PORT" DEEPSEEK_API_KEY=mock \
    node --import tsx/esm apps/cli/src/bin.ts --profile headless --patch "$PATCH" \
    "research the latest state of the art and compare approaches" ) > "$HOME_DIR/run.out" 2> "$HOME_DIR/run.err" || {
  echo "FAIL: dsh exited nonzero"; tail -20 "$HOME_DIR/run.err"; exit 1; }
cat "$HOME_DIR/run.out"

echo "== 3. assert both subagent branches ran in the parent session"
SESSION=$(ls -t "$HOME_DIR"/sessions/*/*/session.v4.jsonl.zstd | head -1)
zstd -dc "$SESSION" > "$HOME_DIR/session.jsonl"
grep -q '\[subagent d_search\]' "$HOME_DIR/session.jsonl" || { echo "FAIL: d_search missing"; exit 1; }
grep -q '\[subagent d_fetch\]' "$HOME_DIR/session.jsonl" || { echo "FAIL: d_fetch missing"; exit 1; }
grep -q '"type":"subagent/catalog"' "$HOME_DIR/session.jsonl" || { echo "FAIL: no subagent catalog"; exit 1; }
STEPS=$(grep -c '"type":"step/start"' "$HOME_DIR/session.jsonl" || true)
echo "parent steps=$STEPS"
# A child summary is logged (model-visible ⟺ logged) but must not claim the
# human `user` source: the stock Web API reads the last such message as the
# latest question, so a synthetic child summary would hijack it.
node --input-type=module -e '
import fs from "node:fs"
const events = fs.readFileSync(process.argv[1], "utf8").trim().split("\n").map(line => JSON.parse(line))
const textOf = e => e.data.content.flatMap(block => block.type === "text" ? [block.text] : []).join("\n")
const results = events.filter(e => e.type === "user/message"
  && e.data.content.some(block => block.type === "text" && block.text.includes("[subagent ")))
const wrongSource = results.filter(e => e.data.source?.kind !== "subagent-result")
const humanPrompts = events.filter(e => e.type === "user/message" && e.data.source?.kind === "user")
if (results.length === 0) {
  console.error("FAIL: no [subagent ...] results persisted in the parent session")
  process.exit(1)
}
if (wrongSource.length > 0) {
  console.error(`FAIL: ${wrongSource.length} subagent result(s) persisted with source.kind !== subagent-result`)
  process.exit(1)
}
if (results.some(e => e.data.source?.kind === "user")) {
  console.error("FAIL: a subagent result claims the human user source")
  process.exit(1)
}
if (humanPrompts.length === 0) {
  console.error("FAIL: the real human prompt is missing from the session log")
  process.exit(1)
}
const latestHuman = humanPrompts.at(-1)
if (latestHuman === undefined || !textOf(latestHuman).includes("research the latest state of the art")) {
  console.error("FAIL: the human question is not the latest source.kind === \"user\" message")
  process.exit(1)
}
if (!results.some(e => e.seq > latestHuman.seq)) {
  console.error("FAIL: no subagent result follows the human prompt, so the source filter is untested")
  process.exit(1)
}
console.log(`subagent_sources=${results.length} human_user_messages=${humanPrompts.length}`)
' "$HOME_DIR/session.jsonl"
echo "PASS  e2e parallel subagent nodes  (home: $HOME_DIR)"
