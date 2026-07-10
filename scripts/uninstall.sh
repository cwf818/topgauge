#!/usr/bin/env bash
# uninstall.sh — full uninstall of topgauge-cc (ToPGauge-CC).
#
# Self-contained: works even if the plugin cache has been partially or
# fully wiped (e.g. after `npm run dev:uninstall`, or any manual
# `rm -rf`). Uses only bash + node (for safe JSON edits) + standard
# Unix tools. No network access. Never reads ANTHROPIC_AUTH_TOKEN.
#
# Behavior:
#   1. Restores settings.json.statusLine to the user's pre-topgauge
#      state. Strategy:
#        a. If statusLine._topgauge_managed === true AND
#           ${CLAUDE_ROOT}/plugins/topgauge-cc/state/upstream-cmd.txt
#           exists, restore from that file (the original install.sh
#           --uninstall behavior, byte-for-byte). This is the STABLE
#           state location (sibling of config.json) as of v0.2.19; it
#           survives cache wipes, so this case covers the common
#           post-upgrade uninstall.
#        a'. (Legacy fallback for v0.2.18 and older) If the stable
#           state dir has no upstream-cmd.txt but any installed cache
#           version dir has one under <version>/state/, prefer the
#           NEWEST available legacy state file. This handles users
#           who installed v0.2.18, never re-ran :install on v0.2.19,
#           and now want to uninstall.
#        b. Else if statusLine._topgauge_managed === true, fall back
#           to the most recent settings.json.bak.<ts> in the same
#           dir whose statusLine does NOT have _topgauge_managed
#           (the state before the plugin was installed).
#        c. Else: statusLine is not ours, leave it alone.
#   2. Removes "topgauge-cc@topgauge-cc" from
#      settings.json.enabledPlugins (if present), preserving CRLF.
#   3. Backs up settings.json to settings.json.bak.<TS> before any
#      destructive change.
#   4. Wipes:
#        - cache/topgauge-cc/
#        - marketplaces/topgauge-cc/
#        - marketplaces/cwf818-topgauge-cc/   (legacy alias)
#        - plugins/topgauge-cc/state/         (our stable state dir;
#                                              clean slate so a future
#                                              re-install doesn't see a
#                                              stale upstream-cmd.txt
#                                              pointing at a now-foreign
#                                              command)
#                                              v0.4.x+ Per-Project
#                                              Layout: this includes
#                                              state/<projectHash>/{cache.json,
#                                              diagnostics.jsonl,
#                                              <sessionId>.jsonl}.
#                                              To PRESERVE token-sample
#                                              history across uninstall
#                                              (rare; samples decay over
#                                              time anyway), run
#                                              `scripts/migrate-state.sh`
#                                              first, then re-install
#                                              without uninstalling.
#   5. Strips the plugin row from installed_plugins.json and
#      known_marketplaces.json (with timestamped .bak.<TS> backups),
#      preserving CRLF.
#   6. Strips `extraKnownMarketplaces.topgauge-cc` from
#      settings.json (Claude Code records the marketplace source there
#      too — leaving it would re-add the marketplace on next
#      /plugin marketplace add with no visible diff).
#
# v0.7.0 — legacy dual-strip: also recognizes the OLD plugin name
# `tokenplan-usage-hud` (cache dir, marketplace alias, enabledPlugins
# key, extraKnownMarketplaces key, state dir) so users upgrading from
# v0.6.x can still uninstall cleanly. The dual-strip is per-file:
# we look up BOTH keys against the same JSON files and wipe both
# directory trees if present. Kept for at least one release.
#
# Idempotency: every step is independently no-op-able. Re-running on
# a fully clean system prints a "nothing to do" message and exits 0.
#
# Usage:
#   uninstall.sh                  # user-level (default)
#   uninstall.sh --project        # project-level (cwd's .claude/settings.json)
#   uninstall.sh --dry-run        # print actions, change nothing
#   uninstall.sh -h | --help
#
# Portable: Linux, macOS, Git Bash on Windows.

set -u

PROJECT_LEVEL=0
DRY_RUN=0

print_help() {
  sed -n '2,46p' "$0"
}

for arg in "$@"; do
  case "$arg" in
    --project) PROJECT_LEVEL=1 ;;
    --dry-run) DRY_RUN=1 ;;
    -h|--help)
      print_help
      exit 0
      ;;
    *)
      echo "uninstall.sh: unknown argument: $arg" >&2
      echo "  usage: uninstall.sh [--project] [--dry-run]" >&2
      exit 2
      ;;
  esac
done

