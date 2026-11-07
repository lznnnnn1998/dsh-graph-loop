#!/usr/bin/env bash
# diff-upstream.sh — show the intended patch surface of the forked loop.
#
# Architecture B keeps a bounded source fork of DSH's agent loop in
# `packages/loop/src/loop`. This script diffs that directory against the DSH
# checkout it was forked from and classifies each file:
#
#   patch       a file the fork is expected to change (agent.ts, index.ts)
#   local-only  a file that exists only in the fork (step-tools.ts)
#   shared      a file that must stay byte-identical after normalizing the
#               `@module` header line (assistant-stream, constants, inbox,
#               runtime-context)
#
# Usage:
#   bash scripts/diff-upstream.sh                # report; exit 0
#   bash scripts/diff-upstream.sh --check        # exit 1 on unexpected divergence
#   bash scripts/diff-upstream.sh /path/to/dsh   # explicit checkout
#   DSH_ROOT=/path/to/dsh bash scripts/diff-upstream.sh
#
# The DSH checkout is only read, never written. When no checkout is found the
# script prints a skip notice and exits 0, so it is safe in a checkout-free CI.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LOCAL="$ROOT/packages/loop/src/loop"

CHECK=0
DSH_INPUT="${DSH_ROOT:-}"
for arg in "$@"; do
  case "$arg" in
    --check) CHECK=1 ;;
    -h|--help) sed -n '2,28p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) DSH_INPUT="$arg" ;;
  esac
done

find_dsh() {
  local candidate
  for candidate in \
    "$DSH_INPUT" \
    "$ROOT/../deepseek-harness" \
    "$HOME/deepseek-harness"; do
    if [[ -n "$candidate" && -d "$candidate/packages/core/agent-loop/src" ]]; then
      printf '%s\n' "$candidate"
      return 0
    fi
  done
  return 1
}

if ! DSH_ROOT_REAL="$(find_dsh)"; then
  printf 'diff-upstream: no DSH checkout found (tried $DSH_ROOT, ../deepseek-harness, ~/deepseek-harness)\n'
  printf 'diff-upstream: skipping; pass a checkout path or set DSH_ROOT\n'
  exit 0
fi

UPSTREAM="$DSH_ROOT_REAL/packages/core/agent-loop/src"
PATCH_FILES=(agent.ts index.ts)

printf 'fork:      %s\n' "$LOCAL"
printf 'upstream:  %s\n' "$UPSTREAM"
if git -C "$DSH_ROOT_REAL" rev-parse --short HEAD >/dev/null 2>&1; then
  printf 'checkout:  %s\n' "$(git -C "$DSH_ROOT_REAL" describe --tags --always 2>/dev/null || git -C "$DSH_ROOT_REAL" rev-parse --short HEAD)"
fi
printf '\n'

unexpected=0
present=0
for file in "$LOCAL"/*.ts; do
  name="$(basename "$file")"
  present=$((present + 1))
  if [[ ! -f "$UPSTREAM/$name" ]]; then
    printf '%-22s local-only (expected)\n' "$name"
    continue
  fi

  if cmp -s "$file" "$UPSTREAM/$name"; then
    printf '%-22s shared: identical\n' "$name"
    continue
  fi

  # Normalize the @module banner: it names this package, not upstream.
  normalized="$(mktemp)"
  sed -E 's#@module .*#@module normalized#' "$file" > "$normalized"
  if sed -E 's#@module .*#@module normalized#' "$UPSTREAM/$name" | cmp -s - "$normalized"; then
    printf '%-22s shared: @module header only (expected)\n' "$name"
    rm -f "$normalized"
    continue
  fi
  rm -f "$normalized"

  if [[ " ${PATCH_FILES[*]} " == *" $name "* ]]; then
    stat="$(git diff --no-index --numstat "$UPSTREAM/$name" "$file" 2>/dev/null | awk 'NR==1 {print "+" $1 " / -" $2}' || true)"
    printf '%-22s patch (expected): %s\n' "$name" "${stat:-differs}"
    continue
  fi

  printf '%-22s UNEXPECTED DIVERGENCE\n' "$name"
  diff -u "$UPSTREAM/$name" "$file" | head -20 || true
  unexpected=$((unexpected + 1))
done

# A file deleted from the fork would be invisible to the loop above.
for upstream_file in "$UPSTREAM"/*.ts; do
  name="$(basename "$upstream_file")"
  if [[ ! -f "$LOCAL/$name" ]]; then
    printf '%-22s MISSING from fork\n' "$name"
    unexpected=$((unexpected + 1))
  fi
done

printf '\n'
if [[ "$unexpected" -gt 0 ]]; then
  printf 'diff-upstream: %d unexpected divergence(s); update the fork or this script deliberately\n' "$unexpected"
  [[ "$CHECK" -eq 1 ]] && exit 1
  exit 0
fi
printf 'diff-upstream: patch surface matches expectations (%d local file(s))\n' "$present"
