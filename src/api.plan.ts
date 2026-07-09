// v0.5.0+ — fetcher for MiniMax-style /v1/token_plan/remains, data-driven
// via the `parameters` block on the matching ProviderEntry.
//
// Real response shape (verified 2026-06-24):
//   { base_resp: { status_code, status_msg },
//     model_remains: [ { model_name,
//                        current_interval_remaining_percent,
//                        current_weekly_remaining_percent,
//                        start_time, end_time,
//                        weekly_start_time, weekly_end_time, ... }, ... ] }
//
// Parsing rules:
//   - We pick the entry with the LOWEST `current_interval_remaining_percent`
//     (the most-active model) as the source of truth. This used to be
//     hardcoded against a single field name; now it's a regular `parameters`
//     slot, default-mapped to `model_remains.0.current_interval_remaining_percent`.
//   - `usedPercentInterval` and `remainingPercentInterval` are mutually
//     exclusive in the user config — the parser derives the missing one
//     via `100 - x`. Same for the 7-day pair. This is the only
//     derivation; the four canonical slots are pure reads from the API.
//   - `startAtInterval` / `endAtInterval` / `startAtWeekly` / `endAtWeekly`
//     are optional. When BOTH endpoints of a window are present,
//     `resetDurationMs` is computed and threaded through to the renderer
//     (so the fill-state arrow picker has a real window-length signal).
//   - `model_name` and the per-model `*_total_count` / `*_usage_count`
//     fields from older drafts are NOT part of the slot map — they were
//     never used by the renderer, and the new data-driven design only
//     surfaces what the renderer needs.
//
// v0.2.21: endpoint and now also the `parameters` block are passed in
// by the caller (the providers config block in src/config.ts holds
// them). The hardcoded `const ENDPOINT` and the per-field `pickFirst`
// alias lists are gone.

import type { ProviderEntry, IntervalConfig, IntervalKey, IntervalSlotConfig } from "./types.ts";
import { resolveSlot } from "./path-expr.ts";
import * as diagnostics from "./diagnostics.ts";

// v0.9.0+ — `Remains` carries three independent `Interval`s
// instead of the v0.5.0–v0.8.x pair-of-Windows shape. Each term
// (shortInterval / midInterval / longInterval) is parsed from the
// provider response using the rules encoded in `parseRemains`
// below (percent / time / quota group derivation + 3-step
// intervalMs fallback chain). A null value means "the parser found
// no usable data for this term" — `m_window`/`m_countdown`/`m_quota`
// fall back to their per-term placeholder when this happens. The
// renderer-side `Window` projection lives in `intervalToWindow` in
// src/render.ts.
import type { Interval } from "./render";
export type { Interval };

export type Remains = {
  shortInterval: Interval | null;
  midInterval: Interval | null;
  longInterval: Interval | null;
};

// v0.9.0+ — built-in defaults for the `shortInterval` / `midInterval`
// labels. The longInterval has no built-in minimax mapping (the
// /v1/token_plan/remains endpoint doesn't ship a 30-day window),
// so its windowId falls back to "30d" via `DEFAULT_WINDOW_IDS`
// without any default path mappings.
const DEFAULT_WINDOW_IDS: Record<IntervalKey, "5h" | "7d" | "30d"> = {
  shortInterval: "5h",
  midInterval:   "7d",
  longInterval:  "30d",
};

// v0.9.0+ — keyword lookup table for the step-3 intervalMs fallback
// chain. Each key is probed against the response root; if the value
// at that key is a finite number, it's multiplied by the listed
// ms-per-unit factor to produce the final intervalMs. Keys are tried
// in array order (first match wins). The semantic covers the common
// shapes providers ship: `hour` / `fiveHour` / `day` / `sevenDay` /
// `week` / `month` / `year`.
const INTERVAL_MS_KEYWORD_TABLE: ReadonlyArray<readonly [string, number]> = [
  ["hour",     3_600_000],       // 1 hour = 3.6e6 ms
  ["fiveHour", 18_000_000],      // 5 hours = 1.8e7 ms
  ["day",      86_400_000],      // 1 day = 8.64e7 ms
  ["sevenDay", 604_800_000],     // 7 days = 6.048e8 ms
  ["week",     604_800_000],     // 7 days = 6.048e8 ms (alias)
  ["month",    2_592_000_000],   // 30 days = 2.592e9 ms
  ["year",     31_536_000_000],  // 365 days = 3.1536e10 ms
];