CLAUDE_ROOT="${CLAUDE_CONFIG_DIR:-$HOME/.claude}"
PLUGINS_DIR="${CLAUDE_ROOT}/plugins"
# v0.7.0 — dual-name arrays. The NEW name (`topgauge-cc`) is the
# canonical install; the LEGACY name (`tokenplan-usage-hud`) is
# included for one release so upgrading users can still uninstall.
# All subsequent loops iterate over both names in parallel.
PLUGIN_NAMES=("topgauge-cc" "tokenplan-usage-hud")

# Build the parallel arrays of paths we will touch, one entry per
# PLUGIN_NAMES slot. We don't use a single big `${N[@]}` indexing
# because some operations need only the dir, others need the JSON key.
ALL_CACHE_DIRS=()
ALL_MARKETPLACE_DIRS=()
ALL_TMP_MARKETPLACE_DIRS=()
ALL_STATE_DIRS=()
ALL_QUERY_PLUGINS_DIRS=()
for n in "${PLUGIN_NAMES[@]}"; do
  ALL_CACHE_DIRS+=("${PLUGINS_DIR}/cache/${n}")
  ALL_MARKETPLACE_DIRS+=("${PLUGINS_DIR}/marketplaces/${n}")
  ALL_TMP_MARKETPLACE_DIRS+=("${PLUGINS_DIR}/marketplaces/cwf818-${n}")
  ALL_STATE_DIRS+=("${PLUGINS_DIR}/${n}/state")
  # vX.X.X+ — query_plugins drop-in dir, sibling of state/ and
  # config.json. Wiped on uninstall so a re-install slate is clean
  # (a stale plugin script from an older version is the kind of
  # thing the user should consciously re-author). Legacy name not
  # included — the pre-rename install never created a
  # query_plugins/ tree.
  if [ "$n" = "topgauge-cc" ]; then
    ALL_QUERY_PLUGINS_DIRS+=("${PLUGINS_DIR}/${n}/query_plugins")
  fi
done

INSTALLED_JSON="${PLUGINS_DIR}/installed_plugins.json"
KNOWN_JSON="${PLUGINS_DIR}/known_marketplaces.json"
# Both versions of the plugin key — we strip whichever is present.
SETTINGS_PLUGIN_KEYS=("topgauge-cc@topgauge-cc" "tokenplan-usage-hud@tokenplan-usage-hud")
# Both versions of the marketplace source key — strip whichever is in
# known_marketplaces.json / extraKnownMarketplaces.
MARKETPLACE_KEYS=("topgauge-cc" "tokenplan-usage-hud")

# Resolve SCRIPT_DIR ONCE, at the top, before any rm -rf. Later in this
# script we wipe CACHE_DIR (the very directory this file lives in) — if
# we re-resolve SCRIPT_DIR after the wipe, the `cd "$(dirname "$0")"`
# fails with "No such file or directory" because the path no longer
# exists. The cached value still lets us locate clean.sh if it's
# somewhere else (rare but possible — e.g. when uninstall.sh is run
# from a copy outside the cache). If the directory is gone, the
# clean.sh invocation is silently skipped (clean is a nice-to-have,
# not a correctness requirement).
SCRIPT_DIR="$(cd "$(dirname "$0")" 2>/dev/null && pwd || true)"

# --- Resolve settings target --------------------------------------------------
if [ "$PROJECT_LEVEL" = 1 ]; then
  TARGET=".claude/settings.json"
else
  TARGET="${CLAUDE_ROOT}/settings.json"
fi

# --- Plan: enumerate actions, then run --------------------------------------

TS=$(date +%Y%m%dT%H%M%S)
ACTIONS=()
DRY_NOTHING=1  # becomes 0 if at least one planned action is meaningful

