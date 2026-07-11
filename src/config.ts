// User-tunable configuration for topgauge-cc (ToPGauge-CC).
//
// Loaded once at startup from
//   ~/.claude/plugins/topgauge-cc/config.json
// (Windows: %USERPROFILE%\.claude\plugins\topgauge-cc\config.json).
//
// Missing file → DEFAULT_CONFIG silently. Malformed JSON or a single
// bad field → one stderr line + DEFAULT_CONFIG. Never crashes.
//
// Precedence: config.json > hardcoded defaults. The earlier
// TOPGAUGE_CC_DISPLAY env var is gone — anyone who used it must migrate
// to config.json's `display` field (see README "Configuration").

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type {
  CompareMethod,
  CurrenciesConfig,
  CurrencySlotConfig,
  IntervalConfig,
  IntervalKey,
  IntervalSlotConfig,
  ProviderEntry,
  ProviderType,
} from "./types.ts";
import * as diagnostics from "./diagnostics.ts";
import { detectTransport } from "./api.ts";

// ----- Defaults — must match today's hardcoded values exactly -----

// Default separator strings referenced from lineTemplate as s_0, s_1, ….
// Empty by default in v0.4.x — the v0.4.0-release style built-in
// characters (" ", "·") are now also available as NAMED ALIASES
// vX.X.X+ — `separators` config array and the numeric `s_<n>`
// dispatch are REMOVED. The six built-in characters
// (`s_space` / `s_dot` / `s_newline` / `s_tab` / `s_colon` /
// `s_pipe`) are the only separator tokens. To render any other
// literal in your template, use `m_label|<your-text>` (or just
// drop a free-form token — the renderer emits unknown tokens
// verbatim now).

// Default line layout. A template is an ordered list of tokens; each
// token is either a display module ("m_<name>"), a named separator
// ("s_space" / "s_dot" / …), or a free-form literal. The renderer
// walks the list left-to-right and concatenates the output of each
// module, with s_<name> rendered as the built-in literal character.
// See render.ts:renderTemplate for the full grammar.
//
// Defaults reproduce the v0.2.16 output byte-for-byte:
//   plan:    "Usage: <5h> <countdown5h> · <7d> <countdown7d>"
//   balance: "Balance: <balance>"
// with s_space / s_dot / s_space composing " · " between windows.
//
// v0.4.0+ — kept around as the SOURCE OF TRUTH for the `plan` / `balance`
// entries inside `DEFAULT_LINE_TEMPLATES`. The legacy top-level
// `lineTemplate: { plan, balance }` config field is REMOVED in v0.4.0+
// (loader warns + ignores); the `m_template` module reads from
// `lineTemplates[key]` instead. Tests still reference this constant via
// __testing, so don't remove.
const DEFAULT_LINE_TEMPLATE: {
  plan: string[];
  balance: string[];
} = {
  // v0.4.x — the default template uses the NAMED ALIASES (s_space,
  // s_dot) so it works with the new empty default `separators`
  // array. The visual output is byte-for-byte identical to the
  // v0.4.0 release: the `s_0 + s_1 + s_0` composition is replaced
  // with `s_space + s_dot + s_space`, both producing " · ".
  plan: [
    "m_modeLabel", "s_space",
    "m_windowQuota|term:short", "s_space", "m_countdown|term:short",
    "s_space", "s_dot", "s_space",
    "m_windowQuota|term:mid", "s_space", "m_countdown|term:mid",
  ],
  balance: ["m_modeLabel", "s_space", "m_balance"],
};

// v0.4.0+ — registry of reusable template fragments. Each value is a
// token array (the same shape as the v0.3.x `lineTemplate.{plan,balance}`
// entries). Allowed tokens: `m_*` modules EXCEPT `m_template`, plus
// `s_*` separators. The loader strips `m_template:` tokens at load
// time so nesting is impossible.
//
// Keys are user-chosen (e.g. `foo`, `myWorkload`). The renderer reads
// from this registry when it encounters an `m_template|<key>` token
// inside `statuslineTemplate`. The legacy `PLAN_PRESETS` /
// `BALANCE_PRESETS` tables (v0.4.0–v0.8.13) are GONE in v0.8.14 — the
// seven plan + two balance presets are now first-class entries in
// this registry with `_`-prefixed keys. Plan presets
// (`_1line` / `_simple` / `_simple-alone` / `_standard` /
// `_standard-alone` / `_abundant` / `_complete`) target TOKEN_PLAN
// providers; balance presets (`_balance_simple` /
// `_balance_simple-alone`) target BALANCE providers (DeepSeek). The
// user references them via `m_template|_X` (with optional
// `|mode|plan|balance` to constrain dispatch to one provider type —
// `m_template` defaults to `mode:plan`).
//
// `_`-prefix = built-in preset, NOT overridable by user. The loader
// rejects user `lineTemplates._*` entries whose name collides with a
// built-in key (warn + skip). Use a different key for user-defined
// presets.
//
// Default entries point at the same arrays DEFAULT_LINE_TEMPLATE uses,
// so the legacy "plan" / "balance" key names continue to resolve for
// backward-compatible lookups via `m_template:plan` / `:balance`.
type LineTemplates = Record<string, string[]>;


// v0.8.14+ — `statuslineTemplate` is array-only. The legacy string-form
// preset-name value (`"1line"`, `"standard"`, etc.) is auto-migrated
// by `applyOverrides` to the equivalent `["m_template|_X"]` form with
// a one-shot stderr warning. Use the array form directly to silence
// the warning. The PLAN_PRESETS / BALANCE_PRESETS tables (v0.4.0–
// v0.8.13) are gone — presets are now first-class entries in
// `DEFAULT_LINE_TEMPLATES` with `_`-prefixed keys.
type StatuslineTemplate = string[];

// Default render = `["m_template|_1line"]`. The `_1line` body is the
// byte-identical rename of the v0.4.0–v0.8.13 `PLAN_PRESETS["1line"]`
// body, so existing users with no config.json see the same render
// they did before v0.8.14 (TOKEN_PLAN provider — the default mode of
// `m_template` matches).
export const DEFAULT_STATUSLINE_TEMPLATE: StatuslineTemplate = ["m_template|_1line"];

// v0.8.14 — Set of all legacy preset names (with the `_` prefix
// stripped). `applyOverrides` uses this to detect legacy string-form
// `statuslineTemplate` values and auto-migrate them to the equivalent
// `["m_template|_X"]` form. `balance_simple` and `balance_simple-alone`
// include the `_balance_` infix (e.g. `balance_simple` becomes the
// `_balance_simple` key). Order matches the bodies above; do not add
// names here without adding the corresponding key to
// DEFAULT_LINE_TEMPLATES.
export const LEGACY_PRESET_NAMES: ReadonlyArray<string> = [
  "1line", "simple", "simple-alone", "standard",
  "standard-alone", "abundant", "complete",
  "balance_simple", "balance_simple-alone",
];

// v0.8.14 — built-in presets are now first-class entries in
// DEFAULT_LINE_TEMPLATES with `_`-prefix. Bodies were migrated
// byte-for-byte from the v0.4.0–v0.8.13 PLAN_PRESETS /
// BALANCE_PRESETS tables; the bodies themselves are unchanged.
//
// Naming convention (carried over from the legacy PLAN_PRESETS /
// BALANCE_PRESETS tables):
//
//   TOKEN_PLAN presets (default mode of `m_template` is "plan", so
//   no `|mode|plan` arg needed):
//     _1line / _simple       : tokenplan only, single line, compact
//                              (_simple is an alias of _1line — same body)
//     _simple-alone          : single line with "Usage:" label prefix
//                              (for the user running this plugin as
//                              the SOLE statusline — no upstream chain)
//     _standard              : 2 lines (tokenplan on line 0, context
//                              & token on line 1). Companion: this
//                              plugin chains an upstream statusline
//                              for session info.
//     _standard-alone        : 3 lines (adds session on line 0).
//     _abundant              : 4 lines (adds git on line 0).
//     _complete              : 5 lines (adds totals on line 3).
//
//   BALANCE presets (use `m_template|_X|mode|balance` to constrain
//   dispatch to BALANCE providers — the default `m_template` mode of
//   "plan" would silently drop these on a TOKEN_PLAN provider):
//     _balance_simple        : default balance render
//                              ("Balance: <balance>")
//     _balance_simple-alone  : balance render with explicit
//                              "Balance:" label prefix for solo use.
//
// Per-module coloring is omitted from the presets (no `:color:` arg)
// — the user can override per module by inlining the preset into
// their own array if they want.
export const DEFAULT_LINE_TEMPLATES: LineTemplates = {
  // Legacy "plan" / "balance" entries — preserved for back-compat
  // with pre-v0.8.14 configs that referenced `m_template:plan` /
  // `:balance`. Bodies match DEFAULT_LINE_TEMPLATE (the `s_space +
  // s_dot + s_space` composition that produces " · " between
  // windows).
  plan: DEFAULT_LINE_TEMPLATE.plan,
  balance: DEFAULT_LINE_TEMPLATE.balance,

  // ----- Built-in presets (v0.8.14+) -----
  _1line: [
    "m_modeLabel", "s_space",
    "m_windowQuota|term:short", "s_space", "m_countdown|term:short",
    "s_space", "s_dot", "s_space",
    "m_windowQuota|term:mid", "s_space", "m_countdown|term:mid",
  ],
  // alias of _1line — same shape, more discoverable name
  _simple: [
    "m_modeLabel", "s_space",
    "m_windowQuota|term:short", "s_space", "m_countdown|term:short",
    "s_space", "s_dot", "s_space",
    "m_windowQuota|term:mid", "s_space", "m_countdown|term:mid",
  ],
  // single line with "Usage:" label prefix
  _simple_alone: [
    "m_label|Usage|color:yellow", "s_newline",
    "m_windowQuota|term:short|nulldrop:false", "s_space",
    "m_countdown|term:short|nulldrop:false",
    "s_space", "s_dot|color:red", "s_space",
    "m_windowQuota|term:mid|nulldrop:false", "s_space",
    "m_countdown|term:mid|nulldrop:false",
  ],
  // 2 lines: line 0 = tokenplan, line 1 = context & token.
  _standard: [
    "m_modeLabel", "s_space",
    "m_windowQuota|term:short", "s_space", "m_countdown|term:short",
    "s_space", "s_dot", "s_space",
    "m_windowQuota|term:mid", "s_space", "m_countdown|term:mid",
    "s_newline",
    "m_sessionApiDuration|nulldrop:false", "s_space",
    "m_tokenIn|nulldrop:false", "s_space",
    "m_tokenInSpeed|nulldrop:false", "s_space",
    "m_tokenOut|nulldrop:false", "s_space",
    "m_tokenOutSpeed|nulldrop:false", "s_space",
    "m_ctx|nulldrop:false", "s_space",
    "m_tokenHitRate|nulldrop:false",
  ],
  // 3 lines: line 0 = session, line 1 = tokenplan, line 2 = context.
  _standard_alone: [
    "m_label|Session|color:yellow", "s_space",
    "m_session|nulldrop:false", "s_space",
    "m_model|nulldrop:false", "s_space",
    "m_ccVersion|nulldrop:false",
    "s_newline",
    "m_label|Usage|color:yellow", "s_newline",
    "m_windowQuota|term:short|nulldrop:false", "s_space",
    "m_countdown|term:short|nulldrop:false",
    "s_space", "s_dot|color:red", "s_space",
    "m_windowQuota|term:mid|nulldrop:false", "s_space",
    "m_countdown|term:mid|nulldrop:false",
    "s_newline",
    "m_label|Context|color:yellow", "s_newline",
    "m_sessionApiDuration|nulldrop:false", "s_space",
    "m_tokenIn|nulldrop:false", "s_space",
    "m_tokenInSpeed|nulldrop:false", "s_space",
    "m_tokenOut|nulldrop:false", "s_space",
    "m_tokenOutSpeed|nulldrop:false", "s_space",
    "m_ctx|nulldrop:false", "s_space",
    "m_tokenHitRate|nulldrop:false",
  ],
  // 4 lines: line 0 = session + git, line 1 = tokenplan, line 2 =
  // context, line 3 = (none — see _complete for the 5-line form).
  _abundant: [
    "m_label|Session|color:yellow", "s_space",
    "m_session|nulldrop:false", "s_space",
    "m_model|nulldrop:false", "s_space",
    "m_branch|nulldrop:false", "s_space",
    "m_gitStatus|nulldrop:false", "s_space",
    "m_ccVersion|nulldrop:false",
    "s_newline",
    "m_label|Usage|color:yellow", "s_newline",
    "m_windowQuota|term:short|nulldrop:false", "s_space",
    "m_countdown|term:short|nulldrop:false",
    "s_space", "s_dot|color:red", "s_space",
    "m_windowQuota|term:mid|nulldrop:false", "s_space",
    "m_countdown|term:mid|nulldrop:false",
    "s_newline",
    "m_label|Context|color:yellow", "s_newline",
    "m_sessionApiDuration|nulldrop:false", "s_space",
    "m_tokenIn|nulldrop:false", "s_space",
    "m_tokenInSpeed|nulldrop:false", "s_space",
    "m_tokenOut|nulldrop:false", "s_space",
    "m_tokenOutSpeed|nulldrop:false", "s_space",
    "m_ctx|nulldrop:false", "s_space",
    "m_tokenHitRate|nulldrop:false",
  ],
  // 5 lines: line 0 = session + git, line 1 = tokenplan, line 2 =
  // context, line 3 = totals. NOT recommended — verbose.
  _complete: [
    "m_label|Session|color:yellow", "s_space",
    "m_session|nulldrop:false", "s_space",
    "m_model|nulldrop:false", "s_space",
    "m_branch|nulldrop:false", "s_space",
    "m_gitStatus|nulldrop:false", "s_space",
    "m_ccVersion|nulldrop:false",
    "s_newline",
    "m_label|Usage|color:yellow", "s_newline",
    "m_windowQuota|term:short|nulldrop:false", "s_space",
    "m_countdown|term:short|nulldrop:false",
    "s_space", "s_dot|color:red", "s_space",
    "m_windowQuota|term:mid|nulldrop:false", "s_space",
    "m_countdown|term:mid|nulldrop:false",
    "s_newline",
    "m_label|Context|color:yellow", "s_newline",
    "m_sessionApiDuration|nulldrop:false", "s_space",
    "m_tokenIn|nulldrop:false", "s_space",
    "m_tokenInSpeed|nulldrop:false", "s_space",
    "m_tokenOut|nulldrop:false", "s_space",
    "m_tokenOutSpeed|nulldrop:false", "s_space",
    "m_ctx|nulldrop:false", "s_space",
    "m_tokenHitRate|nulldrop:false",
    "s_newline",
    "m_label|Total|color:yellow", "s_newline",
    "m_totalTokenIn|nulldrop:false", "s_space",
    "m_totalTokenOut|nulldrop:false", "s_space",
    "m_totalTokenWithCacheIn|nulldrop:false", "s_space",
    "m_linesAdded|nulldrop:false", "s_space",
    "m_linesRemoved|nulldrop:false",
  ],
  // ----- BALANCE presets (use |mode|balance when dispatching) -----
  // Default balance render — "Balance: <balance>".
  _balance_simple: ["m_modeLabel", "s_space", "m_balance"],
  // Balance render with explicit "Balance:" label prefix for solo use.
  _balance_simple_alone: [
    "m_label|Balance|color:yellow", "s_space",
    "m_balance|nulldrop:false",
  ],
};