// Number coercion shared by all group resolvers. Accepts JS numbers
// and numeric strings; rejects everything else. Used in preference
// to `coerceNumber` from src/path-expr.ts because we sometimes
// coerce values that have already been path-resolved (and don't
// need the path layer's `null → 0` semantics).
function asNumber(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v))) return Number(v);
  return null;
}

// v0.9.0+ — resolve the percent group for a single interval. Reads
// the two percent slot paths from `slot` against the response
// `root`, then applies the derivation rules:
//   - both present → used wins (set remaining = 100 - used)
//   - only one present → derive the other as 100 - x
//   - neither → both null (the interval has no % data; `m_window`
//                falls back to placeholder)
function resolvePercentGroup(
  root: unknown,
  slot: IntervalSlotConfig,
): { remainingPercent: number | null; usedPercent: number | null } {
  const usedRaw = slot.usedPercent
    ? asNumber(resolveSlot(root, slot.usedPercent, "number"))
    : null;
  const remRaw = slot.remainingPercent
    ? asNumber(resolveSlot(root, slot.remainingPercent, "number"))
    : null;
  if (usedRaw != null) {
    return { usedPercent: usedRaw, remainingPercent: 100 - usedRaw };
  }
  if (remRaw != null) {
    return { remainingPercent: remRaw, usedPercent: 100 - remRaw };
  }
  return { remainingPercent: null, usedPercent: null };
}

// v0.9.0+ — resolve the time group for a single interval. Implements
// the 3-step intervalMs fallback chain:
//
//   STEP 1 — path resolution. `slot.intervalMs` / `slot.intervalS`
//            are interpreted as path expressions against `root`. The
//            resolved value becomes the candidate intervalMs (with
//            intervalS multiplied by 1000 to convert seconds to ms).
//   STEP 2 — numeric parse fallback. If step 1 returned null AND
//            `slot.intervalS` / `slot.intervalMs` is a raw number
//            (not a path), use that value directly. This is the
//            "user supplied 18000000 in their config" case.
//   STEP 3 — keyword lookup. If steps 1 + 2 both returned null,
//            probe the response `root` for keys in
//            INTERVAL_MS_KEYWORD_TABLE order. First match wins; the
//            matched numeric value is multiplied by the listed
//            ms-per-unit factor.
//
// After the chain runs, the "at least 2 of 3" rule applies: if only
// one of startAt / endAt / intervalMs is non-null, ALL THREE return
// null (the interval is time-unknown). Otherwise derivation order is:
//
//   - startAt + endAt → use them (explicit wins over intervalMs).
//   - startAt + intervalMs → derive endAt = startAt + intervalMs.
//   - endAt + intervalMs → derive startAt = endAt - intervalMs.
//   - all three → startAt + endAt win.
//
// `slot.startAt` / `slot.endAt` are path expressions for epoch-ms
// numbers. They do NOT participate in the fallback chain — they're
// direct reads against the response.
function resolveTimeGroup(
  root: unknown,
  slot: IntervalSlotConfig,
): { startAt: number | null; endAt: number | null; intervalMs: number | null } {
  const startRaw = slot.startAt
    ? asNumber(resolveSlot(root, slot.startAt, "epochMs"))
    : null;
  const endRaw = slot.endAt
    ? asNumber(resolveSlot(root, slot.endAt, "epochMs"))
    : null;

  // STEP 1 — path resolution for intervalMs / intervalS.
  let intervalMsRaw: number | null = null;
  if (typeof slot.intervalMs === "number" && Number.isFinite(slot.intervalMs)) {
    intervalMsRaw = slot.intervalMs;
  } else if (slot.intervalMs != null) {
    const v = asNumber(resolveSlot(root, String(slot.intervalMs), "number"));
    if (v != null) intervalMsRaw = v;
  } else if (typeof slot.intervalS === "number" && Number.isFinite(slot.intervalS)) {
    intervalMsRaw = slot.intervalS * 1000;
  } else if (slot.intervalS != null) {
    const v = asNumber(resolveSlot(root, String(slot.intervalS), "number"));
    if (v != null) intervalMsRaw = v * 1000;
  }

  // STEP 2 — raw numeric fallback. (slot.intervalS / slot.intervalMs
  // shape covers this already when they're raw numbers — step 1
  // already handled it. The "numeric parse" case in the user spec
  // ("18000000" → 18000000) is the path-resolution case where the
  // path returns a numeric string. That happens inside step 1's
  // asNumber coercion. So step 2 is effectively a no-op when the
  // slot is a plain raw number, which is already covered by step 1
  // above. We keep the structure here for parity with the spec but
  // don't add a duplicate check.)

  // STEP 3 — keyword lookup against the response root. Only fires
  // when steps 1 + 2 both returned null.
  if (intervalMsRaw == null && root && typeof root === "object") {
    const r = root as Record<string, unknown>;
    for (const [key, msPerUnit] of INTERVAL_MS_KEYWORD_TABLE) {
      const v = asNumber(r[key]);
      if (v != null) {
        intervalMsRaw = v * msPerUnit;
        break;
      }
    }
  }

  // At-least-2-of-3 rule: if only one of the three is non-null,
  // discard them all. The interval is "time-unknown" — `m_window`
  // and `m_countdown` fall back to their placeholder.
  const nonNullCount = (startRaw != null ? 1 : 0)
    + (endRaw != null ? 1 : 0)
    + (intervalMsRaw != null ? 1 : 0);
  if (nonNullCount < 2) {
    return { startAt: null, endAt: null, intervalMs: null };
  }

  // Explicit-wins derivation order.
  let startAt = startRaw;
  let endAt = endRaw;
  if (startAt != null && endAt != null) {
    // Both endpoints present — explicit wins. intervalMs is unused
    // (already consumed above); we keep the resolved value for the
    // caller's convenience (it equals endAt - startAt if the user
    // didn't supply a conflicting intervalMs).
    return { startAt, endAt, intervalMs: intervalMsRaw ?? (endAt - startAt) };
  }
  if (startAt != null && intervalMsRaw != null) {
    endAt = startAt + intervalMsRaw;
    return { startAt, endAt, intervalMs: intervalMsRaw };
  }
  if (endAt != null && intervalMsRaw != null) {
    startAt = endAt - intervalMsRaw;
    return { startAt, endAt, intervalMs: intervalMsRaw };
  }
  // Unreachable given the nonNullCount >= 2 gate above, but TS
  // wants the return to be exhaustive.
  return { startAt: null, endAt: null, intervalMs: null };
}

