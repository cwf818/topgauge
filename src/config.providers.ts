import type { CompareMethod, ProviderEntry, ProviderType } from "./types.ts";

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
