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
  type: "QUOTA" | "BALANCE";
  intervals: IntervalConfig;
  currencies: CurrenciesConfig;
  signal?: AbortSignal;
};

// v0.8.47+ — single-method ABI. The plugin returns whatever shape
// it decided to project from the raw response (a Partial<Quota> /
// Partial<Balance>, or any opaque object the plugin wants). The
// host then runs ensureQuota / ensureBalance on the result. Plugins
// never see the canonical Quota / Balance types — only their fill
// contract + the ctx argument (signal / currencies / intervals).
export type AccountCreditPlugin = {
  fetchAccountCredit: (
    authenticationKey: string,
    context?: PluginContext,
  ) => unknown | Promise<unknown>;
};
