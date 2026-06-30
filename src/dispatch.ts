// Provider dispatch: maps a (provider, fetch-result) pair to a statusline
// line. Extracted from index.ts so it can be exercised by tests without
// touching process.stdin / process.env (and without importing index.ts,
// which has top-level `await main()` side effects).
//
// Three outcomes the provider data layer can report:
//   fresh — we successfully obtained the data (from network or from a
//           within-TTL cache hit); `ageMs` is the time since the entry
//           was cached. The renderer's m_age module and forced-visibility
//           append both gate on `stale === true`, so fresh ticks render
//           no age suffix regardless of ageMs.
//   stale — fetch failed but a cached value exists; `ageMs` is how long
//           it's been since the last successful fetch (from cache.Entry.at).
//           `stale=true` triggers the broken-chain suffix (e.g. "⛓️‍💥 5m ago")
//           via either the m_age module or the forced-visibility append.
//   fail  — fetch failed AND no cached value; caller renders "not available!"
//
// v0.2.21: switched from provider-name literals ("minimax" /
// "deepseek") to TYPE-based dispatch. buildProviderLine now reads
// the provider's `TYPE` field from the providers config block and
// routes accordingly. Adding a new TOKEN_PLAN or BALANCE provider
// is a config-only change.
//
// v0.4.x: collapsed the per-TYPE helpers (renderPlanLine +
// formatBalanceLine) into a single renderDataLine that reads the
// provider's TYPE only to pick which ctx fields to populate
// (fiveHour/weekly vs balance). The renderer-side per-module
// `mode` filter (see render.ts MODULES / INLINE_MODE_FILTERS)
// handles "plan-only module on a balance ctx" silently.

import type { Remains } from "./api.ts";
import type { Balance } from "./api.deepseek.ts";
import {
  RED,
  renderProviderLine,
  RESET,
  resolveDisplayMode,
} from "./render.ts";
import { configStore } from "./config.ts";
import {
  failLabelForProvider,
  getProviderEntry,
} from "./providers.ts";
import type { Provider, TokenSnapshot } from "./types.ts";

export type FetchResult<T> =
  | { kind: "fresh"; data: T; ageMs: number }
  | { kind: "stale"; data: T; ageMs: number }
  | { kind: "fail" };

// v0.4.x — single adapter that converts a (provider, data) pair to
// the right ctx fields for renderProviderLine. Replaces the older
// `renderPlanLine` + `formatBalanceLine` paths in buildProviderLine:
// those two helpers hardcoded their data shape (TOKEN_PLAN expects
// fiveHour + weekly; BALANCE expects Balance), and the dispatcher
// forked on entry.TYPE to pick one. Now both shapes flow through
// here. The provider's TYPE controls which ctx fields are
// populated; the renderer's per-module `mode` filter handles
// "plan-only module on a balance ctx" silently, so we no longer
// need a TYPE switch on the caller's side. renderProviderLine
// itself picks the template via templateKeyForProvider +
// statuslineTemplate.
//
// Returns null only when data is shape-incompatible with the
// resolved TYPE (returns null as today).
//
// ageMs / stale semantics (unchanged):
//   fresh.ageMs : 0 for a just-fetched tick; the cache age for a
//                 within-TTL cache hit. Renderer suppresses the
//                 suffix on fresh ticks (stale=false gate).
//   stale.ageMs : how long since the last successful fetch.
//                 Renderer appends "⛓️‍💥 Xm ago" (or "0s ago" if the
//                 fetch just failed).
function renderDataLine(
  provider: Provider,
  data: unknown,
  ageMs: number,
  stale: boolean,
  tokens: TokenSnapshot | null,
): string | null {
  const entry = getProviderEntry(provider);
  const mode = resolveDisplayMode();
  // The Phase 1 callers (buildProviderLine's gated path +
  // renderPlanLine's back-compat shim) always pass a provider
  // string with a configured entry. We still guard for null here
  // because Phase 2 will start passing `null` deliberately. Until
  // then, this is defensive.
  if (!entry) return null;
  if (entry.TYPE === "TOKEN_PLAN") {
    const r = data as Remains;
    // The old renderPlanLine had a partial-window fallback:
    // when only fiveHour (or only weekly) was present, it would
    // synthesize a {pct:0} window for the missing side and still
    // render. That logic moves here now — renderProviderLine no
    // longer special-cases null windows (it expects both ctx
    // fields populated), so we hard-fill them before delegating.
    // If neither window is present, return null (legacy behavior).
    const zero = { pct: 0 } as const;
    const fiveHour = r.fiveHour ?? (r.weekly ? zero : null);
    const weekly = r.weekly ?? (r.fiveHour ? zero : null);
    if (!fiveHour || !weekly) return null;
    return renderProviderLine(provider, {
      mode,
      nowMs: Date.now(),
      fiveHour,
      weekly,
      ageMs,
      stale,
      version: configStore.get().version,
      tokens,
    });
  }
  if (entry.TYPE === "BALANCE") {
    return renderProviderLine(provider, {
      mode,
      nowMs: Date.now(),
      balance: data as Balance,
      ageMs,
      stale,
      version: configStore.get().version,
      tokens,
    });
  }
  return null;
}

