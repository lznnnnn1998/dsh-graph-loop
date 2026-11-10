#!/usr/bin/env bash
# diff-upstream.sh — show and enforce the intended patch surface of the forked loop.
#
# Architecture B keeps a bounded source fork of DSH's agent loop in
# `packages/loop/src/loop`. This script diffs that directory against the DSH
# checkout it was forked from and classifies each file:
#
#   patch       a file the fork is expected to change (agent.ts, index.ts),
#               with a pinned added/removed-line budget
#   local-only  a named file that exists only in the fork (graph-node.ts,
#               step-tools.ts, subagent-result.ts, bench-retry.ts)
#   shared      a file that must stay byte-identical after normalizing the
#               `@module` header line (assistant-stream, constants, inbox,
#               runtime-context)
#
# `--check` (used by scripts/ci-local.sh and scripts/verify-all.sh) fails on:
#   * a shared file diverging beyond the header,
#   * an unexpected patch/local-only/divergent file, a missing file,
#   * a patch file growing past its documented budget, or
#   * the DSH checkout not matching the pinned upstream commit below.
# Re-baseline the pin and budgets deliberately when the fork moves; do not
# raise a budget to make a red gate green.
#
# Usage:
#   bash scripts/diff-upstream.sh                # report; exit 0
#   bash scripts/diff-upstream.sh --report       # same, explicit
#   bash scripts/diff-upstream.sh --check        # exit 1 on unexpected divergence
#   bash scripts/diff-upstream.sh /path/to/dsh   # explicit checkout
#   DSH_REPO=/path/to/dsh bash scripts/diff-upstream.sh   # or DSH_ROOT (legacy)
#
# The DSH checkout is only read, never written. When no checkout is found the
# script prints a skip notice and exits 0, so it is safe in a checkout-free CI.
set -euo pipefail

# --- Pinned fork surface ---------------------------------------------------
# Upstream commit the fork is diffed against. The checkout's `git describe` at
# baseline: dsh-v0.2.2-rc.1-811-gfcc0ad4621. Bump only with a re-diff.
PINNED_UPSTREAM_COMMIT="fcc0ad4621"
# Expected patch size at the pin (added/removed lines) and the headroom a
# legitimate small fix may use before the guard fails. A patch that exceeds
# these is fork debt, not maintenance.
PATCH_BUDGETS="agent.ts:372:16 index.ts:154:11"
ADD_TOLERANCE=15
DEL_TOLERANCE=5
LOCAL_ONLY_FILES="bench-retry.ts graph-node.ts step-tools.ts subagent-result.ts"
PATCH_FILES="agent.ts index.ts"
# ---------------------------------------------------------------------------

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LOCAL="$ROOT/packages/loop/src/loop"

CHECK=0
DSH_INPUT="${DSH_REPO:-${DSH_ROOT:-}}"
for arg in "$@"; do
  case "$arg" in
    --check) CHECK=1 ;;
    --report) CHECK=0 ;;
    -h|--help) awk 'NR>1 && /^#/ {sub(/^# ?/,""); print; next} NR>1 {exit}' "$0"; exit 0 ;;
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

in_list() {
  local needle="$1" list="$2" item
  for item in $list; do
    [[ "$item" == "$needle" ]] && return 0
  done
  return 1
}

budget_of() {
  local name="$1" spec
  for spec in $PATCH_BUDGETS; do
    if [[ "${spec%%:*}" == "$name" ]]; then
      local rest="${spec#*:}"
      printf '%s %s\n' "${rest%%:*}" "${rest#*:}"
      return 0
    fi
  done
  return 1
}

if ! DSH_ROOT_REAL="$(find_dsh)"; then
  printf 'diff-upstream: no DSH checkout found (tried $DSH_REPO, ../deepseek-harness, ~/deepseek-harness)\n'
  printf 'diff-upstream: skipping; pass a checkout path or set DSH_REPO\n'
  exit 0
fi