# Action 1: restore statusLine (only if our marker is set)
SL_PLAN=""
if [ -f "$TARGET" ]; then
  # Read the marker in pure bash via node (mirrors the install.sh
  # edit-settings.mjs status op, but inlined so we don't depend on
  # the cache being present).
  WIN_TARGET=""
  if command -v cygpath >/dev/null 2>&1; then
    WIN_TARGET=$(cygpath -w "$TARGET" 2>/dev/null || echo "$TARGET")
  else
    WIN_TARGET="$TARGET"
  fi
  # The marker is not enough: another plugin or a human may have
  # overwritten statusLine.command after install. Trust the command
  # shape (cache path + wrapper.sh suffix), not just the marker.
  # See scripts/lib/edit-settings.mjs#isOurWrapperCommand for the
  # matching logic — duplicated here only because we cannot easily
  # `require` an mjs from inside a node -e heredoc.
  #
  # v0.7.0 — also accept the LEGACY name (`tokenplan-usage-hud`) so a
  # user upgrading from a pre-rename install can still uninstall. The
  # statusLine check accepts both names; the restore-from-bak / warning
  # branches below do not need renaming because they restore a prior
  # user state, which doesn't reference any plugin name.
  MANAGED=$(node -e '
    const fs = require("fs");
    const p = process.argv[1];
    const isOurs = (cmd) => {
      if (typeof cmd !== "string" || cmd.length === 0) return false;
      // v0.7.0 — accept BOTH old and new plugin name in the cache
      // path (legacy dual-strip). The marker may also be either name
      // for the same reason.
      const reNew = /plugins[\/\\]cache[\/\\]topgauge-cc[\/\\]topgauge-cc[\/\\]/;
      const reOld = /plugins[\/\\]cache[\/\\]tokenplan-usage-hud[\/\\]tokenplan-usage-hud[\/\\]/;
      return (reNew.test(cmd) || reOld.test(cmd)) && /wrapper\.sh"\x27\s*$/.test(cmd);
    };
    try {
      const d = JSON.parse(fs.readFileSync(p, "utf8"));
      const sl = d && d.statusLine;
      const m = sl && (sl._topgauge_managed === true || sl._tokenplan_managed === true) && isOurs(sl.command);
      process.stdout.write(m ? "1" : "0");
    } catch (e) { process.stdout.write("0"); }
  ' "$WIN_TARGET" 2>/dev/null || echo "0")
  if [ "$MANAGED" = "1" ]; then
    # Find the upstream-cmd.txt to restore from. Priority:
    #   1. The NEW stable state dir (v0.7.0+): sibling of config.json,
    #      survives cache wipes.
    #   2. The LEGACY stable state dir (v0.2.19–v0.6.x): the user
    #      installed the old name and we want to still find it.
    #   3. Any installed cache version's state/upstream-cmd.txt
    #      (legacy v0.2.18 and older). Pick the NEWEST version's file
    #      that exists — same ordering the statusLine wrapper uses.
    #   4. Most recent pre-managed settings.json.bak.<ts>.
    UPSTREAM_TXT=""
    if [ -f "${ALL_STATE_DIRS[0]}/upstream-cmd.txt" ]; then
      UPSTREAM_TXT="${ALL_STATE_DIRS[0]}/upstream-cmd.txt"
    elif [ -f "${ALL_STATE_DIRS[1]}/upstream-cmd.txt" ]; then
      UPSTREAM_TXT="${ALL_STATE_DIRS[1]}/upstream-cmd.txt"
    elif [ -d "${ALL_CACHE_DIRS[0]}" ] || [ -d "${ALL_CACHE_DIRS[1]}" ]; then
      # Search both legacy and current cache trees for any version
      # dir with a preserved upstream-cmd.txt. Take the highest-
      # version match across both roots.
      SELF_DIR=$( (
        ls -d "${ALL_CACHE_DIRS[0]}"/*/ 2>/dev/null
        ls -d "${ALL_CACHE_DIRS[1]}"/*/ 2>/dev/null
      ) | awk -F/ '{ print $(NF-1) "\t" $(0) }' \
        | sort -t. -k1,1n -k2,2n -k3,3n -k4,4n \
        | tail -1 | cut -f2-)
      if [ -n "$SELF_DIR" ] && [ -f "${SELF_DIR%/}/state/upstream-cmd.txt" ]; then
        UPSTREAM_TXT="${SELF_DIR%/}/state/upstream-cmd.txt"
      fi
    fi
    if [ -n "$UPSTREAM_TXT" ]; then
      SL_PLAN="restore-from-file:${UPSTREAM_TXT}"
    else
      # Fall back: most recent .bak.<ts> whose statusLine is NOT managed
      BAK=""
      for f in $(ls -t "${TARGET}.bak."* 2>/dev/null); do
        if [ -z "$f" ]; then continue; fi
        BWIN=""
        if command -v cygpath >/dev/null 2>&1; then
          BWIN=$(cygpath -w "$f" 2>/dev/null || echo "$f")
        else
          BWIN="$f"
        fi
        M=$(node -e '
          const fs = require("fs");
          try {
            const d = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
            const sl = d && d.statusLine;
            // Accept EITHER marker name — same dual-strip as the
            // primary check above. A backup file from a pre-rename
            // install still uses _tokenplan_managed; the post-rename
            // form uses _topgauge_managed.
            const m = sl && (sl._topgauge_managed === true || sl._tokenplan_managed === true);
            process.stdout.write(m ? "1" : "0");
          } catch (e) { process.stdout.write("0"); }
        ' "$BWIN" 2>/dev/null || echo "0")
        if [ "$M" = "0" ]; then
          BAK="$f"
          break
        fi
      done
      if [ -n "$BAK" ]; then
        SL_PLAN="restore-from-bak:${BAK}"
      else
        SL_PLAN="warning:no-restore-source"
      fi
    fi
  fi
fi
if [ -n "$SL_PLAN" ]; then
  ACTIONS+=("statusLine: ${SL_PLAN}")
  DRY_NOTHING=0
fi

# Action 2: strip enabledPlugins row (if present) — accepts both
# key shapes (legacy + new).
EP_PLAN=""
if [ -f "$TARGET" ]; then
  for KEY in "${SETTINGS_PLUGIN_KEYS[@]}"; do
    HAS_ROW=$(node -e '
      const fs = require("fs");
      try {
        const d = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
        const k = process.argv[2];
        process.stdout.write(d.enabledPlugins && Object.prototype.hasOwnProperty.call(d.enabledPlugins, k) ? "1" : "0");
      } catch (e) { process.stdout.write("0"); }
    ' "$WIN_TARGET" "$KEY" 2>/dev/null || echo "0")
    if [ "$HAS_ROW" = "1" ]; then
      EP_PLAN="${EP_PLAN:+${EP_PLAN}, }${KEY}"
      DRY_NOTHING=0
    fi
  done
fi
if [ -n "$EP_PLAN" ]; then
  ACTIONS+=("enabledPlugins: strip ${EP_PLAN}")
fi

# Action 2b: strip extraKnownMarketplaces.<key> for both old + new keys.
# Claude Code records the marketplace source under both known_marketplaces.json
# AND settings.json.extraKnownMarketplaces (the latter is what shows up in
# `claude plugin marketplace list`). Leaving it would re-add the marketplace
# on next `/plugin marketplace add` with no visible diff.
EKM_PLAN=""
if [ -f "$TARGET" ]; then
  for KEY in "${MARKETPLACE_KEYS[@]}"; do
    HAS_ROW=$(node -e '
      const fs = require("fs");
      try {
        const d = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
        const k = process.argv[2];
        process.stdout.write(d.extraKnownMarketplaces && Object.prototype.hasOwnProperty.call(d.extraKnownMarketplaces, k) ? "1" : "0");
      } catch (e) { process.stdout.write("0"); }
    ' "$WIN_TARGET" "$KEY" 2>/dev/null || echo "0")
    if [ "$HAS_ROW" = "1" ]; then
      EKM_PLAN="${EKM_PLAN:+${EKM_PLAN}, }${KEY}"
      DRY_NOTHING=0
    fi
  done
fi
if [ -n "$EKM_PLAN" ]; then
  ACTIONS+=("extraKnownMarketplaces: strip ${EKM_PLAN}")
fi

# Action 3: wipe dirs (every name in PLUGIN_NAMES — old AND new)
for d in "${ALL_CACHE_DIRS[@]}" "${ALL_MARKETPLACE_DIRS[@]}" "${ALL_TMP_MARKETPLACE_DIRS[@]}" "${ALL_STATE_DIRS[@]}" "${ALL_QUERY_PLUGINS_DIRS[@]}"; do
  if [ -d "$d" ]; then
    ACTIONS+=("rm -rf ${d}")
    DRY_NOTHING=0
  fi
done

# Action 4: strip JSON rows (both keys)
for j in "$INSTALLED_JSON" "$KNOWN_JSON"; do
  if [ -f "$j" ]; then
    # Use node to detect, not grep, so we don't false-positive on
    # substrings that happen to appear in other fields (e.g. the
    # projectPath of THIS project, "D:\WorkSpace\tokenplan-usage-hud",
    # which is a legit project path other plugins reference).
    ANY_FOUND=0
    for KEY in "${MARKETPLACE_KEYS[@]}"; do
      if [ "$j" = "$INSTALLED_JSON" ]; then
        HAS_ROW=$(node -e '
          const fs = require("fs");
          try {
            const d = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
            const k = process.argv[2];
            process.stdout.write(d.plugins && Object.prototype.hasOwnProperty.call(d.plugins, k) ? "1" : "0");
          } catch (e) { process.stdout.write("0"); }
        ' "$(cygpath -w "$j" 2>/dev/null || echo "$j")" "${KEY}@${KEY}" 2>/dev/null || echo "0")
      else
        HAS_ROW=$(node -e '
          const fs = require("fs");
          try {
            const d = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
            const k = process.argv[2];
            process.stdout.write(Object.prototype.hasOwnProperty.call(d, k) ? "1" : "0");
          } catch (e) { process.stdout.write("0"); }
        ' "$(cygpath -w "$j" 2>/dev/null || echo "$j")" "$KEY" 2>/dev/null || echo "0")
      fi
      if [ "$HAS_ROW" = "1" ]; then ANY_FOUND=1; fi
    done
    if [ "$ANY_FOUND" = "1" ]; then
      ACTIONS+=("strip row(s) from $j")
      DRY_NOTHING=0
    fi
  fi
done

# --- Print plan --------------------------------------------------------------
if [ "$DRY_NOTHING" = 1 ]; then
  echo "uninstall.sh: nothing to do — topgauge-cc is not installed"
  exit 0
fi

echo "uninstall.sh: plan"
for a in "${ACTIONS[@]}"; do
  echo "  $a"
done

if [ "$DRY_RUN" = 1 ]; then
  echo "uninstall.sh: --dry-run, no changes made"
  exit 0
fi

# --- Backup settings.json before any destructive change ----------------------
# Only back up if a settings-changing action is in the plan. Re-running
# on a clean system should not pile up empty .bak files.
NEEDS_SETTINGS_BACKUP=0
for a in "${ACTIONS[@]}"; do
  case "$a" in
    "statusLine: "*) NEEDS_SETTINGS_BACKUP=1 ;;
    "enabledPlugins: "*) NEEDS_SETTINGS_BACKUP=1 ;;
    "extraKnownMarketplaces: "*) NEEDS_SETTINGS_BACKUP=1 ;;
  esac
done
if [ "$NEEDS_SETTINGS_BACKUP" = 1 ] && [ -f "$TARGET" ]; then
  cp "$TARGET" "${TARGET}.bak.${TS}"
  echo "uninstall.sh: backup ${TARGET} -> ${TARGET}.bak.${TS}"
fi

# --- Apply: statusLine restore -----------------------------------------------
if [ -n "$SL_PLAN" ]; then
  case "$SL_PLAN" in
    restore-from-file:*)
      SRC="${SL_PLAN#restore-from-file:}"
      # Inline the restore-from-file op (mirrors edit-settings.mjs).
      # Hardened: only restore if the CURRENT command is actually ours.
      # If marker is set but command is foreign (another plugin / human
      # overwrote it), we still want to wipe the cache dirs, but the
      # statusLine is the user's now — don't touch it.
      node -e '
        const fs = require("fs");
        const target = process.argv[1];
        const src = process.argv[2];
        const original = fs.readFileSync(src, "utf8").trim();
        // Same fingerprint as the planning step above. Use a runtime
        // regex (matching `[\/\\]` for the separator) so single-backslash
        // Windows paths match — a String.includes needle built from
        // "[/\\\\]" requires 4 backslashes between segments and silently
        // misses every real Windows path. (Earlier buggy form, kept the
        // isOurs name for symmetry.)
        //
        // v0.7.0 — accept BOTH old and new plugin name (legacy
        // dual-strip). The marker check also accepts either name.
        const isOurs = (cmd) => {
          if (typeof cmd !== "string" || cmd.length === 0) return false;
          const reNew = /plugins[\/\\]cache[\/\\]topgauge-cc[\/\\]topgauge-cc[\/\\]/;
          const reOld = /plugins[\/\\]cache[\/\\]tokenplan-usage-hud[\/\\]tokenplan-usage-hud[\/\\]/;
          return (reNew.test(cmd) || reOld.test(cmd)) && /wrapper\.sh"\x27\s*$/.test(cmd);
        };
        const data = JSON.parse(fs.readFileSync(target, "utf8"));
        if (data.statusLine && isOurs(data.statusLine.command)) {
          // Mirror write-managed read-modify-write: shallow-copy the
          // CURRENT statusLine (which may carry user-set fields the user
          // added AFTER our install — most notably refreshInterval), then
          // overwrite only the keys we own. The earlier
          // "data.statusLine = {…}" form nuked every other field on
          // uninstall, silently dropping refreshInterval. See commit
          // 89e9e10 (v0.1.23) for the matching install-side fix.
          //
          // v0.7.0 — strip BOTH marker names (dual-strip). The marker
          // a backup file from the OLD name uses was
          // `_tokenplan_managed`; we must drop it too so a subsequent
          // re-install of either name starts clean.
          const next = Object.assign({}, data.statusLine);
          next.type = "command";
          next.command = original;
          delete next._topgauge_managed;
          delete next._tokenplan_managed;
          data.statusLine = next;
        } else if (!data.statusLine) {
          data.statusLine = { type: "command", command: original };
        } else {
          process.stderr.write(
            "uninstall.sh: restore-from-file skipped — current statusLine.command is not the topgauge-cc wrapper\n"
          );
        }
        let eol = "\n";
        const size = fs.statSync(target).size;
        if (size > 0) {
          const fd = fs.openSync(target, "r");
          const head = Buffer.alloc(Math.min(64, size));
          fs.readSync(fd, head, 0, head.length, 0);
          fs.closeSync(fd);
          if (head.includes(0x0d)) eol = "\r\n";
        }
        const body = JSON.stringify(data, null, 2) + "\n";
        fs.writeFileSync(target, body.replace(/\n/g, eol));
      ' "$WIN_TARGET" "$SRC"
      # Best-effort cleanup of the state files (they live in the cache
      # which we wipe below, but doing it here too handles the case
      # where the cache isn't writable for some reason).
      rm -f "${SRC%.txt}.sh" "$SRC" 2>/dev/null || true
      echo "uninstall.sh: restored statusLine from ${SRC}"
      ;;
    restore-from-bak:*)
      BAK="${SL_PLAN#restore-from-bak:}"
      cp "$BAK" "$TARGET"
      echo "uninstall.sh: restored ${TARGET} from ${BAK} (no upstream-cmd.txt available)"
      ;;
    warning:no-restore-source)
      # Last-resort: strip both markers but leave the wrapper as the
      # command. The user will see topgauge still wired up until they
      # manually fix it. Better than blanking statusLine entirely.
      node -e '
        const fs = require("fs");
        const target = process.argv[1];
        const data = JSON.parse(fs.readFileSync(target, "utf8"));
        if (data.statusLine) {
          delete data.statusLine._topgauge_managed;
          delete data.statusLine._tokenplan_managed;
        }
        let eol = "\n";
        const size = fs.statSync(target).size;
        if (size > 0) {
          const fd = fs.openSync(target, "r");
          const head = Buffer.alloc(Math.min(64, size));
          fs.readSync(fd, head, 0, head.length, 0);
          fs.closeSync(fd);
          if (head.includes(0x0d)) eol = "\r\n";
        }
        const body = JSON.stringify(data, null, 2) + "\n";
        fs.writeFileSync(target, body.replace(/\n/g, eol));
      ' "$WIN_TARGET"
      echo "uninstall.sh: WARNING — no upstream-cmd.txt and no pre-managed .bak found" >&2
      echo "uninstall.sh: stripped _topgauge_managed / _tokenplan_managed markers but left the wrapper as statusLine." >&2
      echo "uninstall.sh: manually edit settings.json.statusLine.command to restore your previous statusline." >&2
      ;;
  esac
