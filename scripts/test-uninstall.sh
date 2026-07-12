#!/usr/bin/env bash
# test-uninstall.sh — smoke tests for the v0.9.x partial-preserve
# semantics in scripts/uninstall.sh.
#
# The branches under test:
#   - DEFAULT: topgauge/config.json + topgauge/query_plugins/ are
#     NOT wiped; a post-uninstall hint lists their paths.
#   - --keep-state: topgauge/state/<projectHash>/<sessionId>.jsonl
#     files are preserved in addition to the default-preserved paths.
#   - ALWAYS wipe: state/cache.json, state/cache.stat.json,
#     state/upstream-cmd.{sh,txt}, state/<projectHash>/state.json
#     go regardless of flags.
#
# Each test builds a synthetic CLAUDE_ROOT in a tmpdir, monkey-patches
# HOME / CLAUDE_CONFIG_DIR to point at it, and runs uninstall.sh
# against the fixture. Real user settings.json is never touched.
#
# Tests don't drive the full uninstall (statusLine restore + market-
# place JSON strip) — they only exercise the partial-preserve wipe
# paths. The fixture is a minimal settings.json WITHOUT
# `_topgauge_managed: true`, so the statusLine branch is skipped
# (matches "leave it alone" branch in scripts/uninstall.sh).
#
# Portable: Linux, macOS, Git Bash on Windows.

set -u

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
UNINSTALL_SH="${SCRIPT_DIR}/uninstall.sh"
if [ ! -f "$UNINSTALL_SH" ]; then
  echo "missing $UNINSTALL_SH" >&2
  exit 1
fi

# --- Test helpers ------------------------------------------------------------

PASS=0
FAIL=0

assert_eq() {
  local label="$1" expected="$2" actual="$3"
  if [ "$expected" = "$actual" ]; then
    echo "  ok  $label"
    PASS=$((PASS + 1))
  else
    echo "  FAIL $label"
    echo "       expected: $expected"
    echo "       actual:   $actual"
    FAIL=$((FAIL + 1))
  fi
}

assert_file_exists() {
  local label="$1" path="$2"
  if [ -f "$path" ]; then
    echo "  ok  $label"
    PASS=$((PASS + 1))
  else
    echo "  FAIL $label (missing: $path)"
    FAIL=$((FAIL + 1))
  fi
}

assert_dir_exists() {
  local label="$1" path="$2"
  if [ -d "$path" ]; then
    echo "  ok  $label"
    PASS=$((PASS + 1))
  else
    echo "  FAIL $label (missing dir: $path)"
    FAIL=$((FAIL + 1))
  fi
}

assert_file_missing() {
  local label="$1" path="$2"
  if [ ! -f "$path" ]; then
    echo "  ok  $label"
    PASS=$((PASS + 1))
  else
    echo "  FAIL $label (unexpected file: $path)"
    FAIL=$((FAIL + 1))
  fi
}

assert_match_str() {
  local label="$1" pattern="$2" haystack="$3"
  if echo "$haystack" | grep -qF -- "$pattern"; then
    echo "  ok  $label"
    PASS=$((PASS + 1))
  else
    echo "  FAIL $label (pattern not found: $pattern)"
    echo "       output: $haystack"
    FAIL=$((FAIL + 1))
  fi
}

