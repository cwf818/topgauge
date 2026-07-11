// Provider-specific parsers used by built-in dynamic plugins.

import { resolveSlot } from "../path-expr.js";
import type {
  CurrenciesConfig,
  IntervalConfig,
  IntervalKey,
  IntervalSlotConfig,
} from "../types.js";
import type { Balance, BalanceEntry, Interval, Quota } from "./data.js";

function asNumber(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v))) {
    return Number(v);
  }
  return null;
}

// ============================================================================
//  Quota parser (v0.9.0+)
// ============================================================================

const DEFAULT_WINDOW_IDS: Record<IntervalKey, "5h" | "7d" | "30d"> = {
  shortInterval: "5h",
  midInterval:   "7d",
  longInterval:  "30d",
};

const INTERVAL_MS_KEYWORD_TABLE: ReadonlyArray<readonly [string, number]> = [
  ["hour",     3_600_000],
  ["fiveHour", 18_000_000],
  ["day",      86_400_000],
  ["sevenDay", 604_800_000],
  ["week",     604_800_000],
  ["month",    2_592_000_000],
  ["year",     31_536_000_000],
];

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

  const nonNullCount = (startRaw != null ? 1 : 0)
    + (endRaw != null ? 1 : 0)
    + (intervalMsRaw != null ? 1 : 0);
  if (nonNullCount < 2) {
    return { startAt: null, endAt: null, intervalMs: null };
  }

  let startAt = startRaw;
  let endAt = endRaw;
  if (startAt != null && endAt != null) {
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
  return { startAt: null, endAt: null, intervalMs: null };
}

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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

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

export function ensureInterval(value: unknown, key: IntervalKey): Interval | null {
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

export function parseQuota(
  raw: unknown,
  intervalsOrProvider: IntervalConfig | unknown = {},
  legacyIntervalsConfig?: IntervalConfig,
): Quota | null {
  const intervalsConfig = legacyIntervalsConfig ?? (
    intervalsOrProvider as IntervalConfig
  );
  if (!raw || typeof raw !== "object") return null;
  const root = raw as Record<string, unknown>;

  const baseResp = root.base_resp;
  if (baseResp && typeof baseResp === "object") {
    const code = asNumber((baseResp as Record<string, unknown>).status_code);
    if (code !== null && code !== 0) return null;
  }

  // Built-in plugins may use this parser to project a provider response
  // through the configured interval paths. User plugins normally return
  // the canonical Quota object directly and do not need this helper.

  const hasAnySlot =
    intervalsConfig?.shortInterval ||
    intervalsConfig?.midInterval ||
    intervalsConfig?.longInterval;
  if (hasAnySlot) {
    const short = buildInterval(root, intervalsConfig?.shortInterval ?? {}, "shortInterval");
    const mid = buildInterval(root, intervalsConfig?.midInterval ?? {}, "midInterval");
    const long = buildInterval(root, intervalsConfig?.longInterval ?? {}, "longInterval");
    if (short || mid || long) {
      return { shortInterval: short, midInterval: mid, longInterval: long };
    }
  }

  return null;
}

// ============================================================================
//  BALANCE parser (v0.x — ported verbatim from api.balance.ts)
// ============================================================================

// Resolve one entry from the currenciesConfig block (vX.X.X+).
// Walks `currenciesConfig[key]`, runs the configured
// `totalBalance` path expression against `root`, and returns a
// BalanceEntry — or `null` if the slot is missing / unparseable /
// resolves to a non-number. `key` is the literal currency code
// declared in the config; `label` falls back to `key` when the
// configured label is absent (preserves the v0.5.0–v0.8.x
// "unknown currency → bare code" behaviour for the label too).
function resolveCurrenciesEntry(
  root: unknown,
  key: string,
  slot: { label?: string; totalBalance?: string } | undefined,
): BalanceEntry | null {
  if (!slot || !slot.totalBalance) return null;
  const totalBalance = asNumber(resolveSlot(root, slot.totalBalance, "number"));
  if (totalBalance == null) return null;
  const label = slot.label ?? key;
  return { currency: key, totalBalance, label };
}

export function parseBalance(
  raw: unknown,
  currenciesConfig: CurrenciesConfig,
): Balance | null {
  if (!raw || typeof raw !== "object") return null;
  const root = raw as Record<string, unknown>;

  // is_available contract: explicit false (or string "false") →
  // false; otherwise → true (optimistic render).
  const availRaw = root.is_available;
  const explicitlyFalse =
    availRaw === false ||
    (typeof availRaw === "string" && availRaw.toLowerCase() === "false");
  const isAvailable = !explicitlyFalse;

  // vX.X.X+ — currenciesConfig-driven path. Each declared currency
  // key in the resolved map is projected out of `root` via its
  // configured `totalBalance` path. When the map is empty (no
  // built-in defaults matched the active provider id AND the user
  // didn't supply a top-level / per-provider block) the response
  // carries no entries — the plugin author / user is expected to
  // ship currenciesConfig.
  const entries = Object.keys(currenciesConfig)
    .map((k) => resolveCurrenciesEntry(root, k, currenciesConfig[k]))
    .filter((e): e is BalanceEntry => e !== null);

  if (!isAvailable) {
    return {
      isAvailable: false,
      entries,
      minValue: entries.length === 0 ? null : Math.min(...entries.map((e) => e.totalBalance)),
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