fi

# --- Apply: enabledPlugins strip --------------------------------------------
# Strip every plugin key we found in the plan (may be both old and new).
if [ -n "$EP_PLAN" ]; then
  IFS=',' read -r -a EP_KEYS <<< "$EP_PLAN"
  for KEY in "${EP_KEYS[@]}"; do
    KEY_TRIMMED=$(echo "$KEY" | sed 's/^[[:space:]]*//;s/[[:space:]]*$//')
    [ -z "$KEY_TRIMMED" ] && continue
    node -e '
      const fs = require("fs");
      const target = process.argv[1];
      const key = process.argv[2];
      const data = JSON.parse(fs.readFileSync(target, "utf8"));
      if (data.enabledPlugins && Object.prototype.hasOwnProperty.call(data.enabledPlugins, key)) {
        delete data.enabledPlugins[key];
      }
      let eol = "\n";
      const size = fs.statSync(target).size;
      if (size > 0) {
        const fd = fs.openSync(target, "r");
        const head = Buffer.alloc(Math.min(64, size));
        fs.readSync(fd, head, 0, head.length, 0);
        fs.closeSync(fd);
        if (head.includes(0x0d)) eol = "\r\n";
      }
      const body = JSON.stringify(data, null, 2) + "\n";
      fs.writeFileSync(target, body.replace(/\n/g, eol));
    ' "$WIN_TARGET" "$KEY_TRIMMED"
    echo "uninstall.sh: removed ${KEY_TRIMMED} from enabledPlugins"
  done
