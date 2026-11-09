#!/usr/bin/env bash
# One command to make the graph loop the profile's agent runtime.
#
#   bash scripts/install-explore.sh [profile]      # default: web
#   bash scripts/install-explore.sh --profile web
#   bash scripts/install-explore.sh --dry-run      # resolve + report only
#
# It installs the Graph-tab bundle, the graph driver bundle and the explore mode
# bundle into the profile, verifying each step, then checks that the stock
# `agent-loop` row is disabled and the graph rows are present. DSH has no global
# "default profile": profile selection is always `--profile <name>` (or
# `dsh <name>`), so "default" here means the profile the user actually boots —
# `web` unless another name is supplied.
#
# Profile existence is decided from the profile directory on disk
# (`$DSH_HOME/profiles/<name>`, with `$DSH_HOME` defaulting to `~/.dsh`), never
# from a failed `--dump-config`: a corrupt-but-recoverable profile must not be
# recreated. DSH's `--from-default-profile` moves an existing profile aside and
# deletes it, so this script refuses to run it over an existing directory.
#
# `--dry-run` only resolves the profile path and reports what would happen; it
# runs no dsh command and writes nothing, so it is safe against a real profile.
#
# The stock package is NOT uninstalled: the shipped base bundle depends on
# `@deepseek-ai/dsh-agent-loop`. Disabling its row is DSH's supported replacement
# mechanism and is what the graph bundle's patch does.

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# Resolve the read-only DSH checkout: $DSH_REPO wins, then a sibling clone
# (../deepseek-harness) or ~/deepseek-harness. Fail clearly when none exists.
find_dsh() {
  local candidate
  for candidate in "${DSH_REPO:-}" "${DSH_ROOT:-}" "$ROOT/../deepseek-harness" "$HOME/deepseek-harness"; do
    if [ -n "$candidate" ] && [ -d "$candidate" ]; then
      (cd "$candidate" && pwd)
      return 0
    fi
  done
  return 1
}
if ! DSH="$(find_dsh)"; then
  echo "FAIL: no DSH checkout found; set DSH_REPO=/path/to/deepseek-harness" >&2
  echo "      (or place a clone next to this repo as ../deepseek-harness)" >&2
  exit 1
fi
PROFILE="web"
DRY_RUN=0

while [ "$#" -gt 0 ]; do
  case "$1" in
    --profile)
      [ "$#" -ge 2 ] || { echo "--profile needs a name" >&2; exit 2; }
      PROFILE="$2"; shift 2 ;;
    --dry-run)
      DRY_RUN=1; shift ;;
    -h|--help)
      sed -n '2,/^$/p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) PROFILE="$1"; shift ;;
  esac
done

