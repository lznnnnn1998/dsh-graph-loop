#!/usr/bin/env bash
# Verify the published-package path: pack each plugin as a tarball, install the
# tarballs into a fresh Web profile, and assert the composed profile.
#
# This complements e2e-installed.sh (which installs from a local path). It does
# not start the Web server; it proves the package contents and bundle metadata
# are installable the way `dsh plugin add <registry-package>` will be.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DSH="${DSH_ROOT:-/Users/zhinan/deepseek-harness}"
HOME_DIR="${HOME_DIR:-$(mktemp -d /tmp/dsh-tarball.XXXXXX)}"
PACKS="$(mktemp -d /tmp/dsh-packs.XXXXXX)"
PROFILE="${PROFILE:-tarball}"
PORT="${PORT:-8141}"
LOG="$HOME_DIR/mock.log"
cleanup() { [ -n "${MOCK_PID:-}" ] && kill "$MOCK_PID" 2>/dev/null || true; }
trap cleanup EXIT

ds() { ( cd "$DSH" && DSH_HOME="$HOME_DIR" node --import tsx/esm apps/cli/src/bin.ts "$@" ); }

echo "== 1. pack plugin tarballs"
for pkg in loop graph-ui mode; do
  ( cd "$ROOT/packages/$pkg" && npm pack --pack-destination "$PACKS" > /dev/null )
done
ls -1 "$PACKS"

echo "== 2. create a Web profile"
ds --profile "$PROFILE" --from-default-profile web --dump-config > /dev/null

echo "== 3. install tarballs"
for tarball in "$PACKS"/*.tgz; do
  ds plugin --profile "$PROFILE" add "$tarball" > /dev/null
done

echo "== 4. verify the composed profile"
DSH_HOME="$HOME_DIR" ds --profile "$PROFILE" --dump-config > "$HOME_DIR/dump.yml"
grep -q 'id: graph-loop' "$HOME_DIR/dump.yml" || { echo "FAIL: graph-loop row missing"; exit 1; }
grep -q 'id: graph-ui' "$HOME_DIR/dump.yml" || { echo "FAIL: graph-ui row missing"; exit 1; }
grep -q 'id: preset-explore' "$HOME_DIR/dump.yml" || { echo "FAIL: explore preset missing"; exit 1; }
awk '
  /^- id: agent-loop$/ { row = 1; next }
  row && /disabled: true/ { found = 1 }
  row && /^- id: / { row = 0 }
  END { exit found ? 0 : 1 }
' "$HOME_DIR/dump.yml" || { echo "FAIL: stock agent-loop is not disabled"; exit 1; }
awk '
  /^- id: agent-preset-registry$/ { row = 1; next }
  row && /^[[:space:]]+default: explore$/ { found = 1 }
  row && /^- id: / { row = 0 }
  END { exit found ? 0 : 1 }
' "$HOME_DIR/dump.yml" || { echo "FAIL: explore is not the default mode"; exit 1; }

echo "== 5. run the packed loop in a headless profile"
RUNTIME_PROFILE="${PROFILE}-headless"
ds --profile "$RUNTIME_PROFILE" --from-default-profile headless --dump-config > /dev/null
ds plugin --profile "$RUNTIME_PROFILE" add "$PACKS"/dsh-graph-loop-*.tgz > /dev/null
( exec node --import tsx "$DSH/packages/test-support/llm-mock-server/src/bin.ts" \
    --sequence tool_call_success,success --repeat-last --success-text "Tarball graph OK." \
    --tool-name read --tool-arguments '{"path":"README.md"}' --port "$PORT" > "$LOG" 2>&1 ) &
MOCK_PID=$!
for _ in $(seq 1 40); do grep -q '"type":"ready"' "$LOG" && break; sleep 0.25; done
grep -q '"type":"ready"' "$LOG" || { echo "FAIL: mock server did not start"; cat "$LOG"; exit 1; }
DEEPSEEK_BASE_URL="http://127.0.0.1:$PORT" DEEPSEEK_API_KEY=mock \
  ds --profile "$RUNTIME_PROFILE" "explain how the config loader works" > "$HOME_DIR/runtime.out" 2> "$HOME_DIR/runtime.err" || {
  echo "FAIL: packed loop exited nonzero"; tail -20 "$HOME_DIR/runtime.err"; exit 1; }
SESSION=$(ls -t "$HOME_DIR"/sessions/*/*/session.v4.jsonl.zstd | head -1)
zstd -dc "$SESSION" > "$HOME_DIR/runtime.jsonl"
STEPS=$(grep -c '"type":"step/start"' "$HOME_DIR/runtime.jsonl" || true)
NODES=$(grep -c '\[graph node ' "$HOME_DIR/runtime.jsonl" || true)
echo "steps=$STEPS graph_node_messages=$NODES"
[ "$STEPS" -ge 2 ] || { echo "FAIL: expected >=2 steps from packed loop"; exit 1; }
[ "$NODES" -ge 1 ] || { echo "FAIL: expected a graph directive from packed loop"; exit 1; }

echo "PASS  tarball install + packed runtime  (home: $HOME_DIR, packs: $PACKS)"
