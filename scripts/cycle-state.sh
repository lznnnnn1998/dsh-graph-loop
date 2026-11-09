#!/usr/bin/env bash
# Canonical state for the four-role cycle.
#
# Roles must run this first and quote its output; they must not hard-code a HEAD,
# tarball sha, run directory or PID in their prompts. The script is read-only.
set -u
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

echo "# cycle state"
echo "utc=$(date -u '+%Y-%m-%dT%H:%M:%SZ')"
echo "head=$(git rev-parse HEAD 2>/dev/null || echo unknown)"
echo "head_short=$(git rev-parse --short HEAD 2>/dev/null || echo unknown)"
echo "tracked_dirty=$(git status --porcelain -uno 2>/dev/null | wc -l | tr -d ' ')"
echo "branch=$(git branch --show-current 2>/dev/null || echo unknown)"

if [ -f dist/dsh-graph-loop-bench.tgz ]; then
  echo "dist_sha256=$(shasum -a 256 dist/dsh-graph-loop-bench.tgz | awk '{print $1}')"
  echo "dist_bytes=$(stat -f%z dist/dsh-graph-loop-bench.tgz 2>/dev/null || wc -c < dist/dsh-graph-loop-bench.tgz | tr -d ' ')"
else
  echo "dist_sha256=missing"
  echo "dist_bytes=missing"
fi

MARKER=/tmp/product20-shard-full.log
if [ -f "$MARKER" ]; then
  echo "marker_last=$(tail -1 "$MARKER")"
  if tail -1 "$MARKER" | grep -qx '_EXIT'; then
    echo "marker_closed=true"
  else
    echo "marker_closed=false"
  fi
else
  echo "marker_last=missing"
  echo "marker_closed=true"
fi

CONTAINERS="$(docker ps --format '{{.Names}}' 2>/dev/null | wc -l | tr -d ' ')"
echo "harbor_env_containers=$(docker ps --format '{{.Names}}' 2>/dev/null | grep -c '__env' || true)"
echo "all_containers=$CONTAINERS"

for pidfile in bench/official/results/*/runner.pid; do
  [ -f "$pidfile" ] || continue
  pid="$(cat "$pidfile" 2>/dev/null || true)"
  case "$pid" in
    ''|*[!0-9]*) echo "runner_pid $pidfile pid=$pid state=invalid" ;;
    *) if ps -p "$pid" >/dev/null 2>&1; then
         echo "runner_pid $pidfile pid=$pid state=live"
       else
         echo "runner_pid $pidfile pid=$pid state=dead"
       fi ;;
  esac
done

echo "live_runner_pids=$(for f in bench/official/results/*/runner.pid; do [ -f "$f" ] || continue; p=$(cat "$f"); ps -p "$p" >/dev/null 2>&1 && echo "$f"; done | wc -l | tr -d ' ')"
echo "latest_role_design=$(ls -1t docs/audits/role-design-*.md 2>/dev/null | head -1)"
echo "latest_audit=$(ls -1t docs/audits/*.md 2>/dev/null | head -1)"
echo "latest_eval=$(ls -1dt bench/official/results/*eval*/ 2>/dev/null | head -1)"
