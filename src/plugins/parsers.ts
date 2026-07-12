// Pure-validator helpers used by built-in dynamic plugins + the
// host's post-fetch normalisation step.
//
// Plugins return whatever shape their `fillQuota` / `fillBalance`
// decided to project from the raw response. The host runs the
// canonical normalisers (`ensureQuota` / `ensureBalance` /
// `ensureInterval`) here so the plugin author never has to know
// about the canonical Quota / Balance types — only their fill
// contract + the ctx argument (signal).
//
// v0.9.x — the path-expression projection layer
// (`parseQuota` / `parseBalance` / `path-expr.ts`) was REMOVED.
// Plugin authors do their own parsing and ship canonical objects
// directly; there's no host-side path-walker left to configure.

import type { Balance, BalanceEntry, Interval, Quota } from "./data.js";

function asNumber(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v))) {
    return Number(v);
  }
  return null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// Built-in defaults for `windowId` / `label` when a plugin omits
// them. Mirrors the historical v0.4.x "5h / 7d / 30d" defaults so
// existing plugin authors don't have to set these explicitly.
const DEFAULT_WINDOW_IDS: Record<"shortInterval" | "midInterval" | "longInterval", "5h" | "7d" | "30d"> = {
  shortInterval: "5h",
  midInterval:   "7d",
  longInterval:  "30d",
};

function ensureTimeGroup(value: Record<string, unknown>): {
  startAt: number | null;
  endAt: number | null;
  intervalMs: number | null;
} {
  const startRaw = asNumber(value.startAt);
  const endRaw = asNumber(value.endAt);
  const intervalRaw = asNumber(value.intervalMs);
  const nonNullCount = (startRaw != null ? 1 : 0)
    + (endRaw != null ? 1 : 0)
    + (intervalRaw != null ? 1 : 0);
  if (nonNullCount < 2) {
    return { startAt: null, endAt: null, intervalMs: null };
  }

  let startAt = startRaw;
  let endAt = endRaw;
  if (startAt != null && endAt != null) {
    return { startAt, endAt, intervalMs: intervalRaw ?? (endAt - startAt) };
  }
  if (startAt != null && intervalRaw != null) {
    endAt = startAt + intervalRaw;
    return { startAt, endAt, intervalMs: intervalRaw };
  }
  if (endAt != null && intervalRaw != null) {
    startAt = endAt - intervalRaw;
    return { startAt, endAt, intervalMs: intervalRaw };
  }
  return { startAt: null, endAt: null, intervalMs: null };
}

export function ensureInterval(
  value: unknown,
  key: "shortInterval" | "midInterval" | "longInterval",
): Interval | null {
  if (!isRecord(value)) return null;
  const remainingRaw = asNumber(value.remainingPercent);
  const usedRaw = asNumber(value.usedPercent);
  const remainingPercent = usedRaw != null ? 100 - usedRaw : remainingRaw;
  const usedPercent = usedRaw != null ? usedRaw : (
    remainingRaw != null ? 100 - remainingRaw : null
  );
  const time = ensureTimeGroup(value);
  const fallback = DEFAULT_WINDOW_IDS[key];
  const windowId = typeof value.windowId === "string" ? value.windowId : fallback;
  const label = typeof value.label === "string"
    ? value.label
    : (typeof value.windowId === "string" ? value.windowId : fallback);

  return {
    windowId,
    label,
    startAt: time.startAt,
    endAt: time.endAt,
    intervalMs: time.intervalMs,
    remainingPercent,
    usedPercent,
    remainingQuota: asNumber(value.remainingQuota),
    usedQuota: asNumber(value.usedQuota),
    limitQuota: asNumber(value.limitQuota),
  };
}

export function ensureQuota(value: unknown): Quota | null {
  if (!isRecord(value)) return null;
  return {
    shortInterval: ensureInterval(value.shortInterval, "shortInterval"),
    midInterval: ensureInterval(value.midInterval, "midInterval"),
    longInterval: ensureInterval(value.longInterval, "longInterval"),
  };
}

// Apply the is_available fallback contract (missing → optimistic
// true), derive `minValue` over the surviving entries, and guard the
// final shape. The plugin layer is responsible for projecting
// `raw → Partial<Balance>`; this function is the host's normaliser
// and is the ONLY place the canonical `Balance` shape is produced.
//
// Returns null when `value` is not a record.
export function ensureBalance(value: unknown): Balance | null {
  if (!value || typeof value !== "object") return null;
  const partial = value as { isAvailable?: boolean; entries?: BalanceEntry[] };
  const entries = Array.isArray(partial.entries) ? partial.entries : [];
  const isAvailable = partial.isAvailable ?? true;

  if (!isAvailable) {
    return {
      isAvailable: false,
      entries,
      minValue: entries.length === 0
        ? null
        : Math.min(...entries.map((e) => e.totalBalance)),
    };
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