fi

# --- Apply: extraKnownMarketplaces strip ------------------------------------
if [ -n "$EKM_PLAN" ]; then
  IFS=',' read -r -a EKM_KEYS <<< "$EKM_PLAN"
  for KEY in "${EKM_KEYS[@]}"; do
    KEY_TRIMMED=$(echo "$KEY" | sed 's/^[[:space:]]*//;s/[[:space:]]*$//')
    [ -z "$KEY_TRIMMED" ] && continue
    node -e '
      const fs = require("fs");
      const target = process.argv[1];
      const key = process.argv[2];
      const data = JSON.parse(fs.readFileSync(target, "utf8"));
      if (data.extraKnownMarketplaces && Object.prototype.hasOwnProperty.call(data.extraKnownMarketplaces, key)) {
        delete data.extraKnownMarketplaces[key];
      }
      let eol = "\n";
      const size = fs.statSync(target).size;
      if (size > 0) {
        const fd = fs.openSync(target, "r");
        const head = Buffer.alloc(Math.min(64, size));
        fs.readSync(fd, head, 0, head.length, 0);
        fs.closeSync(fd);
        if (head.includes(0x0d)) eol = "\r\n";
      }
      const body = JSON.stringify(data, null, 2) + "\n";
      fs.writeFileSync(target, body.replace(/\n/g, eol));
    ' "$WIN_TARGET" "$KEY_TRIMMED"
    echo "uninstall.sh: removed ${KEY_TRIMMED} from extraKnownMarketplaces"
  done
