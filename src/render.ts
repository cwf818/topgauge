// Pure rendering helpers: split-bar (left colorless / right colored),
// 5-band thresholds, ANSI coloring, and line assembly.
//
// All tunable values (colors, thresholds, bar geometry, currency
// prefixes, display-mode labels, stale annotation formatting) come
// from the singleton in ./config.ts. The defaults in config.ts match
// today's hardcoded values exactly.
//
// v0.2.17: the line layout is now driven by a `lineTemplate` config
// field — an ordered list of display-module tokens (m_modeLabel,
// m_window5h, m_countdown5h, m_window7d, m_countdown7d, m_balance,
// m_age, m_version) and separator references (s_0, s_1, …).
// `formatLine` and `formatBalanceLine` are preserved as compatibility
// shims that expand the default templates; new code should call
// `renderProviderLine` directly.

import { configStore, warn } from "./config.ts";
import { providerTypeFor } from "./providers.ts";
import { PLAN_PRESETS, BALANCE_PRESETS } from "./config.ts";
import type { TokenSample, TokenSnapshot } from "./types.ts";
import {
  buildRainbow,
  buildHue,
  parseFreq,
  pickQuote,
  quoteIndex,
  type QuoteFreq,
} from "./quotes.ts";
import { readAllSamples, projectHash } from "./token-store.ts";
import { readGitInfo } from "./git-info.ts";
import * as statusStore from "./status-store.ts";
import * as cache from "./cache.ts";

export type Window = {
  // Percentage USED in [0, 100]. May be fractional; we'll round.
  pct: number;
  // ISO timestamp string when the window resets, if known.
  resetAt?: string | null;
  // ISO timestamp string for when the current window STARTED. Paired with
  // resetAt so we can compute the window's total duration and pick a
  // fill-state-appropriate reset arrow (⏳ when plenty of time remains,
  // ⌛ when the window is mostly consumed). Optional — DeepSeek has no
  // such concept, so missing fields fall back to the legacy single-arrow.
  resetStartAt?: string | null;
  // Window length in milliseconds (resetAt - resetStartAt). Optional;
  // required for the split-arrow logic, falls back to a single arrow when
  // missing. Kept as a separate field so callers don't have to re-parse the
  // ISO strings inside hot render paths.
  resetDurationMs?: number | null;
};

export type DisplayMode = "remaining" | "used";

// Shorthand for the active config snapshot. Reading configStore.get()
// on every call would be wasteful for hot paths (every formatLine call
// does many color/band lookups) — the helpers below read it lazily.
function cfg() {
  return configStore.get();
}

// v0.8.0+ — top-level token-label resolver. Each call reads
// configStore (same lazy-read pattern as `cfg()`) and returns the
// configured prefix for the requested axis. The four axes map 1:1
// to the v0.8.0+ config schema:
//   "in"      → cfg().labels.labelIn      (per-turn delta, totals, acc, sum, avg-in-speed)
//   "out"     → cfg().labels.labelOut     (per-turn delta, totals, acc, sum, avg-out-speed)
//   "cacheIn" → cfg().labels.labelCacheIn (cache-read columns: per-turn, acc, sum)
//   "totalIn" → cfg().labels.labelTotalIn (session-cumulative total_input / sum-totalIn / acc-totalIn)
// Defaults reproduce the v0.7.x literal "in:" / "out:" / "cache:"
// / "Total:" so existing line templates render byte-identical until
// the user overrides labels.* in config.json.
type LabelAxis = "in" | "out" | "cacheIn" | "totalIn";
function labelFor(axis: LabelAxis): string {
  const labels = cfg().labels;
  switch (axis) {
    case "in": return labels.labelIn;
    case "out": return labels.labelOut;
    case "cacheIn": return labels.labelCacheIn;
    case "totalIn": return labels.labelTotalIn;
  }
}

// Exported so sibling modules (src/dispatch.ts, src/composition.ts) can
// compose colored output without duplicating these literal strings.
export const RESET = "\x1b[0m";

// 256-color SGR sequences are read from configStore so a user can
// override any band via config.json. We re-export them under the same
// names so existing imports (RED, RESET) keep working.
export const BRIGHT_GREEN = configStore.get().colors.brightGreen;
export const DARK_GREEN = configStore.get().colors.darkGreen;
export const YELLOW = configStore.get().colors.yellow;
export const ORANGE = configStore.get().colors.orange;
export const RED = configStore.get().colors.red;
// Used for the stale-on-error annotation (" · 5m ago"). ANSI bright black
// (\x1b[90m) reads as "dim gray" on both light and dark terminals.
export const STALE_COLOR = configStore.get().colors.stale;
// v0.6.0+ — distinct color for the BROKEN-chain "⛓️‍💥 X ago" annotation
// emitted when the fetch failed AND we're rendering the last cached
// value (formatStaleSuffix with healthy=false). Splits the gray stale
// color into a two-axis vocabulary: gray for "informational / fresh
// but stale-data" (🔗), dark red for "degraded / fetch failed" (⛓️‍💥).
// Default `\x1b[31m` (basic dark red) — high contrast on light/dark
// terminals, no 256-color palette dependence.
export const BROKEN_COLOR = configStore.get().colors.broken;

// 5-band thresholds applied to the **displayed** value (so remaining/used
// modes share the same numeric thresholds — only the meaning flips).
// In "remaining" mode the bands run high → low: bright green / dark green /
// yellow / orange / red, because more remaining = healthier. In "used" mode
// the bands run low → high: bright green / dark green / yellow / orange /
// red, because less used = healthier. We achieve this by indexing into the
// SAME 5-color palette from opposite ends.
function colorThresholds(): readonly number[] {
  return cfg().thresholds.minimaxPercent;
}

// 5-color palette indexed by band (0..4). In "remaining" mode, band 0
// (lowest remaining) gets RED and band 4 (most remaining) gets BRIGHT_GREEN.
// In "used" mode the mapping is reversed.
function paletteByUsed(): readonly string[] {
  const c = cfg().colors;
  return [c.brightGreen, c.darkGreen, c.yellow, c.orange, c.red];
}

// In "remaining" mode we want the LOW band → red, so this is the
// REVERSE of paletteByUsed().
function paletteByRemaining(): readonly string[] {
  const c = cfg().colors;
  return [c.red, c.orange, c.yellow, c.darkGreen, c.brightGreen];
}

function bandIndex(value: number, thresholds: readonly number[]): number {
  // thresholds[i] is the upper bound for band i (exclusive on the low end).
  // 5 bands total: [0, t0), [t0, t1), [t1, t2), [t2, t3), [t3, 100].
  // Values exactly AT a threshold belong to the band above it (the less
  // dangerous band) — this matches the natural reading of "0/20/40/60/80"
  // where 20 itself marks the transition INTO dark green, not the end of
  // bright green.
  const v = Math.max(0, Math.min(100, value));
  for (let i = 0; i < thresholds.length; i++) {
    if (v < thresholds[i]) return i;
  }
  return thresholds.length; // top band
}

export function colorFor(displayedPct: number, mode: DisplayMode): string {
  const idx = bandIndex(displayedPct, colorThresholds());
  if (mode === "remaining") return paletteByRemaining()[idx];
  return paletteByUsed()[idx];
}

// Split-bar with a fixed positional layout:
//   [<USED cells>][<REMAINING cells>]
// USED cells use the configured "filled" glyph (default ▓), REMAINING
// cells use the configured "empty" glyph (default ░). The side that
// gets COLORED depends on the mode:
//   used mode      → color the LEFT (used cells)     — colored by used%
//   remaining mode → color the RIGHT (remaining cells) — colored by remaining%
// This is the unified rule "left = used, right = remaining; the metric the
// user is thinking about as 'danger' is the one that gets the color".
export type SplitBar = {
  leftChunk: string; // LEFT half of bar — colored if mode==='used', plain otherwise
  rightChunk: string; // RIGHT half of bar — colored if mode==='remaining', plain otherwise
  color: string;
};

export function splitBar(
  usedPct: number,
  mode: DisplayMode,
  width = configStore.get().bar.width,
): SplitBar {
  const used = Math.max(0, Math.min(100, usedPct));
  const remaining = 100 - used;

  // Color follows the DISPLAYED value (the number shown next to the bar).
  const displayed = mode === "remaining" ? remaining : used;
  const color = colorFor(displayed, mode);

  const coloredSize = Math.round((displayed / 100) * width);
  const plainSize = Math.max(0, width - coloredSize);

  const filled = cfg().bar.filled;
  const empty = cfg().bar.empty;

  // Layout: left = used cells, right = remaining cells. The side that
  // gets color wraps is the "metric of concern" (used in "used" mode,
  // remaining in "remaining" mode). Glyphs flip in remaining mode so
  // the bar reads left-to-right as "what's spent ▓▓▓░░░ what's left":
  //   used      : left=used▓ (colored),  right=remaining░ (plain)
  //   remaining : left=used░ (plain),    right=remaining▓ (colored)
  if (mode === "used") {
    const left = filled.repeat(coloredSize);
    const right = empty.repeat(plainSize);
    return {
      leftChunk: coloredSize > 0 ? `${color}${left}${RESET}` : "",
      rightChunk: right,
      color,
    };
  }
  // mode === "remaining"
  const left = empty.repeat(plainSize);
  const right = filled.repeat(coloredSize);
  return {
    leftChunk: left,
    rightChunk: coloredSize > 0 ? `${color}${right}${RESET}` : "",
    color,
  };
}

// Backwards-compatible simple "filled on left" bar — exported for tests but
// not used by formatOne anymore.
export function pctBar(usedPctValue: number, width = configStore.get().bar.width): { filled: string; empty: string } {
  const clamped = Math.max(0, Math.min(100, usedPctValue));
  const filledCount = Math.round((clamped / 100) * width);
  const emptyCount = Math.max(0, width - filledCount);
  return {
    filled: cfg().bar.filled.repeat(filledCount),
    empty: cfg().bar.empty.repeat(emptyCount),
  };
}

// v0.2.17: factor of formatOne() — returns the bar + colored-percent
// portion only (no reset countdown, no window label). The reset
// annotation is rendered by the m_countdown5h / m_countdown7d modules
// independently so the lineTemplate can place them as separate tokens.
// `formatOne` is kept as the canonical helper that joins these two
// parts (plus a leading space) for callers that want the old combined
// form (and for tests that assert on it).
function formatOneChunk(
  w: Window,
  mode: DisplayMode,
  width = cfg().bar.width,
  // v0.6.0+: when stale=true, the WHOLE colored span (bar chunks
  // AND percent tail) wraps in STALE_COLOR instead of the band-based
  // color — the gray sweep is meant to read as "this number is
  // lying; the fetch failed". splitBar() itself is left untouched
  // (tests assert on its .color field at render.test.ts:30-93), so
  // we post-process its output here: rebuild the colored bar chunks
  // directly with STALE_COLOR wrapping. The plain (uncolored) side
  // of the bar stays plain — we only override the side that would
  // have been band-colored. Inline :color| overrides still win
  // (see formatOneChunkColored and the INLINE_RENDERERS no-:color|
  // branch path below).
  stale: boolean = false,
): string {
  const usedPct = Math.max(0, Math.min(100, Math.round(w.pct)));
  const remainingPct = 100 - usedPct;
  const displayedPct = mode === "remaining" ? remainingPct : usedPct;
  const bar = splitBar(usedPct, mode, width);
  if (!stale) {
    return `${bar.leftChunk}${bar.rightChunk} ${bar.color}${displayedPct}%${RESET}`;
  }
  // stale=true → rewrite the colored chunks AND the percent tail in
  // STALE_COLOR. The plain side of the bar (whichever half is not
  // the "metric of concern" for the active mode) stays plain so the
  // user can still read the "what's used vs what's left" shape from
  // the bar's filled/empty glyph pattern.
  const filled = cfg().bar.filled;
  const empty = cfg().bar.empty;
  const coloredSize = Math.round((displayedPct / 100) * width);
  const plainSize = Math.max(0, width - coloredSize);
  let leftChunk: string;
  let rightChunk: string;
  if (mode === "used") {
    const left = filled.repeat(coloredSize);
    const right = empty.repeat(plainSize);
    leftChunk = coloredSize > 0 ? `${STALE_COLOR}${left}${RESET}` : "";
    rightChunk = right;
  } else {
    const left = empty.repeat(plainSize);
    const right = filled.repeat(coloredSize);
    leftChunk = left;
    rightChunk = coloredSize > 0 ? `${STALE_COLOR}${right}${RESET}` : "";
  }
  return `${leftChunk}${rightChunk} ${STALE_COLOR}${displayedPct}%${RESET}`;
}

// v0.3.3+ variant: same layout, but the colored side of the bar AND
// the percentage are wrapped in `override` instead of the band-based
// color. The plain (uncolored) side of the bar stays plain. Used by
// the inline-args path when the user supplied a `|color|<c>` override
// on m_window5h / m_window7d — the user's color REPLACES the natural
// band-based color (no "ignore on conflict" carve-out; the override
// always wins). Returns the same string shape as `formatOneChunk`.
function formatOneChunkColored(
  w: Window,
  mode: DisplayMode,
  override: string,
  width = cfg().bar.width,
): string {
  const usedPct = Math.max(0, Math.min(100, Math.round(w.pct)));
  const remainingPct = 100 - usedPct;
  const displayedPct = mode === "remaining" ? remainingPct : usedPct;
  const filled = cfg().bar.filled;
  const empty = cfg().bar.empty;
  const coloredSize = Math.round((displayedPct / 100) * width);
  const plainSize = Math.max(0, width - coloredSize);
  if (mode === "used") {
    const left = filled.repeat(coloredSize);
    const right = empty.repeat(plainSize);
    const leftChunk = coloredSize > 0 ? `${override}${left}${RESET}` : "";
    return `${leftChunk}${right} ${override}${displayedPct}%${RESET}`;
  }
  // mode === "remaining"
  const left = empty.repeat(plainSize);
  const right = filled.repeat(coloredSize);
  const rightChunk = coloredSize > 0 ? `${override}${right}${RESET}` : "";
  return `${left}${rightChunk} ${override}${displayedPct}%${RESET}`;
}

// Decide whether a window's countdown should be displayed as the
// `n/a` placeholder — when ctx.stale (fetch failed; serving cached
// data) AND the cached resetAt is already in the past. AND-only
// because:
//   - stale=true, future reset: cached countdown still useful.
//   - stale=false, past-due reset: a fresh fetch is due any
//     moment; the next tick will roll the countdown forward.
function isStaleAndPastDue(w: Window, stale: boolean, nowMs: number): boolean {
  if (!stale) return false;
  if (!w.resetAt) return false;
  const t = Date.parse(w.resetAt);
  if (!Number.isFinite(t)) return false;
  return t <= nowMs;
}

// Build the `(n/a<arrow> <label>)` body that replaces the regular
// past-due "(0m<arrow> <label>)" body when ctx.stale AND resetAt
// is in the past. The arrow still comes from pickResetArrow so the
// user sees the same fill-state glyph they would have seen for
// that elapsed ratio — index 0 when ratio ≤ 0 (matches the
// fresh-data past-due path). Caller is responsible for wrapping
// the body in STALE_COLOR.
function formatStalePastDueResetSuffix(
  windowLabel: string,
  w: Window,
  nowMs: number,
): string {
  const arrow = pickResetArrow(nowMs, w.resetStartAt, w.resetDurationMs);
  return `(n/a${arrow} ${windowLabel})`;
}
function formatOneResetSuffix(
  windowLabel: string,
  w: Window,
  nowMs: number = Date.now(),
): string {
  if (!windowLabel) return "";
  // Two pieces: the countdown (e.g. "2h3m") and the arrow (e.g. "🕛").
  // Both are derived from the same Window + nowMs; the arrow is the
  // single thing we always have even when the countdown is empty
  // (e.g. "<1m" or just the arrow alone if resetAt is present but
  // remaining is 0). Template:
  //   resetAt present → "(<countdown><arrow> <windowLabel>)"
  //   resetAt missing  → "<windowLabel>" (DeepSeek / legacy — no
  //   reset info at all, don't fake it with a default arrow)
  const resetSuffix = formatResetSuffix(w.resetAt, nowMs);
  const arrow = pickResetArrow(nowMs, w.resetStartAt, w.resetDurationMs);
  return w.resetAt
    ? `(${resetSuffix}${arrow} ${windowLabel})`
    : windowLabel;
}

// Compact "remaining time until reset" formatter. Returns the countdown
// portion of the reset annotation (no arrow, no parens) — e.g. "2h3m",
// "<1m" for sub-minute, or "0m" for past-due. The caller (`formatOne`)
// appends the window label and the fill-state arrow glyph picked by
// `pickResetArrow`.
//
// The actual formatting rules live in `formatRemainingMs` (shared with
// the stale-age suffix). See that function's doc comment for the full
// `minUnit` × `maxUnitCount` matrix.
export function formatResetSuffix(
  resetAt: string | null | undefined,
  nowMs: number = Date.now(),
): string {
  if (!resetAt) return "";
  const t = Date.parse(resetAt);
  if (!Number.isFinite(t)) return "";
  const remainingMs = t - nowMs;

  return formatRemainingMs(remainingMs);
}

