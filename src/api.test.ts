import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  ensureInterval,
  ensureQuota,
  fetchForProviderById,
  parseQuota,
  pluginTransport,
  resolvePluginOnDisk,
} from "./api.ts";
import type { IntervalConfig } from "./types.ts";
import { fillQuota } from "./plugins/minimax/index.ts";

const here = dirname(fileURLToPath(import.meta.url));
const fixture = (name: string): unknown =>
  JSON.parse(readFileSync(resolve(here, "__fixtures__", name), "utf8"));

const minimaxIntervals: IntervalConfig = {
  shortInterval: {
    remainingPercent: "model_remains.0.current_interval_remaining_percent",
    startAt: "model_remains.0.start_time",
    endAt: "model_remains.0.end_time",
  },
  midInterval: {
    remainingPercent: "model_remains.0.current_weekly_remaining_percent",
    startAt: "model_remains.0.weekly_start_time",
    endAt: "model_remains.0.weekly_end_time",
  },
  longInterval: {},
};

let oldHome: string | undefined;
let oldUserProfile: string | undefined;
let tempHome: string;

beforeEach(() => {
  oldHome = process.env.HOME;
  oldUserProfile = process.env.USERPROFILE;
  tempHome = mkdtempSync(resolve(tmpdir(), "topgauge-api-"));
  process.env.HOME = tempHome;
  process.env.USERPROFILE = tempHome;
});

afterEach(() => {
  if (oldHome === undefined) delete process.env.HOME;
  else process.env.HOME = oldHome;
  if (oldUserProfile === undefined) delete process.env.USERPROFILE;
  else process.env.USERPROFILE = oldUserProfile;
  rmSync(tempHome, { recursive: true, force: true });
});

describe("parseQuota", () => {
  it("projects the MiniMax model_remains response into three intervals", () => {
    const result = parseQuota(fixture("quota.real.minimax.json"), minimaxIntervals);
    assert.ok(result);
    assert.equal(result.shortInterval?.remainingPercent, 66);
    assert.equal(result.midInterval?.remainingPercent, 61);
    assert.equal(result.longInterval, null);
  });

  it("derives used percentage and interval endpoints", () => {
    const result = parseQuota({
      short: { remaining: 25, start: 1_000, end: 2_000 },
    }, {
      shortInterval: {
        remainingPercent: "short.remaining",
        startAt: "short.start",
        endAt: "short.end",
      },
    });
    assert.equal(result?.shortInterval?.usedPercent, 75);
    assert.equal(result?.shortInterval?.intervalMs, 1_000);
  });

  it("returns null for invalid input or non-zero base response", () => {
    assert.equal(parseQuota(null, minimaxIntervals), null);
    assert.equal(parseQuota({ base_resp: { status_code: 1 } }, minimaxIntervals), null);
  });
});

describe("ensure quota", () => {
  it("fills a partial interval with canonical nullable fields and derives values", () => {
    const interval = ensureInterval({
      remainingPercent: 66,
      startAt: 1_000,
      endAt: 5_000,
    }, "shortInterval");
    assert.deepEqual(interval, {
      windowId: "5h",
      label: "5h",
      startAt: 1_000,
      endAt: 5_000,
      intervalMs: 4_000,
      remainingPercent: 66,
      usedPercent: 34,
      remainingQuota: null,
      usedQuota: null,
      limitQuota: null,
    });
  });

  it("normalizes all quota slots and preserves explicit zero", () => {
    assert.deepEqual(ensureQuota({
      shortInterval: { remainingPercent: 0 },
      extra: "ignored",
    }), {
      shortInterval: {
        windowId: "5h",
        label: "5h",
        startAt: null,
        endAt: null,
        intervalMs: null,
        remainingPercent: 0,
        usedPercent: 100,
        remainingQuota: null,
        usedQuota: null,
        limitQuota: null,
      },
      midInterval: null,
      longInterval: null,
    });
    assert.equal(ensureQuota(null), null);
  });
});

