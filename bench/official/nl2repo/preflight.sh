#!/usr/bin/env bash
# NL2Repo-Bench preflight. READY only when Docker, both OpenHands images and
# the harness checkout exist. The harness is OpenHands-based; a DSH adapter is
# not implemented.
set -u
REPO="${NL2REPO_DIR:-/tmp/nl2repo}"
missing=()
notes=()

command -v docker >/dev/null 2>&1 || missing+=("docker")
if command -v docker >/dev/null 2>&1; then
  docker info >/dev/null 2>&1 || missing+=("a running Docker daemon (docker info failed)")
  for image in docker.all-hands.dev/all-hands-ai/openhands:0.56 docker.all-hands.dev/all-hands-ai/runtime:0.56-nikolaik; do
    docker image inspect "$image" >/dev/null 2>&1 || missing+=("image $image")
  done
fi
[ -d "$REPO" ] || missing+=("NL2RepoBench checkout at $REPO (set NL2REPO_DIR)")
if [ -d "$REPO" ]; then
  [ -f "$REPO/main.py" ] || missing+=("$REPO/main.py")
  [ -f "$REPO/openhands/openhands_app.py" ] || missing+=("$REPO/openhands/openhands_app.py")
fi
command -v python3 >/dev/null 2>&1 || missing+=("python3")

echo "NL2Repo-Bench preflight"
echo "  DSH adapter: NOT IMPLEMENTED (harness calls OpenHands, not DSH)"
if [ "${#notes[@]}" -gt 0 ]; then
  printf '  note: %s\n' "${notes[@]}"
fi
if [ "${#missing[@]}" -gt 0 ]; then
  printf '  missing: %s\n' "${missing[@]}"
  echo "NOT READY"
  exit 2
fi
echo "READY (OpenHands harness; DSH adapter still required)"