// 256-color SGR sequences. The colors are kept as plain ANSI strings
// (not symbolic names) so a downstream user can copy/paste a value
// from `console.log` and paste it into config.json without translation.
// "brightBlack" is accepted on input as a shortcut for "\x1b[90m".
const DEFAULT_COLORS = {
  brightGreen: "\x1b[38;5;41m",
  darkGreen: "\x1b[38;5;29m",
  yellow: "\x1b[38;5;220m",
  orange: "\x1b[38;5;208m",
  red: "\x1b[38;5;196m",
  stale: "\x1b[90m",
  // v0.6.0+ — broken-chain color (used by formatStaleSuffix when
  // the m_age "⛓️‍💥 X ago" annotation fires, i.e. the fetch failed
  // and we're rendering the last successful cached value). Distinct
  // from `colors.stale` (gray, used for the fresh 🔗 annotation) so
  // the user can read the two states at a glance.
  broken: "\x1b[31m",
};

// v0.4.0+ — 3-band palette for the m_tokenHitRate module. Higher is
// better: cache_read / (cache_read + cache_creation) ≥ 80% → green,
// 50–80% → yellow, <50% → orange. Bands chosen to match the visual
// vocabulary of the existing 5-band thresholds (green/yellow/orange)
// so the cache-hit rate reads as "another health indicator" rather
// than a separate dimension.
const DEFAULT_CACHE_HIT_COLORS = {
  good: "\x1b[38;5;41m", // bright green, ≥ 80%
  warn: "\x1b[38;5;220m", // yellow, 50–80%
  bad: "\x1b[38;5;208m", // orange, < 50%
};

const DEFAULT_CACHE_HIT_THRESHOLDS: [number, number] = [50, 80];

const DEFAULT_THRESHOLDS: {
  percentBands: [number, number, number, number];
  balanceBands: [number, number, number, number];
} = {
  // 5-band cutoffs for MiniMax percentage rendering.
  percentBands: [60, 70, 80, 90],
  // 5-band cutoffs for DeepSeek balance rendering (absolute units, not %).
  balanceBands: [5, 10, 20, 50],
};

const DEFAULT_CURRENCY: {
  prefixes: Record<string, string>;
  fallback: string;
  default: string;
} = {
  prefixes: { USD: "$", CNY: "￥", RMB: "￥" },
  // Fallback prefix when the API returns an unknown currency code.
  fallback: "￥",
  // Currency assumed when an entry omits its `currency` field.
  default: "CNY",
};

const DEFAULT_STALE = {
  // Emoji pair prepended to the "X ago" annotation when the fetch
  // failed. The broken glyph is what the user actually sees (no
  // leading separator) — it's the indicator of network failure.
  // v0.2.17: removed the legacy `separator` field. The stale
  // annotation is now appended directly after the template output
  // (no leading separator). If a custom separator is needed, place
  // it in the lineTemplate explicitly.
  ageEmoji: { healthy: "🔗", broken: "⛓️‍💥" },
  // Glyphs appended to the reset countdown (e.g. "2h3m🕛"). The picker
  // indexes into this array by `remainingMs / resetDurationMs`, so the
  // array reads left-to-right as "few remaining → many remaining":
  //   index 0        : remainingMs ≈ 0 (just reset / about to reset)
  //   last index     : remainingMs ≈ resetDurationMs (fresh)
  // `min(…, length-1)` clamps ratio=1.0 to the last entry instead of
  // running off the end. Twelve clock-face emoji give a smooth visual
  // ramp from 12 o'clock (🕛, least remaining) around to 1 o'clock
  // (🕐, most remaining); two glyphs give a binary "hourglass" pair
  // (full/empty); one glyph is a static indicator. Providers without
};

const DEFAULT_BAR = {
  width: 8,
  filled: "▓",
  empty: "░",
};

// v0.4.0+ — number-format knobs for the m_token* modules. Two layers:
//   `thresholds` drives the human-compact notation (matches formatRemainingMs:
//   below the smallest threshold → raw integer; otherwise k / M suffix).
//   `precision` controls decimal places per tier (currently 1; tests can
//   bump to 2 if a user wants more granularity).
//   `speedPrecision` / `cachePctPrecision` independently tune t/s and %.
//   `cacheHitThresholds` mirrors DEFAULT_CACHE_HIT_THRESHOLDS — exposed
//   as a config field so a user who wants different bands can override
//   without touching the colors block.
// v0.4.0+ — 5-band scale thresholds for the m_tokenInSpeed /
// m_tokenOutSpeed modules (`:color:scale` / bare default). The
// bands are picked at the FAST end: tps >= bands[3] → fastest
// band (bright green); tps < bands[0] → slowest band (red).
// `in` uses 5× the `out` thresholds because input streams
// naturally run hotter than output — without the 5× factor the
// `in` module would always read as "fastest green", which
// would defeat the purpose of a gradient. Users can override
// both bands in config.json's `tokenFormat.speedScaleBands`.
const DEFAULT_SPEED_SCALE_BANDS = {
  in: [50, 100, 200, 400] as [number, number, number, number],
  out: [10, 20, 40, 80] as [number, number, number, number],
};

const DEFAULT_TOKEN_FORMAT = {
  // [<1k] → "342", [<1M] → "12.3k", [≥1M] → "1.2M". Aligns with the
  // readable upper bound of typical session totals (rare to see > 1M
  // tokens in a single Claude Code session, but possible over a 7d window).
  thresholds: [1_000, 1_000_000] as [number, number],
  precision: 1,
  speedPrecision: 1,
  cachePctPrecision: 1,
  cacheHitThresholds: DEFAULT_CACHE_HIT_THRESHOLDS,
  speedScaleBands: DEFAULT_SPEED_SCALE_BANDS,
};

type DisplayMode = "used" | "remaining";

// Top-level time-format knobs. They govern ALL time rendering in the
// plugin — reset countdown AND stale-age suffix AND any future caller
// (e.g. an "elapsed since session start" line). Keeping them at top
// level (rather than buried under `stale`) means a user who wants
// second-level granularity anywhere gets it everywhere consistently.
type TimeFormat = {
  // Smallest unit shown on time countdowns. Units BELOW this granularity
  // are never rendered directly — when all remaining units collapse to
  // zero (or get truncated), the formatter falls back to "<1<minUnit>"
  // (positive remaining) or "0<minUnit>" (past-due).
  //   "m" (default): sub-minute shows as "<1m".
  //   "s":           sub-minute shows as actual seconds (e.g. "47s").
  //   "h":           sub-hour shows as "<1h" (useful for windows where
  //                  minute-precision is noise — e.g. the weekly reset).
  minUnit: "m" | "s" | "h";
  // How many non-zero units to display. After dropping units below
  // minUnit AND dropping leading zero units, takes up to maxUnitCount
  // from the start — including any internal/trailing zero units.
  // Clamped to [1, 4]. Examples (minUnit="m"):
  //   1d2h3m4s → "1d2h"
  //   2h3m4s   → "2h3m"
  //   2h0m     → "2h0m"   (NOT "2h" — internal zeros preserved)
  //   0d0h5m   → "5m"     (leading zeros dropped)
  //   0d0h30s  → "<1m"    (all extracted units zero under minUnit)
  maxUnitCount: number;
};

const DEFAULT_TIME_FORMAT: TimeFormat = {
  minUnit: "m",
  maxUnitCount: 2,
};

// Reset-countdown visualization. Belongs with the countdown, NOT with
// the stale-on-error annotation (which is a separate concern).
type Countdown = {
  // Glyphs appended to the reset countdown (e.g. "2h3m🕛"). The picker
  // indexes into this array by remainingMs / resetDurationMs, so the array
  // reads left-to-right as "few remaining → many remaining":
  //   index 0  : remainingMs ≈ 0 (just reset / about to reset)
  //   last     : remainingMs ≈ resetDurationMs (fresh)
  // min(..., length-1) clamps ratio=1.0 to the last entry. Twelve clock-face
  // emoji give a smooth visual ramp from 12 o'clock (🕛, least remaining)
  // around to 1 o'clock (🕐, most remaining); two glyphs give a binary
  // hourglass pair; one glyph is static. Providers without start_time
  // (DeepSeek, legacy) fall back to index 0.
  resetArrows: string[];
};