// Maps a (provider, FetchResult) pair to the final statusline line.
//
// v0.2.21: dispatch is driven by `entry.TYPE` from the providers
// config, not by provider-name literals. The fail-line prefix is
// read via `failLabelForProvider(provider)` so a user who overrides
// `modeLabels.used` / `modeLabels.balance` sees their custom label
// on the fail branch too.
//
// v0.4.0+ — also threads `tokens` (live stdin snapshot) through so
// token modules get their data. Fail paths render the colored "not
// available!" string WITHOUT token data — a user whose provider is
// unreachable shouldn't see token counts (would be confusing) but
// CAN opt to include them via a m_token* module that reads the live
// snapshot; we honor that by still passing tokens on fail.
//
// v0.4.x — collapsed: previously dispatched on `entry.TYPE` to
// renderPlanLine (TOKEN_PLAN) or formatBalanceLine (BALANCE) and
// the per-TYPE helpers hardcoded their data shape. Now every path
// funnels through renderDataLine, which reads TYPE only to pick
// the right ctx fields (`fiveHour`/`weekly` vs `balance`) and
// delegates the rest to renderProviderLine + the per-module
// `mode` filter. The fail-with-tokens branch was already a
// renderProviderLine call (it's been template-routed since v0.4.0);
// the bare-tokens-fail "Usage: not available!" branch is preserved
// verbatim for v0.2.20 byte-for-byte compatibility.
//
// Display mode lives in configStore — the old TOKENPLAN_DISPLAY env
// var is gone (see README "Configuration"). For fresh ticks the
// m_age suffix is suppressed; for stale ticks the renderer appends
// the broken-chain "X ago" annotation (the m_age module OR the
// forced-visibility fallback, whichever fires first).
export function buildProviderLine(
  provider: Provider,
  result: FetchResult<unknown>,
  tokens?: TokenSnapshot | null,
): string | null {
  const entry = getProviderEntry(provider);
  if (!entry) return null;
  if (result.kind === "fail") {
    // No cached data + fetch failed. Render a colored "not available!"
    // so the user sees the plugin is alive but the provider is
    // unreachable. Color matches the existing "is_available: false"
    // branch in formatBalanceLine (RED) so the two unavailable states
    // look the same on screen.
    //
    // `failLabelForProvider` returns the modeLabel verbatim (no
    // trailing space — m_modeLabel module relies on s_0 separators in
    // the lineTemplate). The fail-line path doesn't go through the
    // template, so we re-attach the space here to preserve the
    // v0.2.20 output ("Usage: not available!" / "Balance: not available!").
    //
    // v0.4.0+: still pass tokens through so a user's lineTemplate can
    // include m_tokenIn/m_tokenOut alongside the fail-line — they
    // render their own module output, independent of provider state.
    if (tokens) {
      // Render the fail label as a minimal template (just the label
      // module) so the m_token* modules can still emit alongside.
      // Without this, fail paths would skip the template entirely
      // and the user's opt-in token modules would never render.
      // We use the lineTemplate-style render so separators and
      // module skipping rules match the success path exactly.
      return renderProviderLine(provider, {
        mode: resolveDisplayMode(),
        nowMs: Date.now(),
        ageMs: null,
        stale: true,
        version: configStore.get().version,
        tokens,
      });
    }
    return `${failLabelForProvider(provider)} ${RED}not available!${RESET}`;
  }
  return renderDataLine(
    provider,
    result.data,
    result.ageMs,
    result.kind === "stale",
    tokens ?? null,
  );
}

// v0.4.x — back-compat shim. Tests outside this file may call
// renderPlanLine directly; no external callers exist since v0.2.21
// (the only public surface in production is buildProviderLine).
// Kept as a thin delegation so future test cleanups are decoupled
// from this refactor. The previous body had a partial-window
// fallback that hard-filled the missing window with {pct:0}; that
// behavior moved into renderDataLine above, so this shim is now
// a one-liner. The legacy `mode` argument is ignored — callers
// that need a non-default display mode should configure
// `display: "remaining"` in config.json (the v0.2.x migration path
// from TOKENPLAN_DISPLAY).
export function renderPlanLine(
  data: Remains,
  _mode: ReturnType<typeof resolveDisplayMode>,
  ageMs?: number,
  stale: boolean = false,
  tokens?: TokenSnapshot | null,
): string | null {
  void _mode;
  if (!data.fiveHour && !data.weekly) return null;
  return renderDataLine(
    "minimax",
    data,
    ageMs ?? 0,
    stale,
    tokens ?? null,
  );
}