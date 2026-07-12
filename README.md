<pre>
[upstream statusline lines]
Usage: ▓▓▓▓░░░░ 40% (1h27m🕗 5h) · ▓▓░░░░░░ 20% (4d3h🕔 7d)    # Quota
Balance: ￥110.00 · $3.5                                        # Balance
</pre>

# topgauge

[![License](https://img.shields.io/github/license/cwf818/topgauge)](LICENSE)
[![Tag](https://img.shields.io/github/tag/cwf818/topgauge)](https://github.com/cwf818/topgauge/tags)
[![Stars](https://img.shields.io/github/stars/cwf818/topgauge)](https://github.com/cwf818/topgauge/stargazers)

A provider-agnostic Claude Code statusline plugin for **token-plan usage / remaining quota**. It picks what to render from `ANTHROPIC_BASE_URL`, so the same plugin works against any supported provider's plan endpoint — no per-provider re-install. Currently supported:

- **MiniMax** — `Usage: …` / `Remain: …` (5-hour + weekly windows), from `/v1/token_plan/remains`
- **DeepSeek** — `Balance: …` (account balance), from `/user/balance`

For vanilla Anthropic, OpenRouter, or any other provider not on the list above, the plugin **hides itself** and passes any chained upstream statusline through unchanged.

We deliberately don't reimplement the kitchen-sink statuslines that already exist for vanilla Anthropic — [`claude-hud`](https://github.com/jarrodwatts/claude-hud) and [`ccstatusline`](https://github.com/sirmalloc/ccstatusline) cover that. This plugin focuses on provider-specific **quota / balance** data, plus lightweight usage statistics read from Claude Code's stdin payload.

ANSI colors are 5-band (256-color SGR): bright green / dark green / yellow / orange / red. Applied to the displayed value + the colored bar segment; the empty part of the bar stays uncolored so it remains readable.

## Documentation

- [**MANUAL.md**](./MANUAL.md) — exhaustive module reference. Every `m_*` module's source fields, inline-args grammar (two-class `|name:value|`), default placeholders, edge cases.
- [**CHANGELOG.md**](./CHANGELOG.md) — per-version change history (breaking changes, new modules, removed aliases, schema upgrades).
- [**HOW_TO_CREATE_A_PLUGIN.md**](./HOW_TO_CREATE_A_PLUGIN.md) — wire up a custom provider (kimi / moonshot / z.ai / etc.) without forking the plugin. User-side plugin ABI, fill contract, override resolution.

## Install

The plugin is a single-plugin marketplace. Install it in three steps:

```
/plugin marketplace add cwf818/topgauge
/plugin install topgauge@topgauge
```

> After the plugin install, run `/reload-plugins` so the loader picks up the new commands before wiring it into `settings.json`. Forgetting this step is the most common cause of "command not found" right after install.

Then wire it into `settings.json`:

```
/topgauge:install
```

This patches the active `settings.json` (user-level by default; pass `--project` for project-level):

1. If `statusLine` is already managed by us (`_topgauge_managed: true`), the command is a no-op.
2. Otherwise, the current `settings.json` is backed up to `settings.json.bak.<ISO-timestamp>`.
3. The original `statusLine.command` is preserved at `<claude-root>/plugins/topgauge/state/upstream-cmd.sh` and `<claude-root>/plugins/topgauge/state/upstream-cmd.txt` — sibling of `config.json`, **stable** across `/plugin install` rolls and cache wipes.
4. The `statusLine` is rewritten to invoke our wrapper, which sets `TOPGAUGE_UPSTREAM_CMD=<upstream-cmd.sh>` so the original statusline runs above our line.

`install.sh` auto-builds `dist/index.js` if it's missing (the marketplace install only copies source, not the bundle). Re-running the slash command is always a no-op once installed.

If you want to preview what install will do, run `/topgauge:install --dry-run` first.

If your active `settings.json` doesn't exist at the project level, install creates a minimal one (with `permissions.defaultMode: bypassPermissions`). It does **not** copy from the user-level file.

### Restore from backup

```
/topgauge:install --restore
```

Replaces the active `settings.json` with the most recent `settings.json.bak.<ts>`. Useful if you want to roll back an edit that wasn't made by us.

## Commands

Four slash commands ship with the plugin:

| Command                                  | What it does                                                                                    |
| ---------------------------------------- | ----------------------------------------------------------------------------------------------- |
| `/topgauge:install`           | Wire the wrapper into `settings.json` (or `--restore`).                                            |
| `/topgauge:uninstall`         | Restore `settings.json`, wipe cache + marketplace + loader rows.                                   |
| `/topgauge:clean`             | Trim old `.bak.<ts>` files (keeps the most recent per file).                                      |
| `/topgauge:clean-cache`       | Remove stale version dirs from the plugin cache, keeping only the newest.                          |

Each is a Pattern B2 slash command — the body is a `!`-fenced shell block that loads `scripts/<name>.sh` directly via `${CLAUDE_PLUGIN_ROOT}`, with `allowed-tools` scoped to that script. See [Project layout](#project-layout) for the file map.

## Uninstall

```
/topgauge:uninstall
```

This is a self-contained cleanup that works even after the plugin's cache and marketplace have been wiped. It does all of the following:

1. **Restore `statusLine`** — strategy in order:
   - If `${CLAUDE_ROOT}/plugins/topgauge/state/upstream-cmd.txt` exists (the stable state dir, sibling of `config.json`), restore the original command byte-for-byte from that file.
   - Else, fall back to the most recent `settings.json.bak.<ts>` whose `statusLine` does **not** have `_topgauge_managed: true` (the state before the plugin was installed).
   - Else, strip the marker but leave the wrapper in place and print a warning.
2. **Remove `topgauge@topgauge` from `settings.json.enabledPlugins`** (other plugins preserved).
3. **Remove `topgauge` from `settings.json.extraKnownMarketplaces`** (Claude Code records the marketplace source there too — leaving it would re-add the marketplace on next `/plugin marketplace add` with no visible diff).
4. **Wipe** `cache/topgauge/`, `marketplaces/topgauge/`, and the loader's leftover `marketplaces/cwf818-topgauge/` alias.
5. **Strip the plugin's row** from `installed_plugins.json` and `known_marketplaces.json` (with timestamped `.bak.<TS>` backups).
6. **Trim old `.bak.<ts>` files** — invokes `scripts/clean.sh` as the final step so uninstall leaves a tidy filesystem (one newest backup per file). User-named backups like `settings.json.bak-pre-v0.1.8` are NOT touched.

`settings.json` and the two JSON files are backed up **before** any destructive change. Line endings (CRLF/LF) are preserved. The script is **idempotent** — re-running on a clean system prints `nothing to do` and exits 0. Add `--dry-run` to preview actions without modifying anything.

The `env` block of `settings.json` (including your `ANTHROPIC_AUTH_TOKEN`) is **not** touched. The script runs locally with no API calls and never reads `ANTHROPIC_AUTH_TOKEN`.

After uninstall, re-install with the four-step flow:

```
/plugin marketplace add cwf818/topgauge
/plugin install topgauge@topgauge
/reload-plugins
/topgauge:install
```

Uninstall via the dedicated `/topgauge:uninstall` slash command (or run `scripts/uninstall.sh` directly). The legacy `install.sh --uninstall` thin shim was removed in v0.9.x — it was a layer of indirection that pointed at the same uninstaller; the dedicated command is clearer.

For dev iteration, `npm run dev:uninstall` (or `npm run dev:uninstall:dry`) does the same thing from the command line.

## Clean

```
/topgauge:clean
```

Removes the old `.bak.YYYYMMDDTHHMMSS` backup files our installer leaves behind, keeping only the most recent one per base file:

- `settings.json.bak.<ts>` → keeps the newest
- `installed_plugins.json.bak.<ts>` → keeps the newest
- `known_marketplaces.json.bak.<ts>` → keeps the newest

User-named backups (e.g. `settings.json.bak-pre-v0.1.8`) are **not** touched — only the script-generated timestamp pattern. Idempotent: if at most one backup exists per file, prints `nothing to clean` and exits 0. Add `--dry-run` to preview.

The uninstall slash command already runs `clean.sh` as its final step, so explicit cleanup is usually unnecessary after a fresh uninstall. Use the clean command directly if you want to tidy up between installs, or if you've accumulated a lot of `.bak.<ts>` files from earlier dev iteration.

For dev iteration, `npm run settings:clean` (or `npm run settings:clean:dry`) does the same thing from the command line.

## Clean cache

```
/topgauge:clean-cache
```

Every `/plugin install` rolls the cache forward — Claude Code creates a new `<version>` directory under `<cache>/topgauge/` but does **not** remove the previous one. Old version dirs pile up over time (~40-50 MB each: full source tree + node_modules). The `statusLine.command` written by `:install` is already version-independent — it `ls -d`s every version dir, sorts by version, and `exec`s the highest — so old dirs are pure dead weight.

`/topgauge:clean-cache` walks the cache, finds all `^[0-9]+\.[0-9]+\.[0-9]+(\.[0-9]+)?$` version directories, sorts numerically (so `0.2.10` sorts AFTER `0.2.9`, not lexically), keeps the newest, and removes the rest.

**Safety:** non-version entries (`.in_use`, `.orphaned_at_*`, hidden dirs, files, anything not matching the version regex) are left untouched. Idempotent: re-running is a no-op once only the newest remains. Add `--dry-run` to preview.

## How it composes with other statuslines

- The wrapper script is `scripts/wrapper.sh`. If `TOPGAUGE_UPSTREAM_CMD` is set, it runs that path as a bash script (`bash "$TOPGAUGE_UPSTREAM_CMD"`), captures stdout, and exposes it to the plugin entry as the `TOPGAUGE_UPSTREAM` env var. If unset, the wrapper runs the plugin as the sole statusline.
- `TOPGAUGE_UPSTREAM_CMD` is an **absolute path** to a bash script — `install.sh` writes one at `${CLAUDE_ROOT}/plugins/topgauge/state/upstream-cmd.sh` whose body is `exec bash -c '<original-command>'`. This path is **stable** (sibling of `config.json`, NOT inside the per-version cache dir), so `/plugin install` rolls don't move it. Older v0.1.10–v0.1.11 used `bash -c` against the path itself, which silently failed — fixed in v0.1.12.
- The plugin preserves interior newlines in upstream output and injects `\x1b[0m` before its own line if upstream ends with an unclosed ANSI SGR — so multi-line, ANSI-colored upstream statuslines render correctly.

## Activation

The plugin picks a **provider** from `ANTHROPIC_BASE_URL` and renders exactly one line:

| `ANTHROPIC_BASE_URL`                    | Line                     | API                                                  |
| --------------------------------------- | ------------------------ | ---------------------------------------------------- |
| `https://api.minimaxi.com/anthropic`    | `Usage: …` / `Remain: …` | `GET https://www.minimaxi.com/v1/token_plan/remains` |
| `https://api.deepseek.com/anthropic`    | `Balance: …`             | `GET https://api.deepseek.com/user/balance`          |
| anything else (vanilla Anthropic, etc.) | (hidden)                 | —                                                    |

Both endpoints are called with `Authorization: Bearer $ANTHROPIC_AUTH_TOKEN` — the same token, no new env vars. The provider table lives in the [`providers`](#providers) config block; the defaults reproduce the v0.2.20 behavior (exact match against the `/anthropic` base URL). Other URL forms can be matched via `COMPARE_METHOD: "INCLUDE"` (substring) or `"STARTWITH"` (prefix with suffix-attack guard, so `https://api.deepseek.com.evil.example` is rejected). On vanilla Anthropic, OpenRouter, or any other provider the plugin doesn't recognize, the line is hidden and any upstream output passes through unchanged.

### MiniMax token-plan line

<pre>
 Usage: ▓▓▓▓▓░░░ 38% (47m🕖 5h) · ▓▓▓░░░░░ 39% (4d47m🕓 7d)
Remain: ░░░░░▓▓ 62% (47m🕖 5h) · ░░░▓▓▓▓ 61% (4d47m🕓 7d)
</pre>

Two windows (5-hour + weekly), split-bar with colored percentage, reset
countdown in parentheses, window label after the countdown. The bar
glyphs flip in remaining mode — both modes read left-to-right as
"what's spent → what's left":

- `used` mode: `▓▓▓▓▓░░░` — `▓` is consumed (colored), `░` is remaining (plain)
- `remaining` mode: `░░░░░▓▓` — `░` is consumed (plain), `▓` is remaining (colored)

The reset countdown uses the shared time-formatting template:

| Remaining | Rendered  | Note                                       |
| --------- | --------- | ------------------------------------------ |
| `-1ms`    | `0m`      | past-due, explicit "this window has reset" |
| `30s`     | `<1m`     | sub-minUnit floor                          |
| `5m`      | `5m`      |                                            |
| `60m`     | `1h0m`    | internal zero preserved                    |
| `90m`     | `1h30m`   |                                            |
| `24h`     | `1d0h`    |                                            |

`maxUnitCount` (default `2`) controls how many units are shown. Leading
zeros are dropped (`0d0h5m` → `5m`); internal and trailing zeros are
kept (`2h0m` → `2h0m`, NOT `2h`). See `timeFormat.maxUnitCount` in the
config schema for the full set of options.

### DeepSeek balance line

When `ANTHROPIC_BASE_URL` matches the configured `providers.deepseek` entry (default: exact match against `https://api.deepseek.com/anthropic`), the plugin fetches the user's account balance and renders:

```
Balance: ￥110.00             # is_available=true, single CNY entry
Balance: $25.00               # is_available=true, single USD entry
Balance: ￥110 · $3.5         # multi-currency: ALL entries from balance_infos,
                             # joined by ' · ', single color band from the
                             # LOWEST balance (most urgent currency drives hue).
Balance: not available!       # is_available=false or no parseable entries
```

Per-currency display prefix: `USD` → `$`, `CNY` / `RMB` → `￥`. Any other
currency code is rendered as itself, uppercased (e.g. `EUR42.50`).

5-band color thresholds on the **lowest** entry's numeric value
(`thresholds.balanceBands`, default `[5, 10, 20, 50]`):

| Range     | Color        |
| --------- | ------------ |
| `<5`      | red          |
| `[5,10)`  | orange       |
| `[10,20)` | yellow       |
| `[20,50)` | dark green   |
| `>=50`    | bright green |

## Display mode

Default mode is **`used`** — the line begins with `Usage:` and the percentage shown is the percentage of the window you've consumed. The colored bar segment represents the consumed portion.

Switch to `remaining` mode via the config file:

```json
{ "display": "remaining" }
```

See [Configuration](#configuration) below for the full schema. The earlier `TOKENPLAN_DISPLAY` env var is gone as of v0.2.0 — anyone who used it must move the value to `config.json`.

In remaining mode the line begins with `Remain:` and the percentage is what's left; the colored bar segment represents the remaining portion.

`display` is MiniMax-only — DeepSeek's `Balance:` line doesn't have a percentage to flip. The window / context-window / mem-usage modules (`m_window|term|short|mid|long`, `m_windowContext`, `m_windowMemUsage`) also accept an inline `|display|used|remaining` override that takes precedence over the global `display` for that one module.

## Configuration

A single JSON file parameterizes every hardcoded tunable (color thresholds, cache TTL, fetch timeout, currency prefixes, bar geometry, stale-annotation formatting, display-mode label, per-module labels). Path:

- **Unix**: `~/.claude/plugins/topgauge/config.json`
- **Windows**: `%USERPROFILE%\.claude\plugins\topgauge\config.json`

Loaded once at startup. **Missing file** → all defaults (today's behavior, bit-for-bit identical). **Malformed JSON** or a **single bad field** → one stderr line (`topgauge: config <reason>; using defaults`) and the default for _that_ field only — the rest of your config is still honored. The plugin never blanks the statusline on bad config.

A reference with every field is at [config.example.json](./config.example.json). Copy it to the path above and edit.

### Schema (v1)

```jsonc
{
  "cacheTtlMs": 60000, // > 0; success-cache TTL in ms
  "fetchTimeoutMs": 5000, // > 0; per-request HTTP timeout
  "display": "used", // "used" | "remaining"
  "modeLabels": {
    // line prefix per mode
    "used": "Usage:",        // MiniMax plan line
    "remaining": "Remain:",  // MiniMax plan line in remaining mode
    "balance": "Balance:",   // DeepSeek balance line
  },
  "colors": {
    // 256-color ANSI palette
    "brightGreen": "brightGreen",
    "darkGreen": "darkGreen",
    "yellow": "yellow",
    "orange": "orange",
    "red": "red",
    "stale": "brightBlack", // dim-gray for the "⛓️‍💥 X ago" suffix
  },
  "thresholds": {
    // band cutoffs (4 ascending numbers each).
    // v0.8.36.1 — `percentBands` default is [60, 70, 80, 90]; older
    // [20, 40, 60, 80] still parses and applies as the user override.
    "percentBands": [60, 70, 80, 90],
    "balanceBands": [5, 10, 20, 50],
  },
  "currency": {
    // DeepSeek per-currency rendering
    "prefixes": { "USD": "$", "CNY": "￥", "RMB": "￥" },
    "fallback": "￥", // prefix for unknown currency codes
    "default": "CNY", // assumed currency when API omits one
  },
  "stale": {
    // stale-on-error annotation. v0.2.17 dropped the legacy
    // `separator` field — the stale annotation is now appended
    // directly after the template output. If a custom separator
    // is needed before the annotation, place it explicitly in the
    // lineTemplate (e.g. add an `s_0` token after `m_windowQuota|term:mid`).
    "ageEmoji": { "healthy": "🔗", "broken": "⛓️‍💥" },
  },
  "labels": {
    // v0.8.13+ (extended v0.8.17/22/23/24) — per-module label prefix
    // overrides. Defaults match the v0.8.x literal strings so existing
    // renders stay byte-identical until the user overrides via config.
    // Pre-v0.8.22 names (labelIn, labelOut, labelCacheIn, labelTotalIn,
    // labelApi, labelInSpeed, labelOutSpeed) are HARD-REJECTED in
    // v0.8.22 rev 2 — one stderr warn per load, then dropped. Use the
    // canonical names below.
    "labelTokenIn":                 "in:",
    "labelTokenOut":                "out:",
    "labelTokenTotalIn":            "in:",
    "labelTokenTotalOut":           "out:",        // shared with m_tokenTotalOut
    "labelTokenCachedIn":           "cache:",
    "labelTokenHitRate":            "hit:",        // v0.8.22 — extracted from hardcoded
    "labelApi":                     "api:",
    "labelApiCalls":                "calls:",
    "labelInSpeed":                 "in:",         // distinct from labelTokenIn
    "labelOutSpeed":                "out:",
    "labelContextSize":             "size:",       // v0.8.23
    "labelContextWindowsSize":      "size:",
    "labelContextUsedPercent":      "used:",
    "labelContextRemainingPercent": "remain:",
    "labelMemUsage":                "Mem:",        // v0.8.17
    "labelStartTime":               "start:",      // v0.8.24
    "labelEndTime":                 "end:",
  },
  "cacheHitColors": {
    // v0.4.0+ — 3-band palette for the m_tokenHitRate module.
    // Bands chosen by cacheHitThresholds (in tokenFormat below).
    "good": "brightGreen", // ≥ 80%
    "warn": "yellow",      // ≥ 50%
    "bad": "orange",       // < 50%
  },
  "bar": {
    // bar geometry
    "width": 8, // 3..64
    "filled": "▓",
    "empty": "░",
  },
  "timeFormat": {
    // Top-level knobs — govern ALL time rendering in the plugin
    // (reset countdown AND stale-age suffix). Keeping them out of the
    // `stale` block means a user who wants second-level granularity
    // anywhere gets it everywhere consistently.
    //
    // Smallest unit shown on time countdowns.
    //   "m" (default): sub-minute shows as "<1m" — the "<" prefix
    //                  signals "less than 1 minute" so the user can
    //                  tell a window is about to reset (vs "0m" which
    //                  would imply a definite wait).
    //   "s":           sub-minute shows as actual seconds (e.g. "47s").
    "minUnit": "m",
    // How many non-zero units to show. Drops LEADING zero units first,
    // then takes up to maxUnitCount from the start — including any
    // internal/trailing zero units. Clamped to [1, 4].
    //   1d2h3m4s → "1d2h"
    //   2h3m4s   → "2h3m"
    //   2h0m     → "2h0m"   (NOT "2h" — internal zeros preserved)
    //   0d0h5m   → "5m"     (leading zeros dropped)
    "maxUnitCount": 2,
  },
  "countdown": {
    // Reset-countdown visualization. Belongs with the countdown, NOT with
    // the stale-on-error annotation (which is a separate concern).
    //
    // Glyphs appended to the reset countdown (e.g. "2h3m🕛"). The picker
    // indexes by `remainingMs / resetDurationMs`, so the array reads
    // left-to-right as "few remaining → many remaining" (i.e. ascending
    // by remaining-time ratio). Index 0 is shown when remaining ≈ 0
    // (about to reset); the last entry is shown when remaining ≈ total
    // (fresh). Twelve clock-face emoji give a smooth visual ramp from
    // 12 o'clock (🕛, least remaining) around to 1 o'clock (🕐, most
    // remaining); two glyphs give a binary hourglass (full/empty);
    // one glyph is static. Providers without start_time (DeepSeek,
    // legacy) fall back to index 0.
    "resetArrows": [
      "🕛",
      "🕚",
      "🕙",
      "🕘",
      "🕗",
      "🕖",
      "🕕",
      "🕔",
      "🕓",
      "🕒",
      "🕑",
      "🕐",
    ],
  },
  "tokenFormat": {
    // v0.4.0+ — compact number formatting for the m_token* modules.
    //   < thresholds[0] → raw integer ("342")
    //   < thresholds[1] → "<x.y>k"   ("12.3k")
    //   ≥ thresholds[1] → "<x.y>M"   ("1.2M")
    "thresholds": [1000, 1000000],
    // Decimal places for the k / M tier (0..4)
    "precision": 1,
    // Decimal places for m_tokenInSpeed / m_tokenOutSpeed (0..4)
    "speedPrecision": 1,
    // Decimal places for m_tokenHitRate percentage (0..4)
    "cachePctPrecision": 1,
    // 3-band cache-hit thresholds (ascending). < lo → bad (orange),
    // < hi → warn (yellow), ≥ hi → good (green).
    "cacheHitThresholds": [50, 80],
  },
  "lineTemplates": {
    // v0.4.0+ — registry of reusable template fragments. Each value
    // is a token array. Allowed tokens: any m_* module EXCEPT
    // m_template, plus s_* separators. Keys are user-chosen; the
    // renderer reads from this registry when it sees an
    // `m_template|<key>` token inside `statuslineTemplate`. The
    // shipped fragment library (quota / balance / tokens_tick /
    // tokens_acc / tokens_stat / information / git_info / tick_eval /
    // acc_eval / stat_eval / git_info_all / context_all) is registered
    // with bare keys. User entries whose names collide with a shipped
    // fragment are warned + skipped. Pick a different key for your own
    // fragments (e.g. `myHeader`).
    //
    // Example: a shared `header` chunk used in both plan and
    // balance templates.
    "header": ["m_modeLabel", "s_space"]
  },
  "statuslineTemplate": ["m_template|quota|type:quota", "m_template|balance|type:balance"],
  // v0.8.47+ — string-form values reference DEFAULT_STATUSLINE_PRESETS
  // (whole-line presets `simple` / `standard` / `abundant`):
  //   "statuslineTemplate": "standard"

  // v0.4.0+ replaces the v0.3.x `lineTemplate: { plan, balance }`
  // shape with the two fields above. See the "Upgrading to v0.4.0"
  // section below for the migration notes. The loader warns once
  // per config load and ignores the legacy field.
  "providers": {
    // v0.2.21: declarative provider registry. The plugin picks a
    // provider by matching ANTHROPIC_BASE_URL against each entry's
    // BASE_URL_COMPARED_TO using the entry's COMPARE_METHOD. The
    // first match wins; iteration order = insertion order. TYPE
    // ("QUOTA" | "BALANCE") selects the plugin output shape and
    // renderer fail-line label.
    //
    // Defaults reproduce the built-in plugin behavior. Partial overrides
    // inherit missing fields from the default; a new provider also needs
    // a plugin module under query_plugins/<id>/.
    "minimax": {
      "TYPE": "QUOTA",
      "BASE_URL_COMPARED_TO": "https://api.minimaxi.com/anthropic",
      "COMPARE_METHOD": "EXACT",
      "intervals": {
        "shortInterval": {
          "remainingPercent": "model_remains.0.current_interval_remaining_percent",
          "startAt":          "model_remains.0.start_time",
          "endAt":            "model_remains.0.end_time"
        },
        "midInterval": {
          "remainingPercent": "model_remains.0.current_weekly_remaining_percent",
          "startAt":          "model_remains.0.weekly_start_time",
          "endAt":            "model_remains.0.weekly_end_time"
        },
        "longInterval": {}
      }
    },
    "deepseek": {
      "TYPE": "BALANCE",
      "BASE_URL_COMPARED_TO": "https://api.deepseek.com/anthropic",
      "COMPARE_METHOD": "EXACT",
      "intervals": {}
    },
  },
  // Plugin version is loaded automatically at startup from
  // .claude-plugin/plugin.json and surfaced via the m_version
  // module. No config field — just add "m_version" to your
  // lineTemplate to render "v0.8.37"-style annotations.
}
```

Each `colors.*` value is either a **symbolic shortcut** (`brightGreen`, `darkGreen`, `yellow`, `orange`, `red`, `brightBlack`) or a **literal ANSI SGR string** matching `^\x1b\[[0-9;]*m$`. Strings containing newlines are rejected (statusline-injection guard).

`thresholds.*` must be exactly 4 finite ascending numbers. `bar.width` must be in `[3, 64]`. Numeric fields must be finite and (where relevant) positive. `lineTemplate.<key>` must be a non-empty array of strings.

### Providers

The `providers` block is a `Record<string, ProviderEntry>`. Each entry declares:

- **`TYPE`** — `"QUOTA"` (5h + 7d two-window line) or `"BALANCE"` (account-balance line). Selects the plugin output shape and the renderer fail-line label.
- **`BASE_URL_COMPARED_TO`** — the URL pattern to match `ANTHROPIC_BASE_URL` against.
- **`COMPARE_METHOD`** — one of three modes, all case-insensitive:
  - `"EXACT"` (default) — `baseUrl === pattern`. Safest; rejects URLs that aren't exactly the configured value.
  - `"INCLUDE"` — `baseUrl.includes(pattern)`. Fuzzy host match; useful when `ANTHROPIC_BASE_URL` adds a path you don't care about.
  - `"STARTWITH"` — `baseUrl.startsWith(pattern)` with a suffix-attack guard: the character right after the prefix must be `undefined`, `/`, `?`, or `#`. This rejects `https://api.deepseek.com.evil.example` even though it `startsWith("https://api.deepseek.com")`. The `deepseek` matcher in earlier versions used this scheme; the v0.2.21 default is `EXACT` (a stricter choice), so users who relied on the old prefix behavior should set `COMPARE_METHOD: "STARTWITH"`.
- **`AUTHENTICATION_KEY`** *(optional, v0.6.0+)* — Bearer token sent in the `Authorization` header. **Always wins** over `process.env.ANTHROPIC_AUTH_TOKEN` when present — there is no env fallback. Useful for sandboxed / CI deployments that don't carry the env var, or for giving a single proxy provider a different credential from the rest of the session. Bad values (non-string, empty string) drop just the field; the entry still loads and the fetcher falls back to the env token.
- **`intervals`** *(optional, v0.8.28+)* — keyed by `shortInterval` / `midInterval` / `longInterval` (NOT by window-id literal). Each interval has up to 11 well-known slots the renderer reads; see [Well-known slots](#well-known-slots-per-providertype) below.

A user can override any subset of fields on a known provider; missing fields inherit from the default. To add a new provider, append a new key:

```jsonc
{
  "providers": {
    "moonshot": {
      "TYPE": "BALANCE",
      "BASE_URL_COMPARED_TO": "https://api.moonshot.cn/anthropic",
      "COMPARE_METHOD": "EXACT",
    },
  },
}
```

The cache key for a provider's response is its name (so two Quota providers get separate cache slots). The matcher's iteration order = insertion order of the `providers` object — the first matching entry wins on a tie.

#### Dynamic plugins

Provider acquisition is always handled by a dynamically imported plugin. Built-in `minimax` and `deepseek` plugins are emitted at `dist/plugins/<id>/index.js`; user-defined providers load from `~/.claude/plugins/topgauge/query_plugins/<id>/index.js` (or `index.mjs`). Each plugin exports the same default ABI:

```js
export default {
  async fetchAccountCredit(authenticationKey, context) {
    // return the canonical Quota or Balance object
  },
};
```

`AUTHENTICATION_KEY` is optional and overrides `process.env.ANTHROPIC_AUTH_TOKEN` before the plugin is called. Provider-specific API endpoints, HTTP methods, request bodies, and parsing belong in the plugin source, not in `config.json`.

A user-defined provider only needs its URL matcher, type, optional rendering overrides, and optional credential:

```jsonc
{
  "providers": {
    "moonshot": {
      "TYPE": "BALANCE",
      "BASE_URL_COMPARED_TO": "https://api.moonshot.cn/anthropic",
      "COMPARE_METHOD": "EXACT",
      "AUTHENTICATION_KEY": "sk-internal-only",
      "config": {}
    }
  }
}
```

### Data fields the plugin reads (field-mapping via `intervals.<term>.*`)

Built-in plugins may use the `intervals` block to map provider response fields into the canonical quota windows. User plugins own their API parsing and may ignore this block; adding a new user plugin means adding its module under `query_plugins`.

Anything not mapped resolves to `null`, and the renderer treats `null` as "no data for this window" (drops the chunk and skips its adjacent separators, same as today). A misconfigured path never throws — the parser logs a one-time stderr warning and the slot resolves to `null` (graceful degradation).

#### Well-known slots per `ProviderType`

**`Quota` providers** (e.g. MiniMax). The renderer reads up to **three parallel intervals** — `shortInterval` (default 5h), `midInterval` (default 7d), and `longInterval` (default 30d). Each interval has the same 11-slot shape; only the configured fields need to be present, and each interval is independent. The shape is keyed by term:

| Slot                          | Required            | Type                       | Used by                                                                                | Notes                                                                                                                  |
| ----------------------------- | ------------------- | -------------------------- | -------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| `intervals.<term>.windowId`   | optional            | `"5h"` \| `"7d"` \| `"30d"` | label / id discriminator                                                              | Defaults to `{ shortInterval: "5h", midInterval: "7d", longInterval: "30d" }` when omitted.                            |
| `intervals.<term>.label`      | optional            | string                     | `<label>--` placeholder, `m_quota(<label>):…` body                                     | Defaults to `windowId`.                                                                                                |
| `intervals.<term>.usedPercent`      | one of (percent group) | number 0..100         | `m_windowQuota` bar                                                                         | The **used** percentage. Provide this OR `remainingPercent`, not both. The plugin derives the missing one via `100 - x`. |
| `intervals.<term>.remainingPercent` | one of (percent group) | number 0..100        | (derived → `usedPercent`)                                                              | The **remaining** percentage. Same derive rule.                                                                        |
| `intervals.<term>.startAt`          | one of (time group)    | number (epoch ms)    | `m_countdown` body, `pickResetArrow` fill-state glyph                                  | When the current interval started. Pairs with `endAt` to compute the duration. ISO-8601 strings accepted.              |
| `intervals.<term>.endAt`            | one of (time group)    | number (epoch ms)    | `m_countdown` body                                                                     | When the interval resets. Same ISO-8601 coercion.                                                                      |
| `intervals.<term>.intervalMs` / `intervalS` | one of (time group) | number             | duration signal when `startAt`/`endAt` are missing                                     | Either milliseconds (`intervalMs`) or seconds (`intervalS`, multiplied by 1000). When `startAt`+`endAt` are also set, they win (explicit > derived). |
| `intervals.<term>.usedQuota`        | optional (quota group) | number              | `m_quota` body                                                                         | Used portion (integer).                                                                                                |
| `intervals.<term>.limitQuota`       | optional (quota group) | number              | `m_quota` body                                                                         | Total cap (integer).                                                                                                   |
| `intervals.<term>.remainingQuota`   | optional (quota group) | number              | informational only                                                                      | Remaining portion. Independent of `usedQuota` / `limitQuota`.                                                           |
| `isAvailable`              | optional            | boolean                    | the fail line ("not available!")                                                       | When `false`, the renderer replaces the line with `<modeLabel> <RED>not available!<RESET>`. Defaults to `true` if absent. |

**`BALANCE` providers** (e.g. DeepSeek). Renders an absolute monetary amount, possibly in multiple currencies. All entries in the array are rendered, joined by ` · `, with the **lowest** entry driving the color band. The `BALANCE` slot map is on the next-minor roadmap (DeepSeek still uses its v0.4.x hardcoded `parseBalance`); the slot names below are the planned contract.

| Slot              | Required | Type                | Used by                          | Notes                                                                                                                  |
| ----------------- | -------- | ------------------- | -------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| `isAvailable`     | optional | boolean             | the fail line                    | `false` → render "not available!" instead of the chunks.                                                              |
| `balances`        | required | array of objects    | `m_balance`                      | The list of currency entries. Each entry is parsed via the `balanceEntry` slot map below.                              |
| `balanceEntry.currency` | required per entry | string | `formatBalanceChunk` prefix     | The currency code (e.g. `"CNY"`, `"USD"`). Looked up against `currency.prefixes`; falls back to the raw code or `currency.fallback`. |
| `balanceEntry.totalBalance` | required per entry | number | `formatBalanceChunk` value      | The numeric balance for that currency. Numeric strings (`"110.00"`) are accepted and coerced.                          |

#### Default MiniMax mapping

The shipped `minimax` provider uses this default `intervals` block (you only need to override it if your account exposes differently-named fields, which today is not the case for any user — this is purely a future-proofing hook):

```jsonc
{
  "providers": {
    "minimax": {
      "TYPE": "QUOTA",
      "BASE_URL_COMPARED_TO": "https://api.minimaxi.com/anthropic",
      "COMPARE_METHOD": "EXACT",
      "intervals": {
        "shortInterval": {
          "remainingPercent": "model_remains.0.current_interval_remaining_percent",
          "startAt":          "model_remains.0.start_time",
          "endAt":            "model_remains.0.end_time"
        },
        "midInterval": {
          "remainingPercent": "model_remains.0.current_weekly_remaining_percent",
          "startAt":          "model_remains.0.weekly_start_time",
          "endAt":            "model_remains.0.weekly_end_time"
        },
        "longInterval": {}
      }
    }
  }
}
```

Note the **derivation** at work: only `remainingPercent` is mapped; the plugin derives `usedPercent` via `100 - x`. If your account exposes a `used_percent` field directly, map `usedPercent` instead and skip the derivation.

The parser also picks the **most-active** model from the `model_remains[]` array (lowest `remainingPercent`, or highest `usedPercent` when that's what the user mapped). `model_name` and the per-model `*_total_count` / `*_usage_count` fields from earlier drafts are intentionally NOT in the slot map — they were never used by the renderer.

#### Path-expression grammar

The path is a dotted/bracketed string evaluated against the parsed JSON response. The grammar:

```
path     := segment (('.' segment) | ('[' index ']'))*
segment  := [A-Za-z_][A-Za-z0-9_]*      // object key, OR a pure-digit token
index    := [0-9]+                       // array index
```

A pure-digit segment is parsed as an array index, so `usages.0.limits.0.detail.used` and `usages[0].limits[0].detail.used` are equivalent. Mixed alphanumerics (e.g. `m3`, `a1b`) are rejected as invalid keys.

**Type coercion rules** (the parser is permissive on input, strict on output):

- **Numbers** — accept JS numbers, numeric strings (`"42"`, `"3.14"`); reject non-numeric strings, `null`, booleans, objects. Trailing-unit strings (`"42%"`) are rejected.
- **Epoch ms** — same as numbers, but ISO-8601 strings (`"2026-07-07T11:32:40.140865Z"`) are coerced via `Date.parse`.
- **Booleans** — accept `true`/`false`, the numbers `0`/`1`, and the strings `"true"`/`"false"` (case-insensitive). Other inputs reject.
- **Arrays** — the slot is array-typed; the parser returns the whole array and iterates per-entry.
- **Missing / null** — the slot resolves to `null`; the renderer treats this as "no data" (drop / `n/a` placeholder per module contract).
- **Type mismatch** — the slot rejects; the parser logs a one-time stderr warning and the slot resolves to `null`. The plugin never throws on a bad path; a malformed config degrades to missing data, not a crash.

#### Path-resolution edge cases

- **First-wins on duplicate keys** — if an object has both `used` and `usedAt` as keys, the path `used` matches `used`, not a prefix-match on `usedAt`. The parser does exact-match on object keys.
- **Array out-of-bounds** — `usages[5].detail.used` on a 2-element array resolves to `null` (silent; the slot is just empty). No stderr warning — the user can't tell at config time how many entries the API will return.
- **Heterogeneous arrays** — if `usages[0]` is an object but `usages[1]` is a string, the parser walks the path against whichever type is at each step and rejects on mismatch.
- **Stringly-typed numbers** — `total_balance: "110.00"` is accepted and parsed as `110.00` (Number-coerced). Same for `"42"`, `"-3.14"`. Non-numeric strings reject.

#### Worked example — generic 5h/7d API

Given the example payload in the design spec:

```json
{
  "usages": [
    {
      "scope": "FEATURE_CODING",
      "detail": { "limit": "100", "used": "42", "remaining": "58",
                  "resetTime": "2026-07-07T11:32:40.140865Z" },
      "limits": [
        { "window": { "duration": 300, "timeUnit": "TIME_UNIT_MINUTE" },
          "detail": { "limit": "100", "used": "100",
                      "resetTime": "2026-06-30T21:32:40.140865Z" } }
      ]
    }
  ],
  "totalQuota": { "limit": "100", "used": "8", "remaining": "92" }
}
```

A `Quota` provider mapping for it (note the 5h window comes from the nested `usages[0].limits[0].detail.used`, and the 7d window from the top-level `usages[0].detail.used`):

```jsonc
{
  "providers": {
    "myProvider": {
      "TYPE": "QUOTA",
      "BASE_URL_COMPARED_TO": "https://api.example.com/anthropic",
      "COMPARE_METHOD": "EXACT",
      "intervals": {
        "shortInterval": {
          "usedPercent": "usages[0].limits[0].detail.used",
          "endAt":       "usages[0].limits[0].detail.resetTime"
        },
        "midInterval": {
          "usedPercent": "usages[0].detail.used",
          "endAt":       "usages[0].detail.resetTime"
        },
        "longInterval": {}
      }
    }
  }
}
```

The same mapping using the **bracket-less** form (digits after a dot are still parsed as array indices, per the grammar above):

```jsonc
"usedPercent": "usages.0.limits.0.detail.used",
"endAt":       "usages.0.limits.0.detail.resetTime"
```

#### Worked example — `BALANCE` provider with multiple currencies

For DeepSeek's `/user/balance` shape, the planned `BALANCE` mapping is:

```jsonc
{
  "providers": {
    "deepseek": {
      "TYPE": "BALANCE",
      "BASE_URL_COMPARED_TO": "https://api.deepseek.com/anthropic",
      "COMPARE_METHOD": "EXACT",
      "config": {
        "isAvailable": "is_available",
        "balances":    "balance_infos",
        "balanceEntry.currency":     "currency",
        "balanceEntry.totalBalance": "total_balance"
      },
      "intervals": {}
    }
  }
}
```

The `balances` slot is array-typed; the parser iterates `balance_infos[]` and applies `balanceEntry.*` paths to each element. (DeepSeek's v0.4.x parser still uses the hardcoded `parseBalance`; the slot-based form above is the contract for the v0.5.0 wiring.)

### Module tokens

The line layout is declared as `statuslineTemplate` (v0.4.0+). **v0.8.14+ — `statuslineTemplate` accepts `string[]` (token list) or a `string` (a preset name from [Built-in presets](#built-in-presets) below).** The default is `["m_template|quota|type:quota", "m_template|balance|type:balance"]` — provider-type dispatch: the `quota` fragment renders on a Quota provider (MiniMax), the `balance` fragment renders on a BALANCE provider (DeepSeek), and the other is silently dropped. Use `m_template|<key>` to reference a [shipped fragment](#shipped-fragments-v0847) from `lineTemplates`, or write a raw token array.

- For shared / reusable fragments, register them under `lineTemplates` and pull them into `statuslineTemplate` with `m_template|<key>[|type|<plan|balance>]`. See [`m_template`](#mtemplatekeytypeplnbalance-v040) below.
- **v0.8.14+ auto-migration (legacy warning only):** legacy string-form `statuslineTemplate` values (`"1line"`, `"standard"`, etc., from v0.4.0–v0.8.13) are auto-migrated to the equivalent array form with a one-shot stderr warning. **The legacy preset names themselves (`_1line` / `_standard` / `_abundant` / `_balance_simple` / …) are no longer registered** — see [Built-in presets](#built-in-presets) for the current `simple` / `standard` / `abundant` top-level preset keys. To silence the warn, write the array form directly.

The exhaustive module reference (per-module source fields, inline args, default placeholders, edge cases) lives at [MANUAL.md](./MANUAL.md). The summary table below lists every module with its rendered shape and family; cross-reference [MANUAL.md §3](./MANUAL.md#3-module-reference-m_) for full inline-args and behavior contracts.

Recognized modules:

| Token | Renders | Notes |
| ----- | ------- | ----- |
| `m_modeLabel` | The leading prefix: `modeLabels.used` / `modeLabels.remaining` (plan) or `modeLabels.balance` (DeepSeek). | |
| `m_windowQuota\|term:short\|mid\|long` | Interval bar + colored percentage, e.g. `▓▓▓░░░ 38%`. v0.8.28+ unifies the 5h/7d/30d windows under one module family keyed on `intervals.<term>`. | |
| `m_countdown\|term:short\|mid\|long` | Interval reset suffix: `(2h3m🕛 5h)` when reset time known, or `<label>:--` placeholder otherwise. | |
| `m_quota\|term:short\|mid\|long` | Quota display, e.g. `quota(5h):100/500`. Reads `intervals.<term>.usedQuota` + `.limitQuota`. v0.8.28+ new. | |
| `m_balance` | The DeepSeek balance chunk (e.g. `$25 · ￥110`), single SGR-wrapped block. | |
| `m_age` | The age annotation: `🔗 5m ago` (fresh, in-template) or `⛓️‍💥 5m ago` (stale, in-template or forced fallback). Emits unconditionally when listed in the lineTemplate; returns `null` only when `ageMs` is missing. | |
| `m_version` | The plugin version: `v0.8.37` (auto-loaded from `.claude-plugin/plugin.json`). | |
| `m_memUsage` | System RAM usage `Mem:15.9G/63.7G` (v0.8.17+; renamed from `m_memUsageStatus`). | |
| `m_windowMemUsage` | System RAM used bar + 5-band-colored percentage, e.g. `▓▓▓▓▓░░░ 62%` (v0.8.36+; parallel of `m_windowContext`). | |
| `m_windowContext` | Context window bar + 5-band-colored percentage, parallel to `m_window\|term:short` — e.g. `▓▓▓▓▓░░░ 63%`. Synthesized from stdin `context_window.used_percentage`. | |
| `m_cacheTtlStatus` | One TTL-gauge glyph (v0.8.15+) showing the freshness of the response cache. | |
| `m_statTtlStatus` | One TTL-gauge glyph (v0.8.15+) showing the freshness of the cross-project stat cache. | |
| `m_tokenIn` | Per-API-call input tokens — e.g. `in:140`. Active → brightGreen, idle → cached value under `STALE_COLOR` (v0.8.30 / v0.8.30.1). Always renders — every missing-data case collapses to `in:0`. | |
| `m_tokenOut` | Per-API-call output tokens — `out:265` (or `out:0`). Same semantics as `m_tokenIn`. Active → red, idle → STALE_COLOR. | |
| `m_tokenInTotal` | Session-cumulative input tokens — e.g. `in:163k`. Reads stdin `context_window.total_input_tokens`. | |
| `m_tokenTotalOut` | Session-cumulative output tokens — e.g. `out:155`. Reads stdin `context_window.total_output_tokens`. v0.8.0 renamed from `m_tokenOutTotal`. | |
| `m_tokenCachedIn` | Per-turn cache-read input tokens — e.g. `cache:62k`. Renamed from `m_cacheRead` / `m_cachedTokenIn` in v0.8.0. | |
| `m_tokenHitRate` | Cache hit rate as a percentage with 3-band coloring (`good ≥ 80%`, `warn ≥ 50%`, `bad < 50%`) — e.g. green `hit:99%`. Reads `current_usage.{cache_read, cache_creation}`. Idle tick → cached value STALE_COLORed (TTL gate disabled since v0.8.x R7). | |
| `m_tokenInSpeed` | Per-API-call input speed — e.g. dim-gray `in:32.4 t/s`. v0.8.13+. Idle tick → cached value STALE_COLORed. `\|color:scale` (or bare) maps tps to green→red across 5 bands. | |
| `m_tokenOutSpeed` | Same for output — e.g. `out:18 t/s`. Same semantics as `m_tokenInSpeed`. | |
| `m_accTokenIn` / `m_accTokenOut` / `m_accTokenCachedIn` / `m_accTokenTotalIn` / `m_accApiMs` / `m_accApiCalls` / `m_accTokenHitRate` / `m_accTokenInSpeed` / `m_accTokenOutSpeed` | Three-layer in-memory accumulator (session / project / model — `ccsession` removed in v0.8.35). Inline args: `color`, `nulldrop`, `scope` (default `session`). Cold slots replay from JSONL on first valid tick (v0.8.29). | |
| `m_accStartTime` | `start:HH:MM:SS` from the accumulator slot's `startAt` (v0.8.24+). Inline args: `scope`, `color`, `nulldrop`, `abs`. | |
| `m_sumTokenIn` / `m_sumTokenOut` / `m_sumTokenCachedIn` / `m_sumTokenTotalIn` / `m_sumApiMs` / `m_sumApiCalls` / `m_sumTokenHitRate` / `m_sumTokenInSpeed` / `m_sumTokenOutSpeed` | Cross-project JSONL scan with TTL=300s. Inline args: `color`, `nulldrop`, `model` (default `active`), `window` (default `all` since v0.8.32), `align` (default `false`). | |
| `m_sumStartTime` / `m_sumEndTime` | `start:HH:MM:SS` / `end:HH:MM:SS` from the JSONL row timestamps (v0.8.24+). `\|align:true` (v0.8.27+) prefers plan `resetStartAt` / `resetAt` when the window matches a declared `interval.windowId`. Inline args include `abs` (v0.8.25+) to widen to `YYYY-MM-DD HH:MM:SS`. | |
| `m_quote` | A rotating quote, frequency-bucketed (local) or strings from a remote endpoint (v0.8.18+). See [`m_quote` (v0.8.21+)](#m_quote-v0821) below. | |
| `m_template\|<key>` (v0.4.0+) | Expand a `lineTemplates[<key>]` fragment into the current render. See [`m_template`](#mtemplatekeytypeplnbalance-v040) below. | |
| `m_label\|<text>` | Literal `<text>` (escape literal `\|` as `s_pipe`). | |

**v0.4.0+ session-info / metadata modules** (read the live stdin payload
captured by `/statusline`):

| Token                    | Renders                                                          |
| ------------------------ | ---------------------------------------------------------------- |
| `m_session`              | The session name — e.g. `fix-bar-color-regressions`. Reads stdin `session_name`. |
| `m_model`                | The model display name — e.g. `MiniMax-M3`. Reads stdin `model.display_name`. |
| `m_effort`               | The effort level — e.g. `high`. Reads stdin `effort` (accepts string or `{level}` object). |
| `m_repo`                 | Repository identity — e.g. `github.com/cwf818/topgauge`. Reads stdin `workspace.repo.{host, owner, name}`, drops null components. |
| `m_branch`               | Current git branch. Reads git info from `cwd`. Drops when not a git repo. |
| `m_gitStatus`            | Git dirty / clean indicator: `dirty` / `clean`. |
| `m_ccVersion`            | The Claude Code CLI version — e.g. `2.1.191`. Reads stdin `version`. Lowercase alias `m_ccversion` also accepted (legacy). |
| `m_sessionDuration`      | Elapsed session time — e.g. `20h42m`. Reads stdin `cost.total_duration_ms` in `1d2h3m` format. |
| `m_sessionApiDuration`   | API-call time within the session — e.g. `2h18m`. Reads stdin `cost.total_api_duration_ms`. |
| `m_linesAdded`           | Session-cumulative lines added — e.g. `+ 3965` (with leading space). Reads stdin `cost.total_lines_added`. |
| `m_linesRemoved`         | Session-cumulative lines removed — e.g. `- 967`. Reads stdin `cost.total_lines_removed`. |
| `m_contextSize`          | Context window size (compact) — e.g. `size:200.0k`. Reads stdin `context_window.context_window_size`. Renamed from `m_ctx` in v0.8.0. |
| `m_contextUsedPercent`   | Context used percentage — e.g. `used:63%`. Reads stdin `context_window.used_percentage`. Renamed from `m_contextUsed` in v0.8.0. |
| `m_contextRemainingPercent` | Context remaining percentage — e.g. `remain:37%`. v0.8.0+ sibling. |
| `m_contextWindowsSize`   | Capacity of the context window — e.g. `size:200k`. (typo in name preserved.) Reads `context_window.size`. |

**Visibility of `m_age` (priority: template-driven, stale fallback):**
- If your `lineTemplate` includes `m_age`, the module emits **unconditionally** (no stale gating). Emoji reflects the fetch state: `🔗 X ago` on fresh ticks (showing the cache age), `⛓️‍💥 X ago` on stale (showing time since last successful fetch). Hidden only when `ageMs` is missing.
- If your `lineTemplate` does NOT include `m_age`, the **stale fallback** kicks in: when the fetch result is **stale** (network failure with a cached value), the broken-chain annotation is appended to the rendered line. On fresh ticks, no annotation is shown — the broken-chain indicator is reserved for real outages. The dedup check looks for any `" ago"` tail on the rendered lines, so a user who *does* include `m_age` in their template gets exactly one annotation, not two.

### Inline-args grammar (v0.8.33+)

Two-class separator scheme — **first `|` separates parts**, **first `:` or `=` (within a pair) splits name from value**. The previous v0.7.1–v0.8.32 positional `|name|value|value|…` form is REMOVED.

```
<token>[|<implicit>][|<name>:<value>][|<name>=<value>]…
```

| Token form | Required | Optional | Description |
| ---------- | -------- | -------- | ----------- |
| `m_label\|<text>` | `<text>` (literal) | `color`, `nulldrop` | Emit `<text>` verbatim. Escape a literal `\|` in the text with `s_pipe`. |
| `m_modeLabel\|color:<c>` | — | `color`, `nulldrop` | Same as bare `m_modeLabel`, optionally tinted. |
| `s_<n>\|color:<c>` | `<n>` (numeric index) | `color`, `repeat`, `wrap` | The separator at index `n`, optionally tinted / repeated / wrapped. |
| `m_<name>\|...` | (any module-specific axes) | `color`, `nulldrop`, plus the per-module axes from MANUAL.md §1.1 | Tint the natural output of any module; per-module axes as documented. |

Rules:

- The implicit-value slot (`<text>` for `m_label`, the template name for `m_template|<key>`, `<n>` for `s_<n>`) is `|`-bounded — the value can contain `:` or `=` freely.
- Each subsequent pair is split on the **first** `:` or `=`; everything to the right is the value. So `color:red:blue` parses as `color = "red:blue"`, and `window:5h|align:true` parses as `window = "5h"` + `align = "true"`.
- Unknown `name`, malformed pair (no `:`, no `=`, unknown name, resolver-rejected value) → dispatcher warns to stderr and drops the token (no partial render).
- Order doesn't matter; duplicates keep the last.
- Badarg values (e.g. `align|yes`, `scope|ccsession` after v0.8.35, `field|yes` after v0.8.18) drop the token with the standard one-shot warn — same discipline as a malformed pair.

`<color>` accepts a shortcut name (`brightGreen`, `darkGreen`, `yellow`, `orange`, `red`, `stale`, `brightBlack`) or a raw SGR string (`\x1b[36m`). `m_quote` additionally accepts `rainbow` / `rand-rainbow` / `hue`.

The bare forms (`m_modeLabel`, `s_0`, `m_windowQuota|term:short`, `m_tokenIn`, …) keep working exactly as before — the inline-args path only fires when the token contains `|`. So upgrading to v0.8.33 does NOT change the default `statuslineTemplate` output unless you explicitly opt in.

Examples:

```jsonc
{
  "statuslineTemplate": [
    "m_modeLabel|color:brightGreen",  // tint the leading Usage: prefix
    "s_space",                         // plain space (no color)
    "m_windowQuota|term:short", "s_space",
    "m_countdown|term:short",
    "s_dot",
    "s_space",
    "m_windowQuota|term:mid", "s_space",
    "m_countdown|term:mid",
    "s_newline",
    "m_accStartTime|abs:true",         // v0.8.24+, v0.8.25+
    "s_dot",
    "s_space",
    "m_sumTokenIn|window:5h"           // v0.8.32+ — wall-clock default (align=false)
  ]
}
```

### Per-module `:color:` override

Every existing module — `m_windowQuota|term:short`, `m_windowQuota|term:mid`, `m_countdown|term:short`, `m_countdown|term:mid`, `m_windowContext`, `m_windowMemUsage`, `m_balance`, `m_age`, `m_version`, `m_tokenIn`, `m_tokenOut`, `m_tokenHitRate`, `m_tokenCachedIn`, `m_tokenInSpeed`, `m_tokenOutSpeed`, plus the session-info modules (`m_session`, `m_model`, `m_effort`, `m_repo`, `m_ccVersion`, `m_sessionDuration`, `m_sessionApiDuration`, `m_linesAdded`, `m_linesRemoved`, `m_tokenInTotal`, `m_tokenTotalOut`, `m_contextSize`, `m_contextUsedPercent`, `m_contextRemainingPercent`, `m_contextWindowsSize`), plus the v0.8.0+ three-tuple families (`m_acc*` / `m_sum*`) — also accepts an optional `|color|<c>` segment. Two cases:

- **Plain-text modules** (e.g. `m_version`, `m_tokenIn`, `m_countdown|term:short`): the override simply wraps the natural output in `<color>…<RESET>` SGR. The module's own body is unchanged.
- **Already-colored modules** (e.g. `m_windowQuota|term:short`, `m_balance`, `m_tokenHitRate`, `m_tokenCachedIn`, `m_age`, `m_tokenInSpeed`, `m_tokenOutSpeed`): the override **replaces** the natural color choice — band-based, cache-hit-band, or fixed `stale` color — with your `<color>`. The user's color always wins; if you didn't say `|color:`, the module keeps its existing coloring and the default `statuslineTemplate` output is byte-for-byte identical.

Conflict rule: **if a `|color:` is supplied, the natural color is ignored** (per your spec — "如果与现有颜色方案冲突，则无视该参数" — the override always wins when present).

Examples:

```jsonc
{
  "statuslineTemplate": [
    "m_modeLabel|color:brightGreen",
    "s_space",
    "m_windowQuota|term:short|color:red",
    "s_space", "m_countdown|term:short",
    "s_space", "s_dot", "s_space",
    "m_windowQuota|term:mid",
    "s_space", "m_countdown|term:mid",
    "s_space", "m_age|color:yellow",
    "s_space", "m_tokenIn|color:darkGreen"
  ]
}
```

The bare forms (`m_windowQuota|term:short`, `m_age`, `m_tokenIn`, …) still go through the original `MODULES` path, so users on the default template see no diff on upgrade.

**Extension point:** future parameterized modules (`m_model:…`, …) plug in by adding an entry to `INLINE_SCHEMAS` and `INLINE_RENDERERS` in `src/render.ts`. No new top-level config keys needed.

### Per-module `display` override (window modules only)

The three window modules — `m_windowQuota|term:short`, `m_windowQuota|term:mid`, `m_windowContext`, `m_windowMemUsage` — accept an optional `|display|used` or `|display|remaining` segment. This is the **per-module** counterpart to the top-level `display` config field: it overrides which side of the bar gets colored and which percentage is shown, but only for the one module that uses it. The global config is untouched.

| Token | What it does |
| ----- | ------------ |
| `m_windowQuota\|term:short\|display:used` | 5h bar in `used` mode (same as bare when `display=used` in config). |
| `m_windowQuota\|term:short\|display:remaining` | 5h bar in `remaining` mode (inverts percentage; uses the remaining-mode palette). |
| `m_windowQuota\|term:mid\|display:used` / `display:remaining` | Same, for the 7d window. |
| `m_windowContext\|display:used` / `display:remaining` | Same, for the context window. |
| `m_windowMemUsage\|display:used` / `display:remaining` | Same, for the system RAM used bar. |

The bare forms are byte-for-byte unchanged — the global `display` config (default `used`) still drives them. Combine with `|color:` for both axes:

```jsonc
{
  "statuslineTemplate": [
    "m_modeLabel", "s_space",
    "m_windowQuota|term:short|display:remaining|color:yellow",
    "s_space", "m_countdown|term:short",
    "s_space", "s_dot", "s_space",
    "m_windowQuota|term:mid|display:remaining|color:yellow",
    "s_space", "m_countdown|term:mid"
  ]
}
```

Valid values are exactly `used` or `remaining` (case-sensitive). `display:USED`, `display:` (empty), or any other value is a parse-fail — the token is dropped and the standard one-shot "unknown lineTemplate module" warn fires.

**Note:** the remaining-mode palette is the *reverse* of the used-mode palette: high remaining = healthy = brightGreen, low remaining = red. So `m_windowQuota|term:short|display:remaining` at 38% used renders 62% in the band-3 remaining color (darkGreen) — not the band-3 used color (orange). See `formatOneChunk` / `splitBar` in `src/render.ts` for the exact mapping.

### `m_template|<key>[|type|<plan|balance>]` (v0.4.0+)

Pulls a registered fragment from `lineTemplates` into the rendered template. Use it to share chunks (e.g. a `Usage:` / `Balance:` label, a separator) across plan and balance templates without duplicating tokens.

**Token forms**

| Token form | Required params | Optional params | Description |
| ---------- | --------------- | --------------- | ----------- |
| `m_template\|<key>` | `key` (the `lineTemplates` entry to expand) | `type` (default `plan`; v0.8.37+ omitting `type` renders universally), `nulldrop` (accepted, no-op for this module) | Expand the registered fragment into the current render. |
| `m_template\|<key>\|type:plan` | `key` | `nulldrop` | Same, but the chunk only renders when the provider's TYPE is `QUOTA`. |
| `m_template\|<key>\|type:balance` | `key` | `nulldrop` | Same, but only renders when the provider's TYPE is `BALANCE`. |
| `m_template\|<key>\|<scope>:<...>` | `key` | any non-`type`/`mode` axis | Pass-through: pushes the axis down to inner `m_acc*` / `m_sum*` modules as the outer default. Inner-explicit wins. |

**Behavior:**

- **Missing key** → warns once and drops the chunk (same as any unknown module).
- **Type mismatch** → silently drops (no warn). The user explicitly asked for a type filter, so no error is needed.
- **No-type/mode form** → v0.8.37+ renders on plan, balance, AND unknown provider types. Pre-v0.8.37 silently dropped on type mismatch (default was `plan`).
- **Nesting is impossible**: the loader strips any `m_template:` tokens from `lineTemplates` entries at load time. A `lineTemplates` value cannot contain another `m_template:` token, so recursion cannot happen.
- **`:color:` is silently ignored on `m_template`**: put `|color:` on the inner modules if you want per-module coloring. Color propagation across expanded templates was deferred (the cost/complexity didn't justify the feature).

**Example — share a label across both providers:**

```jsonc
{
  "lineTemplates": {
    "header": ["m_modeLabel", "s_space"]
  },
  "statuslineTemplate": [
    "m_template|header|type:plan",  // visible only on plan providers (Quota)
    "m_windowQuota|term:short", "s_space", "m_countdown|term:short",
    "s_dot",
    "s_space",
    "m_tokenIn"
  ]
  // On a DeepSeek provider the header chunk drops (type:plan ≠ balance)
  // and the renderer falls through to the default balance rendering.
}
```

### Built-in presets (v0.8.47+)

Top-level `statuslineTemplate` accepts a `string` (preset name) or a `string[]` (raw token list). String-form resolves against `DEFAULT_STATUSLINE_PRESETS` in `src/config.template.ts`; the body is cloned into your config so subsequent user mutations don't leak back.

| Key         | Lines | Body summary                                                                                            |
| ----------- | ----- | ------------------------------------------------------------------------------------------------------- |
| `simple`    | 1     | `m_pluginSource` + provider-type dispatch (`m_template|quota|type:quota` / `m_template|balance|type:balance`) + `m_age`. Single line. |
| `compact`   | 4     | `tick_eval` / `acc_eval` / `stat_eval` stacked on lines 0–2; provider-type dispatch + `m_age` + `mem_info` + `m_version` on line 3. No `information` / `git_info` header (that's `standard`); no `m_quote` / per-scope `tokens_acc` / per-window `tokens_stat` (that's `abundant`). Mid-density multi-line. |
| `standard`  | 5     | `information` + `git_info` on line 0; `tick_eval` / `acc_eval` / `stat_eval` on lines 1–3; provider-type dispatch + `m_age` + `m_version` on line 4. |
| `abundant`  | 9     | `information` + `git_info_all` + address-mode `m_quote` on line 0; `tokens_tick` / per-scope `tokens_acc` (session/model/project) on lines 1–4; per-window `tokens_stat` (2h / 5h-align / 7d-align) + `m_statTtlStatus` on lines 5–7; provider-type dispatch + `m_quota|term:long|display:remaining|nulldrop:true` + `m_age` + `m_version` on line 8. Kitchen-sink; verbose. |

Set `"statuslineTemplate": "standard"` (or `"abundant"`) in your `config.json`. To customize, copy the preset body from `src/config.template.ts:DEFAULT_STATUSLINE_PRESETS` into your `lineTemplates` and reference it via `m_template|<key>`.

**Note:** the v0.4.0–v0.8.46 `_1line` / `_simple` / `_simple-alone` / `_standard` / `_standard-alone` / `_abundant` / `_complete` / `_balance_simple` / `_balance_simple-alone` preset family is REMOVED. Old configs that referenced these strings get a one-shot stderr warning and auto-migrate to a closest-matching preset body (typically the `quota` / `balance` fragment); user-defined `lineTemplates._*` entries that collide with a removed preset name still load but are no longer gated by the `_`-prefix collision check (any name is fine now).

### Shipped fragments (v0.8.47+)

`lineTemplates` ships a fragment library that you reference via `m_template|<key>` indirection. Each entry is a token array; the renderer expands it inline and forwards pass-through args (e.g. `scope`, `window`, `align`, `color`, `nulldrop`, `valueOnly`) to the inner modules per the [passthrough whitelist](https://github.com/cwf818/topgauge/blob/main/src/render.ts).

| Key            | Lines | Summary                                                                                                                  |
| -------------- | ----- | ------------------------------------------------------------------------------------------------------------------------ |
| `quota`        | 1     | Provider-type-aware quota render (5h / weekly windows via `m_windowQuota`). Matches `type:quota`.                        |
| `balance`      | 1     | Provider-type-aware balance render (`Balance: <balance>`). Matches `type:balance`.                                       |
| `tokens_tick`  | 1     | Per-turn tick diagnostics: speed (in/out), hit rate, `m_apiMs`, in/out/cached/total tokens, `m_tokenCost`.              |
| `tokens_acc`   | 1     | Session-scoped accumulator (default `scope:ccsession`): speed (in/out), hit rate, `m_accApiMs`, in/out/cached/total tokens, `m_accApiCalls`, `m_accTokenCost`, `m_accStartTime`. Inline arg `:scope:<session|project|model|ccsession>` selects the scope. |
| `tokens_stat`  | 1     | Cross-project sum/avg scan: speed (in/out), hit rate, `m_sumApiMs`, in/out/cached/total tokens, `m_sumApiCalls`, `m_sumTokenCost`, `m_sumStartTime`, `m_sumEndTime`. Inline args `:window:<dhms|all>` (default `all`), `:model:<active|name|all>` (default `active`), `:align:<true|false>` (default `false`; `true` aligns to declared plan window when available). |
| `information`  | 1     | Context-window + memory + model header: `[m_model] Context: <bar> <used>/<cap> \| Memory: <bar> <used>/<total>`.        |
| `git_info`     | 1     | `Git: <branch> <status> <linesAdded> <linesRemoved>`.                                                                    |
| `git_info_all` | 1     | `Git: <repo> <branch> <status> <linesAdded> <linesRemoved>`.                                                             |
| `context_all`  | 1     | `Context: <bar> <used> <cap> <usedPct> <remainingPct>`.                                                                  |
| `tick_eval`    | 1     | Per-turn tick diagnostics with `⚡Tick-tock:` label prefix (cyan).                                                       |
| `acc_eval`     | 2     | Session + project scoped accumulators on one logical row separated by `s_pipe|wrap:true`.                                |
| `stat_eval`    | 2     | 5h-align + 7d-align cross-project scans with `⌛<window>:` label prefixes (yellow) + `m_statTtlStatus` at the tail.      |

**Provider-aware dispatch (v0.8.15+):** `m_template` takes an optional `|type|<quota|balance>` named arg. `m_template|<key>|type:quota` matches a Quota provider and silently drops on a BALANCE provider (and vice versa). **Omit `type` for universal fragments** (context/git/tokens_acc/tokens_stat) — they render on every tick regardless of provider.

### Upgrading to v0.8.37 from v0.8.36

- **`m_template` no-type form is universal.** `m_template|<key>` with no `type:` / `mode:` arg now renders on plan, balance, AND unknown providers — the no-mode silent-drop on a type mismatch is gone. If your `statuslineTemplate` was relying on the silent drop to gate between providers, add `|type:plan` or `|type:balance` explicitly.
- **`thresholds.percentBands` default changed.** Was `[20, 40, 60, 80]`; now `[60, 70, 80, 90]` (v0.8.36.1). User overrides in `config.json` are unaffected. Reset to the new defaults by deleting the field.

### Upgrading to v0.9.0 from v0.8.x (BREAKING — user rewrite required)

`provider.TYPE` is renamed `"Quota"` → `"QUOTA"` (uppercase, aligned with `COMPARE_METHOD` enum and the v0.8.x convention). The default `DEFAULT_PROVIDERS.minimax.TYPE` is updated in source; no behavior change for users who never customized `providers`. But any user-supplied `providers.<id>.TYPE` value in `~/.claude/plugins/topgauge/config.json` must be updated — otherwise validation drops the entry and the provider silently stops matching.

```diff
  "providers": {
    "minimax": {
-     "TYPE": "Quota",
+     "TYPE": "QUOTA",
      "BASE_URL_COMPARED_TO": "https://api.minimaxi.com/anthropic",
      "COMPARE_METHOD": "EXACT"
    }
  }
```

```bash
# sed one-liner for a single config file (run on a copy first)
sed -i.bak -E 's/"TYPE":[[:space:]]*"Quota"/"TYPE": "QUOTA"/g' config.json
```

(For Windows, use PowerShell `Get-Content … | ForEach-Object { $_ -replace '"TYPE":\s*"Quota"','"TYPE": "QUOTA"' } | Set-Content …`.)

After migrating, run `npm test` (or `bash scripts/test-install.sh`) to spot-check that the providers still register. The validation error from a stale `"Quota"` value reads:

```
provider TYPE must be "QUOTA" or "BALANCE" (got "Quota"); dropping
```

— so the failure mode is loud, not silent.

### Upgrading to v0.8.33 from v0.8.32 (BREAKING — user rewrite required)

The inline-args grammar changed to two-class. Every `lineTemplates.<key>` entry in your `~/.claude/plugins/topgauge/config.json` must be rewritten.

```diff
- "m_sumTokenIn|window|5h"            // pre-v0.8.33 — pair boundary on |
+ "m_sumTokenIn|window:5h"            // v0.8.33+ — pair boundary on :
```

The bare `|name|value|` form is REMOVED. The dispatcher treats unparseable segments (no `:`, no `=` boundary) as "unknown lineTemplate module" and drops them with a one-shot stderr warning. The migration is mechanical — for each pair, replace the inner `|` with `:` (or `=`):

```bash
# sed one-liner for a single config file (run on a copy first)
sed -i.bak -E 's/\|([A-Za-z_][A-Za-z0-9_]*)\|/|\1:|/g' config.json
```

(For Windows, use PowerShell `Get-Content … | ForEach-Object { $_ -replace '\|([A-Za-z_][A-Za-z0-9_]*)\|','|$1:|' } | Set-Content …`.)

After migrating, run `npm test` (or `bash scripts/test-install.sh`) to spot-check that the templates still parse.

### Upgrading to v0.8.14 from v0.8.13

`statuslineTemplate` is now a `string[]` (token list) or a `string` (preset name). Pre-v0.8.14 string-form preset-name values (`"1line"`, `"standard"`, etc.) auto-migrate to the equivalent `["m_template|_X"]` array with a one-shot stderr warning — but those `_`-prefixed preset keys are themselves removed in v0.8.47+. The current registry is `DEFAULT_STATUSLINE_PRESETS` with unprefixed keys (`simple` / `standard` / `abundant`), and the fragment library in `DEFAULT_LINE_TEMPLATES` uses bare keys (`quota` / `balance` / `tokens_*` / `information` / `git_info*` / `tick_eval` / `acc_eval` / `stat_eval` / `context_all`). To silence the warning and pin the new shape:

```diff
- "statuslineTemplate": "standard",
+ "statuslineTemplate": "standard",  // still valid — now resolves against DEFAULT_STATUSLINE_PRESETS["standard"]
```

or write the body directly:

```diff
- "statuslineTemplate": ["m_template|_standard"],
+ "statuslineTemplate": ["m_template|information", "s_pipe|wrap:true", "m_template|git_info", ...],
```

**Balance-provider users on the default render** (DeepSeek) need an explicit migration — pre-v0.8.14, `statuslineTemplate: "1line"` silently fell back to the balance preset on a BALANCE provider; v0.8.14+ drops the chunk instead. Use the default render (`["m_template|quota|type:quota", "m_template|balance|type:balance"]`) which dispatches by provider type, or pin explicitly: `"statuslineTemplate": ["m_template|balance|type:balance"]` for DeepSeek.

### Upgrading to v0.4.0 from v0.3.x

The `lineTemplate: { plan, balance }` config field is **removed** in v0.4.0. The loader emits one `topgauge: config lineTemplate is removed in v0.4.0; use lineTemplates + statuslineTemplate. See CHANGELOG.md for the upgrade path. Ignoring the legacy field.` warning per config load and ignores the legacy field — there is **no auto-promotion** of `lineTemplate.plan` → `lineTemplates.plan`.

To migrate a customized `lineTemplate`:

```diff
- "lineTemplate": {
-   "plan":   ["m_modeLabel", "s_0", "m_windowQuota|term:short", "s_0", "m_countdown|term:mid"],
-   "balance": ["m_modeLabel", "s_0", "m_balance"]
- }
+ "lineTemplates": {
+   // Optional — only needed if you want to share fragments.
+   // The renderer reads `statuslineTemplate` first; if you don't
+   // need shared chunks, just set `statuslineTemplate` below and
+   // skip this block.
+ },
+ "statuslineTemplate": [
+   "m_modeLabel", "s_space",
+   "m_windowQuota|term:short", "s_space", "m_windowQuota|term:mid"
+ ]
```

The default `statuslineTemplate` is `["m_template|quota|type:quota", "m_template|balance|type:balance"]` — provider-type dispatch: the `quota` fragment renders on a Quota provider (MiniMax), the `balance` fragment renders on a BALANCE provider (DeepSeek), the other is silently dropped. To switch to a whole-line preset, set `"statuslineTemplate": "simple"` / `"compact"` / `"standard"` / `"abundant"` (the top-level presets live in `DEFAULT_STATUSLINE_PRESETS` in `src/config.template.ts`; see [Built-in presets](#built-in-presets)).

### `m_quote` (v0.8.21+)

A rotating quote, drawn from the bundled `quotes.json` (100+ bilingual entries, English + 中文) or from a remote endpoint. Opt-in — the default `statuslineTemplate` does NOT include it; add it where you want it.

**Token forms (v0.8.33+ two-class grammar)**

| Form | Default freq | Default color | Description |
| ---- | ------------ | ------------- | ----------- |
| `m_quote` | `h` | none | Plain quote from local pool. |
| `m_quote\|freq:<dhms>` | (the one supplied) | none | Pick how often the quote rotates (see below). |
| `m_quote\|color:<c>` | `h` | (the one supplied) | Tint the quote. |
| `m_quote\|address:<URL>\|quote:<path>\|author:<path>` | `h` | none | Fetch from a remote JSON endpoint; walk `<path>` for the quote body and `<path>` for the author. Wrap as `~<quote>~` (default; pass `\|wrap|false` for bare). Falls back to local pool on fetch failure. |
| `m_quote\|fields:<a,b,c>` | `h` | none | v0.8.19+ legacy form: comma-separated dot paths, rendered as `field1: field2:` (trailing colon). |
| `m_quote\|insecureTls:true` | — | — | v0.8.21+ — pass `curl -k` to skip TLS validation against the address. Use only against trusted dev endpoints. |

**Frequency (`freq`) — single-unit time format**

The freq argument is a `<digits><unit>` string (bare unit letter = `1<unit>`). Multi-unit forms like `2h10m` are rejected — express 130 minutes as `130m`. The unit letter picks the bucket size; the digit prefix picks the count.

| `freq`  | Window size | Boundary anchor |
| ------- | ----------- | --------------- |
| `s`     | 1s          | Unix-epoch multiples (since 1s divides 1d, also UTC-aligned) |
| `m`     | 1m          | UTC midnight-aligned (1m divides 1d) |
| `h`     | 1h          | UTC midnight-aligned (default) |
| `d`     | 24h         | UTC midnight-aligned |
| `2h`    | 2h          | UTC midnight-aligned (divides 24h) |
| `12h`   | 12h         | UTC midnight-aligned (00:00 / 12:00 UTC) |
| `6h`    | 6h          | UTC midnight-aligned (00:00 / 06:00 / 12:00 / 18:00 UTC) |
| `30m`   | 30m         | UTC midnight-aligned |
| `7d`    | 7d          | **Rolling** (7d does not divide 1d, so boundaries are epoch-relative) |
| `13h`   | 13h         | **Rolling** |
| `130m`  | 130m        | **Rolling** |

**Anchor rule:** when the bucket size divides one day (`86_400_000 % bucket === 0`), the boundary sits on UTC midnight. Otherwise the boundary sits at Unix-epoch multiples of the bucket. This gives predictable wall-clock times for "round" windows like 12h / 6h / 30m, and accepts arbitrary windows like 13h or 7d for users who want them.

Two ticks within the same window always produce the same quote. Multi-unit forms (`2h10m`), leading zeros (`01h`), zero counts (`0h`), oversize counts (`> 1_000_000`), unknown units (`5x`), and malformed inputs (`+5h`, `1.5h`, `h10`) are all rejected — the token is dropped with a one-shot stderr warn.

**Color (`color`)**

Accepts the standard shortcuts (`brightGreen`, `darkGreen`, `yellow`, `orange`, `red`, `stale`, `brightBlack`), any raw SGR string (`\x1b[36m`), and three special values unique to `m_quote`:

| Color value     | Effect |
| --------------- | ------ |
| `rainbow`       | Per-character 256-color SGR using a 6-hue palette (cyan → blue → purple → magenta → orange → yellow). Rotates through the palette for each character of the quote. |
| `rand-rainbow`  | Same as `rainbow`, but the palette rotation starts at a different offset. Two adjacent `freq` windows with the same quote but different `rand-rainbow` renders will look distinct. |
| `hue`           | Single-hue SGR wrap for the whole quote. The hue is picked from the 6×6×6 256-color cube using a hash of the quote text, so each quote gets a deterministic but varied color. |

Rainbow / rand-rainbow / hue colors are also stable within a `freq` window — same window, same colors — so a tick-by-tick refresh of the statusline never visually strobes.

**Example templates**

```jsonc
{
  "statuslineTemplate": [
    "m_modeLabel", "s_space",
    "m_windowQuota|term:short", "s_space", "m_countdown|term:short",
    "s_space", "s_dot", "s_space",
    "m_windowQuota|term:mid", "s_space", "m_countdown|term:mid",
    "s_newline",
    "m_quote|freq:12h|color:rainbow"
  ]
}
```

Local pool, twice-daily rotating rainbow quote.

```jsonc
{
  "statuslineTemplate": [
    "m_modeLabel", "s_space", "m_windowQuota|term:short",
    "s_newline",
    "m_quote|address:https://v1.hitokoto.cn/|quote:hitokoto|author:from_who|color:hue"
  ]
}
```

Remote endpoint (hitokoto), daily-bucketed rainbow wrap.

**Behavior notes**

- The local pool has 100+ entries; the renderer is deterministic per `(freq, nowMs)` so the same window always shows the same quote. No `Math.random` / no `Date.now` inside the renderer.
- Remote fetches use system `curl -sSf --max-time 5` (with `node:http(s)` core fallback when curl isn't on PATH — v0.8.21+). A failure (curl exit / non-JSON body / any path miss) appends an `error`-level row to `diagnostics.jsonl` (gated on `TOPGAUGE_DIAGNOSTICS_ENABLE=1`) and falls back to the local pool. The user always sees something.
- An invalid `freq` value (e.g. `m_quote|freq:yearly`, `m_quote|freq:2h10m`) drops the token with a one-shot stderr warn.
- An invalid `color` value drops the token with a one-shot stderr warn.

### Recipes

**Lower cache TTL** (re-fetch more often):

```json
{ "cacheTtlMs": 15000 }
```

**Switch to remaining mode**:

```json
{ "display": "remaining" }
```

**Custom palette** (e.g. cyan-only):

```json
{
  "colors": {
    "brightGreen": "\x1b[38;5;51m",
    "darkGreen": "\x1b[38;5;45m",
    "yellow": "\x1b[38;5;81m",
    "orange": "\x1b[38;5;75m",
    "red": "\x1b[38;5;69m"
  }
}
```

**Universal renderer that works on both provider types** (v0.8.37+):

```jsonc
{
  "statuslineTemplate": [
    "m_template|usage|type:plan",
    "s_newline",
    "m_template|balance"
  ],
  "lineTemplates": {
    "usage":  ["m_modeLabel", "s_space", "m_windowQuota|term:short", "s_space", "m_age"],
    "balance":["m_modeLabel", "s_space", "m_balance",         "s_space", "m_age"]
  }
}
```

On a Quota provider the `usage` branch renders (the no-type `balance` branch renders too — v0.8.37+); on a BALANCE provider the `usage` branch drops silently (type mismatch) and `balance` renders.

### Token usage (v0.8.0+ three-tuple family)

In addition to the tokenplan 5h/7d window percentages, the plugin reads Claude Code's session JSON from stdin and exposes a **suite of opt-in `m_token*` modules**. The default `statuslineTemplate` does NOT include any token module — existing v0.7.x configs render byte-identical after upgrade. To opt in, add the desired modules to your `statuslineTemplate` array.

**Available data sources** (parsed once per tick from stdin, zero IO):

- `context_window.total_input_tokens` / `total_output_tokens` — session cumulative
- `context_window.current_usage.{input_tokens, output_tokens, cache_creation_input_tokens, cache_read_input_tokens}` — post-turn snapshot (per-turn delta; `m_tokenIn` / `m_tokenOut` read these, NOT the cumulative `total_input_tokens`)
- `cost.total_duration_ms` — session wall-clock duration (used by `m_sessionDuration`, `m_sessionApiDuration`, and the speed modules)
- `cost.{total_lines_added, total_lines_removed}` — `m_linesAdded` / `m_linesRemoved`
- `session_id`, `cwd`, `transcript_path` — used to scope the state file for `m_acc*` / `m_sum*` modules
- `m_tokenTotalIn` invariant: `total_input_tokens == current.input_tokens + current.cache_read_input_tokens`. Violations are checked at `src/session-parse.ts` and a `warning` row is appended to `state/<projectHash>/diagnostics.jsonl` (gated on `TOPGAUGE_DIAGNOSTICS_ENABLE=1`, 60s dedupe).

**Persistent state file** (only for `m_acc*` / `m_sum*`): one JSON line per tick, appended to `~/.claude/plugins/topgauge/state/<projectHash>/<sessionId>.jsonl` (v0.4.x+ Per-Project Layout; was `state/token-samples/<hash>/<sid>.jsonl` in v0.4.0–v0.4.<n-1>). ~120B per row, ~700KB over 7d. Lives in the stable `state/` directory — survives cache rolls and version bumps. Legacy `state/token-samples/<hash>/<sid>.jsonl` files can be preserved across an upgrade with `bash scripts/migrate-state.sh` (preview with `--dry-run`).

**Example template** with token counts alongside the windows (v0.8.33+ two-class grammar):

```jsonc
{
  "statuslineTemplate": [
    "m_modeLabel", "s_space",
    "m_windowQuota|term:short", "s_space", "m_countdown|term:short",
    "s_space", "s_dot", "s_space",
    "m_windowQuota|term:mid", "s_space", "m_countdown|term:mid",
    "s_space", "s_dot", "s_space",
    "m_tokenIn", "s_space",
    "m_tokenOut", "s_space",
    "m_contextSize",
    "s_space", "m_tokenHitRate"
  ]
}
```

Renders (example): `Usage: ▓░░░░░░░ 9% (4h47m🕔 5h) · ▓▓░░░░░░ 25% (2d8h🕔 7d) · in:163.5k out:155 ctx:163.5k hit:100.0%`

Note: `m_tokenHitRate` now renders as `hit:N%` (v0.8.x R8 — prefix unified with `m_accTokenHitRate` / `m_sumTokenHitRate`); `m_contextSize` shows the cumulative input token count, not the context window's literal `size` (use `m_contextWindowsSize` for that).

**Token-format config** (`tokenFormat` block):

```jsonc
{
  "tokenFormat": {
    // Compact notation thresholds: < thresholds[0] → raw integer,
    // < thresholds[1] → "12.3k", else → "1.2M".
    "thresholds": [1000, 1000000],
    // Decimal places for the k/M tier (0..4)
    "precision": 1,
    // Decimal places for m_tokenInSpeed / m_tokenOutSpeed (0..4)
    "speedPrecision": 1,
    // Decimal places for m_tokenHitRate percentage (0..4)
    "cachePctPrecision": 1,
    // 3-band cache-hit thresholds (ascending). < lo → bad,
    // < hi → warn, ≥ hi → good.
    "cacheHitThresholds": [50, 80],
  },
  "cacheHitColors": {
    "good": "brightGreen",
    "warn": "yellow",
    "bad": "orange",
  },
}
```

**Module reference:** see the [Module tokens](#module-tokens) table above for the per-family summary; the per-module full contract (source fields, inline args, placeholders, edge cases) lives at [MANUAL.md §3](./MANUAL.md#3-module-reference-m_).

**Show only the 5-hour window** (drop the 7-day window):

```jsonc
{
  "statuslineTemplate": [
    "m_modeLabel", "s_space",
    "m_windowQuota|term:short", "s_space",
    "m_countdown|term:short"
  ]
}
```

**Custom inter-window separator** (e.g. ` / ` instead of ` · `):

```jsonc
{
  "statuslineTemplate": [
    "m_modeLabel", "s_space",
    "m_windowQuota|term:short", "s_space", "m_countdown|term:short",
    "s_space", "s_dot", "s_space",
    "m_windowQuota|term:mid", "s_space", "m_countdown|term:mid"
  ]
}
```

**Show the plugin version** at the end of the line:

```jsonc
{
  "statuslineTemplate": [
    "m_modeLabel", "s_space",
    "m_windowQuota|term:short", "s_space", "m_countdown|term:short",
    "s_space", "s_dot", "s_space",
    "m_windowQuota|term:mid", "s_space", "m_countdown|term:mid",
    "s_space", "m_version"
  ]
}
```

### Migration from `TOKENPLAN_DISPLAY` / `TOPGAUGE_DISPLAY`

If you previously set `TOKENPLAN_DISPLAY=remaining` (pre-v0.2.0) or
`TOPGAUGE_DISPLAY=remaining` in your shell, move that value into
`config.json`:

```bash
mkdir -p ~/.claude/plugins/topgauge
echo '{ "display": "remaining" }' > ~/.claude/plugins/topgauge/config.json
```

Restart Claude Code (or run `/reload-plugins`) for the change to take effect.

## Diagnostics log

When the plugin encounters something worth telling you about — a malformed
config field, a fetcher that returned an unexpected status code, an
`m_quote` address fetch failure — it can append a JSONL entry to:

```
~/.claude/plugins/topgauge/state/<projectHash>/diagnostics.jsonl
```

(`v0.4.x+` Per-Project Layout: the log is partitioned by project directory so
multiple Claude Code sessions in different projects never contend over the
same file. The legacy top-level `state/diagnostics.jsonl` is still written
for plugin-level errors with no project affiliation — e.g. config-parse
warnings emitted before any cwd is known.)

Each line is a structured record:

```jsonl
{"at":1782576199672,"level":"warning","source":"config","msg":"invalid 'bar.width' value (got abc); using default 8"}
{"at":1782576200103,"level":"error","source":"api","msg":"MiniMax /v1/token_plan/remains returned non-zero base_resp.status_code (status_code=1008)"}
{"at":1782576231000,"level":"error","source":"m_quote","msg":"address fetch failed: curl exit 28 (timeout after 5000ms)"}
```

Use it as a postmortem trail — `tail -f` while debugging, or `grep` by level
and source when something went wrong yesterday. JSONL is greppable and
structured (timestamp + level + source + message).

### Opt-in gate

The log is **OFF by default** — set `TOPGAUGE_DIAGNOSTICS_ENABLE=1` (or
`true` / `yes`, case-insensitive) in your shell to enable file writes:

```bash
export TOPGAUGE_DIAGNOSTICS_ENABLE=1
```

The rationale: the file lives in your plugins dir and may contain sensitive
fragments (config paths, error text from upstream libraries). We don't write
unless you explicitly ask. The stderr noise for append failures stays
independent of the gate — silent when the write succeeds, present when it
doesn't.

### Size policy

Capped at the last 1000 entries (raised from 200 in v0.8.34). Anything older
than 1000 events is uninteresting by definition — we just want a tail. Trim
is best-effort and runs after every append.

### Wiping the log

`/topgauge:clean --purge-runtime` walks every
`state/<projectHash>/` subdir and wipes its `diagnostics.jsonl`,
`cache.json`, and `<*.jsonl>` token-sample files (v0.4.x+ Per-Project
Layout). It also cleans the legacy top-level `state/diagnostics.jsonl`,
`state/cache.json`, and the legacy `state/token-samples/` tree for users
upgrading from v0.4.0–v0.4.<n-1>. Top-level `upstream-cmd.{sh,txt}` and
`config.json` are NEVER purged. Preview first with
`/topgauge:clean --purge-runtime --dry-run`.

## Auth

The plugin reuses `process.env.ANTHROPIC_AUTH_TOKEN` to call the provider's plan endpoint. **No new env vars.** See [SECURITY.md](./SECURITY.md) for how the token is handled.

## Caching

The Claude Code statusline is updated in response to interaction events by default (every prompt, every tool result). Starting with **Claude Code 2.1.97**, the `statusLine.refreshInterval` field is honored, letting the statusline refresh on a fixed cadence instead. Two scopes of "refresh interval" are involved and they're independent:

- **This plugin's 60 s TTL** — how long we cache a successful API response before re-fetching. MiniMax and DeepSeek have different rate-limit policies and refresh cadences; 60 s is a deliberate default that keeps the statusline responsive without hammering the API. Cache entries are shadowed to disk under `state/<projectHash>/cache.json` (sibling of `config.json`, wiped by `:uninstall`; v0.4.x+ Per-Project Layout — was `state/cache.json` in v0.4.0–v0.4.<n-1>), so the TTL is honored **across per-tick child-process spawns** — the second tick within 60 s reuses the first tick's value instead of re-fetching. Per-project isolation: `render.ts` prefixes every cache key with `<projectHash>:` so different projects never collide on the same `cache.json`.
- **Claude Code's `statusLine.refreshInterval`** — how often the harness invokes the statusline command. Set in `~/.claude/settings.json` independently of this plugin:

  ```json
  {
    "statusLine": {
      "type": "command",
      "command": "...",
      "refreshInterval": 60
    }
  }
  ```

  Unit is **seconds** (not milliseconds — that's a frequent footgun; the harness will reject or misbehave on values like `30000`). For this plugin, **30–120 s is a sensible range**: shorter than the 60 s TTL is wasted, much longer and the line lags behind reality. The `refreshInterval` value does **not** affect the API-call TTL — they are independent knobs.

  This plugin follows the **minimum-change principle**: it does not write `refreshInterval` into `settings.json`. Set it yourself if you want a non-default cadence.

DeepSeek balance uses a separate cache key (`"balance"`) so the two providers don't invalidate each other. (v0.2.21: the cache key is actually the provider's name in the `providers` map — `"minimax"` / `"deepseek"` by default. Adding a third provider gets its own slot automatically.)

### Failure handling

Three outcomes when the provider API is called:

| Outcome                    | What you see on the statusline                                                                                                                                                |
| -------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Fresh fetch                | The normal `Usage: …` / `Balance: …` line, no suffix on the default template. (Includes within-TTL cache hits — the broken-chain suffix is reserved for stale state. If your template includes `m_age`, you'll see a healthy `🔗 X ago` here instead.) |
| Fetch failed, cache exists | The last good value, **with a dim `⛓️‍💥 X ago` suffix** at the end (e.g. `Balance: ￥110 ⛓️‍💥 5m ago`). The broken-chain emoji IS the indicator (no leading separator).   |
| Fetch failed, no cache     | `Usage: not available!` (MiniMax) or `Balance: not available!` (DeepSeek) in red. Plugin is alive but the provider is unreachable.                                            |

The `X ago` format uses the **same template as the reset countdown**:
d/h/m units, `maxUnitCount=2` default, drop leading zeros but keep
internal/trailing zeros. Sub-minute follows `timeFormat.minUnit`:
`minUnit="m"` → `<1m ago`; `minUnit="s"` → `${seconds}s ago`. Examples
(with default `minUnit="m"`):

| Cached age  | Rendered suffix        |
| ----------- | ---------------------- |
| 30 s        | `⛓️‍💥 <1m ago`          |
| 5 min       | `⛓️‍💥 5m ago`           |
| 90 min      | `⛓️‍💥 1h30m ago`         |
| 24 h        | `⛓️‍💥 1d0h ago`          |

The hard-fail `not available!` line intentionally has no age suffix
because there is no cached value to be stale-OF.

## Develop

```bash
npm install
npm run typecheck    # tsc --noEmit
npm test             # node --test --import tsx src/**/*.test.ts
npm run build        # esbuild → dist/index.js
npm run dev          # esbuild --watch
```

### Per-tick pipeline (v1.0)

The per-tick pipeline is split between **data-processor (writes)** and
**render (reads)** — owned by `src/data-processor.ts` and `src/tick-state.ts`.
The render code (`src/render.ts`) is **read-only** against `tickState.pending`;
it never calls `tickState.mark` / `setAvg` / `setPrevTick` / `setLastSpeed`
/ `setLastApiMs` / `setLastTokenHitRate`. Writes are coalesced into a single
`commit()` flush per tick — at most one full-file rewrite of
`state/<projectHash>/status.json` even on active renders. The validation gate
(per user contract 2026-07-04) requires `tokens.totals.tokenTotalIn > 0
AND tokens.totals.tokenTotalOut > 0 AND deltaApiMs > 0`; invalid ticks
commit nothing but the renderer still reads `pending` and falls back to
placeholder / cached values.

### Response shape

The MiniMax parser reads from the `intervals.<term>.<field>` slot map (see [Well-known slots](#well-known-slots-per-providertype) above). For each of the three term slots (`shortInterval` / `midInterval` / `longInterval`), the parser:

1. **Resolves the path** at `intervals.<term>.<field>` against the parsed JSON (the same path-expression grammar as the v0.4.x parser, with array-index and dot-notation support).
2. **Derives missing values** per group:
   - **Percent group** (`usedPercent` / `remainingPercent`): at least one required; if both provided, `usedPercent` wins; if only one is given, the other is derived as `100 - x`.
   - **Time group** (`startAt` / `endAt` / `intervalMs` + `intervalS`): at least two of the three required. If `startAt` + `endAt` are present, they win (explicit > derived); otherwise, missing third field is derived from the other two. If only one is provided, the time group collapses to all-null.
   - **Quota group** (`usedQuota` / `limitQuota` / `remainingQuota`): each is independent — render rules are per-field (see `m_quota` in MANUAL §3.1).
3. **Falls back** the `intervalMs` field through a 3-step chain:
   1. **Path** — `intervals.<term>.intervalMs` / `intervalS` (seconds are multiplied by 1000).
   2. **Numeric parse** — if the path resolved to a string-shaped number, coerce to finite number.
   3. **Keyword lookup** — if both fail, probe the root response for `hour` / `fiveHour` / `day` / `sevenDay` / `week` / `month` / `year` in that order, multiplying by the canonical ms-per-unit (3600000 / 18000000 / 86400000 / 604800000 / 2592000000 / 31536000000).

The `intervals` config is keyed by **term** (`shortInterval` / `midInterval` / `longInterval`), NOT by window-id (`5h` / `7d` / `30d`). The default MiniMax mapping (see [Default MiniMax mapping](#default-minimax-mapping) above) wires `shortInterval` to `current_interval_remaining_percent` + `start_time` + `end_time`, and `midInterval` to `current_weekly_remaining_percent` + `weekly_start_time` + `weekly_end_time`.

If `base_resp.status_code ≠ 0`, the response is treated as failure and the line is omitted.

The verified real shape (captured 2026-06-24 against `https://www.minimaxi.com/v1/token_plan/remains`):

```json
{
  "model_remains": [
    {
      "model_name": "...",
      "current_interval_remaining_percent": 60,
      "current_weekly_remaining_percent": 92,
      "end_time": "...",
      "weekly_end_time": "..."
    }
  ],
  "base_resp": { "status_code": 0 }
}
```

The plugin picks the entry with the **lowest interval remaining %** as the source of truth (the most-active model). If you capture a fresh response and the shape diverges, save it as `src/__fixtures__/remains.real.json` and tighten the parser in `src/api.plan.ts`.

The DeepSeek response shape is simpler — `{ is_available: bool, balance_infos: [{ currency, total_balance, granted_balance, topped_up_balance }, ...] }` — and the parser iterates **all** entries so every currency the account holds is rendered.

### Dev loop: re-installing the plugin from scratch

When iterating on the install flow (changes to `scripts/install.sh`, `scripts/uninstall.sh`, the slash commands, the version, etc.) you need to fully wipe the plugin's on-disk state before `/plugin install` will re-fetch a clean copy. The plugin loader caches marketplace state and refuses to bump an already-installed plugin — on Windows this surfaces as `EPERM: operation not permitted, rename ... -> ... .bak`.

Use the bundled dev helper (does **not** touch `settings.json` — your statusLine is preserved):

```bash
# Preview what will be removed:
npm run dev:uninstall:dry

# Wipe topgauge state:
npm run dev:uninstall
```

It removes:

- the topgauge row from `installed_plugins.json` and `known_marketplaces.json` (with timestamped `.bak.<ts>` backups of both files).
- `cache/topgauge/`, `marketplaces/topgauge/`, and the loader's leftover `marketplaces/cwf818-topgauge/` directory.

Then re-install:

```
/plugin marketplace add cwf818/topgauge
/plugin install topgauge@topgauge
/reload-plugins
/topgauge:install
```

If the loader still says "EPERM" after `dev:uninstall`, the most common cause is a Claude Code process holding a file lock on the marketplace dir. **Quit all running Claude Code sessions** (not just this one) and re-run `npm run dev:uninstall`.

## Project layout

```
src/
  index.ts            # entry — stdin drain, provider dispatch, cache, render, compose
  types.ts            # Provider = string | null; ProviderType / CompareMethod / ProviderEntry
  providers.ts        # URL matching, fetcher / template / fail-label dispatch (v0.2.21+)
  api.plan.ts         # Quota fetch + tolerant parser for /v1/token_plan/remains  (renamed from api.ts in v0.8.36)
  api.balance.ts      # BALANCE fetch + parser for /user/balance                       (renamed from api.deepseek.ts in v0.8.36)
  api.quote.ts        # m_quote remote fetch + dot-path scan (v0.8.18+)
  quotes.ts           # bundled quotes.json (100+ bilingual entries) — m_quote local fallback
  render.ts           # v1.0 READ-ONLY against tickState.pending; MODULES + INLINE_RENDERERS + INLINE_SCHEMAS dispatchers
  data-processor.ts   # v1.0 processTick + setPrevTick + setAvg + setLastSpeed/ApiMs/TokenHitRate — owns ALL writes to tickState.pending
  tick-state.ts       # v1.0 per-tick in-memory Store: beginTick / mark / commit
  status-store.ts     # three-layer acc (session/project/model) + cold-slot JSONL replay (v0.8.29) + stat cache
  cache.ts            # 60s TTL + stale-on-error; per-project cache.json shadowing
  composition.ts      # reads TOPGAUGE_UPSTREAM, prepends (preserving ANSI/multi-line) and appends line
  config.ts           # loads ~/.claude/plugins/topgauge/config.json; module-level singleton store
  diagnostics.ts      # JSONL append logger (opt-in via TOPGAUGE_DIAGNOSTICS_ENABLE); 1000-line cap (v0.8.34+)
  dispatch.ts         # providerType → module-set dispatch (provider-aware gating)
  path-expr.ts        # path-expression grammar evaluator (v0.4.x+) for intervals.<term>.* slot mapping
  git-info.ts         # m_branch / m_gitStatus read-side helpers (cwd-based)
  session-parse.ts    # parseTokenSnapshot — stdin JSON → TokenSnapshot; m_tokenTotalIn invariant check
  token-store.ts      # append-only JSONL state file at state/<projectHash>/<sessionId>.jsonl for m_acc* / m_sum*
  __fixtures__/       # remains.real.json, balance.real.json, balance.multi.json, …
  *.test.ts           # node:test unit tests (render / api / cache / composition / lineTemplate / path-expr / status-store replay / token-store / quotes / index-parse / config)
.claude-plugin/
  plugin.json         # plugin manifest (declares commands, version, keywords)
  marketplace.json    # single-plugin marketplace wiring
commands/
  install.md          # /topgauge:install slash command
  uninstall.md        # /topgauge:uninstall slash command
  clean.md            # /topgauge:clean slash command
  clean-cache.md      # /topgauge:clean-cache slash command
scripts/
  wrapper.sh          # bash wrapper: TOPGAUGE_UPSTREAM_CMD → TOPGAUGE_UPSTREAM → us
  install.sh          # settings.json patcher (install only; uninstall went to :uninstall + uninstall.sh in v0.9.x)
  uninstall.sh        # self-contained uninstaller (used by :uninstall and dev:uninstall)
  clean.sh            # trim old .bak.<ts> files; --purge-runtime also wipes state/<projectHash>/{cache.json,diagnostics.jsonl,*.jsonl} + legacy top-level + token-samples
  clean-cache.sh      # prune old version dirs under cache/topgauge/, keep newest
  migrate-state.sh    # v0.4.x legacy state/token-samples/<hash>/<sid>.jsonl → state/<hash>/<sid>.jsonl
  dev-uninstall.sh    # DEV-ONLY thin shim → exec uninstall.sh
  lib/edit-settings.mjs  # ESM helper used by install.sh
  test-edit-settings.sh  # shell regression tests for edit-settings.mjs
  test-install.sh        # shell regression tests for install.sh (isolated tmpdir)
  test-clean-cache.sh    # shell regression tests for clean-cache.sh
settings.example.json # template (NEVER commit real settings.json)
```

## License

MIT — see [LICENSE](./LICENSE).
