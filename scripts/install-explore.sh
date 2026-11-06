#!/usr/bin/env bash
# One command to make the graph loop the profile's agent runtime.
#
#   bash scripts/install-explore.sh [profile]      # default: web
#   bash scripts/install-explore.sh --profile web
#
# It installs the Graph-tab bundle and the graph driver bundle into the profile,
# then verifies that the stock `agent-loop` row is disabled and the graph rows
# are present. DSH has no global "default profile": profile selection is always
# `--profile <name>` (or `dsh <name>`), so "default" here means the profile the
# user actually boots — `web` unless another name is supplied.
#
# The stock package is NOT uninstalled: the shipped base bundle depends on
# `@deepseek-ai/dsh-agent-loop`. Disabling its row is DSH's supported replacement
# mechanism and is what the graph bundle's patch does.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DSH="${DSH_ROOT:-/Users/zhinan/deepseek-harness}"
PROFILE="web"

while [ "$#" -gt 0 ]; do
  case "$1" in
    --profile)
      [ "$#" -ge 2 ] || { echo "--profile needs a name" >&2; exit 2; }
      PROFILE="$2"; shift 2 ;;
    -h|--help)
      sed -n '2,12p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) PROFILE="$1"; shift ;;
  esac
done

if [ -n "${DSH_HOME:-}" ]; then
  echo "== profile: $PROFILE  (DSH_HOME=$DSH_HOME)"
else
  echo "== profile: $PROFILE  (default DSH_HOME)"
fi

ds() { ( cd "$DSH" && node --import tsx/esm apps/cli/src/bin.ts "$@" ); }

# Create a custom profile from the web template if it does not exist yet.
if ! ds --profile "$PROFILE" --dump-config > /dev/null 2>&1; then
  echo "== creating profile '$PROFILE' from the shipped web template"
  ds --profile "$PROFILE" --from-default-profile web --dump-config > /dev/null
fi

echo "== installing Graph tab bundle"
ds plugin --profile "$PROFILE" add "$ROOT/packages/graph-ui" > /dev/null
echo "== installing graph driver bundle"
ds plugin --profile "$PROFILE" add "$ROOT/packages/loop" > /dev/null
echo "== installing explore mode bundle"
ds plugin --profile "$PROFILE" add "$ROOT/packages/mode" > /dev/null

echo "== verifying composition"
DUMP="$(ds --profile "$PROFILE" --dump-config)"
grep -q 'id: graph-loop' <<<"$DUMP" || { echo "FAIL: graph-loop row missing" >&2; exit 1; }
grep -q 'id: graph-ui' <<<"$DUMP" || { echo "FAIL: graph-ui row missing" >&2; exit 1; }
grep -q 'id: preset-explore' <<<"$DUMP" || { echo "FAIL: explore mode is not registered" >&2; exit 1; }
awk '
  /^- id: agent-loop$/ { row = 1; next }
  row && /^[[:space:]]+disabled: true$/ { found = 1 }
  row && /^- id: / { row = 0 }
  END { exit found ? 0 : 1 }
' <<<"$DUMP" || { echo "FAIL: stock agent-loop row is not disabled" >&2; exit 1; }
awk '
  /^- id: agent-preset-registry$/ { row = 1; next }
  row && /^[[:space:]]+default: explore$/ { found = 1 }
  row && /^- id: / { row = 0 }
  END { exit found ? 0 : 1 }
' <<<"$DUMP" || { echo "FAIL: explore is not the default mode" >&2; exit 1; }

echo "PASS  graph loop installed into profile '$PROFILE'"
echo "      stock agent-loop row disabled (package retained: the base bundle depends on it)"
echo "      default mode: explore (new sessions)"
if [ "$PROFILE" = "web" ]; then
  echo "      default launch: dsh web"
else
  echo "      launch: dsh --profile $PROFILE"
fi
