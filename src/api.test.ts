import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { parseRemains, fetchRemains } from "./api.ts";
import type { IntervalConfig, ProviderEntry } from "./types.ts";

const here = dirname(fileURLToPath(import.meta.url));
const fixture = (name: string): unknown =>
  JSON.parse(readFileSync(resolve(here, "__fixtures__", name), "utf8"));

// Minimal ProviderEntry carrying the default minimax intervals so
// parseRemains gets the same slots the live dispatcher would. Tests
// that need a custom mapping build their own entry.
const minimaxProvider: ProviderEntry = {
  TYPE: "TOKEN_PLAN",
  BASE_URL_COMPARED_TO: "https://api.minimaxi.com/anthropic",
  COMPARE_METHOD: "EXACT",
  ENDPOINT: "https://www.minimaxi.com/v1/token_plan/remains",
  // intervals omitted on purpose — validateProviderEntry fills in
  // MINIMAX_DEFAULT_INTERVALS (current_interval_remaining_percent /
  // current_weekly_remaining_percent + start/end_time pairs) when
  // the entry's ENDPOINT is minimaxi.com and no intervals are
  // supplied. parseRemains receives those defaults via fetchRemains.
  //
  // Tests that want to bypass the built-in defaults can pass an
  // explicit `intervalsConfig` to parseRemains directly.
};

// In tests we don't go through validateProviderEntry (the unit test
// sets up ProviderEntry literals above). To preserve the byte-
// identical minimax behavior the live dispatcher would have, tests
// inline the same MINIMAX_DEFAULT_INTERVALS here and pass it as the
// third arg to parseRemains. This keeps the unit tests independent
// of config.ts while still exercising the "default path mappings"
// branch of the parser.
const minimaxDefaultIntervals: IntervalConfig = {
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

// Project an Interval to the legacy Window shape (pct / resetAt /
// resetStartAt / resetDurationMs). The renderer-side `intervalToWindow`
// helper does the same projection for live callers; tests inline the
// logic here so we don't import the renderer (which would pull in
// configStore + index side effects).
function intervalToWindow(iv: import("./api.ts").Remains["shortInterval"]): {
  pct: number;
  resetAt: string | undefined;
  resetStartAt: string | undefined;
  resetDurationMs: number | undefined;
} | null {
  if (!iv) return null;
  const used = iv.usedPercent != null ? iv.usedPercent : (iv.remainingPercent != null ? 100 - iv.remainingPercent : null);
  if (used == null) return null;
  const resetAt = iv.endAt != null ? new Date(iv.endAt).toISOString() : undefined;
  const resetStartAt = iv.startAt != null ? new Date(iv.startAt).toISOString() : undefined;
  const resetDurationMs = iv.intervalMs != null ? iv.intervalMs : (iv.startAt != null && iv.endAt != null ? iv.endAt - iv.startAt : undefined);
  return { pct: used, resetAt, resetStartAt, resetDurationMs };
}

describe("parseRemains — model_remains array shape (real)", () => {
  it("parses the captured real fixture", () => {
    const r = parseRemains(fixture("remains.real.json"), minimaxProvider, minimaxDefaultIntervals);
    assert.ok(r);
    // Most active model is "general" with interval remaining 66%, weekly 61%.
    // → used% = 34% interval, 39% weekly.
    const shortWin = intervalToWindow(r.shortInterval);
    const midWin = intervalToWindow(r.midInterval);
    assert.ok(shortWin);
    assert.ok(midWin);
    assert.equal(shortWin.pct, 34);
    assert.equal(midWin.pct, 39);
    assert.equal(typeof shortWin.resetAt, "string");
    assert.equal(typeof midWin.resetAt, "string");
  });

  it("threads resetStartAt and resetDurationMs from start_time/end_time", () => {
    const r = parseRemains(fixture("remains.real.json"), minimaxProvider, minimaxDefaultIntervals);
    assert.ok(r);
    const shortWin = intervalToWindow(r.shortInterval);
    const midWin = intervalToWindow(r.midInterval);
    assert.ok(shortWin);
    assert.ok(midWin);
    assert.equal(shortWin.resetDurationMs, 4 * 3_600_000);
    assert.equal(midWin.resetDurationMs, 7 * 24 * 3_600_000);
    const fhStart = Date.parse(shortWin.resetStartAt ?? "");
    const wkStart = Date.parse(midWin.resetStartAt ?? "");
    assert.ok(Number.isFinite(fhStart));
    assert.ok(Number.isFinite(wkStart));
    assert.equal(
      Date.parse(shortWin.resetAt!) - fhStart,
      shortWin.resetDurationMs!
    );
    assert.equal(
      Date.parse(midWin.resetAt!) - wkStart,
      midWin.resetDurationMs!
    );
  });

  it("omits startAt/intervalMs when the source has no start_time AND no intervalMs (at-least-2-of-3 floor)", () => {
    // v0.9.0+ — only 1 of 3 time fields is present (end_time), so the
    // at-least-2-of-3 rule nulls the entire time group. The interval
    // is still alive (percent group has data) but resetStartAt /
    // resetAt / resetDurationMs are all null.
    const r = parseRemains({
      model_remains: [
        {
          model_name: "general",
          current_interval_remaining_percent: 50,
          end_time: 1_000_000,
        },
      ],
    }, minimaxProvider, minimaxDefaultIntervals);
    assert.ok(r);
    assert.ok(r.shortInterval);
    assert.equal(r.shortInterval.startAt, null);
    assert.equal(r.shortInterval.endAt, null);
    assert.equal(r.shortInterval.intervalMs, null);
    // usedPercent is still resolved — the interval survives on the
    // percent group alone.
    assert.equal(r.shortInterval.usedPercent, 50);
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
    }, minimaxProvider, minimaxDefaultIntervals);
    assert.ok(r);
    const shortWin = intervalToWindow(r.shortInterval);
    const midWin = intervalToWindow(r.midInterval);
    assert.ok(shortWin);
    assert.ok(midWin);
    assert.equal(shortWin.pct, 80);
    assert.equal(midWin.pct, 50);
  });

  it("returns null when only weekly percent is present (short interval has no data)", () => {
    const r = parseRemains({
      model_remains: [
        {
          model_name: "general",
          current_weekly_remaining_percent: 75,
        },
      ],
    }, minimaxProvider, minimaxDefaultIntervals);
    assert.ok(r);
    assert.equal(r.shortInterval, null);
    const midWin = intervalToWindow(r.midInterval);
    assert.ok(midWin);
    assert.equal(midWin.pct, 25);
  });
});

