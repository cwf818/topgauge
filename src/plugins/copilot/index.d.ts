// Type facade for src/plugins/copilot/index.js. The plugin's own
// source is plain ESM JS (no transpile step). This .d.ts mirrors
// the public surface — the host loader only consumes the default
// export; named exports exist for unit tests.
//
// Keep this file in sync with the runtime contract. Side-effect
// imports from here would force TS to load an empty module; the
// host loader's dynamic import stays path-stripped from any of
// these types.

export interface QuotaFillInput {
  quota_snapshots?: {
    premium_interactions?: {
      percent_remaining?: number | string | null;
      quota_remaining?:   number | string | null;
      entitlement?:       number | string | null;
    } | null;
  };
}

export interface IntervalPartial {
  remainingPercent: number | null;
  remainingQuota:   number | null;
  limitQuota:       number | null;
  startAt:          number | null;
  endAt:            number | null;
}

export interface QuotaPartial {
  shortInterval: null;
  midInterval:   null;
  longInterval:  IntervalPartial | null;
}

export const ENDPOINT: "http://localhost:4141/usage";

export declare function fillQuota(raw: unknown, nowMs: number): QuotaPartial | null;

export declare function naturalMonthBounds(
  nowMs: number,
): { startAt: number; endAt: number } | null;

export default {
  fetchAccountCredit(
    authenticationKey: string,
    ctx?: { signal?: AbortSignal },
  ): Promise<QuotaPartial | null>;
};
