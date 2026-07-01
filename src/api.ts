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

import type { Window } from "./render.ts";
import type { ProviderEntry } from "./types.ts";
import { resolveSlot } from "./path-expr.ts";

export type Remains = {
  fiveHour: Window | null;
  weekly: Window | null;
};

// v0.5.0+ — slot names and their type coercions. Same key shape the
// user writes in config.json's `providers.<name>.parameters` block.
// Per-slot type enforcement is the parser's job; the renderer never
// sees a string in a number slot.
type SlotName =
  | "remainingPercentInterval"
  | "usedPercentInterval"
  | "remainingPercentWeekly"
  | "usedPercentWeekly"
  | "startAtInterval"
  | "endAtInterval"
  | "startAtWeekly"
  | "endAtWeekly"
  | "isAvailable";

const SLOT_TYPES: Record<SlotName, "number" | "epochMs" | "boolean" | "any"> = {
  remainingPercentInterval: "number",
  usedPercentInterval: "number",
  remainingPercentWeekly: "number",
  usedPercentWeekly: "number",
  startAtInterval: "epochMs",
  endAtInterval: "epochMs",
  startAtWeekly: "epochMs",
  endAtWeekly: "epochMs",
  isAvailable: "boolean",
};

// Default minimax slot map. Used when the user's config doesn't supply
// one (so the v0.4.x out-of-the-box behavior is preserved). The
// bracket-less form matches the fixture's real key layout.
export const DEFAULT_MINIMAX_PARAMETERS: Record<string, string> = {
  remainingPercentInterval: "model_remains.0.current_interval_remaining_percent",
  remainingPercentWeekly:   "model_remains.0.current_weekly_remaining_percent",
  startAtInterval:          "model_remains.0.start_time",
  endAtInterval:            "model_remains.0.end_time",
  startAtWeekly:            "model_remains.0.weekly_start_time",
  endAtWeekly:              "model_remains.0.weekly_end_time",
};

// Pull the active parameters map for a given provider, falling back
// to the default for known names. Unknown providers get an empty
// map (caller will see all nulls → render nothing).
function parametersFor(provider: ProviderEntry | null): Record<string, string> {
  if (!provider) return {};
  if (provider.parameters) return provider.parameters;
  if (provider.TYPE === "TOKEN_PLAN" && provider.ENDPOINT.includes("minimaxi.com")) {
    return DEFAULT_MINIMAX_PARAMETERS;
  }
  return {};
}

function asNumber(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v))) return Number(v);
  return null;
}

function tsToIso(ms: number | null): string | null {
  if (ms == null) return null;
  try {
    return new Date(ms).toISOString();
  } catch {
    return null;
  }
}

// Per-window read. Walks all four slots (used + remaining + start + end)
// and produces a single Window. The "used + remaining = 100" derivation
// happens HERE: if the user mapped only `usedPercentInterval`, the
// remaining-percent is computed before the window is built. If they
// mapped only `remainingPercentInterval`, used% is computed. If they
// mapped both (uncommon but allowed), used wins (it matches the
// "what fraction did I burn" mental model).
type WindowSlots = {
  usedPct: number | null;
  startMs: number | null;
  endMs: number | null;
};

function readWindowSlots(
  root: unknown,
  params: Record<string, string>,
  prefix: "Interval" | "Weekly",
): WindowSlots {
  function readNumber(name: SlotName): number | null {
    const path = params[name];
    if (!path) return null;
    const v = resolveSlot(root, path, SLOT_TYPES[name]);
    return asNumber(v);
  }
  function readEpoch(name: SlotName): number | null {
    const path = params[name];
    if (!path) return null;
    const v = resolveSlot(root, path, SLOT_TYPES[name]);
    return asNumber(v);
  }
  const usedRaw = readNumber(`usedPercent${prefix}` as SlotName);
  const remRaw = readNumber(`remainingPercent${prefix}` as SlotName);
  // Derivation: if both present, used wins; if only one present, derive
  // the other; if neither, the window is missing entirely.
  let usedPct: number | null;
  if (usedRaw != null) {
    usedPct = usedRaw;
  } else if (remRaw != null) {
    usedPct = 100 - remRaw;
  } else {
    usedPct = null;
  }
  return {
    usedPct,
    startMs: readEpoch(`startAt${prefix}` as SlotName),
    endMs: readEpoch(`endAt${prefix}` as SlotName),
  };
}

function slotsToWindow(s: WindowSlots): Window | null {
  if (s.usedPct == null) return null;
  const resetIso = tsToIso(s.endMs);
  const startIso = tsToIso(s.startMs);
  let durationMs: number | null = null;
  if (s.startMs != null && s.endMs != null && s.endMs > s.startMs) {
    durationMs = s.endMs - s.startMs;
  }
  const w: Window = {
    pct: Math.max(0, Math.min(100, s.usedPct)),
    resetAt: resetIso,
  };
  if (startIso !== null) w.resetStartAt = startIso;
  if (durationMs !== null) w.resetDurationMs = durationMs;
  return w;
}

