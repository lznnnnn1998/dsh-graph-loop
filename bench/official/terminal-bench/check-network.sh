#!/usr/bin/env bash
# Offline regression checks for the benchmark network configuration.
#
# No Docker, no network and no Harbor: this only proves that network.sh is the one
# source of truth and that apply-mirrors.py turns a task tree into mirror URLs.
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/../../.." && pwd)"
# Hermetic: do not let caller overrides leak into the regression fixture.
unset PIP_INDEX_URL PIP_TRUSTED_HOST UV_DEFAULT_INDEX NPM_CONFIG_REGISTRY \
      npm_config_registry DSH_NODE_MIRROR DSH_APT_MIRROR
# The regression check always runs with mirrors on; DSH_MIRRORS=off is tested below.
DSH_MIRRORS=cn
export DSH_MIRRORS
# shellcheck source=network.sh
source "$HERE/network.sh"

fail() { printf 'FAIL: %s\n' "$*" >&2; exit 1; }
ok() { printf 'ok: %s\n' "$*"; }

# 0. An invalid mode must fail closed instead of silently using cn while a run
#    records the typo in its rows.
if DSH_MIRRORS=OFF bash -c 'source "$1/network.sh"' _ "$HERE" >/dev/null 2>&1; then
  fail "invalid DSH_MIRRORS must fail closed"
fi
ok "invalid DSH_MIRRORS fails closed"

# 1. Shell syntax for every benchmark shell script.
for script in "$HERE"/*.sh; do
  bash -n "$script" || fail "bash -n ${script#"$ROOT"/}"
done
ok "shell syntax"

# 2. Syntax only; the adapter is imported with Harbor stubbed out in section 4.
python3 - "$HERE/apply-mirrors.py" "$HERE/dsh_agent.py" <<'PY'
import sys
from pathlib import Path
for name in sys.argv[1:]:
    compile(Path(name).read_text(), name, "exec")
PY
ok "python syntax"

# 3. Single source of truth: domestic mirror hosts appear only in network.sh.
if grep -rIn --exclude-dir=results --exclude-dir=__pycache__ --exclude-dir=audits \
    -E 'pypi\.tuna|npmmirror\.com|mirrors\.tuna' \
    "$ROOT/bench" "$ROOT/scripts" "$ROOT/automation" "$ROOT/docs" \
    "$ROOT/README.md" "$ROOT/CHANGELOG.md" 2>/dev/null \
    | grep -v "/network\.sh:"; then
  fail "mirror URLs found outside network.sh; edit network.sh instead"
fi
ok "mirror URLs live only in network.sh"

# 4. The adapter turns the version-free Node base URL into a versioned download URL
#    and forwards the resolved mirror env. Import it with Harbor stubbed out.
case "$DSH_NODE_MIRROR" in
  *node-v[0-9]*|*/v[0-9]*/node-v*)
    fail "DSH_NODE_MIRROR must be a base URL without a version (got $DSH_NODE_MIRROR)" ;;
esac
python3 - "$HERE/dsh_agent.py" <<'PY'
import os, sys, types, typing
if not hasattr(typing, "override"):  # Python 3.11 has no typing.override
    typing.override = lambda f: f

def module(name, **attrs):
    mod = types.ModuleType(name)
    mod.__dict__.update(attrs)
    sys.modules[name] = mod
    return mod

class BaseAgent: ...
class AgentCapabilities:
    def __init__(self, **kwargs): ...
class BaseEnvironment: ...
class AgentContext: ...

module("harbor")
module("harbor.agents")
module("harbor.agents.base", BaseAgent=BaseAgent)
module("harbor.agents.capabilities", AgentCapabilities=AgentCapabilities)
module("harbor.environments")
module("harbor.environments.base", BaseEnvironment=BaseEnvironment)
module("harbor.models")
module("harbor.models.agent")
module("harbor.models.agent.context", AgentContext=AgentContext)

sys.path.insert(0, os.path.dirname(os.path.abspath(sys.argv[1])))
import dsh_agent

version = dsh_agent.NODE_VERSION
expected = f"{os.environ['DSH_NODE_MIRROR'].rstrip('/')}/v{version}/node-v{version}-linux"
assert dsh_agent.NODE_BASE == expected, (dsh_agent.NODE_BASE, expected)
assert dsh_agent.MIRROR_ENV.get("PIP_INDEX_URL") == os.environ["PIP_INDEX_URL"]
assert "DSH_NODE_MIRROR" not in dsh_agent.MIRROR_ENV
print("agent Node URL:", dsh_agent.NODE_BASE)
PY
ok "adapter Node URL + mirror env"