fi

# --- Apply: wipe dirs --------------------------------------------------------
# On Windows, rm -rf can transiently fail with EPERM if an antivirus scanner,
# OneDrive/Dropbox sync client, or another Claude Code session holds a handle
# on the directory tree (this is also the failure mode that hits the loader's
# own `marketplace add` rename). Retry a few times before giving up — the
# handle is almost always released within a second. After rm, verify the
# directory is actually gone and warn loudly if not, so the user knows to
# quit any other Claude session and retry before running /plugin install.
rm_with_retry() {
  local d="$1"
  local i
  for i in 1 2 3; do
    if rm -rf "$d" 2>/dev/null; then
      if [ ! -d "$d" ]; then
        echo "uninstall.sh: removed ${d}"
        return 0
      fi
    fi
    if [ "$i" -lt 3 ]; then sleep 1; fi
  done
  if [ -d "$d" ]; then
    echo "uninstall.sh: WARNING — ${d} still exists after 3 attempts (EPERM?)" >&2
    echo "uninstall.sh: another Claude Code session, antivirus, or a sync client" >&2
    echo "uninstall.sh: is likely holding a handle on it. Quit all Claude Code" >&2
    echo "uninstall.sh: sessions and re-run uninstall.sh before /plugin install." >&2
    return 1
  fi
  echo "uninstall.sh: removed ${d}"
  return 0
}
for d in "${ALL_CACHE_DIRS[@]}" "${ALL_MARKETPLACE_DIRS[@]}" "${ALL_TMP_MARKETPLACE_DIRS[@]}" "${ALL_STATE_DIRS[@]}" "${ALL_QUERY_PLUGINS_DIRS[@]}"; do
  if [ -d "$d" ]; then
    rm_with_retry "$d"
  fi