const DEFAULT_COUNTDOWN: Countdown = {
  resetArrows: [
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
};


// v0.2.21: declarative provider list. Each entry is a self-contained
// provider spec: how to recognize its base URL, how to talk to its API,
// and how to dispatch the rendering. The defaults below reproduce the
// v0.2.20 hardcoded behavior exactly — same base URLs, same endpoints.
// Adding a new provider is a config-only change: drop a new entry into
// `providers` and the dispatcher / fetcher / template picker all pick
// it up automatically.
const DEFAULT_PROVIDERS: Record<string, ProviderEntry> = {
  minimax: {
    TYPE: "TOKEN_PLAN",
    BASE_URL_COMPARED_TO: "https://api.minimaxi.com/anthropic",
    COMPARE_METHOD: "EXACT",
    ENDPOINT: "https://www.minimaxi.com/v1/token_plan/remains",
    config: {},
  },
  deepseek: {
    TYPE: "BALANCE",
    BASE_URL_COMPARED_TO: "https://api.deepseek.com/anthropic",
    COMPARE_METHOD: "EXACT",
    ENDPOINT: "https://api.deepseek.com/user/balance",
    config: {},
    intervals: {},
  },
};

const VALID_PROVIDER_TYPES: ReadonlySet<ProviderType> = new Set([
  "TOKEN_PLAN",
  "BALANCE",
]);

const VALID_COMPARE_METHODS: ReadonlySet<CompareMethod> = new Set([
  "EXACT",
  "INCLUDE",
  "STARTWITH",
]);

// v0.6.0+ — closed enum for the per-provider HTTP method override.
// Keep in sync with ProviderEntry.METHOD in src/types.ts.
const VALID_HTTP_METHODS: ReadonlySet<
  "GET" | "POST" | "PUT" | "PATCH" | "DELETE"
> = new Set(["GET", "POST", "PUT", "PATCH", "DELETE"]);

const DEFAULT_CONFIG: {
  cacheTtlMs: number;
  fetchTimeoutMs: number;
  display: DisplayMode;
  modeLabels: { used: string; remaining: string; balance: string };
  // v0.8.0+ — top-level prefix labels for the per-turn / acc /
  // sum-avg token-stat axes. Every value already includes its
  // trailing colon (e.g. "in:") so the renderer can just concat.
  //
  // v0.8.22+ — names renamed to 1:1 mirror the `m_*` module names
  // they back, so a reader looking at `m_tokenIn` immediately knows
  // to look at `labels.labelTokenIn`. Each label name is shared
  // across the per-turn / acc / sum-avg module of the same family
  // (e.g. `labelTokenIn` covers m_tokenIn / m_accTokenIn /
  // m_sumTokenIn); per-family override was deliberately NOT
  // exposed — the three family variants render the same axis
  // (in-flow / out-flow / cache-read / …) and per-family split
  // would be confusing rather than useful.
  //
  // Defaults reproduce the v0.8.x hardcoded literal strings so
  // existing renders stay byte-identical until the user overrides
  // labels.* in config.json. Old v0.8.13–v0.8.21 names
  // (labelIn / labelOut / labelCacheIn / labelTotalIn /
  // labelApi / labelApiCalls / labelInSpeed / labelOutSpeed /
  // labelMemUsage) are accepted as deprecated aliases — see
  // `applyOverrides` for the migration warning + value mirror.
  labels: {
    // per-turn / acc / sum-avg of token-IN flow
    labelTokenIn: string;
    // per-turn / acc / sum-avg of token-OUT flow
    labelTokenOut: string;
    // per-turn / acc / sum-avg of cache-read flow
    labelTokenCachedIn: string;
    // per-turn / acc / sum-avg of total-IN (input + cache-read)
    labelTokenTotalIn: string;
    // per-turn / acc / sum-avg of API roundtrip time (dhms body)
    labelApiMs: string;
    // per-turn / acc / sum-avg of API call count (integer body)
    labelApiCalls: string;
    // v0.8.13+ — per-turn / acc / sum-avg of token-IN throughput
    // (t/s). Shares `labelTokenIn` semantics across families.
    labelTokenInSpeed: string;
    // per-turn / acc / sum-avg of token-OUT throughput (t/s).
    labelTokenOutSpeed: string;
    // v0.8.17+ — system RAM usage label exposed via m_memUsage.
    labelMemUsage: string;
    // v0.8.22+ — cache hit-rate ratio (lifted out of the v0.8.x
    // R8 hardcoded "hit:" prefix into the labels namespace).
    labelTokenHitRate: string;
    // v0.8.23+ — context-window occupancy / capacity / pct
    // prefixes (were hardcoded "size:" / "size:" / "used:" /
    // "remain:" in v0.8.22). Defaults preserve the literals so
    // existing renders stay byte-identical.
    labelContextSize: string;
    labelContextWindowsSize: string;
    labelContextUsedPercent: string;
    labelContextRemainingPercent: string;
    // v0.8.24+ — start of the tick statistics window. Read by
    // m_accStartTime and m_sumStartTime (the cross-project min
    // of per-row startAt). Default "start:" preserves a clean
    // axis to override via config.json.
    labelStartTime: string;
    // v0.8.24+ — end of the tick statistics window. Read by
    // m_sumEndTime (the cross-project max of per-row lastAt).
    // Default "end:" mirrors the startTime default.
    labelEndTime: string;
    // v0.9.0+ — quota module prefix. Read by `m_quota` (per-term
    // via the new `|term|short|mid|long` inline arg). Default
    // `"quota:"` preserves a clean axis to override via
    // config.json. Renders as e.g. `quota(5h):123/500`.
    labelQuota: string;
    // vX.X.X+ — token cost module prefix. Read by m_tokenCost /
    // m_accTokenCost / m_sumTokenCost. Default "cost:" preserves
    // a clean axis to override via config.json.
    labelTokenCost: string;
  };
  colors: typeof DEFAULT_COLORS;
  cacheHitColors: typeof DEFAULT_CACHE_HIT_COLORS;
  thresholds: typeof DEFAULT_THRESHOLDS;
  currency: typeof DEFAULT_CURRENCY;
  stale: typeof DEFAULT_STALE;
  bar: typeof DEFAULT_BAR;
  countdown: Countdown;
  timeFormat: TimeFormat;
  // v0.4.0+ — registry of reusable template fragments consumed by
  // the m_template module's first argument.
  lineTemplates: typeof DEFAULT_LINE_TEMPLATES;
  // v0.8.14+ — array-only. The template actually rendered is
  // always a `string[]` of tokens (may include `m_template|_X`
  // references that pull chunks from `lineTemplates`). Legacy
  // string-form values from v0.4.0–v0.8.13 configs are
  // auto-migrated by `applyOverrides` to the equivalent
  // `["m_template|_X"]` form with a one-shot warn.
  statuslineTemplate: string[];
  tokenFormat: typeof DEFAULT_TOKEN_FORMAT;
  // vX.X.X+ — per-token pricing for the m_tokenCost / m_accTokenCost /
  // m_sumTokenCost modules. All prices default to 0 (opt-in). When all
  // three are 0 the cost modules render placeholder / "n/a".
  tokenPrice: {
    in: number;      // price per input token
    out: number;     // price per output token
    cachedIn: number;// price per cache-read token
    currency: string;// currency code e.g. "USD", "CNY"
  };
  // Plugin version, populated at startup by index.ts from
  // .claude-plugin/plugin.json. The m_version display module reads
  // this field; tests inject values via __resetForTest.
  version: string;
  // v0.2.21: declarative provider registry. See DEFAULT_PROVIDERS
  // above and src/providers.ts for the matcher / dispatcher.
  providers: Record<string, ProviderEntry>;
  // v0.9.0+ — top-level default intervals config. Each key is one
  // of `shortInterval` / `midInterval` / `longInterval`. This is
  // layer 2 of the 4-layer merge in resolveEffectiveIntervals
  // (above). Per-provider `intervals` blocks (layer 3) deep-merge
  // on top of these. The top-level defaults start empty — global
  // defaults (layer 0) and built-in per-provider defaults
  // (layer 1, e.g. minimax model_remains[0].* paths) are layered
  // in at fetch time, gated on the active provider id.
  intervals: IntervalConfig;
  // vX.X.X+ — top-level currencies config. Maps currency codes
  // (CNY / USD / …) onto `{ label, totalBalance }` slot configs.
  // Layer 2 of the 4-layer merge in resolveEffectiveCurrencies
  // (see src/config.ts). Per-provider `currencies` blocks (layer
  // 3) shallow-replace on top of these. The top-level defaults
  // start empty — built-in per-provider defaults (layer 1, e.g.
  // deepseek's CNY → balance_infos.0.total_balance) are layered
  // in at fetch time, gated on the active provider id.
  currencies: CurrenciesConfig;
  // v0.8.21+ — `m_quote|address|…` fetcher passes `--insecure` /
  // `-k` to curl so self-signed / expired / untrusted-CA HTTPS
  // endpoints work without patching the system CA bundle. Always
  // opt-in (default `false`) so a misconfigured upstream still
  // surfaces TLS errors loudly. Two ways to flip it on:
  //   1. `"quoteInsecureTls": true` in config.json (global default)
  //   2. `|insecureTls|<true|false>` inline arg on a specific
  //      `m_quote` token (per-token override; beats the config
  //      value when the arg is present)
  // There is intentionally NO env-var seed for this flag — the
  // URL you're willing to skip TLS validation for is a config-
  // level decision, not a shell-environment one.
  quoteInsecureTls: boolean;
} = {
  cacheTtlMs: 60_000,
  fetchTimeoutMs: 5_000,
  display: "used",
  // "balance" was added in v0.2.17 alongside the lineTemplate refactor
  // so the m_modeLabel module for the DeepSeek path can pick it up. Defaults
  // to "Balance:" to preserve the v0.2.16 hardcoded literal.
  modeLabels: { used: "Usage:", remaining: "Remain:", balance: "Balance:" },
  // v0.8.22+ — values mirror the v0.8.x hardcoded literals
  // exactly: "in:" for both labelTokenIn and labelTokenInSpeed
  // (the per-turn / acc / sum-avg form was always the same prefix
  // before the v0.8.13 split), "out:" likewise for the matching
  // out-axis. Existing renders stay byte-identical without any
  // user intervention.
  labels: {
    labelTokenIn: "in:",
    labelTokenOut: "out:",
    labelTokenCachedIn: "cache:",
    labelTokenTotalIn: "total:",
    labelApiMs: "api:",
    labelApiCalls: "calls:",
    labelTokenInSpeed: "in:",
    labelTokenOutSpeed: "out:",
    labelMemUsage: "Mem:",
    labelTokenHitRate: "hit:",
    // v0.8.23+ — context-window prefixes (defaults preserve the
    // v0.8.22 hardcoded literals so existing renders stay
    // byte-identical).
    labelContextSize: "size:",
    labelContextWindowsSize: "size:",
    labelContextUsedPercent: "used:",
    labelContextRemainingPercent: "remain:",
    // v0.8.24+ — start/end of the tick statistics window. Net-new
    // axes (no v0.8.23 default to preserve), so the literals are
    // pure v0.8.24 conventions.
    labelStartTime: "start:",
    labelEndTime: "end:",
    // v0.9.0+ — quota module prefix default. Matches the
    // v0.8.x "labelFoo:" convention (trailing colon included
    // so the renderer can concat without a separator).
    labelQuota: "quota:",
    // vX.X.X+ — token cost module prefix default. Matches the
    // existing "labelFoo:" convention (trailing colon included
    // so the renderer can concat without a separator).
    labelTokenCost: "cost:",
  },
  colors: DEFAULT_COLORS,
  cacheHitColors: DEFAULT_CACHE_HIT_COLORS,
  thresholds: DEFAULT_THRESHOLDS,
  currency: DEFAULT_CURRENCY,
  stale: DEFAULT_STALE,
  bar: DEFAULT_BAR,
  countdown: DEFAULT_COUNTDOWN,
  timeFormat: DEFAULT_TIME_FORMAT,
  lineTemplates: DEFAULT_LINE_TEMPLATES,
  statuslineTemplate: DEFAULT_STATUSLINE_TEMPLATE,
  tokenFormat: DEFAULT_TOKEN_FORMAT,
  // vX.X.X+ — per-token pricing defaults (all zero — opt-in).
  tokenPrice: {
    in: 0,
    out: 0,
    cachedIn: 0,
    currency: "USD",
  },
  version: "",
  providers: DEFAULT_PROVIDERS,
  intervals: {},
  // vX.X.X+ — top-level currencies config. Maps currency codes
  // (CNY / USD / …) onto `{ label, totalBalance }` slot configs.
  // Layer 2 of the 4-layer merge in resolveEffectiveCurrencies
  // (below). Per-provider `currencies` blocks (layer 3) shallow-
  // replace on top of these. Top-level defaults start empty —
  // built-in per-provider defaults (layer 1, e.g. deepseek's
  // CNY → balance_infos.0.total_balance) are layered in at fetch
  // time, gated on the active provider id.
  currencies: {} as CurrenciesConfig,
  quoteInsecureTls: false,
};

export type Config = typeof DEFAULT_CONFIG;

// ----- Module-level singleton -----
//
// Set once via loadConfig() at startup. Tests use __resetForTest to
// inject overrides without touching disk. Reading is synchronous: every
// consumer just calls configStore.get() at the moment of need.

let _current: Config = DEFAULT_CONFIG;

export const configStore = {
  get(): Config {
    return _current;
  },
  // Inject the plugin version loaded from .claude-plugin/plugin.json
  // at startup. Mutates the current Config's `version` field in place
  // — the test reset path also resets it (see __resetForTest). Tests
  // can call this directly to simulate the startup injection without
  // touching the filesystem.
  setVersion(v: string): void {
    _current.version = v;
  },
};

// ----- Loader -----

function defaultConfigPath(): string {
  return join(
    homedir(),
    ".claude",
    "plugins",
    "topgauge-cc",
    "config.json",
  );
}

// Test hook: replace the path resolver so tests can point at a temp
// file without monkey-patching node:os. Production code never sets it.
let _pathResolver: () => string = defaultConfigPath;

export async function loadConfig(): Promise<Config> {
  const path = _pathResolver();

  // Cheap existence probe — the common case is no config file, no need
  // to even open the file descriptor.
  diagnostics.logFsRead(path, "config.loadConfig");
  if (!existsSync(path)) {
    _current = DEFAULT_CONFIG;
    return _current;
  }

  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (e) {
    warn(`read failed (${(e as Error).message}); using defaults`);
    _current = DEFAULT_CONFIG;
    return _current;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    warn(`invalid JSON (${(e as Error).message}); using defaults`);
    _current = DEFAULT_CONFIG;
    return _current;
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    warn("root must be a JSON object; using defaults");
    _current = DEFAULT_CONFIG;
    return _current;
  }

  _current = mergeConfig(parsed as Record<string, unknown>);
  return _current;
}

// v0.4.0+ — apply a provider-specific Config override on top of the
// active snapshot. Called from index.ts:main() after loadConfig() and
// matchProvider() so the active Config seen by every consumer
// (configStore.get()) is already the merged view:
//
//   defaults  ⊕  config.json top-level  ⊕  providerEntry.config
//             (lowest)                  (highest)
//
// Implementation: deep-clone the current snapshot, run the same
// per-field validators on top of the provider.config object, replace
// the active snapshot. Reusing the validators (rather than merging
// provider.config as JSON and re-running mergeConfig) keeps the
// precedence math explicit and avoids re-cloning defaults.
//
// Stale-on-error behavior: the active snapshot may have been built
// from a malformed user config (some fields silently fell back to
// defaults with a stderr warn). Re-validating provider.config on top
// of that snapshot means the provider layer's overrides get the SAME
// per-field validation as the top-level config — typos in
// provider.config still produce stderr warns, never silent acceptance.
export function applyProviderOverrides(raw: Record<string, unknown>): void {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return;
  if ("providers" in raw) {
    warn(
      "provider.config must not contain a nested 'providers' key (would recurse); ignoring",
    );
    delete (raw as Record<string, unknown>).providers;
  }
  const base = JSON.parse(JSON.stringify(_current)) as Config;
  _current = applyOverrides(base, raw);
}

// v0.4.0+ — exported so renderer modules (src/render.ts) can warn
// about runtime issues like `m_template:missingkey` without
// duplicating the stderr + diagnostics JSONL wiring. Config-side
// callers (this file) keep using the bare name.
export function warn(msg: string): void {
  process.stderr.write(`topgauge-cc: config ${msg}\n`);
  // v0.4.0+ — also append to the diagnostics JSONL log so the
  // m_warning module can surface the latest signal and the user can
  // postmortem the plugin's recent history. Stderr stays the
  // primary surface for live debugging; the log is the persistent
  // record. Disk errors are swallowed inside diagnostics.append.
  diagnostics.append("warning", "config", msg);
}

// ----- Per-field validation + merge -----
//
// Each validator returns the validated value, or DEFAULT_CONFIG's
// value on failure (with a stderr warning). Per-section isolation:
// a bad `colors` block does NOT poison `cacheTtlMs` — independent
// try/catches around each validator keep partial configs working.

function isFinitePositiveNumber(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v) && v > 0;
}

