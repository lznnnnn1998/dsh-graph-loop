#!/usr/bin/env bash
# Terminal-Bench 4.0 preflight. READY only when the harness and a container
# backend can actually run; a DSH Harbor agent adapter is still required.
set -u
missing=()
notes=()

command -v uv >/dev/null 2>&1 || missing+=("uv (https://docs.astral.sh/uv/)")
command -v docker >/dev/null 2>&1 || missing+=("docker (or a Modal account for --env modal)")
if ! command -v harbor >/dev/null 2>&1 && [ -x "$HOME/.local/bin/harbor" ]; then export PATH="$HOME/.local/bin:$PATH"; fi
command -v harbor >/dev/null 2>&1 || missing+=("harbor CLI (uv tool install --python 3.12 'harbor[modal]'; add ~/.local/bin to PATH)")

if command -v docker >/dev/null 2>&1; then
  docker info >/dev/null 2>&1 || missing+=("a running Docker daemon (docker info failed)")
fi
if command -v harbor >/dev/null 2>&1; then
  harbor --version >/dev/null 2>&1 || notes+=("harbor exists but --version failed")
fi
if command -v docker >/dev/null 2>&1; then
  docker compose version >/dev/null 2>&1 || missing+=("docker compose plugin")
fi
[ -f "$(dirname "${BASH_SOURCE[0]}")/dsh_agent.py" ] || missing+=("dsh_agent.py adapter")
if [ -n "${MODAL_TOKEN_ID:-}" ] || [ -n "${MODAL_TOKEN_SECRET:-}" ]; then
  notes+=("Modal credentials present; --env modal is an option")
fi

echo "Terminal-Bench 4.0 preflight"
echo "  DSH agent adapter: bench/official/terminal-bench/dsh_agent.py"
  echo "  Apple Silicon: build each task for linux/arm64 with build-arm64-task.sh (qemu Node crashes)"
if [ "${#notes[@]}" -gt 0 ]; then
  printf '  note: %s\n' "${notes[@]}"
fi
if [ "${#missing[@]}" -gt 0 ]; then
  printf '  missing: %s\n' "${missing[@]}"
  echo "NOT READY"
  exit 2
fi
echo "READY (harness + DSH adapter; use native arm64 task images on Apple Silicon)"