done

# --- Apply: strip JSON rows --------------------------------------------------
strip_plugin_row_from_json() {
  local file="$1"
  local key="$2"
  local win_path=""
  if command -v cygpath >/dev/null 2>&1; then
    win_path=$(cygpath -w "$file" 2>/dev/null || echo "$file")
  else
    win_path="$file"
  fi
  node -e '
    const fs = require("fs");
    const file = process.argv[1];
    const key = process.argv[2];
    const data = JSON.parse(fs.readFileSync(file, "utf8"));
    if (data.plugins && Object.prototype.hasOwnProperty.call(data.plugins, key)) {
      delete data.plugins[key];
    }
    let eol = "\n";
    const size = fs.statSync(file).size;
    if (size > 0) {
      const fd = fs.openSync(file, "r");
      const head = Buffer.alloc(Math.min(64, size));
      fs.readSync(fd, head, 0, head.length, 0);
      fs.closeSync(fd);
      if (head.includes(0x0d)) eol = "\r\n";
    }
    const body = JSON.stringify(data, null, 2) + "\n";
    fs.writeFileSync(file, body.replace(/\n/g, eol));
  ' "$win_path" "$key"
}

strip_plugin_key_from_json() {
  local file="$1"
  local key="$2"
  local win_path=""
  if command -v cygpath >/dev/null 2>&1; then
    win_path=$(cygpath -w "$file" 2>/dev/null || echo "$file")
  else
    win_path="$file"
  fi
  node -e '
    const fs = require("fs");
    const file = process.argv[1];
    const key = process.argv[2];
    const data = JSON.parse(fs.readFileSync(file, "utf8"));
    if (Object.prototype.hasOwnProperty.call(data, key)) {
      delete data[key];
    }
    let eol = "\n";
    const size = fs.statSync(file).size;
    if (size > 0) {
      const fd = fs.openSync(file, "r");
      const head = Buffer.alloc(Math.min(64, size));
      fs.readSync(fd, head, 0, head.length, 0);
      fs.closeSync(fd);
      if (head.includes(0x0d)) eol = "\r\n";
    }
    const body = JSON.stringify(data, null, 2) + "\n";
    fs.writeFileSync(file, body.replace(/\n/g, eol));
  ' "$win_path" "$key"
}

