// Fetcher + parser for a DeepSeek-style /user/balance endpoint.
//
// Real shape (verified against the user-supplied schema 2026-06-26):
//   { is_available: true,
//     balance_infos: [
//       { currency: "CNY",
//         total_balance: "110.00",
//         granted_balance: "10.00",
//         topped_up_balance: "100.00" },
//       ... possibly more entries, one per currency ...
//     ] }
//
// We render EVERY entry in balance_infos (joined by " · ") — DeepSeek may
// return multiple currencies and the user wants them all visible. The line's
// color band is driven by the LOWEST total_balance across the entries, so
// the most-urgent currency is the one that pops visually.
//
// v0.2.21: endpoint is now passed in by the caller (the providers
// config block in src/config.ts holds the URL). The hardcoded
// `const ENDPOINT` is gone. The URL gate that previously lived here
// is now config-driven via matchProvider() in src/providers.ts; a
// deprecated shim is kept below for one minor version.

import { configStore } from "./config.ts";
import type { ProviderEntry } from "./types.ts";
import * as diagnostics from "./diagnostics.ts";

export type BalanceEntry = {
  currency: string;
  totalBalance: number;
};

export type Balance = {
  isAvailable: boolean;
  entries: BalanceEntry[];
  // Precomputed lowest total_balance across entries (null when there are
  // no parseable entries). Drives the renderer's color band.
  minValue: number | null;
};

function asNumber(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v))) {
    return Number(v);
  }
  return null;
}

function normalizeEntry(raw: unknown): BalanceEntry | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const totalBalance = asNumber(r.total_balance);
  if (totalBalance == null) return null;
  const currency = typeof r.currency === "string" && r.currency !== ""
    ? r.currency
    : configStore.get().currency.default;
  return { currency, totalBalance };
}

export function parseBalance(raw: unknown): Balance | null {
  if (!raw || typeof raw !== "object") return null;
  const root = raw as Record<string, unknown>;

  // DeepSeek uses `is_available: true | false`. The contract for the
  // standard balance schema (src/__fixtures__/balance.schema.json) is:
  //   explicit false (or string "false")  → isAvailable = false
  //                                           (account locked / suspended)
  //   explicit true  (or 1, "true")        → isAvailable = true
  //   missing / null / undefined           → fallback = true
  //                                           (optimistic render; most
  //                                            non-DeepSeek providers
  //                                            don't ship the flag at all)
  //
  // Implementation: build the "is explicitly false" gate, invert it.
  // The string "false" branch preserves the v0.5.x tolerance contract
  // (see `api.deepseek.test.ts:tolerates truthy/falsy variants`) — a
  // string-encoded `false` from a misconfigured plugin still falls
  // into the unavailable branch instead of rendering placeholder.
  const availRaw = root.is_available;
  const explicitlyFalse =
    availRaw === false ||
    (typeof availRaw === "string" && availRaw.toLowerCase() === "false");
  const isAvailable = !explicitlyFalse;

  const arr = root.balance_infos;
  let entries: BalanceEntry[] = [];
  if (Array.isArray(arr)) {
    entries = arr.map(normalizeEntry).filter((e): e is BalanceEntry => e !== null);
  }

  if (!isAvailable) {
    return { isAvailable: false, entries, minValue: entries.length === 0 ? null : Math.min(...entries.map((e) => e.totalBalance)) };
  }

  let minValue: number | null = null;
  if (entries.length > 0) {
    minValue = entries[0].totalBalance;
    for (let i = 1; i < entries.length; i++) {
      if (entries[i].totalBalance < minValue) minValue = entries[i].totalBalance;
    }
  }

  return { isAvailable: true, entries, minValue };
}

export async function fetchBalance(
  token: string,
  endpoint: string,
  signal?: AbortSignal,
  // v0.6.0+ — entry parameter mirrors fetchRemains so the BALANCE
  // dispatcher can pass per-provider BEARER_KEY / METHOD / BODY
  // overrides. Default null preserves the v0.5.x call sites that
  // don't yet pass an entry.
  provider: ProviderEntry | null = null,
): Promise<Balance | null> {
  // v0.6.0+ — entry.BEARER_KEY wins over the env-sourced `token`
  // arg, matching the fetchRemains contract. See api.plan.ts for the
  // full rationale on the empty-token early return.
  const authToken = provider?.BEARER_KEY ?? token;
  if (!authToken) return null;
  const method = provider?.METHOD ?? "GET";
  const bodyJson =
    method !== "GET" && provider?.BODY !== undefined
      ? JSON.stringify(provider.BODY)
      : undefined;
  let res: Response;
  try {
    res = await fetch(endpoint, {
      method,
      headers: {
        Authorization: `Bearer ${authToken}`,
        Accept: "application/json",
      },
      signal,
      ...(bodyJson !== undefined ? { body: bodyJson } : {}),
    });
  } catch (e) {
    // v0.6.x+ — log the network error to diagnostics at the
    // network access point. Mirrors fetchRemains' logging. The
    // WHATWG fetch impl never echoes the auth token in its error
    // message, so logging `(e as Error).message` is safe.
    diagnostics.append(
      "warning", "fetch",
      `deepseek /user/balance ${endpoint}: ${(e as Error).message ?? String(e)}`,
      Date.now(),
    );
    throw e;
  }
  if (!res.ok) {
    const msg = `deepseek /user/balance HTTP ${res.status}`;
    diagnostics.append("warning", "fetch", `${msg} (${endpoint})`, Date.now());
    throw new Error(msg);
  }
  const text = await res.text();
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  return parseBalance(parsed);
}

// v0.2.21: kept as a thin shim for one minor version so external
// callers don't break. Preserves the v0.2.20 prefix-with-suffix-guard
// behavior so `api.deepseek.com.evil.example` is still rejected; the
// configured `COMPARE_METHOD` is ignored here, since this shim
// predates the providers config block.
const DEEPSEEK_PREFIX = "https://api.deepseek.com";

/**
 * @deprecated v0.2.21: use `matchProvider(baseUrl) === "deepseek"`
 * from src/providers.ts.
 */
export function isDeepSeekBaseUrl(baseUrl: string | undefined | null): boolean {
  if (!baseUrl) return false;
  const lower = baseUrl.toLowerCase();
  if (!lower.startsWith(DEEPSEEK_PREFIX)) return false;
  // Reject suffix attacks: next char after the prefix must be
  // undefined, "/", "?", or "#".
  const tail = baseUrl[DEEPSEEK_PREFIX.length];
  return tail === undefined || tail === "/" || tail === "?" || tail === "#";
}