# DSH rejects these names; mirroring the check keeps the profile path well-formed.
case "$PROFILE" in
  ''|.|..|node_modules|*/*|*\\*)
    echo "FAIL: invalid profile name '$PROFILE'" >&2
    exit 2 ;;
esac

ds() { ( cd "$DSH" && node --import tsx/esm apps/cli/src/bin.ts "$@" ); }

# Resolve DSH's home exactly the way @deepseek-ai/dsh-home-paths does: a
# non-blank `$DSH_HOME` wins (expanding a leading `~/`), otherwise `~/.dsh`.
resolve_dsh_home() {
  local configured="${DSH_HOME:-}"
  case "$configured" in
    *[![:space:]]*) ;;
    *) configured="$HOME/.dsh" ;;
  esac
  case "$configured" in
    '~') configured="$HOME" ;;
    '~/'*) configured="$HOME/${configured:2}" ;;
  esac
  case "$configured" in
    /*) ;;
    *) configured="$DSH/$configured" ;;
  esac
  printf '%s\n' "$configured"
}

DSH_HOME_DIR="$(resolve_dsh_home)"
PROFILE_DIR="$DSH_HOME_DIR/profiles/$PROFILE"
MANIFEST="$PROFILE_DIR/package.json"
LOCKFILE="$PROFILE_DIR/pnpm-lock.yaml"

echo "== profile: $PROFILE  (home: $DSH_HOME_DIR)"

profile_exists() { [ -e "$PROFILE_DIR" ] || [ -L "$PROFILE_DIR" ]; }

# Resolve and report without running dsh or writing anything.
if [ "$DRY_RUN" -eq 1 ]; then
  echo "== dry run: no dsh command and no profile change"
  if profile_exists; then
    echo "   profile directory exists: $PROFILE_DIR"
    echo "   would verify it with: dsh --profile $PROFILE --dump-config"
    echo "   would back up $MANIFEST, then add packages/graph-ui, packages/loop, packages/mode"
  else
    echo "   profile directory absent: $PROFILE_DIR"
    echo "   would create it from the shipped web template, then add"
    echo "   packages/graph-ui, packages/loop, packages/mode"
  fi
  exit 0
fi

# An existing profile is never replaced. DSH's initializeProfileFromDefault()
# renames the old directory aside and then deletes it, so a broken-but-recoverable
# profile would be lost; give the user the diagnostics instead.
abort_existing_profile() {
  local cause="$1"
  cat >&2 <<EOF
FAIL: $cause
      The profile directory already exists at:
        $PROFILE_DIR
      Refusing to recreate it: DSH's --from-default-profile moves the old
      directory aside and deletes it, so a corrupt-but-recoverable profile
      would be lost. No profile files were changed.

      Recover the profile in place:
        1. reproduce the error:
             ( cd "$DSH" && node --import tsx/esm apps/cli/src/bin.ts --profile $PROFILE --dump-config )
        2. isolate a broken user layer (omits $PROFILE_DIR/cordis.patch.yml):
             ( cd "$DSH" && node --import tsx/esm apps/cli/src/bin.ts --profile $PROFILE --dump-default-config )
        3. inspect and repair:
             $PROFILE_DIR/package.json
             $PROFILE_DIR/cordis.patch.yml
        4. to start over deliberately, move the old profile away first:
             mv "$PROFILE_DIR" "$PROFILE_DIR.backup-\$(date +%Y%m%d%H%M%S)"
           then re-run this script.
EOF
  exit 1
}

if profile_exists; then
  [ -d "$PROFILE_DIR" ] || abort_existing_profile "the profile path exists but is not a directory."
  echo "== checking the existing profile"
  if ! ds --profile "$PROFILE" --dump-config > /dev/null; then
    abort_existing_profile "profile '$PROFILE' exists but its config cannot be dumped."
  fi
else
  # The directory is absent, so creating it is safe. `loadProfile` initializes a
  # shipped profile name (web, headless, …) from its template on first read; any
  # other name needs an explicit template. Probe with a plain read first so a
  # default `web` install works, and re-check the disk before creating: if DSH
  # left a partial directory behind, treat it as user data, not as absence.
  if ! ds --profile "$PROFILE" --dump-config > /dev/null 2>&1; then
    if profile_exists; then
      abort_existing_profile "a profile directory appeared while probing profile '$PROFILE'."
    fi
    echo "== creating profile '$PROFILE' from the shipped web template"
    if ! ds --profile "$PROFILE" --from-default-profile web --dump-config > /dev/null; then
      echo "FAIL: could not create profile '$PROFILE' from the web template." >&2
      echo "      Shipped profile names are reserved and need no --from-default-profile; for any" >&2
      echo "      other name check DSH_REPO and that '$DSH' is a working dsh checkout." >&2
      exit 1
    fi
    if ! profile_exists; then
      echo "FAIL: dsh reported success but $PROFILE_DIR does not exist." >&2
      exit 1
    fi
  fi
fi

[ -f "$MANIFEST" ] || { echo "FAIL: profile '$PROFILE' has no package.json at $MANIFEST." >&2; exit 1; }

# Back up the manifest (and lockfile) before the first add. Any later failure —
# a failed add, a missing row, the final composition check — restores the
# pre-install state instead of leaving a half-installed profile behind.
BACKUP_DIR=""
restore_profile() {
  cp "$BACKUP_DIR/package.json" "$MANIFEST" || return 1
  if [ -f "$BACKUP_DIR/pnpm-lock.yaml" ]; then
    cp "$BACKUP_DIR/pnpm-lock.yaml" "$LOCKFILE" || return 1
  else
    rm -f "$LOCKFILE"
  fi
}
on_exit() {
  local status=$?
  if [ -n "$BACKUP_DIR" ] && [ -d "$BACKUP_DIR" ]; then
    if [ "$status" -eq 0 ]; then
      rm -rf "$BACKUP_DIR"
    elif restore_profile; then
      echo "== restored the pre-install profile manifest from $BACKUP_DIR" >&2
      rm -rf "$BACKUP_DIR"
    else
      echo "WARNING: could not restore $MANIFEST; the backup is at $BACKUP_DIR" >&2
    fi
  fi
}
trap on_exit EXIT

TMP_ROOT="${TMPDIR:-/tmp}"
TMP_ROOT="${TMP_ROOT%/}"
BACKUP_DIR="$(mktemp -d "$TMP_ROOT/dsh-explore-$PROFILE.XXXXXX")"
cp "$MANIFEST" "$BACKUP_DIR/package.json"
if [ -f "$LOCKFILE" ]; then
  cp "$LOCKFILE" "$BACKUP_DIR/pnpm-lock.yaml"
fi
echo "== backed up the profile manifest to $BACKUP_DIR"

# The package name a local bundle directory publishes (read from its own manifest).
package_name() {
  node -e 'process.stdout.write(require(process.argv[1]).name)' "$1/package.json"
}

# Whether the profile manifest lists the bundle as a dsh.profile.bundles layer.
bundle_listed() {
  node -e '
    const manifest = require(process.argv[1])
    const bundles = manifest?.dsh?.profile?.bundles
    process.exit(Array.isArray(bundles) && bundles.includes(process.argv[2]) ? 0 : 1)
  ' "$MANIFEST" "$1"
}

# Install one local bundle, then verify that step immediately: the profile must
# list the bundle and compose its row. A swallowed failure here would otherwise
# only surface in the final dump, after the manifest already changed.
install_bundle() {
  local label="$1" dir="$2" row="$3"
  local pkg dump
  pkg="$(package_name "$dir")"
  echo "== installing $label"
  if ! ds plugin --profile "$PROFILE" add "$dir" > /dev/null; then
    echo "FAIL: 'plugin add $label' failed; the profile manifest will be restored." >&2
    exit 1
  fi
  if ! bundle_listed "$pkg"; then
    echo "FAIL: $pkg is not in dsh.profile.bundles after installing $label." >&2
    exit 1
  fi
  if ! dump="$(ds --profile "$PROFILE" --dump-config)"; then
    echo "FAIL: profile '$PROFILE' no longer composes after installing $label." >&2
    exit 1
  fi
  if ! grep -Fq "id: $row" <<<"$dump"; then
    echo "FAIL: row 'id: $row' is missing after installing $label." >&2
    exit 1
  fi
  echo "   ok: $pkg composed as row 'id: $row'"
}

install_bundle "Graph tab bundle" "$ROOT/packages/graph-ui" "graph-ui"
install_bundle "graph driver bundle" "$ROOT/packages/loop" "graph-loop"
install_bundle "explore mode bundle" "$ROOT/packages/mode" "preset-explore"

echo "== verifying composition"
DUMP="$(ds --profile "$PROFILE" --dump-config)"
grep -q 'id: graph-loop' <<<"$DUMP" || { echo "FAIL: graph-loop row missing" >&2; exit 1; }
grep -q 'id: graph-ui' <<<"$DUMP" || { echo "FAIL: graph-ui row missing" >&2; exit 1; }
grep -q 'id: preset-explore' <<<"$DUMP" || { echo "FAIL: explore mode is not registered" >&2; exit 1; }
awk '
  /^- id: agent-loop$/ { row = 1; next }
  row && /^[[:space:]]+disabled: true$/ { found = 1 }
  row && /^- id: / { row = 0 }
  END { exit found ? 0 : 1 }
' <<<"$DUMP" || { echo "FAIL: stock agent-loop row is not disabled" >&2; exit 1; }
awk '
  /^- id: agent-preset-registry$/ { row = 1; next }
  row && /^[[:space:]]+default: explore$/ { found = 1 }
  row && /^- id: / { row = 0 }
  END { exit found ? 0 : 1 }
' <<<"$DUMP" || { echo "FAIL: explore is not the default mode" >&2; exit 1; }

echo "PASS  graph loop installed into profile '$PROFILE'"
echo "      stock agent-loop row disabled (package retained: the base bundle depends on it)"
echo "      default mode: explore (new sessions)"
if [ "$PROFILE" = "web" ]; then
  echo "      default launch: dsh web"
else
  echo "      launch: dsh --profile $PROFILE"
fi
