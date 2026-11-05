#!/usr/bin/env bash
# Symlink the read-only DSH checkout's packages into this workspace so our
# plugins share the host's module instances (Node resolves to the realpath).
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DSH="${DSH_ROOT:-/Users/zhinan/deepseek-harness}"
mkdir -p "$ROOT/node_modules/@deepseek-ai"
while IFS=: read -r name dir; do
  [ -e "$DSH/$dir" ] || { echo "skip $name ($dir missing)"; continue; }
  rm -rf "$ROOT/node_modules/@deepseek-ai/$name"
  ln -sfn "$DSH/$dir" "$ROOT/node_modules/@deepseek-ai/$name"
done <<'MAP'
dsh-agent:packages/core/agent
dsh-session:packages/core/session
dsh-session-persistence:packages/session/session-persistence
dsh-session-projection:packages/session/session-projection
dsh-llm:packages/llm/llm
dsh-tools:packages/core/tools
dsh-system-prompt:packages/core/system-prompt
dsh-brand:packages/util/brand
dsh-util-values:packages/util/values
dsh-scope:packages/core/scope
dsh-util-time:packages/util/time
dsh-agent-loop:packages/core/agent-loop
schemastery:vendor/schemastery
cordis:vendor/cordis
MAP
rm -rf "$ROOT/node_modules/zod"
ln -sfn "$DSH/node_modules/zod" "$ROOT/node_modules/zod"
rm -rf "$ROOT/node_modules/@deepseek-ai/cosmokit"
ln -sfn "$DSH/vendor/cosmokit" "$ROOT/node_modules/@deepseek-ai/cosmokit"
echo "linked $(ls -1 "$ROOT/node_modules/@deepseek-ai" | wc -l | tr -d ' ') dsh packages"