function isFiniteNumber(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v);
}

function isAscending4Tuple(v: unknown): v is [number, number, number, number] {
  if (!Array.isArray(v) || v.length !== 4) return false;
  if (!v.every(isFiniteNumber)) return false;
  for (let i = 1; i < v.length; i++) {
    if ((v[i] as number) <= (v[i - 1] as number)) return false;
  }
  return true;
}

// Accept an ANSI SGR string OR a known symbolic shortcut.
const COLOR_SHORTCUTS: Record<string, string> = {
  brightBlack: "\x1b[90m",
  brightGreen: "\x1b[38;5;41m",
  darkGreen: "\x1b[38;5;29m",
  yellow: "\x1b[38;5;220m",
  orange: "\x1b[38;5;208m",
  red: "\x1b[38;5;196m",
};

function normalizeColor(v: unknown): string | null {
  if (typeof v !== "string") return null;
  if (COLOR_SHORTCUTS[v]) return COLOR_SHORTCUTS[v];
  // Accept any SGR sequence (\x1b[...m) — we don't try to validate the
  // exact byte sequence, just that it looks like an SGR. Reject strings
  // that contain newlines so a JSON mistake can't inject multi-line
  // escape codes into the rendered statusline.
  if (/^\x1b\[[0-9;]*m$/.test(v)) return v;
  return null;
}

// v0.4.0+ — internal helper that applies a raw override object on
// top of an existing Config snapshot. Used by both mergeConfig (the
// config.json loader) and applyProviderOverrides (the provider-level
// config overlay). Per-field validators are identical between the
// two callers, so the precedence is:
//
//   defaults  ⊕  config.json  ⊕  providerEntry.config
//
// where each step runs the same validators in sequence.
//
// Why a separate helper: extracting this from mergeConfig keeps the
// validation logic in ONE place. If we re-ran mergeConfig from scratch
// for the provider layer, we'd lose the user-config fixes (e.g. a
// top-level `cacheTtlMs` that was repaired with a stderr warn would
// get re-clobbered by an unrelated bad value in provider.config).
// Re-validating on top of the merged snapshot keeps each layer's
// effect independent.
function applyOverrides(base: Config, raw: Record<string, unknown>): Config {
  // Deep-clone the input Config — we mutate freely and don't want to
  // touch the caller's object. JSON round-trip is fine here: Config
  // is plain data, no functions / Dates / Maps.
  const out = JSON.parse(JSON.stringify(base)) as Config;

  // cacheTtlMs
  if ("cacheTtlMs" in raw) {
    if (isFinitePositiveNumber(raw.cacheTtlMs)) {
      out.cacheTtlMs = raw.cacheTtlMs;
    } else {
      warn("cacheTtlMs must be a positive number; using default");
    }
  }

  // cacheTtlMs
  if ("cacheTtlMs" in raw) {
    if (isFinitePositiveNumber(raw.cacheTtlMs)) {
      out.cacheTtlMs = raw.cacheTtlMs;
    } else {
      warn("cacheTtlMs must be a positive number; using default");
    }
  }

  // fetchTimeoutMs
  if ("fetchTimeoutMs" in raw) {
    if (isFinitePositiveNumber(raw.fetchTimeoutMs)) {
      out.fetchTimeoutMs = raw.fetchTimeoutMs;
    } else {
      warn("fetchTimeoutMs must be a positive number; using default");
    }
  }

  // display
  if ("display" in raw) {
    const d = raw.display;
    if (d === "used" || d === "remaining") {
      out.display = d;
    } else {
      warn('display must be "used" or "remaining"; using default');
    }
  }

  // modeLabels
  if ("modeLabels" in raw) {
    const ml = raw.modeLabels;
    if (ml && typeof ml === "object" && !Array.isArray(ml)) {
      const m = ml as Record<string, unknown>;
      if (typeof m.used === "string") out.modeLabels.used = m.used;
      else if ("used" in m)
        warn("modeLabels.used must be a string; using default");
      if (typeof m.remaining === "string")
        out.modeLabels.remaining = m.remaining;
      else if ("remaining" in m)
        warn("modeLabels.remaining must be a string; using default");
      // v0.2.17: added alongside the lineTemplate refactor so m_modeLabel
      // can pick it up for the DeepSeek (balance) path. Replaces the
      // hardcoded "Balance: " literal in the old formatBalanceLine.
      if (typeof m.balance === "string") out.modeLabels.balance = m.balance;
      else if ("balance" in m)
        warn("modeLabels.balance must be a string; using default");
    } else {
      warn("modeLabels must be an object; using default");
    }
  }

  // v0.8.0+ — top-level token-label overrides. Same partial-merge
  // shape as modeLabels: each field is optional, invalid types are
  // dropped with a one-line warn, valid strings overwrite the
  // default verbatim (no further coercion — callers append the
  // value to a number, so the configured string must not contain
  // a trailing space).
  if ("labels" in raw) {
    const l = raw.labels;
    if (l && typeof l === "object" && !Array.isArray(l)) {
      const lm = l as Record<string, unknown>;
      const fields: Array<keyof typeof out.labels> = [
        "labelTokenIn",
        "labelTokenOut",
        "labelTokenCachedIn",
        "labelTokenTotalIn",
        "labelApiMs",
        "labelApiCalls",
        "labelTokenInSpeed",
        "labelTokenOutSpeed",
        "labelMemUsage",
        "labelTokenHitRate",
        "labelContextSize",
        "labelContextWindowsSize",
        "labelContextUsedPercent",
        "labelContextRemainingPercent",
        // v0.8.24+ — start/end of the tick statistics window.
        // Net-new axes (no v0.8.23 default to preserve).
        "labelStartTime",
        "labelEndTime",
        // v0.9.0+ — quota module prefix. Net-new axis; default
        // "quota:" preserved (see DEFAULT_CONFIG.labels above).
        "labelQuota",
        // vX.X.X+ — token cost module prefix.
        "labelTokenCost",
      ];
      for (const f of fields) {
        if (typeof lm[f] === "string") {
          out.labels[f] = lm[f] as string;
        } else if (f in lm) {
          warn(`labels.${f} must be a string; using default`);
        }
      }
      // v0.8.22+ — old v0.8.13–v0.8.21 names (labelIn / labelOut /
      // labelCacheIn / labelTotalIn / labelApi / labelInSpeed /
      // labelOutSpeed) are NOT accepted. Users must rename in
      // their config.json. We intentionally don't mirror values
      // silently: a stray old name silently adopting a new prefix
      // would mask config bugs and a noisy warn + drop is the
      // right failure mode. Also catches the transient v0.8.22
      // labelTokenTotalOut (reverted before release).
      // Note: `labelApiCalls` and `labelMemUsage` were not renamed
      // — they're the SAME identifier in v0.8.13+ and v0.8.22+, so
      // they remain in `fields` above. We don't list them here.
      const knownOldNames = [
        "labelIn",
        "labelOut",
        "labelCacheIn",
        "labelTotalIn",
        "labelTokenTotalOut",
        "labelApi",
        "labelInSpeed",
        "labelOutSpeed",
      ];
      for (const old of knownOldNames) {
        if (old in lm) {
          warn(
            `labels.${old} is removed in v0.8.22; remove it from ` +
            `your config.json (see release notes)`,
          );
        }
      }
    } else {
      warn("labels must be an object; using default");
    }
  }

  // v0.9.0+ — `intervals` top-level block. Each key is one of
  // `shortInterval` / `midInterval` / `longInterval`. Per-interval
  // slot validation mirrors the per-provider `intervals` validator
  // (shared `validateIntervalSlot` helper below). Built-in
  // provider defaults (minimax / deepseek) are applied at FETCH
  // TIME in resolveEffectiveIntervals, NOT here — top-level
  // defaults start empty so the global layer is just a placeholder
  // today. See the 4-layer merge block above MINIMAX_DEFAULT_INTERVALS
  // for the full contract.
  if ("intervals" in raw) {
    const ivRaw = raw.intervals;
    if (!ivRaw || typeof ivRaw !== "object" || Array.isArray(ivRaw)) {
      warn("intervals must be an object; using default");
    } else {
      const ivm = ivRaw as Record<string, unknown>;
      const keys: IntervalKey[] = ["shortInterval", "midInterval", "longInterval"];
      for (const k of keys) {
        if (!(k in ivm)) continue;
        out.intervals[k] = validateIntervalSlot(k, ivm[k], out.intervals[k] ?? {});
      }
    }
  }

  // vX.X.X+ — `currencies` top-level block. Maps currency codes
  // (CNY / USD / …) onto `{ label, totalBalance }` slots. Layer 2
  // of the 4-layer merge in resolveEffectiveCurrencies. Per-key
  // validation reuses `validateCurrencySlot` (defined below) — same
  // shape rules as the per-provider `currencies` validator.
  // Built-in per-provider defaults (deepseek's CNY → balance_infos
  // .0.total_balance) are applied at FETCH TIME in
  // resolveEffectiveCurrencies, NOT here — top-level defaults start
  // empty so the global layer is just a placeholder today. See the
  // 4-layer merge block above MINIMAX_DEFAULT_INTERVALS for the
  // parallel intervalsConfig contract.
  if ("currencies" in raw) {
    const curRaw = raw.currencies;
    if (!curRaw || typeof curRaw !== "object" || Array.isArray(curRaw)) {
      warn("currencies must be an object; using default");
    } else {
      out.currencies = validateCurrenciesBlock("top-level currencies", curRaw);
    }
  }

  // colors — per-field validation, partial acceptance
  if ("colors" in raw) {
    const c = raw.colors;
    if (c && typeof c === "object" && !Array.isArray(c)) {
      const cm = c as Record<string, unknown>;
      for (const key of [
        "brightGreen",
        "darkGreen",
        "yellow",
        "orange",
        "red",
        "stale",
        "broken",
      ] as const) {
        if (key in cm) {
          const norm = normalizeColor(cm[key]);
          if (norm) {
            out.colors[key] = norm;
          } else {
            warn(
              `colors.${key} must be an ANSI SGR string or a known shortcut; using default`,
            );
          }
        }
      }
    } else {
      warn("colors must be an object; using default");
    }
  }

  // v0.4.0+ — cacheHitColors. Same per-field validator as `colors`
  // (ANSI SGR or a known shortcut). Three bands: good / warn / bad.
  if ("cacheHitColors" in raw) {
    const c = raw.cacheHitColors;
    if (c && typeof c === "object" && !Array.isArray(c)) {
      const cm = c as Record<string, unknown>;
      for (const key of ["good", "warn", "bad"] as const) {
        if (key in cm) {
          const norm = normalizeColor(cm[key]);
          if (norm) {
            out.cacheHitColors[key] = norm;
          } else {
            warn(
              `cacheHitColors.${key} must be an ANSI SGR string or a known shortcut; using default`,
            );
          }
        }
      }
    } else {
      warn("cacheHitColors must be an object; using default");
    }
  }

  // thresholds
  if ("thresholds" in raw) {
    const t = raw.thresholds;
    if (t && typeof t === "object" && !Array.isArray(t)) {
      const tm = t as Record<string, unknown>;
      if ("percentBands" in tm) {
        if (isAscending4Tuple(tm.percentBands)) {
          out.thresholds.percentBands = tm.percentBands;
        } else {
          warn(
            "thresholds.percentBands must be 4 ascending numbers; using default",
          );
        }
      }
      if ("balanceBands" in tm) {
        if (isAscending4Tuple(tm.balanceBands)) {
          out.thresholds.balanceBands = tm.balanceBands;
        } else {
          warn(
            "thresholds.balanceBands must be 4 ascending numbers; using default",
          );
        }
      }
    } else {
      warn("thresholds must be an object; using default");
    }
  }

  // currency
  if ("currency" in raw) {
    const c = raw.currency;
    if (c && typeof c === "object" && !Array.isArray(c)) {
      const cm = c as Record<string, unknown>;
      if ("prefixes" in cm) {
        if (
          cm.prefixes &&
          typeof cm.prefixes === "object" &&
          !Array.isArray(cm.prefixes)
        ) {
          const merged: Record<string, string> = {
            ...DEFAULT_CURRENCY.prefixes,
          };
          for (const [k, v] of Object.entries(
            cm.prefixes as Record<string, unknown>,
          )) {
            if (typeof v === "string") merged[k.toUpperCase()] = v;
          }
          out.currency.prefixes = merged;
        } else {
          warn("currency.prefixes must be an object; using default");
        }
      }
      if ("fallback" in cm) {
        if (typeof cm.fallback === "string")
          out.currency.fallback = cm.fallback;
        else warn("currency.fallback must be a string; using default");
      }
      if ("default" in cm) {
        if (typeof cm.default === "string") out.currency.default = cm.default;
        else warn("currency.default must be a string; using default");
      }
    } else {
      warn("currency must be an object; using default");
    }
  }

  // stale — v0.2.17 dropped the legacy `separator` field. The stale
  // annotation is now appended directly after the template output
  // (no leading separator). The `stale` block is still accepted for
  // forward-compat (e.g. ageEmoji overrides), but only `ageEmoji` is
  // recognized; unknown sub-keys are silently ignored.
  if ("stale" in raw) {
    const s = raw.stale;
    if (!s || typeof s !== "object" || Array.isArray(s)) {
      warn("stale must be an object; using default");
    }
  }

  // countdown — top-level (reset countdown visualization).
  if ("countdown" in raw) {
    const c = raw.countdown;
    if (c && typeof c === "object" && !Array.isArray(c)) {
      const cm = c as Record<string, unknown>;
      if ("resetArrows" in cm) {
        const arr = cm.resetArrows;
        if (
          Array.isArray(arr) &&
          arr.every((v) => typeof v === "string" && !/\n/.test(v)) &&
          arr.length > 0
        ) {
          out.countdown.resetArrows = arr as string[];
        } else {
          warn(
            "countdown.resetArrows must be a non-empty array of single-line strings; using default",
          );
        }
      }
    } else {
      warn("countdown must be an object; using default");
    }
  }

  // timeFormat — top-level (governs reset countdown AND stale suffix).
  if ("timeFormat" in raw) {
    const tf = raw.timeFormat;
    if (tf && typeof tf === "object" && !Array.isArray(tf)) {
      const t = tf as Record<string, unknown>;
      if ("minUnit" in t) {
        if (t.minUnit === "m" || t.minUnit === "s" || t.minUnit === "h")
          out.timeFormat.minUnit = t.minUnit;
        else warn('timeFormat.minUnit must be "m", "s", or "h"; using default');
      }
      if ("maxUnitCount" in t) {
        if (isFiniteNumber(t.maxUnitCount))
          out.timeFormat.maxUnitCount = Math.max(
            1,
            Math.min(4, Math.floor(t.maxUnitCount)),
          );
        else warn("timeFormat.maxUnitCount must be a number; using default");
      }
    } else {
      warn("timeFormat must be an object; using default");
    }
  }

  // v0.4.0+ — tokenFormat (compact number formatting for m_token* modules).
  // All sub-keys are optional; missing → keep default.
  if ("tokenFormat" in raw) {
    const tf = raw.tokenFormat;
    if (tf && typeof tf === "object" && !Array.isArray(tf)) {
      const t = tf as Record<string, unknown>;
      if ("thresholds" in t) {
        if (
          Array.isArray(t.thresholds) &&
          t.thresholds.length === 2 &&
          t.thresholds.every(isFinitePositiveNumber)
        ) {
          const pair = t.thresholds as [number, number];
          if (pair[0] < pair[1]) out.tokenFormat.thresholds = pair;
          else
            warn(
              "tokenFormat.thresholds must be 2 ascending positive numbers; using default",
            );
        } else {
          warn(
            "tokenFormat.thresholds must be [lo, hi] of positive numbers; using default",
          );
        }
      }
      for (const k of [
        "precision",
        "speedPrecision",
        "cachePctPrecision",
      ] as const) {
        if (k in t) {
          if (isFiniteNumber(t[k]) && (t[k] as number) >= 0 && (t[k] as number) <= 4)
            out.tokenFormat[k] = Math.floor(t[k] as number);
          else
            warn(`tokenFormat.${k} must be an integer in [0, 4]; using default`);
        }
      }
      if ("cacheHitThresholds" in t) {
        if (
          Array.isArray(t.cacheHitThresholds) &&
          t.cacheHitThresholds.length === 2 &&
          t.cacheHitThresholds.every(isFiniteNumber)
        ) {
          const pair = t.cacheHitThresholds as [number, number];
          if (pair[0] < pair[1]) out.tokenFormat.cacheHitThresholds = pair;
          else
            warn(
              "tokenFormat.cacheHitThresholds must be 2 ascending numbers; using default",
            );
        } else {
          warn(
            "tokenFormat.cacheHitThresholds must be [lo, hi] numbers; using default",
          );
        }
      }
      // v0.4.0+ — speed scale band overrides. Each direction is
      // an ascending 4-tuple. We validate strictly: a 3-tuple
      // silently falls back to the default; a 5-tuple is also
      // rejected (only 5 bands = 4 thresholds; 4 cutoffs define
      // them).
      if ("speedScaleBands" in t) {
        const sb = t.speedScaleBands;
        if (sb && typeof sb === "object" && !Array.isArray(sb)) {
          const sbm = sb as Record<string, unknown>;
          for (const dir of ["in", "out"] as const) {
            if (dir in sbm) {
              const arr = sbm[dir];
              if (
                Array.isArray(arr) &&
                arr.length === 4 &&
                arr.every(isFiniteNumber)
              ) {
                const quad = arr as [number, number, number, number];
                const ascending = quad[0] < quad[1] && quad[1] < quad[2] && quad[2] < quad[3];
                if (ascending)
                  out.tokenFormat.speedScaleBands[dir] = quad;
                else
                  warn(
                    `tokenFormat.speedScaleBands.${dir} must be 4 ascending numbers; using default`,
                  );
              } else {
                warn(
                  `tokenFormat.speedScaleBands.${dir} must be a 4-tuple of numbers; using default`,
                );
              }
            }
          }
        } else {
          warn("tokenFormat.speedScaleBands must be an object; using default");
        }
      }
    } else {
      warn("tokenFormat must be an object; using default");
    }
  }

  // bar
  if ("bar" in raw) {
    const b = raw.bar;
    if (b && typeof b === "object" && !Array.isArray(b)) {
      const bm = b as Record<string, unknown>;
      if ("width" in bm) {
        // Accept any finite number in [3, 64] — narrower than the [3,32]
        // range first sketched, because wider bars look bad in any
        // statusline context the user might compose this with.
        if (
          isFiniteNumber(bm.width) &&
          (bm.width as number) >= 3 &&
          (bm.width as number) <= 64
        ) {
          out.bar.width = bm.width;
        } else {
          warn("bar.width must be an integer in [3, 64]; using default");
        }
      }
      if ("filled" in bm) {
        if (typeof bm.filled === "string" && !/\n/.test(bm.filled))
          out.bar.filled = bm.filled;
        else warn("bar.filled must be a single-line string; using default");
      }
      if ("empty" in bm) {
        if (typeof bm.empty === "string" && !/\n/.test(bm.empty))
          out.bar.empty = bm.empty;
        else warn("bar.empty must be a single-line string; using default");
      }
    } else {
      warn("bar must be an object; using default");
    }
  }

  // vX.X.X+ — the `separators` config field is REMOVED. Legacy
  // configs that still carry one are silently ignored (no warn, no
  // migration path). Use one of the six built-in s_<name> tokens or
  // `m_label|<text>` for custom separators.

  // v0.4.0+ — legacy `lineTemplate` is REMOVED. The loader still
  // detects the key (so a v0.3.x user gets a clear, actionable
  // warning) but does not migrate or honor the field. Users must
  // move to `statuslineTemplate` (top-level rendered template) +
  // `lineTemplates` (reusable template fragments consumed by
  // `m_template`). The fields are intentionally NOT auto-promoted
  // because the mapping (which preset name to pick) is
  // best-effort and would surprise users with non-default
  // templates — better to make them explicitly migrate.
  if ("lineTemplate" in raw) {
    warn(
      "lineTemplate is removed in v0.4.0; use lineTemplates + " +
      "statuslineTemplate instead. See CHANGELOG.md for the upgrade " +
      "path. Ignoring the legacy field.",
    );
  }

  // v0.4.0+ — `lineTemplates` is a Record<string, string[]> of
  // reusable template fragments. The m_template module's first
  // argument is a key into this record. Nesting protection: any
  // entry containing `m_template` (bare or with colon args) is
  // stripped with a warning — recursion would be invisible to the
  // loader and infinite at render time.
  if ("lineTemplates" in raw) {
    const lt = raw.lineTemplates;
    if (!lt || typeof lt !== "object" || Array.isArray(lt)) {
      warn("lineTemplates must be an object of string arrays; using defaults");
    } else {
      const ltm = lt as Record<string, unknown>;
      const merged: LineTemplates = { ...out.lineTemplates };
      for (const [name, value] of Object.entries(ltm)) {
        // v0.8.14+ — `_`-prefix is reserved for built-in presets.
        // Loader rejects user `lineTemplates._*` entries whose name
        // collides with a key in DEFAULT_LINE_TEMPLATES (the built-in
        // wins, user's entry is dropped with a warn). User-defined
        // `_custom` entries that don't collide with a built-in key
        // are preserved (the `_` is just a naming convention, not
        // ownership). The built-in `_balance_simple`,
        // `_balance_simple-alone`, `_1line`, etc. are protected.
        if (
          name.startsWith("_") &&
          Object.prototype.hasOwnProperty.call(DEFAULT_LINE_TEMPLATES, name)
        ) {
          warn(
            `lineTemplates.${name}: the \`_\`-prefix is reserved for ` +
            `built-in presets; skipping user override. Use a ` +
            `different key (e.g. drop the underscore).`,
          );
          continue;
        }
        if (!Array.isArray(value)) {
          warn(`lineTemplates.${name} must be an array of strings; skipping`);
          continue;
        }
        const cleaned: string[] = [];
        for (const item of value) {
          if (typeof item !== "string") continue;
          if (item === "m_template" || item.startsWith("m_template|")) {
            warn(
              `lineTemplates.${name}: m_template is only allowed inside ` +
              `statuslineTemplate; dropping "${item}"`,
            );
            continue;
          }
          cleaned.push(item);
        }
        if (cleaned.length === 0) {
          warn(`lineTemplates.${name} is empty after cleaning; skipping`);
          continue;
        }
        merged[name] = cleaned;
      }
      out.lineTemplates = merged;
    }
  }

  // v0.8.14+ — `statuslineTemplate` is array-only. The legacy
  // string-form value (one of LEGACY_PRESET_NAMES) auto-migrates to
  // the equivalent `["m_template|_X"]` form with a one-shot stderr
  // warning. Users should write the array form directly to silence
  // the warning. PLAN_PRESETS / BALANCE_PRESETS (v0.4.0–v0.8.13) are
  // gone — presets are now first-class entries in DEFAULT_LINE_TEMPLATES
  // with `_`-prefixed keys.
  //
  // Loader-side migration does NOT do provider-type-aware routing —
  // `"1line"` always migrates to `["m_template|_1line"]` (which uses
  // the default `m_template` mode of "plan" and silently drops on a
  // BALANCE provider). Users on a balance provider must explicitly
  // set `["m_template|_balance_simple|mode|balance"]`. Rationale:
  // the project's "user is explicit, framework doesn't guess"
  // philosophy — mirrors v0.8.13's literal-default labels.
  if ("statuslineTemplate" in raw) {
    const st = raw.statuslineTemplate;
    if (typeof st === "string") {
      // Bare name lookup against LEGACY_PRESET_NAMES. A bare name
      // is migrated to `["m_template|<_name>"]` (the `_` prefix is
      // applied here, since user configs wrote the un-prefixed name).
      // `balance_simple` / `balance_simple-alone` map to the
      // `_balance_simple` / `_balance_simple-alone` entries which
      // include the `_balance_` infix in the key.
      if (LEGACY_PRESET_NAMES.includes(st)) {
        warn(
          `statuslineTemplate: "${st}" is a v0.8.x preset name; ` +
          `auto-migrating to ["m_template|_${st}"]. Write the array ` +
          `form directly to silence this warning.`,
        );
        out.statuslineTemplate = [`m_template|_${st}`];
      } else {
        warn(
          `statuslineTemplate "${st}" is not a known preset ` +
          `(valid: ${LEGACY_PRESET_NAMES.join(", ")}); ` +
          `using default ["m_template|_1line"]`,
        );
        out.statuslineTemplate = DEFAULT_STATUSLINE_TEMPLATE.slice();
      }
    } else if (Array.isArray(st)) {
      const cleaned: string[] = [];
      for (const item of st) {
        if (typeof item === "string") cleaned.push(item);
      }
      out.statuslineTemplate =
        cleaned.length > 0 ? cleaned : DEFAULT_STATUSLINE_TEMPLATE.slice();
    } else {
      warn(
        "statuslineTemplate must be a string[]; using default",
      );
    }
  }

  // v0.8.21+ — opt-in curl --insecure gate. Default false (TLS
  // errors surface normally); user opts in via
  // `"quoteInsecureTls": true` in config.json. No env-var seed —
  // this is a config-file decision. Any non-boolean value
  // (string/number/...) is treated as a typo and silently falls
  // back to the safe default with a stderr warn — the same lenient
  // pattern as fetchTimeoutMs / cacheTtlMs validation.
  if ("quoteInsecureTls" in raw) {
    const v = raw.quoteInsecureTls;
    if (typeof v === "boolean") {
      out.quoteInsecureTls = v;
    } else {
      warn("quoteInsecureTls must be a boolean; using default");
    }
  }

  // vX.X.X+ — tokenPrice: opt-in pricing for m_tokenCost family.
  // All sub-keys optional; missing/invalid → keep default (zero).
  if ("tokenPrice" in raw) {
    const tp = raw.tokenPrice;
    if (tp && typeof tp === "object" && !Array.isArray(tp)) {
      const tpm = tp as Record<string, unknown>;
      for (const key of ["in", "out", "cachedIn"] as const) {
        if (key in tpm) {
          if (typeof tpm[key] === "number" && Number.isFinite(tpm[key]) && (tpm[key] as number) >= 0) {
            out.tokenPrice[key] = tpm[key] as number;
          } else {
            warn(`tokenPrice.${key} must be a non-negative number; using default`);
          }
        }
      }
      if ("currency" in tpm) {
        if (typeof tpm.currency === "string" && tpm.currency.length > 0) {
          out.tokenPrice.currency = tpm.currency.toUpperCase();
        } else {
          warn("tokenPrice.currency must be a non-empty string; using default");
        }
      }
    } else {
      warn("tokenPrice must be an object; using default");
    }
  }

  // Note: the `providers` block is handled separately by mergeConfig
  // (the only caller that processes user-provided provider entries).
  // applyProviderOverrides rejects `providers` at the top of the
  // function, so this helper intentionally doesn't touch it.

  return out;
}

// v0.4.0+ — top-level config.json loader. Wraps applyOverrides with
// the `providers` block handling that lives only at the top layer.
function mergeConfig(raw: Record<string, unknown>): Config {
  const out = applyOverrides(
    JSON.parse(JSON.stringify(DEFAULT_CONFIG)) as Config,
    raw,
  );

  // providers — Record<string, ProviderEntry>. User config is
  // deep-merged on top of DEFAULT_PROVIDERS: existing keys have
  // their fields overridden; new keys are appended. Per-entry
  // validation drops malformed entries with a stderr warn rather
  // than auto-filling (so a typo can't silently produce a half-
  // configured provider that fetches from the wrong endpoint).
  //
  // The "missing `providers` key in user config" case falls back
  // to DEFAULT_PROVIDERS via the deep-clone at the top of
  // mergeConfig — so existing users without a `providers` block
  // keep working unchanged.
  if ("providers" in raw) {
    const p = raw.providers;
    if (!p || typeof p !== "object" || Array.isArray(p)) {
      warn("providers must be an object; using default");
    } else {
      const pm = p as Record<string, unknown>;
      const merged: Record<string, ProviderEntry> = {};
      for (const [name, defaultEntry] of Object.entries(DEFAULT_PROVIDERS)) {
        // Start with the default for known keys; user overrides
        // fields on top below. A partial user entry (e.g. only
        // `ENDPOINT`) inherits the other three fields from the
        // default — so the user can change just one knob without
        // restating the whole entry. A non-object user value (string,
        // array, null) is a user error — drop the entry and warn.
        let seed: Record<string, unknown> | null = null;
        if (name in pm) {
          if (pm[name] && typeof pm[name] === "object" && !Array.isArray(pm[name])) {
            seed = { ...defaultEntry };
            for (const [k, v] of Object.entries(pm[name] as Record<string, unknown>)) {
              if (v !== undefined) seed[k] = v;
            }
          } else {
            warn(`providers.${name} must be an object; dropping`);
          }
        } else {
          // User did not mention this default key → keep it as-is.
          seed = { ...defaultEntry };
        }
        if (seed) {
          const validated = validateProviderEntry(name, seed);
          if (validated) merged[name] = validated;
        }
      }
      // Append any user-defined provider keys NOT in DEFAULT_PROVIDERS.
      for (const [name, value] of Object.entries(pm)) {
        if (name in merged) continue;
        const entry = validateProviderEntry(name, value);
        if (entry) merged[name] = entry;
      }
      out.providers = merged;
    }
  }

  return out;
}

// v0.9.0+ — validate one IntervalSlotConfig. Used by both the
// top-level `intervals` validator (applyOverrides above) and the
// per-provider `intervals` validator (validateProviderEntry
// below). Returns the merged-and-validated slot config (deep-
// merged over the supplied `base`). Drops bad fields with a
// stderr warn; never throws — the caller decides whether to
// proceed with the partially-validated slot.
//
// Field rules:
//   windowId, label, the 7 path fields → string-only
//   intervalS, intervalMs              → positive finite number
//
// The 7 path fields are stored as raw strings here; runtime
// resolution (against the provider response) happens in
// src/api.plan.ts:parseRemains via the path-expr.ts grammar. We don't
// pre-validate paths at config-load time (the response shape
// isn't known yet) — only the SHAPE of each path field
// (string-only).
function validateIntervalSlot(
  key: IntervalKey,
  raw: unknown,
  base: IntervalSlotConfig,
): IntervalSlotConfig {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    warn(`intervals.${key} must be an object; using default`);
    return base;
  }
  const sm = raw as Record<string, unknown>;
  const next: IntervalSlotConfig = { ...base };
  // String fields — windowId / label / the 7 path expressions.
  const stringFields = [
    "windowId", "label",
    "remainingPercent", "usedPercent",
    "startAt", "endAt",
    "remainingQuota", "usedQuota", "limitQuota",
  ] as const;
  for (const f of stringFields) {
    if (typeof sm[f] === "string") {
      (next as Record<string, unknown>)[f] = sm[f];
    } else if (f in sm) {
      warn(`intervals.${key}.${f} must be a string; using default`);
    }
  }
  // Numeric fields — intervalS / intervalMs.
  const numericFields = ["intervalS", "intervalMs"] as const;
  for (const f of numericFields) {
    if (typeof sm[f] === "number" && Number.isFinite(sm[f]) && (sm[f] as number) > 0) {
      (next as Record<string, unknown>)[f] = sm[f];
    } else if (f in sm) {
      warn(`intervals.${key}.${f} must be a positive number; using default`);
    }
  }
  return next;
}

