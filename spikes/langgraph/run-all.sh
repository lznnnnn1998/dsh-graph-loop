#!/usr/bin/env bash
# Reproduce every LangGraph measurement cited in research/03-langgraph.md.
# Requires: node >= 26, `npm install` already run in this directory.
set -euo pipefail
cd "$(dirname "$0")"
{
  echo "###############################"
  echo "# 0. environment"
  echo "###############################"
  echo "date:        $(date -u +%Y-%m-%dT%H:%M:%SZ)"
  echo "node:        $(node --version)"
  echo "npm:         $(npm --version)"
  echo "platform:    $(uname -sm)"
  echo "langgraph:   $(node -p "require('./node_modules/@langchain/langgraph/package.json').version")"
  echo "core:        $(node -p "require('./node_modules/@langchain/core/package.json').version")"
  echo "checkpoint:  $(node -p "require('./node_modules/@langchain/langgraph-checkpoint/package.json').version")"
  echo "zod:         $(node -p "require('./node_modules/zod/package.json').version")"
  echo
  echo "###############################"
  echo "# 1. main spike (sections 0-13)"
  echo "###############################"
  node spike.mjs
  echo
  echo "###############################"
  echo "# 2. Send API diagnosis"
  echo "###############################"
  node probe-send.mjs
  echo
  echo "###############################"
  echo "# 3. telemetry defaults"
  echo "###############################"
  node probe-telemetry.mjs
  echo
  echo "###############################"
  echo "# 4. kernel conformance (design/kernel.ts <-> real langgraph)"
  echo "###############################"
  cd ../..
  ./spikes/langgraph/node_modules/.bin/tsc --noEmit --strict --target ES2024 \
    --module esnext --moduleResolution bundler --skipLibCheck --allowImportingTsExtensions \
    design/kernel.ts design/graph-schema.ts spikes/langgraph/kernel-conformance.ts \
    && echo "typecheck: PASS"
  node --experimental-strip-types spikes/langgraph/kernel-conformance.ts 2>&1 \
    | grep -vE "MODULE_TYPELESS|Reparsing|trace-warnings"
} 2>&1 | tee output.txt