describe("MiniMax direct quota mapping", () => {
  it("selects the general model instead of relying on array order", () => {
    const raw = fixture("quota.real.minimax.json") as {
      model_remains: Array<Record<string, unknown>>;
    };
    const reordered = {
      ...raw,
      model_remains: [...raw.model_remains].reverse(),
    };
    const result = ensureQuota(fillQuota(reordered));
    assert.equal(result?.shortInterval?.remainingPercent, 66);
    assert.equal(result?.shortInterval?.usedPercent, 34);
    assert.equal(result?.midInterval?.remainingPercent, 61);
    assert.equal(result?.midInterval?.intervalMs, 604_800_000);
    assert.equal(result?.longInterval, null);
  });

  it("returns null when the general model is absent", () => {
    assert.equal(fillQuota({
      model_remains: [{ model_name: "video" }],
      base_resp: { status_code: 0 },
    }), null);
  });

  it("completes missing MiniMax fields without using configured paths", () => {
    const result = ensureQuota(fillQuota({
      model_remains: [{
        model_name: "general",
        current_interval_remaining_percent: 0,
      }],
      base_resp: { status_code: 0 },
    }));
    assert.equal(result?.shortInterval?.remainingPercent, 0);
    assert.equal(result?.shortInterval?.usedPercent, 100);
    assert.equal(result?.shortInterval?.startAt, null);
    assert.equal(result?.midInterval?.remainingPercent, null);
  });
});

describe("dynamic plugin loader", () => {
  it("loads the compiled built-in MiniMax plugin dynamically", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (_input, init) => {
      assert.equal((init?.headers as Record<string, string>).Authorization, "Bearer secret");
      return new Response(JSON.stringify(fixture("quota.real.minimax.json")), { status: 200 });
    };
    try {
      const result = await pluginTransport("minimax", "secret", {
        providerId: "minimax",
        type: "Quota",
        intervals: {
          shortInterval: { remainingPercent: "missing.path" },
          midInterval: { remainingPercent: "missing.path" },
        },
        currencies: {},
      });
      const quota = result as {
        shortInterval: { remainingPercent: number; usedPercent: number; intervalMs: number };
        midInterval: { remainingPercent: number; usedPercent: number; intervalMs: number };
      };
      assert.equal(quota.shortInterval.remainingPercent, 66);
      assert.equal(quota.shortInterval.usedPercent, 34);
      assert.equal(quota.shortInterval.intervalMs, 14_400_000);
      assert.equal(quota.midInterval.remainingPercent, 61);
      assert.equal(quota.midInterval.usedPercent, 39);
      assert.equal(quota.midInterval.intervalMs, 604_800_000);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("passes AUTHENTICATION_KEY-selected values to user plugins", async () => {
    const pluginDir = resolve(tempHome, ".claude", "plugins", "topgauge-cc", "query_plugins", "custom");
    mkdirSync(pluginDir, { recursive: true });
    writeFileSync(resolve(pluginDir, "index.mjs"), `export default { fetchAccountCredit(token) {
      return { shortInterval: { windowId: token, label: token, startAt: null, endAt: null, intervalMs: null, remainingPercent: 50, usedPercent: 50, remainingQuota: null, usedQuota: null, limitQuota: null } };
    } };`);
    const path = resolvePluginOnDisk("custom");
    assert.ok(path.endsWith("index.mjs"));
    const result = await fetchForProviderById(
      "custom",
      {
        TYPE: "Quota",
        BASE_URL_COMPARED_TO: "https://custom.example/anthropic",
        COMPARE_METHOD: "EXACT",
        AUTHENTICATION_KEY: "configured-key",
      },
      "environment-key",
      undefined,
    );
    assert.equal((result as { shortInterval: { windowId: string } }).shortInterval.windowId, "configured-key");
  });

  it("rejects the removed fetchAccountQuota ABI", async () => {
    const pluginDir = resolve(tempHome, ".claude", "plugins", "topgauge-cc", "query_plugins", "old");
    mkdirSync(pluginDir, { recursive: true });
    writeFileSync(resolve(pluginDir, "index.mjs"), "export default { fetchAccountQuota() { return {}; } };");
    await assert.rejects(() => pluginTransport("old", "token"), /fetchAccountCredit/);
  });

  it("rejects malformed canonical output", async () => {
    const pluginDir = resolve(tempHome, ".claude", "plugins", "topgauge-cc", "query_plugins", "bad");
    mkdirSync(pluginDir, { recursive: true });
    writeFileSync(resolve(pluginDir, "index.mjs"), "export default { fetchAccountCredit() { return 'bad'; } };");
    const result = await pluginTransport("bad", "token");
    assert.equal(result, "bad");
  });
});
