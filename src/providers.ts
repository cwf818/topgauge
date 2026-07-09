// v0.2.21: provider registry — URL matching, fetcher dispatch, and
// template / fail-label routing. Replaces the v0.2.20 hardcoded
// `resolveProvider` + per-provider `getRemainsData` / `getBalanceData`
// with a config-driven dispatch where adding a new provider is a
// config-only change.
//
// All functions in this module read from `configStore.get().providers`
// at call time, so config changes via `__resetForTest` are picked up
// on the next call (no module-level state).

import { configStore } from "./config.ts";
import type {
  CompareMethod,
  Provider,
  ProviderEntry,
  ProviderType,
} from "./types.ts";
import { fetchRemains } from "./api.plan.ts";
import { fetchBalance } from "./api.balance.ts";

// ----- URL matching -----

// Three modes, all case-insensitive (matches the v0.2.20 behavior of
// the hardcoded MiniMax / DeepSeek matchers, both of which called
// `.toLowerCase()` on the URL before comparing).
//
// `STARTWITH` has an extra suffix-attack guard: the character right
// after the prefix must be undefined (end of string), "/", "?", or
// "#". This rejects `https://api.deepseek.com.evil.example` even
// though it technically `startsWith("https://api.deepseek.com")` —
// the "." immediately after the prefix is not a valid boundary.
export function compareUrl(
  method: CompareMethod,
  baseUrl: string,
  pattern: string,
): boolean {
  const url = baseUrl.toLowerCase();
  const pat = pattern.toLowerCase();
  switch (method) {
    case "EXACT":
      return url === pat;
    case "INCLUDE":
      return url.includes(pat);
    case "STARTWITH": {
      if (!url.startsWith(pat)) return false;
      const tail = baseUrl[pattern.length];
      // undefined = exact match (no char after the prefix); /, ?, #
      // are the legal boundary characters.
      return tail === undefined || tail === "/" || tail === "?" || tail === "#";
    }
  }
}

// Find the first provider whose entry matches the given ANTHROPIC_BASE_URL.
// Returns the provider name (the map key) or null if no entry matches.
// Iteration order = insertion order of `configStore.get().providers`,
// so a user whose config puts `minimax` first will see that take
// precedence on a tie.
export function matchProvider(
  baseUrl: string | undefined | null,
): Provider {
  if (!baseUrl) return null;
  const providers = configStore.get().providers;
  for (const [name, entry] of Object.entries(providers)) {
    if (compareUrl(entry.COMPARE_METHOD, baseUrl, entry.BASE_URL_COMPARED_TO)) {
      return name;
    }
  }
  return null;
}

// Look up a provider's full entry by name. Returns null if the
// provider isn't registered (shouldn't happen for a name returned
// from matchProvider, but the call sites use null-checking for
// defensive narrowing).
export function getProviderEntry(provider: Provider): ProviderEntry | null {
  if (provider == null) return null;
  const providers = configStore.get().providers;
  return providers[provider] ?? null;
}

// ----- Type-driven dispatch -----

// Fetch the provider's data via the appropriate fetcher, hitting the
// configured ENDPOINT. Returns the parsed data shape (Remains for
// TOKEN_PLAN, Balance for BALANCE). Throws on network/HTTP error
// (caller catches and falls back to stale cache).
//
// The `unknown` return type is intentional: callers narrow at the
// call site based on `entry.TYPE`. This keeps providers.ts ignorant
// of the concrete data shapes.
export async function fetchForProvider(
  provider: Provider,
  token: string,
  signal: AbortSignal,
): Promise<unknown> {
  const entry = getProviderEntry(provider);
  if (!entry) throw new Error(`unknown provider: ${String(provider)}`);
  if (entry.TYPE === "TOKEN_PLAN") {
    return fetchRemains(token, entry.ENDPOINT, signal, entry);
  }
  if (entry.TYPE === "BALANCE") {
    return fetchBalance(token, entry.ENDPOINT, signal, entry);
  }
  // Exhaustiveness check: a new ProviderType value without a fetcher
  // branch will fail to compile here.
  const _exhaustive: never = entry.TYPE;
  throw new Error(`unsupported provider TYPE: ${_exhaustive}`);
}

// The "fail" line's prefix label, picked from modeLabels based on
// TYPE. Replaces the hardcoded `"Usage: "` / `"Balance: "` literals
// previously in dispatch.ts:68-69 and render.ts:503.
export function failLabelForProvider(provider: Provider): string {
  const entry = getProviderEntry(provider);
  const modeLabels = configStore.get().modeLabels;
  if (!entry) return modeLabels.used;
  if (entry.TYPE === "TOKEN_PLAN") return modeLabels.used;
  return modeLabels.balance;
}

// Map a provider's TYPE to the renderer-facing type discriminator.
// `TOKEN_PLAN → "plan"`, `BALANCE → "balance"`, and null entry (no
// matching ANTHROPIC_BASE_URL) → `"unknown"`. The renderer uses
// this as the per-module `type` filter comparison target, and as
// the m_modeLabel routing key. Replaces the older
// `provider === "minimax" ? cfg().lineTemplate.plan : …` switch in
// render.ts, AND replaces the older `templateKeyForProvider` name
// — kept as a deprecated alias below for the build's lifetime.
//
// v0.4.x — return type widened to include `"unknown"`. Previously
// null entry fell through to `"plan"` so a user with no configured
// provider but a default plan template still rendered the plan
// line. With Phase 2 of the provider-agnostic refactor we want a
// distinct value here so:
//
//   1. `m_modeLabel` can choose a dedicated label for the "no
//      provider configured" case (vs "this provider is plan type").
//   2. Per-module `type` filters can opt-in to the unknown case
//      independently of plan. (None exist today; reserved for
//      future use.)
//   3. `m_template:plan:mode:plan` and the equivalent `m_window5h`
//      module still drop on unknown — that's the same as plan-only
//      modules dropping on balance.
//
// Note: `mode` is reserved for the display-mode field on
// RenderContext (`used` / `remaining` / `balance`); the per-module
// discriminator is now `type` to avoid collision. See render.ts.
export function providerTypeFor(
  provider: Provider,
): "plan" | "balance" | "unknown" {
  const entry = getProviderEntry(provider);
  if (!entry) return "unknown";
  if (entry.TYPE === "TOKEN_PLAN") return "plan";
  return "balance";
}

// Back-compat alias — older callers referenced `templateKeyForProvider`.
// Kept as a deprecated re-export for one release cycle; remove after
// callers migrate. Body is identical to providerTypeFor.
export const templateKeyForProvider = providerTypeFor;

// TYPE-only accessor — for code paths that have the entry in hand
// already and just want the discriminator.
export function providerTypeOf(provider: Provider): ProviderType | null {
  return getProviderEntry(provider)?.TYPE ?? null;
}