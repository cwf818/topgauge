#!/usr/bin/env bash
# clean-cache.sh — remove stale version directories under the plugin
# cache, keeping only the newest one.
#
# Background:
#   When you /plugin install a new version of topgauge-cc,
#   Claude Code's loader creates a new <version> dir under
#     ${CLAUDE_CONFIG_DIR:-$HOME/.claude}/plugins/cache/topgauge-cc/topgauge-cc/
#   but does NOT remove the previous version's dir. Old dirs pile up
#   over time. Each one is ~40-50MB (full source tree + node_modules).
#
#   The statusLine.command the wrapper writes is a bash one-liner that
#   `ls -d`s all version dirs, sorts by version, and `tail -1`s the
#   highest — so only the newest dir is ever actually used. The
#   older dirs are pure dead weight.
#
# Behavior:
#   - Walks <cache>/topgauge-cc/, finds all <version> dirs.
#   - Sorts by version numerically (4-component dotted-decimal).
#   - Keeps the highest. Removes the rest.
#   - This is destructive: --dry-run is supported for preview.
#
# v0.7.0 — also walks the LEGACY cache root
# (<cache>/tokenplan-usage-hud/tokenplan-usage-hud/) left behind by
# users upgrading from the pre-rename install, so leftover version
# dirs from the old plugin get pruned the same way.
#
# Safety:
#   - Only touches dirs whose name matches the <version> shape
#     (digits and dots). Refuses to touch any other dir or any
#     non-dir entry.
#   - Never touches the wrapper-statusline, the .in_use / .orphaned_at
#     markers, or any other file Claude Code manages.
#   - Only ever descends one level: the version dirs directly under
#     the plugin cache.
#   - Idempotent: re-running is a no-op once only the newest remains.
#   - Self-protection: the version dir this script lives in is
#     itself a candidate for removal. Resolve SCRIPT_DIR up front so
#     a later rm -rf of THAT dir doesn't break us mid-script
#     (same defensive pattern as uninstall.sh).
#
# Usage:
#   clean-cache.sh                  # user-level (default)
#   clean-cache.sh --dry-run        # preview, change nothing
#   clean-cache.sh -h | --help
#
# Portable: Linux, macOS, Git Bash on Windows.

set -u

DRY_RUN=0

print_help() {
  sed -n '2,42p' "$0"
}

for arg in "$@"; do
  case "$arg" in
    --dry-run) DRY_RUN=1 ;;
    -h|--help)
      print_help
      exit 0
      ;;
    *)
      echo "clean-cache.sh: unknown argument: $arg" >&2
      echo "  usage: clean-cache.sh [--dry-run]" >&2
      exit 2
      ;;
  esac
done

# Resolve SCRIPT_DIR ONCE so a later `rm -rf` of THIS dir doesn't
# resolve to a dangling path. Same defensive pattern as uninstall.sh
# (commit 8030e4c). The script itself lives in
# <cache>/topgauge-cc/<version>/scripts/clean-cache.sh, so
# SCRIPT_DIR is exactly the dir we will eventually remove. That's
# fine — we don't need to read this file again after the rm.
SCRIPT_DIR="$(cd "$(dirname "$0")" 2>/dev/null && pwd || true)"

CLAUDE_ROOT="${CLAUDE_CONFIG_DIR:-$HOME/.claude}"
# v0.7.0 — dual-root: walk the NEW cache (`topgauge-cc`) and the
# LEGACY cache (`tokenplan-usage-hud`) left behind by users
# upgrading from the pre-rename install. We dedupe later so a
# version dir that happens to match in both roots only triggers a
# single plan entry. CACHE_BASES is the iterate-over list.
CACHE_BASE="${CLAUDE_ROOT}/plugins/cache/topgauge-cc/topgauge-cc"
LEGACY_CACHE_BASE="${CLAUDE_ROOT}/plugins/cache/tokenplan-usage-hud/tokenplan-usage-hud"
CACHE_BASES=("$CACHE_BASE" "$LEGACY_CACHE_BASE")

# Version dir name: at least 3 dot-separated components (e.g. 0.2.7),
# at most 4 (e.g. 0.2.7.1 for prereleases). Anything with fewer than
# 3 components is treated as decoy and skipped — a 2-component name
# like "1.2" is not a valid plugin version and the user almost
# certainly meant a non-version dir. Reject anything else (including
# `..`, `.`, hidden dirs, names with letters).
VERSION_RE='^[0-9]+\.[0-9]+\.[0-9]+(\.[0-9]+)?$'

