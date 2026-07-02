# ToPGauge-CC — Display Modules Manual

This file documents every token you can write inside `statuslineTemplate` and
inside entries of `lineTemplates.<key>` (consumed via `m_template:<key>...`).

A template is a JSON array of tokens. Two kinds of tokens exist:

| Kind  | Shape                                                    | Meaning                                                              |
| ----- | -------------------------------------------------------- | -------------------------------------------------------------------- |
| `m_*` | Display module — produces a colored value segment.       | See the per-module table below.                                      |
| `s_*` | Separator reference — produces a literal string.         | See the separator table below.                                       |

Tokens can be written in **bare form** (`"m_window5h"`) or **inline-arg form**
(`"m_window5h:color:red"`). Bare form falls back to global config;
inline-arg form overrides per-token. A module that accepts inline args
takes its arguments as `name:value` pairs separated by colons.

---

## 1. Inline-arg syntax (applies to all `m_*` modules and `s_*`)

```
<token>[:<name>:<value>]*
```

- `:` is the separator — every module's parser splits the token on `:`.
- The first segment is the module name. Everything after is `name:value`
  pairs.
- Order of pairs doesn't matter; duplicates keep the last value.
- Unknown `name` or malformed `value` → the dispatcher warns to stderr and
  drops the token.
- Numeric `s_<n>` separators take a single argument that is **either** a
  numeric index (`s_0`, `s_1`, …) **or** a named alias (`s_space`,
  `s_dot`, `s_newline`, `s_tab`, `s_colon`).

### 1.1 Shared named parameters

Every `m_*` module that takes inline args accepts a common subset. Per-module
exceptions are called out in §3.

| Name        | Accepted values                                                 | Default            | Effect                                                                                                                |
| ----------- | --------------------------------------------------------------- | ------------------ | --------------------------------------------------------------------------------------------------------------------- |
| `color`     | SGR string OR a shortcut (`red`, `green`, `yellow`, `blue`, `cyan`, `magenta`, `white`, `gray`, `orange`, `purple`) | module's natural palette color | Replaces the module's band color. WINS over stale-color / placeholder-color.                                            |
| `nulldrop`  | `true` \| `false`                                              | `false`            | `false` → keep the placeholder slot even when data is missing (gray `n/a` / `-- unit` / empty gauge). `true` → drop on null (v0.3.x legacy behavior). |
| `display`   | `used` \| `remaining`                                          | global `display` config | **Window modules only** (`m_window5h`, `m_window7d`, `m_windowContext`). Switch between "show used %" and "show remaining %". Inline wins over config. |
| `mode`      | `plan` \| `balance`                                            | (none)             | **`m_template` only.** Filter sub-template by provider TYPE.                                                          |

### 1.2 Special: `m_quote` extras

`m_quote` extends the color parameter with three additional shortcuts:

- `rainbow` — cycles through band colors
- `rand-rainbow` — randomized rainbow
- `hue` — continuous hue based on wall-clock

It also accepts `freq:<unit-or-number-unit>` (default `h`):

| Form        | Bucket size     |
| ----------- | --------------- |
| `freq:s`    | 1 second        |
| `freq:m`    | 1 minute        |
| `freq:h`    | 1 hour (default)|
| `freq:d`    | 1 day           |
| `freq:30s`  | 30 seconds      |
| `freq:5m`   | 5 minutes       |
| …           | up to multi-digit counts (no leading zero) |

---

## 2. Separators (`s_*`)

Reference a literal from `cfg().separators`, or one of the five built-in aliases.

### 2.1 Numeric form: `s_<n>`

- `s_0` … `s_<N-1>` — index into the `separators` array in `config.json`.
- Default `separators: [" ", "·", "\n", "\t", ":"]` so `s_0` is a space, `s_1`
  is "·", etc.
- Out-of-range index → token dropped (stderr warn).
- Multiple bare `s_0` are NOT collapsed; both render.

### 2.2 Named alias form (always literal, ignores `separators` array)

