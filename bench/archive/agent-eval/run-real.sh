#!/usr/bin/env bash
# Run the local agent evaluation with the real DeepSeek model.
#
# Reads DEEPSEEK_API_KEY from the user's DSH credential store, exports it for the
# child process only, and never prints it. Use run.mjs directly if the key is
# already in the environment.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
KEY="$(python3 - <<'PY'
import os, yaml
path = os.path.expanduser('~/.dsh/.credentials.yaml')
data = yaml.safe_load(open(path))
print(data['refs']['DEEPSEEK_API_KEY'])
PY
)"
export DEEPSEEK_API_KEY="$KEY"
unset DEEPSEEK_BASE_URL
exec node "$ROOT/bench/agent-eval/run.mjs" "$@"
