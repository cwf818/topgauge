import type { CurrenciesConfig } from "../../types.js";
import type { Balance, PluginContext } from "../data.js";
import { parseBalance } from "../parsers.js";

const ENDPOINT = "https://api.deepseek.com/user/balance";

const DEFAULT_CURRENCIES: CurrenciesConfig = {
  CNY: {
    label: "￥",
    totalBalance: "balance_infos.0.total_balance",
  },
};

async function request(authenticationKey: string, signal?: AbortSignal): Promise<unknown> {
  if (!authenticationKey) return null;
  const response = await fetch(ENDPOINT, {
    signal,
    headers: {
      Authorization: `Bearer ${authenticationKey}`,
      Accept: "application/json",
    },
  });
  if (!response.ok) throw new Error(`DeepSeek balance HTTP ${response.status}`);
  return JSON.parse(await response.text()) as unknown;
}

export default {
  async fetchAccountCredit(
    authenticationKey: string,
    context?: PluginContext,
  ): Promise<Balance | null> {
    const raw = await request(authenticationKey, context?.signal);
    return parseBalance(raw, context?.currencies ?? DEFAULT_CURRENCIES);
  },
};
