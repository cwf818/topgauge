// Kimi user plugin for topgauge. POST {scope:["FEATURE_CODING"]}
// → usages[] entry with resetTime + limits[]. Projects the
// usages.detail (top-level cycle) onto shortInterval and
// usages.limits[0].detail (the rolling window) onto midInterval.
// longInterval stays null.
//
// ABI: default export is { fetchAccountCredit(authenticationKey, ctx) },
// same shape as the built-in minimax / deepseek plugins. The host runs
// ensureQuota on the returned Partial<Quota> to derive the canonical
// shape. The plugin author never sees canonical Quota / Interval.
//
// AUTHENTICATION_KEY: the Kimi dashboard's localStorage `access_token`
// (the one issued after browser login at https://kimi.com), NOT the
// API token under Settings. Configure it via providers.kimi.AUTHENTICATION_KEY
// in ~/.claude/plugins/topgauge/config.json. The plugin sends it as
// `Authorization: Bearer <key>` against the GetUsages endpoint.
//
// Auth note: the GetUsages endpoint is the same gRPC-over-HTTP the
// browser dashboard hits, so the localStorage access_token is the
// only credential Kimi accepts. If you log out / refresh from the
// browser, copy the new access_token out of localStorage and paste
// it back into config.json — the cache row `kimi:pluginSource` does
// not gate on credential validity, so a stale token shows up as a
// silent `Remain: --:…` placeholder until the renderer falls back.

const ENDPOINT =
  "https://www.kimi.com/apiv2/kimi.gateway.billing.v1.BillingService/GetUsages";

function isRecord(v) {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}
function asNumber(v) {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v)))
    return Number(v);
  return null;
}
function epochMs(iso) {
  if (typeof iso !== "string") return null;
  const ms = Date.parse(iso);
  return Number.isNaN(ms) ? null : ms;
}

// Pick the FEATURE_CODING scope out of usages[]. Kimi's quota
// response may include other scopes (chat / research / etc) — we
// only render the coding one, matching the user's
// ANTHROPIC_BASE_URL=https://api.kimi.com/coding/ context.
function findCodingUsage(raw) {
  const usages = Array.isArray(raw?.usages) ? raw.usages : [];
  return usages.find((u) => isRecord(u) && u.scope === "FEATURE_CODING") ?? null;
}

// Top-level detail (the primary cycle the dashboard shows).
function topLevelInterval(usage) {
  const detail = usage?.detail;
  if (!isRecord(detail)) return null;
  const remainingPct = asNumber(detail.remaining);
  const resetAt = epochMs(detail.resetTime);
  if (remainingPct == null || resetAt == null) return null;
  // Kimi returns only resetTime — back-derive startAt as
  // resetAt - 5h so the renderer's window-fill-aware reset arrow
  // still gets a direction. (Absolute startAt is an estimate, but
  // the arrow direction is what the user actually reads.)
  const intervalMs = 5 * 60 * 60 * 1000;
  return {
    windowId: "5h",
    label: "5h",
    startAt: resetAt - intervalMs,
    endAt: resetAt,
    intervalMs,
    remainingPercent: remainingPct,
    usedPercent: 100 - remainingPct,
    remainingQuota: asNumber(detail.remaining),
    usedQuota: asNumber(detail.used),
    limitQuota: asNumber(detail.limit),
  };
}

// limits[0] — the rolling sub-window inside the primary cycle.
// duration is in minutes; the fixture shows 300 (5h) but can be
// other values for other scopes.
function rollingInterval(usage) {
  const limits = Array.isArray(usage?.limits) ? usage.limits : [];
  const first = limits[0];
  if (!isRecord(first)) return null;
  const detail = first.detail;
  const window = first.window;
  if (!isRecord(detail) || !isRecord(window)) return null;
  const remainingPct = asNumber(detail.remaining);
  const resetAt = epochMs(detail.resetTime);
  if (remainingPct == null || resetAt == null) return null;
  const minutes = asNumber(window.duration) ?? 300;
  const intervalMs = minutes * 60 * 1000;
  return {
    windowId: "5h",
    label: `${minutes}m`,
    startAt: resetAt - intervalMs,
    endAt: resetAt,
    intervalMs,
    remainingPercent: remainingPct,
    usedPercent: 100 - remainingPct,
    remainingQuota: asNumber(detail.remaining),
    usedQuota: null,
    limitQuota: asNumber(detail.limit),
  };
}

function fillQuota(raw) {
  const usage = findCodingUsage(raw);
  if (!usage) return null;
  return {
    shortInterval: topLevelInterval(usage),
    midInterval: rollingInterval(usage),
    longInterval: null,
  };
}

export default {
  async fetchAccountCredit(authenticationKey, ctx) {
    if (!authenticationKey) return null;
    const response = await fetch(ENDPOINT, {
      method: "POST",
      signal: ctx?.signal,
      headers: {
        Authorization: `Bearer ${authenticationKey}`,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify({ scope: ["FEATURE_CODING"] }),
    });
    if (!response.ok)
      throw new Error(`kimi GetUsages HTTP ${response.status}`);
    const raw = JSON.parse(await response.text());
    return fillQuota(raw);
  },
};

// Named exports for unit tests. The host loader only ever consumes
// `default`; these let kimi.test.ts pin the fill contract.
export { ENDPOINT, fillQuota, topLevelInterval, rollingInterval, findCodingUsage };