// Pure helper: format a non-negative number of milliseconds as a
// `1d2h3m4s` style countdown, respecting `timeFormat.minUnit` (the
// smallest unit that may appear) and `timeFormat.maxUnitCount` (how
// many non-zero units to show). Top-level config so the formatting
// is consistent across reset countdowns and stale-age suffixes.
//
// Unified algorithm:
//   1. Extract [days, hours, minutes, seconds] from remainingMs.
//   2. Drop units below minUnit (so "m" drops s, "h" drops m+s).
//   3. Drop leading zero units from the trimmed list.
//   4. If the trimmed list is empty → "<1<minUnit>" (positive) or
//      "0<minUnit>" (past-due).
//   5. Slice the remaining list to maxUnitCount, join as `1d2h3m4s`.
//
// Examples (maxUnitCount=2):
//   remaining=2h3m45s minUnit="m" → "2h3m"   (s dropped by minUnit)
//   remaining=2h3m45s minUnit="s" → "2h3m"   (slice cuts s — s > maxUnitCount budget)
//   remaining=2h3m45s minUnit="s", maxUnitCount=3 → "2h3m45s"
//   remaining=2h3m0s  minUnit="s", maxUnitCount=3 → "2h3m0s" (internal zeros kept)
//   remaining=50s      minUnit="m" → "<1m"
//   remaining=50s      minUnit="s" → "50s"
//   remaining=50m      minUnit="h" → "<1h"
//   remaining=2h0m     minUnit="m" → "2h0m"   (internal zero kept)
//   remaining=1d2h3m4s minUnit="m", maxUnitCount=2 → "1d2h"
//   remaining=0        → "0m" / "0s" / "0h" depending on minUnit
export function formatRemainingMs(remainingMs: number): string {
  if (!Number.isFinite(remainingMs)) return "";

  const minUnit = cfg().timeFormat.minUnit;
  const maxUnitCount = Math.max(
    1,
    Math.min(4, Math.floor(cfg().timeFormat.maxUnitCount)),
  );

  const totalSeconds = Math.floor(remainingMs / 1000);
  const days = Math.floor(totalSeconds / 86400);
  const hours = Math.floor((totalSeconds % 86400) / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  // Past-due: explicit "0<minUnit>" so the user sees a clear "this
  // window has reset" signal — distinct from "<1<minUnit>" which means
  // "less than 1 unit left" (about to reset).
  if (remainingMs <= 0) return `0${minUnit}`;

  // Build the full unit list, then trim units below minUnit granularity.
  // Order matters: largest → smallest, so "leading zero drop" naturally
  // strips the high-order zeros before the units we care about.
  const allUnits: Array<[number, string]> = [
    [days, "d"],
    [hours, "h"],
    [minutes, "m"],
    [seconds, "s"],
  ];
  // Pre-compute unit→rank once so we can filter and compare without
  // re-allocating per item (TS also dislikes inline-object indexing).
  // Larger rank = smaller unit (s > m > h > d), so `rank[u] <= minUnitRank`
  // keeps units AT or ABOVE minUnit in size (i.e. drops units below it).
  const rank: Record<string, number> = { d: 0, h: 1, m: 2, s: 3 };
  const minUnitRank = rank[minUnit];
  const trimmed = allUnits.filter(([, u]) => rank[u] <= minUnitRank);

  // Drop leading zero units (so "0d0h5m" → "5m", not "0d0h5m").
  let leadingZeroCount = 0;
  while (
    leadingZeroCount < trimmed.length &&
    trimmed[leadingZeroCount][0] === 0
  ) {
    leadingZeroCount++;
  }
  const nonzero = trimmed.slice(leadingZeroCount);

  // All extracted units zero (or all below minUnit) → "<1<minUnit>"
  // floor. Wins over maxUnitCount — "<1<minUnit>" is the truth, not
  // a lossy empty string.
  if (nonzero.length === 0) return `<1${minUnit}`;

  // Take the first maxUnitCount (keeps internal/trailing zeros —
  // "2h0m" stays "2h0m").
  return nonzero.slice(0, maxUnitCount).map(([v, u]) => `${v}${u}`).join("");
}

// Pick a reset-countdown glyph from the configured array by how full the
// window still is. Index = floor(remainingMs / resetDurationMs * length),
// so the array reads left-to-right as "fresh → about to reset":
//   index 0        : right after the window reset (ratio = 0)
//   last index     : just before the next reset    (ratio ≈ 1)
// `min(…, length-1)` clamps ratio=1.0 to the last entry instead of
// running off the end. Falls back to index 0 when the interval data is
// missing (DeepSeek, legacy shape, clock skew) — same "neutral" reading
// for any unknown state, so users don't see a glyph swap just because
// we couldn't parse the new fields.
function pickResetArrow(
  nowMs: number,
  resetStartAt: string | null | undefined,
  resetDurationMs: number | null | undefined,
): string {
  const arrows = cfg().countdown.resetArrows;
  const first = arrows[0] ?? "";
  if (resetStartAt == null || resetDurationMs == null) return first;
  const startMs = Date.parse(resetStartAt);
  if (!Number.isFinite(startMs) || !Number.isFinite(resetDurationMs) || resetDurationMs <= 0) {
    return first;
  }
  const elapsed = nowMs - startMs;
  // Clamp ratio to [0, 1] — negative remaining means we're past the
  // window end (formatResetSuffix already filters those, but defense in
  // depth). Slightly-above-1 (clock skew) clamps to the last index.
  const ratio = Math.max(0, Math.min(1, (resetDurationMs - elapsed) / resetDurationMs));
  const idx = Math.min(arrows.length - 1, Math.floor(ratio * arrows.length));
  return arrows[idx];
}

// Compact "age of cached value" formatter for the trailing annotation.
// The `healthy` flag toggles the emoji: 🔗 for fresh (data is current,
// within-TTL cache hit) or ⛓️‍💥 for stale (fetch failed, showing
// cached data). SGR-wrapped in STALE_COLOR and RESET-terminated.
// Returns "" only when ageMs is non-finite (NaN / ±Infinity).
//
// The X time uses the SAME template as the reset countdown
// (formatRemainingMs) with the same `timeFormat.minUnit` and
// `timeFormat.maxUnitCount` knobs:
//   ageMs = 0          → "0<minUnit> ago"   (e.g. "0m ago", "0s ago")
//   sub-minute (0..59s) → "<1<minUnit> ago" or "${seconds}s ago"
//   minUnit="m" → "<1m ago"  (the "<" floor reads "less than 1 minute")
//   minUnit="s" → "${seconds}s ago" (no spurious round-up — second
//                                  granularity is fine-grained enough
//                                  that we don't need to lie about it)
//
// Visibility is gated by the caller: the m_age module emits whenever
// `ageMs != null` (the user explicitly opted in by listing it in the
// lineTemplate); renderProviderLine's forced-visibility block emits
// only when `stale === true` (the user did NOT list m_age but the
// renderer still wants a broken-chain indicator on real outages).
export function formatStaleSuffix(
  ageMs: number,
  healthy: boolean = false,
  override?: string,
): string {
  if (!Number.isFinite(ageMs)) return "";
  const emoji = healthy ? cfg().stale.ageEmoji.healthy : cfg().stale.ageEmoji.broken;
  const label = `${formatRemainingMs(ageMs)} ago`;
  // v0.3.3+: `override` replaces the default color when supplied
  // (used by the inline-args m_age|color|… path; override always
  // wins regardless of broken/fresh).
  // v0.6.0+: split the default into two — STALE_COLOR (gray) for the
  // informational 🔗 annotation on fresh ticks, BROKEN_COLOR (red)
  // for the ⛓️‍💥 annotation when the fetch failed and the cache is
  // serving stale data.
  const color = override ?? (healthy ? STALE_COLOR : BROKEN_COLOR);
  return `${color}${emoji} ${label}${RESET}`;
}

// Read the configured display mode. The earlier TOPGAUGE_CC_DISPLAY env
// var is gone (per the v0.2.0 config-file migration); anyone using it
// must move to config.json's `display` field.
export function resolveDisplayMode(): DisplayMode {
  return cfg().display;
}

export function formatLine(
  fiveHour: Window,
  weekly: Window,
  mode: DisplayMode = resolveDisplayMode(),
  nowMs: number = Date.now(),
  ageMs?: number,
  stale: boolean = false,
  tokens: TokenSnapshot | null = null,
): string {
  // v0.2.17: delegate to the lineTemplate renderer. The default plan
  // template reproduces the v0.2.16 byte-for-byte output.
  return renderProviderLine("minimax", {
    mode,
    nowMs,
    fiveHour,
    weekly,
    ageMs: ageMs ?? null,
    stale,
    version: cfg().version,
    tokens,
  });
}

// ----- DeepSeek balance line -------------------------------------------------
//
// Distinct from the MiniMax percentage thresholds (0/20/40/60/80): a balance
// is an ABSOLUTE amount, not a percentage, so the bands live at the
// configured thresholds (default 5/10/20/50 — red / orange / yellow / dark
// green / bright green). Lower balance = more urgent, so the lowest band
// (red) corresponds to the LOWEST value — same intuitive direction as the
// "remaining" mode of the MiniMax render.

function balanceThresholds(): readonly number[] {
  return cfg().thresholds.deepseekBalance;
}

// Lowest value → RED, then orange → yellow → dark green → bright green.
function balancePalette(): readonly string[] {
  const c = cfg().colors;
  return [c.red, c.orange, c.yellow, c.darkGreen, c.brightGreen];
}

function balanceBandIndex(value: number): number {
  const t = balanceThresholds();
  for (let i = 0; i < t.length; i++) {
    if (value < t[i]) return i;
  }
  return t.length; // top band
}

export function colorForBalance(value: number): string {
  const v = Math.max(0, value);
  return balancePalette()[balanceBandIndex(v)];
}

// Format a single numeric value for display: integers as "100", floats as
// "110.00". Trim trailing zeros for cases like "110.10" → "110.1".
function formatBalanceValue(v: number): string {
  if (Number.isInteger(v)) return String(v);
  // toFixed(2) then strip trailing zeros and a dangling dot.
  return v.toFixed(2).replace(/\.?0+$/, "");
}

// Per-currency display prefix. The DeepSeek API may return any string in
// `currency`; we recognize the configured ones and fall back to the raw
// currency code for anything else (e.g. EUR → "EUR10.50"). Unknown
// currencies are still rendered (the user can see the code) rather than
// blanked, so a new provider currency never silently disappears.
function prefixForCurrency(currency: string): string {
  const upper = currency.toUpperCase();
  const mapped = cfg().currency.prefixes[upper];
  if (mapped !== undefined) return mapped;
  // Default: show the currency code itself, uppercased. If even the code
  // is empty, fall back to the configured fallback prefix.
  return upper || cfg().currency.fallback;
}

function formatBalanceChunk(currency: string, v: number): string {
  return `${prefixForCurrency(currency)}${formatBalanceValue(v)}`;
}

export type BalanceLike = {
  isAvailable: boolean;
  entries: ReadonlyArray<{ currency: string; totalBalance: number }>;
  minValue: number | null;
};

// v0.2.17: refactor of formatBalanceLine so the m_balance module can
// produce a complete colored chunk (prefix + " · "-joined entries
// wrapped in a single SGR block). Returns "" when there's nothing to
// render so the m_balance module can return null and the template
// renderer skips the surrounding s_0 separators cleanly.
//
// v0.3.3+ `override` parameter: when supplied, replaces the band-based
// `colorForBalance` choice (used by the inline-args m_balance path).
function formatBalanceEntriesColored(b: BalanceLike, override?: string): string {
  if (!b.isAvailable || b.entries.length === 0 || b.minValue == null) {
    return "";
  }
  const chunks = b.entries.map((e) => formatBalanceChunk(e.currency, e.totalBalance));
  // Color follows the LOWEST entry — most urgent currency drives the hue.
  const color = override ?? colorForBalance(b.minValue);
  return `${color}${chunks.join(" · ")}${RESET}`;
}

export function formatBalanceLine(b: BalanceLike, ageMs?: number, stale: boolean = false, tokens: TokenSnapshot | null = null): string {
  if (!b.isAvailable || b.entries.length === 0 || b.minValue == null) {
    // "not available!" is rendered for BOTH the original "API said no" branch
    // (is_available: false) and the "fetch failed and we have no cache" branch
    // upstream. Neither carries an age to report, so the stale suffix is
    // intentionally NOT appended here. v0.2.17: this branch is NOT routed
    // through the lineTemplate (out of scope for v0.2.17) — it's a hardcoded
    // sentinel that always wins.
    return `Balance: ${RED}not available!${RESET}`;
  }
  // v0.2.17: delegate to the lineTemplate renderer. The default balance
  // template reproduces the v0.2.16 byte-for-byte output.
  return renderProviderLine("deepseek", {
    mode: resolveDisplayMode(),
    nowMs: Date.now(),
    balance: b,
    ageMs: ageMs ?? null,
    stale,
    version: cfg().version,
    tokens,
  });
}

// ----- lineTemplate / module renderer (v0.2.17) -------------------------
//
// A lineTemplate is an ordered list of tokens. Two token kinds:
//   m_<name>  — a display module (registered in MODULES below)
//   s_<n>     — a separator reference, looked up in cfg().separators[n]
//
// The renderer walks the template left-to-right, concatenating each
// module's output. Modules return null to signal "hidden in this
// context" — a null return SKIPS the surrounding separators too, so a
// hidden window doesn't leave orphan spaces or "·" in the output. This
// is what makes "drop the 7d window by removing m_window7d from the
// template" a clean operation rather than producing
// "Usage: <5h> ·  " with a trailing orphan separator.
//
// Unknown module names (typos) expand to "" and emit ONE stderr
// warning per render — capped at once-per-render to avoid log spam
// since the renderer runs on every statusline tick.
type RenderContext = {
  mode: DisplayMode;
  nowMs: number;
  fiveHour: Window | null;
  weekly: Window | null;
  balance: BalanceLike | null;
  ageMs: number | null;
  stale: boolean;
  version: string;
  // v0.4.0+ — live stdin snapshot for the m_token* modules. Always
  // present on the main flow (index.ts builds one before invoking
  // renderProviderLine); tests inject a fake via __resetForTest.
  tokens: TokenSnapshot | null;
  // v0.4.0+ — synthetic Window for the m_windowContext module.
  // Synthesized from tokens.contextWindow.usedPct; only `pct` is
  // read by formatOneChunk. Null when stdin lacks used_percentage.
  contextWindow: Window | null;
  // v0.4.x — the provider's TYPE discriminator. Populated by
  // renderProviderLine from providerTypeFor. `"plan"` for
  // TOKEN_PLAN providers, `"balance"` for BALANCE providers, and
  // `"unknown"` when ANTHROPIC_BASE_URL doesn't match any
  // supported provider.
  // configured provider (the entry-tolerant dispatch path).
  // Used by per-module `type` filters and by m_modeLabel's label
  // routing. Renamed from the v0.4.x-beta `providerModeKey` to
  // avoid collision with the display-mode field `mode` (`used` /
  // `remaining` / `balance`); the type discriminator is a TYPE, not
  // a mode.
  providerType: "plan" | "balance" | "unknown";
  // v0.6.0+ — mutable cross-recursion dedup ref for the m_age module.
  // Initialized to `{ value: false }` by renderProviderLine and
  // propagated by reference through any nested `m_template:`
  // expansions (m_template passes ctx as-is; only the inner template
  // array is sliced). The first m_age instance to emit sets .value
  // = true; subsequent m_age instances (and the forced-visibility
  // append in renderProviderLine) see .value=true and skip. Replaces
  // the older templateHasAgeModule string-match which only scanned
  // the top-level token list and missed m_age nested inside
  // lineTemplates.* fragments.
  ageEmittedRef?: { value: boolean };
  // v0.8.7+ — passthrough args from an outer `m_template|<key>|...`
  // expansion. Populated by the m_template renderer with its own
  // parsed `params` (minus the `key` and `mode` intrinsics) before
  // recursing into `renderTemplate(inner, ctx)`. Downstream
  // `INLINE_RENDERER`s read `ctx.passThrough?.[<name>]` as a
  // fallback when their local `params[<name>]` is undefined — so an
  // inner module's own explicit arg always wins. See
  // `passThroughOr()` below. The field is created fresh per
  // m_template invocation; nested m_template is impossible because
  // config.ts strips them at load time.
  passThrough?: Record<string, ResolvedValue>;
};

// v0.4.x — modules may declare a `type` filter so they only render
// for one provider kind. With the unification of renderPlanLine /
// formatBalanceLine into a single `renderDataLine`, the per-provider
// gate that used to live in dispatch.ts:buildProviderLine now lives
// here: a bare `m_window5h` in a balance provider's template
// silently drops (the module is type:`"plan"`), and `m_balance` in a
// plan provider's template silently drops too. Modules without a
// type tag (m_token*, m_age, m_version, …) are provider-agnostic
// and emit on every ctx.
//
// The renderer applies the filter by inspecting `mod.type` and
// comparing against `ctx.providerType`. A module function is still
// canonical; the `type` field is read-only metadata on the same
// record.
//
// Renamed from `mode` to `type` because `mode` is reserved for the
// display-mode field on RenderContext (`used` / `remaining` /
// `balance`). The provider discriminator is a TYPE, not a mode.
//
// v0.4.x — `type` widened to include `"unknown"` (a hypothetical
// `m_xxx:type:"unknown"` would only emit when ANTHROPIC_BASE_URL
// doesn't match any configured provider). No module currently
// uses this — plan-only and balance-only modules drop on unknown
// because their `type` value doesn't match. Reserved for future
// modules that want to render only in the unregistered case
// (e.g. an m_setupHint module that nudges the user toward running
// `/topgauge-cc:install`).
type Module = ((ctx: RenderContext) => string | null) & {
  type?: "plan" | "balance" | "unknown";
};

// v0.8.x — cwf-tickStatus-v2. Per-tick state lives in
// `state/<projectHash>/status.json` (managed by src/status-store.ts).
// Two slot families with clearly separated roles:
//
//   (A) tickStatus:<...>  — PURE ACCUMULATORS (the user-defined
//       rule: "tickStatus 只表示累计状态"). Four dimensions, all
//       written by setAvg's atomic path:
//
//         tickStatus:<sessionId>   per-session (clear-bounded)
//         tickStatus:<projectHash> per-project (cwd-bounded, NO prefix)
//         tickStatus:<model>       per-model (modelDisplayName)
//         tickStatus:ccsession     per-claude-code-process (singleton,
//                                  no sessionId suffix; reset on
//                                  totalApiMs regression — see setAvg)
//
//       value shape (TickStatusValue, acc-only — no per-tick fields):
//         accIn        — accumulated current.input
//         accOut       — accumulated current.output
//         accCached    — accumulated current.cacheRead
//         accTotalIn   — per-tick-delta-accumulator of totalIn
//         accApiMs     — session-cumulative cost.totalApiDurationMs
//                        (mirrors stdin's monotonic field)
//         accApiCount  — accumulated API-call count
//
//   (B) prevTickStatus  — SINGLETON, NOT per-dimension. Holds the
//       last tick's stdin snapshot. Used by the writer to (i)
//       compute the per-tick delta and (ii) detect a ccsession
//       reset (current totalApiMs < prevTickStatus.totalApiMs
//       means the Claude Code process restarted; the ccsession
//       accumulator must reset before this tick's delta is added).
//
//       value shape (PrevTickStatusValue):
//         in/out/cachedIn/totalIn/totalApiMs — previous tick's values
//         sessionId/cwd/model                 — identity for debug
//
// accApiCount contract (unchanged from v0.8.0):
//   On a tick where deltaApiMs > 0 AND input_tokens > 0 (a real
//   API call that produced input tokens), accApiCount += 1. The
//   gate is AND, not OR — a tick with deltaApiMs > 0 but
//   input_tokens == 0 does NOT count.
//
// Exported for tests (so unit tests can pre-seed the cache).
export type PrevTickSnapshot = {
  apiMs: number;
  in: number;
  out: number;
  cacheRead: number;
  totalIn: number;
};

// Public: looks up the previous tick's stdin snapshot. Reads the
// global `prevTickStatus` slot from status.json. Returns null on
// miss (no prior tick). The caller is responsible for the
// post-call `setPrevTick` to keep the cache fresh.
//
// v0.8.x cwf-tickStatus-v2 — prev-tick storage moved out of
// `tickStatus:<sid>` into a single `prevTickStatus` slot. Same
// delta arithmetic (current.totalApiMs - prev.totalApiMs) but
// the baseline is now dimension-agnostic.
export function peekPrevTick(
  sessionId: string,
  cwd?: string | null,
): PrevTickSnapshot | null {
  const v = statusStore.readPrevTickStatus(cwd);
  if (!v) return null;
  // v0.8.x cwf-tickStatus-v2 — the singleton prevTickStatus is
  // shared across ALL sessions in the same cwd. To preserve the
  // v0.4.x "first tick of a new session is a fresh delta" contract
  // (deltaApi = current - 0 = current > 0, hasDelta=true), we MUST
  // treat the singleton as null when its sessionId doesn't match
  // the current sessionId. Otherwise a second renderTemplate call
  // with a DIFFERENT sessionId (e.g. two distinct test snapshots
  // back-to-back) would see the prior session's baseline, get
  // deltaApi = 0, and incorrectly render as an idle/inactive tick.
  if (v.sessionId !== null && v.sessionId !== sessionId) return null;
  return {
    apiMs: v.totalApiMs,
    in: v.in,
    out: v.out,
    cacheRead: v.cachedIn,
    totalIn: v.totalIn,
  };
}

// Public: writes the current tick's snapshot into the global
// `prevTickStatus` slot. Replaces the value wholesale — the new
// shape is a flat PrevTickStatusValue (no longer embedded inside
// the per-session tickStatus entry). Test fixtures seed
// prev-tick baselines through this helper.
export function setPrevTick(
  _sessionId: string,
  snap: PrevTickSnapshot,
  cwd?: string | null,
  identity?: { sessionId?: string | null; cwd?: string | null; model?: string | null },
): void {
  void _sessionId;
  const prev = statusStore.readPrevTickStatus(cwd) ?? statusStore.emptyPrevTickStatus();
  statusStore.writePrevTickStatus(cwd, {
    in: snap.in,
    out: snap.out,
    cachedIn: snap.cacheRead,
    totalIn: snap.totalIn,
    totalApiMs: snap.apiMs,
    sessionId: identity?.sessionId ?? prev.sessionId,
    cwd: identity?.cwd ?? prev.cwd,
    model: identity?.model ?? prev.model,
  });
}

// ----- lastActive (v0.4.x) --------------------------------------------
//
// Stores the LAST active-tick tps per direction (in / out), so an
// idle tick (deltaApi == 0) that would otherwise render "-- t/s"
// can fall back to the cached value. Stored in status.json under
// the `lastActive:in` / `lastActive:out` keys (no sessionId in the
// key — project-wide singleton per direction). 60s TTL is enforced
// inside status-store.ts; writes happen ONLY on active ticks so the
// cached value is always "the last thing I measured".
//
// Reads ignore the per-session dimension: caller passes the
// session-agnostic tps and reads a project-wide value. Different
// from the old tickSpeedDisplay:<direction>:<sessionId> model
// which partitioned by session — the user explicitly asked for
// the session dimension to be dropped (the last-active signal is
// a "what was the overall rate we last saw" reading, useful
// across sessions). The sessionId argument is kept in the
// signature for back-compat with existing test fixtures.
export type LastSpeedSnapshot = {
  direction: "in" | "out";
  tps: number;
};
export function peekLastSpeed(
  _sessionId: string,
  direction: "in" | "out",
  cwd?: string | null,
): number | null {
  void _sessionId;
  return statusStore.readLastActive(cwd, direction);
}
export function setLastSpeed(
  _sessionId: string,
  direction: "in" | "out",
  tps: number,
  cwd?: string | null,
): void {
  void _sessionId;
  statusStore.writeLastActive(cwd, direction, tps);
}
// v0.8.x — parallel helpers for m_apiMs's TTL-bounded fallback
// cache. Mirrors peekLastSpeed/setLastSpeed but stores the raw
// deltaApiMs (NOT a tps) on the "apiMs" direction slot. The
// 60s TTL on status-store's readLastActive applies the same way
// as the tps slots — an idle tick within 60s of the last active
// tick renders the cached ms value (STALE_COLORed), exactly like
// m_tokenInSpeed/m_tokenOutSpeed's idle-tick fallback.
export function peekLastApiMs(
  _sessionId: string,
  cwd?: string | null,
): number | null {
  void _sessionId;
  return statusStore.readLastActive(cwd, "apiMs");
}
export function setLastApiMs(
  _sessionId: string,
  deltaApiMs: number,
  cwd?: string | null,
): void {
  void _sessionId;
  statusStore.writeLastActive(cwd, "apiMs", deltaApiMs);
}
// v0.8.x — parallel helpers for m_tokenHitRate's TTL-bounded
// fallback cache. Mirrors peekLastApiMs/setLastApiMs but stores
// the per-turn hit-rate percentage (e.g. 99.5 for "99.5%") on the
// "tokenHitRate" direction slot. The 60s TTL on status-store's
// readLastActive applies the same way: when this tick's stdin
// lacks cache_read_input_tokens, render the cached percentage
// STALE_COLORed within the TTL window; outside the window or with
// no prior measurement, drop to the "hit:n/a" placeholder.
export function peekLastTokenHitRate(
  _sessionId: string,
  cwd?: string | null,
): number | null {
  void _sessionId;
  return statusStore.readLastActive(cwd, "tokenHitRate");
}
export function setLastTokenHitRate(
  _sessionId: string,
  pct: number,
  cwd?: string | null,
): void {
  void _sessionId;
  statusStore.writeLastActive(cwd, "tokenHitRate", pct);
}
// Test-only: clear the last-active entry for a direction. v0.4.x:
// the entry lives in status.json under the project dir; tests
// that need a clean slot should use a tmp-dir path resolver.
// Kept as a no-op stub so existing test imports compile.
export function __resetLastSpeedForTest(
  _sessionId: string,
  _direction: "in" | "out",
  _cwd?: string | null,
): void {
  // No explicit clear API on status-store for lastActive (TTL is
  // 60s anyway); tests rely on the path resolver + tmp dir.
}

// Test-only: clear the in-memory + disk tickStatus:<sid> entry.
// Production code never calls this. No-op stub: same rationale as
// __resetLastSpeedForTest above.
export function __resetPrevTickForTest(
  _sessionId: string,
  _cwd?: string | null,
): void {
  // Tests that need a clean slot pre-seed with empty values via
  // setPrevTick(..., {apiMs:0, in:0, out:0, cacheRead:0}).
}

// Reads the per-session accumulator from status.json. The
// session-slot key is `tickStatus:<sessionId>` and the value
// shape is the v0.8.x cwf-tickStatus-v2 TickStatusValue
// (acc-only — per-tick / session-cumulative fields live in
// prevTickStatus). Returns null when no prior accumulator write
// exists for the session.
//
// `accApi` mirrors the v0.8.x TokenSample.totalApiMs convention —
// the session-cumulative cost.totalApiDurationMs at the last
// write. m_apiMs / m_apiMs-with-prev-fallback continues to read
// the prev baseline from prevTickStatus; accApi here is the
// "audit/inspect" value that grows monotonically.
export type AvgSnapshot = {
  accIn: number;
  accOut: number;
  accApi: number;
  accCached: number;
  accApiCount: number;
  accTotalIn: number;
};

export function peekAvg(
  sessionId: string,
  cwd?: string | null,
): AvgSnapshot | null {
  if (!sessionId) return null;
  const v = statusStore.readTickStatus(cwd, `tickStatus:${sessionId}`);
  if (!v) return null;
  return {
    accIn: v.accIn,
    accOut: v.accOut,
    accApi: v.accApiMs,
    accCached: v.accCached,
    accApiCount: v.accApiCount,
    accTotalIn: v.accTotalIn,
  };
}

// v0.8.x cwf-tickStatus-v2 — read the four-layer accumulator at a
// chosen scope. Used by the m_acc* module family. The four
// scopes:
//
//   session  → tickStatus:<sessionId>          (clear-bounded)
//   project  → tickStatus:<projectHash(cwd)>   (cwd-bounded; no prefix)
//   model    → tickStatus:<modelDisplayName>   (per-model)
//   ccsession→ tickStatus:ccsession            (claude-code-process;
//                                              reset on totalApiMs
//                                              regression — see setAvg)
//
// Returns null when the slot has never been written, so the
// module can render a placeholder rather than fabricating a "0".
function peekAcc(
  scope: "session" | "project" | "model" | "ccsession",
  ctx: RenderContext,
): AvgSnapshot | null {
  const t = ctx.tokens;
  const cwd = t?.cwd ?? undefined;
  if (scope === "session") {
    if (!t?.sessionId) return null;
    return peekAvg(t.sessionId, cwd);
  }
  let key: string;
  if (scope === "project") {
    if (!cwd) return null;
    key = `tickStatus:${projectHash(cwd)}`;
  } else if (scope === "ccsession") {
    key = statusStore.CCSESSION_KEY;
  } else {
    // scope === "model"
    const model = t?.modelDisplayName;
    if (!model) return null;
    key = `tickStatus:${model}`;
  }
  const v = statusStore.readTickStatus(cwd, key);
  if (!v) return null;
  return {
    accIn: v.accIn,
    accOut: v.accOut,
    accApi: v.accApiMs,
    accCached: v.accCached,
    accApiCount: v.accApiCount,
    accTotalIn: v.accTotalIn,
  };
}

// Canonical write path for the four-layer accumulator. Reads the
// current tickStatus:<sid> entry (or starts from zero), adds the
// per-tick deltas, and writes the unified shape back — including
// the new `accApiCount` field (see accApiCount contract above).
// Also bumps the project-wide `tickStatus:<projectHash>`, the
// per-process `tickStatus:ccsession`, and (when available)
// `tickStatus:<modelDisplayName>` entries with the SAME delta so
// every scoping level reflects this tick.
//
// v0.8.x cwf-tickStatus-v2:
//   - tickStatus:<sid>   : ABSOLUTE (snap.acc* used as-is)
//   - tickStatus:<hash>  : DELTA-ACCUMULATE across sessions/ticks
//   - tickStatus:ccsession: DELTA-ACCUMULATE, but with reset
//                          detection (see ccsessionReset below)
//   - tickStatus:<model> : DELTA-ACCUMULATE
//
// `snap` field meanings (v0.8.x — no `totalIn`, the
// session-cumulative totalIn lives in prevTickStatus now):
//   snap.accIn      = session-cumulative current.input
//   snap.accOut     = session-cumulative current.output
//   snap.accApi     = session-cumulative cost.totalApiDurationMs
//                     (mirrors the on-disk accApiMs field)
//   snap.accCached  = session-cumulative current.cacheRead
//   snap.accApiCount = session-cumulative count of API calls
//   snap.accTotalIn = per-tick-delta-accumulator of totalIn
//
// Caller passes the delta math (computeAndCacheTickDelta already
// produced it). Per-tick `in`/`out`/`cachedIn`/`totalIn`/
// `totalApiMs` fields are NOT stored on tickStatus — they live
// in the singleton `prevTickStatus` slot, which the caller
// updates via setPrevTick BEFORE/AFTER calling setAvg.
//
// IMPORTANT: the per-session slot stores ABSOLUTE cumulative
// values for that session (`accIn = session_prev_accIn + delta`).
// The project-wide / ccsession / per-provider slots store
// DELTAS ACCUMULATED across ticks (`accIn += deltaIn`), so
// multiple sessions tick into the same aggregate without
// overwriting each other.
export function setAvg(
  sessionId: string,
  snap: AvgSnapshot,
  cwd?: string | null,
  extras?: {
    modelDisplayName?: string | null;
    deltaApiCount?: number;
    currentApiMs?: number;
    // Per-tick deltas to ADD into the project-wide / ccsession /
    // per-provider aggregate accumulators. When omitted (legacy
    // callers), the aggregate slots are not bumped — backward
    // compatible with the v0.3.x setAvg signature.
    deltaIn?: number;
    deltaOut?: number;
    deltaCache?: number;
    deltaApiMs?: number;
    deltaTotalIn?: number;
  },
): void {
  if (!sessionId) return;
  // Increment accApiCount only on a valid API call that produced
  // input tokens (per the user's revised contract: AND gate).
  // extras.deltaApiCount is pre-computed by the caller (1 or 0)
  // to keep the gate logic colocated with the delta math.
  const incrementCount = extras?.deltaApiCount ?? 0;

  // Per-session slot — DELTA-ACCUMULATE for in/out/cached/
  // totalIn/apiCount, but ABSOLUTE for accApiMs. The on-disk
  // TickStatusValue is acc-only (v0.8.x cwf-tickStatus-v2):
  // per-tick / session-cumulative input/output/cacheRead/totalIn/
  // totalApiMs live in prevTickStatus. setAvg receives a
  // per-tick `snap` and adds the deltas into the existing slot
  // (or seeds it from zero on the first tick). accApiMs is the
  // session-cumulative cost.totalApiDurationMs at the last
  // write — it MIRRORS stdin's monotonic field rather than
  // accumulating deltas, so we always write the absolute
  // current value (and on a regression the ccsession reset
  // logic zeroes the ccsession slot so the new process can
  // re-seed from zero; the session-slot, which is per-current-
  // session, never sees a regression within its own scope).
  const existing = statusStore.readTickStatus(cwd, `tickStatus:${sessionId}`);
  const next: statusStore.TickStatusValue = existing ?? statusStore.emptyTickStatus();
  next.accIn += snap.accIn;
  next.accOut += snap.accOut;
  next.accApiMs = snap.accApi;
  next.accCached += snap.accCached;
  next.accApiCount += snap.accApiCount;
  next.accTotalIn += snap.accTotalIn;
  statusStore.writeTickStatus(cwd, `tickStatus:${sessionId}`, next);

  // Per-project aggregate — ACCUMULATE per-tick deltas so two
  // concurrent sessions both contribute without overwriting each
  // other. Key is `tickStatus:<projectHash(cwd)>` (no prefix).
  if (
    incrementCount > 0 ||
    extras?.deltaIn ||
    extras?.deltaOut ||
    extras?.deltaCache ||
    extras?.deltaApiMs ||
    extras?.deltaTotalIn
  ) {
    if (cwd) {
      const projectKey = `tickStatus:${projectHash(cwd)}`;
      const agg = statusStore.readTickStatus(cwd, projectKey) ??
        statusStore.emptyTickStatus();
      if (extras?.deltaIn) agg.accIn += extras.deltaIn;
      if (extras?.deltaOut) agg.accOut += extras.deltaOut;
      if (extras?.deltaCache) agg.accCached += extras.deltaCache;
      if (extras?.currentApiMs != null) agg.accApiMs = extras.currentApiMs;
      if (extras?.deltaTotalIn) agg.accTotalIn += extras.deltaTotalIn;
      if (incrementCount > 0) agg.accApiCount += incrementCount;
      statusStore.writeTickStatus(cwd, projectKey, agg);
    }

    // Per-claude-code-process (ccsession) aggregate. Same
    // ACCUMULATE semantics as project. The ccsession reset on a
    // cost.totalApiDurationMs regression is handled in
    // accPrimer (see comment above the r.hasDelta early return)
    // so the reset can fire even when this tick has no positive
    // delta to accumulate. The slot is read+written below only
    // when this tick has a positive contribution to land.
  }
  {
    // ccsession accumulation (gated on hasDelta-like conditions;
    // the slot is already reset to zero by accPrimer on a
    // regression, so a positive-delta tick that follows lands
    // its contribution on the clean baseline).
    const ccs =
      statusStore.readTickStatus(cwd, statusStore.CCSESSION_KEY) ??
      statusStore.emptyTickStatus();
    if (extras?.deltaIn) ccs.accIn += extras.deltaIn;
    if (extras?.deltaOut) ccs.accOut += extras.deltaOut;
    if (extras?.deltaCache) ccs.accCached += extras.deltaCache;
    if (extras?.currentApiMs != null) ccs.accApiMs = extras.currentApiMs;
    if (extras?.deltaTotalIn) ccs.accTotalIn += extras.deltaTotalIn;
    if (incrementCount > 0) ccs.accApiCount += incrementCount;
    // Only persist when at least one field changed; otherwise
    // the read+write is a no-op disk touch on every tick.
    if (
      extras?.deltaIn ||
      extras?.deltaOut ||
      extras?.deltaCache ||
      extras?.currentApiMs != null ||
      extras?.deltaTotalIn ||
      incrementCount > 0
    ) {
      statusStore.writeTickStatus(cwd, statusStore.CCSESSION_KEY, ccs);
    }
  }

  // Per-provider slot (model display name). Optional — only
  // exists when the caller supplied a modelDisplayName. Same
  // ACCUMULATE semantics as the project-wide aggregate: each
  // session tick that lands on this model adds to the running
  // total without overwriting siblings.
  const model = extras?.modelDisplayName;
  if (model && model.length > 0) {
    const prov = statusStore.readTickStatus(cwd, `tickStatus:${model}`) ??
      statusStore.emptyTickStatus();
    if (extras?.deltaIn) prov.accIn += extras.deltaIn;
    if (extras?.deltaOut) prov.accOut += extras.deltaOut;
    if (extras?.deltaCache) prov.accCached += extras.deltaCache;
    if (extras?.currentApiMs != null) prov.accApiMs = extras.currentApiMs;
    if (extras?.deltaTotalIn) prov.accTotalIn += extras.deltaTotalIn;
    if (incrementCount > 0) prov.accApiCount += incrementCount;
    statusStore.writeTickStatus(cwd, `tickStatus:${model}`, prov);
  }
}

export function __resetAvgForTest(
  _sessionId: string,
  _cwd?: string | null,
): void {
  // No-op: see __resetPrevTickForTest above.
}

// Per-render memo: keyed by the RenderContext object itself, so
// the memo lives exactly as long as the render. A WeakMap means
// no manual cleanup and no leak when a render finishes. Several
// per-API-call modules (m_tokenIn / m_tokenOut / m_tokenInSpeed
// / m_tokenOutSpeed / m_tokenInAvg / m_tokenOutAvg) may all be in
// a single lineTemplate, and WITHOUT this memo, the second
// module's computeAndCacheTickDelta would read the cache that
// the first module just wrote — and see delta = 0 (which renders
// "--"). The memo freezes the result for the lifetime of the
// render so each module sees the SAME delta and only the FIRST
// caller fires the cache write.
type TickDeltaResult = {
  hasDelta: boolean;
  deltaIn: number;
  deltaOut: number;
  deltaApi: number;
  // v0.4.0+: delta of current_usage.cache_read_input_tokens
  // across the last tick. Feeds the per-tick-delta-accumulator
  // field accCached (via the m_acc* family). Defaults to 0 when
  // either side of the subtraction is null (stdin lacked the
  // field — see computeAndCacheTickDelta).
  deltaCacheRead: number;
  // v0.8.0+: delta of context_window.total_input_tokens across the
  // last tick. Mirrors the v0.4.x deltaCacheRead shape — both feed
  // per-tick-delta-accumulator fields (accTotalIn, accCached).
  // Source: t.totals.input; on first tick assumes prev=0.
  deltaTotalIn: number;
  // v0.8.0+: latest session-cumulative context_window.total_input_tokens
  // (snapshot, not delta). Source: t.totals.input. Stored on
  // tickStatus.value.totalIn.
  currentTotalIn: number | null;
  writeBack: PrevTickSnapshot | null;
};
const _tickDeltaMemo = new WeakMap<RenderContext, TickDeltaResult>();
// Memo for the setAvg accumulator write. computeTickAvg fires
// setAvg so the per-API-call family works as the sole per-API-
// call module in a template. Idempotent: first caller wins;
// subsequent callers no-op.
const _tickAvgWriteMemo = new WeakMap<RenderContext, true>();
// v0.8.x cwf-tickStatus-v2 — separate memo for the accCached-only
// write fired by accCachePrimer. Keeps the "field not shipped"
// contract on accCached independent of the main primer.
const _tickCacheWriteMemo = new WeakMap<RenderContext, true>();

// One source of truth for the per-API-call delta math. Lives at
// the top of the per-tick pipeline so every v0.4.0+ per-API-call
// module (m_tokenIn / m_tokenOut / m_tokenInSpeed / m_tokenOutSpeed
// / m_tokenInAvg / m_tokenOutAvg) sees the same numbers and the
// same cache state.
//
// Per-render memoization: the first call within a render peeks
// the prev tick, computes the deltas, and returns writeBack. The
// caller fires setPrevTick. Subsequent calls within the same
// render return the SAME result WITHOUT re-peeking and WITHOUT
// triggering another setPrevTick on the caller side (writeBack is
// present on the memo so a late caller may also fire setPrevTick
// safely — the write is idempotent).
//
// Behavior:
//   1. If snapshot data is missing (no sessionId / no
//      totalApiDurationMs / no current.input/output), return
//      hasDelta=false and writeBack=null. The caller renders
//      "--" and skips the cache write. No state changes.
//   2. Otherwise, peek the prevTick. ALWAYS write the current
//      snapshot back so the next tick has a baseline — even when
//      we couldn't compute a delta (first tick, session changed,
//      idle tick, regression). The write is fire-and-forget; the
//      cache failure mode is "next tick drops", same as today.
//   3. If prev exists and (deltaApi > 0 AND deltaIn >= 0 AND
//      deltaOut >= 0), compute the three deltas and return
//      hasDelta=true. The caller (per-module) decides how to
//      render the numbers — speed, raw delta-in/out, or as
//      accumulators.
//
// Why ALL-FOUR fields together (not just the one direction):
//   - m_tokenInAvg needs (deltaIn, deltaApi); m_tokenOutAvg
//     needs (deltaOut, deltaApi). Computing both directions in
//     one pass avoids two cache peeks + writes per tick.
//   - Every per-API-call module is gated by the SAME data
//     validity conditions. Centralizing the gate logic makes it
//     impossible for one module to render numbers while another
//     drops without an explicit check.
function computeAndCacheTickDelta(ctx: RenderContext): TickDeltaResult {
  const memo = _tickDeltaMemo.get(ctx);
  if (memo) return memo;
  const t = ctx.tokens;
  let result: TickDeltaResult;
  if (!t || !t.sessionId) {
    result = {
      hasDelta: false, deltaIn: 0, deltaOut: 0, deltaApi: 0,
      deltaCacheRead: 0, deltaTotalIn: 0, currentTotalIn: null,
      writeBack: null,
    };
    _tickDeltaMemo.set(ctx, result);
    return result;
  }
  const currentApi = t.cost.totalApiDurationMs;
  const currentIn = t.current.input;
  const currentOut = t.current.output;
  const currentCacheRead = t.current.cacheRead;
  // v0.8.0+ — `totals.input` IS the v0.8.0 `totalIn` (source:
  // context_window.total_input_tokens). May be null on stdin that
  // lacks the field; in that case deltaTotalIn=0 and currentTotalIn=null.
  const currentTotalIn = t.totals?.input ?? null;
  if (currentApi == null || currentIn == null || currentOut == null) {
    result = {
      hasDelta: false, deltaIn: 0, deltaOut: 0, deltaApi: 0,
      deltaCacheRead: 0, deltaTotalIn: 0, currentTotalIn,
      writeBack: null,
    };
    _tickDeltaMemo.set(ctx, result);
    return result;
  }
  const prev = peekPrevTick(t.sessionId, t.cwd);
  // Always write the current snapshot so the next tick has a
  // baseline for the `deltaApi` math, even when we render "--" /
  // skip the cache accumulator update. The `in` / `out` /
  // `cacheRead` fields of writeBack are unused by the new
  // accumulation model (we read current.* directly — they're
  // per-turn deltas, not running totals) but the field is kept
  // for schema stability and a 0-stamped baseline is harmless.
  const writeBack: PrevTickSnapshot = {
    apiMs: currentApi,
    in: currentIn,
    out: currentOut,
    cacheRead: currentCacheRead ?? 0,
    totalIn: currentTotalIn ?? 0,
  };
  // v0.4.0+ (revised 2026-06-29): when no previous tick exists
  // (first tick of a session, or a cache miss after a session
  // change), we DO NOT bail to "no data". We assume the prior
  // baseline was at zero — i.e. `prev.apiMs = 0` — so the first
  // tick still contributes. This matches the per-turn-delta
  // contract: current_usage.* values are THIS turn's
  // contribution, and on the very first turn there is no
  // "previous" to compare against, so the safe assumption is
  // "we started from a clean slate". The first tick therefore
  // accumulates into the m_acc* family (no "0" sentinel) and
  // m_tokenIn / m_tokenOut / m_tokenInSpeed render real values
  // when total_api_duration_ms > 0.
  const prevApiMs = prev?.apiMs ?? 0;
  // current_usage.{input_tokens, output_tokens,
  // cache_read_input_tokens} are PER-TURN DELTAS — they report
  // THIS turn's contribution, not a running total. We do NOT
  // subtract prev; the value is already the per-turn delta. The
  // only subtraction is deltaApi, where prev.apiMs tells us
  // "did total_api_duration_ms change this tick?".
  //
  // Gating is deltaApi > 0 ONLY. In / out / cache_read don't all
  // have to move together — e.g. a thinking-only turn adds zero
  // output tokens but may still count as a real API call. We
  // accumulate whatever current.* reports, and a zero per-turn
  // delta on one field is meaningful (it just means "no tokens
  // of that kind this turn"), not a regression. Per-turn deltas
  // are contractually non-negative (an API call can't subtract
  // input tokens), so the previous regression guard is gone.
  const deltaApi = currentApi - prevApiMs;
  const deltaIn = currentIn;
  const deltaOut = currentOut;
  const deltaCacheRead = currentCacheRead ?? 0;
  // v0.8.0+ — deltaTotalIn is a TRUE subtraction (totals.input is
  // session-cumulative, NOT a per-turn delta). Same first-tick
  // convention: prev=0, so the first tick contributes the full
  // currentTotalIn. May be negative only if totals.input regressed
  // (cache eviction / model reset) — in that case clamp to 0 to
  // match the per-turn-delta contract (deltas are non-negative).
  const deltaTotalIn = currentTotalIn != null
    ? Math.max(0, currentTotalIn - (prev?.totalIn ?? 0))
    : 0;
  const hasDelta = deltaApi > 0;
  result = {
    hasDelta, deltaIn, deltaOut, deltaApi, deltaCacheRead,
    deltaTotalIn, currentTotalIn, writeBack,
  };
  _tickDeltaMemo.set(ctx, result);
  return result;
}

// Test-only: clear the per-render memo for a given ctx. The memo
// is normally GC'd with the ctx via the WeakMap key. Production
// code never calls this — tests use it when they reuse a ctx
// across two renderTemplate calls in one test (rare, since the
// main test pattern seeds cache and builds a fresh ctx each time).
export function __resetTickDeltaMemoForTest(ctx: RenderContext): void {
  _tickDeltaMemo.delete(ctx);
  _tickAvgWriteMemo.delete(ctx);
  _tickCacheWriteMemo.delete(ctx);
}

// Compute the per-API-call throughput for one of {in, out}. v0.4.0+
// — always returns a non-null value. The module occupies a stable
// slot in the user's lineTemplate; a missing-data render is
// "in:-- t/s", not a drop. This keeps the line layout stable across
// ticks — the user always sees the module where they put it, and
// learns to read "--" as "no data / nothing to report".
//
// math (when hasDelta):
//   tps = current_in_or_out / delta_api * 1000
//
// Missing-data conditions (render "in:-- t/s"):
//   - no current snapshot data
//   - delta_api <= 0 (no API call between ticks) AND no cached
//     value from a previous active tick to fall back to
//
// v0.4.0+ (revised 2026-06-29 + 2026-06-29): per-turn deltas
// don't need a direction-specific zero-rejection gate. IN and
// OUT don't have to move together — a thinking-only turn adds
// 0 input tokens but 0 output tokens too; a synthesized-message
// turn adds 0 input but real output. The truthful rate is
// 0.0 t/s, not "-- t/s". We render 0.0 directly so the user
// sees the real measurement and learns the difference between
// "0 t/s" (real zero) and "in:-- t/s" (no data).
//
// v0.4.0+ second revision: cache the last ACTIVE-tick tps per
// session. On an idle tick (no API call this turn), fall back
// to the cached tps so the speed module doesn't blink
// in:-- t/s between real measurements during fast statusline
// ticks. The cache is only written on active ticks (idle ticks
// preserve the previous measurement). Returns an `active` flag
// so the caller can pick color: active = scale band, inactive
// = STALE_COLOR (the user reads the gray as "this is a stale
// measurement from a previous API call, not a real one now").
function computeTickSpeed(
  ctx: RenderContext,
  direction: "in" | "out",
  color: string,
): {
  value: string;
  writeBack: PrevTickSnapshot | null;
  active: boolean;
  tps: number | null;
} {
  // v6.x: snapshot missing → "n/a" placeholder (not "in:-- t/s").
  // Mirrors computeTickDelta's null/zero split: no stdin at all is
  // a different state from "stdin present but idle this tick".
  const t = ctx.tokens;
  if (!t || !t.sessionId) {
    return {
      value: `${direction}:n/a`,
      writeBack: null,
      active: false,
      tps: null,
    };
  }
  const r = computeAndCacheTickDelta(ctx);
  if (!r.hasDelta) {
    // Idle tick — fall back to the last active measurement if
    // we have one, otherwise render the truthful "0.0 t/s".
    // v6.x: previously rendered "-- t/s" here, conflating
    // "no measurement" with "0.0 t/s". Per user direction,
    // zero rates are rendered, not hidden.
    const cached = peekLastSpeed(t.sessionId, direction, t.cwd);
    if (cached != null) {
      return {
        value: `${STALE_COLOR}${direction}:${formatSpeed(cached)}${RESET}`,
        writeBack: r.writeBack,
        active: false,
        tps: cached,
      };
    }
    // No cached tps and no active tick → truthful 0.0 t/s
    // (a rate of exactly zero is still data — the API did not
    // produce any tokens this turn).
    return {
      value: `${color}${direction}:${formatSpeed(0)}${RESET}`,
      writeBack: r.writeBack,
      active: false,
      tps: 0,
    };
  }
  const deltaTok = direction === "in" ? r.deltaIn : r.deltaOut;
  const tps = (deltaTok / r.deltaApi) * 1000;
  // Write the active measurement to the cache so subsequent
  // idle ticks can display it.
  setLastSpeed(t.sessionId, direction, tps, t.cwd);
  return {
    value: `${color}${direction}:${formatSpeed(tps)}${RESET}`,
    writeBack: r.writeBack,
    active: true,
    tps,
  };
}

// Per-API-call raw token delta. v6.x — distinguishes three states:
//
//   - snapshot data missing (tokens / sessionId / current.input
//     absent)         → `${direction}:n/a`  (no stdin at all)
//   - idle tick       → `${direction}:0`    (stdin present, no
//                                             delta this tick —
//                                             truthful "0 this turn")
//   - active tick     → `${direction}:${formatCompactToken(n)}`
//
// v0.4.0+ previously collapsed the first two into "in:0", which
// conflated "no data" with "real zero". The new rule (per user
// direction): 0 renders as "0" (never hidden); null renders as
// "n/a". Idle ticks (hasDelta=false) still return "in:0" because
// the snapshot was read but the per-turn delta genuinely is 0 —
// that IS a zero value, not missing data.
//
// Uses formatCompactToken so single-call token counts read the
// same as the cumulative modules (e.g. "in:140", "in:12.3k").
function computeTickDelta(
  ctx: RenderContext,
  direction: "in" | "out",
): { value: string; writeBack: PrevTickSnapshot | null } {
  const t = ctx.tokens;
  // v0.8.0+ — prefix is the configured label (default "In:" / "Out:").
  // The `direction` still drives the actual delta math; only the
  // emitted prefix string reads from config now.
  const prefix = labelFor(direction);
  // v6.x: snapshot missing → "n/a" placeholder (not "0"). Without
  // this gate the function returns "in:0" for both missing-snapshot
  // and idle cases, conflating them.
  if (!t || !t.sessionId) {
    return { value: `${prefix}n/a`, writeBack: null };
  }
  const r = computeAndCacheTickDelta(ctx);
  if (!r.hasDelta) {
    // snapshot read but no API call this tick — truthful 0.
    return { value: `${prefix}0`, writeBack: r.writeBack };
  }
  const n = direction === "in" ? r.deltaIn : r.deltaOut;
  return {
    value: `${prefix}${formatCompactToken(n)}`,
    writeBack: r.writeBack,
  };
}

// Per-session running average speed across all valid API
// calls. Combines the prevTick (per-API-call math) with the
// AvgSnapshot (running totals). The math across the session:
//   sum_in  / sum_api  * 1000  (and same for out)
// Only valid-API-call ticks contribute (deltaApi > 0 AND
// deltaIn / deltaOut >= 0); idle and regression ticks don't.
// Renders "--" when no valid tick has accumulated yet (sumApi
// is still 0 after this tick — i.e. nothing usable came in).
// Color defaults to STALE_COLOR; the inline :color| path
// overrides it.
//
// Side effects: fires BOTH the prevTick write (so the next
// tick's computeAndCacheTickDelta sees a fresh baseline) AND
// the avg accumulate write. This means computeTickAvg is
// self-sufficient — putting m_tokenInAvg alone in a template
// with no speed / raw-delta modules still works.

// v0.8.x cwf-tickStatus-v2 — the m_totalToken* / m_totalTokenWithCacheIn
// module family (and its computeTickTotals helper) was REMOVED
// in this version. The accumulator access for "session-cumulative
// in/out/cache" now goes through the m_acc* family with
// scope=ccsession (the default). For example:
//   m_totalTokenIn          → m_accTokenIn
//   m_totalTokenOut         → m_accTokenOut
//   m_totalTokenWithCacheIn → m_accTokenCachedIn
// No alias is provided — the old names drop with the
// v0.8.x cwf-tickStatus-v2 rename (consistent with the v0.8.0
// removal of m_token5h / m_token7d / m_tokenInAvg / m_tokenOutAvg).

// v0.8.0+ — body factory for the m_acc* family. Renders the
// chosen accumulator field at a chosen scope. Output shape:
//
//   scope=ccsession (default) → "acc(ccs):N"
//   scope=session             → "acc:N"
//   scope=project             → "acc(total):N"
//   scope=model               → "acc(<modelDisplayName>):N"
//
// Reads the four-layer accumulator via peekAcc. Placeholder when
// the chosen slot has never been written (no prior tick, no model
// for the model scope, no sessionId for the session scope). Zero
// accumulator renders as "acc:0" (value-zero rule, never dropped).

// v0.8.x cwf-tickStatus-v2 — the m_acc* family's "self-priming"
// contract. When the m_acc* family is the ONLY per-API-call module
// in the template (no m_token* / m_tokenInSpeed / m_tokenOutSpeed
// sibling), the per-tick pipeline never fires setAvg on its own —
// computeTickAvg gates on a m_token*InAvg call. Without primer
// support, peekAcc returns null on the very first tick and the
// m_acc* module stays at the "n/a" placeholder forever. Both
// accBody and accHitRateBody invoke this helper at the top, so
// placing m_accTokenIn alone in a template (or m_accTokenHitRate
// alone) now works the same way m_totalTokenIn / m_totalTokenOut
// used to.
//
// Primer gate: fires ONLY when the session-slot has never been
// written (peekAvg returns null) AND this is a valid tick
// (hasDelta=true). On every subsequent render, the primer
// short-circuits — the slot is already populated, and another
// setAvg call would double-count the delta (setAvg writes
// ABSOLUTE values for the session slot, so a second pass with
// `prev+delta` would re-add the same delta).
//
// The cache-field gate (`current.cacheRead === null` → skip
// accCached) is the same contract the v0.4.x–v0.8.0
// m_totalTokenWithCacheIn `cache:--` rendering honored — "field
// not shipped" stays distinct from "accumulator is zero".
function accPrimer(ctx: RenderContext): void {
  if (_tickAvgWriteMemo.get(ctx)) return;
  const t = ctx.tokens;
  if (!t || !t.sessionId) return;
  // v0.8.x — fire on every valid tick. setAvg now ACCUMULATES
  // (session slot uses +=, not =) so the per-tick deltas land
  // additively on top of any prior tick. _tickAvgWriteMemo
  // dedupes within a single render (multiple m_acc* calls on the
  // same ctx fire the primer exactly once).
  // v0.8.x cwf-tickStatus-v2 — ccsession reset is OUTSIDE the
  // hasDelta gate. A regression in cost.totalApiDurationMs
  // (current < prev) means the Claude Code process restarted;
  // the ccsession slot must be zeroed even when this tick
  // itself has no positive delta to accumulate. The check MUST
  // run BEFORE computeAndCacheTickDelta's writeBack (which
  // overwrites prevTickStatus with the current snapshot).
  if (t.cwd && t.cost.totalApiDurationMs != null) {
    const prevPrev = statusStore.readPrevTickStatus(t.cwd);
    if (
      prevPrev != null &&
      t.cost.totalApiDurationMs < prevPrev.totalApiMs
    ) {
      statusStore.writeTickStatus(t.cwd, statusStore.CCSESSION_KEY, statusStore.emptyTickStatus());
    }
  }
  const r = computeAndCacheTickDelta(ctx);
  if (r.writeBack) {
    setPrevTick(t.sessionId, r.writeBack, t.cwd, {
      sessionId: t.sessionId,
      cwd: t.cwd,
      model: t.modelDisplayName ?? null,
    });
  }
  if (!r.hasDelta) return;
  _tickAvgWriteMemo.set(ctx, true);
  // v0.8.x cwf-tickStatus-v2 — accApi is the ABSOLUTE
  // session-cumulative cost.totalApiDurationMs (mirrors the
  // stdin field), not a delta. Pass the current absolute value
  // so setAvg's `next.accApiMs = snap.accApi` writes the
  // correct absolute.
  const currentApi = t.cost.totalApiDurationMs ?? 0;
  const next: AvgSnapshot = {
    accIn: r.deltaIn,
    accOut: r.deltaOut,
    accApi: currentApi,
    // accCached intentionally NOT touched here — see header
    // "Primer gate" above. The m_accTokenCachedIn /
    // m_accTokenHitRate bodies call accCachePrimer() to bump
    // accCached on a separate code path.
    accCached: 0,
    accApiCount: r.deltaApi > 0 && t.current.input != null && t.current.input > 0 ? 1 : 0,
    accTotalIn: r.deltaTotalIn,
  };
  setAvg(t.sessionId, next, t.cwd, {
    modelDisplayName: t.modelDisplayName ?? null,
    deltaApiCount: r.deltaApi > 0 && t.current.input != null && t.current.input > 0 ? 1 : 0,
    currentApiMs: t.cost.totalApiDurationMs ?? undefined,
    deltaIn: r.deltaIn,
    deltaOut: r.deltaOut,
    // deltaCache deliberately omitted: do NOT accumulate the
    // missing-field 0 into accCached.
    deltaApiMs: r.deltaApi,
    deltaTotalIn: r.deltaTotalIn,
  });
}

// Fire the cache-specific delta (accCached) on a separate code
// path. The m_token* family does NOT bump accCached on its own
// (it gates on a separate code path), so the m_accTokenCachedIn /
// m_accTokenHitRate bodies call this helper to add the per-tick
// delta. setAvg ACCUMULATES, so re-firing on a populated slot
// is safe and correct — the cache delta is added to whatever
// the slot already holds. _tickCacheWriteMemo dedupes within
// a single render (multiple m_acc* calls on the same ctx fire
// the primer exactly once).
//
// "Field not shipped" — when stdin lacks cache_read_input_tokens
// entirely (current.cacheRead === null), the helper short-circuits
// and accCached stays untouched. The m_acc* bodies surface this
// state via the "cache:--" / "hit:n/a" placeholder.
function accCachePrimer(ctx: RenderContext): void {
  if (_tickCacheWriteMemo.get(ctx)) return;
  const t = ctx.tokens;
  if (!t || !t.sessionId) return;
  if (t.current.cacheRead == null) return; // "field not shipped"
  const r = computeAndCacheTickDelta(ctx);
  if (!r.hasDelta) return;
  _tickCacheWriteMemo.set(ctx, true);
  // v0.8.x cwf-tickStatus-v2 — setAvg ACCUMULATES for the
  // per-tick deltas but ABSOLUTE for accApi. accPrimer already
  // wrote the per-tick deltas (including the absolute
  // totalApiDurationMs) for this render, so we must:
  //   - pass zero for accIn/accOut/accCached/accApiCount/accTotalIn
  //     (accPrimer already accumulated these; we'd double-count
  //     otherwise)
  //   - pass the current absolute totalApiDurationMs for accApi
  //     (setAvg's `next.accApiMs = snap.accApi` mirrors the
  //     stdin monotonic field; passing 0 here would zero it out)
  const currentApi = t.cost.totalApiDurationMs ?? 0;
  const next: AvgSnapshot = {
    accIn: 0,
    accOut: 0,
    accApi: currentApi,
    accCached: r.deltaCacheRead,
    accApiCount: 0,
    accTotalIn: 0,
  };
  setAvg(t.sessionId, next, t.cwd, {
    modelDisplayName: t.modelDisplayName ?? null,
    currentApiMs: t.cost.totalApiDurationMs ?? undefined,
    deltaCache: r.deltaCacheRead,
  });
}

function accBody(
  ctx: RenderContext,
  field: "in" | "out" | "cached" | "total" | "apiMs" | "apiCalls",
  scope?: "session" | "project" | "model" | "ccsession",
): string {
  // v0.8.x cwf-tickStatus-v2 — self-priming. When the m_acc* family
  // is the only per-API-call module in the template (no m_token* /
  // m_tokenInSpeed / m_tokenOutSpeed), the only way for the
  // session-scope accumulator to update THIS tick is for the m_acc*
  // call to fire setAvg itself — otherwise peekAcc returns null on
  // every fresh tick and the module stays at "n/a" forever. We
  // delegate the per-tick delta math to computeAndCacheTickDelta
  // (same memo as m_token*InSpeed etc., so the write is idempotent
  // across multiple m_acc* calls in the same render).
  accPrimer(ctx);
  const useScope = scope ?? "ccsession";
  const v = peekAcc(useScope, ctx);
  if (!v) {
    // v0.8.x cwf-tickStatus-v2 — the accCached track only writes
    // when stdin carries the cache field. m_accTokenCachedIn /
    // m_accTokenTotalIn / m_accTokenHitRate must still honor
    // the "field not shipped" → "--" contract, so we don't fire
    // accCachePrimer here on a missing slot — the placeholder
    // shape is the only honest signal in that case.
    return placeholderAcc(field, useScope, ctx);
  }
  // v0.8.x cwf-tickStatus-v2 — the "field not shipped" contract on
  // the cache track (m_accTokenCachedIn / m_accTokenTotalIn /
  // m_accTokenHitRate): when stdin lacks cache_read_input_tokens
  // entirely, render the field-specific "--" placeholder rather
  // than "0" / "total:0". Mirrors the v0.4.x m_totalTokenWith
  // CacheIn behavior.
  if (
    (field === "cached" || field === "total") &&
    ctx.tokens?.current?.cacheRead === null
  ) {
    return placeholderAcc(field, useScope, ctx);
  }
  // Fire the cache-track primer now that the slot exists, so
  // accCached lands on disk and the next render's peekAcc sees
  // it. Safe to call even when field === "in" (idempotent via
  // _tickCacheWriteMemo; only writes when cacheRead != null).
  accCachePrimer(ctx);
  // Re-read after the cache primer (it may have bumped accCached).
  const v2 = peekAcc(useScope, ctx) ?? v;
  let n: number;
  switch (field) {
    case "in": n = v2.accIn; break;
    case "out": n = v2.accOut; break;
    case "cached": n = v2.accCached; break;
    case "apiMs": n = v2.accApi; break;
    case "apiCalls": n = v2.accApiCount; break;
    case "total": n = v2.accIn + v2.accCached; break;
  }
  // v0.8.0+ — acc* family prefixes use the same label axes as their
  // per-turn siblings. m_accTokenIn/Out/CachedIn/TotalIn share
  // labelIn / labelOut / labelCacheIn / labelTotalIn; m_accApiMs
  // uses the hardcoded "api:" prefix (the API-ms series is not a
  // user-facing label axis) and renders via formatRemainingMs so the
  // accumulator matches m_apiMs's "api:1m" dhms shape rather than
  // the v0.7.x raw-ms `acc:60.0k` literal. Honors the same
  // timeFormat.minUnit / maxUnitCount knobs as the per-turn
  // sibling. Defaults reproduce the v0.7.x literal "acc:" prefix
  // for the in/out/cached/total fields via the corresponding
  // label.* defaults.
  let prefix: string;
  let body: string;
  switch (field) {
    case "in": prefix = labelFor("in"); body = formatCompactToken(n); break;
    case "out": prefix = labelFor("out"); body = formatCompactToken(n); break;
    case "cached": prefix = labelFor("cacheIn"); body = formatCompactToken(n); break;
    case "total": prefix = labelFor("totalIn"); body = formatCompactToken(n); break;
    // v0.8.x — m_accApiMs now renders `api:<dhms>` to mirror m_apiMs.
    // The accumulator value (accApi) is session-cumulative
    // totalApiMs, so the formatted string grows monotonically as
    // the session ages (e.g. "api:5m", "api:1h12m").
    case "apiMs": prefix = "api:"; body = formatRemainingMs(n); break;
    // v0.8.x — m_accApiCalls mirrors m_apiCalls's `calls:N` shape
    // (the value-zero rule says count:0 still renders, since
    // zero is a real measured count, not a "no data" signal).
    case "apiCalls": prefix = "calls:"; body = String(n); break;
  }
  return `${prefix}${body}`;
}

// m_accTokenHitRate — session-aggregate formula
// (accCached / (accCached + accIn) * 100). Colored via the
// cacheHitColor palette (good ≥ 80%, warn ≥ 50%, bad < 50%).
// Zero denominator (no input and no cache reads) renders
// "hit:0.0%"; missing-acc placeholder when the slot has never
// been written.
//
// v0.8.x R8 — prefix unified with m_tokenHitRate: both modules
// now render "hit:N%" (was "acc:N%" for the acc variant). The
// acc/sum/per-turn triple shares the same "hit:" prefix so
// users can compose them in a lineTemplate without having to
// re-bind the prefix. The scope distinction is still visible
// via the surrounding context (m_acc* siblings use the same
// default ccsession scope, m_tokenHitRate is per-turn).
function accHitRateBody(
  ctx: RenderContext,
  scope?: "session" | "project" | "model" | "ccsession",
): string {
  // See accBody for the primer rationale.
  accPrimer(ctx);
  // v0.8.x cwf-tickStatus-v2 — "field not shipped" signal on
  // the cache track. m_accTokenHitRate is undefined when stdin
  // lacks cache_read_input_tokens — render the placeholder
  // rather than fabricating a 0% hit rate.
  if (ctx.tokens?.current?.cacheRead === null) {
    return placeholderAcc("hitRate", scope ?? "ccsession", ctx);
  }
  accCachePrimer(ctx);
  const useScope = scope ?? "ccsession";
  const v = peekAcc(useScope, ctx);
  if (!v) return placeholderAcc("hitRate", useScope, ctx);
  const denom = v.accCached + v.accIn;
  if (denom === 0) return `${cacheHitColor(0)}hit:0.0%${RESET}`;
  const pct = (v.accCached / denom) * 100;
  const color = cacheHitColor(pct);
  return `${color}hit:${pct.toFixed(cachePctPrecision())}%${RESET}`;
}

// m_acc* placeholder shape: "acc:n/a" for plain fields, "acc:n/a%"
// for the hit-rate module. Used when the chosen scope has no
// accumulator written yet. The `scope` arg is currently unused (we
// render the same placeholder regardless of scope) — included so
// the call site is self-documenting and a future tweak that
// distinguishes scopes (e.g. "acc(total):n/a") has a hook.
function placeholderAcc(
  field: "in" | "out" | "cached" | "total" | "apiMs" | "apiCalls" | "hitRate",
  _scope: "session" | "project" | "model" | "ccsession",
  ctx: RenderContext,
): string {
  // v0.8.0+ labels.* — the four token-axis fields read their
  // prefix from labelFor so the placeholder matches the user's
  // configured labelIn / labelOut / labelCacheIn / labelTotalIn.
  // apiMs mirrors m_apiMs's "api:" prefix (not part of the
  // user-facing axis set). v0.8.x R8 — hitRate mirrors
  // m_tokenHitRate's "hit:" prefix (was "acc:" before R8) so
  // the per-turn / acc / sum triple all share the same "hit:n/a%"
  // placeholder shape.
  let prefix: string;
  switch (field) {
    case "in": prefix = labelFor("in"); break;
    case "out": prefix = labelFor("out"); break;
    case "cached": prefix = labelFor("cacheIn"); break;
    case "total": prefix = labelFor("totalIn"); break;
    case "apiMs": prefix = "api:"; break;
    case "apiCalls": prefix = "calls:"; break;
    case "hitRate": prefix = "hit:"; break;
  }
  // v0.8.x cwf-tickStatus-v2 — "cached" and "total" use the
  // "field not shipped" → "--" shape ONLY when the cache field
  // is explicitly null on the snapshot (current.cacheRead ===
  // null). When tokens is null entirely (no snapshot at all),
  // the generic "n/a" shape is more honest — we don't know
  // whether the field was shipped or not. hitRate keeps the %
  // suffix.
  const fieldNotShipped =
    (field === "cached" || field === "total") &&
    ctx.tokens?.current?.cacheRead === null;
  let body: string;
  if (fieldNotShipped) {
    body = `${prefix}--`;
  } else if (field === "hitRate") {
    body = `${prefix}n/a%`;
  } else {
    body = `${prefix}n/a`;
  }
  return `${STALE_COLOR}${body}${RESET}`;
}

const MODULES: Record<string, Module> = {
  // The leading prefix. For the plan path, picks the mode-aware
  // label ("Usage:" / "Remain:"). For the balance path, the label
  // is the dedicated modeLabels.balance entry (default "Balance:").
  // Returns the label WITHOUT a trailing space — the surrounding
  // s_0 separator token provides spacing.
  // The leading prefix. For the plan path, picks the mode-aware
  // label ("Usage:" / "Remain:"). For the balance path, the label
  // is the dedicated modeLabels.balance entry (default "Balance:").
  // v0.4.x — body routes on ctx.providerType. providerType === "balance"
  // gets the dedicated Balance label; providerType === "plan" or
  // "unknown" both get the display-mode label (`used` / `remaining`).
  // "unknown" sharing the plan label is intentional — there's no
  // plan-shaped provider configured, but if the user's display mode
  // is "used" we still want "Usage:" as the prefix. The surrounding
  // m_window5h/m_balance modules carry the per-provider `type`
  // filter; m_modeLabel doesn't need to.
  // Returns the label WITHOUT a trailing space — the surrounding
  // s_0 separator token provides spacing.
  m_modeLabel: (c) => wrapPlainDefault("m_modeLabel",
    c.providerType === "balance"
      ? cfg().modeLabels.balance
      : cfg().modeLabels[c.mode],
    undefined),
  m_window5h: Object.assign(
    // v6.x: bare form now follows the placeholder rule — when the
    // window is missing, render the gray gauge placeholder
    // ("░░░░░░░░ 0%" used / "▓▓▓▓▓▓▓▓ 100%" remaining) instead of
    // dropping. Inline `m_window5h:` had this since v0.4.x; the
    // bare path was the lone hold-out.
    ((c: RenderContext) => c.fiveHour ? formatOneChunk(c.fiveHour, c.mode, cfg().bar.width, c.stale) : placeholderBare("m_window5h", c)),
    { type: "plan" as const },
  ),
  m_window7d: Object.assign(
    ((c: RenderContext) => c.weekly ? formatOneChunk(c.weekly, c.mode, cfg().bar.width, c.stale) : placeholderBare("m_window7d", c)),
    { type: "plan" as const },
  ),
  // Reset-suffix portion of a window. v6.x: when the whole window
  // is missing, render "5h:--" / "7d:--" placeholder (matches the
  // inline behavior). When resetAt is missing the helper still
  // emits " <label>" (e.g. " 5h") so the m_countdown5h token
  // doubles as the window-label module for legacy/no-reset data.
  //
  // v0.7.x: when ctx.stale AND resetAt <= nowMs (past-due), the
  // cached countdown is no longer trustworthy — swap the body for
  // "(n/a<arrow> <label>)" and tint it STALE_COLOR so the user
  // sees a gray "already-expired, no longer readable" reading
  // instead of the default teal "(0m<arrow> <label>)".
  m_countdown5h: Object.assign(
    ((c: RenderContext) => {
      if (!c.fiveHour) return placeholderBare("m_countdown5h", c);
      if (isStaleAndPastDue(c.fiveHour, c.stale, c.nowMs)) {
        return `${STALE_COLOR}${formatStalePastDueResetSuffix("5h", c.fiveHour, c.nowMs)}${RESET}`;
      }
      return wrapPlainDefault("m_countdown5h", formatOneResetSuffix("5h", c.fiveHour, c.nowMs), undefined);
    }),
    { type: "plan" as const },
  ),
  m_countdown7d: Object.assign(
    ((c: RenderContext) => {
      if (!c.weekly) return placeholderBare("m_countdown7d", c);
      if (isStaleAndPastDue(c.weekly, c.stale, c.nowMs)) {
        return `${STALE_COLOR}${formatStalePastDueResetSuffix("7d", c.weekly, c.nowMs)}${RESET}`;
      }
      return wrapPlainDefault("m_countdown7d", formatOneResetSuffix("7d", c.weekly, c.nowMs), undefined);
    }),
    { type: "plan" as const },
  ),
  // The DeepSeek balance chunk. v6.x: when there's nothing to
  // render (unavailable / empty / no min), emit a "balance:n/a"
  // placeholder instead of dropping. Aligns with the bare-vs-inline
  // parity rule.
  m_balance: Object.assign(
    ((c: RenderContext) => c.balance ? formatBalanceEntriesColored(c.balance) || placeholderBare("m_balance", c) : placeholderBare("m_balance", c)),
    { type: "balance" as const },
  ),
  // Stale-age annotation. v6.x: when ageMs is missing, emit
  // "age:n/a" placeholder (was: drop). The :nulldrop|true inline
  // override still drops for users wanting v0.3.x semantics.
  m_age: (c) => {
    if (c.ageMs == null) return placeholderBare("m_age", c);
    // v0.6.0+ — dedup against any other m_age that already emitted
    // anywhere in the recursive render tree. The forced-visibility
    // append in renderProviderLine reads the same ref; the FIRST
    // m_age to fire (whichever instance it is) claims the slot,
    // all subsequent instances return null.
    if (c.ageEmittedRef?.value) return null;
    if (c.ageEmittedRef) c.ageEmittedRef.value = true;
    return formatStaleSuffix(c.ageMs, !c.stale);
  },
  // Plugin version (e.g. "v0.2.17"). v6.x: empty version → emit
  // "v:n/a" placeholder (was: drop). Aligns with the bare-vs-inline
  // parity rule.
  m_version: (c) => (c.version ? wrapPlainDefault("m_version", `v${c.version}`, undefined) : placeholderBare("m_version", c)),
  // ----- v0.4.0+ token-usage modules -----
  // Each module is independent and returns null when its source data
  // isn't available, so users compose freely via lineTemplate. The
  // default plan / balance templates do NOT include any of these —
  // existing users see no change on upgrade.

  // Per-API-call input tokens. v0.4.0+ — semantics changed
  // again: from "raw current_usage.input_tokens (absolute)" to
  // "delta of current.input vs the previous tick's snapshot, but
  // ONLY when an actual API call happened between ticks". The
  // same prevTick cache that m_tokenInSpeed uses is read here;
  // the gate is identical (delta_api > 0). When no API call
  // landed, this module renders "in:--" — same stable-slot
  // pattern as the speed modules — so the user can SEE whether
  // the current turn produced output or just sat idle. For the
  // session-cumulative intent, see m_tokenInTotal / m_tokenTotal
  // / m_tokenSession.
  m_tokenIn: (c) => {
    const r = computeTickDelta(c, "in");
    if (r.writeBack && c.tokens?.sessionId) setPrevTick(c.tokens.sessionId, r.writeBack, c.tokens.cwd, {
      sessionId: c.tokens.sessionId, cwd: c.tokens.cwd, model: c.tokens.modelDisplayName ?? null,
    });
    return r.value;
  },
  // Per-API-call output tokens (see m_tokenIn for the gate
  // rationale — output-only turns, thinking-only turns, idle
  // turns all produce different "out:--" / "out:N" signals).
  m_tokenOut: (c) => {
    const r = computeTickDelta(c, "out");
    if (r.writeBack && c.tokens?.sessionId) setPrevTick(c.tokens.sessionId, r.writeBack, c.tokens.cwd, {
      sessionId: c.tokens.sessionId, cwd: c.tokens.cwd, model: c.tokens.modelDisplayName ?? null,
    });
    return r.value;
  },
  // Session cumulative in + out + cache (cache = ctx_creation + ctx_read
  // from the latest per-turn snapshot — close enough for "total tokens
  // spent in this session" intent; users wanting exact counts can split
  // into m_tokenIn / m_tokenOut).
  m_tokenTotal: (c) => {
    const t = c.tokens;
    if (!t) return placeholderBare("m_tokenTotal", c);
    const inT = t.totals.input ?? 0;
    const outT = t.totals.output ?? 0;
    const cache =
      (t.current.cacheCreation ?? 0) + (t.current.cacheRead ?? 0);
    return `tot:${formatCompactToken(inT + outT + cache)}`;
  },
  // Alias for m_tokenTotal — clearer when used in a template that
  // also has m_token5h/m_token7d (so the three read as "session / 5h /
  // 7d" rather than "tot / 5h / 7d").
  m_tokenSession: (c) => {
    const t = c.tokens;
    if (!t) return placeholderBare("m_tokenSession", c);
    const inT = t.totals.input ?? 0;
    const outT = t.totals.output ?? 0;
    const cache =
      (t.current.cacheCreation ?? 0) + (t.current.cacheRead ?? 0);
    return `session:${formatCompactToken(inT + outT + cache)}`;
  },
  // v0.8.0+ — renamed from `m_ctx`. The new semantic: "context
  // size" = `context_window.total_input_tokens` (the cumulative
  // amount of input tokens currently in the context window).
  // Previously `m_ctx` computed `current.input + current.cacheCreation
  // + current.cacheRead` (the per-turn context length). The new
  // semantic is what users mean when they say "size" — the actual
  // occupancy, sourced from the cumulative `total_input_tokens`
  // field. Prefix: `size:<N>`. The capacity (upper bound) is a
  // separate module: `m_contextWindowsSize` (typo preserved per
  // user direction). See [[token-modules-redesign-v0-8-0]].
  //
  // v6.x: zero length renders as "size:0" (the user's "0 直接显示"
  // rule). The placeholder path is reserved for the truly
  // missing-data case (no totals.input at all).
  m_contextSize: (c) => {
    const total = c.tokens?.totals?.input;
    if (total == null) return placeholderBare("m_contextSize", c);
    return `size:${formatCompactToken(total)}`;
  },
  // v0.8.0+ — semantic change: per-turn hit rate, not session-aggregate.
  // New formula: m_tokenCachedIn / m_tokenTotalIn (per-turn snapshot)
  //   = current_usage.cache_read_input_tokens / context_window.total_input_tokens
  // The session-aggregate formula
  //   (accCached / (accCached + accIn), v0.4.x semantics) is now
  // exposed as a separate module: m_accTokenHitRate (see
  // [[token-modules-redesign-v0-8-0]]). Coloring still uses the
  // cacheHitColor palette (good ≥ 80%, warn ≥ 50%, bad < 50%).
  //
  // Zero denominator (no input and no cache reads) renders as
  // "hit:0.0%" — the "0 直接显示" rule. Missing-totals or
  // missing-cacheRead → "hit:n/a" placeholder.
  m_tokenHitRate: (c) => {
    const t = c.tokens;
    if (!t) return placeholderBare("m_tokenHitRate", c);
    const total = t.totals?.input;
    const cacheRead = t.current?.cacheRead;
    if (total == null || cacheRead == null) {
      // v0.8.x — mirror m_apiMs / m_tokenInSpeed / m_tokenOutSpeed:
      // when the field is not shipped this tick but a prior
      // measurement sits in the lastActive:tokenHitRate slot
      // within the 60s TTL window, surface it STALE_COLORed
      // instead of dropping to the "hit:n/a" placeholder. The
      // user-facing rationale: the per-turn hit rate is a
      // reading that decays slowly; an idle tick should display
      // the last known value, not blank.
      if (c.tokens?.sessionId) {
        const cached = peekLastTokenHitRate(c.tokens.sessionId, c.tokens.cwd);
        if (cached != null) {
          return wrapPlainDefault(
            "m_tokenHitRate",
            `hit:${cached.toFixed(cachePctPrecision())}%`,
            STALE_COLOR,
          );
        }
      }
      return placeholderBare("m_tokenHitRate", c);
    }
    if (total === 0) return `${STALE_COLOR}hit:0.0%${RESET}`;
    const pct = (cacheRead / total) * 100;
    // v0.8.x — cache the active measurement so subsequent ticks
    // that lack cacheRead can fall back to it (mirrors setLastSpeed
    // / setLastApiMs). Only persist when the per-tick delta is
    // actually present (the gate above already required cacheRead
    // != null), so a "field not shipped" tick never writes 0/0.
    if (t.sessionId) {
      setLastTokenHitRate(t.sessionId, pct, t.cwd);
    }
    // v0.8.x — "active" coloring: the per-turn hit rate is only
    // a fresh reading when the API actually did work this tick
    // (hasDelta=true from computeAndCacheTickDelta, the same
    // signal m_tokenInSpeed / m_tokenOutSpeed / m_apiMs use to
    // decide STALE_COLOR vs band-color). An idle tick's
    // current.cacheRead is the same value the prior tick had
    // (the field doesn't change when the API is idle), so the
    // displayed rate is "from a previous API call" — gray it,
    // matching the tps siblings. The setLastTokenHitRate above
    // already idempotently overwrites with the same value, so
    // the cache is unaffected by an idle re-render.
    const r = computeAndCacheTickDelta(c);
    if (r.writeBack && t.sessionId) setPrevTick(t.sessionId, r.writeBack, t.cwd, {
      sessionId: t.sessionId, cwd: t.cwd, model: t.modelDisplayName ?? null,
    });
    if (!r.hasDelta) {
      return wrapPlainDefault(
        "m_tokenHitRate",
        `hit:${pct.toFixed(cachePctPrecision())}%`,
        STALE_COLOR,
      );
    }
    const color = cacheHitColor(pct);
    return `${color}hit:${pct.toFixed(cachePctPrecision())}%${RESET}`;
  },
  // v0.8.0+ — renamed from `m_cacheRead`. The old name's `cache`
  // prefix collided conceptually with m_tokenHitRate (which is the
  // session-aggregate hit-rate percentage). The new name lives in
  // the `m_token*` family: it's "this turn's cache-read input
  // tokens", a sibling of m_tokenIn / m_tokenOut / m_tokenTotalIn.
  // See [[token-modules-redesign-v0-8-0]] for the rename rationale.
  //
  // Source: `current_usage.cache_read_input_tokens` (per-turn snapshot,
  // not session-cumulative). Single-color (STALE_COLOR). v6.x: zero
  // reads now render as "cache:0"; null cacheRead field on a present
  // snapshot falls back to placeholder "cache:n/a". The bare-token
  // shape dropped the `(XX%)` share suffix in v0.8.6+ — the
  // dedicated m_tokenHitRate module renders the ratio for users who
  // want it, keeping m_tokenCachedIn focused on the raw token count.
  m_tokenCachedIn: (c) => {
    const t = c.tokens?.current;
    if (!t) return placeholderBare("m_tokenCachedIn", c);
    // v6.x: cacheRead=null is now distinct from cacheRead=0.
    // null (field not shipped by stdin) → "cache:n/a" placeholder;
    // 0 (real zero cache reads) → "cache:0" — the user can
    // see "we tracked, nothing cached" vs "no tracking at all".
    if (t.cacheRead == null) return placeholderBare("m_tokenCachedIn", c);
    const label = formatCompactToken(t.cacheRead);
    const prefix = labelFor("cacheIn");
    return `${STALE_COLOR}${prefix}${label}${RESET}`;
  },
  // v0.4.0+ — per-API-call input speed. Reads the previous-tick
  // snapshot from cache (keyed by sessionId) and computes
  // delta(current.input) / delta(cost.totalApiDurationMs) * 1000.
  // The bare form (and `:color|scale`) applies the 5-band scale
  // color via speedScaleColor: faster = greener, slower = redder;
  // the `:color|<shortcut|SGR>` form overrides with a single color
  // (e.g. `:color|red`). computeTickSpeed handles the cached /
  // idle case by switching to STALE_COLOR regardless of the
  // caller's color — gray signals "inactive: this measurement is
  // from a previous API call, not this tick".
  m_tokenInSpeed: (c) => {
    // First call with a temporary color to discover the tps
    // (for the active case); the actual rendered value comes
    // from a second call with the proper color. Two
    // computeAndCacheTickDelta calls is fine — the per-render
    // memo makes the second call free.
    const probe = computeTickSpeed(c, "in", STALE_COLOR);
    const color = probe.active
      ? speedScaleColor("in", probe.tps ?? 0)
      : STALE_COLOR; // unused — computeTickSpeed forces STALE
    const r = computeTickSpeed(c, "in", color);
    if (r.writeBack && c.tokens?.sessionId) setPrevTick(c.tokens.sessionId, r.writeBack, c.tokens.cwd, {
      sessionId: c.tokens.sessionId, cwd: c.tokens.cwd, model: c.tokens.modelDisplayName ?? null,
    });
    return r.value;
  },
  // v0.4.0+ — per-API-call output speed (see m_tokenInSpeed for
  // the math + drop conditions).
  m_tokenOutSpeed: (c) => {
    const probe = computeTickSpeed(c, "out", STALE_COLOR);
    const color = probe.active
      ? speedScaleColor("out", probe.tps ?? 0)
      : STALE_COLOR;
    const r = computeTickSpeed(c, "out", color);
    if (r.writeBack && c.tokens?.sessionId) setPrevTick(c.tokens.sessionId, r.writeBack, c.tokens.cwd, {
      sessionId: c.tokens.sessionId, cwd: c.tokens.cwd, model: c.tokens.modelDisplayName ?? null,
    });
    return r.value;
  },
  // v0.8.x cwf-tickStatus-v2 — m_totalToken* / m_totalTokenWithCacheIn
  // REMOVED. Use the m_acc* family with scope=ccsession (default):
  //   m_totalTokenIn          → m_accTokenIn
  //   m_totalTokenOut         → m_accTokenOut
  //   m_totalTokenWithCacheIn → m_accTokenCachedIn
  // v0.8.0+ — six per-session/per-model/per-project accumulators
  // (m_accTokenIn / m_accTokenOut / m_accTokenCachedIn /
  // m_accTokenTotalIn / m_accApiMs / m_accTokenHitRate). They all
  // read the four-layer accumulator (ccsession / session / project /
  // model) via peekAcc and render in the same shape:
  //
  //   m_accTokenIn                 → "acc(ccs):163.5k"   (ccsession default)
  //   m_accTokenIn:scope:project   → "acc(total):42.3k"
  //   m_accTokenIn:scope:model     → "acc(MiniMax-M3):12.4k"
  //
  // The acc value is a real measured number, not a delta — 0 is
  // rendered as "acc:0" (the value-zero rule). The placeholder path
  // is reserved for the truly-missing-data case (no session, no
  // model for the model scope, no prior accumulator write).
  //
  // These six modules re-use the same accumulator that m_totalToken*
  // / m_tokenInAvg / m_tokenOutAvg maintain — no new tick-side
  // writes. The first valid tick of a session primes the slot;
  // until then, the placeholder fires.
  // v0.8.0+ — the bare m_acc* forms render at the default scope
  // (session if a sessionId exists in the live snapshot, else
  // project). The inline form `m_acc*:scope:<session|project|model>`
  // overrides; the inline path is wired in INLINE_RENDERERS below
  // and uses the same accBody / accHitRateBody helpers.
  // v0.8.7+ — when a `scope` is on `ctx.passThrough` (i.e. an outer
  // m_template forwarded it), the bare form honors it the same way
  // the inline form does, so `m_template|<key>|scope|project` can
  // route a bare `m_accTokenIn` (no inline args) to the project
  // scope. Inner-explicit-wins: when the inner token is the inline
  // form `m_accTokenIn|scope|...`, that arg beats the passthrough.
  m_accTokenIn: (c) => accBody(c, "in", passThroughScope(c)),
  m_accTokenOut: (c) => accBody(c, "out", passThroughScope(c)),
  m_accTokenCachedIn: (c) => accBody(c, "cached", passThroughScope(c)),
  m_accTokenTotalIn: (c) => accBody(c, "total", passThroughScope(c)),
  m_accApiMs: (c) => accBody(c, "apiMs", passThroughScope(c)),
  // v0.8.x — m_accApiCalls mirrors m_apiCalls (`calls:N`) but reads
  // the chosen scope's accApiCount slot from status.json. Default
  // scope is ccsession (per-process, resets only on totalApiMs
  // regression). Inline `m_accApiCalls|scope|project` etc. to widen
  // or narrow. value=0 still renders as `calls:0` (the value-zero
  // rule — count:0 is real data, not a placeholder).
  m_accApiCalls: (c) => accBody(c, "apiCalls", passThroughScope(c)),
  // m_accTokenHitRate — session-aggregate formula
  // (accCached / (accCached + accIn) * 100), the v0.4.x semantic
  // that m_tokenHitRate (per-turn) replaced. Coloring uses the
  // cacheHitColor palette. v0.8.x — renamed from m_accCacheHitRate
  // to align the namespace with m_tokenHitRate (per-turn) and
  // m_sumTokenHitRate (cross-project).
  m_accTokenHitRate: (c) => accHitRateBody(c, passThroughScope(c)),
  // v0.8.0+ — sum/avg advanced statistics. 5 plain sums (in/out/
  // cached/total/apiMs) + 3 ratios (tokenHitRate + tokenInSpeed +
  // tokenOutSpeed). All default to "|model|active" + "|window|5h"
  // + "|align|true" — the inline form `m_sumTokenIn|window|7d` etc
  // overrides. See parseWindowScope + fetchSumAggregate for the
  // resolution path; results are cached in state/cache.json under
  // the "stat:<model>:<window>:<align>" key (window ∈ {"5h","7d",
  // "all"}) with TTL=300s. sinceMs is derived but not part of the
  // key, capping the cache at 12 entries.
  m_sumTokenIn: (c) => {
    const filter = parseWindowScope(c, c.passThrough ?? {});
    if (!filter) return null;
    const agg = fetchSumAggregate(filter);
    return agg.rows === 0 ? null : `${labelFor("in")}${formatCompactToken(agg.sumIn)}`;
  },
  m_sumTokenOut: (c) => {
    const filter = parseWindowScope(c, c.passThrough ?? {});
    if (!filter) return null;
    const agg = fetchSumAggregate(filter);
    return agg.rows === 0 ? null : `${labelFor("out")}${formatCompactToken(agg.sumOut)}`;
  },
  m_sumTokenCachedIn: (c) => {
    const filter = parseWindowScope(c, c.passThrough ?? {});
    if (!filter) return null;
    const agg = fetchSumAggregate(filter);
    return agg.rows === 0 ? null : `${labelFor("cacheIn")}${formatCompactToken(agg.sumCached)}`;
  },
  m_sumTokenTotalIn: (c) => {
    const filter = parseWindowScope(c, c.passThrough ?? {});
    if (!filter) return null;
    const agg = fetchSumAggregate(filter);
    return agg.rows === 0 ? null : `${labelFor("totalIn")}${formatCompactToken(agg.sumTotalIn)}`;
  },
  m_sumApiMs: (c) => {
    const filter = parseWindowScope(c, c.passThrough ?? {});
    if (!filter) return null;
    const agg = fetchSumAggregate(filter);
    return agg.rows === 0 ? null : `api:${formatRemainingMs(agg.sumApiMs)}`;
  },
  // v0.8.x — m_avg* renamed to m_sum* to align the namespace with
  // the cross-project JSONL scan family (m_sumTokenIn/Out/...).
  // m_sumTokenHitRate replaces m_avgCacheHitRate (the SUM-OF-
  // CACHED-OVER-TOTAL formula, NOT the per-turn m_tokenHitRate);
  // m_sumTokenInSpeed / m_sumTokenOutSpeed replace the
  // m_avgTokenInSpeed / m_avgTokenOutSpeed tps averages. The old
  // m_avg* names are REMOVED with no alias (consistent with the
  // v0.8.0 major-bump).
  m_sumTokenHitRate: (c) => {
    const filter = parseWindowScope(c, c.passThrough ?? {});
    if (!filter) return null;
    const agg = fetchSumAggregate(filter);
    const denom = agg.sumIn + agg.sumCached;
    if (agg.rows === 0 || denom === 0) return null;
    const pct = (agg.sumCached / denom) * 100;
    return `${cacheHitColor(pct)}hit:${pct.toFixed(cachePctPrecision())}%${RESET}`;
  },
  m_sumTokenInSpeed: (c) => {
    const filter = parseWindowScope(c, c.passThrough ?? {});
    if (!filter) return null;
    const agg = fetchSumAggregate(filter);
    if (agg.sumApiMs === 0) return null;
    const tps = (agg.sumIn / agg.sumApiMs) * 1000;
    return `${labelFor("in")}${formatSpeed(tps)}`;
  },
  m_sumTokenOutSpeed: (c) => {
    const filter = parseWindowScope(c, c.passThrough ?? {});
    if (!filter) return null;
    const agg = fetchSumAggregate(filter);
    if (agg.sumApiMs === 0) return null;
    const tps = (agg.sumOut / agg.sumApiMs) * 1000;
    return `${labelFor("out")}${formatSpeed(tps)}`;
  },
  // v0.8.x — total count of API calls (rows with apiMs > 0) in the
  // window. Honors :model|, :window|, :align| like the other
  // m_sum* modules. Despite the family being "sum" (cross-tick
  // aggregate), the value is a COUNT, not a token — kept under the
  // m_sum prefix because the rendering path is the same
  // (windowed cross-project JSONL scan → single cached aggregate).
  m_sumApiCalls: (c) => {
    const filter = parseWindowScope(c, c.passThrough ?? {});
    if (!filter) return null;
    const agg = fetchSumAggregate(filter);
    return agg.calls === 0 ? null : `calls:${agg.calls}`;
  },
  // v0.3.6+ — bare `m_quote` (no inline args). Picks a quote from
  // the hourly window and renders it plain (no SGR wrapper). Opt-in
  // — the default plan / balance templates do NOT include it.
  m_quote: (c) => {
    const freq = parseFreq("h");
    if (!freq) return null; // unreachable — "h" is always valid
    return pickQuote(freq, c.nowMs);
  },

  // ----- v0.4.0+ session-info / metadata modules -----
  // These read fields from the live stdin payload. The default
  // plan / balance templates do NOT include any of these — they are
  // strictly opt-in via lineTemplate.

  // Session name (stdin.session_name). v6.x: bare form now emits
  // "n/a" placeholder when missing (was: drop).
  m_session: (c) => c.tokens?.sessionName ? wrapPlainDefault("m_session", c.tokens.sessionName, undefined) : placeholderBare("m_session", c),
  // Model display name (stdin.model.display_name). v6.x: bare
  // form emits "n/a" placeholder when missing.
  m_model: (c) => c.tokens?.modelDisplayName ? wrapPlainDefault("m_model", c.tokens.modelDisplayName, undefined) : placeholderBare("m_model", c),
  // Effort level (stdin.effort, polymorphic — already coerced to
  // string by parseTokenSnapshot). v6.x: bare form emits "n/a"
  // placeholder when missing.
  m_effort: (c) => c.tokens?.effort ? wrapPlainDefault("m_effort", c.tokens.effort, undefined) : placeholderBare("m_effort", c),
  // Repository identity (stdin.workspace.repo). v6.x: when no
  // component is available, emit "n/a" placeholder instead of drop.
  m_repo: (c) => {
    const r = c.tokens?.repo;
    if (!r) return placeholderBare("m_repo", c);
    const parts = [r.host, r.owner, r.name].filter(
      (p): p is string => p != null && p.length > 0,
    );
    return parts.length > 0 ? wrapPlainDefault("m_repo", parts.join("/"), undefined) : placeholderBare("m_repo", c);
  },
  // Claude Code CLI version (stdin.version). v6.x: bare form
  // emits "n/a" placeholder when missing.
  m_ccVersion: (c) => c.tokens?.ccversion ? wrapPlainDefault("m_ccVersion", c.tokens.ccversion, undefined) : placeholderBare("m_ccVersion", c),
  // Current git branch. v6.x: cwd missing / not a git repo /
  // detached HEAD now emit "branch:n/a" placeholder (was: drop).
  m_branch: (c) => readGitInfo(c.tokens?.cwd)?.branch ? wrapPlainDefault("m_branch", readGitInfo(c.tokens!.cwd)!.branch!, undefined) : placeholderBare("m_branch", c),
  // Git working-tree cleanliness indicator. v6.x: missing git
  // info → "git:n/a" placeholder (was: drop).
  m_gitStatus: (c) => {
    const info = readGitInfo(c.tokens?.cwd);
    if (info == null) return placeholderBare("m_gitStatus", c);
    return wrapPlainDefault("m_gitStatus", info.dirty ? "dirty" : "clean", undefined);
  },
  // Deprecated alias — see m_ccVersion above.
  m_ccversion: (c) => c.tokens?.ccversion ? wrapPlainDefault("m_ccversion", c.tokens.ccversion, undefined) : placeholderBare("m_ccversion", c),
  // Session elapsed wall-clock (stdin.cost.total_duration_ms).
  // v6.x: missing field → "--" placeholder (was: drop). 0 ms is
  // a real value and renders as "0s".
  m_sessionDuration: (c) => {
    const ms = c.tokens?.cost.totalDurationMs;
    return ms != null ? wrapPlainDefault("m_sessionDuration", formatRemainingMs(ms), undefined) : placeholderBare("m_sessionDuration", c);
  },
  // Session API-call time (stdin.cost.total_api_duration_ms). v6.x:
  // missing field → "--" placeholder.
  m_sessionApiDuration: (c) => {
    const ms = c.tokens?.cost.totalApiDurationMs;
    return ms != null ? wrapPlainDefault("m_sessionApiDuration", formatRemainingMs(ms), undefined) : placeholderBare("m_sessionApiDuration", c);
  },
  // v0.8.0+ — per-turn delta of cost.totalApiDurationMs rendered
  // as a dhms time string with the "api:" prefix. Reuses the
  // shared computeAndCacheTickDelta memo (same r.deltaApi that
  // m_tokenIn / m_tokenOut / m_tokenInSpeed read), so the
  // prev-tick baseline is maintained regardless of which
  // per-turn module appears in the user's template.
  //
  // Gate: hasDelta (deltaApi > 0). Idle ticks → "api:--"
  // placeholder via PLACEHOLDERS; first tick with prev=0
  // baseline → real value (per the per-turn-delta contract:
  // current_usage IS the per-turn delta, so the safe assumption
  // is prior=0). No snapshot / no sessionId → placeholder.
  //
  // The writeBack path mirrors m_tokenIn / m_tokenOut: when
  // computeAndCacheTickDelta returns a non-null writeBack we
  // fire setPrevTick so the NEXT tick has a fresh baseline.
  // When this module is rendered alone in a template (no other
  // per-turn module), the writeBack here is the only one —
  // still sufficient because setPrevTick is idempotent and the
  // next tick's computeAndCacheTickDelta will overwrite with
  // the freshest snapshot.
  m_apiMs: (c) => {
    const t = c.tokens;
    if (!t || !t.sessionId) return placeholderBare("m_apiMs", c);
    const r = computeAndCacheTickDelta(c);
    if (r.writeBack && t.sessionId) setPrevTick(t.sessionId, r.writeBack, t.cwd, {
      sessionId: t.sessionId, cwd: t.cwd, model: t.modelDisplayName ?? null,
    });
    if (!r.hasDelta) {
      // v0.8.x — mirror m_tokenInSpeed/m_tokenOutSpeed: when this
      // tick has no API-call delta, fall back to the last cached
      // deltaApiMs within the 60s TTL window instead of dropping
      // to "api:--". The cached value is rendered STALE_COLORed
      // (gray) so the user sees the reading is from a previous
      // API call, not this tick — same convention as the tps
      // siblings. Outside the TTL or with no prior measurement,
      // we still drop to the placeholder.
      const cached = peekLastApiMs(t.sessionId, t.cwd);
      if (cached != null) {
        return wrapPlainDefault(
          "m_apiMs",
          `api:${formatRemainingMs(cached)}`,
          STALE_COLOR,
        );
      }
      return placeholderBare("m_apiMs", c);
    }
    // Active tick — cache the deltaApiMs so subsequent idle ticks
    // within the TTL window can fall back to it.
    setLastApiMs(t.sessionId, r.deltaApi, t.cwd);
    return wrapPlainDefault("m_apiMs", `api:${formatRemainingMs(r.deltaApi)}`, undefined);
  },
  // Session-cumulative lines added (stdin.cost.total_lines_added).
  // v6.x: missing field → "+ --" placeholder (was: drop). Zero is
  // a real value and renders as "+ 0".
  m_linesAdded: (c) => {
    const n = c.tokens?.cost.totalLinesAdded;
    return n != null ? wrapPlainDefault("m_linesAdded", `+ ${n}`, undefined) : placeholderBare("m_linesAdded", c);
  },
  // Session-cumulative lines removed. v6.x: missing → "- --".
  m_linesRemoved: (c) => {
    const n = c.tokens?.cost.totalLinesRemoved;
    return n != null ? wrapPlainDefault("m_linesRemoved", `- ${n}`, undefined) : placeholderBare("m_linesRemoved", c);
  },
  // Session-cumulative input tokens (stdin.context_window.total_input_tokens).
  // v6.x: totals.input=null → "in:n/a" placeholder (was: drop).
  m_tokenInTotal: (c) =>
    c.tokens?.totals.input != null
      ? `${labelFor("in")}${formatCompactToken(c.tokens.totals.input)}`
      : placeholderBare("m_tokenInTotal", c),
  // Session-cumulative output tokens. v6.x: totals.output=null →
  // "out:n/a" placeholder. v0.8.0+ — renamed from `m_tokenOutTotal`
  // to `m_tokenTotalOut` so it sits in the `totalOut` family
  // alongside `m_accTokenOut` (in-memory acc) / `m_sumTokenOut`
  // (cross-project sum) / `totalOut` on-disk jsonl column. Source
  // unchanged: reads `tokens.totals.output` (= stdin
  // `context_window.total_output_tokens`) directly, distinct from
  // `m_accTokenOut`'s in-memory accumulator rollup.
  m_tokenTotalOut: (c) =>
    c.tokens?.totals.output != null
      ? `${labelFor("out")}${formatCompactToken(c.tokens.totals.output)}`
      : placeholderBare("m_tokenTotalOut", c),
  // v0.8.0+ — new module added to fix the v0.8.0 contract gap.
  // Source: same as m_tokenInTotal (stdin.context_window.
  // total_input_tokens); the distinguishing semantics is that
  // m_tokenTotalIn is in the total_input family alongside
  // m_accTokenTotalIn / m_sumTokenTotalIn, all sharing the
  // labelTotalIn label. The bare form below is identical to
  // m_tokenInTotal's data path; the two names exist so callers
  // can pick the family whose label matches their config.
  m_tokenTotalIn: (c) =>
    c.tokens?.totals.input != null
      ? `${labelFor("totalIn")}${formatCompactToken(c.tokens.totals.input)}`
      : placeholderBare("m_tokenTotalIn", c),
  // Project-wide count of valid API calls since first tick.
  // v6.x: missing cwd → "calls:n/a" placeholder (was: "calls:0").
  // Calls=0 still renders as "calls:0" — the v0.4.x always-render
  // design stays intact.
  m_apiCalls: (c) => {
    const cwd = c.tokens?.cwd;
    if (!cwd) return placeholderBare("m_apiCalls", c);
    // v0.8.x cwf-tickStatus-v2 — project-wide key is now
    // `tickStatus:<projectHash(cwd)>` (no prefix-less `tickStatus`).
    const v = statusStore.readTickStatus(cwd, `tickStatus:${projectHash(cwd)}`);
    if (!v) return wrapPlainDefault("m_apiCalls", "calls:0", undefined);
    return wrapPlainDefault("m_apiCalls", `calls:${v.accApiCount}`, undefined);
  },
  // v0.8.0+ — renamed from `m_contextSize`. The old name now lives
  // at `m_contextSize` with a different source (the cumulative
  // occupancy, see m_contextSize entry above). The new name holds
  // the capacity (upper bound) of the context window. Typo
  // `Widows` is preserved per user direction.
  //
  // Source: `context_window.context_window_size`. v6.x: size=null →
  // "size:n/a" placeholder.
  m_contextWindowsSize: (c) => {
    const sz = c.tokens?.contextWindow?.size;
    return sz != null ? wrapPlainDefault("m_contextWindowsSize", `size:${formatCompactToken(sz)}`, undefined) : placeholderBare("m_contextWindowsSize", c);
  },
  // v0.8.0+ — renamed from `m_contextUsed` (the `Percent` suffix
  // makes the unit explicit and matches m_tokenHitRate's % output
  // style). Source: `context_window.used_percentage`. v6.x:
  // usedPct=null → "n/a%" placeholder. Zero renders as "0%".
  m_contextUsedPercent: (c) => {
    const pct = c.tokens?.contextWindow?.usedPct;
    return pct != null ? wrapPlainDefault("m_contextUsedPercent", `used:${pct}%`, undefined) : placeholderBare("m_contextUsedPercent", c);
  },
  // v0.8.0+ — new per-turn module. Sibling of m_contextUsedPercent,
  // rendering the inverse: the unused share of the context window.
  // Source: `context_window.remaining_percentage`. Zero renders
  // as "0%"; null → "remain:n/a%" placeholder.
  m_contextRemainingPercent: (c) => {
    const pct = c.tokens?.contextWindow?.remainingPct;
    return pct != null ? wrapPlainDefault("m_contextRemainingPercent", `remain:${pct}%`, undefined) : placeholderBare("m_contextRemainingPercent", c);
  },
  // Context window bar + 5-band-colored percentage. v6.x: bare
  // form now follows the placeholder rule — when the synthetic
  // Window is missing, render the gray gauge placeholder. Zero
  // pct still renders as a 0-value bar (the user's "0 直接显示"
  // rule preserves the natural 0-value render path).
  m_windowContext: (c) =>
    c.contextWindow ? formatOneChunk(c.contextWindow, c.mode, cfg().bar.width, c.stale) : placeholderBare("m_windowContext", c),
};

// Cap unknown-module warnings to once per process so a template typo
// doesn't spam stderr on every statusline tick (which is every few
// seconds in active sessions). A one-shot warn is enough — the user
// will see it on the first invocation.
let _unknownModuleWarned = false;

// ----- v0.4.0+ token-module helpers -----

// Compact token formatter: <thresholds[0] → raw integer, <thresholds[1]
// → "<x.y>k", else "<x.y>M". Matches formatRemainingMs's tier shape
// but uses token-specific thresholds (default 1k / 1M). Negative or
// non-finite inputs fall back to "0". Exported so tests can pin the
// behavior at threshold boundaries.
export function formatCompactToken(n: number): string {
  if (!Number.isFinite(n) || n < 0) return "0";
  const t = cfg().tokenFormat;
  const [lo, hi] = t.thresholds;
  if (n < lo) return String(Math.floor(n));
  if (n < hi) return `${(n / 1_000).toFixed(t.precision)}k`;
  return `${(n / 1_000_000).toFixed(t.precision)}M`;
}

// Speed formatter: t/s with k suffix above 1000. Mirrors ccstatusline's
// formatSpeed. Null → "—". Exported for tests.
export function formatSpeed(tps: number | null): string {
  if (tps == null || !Number.isFinite(tps)) return "—";
  const precision = cfg().tokenFormat.speedPrecision;
  if (Math.abs(tps) >= 1000) {
    return `${(tps / 1000).toFixed(precision)}k t/s`;
  }
  return `${tps.toFixed(precision)} t/s`;
}

// v0.4.0+ — 5-band color picker for the speed scale.
// Faster = greener; slower = redder. Same color palette
// shape as the existing 5-band gauge modules
// (m_window5h/7d/context): bright green / dark green /
// yellow / orange / red, indexed from the FAST end.
//
// `in` uses 5× the `out` thresholds (per the user's spec:
// out: [10, 20, 40, 80], in: [50, 100, 200, 400]) — input
// streams naturally run hotter than output, so the bands
// are scaled accordingly. The thresholds are config-driven
// (cfg().tokenFormat.speedScaleBands) but the defaults match
// the user-requested bands. Returns an SGR string; the
// caller wraps the value with the RESET suffix.
export function speedScaleColor(
  direction: "in" | "out",
  tps: number,
): string {
  const c = cfg().colors;
  // Same 5-color palette the gauge modules use. Index 0 =
  // fastest (bright green); index 4 = slowest (red).
  const palette = [
    c.brightGreen, // brightest green — fastest
    c.darkGreen,
    c.yellow,
    c.orange,
    c.red,         // red — slowest
  ];
  const bands = direction === "in"
    ? cfg().tokenFormat.speedScaleBands.in
    : cfg().tokenFormat.speedScaleBands.out;
  // bands are sorted ascending; we want to pick the band
  // that the tps falls INTO from the FAST end. tps >= bands[3]
  // → fastest (palette[0]); tps < bands[0] → slowest
  // (palette[4]).
  if (tps >= bands[3]) return palette[0];
  if (tps >= bands[2]) return palette[1];
  if (tps >= bands[1]) return palette[2];
  if (tps >= bands[0]) return palette[3];
  return palette[4];
}

function cachePctPrecision(): number {
  return cfg().tokenFormat.cachePctPrecision;
}

// 3-band cache-hit color picker (good / warn / bad) using
// cacheHitColors + cacheHitThresholds from config. Exported for tests.
export function cacheHitColor(pct: number): string {
  const [lo, hi] = cfg().tokenFormat.cacheHitThresholds;
  const c = cfg().cacheHitColors;
  if (pct >= hi) return c.good;
  if (pct >= lo) return c.warn;
  return c.bad;
}

// Read samples for the (cwd, session) from the current snapshot,
// filter to the [now - windowMs, now] range, sum the delta between
// the FIRST and LAST sample in the window, and format as
// "<label>:<compact>". Returns null when:
//   - tokens/sessionId/cwd missing
//   - no samples in the window yet (fresh session)
//   - only one sample (can't compute a delta)
// The "first sample baseline + last sample now" approach matches how
// total_input_tokens / total_output_tokens are session-cumulative on
// stdin — delta = (cumulative at end of window) - (cumulative at start
// of window) = tokens used during the window.
//
// v6.x: total===0 (real zero in the window) now returns "label:0"
// instead of null. The user reads "0" as "tracked, nothing in the
// window" — distinct from the missing-data case (no samples) which
// goes through placeholderBare at the call site.
// v0.8.0+ — parse a human duration string into milliseconds.
// Supports "all" (returns the sentinel "all") and any chain of
// `<digits><unit>` where unit ∈ {d, h, m, s}. The chain is
// accumulated in canonical order (d → h → m → s) regardless of
// the input order, so "1m2h" and "2h1m" parse identically.
// Returns null on malformed input (no digits, bad unit, etc.).
//
// Examples:
//   parseDhms("5h")    → 5 * 3600 * 1000
//   parseDhms("7d")    → 7 * 86400 * 1000
//   parseDhms("1h30m") → 1*3600*1000 + 30*60*1000
//   parseDhms("2d12h") → 2*86400*1000 + 12*3600*1000
//   parseDhms("all")   → "all" (sentinel)
//   parseDhms("")      → null
//   parseDhms("5x")    → null
function parseDhms(raw: string | undefined): number | "all" | null {
  if (raw == null) return null;
  if (raw === "all") return "all";
  if (raw.length === 0) return null;
  // Match `<digits><unit>` pairs. The order doesn't matter — we
  // sum into a single accumulator and pick each unit's contribution
  // by its letter. Allows e.g. "5h30m" and "30m5h".
  const re = /(\d+)([dhms])/g;
  let ms = 0;
  let matched = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(raw)) !== null) {
    const n = Number(m[1]);
    const u = m[2];
    if (!Number.isFinite(n) || n <= 0) return null;
    switch (u) {
      case "d": ms += n * 86400 * 1000; break;
      case "h": ms += n * 3600 * 1000; break;
      case "m": ms += n * 60 * 1000; break;
      case "s": ms += n * 1000; break;
    }
    matched += m[0].length;
  }
  if (matched === 0) return null;
  // Trailing junk (e.g. "5hz") is a parse-fail. The whole string
  // must consist of digit/unit pairs.
  if (matched !== raw.length) return null;
  return ms;
}

