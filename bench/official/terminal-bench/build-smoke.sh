#!/usr/bin/env bash
# Build the smoke task image with a native DSH runtime.
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=network.sh
source "$HERE/network.sh"
# The smoke Dockerfiles perform no package installs, so apply-mirrors.py has
# nothing to rewrite here; the proxy build args below still apply.
BUILD_ARGS=(--platform linux/arm64)
for name in $DSH_BUILD_PROXY_VARS; do
  value="${!name:-}"
  [ -n "$value" ] && BUILD_ARGS+=(--build-arg "$name=$value")
done
docker image inspect dsh-base:arm64 >/dev/null 2>&1 || {
  echo "missing dsh-base:arm64; build it first:"
  echo "  bash $HERE/build-dsh-base.sh"
  exit 1
}
docker build "${BUILD_ARGS[@]}" -t tb-smoke-env:arm64 "$HERE/smoke-task/environment"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
cat > "$tmp/Dockerfile" <<'EOD'
FROM tb-smoke-env:arm64
COPY --from=dsh-base:arm64 /opt/dsh /opt/dsh
ENV PATH=/opt/dsh/bin:$PATH
EOD
docker build "${BUILD_ARGS[@]}" -t tb-smoke-dsh:arm64 -f "$tmp/Dockerfile" "$tmp"
echo "PASS smoke image built (network: mirrors=$DSH_MIRRORS)"
