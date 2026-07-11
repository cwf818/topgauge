import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseBalance, pluginTransport, isDeepSeekBaseUrl } from "./api.ts";

const here = dirname(fileURLToPath(import.meta.url));
const fixture = (name: string): unknown =>
  JSON.parse(readFileSync(resolve(here, "__fixtures__", name), "utf8"));
const currencies = { CNY: { label: "￥", totalBalance: "balance_infos.0.total_balance" } };

describe("isDeepSeekBaseUrl", () => {
  it("matches the provider URL and rejects suffix attacks", () => {
    assert.equal(isDeepSeekBaseUrl("https://api.deepseek.com/anthropic"), true);
    assert.equal(isDeepSeekBaseUrl("https://api.deepseek.com.evil.example"), false);
  });
});

describe("parseBalance", () => {
  it("parses the real balance fixture", () => {
    const result = parseBalance(fixture("balance.real.json"), currencies);
    assert.equal(result?.isAvailable, true);
    assert.equal(result?.entries[0]?.label, "￥");
  });

  it("keeps all configured currencies and computes the minimum", () => {
    const result = parseBalance({
      is_available: true,
      balance_infos: [{ currency: "CNY", total_balance: "20" }],
    }, currencies);
    assert.equal(result?.minValue, 20);
  });

  it("marks explicit unavailable responses without throwing", () => {
    const result = parseBalance({ is_available: false }, currencies);
    assert.equal(result?.isAvailable, false);
    assert.deepEqual(result?.entries, []);
  });
});

describe("DeepSeek built-in plugin", () => {
  it("uses the supplied authentication key and returns Balance", async () => {
    const oldFetch = globalThis.fetch;
    globalThis.fetch = async (_input, init) => {
      assert.equal((init?.headers as Record<string, string>).Authorization, "Bearer configured");
      return new Response(JSON.stringify(fixture("balance.real.json")), { status: 200 });
    };
    try {
      const result = await pluginTransport("deepseek", "configured", {
        providerId: "deepseek",
        type: "BALANCE",
        intervals: {},
        currencies,
      });
      assert.equal((result as { isAvailable: boolean }).isAvailable, true);
    } finally {
      globalThis.fetch = oldFetch;
    }
  });
});