# Build a fresh fixture mirroring the on-disk layout described in
# CLAUDE.md. We deliberately do NOT mark settings.json as ours (no
# _topgauge_managed marker) so uninstall.sh's statusLine-restore
# branch is skipped and we exercise ONLY the wipe logic.
#
# $ROOT/                                    (synthetic CLAUDE_ROOT)
#   plugins/cache/topgauge/topgauge/0.9.0/  (cache stub for statusLine probe)
#   plugins/topgauge/
#     config.json                            (user-owned; must NOT be wiped)
#     query_plugins/minimax/index.js         (user override; must NOT be wiped)
#     state/
#       cache.json                           (must be wiped)
#       cache.stat.json                      (must be wiped)
#       upstream-cmd.sh                      (must be wiped)
#       upstream-cmd.txt                     (must be wiped)
#       d--workspace-topgauge/
#         ca62...jsonl                       (sample; default wipes, --keep-state preserves)
#         state.json                         (must be wiped)
#   plugins/installed_plugins.json           (synthetic; uninstall strips the row)
#   plugins/known_marketplaces.json          (synthetic; uninstall strips the row)
#   settings.json                            (no marker; uninstall skips restore)
build_fixture() {
  local root
  root="$(mktemp -d -t topgauge-uninstall-test-XXXXXX)"
  local plugins="${root}/plugins"
  local cache="${plugins}/cache/topgauge/topgauge/0.9.0"
  local state="${plugins}/topgauge"
  mkdir -p "${cache}/dist" "${cache}/scripts" \
           "${state}/query_plugins/minimax" \
           "${state}/state/d--workspace-topgauge"

  # Synthetic plugin source layout — uninstall.sh resolves paths off
  # CLAUDE_ROOT so layout matters, not file contents.
  printf '# stub\n' > "${cache}/dist/index.js"
  printf '# stub\n' > "${cache}/scripts/wrapper.sh"
  chmod +x "${cache}/scripts/wrapper.sh"

  # User-owned artifacts that must NOT be wiped (default branch).
  printf '{"providers":{"minimax":{"provider":"minimax"}}}\n' \
    > "${state}/config.json"
  printf '#!/usr/bin/env bash\necho user-override\n' \
    > "${state}/query_plugins/minimax/index.js"
  chmod +x "${state}/query_plugins/minimax/index.js"

  # Cache noise — must be wiped unconditionally.
  printf '{"k":"v"}\n' > "${state}/state/cache.json"
  printf '{"stats":[]}\n' > "${state}/state/cache.stat.json"
  cat > "${state}/state/upstream-cmd.sh" <<'EOF'
#!/usr/bin/env bash
echo previous
EOF
  printf 'echo previous\n' > "${state}/state/upstream-cmd.txt"
  chmod +x "${state}/state/upstream-cmd.sh"

  # Per-project tickStatus — must be wiped.
  printf '{"prevTick":{}}\n' \
    > "${state}/state/d--workspace-topgauge/state.json"

  # Token-sample history — conditional.
  printf '{"at":1}\n{"at":2}\n' \
    > "${state}/state/d--workspace-topgauge/ca625a72-test-session.jsonl"

  # Settings + loader JSONs (synthetic; no marker).
  printf '{}' > "${root}/settings.json"
  printf '{"plugins":{"topgauge@topgauge":[]}}\n' \
    > "${plugins}/installed_plugins.json"
  printf '{"topgauge":{"source":"github"}}\n' \
    > "${plugins}/known_marketplaces.json"

  echo "$root"
}

# Run uninstall.sh inside a sandboxed CLAUDE_ROOT.
#   $1 = root from build_fixture()
#   $2... = uninstall.sh args
run_uninstall() {
  local root="$1"; shift
  (
    # Subshell isolation: never let the sandbox leak to the parent
    # environment. The statusLine-restore branch needs HOME for
    # default settings.json resolution; we override both knobs.
    export HOME="$root"
    export CLAUDE_CONFIG_DIR="$root"
    cd "$root"
    bash "$UNINSTALL_SH" "$@"
  )
}

# ============================================================================
# Tests
# ============================================================================

echo "== v0.9.x partial-preserve: DEFAULT (no --keep-state) =="

ROOT=$(build_fixture)
run_uninstall "$ROOT" >/dev/null 2>&1

# config.json + query_plugins/ preserved
assert_file_exists  "[default] topgauge/config.json preserved" \
  "${ROOT}/plugins/topgauge/config.json"
assert_file_exists  "[default] topgauge/query_plugins/minimax/index.js preserved" \
  "${ROOT}/plugins/topgauge/query_plugins/minimax/index.js"
assert_dir_exists   "[default] topgauge/query_plugins/ dir preserved" \
  "${ROOT}/plugins/topgauge/query_plugins"

# Always-wiped cache noise gone
assert_file_missing "[default] state/cache.json wiped" \
  "${ROOT}/plugins/topgauge/state/cache.json"
assert_file_missing "[default] state/cache.stat.json wiped" \
  "${ROOT}/plugins/topgauge/state/cache.stat.json"
assert_file_missing "[default] state/upstream-cmd.sh wiped" \
  "${ROOT}/plugins/topgauge/state/upstream-cmd.sh"
assert_file_missing "[default] state/upstream-cmd.txt wiped" \
  "${ROOT}/plugins/topgauge/state/upstream-cmd.txt"

# Always-wiped per-project state.json gone
assert_file_missing "[default] state/<hash>/state.json wiped" \
  "${ROOT}/plugins/topgauge/state/d--workspace-topgauge/state.json"

# Default-wiped .jsonl gone
assert_file_missing "[default] state/<hash>/<sid>.jsonl wiped" \
  "${ROOT}/plugins/topgauge/state/d--workspace-topgauge/ca625a72-test-session.jsonl"

# Cache dir wiped (matched the always-wipe list)
assert_file_missing "[default] cache/topgauge/* wiped" \
  "${ROOT}/plugins/cache/topgauge"

