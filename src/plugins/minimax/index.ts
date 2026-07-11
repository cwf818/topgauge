import type { PluginContext, Quota } from "../data.js";
import { ensureQuota } from "../parsers.js";

const ENDPOINT = "https://www.minimaxi.com/v1/token_plan/remains";

type PartialQuota = {
  shortInterval?: Record<string, unknown> | null;
  midInterval?: Record<string, unknown> | null;
  longInterval?: Record<string, unknown> | null;
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
  if (!response.ok) throw new Error(`MiniMax token plan HTTP ${response.status}`);
  return JSON.parse(await response.text()) as unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asStatusCode(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "" && Number.isFinite(Number(value))) {
    return Number(value);
  }
  return null;
}

export function fillQuota(raw: unknown): PartialQuota | null {
  if (!isRecord(raw)) return null;

  const baseResp = raw.base_resp;
  if (isRecord(baseResp)) {
    const statusCode = asStatusCode(baseResp.status_code);
    if (statusCode !== null && statusCode !== 0) return null;
  }

  if (!Array.isArray(raw.model_remains)) return null;
  const general = raw.model_remains.find(
    (entry): entry is Record<string, unknown> =>
      isRecord(entry) && entry.model_name === "general",
  );
  if (!general) return null;

  return {
    shortInterval: {
      remainingPercent: general.current_interval_remaining_percent,
      startAt: general.start_time,
      endAt: general.end_time,
    },
    midInterval: {
      remainingPercent: general.current_weekly_remaining_percent,
      startAt: general.weekly_start_time,
      endAt: general.weekly_end_time,
    },
    longInterval: null,
  };
}

export default {
  async fetchAccountCredit(
    authenticationKey: string,
    context?: PluginContext,
  ): Promise<Quota | null> {
    const raw = await request(authenticationKey, context?.signal);
    return ensureQuota(fillQuota(raw));
  },
};