describe("parseRemains — slot derivation", () => {
  // Provider whose `usedPercent` / `startAt` / `endAt` come from a
  // non-default path. Exercises the "user supplies USED, we derive
  // remaining" branch (the inverse of the minimax default).
  const usedMappedIntervals: IntervalConfig = {
    shortInterval: {
      usedPercent: "model_remains.0.current_interval_remaining_percent",
      startAt: "model_remains.0.start_time",
      endAt: "model_remains.0.end_time",
    },
    midInterval: {
      usedPercent: "model_remains.0.current_weekly_remaining_percent",
      startAt: "model_remains.0.weekly_start_time",
      endAt: "model_remains.0.weekly_end_time",
    },
    longInterval: {},
  };

  it("uses used% directly when both used and remaining are mapped (used wins)", () => {
    const r = parseRemains({
      model_remains: [
        { current_interval_remaining_percent: 30 },
      ],
    }, minimaxProvider, usedMappedIntervals);
    assert.ok(r);
    // used% raw is 30; remaining would be 70. The "used wins" rule
    // means pct=30. (Minimax's "remaining" mapping would yield
    // 100-30=70. We follow the user's mapping: they wired used
    // directly, so we trust it.)
    const shortWin = intervalToWindow(r.shortInterval);
    assert.ok(shortWin);
    assert.equal(shortWin.pct, 30);
  });

  it("derives used% from remaining% when only remaining is mapped (default minimax)", () => {
    const r = parseRemains({
      model_remains: [
        { current_interval_remaining_percent: 25 },
      ],
    }, minimaxProvider, minimaxDefaultIntervals);
    assert.ok(r);
    const shortWin = intervalToWindow(r.shortInterval);
    assert.ok(shortWin);
    assert.equal(shortWin.pct, 75);
  });

  it("returns null when both used% and remaining% are unmapped", () => {
    // An entry with no percentage fields yields no intervals; the
    // parser treats this as "no recognizable data" and gives up
    // entirely (returns null), matching the dispatcher's "no data →
    // no line" contract.
    const r = parseRemains({
      model_remains: [
        { model_name: "general" },
      ],
    }, minimaxProvider, minimaxDefaultIntervals);
    assert.equal(r, null);
  });

  it("derives used% = 100 - remaining% without clamping (out-of-range values pass through)", () => {
    // v0.9.0+ — the parser no longer clamps percentages to [0, 100].
    // A remainingPercent of 150 yields usedPercent = -50, which is
    // what the renderer paints. (The original v0.5.0 clamp was
    // removed because (a) real providers never ship out-of-range
    // values and (b) clamping silently hides upstream bugs.)
    const r = parseRemains({
      model_remains: [
        { current_interval_remaining_percent: 150 },
      ],
    }, minimaxProvider, minimaxDefaultIntervals);
    assert.ok(r);
    // 100 - 150 = -50.
    assert.equal(r.shortInterval?.usedPercent, -50);
    assert.equal(r.shortInterval?.remainingPercent, 150);
  });
});

