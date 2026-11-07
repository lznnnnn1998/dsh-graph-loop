#!/usr/bin/env bash
# Prepare a throwaway DSH home with two profiles:
#   headless — stock loop (the official arm)
#   explore  — the graph bundle installed with `dsh plugin add` (the candidate arm)
#
# No DSH source is modified. The profile directory lives under the supplied home.
#
# Usage: bash bench/agent-eval/prepare-installed.sh [HOME_DIR]
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
DSH="${DSH_ROOT:-/Users/zhinan/deepseek-harness}"
HOME_DIR="${1:-/tmp/dsh-agent-eval/installed-home}"
TSX="$DSH/node_modules/tsx/dist/loader.mjs"

if [ ! -f "$TSX" ]; then
  echo "tsx loader not found at $TSX" >&2
  exit 1
fi
mkdir -p "$HOME_DIR"

ds() { ( cd "$DSH" && DSH_HOME="$HOME_DIR" node --import "$TSX" apps/cli/src/bin.ts "$@" ); }

echo "== stock headless profile (shipped)"
ds --profile headless --dump-config > /dev/null

echo "== create explore profile and install the graph bundle"
ds --profile explore --from-default-profile headless --dump-config > /dev/null
ds plugin --profile explore add "$ROOT/packages/loop" > /dev/null
ds --profile explore --dump-config > "$HOME_DIR/explore-dump.yml"
grep -q 'id: graph-loop' "$HOME_DIR/explore-dump.yml" || {
  echo "FAIL: graph-loop row missing from the installed profile" >&2
  exit 1
}

echo "READY  home=$HOME_DIR"
echo "run: bash bench/agent-eval/run-real.sh --installed --home $HOME_DIR --arm both"