# Strip every plugin key shape (old + new) from installed_plugins.json.
# We don't gate on the planning step here — by the time we're applying,
# we already know what to do; we just iterate the same key list.
if [ -f "$INSTALLED_JSON" ]; then
  ANY_INSTALLED=0
  for KEY in "${SETTINGS_PLUGIN_KEYS[@]}"; do
    if grep -q "$KEY" "$INSTALLED_JSON" 2>/dev/null; then
      ANY_INSTALLED=1
      break
    fi
  done
  if [ "$ANY_INSTALLED" = "1" ]; then
    cp "$INSTALLED_JSON" "${INSTALLED_JSON}.bak.${TS}"
    echo "uninstall.sh: backup ${INSTALLED_JSON} -> ${INSTALLED_JSON}.bak.${TS}"
    for KEY in "${SETTINGS_PLUGIN_KEYS[@]}"; do
      if grep -q "$KEY" "$INSTALLED_JSON" 2>/dev/null; then
        strip_plugin_row_from_json "$INSTALLED_JSON" "$KEY" \
          && echo "uninstall.sh: stripped ${KEY} from ${INSTALLED_JSON}" \
          || echo "uninstall.sh: failed to strip ${KEY} from ${INSTALLED_JSON}" >&2
      fi
    done
  fi
fi

# Strip every marketplace key (old + new) from known_marketplaces.json.
if [ -f "$KNOWN_JSON" ]; then
  ANY_KNOWN=0
  for KEY in "${MARKETPLACE_KEYS[@]}"; do
    if grep -q "$KEY" "$KNOWN_JSON" 2>/dev/null; then
      ANY_KNOWN=1
      break
    fi
  done
  if [ "$ANY_KNOWN" = "1" ]; then
    cp "$KNOWN_JSON" "${KNOWN_JSON}.bak.${TS}"
    echo "uninstall.sh: backup ${KNOWN_JSON} -> ${KNOWN_JSON}.bak.${TS}"
    for KEY in "${MARKETPLACE_KEYS[@]}"; do
      if grep -q "$KEY" "$KNOWN_JSON" 2>/dev/null; then
        strip_plugin_key_from_json "$KNOWN_JSON" "$KEY" \
          && echo "uninstall.sh: stripped ${KEY} from ${KNOWN_JSON}" \
          || echo "uninstall.sh: failed to strip ${KEY} from ${KNOWN_JSON}" >&2
      fi
    done
  fi
fi

echo ""
echo "uninstall.sh: done. topgauge-cc is fully removed."

# --- Final: trim old backup files (keep only the most recent per file) -------
# This runs scripts/clean.sh so uninstall leaves a tidy filesystem. It is
# always safe — clean is a no-op when at most one backup per file exists.
# SCRIPT_DIR was resolved at the top of the script, before we wiped
# CACHE_DIR, so it still points at a valid location here even though
# this file is now gone. If the directory was gone at top-of-script
# time too (script run from a copy outside the cache), SCRIPT_DIR is
# empty and we just skip the final clean step.
if [ -n "${SCRIPT_DIR:-}" ] && [ -f "${SCRIPT_DIR}/clean.sh" ]; then
  PROJECT_FLAG=""
  [ "$PROJECT_LEVEL" = 1 ] && PROJECT_FLAG="--project"
  bash "${SCRIPT_DIR}/clean.sh" $PROJECT_FLAG || true
fi

echo ""
echo "  Re-install with: /plugin marketplace add cwf818/topgauge-cc"
echo "                   /plugin install topgauge-cc@topgauge-cc"
echo "                   /reload-plugins"
echo "                   /topgauge-cc:install"