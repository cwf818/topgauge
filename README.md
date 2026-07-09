<pre>
[upstream statusline lines]
Usage: ▓▓▓▓░░░░ 40% (1h27m🕗 5h) · ▓▓░░░░░░ 20% (4d3h🕔 7d)    # Tokeplan
Balance: ￥110.00 · $3.5                                        # Balance
</pre>

# topgauge-cc

[![License](https://img.shields.io/github/license/cwf818/topgauge-cc)](LICENSE)
[![Tag](https://img.shields.io/github/tag/cwf818/topgauge-cc)](https://github.com/cwf818/topgauge-cc/tags)
[![Stars](https://img.shields.io/github/stars/cwf818/topgauge-cc)](https://github.com/cwf818/topgauge-cc/stargazers)

A provider-agnostic Claude Code statusline plugin for **token-plan usage / remaining quota**. It picks what to render from `ANTHROPIC_BASE_URL`, so the same plugin works against any supported provider's plan endpoint — no per-provider re-install. Currently supported:

- **MiniMax** — `Usage: …` / `Remain: …` (5-hour + weekly windows), from `/v1/token_plan/remains`
- **DeepSeek** — `Balance: …` (account balance), from `/user/balance`

For vanilla Anthropic, OpenRouter, or any other provider not on the list above, the plugin **hides itself** and passes any chained upstream statusline through unchanged.

We deliberately don't reimplement the kitchen-sink statuslines that already exist for vanilla Anthropic — [`claude-hud`](https://github.com/jarrodwatts/claude-hud) and [`ccstatusline`](https://github.com/sirmalloc/ccstatusline) cover that. This plugin is only the **plan / quota** piece that's provider-specific.

ANSI colors are 5-band (256-color SGR): bright green / dark green / yellow / orange / red. Applied to the displayed value + the colored bar segment; the empty part of the bar stays uncolored so it remains readable.

## What's new

- **v0.7.0 (this release)** — full rename to `topgauge-cc` (ToPGauge-CC). Package id, marketplace id, plugin name, env-var namespace, slash-command prefix, settings.json marker, state-dir path, all stderr banners, and the docs are renamed. Provider strings (`minimax`, `deepseek`, etc.) are unchanged. Users upgrading from a pre-rename install get a one-shot state-dir migration (`plugins/tokenplan-usage-hud/state/` → `plugins/topgauge-cc/state/`), and `:uninstall` recognizes BOTH the old and the new name so a clean uninstall doesn't require a manual migration first. See [CHANGELOG.md](CHANGELOG.md) for the full list.
- **v0.4.0 (in development)** — exposes 16 new statusline modules reading the captured Claude Code stdin payload: session identity (`m_session`, `m_model`, `m_effort`, `m_repo`, `m_ccVersion`), session metrics (`m_sessionDuration`, `m_sessionApiDuration`, `m_linesAdded`, `m_linesRemoved`), cumulative token counters (`m_tokenInTotal`, `m_tokenOutTotal`), context-window stats (`m_contextSize`, `m_contextUsed`, `m_windowContext`). Also: `m_tokenIn` / `m_tokenOut` and `m_tokenInSpeed` / `m_tokenOutSpeed` now read the per-turn `current_usage` fields instead of session-cumulative. **BREAKING**: the `lineTemplate: { plan, balance }` config field is removed — replaced by `lineTemplates` (registry of reusable fragments) + `statuslineTemplate` (the rendered template). See [CHANGELOG.md](CHANGELOG.md) for the full v0.4.0 list and the [Upgrading to v0.4.0](#upgrading-to-v040-from-v03x) section below for the migration recipe.

## Install

The plugin is a single-plugin marketplace. Install it in three steps:

```
/plugin marketplace add cwf818/topgauge-cc
/plugin install topgauge-cc@topgauge-cc
```

> After the plugin install, run `/reload-plugins` so the loader picks up the new commands before wiring it into `settings.json`. Forgetting this step is the most common cause of "command not found" right after install.

Then wire it into `settings.json`:

```
/topgauge-cc:install
```

This patches the active `settings.json` (user-level by default; pass `--project` for project-level):

1. If `statusLine` is already managed by us (`_topgauge_managed: true`), the command is a no-op.
2. Otherwise, the current `settings.json` is backed up to `settings.json.bak.<ISO-timestamp>`.
3. The original `statusLine.command` is preserved at `<claude-root>/plugins/topgauge-cc/state/upstream-cmd.sh` and `<claude-root>/plugins/topgauge-cc/state/upstream-cmd.txt` — sibling of `config.json`, **stable** across `/plugin install` rolls and cache wipes.
4. The `statusLine` is rewritten to invoke our wrapper, which sets `TOPGAUGE_CC_UPSTREAM_CMD=<upstream-cmd.sh>` so the original statusline runs above our line.

`install.sh` auto-builds `dist/index.js` if it's missing (the marketplace install only copies source, not the bundle). Re-running the slash command is always a no-op once installed.

If you want to preview what install will do, run `/topgauge-cc:install --dry-run` first.

If your active `settings.json` doesn't exist at the project level, install creates a minimal one (with `permissions.defaultMode: bypassPermissions`). It does **not** copy from the user-level file.

### Restore from backup

```
/topgauge-cc:install --restore
```

Replaces the active `settings.json` with the most recent `settings.json.bak.<ts>`. Useful if you want to roll back an edit that wasn't made by us.

## Commands

Four slash commands ship with the plugin:

| Command                                  | What it does                                                                                    |
| ---------------------------------------- | ----------------------------------------------------------------------------------------------- |
| `/topgauge-cc:install`           | Wire the wrapper into `settings.json` (or `--uninstall` / `--restore`).                          |
| `/topgauge-cc:uninstall`         | Restore `settings.json`, wipe cache + marketplace + loader rows.                                   |
| `/topgauge-cc:clean`             | Trim old `.bak.<ts>` files (keeps the most recent per file).                                      |
| `/topgauge-cc:clean-cache`       | Remove stale version dirs from the plugin cache, keeping only the newest.                          |

Each is a Pattern B2 slash command — the body is a `!`-fenced shell block that loads `scripts/<name>.sh` directly via `${CLAUDE_PLUGIN_ROOT}`, with `allowed-tools` scoped to that script. See [Project layout](#project-layout) for the file map.

## Uninstall

```
/topgauge-cc:uninstall
```

This is a self-contained cleanup that works even after the plugin's cache and marketplace have been wiped. It does all of the following:

1. **Restore `statusLine`** — strategy in order:
   - If `${CLAUDE_ROOT}/plugins/topgauge-cc/state/upstream-cmd.txt` exists (the stable state dir, sibling of `config.json`), restore the original command byte-for-byte from that file.
   - Else, fall back to the legacy state dir `${CLAUDE_ROOT}/plugins/tokenplan-usage-hud/state/upstream-cmd.txt` (v0.7.0 legacy dual-strip — preserved so users upgrading from a pre-rename install can still uninstall cleanly).
   - Else, fall back to the highest-version cache dir's legacy `state/upstream-cmd.txt` (v0.2.18 and older layout, before the stable state dir existed). Same ordering as the wrapper's `ls + sort + tail` resolver.
   - Else, fall back to the most recent `settings.json.bak.<ts>` whose `statusLine` does **not** have `_topgauge_managed: true` (or `_tokenplan_managed: true`, the v0.6.x marker) (the state before the plugin was installed).
   - Else, strip the marker but leave the wrapper in place and print a warning.
2. **Remove `topgauge-cc@topgauge-cc` from `settings.json.enabledPlugins`** (other plugins preserved). v0.7.0 also strips the legacy key `tokenplan-usage-hud@tokenplan-usage-hud` if present (legacy dual-strip).
3. **Remove `topgauge-cc` from `settings.json.extraKnownMarketplaces`** (Claude Code records the marketplace source there too — leaving it would re-add the marketplace on next `/plugin marketplace add` with no visible diff). v0.7.0 also strips the legacy `tokenplan-usage-hud` key if present.
4. **Wipe** `cache/topgauge-cc/`, `marketplaces/topgauge-cc/`, and the legacy `marketplaces/cwf818-topgauge-cc/` alias — AND the legacy `cache/tokenplan-usage-hud/`, `marketplaces/tokenplan-usage-hud/`, `marketplaces/cwf818-tokenplan-usage-hud/`, `plugins/tokenplan-usage-hud/state/` paths left by users upgrading from a pre-rename install.
5. **Strip the plugin's row** from `installed_plugins.json` and `known_marketplaces.json` (with timestamped `.bak.<TS>` backups). v0.7.0 also strips both old and new key shapes from each file.
6. **Trim old `.bak.<ts>` files** — invokes `scripts/clean.sh` as the final step so uninstall leaves a tidy filesystem (one newest backup per file). User-named backups like `settings.json.bak-pre-v0.1.8` are NOT touched.

`settings.json` and the two JSON files are backed up **before** any destructive change. Line endings (CRLF/LF) are preserved. The script is **idempotent** — re-running on a clean system prints `nothing to do` and exits 0. Add `--dry-run` to preview actions without modifying anything.

The `env` block of `settings.json` (including your `ANTHROPIC_AUTH_TOKEN`) is **not** touched. The script runs locally with no API calls and never reads `ANTHROPIC_AUTH_TOKEN`.

After uninstall, re-install with the four-step flow:

```
/plugin marketplace add cwf818/topgauge-cc
/plugin install topgauge-cc@topgauge-cc
/reload-plugins
/topgauge-cc:install
```

The legacy `/topgauge-cc:install --uninstall` flag still works (it's a thin shim that calls the same uninstaller). Prefer the dedicated `:uninstall` slash command in new scripts.

For dev iteration, `npm run dev:uninstall` (or `npm run dev:uninstall:dry`) does the same thing from the command line.

## Clean

```
/topgauge-cc:clean
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
/topgauge-cc:clean-cache
```

Every `/plugin install` rolls the cache forward — Claude Code creates a new `<version>` directory under `<cache>/topgauge-cc/` but does **not** remove the previous one. Old version dirs pile up over time (~40-50 MB each: full source tree + node_modules). The `statusLine.command` written by `:install` is already version-independent — it `ls -d`s every version dir, sorts by version, and `exec`s the highest — so old dirs are pure dead weight.

`/topgauge-cc:clean-cache` walks the cache, finds all `^[0-9]+\.[0-9]+\.[0-9]+(\.[0-9]+)?$` version directories, sorts numerically (so `0.2.10` sorts AFTER `0.2.9`, not lexically), keeps the newest, and removes the rest.

**Safety:** non-version entries (`.in_use`, `.orphaned_at_*`, hidden dirs, files, anything not matching the version regex) are left untouched. Idempotent: re-running is a no-op once only the newest remains. Add `--dry-run` to preview.

## How it composes with other statuslines

- The wrapper script is `scripts/wrapper.sh`. If `TOPGAUGE_CC_UPSTREAM_CMD` is set, it runs that path as a bash script (`bash "$TOPGAUGE_CC_UPSTREAM_CMD"`), captures stdout, and exposes it to the plugin entry as the `TOPGAUGE_CC_UPSTREAM` env var. If unset, the wrapper runs the plugin as the sole statusline.
- `TOPGAUGE_CC_UPSTREAM_CMD` is an **absolute path** to a bash script — `install.sh` writes one at `${CLAUDE_ROOT}/plugins/topgauge-cc/state/upstream-cmd.sh` whose body is `exec bash -c '<original-command>'`. This path is **stable** (sibling of `config.json`, NOT inside the per-version cache dir), so `/plugin install` rolls don't move it. Older v0.1.10–v0.1.11 used `bash -c` against the path itself, which silently failed — fixed in v0.1.12.
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
kept (`2h0m` → `2h0m`, NOT `2h`). See `stale.maxUnitCount` in the
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

5-band color thresholds on the **lowest** entry's numeric value:

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

`display` is MiniMax-only — DeepSeek's `Balance:` line doesn't have a percentage to flip.

## Configuration

A single JSON file parameterizes every hardcoded tunable (color thresholds, cache TTL, fetch timeout, currency prefixes, bar geometry, stale-annotation formatting, display-mode label). Path:

- **Unix**: `~/.claude/plugins/topgauge-cc/config.json`
- **Windows**: `%USERPROFILE%\.claude\plugins\topgauge-cc\config.json`

Loaded once at startup. **Missing file** → all defaults (today's behavior, bit-for-bit identical). **Malformed JSON** or a **single bad field** → one stderr line (`topgauge-cc: config <reason>; using defaults`) and the default for _that_ field only — the rest of your config is still honored. The plugin never blanks the statusline on bad config.

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
    // band cutoffs (4 ascending numbers each)
    "percentBands": [20, 40, 60, 80],
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
    // lineTemplate (e.g. add an `s_0` token after `m_window|term|mid`).
    "ageEmoji": { "healthy": "🔗", "broken": "⛓️‍💥" },
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
  "separators": [
    // Separator strings referenced from `lineTemplate` as s_0, s_1, ….
    // s_0 — between adjacent modules within a group (default: " ")
    // s_1 — the inter-group glyph (default: "·", just the symbol — no
    //       surrounding spaces; the default plan template composes
    //       s_0 + s_1 + s_0 to produce the visual " · ")
    // Add more entries to reference them as s_2, s_3, … in your
    // lineTemplate.
    " ",
    "·",
  ],
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
    // `m_template:<key>` token inside `statuslineTemplate`.
    // Default entries `plan` and `balance` point at the v0.3.x
    // defaults so existing internal lookups still resolve; they're
    // auto-merged with your custom keys (your keys win on
    // collision).
    //
    // Example: a shared `header` chunk used in both plan and
    // balance templates.
    "header": ["m_modeLabel", "s_0"]
  },
  "statuslineTemplate": ["m_template|_1line"],  // or a raw token array, e.g.:
  // ["m_template|_standard", "m_window|term|short", "s_0", "m_window|term|mid"],

  // v0.4.0+ replaces the v0.3.x `lineTemplate: { plan, balance }`
  // shape with the two fields above. See the "Upgrading to v0.4.0"
  // section below for the migration notes. The loader warns once
  // per config load and ignores the legacy field.
  "providers": {
    // v0.2.21: declarative provider registry. The plugin picks a
    // provider by matching ANTHROPIC_BASE_URL against each entry's
    // BASE_URL_COMPARED_TO using the entry's COMPARE_METHOD. The
    // first match wins; iteration order = insertion order. The TYPE
    // field ("TOKEN_PLAN" | "BALANCE") is the dispatcher — it picks
    // the fetcher, the lineTemplate key, and the fail-line label.
    //
    // Defaults reproduce the v0.2.20 hardcoded behavior bit-for-bit.
    // Adding a new provider is a config-only change; partial overrides
    // inherit missing fields from the default.
    "minimax": {
      "TYPE": "TOKEN_PLAN",
      "BASE_URL_COMPARED_TO": "https://api.minimaxi.com/anthropic",
      "COMPARE_METHOD": "EXACT",
      "ENDPOINT": "https://www.minimaxi.com/v1/token_plan/remains",
    },
    "deepseek": {
      "TYPE": "BALANCE",
      "BASE_URL_COMPARED_TO": "https://api.deepseek.com/anthropic",
      "COMPARE_METHOD": "EXACT",
      "ENDPOINT": "https://api.deepseek.com/user/balance",
    },
  },
  // Plugin version is loaded automatically at startup from
  // .claude-plugin/plugin.json and surfaced via the m_version
  // module. No config field — just add "m_version" to your
  // lineTemplate to render "v0.2.17"-style annotations.
}
```

Each `colors.*` value is either a **symbolic shortcut** (`brightGreen`, `darkGreen`, `yellow`, `orange`, `red`, `brightBlack`) or a **literal ANSI SGR string** matching `^\x1b\[[0-9;]*m$`. Strings containing newlines are rejected (statusline-injection guard).

`thresholds.*` must be exactly 4 finite ascending numbers. `bar.width` must be in `[3, 64]`. Numeric fields must be finite and (where relevant) positive. `separators` entries must be single-line strings; an entry containing `\n` is dropped (the rest of the array is preserved). `lineTemplate.<key>` must be a non-empty array of strings.

### Providers

The `providers` block is a `Record<string, ProviderEntry>`. Each entry declares:

- **`TYPE`** — `"TOKEN_PLAN"` (5h + 7d two-window line) or `"BALANCE"` (account-balance line). Drives the fetcher, the lineTemplate key, and the fail-line label.
- **`BASE_URL_COMPARED_TO`** — the URL pattern to match `ANTHROPIC_BASE_URL` against.
- **`COMPARE_METHOD`** — one of three modes, all case-insensitive:
  - `"EXACT"` (default) — `baseUrl === pattern`. Safest; rejects URLs that aren't exactly the configured value.
  - `"INCLUDE"` — `baseUrl.includes(pattern)`. Fuzzy host match; useful when `ANTHROPIC_BASE_URL` adds a path you don't care about.
  - `"STARTWITH"` — `baseUrl.startsWith(pattern)` with a suffix-attack guard: the character right after the prefix must be `undefined`, `/`, `?`, or `#`. This rejects `https://api.deepseek.com.evil.example` even though it `startsWith("https://api.deepseek.com")`. The `deepseek` matcher in earlier versions used this scheme; the v0.2.21 default is `EXACT` (a stricter choice), so users who relied on the old prefix behavior should set `COMPARE_METHOD: "STARTWITH"`.
- **`ENDPOINT`** — the provider's API URL. Must start with `http://` or `https://`.
- **`BEARER_KEY`** *(optional, v0.6.0+)* — Bearer token sent in the `Authorization` header. **Always wins** over `process.env.ANTHROPIC_AUTH_TOKEN` when present — there is no env fallback. Useful for sandboxed / CI deployments that don't carry the env var, or for giving a single proxy provider a different credential from the rest of the session. Bad values (non-string, empty string) drop just the field; the entry still loads and the fetcher falls back to the env token.
- **`METHOD`** *(optional, v0.6.0+)* — HTTP method, one of `"GET" | "POST" | "PUT" | "PATCH" | "DELETE"`. Defaults to `"GET"`. **Strict** validation: bad values (typo, wrong casing, `"OPTIONS"`, …) drop the whole entry at config-load. Use this to switch a provider's verb without rebuilding the plugin.
- **`BODY`** *(optional, v0.6.0+)* — static JSON object sent as the request body. Only meaningful when `METHOD` is not `"GET"` (POST/PUT/PATCH carry a payload; DELETE tolerates a body but most servers ignore it). Serialized with `JSON.stringify` at fetch time. Must be a plain object — arrays / strings / numbers are rejected. **No template placeholders**: BODY is intentionally a static shape so the provider config stays declarative. Bad shape drops just the field; the entry still loads.

A user can override any subset of fields on a known provider; missing fields inherit from the default. To add a new provider, append a new key:

```jsonc
{
  "providers": {
    "moonshot": {
      "TYPE": "BALANCE",
      "BASE_URL_COMPARED_TO": "https://api.moonshot.cn/anthropic",
      "COMPARE_METHOD": "EXACT",
      "ENDPOINT": "https://api.moonshot.cn/v1/users/me/balance",
    },
  },
}
```

The cache key for a provider's response is its name (so two TOKEN_PLAN providers get separate cache slots). The matcher's iteration order = insertion order of the `providers` object — the first matching entry wins on a tie.

#### HTTP request overrides (worked example)

The three new optional fields compose: `BEARER_KEY` alone shadows the env-supplied token without changing the request shape; `METHOD` alone changes the verb but sends no payload; all three together POST a static JSON body authenticated with a per-provider key. Example:

```jsonc
{
  "providers": {
    "my-proxy": {
      "TYPE": "TOKEN_PLAN",
      "BASE_URL_COMPARED_TO": "https://internal-proxy.example.com",
      "COMPARE_METHOD": "EXACT",
      "ENDPOINT": "https://internal-proxy.example.com/usage",
      "BEARER_KEY": "sk-internal-only",
      "METHOD": "POST",
      "BODY": { "team": "alpha" },
      "intervals": {
        "shortInterval": { "remainingPercent": "data.0.pct" },
        "midInterval": {},
        "longInterval": {}
      }
    }
  }
}
```

Notes on behavior:

- `BEARER_KEY` always wins. If `ANTHROPIC_AUTH_TOKEN` is set to `"env-token"` in the env and the entry has `"BEARER_KEY": "sk-internal-only"`, the wire shows `Authorization: Bearer sk-internal-only`. This is the only credential rotation point — there's no precedence list.
- A GET with `BODY` set sends no body on the wire (the WHATWG fetch impl drops it). To actually send a body, `METHOD` must be POST/PUT/PATCH (or DELETE, where most servers ignore it).
- Validation runs at config-load. A bad `METHOD` drops the entry (strict); a bad `BEARER_KEY` / `BODY` drops just the field (lenient) and the entry survives.

### Data fields the plugin reads (planned: field-mapping via `parameters`)

The plugin uses a **data-driven provider model**: each `ProviderEntry` declares a `parameters` block that maps the well-known slots the renderer needs onto path expressions evaluated against the API's JSON response. Adding a new provider is a pure config change — no TS code, no rebuild, no fork.

Anything not mapped resolves to `null`, and the renderer treats `null` as "no data for this window" (drops the chunk and skips its adjacent separators, same as today). A misconfigured path never throws — the parser logs a one-time stderr warning and the slot resolves to `null` (graceful degradation).

#### Well-known slots per `ProviderType`

**`TOKEN_PLAN` providers** (e.g. MiniMax). The renderer reads up to **three parallel intervals** — `shortInterval` (default 5h), `midInterval` (default 7d), and `longInterval` (default 30d). Each interval has the same 11-slot shape; only the configured fields need to be present, and each interval is independent. The shape is keyed by term:

| Slot                          | Required            | Type                       | Used by                                                                                | Notes                                                                                                                  |
| ----------------------------- | ------------------- | -------------------------- | -------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| `intervals.<term>.windowId`   | optional            | `"5h"` \| `"7d"` \| `"30d"` | label / id discriminator                                                              | Defaults to `{ shortInterval: "5h", midInterval: "7d", longInterval: "30d" }` when omitted.                            |
| `intervals.<term>.label`      | optional            | string                     | `<label>--` placeholder, `m_quota(<label>):…` body                                     | Defaults to `windowId`.                                                                                                |
| `intervals.<term>.usedPercent`      | one of (percent group) | number 0..100         | `m_window` bar                                                                         | The **used** percentage. Provide this OR `remainingPercent`, not both. The plugin derives the missing one via `100 - x`. |
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
      "TYPE": "TOKEN_PLAN",
      "BASE_URL_COMPARED_TO": "https://api.minimaxi.com/anthropic",
      "COMPARE_METHOD": "EXACT",
      "ENDPOINT": "https://www.minimaxi.com/v1/token_plan/remains",
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

A `TOKEN_PLAN` provider mapping for it (note the 5h window comes from the nested `usages[0].limits[0].detail.used`, and the 7d window from the top-level `usages[0].detail.used`):

```jsonc
{
  "providers": {
    "myProvider": {
      "TYPE": "TOKEN_PLAN",
      "BASE_URL_COMPARED_TO": "https://api.example.com/anthropic",
      "COMPARE_METHOD": "EXACT",
      "ENDPOINT": "https://api.example.com/v1/usage",
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
      "ENDPOINT": "https://api.deepseek.com/user/balance",
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

The line layout is declared as `statuslineTemplate` (v0.4.0+). **v0.8.14+ — `statuslineTemplate` is array-only.** The default is `["m_template|_1line"]` — the same single-line shape v0.3.x / v0.4.x / … / v0.8.13 rendered with the default `1line` preset. Use `m_template|_X` to reference a built-in preset (see [Built-in presets (v0.8.14+)](#built-in-presets-v0814) below), or write a raw token array.

- For shared / reusable fragments, register them under `lineTemplates` and pull them into `statuslineTemplate` with `m_template|<key>[|mode|<plan|balance>]`. See [`m_template`](#mtemplatekeymodenulldrop-v040) below.
- **v0.8.14+ auto-migration:** legacy string-form `statuslineTemplate` values (`"1line"`, `"standard"`, etc., from v0.4.0–v0.8.13) are auto-migrated to the equivalent `["m_template|_X"]` form with a one-shot stderr warning. To silence the warn, write the array form directly.

Three token shapes:

- **`m_<name>`** — a display module, rendered in order. Modules that have no content in the current context (e.g. `m_window|term|mid` when the midInterval data is missing) emit nothing, AND their immediately adjacent `s_N` tokens are skipped too — so a hidden window doesn't leave orphan separators in the output.
- **`s_<n>`** — a separator reference, looked up in `separators[n]`. Out-of-range references expand to `""` and trigger a one-time stderr warning.
- **Inline-args tokens** (v0.3.3+) — `m_<name>|args` (pipe-delimited since v0.7.1), `s_<n>|args` — see the [Inline-args grammar](#inline-args-grammar-v033) below for the full syntax. Lets you emit arbitrary literal text (`m_label|<string>`) and tint separators (`s_<n>|color|<c>`) without registering a new module.

Recognized modules:

| Token              | Renders                                                          |
| ------------------ | ---------------------------------------------------------------- |
| `m_modeLabel`          | The leading prefix: `modeLabels.used` (plan) or `modeLabels.balance` (DeepSeek) |
| `m_window\|term\|short\|mid\|long` (default `term=short`) | Interval bar + colored percentage (e.g. `▓▓▓░░░ 38%`). v0.9.0+ unifies the 5h/7d/30d windows under a single module family. |
| `m_countdown\|term\|short\|mid\|long` (default `term=short`) | Interval reset suffix: `(2h3m🕛 5h)` when reset time known, or `<label>:--` placeholder otherwise. |
| `m_quota\|term\|short\|mid\|long` (default `term=short`) | Quota display, e.g. `quota(5h):100/500` / `quota(5h):0/500` / `quota(5h):100/--`. Reads `intervals.<term>.usedQuota` + `.limitQuota`. v0.9.0+ new. |
| `m_balance`        | The DeepSeek balance chunk (e.g. `$25 · ￥110`), single SGR-wrapped block |
| `m_age`            | The age annotation: `🔗 5m ago` (fresh, in-template) or `⛓️‍💥 5m ago` (stale, in-template or forced fallback). Emits unconditionally when listed in the lineTemplate; returns `null` only when `ageMs` is missing. |
| `m_version`        | The plugin version: `v0.3.3` (auto-loaded from `.claude-plugin/plugin.json`) |
| `m_tokenIn`        | Per-API-call input tokens — e.g. `in:140`. **v0.4.0+ semantics**: shows `delta(current_usage.input_tokens)` when `delta(cost.total_api_duration_ms) > 0`. Otherwise (first tick, no API call, session change, regression) renders **`in:0`** — "0" reads as "tracking but nothing new this tick" rather than the more ambiguous `--`. A valid zero-delta API call (deltaIn == 0 with deltaApi > 0) also renders `in:0`. For session-cumulative, use `m_tokenInTotal`. |
| `m_tokenOut`       | Per-API-call output tokens — `out:265` (or `out:0` for all missing-data / zero-delta cases). Same semantics as `m_tokenIn`. |
| `m_tokenTotal` / `m_tokenSession` | Session cumulative total (`input + output + cache`) — e.g. `tot:163k` / `session:163k`. Two names for the same metric; pick whichever reads better in your template. |
| `m_tokenHitRate`   | Cache hit rate as a percentage with 3-band coloring (`good ≥ 80%`, `warn ≥ 50%`, `bad < 50%`) — e.g. green `cache:99%`. Reads `current_usage.{cache_read, cache_creation}`. |
| `m_tokenInSpeed`   | Per-API-call input speed — e.g. dim-gray `in:32.4 t/s`. **v0.4.0+**: math is `delta(current_usage.input_tokens) / delta(cost.total_api_duration_ms) * 1000`. Always renders — every missing-data case (first tick, no-API-call, session change, regression) **AND** the zero-token-delta case collapse to **`in:-- t/s`** rather than `0.0 t/s`. One consistent "no throughput to report" signal across all branches. |
| `m_totalTokenIn`   | Per-session running total of input tokens across valid-API-call ticks — e.g. `in:340`. **v0.4.0+**: reads the same `tickAvg:<sessionId>` cache slot as `m_tokenInAvg`'s numerator; `AvgSnapshot` is extended with `sumCache` to accommodate the cache-read module below. Only `delta_api > 0` ticks contribute; idle and regression ticks don't accumulate. Always renders — `in:0` when no valid tick has accumulated yet. |
| `m_totalTokenOut`  | Same for output tokens — e.g. `out:265`. |
| `m_totalTokenWithCacheIn` | Per-session running total of `cache_read_input_tokens` across valid-API-call ticks — e.g. `cache:490k`. Renders `cache:--` when stdin lacks `current_usage.cache_read_input_tokens` (honest "data unavailable" signal); `cache:0` when no valid tick has accumulated yet. |
| `m_quote`          | An inspirational short quote from a 100+ entry bilingual pool (English + 中文). See the [m_quote section](#m_quote-v036) below for the `:freq:` and `:color:` parameters. |

**v0.4.0+ session-info / metadata modules** (read the live stdin payload
captured by `/statusline`):

| Token                    | Renders                                                          |
| ------------------------ | ---------------------------------------------------------------- |
| `m_session`              | The session name — e.g. `strip-diagnostics-display`. Reads stdin `session_name`. |
| `m_model`                | The model display name — e.g. `MiniMax-M3`. Reads stdin `model.display_name`. |
| `m_effort`               | The effort level — e.g. `high`. Reads stdin `effort` (accepts string or `{level}` object). |
| `m_repo`                 | Repository identity — e.g. `github.com/cwf818/topgauge-cc`. Reads stdin `workspace.repo.{host, owner, name}`, drops null components. |
| `m_ccVersion`            | The Claude Code CLI version — e.g. `2.1.191`. Reads stdin `version`. |
| `m_sessionDuration`      | Elapsed session time — e.g. `20h42m`. Reads stdin `cost.total_duration_ms` in `1d2h3m` format. |
| `m_sessionApiDuration`   | API-call time within the session — e.g. `2h18m`. Reads stdin `cost.total_api_duration_ms`. |
| `m_linesAdded`           | Session-cumulative lines added — e.g. `+ 3965` (with leading space). Reads stdin `cost.total_lines_added`. |
| `m_linesRemoved`         | Session-cumulative lines removed — e.g. `- 967`. Reads stdin `cost.total_lines_removed`. |
| `m_tokenInTotal`         | Session-cumulative input tokens — e.g. `in:163k`. **v0.4.0**: new module, replaces the pre-v0.4.0 `m_tokenIn` semantic. Reads stdin `context_window.total_input_tokens`. |
| `m_tokenTotalOut`       | Session-cumulative output tokens — e.g. `out:155`. Reads stdin `context_window.total_output_tokens`. **v0.8.0**: renamed from `m_tokenOutTotal` so it sits in the `totalOut` family alongside `totalOut` on-disk / `m_accTokenOut` / `m_sumTokenOut`. |
| `m_contextSize`          | Context window size (compact) — e.g. `size:200.0k`. Reads stdin `context_window.context_window_size`. |
| `m_contextUsed`          | Context used percentage — e.g. `used:63%`. Reads stdin `context_window.used_percentage`. |
| `m_windowContext`        | Context bar + 5-band-colored percentage, parallel to `m_window|term|short` / `m_window|term|mid` — e.g. `▓▓▓▓▓░░░ 63%`. Synthesized from `used_percentage`. |
| `m_template:<key>` (v0.4.0+) | Expand a `lineTemplates[<key>]` fragment into the current render. See [`m_template`](#mtemplatekeymodenulldrop-v040) below. |

**Visibility of `m_age` (priority: template-driven, stale fallback):**
- If your `lineTemplate` includes `m_age`, the module emits **unconditionally** (no stale gating). Emoji reflects the fetch state: `🔗 X ago` on fresh ticks (showing the cache age), `⛓️‍💥 X ago` on stale (showing time since last successful fetch). Hidden only when `ageMs` is missing.
- If your `lineTemplate` does NOT include `m_age`, the **stale fallback** kicks in: when the fetch result is **stale** (network failure with a cached value), the broken-chain annotation is appended to the rendered line. On fresh ticks, no annotation is shown — the broken-chain indicator is reserved for real outages. The dedup check looks for any `" ago"` tail on the rendered lines, so a user who *does* include `m_age` in their template gets exactly one annotation, not two.

### Inline-args grammar (v0.3.3+)

Token forms that take colon-delimited parameters:

| Token form                  | Required params         | Optional params | Description |
| --------------------------- | ----------------------- | --------------- | ----------- |
| `m_label:<string>`          | `string` (literal text) | `color`         | Emit `<string>` verbatim, optionally wrapped in `<color>` SGR. |
| `m_modeLabel[:color:<c>]`   | (string from `ctx`)     | `color`         | Same as today's bare `m_modeLabel`, optionally tinted. The string is derived from `modeLabels.used`/`remaining`/`balance` based on `ctx.mode` and `ctx.balance`. |
| `s_<n>[:color:<c>]`         | `index`                 | `color`         | The separator at index `n` (from `separators[]`), optionally tinted. |
| `m_<name>[:color:<c>]` (v0.3.4+, any module) | — | `color` | Tint the natural output of any other module. See [Per-module `:color:` override](#per-module-color-override-v034) below. |

The grammar after the prefix is `<param1>:<value1>[:<param2>:<value2>…]`. The **first segment is the value of the implicit first parameter** (`string` for `m_label`, `index` for `s_<n>`); subsequent segments come in `name:value` pairs. Both halves are validated against the per-prefix schema (`INLINE_SCHEMAS` in `src/render.ts`); any malformed token is dropped with a one-shot stderr warn.

`<color>` accepts either a shortcut name (`brightGreen`, `darkGreen`, `yellow`, `orange`, `red`, `stale`, `brightBlack`) or a raw SGR string (`\x1b[36m`). Anything else triggers the same one-shot warn.

The bare forms (`m_modeLabel`, `s_0`, `m_window|term|short`, `m_tokenIn`, …) keep working exactly as today — the inline-args path only fires when the token contains `:`. So upgrading to v0.3.4 does NOT change the default `lineTemplate` output. Examples (opt-in — add to your `lineTemplate` to enable):

```jsonc
{
  "lineTemplate": {
    "plan": [
      "m_modeLabel:color:brightGreen",  // tint the leading Usage: prefix
      "s_0",                            // plain space (no color)
      "m_window|term|short", "s_0", "m_countdown|term|short",
      "s_0:color:darkGreen",            // tint the middle separator
      "s_1", "s_0",
      "m_window|term|mid", "s_0", "m_countdown|term|mid"
    ],
    "balance": [
      "m_label:$:color:yellow",         // emit "$" in yellow, then space, then balance
      "s_0",
      "m_balance"
    ]
  }
}
```

### Per-module `:color:` override (v0.3.4+)

Every existing module — `m_window|term|short`, `m_window|term|mid`, `m_countdown|term|short`, `m_countdown|term|mid`, `m_balance`, `m_age`, `m_version`, `m_tokenIn`, `m_tokenOut`, `m_tokenTotal`, `m_tokenSession`, `m_ctx`, `m_tokenHitRate`, `m_cacheRead`, `m_token5h`, `m_token7d`, `m_tokenInSpeed`, `m_tokenOutSpeed`, `m_tokenInAvg`, `m_tokenOutAvg`, `m_totalTokenIn`, `m_totalTokenOut`, `m_totalTokenWithCacheIn`, plus the v0.4.0+ session-info modules (`m_session`, `m_model`, `m_effort`, `m_repo`, `m_ccVersion`, `m_sessionDuration`, `m_sessionApiDuration`, `m_linesAdded`, `m_linesRemoved`, `m_tokenInTotal`, `m_tokenTotalOut`, `m_contextSize`, `m_contextUsed`, `m_windowContext`) — also accepts an optional `:color:<c>` segment. Two cases:

- **Plain-text modules** (e.g. `m_version`, `m_tokenIn`, `m_countdown|term|short`, `m_ctx`): the override simply wraps the natural output in `<color>…<RESET>` SGR. The module's own body is unchanged.
- **Already-colored modules** (e.g. `m_window|term|short`, `m_balance`, `m_tokenHitRate`, `m_cacheRead`, `m_age`, `m_tokenInSpeed`, `m_tokenOutSpeed`): the override **replaces** the natural color choice — band-based, cache-hit-band, or fixed `stale` color — with your `<color>`. The user's color always wins; if you didn't say `:color:`, the module keeps its existing coloring and the default `lineTemplate` output is byte-for-byte identical to v0.3.3.

Conflict rule: **if a `:color:` is supplied, the natural color is ignored** (per your spec — "如果与现有颜色方案冲突，则无视该参数" — the override always wins when present).

Examples:

```jsonc
{
  "lineTemplate": {
    "plan": [
      "m_modeLabel:color:brightGreen",   // tint the leading prefix
      "s_0",
      "m_window|term|short|color:red",            // force the 5h bar/percent to red
      "s_0", "m_countdown|term|short",
      "s_0", "s_1", "s_0",
      "m_window|term|mid", "s_0", "m_countdown|term|mid",
      "s_0", "m_age:color:yellow",       // tint the stale annotation
      "s_0", "m_tokenIn:color:darkGreen" // tint the session input-token chunk
    ],
    "balance": ["m_modeLabel", "s_0", "m_balance:color:red"]
  }
}
```

The bare forms (`m_window|term|short`, `m_age`, `m_tokenIn`, …) still go through the original `MODULES` path, so users on the default template see no diff on upgrade.

**Extension point:** future parameterized modules (`m_model:...`, …) plug in by adding an entry to `INLINE_SCHEMAS` and `INLINE_RENDERERS` in `src/render.ts`. No new top-level config keys needed.

### Per-module `:display:` override (v0.4.0+, window modules only)

The three window modules — `m_window|term|short`, `m_window|term|mid`, `m_windowContext` — accept an optional `:display:used` or `:display:remaining` segment. This is the **per-module** counterpart to the top-level `display` config field: it overrides which side of the bar gets colored and which percentage is shown, but only for the one module that uses it. The global config is untouched.

| Token | What it does |
| ----- | ------------ |
| `m_window|term|short|display|used` | 5h bar in `used` mode (same as bare when `display=used` in config) |
| `m_window|term|short|display|remaining` | 5h bar in `remaining` mode (inverts percentage; uses the remaining-mode palette) |
| `m_window|term|mid|display|used` / `:remaining` | Same, for the 7d window |
| `m_windowContext:display:used` / `:remaining` | Same, for the context window |

The bare forms are byte-for-byte unchanged — the global `display` config (default `used`) still drives them. Combine with `:color:` for both axes:

```jsonc
{
  "lineTemplate": {
    "plan": [
      "m_modeLabel", "s_0",
      "m_window|term|short|display|remaining:color:yellow", "s_0", "m_countdown|term|short",
      "s_0", "s_1", "s_0",
      "m_window|term|mid|display|remaining:color:yellow", "s_0", "m_countdown|term|mid"
    ],
    "balance": ["m_modeLabel", "s_0", "m_balance"]
  }
}
```

Valid values are exactly `used` or `remaining` (case-sensitive). `display:USED`, `display:` (empty), or any other value is a parse-fail — the token is dropped and the standard one-shot "unknown lineTemplate module" warn fires.

**Note:** the remaining-mode palette is the *reverse* of the used-mode palette: high remaining = healthy = brightGreen, low remaining = red. So `m_window|term|short|display|remaining` at 38% used renders 62% in the band-3 remaining color (darkGreen) — not the band-3 used color (orange). See [`formatOneChunk` / `splitBar`](src/render.ts) for the exact mapping.

### `m_template:<key>[:mode:<plan|balance>]` (v0.4.0+)

Pulls a registered fragment from `lineTemplates` into the rendered template. Use it to share chunks (e.g. a `Usage:` / `Balance:` label, a separator) across plan and balance templates without duplicating tokens.

**Token forms**

| Token form | Required params | Optional params | Description |
| ---------- | --------------- | --------------- | ----------- |
| `m_template:<key>`             | `key` (the `lineTemplates` entry to expand) | `mode` (default `plan`), `nulldrop` (accepted, no-op for this module) | Expand the registered fragment into the current render. |
| `m_template:<key>:mode:plan`   | `key`               | `nulldrop` | Same, but the chunk only renders when the provider's mode key is `plan`. |
| `m_template:<key>:mode:balance`| `key`               | `nulldrop` | Same, but only renders when the provider's mode key is `balance`. |

**Behavior:**

- **Missing key** → warns once and drops the chunk (same as any unknown module).
- **Mode mismatch** → silently drops (no warn). The user explicitly asked for a mode filter, so no error is needed.
- **Nesting is impossible**: the loader strips any `m_template:` tokens from `lineTemplates` entries at load time. A `lineTemplates` value cannot contain another `m_template:` token, so recursion cannot happen.
- **`:color:` is silently ignored on `m_template`**: put `:color:` on the inner modules if you want per-module coloring. Color propagation across expanded templates was deferred (the cost/complexity didn't justify the feature).

**Example — share a label across both providers:**

```jsonc
{
  "lineTemplates": {
    "header": ["m_modeLabel", "s_0"]
  },
  "statuslineTemplate": [
    "m_template:header:mode:plan",  // visible only on plan providers (TOKEN_PLAN)
    "m_window|term|short", "s_0", "m_countdown|term|short",
    "s_2",
    "m_tokenIn"
  ]
  // On a DeepSeek provider the header chunk drops (mode:plan ≠ balance)
  // and the renderer falls through to the default balance rendering
  // (BALANCE_PRESETS["simple"] = ["m_modeLabel", "s_0", "m_balance"]).
}
```

### Built-in presets (v0.8.14+)

The seven plan + two balance presets are now first-class entries in `lineTemplates` with `_`-prefixed keys. Use `m_template|_X` (with an optional `|mode|<plan|balance>` to constrain dispatch) to reference them from your `statuslineTemplate` array.

| Key                       | Lines | Description                                                                           | Default mode |
| ------------------------- | ----- | ------------------------------------------------------------------------------------- | ------------ |
| `_1line` / `_simple`      | 1     | Token-plan only, single line (aliases of each other — byte-identical)                 | `plan`       |
| `_simple-alone`           | 1     | Single line with an explicit `"Usage:"` label prefix (for solo use, no upstream)      | `plan`       |
| `_standard`               | 2     | Line 0 = token-plan, line 1 = context + tokens (no session line — pair with upstream) | `plan`       |
| `_standard-alone`         | 3     | Adds session info on line 0 (for solo use, no upstream chain)                         | `plan`       |
| `_abundant`               | 4     | Line 0 = session + git (deep git workflow)                                            | `plan`       |
| `_complete`               | 5     | Adds totals on line 3 (verbose — not recommended)                                     | `plan`       |
| `_balance_simple`         | 1     | Default balance render (`"Balance: <balance>"`)                                       | `balance`    |
| `_balance_simple-alone`   | 1     | Balance render with explicit `"Balance:"` label prefix (for solo use)                 | `balance`    |

**Provider-aware dispatch (v0.8.14+):** `m_template` takes an optional `|mode|<plan|balance>` second arg. `m_template|_standard` (the default — `mode:plan`) silently drops on a BALANCE provider (DeepSeek) — use `m_template|_balance_simple|mode|balance` instead. Pick the preset matching your provider's TYPE.

**`_`-prefix is reserved:** user-defined `lineTemplates._*` entries whose name collides with a built-in key are rejected with a warning (the built-in wins). Use a different key for user presets (e.g. `my1line`).

### Upgrading to v0.8.14 from v0.8.13

`statuslineTemplate` is now **array-only**. Pre-v0.8.14 string-form preset-name values (`"1line"`, `"standard"`, etc.) auto-migrate to the equivalent `["m_template|_X"]` form with a one-shot stderr warning:

```diff
- "statuslineTemplate": "standard",
+ "statuslineTemplate": ["m_template|_standard"],
```

To silence the warn, write the array form directly. **Balance-provider users on the default render** (DeepSeek) need an explicit migration — pre-v0.8.14, `statuslineTemplate: "1line"` silently fell back to the balance preset on a BALANCE provider; v0.8.14+ drops the chunk instead. Set `statuslineTemplate: ["m_template|_balance_simple|mode|balance"]` for a DeepSeek render.

### Upgrading to v0.4.0 from v0.3.x

The `lineTemplate: { plan, balance }` config field is **removed** in v0.4.0. The loader emits one `topgauge-cc: config lineTemplate is removed in v0.4.0; use lineTemplates + statuslineTemplate. See CHANGELOG.md for the upgrade path. Ignoring the legacy field.` warning per config load and ignores the legacy field — there is **no auto-promotion** of `lineTemplate.plan` → `lineTemplates.plan`.

To migrate a customized `lineTemplate`:

```diff
- "lineTemplate": {
-   "plan":   ["m_modeLabel", "s_0", "m_window|term|short", "s_0", "m_countdown|term|mid"],
-   "balance": ["m_modeLabel", "s_0", "m_balance"]
- }
+ "lineTemplates": {
+   // Optional — only needed if you want to share fragments.
+   // The renderer reads `statuslineTemplate` first; if you don't
+   // need shared chunks, just set `statuslineTemplate` below and
+   // skip this block.
+ },
+ "statuslineTemplate": [
+   "m_modeLabel", "s_0",
+   "m_window|term|short", "s_0", "m_window|term|mid"
+ ]
```

The default `statuslineTemplate` is `["m_template|_1line"]`, which reproduces the v0.3.6 default rendering — only customized configs require manual migration. To switch presets, set `"statuslineTemplate": ["m_template|_standard"]` / `["m_template|_abundant"]` / `["m_template|_complete"]` (the full list lives in `DEFAULT_LINE_TEMPLATES` at the top of `src/config.ts` with `_`-prefixed keys; see [Built-in presets (v0.8.14+)](#built-in-presets-v0814)).

### `m_quote` (v0.3.6+)

An inspirational short quote, drawn from a 100+ entry bilingual pool (English + 中文). Opt-in — the default `lineTemplate` does NOT include it; add it where you want it.

**Token forms**

| Form                            | Default freq | Default color | Description |
| ------------------------------- | ------------ | ------------- | ----------- |
| `m_quote`                       | `h`          | none          | Plain quote, no SGR wrap. |
| `m_quote:freq:<numeric-time>`   | (the one supplied) | none | Pick how often the quote rotates (see below). |
| `m_quote:color:<c>`             | `h`          | (the one supplied) | Tint the quote (see below). |
| `m_quote:freq:<…>:color:<…>`    | —            | —             | Combine both. |

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

Accepts the standard 7 shortcuts (`brightGreen`, `darkGreen`, `yellow`, `orange`, `red`, `stale`, `brightBlack`), any raw SGR string (`\x1b[36m`), and three special values unique to `m_quote`:

| Color value     | Effect |
| --------------- | ------ |
| `rainbow`       | Per-character 256-color SGR using a 6-hue palette (cyan → blue → purple → magenta → orange → yellow). Rotates through the palette for each character of the quote. |
| `rand-rainbow`  | Same as `rainbow`, but the palette rotation starts at a different offset. Two adjacent `freq` windows with the same quote but different `rand-rainbow` renders will look distinct. |
| `hue`           | Single-hue SGR wrap for the whole quote. The hue is picked from the 6×6×6 256-color cube using a hash of the quote text, so each quote gets a deterministic but varied color. |

Rainbow / rand-rainbow / hue colors are also stable within a `freq` window — same window, same colors — so a tick-by-tick refresh of the statusline never visually strobes.

**Example template**

```jsonc
{
  "lineTemplate": {
    "plan": [
      "m_modeLabel", "s_0",
      "m_window|term|short", "s_0", "m_countdown|term|short",
      "s_0", "s_1", "s_0",
      "m_window|term|mid", "s_0", "m_countdown|term|mid",
      "s_2",                              // newline separator (see "Module tokens")
      "m_quote:freq:12h:color:rainbow"   // twice-daily rotating rainbow quote
    ],
    "balance": ["m_modeLabel", "s_0", "m_balance", "s_2", "m_quote:color:hue"]
  }
}
```

**Behavior notes**

- The pool has 110+ entries; the renderer is deterministic per `(freq, nowMs)` so the same window always shows the same quote. No `Math.random` / no `Date.now` inside the renderer.
- An invalid `freq` value (e.g. `m_quote:freq:yearly`, `m_quote:freq:2h10m`) drops the token with a one-shot stderr warn.
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

### Token usage (v0.4.0+)

In addition to the tokenplan 5h/7d window percentages, the plugin reads Claude Code's session JSON from stdin and exposes a **suite of opt-in `m_token*` modules**. The default `lineTemplate` does NOT include any token module — existing v0.3.x configs render byte-identical after upgrade. To opt in, add the desired modules to your `lineTemplate.plan` (and/or `balance`).

**Available data sources** (parsed once per tick from stdin, zero IO):

- `context_window.total_input_tokens` / `total_output_tokens` — session cumulative
- `context_window.current_usage.{input_tokens, output_tokens, cache_creation_input_tokens, cache_read_input_tokens}` — post-turn snapshot
- `cost.total_duration_ms` — session wall-clock duration (used by speed modules)
- `session_id`, `cwd`, `transcript_path` — used to scope the state file for 5h/7d modules

**Persistent state file** (only for `m_token5h` / `m_token7d`): one JSON line per tick, appended to `~/.claude/plugins/topgauge-cc/state/<projectHash>/<sessionId>.jsonl` (v0.4.x+ Per-Project Layout; was `state/token-samples/<hash>/<sid>.jsonl` in v0.4.0–v0.4.<n-1>). ~120B per row, ~700KB over 7d. Lives in the stable `state/` directory — survives cache rolls and version bumps. Legacy `state/token-samples/<hash>/<sid>.jsonl` files can be preserved across an upgrade with `bash scripts/migrate-state.sh` (preview with `--dry-run`).

**Example template** with token counts alongside the windows:

```jsonc
{
  "lineTemplate": {
    "plan": [
      "m_modeLabel", "s_0",
      "m_window|term|short", "s_0", "m_countdown|term|short",
      "s_0", "s_1", "s_0",
      "m_window|term|mid", "s_0", "m_countdown|term|mid",
      "s_0", "s_1", "s_0",
      "m_tokenIn", "s_0", "m_tokenOut", "s_0", "m_ctx",
      "s_0", "m_tokenHitRate",
    ],
  }
}
```

Renders (example): `Usage: ▓░░░░░░░ 9% (4h47m🕔 5h) · ▓▓░░░░░░ 25% (2d8h🕔 7d) · in:163.5k out:155 ctx:163.5k cache:100.0%`

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

**Module reference:** see the [Module tokens](#module-tokens) table above for the full `m_token*` list with output examples. The full design rationale (data source choice, slice strategy, color policy, state file shape) lives at `memory/token-usage-design-adr.md` in the source repo.

**Show only the 5-hour window** (drop the 7-day window):

```json
{
  "lineTemplate": {
    "plan": ["m_modeLabel", "s_0", "m_window|term|short", "s_0", "m_countdown|term|short"],
    "balance": ["m_modeLabel", "s_0", "m_balance"]
  }
}
```

**Custom inter-window separator** (e.g. ` / ` instead of ` · `):

```json
{
  "separators": [" ", " / "],
  "lineTemplate": {
    "plan": [
      "m_modeLabel", "s_0",
      "m_window|term|short", "s_0", "m_countdown|term|short",
      "s_0", "s_1", "s_0",
      "m_window|term|mid", "s_0", "m_countdown|term|mid"
    ],
    "balance": ["m_modeLabel", "s_0", "m_balance"]
  }
}
```

**Show the plugin version** at the end of the line:

```json
{
  "lineTemplate": {
    "plan": [
      "m_modeLabel", "s_0",
      "m_window|term|short", "s_0", "m_countdown|term|short",
      "s_0", "s_1", "s_0",
      "m_window|term|mid", "s_0", "m_countdown|term|mid",
      "s_0", "m_version"
    ],
    "balance": ["m_modeLabel", "s_0", "m_balance", "s_0", "m_version"]
  }
}
```

### Migration from `TOKENPLAN_DISPLAY` / `TOPGAUGE_CC_DISPLAY`

If you previously set `TOKENPLAN_DISPLAY=remaining` (pre-v0.2.0) or
`TOPGAUGE_CC_DISPLAY=remaining` in your shell, move that value into
`config.json`:

```bash
mkdir -p ~/.claude/plugins/topgauge-cc
echo '{ "display": "remaining" }' > ~/.claude/plugins/topgauge-cc/config.json
```

Restart Claude Code (or run `/reload-plugins`) for the change to take effect.

## Diagnostics log

When the plugin encounters something worth telling you about — a malformed
config field, a fetcher that returned an unexpected status code — it can
append a JSONL entry to:

```
~/.claude/plugins/topgauge-cc/state/<projectHash>/diagnostics.jsonl
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
```

Use it as a postmortem trail — `tail -f` while debugging, or `grep` by level
and source when something went wrong yesterday. JSONL is greppable and
structured (timestamp + level + source + message).

### Opt-in gate

The log is **OFF by default** — set `TOPGAUGE_CC_DIAGNOSTICS_ENABLE=1` (or
`true` / `yes`, case-insensitive) in your shell to enable file writes:

```bash
export TOPGAUGE_CC_DIAGNOSTICS_ENABLE=1
```

The rationale: the file lives in your plugins dir and may contain sensitive
fragments (config paths, error text from upstream libraries). We don't write
unless you explicitly ask. The stderr noise for append failures stays
independent of the gate — silent when the write succeeds, present when it
doesn't.

### Size policy

Capped at the last 200 entries (~40KB). Anything older than 200 events is
uninteresting by definition — we just want a tail. Trim is best-effort and
runs after every append.

### Wiping the log

`/topgauge-cc:clean --purge-runtime` walks every
`state/<projectHash>/` subdir and wipes its `diagnostics.jsonl`,
`cache.json`, and `<*.jsonl>` token-sample files (v0.4.x+ Per-Project
Layout). It also cleans the legacy top-level `state/diagnostics.jsonl`,
`state/cache.json`, and the legacy `state/token-samples/` tree for users
upgrading from v0.4.0–v0.4.<n-1>. Top-level `upstream-cmd.{sh,txt}` and
`config.json` are NEVER purged. Preview first with
`/topgauge-cc:clean --purge-runtime --dry-run`.

## Auth

The plugin reuses `process.env.ANTHROPIC_AUTH_TOKEN` to call the provider's plan endpoint. **No new env vars.** See [SECURITY.md](./SECURITY.md) for how the token is handled.

## Caching

The Claude Code statusline is updated in response to interaction events by default (every prompt, every tool result). Starting with **Claude Code 2.1.97**, the `statusLine.refreshInterval` field is honored, letting the statusline refresh on a fixed cadence instead. Two scopes of "refresh interval" are involved and they're independent:

- **This plugin's 60 s TTL** — how long we cache a successful API response before re-fetching. MiniMax and DeepSeek have different rate-limit policies and refresh cadences; 60 s is a deliberate default that keeps the statusline responsive without hammering the API. Cache entries are shadowed to disk under `state/<projectHash>/cache.json` (sibling of `config.json`, wiped by `:uninstall`; v0.4.x+ Per-Project Layout — was `state/cache.json` in v0.4.0–v0.4.<n-1>), so the TTL is honored **across per-tick child-process spawns** — the second tick within 60 s reuses the first tick's value instead of re-fetching. Per-project isolation: `render.ts` prefixes every cache key with `<projectHash>:` so different projects never collide on the same `cache.json`. (v0.7.0: state dir renamed from `plugins/tokenplan-usage-hud/state/` to `plugins/topgauge-cc/state/`.)
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

### Response shape

The MiniMax parser reads from the `intervals.<term>.<field>` slot map (see [Well-known slots](#well-known-slots-per-providertype) above). For each of the three term slots (`shortInterval` / `midInterval` / `longInterval`), the parser:

1. **Resolves the path** at `intervals.<term>.<field>` against the parsed JSON (the same path-expression grammar as the v0.4.x parser, with array-index and dot-notation support).
2. **Derives missing values** per group:
   - **Percent group** (`usedPercent` / `remainingPercent`): at least one required; if both provided, `usedPercent` wins; if only one is given, the other is derived as `100 - x`.
   - **Time group** (`startAt` / `endAt` / `intervalMs` + `intervalS`): at least two of the three required. If `startAt` + `endAt` are present, they win (explicit > derived); otherwise, missing third field is derived from the other two. If only one is provided, the time group collapses to all-null.
   - **Quota group** (`usedQuota` / `limitQuota` / `remainingQuota`): each is independent — render rules are per-field (see `m_quota` in §3).
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

The plugin picks the entry with the **lowest interval remaining %** as the source of truth (the most-active model). If you capture a fresh response and the shape diverges, save it as `src/__fixtures__/remains.real.json` and tighten the parser in `src/api.ts`.

The DeepSeek response shape is simpler — `{ is_available: bool, balance_infos: [{ currency, total_balance, granted_balance, topped_up_balance }, ...] }` — and the parser iterates **all** entries so every currency the account holds is rendered.

### Dev loop: re-installing the plugin from scratch

When iterating on the install flow (changes to `scripts/install.sh`, `scripts/uninstall.sh`, the slash commands, the version, etc.) you need to fully wipe the plugin's on-disk state before `/plugin install` will re-fetch a clean copy. The plugin loader caches marketplace state and refuses to bump an already-installed plugin — on Windows this surfaces as `EPERM: operation not permitted, rename ... -> ... .bak`.

Use the bundled dev helper (does **not** touch `settings.json` — your statusLine is preserved):

```bash
# Preview what will be removed:
npm run dev:uninstall:dry

# Wipe topgauge-cc state:
npm run dev:uninstall
```

It removes:

- the topgauge row from `installed_plugins.json` and `known_marketplaces.json` (with timestamped `.bak.<ts>` backups of both files). v0.7.0: also strips the legacy `tokenplan-usage-hud` keys if present.
- `cache/topgauge-cc/`, `marketplaces/topgauge-cc/`, and the loader's leftover `marketplaces/cwf818-topgauge-cc/` directory. v0.7.0: also wipes the legacy `cache/tokenplan-usage-hud/`, `marketplaces/tokenplan-usage-hud/`, and `plugins/tokenplan-usage-hud/state/` paths.

Then re-install:

```
/plugin marketplace add cwf818/topgauge-cc
/plugin install topgauge-cc@topgauge-cc
/reload-plugins
/topgauge-cc:install
```

If the loader still says "EPERM" after `dev:uninstall`, the most common cause is a Claude Code process holding a file lock on the marketplace dir. **Quit all running Claude Code sessions** (not just this one) and re-run `npm run dev:uninstall`.

## Project layout

```
src/
  index.ts            # entry — stdin drain, provider dispatch, cache, render, compose
  types.ts            # Provider = string | null; ProviderType / CompareMethod / ProviderEntry
  providers.ts        # URL matching, fetcher / template / fail-label dispatch (v0.2.21)
  api.ts              # MiniMax fetch + tolerant parser for /v1/token_plan/remains
  api.deepseek.ts     # DeepSeek fetch + parser for /user/balance
  render.ts           # pure: pctBar + ANSI color thresholds + formatLine + formatBalanceLine
  cache.ts            # 60s TTL + stale-on-error; getWithAge returns cache age on within-TTL hit
  composition.ts      # reads TOPGAUGE_CC_UPSTREAM, prepends (preserving ANSI/multi-line) and appends line
  diagnostics.ts      # JSONL append logger (opt-in via TOPGAUGE_CC_DIAGNOSTICS_ENABLE)
  token-store.ts      # append-only JSONL state file for m_token5h / m_token7d (v0.4.0+)
  __fixtures__/       # remains.real.json, balance.real.json, balance.multi.json, …
  *.test.ts           # node:test unit tests
.claude-plugin/
  plugin.json         # plugin manifest (declares commands)
  marketplace.json    # single-plugin marketplace wiring
commands/
  install.md          # /topgauge-cc:install slash command
  uninstall.md        # /topgauge-cc:uninstall slash command
  clean.md            # /topgauge-cc:clean slash command
  clean-cache.md      # /topgauge-cc:clean-cache slash command
scripts/
  wrapper.sh          # bash wrapper: TOPGAUGE_CC_UPSTREAM_CMD → TOPGAUGE_CC_UPSTREAM → us
  install.sh          # settings.json patcher (install + thin shim for --uninstall)
  uninstall.sh        # self-contained uninstaller (used by :uninstall and dev:uninstall)
  clean.sh            # trim old .bak.<ts> files; --purge-runtime also wipes state/<projectHash>/{cache.json,diagnostics.jsonl,*.jsonl} + legacy top-level + token-samples
  lib/edit-settings.mjs  # ESM helper used by install.sh
  dev-uninstall.sh    # DEV-ONLY thin shim → exec uninstall.sh
settings.example.json # template (NEVER commit real settings.json)
```

## License

MIT — see [LICENSE](./LICENSE).