// v0.9.0+ — built-in default intervals for the minimax provider.
// Applied at FETCH TIME by resolveEffectiveIntervals (below) when
// the active provider id matches "minimax". The legacy code-path
// inside `validateProviderEntry` used a URL gate
// (`ENDPOINT.includes("minimaxi.com")`); the move to id-gating
// fixes the case where a user renames the provider id but keeps
// the minimaxi.com URL — they would silently lose defaults. The
// longInterval term has no built-in minimax mapping (the
// /v1/token_plan/remains endpoint doesn't ship a 30-day window) —
// its slot defaults to `{}`.
const MINIMAX_DEFAULT_INTERVALS: IntervalConfig = {
  shortInterval: {
    remainingPercent: "model_remains.0.current_interval_remaining_percent",
    startAt: "model_remains.0.start_time",
    endAt: "model_remains.0.end_time",
  },
  midInterval: {
    remainingPercent: "model_remains.0.current_weekly_remaining_percent",
    startAt: "model_remains.0.weekly_start_time",
    endAt: "model_remains.0.weekly_end_time",
  },
  longInterval: {},
};

// ----- 4-layer intervals merge -----
//
// v0.X.X+ — replace the v0.9.0 single-layer "URL-gate MINIMAX_DEFAULT
// _INTERVALS + validateIntervalSlot user block" model with a 4-layer
// merge keyed on the ACTIVE provider id:
//
//   layer 0  project-builtin GLOBAL defaults (GLOBAL_DEFAULT_INTERVALS)
//   layer 1  project-builtin PER-PROVIDER defaults
//            (BUILTIN_PROVIDER_INTERVALS[id])
//   layer 2  user config.json top-level intervals (configStore.get().intervals)
//   layer 3  user providers.<id>.intervals (entry.intervals)
//
// Layer 1 and layer 3 fire ONLY when the active provider id matches
// the layer's key — so a kimi active provider never inherits minimax
// defaults, and a user's `providers.minimax.intervals` block is never
// applied to a non-minimax provider. Layer 0 and layer 2 are
// unconditional globals.
//
// Each layer deep-merges on top of the previous. The merge is O(9)
// string fields at most — safe to call from the fetch hot path.