# Build the sorted-by-version list of version dirs across ALL
# CACHE_BASES. Each entry is a "<cache_base>\t<version>" pair so
# the keep/newest selection can disambiguate when the same version
# string appears under two roots. We then emit a list of
# <full_path>\t<basename> rows, one per version dir found under any
# of the CACHE_BASES.
ANY_FOUND=0
SORTED_ROWS=()
for BASE in "${CACHE_BASES[@]}"; do
  if [ ! -d "$BASE" ]; then continue; fi
  ANY_FOUND=1
  shopt -s nullglob
  while IFS= read -r row; do
    [ -z "$row" ] && continue
    SORTED_ROWS+=("$row")
  done < <(
    ls -1d "${BASE}/"*/ 2>/dev/null \
      | awk -F/ '{ n=$(NF-1); if (n ~ /^[0-9]+\.[0-9]+\.[0-9]+(\.[0-9]+)?$/) print n "\t" $0 }' \
      | sort -t. -k1,1n -k2,2n -k3,3n -k4,4n
  )
  shopt -u nullglob
done
if [ "$ANY_FOUND" = 0 ]; then
  echo "clean-cache.sh: no cache dir at ${CACHE_BASES[*]}; nothing to clean"
  exit 0
fi
if [ "${#SORTED_ROWS[@]}" -le 1 ]; then
  echo "clean-cache.sh: nothing to clean — at most one version dir present"
  exit 0
fi

# Newest is the last row. Everything before is a removal target.
# We use a unique-keyed dedupe so the same path appearing under two
# CACHE_BASES (rare; only happens when legacy and new roots collide)
# is only listed once.
NEWEST_ROW="${SORTED_ROWS[${#SORTED_ROWS[@]}-1]}"
NEWEST_VERSION="${NEWEST_ROW%%	*}"
NEWEST_PATH="${NEWEST_ROW#*	}"
echo "clean-cache.sh: plan"
echo "  keep:    ${NEWEST_PATH}  (version ${NEWEST_VERSION})"
echo "  remove:"

REMOVE_LIST=()
SEEN=()
for row in "${SORTED_ROWS[@]:0:${#SORTED_ROWS[@]}-1}"; do
  path="${row#*	}"
  # Skip if this is the same path as the one we just kept (covers
  # the dual-root case where the newest version appears under
  # both legacy and new cache roots).
  if [ "$path" = "$NEWEST_PATH" ]; then continue; fi
  # Dedupe across CACHE_BASES.
  for s in "${SEEN[@]}"; do
    if [ "$s" = "$path" ]; then continue 2; fi
  done
  SEEN+=("$path")
  REMOVE_LIST+=("$path")
  echo "    rm -rf ${path}"
done

if [ "$DRY_RUN" = 1 ]; then
  echo "clean-cache.sh: --dry-run, no changes made"
  exit 0
fi

# Apply: wipe each stale version dir. Defensive belt-and-suspenders:
#   1. Re-check VERSION_RE on the basename (in case the glob returned
#      something unexpected).
#   2. Never operate on the newest version (would break the wrapper).
#   3. `rm -rf` only — no destructive actions on the parent cache dir.
for path in "${REMOVE_LIST[@]}"; do
  base=$(basename "$path")
  if [[ ! "$base" =~ $VERSION_RE ]]; then
    echo "clean-cache.sh: refusing to remove non-version path: $path" >&2
    continue
  fi
  if [ "$path" = "$NEWEST_PATH" ]; then
    echo "clean-cache.sh: refusing to remove newest version: $path" >&2
    continue
  fi
  rm -rf "$path"
  echo "clean-cache.sh: removed ${path}"
done

# If this script was run from a dir that we just removed, SCRIPT_DIR
# is now dangling. That's expected and harmless — the script has
# already finished its work, and any future call from a NEW install
# resolves a fresh path.
if [ -n "${SCRIPT_DIR:-}" ] && [ ! -d "$SCRIPT_DIR" ]; then
  echo "clean-cache.sh: note — this script's own dir was removed (${SCRIPT_DIR}). Re-install to recover."
fi

echo "clean-cache.sh: done"
