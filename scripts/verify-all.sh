#!/usr/bin/env bash
# One-command verification for the repo: types, unit tests, installed bundle,
# tarball install, markdown links. The official benchmark preflights are run in
# report-only mode so the gate never depends on a container backend.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

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

echo "== benchmark network config (offline)"
bash bench/official/terminal-bench/check-network.sh

echo "== official benchmark preflights (report only)"
bash bench/official/terminal-bench/preflight.sh || true

echo "PASS  verify-all"