// v0.9.0+ — resolve the quota group for a single interval. Each
// quota field is an independent path expression — there's no
// derivation between remaining / used / limit (unlike the percent
// group). The renderer (`m_quota`) decides what's enough to
// render based on what comes back. Returns all three resolved
// values; any may be null.
function resolveQuotaGroup(
  root: unknown,
  slot: IntervalSlotConfig,
): { remainingQuota: number | null; usedQuota: number | null; limitQuota: number | null } {
  return {
    remainingQuota: slot.remainingQuota
      ? asNumber(resolveSlot(root, slot.remainingQuota, "number"))
      : null,
    usedQuota: slot.usedQuota
      ? asNumber(resolveSlot(root, slot.usedQuota, "number"))
      : null,
    limitQuota: slot.limitQuota
      ? asNumber(resolveSlot(root, slot.limitQuota, "number"))
      : null,
  };
}

// v0.9.0+ — build one `Interval` from a slot config and a response
// root. Returns null when ALL data sources are null — i.e. when
// the interval would render as a pure empty placeholder. A
// time-only interval (percent group all-null, quota group all-null,
// but startAt + endAt present) is treated as null because the
// renderer can't surface it through `m_window` / `m_countdown` /
// `m_quota` — the placeholder would be the only output. We
// preserve the Interval when ANY non-null percent or quota field
// exists so the renderer can at least draw the gauge placeholder
// (m_window → gray bar with 0%) and / or the quota body.
function buildInterval(
  root: unknown,
  slot: IntervalSlotConfig,
  key: IntervalKey,
): Interval | null {
  const percent = resolvePercentGroup(root, slot);
  const time = resolveTimeGroup(root, slot);
  const quota = resolveQuotaGroup(root, slot);

  const hasPercent = percent.remainingPercent != null || percent.usedPercent != null;
  const hasQuota = quota.remainingQuota != null || quota.usedQuota != null || quota.limitQuota != null;
  if (!hasPercent && !hasQuota) return null;

  const windowId = slot.windowId ?? DEFAULT_WINDOW_IDS[key];
  return {
    windowId,
    label: slot.label ?? slot.windowId ?? DEFAULT_WINDOW_IDS[key],
    startAt: time.startAt,
    endAt: time.endAt,
    intervalMs: time.intervalMs,
    remainingPercent: percent.remainingPercent,
    usedPercent: percent.usedPercent,
    remainingQuota: quota.remainingQuota,
    usedQuota: quota.usedQuota,
    limitQuota: quota.limitQuota,
  };
}

