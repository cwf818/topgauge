import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  __resetForTest,
  __testing,
  configStore,
  loadConfig,
  resolveEffectiveCurrencies,
  resolveEffectiveIntervals,
} from "./config.ts";

let dir: string;
beforeEach(() => {
  __resetForTest();
  dir = mkdtempSync(join(tmpdir(), "topgauge-config-"));
  __testing.setPathResolver(() => join(dir, "config.json"));
});
afterEach(() => {
  __testing.resetPathResolver();
  __resetForTest();
  rmSync(dir, { recursive: true, force: true });
});

describe("provider defaults", () => {
  it("registers MiniMax as Quota and DeepSeek as BALANCE", () => {
    const providers = configStore.get().providers;
    assert.equal(providers.minimax.TYPE, "Quota");
    assert.equal(providers.deepseek.TYPE, "BALANCE");
    assert.equal("ENDPOINT" in providers.minimax, false);
  });

  it("uses AUTHENTICATION_KEY as the provider credential field", async () => {
    writeFileSync(join(dir, "config.json"), JSON.stringify({
      providers: {
        custom: {
          TYPE: "BALANCE",
          BASE_URL_COMPARED_TO: "https://custom.example/anthropic",
          COMPARE_METHOD: "EXACT",
          AUTHENTICATION_KEY: "configured",
        },
      },
    }));
    await loadConfig();
    assert.equal(configStore.get().providers.custom.AUTHENTICATION_KEY, "configured");
    assert.equal("BEARER_KEY" in (configStore.get().providers.custom as object), false);
  });
});

describe("provider mapping resolvers", () => {
  it("keeps built-in MiniMax interval mappings", () => {
    const entry = configStore.get().providers.minimax;
    const intervals = resolveEffectiveIntervals("minimax", entry);
    assert.equal(intervals.shortInterval?.remainingPercent, "model_remains.0.current_interval_remaining_percent");
    assert.equal(intervals.midInterval?.remainingPercent, "model_remains.0.current_weekly_remaining_percent");
  });

  it("keeps the DeepSeek CNY currency mapping", () => {
    const entry = configStore.get().providers.deepseek;
    const currencies = resolveEffectiveCurrencies("deepseek", entry);
    assert.equal(currencies.CNY?.totalBalance, "balance_infos.0.total_balance");
  });
});

describe("config facade", () => {
  it("loads rendering overrides without replacing provider defaults", async () => {
    writeFileSync(join(dir, "config.json"), JSON.stringify({
      display: "remaining",
      modeLabels: { remaining: "Left:" },
    }));
    await loadConfig();
    assert.equal(configStore.get().display, "remaining");
    assert.equal(configStore.get().modeLabels.remaining, "Left:");
    assert.equal(configStore.get().providers.minimax.TYPE, "Quota");
  });

  it("exposes the split template constants through config.ts", () => {
    assert.ok(__testing.DEFAULT_CONFIG.statuslineTemplate.length > 0);
    assert.ok(__testing.DEFAULT_CONFIG.lineTemplates.tokens_stat.length > 0);
  });
});
