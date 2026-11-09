#!/usr/bin/env bash
# End-to-end through the INSTALLED bundle (no --patch): create a headless-backed
# `explore` profile, install packages/loop, run one task against the mock LLM.
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
PORT="${PORT:-8135}"
HOME_DIR="${HOME_DIR:-$(mktemp -d "${TMPDIR:-/tmp}/dsh-explore-inst.XXXXXX")}"
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
# A directive is logged (model-visible ⟺ logged) but must not claim the human
# `user` source: the stock Web API reads the last such message as the question.
node --input-type=module -e '
import fs from "node:fs"
const events = fs.readFileSync(process.argv[1], "utf8").trim().split("\n").map(line => JSON.parse(line))
const directives = events.filter(e => e.type === "user/message"
  && e.data.content.some(block => block.type === "text" && block.text.includes("[graph node ")))
const wrongSource = directives.filter(e => e.data.source?.kind !== "graph-node")
const humanPrompts = events.filter(e => e.type === "user/message" && e.data.source?.kind === "user")
if (wrongSource.length > 0) {
  console.error(`FAIL: ${wrongSource.length} graph directive(s) persisted with source.kind !== graph-node`)
  process.exit(1)
}
if (humanPrompts.length === 0) {
  console.error("FAIL: the real human prompt is missing from the session log")
  process.exit(1)
}
const latestHuman = humanPrompts.at(-1)
const textOf = e => e.data.content.flatMap(block => block.type === "text" ? [block.text] : []).join("\n")
if (latestHuman === undefined || !textOf(latestHuman).includes("explain how the config loader works")) {
  console.error("FAIL: the human question is not the latest source.kind === \"user\" message")
  process.exit(1)
}
if (!directives.some(d => d.seq > latestHuman.seq)) {
  console.error("FAIL: no graph directive follows the human prompt, so the source filter is untested")
  process.exit(1)
}
console.log(`graph_node_sources=${directives.length} human_user_messages=${humanPrompts.length}`)
' "$HOME_DIR/session.jsonl"
echo "PASS  e2e installed bundle  (home: $HOME_DIR)"