UPSTREAM="$DSH_ROOT_REAL/packages/core/agent-loop/src"

printf 'fork:      %s\n' "$LOCAL"
printf 'upstream:  %s\n' "$UPSTREAM"

upstream_mismatch=0
if git -C "$DSH_ROOT_REAL" rev-parse HEAD >/dev/null 2>&1; then
  actual_commit="$(git -C "$DSH_ROOT_REAL" rev-parse HEAD)"
  actual_describe="$(git -C "$DSH_ROOT_REAL" describe --tags --always 2>/dev/null || printf '%s' "$actual_commit")"
  printf 'checkout:  %s\n' "$actual_describe"
  if [[ "$actual_commit" != "$PINNED_UPSTREAM_COMMIT"* ]]; then
    upstream_mismatch=1
    printf 'pin:       MISMATCH — expected commit %s, checkout is %s\n' "$PINNED_UPSTREAM_COMMIT" "$actual_commit"
    printf 'pin:       re-diff the fork, then update PINNED_UPSTREAM_COMMIT and the patch budgets\n'
  else
    printf 'pin:       %s (expected commit)\n' "$PINNED_UPSTREAM_COMMIT"
  fi
fi
printf '\n'

unexpected=0
present=0
for file in "$LOCAL"/*.ts; do
  name="$(basename "$file")"
  present=$((present + 1))
  if [[ ! -f "$UPSTREAM/$name" ]]; then
    if in_list "$name" "$LOCAL_ONLY_FILES"; then
      printf '%-22s local-only (expected)\n' "$name"
    else
      printf '%-22s UNEXPECTED local-only file (add it to LOCAL_ONLY_FILES deliberately)\n' "$name"
      unexpected=$((unexpected + 1))
    fi
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

  if in_list "$name" "$PATCH_FILES"; then
    added=""
    removed=""
    numstat="$(git diff --no-index --numstat "$UPSTREAM/$name" "$file" 2>/dev/null | awk 'NR==1 {print $1 " " $2}' || true)"
    if [[ -n "$numstat" ]]; then
      added="${numstat%% *}"
      removed="${numstat##* }"
    fi
    if ! [[ "$added" =~ ^[0-9]+$ && "$removed" =~ ^[0-9]+$ ]]; then
      printf '%-22s patch (expected): UNMEASURABLE diff\n' "$name"
      unexpected=$((unexpected + 1))
      continue
    fi
    if ! budget="$(budget_of "$name")"; then
      printf '%-22s patch (expected): +%s / -%s  (no budget declared)\n' "$name" "$added" "$removed"
      unexpected=$((unexpected + 1))
      continue
    fi
    budget_add="${budget%% *}"
    budget_del="${budget##* }"
    max_add=$((budget_add + ADD_TOLERANCE))
    max_del=$((budget_del + DEL_TOLERANCE))
    printf '%-22s patch (expected): +%s / -%s  (budget +%s / -%s)\n' "$name" "$added" "$removed" "$max_add" "$max_del"
    if (( added > max_add || removed > max_del )); then
      printf '%-22s PATCH BUDGET EXCEEDED: +%s / -%s vs +%s / -%s\n' "$name" "$added" "$removed" "$max_add" "$max_del"
      unexpected=$((unexpected + 1))
    fi
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
if [[ "$unexpected" -gt 0 || "$upstream_mismatch" -gt 0 ]]; then
  [[ "$upstream_mismatch" -gt 0 ]] && printf 'diff-upstream: upstream checkout does not match the pinned commit\n'
  [[ "$unexpected" -gt 0 ]] && printf 'diff-upstream: %d unexpected divergence(s); update the fork or this script deliberately\n' "$unexpected"
  if [[ "$CHECK" -eq 1 ]]; then exit 1; fi
  printf 'diff-upstream: report mode; a --check run would fail\n'
  exit 0
fi
printf 'diff-upstream: patch surface matches expectations (%d local file(s), pinned at %s)\n' "$present" "$PINNED_UPSTREAM_COMMIT"
