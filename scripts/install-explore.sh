#!/usr/bin/env bash
# One command to add the explore mode to a Web profile:
#   bash scripts/install-explore.sh [profile]
# Installs the driver bundle + the Graph-tab client bundle, then verifies the
# composed rows. Stack the packages in this order so both layers land last.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PROFILE="${1:-web}"
DSH="${DSH_ROOT:-/Users/zhinan/deepseek-harness}"
ds() { ( cd "$DSH" && node --import tsx/esm apps/cli/src/bin.ts "$@" ); }

echo "== profile: $PROFILE"
ds --profile "$PROFILE" --dump-config > /dev/null
echo "== installing Graph tab bundle"
ds plugin --profile "$PROFILE" add "$ROOT/packages/graph-ui" > /dev/null
echo "== installing graph driver bundle"
ds plugin --profile "$PROFILE" add "$ROOT/packages/loop" > /dev/null
echo "== verifying composition"
ds --profile "$PROFILE" --dump-config | grep -E "id: graph-loop|id: graph-ui|id: agent-loop" -A1 | head -10
echo "PASS  explore mode installed into profile '$PROFILE'"
