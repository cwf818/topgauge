import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { isDeepSeekBaseUrl, parseBalance, fetchBalance } from "./api.ts";
import type { ProviderEntry } from "./types.ts";

const here = dirname(fileURLToPath(import.meta.url));
const fixture = (name: string): unknown =>
  JSON.parse(readFileSync(resolve(here, "__fixtures__", name), "utf8"));

describe("isDeepSeekBaseUrl", () => {
  it("matches api.deepseek.com", () => {
    assert.equal(isDeepSeekBaseUrl("https://api.deepseek.com"), true);
  });
  it("matches trailing slash", () => {
    assert.equal(isDeepSeekBaseUrl("https://api.deepseek.com/"), true);
  });
  it("matches /anthropic path suffix", () => {
    assert.equal(isDeepSeekBaseUrl("https://api.deepseek.com/anthropic"), true);
  });
  it("is case-insensitive", () => {
    assert.equal(isDeepSeekBaseUrl("https://API.DeepSeek.COM/Anthropic"), true);
  });
  it("rejects suffix attacks (api.deepseek.com.evil.example)", () => {
    assert.equal(isDeepSeekBaseUrl("https://api.deepseek.com.evil.example"), false);
  });
  it("rejects api.minimaxi.com", () => {
    assert.equal(isDeepSeekBaseUrl("https://api.minimaxi.com"), false);
  });
  it("rejects http (not https)", () => {
    assert.equal(isDeepSeekBaseUrl("http://api.deepseek.com"), false);
  });
  it("rejects empty / undefined / null", () => {
    assert.equal(isDeepSeekBaseUrl(""), false);
    assert.equal(isDeepSeekBaseUrl(undefined), false);
    assert.equal(isDeepSeekBaseUrl(null), false);
  });
  it("accepts ?query and #fragment", () => {
    assert.equal(isDeepSeekBaseUrl("https://api.deepseek.com?x=1"), true);
    assert.equal(isDeepSeekBaseUrl("https://api.deepseek.com#frag"), true);
  });
});

// vX.X.X+ — parseBalance now requires a currenciesConfig argument
// and projects entries from the response via the configured
// `totalBalance` paths. The legacy `balance_infos[]` shape is
// NO LONGER supported — tests below all thread a currenciesConfig
// matching the deepseek built-in default.

const DEEPSEEK_CNY_CONFIG = {
  CNY: { label: "￥", totalBalance: "currencies.CNY.total_balance" },
} as const;

describe("parseBalance — single-currency real shape", () => {
  it("parses the captured real fixture", () => {
    const b = parseBalance(fixture("balance.real.json"), DEEPSEEK_CNY_CONFIG);
    assert.ok(b);
    assert.equal(b!.isAvailable, true);
    assert.equal(b!.entries.length, 1);
    assert.equal(b!.entries[0].currency, "CNY");
    assert.equal(b!.entries[0].totalBalance, 110);
    assert.equal(b!.entries[0].label, "￥");
    assert.equal(b!.minValue, 110);
  });
});

describe("parseBalance — multi-currency", () => {
  it("keeps all entries and picks the minimum for color", () => {
    const config = {
      CNY: { label: "￥", totalBalance: "currencies.CNY.total_balance" },
      USD: { label: "$", totalBalance: "currencies.USD.total_balance" },
    };
    const b = parseBalance(fixture("balance.multi.json"), config);
    assert.ok(b);
    assert.equal(b!.isAvailable, true);
    assert.equal(b!.entries.length, 2);
    assert.deepEqual(
      b!.entries.map((e) => e.totalBalance),
      [110, 3.5]
    );
    // 3.5 < 110 → minValue is the USD entry.
    assert.equal(b!.minValue, 3.5);
  });
});