describe("parseRemains — intervals namespace (v0.9.0+)", () => {
  describe("3-step intervalMs fallback chain", () => {
    it("step 1: raw intervalMs is used directly when it is a plain number", () => {
      const cfg: IntervalConfig = {
        shortInterval: {
          remainingPercent: "model_remains.0.current_interval_remaining_percent",
          startAt: "model_remains.0.start_time",
          intervalMs: 18_000_000,
        },
        midInterval: {},
        longInterval: {},
      };
      const r = parseRemains({
        model_remains: [
          {
            current_interval_remaining_percent: 50,
            start_time: 100,
          },
        ],
      }, minimaxProvider, cfg);
      assert.ok(r);
      // startAt + intervalMs → endAt = startAt + intervalMs.
      assert.equal(r.shortInterval?.intervalMs, 18_000_000);
      assert.equal(r.shortInterval?.startAt, 100);
      assert.equal(r.shortInterval?.endAt, 18_000_100);
    });

    it("step 1b: raw intervalS is converted to ms by multiplying by 1000", () => {
      const cfg: IntervalConfig = {
        shortInterval: {
          remainingPercent: "model_remains.0.current_interval_remaining_percent",
          startAt: "model_remains.0.start_time",
          intervalS: 18_000,
        },
        midInterval: {},
        longInterval: {},
      };
      const r = parseRemains({
        model_remains: [
          {
            current_interval_remaining_percent: 50,
            start_time: 100,
          },
        ],
      }, minimaxProvider, cfg);
      assert.ok(r);
      assert.equal(r.shortInterval?.intervalMs, 18_000_000);
    });

    it("step 2: keyword lookup against response root fires when no slot.intervalMs / intervalS is mapped", () => {
      const cfg: IntervalConfig = {
        shortInterval: {
          remainingPercent: "model_remains.0.current_interval_remaining_percent",
          startAt: "model_remains.0.start_time",
        },
        midInterval: {},
        longInterval: {},
      };
      const r = parseRemains({
        model_remains: [
          {
            current_interval_remaining_percent: 50,
            start_time: 100,
          },
        ],
        // Keyword lookup probes the response root, not the array element.
        fiveHour: 5,
      }, minimaxProvider, cfg);
      assert.ok(r);
      // fiveHour=5 × 18_000_000 ms = 90_000_000 ms.
      assert.equal(r.shortInterval?.intervalMs, 90_000_000);
    });

    it("step 2: keyword lookup matches 'day' / 'week' / 'month' aliases", () => {
      for (const [key, expected] of [
        ["day",   86_400_000],
        ["week",  604_800_000],
        ["month", 2_592_000_000],
      ] as const) {
        const cfg: IntervalConfig = {
          shortInterval: {
            remainingPercent: "model_remains.0.current_interval_remaining_percent",
            startAt: "model_remains.0.start_time",
          },
          midInterval: {},
          longInterval: {},
        };
        const r = parseRemains({
          model_remains: [
            { current_interval_remaining_percent: 50, start_time: 100 },
          ],
          [key]: 1,
        }, minimaxProvider, cfg);
        assert.ok(r);
        assert.equal(r.shortInterval?.intervalMs, expected);
      }
    });
  });

  describe("time-group derivation (at-least-2-of-3)", () => {
    it("startAt + endAt → use both (explicit wins)", () => {
      const cfg: IntervalConfig = {
        shortInterval: {
          remainingPercent: "model_remains.0.current_interval_remaining_percent",
          startAt: "model_remains.0.start_time",
          endAt: "model_remains.0.end_time",
        },
        midInterval: {},
        longInterval: {},
      };
      const r = parseRemains({
        model_remains: [{ current_interval_remaining_percent: 50, start_time: 100, end_time: 200 }],
      }, minimaxProvider, cfg);
      assert.ok(r);
      assert.equal(r.shortInterval?.startAt, 100);
      assert.equal(r.shortInterval?.endAt, 200);
    });

    it("startAt + intervalMs → derive endAt", () => {
      const cfg: IntervalConfig = {
        shortInterval: {
          remainingPercent: "model_remains.0.current_interval_remaining_percent",
          startAt: "model_remains.0.start_time",
          intervalMs: 18_000_000,
        },
        midInterval: {},
        longInterval: {},
      };
      const r = parseRemains({
        model_remains: [{ current_interval_remaining_percent: 50, start_time: 100 }],
      }, minimaxProvider, cfg);
      assert.ok(r);
      assert.equal(r.shortInterval?.startAt, 100);
      assert.equal(r.shortInterval?.endAt, 100 + 18_000_000);
    });

    it("endAt + intervalMs → derive startAt", () => {
      const cfg: IntervalConfig = {
        shortInterval: {
          remainingPercent: "model_remains.0.current_interval_remaining_percent",
          endAt: "model_remains.0.end_time",
          intervalMs: 18_000_000,
        },
        midInterval: {},
        longInterval: {},
      };
      const r = parseRemains({
        model_remains: [{ current_interval_remaining_percent: 50, end_time: 18_000_100 }],
      }, minimaxProvider, cfg);
      assert.ok(r);
      assert.equal(r.shortInterval?.endAt, 18_000_100);
      assert.equal(r.shortInterval?.startAt, 100);
    });

    it("only 1 of 3 time fields → all null (at-least-2 floor)", () => {
      const cfg: IntervalConfig = {
        shortInterval: {
          remainingPercent: "model_remains.0.current_interval_remaining_percent",
          endAt: "model_remains.0.end_time",
        },
        midInterval: {},
        longInterval: {},
      };
      const r = parseRemains({
        model_remains: [{ current_interval_remaining_percent: 50, end_time: 18_000_100 }],
      }, minimaxProvider, cfg);
      assert.ok(r);
      // startAt/endAt/intervalMs all null — interval is time-unknown.
      assert.equal(r.shortInterval?.startAt, null);
      assert.equal(r.shortInterval?.endAt, null);
      assert.equal(r.shortInterval?.intervalMs, null);
    });
  });

  describe("quota group resolution", () => {
    it("resolves all three quota fields independently", () => {
      const cfg: IntervalConfig = {
        shortInterval: {
          remainingQuota: "model_remains.0.remaining",
          usedQuota: "model_remains.0.used",
          limitQuota: "model_remains.0.limit",
        },
        midInterval: {},
        longInterval: {},
      };
      const r = parseRemains({
        model_remains: [{ remaining: 100, used: 400, limit: 500 }],
      }, minimaxProvider, cfg);
      assert.ok(r);
      assert.equal(r.shortInterval?.remainingQuota, 100);
      assert.equal(r.shortInterval?.usedQuota, 400);
      assert.equal(r.shortInterval?.limitQuota, 500);
    });

    it("keeps null fields null (no derivation between quota fields)", () => {
      const cfg: IntervalConfig = {
        shortInterval: {
          usedQuota: "model_remains.0.used",
          limitQuota: "model_remains.0.limit",
        },
        midInterval: {},
        longInterval: {},
      };
      const r = parseRemains({
        model_remains: [{ used: 400, limit: 500 }],
      }, minimaxProvider, cfg);
      assert.ok(r);
      assert.equal(r.shortInterval?.remainingQuota, null);
      assert.equal(r.shortInterval?.usedQuota, 400);
      assert.equal(r.shortInterval?.limitQuota, 500);
    });
  });

  describe("null interval contract", () => {
    it("returns null when ALL groups fail (no data anywhere)", () => {
      const cfg: IntervalConfig = {
        shortInterval: { remainingPercent: "model_remains.0.nope" },
        midInterval: {},
        longInterval: {},
      };
      const r = parseRemains({
        model_remains: [{ model_name: "general" }],
      }, minimaxProvider, cfg);
      assert.equal(r, null);
    });

    it("keeps interval alive when at least one percent or quota field is present", () => {
      const cfg: IntervalConfig = {
        shortInterval: {
          usedQuota: "model_remains.0.used",
        },
        midInterval: {},
        longInterval: {},
      };
      const r = parseRemains({
        model_remains: [{ used: 400 }],
      }, minimaxProvider, cfg);
      assert.ok(r);
      assert.ok(r.shortInterval);
      assert.equal(r.shortInterval.usedQuota, 400);
      assert.equal(r.shortInterval.remainingPercent, null);
    });
  });

  describe("default MiniMax mapping (byte-equivalent to v0.8.x)", () => {
    it("reproduces the v0.8.27 default shortInterval shape", () => {
      const r = parseRemains({
        model_remains: [
          {
            model_name: "general",
            current_interval_remaining_percent: 66,
            current_weekly_remaining_percent: 61,
            start_time: 1_000,
            end_time: 1_000 + 4 * 3_600_000,
            weekly_start_time: 2_000,
            weekly_end_time: 2_000 + 7 * 24 * 3_600_000,
          },
        ],
      }, minimaxProvider, minimaxDefaultIntervals);
      assert.ok(r);
      const shortWin = intervalToWindow(r.shortInterval);
      const midWin = intervalToWindow(r.midInterval);
      assert.ok(shortWin);
      assert.ok(midWin);
      // 100 - 66 = 34% used, 100 - 61 = 39% used.
      assert.equal(shortWin.pct, 34);
      assert.equal(midWin.pct, 39);
      assert.equal(shortWin.resetDurationMs, 4 * 3_600_000);
      assert.equal(midWin.resetDurationMs, 7 * 24 * 3_600_000);
      // longInterval has no built-in minimax mapping → null.
      assert.equal(r.longInterval, null);
    });
  });
});