# 5. Rewrite a representative two-stage task tree and check every mirror surface.
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
task="$tmp/task"
mkdir -p "$task/environment"
cat > "$task/environment/Dockerfile" <<'EOF'
FROM python:3.12-slim
RUN apt-get update && apt-get install -y curl
RUN pip install uv && npm config set registry https://registry.npmjs.org
RUN curl -fsSL https://nodejs.org/dist/v24.9.0/node-v24.9.0-linux-arm64.tar.gz -o /tmp/node.tgz
RUN python3 - <<'PY'
FROM not-a-stage
PY
FROM alpine:3.20
RUN echo stage without package installs
EOF
cat > "$task/uv.lock" <<'EOF'
source = { registry = "https://pypi.org/simple" }
url = "https://files.pythonhosted.org/packages/ab/cd/foo.whl"
EOF
python3 "$HERE/apply-mirrors.py" "$task" >/dev/null
df="$task/environment/Dockerfile"
pip_base="${PIP_INDEX_URL%/simple}"
grep -q "$PIP_INDEX_URL" "$df" || fail "pip index not written to the Dockerfile"
grep -q "$PIP_TRUSTED_HOST" "$df" || fail "pip trusted host not written to the Dockerfile"
grep -q "$NPM_CONFIG_REGISTRY" "$df" || fail "npm registry not written to the Dockerfile"
grep -q "$DSH_NODE_MIRROR" "$df" || fail "Node mirror not written to the Dockerfile"
grep -q "$DSH_APT_MIRROR" "$df" || fail "apt mirror not written to the Dockerfile"
if grep -q 'pypi.org/simple' "$df"; then fail "explicit pypi index survived the rewrite"; fi
if grep -q 'registry.npmjs.org' "$df"; then fail "explicit npm registry survived the rewrite"; fi
if grep -q 'nodejs.org/dist' "$df"; then fail "explicit Node download survived the rewrite"; fi
[ "$(grep -c '^# dsh-mirrors' "$df")" -eq 2 ] || fail "expected one marker per real FROM stage"
grep -q '^FROM not-a-stage$' "$df" || fail "heredoc body was rewritten"
[ "$(grep -c 'sed -i -E' "$df")" -eq 1 ] || fail "apt rewrite must be limited to the apt stage"
grep -q "$PIP_INDEX_URL" "$task/uv.lock" || fail "uv.lock registry URL not rewritten"
grep -q "$pip_base" "$task/uv.lock" || fail "uv.lock wheel URL not rewritten"
# Execute the generated apt sed expression: it is POSIX ERE run inside the image,
# not Python regex. A `(?:...)` group here would be silently rejected by sed.
python3 - "$df" "$DSH_APT_MIRROR" <<'PY'
import pathlib, re, subprocess, sys
text = pathlib.Path(sys.argv[1]).read_text()
apt = sys.argv[2]
match = re.search(r"sed -i -E '([^']*)'", text)
if not match:
    raise SystemExit("no apt sed expression found in the rewritten Dockerfile")
sources = (
    "deb http://deb.debian.org/debian bookworm main\n"
    "deb http://security.debian.org/debian-security bookworm-security main\n"
)
result = subprocess.run(["sed", "-E", match.group(1)], input=sources, capture_output=True, text=True)
if result.returncode != 0:
    raise SystemExit(f"apt sed rejected the expression: {result.stderr.strip()}")
if apt not in result.stdout or "deb.debian.org" in result.stdout:
    raise SystemExit(f"apt sed did not rewrite Debian sources: {result.stdout!r}")
print("apt sed expression rewrote Debian sources")
PY
cp "$df" "$tmp/dockerfile.first"
python3 "$HERE/apply-mirrors.py" "$task" >/dev/null
cmp -s "$df" "$tmp/dockerfile.first" || fail "apply-mirrors.py is not idempotent"
ok "Dockerfile/uv.lock rewrite + heredoc safety + apt sed + idempotence"

# 6. DSH_MIRRORS=off must leave a task tree untouched.
mkdir -p "$tmp/off/environment"
cat > "$tmp/off/environment/Dockerfile" <<'EOF'
FROM python:3.12-slim
RUN apt-get update && pip install requests
EOF
cp "$tmp/off/environment/Dockerfile" "$tmp/off.first"
(
  set -u
  export DSH_MIRRORS=off
  # shellcheck source=network.sh
  source "$HERE/network.sh"
  [ -z "${PIP_INDEX_URL:-}" ] || exit 1
  python3 "$HERE/apply-mirrors.py" "$tmp/off" >/dev/null
) || fail "DSH_MIRRORS=off did not unset the mirror environment"
cmp -s "$tmp/off/environment/Dockerfile" "$tmp/off.first" || fail "DSH_MIRRORS=off still rewrote the Dockerfile"
ok "DSH_MIRRORS=off is a no-op"

dsh_network_validate >/dev/null || fail "network.sh validation"
ok "resolved network config is valid"
echo "PASS network config check"