// v0.8.x — resolve the effective (windowKey, sinceMs, alignActive,
// model) for a sum/avg scan.
//
//   windowKey   — discrete cache key segment. One of "5h" / "7d" /
//                 "all". Any other dhms input (e.g. "1d2h") is
//                 rejected at parse time so the cache key space
//                 stays bounded (≤ 12 entries: 2 model × 3 window ×
//                 2 align).
//   sinceMs     — wall-clock anchor. Samples with `at < sinceMs` are
//                 excluded. Derived from windowKey + ctx.nowMs +
//                 optionally resetStartAt.
//   alignActive — when true, sinceMs is resetStartAt (cover exactly
//                 one full window since the last refill); when
//                 false, sinceMs is nowMs-window (the trailing N ms
//                 of wall-clock). Forced false for window="all" or
//                 when resetStartAt is missing on the relevant Window.
//   modelFilter — undefined (all rows), "active" (current model), or
//                 a literal model name.
type SumFilter = {
  windowKey: "5h" | "7d" | "all";
  sinceMs: number;
  alignActive: boolean;
  modelFilter?: string;
};

function parseWindowScope(
  ctx: RenderContext,
  params: Record<string, ResolvedValue | undefined>,
): SumFilter | null {
  const windowRaw = (params.window as string | undefined) ?? "5h";
  // Normalize the raw window string into one of the three discrete
  // cache-key values. Any other dhms is rejected (drops the module).
  // The full parseDhms validation still runs so e.g. "5x" returns
  // null, and the standard warn-unknown-window path can fire.
  let windowKey: "5h" | "7d" | "all";
  if (windowRaw === "all") {
    windowKey = "all";
  } else if (windowRaw === "5h") {
    windowKey = "5h";
  } else if (windowRaw === "7d") {
    windowKey = "7d";
  } else {
    // Anything else (free-form dhms like "1d2h") is not allowed in
    // v0.8.x — refuse rather than minting a unique cache key.
    return null;
  }

  const alignRaw = (params.align as string | undefined) ?? "true";
  const alignWanted = alignRaw === "true";

  // Resolve model filter.
  const modelRaw = (params.model as string | undefined) ?? "active";
  let modelFilter: string | undefined;
  if (modelRaw === "all") {
    modelFilter = undefined;
  } else if (modelRaw === "active") {
    modelFilter = ctx.tokens?.modelDisplayName ?? undefined;
  } else {
    modelFilter = modelRaw;
  }

  if (windowKey === "all") {
    // No time anchor — align is meaningless. Scan from epoch.
    return { windowKey, sinceMs: 0, alignActive: false, modelFilter };
  }

  // Try to align to the plan window's resetStartAt if asked.
  const w: Window | null | undefined =
    windowKey === "5h"
      ? ctx.fiveHour
      : ctx.weekly;
  if (
    alignWanted &&
    w != null &&
    typeof w.resetStartAt === "number" &&
    typeof w.resetDurationMs === "number" &&
    w.resetDurationMs > 0
  ) {
    return {
      windowKey,
      sinceMs: w.resetStartAt,
      alignActive: true,
      modelFilter,
    };
  }
  const windowMs = windowKey === "5h" ? 5 * 3600_000 : 7 * 86400_000;
  return {
    windowKey,
    sinceMs: ctx.nowMs - windowMs,
    alignActive: false,
    modelFilter,
  };
}