// Layer 0 — project-builtin GLOBAL defaults. Maps the canonical
// v0.9.0+ plugin schema (query_plugins/<id>/index.js output) so a
// plugin-style body works out of the box without the user
// configuring intervalsConfig. The mapping assumes the body has
// {shortInterval, midInterval, longInterval} at root, each an
// Interval-shape sub-object with the field names below.
//
// windowId / label are static ("5h" / "7d" / "30d") rather than
// path expressions — the plugin author is free to set whatever
// they want on the sub-object's windowId, but the canonical
// schema's labels are the de-facto industry names. Users who
// want different labels override via layer 2 or layer 3.
//
// usedPercent is NOT mapped: resolvePercentGroup auto-derives
// `100 - remainingPercent` when usedPercent is absent, so
// emitting remainingPercent alone is enough.
const GLOBAL_DEFAULT_INTERVALS: IntervalConfig = {
  shortInterval: {
    windowId: "5h",
    label: "5h",
    remainingPercent: "shortInterval.remainingPercent",
    startAt: "shortInterval.startAt",
    endAt: "shortInterval.endAt",
  },
  midInterval: {
    windowId: "7d",
    label: "7d",
    remainingPercent: "midInterval.remainingPercent",
    startAt: "midInterval.startAt",
    endAt: "midInterval.endAt",
  },
  longInterval: {
    windowId: "30d",
    label: "30d",
    remainingPercent: "longInterval.remainingPercent",
    startAt: "longInterval.startAt",
    endAt: "longInterval.endAt",
  },
};