| Token         | Literal     | Notes                       |
| ------------- | ----------- | --------------------------- |
| `s_space`     | `" "`       | Always a single space.      |
| `s_dot`       | `"·"`       | Middle dot (U+00B7).        |
| `s_newline`   | `"\n"`      | Line break — only useful in multi-line layouts. |
| `s_tab`       | `"\t"`      | Tab character.              |
| `s_colon`     | `":"`       | Colon.                      |

**Rule**: the named form always renders the built-in character, even if
the user has overridden array index 0 to be `"x"`. This makes
self-documenting templates (e.g. `["m_window5h", "s_space",
"m_countdown5h"]`) immune to user-config reshuffles.

### 2.3 Separator placement rules

- Adjacent separators around a dropped module are **skipped** — so a
  `null` `m_ctx` won't leave `… · · …` artifacts.
- Leading/trailing separators are trimmed at the renderer level.
- Newlines (`s_newline`) act as hard breaks: output above the break is the
  upstream section, the break itself goes into composition, and output
  below is appended.

---

## 3. Module reference (`m_*`)

The table below covers every module the renderer recognizes. The `Type`
column tells you which provider TYPE the module is gated to — modules
with no entry apply to every provider (and to provider-less ticks via
the `unknown` TYPE fallback).

| Module                   | What it renders                                                                            | Source field                                                | Type filter        | Inline args                              | Notes |
| ------------------------ | ------------------------------------------------------------------------------------------ | ----------------------------------------------------------- | ------------------ | ---------------------------------------- | ----- |
| `m_modeLabel`            | `Usage:` (plan provider) or `Balance:` (balance provider).                                | derived from `providerType`                                 | (always emits)     | `color`                                   | First item in default line templates.    |
| `m_window5h`             | Bar + colored % of 5-hour window: `▓░░░░░░░ 9%`.                                            | `fiveHour.pct` / `fiveHour.resetAt`                         | plan               | `color`, `display`, `nulldrop`            | On `stale=true`, bar dims to `STALE_COLOR`. `display:remaining` flips the % sign. |
| `m_window7d`             | Same shape for the 7-day window.                                                           | `weekly.pct` / `weekly.resetAt`                              | plan               | `color`, `display`, `nulldrop`            | Same stale / display semantics as `m_window5h`. |
| `m_countdown5h`          | `(4h47m🕔 5h)` reset countdown, with fill-state arrow.                                     | `fiveHour.resetAt`, `fiveHour.resetStartAt`, `fiveHour.resetDurationMs` | plan | `color`, `nulldrop`                        | Arrow glyph picked from `resetArrows` array by remaining-time ratio. Drops if no resetAt. |
| `m_countdown7d`          | `(2d8h🕔 7d)` reset countdown for 7-day window.                                             | `weekly.resetAt`, `weekly.resetStartAt`, `weekly.resetDurationMs` | plan | `color`, `nulldrop`                        | Same arrow semantics as `m_countdown5h`.  |
| `m_windowContext`        | Bar + colored % of context window usage (input tokens vs context_window_size).            | `tokens.contextWindow`                                       | agnostic           | `color`, `display`, `nulldrop`            | `display:used` shows how full the context is. |
| `m_balance`              | Multi-currency balance line: `Balance: CNY 110.00 · USD 5.00`.                            | `balance.entries[]`                                          | balance            | `color`, `nulldrop`                        | Color band driven by the LOWEST `totalBalance`. |
| `m_age`                  | Stale-age suffix: `🔗 5m ago` (fresh) or `⛓️‍💥 5m ago` (stale).                                | `ageMs`, `stale`                                             | agnostic           | `color`, `nulldrop`                        | Always emits once per render (ref-deduped across `m_template:` recursion). |
| `m_version`              | `v0.7.0` plugin version.                                                                   | `version` (from `.claude-plugin/plugin.json`)                | agnostic           | `color`, `nulldrop`                        | Emits nothing when version string is empty. |
| `m_label:<text>`         | Literal `<text>`.                                                                          | inline                                                      | agnostic           | (implicit text), `color`, `nulldrop`       | Single colon (`:`) inside the text is a separator — use it carefully. |
| `m_template:<key>[:mode:plan\|balance]` | Inserts the array under `lineTemplates.<key>` in place. Recursively expanded. | inline key                                                  | filtered by mode   | `mode`, `nulldrop`                         | Sub-template may itself contain `m_template:` (recursive). `mode:plan` skips for balance providers and vice versa. |
| `m_tokenIn`              | This-tick input tokens, e.g. `in:154`.                                                     | `tokens.current.inputTokens`                                 | agnostic           | `color`, `nulldrop`                        | Drops when no input tokens on this turn. |
| `m_tokenOut`             | This-tick output tokens, e.g. `out:135`.                                                    | `tokens.current.outputTokens`                                | agnostic           | `color`, `nulldrop`                        | Same as above for output.                |
| `m_tokenTotal`           | This-tick in+out, e.g. `total:289`.                                                        | `tokens.current.inputTokens + outputTokens`                 | agnostic           | `color`, `nulldrop`                        | Alias: `m_tokenSession`.                |
| `m_tokenSession`         | Same shape as `m_tokenTotal` (alias).                                                     | same                                                         | agnostic           | `color`, `nulldrop`                        | Kept for backward compatibility.         |
| `m_ctx`                  | Context usage e.g. `ctx:31.4k`.                                                            | `tokens.contextWindow.total_input_tokens`                   | agnostic           | `color`, `nulldrop`                        | Human-readable with k/M suffix.         |
| `m_cacheHitRate`         | Cache hit rate e.g. `hit:99%`.                                                             | derived from `tokens.current.cacheRead / (cacheRead + cacheCreation + input)` | agnostic | `color`, `nulldrop`                        | Drops on 0 cache activity.               |
| `m_cacheRead`            | Cache-read tokens this tick, e.g. `cache:62k`.                                             | `tokens.current.cacheReadTokens`                             | agnostic           | `color`, `nulldrop`                        |                                         |
| `m_token5h`              | Cross-tick cumulative input tokens within the last 5h window, e.g. `5h:42k`.                | `state/<projectHash>/<sid>.jsonl`                            | agnostic           | `color`, `nulldrop`                        | Requires on-disk JSONL state — older ticks before state existed show `5h:--`. |
| `m_token7d`              | Same as `m_token5h` for the 7-day window, e.g. `7d:240k`.                                   | `state/<projectHash>/<sid>.jsonl`                            | agnostic           | `color`, `nulldrop`                        | Same caveat as `m_token5h`.             |
| `m_tokenInSpeed`         | Tokens/sec over the last active tick, e.g. `in:42 t/s`.                                     | `status.json.lastActive.in` + `tickStatus.in`                | agnostic           | `color`, `nulldrop`                        | Idle tick (no current tick data) → STALE_COLOR, uses last-active cached value. |
| `m_tokenOutSpeed`        | Same for output, e.g. `out:18 t/s`.                                                         | `status.json.lastActive.out`                                 | agnostic           | `color`, `nulldrop`                        | Same idle semantics as `m_tokenInSpeed`. |
| `m_tokenInAvg`           | Session-wide average input tokens per tick.                                                | `tokens.totals.input / apiCalls`                            | agnostic           | `color`, `nulldrop`                        | Drops when apiCalls is 0.                |
| `m_tokenOutAvg`          | Session-wide average output tokens per tick.                                                | `tokens.totals.output / apiCalls`                           | agnostic           | `color`, `nulldrop`                        | Drops when apiCalls is 0.                |
| `m_totalTokenIn`         | Cumulative input tokens for the entire session.                                             | `tokens.totals.input`                                        | agnostic           | `color`, `nulldrop`                        |                                         |
| `m_totalTokenOut`        | Cumulative output tokens for the entire session.                                            | `tokens.totals.output`                                       | agnostic           | `color`, `nulldrop`                        |                                         |
| `m_totalTokenWithCacheIn`| Cumulative input + cache reads, e.g. `withCache:1.2M`.                                      | `tokens.totals.input + cacheReadTokens`                     | agnostic           | `color`, `nulldrop`                        |                                         |
| `m_quote[:freq:...][:color:...]` | A rotating quote, frequency-bucketed.                                                  | `quotes.json` (bundled)                                     | agnostic           | `freq`, `color`, `nulldrop`                | Picks a quote per bucket — `freq:h` rotates hourly, `freq:30s` rotates every 30 s. |
| `m_session`              | User-defined session name (e.g. `fix-bar-color-regressions`).                              | `tokens.sessionName`                                         | agnostic           | `color`, `nulldrop`                        | Drops when sessionName is empty.         |
| `m_model`                | Display name of the active model, e.g. `kimi-k2.6`.                                         | `tokens.modelDisplayName`                                    | agnostic           | `color`, `nulldrop`                        |                                         |
| `m_effort`               | Effort level: `low`, `medium`, `high`, `max`.                                              | `tokens.effort`                                              | agnostic           | `color`, `nulldrop`                        |                                         |
| `m_repo`                 | `host/owner/name`, e.g. `github.com/cwf818/topgauge-cc`.                                   | `tokens.workspace.repo`                                      | agnostic           | `color`, `nulldrop`                        | Drops when no repo.                      |
| `m_branch`               | Current git branch.                                                                        | `git info from cwd`                                          | agnostic           | `color`, `nulldrop`                        | Drops when not a git repo.               |
| `m_gitStatus`            | Git dirty/clean indicator.                                                                 | `git status`                                                 | agnostic           | `color`, `nulldrop`                        |                                         |
| `m_ccVersion`            | Claude Code version, e.g. `cc:2.1.191`.                                                    | `tokens.ccversion`                                            | agnostic           | `color`, `nulldrop`                        | Alias: `m_ccversion` (lowercase v).      |
| `m_sessionDuration`      | Wall-clock duration of the session, e.g. `2h 15m`.                                          | `tokens.cost.total_duration_ms`                              | agnostic           | `color`, `nulldrop`                        |                                         |
| `m_sessionApiDuration`   | API-only duration, e.g. `api:1m 23s`.                                                       | `tokens.cost.total_api_duration_ms`                          | agnostic           | `color`, `nulldrop`                        |                                         |
| `m_linesAdded`           | Lines added in the session, e.g. `+1.2k`.                                                  | `tokens.cost.total_lines_added`                              | agnostic           | `color`, `nulldrop`                        |                                         |
| `m_linesRemoved`         | Lines removed in the session, e.g. `-340`.                                                 | `tokens.cost.total_lines_removed`                            | agnostic           | `color`, `nulldrop`                        |                                         |
| `m_tokenInTotal`         | Cumulative input tokens including cache reads.                                              | `tokens.totals.input + cacheRead`                            | agnostic           | `color`, `nulldrop`                        |                                         |
| `m_tokenTotalOut`       | Session-cumulative output tokens, e.g. `out:155`.                                           | `tokens.totals.output`                                       | agnostic           | `color`, `nulldrop`                        | v0.8.0+ renamed from `m_tokenOutTotal`. |
| `m_apiCalls`             | Number of API calls made in this session, e.g. `calls:42`.                                  | `tokens.apiCount` (derived)                                  | agnostic           | `color`, `nulldrop`                        | null → `calls:0` (`:nulldrop:` is a no-op — never returns null) |
| `m_contextSize`          | Context window size, e.g. `size:200k`.                                                      | `tokens.contextWindow.context_window_size`                   | agnostic           | `color`, `nulldrop`                        |                                         |
| `m_contextUsed`          | Currently used context tokens (input+output+cache), e.g. `used:163.5k`.                    | derived                                                       | agnostic           | `color`, `nulldrop`                        |                                         |

