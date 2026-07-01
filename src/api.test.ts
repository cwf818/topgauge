import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { parseRemains, fetchRemains } from "./api.ts";
import type { ProviderEntry } from "./types.ts";

const here = dirname(fileURLToPath(import.meta.url));
const fixture = (name: string): unknown =>
  JSON.parse(readFileSync(resolve(here, "__fixtures__", name), "utf8"));

// Minimal ProviderEntry carrying the default minimax parameters so
// parseRemains gets the same slots the live dispatcher would. Tests
// that need a custom mapping build their own entry.
const minimaxProvider: ProviderEntry = {
  TYPE: "TOKEN_PLAN",
  BASE_URL_COMPARED_TO: "https://api.minimaxi.com/anthropic",
  COMPARE_METHOD: "EXACT",
  ENDPOINT: "https://www.minimaxi.com/v1/token_plan/remains",
  // parameters omitted on purpose — parseRemains falls back to
  // DEFAULT_MINIMAX_PARAMETERS when the entry's ENDPOINT is
  // minimaxi.com and no parameters are supplied.
};

describe("parseRemains — model_remains array shape (real)", () => {
  it("parses the captured real fixture", () => {
    const r = parseRemains(fixture("remains.real.json"), minimaxProvider);
    assert.ok(r);
    // Most active model is "general" with interval remaining 66%, weekly 61%.
    // → used% = 34% interval, 39% weekly.
    assert.equal(r.fiveHour?.pct, 34);
    assert.equal(r.weekly?.pct, 39);
    assert.equal(typeof r.fiveHour?.resetAt, "string");
    assert.equal(typeof r.weekly?.resetAt, "string");
  });

  it("threads resetStartAt and resetDurationMs from start_time/end_time", () => {
    const r = parseRemains(fixture("remains.real.json"), minimaxProvider);
    assert.ok(r);
    assert.equal(r.fiveHour?.resetDurationMs, 4 * 3_600_000);
    assert.equal(r.weekly?.resetDurationMs, 7 * 24 * 3_600_000);
    const fhStart = Date.parse(r.fiveHour?.resetStartAt ?? "");
    const wkStart = Date.parse(r.weekly?.resetStartAt ?? "");
    assert.ok(Number.isFinite(fhStart));
    assert.ok(Number.isFinite(wkStart));
    assert.equal(
      Date.parse(r.fiveHour!.resetAt!) - fhStart,
      r.fiveHour!.resetDurationMs
    );
    assert.equal(
      Date.parse(r.weekly!.resetAt!) - wkStart,
      r.weekly!.resetDurationMs
    );
  });

  it("omits resetStartAt/resetDurationMs when the source has no start_time", () => {
    const r = parseRemains({
      model_remains: [
        {
          model_name: "general",
          current_interval_remaining_percent: 50,
          end_time: 1_000_000,
        },
      ],
    }, minimaxProvider);
    assert.ok(r);
    assert.equal(r.fiveHour?.resetAt, new Date(1_000_000).toISOString());
    assert.equal(r.fiveHour?.resetStartAt, undefined);
    assert.equal(r.fiveHour?.resetDurationMs, undefined);
  });

  it("picks the most-active entry (lowest interval_remaining_percent)", () => {
    const r = parseRemains({
      model_remains: [
        {
          model_name: "video",
          current_interval_remaining_percent: 100,
          current_weekly_remaining_percent: 100,
        },
        {
          model_name: "general",
          current_interval_remaining_percent: 20,
          current_weekly_remaining_percent: 50,
        },
      ],
    }, minimaxProvider);
    assert.ok(r);
    assert.equal(r.fiveHour?.pct, 80);
    assert.equal(r.weekly?.pct, 50);
  });

  it("uses weekly percent when interval percent is absent", () => {
    const r = parseRemains({
      model_remains: [
        {
          model_name: "general",
          current_weekly_remaining_percent: 75,
        },
      ],
    }, minimaxProvider);
    assert.ok(r);
    assert.equal(r.fiveHour, null);
    assert.equal(r.weekly?.pct, 25);
  });
});

describe("parseRemains — slot derivation", () => {
  // Provider whose `usedPercentInterval` / `usedPercentWeekly` come
  // from a non-default path. Exercises the "user supplies USED, we
  // derive remaining" branch (the inverse of the minimax default).
  const usedMappedProvider: ProviderEntry = {
    ...minimaxProvider,
    parameters: {
      usedPercentInterval: "model_remains.0.current_interval_remaining_percent",
      usedPercentWeekly:   "model_remains.0.current_weekly_remaining_percent",
      startAtInterval:      "model_remains.0.start_time",
      endAtInterval:        "model_remains.0.end_time",
      startAtWeekly:        "model_remains.0.weekly_start_time",
      endAtWeekly:          "model_remains.0.weekly_end_time",
    },
  };

  it("uses used% directly when both used and remaining are mapped (used wins)", () => {
    const r = parseRemains({
      model_remains: [
        { current_interval_remaining_percent: 30 },
      ],
    }, usedMappedProvider);
    assert.ok(r);
    // used% raw is 30; remaining would be 70. The "used wins" rule
    // means pct=30. (Minimax's "remaining" mapping would yield
    // 100-30=70. We follow the user's mapping: they wired used
    // directly, so we trust it.)
    assert.equal(r.fiveHour?.pct, 30);
  });

  it("derives used% from remaining% when only remaining is mapped (default minimax)", () => {
    const r = parseRemains({
      model_remains: [
        { current_interval_remaining_percent: 25 },
      ],
    }, minimaxProvider);
    assert.ok(r);
    assert.equal(r.fiveHour?.pct, 75);
  });

  it("returns null when both used% and remaining% are unmapped", () => {
    // An entry with no percentage fields yields no windows; the parser
    // treats this as "no recognizable data" and gives up entirely
    // (returns null), matching the dispatcher's "no data → no line"
    // contract.
    const r = parseRemains({
      model_remains: [
        { model_name: "general" },
      ],
    }, minimaxProvider);
    assert.equal(r, null);
  });

  it("clamps out-of-range percentages to [0, 100]", () => {
    const r = parseRemains({
      model_remains: [
        { current_interval_remaining_percent: 150 },
      ],
    }, minimaxProvider);
    assert.ok(r);
    // 100 - 150 = -50, clamped to 0.
    assert.equal(r.fiveHour?.pct, 0);
  });
});

