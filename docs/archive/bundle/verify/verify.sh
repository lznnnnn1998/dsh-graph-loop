#!/usr/bin/env bash
# Verify the explore bundles against a THROWAWAY DSH home.
#
# It boots nothing: `--dump-config` composes the profile and exits, which is exactly
# the check the release note promises (docs/user/develop/basic/publish.md).
#
# Usage:
#   bundle/verify/verify.sh
#   DSH_ROOT=/path/to/deepseek-harness HOME_DIR=/tmp/somewhere bundle/verify/verify.sh
#
# Requirements: a DSH source checkout (default /Users/zhinan/deepseek-harness) with
# node_modules installed. Nothing outside $HOME_DIR is written.
set -euo pipefail

DSH_ROOT="${DSH_ROOT:-/Users/zhinan/deepseek-harness}"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BUNDLE_DIR="$(cd "$HERE/.." && pwd)"
HOME_DIR="${HOME_DIR:-/tmp/dsh-explore-verify}"
OUT="${OUT:-$HOME_DIR/dumps}"
PROFILE="${PROFILE:-explore}"

DSH() {
  ( cd "$DSH_ROOT" && DSH_HOME="$HOME_DIR" node --import tsx/esm apps/cli/src/bin.ts "$@" )
}

line() { printf '\n\033[1m== %s\033[0m\n' "$*"; }

line "0. reset $HOME_DIR"
rm -rf "$HOME_DIR"
mkdir -p "$OUT"

line "1. create profile '$PROFILE' from the shipped web template"
DSH --profile "$PROFILE" --from-default-profile web --dump-config > "$OUT/0-baseline.yml"
echo "rows: $(grep -c '^- ' "$OUT/0-baseline.yml")"
grep -n "id: agent-loop" -A3 "$OUT/0-baseline.yml"
grep -n "id: preset-" "$OUT/0-baseline.yml"

line "2. install bundle A (@dsh/explore-mode) into '$PROFILE'"
DSH plugin --profile "$PROFILE" add "$BUNDLE_DIR/a-preset"
DSH --profile "$PROFILE" --dump-config > "$OUT/1-with-a.yml"
echo "rows: $(grep -c '^- ' "$OUT/1-with-a.yml")"
grep -n "id: preset-explore" -A6 "$OUT/1-with-a.yml"
grep -n "id: graph-registry" -A3 "$OUT/1-with-a.yml"
# the stock loop must still be there and enabled
grep -n "id: agent-loop" -A3 "$OUT/1-with-a.yml"

line "3. remove bundle A"
DSH plugin --profile "$PROFILE" remove @dsh/explore-mode
DSH --profile "$PROFILE" --dump-config > "$OUT/2-after-remove.yml"
if grep -q "id: preset-explore" "$OUT/2-after-remove.yml"; then
  echo "FAIL: preset-explore still composed after remove"; exit 1
fi
echo "removed cleanly"

line "4. install bundle B (@dsh/explore-loop)"
DSH plugin --profile "$PROFILE" add "$BUNDLE_DIR/b-loop"
DSH --profile "$PROFILE" --dump-config > "$OUT/3-with-b.yml"
echo "rows: $(grep -c '^- ' "$OUT/3-with-b.yml")"
echo "--- stock row (must be disabled) ---"
grep -n "id: agent-loop" -A3 "$OUT/3-with-b.yml"
echo "--- graph driver row ---"
grep -n "id: graph-loop" -A6 "$OUT/3-with-b.yml"

line "5. invariants"
python3 - "$OUT/3-with-b.yml" <<'PY'
import re, sys, collections
text = open(sys.argv[1], encoding="utf-8").read().splitlines()
# top-level row ids only (column 0 '- id: ...'); preset children are indented
ids = [m.group(1) for line in text if (m := re.match(r'^- id: (\S+)$', line))]
dupes = {k: v for k, v in collections.Counter(ids).items() if v > 1}
print(f"top-level rows: {len(ids)}, unique ids: {len(set(ids))}")
if dupes:
    print(f"FAIL duplicate ids: {dupes}"); sys.exit(1)
print("no duplicate top-level row ids")
PY
python3 - "$OUT/3-with-b.yml" <<'PY'
import re, sys
lines = open(sys.argv[1], encoding="utf-8").read().splitlines()
def block(row_id):
    out = []
    for i, l in enumerate(lines):
        if l == f"- id: {row_id}":
            j = i
            while j + 1 < len(lines) and (lines[j + 1].startswith("  ") or lines[j + 1] == ""):
                j += 1
            return lines[i:j + 1]
    return []
a = block("agent-loop"); g = block("graph-loop")
assert a, "agent-loop row missing from composition"
assert g, "graph-loop row missing from composition"
assert any("disabled: true" in l for l in a), "stock agent-loop row is not disabled"
assert not any("disabled: true" in l for l in g), "graph-loop row is disabled"
print("stock loop disabled, graph driver enabled")
PY

line "done — dumps in $OUT"
ls -l "$OUT"
echo
echo "Re-open the profile in the Web UI with:"
echo "  cd $DSH_ROOT && DSH_HOME=$HOME_DIR pnpm dsh --profile $PROFILE --port 3081"
