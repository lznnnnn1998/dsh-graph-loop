#!/usr/bin/env bash
# Build the reusable DSH base image (Node + DSH + pnpm) for native arm64 tasks.
#
# The build copy is passed through apply-mirrors.py so the base image follows the
# same network configuration as task images. The task sources are not modified.
#
# Usage: build-dsh-base.sh [tag]    (default: dsh-base:arm64)
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=network.sh
source "$HERE/network.sh"
TAG="${1:-dsh-base:arm64}"

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
cp "$HERE/dsh-base.Dockerfile" "$tmp/Dockerfile"
python3 "$HERE/apply-mirrors.py" "$tmp"

BUILD_ARGS=(--platform linux/arm64)
for name in $DSH_BUILD_PROXY_VARS; do
  value="${!name:-}"
  [ -n "$value" ] && BUILD_ARGS+=(--build-arg "$name=$value")
done

echo "network: mirrors=$DSH_MIRRORS (source: network.sh)"
docker build "${BUILD_ARGS[@]}" -t "$TAG" "$tmp"
echo "PASS dsh base built: $TAG"