describe("parseRemains — error paths", () => {
  it("returns null on non-zero base_resp.status_code", () => {
    assert.equal(parseRemains(fixture("remains.empty.json"), minimaxProvider, minimaxDefaultIntervals), null);
  });

  it("returns null when no recognizable windows", () => {
    assert.equal(parseRemains({ data: { something: "else" } }, minimaxProvider, minimaxDefaultIntervals), null);
  });

  it("handles malformed input gracefully", () => {
    assert.equal(parseRemains(null, minimaxProvider, minimaxDefaultIntervals), null);
    assert.equal(parseRemains(undefined, minimaxProvider, minimaxDefaultIntervals), null);
    assert.equal(parseRemains("string", minimaxProvider, minimaxDefaultIntervals), null);
    assert.equal(parseRemains(42, minimaxProvider, minimaxDefaultIntervals), null);
    assert.equal(parseRemains([], minimaxProvider, minimaxDefaultIntervals), null);
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

  // fetchRemains reads the provider's `intervals` block. The mock
  // returns model_remains[0] with current_interval_remaining_percent
  // and current_weekly_remaining_percent — the same fields the
  // minimax defaults map to. We seed the entries with the minimax
  // defaults so the parser has a path to follow.
  const withIntervals = (e: ProviderEntry): ProviderEntry => ({
    ...e,
    intervals: minimaxDefaultIntervals,
  });

  it("uses entry.BEARER_KEY over the env-supplied token", async () => {
    const entry = withIntervals({
      ...minimaxProvider,
      BEARER_KEY: "secret-from-config",
    });
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
      withIntervals(minimaxProvider),
    );
    const sent = rec[0].init.headers as Record<string, string>;
    assert.equal(sent.Authorization, "Bearer env-token");
  });

  it("POSTs entry.BODY as JSON when METHOD=POST and BODY is set", async () => {
    const entry = withIntervals({
      ...minimaxProvider,
      METHOD: "POST",
      BODY: { foo: "bar", n: 42 },
    });
    await fetchRemains("t", entry.ENDPOINT, undefined, entry);
    assert.equal(rec[0].init.method, "POST");
    assert.equal(rec[0].init.body, JSON.stringify({ foo: "bar", n: 42 }));
  });

  it("GET with BODY present still sends no body (spec-friendly)", async () => {
    const entry = withIntervals({
      ...minimaxProvider,
      BODY: { foo: "bar" },
    });
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
    const entry = withIntervals({
      ...minimaxProvider,
      BEARER_KEY: "config-only",
    });
    const r = await fetchRemains("", entry.ENDPOINT, undefined, entry);
    assert.ok(r);
    assert.equal(rec.length, 1);
    const sent = rec[0].init.headers as Record<string, string>;
    assert.equal(sent.Authorization, "Bearer config-only");
  });
});

// ----- vX.X.X+ transport layer (http / exec / plugin) -----------------
//
// detectTransport decides which transport layer to route through,
// based on the ENDPOINT's prefix + the presence of a bundled plugin
// file at ~/.claude/plugins/topgauge-cc/query_plugins/<id>/index.js.
// The three transports each have a separate test below; this header
// covers the central dispatch.
//
// HOME is monkey-patched in the pluginTransport suite so we can drop
// a synthetic query_plugins tree under a tmpdir.
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  detectTransport,
  execTransport,
  pluginTransport,
  queryPluginsDir,
  queryPluginPath,
  fetchForProviderById,
} from "./api.ts";

