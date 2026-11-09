#!/usr/bin/env bash
# dev-patch.sh — materialize a committed dev overlay template for runtime use.
#
# packages/loop/dev*.patch.yml are committed TEMPLATES: __REPO_ROOT__ stands
# for the absolute path of this checkout and __TMP_DIR__ for the system temp
# directory. The DSH `--patch` loader needs a real file whose plugin paths are
# absolute, so the e2e scripts source this helper, materialize the template
# under the temp dir, and remove it again on exit. Nothing machine-specific is
# ever written into the repository.
#
# Usage (from an e2e script with ROOT already resolved):
#   . "$ROOT/scripts/lib/dev-patch.sh"
#   PATCH="$(materialize_dev_patch "$ROOT" dev-headless.patch.yml)"
#   cleanup() { ...; rm -f "${PATCH:-}"; }
#   trap cleanup EXIT
#
# Prints the materialized file path on stdout. On error, prints a clear message
# on stderr and returns non-zero (under `set -e` that aborts the caller).
materialize_dev_patch() {
  local root="${1:?repo root required}"
  local template="${2:?template filename required}"
  local src="$root/packages/loop/$template"
  local tmpdir out

  if [ ! -f "$src" ]; then
    printf 'dev-patch: FAIL — overlay template missing: %s\n' "$src" >&2
    printf 'dev-patch: expected a committed packages/loop/*.patch.yml template\n' >&2
    return 1
  fi

  tmpdir="${TMPDIR:-/tmp}"
  tmpdir="${tmpdir%/}"
  out="$(mktemp "$tmpdir/dsh-dev-patch.XXXXXX")" || return 1

  # `|` as the sed delimiter: checkout paths and temp dirs contain slashes.
  if ! sed -e "s|__REPO_ROOT__|$root|g" -e "s|__TMP_DIR__|$tmpdir|g" "$src" > "$out"; then
    rm -f "$out"
    printf 'dev-patch: FAIL — could not materialize %s\n' "$src" >&2
    return 1
  fi

  printf '%s\n' "$out"
}