// v0.8.x — sum/avg scanning core. The cache key is
// "stat:<model|"all">:<window>:<align>" with TTL=300s and value
// the StatAggregate dict below. ReadAllSamples is called with the
// resolved sinceMs and applies a mtime pre-filter to skip stale
// files before opening them.
type StatAggregate = {
  sumIn: number;
  sumOut: number;
  sumCached: number;
  sumTotalIn: number; // sumIn + sumCached
  sumApiMs: number;
  rows: number; // total rows scanned (incl. fallback apiMs=0 rows)
  calls: number; // v0.8.x — count of rows with apiMs > 0 (real API activity)
  lastAt: number; // max sample `at`; 0 when no rows
  generatedAt: number; // Date.now() at scan time; for diagnostics
};

function aggregateSamples(samples: TokenSample[]): StatAggregate {
  // v0.8.0+ — TokenSample field rename. The per-turn columns are
  // now `in` (was `ctx_in`), `cacheIn` (was `ctx_read`), and `apiMs`
  // (was `deltaApiMs`). The cumulative columns `totalIn` /
  // `totalOut` / `totalApiMs` are kept on the row for off-line audit
  // but NOT summed — they're monotonic session totals, so summing
  // them would produce meaningless numbers. m_sumTokenTotalIn
  // therefore derives from per-turn columns (sumIn + sumCached)
  // rather than from the cumulative totalIn field.
  let sumIn = 0, sumOut = 0, sumCached = 0, sumApiMs = 0, lastAt = 0, calls = 0;
  for (const s of samples) {
    sumIn += s.in;
    sumOut += s.out;
    sumCached += s.cacheIn;
    sumApiMs += s.apiMs ?? 0;
    if ((s.apiMs ?? 0) > 0) calls += 1;
    if (s.at > lastAt) lastAt = s.at;
  }
  return {
    sumIn,
    sumOut,
    sumCached,
    sumTotalIn: sumIn + sumCached,
    sumApiMs,
    rows: samples.length,
    calls,
    lastAt,
    generatedAt: Date.now(),
  };
}