// Built-in provider defaults. Currently only minimax ships a non-empty
// IntervalConfig; deepseek uses parseBalance which doesn't read
// intervalsConfig today, but the empty constant is shipped so the
// contract is symmetric and a future deepseek parseBalance that does
// read intervals has somewhere to land without a config schema change.
const BUILTIN_PROVIDER_INTERVALS: Record<string, IntervalConfig> = {
  minimax: MINIMAX_DEFAULT_INTERVALS,
  // deepseek ships no intervals defaults (it uses parseBalance
  // / currenciesConfig instead); absent key = Layer 1 doesn't fire.
  deepseek: {},
};

// Resolve the effective IntervalConfig for the active provider by
// merging all four layers in order. See the block comment above for
// the merge contract. Pure read against configStore — no mutation.
// `entry` is the active provider's ProviderEntry (from
// configStore.get().providers[id]); pass null for the no-provider
// case to still get layers 0 + 2.
//
// vX.X.X+ — switch to SHALLOW ASSIGNMENT per layer. Each layer's
// `shortInterval` / `midInterval` / `longInterval` slot, when
// present, REPLACES the previous layer's value verbatim rather
// than deep-merging on top of it. Rationale: per-layer configs are
// authored as whole units (e.g. `intervals.shortInterval: { … }`),
// not as additive patches; a partial slot would otherwise inherit
// stale fields from an earlier layer (e.g. a user who sets only
// `label` would silently keep the built-in `remainingPercent`
// path). The shallow-assign contract mirrors the vX.X.X+ change to
// `resolveEffectiveCurrencies` and the `multi-layer override wins`
// principle from [[new-feature-convention]] — no default silently
// leaks through.
export function resolveEffectiveIntervals(
  activeProviderId: string,
  entry: ProviderEntry | null,
): IntervalConfig {
  // Layer 0 — project-builtin GLOBAL defaults (unconditional).
  const out: IntervalConfig = {
    shortInterval: { ...GLOBAL_DEFAULT_INTERVALS.shortInterval },
    midInterval: { ...GLOBAL_DEFAULT_INTERVALS.midInterval },
    longInterval: { ...GLOBAL_DEFAULT_INTERVALS.longInterval },
  };
  // Layer 1 — built-in per-provider defaults. Gate on active id.
  // Shallow: each declared slot fully replaces the layer-0 value.
  // Empty slots ({}) are skipped so they don't wipe layer-0 fields
  // — important for MINIMAX_DEFAULT_INTERVALS.longInterval which
  // intentionally ships as {} (no 30d window in the real API).
  const builtin = BUILTIN_PROVIDER_INTERVALS[activeProviderId];
  if (builtin) {
    if (hasAnyField(builtin.shortInterval))
      out.shortInterval = { ...builtin.shortInterval };
    if (hasAnyField(builtin.midInterval))
      out.midInterval = { ...builtin.midInterval };
    if (hasAnyField(builtin.longInterval))
      out.longInterval = { ...builtin.longInterval };
  }
  // Layer 2 — user top-level intervals (unconditional). Shallow:
  // each declared slot fully replaces the layer-1 (or layer-0)
  // value. Absent slots keep the previous layer's value. Empty
  // slots ({}) are treated as absent — the user must declare at
  // least one field for a slot to be considered an override,
  // otherwise a typo'd `intervals: { shortInterval: {} }` would
  // silently wipe built-in defaults.
  const top = configStore.get().intervals;
  if (top) {
    if (hasAnyField(top.shortInterval))
      out.shortInterval = { ...top.shortInterval };
    if (hasAnyField(top.midInterval))
      out.midInterval = { ...top.midInterval };
    if (hasAnyField(top.longInterval))
      out.longInterval = { ...top.longInterval };
  }
  // Layer 3 — user per-provider intervals. By construction entry IS
  // the active provider's entry, but we re-check the id so the gate
  // logic is obvious to a reader skimming this function in
  // isolation. Shallow: same rule as layers 1 + 2. Empty slots
  // ({}) are treated as absent.
  if (entry && entry.intervals) {
    if (hasAnyField(entry.intervals.shortInterval))
      out.shortInterval = { ...entry.intervals.shortInterval };
    if (hasAnyField(entry.intervals.midInterval))
      out.midInterval = { ...entry.intervals.midInterval };
    if (hasAnyField(entry.intervals.longInterval))
      out.longInterval = { ...entry.intervals.longInterval };
  }
  return out;
}

// Helper: a slot "overrides" when it has at least one defined
// field. `{}` is treated as no-op so empty-slot placeholders
// (e.g. MINIMAX_DEFAULT_INTERVALS.longInterval, where minimax's
// real API doesn't ship a 30d window) don't wipe earlier-layer
// fields. `{ remainingPercent: "x" }` is an override — the
// shallow-assign contract means missing fields now read undefined
// for that slot, which is exactly the user's intent when they
// author a partial slot.
function hasAnyField(slot: IntervalSlotConfig | undefined): boolean {
  if (!slot) return false;
  for (const _ in slot) return true;
  return false;
}

// ----- 4-layer currencies merge (vX.X.X+) -----
//
// Mirror of the intervalsConfig 4-layer merge, keyed on currency
// code (CNY / USD / …) instead of interval term. Each layer is a
// flat dict `{ CODE: { label?, totalBalance? } }`; the merge is
// done per-KEY with SHALLOW ASSIGNMENT — a layer that declares
// `{ CNY: { label: "$" } }` fully replaces the previous layer's
// CNY slot (the path expression `totalBalance` from layer-1 is
// NOT preserved alongside the new label).
//
//   layer 0  project-builtin GLOBAL defaults (empty by design —
//            per-provider defaults are richer than any global)
//   layer 1  project-builtin PER-PROVIDER defaults
//            (BUILTIN_PROVIDER_CURRENCIES[id])
//   layer 2  user config.json top-level currencies
//            (configStore.get().currencies)
//   layer 3  user providers.<id>.currencies (entry.currencies)
//
// Layer 1 and layer 3 fire ONLY when the active provider id matches
// the layer's key — same gate pattern as resolveEffectiveIntervals.
// Layer 0 and layer 2 are unconditional globals.

// Built-in per-provider defaults. Currently only deepseek ships a
// non-empty CurrenciesConfig: CNY → balance_infos.0.total_balance,
// which mirrors the v0.5.0–v0.8.x DeepSeek default response shape
// (a single CNY entry under `balance_infos[0]`). The label is the
// same ￥ glyph the legacy `cfg().currency.prefixes.CNY` mapping
// produced, so existing renders stay byte-identical after upgrade.
// minimax uses parseRemains (TOKEN_PLAN), so its slot is empty.
const BUILTIN_PROVIDER_CURRENCIES: Record<string, CurrenciesConfig> = {
  deepseek: {
    CNY: {
      label: "￥",
      totalBalance: "balance_infos.0.total_balance",
    },
  },
  minimax: {},
};

// Resolve the effective CurrenciesConfig for the active provider by
// merging all four layers in order. See the block comment above for
// the shallow-assign / per-key merge contract. Pure read against
// configStore — no mutation. `entry` is the active provider's
// ProviderEntry (from configStore.get().providers[id]); pass null
// for the no-provider case to still get layers 0 + 2.
//
// The output keys are the union of all declared keys across layers,
// in declaration order (layer 0 → 1 → 2 → 3). A key absent from
// every layer is dropped. A key whose slot ends up empty after
// merge is preserved with `{}` so the renderer can still surface
// the code (e.g. for "CNY: --" rendering) without losing key
// ordering.
export function resolveEffectiveCurrencies(
  activeProviderId: string,
  entry: ProviderEntry | null,
): CurrenciesConfig {
  const out: CurrenciesConfig = {};
  // Layer 1 — built-in per-provider defaults. Gate on active id.
  const builtin = BUILTIN_PROVIDER_CURRENCIES[activeProviderId];
  if (builtin) {
    for (const [k, v] of Object.entries(builtin)) {
      out[k] = { ...v };
    }
  }
  // Layer 2 — user top-level currencies (unconditional). Per-key
  // shallow assign.
  const top = configStore.get().currencies;
  if (top) {
    for (const [k, v] of Object.entries(top)) {
      out[k] = { ...v };
    }
  }
  // Layer 3 — user per-provider currencies. Per-key shallow
  // assign. By construction entry IS the active provider's entry,
  // but we re-check the id so the gate logic is obvious to a
  // reader skimming this function in isolation.
  if (entry && entry.currencies) {
    for (const [k, v] of Object.entries(entry.currencies)) {
      out[k] = { ...v };
    }
  }
  return out;
}

// Validate one CurrencySlotConfig (vX.X.X+). Mirrors
// `validateIntervalSlot`'s shape rules: `label` must be a string,
// `totalBalance` must be a string (path expression — runtime
// resolution happens in parseBalance). Bad fields drop with a
// stderr warn; the rest of the slot survives. The caller decides
// whether to proceed with a partially-validated slot.
//
// Unlike validateIntervalSlot, there's no `base` argument —
// CurrencySlotConfig has only 2 fields, so per-key shallow assign
// at the resolver level is the same as "fresh slot per layer".
function validateCurrencySlot(
  key: string,
  raw: unknown,
): CurrencySlotConfig | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    warn(`currencies.${key} must be an object; dropping the entry`);
    return null;
  }
  const sm = raw as Record<string, unknown>;
  const next: CurrencySlotConfig = {};
  if ("label" in sm) {
    if (typeof sm.label === "string") {
      next.label = sm.label;
    } else {
      warn(`currencies.${key}.label must be a string; dropping the field`);
    }
  }
  if ("totalBalance" in sm) {
    if (typeof sm.totalBalance === "string") {
      next.totalBalance = sm.totalBalance;
    } else {
      warn(`currencies.${key}.totalBalance must be a string (path expression); dropping the field`);
    }
  }
  return next;
}

// Validate one CurrenciesConfig block (top-level or per-provider).
// Returns the validated map; malformed entries drop with a stderr
// warn. Used by both the top-level `currencies` validator
// (applyOverrides below) and the per-provider `currencies`
// validator (validateProviderEntry below).
function validateCurrenciesBlock(
  blockKind: "top-level currencies" | "provider currencies",
  raw: unknown,
): CurrenciesConfig {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    warn(`${blockKind} must be an object; dropping the block`);
    return {};
  }
  const out: CurrenciesConfig = {};
  const rm = raw as Record<string, unknown>;
  for (const [k, v] of Object.entries(rm)) {
    const validated = validateCurrencySlot(k, v);
    if (validated !== null) {
      out[k] = validated;
    }
  }
  return out;
}