// v0.9.0+ — pick the most-active entry from `model_remains[]`. The
// scoring signal is the resolved used% (or remaining%, converted to
// used-equivalent) of the `shortInterval` — the same short-window
// metric that drove the v0.8.x `pickMostActiveIndex`. Returns -1
// when no percent path is mapped for shortInterval (the caller
// falls through to the non-array branch).
//
// The choice of shortInterval (5h) as the picker signal is
// deliberate: the 5h window is the most reactive (resets most
// often, has the tightest "almost out" signal), so picking by it
// gives the renderer the most-current model usage reading.
function pickMostActiveIndex(
  arr: unknown[],
  intervalsConfig: IntervalConfig,
): number {
  if (arr.length === 0) return -1;
  const short = intervalsConfig?.shortInterval;
  if (!short) return -1;
  const remainingPath = short.remainingPercent;
  const usedPath = short.usedPercent;
  if (!remainingPath && !usedPath) return -1;
  function reindexTail(path: string, idx: number): string {
    const tail = path.replace(
      /^(model_remains|modelRemains)\.?\[?0\]?\.?/,
      "",
    );
    return tail ? `model_remains.${idx}.${tail}` : `model_remains.${idx}`;
  }
  const root = { model_remains: arr };
  let bestIdx = 0;
  let bestScore = -Infinity;
  for (let i = 0; i < arr.length; i++) {
    let usedEquiv: number | null = null;
    if (remainingPath) {
      const v = asNumber(resolveSlot(root, reindexTail(remainingPath, i), "number"));
      if (v != null) usedEquiv = 100 - v;
    }
    if (usedEquiv == null && usedPath) {
      const v = asNumber(resolveSlot(root, reindexTail(usedPath, i), "number"));
      if (v != null) usedEquiv = v;
    }
    const score = usedEquiv ?? 0;
    if (score > bestScore) {
      bestScore = score;
      bestIdx = i;
    }
  }
  return bestIdx;
}

// Swap the leading `model_remains.0` (or `[0]`) of each path in
// every slot config for the chosen index. Walks all three terms;
// paths that don't start with `model_remains` are left untouched.
function reindexPaths(
  config: IntervalConfig,
  idx: number,
): IntervalConfig {
  const out: IntervalConfig = {};
  for (const k of ["shortInterval", "midInterval", "longInterval"] as IntervalKey[]) {
    const slot = config?.[k];
    if (!slot) continue;
    const next: IntervalSlotConfig = {};
    for (const [field, value] of Object.entries(slot)) {
      if (typeof value === "string") {
        next[field as keyof IntervalSlotConfig] = value.replace(
          /^(model_remains|modelRemains)\.?\[?0\]?\.?/,
          `$1.${idx}.`,
        ) as never;
      } else {
        // Numeric fields (intervalS / intervalMs) are passed through
        // unchanged.
        (next as Record<string, unknown>)[field] = value;
      }
    }
    out[k] = next;
  }
  return out;
}

