#!/usr/bin/env bash
# Terminal-Bench 4.0 preflight. READY only when the harness and a container
# backend can actually run; a DSH Harbor agent adapter is still required.
set -u
missing=()
notes=()

command -v uv >/dev/null 2>&1 || missing+=("uv (https://docs.astral.sh/uv/)")
command -v docker >/dev/null 2>&1 || missing+=("docker (or a Modal account for --env modal)")
command -v harbor >/dev/null 2>&1 || notes+=("harbor CLI not on PATH; install with: uv tool install 'harbor[modal]'")

if command -v docker >/dev/null 2>&1; then
  docker info >/dev/null 2>&1 || missing+=("a running Docker daemon (docker info failed)")
fi
if command -v harbor >/dev/null 2>&1; then
  harbor --version >/dev/null 2>&1 || notes+=("harbor exists but --version failed")
fi
if [ -n "${MODAL_TOKEN_ID:-}" ] || [ -n "${MODAL_TOKEN_SECRET:-}" ]; then
  notes+=("Modal credentials present; --env modal is an option")
fi

echo "Terminal-Bench 4.0 preflight"
echo "  DSH agent adapter: NOT IMPLEMENTED (Harbor needs a DSH agent class)"
if [ "${#notes[@]}" -gt 0 ]; then
  printf '  note: %s\n' "${notes[@]}"
fi
if [ "${#missing[@]}" -gt 0 ]; then
  printf '  missing: %s\n' "${missing[@]}"
  echo "NOT READY"
  exit 2
fi
echo "READY (harness only; DSH adapter still required)"
