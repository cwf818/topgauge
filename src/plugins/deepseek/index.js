// DeepSeek built-in plugin. Plain ESM JS — same shape as a
// user-written plugin at ~/.claude/plugins/topgauge/query_plugins/<id>/.
//
// ABI: default export is { fetchAccountCredit(authenticationKey, ctx) },
// where `ctx` exposes { signal, intervals, currencies }. The returned
// object is a Partial<Balance> (host will run `ensureBalance` on it
// to produce the canonical Balance shape). The plugin author never
// has to know about the canonical Quota / Balance types.

const ENDPOINT = "https://api.deepseek.com/user/balance";

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asNumber(value) {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "" && Number.isFinite(Number(value))) {
    return Number(value);
  }
  return null;
}

// Minimal path expression walker (matches path-expr.resolveSlot for
// the single-segment / two-segment shapes DeepSeek uses). Keeps the
// plugin dependency-free.
function readPath(root, path) {
  const parts = path.split(".");
  let cur = root;
  for (const p of parts) {
    if (cur == null || typeof cur !== "object") return undefined;
    cur = cur[p];
  }
  return cur;
}

// Walk `currencies` map → BalanceEntry[] (one per declared currency).
// Slots whose `totalBalance` path resolves to null are dropped
// (matches the v0.x parseBalance behaviour).
function fillBalance(raw, currencies) {
  if (!isRecord(raw)) return null;

  const availRaw = raw.is_available;
  let isAvailable;
  if (typeof availRaw === "boolean") {
    isAvailable = availRaw;
  } else if (typeof availRaw === "string" && availRaw.toLowerCase() === "false") {
    isAvailable = false;
  }

  const entries = [];
  for (const [key, slot] of Object.entries(currencies ?? {})) {
    if (!slot || !slot.totalBalance) continue;
    const totalBalance = asNumber(readPath(raw, slot.totalBalance));
    if (totalBalance == null) continue;
    entries.push({ currency: key, totalBalance, label: slot.label ?? key });
  }

  return { isAvailable, entries };
}

export default {
  async fetchAccountCredit(authenticationKey, ctx) {
    if (!authenticationKey) return null;
    const response = await fetch(ENDPOINT, {
      signal: ctx?.signal,
      headers: {
        Authorization: `Bearer ${authenticationKey}`,
        Accept: "application/json",
      },
    });
    if (!response.ok) throw new Error(`DeepSeek balance HTTP ${response.status}`);
    const raw = JSON.parse(await response.text());
    return fillBalance(raw, ctx?.currencies);
  },
};