describe("queryPluginsDir + queryPluginPath", () => {
  it("resolves under homedir()", () => {
    // The function does not cache the path; subsequent calls in the
    // same process pick up any HOME override made after first call.
    const d = queryPluginsDir();
    const h = process.env.HOME || process.env.USERPROFILE;
    assert.ok(d.includes("topgauge-cc/query_plugins") || d.endsWith("topgauge-cc\\query_plugins"));
    if (h) {
      assert.ok(d.startsWith(h), `expected ${d} to start with HOME=${h}`);
    }
  });

  it("queryPluginPath(id) joins <dir>/<id>/index.js", () => {
    const d = queryPluginsDir();
    assert.equal(queryPluginPath("myscript"), join(d, "myscript", "index.js"));
  });
});

describe("detectTransport", () => {
  let sandbox: string | null = null;
  let originalHome: string | undefined;
  let originalProfile: string | undefined;

  beforeEach(() => {
    sandbox = mkdtempSync(join(tmpdir(), "topgauge-cc-detect-"));
    originalHome = process.env.HOME;
    originalProfile = process.env.USERPROFILE;
    // On Windows, queryPluginsDir uses homedir() which honors
    // USERPROFILE; on Linux/macOS it uses HOME. Override BOTH so
    // the function-resolved path targets our tmpdir.
    process.env.HOME = sandbox;
    process.env.USERPROFILE = sandbox;
  });
  afterEach(() => {
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
    if (originalProfile === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = originalProfile;
    if (sandbox) rmSync(sandbox, { recursive: true, force: true });
    sandbox = null;
  });

  it("http:// → http", () => {
    assert.equal(detectTransport("http://example.com/foo", "any"), "http");
  });
  it("https:// → http", () => {
    assert.equal(detectTransport("https://example.com/foo", "any"), "http");
  });
  it("arbitrary command string → exec", () => {
    assert.equal(detectTransport("python3 /opt/fetch.py", "any"), "exec");
  });
  it("non-empty non-http → exec (no leading / required)", () => {
    assert.equal(detectTransport("echo hello", "any"), "exec");
  });
  it("empty string + plugin file present → plugin", () => {
    const dir = join(sandbox!, ".claude", "plugins", "topgauge-cc", "query_plugins", "myscript");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "index.js"), "process.stdout.write('{}');");
    assert.equal(detectTransport("", "myscript"), "plugin");
  });
  it("empty string + plugin file absent → throws", () => {
    assert.throws(
      () => detectTransport("", "no-such-provider"),
      /ENDPOINT=""/,
    );
  });
});