function fetchSumAggregate(filter: SumFilter): StatAggregate {
  // Key is bound to the discrete filter triple (model, window, align)
  // — `sinceMs` is derived but NOT part of the key. That caps the
  // key space at 12 entries (2 model × 3 window × 2 align). Value is
  // the StatAggregate dict feeding all 8 sum/avg modules; on TTL
  // expiry we re-scan (no incremental reuse).
  const key = `stat:${filter.modelFilter ?? "all"}:${filter.windowKey}:${filter.alignActive}`;
  const cached = cache.get<StatAggregate>(key, 300_000);
  if (cached) return cached;
  // Cross-project scan (no cwd scoping); the inline-args
  // resolution never carries a cwd key, so we always go through
  // readAllSamples here. readAllSamples applies a mtime pre-filter
  // to skip stale files. Per-project reads are reserved for the
  // future "per-cwd window" use case.
  const samples = readAllSamples(filter.sinceMs);
  const filtered = filter.modelFilter === undefined
    ? samples
    : samples.filter((s) => s.model === filter.modelFilter);
  const agg = aggregateSamples(filtered);
  cache.set(key, agg, 300_000);
  return agg;
}


function warnUnknownModuleOnce(name: string): void {
  if (_unknownModuleWarned) return;
  _unknownModuleWarned = true;
  process.stderr.write(`topgauge-cc: unknown lineTemplate module '${name}'; ignoring\n`);
}

// Reset the once-per-process warn flag. Exported so tests can clear
// it between cases and observe the warning on demand.
export function __resetUnknownModuleWarnForTest(): void {
  _unknownModuleWarned = false;
}

// Expand a template into rendered lines. Each output element is one
// rendered line — separators and module pieces that contain "\n" are
// split into separate line segments. Empty segments are dropped so a
// trailing "\n" separator doesn't emit a blank line at the end.
//
// Modules that return null (or "") cause their immediately adjacent
// s_N tokens to be skipped too — see the comment on RenderContext for
// the reasoning. Empty segments from the splitting pass get the same
// treatment.
// ----- v0.3.3+ inline-args tokens -----
//
// Three token forms now take colon-delimited parameters:
//
//   s_<n>[:color|<c>]
//   m_label:<string>[:color|<c>]
//   m_modeLabel[:color|<c>]
//
// General grammar: <prefix>(:<param>:<value>)*. Even segment count is
// required after the prefix; odd counts drop the token. Every
// (param, value) pair must be in the prefix's registered schema;
// unknown params drop the token. The renderer for the prefix takes the
// resolved { param: value } object plus the render context and returns
// the chunk text (or null to drop).
//
// Future parameterized modules (m_model, …) plug in by adding an entry
// to both INLINE_SCHEMAS and INLINE_RENDERERS. The bare <prefix> form
// (no colon) still routes through MODULES as before — so existing
// templates using bare `m_modeLabel` / `s_0` keep working byte-for-byte.

// v6.x — additional named SGR constants for the per-module default
// colors below. These are 256-color SGR strings (not theme-driven),
// chosen to be visually distinguishable from each other AND from
// the 5-band palette so DEFAULT_COLORS entries read as "this module's
// natural tint" rather than blending with the threshold colors.
const NAMED_PALETTE: Record<string, string> = {
  cyan: "\x1b[38;5;51m",         // bright cyan
  blue: "\x1b[38;5;33m",         // mid blue
  magenta: "\x1b[38;5;201m",     // hot pink/magenta
  purple: "\x1b[38;5;141m",      // violet
  teal: "\x1b[38;5;80m",         // dim teal
  brown: "\x1b[38;5;130m",       // earth brown
  gray: "\x1b[38;5;245m",        // mid gray (different from stale's dark gray)
  lavender: "\x1b[38;5;183m",    // soft lavender
};

// v6.x — DEFAULT_COLORS maps each non-numeric m_* module to its
// hardcoded default tint. Numeric modules (5-band / speed-scale /
// gauge / cache-hit) keep their existing color logic and are NOT in
// this map. The dispatcher / INLINE_RENDERERS use this as a fallback
// when `params.color` is empty — so users always see SOME color on
// bare-form modules, and `|color|<c>` overrides as before.
const DEFAULT_COLORS: Record<string, string> = {
  // String-class identifiers / metadata
  m_session: NAMED_PALETTE.purple,
  m_model: NAMED_PALETTE.cyan,
  m_effort: NAMED_PALETTE.magenta,
  m_repo: NAMED_PALETTE.blue,
  m_branch: NAMED_PALETTE.teal,
  m_gitStatus: NAMED_PALETTE.brown,
  m_ccVersion: NAMED_PALETTE.gray,
  m_ccversion: NAMED_PALETTE.gray, // deprecated alias — same color
  m_age: NAMED_PALETTE.stale,      // (already STALE_COLOR-shaped)
  m_version: NAMED_PALETTE.gray,
  m_balance: NAMED_PALETTE.lavender,
  m_modeLabel: NAMED_PALETTE.stale,
  m_label: NAMED_PALETTE.cyan,
  // Duration / count class (numeric but NOT 5-band / scale)
  m_sessionDuration: NAMED_PALETTE.brown,
  m_sessionApiDuration: NAMED_PALETTE.brown,
  m_sumApiCalls: NAMED_PALETTE.cyan,
  // v0.8.0+ — per-turn delta of cost.totalApiDurationMs,
  // formatted as a dhms time string ("api:5s" / "api:1m30s").
  // Brown matches the existing time-format family; the "api:"
  // prefix is hardcoded (not part of the labels.* axis set).
  m_apiMs: NAMED_PALETTE.brown,
  m_linesAdded: "\x1b[1;38;5;22m",   // bold + dark green (muted git-style added)
  m_linesRemoved: "\x1b[1;38;5;88m", // bold + dim red (muted git-style removed)
  m_apiCalls: NAMED_PALETTE.cyan,
  m_countdown5h: NAMED_PALETTE.teal,
  m_countdown7d: NAMED_PALETTE.teal,
  m_contextSize: NAMED_PALETTE.gray,
  m_contextWindowsSize: NAMED_PALETTE.gray,
  m_contextUsedPercent: NAMED_PALETTE.gray,
  m_contextRemainingPercent: NAMED_PALETTE.gray,
  // v0.8.0+ — m_acc* family. Plain numeric accumulators get
  // STALE_COLOR (gray) so they read as "data" rather than
  // "status"; m_accTokenHitRate is governed by the band-based
  // cacheHitColor helper, so the DEFAULT_COLORS entry is moot
  // for the value but keeps the dispatcher / inline path happy.
  m_accTokenIn: NAMED_PALETTE.stale,
  m_accTokenOut: NAMED_PALETTE.stale,
  m_accTokenCachedIn: NAMED_PALETTE.stale,
  m_accTokenTotalIn: NAMED_PALETTE.stale,
  m_accApiMs: NAMED_PALETTE.stale,
  m_accApiCalls: NAMED_PALETTE.stale,
  m_accTokenHitRate: NAMED_PALETTE.stale,
};

// Snapshot of `cfg().colors` + the `brightBlack` input shortcut. Read
// once at module load so render hot paths don't touch configStore per
// call. Mirrors the pattern at lines 56-63.
const LABEL_COLOR_SHORTCUTS: Record<string, string> = (() => {
  const c = configStore.get().colors;
  return {
    brightGreen: c.brightGreen,
    darkGreen: c.darkGreen,
    yellow: c.yellow,
    orange: c.orange,
    red: c.red,
    stale: c.stale,
    brightBlack: "\x1b[90m",
    // v6.x — additional named shortcuts exposed via `:color|<name>`
    // (e.g. `:color|cyan` on a string module). Identical to the
    // entries in NAMED_PALETTE; duplicated here so resolveColor can
    // look them up without scanning NAMED_PALETTE separately.
    cyan: NAMED_PALETTE.cyan,
    blue: NAMED_PALETTE.blue,
    magenta: NAMED_PALETTE.magenta,
    purple: NAMED_PALETTE.purple,
    teal: NAMED_PALETTE.teal,
    brown: NAMED_PALETTE.brown,
    gray: NAMED_PALETTE.gray,
    lavender: NAMED_PALETTE.lavender,
  };
})();

// Pure resolver for `<colorvalue>`. Accepts shortcut names and raw
// SGR strings (`\x1b[…m`). Returns null on anything else so the
// caller can warn + soft-fallback to plain text.
//
// v0.3.5+: the SPECIAL shortcut set (rainbow / rand-rainbow / hue)
// is NOT returned by this resolver — those need per-text processing
// (buildRainbow / buildHue from src/quotes.ts), not a single SGR
// string. They're handled at a higher level by `applyColor` below.
// This resolver only validates shortcut-as-SGR and raw-SGR strings.
// v0.4.0+ — sentinel string returned by resolveColor when the
// user writes `:color|scale`. The speed-module renderers
// (m_tokenInSpeed / m_tokenOutSpeed, both bare default and
// inline) detect this token and replace it with the per-band
// scale color via speedScaleColor(). For all other modules
// the value behaves as opaque — they'd never see it because
// their schema doesn't accept a custom color palette, and
// resolving it to the literal string means a bug in the
// caller that swallows it just renders uncolored (the SGR
// would be invalid, but the chunk would still display).
export const SCALE_COLOR_SENTINEL = "__SCALE__";

