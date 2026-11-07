#!/usr/bin/env bash
# Build a Terminal-Bench task natively for linux/arm64 on Apple Silicon.
#
# The published task images are amd64; running Node under qemu-x86_64 crashes
# with libuv's uv__io_poll assertion, so the DSH agent needs a native image.
# This copies the task, unpins multi-arch base digests, replaces the task's
# docker_image fields with local tags, and builds both environment and verifier.
#
# Usage: build-arm64-task.sh <task-dir> <output-dir> [env-tag] [verifier-tag]
set -euo pipefail
TASK="${1:?task dir}"
OUT="${2:?output dir}"
ENV_TAG="${3:-tb-arm64-env:latest}"
VERIFIER_TAG="${4:-tb-arm64-verifier:latest}"

rm -rf "$OUT"
cp -R "$TASK" "$OUT"

python3 - "$OUT" "$ENV_TAG" "$VERIFIER_TAG" <<'PY'
import re, sys
from pathlib import Path
out, env_tag, verifier_tag = Path(sys.argv[1]), sys.argv[2], sys.argv[3]
for p in [out / 'environment' / 'Dockerfile', out / 'tests' / 'Dockerfile']:
    if not p.exists():
        continue
    s = p.read_text()
    # Multi-arch bases: drop the amd64 manifest digest and let buildx pick arm64.
    s = re.sub(r'python:3\.(?:12|13)-slim-bookworm@sha256:[0-9a-f]+', lambda m: m.group(0).split('@')[0], s)
    s = re.sub(r'mcr\.microsoft\.com/playwright/python:[^@\s]+@sha256:[0-9a-f]+', lambda m: m.group(0).split('@')[0], s)
    s = re.sub(r'ghcr\.io/astral-sh/uv@sha256:[0-9a-f]+', 'ghcr.io/astral-sh/uv:latest', s)
    p.write_text(s)

toml = out / 'task.toml'
s = toml.read_text()
# The environment image and the verifier image are the two `docker_image` keys.
def replace_section_image(text: str, section: str, tag: str) -> str:
    # Replace docker_image only inside the named TOML section.
    pattern = re.compile(
        r'(?ms)^\[' + re.escape(section) + r'\]\s*$.*?(?=^\[[^\]]+\]\s*$|\Z)'
    )
    match = pattern.search(text)
    if match is None:
        return text
    block = match.group(0)
    new_block = re.sub(r'docker_image\s*=\s*"[^"]+"', f'docker_image = "{tag}"', block, count=1)
    return text[:match.start()] + new_block + text[match.end():]

s = replace_section_image(s, 'environment', env_tag)
s = replace_section_image(s, 'verifier.environment', verifier_tag)
toml.write_text(s)
PY

echo "== build environment (linux/arm64)"
docker build --platform linux/arm64 -t "$ENV_TAG" "$OUT/environment"

if [ -f "$OUT/tests/Dockerfile" ]; then
  echo "== build verifier (linux/arm64)"
  docker build --platform linux/arm64 -t "$VERIFIER_TAG" "$OUT/tests"
fi

echo "PASS arm64 task built at $OUT"
echo "  env:      $ENV_TAG"
echo "  verifier: $VERIFIER_TAG"