describe("execTransport", () => {
  it("captures stdout from a `node -e` invocation", async () => {
    const body = await execTransport("node -e \"process.stdout.write('hello-world');\"");
    assert.equal(body, "hello-world");
  });

  it("returns empty string when the command outputs nothing", async () => {
    const body = await execTransport("node -e \"process.exit(0);\"");
    assert.equal(body, "");
  });

  it("throws (and the caller propagates) on non-zero exit", async () => {
    await assert.rejects(
      () => execTransport("node -e \"process.exit(1);\""),
      /Command failed/,
    );
  });
});

describe("pluginTransport", () => {
  let sandbox: string | null = null;
  let originalHome: string | undefined;
  let originalProfile: string | undefined;
  let pluginDir: string | null = null;

  beforeEach(() => {
    sandbox = mkdtempSync(join(tmpdir(), "topgauge-cc-plugin-"));
    originalHome = process.env.HOME;
    originalProfile = process.env.USERPROFILE;
    process.env.HOME = sandbox;
    process.env.USERPROFILE = sandbox;
    pluginDir = join(
      sandbox!,
      ".claude",
      "plugins",
      "topgauge-cc",
      "query_plugins",
      "myscript",
    );
    mkdirSync(pluginDir, { recursive: true });
  });
  afterEach(() => {
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
    if (originalProfile === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = originalProfile;
    if (sandbox) rmSync(sandbox, { recursive: true, force: true });
    sandbox = null;
    pluginDir = null;
  });

  it("calls fetchAccountQuota(token) on the imported module and returns its value as-is", async () => {
    // The plugin is a .mjs ESM module so dynamic import() works
    // without an adjacent package.json. `fetchAccountQuota` returns the
    // canonical Balance shape directly; pluginTransport must
    // surface that object verbatim (no JSON.parse / no parseBalance).
    writeFileSync(
      join(pluginDir!, "index.mjs"),
      `export default {
         async fetchAccountQuota(token) {
           return {
             isAvailable: token === "good-token",
             entries: [{ currency: "CNY", totalBalance: 42 }],
             minValue: null,
           };
         },
       };`,
    );
    const out = await pluginTransport("myscript", "good-token");
    assert.equal(typeof out, "object");
    const bal = out as { isAvailable: boolean; entries: Array<{ currency: string; totalBalance: number }> };
    assert.equal(bal.isAvailable, true);
    assert.equal(bal.entries[0].currency, "CNY");
    assert.equal(bal.entries[0].totalBalance, 42);
  });

  it("passes the token argument through to fetchAccountQuota (plugin decides how to use it)", async () => {
    // The plugin author sees `token` as the only argument. We use
    // the returned object to surface the captured value back to the
    // test (ESM module instances don't share outer mutable state
    // across imports).
    writeFileSync(
      join(pluginDir!, "index.mjs"),
      `export default {
         async fetchAccountQuota(token) {
           return { isAvailable: true, entries: [{ currency: token, totalBalance: 0 }], minValue: null };
         },
       };`,
    );
    const out = await pluginTransport("myscript", "secret-token");
    const bal = out as { entries: Array<{ currency: string }> };
    assert.equal(bal.entries[0].currency, "secret-token");
  });

  it("throws when query_plugins/<id>/index.js is missing", async () => {
    // We never created pluginDir/<id> for nonexistent — use a
    // different tmpdir path to be sure.
    const otherSandbox = mkdtempSync(join(tmpdir(), "topgauge-cc-plugin-missing-"));
    const oldHome = process.env.HOME;
    const oldProfile = process.env.USERPROFILE;
    process.env.HOME = otherSandbox;
    process.env.USERPROFILE = otherSandbox;
    try {
      await assert.rejects(
        () => pluginTransport("nonexistent", "t"),
        /plugin .*index\.js|Cannot find|cannot find/i,
      );
    } finally {
      process.env.HOME = oldHome;
      process.env.USERPROFILE = oldProfile;
      rmSync(otherSandbox, { recursive: true, force: true });
    }
  });

  it("throws when the loaded module has no `default` export", async () => {
    writeFileSync(
      join(pluginDir!, "index.mjs"),
      `export const fetchAccountQuota = async () => ({ isAvailable: true });`,
    );
    await assert.rejects(
      () => pluginTransport("myscript", "t"),
      /default export/,
    );
  });

  it("throws when the default export has no `fetchAccountQuota` method", async () => {
    writeFileSync(
      join(pluginDir!, "index.mjs"),
      `export default { wrongName() { return {}; } };`,
    );
    await assert.rejects(
      () => pluginTransport("myscript", "t"),
      /default export must be/,
    );
  });

  it("propagates errors thrown inside fetchAccountQuota", async () => {
    writeFileSync(
      join(pluginDir!, "index.mjs"),
      `export default {
         async fetchAccountQuota() { throw new Error("upstream busted"); },
       };`,
    );
    await assert.rejects(
      () => pluginTransport("myscript", "t"),
      /upstream busted/,
    );
  });
});

describe("fetchForProviderById — end-to-end dispatcher", () => {
  let sandbox: string | null = null;
  let originalHome: string | undefined;
  let originalProfile: string | undefined;

  beforeEach(() => {
    sandbox = mkdtempSync(join(tmpdir(), "topgauge-cc-fp-"));
    originalHome = process.env.HOME;
    originalProfile = process.env.USERPROFILE;
    process.env.HOME = sandbox;
    process.env.USERPROFILE = sandbox;
  });
  afterEach(() => {
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
    if (originalProfile === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = originalProfile;
    if (sandbox) rmSync(sandbox, { recursive: true, force: true });
    sandbox = null;
  });

  it("TOKEN_PLAN via exec transport: parses a synthetic payload", async () => {
    const entry = {
      TYPE: "TOKEN_PLAN" as const,
      BASE_URL_COMPARED_TO: "https://example.com",
      COMPARE_METHOD: "EXACT" as const,
      ENDPOINT: "node -e \"process.stdout.write(JSON.stringify({base_resp:{status_code:0},model_remains:[{current_interval_remaining_percent:50,current_weekly_remaining_percent:50,end_time:99999999999,weekly_end_time:99999999999}]}))\"",
      intervals: minimaxDefaultIntervals,
    };
    const out = await fetchForProviderById("testplan", entry, "t", undefined);
    assert.ok(out);
    assert.equal((out as { shortInterval: { remainingPercent: number } }).shortInterval.remainingPercent, 50);
  });

  it("BALANCE via plugin transport: runs query_plugins/<id>/index.js", async () => {
    const dir = join(sandbox!, ".claude", "plugins", "topgauge-cc", "query_plugins", "testbal");
    mkdirSync(dir, { recursive: true });
    // Plugin contract: ESM module with `default export { fetchAccountQuota }`.
    writeFileSync(
      join(dir, "index.mjs"),
      `export default {
         async fetchAccountQuota() {
           return {
             isAvailable: true,
             entries: [{ currency: "USD", totalBalance: 7.5 }],
             minValue: null,
           };
         },
       };`,
    );
    const entry = {
      TYPE: "BALANCE" as const,
      BASE_URL_COMPARED_TO: "https://example.com",
      COMPARE_METHOD: "EXACT" as const,
      ENDPOINT: "",
    };
    const out = await fetchForProviderById("testbal", entry, "t", undefined);
    assert.ok(out);
    const bal = out as { isAvailable: boolean; entries: Array<{ currency: string; totalBalance: number }> };
    assert.equal(bal.isAvailable, true);
    assert.equal(bal.entries[0].currency, "USD");
    assert.equal(bal.entries[0].totalBalance, 7.5);
  });

  it("TOKEN_PLAN via plugin transport: plugin's canonical `Remains` shape passes through unparsed", async () => {
    const dir = join(sandbox!, ".claude", "plugins", "topgauge-cc", "query_plugins", "testplan");
    mkdirSync(dir, { recursive: true });
    // The plugin emits the *post-parseRemains* shape — three named
    // intervals, no model_remains array. Dispatcher must accept this
    // shape verbatim, not call parseRemains and lose the structure.
    writeFileSync(
      join(dir, "index.mjs"),
      `export default {
         async fetchAccountQuota() {
           const now = Date.now();
           return {
             shortInterval: {
               label: "5h",
               startAt: now,
               endAt: now + 4*3600*1000,
               intervalMs: 4*3600*1000,
               remainingPercent: 75,
               usedPercent: 25,
             },
             midInterval: {
               label: "7d",
               startAt: now,
               endAt: now + 7*24*3600*1000,
               intervalMs: 7*24*3600*1000,
               remainingPercent: 50,
               usedPercent: 50,
             },
             longInterval: null,
           };
         },
       };`,
    );
    const entry = {
      TYPE: "TOKEN_PLAN" as const,
      BASE_URL_COMPARED_TO: "https://example.com",
      COMPARE_METHOD: "EXACT" as const,
      ENDPOINT: "",
      // No `intervals` block — this is the v0.8.46 contract: plugin
      // authors don't supply a path mapping because they ARE the
      // mapping. The entry's `intervals` field is irrelevant for
      // plugin transport.
    };
    const out = await fetchForProviderById("testplan", entry, "t", undefined);
    assert.ok(out);
    const r = out as { shortInterval: { remainingPercent: number; usedPercent: number } };
    assert.equal(r.shortInterval.remainingPercent, 75);
    assert.equal(r.shortInterval.usedPercent, 25);
  });

  it("plugin transport: invalid shape (non-Remains object on TOKEN_PLAN) returns null", async () => {
    const dir = join(sandbox!, ".claude", "plugins", "topgauge-cc", "query_plugins", "badshape");
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "index.mjs"),
      `export default {
         async fetchAccountQuota() { return "string is not a Remains"; },
       };`,
    );
    const entry = {
      TYPE: "TOKEN_PLAN" as const,
      BASE_URL_COMPARED_TO: "https://example.com",
      COMPARE_METHOD: "EXACT" as const,
      ENDPOINT: "",
    };
    const out = await fetchForProviderById("badshape", entry, "t", undefined);
    assert.equal(out, null);
  });

  it("returns null when entry is null", async () => {
    const out = await fetchForProviderById("anything", null, "t", undefined);
    assert.equal(out, null);
  });

  it("throws when empty ENDPOINT + missing plugin file", async () => {
    const entry = {
      TYPE: "BALANCE" as const,
      BASE_URL_COMPARED_TO: "https://example.com",
      COMPARE_METHOD: "EXACT" as const,
      ENDPOINT: "",
    };
    await assert.rejects(
      () => fetchForProviderById("missing-plugin", entry, "t", undefined),
      /ENDPOINT=""/,
    );
  });
});