import type { CurrenciesConfig, IntervalConfig } from "../types.js";

export type Interval = {
  windowId: string;
  label: string;
  startAt: number | null;
  endAt: number | null;
  intervalMs: number | null;
  remainingPercent: number | null;
  usedPercent: number | null;
  remainingQuota: number | null;
  usedQuota: number | null;
  limitQuota: number | null;
};

export type Quota = {
  shortInterval: Interval | null;
  midInterval: Interval | null;
  longInterval: Interval | null;
};

export type BalanceEntry = {
  currency: string;
  totalBalance: number;
  label: string;
};

export type Balance = {
  isAvailable: boolean;
  entries: BalanceEntry[];
  minValue: number | null;
};

export type PluginContext = {
  providerId: string;
  type: "Quota" | "BALANCE";
  intervals: IntervalConfig;
  currencies: CurrenciesConfig;
  signal?: AbortSignal;
};

export type AccountCreditPlugin = {
  fetchAccountCredit: (
    authenticationKey: string,
    context?: PluginContext,
  ) => unknown | Promise<unknown>;
};
