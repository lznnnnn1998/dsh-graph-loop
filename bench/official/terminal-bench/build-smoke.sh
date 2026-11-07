#!/usr/bin/env bash
# Build the smoke task image with a native DSH runtime.
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
docker image inspect dsh-base:arm64 >/dev/null 2>&1 || {
  echo "missing dsh-base:arm64; build it first:"
  echo "  docker build --platform linux/arm64 -t dsh-base:arm64 -f $HERE/dsh-base.Dockerfile $HERE"
  exit 1
}
docker build --platform linux/arm64 -t tb-smoke-env:arm64 "$HERE/smoke-task/environment"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
cat > "$tmp/Dockerfile" <<'EOD'
FROM tb-smoke-env:arm64
COPY --from=dsh-base:arm64 /opt/dsh /opt/dsh
ENV PATH=/opt/dsh/bin:$PATH
EOD
docker build --platform linux/arm64 -t tb-smoke-dsh:arm64 -f "$tmp/Dockerfile" "$tmp"
echo "PASS smoke image built"