describe("parseBalance — unavailable / missing fields", () => {
  it("is_available=false → isAvailable=false, entries from config still populated", () => {
    const b = parseBalance({ is_available: false }, DEEPSEEK_CNY_CONFIG);
    assert.ok(b);
    assert.equal(b!.isAvailable, false);
    // config has CNY but the response doesn't carry currencies.CNY.total_balance,
    // so the entry is dropped (path resolution returns null).
    assert.equal(b!.entries.length, 0);
    assert.equal(b!.minValue, null);
  });
  it("empty currenciesConfig → no entries, isAvailable honored", () => {
    const b = parseBalance({ is_available: true }, {});
    assert.ok(b);
    assert.equal(b!.isAvailable, true);
    assert.equal(b!.entries.length, 0);
    assert.equal(b!.minValue, null);
  });
  it("missing is_available → optimistic true (renders entries)", () => {
    const body = {
      currencies: { CNY: { total_balance: 110 } },
    };
    const b = parseBalance(body, DEEPSEEK_CNY_CONFIG);
    assert.ok(b);
    assert.equal(b!.isAvailable, true);
    assert.equal(b!.entries.length, 1);
    assert.equal(b!.entries[0].totalBalance, 110);
  });
  it("entries with non-numeric total_balance are dropped", () => {
    const config = {
      CNY: { label: "￥", totalBalance: "currencies.CNY.total_balance" },
      USD: { label: "$", totalBalance: "currencies.USD.total_balance" },
    };
    const body = {
      is_available: true,
      currencies: {
        CNY: { total_balance: "abc" },
        USD: { total_balance: "5" },
      },
    };
    const b = parseBalance(body, config);
    assert.ok(b);
    assert.equal(b!.entries.length, 1);
    assert.equal(b!.entries[0].currency, "USD");
    assert.equal(b!.entries[0].totalBalance, 5);
  });
  it("accepts numeric total_balance (not just string)", () => {
    const body = {
      is_available: true,
      currencies: { CNY: { total_balance: 42.5 } },
    };
    const b = parseBalance(body, DEEPSEEK_CNY_CONFIG);
    assert.ok(b);
    assert.equal(b!.entries[0].totalBalance, 42.5);
  });
  it("rejects non-object input", () => {
    assert.equal(parseBalance(null, DEEPSEEK_CNY_CONFIG), null);
    assert.equal(parseBalance(undefined, DEEPSEEK_CNY_CONFIG), null);
    assert.equal(parseBalance("string", DEEPSEEK_CNY_CONFIG), null);
    assert.equal(parseBalance(42, DEEPSEEK_CNY_CONFIG), null);
  });
  it("tolerates truthy/falsy variants of is_available", () => {
    assert.equal(parseBalance({ is_available: 1 }, DEEPSEEK_CNY_CONFIG)!.isAvailable, true);
    assert.equal(parseBalance({ is_available: "true" }, DEEPSEEK_CNY_CONFIG)!.isAvailable, true);
    assert.equal(parseBalance({ is_available: "false" }, DEEPSEEK_CNY_CONFIG)!.isAvailable, false);
  });
  it("missing currencies object → no entries (paths resolve to null)", () => {
    const b = parseBalance({ is_available: true }, DEEPSEEK_CNY_CONFIG);
    assert.ok(b);
    assert.equal(b!.entries.length, 0);
    assert.equal(b!.minValue, null);
  });
  it("is_available: null → optimistic true, renders entries", () => {
    const body = {
      is_available: null,
      currencies: { CNY: { total_balance: 50 } },
    };
    const b = parseBalance(body, DEEPSEEK_CNY_CONFIG);
    assert.ok(b);
    assert.equal(b!.isAvailable, true);
    assert.equal(b!.entries.length, 1);
  });
  it("is_available: false (with entries) → isAvailable=false; minValue still computed", () => {
    // The unavailable branch still surfaces entries + minValue so the
    // renderer can choose to display a "frozen" / "suspended" hint with
    // the balance list attached. The contract is the `isAvailable`
    // flag, not the entries list — renderer's call.
    const body = {
      is_available: false,
      currencies: { CNY: { total_balance: 110 } },
    };
    const b = parseBalance(body, DEEPSEEK_CNY_CONFIG);
    assert.ok(b);
    assert.equal(b!.isAvailable, false);
    assert.equal(b!.entries.length, 1);
    assert.equal(b!.minValue, 110);
  });
  it("case-insensitive string 'FALSE' → false (preserve v0.5.x tolerance)", () => {
    assert.equal(
      parseBalance({ is_available: "FALSE" }, DEEPSEEK_CNY_CONFIG)!.isAvailable,
      false,
    );
  });
});