export function parseRemains(
  raw: unknown,
  _provider: ProviderEntry | null = null,
  intervalsConfig: IntervalConfig = {},
): Remains | null {
  if (!raw || typeof raw !== "object") return null;
  const root = raw as Record<string, unknown>;

  // Non-zero base_resp.status_code -> failure.
  const baseResp = root.base_resp;
  if (baseResp && typeof baseResp === "object") {
    const code = asNumber((baseResp as Record<string, unknown>).status_code);
    if (code !== null && code !== 0) return null;
  }

  const arr = root.model_remains ?? root.modelRemains;

  let scopeRoot: unknown = root;
  if (Array.isArray(arr) && arr.length > 0) {
    const chosenIdx = pickMostActiveIndex(arr, intervalsConfig);
    if (chosenIdx >= 0) {
      // Re-bind each path to point at this specific index. The user
      // wrote `model_remains.0.start_time`; we replace the trailing
      // `.0` / `[0]` with the chosen index.
      const reindexed = reindexPaths(intervalsConfig, chosenIdx);
      const short = buildInterval(scopeRoot, reindexed.shortInterval ?? {}, "shortInterval");
      const mid = buildInterval(scopeRoot, reindexed.midInterval ?? {}, "midInterval");
      const long = buildInterval(scopeRoot, reindexed.longInterval ?? {}, "longInterval");
      if (short || mid || long) {
        return { shortInterval: short, midInterval: mid, longInterval: long };
      }
    }
  }

  // Non-array root case (e.g. kimi's `{ usages: [...], totalQuota: {...} }`).
  // The intervals config paths are interpreted as literal key chains
  // from the response root, no array-picking / re-indexing needed.
  // Skipping this branch when the caller didn't supply any intervals
  // config keeps the "no data → null" contract.
  const hasAnySlot =
    intervalsConfig?.shortInterval ||
    intervalsConfig?.midInterval ||
    intervalsConfig?.longInterval;
  if (hasAnySlot) {
    const short = buildInterval(scopeRoot, intervalsConfig?.shortInterval ?? {}, "shortInterval");
    const mid = buildInterval(scopeRoot, intervalsConfig?.midInterval ?? {}, "midInterval");
    const long = buildInterval(scopeRoot, intervalsConfig?.longInterval ?? {}, "longInterval");
    if (short || mid || long) {
      return { shortInterval: short, midInterval: mid, longInterval: long };
    }
  }

  return null;
}

export async function fetchRemains(
  token: string,
  endpoint: string,
  signal?: AbortSignal,
  provider: ProviderEntry | null = null,
): Promise<Remains | null> {
  // v0.6.0+ — entry.BEARER_KEY wins over the env-sourced `token` arg.
  // The `token` arg is still passed in (the dispatcher pre-reads
  // process.env.ANTHROPIC_AUTH_TOKEN) so the call signature is
  // stable; the entry just shadows it when present. Empty on both
  // axes → return null without touching the network.
  const authToken = provider?.BEARER_KEY ?? token;
  if (!authToken) return null;
  const method = provider?.METHOD ?? "GET";
  // Send a body only when METHOD is not GET AND the user supplied
  // one. A GET with a body is rejected by the spec; some servers
  // tolerate it but the WHATWG fetch impl drops it silently, so we
  // never put one on the wire for GET regardless of config. DELETE
  // with a body is allowed by the spec but unusual; we forward it
  // faithfully because the user's config is the source of truth.
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
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      signal,
      ...(bodyJson !== undefined ? { body: bodyJson } : {}),
    });
  } catch (e) {
    // v0.6.x+ — log the network error to diagnostics. The error
    // message is what the WHATWG fetch impl produces ("fetch
    // failed", "ECONNREFUSED", "aborted", etc.) and never includes
    // the auth token — the token lives in the request header and
    // is not echoed in failures. We log here (at the network
    // access point) rather than in the dispatcher so the record
    // reflects what the fetcher actually saw, not how the caller
    // chose to label the result (stale / fail / null). Level
    // "warning" matches the existing config-parse warnings; the
    // statusline continues to run normally via stale-on-error.
    diagnostics.append(
      "warning", "fetch",
      `token_plan/remains ${endpoint}: ${(e as Error).message ?? String(e)}`,
      Date.now(),
    );
    throw e;
  }
  if (!res.ok) {
    const msg = `token_plan/remains HTTP ${res.status}`;
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
  // v0.9.0+ — thread the provider's `intervals` block into the
  // parser. Built-in minimax defaults are already applied by
  // validateProviderEntry, so this is just the user-supplied
  // overrides (or the built-in defaults if the user supplied
  // none). Legacy `parameters` field is gone.
  return parseRemains(parsed, provider, provider?.intervals);
}