describe("parseRemains — error paths", () => {
  it("returns null on non-zero base_resp.status_code", () => {
    assert.equal(parseRemains(fixture("remains.empty.json"), minimaxProvider), null);
  });

  it("returns null when no recognizable windows", () => {
    assert.equal(parseRemains({ data: { something: "else" } }, minimaxProvider), null);
  });

  it("handles malformed input gracefully", () => {
    assert.equal(parseRemains(null, minimaxProvider), null);
    assert.equal(parseRemains(undefined, minimaxProvider), null);
    assert.equal(parseRemains("string", minimaxProvider), null);
    assert.equal(parseRemains(42, minimaxProvider), null);
    assert.equal(parseRemains([], minimaxProvider), null);
  });
});

// ----- v0.6.0+ HTTP override plumbing -----
//
// Mock the global fetch so we can inspect the RequestInit the fetcher
// actually constructs without touching the network. Each test gets a
// fresh recorder via beforeEach; afterEach restores the original
// fetch so the test runner's own I/O is unaffected.
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
        base_resp: { status_code: 0, status_msg: "ok" },
        model_remains: [
          {
            current_interval_remaining_percent: 50,
            current_weekly_remaining_percent: 50,
            end_time: Date.now() + 3_600_000,
            weekly_end_time: Date.now() + 7 * 24 * 3_600_000,
          },
        ],
      }),
      {
        status: 200,
        headers: { "content-type": "application/json" },
      },
    ) as unknown as Response;
  }) as typeof fetch;
  return () => {
    globalThis.fetch = original;
  };
}

describe("fetchRemains — per-provider HTTP overrides (v0.6.0+)", () => {
  const rec: RecordedCall[] = [];
  let restore: () => void;
  beforeEach(() => {
    rec.length = 0;
    restore = installMockFetch(rec);
  });
  afterEach(() => restore());

  it("uses entry.BEARER_KEY over the env-supplied token", async () => {
    const entry: ProviderEntry = {
      ...minimaxProvider,
      BEARER_KEY: "secret-from-config",
    };
    const r = await fetchRemains(
      "env-token",
      entry.ENDPOINT,
      undefined,
      entry,
    );
    assert.ok(r);
    const sent = rec[0].init.headers as Record<string, string>;
    assert.equal(sent.Authorization, "Bearer secret-from-config");
  });

  it("falls back to env token when BEARER_KEY is absent", async () => {
    await fetchRemains(
      "env-token",
      minimaxProvider.ENDPOINT,
      undefined,
      minimaxProvider,
    );
    const sent = rec[0].init.headers as Record<string, string>;
    assert.equal(sent.Authorization, "Bearer env-token");
  });

  it("POSTs entry.BODY as JSON when METHOD=POST and BODY is set", async () => {
    const entry: ProviderEntry = {
      ...minimaxProvider,
      METHOD: "POST",
      BODY: { foo: "bar", n: 42 },
    };
    await fetchRemains("t", entry.ENDPOINT, undefined, entry);
    assert.equal(rec[0].init.method, "POST");
    assert.equal(rec[0].init.body, JSON.stringify({ foo: "bar", n: 42 }));
  });

  it("GET with BODY present still sends no body (spec-friendly)", async () => {
    const entry: ProviderEntry = {
      ...minimaxProvider,
      BODY: { foo: "bar" },
    };
    await fetchRemains("t", entry.ENDPOINT, undefined, entry);
    assert.equal(rec[0].init.method, "GET");
    assert.equal(rec[0].init.body, undefined);
  });

  it("returns null when env token is empty AND entry.BEARER_KEY is absent", async () => {
    const r = await fetchRemains(
      "",
      minimaxProvider.ENDPOINT,
      undefined,
      minimaxProvider,
    );
    assert.equal(r, null);
    assert.equal(
      rec.length,
      0,
      "must not hit the network when no token source is available",
    );
  });

  it("uses entry.BEARER_KEY even when env token is empty", async () => {
    const entry: ProviderEntry = {
      ...minimaxProvider,
      BEARER_KEY: "config-only",
    };
    const r = await fetchRemains("", entry.ENDPOINT, undefined, entry);
    assert.ok(r);
    assert.equal(rec.length, 1);
    const sent = rec[0].init.headers as Record<string, string>;
    assert.equal(sent.Authorization, "Bearer config-only");
  });
});
