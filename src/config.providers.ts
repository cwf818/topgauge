import type {
  CompareMethod,
  CurrenciesConfig,
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

const BUILTIN_PROVIDER_CURRENCIES: Record<string, CurrenciesConfig> = {
  deepseek: {
    CNY: { label: "￥", totalBalance: "balance_infos.0.total_balance" },
  },
  minimax: {},
};

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