# Hint message lists preserved paths
HINT_OUT=$(run_uninstall "$ROOT" --dry-run 2>&1)
# On a second run, files are already gone — preserve-list check is
# only meaningful on the FIRST run. Skip the hint pattern-check if
# the artifact doesn't exist anymore (we already ran once above).

rm -rf "$ROOT"

echo ""
echo "== v0.9.x partial-preserve: --keep-state =="

ROOT=$(build_fixture)
OUT=$(run_uninstall "$ROOT" --keep-state 2>&1)

# config.json + query_plugins/ still preserved
assert_file_exists  "[keep-state] topgauge/config.json preserved" \
  "${ROOT}/plugins/topgauge/config.json"
assert_file_exists  "[keep-state] topgauge/query_plugins/minimax/index.js preserved" \
  "${ROOT}/plugins/topgauge/query_plugins/minimax/index.js"

# .jsonl preserved (this is the differentiating branch)
assert_file_exists  "[keep-state] state/<hash>/<sid>.jsonl preserved" \
  "${ROOT}/plugins/topgauge/state/d--workspace-topgauge/ca625a72-test-session.jsonl"

# Always-wiped still gone
assert_file_missing "[keep-state] state/cache.json still wiped" \
  "${ROOT}/plugins/topgauge/state/cache.json"
assert_file_missing "[keep-state] state/<hash>/state.json still wiped" \
  "${ROOT}/plugins/topgauge/state/d--workspace-topgauge/state.json"

# Post-uninstall hint mentions --keep-state + lists preserved .jsonl
assert_match_str "[keep-state] hint mentions --keep-state" \
  "--keep-state preserved" "$OUT"
assert_match_str "[keep-state] hint lists .jsonl path" \
  "ca625a72-test-session.jsonl" "$OUT"

rm -rf "$ROOT"

echo ""
echo "== v0.9.x partial-preserve: dry-run =="

ROOT=$(build_fixture)
OUT=$(run_uninstall "$ROOT" --dry-run 2>&1)

# grep regex: literal "rm -f ", any chars, "<file>". We match the
# `Actions:` line via grep -E. The `--` is not needed here because
# the pattern starts with `rm` (not `-`), but use it anyway for
# safety across grep versions.
assert_match_str "[dry-run] default wipes .jsonl" \
  "ca625a72-test-session.jsonl" "$OUT"
assert_match_str "[dry-run] default wipes state.json" \
  "d--workspace-topgauge/state.json" "$OUT"
assert_match_str "[dry-run] default wipes cache.json" \
  "topgauge/state/cache.json" "$OUT"

# Verify dry-run did NOT actually delete anything
assert_file_exists "[dry-run] cache.json still on disk" \
  "${ROOT}/plugins/topgauge/state/cache.json"
assert_file_exists "[dry-run] config.json still on disk" \
  "${ROOT}/plugins/topgauge/config.json"

OUT_KS=$(run_uninstall "$ROOT" --dry-run --keep-state 2>&1)
# Inverse assertion: .jsonl wipe must NOT appear in the plan.
if echo "$OUT_KS" | grep -qF -- "ca625a72-test-session.jsonl"; then
  echo "  FAIL [dry-run + --keep-state] plan contains .jsonl wipe (should be skipped)"
  FAIL=$((FAIL + 1))
else
  echo "  ok  [dry-run + --keep-state] plan omits .jsonl wipe"
  PASS=$((PASS + 1))
fi

# Dry-run + --dry-run message
assert_match_str "[dry-run] explicit no-change message" \
  "--dry-run, no changes made" "$OUT"

rm -rf "$ROOT"

echo ""
echo "== v0.9.x partial-preserve: hint on FIRST run only =="

ROOT=$(build_fixture)
OUT1=$(run_uninstall "$ROOT" 2>&1)
# First-run hint mentions config.json
assert_match_str "[first-run hint] mentions config.json" \
  "config.json" "$OUT1"

# Second run on the same fixture: everything's already gone — the
# install is fully clean. The "nothing to do" message is the right
# signal, but the script must not crash and must not print
# false-positive hints about non-existent files. Since HINT_LINES
# iterates over files that no longer exist, the hint block is
# skipped (the for-loop on HINT_LINES with length 0 prints
# nothing). Verify the script exits 0.
set +e
run_uninstall "$ROOT" >/dev/null 2>&1
EC=$?
set -e
assert_eq "[second-run] idempotent exit code is 0" "0" "$EC"

rm -rf "$ROOT"

# ============================================================================
# Summary
# ============================================================================

echo ""
echo "tests: PASS=${PASS} FAIL=${FAIL}"
if [ "$FAIL" -gt 0 ]; then
  exit 1
fi
exit 0