// Pick the most-active entry from `model_remains[]`. Returns the
// INDEX of the chosen entry so the caller can re-bind the user's
// `parameters` paths to that specific entry. See `pickMostActiveIndex`
// below for the full scoring rules.
//
// The "most-active" model is the one whose 5h window is closest to
// exhausted. On the `used` axis that's the LARGEST used%; on the
// `remaining` axis (the original minimax signal) that's the
// SMALLEST remaining%. We unify by reading whichever the user
// mapped and converting to a "used% equivalent" for comparison.

export function parseRemains(
  raw: unknown,
  provider: ProviderEntry | null = null,
): Remains | null {
  if (!raw || typeof raw !== "object") return null;
  const root = raw as Record<string, unknown>;

  // Non-zero base_resp.status_code -> failure.
  const baseResp = root.base_resp;
  if (baseResp && typeof baseResp === "object") {
    const code = asNumber((baseResp as Record<string, unknown>).status_code);
    if (code !== null && code !== 0) return null;
  }

  const params = parametersFor(provider);
  const arr = root.model_remains ?? root.modelRemains;
  if (Array.isArray(arr) && arr.length > 0) {
    const chosenIdx = pickMostActiveIndex(arr, params);
    if (chosenIdx >= 0) {
      // Re-bind each slot path to point at this specific index. The
      // user wrote `model_remains.0.start_time` (or the bracket
      // equivalent); we replace the trailing `.0` / `[0]` with the
      // chosen index. This keeps the user's `parameters` config
      // independent of WHICH entry we'll pick — they describe the
      // shape, we describe the instance.
      const reindexed = reindexPaths(params, chosenIdx);
      const interval = slotsToWindow(readWindowSlots(root, reindexed, "Interval"));
      const weekly = slotsToWindow(readWindowSlots(root, reindexed, "Weekly"));
      // Require at least one of the two windows to yield real data;
      // an entry with no percent / no timestamps is treated as "no
      // recognizable data" and we fall through to the null return.
      // (Picking an empty entry is not an error per se — the user
      // might just be looking at a quiet moment — but the renderer
      // has nothing to draw, and surfacing a `null` here matches the
      // "no data" contract the dispatcher expects.)
      if (interval || weekly) {
        return { fiveHour: interval, weekly };
      }
    }
  }

  // No recognizable model_remains array and no parameters map → give up.
  return null;
}

// Swap the leading `model_remains.0` (or `[0]`) of each path for
// the chosen index. No-op on paths that don't start with
// `model_remains` (e.g. a future provider where the user maps
// `data.five_hour.remaining` instead).
function reindexPaths(
  params: Record<string, string>,
  idx: number,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [slot, path] of Object.entries(params)) {
    out[slot] = path.replace(
      /^(model_remains|modelRemains)\.?\[?0\]?\.?/,
      `$1.${idx}.`,
    );
  }
  return out;
}

// Return the index of the most-active entry. "Most active" = the
// entry whose interval window is closest to exhausted, which on the
// `used` axis means the LARGEST used%, and on the `remaining` axis
// means the SMALLEST remaining%. We prefer `remainingPercentInterval`
// (the original minimax signal) and fall back to `usedPercentInterval`
// when the user didn't map a remaining slot. -1 when the array is
// empty or no interval-related slot is mapped at all. Stable on
// ties (first-encountered wins).
function pickMostActiveIndex(
  arr: unknown[],
  params: Record<string, string>,
): number {
  if (arr.length === 0) return -1;
  // remaining% is the canonical "smaller is busier" signal. used%
  // is the inverse — "larger is busier". We unify by reading whichever
  // the user mapped and converting to a "used% equivalent" for
  // comparison (0 = least busy, 100 = fully used).
  const remainingPath = params.remainingPercentInterval;
  const usedPath = params.usedPercentInterval;
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
    // Missing score (no interval slot parseable for this entry) →
    // treat as 0% used. A real 0% entry also scores 0; this is
    // acceptable because an entry that yields 0 used AND 0 remaining
    // (i.e. no data at all) should be deprioritized — but we don't
    // have a strong "completely missing" signal here, and the
    // alternative (skip the entry) leaves us with no fallback when
    // ALL entries are unparseable.
    const score = usedEquiv ?? 0;
    if (score > bestScore) {
      bestScore = score;
      bestIdx = i;
    }
  }
  return bestIdx;
}

export async function fetchRemains(
  token: string,
  endpoint: string,
  signal?: AbortSignal,
  provider: ProviderEntry | null = null,
): Promise<Remains | null> {
  if (!token) return null;
  const res = await fetch(endpoint, {
    method: "GET",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    signal,
  });
  if (!res.ok) {
    throw new Error(`token_plan/remains HTTP ${res.status}`);
  }
  const text = await res.text();
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  return parseRemains(parsed, provider);
}
