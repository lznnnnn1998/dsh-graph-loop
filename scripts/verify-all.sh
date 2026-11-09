#!/usr/bin/env bash
# One-command verification for the repo: types, unit tests, installed bundle,
# tarball install, markdown links. The benchmark preflights are report-only and
# run only when the local bench/ tree exists (bench/ is never published).
#
#   bash scripts/verify-all.sh               # full local verification
#   bash scripts/verify-all.sh --with-bench  # require the local benchmark checks
#   bash scripts/verify-all.sh --no-bench    # skip benchmark checks
#   WITH_BENCH=1 bash scripts/verify-all.sh  # same as --with-bench
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

# bench/ is local-only: detect it instead of assuming it. --with-bench /
# WITH_BENCH=1 makes the benchmark steps required.
BENCH_REQUEST=0
for arg in "$@"; do
  case "$arg" in
    --with-bench) BENCH_REQUEST=1 ;;
    --no-bench) BENCH_REQUEST=-1 ;;
    -h|--help)
      sed -n '2,/^$/p' "$0" | sed 's/^# \{0,1\}//'
      exit 0 ;;
    *)
      echo "verify-all: unknown argument: $arg (try --help)" >&2
      exit 2 ;;
  esac
done
if [ "${WITH_BENCH:-0}" = 1 ]; then BENCH_REQUEST=1; fi
BENCH_TREE="$ROOT/bench/official/terminal-bench"
if [ "$BENCH_REQUEST" -gt 0 ]; then
  [ -d "$BENCH_TREE" ] || {
    echo 'verify-all: --with-bench requested but bench/ is absent (local-only tree)' >&2
    exit 1
  }
  WANT_BENCH=1
elif [ "$BENCH_REQUEST" -lt 0 ]; then
  WANT_BENCH=0
elif [ -d "$BENCH_TREE" ]; then
  WANT_BENCH=1
else
  WANT_BENCH=0
fi

echo "== typecheck"
npm run typecheck

echo "== build bundles (prepack equivalent)"
npm run build

echo "== build reproducibility (lib matches the source)"
npm run build:check

echo "== unit tests"
npm test

echo "== fork patch surface guard (skipped when no DSH checkout is available)"
bash scripts/diff-upstream.sh --check

echo "== installed-bundle e2e (mock LLM)"
bash scripts/e2e-installed.sh

echo "== tarball install"
bash scripts/e2e-tarball.sh

echo "== markdown links"
python3 - <<'PY'
import pathlib, re, sys
bad = []
for path in pathlib.Path('.').rglob('*.md'):
    if any(part in {'.git', 'node_modules', '.secrets'} for part in path.parts):
        continue
    for match in re.finditer(r'\]\(([^)]+\.md)(?:#[^)]*)?\)', path.read_text(errors='ignore')):
        target = match.group(1)
        if target.startswith(('http://', 'https://', '/')):
            continue
        if not (path.parent / target).resolve().exists():
            bad.append(f'{path}: {target}')
if bad:
    print('\n'.join(bad))
    sys.exit(1)
print('markdown links OK')
PY

if [ "$WANT_BENCH" -eq 1 ]; then
  echo "== benchmark network config (offline)"
  bash "$BENCH_TREE/check-network.sh"

  echo "== official benchmark preflights (report only)"
  bash "$BENCH_TREE/preflight.sh" || true
else
  echo "== benchmark checks: skipped (bench/ is local-only and absent; --with-bench to require)"
fi

echo "PASS  verify-all"
