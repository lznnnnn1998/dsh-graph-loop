#!/usr/bin/env bash
# Build /tmp/dsh-compat: copy core/loop/mode sources and port the node:test
# suite to vitest so DSH's runner + v8 coverage can execute it outside the
# DSH workspace. DSH packages resolve through symlinks; nothing in the DSH
# checkout is modified.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DSH="${1:-${DSH_ROOT:-/Users/zhinan/deepseek-harness}}"
COMPAT="${2:-/tmp/dsh-compat}"

rm -rf "$COMPAT"
mkdir -p "$COMPAT/packages" "$COMPAT/node_modules"
for pkg in core loop mode; do
  cp -R "$ROOT/packages/$pkg" "$COMPAT/packages/$pkg"
  rm -rf "$COMPAT/packages/$pkg/lib" "$COMPAT/packages/$pkg/node_modules"
done
mkdir -p "$COMPAT/packages/loop/tests"
node "$ROOT/compat/port-tests.mjs" "$ROOT/test/unit" "$COMPAT/packages/loop/tests"
cp "$ROOT/compat/vitest.config.ts" "$COMPAT/vitest.config.ts"
printf '{"name":"dsh-compat","private":true,"type":"module"}\n' > "$COMPAT/package.json"

# DSH workspace packages: symlink every package into the compat node_modules.
node - "$DSH" "$COMPAT" <<'NODE'
import { globSync } from 'node:fs'
import { readFileSync, symlinkSync, mkdirSync, existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
const [dsh, compat] = process.argv.slice(2)
const manifests = [
  ...globSync([`${dsh}/packages/*/*/package.json`, `${dsh}/vendor/*/package.json`]),
]
for (const manifest of manifests) {
  const name = JSON.parse(readFileSync(manifest, 'utf8')).name
  if (typeof name !== 'string' || !name.startsWith('@deepseek-ai/')) continue
  const dest = join(compat, 'node_modules', name)
  if (existsSync(dest)) continue
  mkdirSync(dirname(dest), { recursive: true })
  symlinkSync(dirname(manifest), dest)
}
NODE
for link in vitest vite vite-tsconfig-paths typescript @vitest; do
  [ -e "$DSH/node_modules/$link" ] && ln -sfn "$DSH/node_modules/$link" "$COMPAT/node_modules/$link"
done
ln -sfn "$DSH/node_modules/.bin" "$COMPAT/node_modules/.bin"
[ -e "$ROOT/node_modules/@langchain" ] && ln -sfn "$ROOT/node_modules/@langchain" "$COMPAT/node_modules/@langchain"
for pkg in core loop mode; do ln -sfn "../packages/$pkg" "$COMPAT/node_modules/dsh-graph-loop-$pkg"; done
ln -sfn ../packages/loop "$COMPAT/node_modules/dsh-graph-loop"
echo "compat workspace: $COMPAT"
