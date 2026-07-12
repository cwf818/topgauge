import type {
  CompareMethod,
  CurrenciesConfig,
  IntervalConfig,
  IntervalKey,
  IntervalSlotConfig,
  ProviderEntry,
  ProviderType,
} from "./types.ts";

export const DEFAULT_PROVIDERS: Record<string, ProviderEntry> = {
  minimax: {
    TYPE: "QUOTA",
    BASE_URL_COMPARED_TO: "https://api.minimaxi.com/anthropic",
    COMPARE_METHOD: "EXACT",
    config: {},
  },
  deepseek: {
    TYPE: "BALANCE",
    BASE_URL_COMPARED_TO: "https://api.deepseek.com/anthropic",
    COMPARE_METHOD: "EXACT",
    config: {},
  },
};

export const VALID_PROVIDER_TYPES: ReadonlySet<ProviderType> = new Set([
  "QUOTA",
  "BALANCE",
]);

export const VALID_COMPARE_METHODS: ReadonlySet<CompareMethod> = new Set([
  "EXACT",
  "INCLUDE",
  "STARTWITH",
]);

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

const BUILTIN_PROVIDER_INTERVALS: Record<string, IntervalConfig> = {
  minimax: MINIMAX_DEFAULT_INTERVALS,
  deepseek: {},
};

const BUILTIN_PROVIDER_CURRENCIES: Record<string, CurrenciesConfig> = {
  deepseek: {
    CNY: { label: "￥", totalBalance: "balance_infos.0.total_balance" },
  },
  minimax: {},
};

function hasAnyField(slot: IntervalSlotConfig | undefined): boolean {
  if (!slot) return false;
  for (const _ in slot) return true;
  return false;
}

export function resolveEffectiveIntervalsPure(
  activeProviderId: string,
  entry: ProviderEntry | null,
  top: IntervalConfig,
): IntervalConfig {
  const out: IntervalConfig = {
    shortInterval: { ...GLOBAL_DEFAULT_INTERVALS.shortInterval },
    midInterval: { ...GLOBAL_DEFAULT_INTERVALS.midInterval },
    longInterval: { ...GLOBAL_DEFAULT_INTERVALS.longInterval },
  };
  const builtin = BUILTIN_PROVIDER_INTERVALS[activeProviderId];
  if (builtin) {
    if (hasAnyField(builtin.shortInterval)) out.shortInterval = { ...builtin.shortInterval };
    if (hasAnyField(builtin.midInterval)) out.midInterval = { ...builtin.midInterval };
    if (hasAnyField(builtin.longInterval)) out.longInterval = { ...builtin.longInterval };
  }
  if (top) {
    if (hasAnyField(top.shortInterval)) out.shortInterval = { ...top.shortInterval };
    if (hasAnyField(top.midInterval)) out.midInterval = { ...top.midInterval };
    if (hasAnyField(top.longInterval)) out.longInterval = { ...top.longInterval };
  }
  if (entry?.intervals) {
    if (hasAnyField(entry.intervals.shortInterval)) out.shortInterval = { ...entry.intervals.shortInterval };
    if (hasAnyField(entry.intervals.midInterval)) out.midInterval = { ...entry.intervals.midInterval };
    if (hasAnyField(entry.intervals.longInterval)) out.longInterval = { ...entry.intervals.longInterval };
  }
  return out;
}

export function resolveEffectiveCurrenciesPure(
  activeProviderId: string,
  entry: ProviderEntry | null,
  top: CurrenciesConfig,
): CurrenciesConfig {
  const out: CurrenciesConfig = {};
  for (const [key, value] of Object.entries(BUILTIN_PROVIDER_CURRENCIES[activeProviderId] ?? {})) {
    out[key] = { ...value };
  }
  for (const [key, value] of Object.entries(top ?? {})) out[key] = { ...value };
  for (const [key, value] of Object.entries(entry?.currencies ?? {})) out[key] = { ...value };
  return out;
}

export type { IntervalKey };