---

## 4. Per-module type filters

The renderer tags each module with a `type` value. A module's emit is
skipped if the active provider's TYPE doesn't match.

| TYPE value | Active when                                       |
| ---------- | ------------------------------------------------- |
| `plan`     | Provider has `TYPE: "TOKEN_PLAN"`.                |
| `balance`  | Provider has `TYPE: "BALANCE"`.                   |
| `unknown`  | No provider entry matched `ANTHROPIC_BASE_URL`.   |

`agnostic` modules (everything not labeled plan/balance) emit on every
tick.

---

## 5. Drop semantics & `nulldrop` recap

| Form                                  | Behavior when underlying data is `null`                                  |
| ------------------------------------- | ------------------------------------------------------------------------ |
| `m_*` (bare)                          | DROP — module skipped, adjacent separators trimmed.                      |
| `m_*:nulldrop:false` (default inline) | PLACEHOLDER — module renders a fixed `STALE_COLOR`-wrapped body so the layout stays stable. |
| `m_*:nulldrop:true`                   | DROP — same as bare form (v0.3.x behavior preserved).                   |

Placeholder shapes per module:

| Module class           | Placeholder body                          |
| ---------------------- | ----------------------------------------- |
| pure number            | `<prefix>n/a` (e.g. `in:n/a`)             |
| number + unit          | `-- <unit>` (e.g. `5h:--`)                |
| gauge (window)         | `░░░░░░░░ 0%` (gray)                       |
| bare string            | `n/a`                                     |