// ----- v0.6.0+ HTTP override plumbing for fetchBalance -----
//
// fetchBalance is now symmetric with fetchRemains — it accepts an
// optional 4th `provider` arg and reads entry.BEARER_KEY /
// entry.METHOD / entry.BODY. These tests exercise the same five
// cases as the fetchRemains block, against a parser that expects
// the deepseek-shaped payload.
type RecordedCall = { url: string; init: RequestInit };
function installMockFetch(recorder: RecordedCall[]) {
  const original = globalThis.fetch;
  globalThis.fetch = (async (
    url: string | URL | Request,
    init?: RequestInit,
  ) => {
    recorder.push({ url: String(url), init: init ?? {} });
    return new Response(
      JSON.stringify({
        is_available: true,
        currencies: { CNY: { total_balance: "5.00" } },
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    ) as unknown as Response;
  }) as typeof fetch;
  return () => {
    globalThis.fetch = original;
  };
}

const deepseekEntry: ProviderEntry = {
  TYPE: "BALANCE",
  BASE_URL_COMPARED_TO: "https://api.deepseek.com/anthropic",
  COMPARE_METHOD: "EXACT",
  ENDPOINT: "https://api.deepseek.com/user/balance",
};

describe("fetchBalance — per-provider HTTP overrides (v0.6.0+)", () => {
  const rec: RecordedCall[] = [];
  let restore: () => void;
  beforeEach(() => {
    rec.length = 0;
    restore = installMockFetch(rec);
  });
  afterEach(() => restore());

  it("uses entry.BEARER_KEY over the env-supplied token", async () => {
    const entry: ProviderEntry = {
      ...deepseekEntry,
      BEARER_KEY: "secret-from-config",
    };
    const b = await fetchBalance(
      "env-token",
      entry.ENDPOINT,
      undefined,
      entry,
    );
    assert.ok(b);
    const sent = rec[0].init.headers as Record<string, string>;
    assert.equal(sent.Authorization, "Bearer secret-from-config");
  });

  it("falls back to env token when BEARER_KEY is absent", async () => {
    await fetchBalance(
      "env-token",
      deepseekEntry.ENDPOINT,
      undefined,
      deepseekEntry,
    );
    const sent = rec[0].init.headers as Record<string, string>;
    assert.equal(sent.Authorization, "Bearer env-token");
  });

  it("POSTs entry.BODY as JSON when METHOD=POST and BODY is set", async () => {
    const entry: ProviderEntry = {
      ...deepseekEntry,
      METHOD: "POST",
      BODY: { account: "main" },
    };
    await fetchBalance("t", entry.ENDPOINT, undefined, entry);
    assert.equal(rec[0].init.method, "POST");
    assert.equal(rec[0].init.body, JSON.stringify({ account: "main" }));
  });

  it("GET with BODY present still sends no body (spec-friendly)", async () => {
    const entry: ProviderEntry = {
      ...deepseekEntry,
      BODY: { x: 1 },
    };
    await fetchBalance("t", entry.ENDPOINT, undefined, entry);
    assert.equal(rec[0].init.method, "GET");
    assert.equal(rec[0].init.body, undefined);
  });

  it("returns null when env token is empty AND entry.BEARER_KEY is absent", async () => {
    const b = await fetchBalance(
      "",
      deepseekEntry.ENDPOINT,
      undefined,
      deepseekEntry,
    );
    assert.equal(b, null);
    assert.equal(rec.length, 0, "must not hit the network");
  });

  it("forwards the 4th arg default — calling without provider still works", async () => {
    // Back-compat for any external test that hasn't migrated to the
    // new signature. Same as before v0.6.0.
    const b = await fetchBalance("env-only", deepseekEntry.ENDPOINT);
    assert.ok(b);
    assert.equal(rec.length, 1);
    const sent = rec[0].init.headers as Record<string, string>;
    assert.equal(sent.Authorization, "Bearer env-only");
  });
});