function resolveColor(value: string): string | null {
  if (value === "scale") return SCALE_COLOR_SENTINEL;
  if (LABEL_COLOR_SHORTCUTS[value]) return LABEL_COLOR_SHORTCUTS[value];
  if (/^\x1b\[[0-9;]*m$/.test(value)) return value;
  return null;
}

// Tagged result for the higher-level `resolveColorParam` (used by
// m_quote and any other future module that wants the
// rainbow/hue shortcuts). Not exported via INLINE_SCHEMAS's
// `ParamResolver` return type (which is `ResolvedValue | null`,
// i.e. string | number | null) — the m_quote schema's `color`
// resolver does a string-tag instead, and the renderer recognizes
// the 3 magic strings as "apply buildRainbow / buildHue".
export type ColorParam =
  | { kind: "sgr"; value: string } // wrap text with `<sgr>…<RESET>`
  | { kind: "rainbow"; salt: number } // per-char SGR; salt offsets the rotation
  | { kind: "hue" } // single-hue wrap from buildHue
  | { kind: "none" };

// Resolve the full `<colorvalue>` namespace: shortcut names, raw
// SGR strings, plus the 3 special values. Returns a tagged result
// the renderer pattern-matches against. Same null-on-bad-value
// contract as `resolveColor` so the dispatcher can warn + drop.
export function resolveColorParam(value: string): ColorParam | null {
  if (value === "rainbow") return { kind: "rainbow", salt: 0 };
  if (value === "rand-rainbow") return { kind: "rainbow", salt: 1 };
  if (value === "hue") return { kind: "hue" };
  const sgr = resolveColor(value);
  if (sgr === null) return null;
  return { kind: "sgr", value: sgr };
}

// Apply a resolved ColorParam to a plain-text body. Used by
// m_quote (and any future module that opts into the full color
// grammar). Safe ONLY for plain-text bodies — colored bodies must
// use their override-aware helpers (e.g. formatOneChunkColored).
//
// The `seed` argument seeds rainbow / hue color generation so a
// caller can tie color choice to a frequency window (same window
// → same color). Callers that don't care about per-window color
// stability can pass 0.
export function applyColor(
  body: string,
  param: ColorParam,
  seed: number,
): string {
  if (body === "") return body;
  switch (param.kind) {
    case "sgr":
      return `${param.value}${body}${RESET}`;
    case "rainbow":
      return buildRainbow(body, seed + param.salt);
    case "hue":
      return buildHue(body, seed);
    case "none":
      return body;
  }
}

// Encode a ColorParam as a string so it round-trips through the
// generic `params.color: string` channel that INLINE_RENDERERS uses.
// The decoder is `paramFromString`. This keeps the existing
// ResolvedValue = string | number contract intact.
const COLOR_KIND_SGR = "\x00COLOR:sgr:";
const COLOR_KIND_RAINBOW = "\x00COLOR:rainbow:";
const COLOR_KIND_HUE = "\x00COLOR:hue:";

export function encodeColorParam(p: ColorParam): string {
  switch (p.kind) {
    case "sgr":
      return COLOR_KIND_SGR + p.value;
    case "rainbow":
      return COLOR_KIND_RAINBOW + String(p.salt);
    case "hue":
      return COLOR_KIND_HUE;
    case "none":
      return "";
  }
}

export function decodeColorParam(encoded: string | undefined): ColorParam {
  if (encoded === undefined || encoded === "") return { kind: "none" };
  if (encoded.startsWith(COLOR_KIND_SGR)) {
    return { kind: "sgr", value: encoded.slice(COLOR_KIND_SGR.length) };
  }
  if (encoded.startsWith(COLOR_KIND_RAINBOW)) {
    const salt = Number(encoded.slice(COLOR_KIND_RAINBOW.length));
    return { kind: "rainbow", salt: Number.isFinite(salt) ? salt : 0 };
  }
  if (encoded.startsWith(COLOR_KIND_HUE)) {
    return { kind: "hue" };
  }
  // Fallback: treat the string as a raw SGR. (Shouldn't happen
  // since the resolver validates, but defensive.)
  return { kind: "sgr", value: encoded };
}

type ResolvedValue = string | number;

type ParamResolver = (raw: string) => ResolvedValue | null;

// Sentinel: renderers return this to signal "args parsed fine but
// semantically invalid" (e.g. m_label with an empty string, s_<n>
// with an out-of-range index). The dispatcher warns once on this;
// a plain null is treated as "no data to show" (silent drop, same
// as the bare MODULES path).
const INLINE_BADARG = Symbol("inline-badarg");

type InlineRenderer = (
  params: Record<string, ResolvedValue>,
  ctx: RenderContext,
) => string | null | typeof INLINE_BADARG;

// Per-prefix inline schema. The first segment after the prefix is the
// value of the implicit param (`implicit`). Subsequent segments come in
// `name:value` pairs resolved against `named`. Future parameterized
// modules (m_model, …) plug in here.
type InlineSchema = {
  implicit?: { name: string; resolver: ParamResolver };
  named: Record<string, ParamResolver>;
};

// v0.3.3+: every existing module accepts an optional `|color|<c>`
// override via inline-args. The named param is `color` for all of
// them — same shortcut table and raw-SGR rules as `m_label`.
//
// For modules that emit plain text (no internal SGR), the override
// is a simple wrap. For modules that already apply a band-based /
// single-color SGR (m_window5h/7d, m_balance, m_tokenHitRate,
// m_cacheRead, m_age, m_tokenInSpeed, m_tokenOutSpeed), the override
// REPLACES the natural color choice — the user's `color` always wins.
// (Per spec: "如果与现有颜色方案冲突，则无视该参数" — interpreted as
// "if the user explicitly asked for a color, ignore the natural
// scheme in favor of theirs".)
const COLOR_PARAM = {
  named: {
    color: (raw: string) => resolveColor(raw),
  },
} as const;

// v0.4.0+ — per-module null-drop override. Accepts "true" or "false"
// verbatim; anything else is a parse-fail and the inline token is
// dropped (same as :color|<garbage>). Semantics:
//
//   nulldrop omitted / nulldrop:false  → DEFAULT. Force a stable
//     placeholder when the data is missing — the module ALWAYS
//     renders, regardless of whether the underlying field is null.
//     This keeps the line layout stable across ticks and matches
//     the user's expectation that an explicitly-listed module in
//     lineTemplate should occupy its slot.
//   nulldrop:true                      → opt out of the placeholder
//     and preserve the v0.3.x "drop on null" behavior. The module
//     disappears and adjacent separators are skipped.
//
// The bare MODULES path (no inline args) keeps the original drop
// semantics — bare `m_contextSize` (or any m_token* module) still
// drops on null. To get the placeholder behavior the user must
// use the inline form `m_contextSize` (which now defaults to
// placeholder — see above). This is a BREAKING change for any
// existing inline template that lists a module whose value is
// sometimes null (the slot is now always
// visible). Users who want the old drop behavior add
// `:nulldrop|true` to those tokens.
//
// Placeholder shape per module (see PLACEHOLDERS in render.ts
// for the dispatch):
//   pure-number modules        → STALE_COLOR wrap on "n/a" (e.g.
//                                "in:n/a", "ctx:n/a", "cache:n/a")
//   number+unit modules        → STALE_COLOR wrap on "-- <unit>"
//                                (e.g. "5h:--", "session:--", "+ --")
//   gauge modules              → STALE_COLOR wrap on
//                                "░░░░░░░░ 0%" (parallel to the
//                                natural 0-value render)
//   bare-string modules        → STALE_COLOR wrap on "n/a"
const NULDROP_PARAM = {
  named: {
    nulldrop: (raw: string): ResolvedValue | null =>
      raw === "true" || raw === "false" ? raw : null,
  },
} as const;

// v0.7.2+ — separator `repeat` parameter. Multiplies the rendered
// body N times so a single token can emit e.g. 3 spaces (`s_space|
// repeat|3` → `"   "`). Capped at 8 to keep a runaway config from
// blowing up the statusline width. Default 1 when omitted. Out-of-
// range (non-integer, < 1, or > 8) is a badarg → warn + drop.
const SEP_REPEAT_MAX = 8;
const REPEAT_PARAM = {
  named: {
    repeat: (raw: string): ResolvedValue | null => {
      if (!/^[0-9]+$/.test(raw)) return null;
      const n = Number(raw);
      if (!Number.isInteger(n) || n < 1 || n > SEP_REPEAT_MAX) return null;
      return raw;
    },
  },
} as const;

// v0.7.2+ — separator `wrap` parameter. Default `true`. When true,
// bodies that are NOT whitespace/control get padded with one
// space on each side (so `s_dot|wrap|true` renders ` · ` instead
// of just `·`). Bodies that are pure whitespace/control
// (`s_space`, `s_tab`, `s_newline`, and any array entry that's
// a single ASCII whitespace or NUL/STP/etc.) are returned
// as-is regardless — wrapping would either create multi-space
// runs (with `s_space`) or push the next module onto a new line
// twice (`s_newline`).
const WRAP_PARAM = {
  named: {
    wrap: (raw: string): ResolvedValue | null =>
      raw === "true" || raw === "false" ? raw : null,
  },
} as const;

// Classify a separator body as "whitespace/control" (no padding
// even under wrap=true) or "printable" (pad with 1 space on each
// side). Pure: only inspects the body's own characters. Used by
// the s_ renderer's wrap step.
function isControlBody(body: string): boolean {
  if (body === "") return true;
  for (let i = 0; i < body.length; i++) {
    const code = body.charCodeAt(i);
    // ASCII whitespace (tab=9, LF=10, CR=13, space=32, VT=11, FF=12)
    // and any C0 control char (< 32) or DEL (127) is "control" for
    // wrap purposes. Anything else (regular printable, multi-byte
    // UTF-8 like `·`, anything else) is "printable" and pads.
    if (code < 33) return true;
    if (code === 127) return true;
  }
  return false;
}

// Pure: format a separator body with the parsed repeat count and
// the wrap flag. Repeat=0 is rejected upstream by the resolver
// (returns null), so this layer can assume n >= 1. wrap=true
// + non-control body pads with 1 space on each side; wrap=false
// returns body as-is.
function formatSepBody(body: string, repeat: string, wrap: string): string {
  const n = Number(repeat);
  const inner = wrap === "true" && !isControlBody(body)
    ? ` ${body} `
    : body;
  let out = "";
  for (let i = 0; i < n; i++) out += inner;
  return out;
}

// v0.8.0+ — four-layer accumulator scope selector (used by
// m_acc*). Accepts "ccsession" (default), "session", "project",
// or "model". Anything else is a parse-fail and the inline token
// is dropped (same as :color|<garbage>). The model scope is a
// no-op when the
// live TokenSnapshot has no modelDisplayName (the placeholder
// path fires); project scope reads the project-wide slot, which
// is null until at least one tick has accumulated into it.
const SCOPE_PARAM = {
  named: {
    // v0.8.x cwf-tickStatus-v2 — added "ccsession" scope to
    // m_acc*:scope:|...| (per-claude-code-process singleton).
    scope: (raw: string): ResolvedValue | null =>
      raw === "session" || raw === "project" || raw === "model" || raw === "ccsession" ? raw : null,
  },
} as const;

// v0.8.0+ — sum/avg module inline args.
//
// `:model|<active|name|all>` — narrow the jsonl scan to one model
//   identity, "active" (the model currently displayed in m_model),
//   or "all" (every row). Default is "active". The literal "all"
//   skips per-row model filtering entirely.
//
// `:window|<dhms|all>` — the time window to scan. Accepts any
//   `<digits><unit>` chain parseable by parseDhms (e.g. "5h",
//   "7d", "1h30m", "2d12h"), plus the special "all" sentinel
//   (no time filter, scan the entire jsonl). Default is "5h".
//
// `:align|<true|false>` — when true AND window ∈ {5h, 7d} AND
//   ctx.fiveHour/weekly has resetStartAt+resetDurationMs, use the
//   plan-aligned window [resetStartAt, resetStartAt + duration]
//   instead of the wall-clock [now - windowMs, now]. The
//   tokenplan "5h since 14:00" anchor matters here — without
//   align, the wall-clock window can read N% under 100% even at
//   full quota because we miss the recent refill. Default true.
const MODEL_PARAM = {
  named: {
    model: (raw: string): ResolvedValue | null =>
      raw === "active" || raw === "all" || raw.length > 0 ? raw : null,
  },
} as const;

const WINDOW_PARAM = {
  named: {
    window: (raw: string): ResolvedValue | null =>
      parseDhms(raw) !== null ? raw : null,
  },
} as const;

const ALIGN_PARAM = {
  named: {
    align: (raw: string): ResolvedValue | null =>
      raw === "true" || raw === "false" ? raw : null,
  },
} as const;

// v0.4.0+ — per-module display-mode override (scoped to the bar
// computation for the window modules). Accepts "used" or
// "remaining" verbatim; anything else is a parse-fail and the
// inline token is dropped (same as :color|<garbage>). Resolution is
// deliberately narrow — the module-level `display` config field
// (RESOLVED via resolveDisplayMode) stays the default for the bare
// `m_window5h` form. Inline display wins when present, so users can
// e.g. show 5h as "remaining" while the global config is "used".
const DISPLAY_PARAM = {
  named: {
    display: (raw: string): ResolvedValue | null =>
      raw === "used" || raw === "remaining" ? raw : null,
  },
} as const;

// ----- v0.4.0+ placeholder shapes for nulldrop:false -----------------------
//
// Each constant is a closure over the inline-args params + ctx so the
// INLINE_RENDERERS can pull a precomputed placeholder body. Every
// placeholder wraps its body in `${STALE_COLOR}…${RESET}` so a missing
// gauge / number reads as "dim gray, no data" — visually distinct
// from a real value (which is colored by the band palette or wrapped
// in the user's :color| override). The :color| inline override still
// wins when present (it REPLACES the placeholder's STALE_COLOR wrap,
// matching the existing "user override always wins" rule).

// pure-number placeholder body: "<prefix>n/a" — PLAIN text. The
// STALE_COLOR wrap is applied by the INLINE_RENDERER (via
// wrapPlain / formatOneChunkColored) so a `|color|<c>` inline
// override REPLACES the default STALE_COLOR, matching the
// existing "user color always wins" rule for every other module.
// The prefix matches the module's normal inline label (e.g.
// "ctx:", "in:", "out:", "cache:") so a nulldrop placeholder reads
// like the same module just with "n/a" instead of a real number.
// Bare-string modules pass prefix="" (e.g. m_session → just "n/a").
function placeholderNA(
  prefix: string,
): (_params: Record<string, ResolvedValue>, _ctx: RenderContext) => string {
  return (_p, _c) => `${prefix}n/a`;
}

// number+unit placeholder body: PLAIN text. The STALE_COLOR wrap
// is applied by the INLINE_RENDERER (via wrapPlain) for the same
// reason as placeholderNA. The `body` is the COMPLETE placeholder
// text the module would otherwise emit (e.g. "5h:--", "+ --",
// "-- t/s"). Bare-number modules pass body="--" with no suffix
// (e.g. m_sessionDuration → "--", matching the existing
// formatRemainingMs shape).
function placeholderDashesUnit(
  body: string,
): (_params: Record<string, ResolvedValue>, _ctx: RenderContext) => string {
  return (_p, _c) => body;
}

// gauge placeholder body: returns PLAIN text (no SGR). The
// INLINE_RENDERER handles the SGR wrap via wrapPlain (so a
// `|color|<c>` override can REPLACE the default STALE_COLOR just
// like every other module). The placeholder shape is a 0-value
// bar — "used" mode shows an empty bar with "0%"; "remaining"
// mode shows a full bar with "100%". The synthetic pct=0 keeps
// the bar geometry aligned with the natural 0-value render path
// (see render-tokens.test.ts: "m_windowContext: usedPct=0").
function placeholderGauge(
  params: Record<string, ResolvedValue>,
  ctx: RenderContext,
): string {
  const mode = (params.display as DisplayMode | undefined) ?? ctx.mode;
  const empty = cfg().bar.empty;
  const filled = cfg().bar.filled;
  const width = cfg().bar.width;
  if (mode === "used") {
    return `${empty.repeat(width)} 0%`;
  }
  // mode === "remaining": full filled bar, "100%".
  return `${filled.repeat(width)} 100%`;
}

// Module → placeholder dispatcher. Each module opts into ONE of
// the four shape families by listing its `placeholder` body. The
// INLINE_RENDERER consults this table when the data path returns
// null/empty AND params.nulldrop === "false".
//
// Add a module here ONLY if its bare-module null case is currently
// a `return null`. The four families cover every existing drop
// case: pure-number ("n/a"), number+unit ("-- <unit>"), gauge
// ("gray bar + 0%"), bare-string ("n/a").
//
// v0.8.0+: placeholderNA / placeholderDashesUnit factories take
// the prefix (or body) as a string OR as a function. The function
// form is used for the four `labels.*` axes (in / out / cacheIn /
// totalIn) so the placeholder reflects the user's configured
// label rather than the hardcoded literal. The function is
// invoked at placeholder-fire time, reading configStore.get()
// at the same moment the renderer did.
type PlaceholderBody = (
  params: Record<string, ResolvedValue>,
  ctx: RenderContext,
) => string;

// Label-aware NA placeholder: receives the LabelAxis enum (always
// one of the four label axes). The body defers label resolution
// until placeholder-fire time so any subsequent config override
// is picked up. Defaults reproduce the v0.7.x literal-string
// behavior exactly because cfg().labels.labelIn === "in:" etc.
function placeholderLabelOr(axis: LabelAxis): PlaceholderBody {
  return (_p, _c) => `${labelFor(axis)}n/a`;
}

const PLACEHOLDERS: Record<string, PlaceholderBody> = {
  // pure-number — placeholder shape is "<prefix>n/a"
  m_tokenInTotal: placeholderLabelOr("in"),
  m_tokenTotalOut: placeholderLabelOr("out"),
  m_apiCalls: placeholderNA("calls:"),
  // v0.8.x cwf-tickStatus-v2 — m_totalToken* / m_totalTokenWithCacheIn
  // REMOVED. Use the m_acc* family with scope=ccsession (default).
  // m_acc* — v0.8.0+ labels.*: the four token-axis acc modules
  // (m_accTokenIn/Out/CachedIn/TotalIn) share their prefix with
  // the per-turn siblings via labelFor. m_accApiMs keeps its
  // hardcoded "api:" prefix (mirrors m_apiMs). m_accTokenHitRate
  // (v0.8.x R8) now also mirrors its per-turn sibling — "hit:"
  // prefix, matching m_tokenHitRate / m_sumTokenHitRate. The
  // :scope: inline arg is ignored at the placeholder level
  // (placeholderNA returns the same body regardless of scope —
  // see placeholderAcc comment for the future-extension hook).
  m_accTokenIn: placeholderLabelOr("in"),
  m_accTokenOut: placeholderLabelOr("out"),
  m_accTokenCachedIn: placeholderLabelOr("cacheIn"),
  m_accTokenTotalIn: placeholderLabelOr("totalIn"),
  m_accApiMs: placeholderNA("api:"),
  m_accApiCalls: placeholderNA("calls:"),
  // v0.8.x R8 — m_accTokenHitRate now mirrors m_tokenHitRate's
  // "hit:" prefix (was "acc:"). The placeholder is therefore
  // "hit:n/a%" — same body as the per-turn sibling, so users
  // composing `m_tokenHitRate m_accTokenHitRate m_sumTokenHitRate`
  // see a consistent prefix across the triple. The "hit:N%" shape
  // needs a "%" suffix on the placeholder too, matching
  // m_tokenHitRate's placeholderDashesUnit convention.
  m_accTokenHitRate: placeholderDashesUnit("hit:n/a%"),
  m_tokenCachedIn: placeholderLabelOr("cacheIn"),
  m_tokenHitRate: placeholderNA("hit:"),
  m_contextSize: placeholderNA("size:"),
  m_contextWindowsSize: placeholderNA("size:"),
  // m_contextUsedPercent's natural shape is "${pct}%" — the
  // placeholder preserves the unit suffix so users see "used:n/a%"
  // rather than bare "n/a" when usedPct is null.
  m_contextUsedPercent: placeholderDashesUnit("used:n/a%"),
  m_contextRemainingPercent: placeholderDashesUnit("remain:n/a%"),
  // number+unit — placeholder shape is the module's normal body
  // with "--" swapped in for the numeric value (e.g. "5h:--",
  // "+ --", "-- t/s"). Empty body = bare dash.
  m_sessionDuration: placeholderDashesUnit("--"),
  m_sessionApiDuration: placeholderDashesUnit("--"),
  // v0.8.0+ — per-turn API-ms delta placeholder. Shape preserves
  // the "api:" prefix + dashes-unit ("--") so the rendered body
  // matches the live output ("api:5s" / "api:--"). Note the dash
  // count stays at "--" (not "5s:--") because the dhms slot
  // collapses to a single segment when value is absent — there's
  // no "5h 30m" structure to mirror at placeholder time.
  m_apiMs: placeholderDashesUnit("api:--"),
  m_linesAdded: placeholderDashesUnit("+ --"),
  m_linesRemoved: placeholderDashesUnit("- --"),
  // v0.8.0+ — sum/avg advanced statistics placeholders. Same shape
  // as the rendered output: "in:n/a" / "out:n/a" / "cache:n/a" /
  // "api:n/a" for the 5 plain modules; "hit:n/a%" for the ratio.
  // Empty aggregate (no rows in window) triggers the placeholder.
  m_sumTokenIn: placeholderLabelOr("in"),
  m_sumTokenOut: placeholderLabelOr("out"),
  m_sumTokenCachedIn: placeholderLabelOr("cacheIn"),
  m_sumTokenTotalIn: placeholderLabelOr("totalIn"),
  m_sumApiMs: placeholderNA("api:"),
  m_sumTokenHitRate: placeholderNA("hit:"),
  m_sumTokenInSpeed: placeholderLabelOr("in"),
  m_sumTokenOutSpeed: placeholderLabelOr("out"),
  m_sumApiCalls: placeholderNA("calls:"),
  // v0.8.0+ — newly added m_tokenTotalIn (session-cumulative
  // total_input_tokens). Shares the labelTotalIn axis with its
  // sum/avg siblings.
  m_tokenTotalIn: placeholderLabelOr("totalIn"),
  // gauge (placeholder shape is the gray 0% / 100% bar)
  m_window5h: placeholderGauge,
  m_window7d: placeholderGauge,
  m_windowContext: placeholderGauge,
  // bare-string (no prefix to recover from; just "n/a")
  m_session: placeholderNA(""),
  m_model: placeholderNA(""),
  m_effort: placeholderNA(""),
  m_repo: placeholderNA(""),
  m_branch: placeholderNA("branch:"),
  m_gitStatus: placeholderNA("git:"),
  m_ccVersion: placeholderNA(""),
  m_ccversion: placeholderNA(""),
  // v6.x: per-API-call token modules. Previously these had no
  // placeholder registration — bare forms dropped on null and the
  // inline path produced "in:-- t/s" / "in:--" sentinels. New
  // rule (per user direction): null → "n/a"; idle tick (delta=0)
  // → "in:0" / "out:0" / "in:0.0 t/s"; 0 is always rendered, never
  // hidden. The bare MODULES paths now route through these
  // placeholders instead of returning null so layout stays stable.
  m_tokenIn: placeholderLabelOr("in"),
  m_tokenOut: placeholderLabelOr("out"),
  m_tokenInSpeed: placeholderLabelOr("in"),
  m_tokenOutSpeed: placeholderLabelOr("out"),
  // v6.x: previously drop-by-design modules (no age info / no
  // version / no reset data / no balance). Now also follow the
  // placeholder rule — they occupy their slot so adjacent
  // separators don't shift. :nulldrop|true remains the opt-out.
  m_age: placeholderNA("age:"),
  m_version: placeholderNA("v:"),
  m_countdown5h: placeholderDashesUnit("5h:--"),
  m_countdown7d: placeholderDashesUnit("7d:--"),
  m_balance: placeholderNA("balance:"),
};

// Render a placeholder body unless the user has explicitly opted
// out via `:nulldrop|true`, OR the module has no registered
// placeholder shape. The default is FORCED placeholder (every
// inline-listed module keeps its slot even when data is null).
// Returns null when the user opted out, so the caller's drop path
// takes over (matching the bare MODULES drop behavior).
//
// The returned string is PLAIN text (no SGR); the caller is
// expected to wrap it in the user's chosen color (defaults to
// STALE_COLOR via placeholderWithColor), matching the existing
// "override wins" pattern for every other inline module.
function placeholderOrNull(
  modKey: string,
  params: Record<string, ResolvedValue>,
  _ctx: RenderContext,
): string | null {
  if (params.nulldrop === "true") return null;
  const body = PLACEHOLDERS[modKey];
  if (!body) return null;
  return body(params, _ctx);
}

// Render a placeholder (when active) wrapped in the user's
// `|color|<c>` override, or STALE_COLOR by default. Returns null
// when the user opted out of the placeholder (`nulldrop:true`)
// OR the module has no registered placeholder shape — the caller's
// null-fall-through path takes over (drop, same as bare MODULES
// behavior).
//
// The STALE_COLOR default is what makes a missing-data placeholder
// visually distinct from a real value (a real `ctx:163.5k` is
// band-colored; a placeholder `ctx:n/a` is gray). Note: this is
// the OPPOSITE of wrapPlain (which returns plain text when no
// color is supplied) — placeholder rendering ALWAYS wraps, even
// without an override.
function placeholderWithColor(
  modKey: string,
  params: Record<string, ResolvedValue>,
  ctx: RenderContext,
): string | null {
  const body = placeholderOrNull(modKey, params, ctx);
  if (body == null) return null;
  const color = (params.color as string | undefined) ?? STALE_COLOR;
  return `${color}${body}${RESET}`;
}

// v6.x — bare-path variant of placeholderWithColor. Used by MODULES
// (the bare form, no inline-args) so a module's null case renders
// its PLACEHOLDERS body wrapped in STALE_COLOR, matching the inline
// default. Returns null when the module has no registered shape
// (preserves the legacy drop-by-design behavior — but as of v6.x,
// every module in MODULES has either a placeholder or a different
// always-render strategy, so this null return is only a defensive
// fallback). Color override is not supported on the bare path
// (mod.color is a no-op for bare tokens; the inline path remains
// the only way to customize placeholder color).
//
// `ctx` is required because placeholderGauge reads ctx.mode to
// pick between the used ("░...░ 0%") and remaining ("▓...▓ 100%")
// gauge placeholder shapes. Pure-NA and dashes-unit bodies ignore
// ctx, so passing the real render context is safe and uniform.
function placeholderBare(modKey: string, ctx: RenderContext): string | null {
  const body = PLACEHOLDERS[modKey];
  if (!body) return null;
  return `${STALE_COLOR}${body({}, ctx)}${RESET}`;
}

// Extended-color schema used by `m_quote`. Accepts the standard
// 7 shortcuts + raw SGR + the 3 special shortcuts (rainbow /
// rand-rainbow / hue). The resolver encodes the tagged ColorParam
// as a string (using NUL-prefix sentinels in `encodeColorParam`)
// so it round-trips through the generic INLINE_SCHEMAS contract
// (`params.color: string | undefined`). The m_quote renderer
// decodes via `decodeColorParam`.
const QUOTE_COLOR_PARAM = {
  named: {
    color: (raw: string) => {
      const p = resolveColorParam(raw);
      if (p === null) return null;
      return encodeColorParam(p);
    },
  },
} as const;

const QUOTE_FREQ_PARAM = {
  named: {
    freq: (raw: string) => {
      // Shape-validate the single-unit time format up front so a
      // clearly-wrong token (e.g. "yearly", "2h10m", "5x") is
      // rejected before reaching the renderer. The renderer then
      // calls parseFreq() to extract the bucket size. We pass the
      // raw string through (rather than the parsed QuoteFreq
      // object) so the ResolvedValue = string | number channel
      // doesn't need a sentinel round-trip.
      if (raw === "") return null;
      // Bare unit letter → valid shorthand.
      if (raw === "d" || raw === "h" || raw === "m" || raw === "s") return raw;
      // Numeric form: <digits><unit>. Reject multi-unit, unknown
      // units, leading zeros, and empty digit runs here so the
      // renderer's parseFreq() never sees malformed input.
      if (raw.length < 2) return null;
      const unit = raw[raw.length - 1];
      if (unit !== "d" && unit !== "h" && unit !== "m" && unit !== "s") return null;
      const digits = raw.slice(0, -1);
      if (digits === "") return null;
      if (!/^[0-9]+$/.test(digits)) return null;
      if (digits.length > 1 && digits[0] === "0") return null;
      return raw;
    },
  },
} as const;

// v0.4.x — named separator aliases. Each `s_<name>` token is a
// built-in alias for a specific character; it renders the literal
// value regardless of `cfg().separators` contents. This lets users
// write self-documenting templates (e.g. `["m_window5h", "s_space",
// "m_countdown5h"]`) without having to remember the array's
// default order. Users who want CUSTOM separators still set
// `separators: [...]` and reference them via `s_<n>`. The two
// forms are independent: `s_space` always renders " " even if the
// user explicitly puts "x" at array index 0; `s_0` always
// resolves to whatever is at array index 0, even if that happens
// to be " ".
//
// Encoding note: ResolvedValue is a `string | number` union, so
// we can't pass a { kind, ... } object through the inline-schema
// machinery. Named forms are encoded as a tagged string
// ("alias:space", "alias:dot", …) and numeric forms stay as a
// plain number. The s_ renderer and the bare-form fast path
// both decode this.
// v0.7.1+ — `pipe` joins the alias table. Mirrors the new inline-args
// separator (see parseInlineArgs). Pure render output, NOT the
// inline-args delimiter itself.
const NAMED_SEPARATORS: ReadonlyMap<string, string> = new Map([
  ["space",   " "],
  ["dot",     "·"],
  ["newline", "\n"],
  ["tab",     "\t"],
  ["colon",   ":"],
  ["pipe",    "|"],
]);

const SEP_ALIAS_PREFIX = "alias:";

function resolveSepRef(raw: string): string | number | null {
  // Named alias wins (checked first) so users who happen to have
  // `separators: ["space", ...]` and write `s_space` get the
  // built-in literal, not array[0]. This is the only consistent
  // rule: the named form ALWAYS renders the built-in character.
  const alias = NAMED_SEPARATORS.get(raw);
  if (alias !== undefined) return SEP_ALIAS_PREFIX + raw;
  // Numeric form: only match all-digit suffixes (rejects "0a",
  // "1.0", "12 ", etc.). Out-of-range check happens at the
  // renderer / bare-form site, not here, because the resolver
  // doesn't know the array length.
  if (/^[0-9]+$/.test(raw)) {
    const n = Number(raw);
    if (Number.isInteger(n) && n >= 0) return n;
  }
  return null;
}

// Decode the value of `params.index` (set by resolveSepRef) into
// the literal separator body. Returns INLINE_BADARG for an
// out-of-range numeric index (the dispatcher warns + drops).
function resolveSepBody(index: string | number): string | typeof INLINE_BADARG {
  if (typeof index === "string" && index.startsWith(SEP_ALIAS_PREFIX)) {
    const name = index.slice(SEP_ALIAS_PREFIX.length);
    return NAMED_SEPARATORS.get(name) ?? INLINE_BADARG;
  }
  const seps = cfg().separators;
  const sep = seps[index as number];
  if (sep === undefined) return INLINE_BADARG;
  return sep;
}

const INLINE_SCHEMAS: Record<string, InlineSchema> = {
  s_: {
    // v0.4.x — the implicit param of an `s_…` token accepts BOTH
    // a numeric index (`s_0`, `s_1`, …, looked up in
    // cfg().separators[i]) and a named alias (`s_space`, `s_dot`,
    // `s_newline`, `s_tab`, `s_colon`, `s_pipe`, resolved to a
    // built-in literal character independent of the array).
    // Unknown numeric or non-numeric suffixes return null → the
    // caller warns + drops the token.
    //
    // v0.7.2+ — added `|repeat|<1..8>` and `|wrap|<true|false>`
    // named params for inline separators. repeat multiplies the
    // body (1 default, max 8 — see REPEAT_PARAM). wrap=true pads
    // printable bodies with 1 space on each side so e.g.
    // `s_dot|wrap|true` renders " · " instead of "·"; whitespace
    // bodies (`s_space`, `s_tab`, `s_newline`, and any array entry
    // matching isControlBody) skip the padding. See
    // [[repeat-and-wrap-on-separator]].
    implicit: {
      name: "index",
      resolver: resolveSepRef,
    },
    named: {
      ...COLOR_PARAM.named,
      ...NULDROP_PARAM.named,
      ...REPEAT_PARAM.named,
      ...WRAP_PARAM.named,
    },
  },
  m_label: {
    implicit: { name: "string", resolver: (raw) => raw },
    named: { ...COLOR_PARAM.named, ...NULDROP_PARAM.named },
  },
  m_modeLabel: {
    // No implicit — the string is derived from ctx. The first segment,
    // if present, MUST be a name in `named` (i.e. starts a name:value
    // pair). Otherwise the token is malformed.
    named: { ...COLOR_PARAM.named, ...NULDROP_PARAM.named },
  },
  // v0.3.3+ — every existing module also accepts an optional :color|
  // override. Schema is empty (`{}`) when the module takes no implicit
  // param; the renderer just reads params.color and applies it.
  m_window5h: { named: { ...COLOR_PARAM.named, ...DISPLAY_PARAM.named, ...NULDROP_PARAM.named } },
  m_window7d: { named: { ...COLOR_PARAM.named, ...DISPLAY_PARAM.named, ...NULDROP_PARAM.named } },
  m_countdown5h: { named: { ...COLOR_PARAM.named, ...NULDROP_PARAM.named } },
  m_countdown7d: { named: { ...COLOR_PARAM.named, ...NULDROP_PARAM.named } },
  m_balance: { named: { ...COLOR_PARAM.named, ...NULDROP_PARAM.named } },
  m_age: { named: { ...COLOR_PARAM.named, ...NULDROP_PARAM.named } },
  m_version: { named: { ...COLOR_PARAM.named, ...NULDROP_PARAM.named } },
  m_tokenIn: { named: { ...COLOR_PARAM.named, ...NULDROP_PARAM.named } },
  m_tokenOut: { named: { ...COLOR_PARAM.named, ...NULDROP_PARAM.named } },
  m_tokenTotal: { named: { ...COLOR_PARAM.named, ...NULDROP_PARAM.named } },
  m_tokenSession: { named: { ...COLOR_PARAM.named, ...NULDROP_PARAM.named } },
  m_contextSize: { named: { ...COLOR_PARAM.named, ...NULDROP_PARAM.named } },
  m_tokenHitRate: { named: { ...COLOR_PARAM.named, ...NULDROP_PARAM.named } },
  m_tokenCachedIn: { named: { ...COLOR_PARAM.named, ...NULDROP_PARAM.named } },
  m_tokenInSpeed: { named: { ...COLOR_PARAM.named, ...NULDROP_PARAM.named } },
  m_tokenOutSpeed: { named: { ...COLOR_PARAM.named, ...NULDROP_PARAM.named } },
  // v0.8.x cwf-tickStatus-v2 — m_totalToken* / m_totalTokenWithCacheIn
  // REMOVED. The m_acc* family replaces them.
  // v0.8.0+ — m_acc* family accepts :scope:<ccsession|session|project|model>
  // (default ccsession for the bare form) and the standard :color|
  // override + :nulldrop| opt-out.
  m_accTokenIn: { named: { ...COLOR_PARAM.named, ...NULDROP_PARAM.named, ...SCOPE_PARAM.named } },
  m_accTokenOut: { named: { ...COLOR_PARAM.named, ...NULDROP_PARAM.named, ...SCOPE_PARAM.named } },
  m_accTokenCachedIn: { named: { ...COLOR_PARAM.named, ...NULDROP_PARAM.named, ...SCOPE_PARAM.named } },
  m_accTokenTotalIn: { named: { ...COLOR_PARAM.named, ...NULDROP_PARAM.named, ...SCOPE_PARAM.named } },
  m_accApiMs: { named: { ...COLOR_PARAM.named, ...NULDROP_PARAM.named, ...SCOPE_PARAM.named } },
  m_accApiCalls: { named: { ...COLOR_PARAM.named, ...NULDROP_PARAM.named, ...SCOPE_PARAM.named } },
  m_accTokenHitRate: { named: { ...COLOR_PARAM.named, ...NULDROP_PARAM.named, ...SCOPE_PARAM.named } },
  // v0.8.0+ — sum/avg advanced statistics. All 8 accept the same
  // 5 inline args: :model|<active|name|all>, :window|<dhms|all>,
  // :align|<true|false>, :color|<c>, :nulldrop|<b>. The WINDOW
  // resolver rejects malformed dhms strings at parse time →
  // badarg → dispatcher warn + drop. Same for the MODEL/ALIGN
  // schemas.
  m_sumTokenIn: { named: { ...COLOR_PARAM.named, ...NULDROP_PARAM.named, ...MODEL_PARAM.named, ...WINDOW_PARAM.named, ...ALIGN_PARAM.named } },
  m_sumTokenOut: { named: { ...COLOR_PARAM.named, ...NULDROP_PARAM.named, ...MODEL_PARAM.named, ...WINDOW_PARAM.named, ...ALIGN_PARAM.named } },
  m_sumTokenCachedIn: { named: { ...COLOR_PARAM.named, ...NULDROP_PARAM.named, ...MODEL_PARAM.named, ...WINDOW_PARAM.named, ...ALIGN_PARAM.named } },
  m_sumTokenTotalIn: { named: { ...COLOR_PARAM.named, ...NULDROP_PARAM.named, ...MODEL_PARAM.named, ...WINDOW_PARAM.named, ...ALIGN_PARAM.named } },
  m_sumApiMs: { named: { ...COLOR_PARAM.named, ...NULDROP_PARAM.named, ...MODEL_PARAM.named, ...WINDOW_PARAM.named, ...ALIGN_PARAM.named } },
  m_sumTokenHitRate: { named: { ...COLOR_PARAM.named, ...NULDROP_PARAM.named, ...MODEL_PARAM.named, ...WINDOW_PARAM.named, ...ALIGN_PARAM.named } },
  m_sumTokenInSpeed: { named: { ...COLOR_PARAM.named, ...NULDROP_PARAM.named, ...MODEL_PARAM.named, ...WINDOW_PARAM.named, ...ALIGN_PARAM.named } },
  m_sumTokenOutSpeed: { named: { ...COLOR_PARAM.named, ...NULDROP_PARAM.named, ...MODEL_PARAM.named, ...WINDOW_PARAM.named, ...ALIGN_PARAM.named } },
  m_sumApiCalls: { named: { ...COLOR_PARAM.named, ...NULDROP_PARAM.named, ...MODEL_PARAM.named, ...WINDOW_PARAM.named, ...ALIGN_PARAM.named } },
  // v0.3.6+ — quote module. Accepts `:freq|<numeric-time>` and
  // `:color|<sgr|shortcut|rainbow|rand-rainbow|hue>`. The freq
  // grammar is the single-unit time format `<digits><unit>` (bare
  // unit letter = 1<unit>) — see QUOTE_FREQ_PARAM. Default freq
  // (`h` = 1h) is applied at the RENDERER level when params.freq
  // is undefined.
  m_quote: {
    named: {
      ...QUOTE_FREQ_PARAM.named,
      ...QUOTE_COLOR_PARAM.named,
      ...NULDROP_PARAM.named,
    },
  },
  // v0.4.0+ — session-info / metadata modules. All take only the
  // optional :color| override (mirror the m_token* pattern).
  m_session: { named: { ...COLOR_PARAM.named, ...NULDROP_PARAM.named } },
  m_model: { named: { ...COLOR_PARAM.named, ...NULDROP_PARAM.named } },
  m_effort: { named: { ...COLOR_PARAM.named, ...NULDROP_PARAM.named } },
  m_repo: { named: { ...COLOR_PARAM.named, ...NULDROP_PARAM.named } },
  m_branch: { named: { ...COLOR_PARAM.named, ...NULDROP_PARAM.named } },
  m_gitStatus: { named: { ...COLOR_PARAM.named, ...NULDROP_PARAM.named } },
  m_ccVersion: { named: { ...COLOR_PARAM.named, ...NULDROP_PARAM.named } },
  m_ccversion: { named: { ...COLOR_PARAM.named, ...NULDROP_PARAM.named } },
  m_sessionDuration: { named: { ...COLOR_PARAM.named, ...NULDROP_PARAM.named } },
  m_sessionApiDuration: { named: { ...COLOR_PARAM.named, ...NULDROP_PARAM.named } },
  // v0.8.0+ — per-turn API-ms delta. Same inline-args grammar as
  // m_sessionDuration (color + nulldrop). The dispatcher accepts
  // both `:color|` and `:nulldrop|` overrides via this schema.
  m_apiMs: { named: { ...COLOR_PARAM.named, ...NULDROP_PARAM.named } },
  m_linesAdded: { named: { ...COLOR_PARAM.named, ...NULDROP_PARAM.named } },
  m_linesRemoved: { named: { ...COLOR_PARAM.named, ...NULDROP_PARAM.named } },
  m_tokenInTotal: { named: { ...COLOR_PARAM.named, ...NULDROP_PARAM.named } },
  m_tokenTotalOut: { named: { ...COLOR_PARAM.named, ...NULDROP_PARAM.named } },
  m_tokenTotalIn: { named: { ...COLOR_PARAM.named, ...NULDROP_PARAM.named } },
  m_apiCalls: { named: { ...COLOR_PARAM.named, ...NULDROP_PARAM.named } },
  m_contextWindowsSize: { named: { ...COLOR_PARAM.named, ...NULDROP_PARAM.named } },
  m_contextUsedPercent: { named: { ...COLOR_PARAM.named, ...NULDROP_PARAM.named } },
  m_contextRemainingPercent: { named: { ...COLOR_PARAM.named, ...NULDROP_PARAM.named } },
  m_windowContext: { named: { ...COLOR_PARAM.named, ...DISPLAY_PARAM.named, ...NULDROP_PARAM.named } },
  // v0.4.0+ — sub-template reference. First argument is the key
  // into cfg().lineTemplates (the user's reusable-fragment
  // registry). Optional `:mode|<plan|balance>` filter (default
  // "plan"): when the current provider's mode key does not match,
  // the chunk drops so adjacent separators are skipped. We do
  // NOT accept `:color|` here — propagating a color across an
  // expanded template requires a more invasive design (the
  // expansion's internal modules would need to inherit or be
  // re-styled). Users wanting per-chunk color put `:color|` on
  // the inner modules inside their lineTemplates entry.
  m_template: {
    implicit: {
      name: "key",
      resolver: (raw) =>
        typeof raw === "string" && raw !== "" ? raw : null,
    },
    named: {
      // Intrinsic — providerType filter. NOT forwarded via
      // passThrough (it's a m_template-local concern, not an
      // arg value to push to inner modules).
      mode: (raw) => (raw === "plan" || raw === "balance" ? raw : null),
      // v0.8.7+ — passthrough whitelist. Each of these named
      // params is accepted on `m_template` and forwarded to the
      // inner module list as a fallback when the inner module's
      // own `params[<name>]` is undefined. Unknown args still
      // fail loud (parseInlineArgs → badarg → warn + drop), so
      // typos are not silently accepted. The whitelist mirrors
      // the param atoms that the `m_acc*` / `m_sum*` /
      // `m_template` consumers actually read.
      ...NULDROP_PARAM.named,
      ...COLOR_PARAM.named,
      ...SCOPE_PARAM.named,
      ...MODEL_PARAM.named,
      ...WINDOW_PARAM.named,
      ...ALIGN_PARAM.named,
    },
  },
};

// NOTE: the `mode:` named arg on `m_template` keeps the OLD name for
// back-compat with existing config.json files that reference
// `m_template:plan:mode|plan`. Internally the renderer now uses
// `ctx.providerType` (a TYPE discriminator, not a mode), but the
// inline-arg syntax is unchanged. The param value still parses
// "plan" / "balance" (the renderer-side filter only matches the
// registered TYPE values, not the new "unknown" — unknown providers
// never reach this branch because dispatch wires a default
// lineTemplate that doesn't reference m_template).

// Pure helper: wrap a plain-text body in `<color>…<RESET>`. Returns
// the body unchanged when `color` is undefined. Safe ONLY for bodies
// that don't already contain SGR sequences — colored bodies must use
// their override-aware helper (e.g. formatOneChunkColored).
function wrapPlain(body: string, color: string | undefined): string {
  return color ? `${color}${body}${RESET}` : body;
}

// v6.x — wrap a plain-text body with either the user's `|color|<c>`
// override or the module's hardcoded DEFAULT_COLORS entry. Used by
// every non-numeric m_* INLINE_RENDERER so bare-form parity holds:
// bare `m_session` (no params) tints to purple, and inline
// `m_session|color|green` overrides to green — exactly as the user
// would expect.
function wrapPlainDefault(
  modKey: string,
  body: string,
  paramsColor: string | undefined,
): string {
  const color = paramsColor ?? DEFAULT_COLORS[modKey];
  return color ? `${color}${body}${RESET}` : body;
}

// v0.8.7+ — resolve an inline-arg value with passthrough fallback.
// Resolution order: local `params[name]` (the inner module's own
// explicit arg) > `ctx.passThrough?.[name]` (an outer m_template's
// forwarded arg) > undefined (caller applies its own DEFAULT).
// Used by the m_acc* and m_sum* renderers so that a single
// `m_template|<key>|scope|model` caller can drive the inner
// module's `scope` choice without the inner module having to
// declare it. Inner-explicit-wins is the documented contract —
// the user explicitly chose it over a passthrough-beats-explicit
// alternative.
function passThroughOr<T extends ResolvedValue>(
  params: Record<string, ResolvedValue | undefined>,
  ctx: RenderContext,
  name: string,
): T | undefined {
  const local = params[name] as T | undefined;
  if (local !== undefined) return local;
  const pt = ctx.passThrough?.[name];
  return pt === undefined ? undefined : (pt as T);
}

// v0.8.7+ — build a merged `params` view that fills in any missing
// keys from `ctx.passThrough`. Used by renderers that hand `params`
// wholesale to a helper (e.g. `parseWindowScope`), so the helper
// can stay params-only and still see the outer m_template's
// forwarded values. Returns a fresh object — the original
// `params` is not mutated. Inner-explicit-wins is preserved
// because the merge is a one-way fill: local keys are kept as-is
// and only undefined slots take the passthrough value.
function mergePassThrough(
  params: Record<string, ResolvedValue | undefined>,
  ctx: RenderContext,
): Record<string, ResolvedValue | undefined> {
  if (!ctx.passThrough) return params;
  const out: Record<string, ResolvedValue | undefined> = { ...params };
  for (const [k, v] of Object.entries(ctx.passThrough)) {
    if (out[k] === undefined) out[k] = v;
  }
  return out;
}

// v0.8.7+ — extract a `scope` value from `ctx.passThrough` for
// MODULES-bare-path renderers (which don't go through INLINE_RENDERERS
// and therefore can't call `passThroughOr(params, ctx, "scope")`).
// Returns undefined when passthrough is absent or the value isn't a
// known scope — `accBody` then applies its own default (ccsession).
// Centralized here so the bare path stays a one-liner at the call
// site and validation logic lives in one place.
function passThroughScope(
  ctx: RenderContext,
): "session" | "project" | "model" | "ccsession" | undefined {
  const v = ctx.passThrough?.scope;
  if (v === "session" || v === "project" || v === "model" || v === "ccsession") {
    return v;
  }
  return undefined;
}

// v0.4.x — parallel to MODULES' per-module `type` tag. Each entry
// here mirrors its INLINE_RENDERERS counterpart's provider scope:
// the inline form `m_window5h|color|…` is also plan-only; `m_balance:…`
// is balance-only. The bare-module dispatcher at line ~3220 enforces
// the same filter via `MODULES[name].type`; this map keeps the
// inline path symmetric so a `m_window5h|color|red` in a balance
// provider's template drops the same way the bare form does.
//
// Untagged entries (key absent from this map) are provider-agnostic;
// the dispatcher treats the absence of a key as "no type filter",
// matching the MODULES-default of type === undefined.
//
// Renamed from INLINE_MODE_FILTERS to INLINE_TYPE_FILTERS in v0.4.x
// to avoid collision with the display-mode field (`used` /
// `remaining` / `balance`).
const INLINE_TYPE_FILTERS: Partial<Record<string, "plan" | "balance" | "unknown">> = {
  m_window5h: "plan",
  m_window7d: "plan",
  m_countdown5h: "plan",
  m_countdown7d: "plan",
  m_balance: "balance",
};

// Per-prefix renderer. Returns the chunk text (or null to drop).
const INLINE_RENDERERS: Record<string, InlineRenderer> = {
  s_: (params, _ctx) => {
    // params.index is the output of resolveSepRef: a plain
    // number for the index form, or a "alias:<name>" string
    // for the named form. resolveSepBody decodes both and
    // returns either the literal body or INLINE_BADARG
    // (out-of-range). Inline-args path through here.
    const body = resolveSepBody(params.index);
    if (body === INLINE_BADARG) return INLINE_BADARG;
    // v0.7.2+ — repeat N times (validated by REPEAT_PARAM resolver
    // upstream; default "1"), then optionally pad with 1 space on
    // each side when wrap=true and the body is non-control. See
    // formatSepBody.
    const repeat = (params.repeat as string | undefined) ?? "1";
    const wrap = (params.wrap as string | undefined) ?? "true";
    const shape = formatSepBody(body, repeat, wrap);
    return wrapPlain(shape, params.color as string | undefined);
  },
  m_label: (params, _ctx) => {
    const s = params.string as string;
    if (s === "") return INLINE_BADARG; // empty payload is malformed
    return wrapPlain(s, params.color as string | undefined);
  },
  m_modeLabel: (params, ctx) => {
    // Mirrors the MODULES["m_modeLabel"] body: balance path → balance
    // label, else the mode-aware label. v6.x: inline form now ALSO
    // tints with DEFAULT_COLORS["m_modeLabel"] (=stale gray) so bare
    // vs inline parity holds for the prefix label too.
    const s = ctx.providerType === "balance"
      ? cfg().modeLabels.balance
      : cfg().modeLabels[ctx.mode];
    return wrapPlainDefault("m_modeLabel", s, params.color as string | undefined);
  },
  m_window5h: (params, ctx) => {
    if (!ctx.fiveHour) return placeholderWithColor("m_window5h", params, ctx);
    const mode = (params.display as DisplayMode | undefined) ?? ctx.mode;
    const color = params.color as string | undefined;
    if (color) return formatOneChunkColored(ctx.fiveHour, mode, color);
    // No override → reproduce the bare-module output. v0.6.0+: pass
    // ctx.stale so the percent tail wraps in STALE_COLOR instead of
    // the band-based color on stale ticks. :color| override above
    // always wins (documented v0.3.3 semantics — the user's color
    // wins even when stale so explicit coloring stays sticky).
    return formatOneChunk(ctx.fiveHour, mode, cfg().bar.width, ctx.stale);
  },
  m_window7d: (params, ctx) => {
    if (!ctx.weekly) return placeholderWithColor("m_window7d", params, ctx);
    const mode = (params.display as DisplayMode | undefined) ?? ctx.mode;
    const color = params.color as string | undefined;
    if (color) return formatOneChunkColored(ctx.weekly, mode, color);
    return formatOneChunk(ctx.weekly, mode, cfg().bar.width, ctx.stale);
  },
  m_countdown5h: (params, ctx) => {
    // v6.x: missing window → "5h:--" placeholder (was: drop).
    // Bare MODULES already does this; inline now matches.
    if (!ctx.fiveHour) return placeholderWithColor("m_countdown5h", params, ctx);
    // v0.7.x: stale AND past-due → "(n/a<arrow> 5h)" wrapped in
    // STALE_COLOR. An explicit :color| still wins (no override).
    if (isStaleAndPastDue(ctx.fiveHour, ctx.stale, ctx.nowMs)) {
      const userColor = params.color as string | undefined;
      const color = userColor ?? STALE_COLOR;
      const body = formatStalePastDueResetSuffix("5h", ctx.fiveHour, ctx.nowMs);
      return `${color}${body}${RESET}`;
    }
    const body = formatOneResetSuffix("5h", ctx.fiveHour, ctx.nowMs);
    if (body === "") return null;
    return wrapPlainDefault("m_countdown5h", body, params.color as string | undefined);
  },
  m_countdown7d: (params, ctx) => {
    // v6.x: missing window → "7d:--" placeholder.
    if (!ctx.weekly) return placeholderWithColor("m_countdown7d", params, ctx);
    if (isStaleAndPastDue(ctx.weekly, ctx.stale, ctx.nowMs)) {
      const userColor = params.color as string | undefined;
      const color = userColor ?? STALE_COLOR;
      const body = formatStalePastDueResetSuffix("7d", ctx.weekly, ctx.nowMs);
      return `${color}${body}${RESET}`;
    }
    const body = formatOneResetSuffix("7d", ctx.weekly, ctx.nowMs);
    if (body === "") return null;
    return wrapPlainDefault("m_countdown7d", body, params.color as string | undefined);
  },
  m_balance: (params, ctx) => {
    // v6.x: missing balance → "balance:n/a" placeholder (was:
    // drop). Multi-currency join still prefers the real chunk
    // when available; the placeholder only fires on the truly
    // empty case. Default tint comes from DEFAULT_COLORS — see
    // wrapPlainDefault below.
    if (!ctx.balance) return placeholderWithColor("m_balance", params, ctx);
    const color = (params.color as string | undefined) ?? DEFAULT_COLORS["m_balance"];
    const text = formatBalanceEntriesColored(ctx.balance, color);
    return text || placeholderWithColor("m_balance", params, ctx);
  },
  m_age: (params, ctx) => {
    // v6.x: missing ageMs → "age:n/a" placeholder (was: drop).
    if (ctx.ageMs == null) return placeholderWithColor("m_age", params, ctx);
    // v0.6.0+ — same cross-recursion dedup as the bare-MODULES path.
    // Whichever m_age instance fires first (bare or inline, top-level
    // or inside an m_template: fragment) claims the slot.
    if (ctx.ageEmittedRef?.value) return null;
    if (ctx.ageEmittedRef) ctx.ageEmittedRef.value = true;
    const color = (params.color as string | undefined) ?? DEFAULT_COLORS["m_age"];
    return formatStaleSuffix(ctx.ageMs, !ctx.stale, color);
  },
  m_version: (params, ctx) => {
    // v6.x: missing version → "v:n/a" placeholder (was: drop).
    if (!ctx.version) return placeholderWithColor("m_version", params, ctx);
    return wrapPlainDefault("m_version", `v${ctx.version}`, params.color as string | undefined);
  },
  m_tokenIn: (params, ctx) => {
    const r = computeTickDelta(ctx, "in");
    if (r.writeBack && ctx.tokens?.sessionId) setPrevTick(ctx.tokens.sessionId, r.writeBack, ctx.tokens.cwd, {
      sessionId: ctx.tokens.sessionId, cwd: ctx.tokens.cwd, model: ctx.tokens.modelDisplayName ?? null,
    });
    return wrapPlain(r.value, params.color as string | undefined);
  },
  m_tokenOut: (params, ctx) => {
    const r = computeTickDelta(ctx, "out");
    if (r.writeBack && ctx.tokens?.sessionId) setPrevTick(ctx.tokens.sessionId, r.writeBack, ctx.tokens.cwd, {
      sessionId: ctx.tokens.sessionId, cwd: ctx.tokens.cwd, model: ctx.tokens.modelDisplayName ?? null,
    });
    return wrapPlain(r.value, params.color as string | undefined);
  },
  m_tokenTotal: (params, ctx) => {
    const body = inlineTokenTotalLabel(ctx);
    if (body == null) return placeholderWithColor("m_tokenTotal", params, ctx);
    return wrapPlain(body, params.color as string | undefined);
  },
  m_tokenSession: (params, ctx) => {
    const body = inlineTokenSessionLabel(ctx);
    if (body == null) return placeholderWithColor("m_tokenSession", params, ctx);
    return wrapPlain(body, params.color as string | undefined);
  },
  // v0.8.0+ — inline form of m_contextSize (cumulative occupancy,
  // total_input_tokens). See MODULES entry for the new semantic.
  m_contextSize: (params, ctx) => {
    const total = ctx.tokens?.totals?.input;
    if (total == null) return placeholderWithColor("m_contextSize", params, ctx);
    return wrapPlain(
      `size:${formatCompactToken(total)}`,
      params.color as string | undefined,
    );
  },
  // v0.8.0+ — per-turn hit rate (see MODULES entry for the
  // formula and rename rationale). The inline form takes an
  // optional `:color|` override; the bare form is the canonical
  // per-turn hit rate. The session-aggregate formula moved to
  // m_accTokenHitRate.
  m_tokenHitRate: (params, ctx) => {
    const t = ctx.tokens;
    if (!t) return placeholderWithColor("m_tokenHitRate", params, ctx);
    const total = t.totals?.input;
    const cacheRead = t.current?.cacheRead;
    if (total == null || cacheRead == null) {
      // v0.8.x — TTL-bounded cache fallback (mirrors MODULES path
      // and the m_apiMs / m_tokenInSpeed convention). Idle tick
      // within 60s of the last active tick renders the cached
      // percentage in STALE_COLOR; outside the window or with no
      // prior measurement, the placeholder drops in. STALE_COLOR
      // wins over the user's |color| override, matching
      // computeTickSpeed's convention — gray is the canonical
      // "this is from a previous tick" signal.
      if (t.sessionId) {
        const cached = peekLastTokenHitRate(t.sessionId, t.cwd);
        if (cached != null) {
          return wrapPlainDefault(
            "m_tokenHitRate",
            `hit:${cached.toFixed(cachePctPrecision())}%`,
            STALE_COLOR,
          );
        }
      }
      return placeholderWithColor("m_tokenHitRate", params, ctx);
    }
    if (total === 0) return `${STALE_COLOR}hit:0.0%${RESET}`;
    const pct = (cacheRead / total) * 100;
    if (t.sessionId) setLastTokenHitRate(t.sessionId, pct, t.cwd);
    // v0.8.x — "active" coloring (mirrors MODULES body and the
    // m_tokenInSpeed / m_tokenOutSpeed / m_apiMs convention). The
    // per-turn hit rate is only a fresh reading when the API
    // actually did work this tick (hasDelta=true). An idle tick
    // renders STALE_COLOR regardless of the user's |color|
    // override, matching computeTickSpeed.
    const r = computeAndCacheTickDelta(ctx);
    if (r.writeBack && t.sessionId) setPrevTick(t.sessionId, r.writeBack, t.cwd, {
      sessionId: t.sessionId, cwd: t.cwd, model: t.modelDisplayName ?? null,
    });
    if (!r.hasDelta) {
      return wrapPlainDefault(
        "m_tokenHitRate",
        `hit:${pct.toFixed(cachePctPrecision())}%`,
        STALE_COLOR,
      );
    }
    const color = (params.color as string | undefined) ?? cacheHitColor(pct);
    return `${color}hit:${pct.toFixed(cachePctPrecision())}%${RESET}`;
  },
  // v0.8.0+ — renamed from `m_cacheRead` (see MODULES entry). The
  // `(XX%)` share suffix was dropped in v0.8.6+ — use m_tokenHitRate
  // for the ratio.
  m_tokenCachedIn: (params, ctx) => {
    const t = ctx.tokens?.current;
    if (!t) return placeholderWithColor("m_tokenCachedIn", params, ctx);
    // v6.x: distinguish cacheRead=null (field not shipped by
    // stdin) from cacheRead=0 (real zero cache reads).
    //   null → placeholder "cache:n/a"
    //   0    → "cache:0" (real zero, not hidden)
    if (t.cacheRead == null) return placeholderWithColor("m_tokenCachedIn", params, ctx);
    const label = formatCompactToken(t.cacheRead);
    const color = (params.color as string | undefined) ?? STALE_COLOR;
    const prefix = labelFor("cacheIn");
    return `${color}${prefix}${label}${RESET}`;
  },
  // v0.4.0+ — :color|scale (or no :color| at all) → 5-band
  // scale color on the active tick, STALE_COLOR on the
  // cached/inactive tick. :color|<shortcut|SGR> → that exact
  // color on the active tick, STALE_COLOR on the cached
  // tick (per the user's "inactive 不受 :color| 影响"
  // decision — gray is the canonical "stale" signal).
  m_tokenInSpeed: (params, ctx) => {
    const probe = computeTickSpeed(ctx, "in", STALE_COLOR);
    const userColor = params.color as string | undefined;
    const activeColor =
      userColor === SCALE_COLOR_SENTINEL || userColor == null
        ? speedScaleColor("in", probe.tps ?? 0)
        : (userColor ?? STALE_COLOR);
    const r = computeTickSpeed(ctx, "in", activeColor);
    if (r.writeBack && ctx.tokens?.sessionId) setPrevTick(ctx.tokens.sessionId, r.writeBack, ctx.tokens.cwd, {
      sessionId: ctx.tokens.sessionId, cwd: ctx.tokens.cwd, model: ctx.tokens.modelDisplayName ?? null,
    });
    return r.value;
  },
  m_tokenOutSpeed: (params, ctx) => {
    const probe = computeTickSpeed(ctx, "out", STALE_COLOR);
    const userColor = params.color as string | undefined;
    const activeColor =
      userColor === SCALE_COLOR_SENTINEL || userColor == null
        ? speedScaleColor("out", probe.tps ?? 0)
        : (userColor ?? STALE_COLOR);
    const r = computeTickSpeed(ctx, "out", activeColor);
    if (r.writeBack && ctx.tokens?.sessionId) setPrevTick(ctx.tokens.sessionId, r.writeBack, ctx.tokens.cwd, {
      sessionId: ctx.tokens.sessionId, cwd: ctx.tokens.cwd, model: ctx.tokens.modelDisplayName ?? null,
    });
    return r.value;
  },
  // v0.8.x cwf-tickStatus-v2 — m_totalToken* / m_totalTokenWithCacheIn
  // REMOVED. Use the m_acc* family (scope=ccsession default).
  // v0.8.0+ — 6 acc modules (m_accTokenIn / Out / CachedIn / TotalIn /
  // ApiMs / CacheHitRate). Four-layer granularity via :scope:
  //   ccsession (default) — per-claude-code-process (singleton; reset
  //                        on cost.totalApiDurationMs regression)
  //   session — per-session accumulator
  //   project — crosses session boundaries within the same cwd
  //   model — crosses session boundaries within the same model
  // All read from the v0.8.0 AccSnapshot slot populated by setAvg
  // (which writes 3 slots per tick: session/project/model). The
  // scope→slot mapping is hidden inside peekAcc; renderers just
  // pass the resolved scope through.
  m_accTokenIn: (params, ctx) => {
    const scope = passThroughOr<"session" | "project" | "model" | "ccsession">(params, ctx, "scope") ?? "ccsession";
    return wrapPlainDefault("m_accTokenIn", accBody(ctx, "in", scope), passThroughOr<string>(params, ctx, "color"));
  },
  m_accTokenOut: (params, ctx) => {
    const scope = passThroughOr<"session" | "project" | "model" | "ccsession">(params, ctx, "scope") ?? "ccsession";
    return wrapPlainDefault("m_accTokenOut", accBody(ctx, "out", scope), passThroughOr<string>(params, ctx, "color"));
  },
  m_accTokenCachedIn: (params, ctx) => {
    const scope = passThroughOr<"session" | "project" | "model" | "ccsession">(params, ctx, "scope") ?? "ccsession";
    return wrapPlainDefault("m_accTokenCachedIn", accBody(ctx, "cached", scope), passThroughOr<string>(params, ctx, "color"));
  },
  m_accTokenTotalIn: (params, ctx) => {
    const scope = passThroughOr<"session" | "project" | "model" | "ccsession">(params, ctx, "scope") ?? "ccsession";
    return wrapPlainDefault("m_accTokenTotalIn", accBody(ctx, "total", scope), passThroughOr<string>(params, ctx, "color"));
  },
  m_accApiMs: (params, ctx) => {
    const scope = passThroughOr<"session" | "project" | "model" | "ccsession">(params, ctx, "scope") ?? "ccsession";
    return wrapPlainDefault("m_accApiMs", accBody(ctx, "apiMs", scope), passThroughOr<string>(params, ctx, "color"));
  },
  m_accApiCalls: (params, ctx) => {
    const scope = passThroughOr<"session" | "project" | "model" | "ccsession">(params, ctx, "scope") ?? "ccsession";
    return wrapPlainDefault("m_accApiCalls", accBody(ctx, "apiCalls", scope), passThroughOr<string>(params, ctx, "color"));
  },
  // Hit rate is special: ccsession-scoped by default (per-process
  // lifetime). Pass :scope:session/:scope:project/:scope:model to
  // opt into a narrower or wider aggregate.
  m_accTokenHitRate: (params, ctx) => {
    const scope = passThroughOr<"session" | "project" | "model" | "ccsession">(params, ctx, "scope") ?? "ccsession";
    return accHitRateBody(ctx, scope);
  },
  // v0.8.0+ — sum/avg inline renderers. Same body shape as the
  // bare-form MODULES entries; the inline path passes params so
  // :model|/:window|/:align| take effect. A parse failure on the
  // inline args has already dropped the token at the schema
  // resolver, so parseWindowScope here is the runtime fallback
  // for unexpected shapes (null → INLINE_BADARG path).
  m_sumTokenIn: (params, ctx) => {
    const merged = mergePassThrough(params, ctx);
    const filter = parseWindowScope(ctx, merged);
    if (!filter) return INLINE_BADARG;
    const agg = fetchSumAggregate(filter);
    if (agg.rows === 0) return placeholderWithColor("m_sumTokenIn", params, ctx);
    return wrapPlain(`${labelFor("in")}${formatCompactToken(agg.sumIn)}`, passThroughOr<string>(params, ctx, "color"));
  },
  m_sumTokenOut: (params, ctx) => {
    const merged = mergePassThrough(params, ctx);
    const filter = parseWindowScope(ctx, merged);
    if (!filter) return INLINE_BADARG;
    const agg = fetchSumAggregate(filter);
    if (agg.rows === 0) return placeholderWithColor("m_sumTokenOut", params, ctx);
    return wrapPlain(`${labelFor("out")}${formatCompactToken(agg.sumOut)}`, passThroughOr<string>(params, ctx, "color"));
  },
  m_sumTokenCachedIn: (params, ctx) => {
    const merged = mergePassThrough(params, ctx);
    const filter = parseWindowScope(ctx, merged);
    if (!filter) return INLINE_BADARG;
    const agg = fetchSumAggregate(filter);
    if (agg.rows === 0) return placeholderWithColor("m_sumTokenCachedIn", params, ctx);
    return wrapPlain(`${labelFor("cacheIn")}${formatCompactToken(agg.sumCached)}`, passThroughOr<string>(params, ctx, "color"));
  },
  m_sumTokenTotalIn: (params, ctx) => {
    const merged = mergePassThrough(params, ctx);
    const filter = parseWindowScope(ctx, merged);
    if (!filter) return INLINE_BADARG;
    const agg = fetchSumAggregate(filter);
    if (agg.rows === 0) return placeholderWithColor("m_sumTokenTotalIn", params, ctx);
    return wrapPlain(`${labelFor("totalIn")}${formatCompactToken(agg.sumTotalIn)}`, passThroughOr<string>(params, ctx, "color"));
  },
  m_sumApiMs: (params, ctx) => {
    const merged = mergePassThrough(params, ctx);
    const filter = parseWindowScope(ctx, merged);
    if (!filter) return INLINE_BADARG;
    const agg = fetchSumAggregate(filter);
    if (agg.rows === 0) return placeholderWithColor("m_sumApiMs", params, ctx);
    return wrapPlain(`api:${formatRemainingMs(agg.sumApiMs)}`, passThroughOr<string>(params, ctx, "color"));
  },
  m_sumTokenHitRate: (params, ctx) => {
    const merged = mergePassThrough(params, ctx);
    const filter = parseWindowScope(ctx, merged);
    if (!filter) return INLINE_BADARG;
    const agg = fetchSumAggregate(filter);
    const denom = agg.sumIn + agg.sumCached;
    if (agg.rows === 0 || denom === 0) return placeholderWithColor("m_sumTokenHitRate", params, ctx);
    const pct = (agg.sumCached / denom) * 100;
    return `${cacheHitColor(pct)}hit:${pct.toFixed(cachePctPrecision())}%${RESET}`;
  },
  m_sumTokenInSpeed: (params, ctx) => {
    const merged = mergePassThrough(params, ctx);
    const filter = parseWindowScope(ctx, merged);
    if (!filter) return INLINE_BADARG;
    const agg = fetchSumAggregate(filter);
    if (agg.sumApiMs === 0) return placeholderWithColor("m_sumTokenInSpeed", params, ctx);
    const tps = (agg.sumIn / agg.sumApiMs) * 1000;
    return wrapPlain(`${labelFor("in")}${formatSpeed(tps)}`, passThroughOr<string>(params, ctx, "color"));
  },
  m_sumTokenOutSpeed: (params, ctx) => {
    const merged = mergePassThrough(params, ctx);
    const filter = parseWindowScope(ctx, merged);
    if (!filter) return INLINE_BADARG;
    const agg = fetchSumAggregate(filter);
    if (agg.sumApiMs === 0) return placeholderWithColor("m_sumTokenOutSpeed", params, ctx);
    const tps = (agg.sumOut / agg.sumApiMs) * 1000;
    return wrapPlain(`${labelFor("out")}${formatSpeed(tps)}`, passThroughOr<string>(params, ctx, "color"));
  },
  // v0.8.x — total count of API calls in window. See MODULES twin.
  m_sumApiCalls: (params, ctx) => {
    const merged = mergePassThrough(params, ctx);
    const filter = parseWindowScope(ctx, merged);
    if (!filter) return INLINE_BADARG;
    const agg = fetchSumAggregate(filter);
    if (agg.calls === 0) return placeholderWithColor("m_sumApiCalls", params, ctx);
    return wrapPlain(`calls:${agg.calls}`, passThroughOr<string>(params, ctx, "color"));
  },
  m_quote: (params, ctx) => {
    // Default freq = 1h (per-hour window). The schema resolver
    // already shape-validated the raw string; we now parse it
    // into a QuoteFreq {count, unit, ms} object that quoteIndex
    // and pickQuote need. params.freq is undefined when the
    // token is just `m_quote` or `m_quote|color|red` (no freq
    // segment). On a malformed-but-shape-valid string we
    // INLINE_BADARG here; in practice parseFreq rejects the
    // same set the resolver does.
    const raw = params.freq as string | undefined;
    const parsed: QuoteFreq | null = parseFreq(raw ?? "h");
    if (!parsed) return INLINE_BADARG;
    const seed = quoteIndex(parsed, ctx.nowMs);
    const text = pickQuote(parsed, ctx.nowMs);
    if (text === "") return null;
    const color = decodeColorParam(params.color as string | undefined);
    return applyColor(text, color, seed);
  },
  // v0.4.0+ — session-info / metadata inline renderers. All mirror
  // their MODULES counterparts but accept an optional :color| override.
  m_session: (params, ctx) => {
    const s = ctx.tokens?.sessionName;
    if (s == null) return placeholderWithColor("m_session", params, ctx);
    return wrapPlainDefault("m_session", s, params.color as string | undefined);
  },
  m_model: (params, ctx) => {
    const s = ctx.tokens?.modelDisplayName;
    if (s == null) return placeholderWithColor("m_model", params, ctx);
    return wrapPlainDefault("m_model", s, params.color as string | undefined);
  },
  m_effort: (params, ctx) => {
    const s = ctx.tokens?.effort;
    if (s == null) return placeholderWithColor("m_effort", params, ctx);
    return wrapPlainDefault("m_effort", s, params.color as string | undefined);
  },
  m_repo: (params, ctx) => {
    const r = ctx.tokens?.repo;
    if (!r) return placeholderWithColor("m_repo", params, ctx);
    const parts = [r.host, r.owner, r.name].filter(
      (p): p is string => p != null && p.length > 0,
    );
    if (parts.length === 0) return placeholderWithColor("m_repo", params, ctx);
    return wrapPlainDefault("m_repo", parts.join("/"), params.color as string | undefined);
  },
  m_branch: (params, ctx) => {
    const branch = readGitInfo(ctx.tokens?.cwd)?.branch;
    if (branch == null) return placeholderWithColor("m_branch", params, ctx);
    return wrapPlainDefault("m_branch", branch, params.color as string | undefined);
  },
  m_gitStatus: (params, ctx) => {
    const info = readGitInfo(ctx.tokens?.cwd);
    if (info == null) return placeholderWithColor("m_gitStatus", params, ctx);
    return wrapPlainDefault("m_gitStatus", info.dirty ? "dirty" : "clean", params.color as string | undefined);
  },
  m_ccVersion: (params, ctx) => {
    const v = ctx.tokens?.ccversion;
    if (v == null) return placeholderWithColor("m_ccVersion", params, ctx);
    return wrapPlainDefault("m_ccVersion", v, params.color as string | undefined);
  },
  // Deprecated alias — same body as m_ccVersion.
  m_ccversion: (params, ctx) => {
    const v = ctx.tokens?.ccversion;
    if (v == null) return placeholderWithColor("m_ccversion", params, ctx);
    return wrapPlainDefault("m_ccversion", v, params.color as string | undefined);
  },
  m_sessionDuration: (params, ctx) => {
    const ms = ctx.tokens?.cost.totalDurationMs;
    if (ms == null) return placeholderWithColor("m_sessionDuration", params, ctx);
    return wrapPlainDefault("m_sessionDuration", formatRemainingMs(ms), params.color as string | undefined);
  },
  m_sessionApiDuration: (params, ctx) => {
    const ms = ctx.tokens?.cost.totalApiDurationMs;
    if (ms == null) return placeholderWithColor("m_sessionApiDuration", params, ctx);
    return wrapPlainDefault("m_sessionApiDuration", formatRemainingMs(ms), params.color as string | undefined);
  },
  // v0.8.0+ — per-turn API-ms delta (mirror of MODULES path with
  // inline-args color support). Bare-form default color comes
  // from DEFAULT_COLORS.m_apiMs; the inline `:color|` override
  // takes precedence here.
  m_apiMs: (params, ctx) => {
    const t = ctx.tokens;
    if (!t || !t.sessionId) return placeholderWithColor("m_apiMs", params, ctx);
    const r = computeAndCacheTickDelta(ctx);
    if (r.writeBack && t.sessionId) setPrevTick(t.sessionId, r.writeBack, t.cwd, {
      sessionId: t.sessionId, cwd: t.cwd, model: t.modelDisplayName ?? null,
    });
    if (!r.hasDelta) {
      // v0.8.x — TTL-bounded cache fallback (mirrors MODULES path
      // and the m_tokenInSpeed/m_tokenOutSpeed convention). Idle
      // tick within 60s of the last active tick renders the
      // cached deltaApiMs in STALE_COLOR; outside the window or
      // with no prior measurement, the placeholder drops in.
      const cached = peekLastApiMs(t.sessionId, t.cwd);
      if (cached != null) {
        // v0.8.x — the user's inline `|color|` override loses to
        // the STALE_COLOR convention here, matching the tps
        // siblings: gray signals "this is from a previous API
        // call, not this tick" regardless of the user's color
        // choice. See computeTickSpeed.
        return wrapPlainDefault(
          "m_apiMs",
          `api:${formatRemainingMs(cached)}`,
          STALE_COLOR,
        );
      }
      return placeholderWithColor("m_apiMs", params, ctx);
    }
    setLastApiMs(t.sessionId, r.deltaApi, t.cwd);
    return wrapPlainDefault("m_apiMs", `api:${formatRemainingMs(r.deltaApi)}`, params.color as string | undefined);
  },
  m_linesAdded: (params, ctx) => {
    const n = ctx.tokens?.cost.totalLinesAdded;
    if (n == null) return placeholderWithColor("m_linesAdded", params, ctx);
    return wrapPlainDefault("m_linesAdded", `+ ${n}`, params.color as string | undefined);
  },
  m_linesRemoved: (params, ctx) => {
    const n = ctx.tokens?.cost.totalLinesRemoved;
    if (n == null) return placeholderWithColor("m_linesRemoved", params, ctx);
    return wrapPlainDefault("m_linesRemoved", `- ${n}`, params.color as string | undefined);
  },
  m_tokenInTotal: (params, ctx) => {
    const t = ctx.tokens;
    if (!t || t.totals.input == null) return placeholderWithColor("m_tokenInTotal", params, ctx);
    return wrapPlain(
      `${labelFor("in")}${formatCompactToken(t.totals.input)}`,
      params.color as string | undefined,
    );
  },
  m_tokenTotalOut: (params, ctx) => {
    const t = ctx.tokens;
    if (!t || t.totals.output == null) return placeholderWithColor("m_tokenTotalOut", params, ctx);
    return wrapPlain(
      `${labelFor("out")}${formatCompactToken(t.totals.output)}`,
      params.color as string | undefined,
    );
  },
  // v0.8.0+ — total_input_tokens under the labelTotalIn label
  // family. Reads the same input as m_tokenInTotal; the two
  // modules differ in which labels.* axis labels them.
  m_tokenTotalIn: (params, ctx) => {
    const t = ctx.tokens;
    if (!t || t.totals.input == null) return placeholderWithColor("m_tokenTotalIn", params, ctx);
    return wrapPlain(
      `${labelFor("totalIn")}${formatCompactToken(t.totals.input)}`,
      params.color as string | undefined,
    );
  },
  // v0.4.x — project-wide count of valid API calls (sumApiCount
  // in tickStatus). Reads the same project-wide slot the
  // accumulator writes to. Renders "calls:N"; renders "calls:0"
  // (plain, or in the `|color|<c>` SGR) when the slot is
  // uninitialized. (`:nulldrop|` is a no-op here — the function
  // never returns null, same as m_tokenIn / m_tokenOut via
  // computeTickDelta.)
  m_apiCalls: (params, ctx) => {
    const cwd = ctx.tokens?.cwd;
    if (!cwd) return wrapPlainDefault("m_apiCalls", "calls:0", params.color as string | undefined);
    // v0.8.x cwf-tickStatus-v2 — project-wide key now keyed by
    // projectHash (no prefix-less `tickStatus`).
    const v = statusStore.readTickStatus(cwd, `tickStatus:${projectHash(cwd)}`);
    if (!v) return wrapPlainDefault("m_apiCalls", "calls:0", params.color as string | undefined);
    return wrapPlainDefault("m_apiCalls", `calls:${v.accApiCount}`, params.color as string | undefined);
  },
  // v0.8.0+ — inline form of m_contextWindowsSize (capacity).
  m_contextWindowsSize: (params, ctx) => {
    const sz = ctx.tokens?.contextWindow?.size;
    if (sz == null) return placeholderWithColor("m_contextWindowsSize", params, ctx);
    return wrapPlainDefault("m_contextWindowsSize", `size:${formatCompactToken(sz)}`, params.color as string | undefined);
  },
  // v0.8.0+ — inline form of m_contextUsedPercent.
  m_contextUsedPercent: (params, ctx) => {
    const pct = ctx.tokens?.contextWindow?.usedPct;
    if (pct == null) return placeholderWithColor("m_contextUsedPercent", params, ctx);
    return wrapPlainDefault("m_contextUsedPercent", `used:${pct}%`, params.color as string | undefined);
  },
  // v0.8.0+ — inline form of m_contextRemainingPercent.
  m_contextRemainingPercent: (params, ctx) => {
    const pct = ctx.tokens?.contextWindow?.remainingPct;
    if (pct == null) return placeholderWithColor("m_contextRemainingPercent", params, ctx);
    return wrapPlainDefault("m_contextRemainingPercent", `remain:${pct}%`, params.color as string | undefined);
  },
  m_windowContext: (params, ctx) => {
    if (!ctx.contextWindow) return placeholderWithColor("m_windowContext", params, ctx);
    const mode = (params.display as DisplayMode | undefined) ?? ctx.mode;
    const color = params.color as string | undefined;
    if (color) return formatOneChunkColored(ctx.contextWindow, mode, color);
    // v0.6.0+: stale-aware — see m_window5h/7d path. :color| above
    // always wins, so explicit user color stays sticky even on stale.
    return formatOneChunk(ctx.contextWindow, mode, cfg().bar.width, ctx.stale);
  },
  // v0.4.0+ — expand a registered lineTemplates fragment. The
  // loader strips any `m_template:` tokens from lineTemplates
  // arrays (config.ts applyOverrides), so the recursive call below
  // cannot itself reach an `m_template:` token. We `.slice()` the
  // inner array to defend against any future in-place mutation.
  // Missing key → warn + drop (renderer null path, same as bare
  // MODULES drop). Mode mismatch → silent drop (no warn; the user
  // explicitly asked for a mode filter).
  m_template: (params, ctx) => {
    const key = params.key as string;
    const inner = cfg().lineTemplates[key];
    if (!inner) {
      warn(
        `m_template: lineTemplates["${key}"] is undefined; dropping chunk`,
      );
      return null;
    }
    const want = (params.mode as "plan" | "balance" | undefined) ?? "plan";
    // v0.4.x — the inline-arg name `mode` is preserved for back-compat
    // with existing config.json files (e.g. `m_template:plan:mode|plan`).
    // The comparison target is now ctx.providerType. "unknown" never
    // matches an inline `mode:plan|balance` arg, so unknown providers
    // silently drop m_template references — same behavior as before.
    if (ctx.providerType !== want) return null;
    // v0.8.7+ — passthrough: build a passThrough view from every
    // param except the two intrinsics (`key` is the lookup target,
    // `mode` is the providerType filter — both are m_template-local
    // concerns, not values to push to inner modules). Nested
    // m_template is impossible because config.ts strips them at
    // load time, so we don't need to merge with a pre-existing
    // passThrough on the outer context.
    const passThrough: Record<string, ResolvedValue> = {};
    for (const [k, v] of Object.entries(params)) {
      if (k === "key" || k === "mode") continue;
      passThrough[k] = v as ResolvedValue;
    }
    const innerCtx: RenderContext = { ...ctx, passThrough };
    const lines = renderTemplate(inner.slice(), innerCtx);
    return lines.join("\n");
  },
};

// Extract the `m_tokenTotal` body as a pure helper so the inline
// renderer can call it without duplicating the computation.
// v6.x: when there's no snapshot at all, return the placeholder
// shape directly (without SGR wrap — the inline renderer applies
// STALE_COLOR + RESET when it gets a non-null string back, so
// returning the plain placeholder body here is the right division
// of labor). Mirrors the bare MODULES path's placeholderBare call.
function inlineTokenTotalLabel(ctx: RenderContext): string | null {
  const t = ctx.tokens;
  if (!t) return "tot:n/a";
  const inT = t.totals.input ?? 0;
  const outT = t.totals.output ?? 0;
  const cache = (t.current.cacheCreation ?? 0) + (t.current.cacheRead ?? 0);
  return `tot:${formatCompactToken(inT + outT + cache)}`;
}

// Same for `m_tokenSession`. v6.x: missing tokens → "session:n/a".
function inlineTokenSessionLabel(ctx: RenderContext): string | null {
  const t = ctx.tokens;
  if (!t) return "session:n/a";
  const inT = t.totals.input ?? 0;
  const outT = t.totals.output ?? 0;
  const cache = (t.current.cacheCreation ?? 0) + (t.current.cacheRead ?? 0);
  return `session:${formatCompactToken(inT + outT + cache)}`;
}

// v0.7.1+ — Parse the PIPE-delimited remainder after a token prefix
// into a `{ param: value }` object. Pure; no side effects.
//
// Why `|` instead of `:`: `:` is heavily used in label text (e.g.
// `Usage:`, `In:`, `api:5s`, `5h:--`) and in time-format units
// (`api:1m30s`). Adopting it as the inline-args delimiter forced
// every module's value-position to forbid `:` characters in
// strings like color names / model names / window values. `|`
// has zero collision with rendered output, so the grammar
// becomes unambiguous: the FIRST `|` separates the prefix from
// the args list, and subsequent `|` separate the args themselves.
//
// Layout:
//   - If the schema has an `implicit` param, the FIRST segment is its
//     value. Remaining segments (if any) must form name:value pairs.
//   - If the schema has no `implicit`, the FIRST segment (if any) must
//     be a name in `named` — i.e. segment 0 is the name of a pair,
//     segment 1 is its value, etc.
//
// Returns null on:
//   - any resolver returning null (bad value)
//   - unknown param name in the named section
//   - odd number of named segments (last segment has no value)
function parseInlineArgs(
  remainder: string,
  schema: InlineSchema,
): Record<string, ResolvedValue> | null {
  if (remainder === "") {
    // Empty remainder with an implicit param means "missing required
    // param" → null. Empty remainder without an implicit is fine.
    return schema.implicit ? null : {};
  }
  const parts = remainder.split("|");

  let out: Record<string, ResolvedValue> = {};
  let startIdx = 0;

  if (schema.implicit) {
    const v = parts[0]!;
    const r = schema.implicit.resolver(v);
    if (r === null) return null;
    out[schema.implicit.name] = r;
    startIdx = 1;
  }

  // Trailing segments must form name:value pairs (even count).
  const tail = parts.length - startIdx;
  if (tail % 2 !== 0) return null;
  for (let i = startIdx; i < parts.length; i += 2) {
    const name = parts[i]!;
    const raw = parts[i + 1]!;
    if (!(name in schema.named)) return null;
    const r = schema.named[name]!(raw);
    if (r === null) return null;
    out[name] = r;
  }
  return out;
}

// Try to expand an inline-args token. Returns one of:
//   - { kind: "ok",     value }    — chunk text (possibly empty)
//   - { kind: "badarg" }            — parse failed (warn + drop)
//   - undefined                     — no schema for this prefix (caller
//                                     falls through to the unknown-module
//                                     path; rare — only fires when a
//                                     typo slips past the dispatcher).
//
// `key` is the bare prefix (used as the schema/renderer lookup key —
// no trailing colon). `skipLen` is how many characters of the token
// to consume before the remainder starts.
//
// v0.3.4+ — distinguish parse failure from "renderer returned null
// for valid args but missing data". Previously the dispatcher warned
// on ANY null return, which made modules like m_tokenOut (returns
// null when stdin lacks total_output_tokens) wrongly warn on the
// "unknown lineTemplate module" path.
type InlineResult =
  | { kind: "ok"; value: string | null }
  | { kind: "badarg" };

function expandInlineToken(
  tok: string,
  key: string,
  skipLen: number,
  ctx: RenderContext,
): InlineResult | undefined {
  const schema = INLINE_SCHEMAS[key];
  if (schema === undefined) return undefined;
  const params = parseInlineArgs(tok.slice(skipLen), schema);
  if (params === null) return { kind: "badarg" };
  const rendered = INLINE_RENDERERS[key]!(params, ctx);
  if (rendered === INLINE_BADARG) return { kind: "badarg" };
  return { kind: "ok", value: rendered };
}

export function renderTemplate(template: readonly string[], ctx: RenderContext): string[] {
  const seps = cfg().separators;
  const lines: string[] = [];
  let current = "";
  for (let i = 0; i < template.length; i++) {
    const tok = template[i];
    if (tok == null) continue;
    let piece: string | null = null;
    // v0.3.3+ — inline-args tokens (s_<n>|…, m_label|…, m_modeLabel|…,
    // and every other m_<name>|…). Only fire when the token contains
    // "|" so the bare forms (s_0, m_modeLabel, m_window5h, …) keep
    // routing through MODULES as before.
    if (tok.includes("|")) {
      // v0.4.x — provider-type filter for inline-args tokens. We
      // extract the prefix (everything before the first "|") and
      // consult INLINE_TYPE_FILTERS. When the prefix carries a tag
      // and it doesn't match ctx.providerType, we silently drop
      // the whole token WITHOUT entering the long prefix chain
      // below. This keeps the per-prefix `type` tag symmetrical
      // with MODULES' `type` field so a `m_window5h|color:red` in a
      // balance provider's template drops identically to its bare
      // form.
      //
      // Special case: s_<n>|… is a separator, not a module, so we
      // skip the type check (separators are provider-agnostic).
      // m_label|… and m_template|… are also provider-agnostic by
      // design; their prefix is absent from INLINE_TYPE_FILTERS so
      // the lookup is a no-op. Missing-key (unknown prefix) is also
      // a no-op — the long chain below will produce inline=undefined
      // and the unknown-module warn path will fire there.
      //
      // Renamed from the v0.4.x-beta `INLINE_MODE_FILTERS` /
      // `ctx.providerModeKey` to avoid collision with the
      // display-mode field on RenderContext.
      //
      // v0.7.1+ — inline-args separator is `|`, not `:`. See
      // parseInlineArgs for the rationale.
      const pipeAt = tok.indexOf("|");
      const inlinePrefix = pipeAt > 0 && tok.startsWith("m_")
        ? tok.slice(0, pipeAt)
        : "";
      if (inlinePrefix) {
        const need = INLINE_TYPE_FILTERS[inlinePrefix];
        if (need && need !== ctx.providerType) {
          continue;
        }
      }
      // The prefix → key/skipLen table. Keep them in sync with the
      // INLINE_SCHEMAS / INLINE_RENDERERS entries above. A typo here
      // means the token silently routes through MODULES (which won't
      // match the literal pipe-bearing string) and falls through
      // to the unknown-module warn.
      let inline: InlineResult | undefined;
      if (tok.startsWith("s_")) {
        // s_<n>:… → skip "s_" (length 2), remainder starts at the index.
        inline = expandInlineToken(tok, "s_", 2, ctx);
      } else if (tok.startsWith("m_label|")) {
        // m_label|<args> → skip "m_|" (length 8), remainder starts
        // at the string value.
        inline = expandInlineToken(tok, "m_label", 8, ctx);
      } else if (tok.startsWith("m_modeLabel|")) {
        // m_modeLabel|<args> → skip "m_|" (length 12).
        inline = expandInlineToken(tok, "m_modeLabel", 12, ctx);
      } else if (tok.startsWith("m_window5h|")) {
        // m_window5h|color|<c> → skip "m_window5h|" (length 11).
        inline = expandInlineToken(tok, "m_window5h", 11, ctx);
      } else if (tok.startsWith("m_window7d|")) {
        inline = expandInlineToken(tok, "m_window7d", 11, ctx);
      } else if (tok.startsWith("m_countdown5h|")) {
        inline = expandInlineToken(tok, "m_countdown5h", 14, ctx);
      } else if (tok.startsWith("m_countdown7d|")) {
        inline = expandInlineToken(tok, "m_countdown7d", 14, ctx);
      } else if (tok.startsWith("m_balance|")) {
        inline = expandInlineToken(tok, "m_balance", 10, ctx);
      } else if (tok.startsWith("m_age|")) {
        inline = expandInlineToken(tok, "m_age", 6, ctx);
      } else if (tok.startsWith("m_version|")) {
        inline = expandInlineToken(tok, "m_version", 10, ctx);
      } else if (tok.startsWith("m_tokenIn|")) {
        inline = expandInlineToken(tok, "m_tokenIn", 10, ctx);
      } else if (tok.startsWith("m_tokenOut|")) {
        inline = expandInlineToken(tok, "m_tokenOut", 11, ctx);
      } else if (tok.startsWith("m_tokenInTotal|")) {
        // Longer prefix must come BEFORE m_tokenIn: would match first;
        // m_tokenIn: would shadow m_tokenInTotal|color|… if ordered
        // the other way. Same rationale for m_tokenTotalOut vs
        // m_tokenOut.
        inline = expandInlineToken(tok, "m_tokenInTotal", 15, ctx);
      } else if (tok.startsWith("m_tokenTotalOut|")) {
        // m_tokenTotalOut: (16 chars) must come BEFORE m_tokenTotal:
        // (13 chars) so the longer literal wins — otherwise
        // `m_tokenTotalOut|color|red` would match the m_tokenTotal:
        // branch with remainder "Out|color|red" and parse-fail.
        inline = expandInlineToken(tok, "m_tokenTotalOut", 16, ctx);
      } else if (tok.startsWith("m_apiCalls|")) {
        // m_apiCalls|color|<c> / |nulldrop|… → skip "m_apiCalls|"
        // (length 11).
        inline = expandInlineToken(tok, "m_apiCalls", 11, ctx);
      } else if (tok.startsWith("m_tokenTotalIn|")) {
        // m_tokenTotalIn: → skip prefix+colon (15 chars). Listed
        // BEFORE m_tokenTotal: which would otherwise shadow it
        // (m_tokenTotal: is a 13-char prefix; m_tokenTotalIn: starts
        // with the same 13 chars).
        inline = expandInlineToken(tok, "m_tokenTotalIn", 15, ctx);
      } else if (tok.startsWith("m_tokenTotal|")) {
        inline = expandInlineToken(tok, "m_tokenTotal", 13, ctx);
      } else if (tok.startsWith("m_tokenSession|")) {
        inline = expandInlineToken(tok, "m_tokenSession", 15, ctx);
      } else if (tok.startsWith("m_contextSize|")) {
        inline = expandInlineToken(tok, "m_contextSize", 14, ctx);
      } else if (tok.startsWith("m_tokenHitRate|")) {
        // m_tokenHitRate → skip prefix+pipe (15 chars).
        inline = expandInlineToken(tok, "m_tokenHitRate", 15, ctx);
      } else if (tok.startsWith("m_tokenCachedIn|")) {
        inline = expandInlineToken(tok, "m_tokenCachedIn", 16, ctx);
      } else if (tok.startsWith("m_tokenInSpeed|")) {
        inline = expandInlineToken(tok, "m_tokenInSpeed", 15, ctx);
      } else if (tok.startsWith("m_tokenOutSpeed|")) {
        inline = expandInlineToken(tok, "m_tokenOutSpeed", 16, ctx);
      } else if (tok.startsWith("m_accTokenCachedIn|")) {
        // Longer prefix listed first defensively (18 chars) — siblings
        // m_accTokenIn (12), m_accTokenOut (13), m_accTokenTotalIn
        // (16) share the "m_accToken" stem but differ at index 13/14/15.
        inline = expandInlineToken(tok, "m_accTokenCachedIn", 19, ctx);
      } else if (tok.startsWith("m_accTokenTotalIn|")) {
        // m_accTokenTotalIn → skip prefix+pipe (18 chars). Listed
        // before m_accTokenIn / m_accTokenOut to avoid prefix-shadow.
        inline = expandInlineToken(tok, "m_accTokenTotalIn", 18, ctx);
      } else if (tok.startsWith("m_accTokenOut|")) {
        // m_accTokenOut → skip prefix+pipe (14 chars).
        inline = expandInlineToken(tok, "m_accTokenOut", 14, ctx);
      } else if (tok.startsWith("m_accTokenIn|")) {
        // m_accTokenIn → skip prefix+pipe (13 chars).
        inline = expandInlineToken(tok, "m_accTokenIn", 13, ctx);
      } else if (tok.startsWith("m_accApiMs|")) {
        // m_accApiMs → skip prefix+pipe (11 chars).
        inline = expandInlineToken(tok, "m_accApiMs", 11, ctx);
      } else if (tok.startsWith("m_accApiCalls|")) {
        // m_accApiCalls → skip prefix+pipe (14 chars). Listed
        // before m_accTokenHitRate (19) and the m_sum* family to
        // keep the m_acc* cluster contiguous; shares length with
        // m_sumApiCalls (14) but diverges at index 5 ('c' vs 's').
        inline = expandInlineToken(tok, "m_accApiCalls", 14, ctx);
      } else if (tok.startsWith("m_accTokenHitRate|")) {
        // m_accTokenHitRate → skip prefix+pipe (18 chars). Renamed
        // from m_accCacheHitRate to align the namespace with
        // m_tokenHitRate (per-turn) / m_sumTokenHitRate
        // (cross-project). 18 chars shares length with
        // m_accTokenTotalIn (18) and m_sumTokenTotalIn (18) but
        // diverges at position 14 ('H' vs 'T' / 'T'), so no shadow.
        inline = expandInlineToken(tok, "m_accTokenHitRate", 18, ctx);
      } else if (tok.startsWith("m_sumTokenOutSpeed|")) {
        // v0.8.x — m_avgTokenOutSpeed renamed to m_sumTokenOutSpeed.
        // 19 chars; shares length with m_sumTokenCachedIn (19)
        // but diverges at position 14 ('O' vs 'C'). MUST be
        // listed before m_sumTokenOut (14) to avoid the
        // m_sumTokenOutSpeed|...|xxx token being matched by
        // startsWith("m_sumTokenOut|").
        inline = expandInlineToken(tok, "m_sumTokenOutSpeed", 20, ctx);
      } else if (tok.startsWith("m_sumTokenCachedIn|")) {
        // 19 chars; siblings m_sumTokenIn (12) / m_sumTokenOut (13) /
        // m_sumTokenTotalIn (17) / m_sumApiMs (10) /
        // m_sumTokenInSpeed (18) / m_sumTokenHitRate (18) differ at
        // later positions.
        inline = expandInlineToken(tok, "m_sumTokenCachedIn", 19, ctx);
      } else if (tok.startsWith("m_sumTokenInSpeed|")) {
        // v0.8.x — m_avgTokenInSpeed renamed to m_sumTokenInSpeed.
        // 18 chars; shares length with m_sumTokenTotalIn (18) and
        // m_sumTokenHitRate (18) but diverges at position 14 ('I' vs
        // 'T' / 'H'). MUST be listed before m_sumTokenIn (13) to
        // avoid the m_sumTokenInSpeed|...|xxx token being matched
        // by startsWith("m_sumTokenIn|").
        inline = expandInlineToken(tok, "m_sumTokenInSpeed", 19, ctx);
      } else if (tok.startsWith("m_sumTokenTotalIn|")) {
        inline = expandInlineToken(tok, "m_sumTokenTotalIn", 18, ctx);
      } else if (tok.startsWith("m_sumTokenHitRate|")) {
        // v0.8.x — m_avgCacheHitRate renamed to m_sumTokenHitRate.
        // 18 chars; shares length with m_sumTokenTotalIn (18) and
        // m_sumTokenInSpeed (18) but diverges at position 14 ('H'
        // vs 'T' / 'I'). The user-facing hit-rate prefix ("hit:N%")
        // is unchanged; the rename aligns the namespace with the
        // cross-project JSONL scan family (sits next to
        // m_sumTokenIn/Out/etc.).
        inline = expandInlineToken(tok, "m_sumTokenHitRate", 18, ctx);
      } else if (tok.startsWith("m_sumTokenOut|")) {
        inline = expandInlineToken(tok, "m_sumTokenOut", 14, ctx);
      } else if (tok.startsWith("m_sumApiCalls|")) {
        inline = expandInlineToken(tok, "m_sumApiCalls", 14, ctx);
      } else if (tok.startsWith("m_sumTokenIn|")) {
        inline = expandInlineToken(tok, "m_sumTokenIn", 13, ctx);
      } else if (tok.startsWith("m_sumApiMs|")) {
        inline = expandInlineToken(tok, "m_sumApiMs", 11, ctx);
      } else if (tok.startsWith("m_quote|")) {
        // m_quote|freq|<…>|color|<…> → skip "m_quote|" (length 8).
        inline = expandInlineToken(tok, "m_quote", 8, ctx);
      } else if (tok.startsWith("m_session|")) {
        inline = expandInlineToken(tok, "m_session", 10, ctx);
      } else if (tok.startsWith("m_model|")) {
        inline = expandInlineToken(tok, "m_model", 8, ctx);
      } else if (tok.startsWith("m_effort|")) {
        inline = expandInlineToken(tok, "m_effort", 9, ctx);
      } else if (tok.startsWith("m_repo|")) {
        inline = expandInlineToken(tok, "m_repo", 7, ctx);
      } else if (tok.startsWith("m_branch|")) {
        // m_branch|color|<c> → skip "m_|" (length 9).
        inline = expandInlineToken(tok, "m_branch", 9, ctx);
      } else if (tok.startsWith("m_gitStatus|")) {
        // m_gitStatus|color|<c> → skip "m_|" (length 12).
        inline = expandInlineToken(tok, "m_gitStatus", 12, ctx);
      } else if (tok.startsWith("m_ccVersion|")) {
        // m_ccVersion|color|<c> → skip "m_|" (length 12).
        inline = expandInlineToken(tok, "m_ccVersion", 12, ctx);
      } else if (tok.startsWith("m_ccversion|")) {
        // Deprecated alias — same dispatch as m_ccVersion: above.
        // Pre-rename configs may still use the lowercase form.
        inline = expandInlineToken(tok, "m_ccversion", 12, ctx);
      } else if (tok.startsWith("m_sessionApiDuration|")) {
        // Longer prefix must come BEFORE m_sessionDuration: for the
        // same prefix-shadowing reason as the m_tokenIn family.
        inline = expandInlineToken(tok, "m_sessionApiDuration", 21, ctx);
      } else if (tok.startsWith("m_sessionDuration|")) {
        inline = expandInlineToken(tok, "m_sessionDuration", 18, ctx);
      } else if (tok.startsWith("m_apiMs|")) {
        // v0.8.0+ — per-turn API-ms delta. No prefix-shadowing
        // concern: m_apiMs (8) and m_accApiMs (11) share the
        // "m_a" prefix but diverge at position 3 ("piMs" vs
        // "ccApiMs"), so the literal startsWith check is exact.
        // Placed adjacent to m_sessionDuration for cohesion
        // (both are dhms time-format modules).
        inline = expandInlineToken(tok, "m_apiMs", 8, ctx);
      } else if (tok.startsWith("m_linesAdded|")) {
        inline = expandInlineToken(tok, "m_linesAdded", 13, ctx);
      } else if (tok.startsWith("m_linesRemoved|")) {
        // m_linesRemoved|color|<c> → skip "m_|" (length 15).
        inline = expandInlineToken(tok, "m_linesRemoved", 15, ctx);
      } else if (tok.startsWith("m_contextWindowsSize|")) {
        // m_contextWindowsSize → skip prefix+colon (21 chars).
        inline = expandInlineToken(tok, "m_contextWindowsSize", 21, ctx);
      } else if (tok.startsWith("m_contextUsedPercent|")) {
        inline = expandInlineToken(tok, "m_contextUsedPercent", 21, ctx);
      } else if (tok.startsWith("m_contextRemainingPercent|")) {
        inline = expandInlineToken(tok, "m_contextRemainingPercent", 25, ctx);
      } else if (tok.startsWith("m_windowContext|")) {
        inline = expandInlineToken(tok, "m_windowContext", 16, ctx);
      } else if (tok.startsWith("m_template|")) {
        // m_template|<key>[|mode|<plan|balance>][|nulldrop|<bool>]
        // → skip "m_template|" (length 11).
        inline = expandInlineToken(tok, "m_template", 11, ctx);
      }
      // Parse failure (bad |color|, unknown param, odd segment count)
      // → warn + drop. Renderer returning null for valid args (e.g.
      // m_tokenOut when stdin lacks total_output_tokens) is NOT a
      // parse failure — silently skip the chunk, same as the bare
      // MODULES path. (v0.3.4+: previously we conflated the two
      // and wrongly warned "unknown module" on missing data.)
      if (inline?.kind === "badarg") {
        warnUnknownModuleOnce(tok);
        continue;
      }
      piece = inline?.kind === "ok" ? inline.value : null;
    } else if (tok.startsWith("s_")) {
      // Bare s_<…>|: legacy fast path. Two forms accepted:
      //   s_<digit>+ → array index (out-of-range = warn + drop)
      //   s_<name>   → built-in alias (s_space, s_dot, s_newline,
      //                 s_tab, s_colon, s_pipe), renders the literal
      //                 value independent of cfg().separators.
      // Inline-args (with optional color|) handles the
      // `s_<…>|color|<c>` form via the new path above; this branch
      // only fires for the no-pipe shorthand.
      const suffix = tok.slice(2);
      const alias = NAMED_SEPARATORS.get(suffix);
      if (alias !== undefined) {
        piece = alias;
      } else {
        const n = Number(suffix);
        if (!Number.isInteger(n) || n < 0 || n >= seps.length) {
          warnUnknownModuleOnce(tok);
          continue;
        }
        piece = seps[n];
      }
    } else if (tok.startsWith("m_")) {
      const mod = MODULES[tok];
      if (!mod) {
        warnUnknownModuleOnce(tok);
        continue;
      }
      // v0.4.x — provider-type filter. Modules tagged with a type
      // (`m_window5h: "plan"`, `m_balance: "balance"`, …) silently
      // drop on a non-matching provider type. Untagged modules
      // (m_token*, m_age, m_version, …) skip the check and emit
      // on every ctx — those are provider-agnostic by design.
      //
      // Renamed from `mod.mode` / `ctx.providerModeKey` to
      // `mod.type` / `ctx.providerType` to avoid collision with
      // the display-mode field (`used` / `remaining` / `balance`).
      //
      // The drop is a no-op — the chunk is skipped AND adjacent
      // s_<n> separators are skipped too via the same null-fall-
      // through the MODULES renderer already implements.
      if (mod.type != null && mod.type !== ctx.providerType) {
        continue;
      }
      piece = mod(ctx);
    } else {
      warnUnknownModuleOnce(tok);
      continue;
    }
    if (piece == null || piece === "") continue;
    // Split the piece on '\n' so a "\n" separator or a future module
    // that embeds newlines naturally produces multi-line output. The
    // first segment is appended to the in-progress current line; any
    // further segments start a new line (and the trailing one keeps
    // the new "current" line for the next piece to append to).
    const segments = piece.split("\n");
    for (let j = 0; j < segments.length; j++) {
      const seg = segments[j]!;
      if (j === 0) {
        current += seg;
      } else {
        // Push the completed line and start a new one. Skip empty
        // lines that arise from consecutive "\n\n" splits.
        if (current.length > 0) lines.push(current);
        current = seg;
      }
    }
  }
  // Flush whatever's left in the in-progress line.
  if (current.length > 0) lines.push(current);
  return lines;
}

// Top-level renderer used by dispatch.ts. Selects the right template
// for the provider, builds the context, and — critically — force-
// appends the m_age stale suffix when the result is `stale` AND the
// template didn't already emit it. This preserves the v0.2.16
// invariant that a stale-on-error tick always carries a visible
// broken-chain indicator, regardless of what the user put in their
// lineTemplate.
export function renderProviderLine(
  provider: import("./types.ts").Provider,
  ctx: Omit<RenderContext, "fiveHour" | "weekly" | "balance" | "tokens" | "contextWindow" | "providerType"> & {
    fiveHour?: Window | null;
    weekly?: Window | null;
    balance?: BalanceLike | null;
    // v0.4.0+ — optional for back-compat with tests/callers that
    // don't thread a TokenSnapshot. Defaults to null, which causes
    // all m_token* modules to skip rendering.
    tokens?: TokenSnapshot | null;
    // v0.4.0+ — optional. Synthesized from tokens.contextWindow.usedPct
    // when omitted. Only read by m_windowContext.
    contextWindow?: Window | null;
  },
): string {
  // v0.4.0+ — synthesize the contextWindow Window from
  // tokens.contextWindow.usedPct when not supplied. formatOneChunk
  // only reads `pct`, so this minimal shape is enough.
  const usedPct = ctx.tokens?.contextWindow?.usedPct;
  const contextWindow =
    ctx.contextWindow !== undefined
      ? ctx.contextWindow
      : usedPct != null
        ? { pct: usedPct }
        : null;
  // v0.2.21: template picked by provider TYPE via providers.ts, not
  // by provider-name literal. Same outward behavior — defaults put
  // TOKEN_PLAN at "plan" and BALANCE at "balance" — but the
  // indirection lets a third provider slot in without code changes.
  //
  // v0.4.0+ — the template is now resolved from `cfg().statuslineTemplate`,
  // which is a top-level rendered-template field. String form is
  // looked up against PLAN_PRESETS / BALANCE_PRESETS (whichever
  // contains the name); array form is passed through unchanged and
  // may include `m_template` references that pull from
  // `cfg().lineTemplates`. The provider type is threaded through to
  // the full ctx so per-module `type` filters can compare against it.
  // v0.4.x — providerTypeFor returns "plan" / "balance" / "unknown"
  // (replaces the older templateKeyForProvider name).
  const providerType = providerTypeFor(provider);
  const cfgSnap = cfg();
  const fullCtx: RenderContext = {
    mode: ctx.mode,
    nowMs: ctx.nowMs,
    fiveHour: ctx.fiveHour ?? null,
    weekly: ctx.weekly ?? null,
    balance: ctx.balance ?? null,
    ageMs: ctx.ageMs,
    stale: ctx.stale,
    version: ctx.version,
    tokens: ctx.tokens ?? null,
    contextWindow,
    providerType,
    // v0.6.0+ — single-owner dedup ref. Propagated by reference
    // through any nested m_template: expansions; each m_age instance
    // (bare + inline-args) checks + sets this slot so the WHOLE render
    // emits ⛓️‍💥/🔗 at most once even when the user's template contains
    // m_age in multiple places.
    ageEmittedRef: { value: false },
  };
  const statuslineRaw = cfgSnap.statuslineTemplate;
  let template: string[];
  if (typeof statuslineRaw === "string") {
    // Provider-aware resolution: a balance provider looks up its
    // preset name against BALANCE_PRESETS (currently "simple" /
    // "simple-alone"); a plan provider looks up against PLAN_PRESETS
    // ("1line", "simple", "standard", …). Each table is searched
    // independently — there is no cross-table fallback, because the
    // two tables hold DIFFERENT shapes (plan = 5h/7d windows;
    // balance = m_balance). Falling back across tables would silently
    // render a plan preset on a balance provider (no m_balance) or
    // a balance preset on a plan provider (no 5h/7d).
    let resolved: string[];
    if (providerType === "balance") {
      resolved = Object.prototype.hasOwnProperty.call(
        BALANCE_PRESETS,
        statuslineRaw,
      )
        ? BALANCE_PRESETS[statuslineRaw].slice()
        : BALANCE_PRESETS["simple"].slice();
    } else {
      resolved = Object.prototype.hasOwnProperty.call(
        PLAN_PRESETS,
        statuslineRaw,
      )
        ? PLAN_PRESETS[statuslineRaw].slice()
        : PLAN_PRESETS["1line"].slice();
    }
    template = resolved;
  } else {
    template = statuslineRaw;
  }
  const lines = renderTemplate(template, fullCtx);
  // Forced visibility for the age annotation (stale-only fallback):
  // when the user did NOT put m_age in their lineTemplate AND the
  // fetch was stale, append the broken-chain suffix to the rendered
  // line. This preserves the v0.2.16 invariant that a network
  // failure is always visible, no matter what the user put in their
  // template.
  //
  // Dedup v0.6.0+ — moved from a top-level string scan
  // (`templateHasAgeModule`, which only saw the outermost tokens and
  // missed m_age nested inside lineTemplates.* fragments) to a
  // render-recursion-aware check: `fullCtx.ageEmittedRef.value`
  // flips to true the moment ANY m_age instance (bare or inline,
  // top-level or nested via m_template:) fires. The first m_age
  // emits; this fallback sees the ref and skips, eliminating the
  // "⛓️‍💥 ⛓️‍💥" double-append the old logic produced.
  if (
    ctx.ageMs != null &&
    ctx.stale &&
    fullCtx.ageEmittedRef !== undefined &&
    !fullCtx.ageEmittedRef.value
  ) {
    fullCtx.ageEmittedRef.value = true;
    const suffix = formatStaleSuffix(ctx.ageMs, false);
    // The suffix carries its own SGR close, so it slots onto the
    // last line regardless of how many lines the template emitted.
    if (lines.length === 0) {
      lines.push(suffix);
    } else {
      lines[lines.length - 1] = (lines[lines.length - 1] ?? "") + suffix;
    }
  }
  return lines.join("\n");
}