`m_window5h`, `m_window7d`, and `m_windowContext` always render the gauge
shape with the `STALE_COLOR` band when stale, regardless of `display`
mode.

---

## 6. Color values accepted by `:color:`

Anything `resolveColor()` accepts. Three categories:

1. **Shortcut name** (one of: `red`, `green`, `yellow`, `blue`, `cyan`,
   `magenta`, `white`, `gray`, `orange`, `purple`) — expands to a
   built-in 256-color SGR.
2. **Raw SGR escape** (any string starting with `\x1b[`).
3. **Quote-only extras** (`m_quote` only): `rainbow`, `rand-rainbow`,
   `hue`.

`STALE_COLOR` (`\x1b[90m` = bright black) and `BROKEN_COLOR`
(`\x1b[31m` = red) are the two implicit fallback colors used when a
module's data is missing or its fetch is broken — see `colors.stale`
and `colors.broken` in `config.json`.

---

## 7. Composition with the upstream statusline

Tokens that produce a `\n` (`s_newline`, or any multi-line body) split
the rendered output into "above the break" and "below the break" chunks:

- Everything ABOVE the first newline is **prepended** to the upstream
  output (whatever `TOPGAUGE_CC_UPSTREAM` contains).
- Everything BELOW is **appended** after the upstream.

This is how `["m_template:plan:mode:plan", "\n", "m_template:balance:mode:balance"]`
renders: plan-section + newline + balance-section, sandwiched around the
upstream statusline.

---

## 8. Quick example templates

```jsonc
// Minimal: just the mode label and 5h window.
"statuslineTemplate": ["m_modeLabel", "s_0", "m_window5h"]

// Default-style (with upstream separators between modules).
"statuslineTemplate": [
  "m_modeLabel:color:yellow",
  "s_0",
  "m_window5h",
  "s_1",
  "m_window7d",
  "s_0",
  "m_age:color:gray"
]

// Plan-only with custom 5h color override:
"statuslineTemplate": [
  "m_template:plan:mode:plan",
  "s_newline",
  "m_template:balance:mode:balance"
],
"lineTemplates": {
  "plan": [
    "m_window5h:color:red:display:remaining",
    "s_space",
    "m_countdown5h",
    "s_1",
    "m_window7d",
    "s_space",
    "m_countdown7d"
  ],
  "balance": [
    "m_balance",
    "s_space",
    "m_age"
  ]
}
```