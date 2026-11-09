#!/usr/bin/env python3
"""Rewrite a copied Terminal-Bench task tree to the package sources in network.sh.

This script owns no URLs: it reads the mirror environment that network.sh resolves,
so a single file (`bench/official/terminal-bench/network.sh`) remains the source of
truth. It is applied to the *build copy*, never to the task source, and is idempotent
through a marker comment.

  source bench/official/terminal-bench/network.sh
  python3 apply-mirrors.py <build-copy> [--off]

Rewrites, when the corresponding value is exported:
  - explicit pypi / files.pythonhosted URLs and uv.lock registry URLs -> PIP_INDEX_URL;
  - explicit registry.npmjs.org URLs in Dockerfiles                     -> NPM_CONFIG_REGISTRY;
  - nodejs.org/dist URLs in Dockerfiles                                -> DSH_NODE_MIRROR;
  - Debian/Ubuntu apt sources in Dockerfiles                           -> DSH_APT_MIRROR.

Docker base images, vendor sidecars and GitHub downloads are not package indexes and
are intentionally not rewritten; use the Docker daemon proxy for those.
"""

from __future__ import annotations

import os
import re
import sys
from pathlib import Path
from urllib.parse import urlparse

MARKER = "# dsh-mirrors: package sources from network.sh"


def _env(name: str) -> str:
    value = (os.environ.get(name) or "").strip()
    return value.rstrip("/")


PIP_INDEX = _env("PIP_INDEX_URL")
PIP_BASE = PIP_INDEX[: -len("/simple")] if PIP_INDEX.endswith("/simple") else ""
PIP_HOST = _env("PIP_TRUSTED_HOST") or (urlparse(PIP_INDEX).hostname or "")
UV_INDEX = _env("UV_DEFAULT_INDEX") or PIP_INDEX
NPM = _env("NPM_CONFIG_REGISTRY") or _env("npm_config_registry")
APT = _env("DSH_APT_MIRROR")
NODE_MIRROR = _env("DSH_NODE_MIRROR")
MIRRORS_MODE = _env("DSH_MIRRORS")

APT_PATTERN = (
    r"https?://(?:deb\.debian\.org|security\.debian\.org|archive\.ubuntu\.com"
    r"|security\.ubuntu\.com|ports\.ubuntu\.com)"
)


def env_block() -> str | None:
    """The Dockerfile ENV block for all resolved package indexes."""
    pairs: list[tuple[str, str]] = []
    if PIP_INDEX:
        pairs.append(("PIP_INDEX_URL", PIP_INDEX))
    if PIP_HOST:
        pairs.append(("PIP_TRUSTED_HOST", PIP_HOST))
    if UV_INDEX:
        pairs.append(("UV_DEFAULT_INDEX", UV_INDEX))
    if NPM:
        pairs.extend((("NPM_CONFIG_REGISTRY", NPM), ("npm_config_registry", NPM)))
    if not pairs:
        return None
    lines = [f"ENV {pairs[0][0]}={pairs[0][1]}"]
    lines.extend(f"    {key}={value}" for key, value in pairs[1:])
    return " \\\n".join(lines)


def apt_block() -> str | None:
    """Rewrite apt sources in-place; only inserted into stages that run apt."""
    if not APT:
        return None
    return (
        "RUN if command -v sed >/dev/null 2>&1; then \\\n"
        "      for f in /etc/apt/sources.list /etc/apt/sources.list.d/*.list "
        "/etc/apt/sources.list.d/*.sources; do \\\n"
        '        [ -f "$f" ] || continue; \\\n'
        f"        sed -i -E 's#{APT_PATTERN}#{APT}#g' \"$f\" || true; \\\n"
        "      done; \\\n"
        "    fi"
    )


ENV_BLOCK = env_block()
APT_BLOCK = apt_block()


def rewrite_dockerfile(text: str) -> str:
    if MARKER in text:
        return text

    replacements = [
        ("https://pypi.org/simple", PIP_INDEX),
        ("http://pypi.org/simple", PIP_INDEX),
        ("https://files.pythonhosted.org", PIP_BASE),
        ("https://registry.npmjs.org", NPM),
        ("http://registry.npmjs.org", NPM),
        ("https://nodejs.org/dist", NODE_MIRROR),
    ]
    for old, new in replacements:
        if old and new:
            text = text.replace(old, new)

    lines = text.splitlines()
    froms = [i for i, line in enumerate(lines) if line.startswith("FROM ")]
    # Only stages that actually run apt get the source rewrite; a distroless stage
    # must not gain a RUN layer it cannot execute.
    stage_needs_apt = []
    for n, start in enumerate(froms):
        end = froms[n + 1] if n + 1 < len(froms) else len(lines)
        stage_needs_apt.append(
            any(
                re.search(
                    r"\bapt(?:-get)?\b.*\b(?:update|install|upgrade|dist-upgrade)\b", line
                )
                for line in lines[start:end]
            )
        )

    out: list[str] = []
    for i, line in enumerate(lines):
        out.append(line)
        if i not in froms:
            continue
        out.append(MARKER)
        if ENV_BLOCK:
            out.append(ENV_BLOCK)
        stage = froms.index(i)
        if APT_BLOCK and stage_needs_apt[stage]:
            out.append(APT_BLOCK)
    return "\n".join(out) + "\n"


def rewrite_uv_lock(text: str) -> str:
    if PIP_INDEX:
        text = text.replace("https://pypi.org/simple", PIP_INDEX)
    if PIP_BASE:
        text = text.replace("https://files.pythonhosted.org", PIP_BASE)
    return text


def main(argv: list[str]) -> int:
    args = [a for a in argv[1:] if a]
    force_off = "--off" in args
    args = [a for a in args if a != "--off"]
    if not args:
        print("usage: apply-mirrors.py <build-copy> [--off]", file=sys.stderr)
        return 2
    if args[0] in {"-h", "--help"}:
        print("usage: apply-mirrors.py <build-copy> [--off]")
        return 0
    if len(args) != 1:
        print("usage: apply-mirrors.py <build-copy> [--off]", file=sys.stderr)
        return 2

    root = Path(args[0])
    if not root.is_dir():
        print(f"apply-mirrors: not a directory: {root}", file=sys.stderr)
        return 2

    active = bool(PIP_INDEX or NPM or NODE_MIRROR or APT)
    if force_off or MIRRORS_MODE == "off" or not active:
        print("mirrors: off (upstream package sources)")
        return 0

    changed = 0
    for path in sorted(root.rglob("*")):
        if not path.is_file():
            continue
        if path.name.startswith("Dockerfile"):
            before = path.read_text()
            after = rewrite_dockerfile(before)
        elif path.name == "uv.lock":
            before = path.read_text()
            after = rewrite_uv_lock(before)
        else:
            continue
        if after != before:
            path.write_text(after)
            changed += 1
            print(f"mirrors: rewrote {path}")
    print(f"mirrors: {changed} file(s) -> pip/uv/npm/node/apt sources from network.sh")
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