// Validate one ProviderEntry. Returns the validated entry or null if
// the entry is fatally malformed. The caller (`mergeConfig`) is
// responsible for filling missing fields from the default entry
// before calling this — we validate the merged result, not the raw
// user input. A partial user entry (e.g. only `ENDPOINT`) thus
// preserves the other three fields from the default; an invalid
// `TYPE` on an otherwise-OK entry drops the whole thing.
function validateProviderEntry(name: string, v: unknown): ProviderEntry | null {
  if (!v || typeof v !== "object" || Array.isArray(v)) {
    warn("provider entry must be an object; dropping");
    return null;
  }
  const e = v as Record<string, unknown>;
  // TYPE
  const t = e.TYPE;
  if (typeof t !== "string" || !VALID_PROVIDER_TYPES.has(t as ProviderType)) {
    warn(`provider TYPE must be "TOKEN_PLAN" or "BALANCE" (got ${JSON.stringify(t)}); dropping`);
    return null;
  }
  // BASE_URL_COMPARED_TO
  const base = e.BASE_URL_COMPARED_TO;
  if (typeof base !== "string" || base.length === 0) {
    warn("provider BASE_URL_COMPARED_TO must be a non-empty string; dropping");
    return null;
  }
  // COMPARE_METHOD
  const cm = e.COMPARE_METHOD;
  if (typeof cm !== "string" || !VALID_COMPARE_METHODS.has(cm as CompareMethod)) {
    warn(`provider COMPARE_METHOD must be one of "EXACT", "INCLUDE", "STARTWITH" (got ${JSON.stringify(cm)}); dropping`);
    return null;
  }
  // ENDPOINT — see src/api.ts:detectTransport for the runtime
  // interpretation. Three accepted shapes:
  //   - "http://..." / "https://..." → httpTransport
  //   - any other non-empty string    → execTransport (execSync(ep))
  //   - "" (only valid when
  //     query_plugins/<id>/index.{js,mjs} exists) → pluginTransport.
  //     config-load accepts the empty string here so the user's
  //     "wire a plugin script later" workflow doesn't trip the
  //     validator; detectTransport THROWS at fetch time if the
  //     plugin file is absent, but we mirror that decision here so
  //     a misconfigured entry never silently becomes a no-provider
  //     render (which would drop every type:"plan"/"balance" module).
  const ep = e.ENDPOINT;
  if (typeof ep !== "string") {
    warn(`providers.${name} ENDPOINT must be a string; dropping`);
    return null;
  }
  if (ep.length === 0) {
    // Reuse detectTransport's resolution: it walks .js then .mjs.
    // If neither exists it would throw — we want a boolean here,
    // so wrap in try/catch. The empty-string branch is the only
    // path in detectTransport that throws, so the catch is narrow.
    let pluginOk = false;
    try {
      detectTransport(ep, name);
      pluginOk = true;
    } catch {
      pluginOk = false;
    }
    if (!pluginOk) {
      warn(
        `providers.${name} ENDPOINT="" but no query_plugins/${name}/index.{js,mjs} on disk; dropping`,
      );
      return null;
    }
  }
  // Surface-to-stderr hint when the ENDPOINT looks like a shell
  // command (non-HTTP, non-empty). The transport dispatcher is going
  // to execSync() this verbatim — the user almost certainly intended
  // an http URL if they didn't start with http(s), so the warn helps
  // catch typos at config-load rather than at runtime. The empty
  // string is exempt: it's the explicit "use the bundled plugin"
  // signal, never executed as a shell command.
  if (ep.length > 0 && !/^https?:\/\//.test(ep)) {
    warn(
      `provider ENDPOINT "${ep}" does not start with http(s) — will be executed as a shell command`,
    );
  }
  // v0.6.0+ — optional per-provider HTTP method. STRICT: any value
  // outside the closed enum drops the whole entry, matching the
  // TYPE/COMPARE_METHOD pattern. The user almost certainly has a
  // typo or copied a verb from a different API ("get" lowercase,
  // "PATCH " with stray whitespace, "OPTIONS", …). Silently
  // coercing or accepting would mask the bug.
  let validatedMethod:
    | "GET"
    | "POST"
    | "PUT"
    | "PATCH"
    | "DELETE"
    | undefined;
  if ("METHOD" in e && e.METHOD !== undefined) {
    const m = e.METHOD;
    if (typeof m !== "string" || !VALID_HTTP_METHODS.has(m as never)) {
      warn(
        `provider METHOD must be one of ${[...VALID_HTTP_METHODS].join(", ")} (got ${JSON.stringify(m)}); dropping the entry`,
      );
      return null;
    }
    validatedMethod = m as
      | "GET"
      | "POST"
      | "PUT"
      | "PATCH"
      | "DELETE";
  }
  // v0.6.0+ — optional per-provider Bearer token. LENIENT: a bad
  // value drops just the field; the entry still loads. Rationale:
  // BEARER_KEY without an entry-level fallback is recoverable
  // because the fetcher falls back to process.env.ANTHROPIC_AUTH_TOKEN
  // when BEARER_KEY is absent. The user might be testing the field
  // incrementally and a partial block shouldn't cost the whole entry.
  let validatedBearer: string | undefined;
  if ("BEARER_KEY" in e && e.BEARER_KEY !== undefined) {
    const b = e.BEARER_KEY;
    if (typeof b === "string" && b.length > 0) {
      validatedBearer = b;
    } else {
      warn("provider BEARER_KEY must be a non-empty string; dropping the field");
    }
  }
  // v0.6.0+ — optional static JSON request body. LENIENT: same
  // rationale as BEARER_KEY. A bad body shape drops the field; the
  // entry survives. Note: an empty `{}` is a valid object and will
  // be forwarded (some servers accept it).
  let validatedBody: Record<string, unknown> | undefined;
  if ("BODY" in e && e.BODY !== undefined) {
    const body = e.BODY;
    if (body && typeof body === "object" && !Array.isArray(body)) {
      validatedBody = body as Record<string, unknown>;
    } else {
      warn("provider BODY must be a plain object; dropping the field");
    }
  }
  // v0.4.0+ — optional provider-specific Config overrides. Validated
  // here only for shape (must be a plain object, no nested `providers`
  // key to avoid recursion). The fields inside `config` are merged
  // into the active Config snapshot at startup via
  // configStore.applyProviderOverrides(provider); per-field validators
  // are applied at THAT time so a typo still produces a stderr warn.
  if ("config" in e && e.config !== undefined) {
    const c = e.config;
    if (!c || typeof c !== "object" || Array.isArray(c)) {
      warn(`provider.config must be an object (got ${typeof c}); dropping the entry`);
      return null;
    }
    const cm = c as Record<string, unknown>;
    if ("providers" in cm) {
      warn(
        "provider.config must not contain a nested 'providers' key (would recurse); dropping the entry",
      );
      return null;
    }
  }
  // Forward the validated `config` block (or omit it entirely if
  // the user didn't supply one) so downstream readers see a
  // consistent shape.
  const validatedConfig =
    "config" in e &&
    e.config &&
    typeof e.config === "object" &&
    !Array.isArray(e.config)
      ? (e.config as Record<string, unknown>)
      : undefined;
  // v0.9.0+ — forward the user-supplied `intervals` block (the
  // data-driven per-interval slot mapping). Replaces the v0.5.0–
//  v0.8.x flat `parameters` block. Built-in provider defaults
  // (the minimax model_remains[0].* paths) are NOT layered in here
  // — they fire at FETCH TIME in resolveEffectiveIntervals (above),
  // gated on the active provider id. So a kimi active provider
  // never inherits minimax-style defaults even if the user's
  // providers.minimax entry still exists with the URL pointing at
  // minimaxi.com.
  //
  // Per-key validation reuses `validateIntervalSlot` (defined
  // above) — same shape rules as the top-level `intervals`
  // validator. Lenient: bad fields drop with a stderr warn; the
  // entry itself stays loaded.
  let validatedIntervals: IntervalConfig = {};
  if ("intervals" in e && e.intervals !== undefined) {
    const rawIntervals = e.intervals;
    if (
      !rawIntervals ||
      typeof rawIntervals !== "object" ||
      Array.isArray(rawIntervals)
    ) {
      warn("provider.intervals must be an object; dropping the block");
    } else {
      const rIm = rawIntervals as Record<string, unknown>;
      for (const k of ["shortInterval", "midInterval", "longInterval"] as IntervalKey[]) {
        if (k in rIm) {
          validatedIntervals[k] = validateIntervalSlot(
            k,
            rIm[k],
            validatedIntervals[k] ?? {},
          );
        }
      }
    }
  }
  // vX.X.X+ — forward the user-supplied `currencies` block. Layer 3
  // of the 4-layer merge in resolveEffectiveCurrencies. Built-in
  // per-provider defaults (deepseek's CNY → balance_infos.0.total
  // _balance) are NOT layered in here — they fire at FETCH TIME in
  // resolveEffectiveCurrencies, gated on the active provider id.
  // Same gate pattern as the per-provider `intervals` block above:
  // a kimi active provider never inherits deepseek-style defaults
  // even if the user's providers.deepseek entry still exists with
  // the URL pointing at api.deepseek.com.
  //
  // Per-key validation reuses `validateCurrenciesBlock` (defined
  // above) — same shape rules as the top-level `currencies`
  // validator. Lenient: bad fields drop with a stderr warn; the
  // entry itself stays loaded.
  let validatedCurrencies: CurrenciesConfig = {};
  if ("currencies" in e && e.currencies !== undefined) {
    validatedCurrencies = validateCurrenciesBlock(
      "provider currencies",
      e.currencies,
    );
  }
  return {
    TYPE: t as ProviderType,
    BASE_URL_COMPARED_TO: base,
    COMPARE_METHOD: cm as CompareMethod,
    ENDPOINT: ep,
    ...(validatedConfig ? { config: validatedConfig } : {}),
    ...(validatedIntervals ? { intervals: validatedIntervals } : {}),
    ...(validatedCurrencies && Object.keys(validatedCurrencies).length > 0
      ? { currencies: validatedCurrencies }
      : {}),
    ...(validatedBearer ? { BEARER_KEY: validatedBearer } : {}),
    ...(validatedMethod ? { METHOD: validatedMethod } : {}),
    ...(validatedBody ? { BODY: validatedBody } : {}),
  };
}

// ----- Test-only -----

export function __resetForTest(overrides?: Partial<Config>): void {
  if (overrides === undefined) {
    // v0.2.17: deep-clone DEFAULT_CONFIG before assigning. setVersion()
    // mutates _current.version in place; if _current WERE DEFAULT_CONFIG
    // itself, that mutation would leak across reset calls. Cloning
    // makes the reset path symmetric with the overrides branch.
    _current = JSON.parse(JSON.stringify(DEFAULT_CONFIG)) as Config;
    return;
  }
  // Deep-merge so tests can override `stale: { separator: " · " }`
  // without erasing colors / bar / etc. Plain `...DEFAULT_CONFIG,
  // ...overrides` would replace the whole `stale` object with a partial
  // one missing separator / ageEmoji.
  const base = JSON.parse(JSON.stringify(DEFAULT_CONFIG)) as Config;
  const merged = deepMerge(
    base,
    overrides as Record<string, unknown>,
  ) as Config;
  _current = merged;
}

function deepMerge(base: unknown, over: unknown): unknown {
  if (over === undefined) return base;
  if (over === null || typeof over !== "object" || Array.isArray(over))
    return over;
  if (base === null || typeof base !== "object" || Array.isArray(base))
    return over;
  const out: Record<string, unknown> = { ...(base as Record<string, unknown>) };
  for (const [k, v] of Object.entries(over as Record<string, unknown>)) {
    out[k] = v === undefined ? out[k] : deepMerge(out[k], v);
  }
  return out;
}

export const __testing = {
  DEFAULT_CONFIG,
  configPath: defaultConfigPath,
  setPathResolver(fn: () => string): void {
    _pathResolver = fn;
  },
  resetPathResolver(): void {
    _pathResolver = defaultConfigPath;
  },
};
