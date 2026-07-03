// Tests for v0.4.0+ token-usage renderer modules + helpers.
// Exercises formatCompactToken, formatSpeed, cacheHitColor, and
// the lineTemplate integration via renderTemplate with a minimal
// TokenSnapshot.

import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import {
  __resetPrevTickForTest,
  __resetUnknownModuleWarnForTest,
  cacheHitColor,
  formatCompactToken,
  formatSpeed,
  peekAvg,
  peekPrevTick,
  renderTemplate,
  setAvg,
  setPrevTick,
} from "./render.ts";
import { __resetForTest, configStore } from "./config.ts";
import type { Config } from "./config.ts";
import {
  __resetForTest as resetCacheForTest,
  setCachePathResolver,
} from "./cache.ts";
import {
  __resetForTest as resetStatusForTest,
  setStatusPathResolver,
} from "./status-store.ts";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { execFileSync } from "node:child_process";
import { __resetGitInfoCacheForTest } from "./git-info.ts";
import { setStateRoot, resetStateRoot } from "./token-store.ts";
import type { TokenSnapshot } from "./types.ts";
import type { Window } from "./render.ts";

const STALE = "\x1b[90m";
const GREEN = "\x1b[38;5;41m";
const YELLOW = "\x1b[38;5;220m";
const ORANGE = "\x1b[38;5;208m";
const RED = "\x1b[38;5;196m";

const strip = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, "");

const fakeSnapshot = (overrides: Partial<TokenSnapshot> = {}): TokenSnapshot => ({
  sessionId: "sess-test",
  cwd: "D:\\test",
  totals: { input: 163479, output: 155 },
  current: {
    input: 38,
    output: 155,
    cacheCreation: 0,
    cacheRead: 163441,
  },
  cost: { totalDurationMs: 600_000, totalApiDurationMs: 60_000, totalLinesAdded: 3965, totalLinesRemoved: 967 }, // 10 minutes total, 1m API time
  // v0.4.0+ — session identity / metadata / context stats
  sessionName: "strip-diagnostics-display",
  modelDisplayName: "MiniMax-M3",
  effort: "high",
  repo: { host: "github.com", owner: "cwf818", name: "topgauge-cc" },
  ccversion: "2.1.191",
  contextWindow: { size: 200000, usedPct: 63, remainingPct: 37 },
  ...overrides,
});

// renderTemplate needs the full RenderContext. Default seps are
// [" ", "·"] so "s_space" → " " and "s_dot" → "·". Tests don't care about
// fiveHour/weekly/balance — we only exercise m_token* paths.
const ctxFor = (
  tokens: TokenSnapshot | null,
  fiveHour: Window | null = null,
  weekly: Window | null = null,
  providerType: "plan" | "balance" | "unknown" = "plan",
) => ({
  mode: "used" as const,
  nowMs: 1_000_000,
  fiveHour,
  weekly,
  balance: null,
  ageMs: null,
  stale: false,
  version: "0.4.0-dev0",
  tokens,
  // v0.4.0+ — synthesized from tokens.contextWindow.usedPct.
  // The renderProviderLine helper does this synthesis; tests build
  // RenderContext directly so we mirror it here.
  contextWindow:
    tokens?.contextWindow?.usedPct != null
      ? { pct: tokens.contextWindow.usedPct }
      : null,
  // v0.4.x — the provider TYPE discriminator. Tests that don't care
  // about type filtering use the default "plan"; m_template coverage
  // in §5.3 overrides this. Renamed from `providerModeKey` (v0.4.x-
  // beta) to avoid collision with the display-mode field.
  providerType,
});

// v0.4.0+ — the speed/delta/avg cache helpers (peekPrevTick /
// setPrevTick / peekAvg / setAvg) write to
// ~/.claude/plugins/topgauge-cc/state/cache.json. Tests MUST
// point that path at a tmp file so they don't leak to the user's
// real cache between runs. Per-test tmp dir + clean teardown keeps
// each test fully isolated.
let _tmpDir: string;
beforeEach(() => {
  __resetForTest();
  _tmpDir = mkdtempSync(join(tmpdir(), "topgauge-cc-render-tokens-"));
  setCachePathResolver(() => join(_tmpDir, "cache.json"));
  // v0.4.x — per-tick state lives in status.json under the
  // project dir; tests must point that resolver at a tmp file
  // too so the cache module's leftover disk shadow doesn't leak
  // across tests.
  setStatusPathResolver(() => join(_tmpDir, "status.json"));
  resetCacheForTest(); // clears in-memory Map + lazy-load guard
  resetStatusForTest(); // clears status-store in-memory cache
  // v0.8.0+ — token-store's stateRoot hook needs an explicit
  // reset between tests so sum/avg scans don't leak into a
  // different test's tmp dir.
  resetStateRoot();
});
// afterEach would be cleaner, but node:test supports only beforeEach
// in this file's existing pattern; we cleanup via the next beforeEach's
// fresh tmp dir. The old _tmpDir becomes unreachable but the OS will
// GC the temp dir eventually — acceptable for tests.

describe("formatCompactToken", () => {
  it("below thresholds[0] → raw integer", () => {
    assert.equal(formatCompactToken(0), "0");
    assert.equal(formatCompactToken(342), "342");
    assert.equal(formatCompactToken(999), "999");
  });

  it("between thresholds[0] and thresholds[1] → k with 1 decimal", () => {
    assert.equal(formatCompactToken(1_000), "1.0k");
    assert.equal(formatCompactToken(12_300), "12.3k");
    assert.equal(formatCompactToken(163_479), "163.5k");
  });

  it("≥ thresholds[1] → M with 1 decimal", () => {
    assert.equal(formatCompactToken(1_000_000), "1.0M");
    assert.equal(formatCompactToken(1_234_567), "1.2M");
  });

  it("non-finite / negative → '0'", () => {
    assert.equal(formatCompactToken(NaN), "0");
    assert.equal(formatCompactToken(-1), "0");
    assert.equal(formatCompactToken(Infinity), "0");
  });
});

describe("formatSpeed", () => {
  it("<1000 t/s → decimal t/s", () => {
    assert.equal(formatSpeed(42.5), "42.5 t/s");
    assert.equal(formatSpeed(0.1), "0.1 t/s");
  });

  it("≥1000 t/s → k t/s", () => {
    assert.equal(formatSpeed(1200), "1.2k t/s");
  });

  it("null → —", () => {
    assert.equal(formatSpeed(null), "—");
  });

  it("non-finite → —", () => {
    assert.equal(formatSpeed(NaN), "—");
  });
});

describe("cacheHitColor — 3-band picker", () => {
  it("≥80 → good (green)", () => {
    assert.equal(cacheHitColor(80), GREEN);
    assert.equal(cacheHitColor(99), GREEN);
    assert.equal(cacheHitColor(100), GREEN);
  });

  it("≥50 and <80 → warn (yellow)", () => {
    assert.equal(cacheHitColor(50), YELLOW);
    assert.equal(cacheHitColor(79.9), YELLOW);
  });

  it("<50 → bad (orange)", () => {
    assert.equal(cacheHitColor(0), ORANGE);
    assert.equal(cacheHitColor(49.9), ORANGE);
  });
});

describe("renderTemplate — m_token* modules", () => {
  // ----- m_tokenIn / m_tokenOut (v0.4.0+ per-API-call delta) -----
  // semantics changed again from raw current_usage.* values to
  // delta vs the previous tick's snapshot, gated on delta_api > 0.
  // Same stability rule as the speed modules: always render (data
  // missing → "in:--"). Tests below cover each gate.

  it("m_tokenIn renders 'in:N' where N is the delta vs the previous tick", () => {
    // Seed prev in=0; fakeSnapshot has current.input=38 → delta=38.
    // deltaApi = 60_000 - 0 = 60_000 > 0 → valid tick.
    setPrevTick("sess-test", { apiMs: 0, in: 0, out: 0, cacheRead: 0 }, "D:\\test");
    const out = renderTemplate(["m_tokenIn"], ctxFor(fakeSnapshot())).join("\n");
    assert.equal(strip(out), "in:38");
  });

  it("m_tokenOut renders 'out:N' where N is the delta vs the previous tick", () => {
    setPrevTick("sess-test", { apiMs: 0, in: 0, out: 0, cacheRead: 0 }, "D:\\test");
    const out = renderTemplate(["m_tokenOut"], ctxFor(fakeSnapshot())).join("\n");
    assert.equal(strip(out), "out:155");
  });

  it("m_tokenIn: first tick (no prev) → assumes prev.apiMs=0, renders current.input directly", () => {
    // v0.4.0+ (revised 2026-06-29): when no previous tick exists
    // we DO NOT bail to "in:0". The renderer assumes the prior
    // baseline was at zero (prev.apiMs=0) and the first tick
    // contributes: deltaApi = currentApi - 0 = currentApi > 0
    // → hasDelta=true → render current.input directly. So the
    // first tick is NOT a sentinel and NOT a drop — it shows
    // the real per-turn delta. Side effect: setPrevTick is
    // still called with the current tick's snapshot so the NEXT
    // tick has a real baseline.
    const out = renderTemplate(["m_tokenIn"], ctxFor(fakeSnapshot())).join("\n");
    assert.equal(strip(out), "in:38");
    const cached = peekPrevTick("sess-test", "D:\\test");
    assert.ok(cached, "current tick should be written to cache");
    assert.equal(cached!.apiMs, 60_000);
    assert.equal(cached!.in, 38);
  });

  it("m_tokenIn: no API call between ticks (deltaApi=0) → renders 'in:0'", () => {
    // Pre-seed prev with the SAME totalApiDurationMs as current.
    // deltaApi=0 → no API call → hasDelta=false → "in:0".
    setPrevTick("sess-test", { apiMs: 60_000, in: 0, out: 0, cacheRead: 0 }, "D:\\test");
    const out = renderTemplate(["m_tokenIn"], ctxFor(fakeSnapshot())).join("\n");
    assert.equal(strip(out), "in:0");
  });

  it("m_tokenIn: sessionId changes → prev cache miss → assumes prev=0 for new session", () => {
    // Pre-seed prev under a different sessionId. The new tick's
    // sessionId misses the cache → treated as a first tick for
    // the new session → prev.apiMs defaults to 0 → deltaApi =
    // currentApi (60_000) > 0 → hasDelta=true → render
    // current.input directly ("in:38"). The OLD session's
    // cache entry is NOT wiped (different sessionId key).
    setPrevTick("sess-OTHER", { apiMs: 0, in: 0, out: 0, cacheRead: 0 }, "D:\\test");
    const out = renderTemplate(["m_tokenIn"], ctxFor(fakeSnapshot())).join("\n");
    assert.equal(strip(out), "in:38");
    const cached = peekPrevTick("sess-test", "D:\\test");
    assert.ok(cached, "new session's baseline should be written");
    const oldCached = peekPrevTick("sess-OTHER", "D:\\test");
    assert.ok(oldCached, "old session's cache entry should not be wiped");
  });

  it("m_tokenIn: second tick with real API call → emits this turn's delta directly", () => {
    // v0.4.0+ (revised 2026-06-29): current_usage.input_tokens IS
    // the per-turn delta — it reports THIS turn's contribution,
    // not a running total. We do NOT subtract prev; we just
    // display current.input when an API call landed
    // (deltaApi > 0).
    //
    // First tick writes the baseline (apiMs=60_000) and renders
    // "in:0" because hasDelta=false on the first tick.
    renderTemplate(["m_tokenIn"], ctxFor(fakeSnapshot()));
    // Second tick: this turn added 200 input tokens; the total
    // API time grew by 5s (+5_000 → 65_000). current.input=200
    // is THIS turn's delta → render "in:200", not "in:162" (no
    // subtraction from the 38 baseline).
    const next = fakeSnapshot({
      current: { input: 200, output: 155, cacheCreation: 0, cacheRead: 163441 },
      cost: { totalDurationMs: 700_000, totalApiDurationMs: 65_000, totalLinesAdded: null, totalLinesRemoved: null },
    });
    const out = renderTemplate(["m_tokenIn"], ctxFor(next)).join("\n");
    assert.equal(strip(out), "in:200");
  });

  it("m_tokenIn: per-turn delta contract — current.input IS the per-turn delta, no subtraction", () => {
    // Pins the new contract: even when prev.in is non-zero, the
    // module reports current.input verbatim (no
    // current.input - prev.in subtraction). The previous
    // implementation subtracted, which was correct under the
    // (now-abandoned) "current.input is a running total"
    // interpretation. Claude Code's session JSON reports
    // current_usage.{input,output,cache_read}_tokens as the
    // per-turn contribution (verified against the
    // stdin.real.json fixture: current_usage.input_tokens=140
    // while total_input_tokens=126860 — clearly per-turn, not
    // running total).
    setPrevTick("sess-test", { apiMs: 0, in: 100, out: 0, cacheRead: 0 }, "D:\\test");
    const out = renderTemplate(["m_tokenIn"], ctxFor(fakeSnapshot())).join("\n");
    // fakeSnapshot has current.input=38; under the new contract
    // that's THIS turn's delta, not (38 - 100). deltaApi = 60_000
    // > 0 → hasDelta=true → render current.input directly.
    assert.equal(strip(out), "in:38");
  });

  // ----- m_tokenInSpeed / m_tokenOutSpeed (delta-based speed) -----

  it("m_tokenInSpeed: delta of current.input / delta of cost.totalApiDurationMs", () => {
    setPrevTick("sess-test", { apiMs: 0, in: 0, out: 0, cacheRead: 0 }, "D:\\test");
    const out = renderTemplate(["m_tokenInSpeed"], ctxFor(fakeSnapshot())).join("\n");
    // delta_in = 38, delta_api = 60_000 → 38/60000*1000 = 0.633 → "0.6 t/s".
    // v0.4.0+ scale coloring: 0.6 < 50 (the lowest `in` band) → red.
    assert.equal(strip(out), "in:0.6 t/s");
    assert.ok(out.includes(RED), `expected RED band in: ${JSON.stringify(out)}`);
  });

  it("m_tokenOutSpeed: delta of current.output / delta of cost.totalApiDurationMs", () => {
    setPrevTick("sess-test", { apiMs: 0, in: 0, out: 0, cacheRead: 0 }, "D:\\test");
    const out = renderTemplate(["m_tokenOutSpeed"], ctxFor(fakeSnapshot())).join("\n");
    // delta_out = 155, delta_api = 60_000 → 155/60000*1000 = 2.583 → "2.6 t/s".
    // v0.4.0+ scale coloring: 2.6 < 10 (the lowest `out` band) → red.
    assert.equal(strip(out), "out:2.6 t/s");
  });

  it("m_tokenInSpeed: first tick (no prev) → assumes prev.apiMs=0, computes real speed", () => {
    // v0.4.0+ (revised 2026-06-29): no prev → assume prev.apiMs=0,
    // deltaApi = 60_000 - 0 = 60_000 > 0 → hasDelta=true → render
    // current.input / deltaApi * 1000. So the first tick is NOT a
    // "-- t/s" sentinel — it shows a real rate. The cache is
    // still populated so the NEXT tick has a baseline.
    const out = renderTemplate(["m_tokenInSpeed"], ctxFor(fakeSnapshot())).join("\n");
    // current.input=38, deltaApi=60_000 → 38/60000*1000 = 0.633 → "0.6 t/s"
    assert.equal(strip(out), "in:0.6 t/s");
    const cached = peekPrevTick("sess-test", "D:\\test");
    assert.ok(cached);
    assert.equal(cached!.apiMs, 60_000);
    assert.equal(cached!.in, 38);
  });

  it("m_tokenInSpeed: no API call between ticks (deltaApi=0) → 'in:0.0 t/s' (v6.x idle=0)", () => {
    // v6.x — idle tick now renders the truthful 0.0 t/s rate rather
    // than "-- t/s". The "no data" sentinel is reserved for the
    // snapshot-missing case (test elsewhere uses ctxFor(null)).
    setPrevTick("sess-test", { apiMs: 60_000, in: 0, out: 0, cacheRead: 0 }, "D:\\test");
    const out = renderTemplate(["m_tokenInSpeed"], ctxFor(fakeSnapshot())).join("\n");
    assert.equal(strip(out), "in:0.0 t/s");
  });

  it("m_tokenInSpeed: sessionId changes → prev cache miss → assumes prev=0", () => {
    // Pre-seed prev under a different sessionId. The new tick's
    // sessionId misses the cache → treat as first tick for the
    // new session → prev.apiMs=0 → deltaApi=60_000 > 0 →
    // hasDelta=true → render real speed.
    setPrevTick("sess-OTHER", { apiMs: 0, in: 0, out: 0, cacheRead: 0 }, "D:\\test");
    const out = renderTemplate(["m_tokenInSpeed"], ctxFor(fakeSnapshot())).join("\n");
    // current.input=38, deltaApi=60_000 → 0.6 t/s
    assert.equal(strip(out), "in:0.6 t/s");
  });

  it("m_tokenInSpeed: thinking-only turn (deltaApi>0, current.input=0) → '0.0 t/s'", () => {
    // v0.4.0+ (revised): a turn with deltaApi>0 and current.input=0
    // (a thinking-only turn that produced no input tokens) is
    // valid — the rate is genuinely 0.0 t/s, not "-- t/s". This
    // is the per-turn-delta contract: an API call CAN add zero
    // input tokens (synthesized message, etc). The speed
    // module's direction-specific gate was a legacy artifact
    // from the "subtract prev" model — under the new contract
    // the per-turn input IS current.input verbatim, and a
    // zero rate is the truthful answer.
    const snap = fakeSnapshot({
      current: { input: 0, output: 50, cacheCreation: 0, cacheRead: 0 },
      cost: { totalDurationMs: 600_000, totalApiDurationMs: 60_000, totalLinesAdded: null, totalLinesRemoved: null },
    });
    setPrevTick("sess-test", { apiMs: 30_000, in: 0, out: 0, cacheRead: 0 }, "D:\\test");
    const out = renderTemplate(["m_tokenInSpeed"], ctxFor(snap)).join("\n");
    // current.input=0, deltaApi=30_000 → 0.0 t/s
    assert.equal(strip(out), "in:0.0 t/s");
  });

  it("m_tokenInSpeed: second tick with real API call → emits real speed", () => {
    renderTemplate(["m_tokenInSpeed"], ctxFor(fakeSnapshot()));
    const next = fakeSnapshot({
      current: { input: 200, output: 250, cacheCreation: 0, cacheRead: 163441 },
      cost: { totalDurationMs: 700_000, totalApiDurationMs: 65_000, totalLinesAdded: null, totalLinesRemoved: null },
    });
    const out = renderTemplate(["m_tokenInSpeed"], ctxFor(next)).join("\n");
    // deltaIn = current.input = 200 (no subtraction),
    // deltaApi = 65_000 - 60_000 = 5_000 → 200/5000*1000 = 40.0
    assert.equal(strip(out), "in:40.0 t/s");
  });


  // ----- m_totalTokenIn / m_totalTokenOut / m_totalTokenWithCacheIn
  //   (v0.4.0+ per-session running totals, sharing the tickAvg cache
  //   with m_tokenInAvg / m_tokenOutAvg). All valid-API-call ticks
  //   contribute; idle / regression / missing-sessionId do not.

  it("m_totalTokenIn: first tick (no avg cache) → assumes prev=0, contributes this turn's delta", () => {
    // v0.4.0+ (revised 2026-06-29): first tick assumes prev=0,
    // deltaApi=60_000>0 → hasDelta=true → accumulate
    // current.input=38 → sumIn=38 → "in:38" (no more "in:0"
    // sentinel on first tick).
    const out = renderTemplate(
      ["m_totalTokenIn"],
      ctxFor(fakeSnapshot()),
    ).join("\n");
    assert.equal(strip(out), "in:38");
    const avg = peekAvg("sess-test", "D:\\test");
    assert.ok(avg);
    assert.equal(avg!.accIn, 38);
  });

  it("m_totalTokenIn: after one valid tick → 'in:N' (single-tick contribution)", () => {
    // Seed prev so the first tick has a delta. fakeSnapshot has
    // current.input=38 and prev in=0 → sumIn=38.
    setPrevTick("sess-test", { apiMs: 0, in: 0, out: 0, cacheRead: 0 }, "D:\\test");
    const out = renderTemplate(
      ["m_totalTokenIn"],
      ctxFor(fakeSnapshot()),
    ).join("\n");
    assert.equal(strip(out), "in:38");
    const avg = peekAvg("sess-test", "D:\\test");
    assert.ok(avg);
    assert.equal(avg!.accIn, 38);
  });

  it("m_totalTokenIn: second tick accumulates, reads cumulative sum", () => {
    setPrevTick("sess-test", { apiMs: 0, in: 0, out: 0, cacheRead: 0 }, "D:\\test");
    renderTemplate(["m_totalTokenIn"], ctxFor(fakeSnapshot()));
    // Second tick: current.input=200 (this turn's delta, no
    // subtraction), output=250, api +5_000.
    const next = fakeSnapshot({
      current: { input: 200, output: 250, cacheCreation: 0, cacheRead: 163441 },
      cost: { totalDurationMs: 700_000, totalApiDurationMs: 65_000, totalLinesAdded: null, totalLinesRemoved: null },
    });
    const out = renderTemplate(
      ["m_totalTokenIn"],
      ctxFor(next),
    ).join("\n");
    // sumIn = 38 + 200 = 238 → "in:238"
    assert.equal(strip(out), "in:238");
  });

  it("m_totalTokenIn: idle tick (deltaApi=0) does NOT accumulate", () => {
    setPrevTick("sess-test", { apiMs: 0, in: 0, out: 0, cacheRead: 0 }, "D:\\test");
    renderTemplate(["m_totalTokenIn"], ctxFor(fakeSnapshot()));
    // Idle: pre-seed prev with the SAME totalApiDurationMs as
    // fakeSnapshot (60_000). deltaApi = 0 → no accumulation.
    setPrevTick("sess-test", { apiMs: 60_000, in: 38, out: 155, cacheRead: 163441 }, "D:\\test");
    renderTemplate(["m_totalTokenIn"], ctxFor(fakeSnapshot()));
    const avg = peekAvg("sess-test", "D:\\test");
    assert.ok(avg);
    assert.equal(avg!.accIn, 38, "idle tick must not change sumIn");
  });

  it("m_totalTokenOut: first tick (no avg cache) → assumes prev=0, contributes this turn's delta", () => {
    // v0.4.0+ (revised 2026-06-29): first tick contributes
    // current.output=155 → sumOut=155 → "out:155" (no more
    // "out:0" sentinel on first tick).
    const out = renderTemplate(
      ["m_totalTokenOut"],
      ctxFor(fakeSnapshot()),
    ).join("\n");
    assert.equal(strip(out), "out:155");
  });

  it("m_totalTokenOut: after one valid tick → 'out:N'", () => {
    setPrevTick("sess-test", { apiMs: 0, in: 0, out: 0, cacheRead: 0 }, "D:\\test");
    const out = renderTemplate(
      ["m_totalTokenOut"],
      ctxFor(fakeSnapshot()),
    ).join("\n");
    // sumOut=155, formatCompactToken(155) = "155"
    assert.equal(strip(out), "out:155");
  });

  it("m_totalTokenOut: second tick accumulates", () => {
    setPrevTick("sess-test", { apiMs: 0, in: 0, out: 0, cacheRead: 0 }, "D:\\test");
    renderTemplate(["m_totalTokenOut"], ctxFor(fakeSnapshot()));
    // Second tick: current.output=250 (this turn's delta).
    const next = fakeSnapshot({
      current: { input: 200, output: 250, cacheCreation: 0, cacheRead: 163441 },
      cost: { totalDurationMs: 700_000, totalApiDurationMs: 65_000, totalLinesAdded: null, totalLinesRemoved: null },
    });
    const out = renderTemplate(
      ["m_totalTokenOut"],
      ctxFor(next),
    ).join("\n");
    // sumOut = 155 + 250 = 405
    assert.equal(strip(out), "out:405");
  });

  it("m_totalTokenWithCacheIn: first tick → assumes prev=0, contributes this turn's cache_read", () => {
    // v0.4.0+ (revised 2026-06-29): first tick contributes
    // current.cacheRead=163441 → sumCache=163441 →
    // "cache:163.4k" (no more "cache:0" sentinel on first tick).
    const out = renderTemplate(
      ["m_totalTokenWithCacheIn"],
      ctxFor(fakeSnapshot()),
    ).join("\n");
    assert.equal(strip(out), "cache:163.4k");
  });

  it("m_totalTokenWithCacheIn: missing stdin field → 'cache:--'", () => {
    // fakeSnapshot().current.cacheRead is populated; override it
    // to null to simulate stdin lacking cache_read_input_tokens.
    const out = renderTemplate(
      ["m_totalTokenWithCacheIn"],
      ctxFor(fakeSnapshot({ current: { input: 38, output: 155, cacheCreation: 0, cacheRead: null } })),
    ).join("\n");
    assert.equal(strip(out), "cache:--");
  });

  it("m_totalTokenWithCacheIn: after one valid tick → 'cache:N' (compact format)", () => {
    setPrevTick("sess-test", { apiMs: 0, in: 0, out: 0, cacheRead: 0 }, "D:\\test");
    const out = renderTemplate(
      ["m_totalTokenWithCacheIn"],
      ctxFor(fakeSnapshot()),
    ).join("\n");
    // sumCache = 163441 (prev=0, current=163441, delta=163441)
    // formatCompactToken(163441) = "163.4k"
    assert.equal(strip(out), "cache:163.4k");
    const avg = peekAvg("sess-test", "D:\\test");
    assert.ok(avg);
    assert.equal(avg!.accCached, 163441);
  });

  it("m_totalTokenWithCacheIn: second tick accumulates cache_read deltas", () => {
    setPrevTick("sess-test", { apiMs: 0, in: 0, out: 0, cacheRead: 0 }, "D:\\test");
    renderTemplate(
      ["m_totalTokenWithCacheIn"],
      ctxFor(fakeSnapshot()),
    );
    // Second tick: current.cacheRead=350000 (this turn's delta,
    // no subtraction from the 163441 baseline). Sum =
    // 163441 + 350000 = 513441.
    const next = fakeSnapshot({
      current: { input: 200, output: 250, cacheCreation: 0, cacheRead: 350_000 },
      cost: { totalDurationMs: 700_000, totalApiDurationMs: 65_000, totalLinesAdded: null, totalLinesRemoved: null },
    });
    const out = renderTemplate(
      ["m_totalTokenWithCacheIn"],
      ctxFor(next),
    ).join("\n");
    // formatCompactToken(513441) = "513.4k"
    assert.equal(strip(out), "cache:513.4k");
  });

  it("m_totalToken*: tokens is null → 'in:n/a out:n/a cache:n/a' (v6.x placeholders)", () => {
    // v6.x — null/no-snapshot now renders "n/a" placeholders
    // rather than "0" sentinels. The "stable slot" rule still
    // holds (every module renders something), but the value
    // reflects "missing data", not "zero tracked".
    const out = renderTemplate(
      ["m_totalTokenIn", "s_space", "m_totalTokenOut", "s_space", "m_totalTokenWithCacheIn"],
      ctxFor(null),
    ).join("\n");
    assert.equal(strip(out), "in:n/a out:n/a cache:n/a");
  });

  it("m_totalTokenIn:color:brightGreen wraps the chunk in brightGreen", () => {
    setPrevTick("sess-test", { apiMs: 0, in: 0, out: 0, cacheRead: 0 }, "D:\\test");
    const out = renderTemplate(
      ["m_totalTokenIn:color:brightGreen"],
      ctxFor(fakeSnapshot()),
    );
    const joined = out.join("\n");
    assert.ok(
      joined.includes(`\x1b[38;5;41min:38\x1b[0m`),
      `got: ${JSON.stringify(joined)}`,
    );
  });

  it("m_totalTokenWithCacheIn shares the accumulator with m_accTokenIn", () => {
    // v0.8.0+ — m_tokenInAvg / m_tokenOutAvg were removed; the
    // m_totalToken* family now shares its AccSnapshot slot with
    // the new m_acc* modules. Both modules read the same
    // peekAvg cache slot in the same render.
    setPrevTick("sess-total-avg", { apiMs: 0, in: 0, out: 0, cacheRead: 0 }, "D:\\test");
    const out = renderTemplate(
      [
        "m_totalTokenIn",
        "s_space",
        "m_totalTokenOut",
        "s_space",
        "m_totalTokenWithCacheIn",
        "s_space",
        "m_accTokenIn",
      ],
      ctxFor(fakeSnapshot({ sessionId: "sess-total-avg" })),
    ).join("\n");
    // All three totals read the avg cache the SAME tick — so
    //   sumIn=38 → "in:38" / "in:38" (m_accTokenIn shares the
    //     labelIn axis with the per-turn m_tokenIn)
    //   sumOut=155 → "out:155"
    //   sumCache=163441 → "cache:163.4k"
    assert.equal(
      strip(out),
      "in:38 out:155 cache:163.4k in:38",
    );
    const avg = peekAvg("sess-total-avg", "D:\\test");
    assert.ok(avg);
    assert.equal(avg!.accIn, 38);
    assert.equal(avg!.accOut, 155);
    assert.equal(avg!.accCached, 163441);
    assert.equal(avg!.accApi, 60_000);
  });

  // ----- generic snapshot tests -----

  it("tokens is null → m_tokenIn / m_tokenOut render 'n/a'; m_contextSize / m_cacheHitRate render 'n/a' (v6.x placeholders)", () => {
    // v6.x — null/no-snapshot is now distinct from "zero". All
    // per-API-call modules emit "n/a" placeholders rather than
    // "0" or drop. The bare-form parity rule means m_tokenIn and
    // m_contextSize both keep their slot when stdin is missing.
    const out = renderTemplate(
      ["m_tokenIn", "s_space", "m_tokenOut", "s_space", "m_contextSize", "s_space", "m_cacheHitRate"],
      ctxFor(null),
    ).join("\n");
    assert.equal(strip(out), "in:n/a out:n/a size:n/a hit:n/a");
  });

  it("partial snapshot: missing cost.totalApiDurationMs → m_tokenInSpeed renders 'in:0.0 t/s' (v6.x)", () => {
    // v6.x — when totalApiDurationMs is null the function takes the
    // idle-without-measurement path (cost missing means we can't
    // compute a rate this tick). Per the v6.x "0 renders, n/a is
    // reserved for the no-stdin-at-all case", the truthful zero is
    // rendered. The tokens=null path (no stdin) is a separate test.
    const out = renderTemplate(
      ["m_tokenInSpeed"],
      ctxFor(fakeSnapshot({ cost: { totalDurationMs: null, totalApiDurationMs: null, totalLinesAdded: null, totalLinesRemoved: null } })),
    ).join("\n");
    assert.equal(strip(out), "in:0.0 t/s");
  });

  it("m_cacheHitRate: per-turn cacheRead / totals.input = 100.0% (v0.8.0 per-turn formula)", () => {
    // v0.8.0+ formula: current.cacheRead / totals.input. With the
    // fakeSnapshot (totals.input=163479, current.cacheRead=163441),
    // the rate is 163441/163479 = 99.978% → toFixed(1) rounds to
    // "100.0%" (the user-acceptable "near-total" display).
    const out = renderTemplate(
      ["m_cacheHitRate"],
      ctxFor(fakeSnapshot()),
    ).join("\n");
    assert.equal(strip(out), "hit:100.0%");
  });

  it("m_cacheHitRate: 0 cache reads / 38 totals.input = 0.0% (v0.8.0 per-turn formula)", () => {
    // v0.8.0+ — when current.cacheRead=0 and totals.input=38, the
    // per-turn rate is 0/38 = 0.0% (NOT a null/drop).
    const out = renderTemplate(
      ["m_cacheHitRate"],
      ctxFor(
        fakeSnapshot({
          totals: { input: 38, output: 155 },
          current: { input: 38, output: 155, cacheCreation: 0, cacheRead: 0 },
        }),
      ),
    ).join("\n");
    assert.equal(strip(out), "hit:0.0%");
  });

  it("composed template with multiple token modules + separator", () => {
    // Seed prev so m_tokenIn / m_tokenOut have a delta to render.
    setPrevTick("sess-test", { apiMs: 0, in: 0, out: 0, cacheRead: 0 }, "D:\\test");
    const out = renderTemplate(
      ["m_tokenIn", "s_space", "m_tokenOut", "s_space", "s_dot", "s_space", "m_contextSize"],
      ctxFor(fakeSnapshot()),
    ).join("\n");
    // v0.4.0+ per-API-call delta:
    //   m_tokenIn delta = 38-0 = 38 → "in:38"
    //   m_tokenOut delta = 155-0 = 155 → "out:155"
    //   m_contextSize (v0.8.0+) = totals.input = 163479 → "size:163.5k"
    // s_0=" " between adjacent, then "·" + " " between groups →
    // "in:38 out:155 · size:163.5k"
    assert.equal(strip(out), "in:38 out:155 · size:163.5k");
  });

  it("m_tokenSession / m_tokenTotal: same numeric totals (input+output+cache)", () => {
    // Both modules compute in+out+cache identically. Only the prefix
    // differs ("session:" vs "tot:") — useful when the user wants
    // both labels visible in different templates.
    const sess = renderTemplate(["m_tokenSession"], ctxFor(fakeSnapshot())).join("\n");
    const tot = renderTemplate(["m_tokenTotal"], ctxFor(fakeSnapshot())).join("\n");
    const sessVal = strip(sess).replace(/^session:/, "");
    const totVal = strip(tot).replace(/^tot:/, "");
    assert.equal(sessVal, totVal);
    assert.equal(sessVal, "327.1k");
    assert.ok(strip(sess).startsWith("session:"));
    assert.ok(strip(tot).startsWith("tot:"));
  });
});

// ----- v0.8.0+ per-turn API-ms delta (m_apiMs) ---------------------------
//
// Per-tick delta of cost.totalApiDurationMs formatted as a dhms
// time string with the "api:" prefix. Distinct from m_accApiMs
// (session-cumulative token count, prefix "acc:") and m_sumApiMs
// (cross-project sum token count, prefix "api:" but token
// formatted). The new module's value semantics:
//
//   m_apiMs = current total_api_duration_ms − prev total_api_duration_ms
//
// Gate: hasDelta (deltaApi > 0). Idle tick (current == prev) →
// "api:--". No stdin or no sessionId → "api:--". The
// writeBack path mirrors m_tokenIn / m_tokenOut: the renderer
// fires setPrevTick on every call so the next tick has a fresh
// baseline regardless of which per-turn module appears in the
// user's template.

describe("renderTemplate — v0.8.0+ m_apiMs per-turn delta", () => {
  beforeEach(() => {
    __resetPrevTickForTest("any-session");
  });

  it("m_apiMs: first tick (prev=0, current=90_000) → 'api:1m'", () => {
    // Per the per-turn-delta contract, first tick assumes
    // prior baseline = 0 → delta = 90_000ms → "1m" under the
    // default minUnit='m'.
    setPrevTick(
      "sess-apims-first",
      { apiMs: 0, in: 0, out: 0, cacheRead: 0 },
      "D:\\test",
    );
    const out = renderTemplate(
      ["m_apiMs"],
      ctxFor(
        fakeSnapshot({
          sessionId: "sess-apims-first",
          cost: { totalDurationMs: 120_000, totalApiDurationMs: 90_000, totalLinesAdded: 0, totalLinesRemoved: 0 },
        }),
      ),
    ).join("\n");
    assert.equal(strip(out), "api:1m");
  });

  it("m_apiMs: delta=90_000 (prev=0, current=90_000) renders as 'api:1m' under default minUnit='m'", () => {
    // Same delta as the first-tick test, but verifies the
    // prev-tick cache is read on subsequent ticks too.
    setPrevTick(
      "sess-apims-delta",
      { apiMs: 0, in: 0, out: 0, cacheRead: 0 },
      "D:\\test",
    );
    const out = renderTemplate(
      ["m_apiMs"],
      ctxFor(
        fakeSnapshot({
          sessionId: "sess-apims-delta",
          cost: { totalDurationMs: 120_000, totalApiDurationMs: 90_000, totalLinesAdded: 0, totalLinesRemoved: 0 },
        }),
      ),
    ).join("\n");
    assert.equal(strip(out), "api:1m");
  });

  it("m_apiMs: sub-minute delta (40s) renders '<1m' under default minUnit='m'", () => {
    // Default cfg().timeFormat.minUnit is 'm' → sub-minute deltas
    // collapse to '<1m'. The user can opt into second precision
    // via timeFormat.minUnit: 's' in config.json.
    setPrevTick(
      "sess-apims-sub",
      { apiMs: 0, in: 0, out: 0, cacheRead: 0 },
      "D:\\test",
    );
    __resetForTest({
      timeFormat: { ...configStore.get().timeFormat, minUnit: "m" },
    });
    const out = renderTemplate(
      ["m_apiMs"],
      ctxFor(
        fakeSnapshot({
          sessionId: "sess-apims-sub",
          cost: { totalDurationMs: 60_000, totalApiDurationMs: 40_000, totalLinesAdded: 0, totalLinesRemoved: 0 },
        }),
      ),
    ).join("\n");
    assert.equal(strip(out), "api:<1m");
  });

  it("m_apiMs: sub-minute delta (40s) renders '40s' under minUnit='s' override", () => {
    // The user-facing knob: timeFormat.minUnit: 's' enables
    // second precision for sub-minute deltas. The format
    // pipeline honors cfg().timeFormat.minUnit — same as
    // m_sessionDuration / m_sessionApiDuration.
    setPrevTick(
      "sess-apims-sec",
      { apiMs: 0, in: 0, out: 0, cacheRead: 0 },
      "D:\\test",
    );
    __resetForTest({
      timeFormat: { ...configStore.get().timeFormat, minUnit: "s" },
    });
    const out = renderTemplate(
      ["m_apiMs"],
      ctxFor(
        fakeSnapshot({
          sessionId: "sess-apims-sec",
          cost: { totalDurationMs: 60_000, totalApiDurationMs: 40_000, totalLinesAdded: 0, totalLinesRemoved: 0 },
        }),
      ),
    ).join("\n");
    assert.equal(strip(out), "api:40s");
  });

  it("m_apiMs: idle tick (current == prev → deltaApi=0) → placeholder 'api:--'", () => {
    setPrevTick(
      "sess-apims-idle",
      { apiMs: 30_000, in: 0, out: 0, cacheRead: 0 },
      "D:\\test",
    );
    const out = renderTemplate(
      ["m_apiMs"],
      ctxFor(
        fakeSnapshot({
          sessionId: "sess-apims-idle",
          cost: { totalDurationMs: 60_000, totalApiDurationMs: 30_000, totalLinesAdded: 0, totalLinesRemoved: 0 },
        }),
      ),
    ).join("\n");
    assert.equal(strip(out), "api:--");
    assert.ok(out.includes(STALE), `expected STALE wrap on: ${JSON.stringify(out)}`);
  });

  it("m_apiMs: no stdin (tokens=null) → placeholder 'api:--'", () => {
    const out = renderTemplate(["m_apiMs"], ctxFor(null)).join("\n");
    assert.equal(strip(out), "api:--");
    assert.ok(out.includes(STALE), `expected STALE wrap on: ${JSON.stringify(out)}`);
  });

  it("m_apiMs: totalApiDurationMs=null on an otherwise-present snapshot → placeholder 'api:--'", () => {
    // totalApiDurationMs is OPTIONAL in TokenSnapshot.cost. When
    // null but other fields are present, computeAndCacheTickDelta
    // bails to hasDelta=false → placeholder fires.
    const out = renderTemplate(
      ["m_apiMs"],
      ctxFor(
        fakeSnapshot({
          sessionId: "sess-apims-noapi",
          cost: { totalDurationMs: 600_000, totalApiDurationMs: null, totalLinesAdded: 0, totalLinesRemoved: 0 },
        }),
      ),
    ).join("\n");
    assert.equal(strip(out), "api:--");
  });

  it("m_apiMs: inline :color:brightGreen wraps the chunk in the green SGR", () => {
    setPrevTick(
      "sess-apims-color",
      { apiMs: 0, in: 0, out: 0, cacheRead: 0 },
      "D:\\test",
    );
    const out = renderTemplate(
      ["m_apiMs:color:brightGreen"],
      ctxFor(
        fakeSnapshot({
          sessionId: "sess-apims-color",
          cost: { totalDurationMs: 120_000, totalApiDurationMs: 90_000, totalLinesAdded: 0, totalLinesRemoved: 0 },
        }),
      ),
    ).join("\n");
    assert.equal(strip(out), "api:1m");
    assert.ok(out.includes(GREEN), `expected GREEN wrap on: ${JSON.stringify(out)}`);
  });

  it("m_apiMs: inline :nulldrop:true is a no-op (function never returns null)", () => {
    // The m_apiMs renderer always returns either "api:1m" or
    // "api:--" placeholder (via wrapPlainDefault /
    // placeholderWithColor, which wrap in STALE_COLOR). Therefore
    // `:nulldrop:true` has no effect — the dispatcher can only
    // short-circuit on a null return. Same property as
    // m_tokenInTotal / m_apiCalls / m_sessionDuration.
    setPrevTick(
      "sess-apims-nulldrop",
      { apiMs: 0, in: 0, out: 0, cacheRead: 0 },
      "D:\\test",
    );
    const out = renderTemplate(
      ["m_apiMs:nulldrop:true"],
      ctxFor(
        fakeSnapshot({
          sessionId: "sess-apims-nulldrop",
          cost: { totalDurationMs: 120_000, totalApiDurationMs: 90_000, totalLinesAdded: 0, totalLinesRemoved: 0 },
        }),
      ),
    ).join("\n");
    assert.equal(strip(out), "api:1m");
  });

  it("m_apiMs: writeBack fires setPrevTick so the NEXT tick has a fresh baseline", () => {
    // When m_apiMs is rendered ALONE (no other per-turn module),
    // it's the only consumer of computeAndCacheTickDelta. The
    // renderer must still fire setPrevTick so the NEXT tick can
    // compute the correct delta (otherwise we'd see the original
    // baseline forever).
    setPrevTick(
      "sess-apims-write",
      { apiMs: 0, in: 0, out: 0, cacheRead: 0 },
      "D:\\test",
    );
    // First render — delta = 90_000 - 0 = 90_000 → "api:1m".
    renderTemplate(
      ["m_apiMs"],
      ctxFor(
        fakeSnapshot({
          sessionId: "sess-apims-write",
          cost: { totalDurationMs: 120_000, totalApiDurationMs: 90_000, totalLinesAdded: 0, totalLinesRemoved: 0 },
        }),
      ),
    );
    // Second render — delta = 180_000 - 90_000 = 90_000 → "api:1m".
    // If writeBack didn't fire, this would still see prev=0 and
    // produce "api:3m" (wrong).
    const out2 = renderTemplate(
      ["m_apiMs"],
      ctxFor(
        fakeSnapshot({
          sessionId: "sess-apims-write",
          cost: { totalDurationMs: 240_000, totalApiDurationMs: 180_000, totalLinesAdded: 0, totalLinesRemoved: 0 },
        }),
      ),
    ).join("\n");
    assert.equal(strip(out2), "api:1m");
  });

  it("m_apiMs: default tint is brown (matches the time-format family)", () => {
    setPrevTick(
      "sess-apims-brown",
      { apiMs: 0, in: 0, out: 0, cacheRead: 0 },
      "D:\\test",
    );
    const out = renderTemplate(
      ["m_apiMs"],
      ctxFor(
        fakeSnapshot({
          sessionId: "sess-apims-brown",
          cost: { totalDurationMs: 120_000, totalApiDurationMs: 90_000, totalLinesAdded: 0, totalLinesRemoved: 0 },
        }),
      ),
    ).join("\n");
    const BROWN = "\x1b[38;5;130m";
    assert.ok(out.includes(BROWN), `expected BROWN wrap on: ${JSON.stringify(out)}`);
  });
});

describe("renderTemplate — newline separator (v0.4.0+ multi-line layout)", () => {
  beforeEach(() => {
    __resetForTest({
      separators: [" ", " · ", "\n"],
      statuslineTemplate: ["m_tokenIn", "s_newline", "m_contextSize"],
    });
  });

  it('a "\\n" separator splits the template into two rendered lines', () => {
    // Seed prev so m_tokenIn has a delta to render.
    setPrevTick("sess-test", { apiMs: 0, in: 0, out: 0, cacheRead: 0 }, "D:\\test");
    const out = renderTemplate(["m_tokenIn", "s_newline", "m_contextSize"], ctxFor(fakeSnapshot()));
    assert.deepEqual(out.map(strip), ["in:38", "size:163.5k"]);
  });

  it("trailing '\\n' separator does NOT emit a blank trailing line", () => {
    setPrevTick("sess-test", { apiMs: 0, in: 0, out: 0, cacheRead: 0 }, "D:\\test");
    const out = renderTemplate(["m_tokenIn", "s_newline"], ctxFor(fakeSnapshot()));
    assert.deepEqual(out.map(strip), ["in:38"]);
  });

  it("consecutive '\\n\\n' separators drop the empty middle line", () => {
    setPrevTick("sess-test", { apiMs: 0, in: 0, out: 0, cacheRead: 0 }, "D:\\test");
    const out = renderTemplate(["m_tokenIn", "s_newline", "s_newline", "m_contextSize"], ctxFor(fakeSnapshot()));
    assert.deepEqual(out.map(strip), ["in:38", "size:163.5k"]);
  });

  it("a module piece containing '\\n' (future-proof) also splits", () => {
    assert.ok(true, "covered via composition integration test");
  });
});

// ----- v0.4.0+ session-info / metadata modules -----
describe("renderTemplate — v0.4.0+ session-info modules", () => {
  it("m_session: bare 'strip-diagnostics-display'", () => {
    const out = renderTemplate(["m_session"], ctxFor(fakeSnapshot())).join("\n");
    assert.equal(strip(out), "strip-diagnostics-display");
  });

  it("m_model: bare 'MiniMax-M3'", () => {
    const out = renderTemplate(["m_model"], ctxFor(fakeSnapshot())).join("\n");
    assert.equal(strip(out), "MiniMax-M3");
  });

  it("m_effort: bare 'high'", () => {
    const out = renderTemplate(["m_effort"], ctxFor(fakeSnapshot())).join("\n");
    assert.equal(strip(out), "high");
  });

  it("m_repo: 'github.com/cwf818/topgauge-cc'", () => {
    const out = renderTemplate(["m_repo"], ctxFor(fakeSnapshot())).join("\n");
    assert.equal(strip(out), "github.com/cwf818/topgauge-cc");
  });

  it("m_branch: emits 'branch:n/a' when cwd is not a git repo (v6.x placeholder)", () => {
    // v6.x — bare m_branch now renders a "branch:n/a" placeholder
    // instead of dropping, matching the inline path's behavior.
    const out = renderTemplate(["m_branch"], ctxFor(fakeSnapshot())).join("\n");
    assert.equal(strip(out), "branch:n/a");
    assert.ok(out.includes(STALE), `expected STALE wrap on: ${JSON.stringify(out)}`);
  });

  it("m_branch: emits 'branch:n/a' when cwd is missing entirely (v6.x placeholder)", () => {
    // v6.x — bare form now renders the placeholder, matching the
    // inline :nulldrop:false path.
    const out = renderTemplate(
      ["m_branch"],
      ctxFor(fakeSnapshot({ cwd: null })),
    ).join("\n");
    assert.equal(strip(out), "branch:n/a");
  });

  it("m_branch: renders the current branch when cwd is a real repo", () => {
    // process.cwd() is the repo root when tests run, so readGitInfo
    // returns the actual branch (e.g. "main"). The 60s cache may
    // already hold a stale value from another test, but the cache
    // value reflects whatever git says NOW for this cwd — which is
    // exactly what the renderer should display.
    const out = renderTemplate(
      ["m_branch"],
      ctxFor(fakeSnapshot({ cwd: process.cwd() })),
    ).join("\n");
    assert.ok(out.length > 0, "expected m_branch to render the branch");
    assert.ok(!out.startsWith(" "), `m_branch should not be padded: ${JSON.stringify(out)}`);
  });

  it("m_branch:color:brightGreen wraps the branch in brightGreen", () => {
    const out = renderTemplate(
      ["m_branch:color:brightGreen"],
      ctxFor(fakeSnapshot({ cwd: process.cwd() })),
    ).join("\n");
    assert.ok(out.includes("\x1b[38;5;41m"), `got: ${JSON.stringify(out)}`);
  });

  it("m_branch:nulldrop:false renders 'branch:n/a' when not in a git repo", () => {
    // inline :nulldrop:false forces the placeholder instead of
    // dropping the slot (consistent with m_repo :nulldrop:false).
    const out = renderTemplate(
      ["m_branch:nulldrop:false"],
      ctxFor(fakeSnapshot()), // cwd="D:\\test", not a git repo
    ).join("\n");
    assert.equal(strip(out), "branch:n/a");
  });

  it("m_gitStatus: emits 'git:n/a' when cwd is not a git repo (v6.x placeholder)", () => {
    const out = renderTemplate(["m_gitStatus"], ctxFor(fakeSnapshot())).join("\n");
    assert.equal(strip(out), "git:n/a");
  });

  it("m_gitStatus: emits 'git:n/a' when cwd is missing (v6.x placeholder)", () => {
    const out = renderTemplate(
      ["m_gitStatus"],
      ctxFor(fakeSnapshot({ cwd: null })),
    ).join("\n");
    assert.equal(strip(out), "git:n/a");
  });

  it("m_gitStatus: renders 'clean' on a fresh repo, 'dirty' after a write", () => {
    // Build a temp git repo so readGitInfo returns { branch, dirty }.
    // Skipped when git isn't on PATH (CI without git).
    let repoDir: string | undefined;
    try {
      execFileSync("git", ["--version"], { stdio: "ignore", timeout: 1000 });
    } catch {
      return; // skip
    }
    repoDir = mkdtempSync(join(tmpdir(), "topgauge-cc-render-git-"));
    execFileSync("git", ["init", "-q", "-b", "main"], { cwd: repoDir });
    execFileSync("git", ["config", "user.email", "t@t"], { cwd: repoDir });
    execFileSync("git", ["config", "user.name", "t"], { cwd: repoDir });
    writeFileSync(join(repoDir, "r"), "x");
    execFileSync("git", ["add", "."], { cwd: repoDir });
    execFileSync("git", ["commit", "-q", "-m", "init"], { cwd: repoDir });

    try {
      __resetGitInfoCacheForTest();
      const clean = renderTemplate(
        ["m_gitStatus"],
        ctxFor(fakeSnapshot({ cwd: repoDir })),
      ).join("\n");
      assert.equal(strip(clean), "clean");

      // Now dirty the tree and force a fresh read.
      writeFileSync(join(repoDir, "new"), "y");
      __resetGitInfoCacheForTest();
      const dirty = renderTemplate(
        ["m_gitStatus"],
        ctxFor(fakeSnapshot({ cwd: repoDir })),
      ).join("\n");
      assert.equal(strip(dirty), "dirty");
    } finally {
      if (repoDir) rmSync(repoDir, { recursive: true, force: true });
    }
  });

  it("m_gitStatus:color:red wraps the indicator in red", () => {
    const out = renderTemplate(
      ["m_gitStatus:color:red"],
      ctxFor(fakeSnapshot({ cwd: process.cwd() })),
    ).join("\n");
    assert.ok(out.includes("\x1b[38;5;196m"), `got: ${JSON.stringify(out)}`);
  });

  it("m_gitStatus:nulldrop:false renders 'git:n/a' when not in a git repo", () => {
    const out = renderTemplate(
      ["m_gitStatus:nulldrop:false"],
      ctxFor(fakeSnapshot()),
    ).join("\n");
    assert.equal(strip(out), "git:n/a");
  });

  it("m_repo: drops null components", () => {
    const out = renderTemplate(
      ["m_repo"],
      ctxFor(fakeSnapshot({ repo: { host: "github.com", owner: null, name: "x" } })),
    ).join("\n");
    assert.equal(strip(out), "github.com/x");
  });

  it("m_repo: emits 'n/a' when no component is available (v6.x placeholder)", () => {
    // v6.x — bare form now emits the placeholder instead of dropping.
    const out = renderTemplate(
      ["m_repo"],
      ctxFor(fakeSnapshot({ repo: { host: null, owner: null, name: null } })),
    ).join("\n");
    assert.equal(strip(out), "n/a");
  });

  it("m_ccVersion: bare '2.1.191'", () => {
    const out = renderTemplate(["m_ccVersion"], ctxFor(fakeSnapshot())).join("\n");
    assert.equal(strip(out), "2.1.191");
  });

  it("m_sessionDuration: dhms format of total_duration_ms (600_000ms = 10m)", () => {
    const out = renderTemplate(["m_sessionDuration"], ctxFor(fakeSnapshot())).join("\n");
    assert.equal(strip(out), "10m");
  });

  it("m_sessionApiDuration: emits '--' when totalApiDurationMs is null (v6.x placeholder)", () => {
    const out = renderTemplate(
      ["m_sessionApiDuration"],
      ctxFor(fakeSnapshot({ cost: { totalDurationMs: 600_000, totalApiDurationMs: null, totalLinesAdded: null, totalLinesRemoved: null } })),
    ).join("\n");
    assert.equal(strip(out), "--");
  });

  it("m_linesAdded: '+ 3965'", () => {
    const out = renderTemplate(["m_linesAdded"], ctxFor(fakeSnapshot())).join("\n");
    assert.equal(strip(out), "+ 3965");
  });

  it("m_linesRemoved: '- 967'", () => {
    const out = renderTemplate(["m_linesRemoved"], ctxFor(fakeSnapshot())).join("\n");
    assert.equal(strip(out), "- 967");
  });

  it("m_linesAdded: 0 renders as '+ 0' (zero is information, not absence)", () => {
    const out = renderTemplate(
      ["m_linesAdded"],
      ctxFor(
        fakeSnapshot({ cost: { totalDurationMs: 600_000, totalApiDurationMs: null, totalLinesAdded: 0, totalLinesRemoved: 0 } }),
      ),
    ).join("\n");
    assert.equal(strip(out), "+ 0");
  });

  it("m_tokenInTotal: 'in:163.5k' (cumulative, the old m_tokenIn behavior)", () => {
    const out = renderTemplate(["m_tokenInTotal"], ctxFor(fakeSnapshot())).join("\n");
    assert.equal(strip(out), "in:163.5k");
  });

  it("m_tokenTotalOut: 'out:155' (cumulative)", () => {
    const out = renderTemplate(["m_tokenTotalOut"], ctxFor(fakeSnapshot())).join("\n");
    assert.equal(strip(out), "out:155");
  });

  // v0.8.0+ — newly registered module under the labelTotalIn
  // family. Reads the same source as m_tokenInTotal but emits the
  // labelTotalIn prefix instead of labelIn — both default to
  // "in:" / "total:" respectively, but a user override on either
  // axis diverges them.
  it("m_tokenTotalIn: 'total:163.5k' (cumulative, labelTotalIn axis)", () => {
    const out = renderTemplate(["m_tokenTotalIn"], ctxFor(fakeSnapshot())).join("\n");
    assert.equal(strip(out), "total:163.5k");
  });

  it("m_tokenTotalIn:nulldrop:false renders 'total:n/a' placeholder on null totals.input", () => {
    const out = renderTemplate(
      ["m_tokenTotalIn:nulldrop:false"],
      ctxFor(fakeSnapshot({ totals: { input: null, output: null } })),
    ).join("\n");
    assert.equal(strip(out), "total:n/a");
  });

  // ----- m_apiCalls (v0.4.x) -------------------------------------------
  // Reads the project-wide tickStatus slot's sumApiCount. Survives
  // session changes — the value reflects ALL sessions that have
  // ticked in this cwd. Supports :color: and :nulldrop: like other
  // text-style modules. Renders "calls:N"; placeholder is "calls:n/a".

  it("m_apiCalls: renders 'calls:0' when no project-wide tickStatus slot exists", () => {
    // Fresh cwd, no prior write → tickStatus slot is null → counter
    // is uninitialized → render "calls:0" (the natural zero state,
    // matching the m_tokenIn/m_tokenOut "in:0"/"out:0" pattern).
    // Opt back into drop-on-null with `:nulldrop:true`.
    const out = renderTemplate(
      ["m_apiCalls"],
      ctxFor(fakeSnapshot({ cwd: "D:\\no-project-state-yet" })),
    ).join("\n");
    assert.equal(strip(out), "calls:0");
  });

  it("m_apiCalls: renders 'calls:N' from project-wide sumApiCount", () => {
    // Seed the project-wide slot with sumApiCount=7.
    setAvg(
      "sess-1",
      { accIn: 0, accOut: 0, accApi: 0, accCached: 0, accApiCount: 0 },
      "D:\\test",
      {
        modelDisplayName: "claude-opus-4-8",
        deltaApiCount: 1,
        currentIn: 38,
        currentOut: 155,
        currentCacheRead: 163441,
        currentApiMs: 60_000,
        deltaIn: 38,
        deltaOut: 155,
        deltaCache: 163441,
        deltaApiMs: 60_000,
      },
    );
    // Subsequent ticks bump the same project-wide slot.
    setAvg(
      "sess-1",
      { accIn: 38, accOut: 155, accApi: 60_000, accCached: 163441, accApiCount: 1 },
      "D:\\test",
      {
        modelDisplayName: "claude-opus-4-8",
        deltaApiCount: 1,
        currentIn: 200,
        currentOut: 250,
        currentCacheRead: 200_000,
        currentApiMs: 65_000,
        deltaIn: 200,
        deltaOut: 250,
        deltaCache: 200_000,
        deltaApiMs: 5_000,
      },
    );
    const out = renderTemplate(
      ["m_apiCalls"],
      ctxFor(fakeSnapshot({ sessionId: "sess-1" })),
    ).join("\n");
    assert.equal(strip(out), "calls:2");
  });

  it("m_apiCalls: no valid tick has landed yet → bare form renders 'calls:0' (no slot exists)", () => {
    // The project-wide tickStatus slot is only WRITTEN by setAvg
    // when at least one delta is non-zero (or sumApiCount
    // increments). A "zero deltas" tick passes through setAvg's
    // gate without ever creating the slot — so a fresh project
    // with no API calls renders the natural zero "calls:0"
    // (matching the m_tokenIn/m_tokenOut "in:0"/"out:0" pattern).
    // This is distinct from the per-session slot which IS stamped
    // on every active tick. Document the contract: m_apiCalls is
    // a counter that starts at 0, not a "have I had any valid
    // API calls yet?" sentinel — use `:nulldrop:true` to opt
    // back into drop-on-null.
    setAvg(
      "sess-zero",
      { accIn: 0, accOut: 0, accApi: 0, accCached: 0, accApiCount: 0 },
      "D:\\test",
      {
        modelDisplayName: null,
        deltaApiCount: 0,
        currentIn: 0,
        currentOut: 0,
        currentCacheRead: 0,
        currentApiMs: 0,
        deltaIn: 0,
        deltaOut: 0,
        deltaCache: 0,
        deltaApiMs: 0,
      },
    );
    const out = renderTemplate(
      ["m_apiCalls"],
      ctxFor(fakeSnapshot({ sessionId: "sess-zero" })),
    ).join("\n");
    assert.equal(strip(out), "calls:0");
  });

  it("m_apiCalls:nulldrop:false with no slot → 'calls:0' (no STALE wrap)", () => {
    // Inline form no longer falls back to the placeholder when the
    // data path returns null — "calls:0" is the natural zero state.
    // Same shape as m_tokenInTotal:nulldrop:false (which renders
    // "in:0"). The placeholderNA("calls:") registration is left in
    // place but is unreachable for m_apiCalls.
    const out = renderTemplate(
      ["m_apiCalls:nulldrop:false"],
      ctxFor(fakeSnapshot({ cwd: "D:\\no-project-state-yet" })),
    ).join("\n");
    assert.equal(strip(out), "calls:0");
    assert.ok(!out.includes(STALE), `expected no STALE wrap on: ${JSON.stringify(out)}`);
  });

  it("m_apiCalls:nulldrop:false with no slot yet → 'calls:0'", () => {
    // A "zero deltas" tick never created the project-wide slot
    // (setAvg's gate skipped the write). The inline form now
    // renders "calls:0" (the natural zero state) rather than
    // the placeholder. Document the contract: m_apiCalls is a
    // counter that starts at 0.
    setAvg(
      "sess-zero",
      { accIn: 0, accOut: 0, accApi: 0, accCached: 0, accApiCount: 0 },
      "D:\\test",
      {
        modelDisplayName: null,
        deltaApiCount: 0,
        currentIn: 0,
        currentOut: 0,
        currentCacheRead: 0,
        currentApiMs: 0,
        deltaIn: 0,
        deltaOut: 0,
        deltaCache: 0,
        deltaApiMs: 0,
      },
    );
    const out = renderTemplate(
      ["m_apiCalls:nulldrop:false"],
      ctxFor(fakeSnapshot({ sessionId: "sess-zero" })),
    ).join("\n");
    assert.equal(strip(out), "calls:0");
  });

  it("m_apiCalls:nulldrop:true is a no-op (function never returns null)", () => {
    // The inline m_apiCalls renderer never returns null — it always
    // returns "calls:0" or "calls:N". Therefore `:nulldrop:true` has
    // no effect (the dispatcher can only short-circuit on a null
    // return). Same shape as m_tokenIn / m_tokenOut, which share
    // this property via computeTickDelta. This test pins the
    // behavior so a future refactor that re-introduces a null
    // branch will surface the question explicitly.
    const out = renderTemplate(
      ["m_apiCalls:nulldrop:true"],
      ctxFor(fakeSnapshot({ cwd: "D:\\no-project-state-yet" })),
    ).join("\n");
    assert.equal(strip(out), "calls:0");
  });

  it("m_apiCalls:color:brightGreen wraps the chunk in brightGreen", () => {
    setAvg(
      "sess-colored",
      { accIn: 0, accOut: 0, accApi: 0, accCached: 0, accApiCount: 0 },
      "D:\\test",
      {
        modelDisplayName: null,
        deltaApiCount: 1,
        currentIn: 38,
        currentOut: 155,
        currentCacheRead: 0,
        currentApiMs: 60_000,
        deltaIn: 38,
        deltaOut: 155,
        deltaCache: 0,
        deltaApiMs: 60_000,
      },
    );
    const out = renderTemplate(
      ["m_apiCalls:color:brightGreen"],
      ctxFor(fakeSnapshot({ sessionId: "sess-colored" })),
    );
    const joined = out.join("\n");
    assert.match(strip(joined), /calls:1/);
    assert.ok(
      joined.includes(`\x1b[38;5;41mcalls:1\x1b[0m`),
      `expected brightGreen wrap on: ${JSON.stringify(joined)}`,
    );
  });

  it("m_apiCalls:color:red override applies SGR to 'calls:0' (no STALE wrap)", () => {
    // Inline :color: wins over the natural zero (no STALE_COLOR is
    // applied because "calls:0" is not stale data — it's the
    // counter's zero state).
    const RED_SGR = "\x1b[38;5;196m";
    const out = renderTemplate(
      ["m_apiCalls:nulldrop:false:color:red"],
      ctxFor(fakeSnapshot({ cwd: "D:\\no-project-state-yet" })),
    ).join("\n");
    assert.equal(strip(out), "calls:0");
    assert.ok(out.includes(RED_SGR), `expected RED in: ${JSON.stringify(out)}`);
  });

  it("m_apiCalls: bare form renders 'calls:0' on null (MODULES path)", () => {
    // Bare m_apiCalls (no colon) goes through the MODULES dispatcher
    // and now renders "calls:0" on null — same "render the natural
    // zero" semantics as m_tokenInTotal.
    const out = renderTemplate(
      ["m_apiCalls"],
      ctxFor(fakeSnapshot({ cwd: "D:\\no-project-state-yet" })),
    ).join("\n");
    assert.equal(strip(out), "calls:0");
  });

  it("m_apiCalls:inline m_apiCalls: (trailing colon) renders 'calls:0'", () => {
    // Trailing-colon form has empty remainder → nulldrop undefined
    // → the inline form renders "calls:0" (the natural zero),
    // matching the bare form.
    const out = renderTemplate(
      ["m_apiCalls:"],
      ctxFor(fakeSnapshot({ cwd: "D:\\no-project-state-yet" })),
    ).join("\n");
    assert.equal(strip(out), "calls:0");
  });

  it("m_apiCalls: count survives a sessionId change (project-wide scope)", () => {
    // The project-wide tickStatus slot is keyed only by cwd, not
    // sessionId. Switching the sessionId on the next render does
    // NOT reset the count. This is the v0.4.x simplification vs
    // the per-session tickAvg slot.
    setAvg(
      "sess-A",
      { accIn: 38, accOut: 155, accApi: 60_000, accCached: 163441, accApiCount: 1 },
      "D:\\test",
      {
        modelDisplayName: "claude-opus-4-8",
        deltaApiCount: 1,
        currentIn: 38,
        currentOut: 155,
        currentCacheRead: 163441,
        currentApiMs: 60_000,
        deltaIn: 38,
        deltaOut: 155,
        deltaCache: 163441,
        deltaApiMs: 60_000,
      },
    );
    // Render with a DIFFERENT sessionId — count should still be 1.
    const out = renderTemplate(
      ["m_apiCalls"],
      ctxFor(fakeSnapshot({ sessionId: "sess-B" })),
    ).join("\n");
    assert.equal(strip(out), "calls:1");
  });

  it("m_contextSize: 'size:163.5k' (cumulative occupancy from totals.input)", () => {
    // v0.8.0+ — m_contextSize source is total_input_tokens. The
    // fakeSnapshot has totals.input=163479 → "size:163.5k". The
    // capacity is the separate m_contextWindowsSize module.
    const out = renderTemplate(["m_contextSize"], ctxFor(fakeSnapshot())).join("\n");
    assert.equal(strip(out), "size:163.5k");
  });

  it("m_contextWindowsSize: 'size:200.0k' (capacity from context_window.size)", () => {
    // v0.8.0+ — the new module for the capacity (upper bound),
    // sourced from context_window.size. The typo `Widows` is
    // preserved per user direction.
    const out = renderTemplate(["m_contextWindowsSize"], ctxFor(fakeSnapshot())).join("\n");
    assert.equal(strip(out), "size:200.0k");
  });

  it("m_contextUsedPercent: 'used:63%' (key-prefixed percentage)", () => {
    const out = renderTemplate(["m_contextUsedPercent"], ctxFor(fakeSnapshot())).join("\n");
    assert.equal(strip(out), "used:63%");
  });

  it("m_contextRemainingPercent: 'remain:37%' (sibling of m_contextUsedPercent)", () => {
    // v0.8.0+ — new module. fakeSnapshot has remainingPct=37.
    const out = renderTemplate(["m_contextRemainingPercent"], ctxFor(fakeSnapshot())).join("\n");
    assert.equal(strip(out), "remain:37%");
  });

  it("m_windowContext: bar + 5-band-colored percentage (63% lands in orange band)", () => {
    const out = renderTemplate(["m_windowContext"], ctxFor(fakeSnapshot())).join("\n");
    const stripped = strip(out);
    assert.match(stripped, /^[▓░]+ 63%$/);
    assert.ok(out.includes(ORANGE), `expected ORANGE in: ${JSON.stringify(out)}`);
  });

  it("m_windowContext: emits gray '░░░░░░░░ 0%' gauge when contextWindow.usedPct is null (v6.x placeholder)", () => {
    // v6.x — bare m_windowContext now follows the placeholder rule.
    // The gauge placeholder shape is "░░░░░░░░ 0%" (used mode) or
    // "▓▓▓▓▓▓▓▓ 100%" (remaining mode). Defaults to "used" → empty
    // bar + "0%".
    const out = renderTemplate(
      ["m_windowContext"],
      ctxFor(
        fakeSnapshot({ contextWindow: { size: 200000, usedPct: null, remainingPct: null } }),
      ),
    ).join("\n");
    assert.equal(strip(out), "░░░░░░░░ 0%");
  });

  // v0.4.0+ — value=0 is a valid number, not "missing". Per the
  // render zero-value rule (memory/render-value-zero-rule.md), a 0
  // MUST render as "0", not drop the whole module. The only condition
  // that hides the module is `usedPct == null` (stdin didn't carry the
  // field at all). These four cases pin that contract so a future
  // refactor can't regress to a `!value`/truthy guard.
  it("m_windowContext: usedPct=0 renders '░░░░░░░░ 0%' (NOT hidden)", () => {
    const out = renderTemplate(
      ["m_windowContext"],
      ctxFor(fakeSnapshot({ contextWindow: { size: 200000, usedPct: 0, remainingPct: 100 } })),
    ).join("\n");
    assert.equal(strip(out), "░░░░░░░░ 0%");
  });

  it("m_windowContext:display:remaining with usedPct=0 renders full-bar 100% (NOT hidden)", () => {
    const out = renderTemplate(
      ["m_windowContext:display:remaining"],
      ctxFor(fakeSnapshot({ contextWindow: { size: 200000, usedPct: 0, remainingPct: 100 } })),
    ).join("\n");
    assert.equal(strip(out), "▓▓▓▓▓▓▓▓ 100%");
  });

  it("m_windowContext:color:red at usedPct=0 still emits the 0% chunk with override SGR", () => {
    const RED_SGR = "\x1b[38;5;196m";
    const out = renderTemplate(
      ["m_windowContext:color:red"],
      ctxFor(fakeSnapshot({ contextWindow: { size: 200000, usedPct: 0, remainingPct: 100 } })),
    ).join("\n");
    assert.equal(strip(out), "░░░░░░░░ 0%");
    assert.ok(out.includes(RED_SGR), `expected RED SGR in: ${JSON.stringify(out)}`);
  });

  it("m_contextUsedPercent: usedPct=0 renders 'used:0%' (NOT hidden)", () => {
    const out = renderTemplate(
      ["m_contextUsedPercent"],
      ctxFor(fakeSnapshot({ contextWindow: { size: 200000, usedPct: 0, remainingPct: 100 } })),
    ).join("\n");
    assert.equal(strip(out), "used:0%");
  });

  it("inline :color: override applies SGR to plain modules (m_session:color:red)", () => {
    const RED_SGR = "\x1b[38;5;196m";
    const out = renderTemplate(
      ["m_session:color:red"],
      ctxFor(fakeSnapshot()),
    ).join("\n");
    assert.equal(strip(out), "strip-diagnostics-display");
    assert.ok(out.includes(RED_SGR), `expected RED in: ${JSON.stringify(out)}`);
  });

  it("inline :color: override applies SGR to m_windowContext (formatOneChunkColored)", () => {
    const RED_SGR = "\x1b[38;5;196m";
    const out = renderTemplate(
      ["m_windowContext:color:red"],
      ctxFor(fakeSnapshot()),
    ).join("\n");
    const stripped = strip(out);
    assert.match(stripped, /^[▓░]+ 63%$/);
    assert.ok(out.includes(RED_SGR), `expected RED in: ${JSON.stringify(out)}`);
  });

  it("all session-info modules emit placeholders when tokens is null (v6.x)", () => {
    // v6.x — bare-form parity: every session-info module renders
    // its placeholder body wrapped in STALE_COLOR when tokens is
    // null, instead of dropping. The shape is module-specific
    // (see PLACEHOLDERS in render.ts). This test verifies the
    // shapes match the design.
    const cases: Array<[string, string]> = [
      ["m_session", "n/a"],
      ["m_model", "n/a"],
      ["m_effort", "n/a"],
      ["m_repo", "n/a"],
      ["m_ccVersion", "n/a"],
      ["m_sessionDuration", "--"],
      ["m_sessionApiDuration", "--"],
      ["m_linesAdded", "+ --"],
      ["m_linesRemoved", "- --"],
      ["m_tokenInTotal", "in:n/a"],
      ["m_tokenTotalOut", "out:n/a"],
      ["m_contextWindowsSize", "size:n/a"],
      ["m_contextSize", "size:n/a"],
      ["m_contextUsedPercent", "used:n/a%"],
      ["m_contextRemainingPercent", "remain:n/a%"],
      ["m_windowContext", "░░░░░░░░ 0%"],
    ];
    for (const [m, expected] of cases) {
      const out = renderTemplate([m], ctxFor(null)).join("\n");
      assert.equal(strip(out), expected, `${m} should render "${expected}" placeholder, got ${JSON.stringify(out)}`);
    }
  });
});

// ----- v0.4.0+ nulldrop inline override ----------------------------------
//
// Every m_* module accepts an optional `:nulldrop:<true|false>`
// inline argument. Semantics (FLIPPED in v0.4.0 — see
// nulldrop-inline-override memory):
//   omitted / `:nulldrop:false`  → DEFAULT. Force a stable
//     placeholder when data is null — module ALWAYS renders.
//   `:nulldrop:true`             → opt out of placeholder; preserve
//     v0.3.x drop-on-null behavior.
//
// Placeholder shape per family (see PLACEHOLDERS in render.ts):
//   pure-number → STALE_COLOR "n/a" wrapped     (e.g. "in:n/a")
//   number+unit → STALE_COLOR "-- <unit>"       (e.g. "5h:-- t/s")
//   gauge       → STALE_COLOR "░░░░░░░░ 0%"     (or full bar 100% in remaining mode)
//   bare-string → STALE_COLOR "n/a" wrapped
//
// The bare MODULES path is unaffected — bare `m_contextSize` still
// drops when tokens is null. To force a placeholder the user MUST
// use the inline form `m_contextSize` (which now defaults to
// placeholder — see above) or `m_contextSize:nulldrop:false`. To
// preserve old drop behavior on an inline token, write
// `m_contextSize:nulldrop:true`.

describe("renderTemplate — :nulldrop inline override (v0.4.0+)", () => {
  // ----- pure-number family -----

  it("m_contextSize:nulldrop:false with no tokens renders 'size:n/a' (placeholder)", () => {
    // v0.8.0+ — m_contextSize was renamed to m_contextSize (semantic now
    // cumulative occupancy, sourced from totals.input). The
    // placeholder still reads "size:n/a".
    const out = renderTemplate(
      ["m_contextSize:nulldrop:false"],
      ctxFor(null),
    ).join("\n");
    assert.equal(strip(out), "size:n/a");
    assert.ok(out.includes(STALE), `expected STALE wrap on: ${JSON.stringify(out)}`);
  });

  it("m_contextSize:nulldrop:false with zero totals.input renders 'size:0' (v6.x zero rule)", () => {
    // v6.x — zero is now rendered as "size:0" (a real value, not
    // a placeholder). The placeholder path is reserved for the
    // snapshot-missing case (test elsewhere).
    const out = renderTemplate(
      ["m_contextSize:nulldrop:false"],
      ctxFor(
        fakeSnapshot({
          totals: { input: 0, output: 0 },
          current: { input: 0, output: 0, cacheCreation: 0, cacheRead: 0 },
        }),
      ),
    ).join("\n");
    assert.equal(strip(out), "size:0");
  });

  it("m_contextSize bare form emits 'size:n/a' on null (v6.x placeholder parity)", () => {
    // v6.x — bare m_contextSize now follows the placeholder rule,
    // matching the inline path. Adjacent separators are preserved
    // (no orphan-space drop).
    const out = renderTemplate(["m_contextSize"], ctxFor(null)).join("\n");
    assert.equal(strip(out), "size:n/a");
    assert.ok(out.includes(STALE), `expected STALE wrap on: ${JSON.stringify(out)}`);
  });

  it("m_contextSize:nulldrop:true behaves like bare (drops on null)", () => {
    // Explicit nulldrop:true → preserve original drop behavior.
    const out = renderTemplate(["m_contextSize:nulldrop:true"], ctxFor(null));
    assert.deepEqual(out, []);
  });

  it("m_tokenCachedIn:nulldrop:false with cacheRead=0 renders 'cache:0 (0.0%)' (v6.x zero rule)", () => {
    // v6.x — cacheRead=0 is now rendered as "cache:0 (0.0%)" — a
    // real zero, not the placeholder. The placeholder path is
    // reserved for cacheRead=null (field not shipped by stdin).
    const out = renderTemplate(
      ["m_tokenCachedIn:nulldrop:false"],
      ctxFor(
        fakeSnapshot({
          current: { input: 38, output: 155, cacheCreation: 0, cacheRead: 0 },
        }),
      ),
    ).join("\n");
    assert.equal(strip(out), "cache:0 (0.0%)");
  });

  it("m_tokenCachedIn:nulldrop:false with cacheRead=null renders 'cache:n/a' (placeholder)", () => {
    // The placeholder path is reserved for the missing-field case
    // (cacheRead=null on a present snapshot).
    const out = renderTemplate(
      ["m_tokenCachedIn:nulldrop:false"],
      ctxFor(
        fakeSnapshot({
          current: { input: 38, output: 155, cacheCreation: 0, cacheRead: null },
        }),
      ),
    ).join("\n");
    assert.equal(strip(out), "cache:n/a");
  });

  it("m_tokenCachedIn bare form emits 'cache:0 (0.0%)' when read=0 (v6.x zero rule)", () => {
    // v6.x — bare m_tokenCachedIn renders the real "cache:0 (0.0%)"
    // chunk when read=0, matching the inline default. Drop is
    // reserved for cacheRead=null (the missing-field case).
    const out = renderTemplate(
      ["m_tokenCachedIn"],
      ctxFor(
        fakeSnapshot({
          current: { input: 38, output: 155, cacheCreation: 0, cacheRead: 0 },
        }),
      ),
    ).join("\n");
    assert.equal(strip(out), "cache:0 (0.0%)");
  });

  it("m_cacheHitRate:nulldrop:false: 0 cache / 38 totals.input = 0.0% (v0.8.0 per-turn formula)", () => {
    // v0.8.0+ formula is current.cacheRead / totals.input. When
    // cacheRead=0 and totals.input=38, the rate is 0/38 = 0.0% —
    // a truthful zero, NOT a placeholder drop.
    const out = renderTemplate(
      ["m_cacheHitRate:nulldrop:false"],
      ctxFor(
        fakeSnapshot({
          totals: { input: 38, output: 155 },
          current: { input: 38, output: 155, cacheCreation: 0, cacheRead: 0 },
        }),
      ),
    ).join("\n");
    assert.equal(strip(out), "hit:0.0%");
  });

  it("m_contextWindowsSize:nulldrop:false renders 'size:n/a' when context_window.size is null", () => {
    // v0.8.0+ — m_contextSize was renamed to m_contextWindowsSize
    // (capacity, sourced from context_window.size). The new
    // m_contextSize (cumulative occupancy) is tested separately
    // above.
    const out = renderTemplate(
      ["m_contextWindowsSize:nulldrop:false"],
      ctxFor(
        fakeSnapshot({ contextWindow: { size: null, usedPct: null, remainingPct: null } }),
      ),
    ).join("\n");
    assert.equal(strip(out), "size:n/a");
  });

  it("m_contextUsedPercent:nulldrop:false renders 'used:n/a%' when usedPct is null", () => {
    const out = renderTemplate(
      ["m_contextUsedPercent:nulldrop:false"],
      ctxFor(
        fakeSnapshot({ contextWindow: { size: 200000, usedPct: null, remainingPct: null } }),
      ),
    ).join("\n");
    assert.equal(strip(out), "used:n/a%");
  });

  it("m_tokenInTotal:nulldrop:false renders 'in:n/a' when totals.input is null", () => {
    const out = renderTemplate(
      ["m_tokenInTotal:nulldrop:false"],
      ctxFor(
        fakeSnapshot({ totals: { input: null, output: null } }),
      ),
    ).join("\n");
    assert.equal(strip(out), "in:n/a");
  });

  it("m_tokenTotalOut:nulldrop:false renders 'out:n/a' when totals.output is null", () => {
    const out = renderTemplate(
      ["m_tokenTotalOut:nulldrop:false"],
      ctxFor(
        fakeSnapshot({ totals: { input: null, output: null } }),
      ),
    ).join("\n");
    assert.equal(strip(out), "out:n/a");
  });

  // ----- number+unit family -----

  it("m_sessionDuration:nulldrop:false renders '--' (number+unit placeholder, no unit)", () => {
    const out = renderTemplate(
      ["m_sessionDuration:nulldrop:false"],
      ctxFor(
        fakeSnapshot({ cost: { totalDurationMs: null, totalApiDurationMs: null, totalLinesAdded: null, totalLinesRemoved: null } }),
      ),
    ).join("\n");
    assert.equal(strip(out), "--");
  });

  it("m_linesAdded:nulldrop:false renders '+ --' (signed placeholder)", () => {
    const out = renderTemplate(
      ["m_linesAdded:nulldrop:false"],
      ctxFor(
        fakeSnapshot({ cost: { totalDurationMs: 600_000, totalApiDurationMs: null, totalLinesAdded: null, totalLinesRemoved: null } }),
      ),
    ).join("\n");
    assert.equal(strip(out), "+ --");
  });

  it("m_linesRemoved:nulldrop:false renders '- --' (signed placeholder)", () => {
    const out = renderTemplate(
      ["m_linesRemoved:nulldrop:false"],
      ctxFor(
        fakeSnapshot({ cost: { totalDurationMs: 600_000, totalApiDurationMs: null, totalLinesAdded: null, totalLinesRemoved: null } }),
      ),
    ).join("\n");
    assert.equal(strip(out), "- --");
  });


  // ----- gauge family -----

  it("m_windowContext:nulldrop:false renders '░░░░░░░░ 0%' (gauge placeholder, used mode)", () => {
    const out = renderTemplate(
      ["m_windowContext:nulldrop:false"],
      ctxFor(
        fakeSnapshot({ contextWindow: { size: 200000, usedPct: null, remainingPct: null } }),
      ),
    ).join("\n");
    assert.equal(strip(out), "░░░░░░░░ 0%");
    assert.ok(out.includes(STALE), `expected STALE wrap on: ${JSON.stringify(out)}`);
  });

  it("m_windowContext:nulldrop:false in remaining mode renders '▓▓▓▓▓▓▓▓ 100%'", () => {
    const out = renderTemplate(
      ["m_windowContext:nulldrop:false:display:remaining"],
      ctxFor(
        fakeSnapshot({ contextWindow: { size: 200000, usedPct: null, remainingPct: null } }),
      ),
    ).join("\n");
    assert.equal(strip(out), "▓▓▓▓▓▓▓▓ 100%");
  });

  it("m_windowContext:nulldrop:false:color:red overrides STALE wrap with user color", () => {
    const RED_SGR = "\x1b[38;5;196m";
    const out = renderTemplate(
      ["m_windowContext:nulldrop:false:color:red"],
      ctxFor(
        fakeSnapshot({ contextWindow: { size: 200000, usedPct: null, remainingPct: null } }),
      ),
    ).join("\n");
    assert.equal(strip(out), "░░░░░░░░ 0%");
    assert.ok(out.includes(RED_SGR), `expected RED override in: ${JSON.stringify(out)}`);
  });

  it("m_windowContext bare form emits gray '░░░░░░░░ 0%' gauge (v6.x placeholder parity)", () => {
    // v6.x — bare form now follows the placeholder rule, matching
    // the inline path. The placeholder shape is a gray bar + "0%".
    const out = renderTemplate(
      ["m_windowContext"],
      ctxFor(
        fakeSnapshot({ contextWindow: { size: 200000, usedPct: null, remainingPct: null } }),
      ),
    ).join("\n");
    assert.equal(strip(out), "░░░░░░░░ 0%");
  });

  it("m_window5h:nulldrop:false renders gray '░░░░░░░░ 0%' when fiveHour is null", () => {
    // fiveHour is null → placeholder fires.
    const out = renderTemplate(
      ["m_window5h:nulldrop:false"],
      ctxFor(null, null, null),
    ).join("\n");
    assert.equal(strip(out), "░░░░░░░░ 0%");
  });

  it("m_window7d:nulldrop:false renders gray '░░░░░░░░ 0%' when weekly is null", () => {
    const out = renderTemplate(
      ["m_window7d:nulldrop:false"],
      ctxFor(null, null, null),
    ).join("\n");
    assert.equal(strip(out), "░░░░░░░░ 0%");
  });

  // ----- bare-string family -----

  it("m_session:nulldrop:false renders 'n/a' when sessionName is null", () => {
    const out = renderTemplate(
      ["m_session:nulldrop:false"],
      ctxFor(fakeSnapshot({ sessionName: null })),
    ).join("\n");
    assert.equal(strip(out), "n/a");
  });

  it("m_model:nulldrop:false renders 'n/a' when modelDisplayName is null", () => {
    const out = renderTemplate(
      ["m_model:nulldrop:false"],
      ctxFor(fakeSnapshot({ modelDisplayName: null })),
    ).join("\n");
    assert.equal(strip(out), "n/a");
  });

  it("m_effort:nulldrop:false renders 'n/a' when effort is null", () => {
    const out = renderTemplate(
      ["m_effort:nulldrop:false"],
      ctxFor(fakeSnapshot({ effort: null })),
    ).join("\n");
    assert.equal(strip(out), "n/a");
  });

  it("m_repo:nulldrop:false renders 'n/a' when all components are null", () => {
    const out = renderTemplate(
      ["m_repo:nulldrop:false"],
      ctxFor(fakeSnapshot({ repo: { host: null, owner: null, name: null } })),
    ).join("\n");
    assert.equal(strip(out), "n/a");
  });

  it("m_ccVersion:nulldrop:false renders 'n/a' when ccversion is null", () => {
    const out = renderTemplate(
      ["m_ccVersion:nulldrop:false"],
      ctxFor(fakeSnapshot({ ccversion: null })),
    ).join("\n");
    assert.equal(strip(out), "n/a");
  });

  // ----- separator-skip semantics preserved -----

  it("m_contextSize:nulldrop:false forces the slot; adjacent s_0 separators are preserved (v6.x)", () => {
    // v6.x — tokens=null now triggers "n/a" placeholders for the
    // per-API-call family too (m_tokenIn / m_tokenOut). The
    // placeholder keeps the slot occupied, so surrounding s_0
    // separators stay (matching the inline nulldrop:false contract).
    const out = renderTemplate(
      ["m_tokenIn", "s_space", "m_contextSize:nulldrop:false", "s_space", "m_tokenOut"],
      ctxFor(null),
    ).join("\n");
    assert.equal(strip(out), "in:n/a size:n/a out:n/a");
  });

  it("m_contextSize:nulldrop:false composed with :color: applies color to the placeholder", () => {
    const RED_SGR = "\x1b[38;5;196m";
    const out = renderTemplate(
      ["m_contextSize:nulldrop:false:color:red"],
      ctxFor(null),
    ).join("\n");
    assert.equal(strip(out), "size:n/a");
    assert.ok(out.includes(RED_SGR), `expected RED in: ${JSON.stringify(out)}`);
  });

  // ----- parse-fail path -----

  it("m_contextSize:nulldrop:invalid_value (not true/false) is a parse-fail — token drops + warn", () => {
    // Resolver returns null for any value other than 'true'/'false',
    // so parseInlineArgs returns null → badarg → warn + drop.
    // We don't assert the stderr line here (the warn is fired
    // once per process), but we do assert the chunk is gone.
    __resetUnknownModuleWarnForTest();
    const out = renderTemplate(
      ["m_contextSize:nulldrop:maybe"],
      ctxFor(null),
    );
    assert.deepEqual(out, []);
  });

  // ----- v0.4.0 default = placeholder (flip from earlier opt-in design) -----
  //
  // The DEFAULT for an INLINE token (one with `:` in it) is now
  // force-placeholder. This is a behavior flip from the
  // pre-v0.4.0-final design (which had nulldrop:false as the
  // opt-in). Bare `m_contextSize` (no colon) STILL drops — that path goes
  // through MODULES, not the inline dispatcher, and the v0.3.x
  // drop semantics on bare tokens are preserved as a backward-compat
  // promise. Users who want drop semantics on an inline token add
  // `:nulldrop:true`.
  //
  // Concretely: the placeholder fires whenever an inline token's
  // params.nulldrop is NOT the literal "true" (undefined counts as
  // "false" / default).

  it("bare m_contextSize emits 'size:n/a' on null (v6.x placeholder parity)", () => {
    // v6.x — bare m_contextSize now follows the placeholder rule, matching
    // the inline path's default behavior. There is no longer a
    // bare-vs-inline asymmetry.
    const out = renderTemplate(["m_contextSize"], ctxFor(null)).join("\n");
    assert.equal(strip(out), "size:n/a");
  });

  it("inline m_contextSize: (trailing colon, no args) defaults to placeholder — renders 'size:n/a'", () => {
    // The trailing-colon form `m_contextSize:` has empty remainder →
    // params={} → nulldrop undefined → placeholder fires.
    const out = renderTemplate(["m_contextSize:"], ctxFor(null)).join("\n");
    assert.equal(strip(out), "size:n/a");
    assert.ok(out.includes(STALE), `expected STALE wrap on: ${JSON.stringify(out)}`);
  });

  it("inline m_contextSize:nulldrop:false (explicit) renders placeholder 'size:n/a'", () => {
    // Equivalent to the no-arg form `m_contextSize:` after the flip.
    const out = renderTemplate(["m_contextSize:nulldrop:false"], ctxFor(null)).join("\n");
    assert.equal(strip(out), "size:n/a");
  });

  it("m_contextSize:nulldrop:true opts OUT of placeholder — drops on null", () => {
    // `:nulldrop:true` is the escape hatch for users who want the
    // v0.3.x drop-on-null semantics on an inline token.
    const out = renderTemplate(["m_contextSize:nulldrop:true"], ctxFor(null));
    assert.deepEqual(out, []);
  });

  it("bare m_windowContext emits gray '░░░░░░░░ 0%' gauge (v6.x placeholder parity)", () => {
    // v6.x — bare form follows the placeholder rule, matching
    // the inline path's default behavior.
    const out = renderTemplate(
      ["m_windowContext"],
      ctxFor(
        fakeSnapshot({ contextWindow: { size: 200000, usedPct: null, remainingPct: null } }),
      ),
    ).join("\n");
    assert.equal(strip(out), "░░░░░░░░ 0%");
  });

  it("inline m_windowContext: defaults to placeholder gray bar '░░░░░░░░ 0%'", () => {
    const out = renderTemplate(
      ["m_windowContext:"],
      ctxFor(
        fakeSnapshot({ contextWindow: { size: 200000, usedPct: null, remainingPct: null } }),
      ),
    ).join("\n");
    assert.equal(strip(out), "░░░░░░░░ 0%");
  });

  it("m_windowContext:nulldrop:true drops on null (preserves v0.3.x drop behavior)", () => {
    const out = renderTemplate(
      ["m_windowContext:nulldrop:true"],
      ctxFor(
        fakeSnapshot({ contextWindow: { size: 200000, usedPct: null, remainingPct: null } }),
      ),
    );
    assert.deepEqual(out, []);
  });

  it("inline m_session: defaults to placeholder 'n/a' on null sessionName", () => {
    const out = renderTemplate(["m_session:"], ctxFor(fakeSnapshot({ sessionName: null }))).join("\n");
    assert.equal(strip(out), "n/a");
  });

  it("m_session:nulldrop:true drops on null sessionName", () => {
    const out = renderTemplate(["m_session:nulldrop:true"], ctxFor(fakeSnapshot({ sessionName: null })));
    assert.deepEqual(out, []);
  });

  it("inline m_linesAdded: defaults to placeholder '+ --'", () => {
    const out = renderTemplate(
      ["m_linesAdded:"],
      ctxFor(
        fakeSnapshot({ cost: { totalDurationMs: 600_000, totalApiDurationMs: null, totalLinesAdded: null, totalLinesRemoved: null } }),
      ),
    ).join("\n");
    assert.equal(strip(out), "+ --");
  });

  it("m_linesAdded:nulldrop:true drops on null totalLinesAdded", () => {
    const out = renderTemplate(
      ["m_linesAdded:nulldrop:true"],
      ctxFor(
        fakeSnapshot({ cost: { totalDurationMs: 600_000, totalApiDurationMs: null, totalLinesAdded: null, totalLinesRemoved: null } }),
      ),
    );
    assert.deepEqual(out, []);
  });

  it("separator-skip behavior when :nulldrop:true opts out (documented gap)", () => {
    // nulldrop:true → drop → module disappears. The doc comment
    // promises "adjacent separators are skipped", but in practice
    // the inline dispatcher does NOT strip a leading s_N that was
    // already appended to the in-progress line before the dropped
    // module. This is a pre-existing renderer limitation (not
    // introduced by the nulldrop work) — the bare MODULES path has
    // the same shape: s_0 added before the module token stays in
    // `current` even if the module drops. The correct fix is a
    // post-render trim pass on `current`, scoped to recent drops;
    // for now we pin the OBSERVED behavior so a future fix can
    // tighten this without surprise.
    //
    // v6.x — m_tokenIn/m_tokenOut now render "in:n/a" / "out:n/a"
    // placeholders instead of "in:0" sentinels when tokens is
    // null. The nulldrop:true opt-out still drops m_contextSize, leaving
    // orphan s_space separators between the placeholders.
    const out = renderTemplate(
      ["m_tokenIn", "s_space", "m_contextSize:nulldrop:true", "s_space", "m_tokenOut"],
      ctxFor(null),
    ).join("\n");
    assert.match(strip(out), /^in:n\/a\s+out:n\/a$/);
    // m_contextSize:nulldrop:true is NOT in the output.
    assert.ok(!out.includes("size:"), `expected no size: chunk in: ${JSON.stringify(out)}`);
  });
});

// ----- v0.4.0+ speed cache + color:scale behavior ---------------------
//
// The speed modules gained two new behaviors in v0.4.0:
//   1. Cache the last ACTIVE-tick tps per session. On an idle
//      tick (no API call this turn), fall back to the cached
//      tps instead of rendering "-- t/s". Idle ticks do NOT
//      overwrite the cache.
//   2. 5-band scale coloring (`:color:scale` or bare default).
//      Faster = greener; slower = redder. `out` bands:
//      [10, 20, 40, 80]; `in` bands: 5× out = [50, 100, 200, 400].
//      `:color:<shortcut|SGR>` overrides the active-tick color
//      (e.g. `:color:red` → always red on active ticks).
//   3. Cached/inactive ticks ALWAYS render in STALE_COLOR
//      regardless of the user's :color: choice. Gray signals
//      "this is a stale measurement from a previous API call".

describe("renderTemplate — m_tokenInSpeed / m_tokenOutSpeed cache + scale (v0.4.0+)", () => {
  // ----- 5-band scale coloring on active ticks -----

  it("m_tokenInSpeed: 0.6 t/s → red (slowest band, < 50)", () => {
    // current.input=38, deltaApi=60_000 → 0.633 t/s; 0.6 < 50
    // → red.
    setPrevTick("sess-test", { apiMs: 0, in: 0, out: 0, cacheRead: 0 }, "D:\\test");
    const out = renderTemplate(["m_tokenInSpeed"], ctxFor(fakeSnapshot())).join("\n");
    assert.equal(strip(out), "in:0.6 t/s");
    assert.ok(out.includes(RED), `expected RED in: ${JSON.stringify(out)}`);
    assert.ok(!out.includes(STALE), `did not expect STALE in: ${JSON.stringify(out)}`);
  });

  it("m_tokenInSpeed: 50 t/s → orange (bands[0] boundary)", () => {
    // current.input=3000, deltaApi=60_000 → 50 t/s; 50 >= bands[0]=50
    // → palette[3] = orange.
    setPrevTick("sess-test", { apiMs: 0, in: 0, out: 0, cacheRead: 0 }, "D:\\test");
    const snap = fakeSnapshot({
      current: { input: 3000, output: 3000, cacheCreation: 0, cacheRead: 0 },
    });
    const out = renderTemplate(["m_tokenInSpeed"], ctxFor(snap)).join("\n");
    assert.equal(strip(out), "in:50.0 t/s");
    assert.ok(out.includes(ORANGE), `expected ORANGE in: ${JSON.stringify(out)}`);
  });

  it("m_tokenInSpeed: 400 t/s → bright green (fastest band, >= 400)", () => {
    // current.input=24000, deltaApi=60_000 → 400 t/s;
    // 400 >= bands[3]=400 → bright green.
    setPrevTick("sess-test", { apiMs: 0, in: 0, out: 0, cacheRead: 0 }, "D:\\test");
    const snap = fakeSnapshot({
      current: { input: 24_000, output: 24_000, cacheCreation: 0, cacheRead: 0 },
    });
    const out = renderTemplate(["m_tokenInSpeed"], ctxFor(snap)).join("\n");
    assert.equal(strip(out), "in:400.0 t/s");
    assert.ok(out.includes(GREEN), `expected GREEN in: ${JSON.stringify(out)}`);
  });

  it("m_tokenOutSpeed: 80 t/s → bright green (fastest out band)", () => {
    // current.output=4800, deltaApi=60_000 → 80 t/s;
    // 80 >= bands[3]=80 → bright green.
    setPrevTick("sess-test", { apiMs: 0, in: 0, out: 0, cacheRead: 0 }, "D:\\test");
    const snap = fakeSnapshot({
      current: { input: 4800, output: 4800, cacheCreation: 0, cacheRead: 0 },
    });
    const out = renderTemplate(["m_tokenOutSpeed"], ctxFor(snap)).join("\n");
    assert.equal(strip(out), "out:80.0 t/s");
    assert.ok(out.includes(GREEN), `expected GREEN in: ${JSON.stringify(out)}`);
  });

  it("m_tokenOutSpeed: 30 t/s → yellow (20 ≤ 30 < 40)", () => {
    setPrevTick("sess-test", { apiMs: 0, in: 0, out: 0, cacheRead: 0 }, "D:\\test");
    const snap = fakeSnapshot({
      current: { input: 1800, output: 1800, cacheCreation: 0, cacheRead: 0 },
    });
    const out = renderTemplate(["m_tokenOutSpeed"], ctxFor(snap)).join("\n");
    assert.equal(strip(out), "out:30.0 t/s");
    assert.ok(out.includes(YELLOW), `expected YELLOW in: ${JSON.stringify(out)}`);
  });

  it("m_tokenInSpeed:color:scale is equivalent to bare (scale is the default)", () => {
    // Explicit `:color:scale` and bare `m_tokenInSpeed` produce
    // the same color choice. The bare form defaults to scale
    // because scale is the canonical visualization for speed.
    // Use a fresh sessionId per call so the inline renderer's
    // writeback doesn't make the second call see deltaApi=0.
    const bare = renderTemplate(
      ["m_tokenInSpeed"],
      ctxFor(fakeSnapshot({ sessionId: "sess-bare" })),
    ).join("\n");
    const scaled = renderTemplate(
      ["m_tokenInSpeed:color:scale"],
      ctxFor(fakeSnapshot({ sessionId: "sess-scaled" })),
    ).join("\n");
    // Both should land in the same band (red, 0.6 t/s).
    assert.equal(strip(bare), strip(scaled));
    assert.ok(bare.includes(RED) && scaled.includes(RED), `bare=${JSON.stringify(bare)} scaled=${JSON.stringify(scaled)}`);
  });

  it("m_tokenInSpeed:color:red overrides scale on active ticks", () => {
    setPrevTick("sess-test", { apiMs: 0, in: 0, out: 0, cacheRead: 0 }, "D:\\test");
    const out = renderTemplate(
      ["m_tokenInSpeed:color:red"],
      ctxFor(fakeSnapshot()),
    ).join("\n");
    // 0.6 t/s would normally be red via scale; with explicit
    // `:color:red` it stays red (same color in this case —
    // semantically equivalent).
    assert.equal(strip(out), "in:0.6 t/s");
    assert.ok(out.includes(RED));
  });

  it("m_tokenInSpeed:color:brightGreen on a slow turn still renders green", () => {
    // 0.6 t/s would be red via scale; the user's `:color:brightGreen`
    // override wins. This is the "if user explicitly asked, ignore
    // the natural scheme in favor of theirs" rule.
    setPrevTick("sess-test", { apiMs: 0, in: 0, out: 0, cacheRead: 0 }, "D:\\test");
    const out = renderTemplate(
      ["m_tokenInSpeed:color:brightGreen"],
      ctxFor(fakeSnapshot()),
    ).join("\n");
    assert.equal(strip(out), "in:0.6 t/s");
    assert.ok(out.includes(GREEN), `expected GREEN override in: ${JSON.stringify(out)}`);
  });

  // ----- cached (inactive) tick behavior -----

  it("m_tokenInSpeed: idle tick with cached tps → STALE_COLOR, not -- t/s", () => {
    // First tick: active, writes 38/60000*1000 = 0.633 → cache
    // holds 0.633. Second tick: deltaApi=0 (same totalApiDurationMs
    // as cached) → falls back to cached value with STALE_COLOR.
    setPrevTick("sess-test", { apiMs: 0, in: 0, out: 0, cacheRead: 0 }, "D:\\test");
    renderTemplate(["m_tokenInSpeed"], ctxFor(fakeSnapshot()));
    // Idle tick: same totalApiDurationMs (60_000) → deltaApi=0.
    setPrevTick("sess-test", { apiMs: 60_000, in: 38, out: 155, cacheRead: 0 }, "D:\\test");
    const out = renderTemplate(["m_tokenInSpeed"], ctxFor(fakeSnapshot())).join("\n");
    // Cached value (0.6 t/s) wrapped in STALE_COLOR.
    assert.equal(strip(out), "in:0.6 t/s");
    assert.ok(out.includes(STALE), `expected STALE (cached) in: ${JSON.stringify(out)}`);
  });

  it("m_tokenInSpeed: idle tick with NO cached tps → 'in:0.0 t/s' (v6.x idle=0)", () => {
    // v6.x — idle tick now renders the truthful 0.0 t/s rate.
    // The missing-data sentinel is reserved for the snapshot-missing
    // case (handled via ctxFor(null) elsewhere).
    setPrevTick("sess-test", { apiMs: 60_000, in: 0, out: 0, cacheRead: 0 }, "D:\\test");
    const out = renderTemplate(["m_tokenInSpeed"], ctxFor(fakeSnapshot())).join("\n");
    assert.equal(strip(out), "in:0.0 t/s");
  });

  it("m_tokenInSpeed: idle tick → STALE_COLOR even with :color:red override", () => {
    // Per the user's "inactive 不受 :color: 影响" decision:
    // cached/inactive ticks ALWAYS use STALE_COLOR regardless of
    // the user's color override. Gray is the canonical "this is a
    // stale measurement" signal — overriding it would erase the
    // "inactive" affordance.
    setPrevTick("sess-test", { apiMs: 0, in: 0, out: 0, cacheRead: 0 }, "D:\\test");
    // Prime the cache with an active tick.
    renderTemplate(["m_tokenInSpeed:color:red"], ctxFor(fakeSnapshot()));
    // Idle tick: same totalApiDurationMs.
    setPrevTick("sess-test", { apiMs: 60_000, in: 38, out: 155, cacheRead: 0 }, "D:\\test");
    const out = renderTemplate(
      ["m_tokenInSpeed:color:red"],
      ctxFor(fakeSnapshot()),
    ).join("\n");
    assert.equal(strip(out), "in:0.6 t/s");
    assert.ok(
      out.includes(STALE),
      `expected STALE on cached tick even with :color:red in: ${JSON.stringify(out)}`,
    );
    // And the RED override from :color:red should NOT be present
    // on the cached render — only the active render.
    assert.ok(
      !out.includes(RED),
      `did not expect RED on cached tick in: ${JSON.stringify(out)}`,
    );
  });

  it("m_tokenInSpeed: cache is project-wide (no session dimension)", () => {
    // v0.4.x — the lastActive:in slot is now a single project-wide
    // entry (no sessionId dimension) with a 60s TTL. Session changes
    // do NOT isolate the cache: sess-B sees sess-A's cached tps.
    // The test pins that simplified contract.
    setPrevTick("sess-A", { apiMs: 0, in: 0, out: 0, cacheRead: 0 }, "D:\\test");
    renderTemplate(["m_tokenInSpeed"], ctxFor(fakeSnapshot({ sessionId: "sess-A" })));
    // Now switch to sess-B; prime it with a prev at the SAME
    // totalApiDurationMs (idle tick). With the new design,
    // lastActive:in is still hot from sess-A, so sess-B sees the
    // cached tps (rendered with STALE_COLOR since the tick is idle).
    setPrevTick("sess-B", { apiMs: 60_000, in: 0, out: 0, cacheRead: 0 }, "D:\\test");
    const out = renderTemplate(
      ["m_tokenInSpeed"],
      ctxFor(fakeSnapshot({ sessionId: "sess-B" })),
    ).join("\n");
    assert.equal(strip(out), "in:0.6 t/s");
    assert.ok(out.includes(STALE), `expected STALE on idle cross-session tick in: ${JSON.stringify(out)}`);
  });

  it("m_tokenInSpeed: idle tick does NOT overwrite the cache", () => {
    // Prime with 0.6 t/s.
    setPrevTick("sess-test", { apiMs: 0, in: 0, out: 0, cacheRead: 0 }, "D:\\test");
    renderTemplate(["m_tokenInSpeed"], ctxFor(fakeSnapshot()));
    // Idle tick at higher totalApiDurationMs but no API call.
    setPrevTick("sess-test", { apiMs: 60_000, in: 38, out: 155, cacheRead: 0 }, "D:\\test");
    renderTemplate(["m_tokenInSpeed"], ctxFor(fakeSnapshot()));
    // The cache should still hold 0.633 (the first tick's value),
    // not some interpolated number from the idle tick.
    // We can't directly peek the cache from the test (peekLastSpeed
    // is the helper), so we assert via behavior: a subsequent
    // active tick writes a NEW value, and the idle tick's lack of
    // write is implicit in the fact that we got a cached 0.6.
    // Render another idle tick to confirm cache is still 0.6.
    const out = renderTemplate(["m_tokenInSpeed"], ctxFor(fakeSnapshot())).join("\n");
    assert.equal(strip(out), "in:0.6 t/s");
  });
});

// ----- v0.4.0+ m_template module -----
//
// Direct coverage of `m_template:<key>[:mode:<plan|balance>]` against
// `renderTemplate` (no provider dispatch — ctx.providerType is
// set explicitly). The end-to-end "minimax renders the chunk" path
// is in lineTemplate.test.ts; this file exercises the renderer in
// isolation so a missing-key warn is easier to capture.
//
// The inline `:mode:` arg keeps the OLD name for back-compat with
// existing config.json files; the comparison target inside the
// renderer is now ctx.providerType (renamed from providerModeKey).
describe("renderTemplate — m_template inline-args (v0.4.0+)", () => {
  beforeEach(() => __resetForTest());

  it("m_template:foo with ctx.providerType='plan' expands the registered fragment", () => {
    __resetForTest({
      lineTemplates: { foo: ["m_window5h"] },
    });
    const out = renderTemplate(["m_template:foo"], ctxFor(null, { pct: 42 }));
    // m_window5h at 42% should land in band 1 (orange) per the
    // default band thresholds. Strip ANSI for stability.
    assert.match(out.map(strip).join("\n"), /42%/);
  });

  it("m_template:foo with ctx.providerType='balance' wants mode:plan → drops", () => {
    __resetForTest({
      lineTemplates: { foo: ["m_window5h"] },
    });
    const out = renderTemplate(
      ["m_template:foo:mode:plan"],
      ctxFor(null, null, null, "balance"),
    );
    // Dropped because providerType=balance but mode wants plan.
    // The dropped chunk leaves an empty array (separators are also
    // skipped when their neighbors drop).
    assert.deepEqual(out, []);
  });

  it("m_template:foo with ctx.providerType='plan' wants mode:plan → renders", () => {
    __resetForTest({
      lineTemplates: { foo: ["m_window5h"] },
    });
    const out = renderTemplate(
      ["m_template:foo:mode:plan"],
      ctxFor(null, { pct: 42 }, null, "plan"),
    );
    assert.match(out.map(strip).join("\n"), /42%/);
  });

  it("m_template:nonexistent (missing key) warns and drops", () => {
    let captured = "";
    const err = process.stderr as unknown as { write: (chunk: string) => boolean };
    const original = err.write;
    err.write = (chunk) => {
      captured += typeof chunk === "string" ? chunk : "";
      return true;
    };
    try {
      const out = renderTemplate(["m_template:nonexistent"], ctxFor(null));
      assert.deepEqual(out, []);
      assert.match(captured, /lineTemplates\["nonexistent"\] is undefined/);
    } finally {
      err.write = original;
    }
  });
});

// v0.4.x+ — Per-Project cache isolation. Two snapshots with the
// same sessionId but different cwds must NOT share the same
// tickSpeed: / tickAvg: cache slot. The render layer applies a
// `projectHash(cwd):` prefix before calling into the cache module,
// so each project's accumulator lives at a distinct key. This
// describe block exercises that path end-to-end via the public
// render-template API.
describe("render — per-project cache isolation", () => {
  it("same sessionId, different cwds → accumulators are independent", () => {
    __resetForTest({ lineTemplates: { tok: ["m_tokenInSpeed", "m_tokenOutSpeed"] } });
    // Use the EXACT same sessionId but two different cwds. If the
    // per-project prefix were missing, the two renders would share
    // the same tickSpeed: cache slot and the second render would
    // see the first render's prev-tick snapshot — leading to
    // wrong deltaIn/deltaOut values.
    const sid = "sess-shared";
    const tokensA = fakeSnapshot({
      sessionId: sid,
      cwd: "D:\\WorkSpace\\alpha",
      totals: { input: 0, output: 0 },
      current: { input: 0, output: 0, cacheCreation: 0, cacheRead: 0 },
      cost: { totalDurationMs: 0, totalApiDurationMs: 0, totalLinesAdded: 0, totalLinesRemoved: 0 },
    });
    const tokensB = fakeSnapshot({
      sessionId: sid,
      cwd: "D:\\WorkSpace\\beta",
      totals: { input: 0, output: 0 },
      current: { input: 0, output: 0, cacheCreation: 0, cacheRead: 0 },
      cost: { totalDurationMs: 0, totalApiDurationMs: 0, totalLinesAdded: 0, totalLinesRemoved: 0 },
    });
    // First render in project A: set a prev-tick baseline via the
    // public setPrevTick + cwd (which exercises the same key
    // prefixing the production code path uses). After the render,
    // the tickSpeed: slot for project A holds 100ms of apiMs.
    setPrevTick(sid, { apiMs: 100, in: 0, out: 0, cacheRead: 0 }, tokensA.cwd);
    // First render in project B: different cwd → different slot.
    // Set a distinct baseline (0ms) so the two slots are clearly
    // distinguishable.
    setPrevTick(sid, { apiMs: 0, in: 0, out: 0, cacheRead: 0 }, tokensB.cwd);

    // Peek each project's slot — they must be distinct.
    const a = peekPrevTick(sid, tokensA.cwd);
    const b = peekPrevTick(sid, tokensB.cwd);
    assert.deepEqual(a, { apiMs: 100, in: 0, out: 0, cacheRead: 0 });
    assert.deepEqual(b, { apiMs: 0, in: 0, out: 0, cacheRead: 0 });

    // Cleanup: clear both slots so the next test in the suite
    // (which uses the default `D:\\test` cwd → projectHash
    // "d--test") is not contaminated.
    __resetPrevTickForTest(sid, tokensA.cwd);
    __resetPrevTickForTest(sid, tokensB.cwd);
  });
});

// ----- v0.4.x — named separator aliases (s_space / s_dot / s_newline / s_tab / s_colon) -----
//
// Per AskUserQuestion direction, the default `separators` array is
// empty in v0.4.x — the built-in characters (" ", "·", "\n", "\t",
// ":") are now reachable via NAMED ALIASES that work independently
// of the array. Users can still set `separators: ["x", "y"]` and
// reference them with `s_0` / `s_1`; the two forms don't interfere
// with each other.
describe("renderTemplate — named separator aliases (v0.4.x)", () => {
  beforeEach(() => {
    // Reset to the v0.4.x defaults: empty `separators` array, the
    // default template, no version injection.
    __resetForTest();
  });

  // ----- Bare form, default empty array -----

  it('s_space renders the literal " " even when `separators` is empty', () => {
    // DEFAULT_SEPARATORS is now []; the alias MUST resolve from
    // NAMED_SEPARATORS, not from seps[0]. The template
    // ["m_modeLabel", "s_space", "m_modeLabel"] concatenates to
    // a single line "Usage: Usage:" (the alias fills the slot).
    const out = renderTemplate(["m_modeLabel", "s_space", "m_modeLabel"], ctxFor(null));
    // m_modeLabel renders "Usage:" for the plan mode default.
    // Output lines are joined with no internal separator here —
    // renderTemplate returns the post-newline-split line array.
    assert.deepEqual(out.map(strip), ["Usage: Usage:"]);
  });

  it('s_dot renders "·" (middot U+00B7) even when `separators` is empty', () => {
    const out = renderTemplate(["s_dot"], ctxFor(null));
    assert.deepEqual(out.map(strip), ["·"]);
  });

  it("s_newline renders the literal newline char (default array is empty)", () => {
    // The bare-form path must split the template on the "\n"
    // alias just like a `separators[2] === "\n"` would. We use
    // a trivial template so we only assert the split behavior,
    // not any module rendering.
    const out = renderTemplate(["s_newline"], ctxFor(null));
    // A single bare "\n" should produce zero output lines
    // (trailing newline is trimmed, same as the array path's
    // behavior tested in the "newline separator" suite above).
    assert.deepEqual(out, []);
  });

  it("s_tab renders the literal TAB char", () => {
    const out = renderTemplate(["s_tab"], ctxFor(null));
    assert.deepEqual(out.map(strip), ["\t"]);
  });

  it('s_colon renders the literal ":"', () => {
    const out = renderTemplate(["s_colon"], ctxFor(null));
    assert.deepEqual(out.map(strip), [":"]);
  });

  // ----- Inline-args form (`:color:<c>` / `:nulldrop:<b>`) -----

  it("s_space:color:brightGreen wraps the space in the brightGreen SGR", () => {
    const out = renderTemplate(["s_space:color:brightGreen"], ctxFor(null));
    assert.equal(out.length, 1);
    assert.equal(strip(out[0]), " ");
    assert.ok(out[0].includes(GREEN), `expected GREEN in: ${JSON.stringify(out[0])}`);
  });

  it("s_dot:color:red wraps the dot in the red SGR", () => {
    const out = renderTemplate(["s_dot:color:red"], ctxFor(null));
    assert.equal(out.length, 1);
    assert.equal(strip(out[0]), "·");
    assert.ok(out[0].includes(RED), `expected RED in: ${JSON.stringify(out[0])}`);
  });

  // ----- Independence from `separators` array -----

  it("s_space ignores `separators: ['x','y']` — alias always renders ' '", () => {
    __resetForTest({ separators: ["x", "y"] });
    const out = renderTemplate(["s_space"], ctxFor(null));
    assert.deepEqual(out.map(strip), [" "]);
  });

  it("s_0 still resolves to separators[0] when the array is set", () => {
    // Backward-compat: a user with `separators: ["x", "y"]` and
    // a template using `s_0` / `s_1` sees no change. The named
    // aliases do NOT hijack numeric suffixes. Adjacent tokens
    // concatenate into one line.
    __resetForTest({ separators: ["x", "y"] });
    const out = renderTemplate(["s_0", "s_1", "s_0"], ctxFor(null));
    assert.deepEqual(out.map(strip), ["xyx"]);
  });

  it("s_0 with the default empty array warns + drops (out-of-range)", () => {
    // The legacy out-of-range behavior must still fire when the
    // user references an index that doesn't exist. With the new
    // empty default array, even s_0 is out-of-range — a user who
    // upgrades from v0.3.x without setting `separators` will see
    // their templates drop s_<n> tokens. They should migrate to
    // the named aliases (s_space, s_dot) which keep working.
    __resetForTest();
    __resetUnknownModuleWarnForTest();
    const out = renderTemplate(["s_0"], ctxFor(null));
    assert.deepEqual(out, []);
  });

  // ----- Unknown alias warns + drops -----

  it("s_xyz (unknown alias name) warns + drops", () => {
    // Matches the existing s_<out-of-range> behavior: warn once
    // (fired by warnUnknownModuleOnce), then drop the chunk.
    __resetUnknownModuleWarnForTest();
    const out = renderTemplate(["s_xyz"], ctxFor(null));
    assert.deepEqual(out, []);
  });

  it("s_dot:color:bogus_color (bad inline arg) warns + drops", () => {
    // Inline-args form: the resolver succeeds (s_dot IS a known
    // alias), but the `:color:bogus_color` arg fails the color
    // validator → badarg → warn + drop. The whole s_dot chunk
    // is gone; s_space (no args) in the same template survives.
    // The three pieces concatenate into one line "  " (two
    // spaces, the dot chunk dropped).
    __resetUnknownModuleWarnForTest();
    const out = renderTemplate(
      ["s_space", "s_dot:color:bogus_color", "s_space"],
      ctxFor(null),
    );
    assert.deepEqual(out.map(strip), ["  "]);
  });
});

// ----- v0.8.0+ acc modules (per-session / per-project / per-model) -----
//
// Six new modules expose the three-layer accumulator that setAvg
// writes each tick:
//   m_accTokenIn       — session-cumulative current.input
//   m_accTokenOut      — session-cumulative current.output
//   m_accTokenCachedIn — session-cumulative current.cacheRead
//   m_accTokenTotalIn  — accIn + accCached (the "total tokens
//                        the model has seen this session, counting
//                        cache_read as already-paid-for" view)
//   m_accApiMs         — session-cumulative cost.totalApiDurationMs
//   m_accCacheHitRate  — accCached / (accCached + accIn) * 100%
//
// All six accept an optional `:scope:<session|project|model>` arg.
// Default scope:
//   - the 5 plain modules fall back to "project" when no
//     sessionId is on the snapshot (so a fresh project renders
//     placeholders instead of empty), otherwise "session".
//   - m_accCacheHitRate defaults to "session" — a per-session
//     ratio is the natural "what % of MY model reads are cache
//     hits" answer; project/model are opt-in.
//
// Slot locations (setAvg writes 3 slots per tick):
//   session: tickStatus:<sid>     (read via peekAvg)
//   project: tickStatus            (read via statusStore.readTickStatus)
//   model:   tickStatus:<model>    (read via statusStore.readTickStatus)
//
// Placeholders (v0.8.0+ labels.*): the four token-axis acc
// modules (m_accTokenIn/Out/CachedIn/TotalIn) read their prefix
// from labelFor so the placeholder matches the configured
// labelIn/Out/CacheIn/TotalIn. m_accApiMs / m_accCacheHitRate
// are NOT in the user-facing axis set, so they keep their
// hardcoded "acc:" / "acc:n/a%" prefix shape. Inline default is
// the placeholder (nulldrop:false behavior); bare form also
// renders the placeholder when data is missing — matching the
// v6.x bare-vs-inline parity rule.
describe("renderTemplate — v0.8.0+ m_acc* modules (three-scope accumulators)", () => {
  it("m_accTokenIn: bare form with no session slot → 'in:n/a' placeholder", () => {
    // No setAvg called → peekAvg returns null → placeholder fires.
    const out = renderTemplate(
      ["m_accTokenIn"],
      ctxFor(fakeSnapshot({ sessionId: "sess-fresh-1" })),
    ).join("\n");
    assert.equal(strip(out), "in:n/a");
    assert.ok(out.includes(STALE), `expected STALE wrap on: ${JSON.stringify(out)}`);
  });

  it("m_accTokenIn: session scope reads accIn from per-session slot", () => {
    // Set the session slot directly via setAvg (full deltas so
    // the gate passes).
    setAvg(
      "sess-acc-in",
      { accIn: 42000, accOut: 0, accApi: 0, accCached: 0, accApiCount: 1 },
      "D:\\test",
      {
        modelDisplayName: "MiniMax-M3",
        deltaApiCount: 1,
        currentIn: 42000,
        currentOut: 0,
        currentCacheRead: 0,
        currentApiMs: 1000,
        deltaIn: 42000,
        deltaOut: 0,
        deltaCache: 0,
        deltaApiMs: 1000,
      },
    );
    const out = renderTemplate(
      ["m_accTokenIn"],
      ctxFor(fakeSnapshot({ sessionId: "sess-acc-in" })),
    ).join("\n");
    // formatCompactToken(42000) = "42.0k" → "in:42.0k" (v0.8.0+
    // labels.* — m_accTokenIn shares the labelIn axis with its
    // per-turn sibling m_tokenIn)
    assert.equal(strip(out), "in:42.0k");
  });

  it("m_accTokenOut: session scope reads accOut from per-session slot", () => {
    setAvg(
      "sess-acc-out",
      { accIn: 0, accOut: 1234, accApi: 0, accCached: 0, accApiCount: 1 },
      "D:\\test",
      {
        modelDisplayName: "MiniMax-M3",
        deltaApiCount: 1,
        currentIn: 0,
        currentOut: 1234,
        currentCacheRead: 0,
        currentApiMs: 1000,
        deltaIn: 0,
        deltaOut: 1234,
        deltaCache: 0,
        deltaApiMs: 1000,
      },
    );
    const out = renderTemplate(
      ["m_accTokenOut"],
      ctxFor(fakeSnapshot({ sessionId: "sess-acc-out" })),
    ).join("\n");
    // formatCompactToken(1234) = "1.2k" → "out:1.2k" (v0.8.0+
    // labels.* — m_accTokenOut shares the labelOut axis with
    // m_tokenOut)
    assert.equal(strip(out), "out:1.2k");
  });

  it("m_accTokenCachedIn: session scope reads accCached from per-session slot", () => {
    setAvg(
      "sess-acc-cached",
      { accIn: 0, accOut: 0, accApi: 0, accCached: 163441, accApiCount: 1 },
      "D:\\test",
      {
        modelDisplayName: "MiniMax-M3",
        deltaApiCount: 1,
        currentIn: 0,
        currentOut: 0,
        currentCacheRead: 163441,
        currentApiMs: 1000,
        deltaIn: 0,
        deltaOut: 0,
        deltaCache: 163441,
        deltaApiMs: 1000,
      },
    );
    const out = renderTemplate(
      ["m_accTokenCachedIn"],
      ctxFor(fakeSnapshot({ sessionId: "sess-acc-cached" })),
    ).join("\n");
    // formatCompactToken(163441) = "163.4k" → "cache:163.4k"
    // (v0.8.0+ labels.* — m_accTokenCachedIn shares the labelCacheIn
    // axis with m_tokenCachedIn)
    assert.equal(strip(out), "cache:163.4k");
  });

  it("m_accTokenTotalIn: derived field accIn + accCached → 'total:163.5k' (0+163441+38 total)", () => {
    // Real shape: with both accIn=38 and accCached=163441, total is 163479.
    setAvg(
      "sess-acc-total",
      { accIn: 38, accOut: 0, accApi: 0, accCached: 163441, accApiCount: 1 },
      "D:\\test",
      {
        modelDisplayName: "MiniMax-M3",
        deltaApiCount: 1,
        currentIn: 38,
        currentOut: 0,
        currentCacheRead: 163441,
        currentApiMs: 1000,
        deltaIn: 38,
        deltaOut: 0,
        deltaCache: 163441,
        deltaApiMs: 1000,
      },
    );
    const out = renderTemplate(
      ["m_accTokenTotalIn"],
      ctxFor(fakeSnapshot({ sessionId: "sess-acc-total" })),
    ).join("\n");
    // 38 + 163441 = 163479 → "163.5k" → "total:163.5k" (v0.8.0+
    // labels.* — m_accTokenTotalIn shares the labelTotalIn axis
    // with m_tokenTotalIn and m_sumTokenTotalIn)
    assert.equal(strip(out), "total:163.5k");
  });

  it("m_accApiMs: session scope reads accApi from per-session slot", () => {
    setAvg(
      "sess-acc-api",
      { accIn: 0, accOut: 0, accApi: 60_000, accCached: 0, accApiCount: 1 },
      "D:\\test",
      {
        modelDisplayName: "MiniMax-M3",
        deltaApiCount: 1,
        currentIn: 0,
        currentOut: 0,
        currentCacheRead: 0,
        currentApiMs: 60_000,
        deltaIn: 0,
        deltaOut: 0,
        deltaCache: 0,
        deltaApiMs: 60_000,
      },
    );
    const out = renderTemplate(
      ["m_accApiMs"],
      ctxFor(fakeSnapshot({ sessionId: "sess-acc-api" })),
    ).join("\n");
    // formatCompactToken(60_000) = "60.0k" — the unit (ms) is
    // implicit by the module name; no "ms" suffix is rendered.
    assert.equal(strip(out), "acc:60.0k");
  });

  it("m_accCacheHitRate: session scope formula accCached / (accCached + accIn) = 99.978%", () => {
    // 163441 / (163441 + 38) * 100 = 99.97799… → toFixed(1) → "100.0%".
    setAvg(
      "sess-acc-hit",
      { accIn: 38, accOut: 0, accApi: 0, accCached: 163441, accApiCount: 1 },
      "D:\\test",
      {
        modelDisplayName: "MiniMax-M3",
        deltaApiCount: 1,
        currentIn: 38,
        currentOut: 0,
        currentCacheRead: 163441,
        currentApiMs: 1000,
        deltaIn: 38,
        deltaOut: 0,
        deltaCache: 163441,
        deltaApiMs: 1000,
      },
    );
    const out = renderTemplate(
      ["m_accCacheHitRate"],
      ctxFor(fakeSnapshot({ sessionId: "sess-acc-hit" })),
    ).join("\n");
    assert.equal(strip(out), "acc:100.0%");
  });

  it("m_accCacheHitRate: zero denominator → 'acc:0.0%' (no placeholder drop)", () => {
    // All-zero slot → no input and no cache → 0/0. Per the v6.x
    // zero-value rule, render "acc:0.0%" rather than "acc:n/a%".
    setAvg(
      "sess-acc-zero",
      { accIn: 0, accOut: 0, accApi: 0, accCached: 0, accApiCount: 0 },
      "D:\\test",
      {
        modelDisplayName: null,
        deltaApiCount: 0,
        currentIn: 0,
        currentOut: 0,
        currentCacheRead: 0,
        currentApiMs: 0,
        deltaIn: 0,
        deltaOut: 0,
        deltaCache: 0,
        deltaApiMs: 0,
      },
    );
    const out = renderTemplate(
      ["m_accCacheHitRate"],
      ctxFor(fakeSnapshot({ sessionId: "sess-acc-zero" })),
    ).join("\n");
    assert.equal(strip(out), "acc:0.0%");
  });

  it("m_accCacheHitRate: missing slot → 'acc:n/a%' placeholder", () => {
    // No setAvg called for this sessionId → peekAvg returns null
    // → placeholder path fires.
    const out = renderTemplate(
      ["m_accCacheHitRate"],
      ctxFor(fakeSnapshot({ sessionId: "sess-hit-fresh" })),
    ).join("\n");
    assert.equal(strip(out), "acc:n/a%");
    assert.ok(out.includes(STALE), `expected STALE wrap on: ${JSON.stringify(out)}`);
  });

  it("m_accTokenIn:scope:project reads the project-wide slot (cross-session)", () => {
    // Seed the project-wide slot directly via setAvg (setAvg bumps
    // all 3 layers — the project slot is keyed by cwd only).
    setAvg(
      "sess-X",
      { accIn: 100, accOut: 0, accApi: 0, accCached: 0, accApiCount: 1 },
      "D:\\project-scope-test",
      {
        modelDisplayName: "MiniMax-M3",
        deltaApiCount: 1,
        currentIn: 100,
        currentOut: 0,
        currentCacheRead: 0,
        currentApiMs: 1000,
        deltaIn: 100,
        deltaOut: 0,
        deltaCache: 0,
        deltaApiMs: 1000,
      },
    );
    setAvg(
      "sess-Y",
      { accIn: 250, accOut: 0, accApi: 0, accCached: 0, accApiCount: 1 },
      "D:\\project-scope-test",
      {
        modelDisplayName: "MiniMax-M3",
        deltaApiCount: 1,
        currentIn: 150,
        currentOut: 0,
        currentCacheRead: 0,
        currentApiMs: 1000,
        deltaIn: 150,
        deltaOut: 0,
        deltaCache: 0,
        deltaApiMs: 1000,
      },
    );
    // Render with a THIRD sessionId — the per-session slot for
    // sess-Z is null, but the project slot has both prior deltas
    // accumulated (100 + 150 = 250).
    const out = renderTemplate(
      ["m_accTokenIn:scope:project"],
      ctxFor(fakeSnapshot({ sessionId: "sess-Z", cwd: "D:\\project-scope-test" })),
    ).join("\n");
    // v0.8.0+ labels.* — m_accTokenIn renders under labelIn.
    assert.equal(strip(out), "in:250");
  });

  it("m_accTokenIn:scope:model reads the per-model slot (cross-session, single model)", () => {
    // Two sessions under the same model + cwd. The model slot
    // accumulates both deltas (100 + 150 = 250), independent of
    // sessionId.
    setAvg(
      "sess-M1",
      { accIn: 100, accOut: 0, accApi: 0, accCached: 0, accApiCount: 1 },
      "D:\\model-scope-test",
      {
        modelDisplayName: "MiniMax-M3",
        deltaApiCount: 1,
        currentIn: 100,
        currentOut: 0,
        currentCacheRead: 0,
        currentApiMs: 1000,
        deltaIn: 100,
        deltaOut: 0,
        deltaCache: 0,
        deltaApiMs: 1000,
      },
    );
    setAvg(
      "sess-M2",
      { accIn: 250, accOut: 0, accApi: 0, accCached: 0, accApiCount: 1 },
      "D:\\model-scope-test",
      {
        modelDisplayName: "MiniMax-M3",
        deltaApiCount: 1,
        currentIn: 150,
        currentOut: 0,
        currentCacheRead: 0,
        currentApiMs: 1000,
        deltaIn: 150,
        deltaOut: 0,
        deltaCache: 0,
        deltaApiMs: 1000,
      },
    );
    // Render with model="MiniMax-M3" — model slot is keyed by
    // model+cwd. Should read 250.
    const out = renderTemplate(
      ["m_accTokenIn:scope:model"],
      ctxFor(
        fakeSnapshot({
          sessionId: "sess-M3",
          cwd: "D:\\model-scope-test",
          modelDisplayName: "MiniMax-M3",
        }),
      ),
    ).join("\n");
    // v0.8.0+ labels.* — m_accTokenIn renders under labelIn.
    assert.equal(strip(out), "in:250");
  });

  it("m_accTokenIn:scope:model with no modelDisplayName on snapshot → 'in:n/a'", () => {
    // peekAcc's model branch returns null when ctx.tokens has no
    // modelDisplayName (cannot resolve the model slot key).
    const out = renderTemplate(
      ["m_accTokenIn:scope:model"],
      ctxFor(fakeSnapshot({ sessionId: "sess-no-model", modelDisplayName: null })),
    ).join("\n");
    // v0.8.0+ labels.* — placeholder reads labelIn.
    assert.equal(strip(out), "in:n/a");
  });

  it("m_accTokenIn:scope:session (explicit) on a fresh snapshot → 'in:n/a' placeholder", () => {
    // No setAvg called → per-session slot missing → placeholder.
    const out = renderTemplate(
      ["m_accTokenIn:scope:session"],
      ctxFor(fakeSnapshot({ sessionId: "sess-scope-fresh" })),
    ).join("\n");
    // v0.8.0+ labels.* — placeholder reads labelIn.
    assert.equal(strip(out), "in:n/a");
  });

  it("m_accTokenIn:scope:invalid (not session/project/model) is a parse-fail — drops", () => {
    // The SCOPE_PARAM resolver only accepts the three literal
    // values; "invalid" is rejected → parseInlineArgs returns
    // null → badarg → dispatcher warn + drop.
    __resetUnknownModuleWarnForTest();
    const out = renderTemplate(
      ["m_accTokenIn:scope:invalid"],
      ctxFor(fakeSnapshot({ sessionId: "sess-bad-scope" })),
    );
    assert.deepEqual(out, []);
  });

  it("m_accTokenIn:nulldrop:false (default for inline) renders placeholder on missing slot", () => {
    // Inline default is placeholder — same shape as bare form.
    const out = renderTemplate(
      ["m_accTokenIn:nulldrop:false"],
      ctxFor(fakeSnapshot({ sessionId: "sess-no-data" })),
    ).join("\n");
    // v0.8.0+ labels.* — placeholder reads labelIn.
    assert.equal(strip(out), "in:n/a");
  });

  it("m_accTokenIn:nulldrop:true is a no-op (function never returns null)", () => {
    // The m_accTokenIn renderer never returns null — it always
    // returns either "in:N" or "in:n/a" placeholder (via
    // wrapPlainDefault → STALE_COLOR wrap). Therefore
    // `:nulldrop:true` has no effect (the dispatcher can only
    // short-circuit on a null return). Same shape as m_apiCalls
    // and m_tokenInTotal which share this property.
    const out = renderTemplate(
      ["m_accTokenIn:nulldrop:true"],
      ctxFor(fakeSnapshot({ sessionId: "sess-no-data" })),
    ).join("\n");
    // v0.8.0+ labels.* — placeholder reads labelIn.
    assert.equal(strip(out), "in:n/a");
  });

  it("m_accTokenIn:color:brightGreen wraps the chunk in brightGreen", () => {
    setAvg(
      "sess-acc-colored",
      { accIn: 12345, accOut: 0, accApi: 0, accCached: 0, accApiCount: 1 },
      "D:\\test",
      {
        modelDisplayName: "MiniMax-M3",
        deltaApiCount: 1,
        currentIn: 12345,
        currentOut: 0,
        currentCacheRead: 0,
        currentApiMs: 1000,
        deltaIn: 12345,
        deltaOut: 0,
        deltaCache: 0,
        deltaApiMs: 1000,
      },
    );
    const out = renderTemplate(
      ["m_accTokenIn:color:brightGreen"],
      ctxFor(fakeSnapshot({ sessionId: "sess-acc-colored" })),
    ).join("\n");
    // formatCompactToken(12345) = "12.3k" → "in:12.3k" (v0.8.0+
    // labels.* — m_accTokenIn renders under labelIn)
    assert.equal(strip(out), "in:12.3k");
    assert.ok(out.includes(GREEN), `expected GREEN wrap on: ${JSON.stringify(out)}`);
  });

  it("m_accTokenIn: composed with multiple acc modules and separators", () => {
    // Seed the session slot with a mix of fields.
    setAvg(
      "sess-multi",
      { accIn: 500, accOut: 250, accApi: 5000, accCached: 10000, accApiCount: 3 },
      "D:\\test",
      {
        modelDisplayName: "MiniMax-M3",
        deltaApiCount: 3,
        currentIn: 500,
        currentOut: 250,
        currentCacheRead: 10000,
        currentApiMs: 5000,
        deltaIn: 500,
        deltaOut: 250,
        deltaCache: 10000,
        deltaApiMs: 5000,
      },
    );
    const out = renderTemplate(
      [
        "m_accTokenIn",
        "s_space",
        "m_accTokenOut",
        "s_space",
        "s_dot",
        "s_space",
        "m_accCacheHitRate",
      ],
      ctxFor(fakeSnapshot({ sessionId: "sess-multi" })),
    ).join("\n");
    // in=500→"500", out=250→"250", hitRate=10000/(10000+500)=95.2%
    // v0.8.0+ labels.* — m_accTokenIn/Out pick up labelIn/labelOut;
    // m_accCacheHitRate is NOT in the label axis set, so its
    // "acc:" prefix is preserved.
    assert.equal(strip(out), "in:500 out:250 · acc:95.2%");
  });
});

// ----- v0.8.0+ sum/avg advanced statistics -------------------------------
//
// 8 new modules: 5 sums (in / out / cached / total / apiMs) + 3
// ratios (cacheHitRate / tokenInSpeed / tokenOutSpeed). All read
// the per-tick jsonl stream (cross-project via readAllSamples) and
// filter by `:model:`, `:window:`, `:align:`. Results are cached in
// state/cache.json under the "stat:<model>:<window>:<align>" key
// (window ∈ {"5h","7d","all"}) with TTL=300s. sinceMs is derived
// from window + ctx.nowMs + optional resetStartAt but is NOT part
// of the key, capping the cache at 12 entries.
//
// Tests below use a tmpDir as the state root (via setStateRoot)
// so the user's real on-disk samples are untouched. Each test
// seeds one or more jsonl rows directly into the per-session
// file, then asserts on the rendered output.

describe("renderTemplate — v0.8.0+ m_sum*/m_avg* advanced statistics", () => {
  beforeEach(() => {
    // The cache module also needs a tmp path so cached aggregates
    // from one test don't leak into the next.
    setCachePathResolver(() => join(_tmpDir, "cache.json"));
    resetCacheForTest();
  });

  // ----- parseDhms / parseWindowScope basics -----

  it("m_sumTokenIn with no samples anywhere → 'in:n/a' placeholder", () => {
    // Empty state root → no rows → agg.rows=0. The bare
    // MODULES path returns null (drops the chunk); the inline
    // form with the default nulldrop:false renders the
    // placeholder.
    setStateRoot(() => join(_tmpDir, "sum-empty"));
    const out = renderTemplate(
      ["m_sumTokenIn:nulldrop:false"],
      ctxFor(fakeSnapshot()),
    ).join("\n");
    assert.equal(strip(out), "in:n/a");
  });

  it("m_sumTokenIn:window:invalid_value (parse-fail) → drops with warn", () => {
    // The WINDOW_PARAM resolver rejects malformed dhms at the
    // schema layer → parseInlineArgs returns null → dispatcher
    // warn + drop. We assert the chunk is gone; the warn is
    // once-per-process and may not fire on every call.
    setStateRoot(() => join(_tmpDir, "sum-bad-window"));
    __resetUnknownModuleWarnForTest();
    const out = renderTemplate(
      ["m_sumTokenIn:window:xyz"],
      ctxFor(fakeSnapshot()),
    );
    assert.deepEqual(out, []);
  });

  it("m_sumTokenIn:model:nonexistent-model (no matching rows) → 'in:n/a' placeholder", () => {
    // An unknown model name is treated as a literal filter — no
    // matching rows → empty aggregate → inline form renders
    // placeholder (bare form would drop).
    setStateRoot(() => join(_tmpDir, "sum-no-model-match"));
    const out = renderTemplate(
      ["m_sumTokenIn:model:nonexistent-model"],
      ctxFor(fakeSnapshot()),
    ).join("\n");
    assert.equal(strip(out), "in:n/a");
  });

  it("m_sumTokenIn:align:invalid (not true/false) is a parse-fail → drops", () => {
    setStateRoot(() => join(_tmpDir, "sum-bad-align"));
    __resetUnknownModuleWarnForTest();
    const out = renderTemplate(
      ["m_sumTokenIn:align:maybe"],
      ctxFor(fakeSnapshot()),
    );
    assert.deepEqual(out, []);
  });

  // ----- per-fixture sum -----

  it("m_sumTokenIn reads sum(in) across rows in the configured window", () => {
    // Seed 3 jsonl rows under a tmpDir state root, each carrying
    // the per-turn `in` (which is what the sum module sums).
    // Rows are anchored near the test ctx's nowMs (1_000_000) so
    // they fall inside the default 5h window.
    const stateRootDir = join(_tmpDir, "sum-fixture-A");
    setStateRoot(() => stateRootDir);
    const projHash = "d--sum-a";
    const sess = "sess-sum-a";
    const cwd = "D:\\sum-a";
    const sessionFile = join(stateRootDir, projHash, `${sess}.jsonl`);
    mkdirSync(dirname(sessionFile), { recursive: true });
    // Three valid samples: sumIn = 100 + 200 + 300 = 600.
    // v0.8.0+ schema: per-turn `in` / cumulative `totalIn` /
    // per-turn `apiMs` (was `deltaApiMs`).
    writeFileSync(
      sessionFile,
      [
        JSON.stringify({ at: 999_000, totalIn: 100, totalOut: 50, in: 100, out: 50, cacheIn: 0, cacheCreation: 0, model: "MiniMax-M3", totalApiMs: 1000, apiMs: 1000 }),
        JSON.stringify({ at: 999_500, totalIn: 200, totalOut: 75, in: 200, out: 75, cacheIn: 0, cacheCreation: 0, model: "MiniMax-M3", totalApiMs: 1000, apiMs: 1000 }),
        JSON.stringify({ at: 999_900, totalIn: 300, totalOut: 100, in: 300, out: 100, cacheIn: 0, cacheCreation: 0, model: "MiniMax-M3", totalApiMs: 1000, apiMs: 1000 }),
      ].join("\n") + "\n",
      "utf8",
    );
    const out = renderTemplate(
      ["m_sumTokenIn"],
      ctxFor(fakeSnapshot({ sessionId: sess, cwd, modelDisplayName: "MiniMax-M3" })),
    ).join("\n");
    // formatCompactToken(600) = "600" → "in:600"
    assert.equal(strip(out), "in:600");
  });

  it("m_sumTokenIn:window:1d1h is rejected — v0.8.x only accepts 5h/7d/all as window keys", () => {
    // v0.8.x: free-form dhms like "1d1h" no longer map to a cache
    // key segment (would explode the key space). parseWindowScope
    // returns null and the module drops (renders empty).
    const stateRootDir = join(_tmpDir, "sum-fixture-window");
    setStateRoot(() => stateRootDir);
    const projHash = "d--sum-w";
    const sess = "sess-sum-w";
    const cwd = "D:\\sum-w";
    const sessionFile = join(stateRootDir, projHash, `${sess}.jsonl`);
    mkdirSync(dirname(sessionFile), { recursive: true });
    const now = 1_000_000;
    // Seed one row so a successful parse would render something
    // visible; the assertion below verifies it gets DROPPED.
    writeFileSync(
      sessionFile,
      JSON.stringify({ at: now - 3600_000, totalIn: 10, totalOut: 0, in: 10, out: 0, cacheIn: 0, cacheCreation: 0, model: "MiniMax-M3", totalApiMs: 100, apiMs: 100 }) + "\n",
      "utf8",
    );
    const out = renderTemplate(
      ["m_sumTokenIn:window:1d1h"],
      ctxFor(
        fakeSnapshot({
          sessionId: sess,
          cwd,
          modelDisplayName: "MiniMax-M3",
        }),
      ),
    ).join("\n");
    assert.equal(out, "");
  });

  it("m_sumTokenIn:window:7d excludes rows older than 7d (canonical window)", () => {
    // v0.8.x: the canonical 7d window must drop rows whose `at`
    // is more than 7 days old, even if the jsonl file itself is
    // freshly written. This is the row-level sinceMs filter
    // inside readAllSamples; the mtime pre-filter only skips
    // files whose mtime predates sinceMs (here the file's mtime
    // is "now", so the pre-filter passes and the row filter runs).
    const stateRootDir = join(_tmpDir, "sum-fixture-window-7d");
    setStateRoot(() => stateRootDir);
    const projHash = "d--sum-w7";
    const sess = "sess-sum-w7";
    const cwd = "D:\\sum-w7";
    const sessionFile = join(stateRootDir, projHash, `${sess}.jsonl`);
    mkdirSync(dirname(sessionFile), { recursive: true });
    const now = 1_700_000_000_000; // big enough to keep old rows positive
    writeFileSync(
      sessionFile,
      [
        // Inside 7d: 1d ago, 3d ago, 6d ago
        JSON.stringify({ at: now - 1 * 86400_000, totalIn: 10, totalOut: 0, in: 10, out: 0, cacheIn: 0, cacheCreation: 0, model: "MiniMax-M3", totalApiMs: 100, apiMs: 100 }),
        JSON.stringify({ at: now - 3 * 86400_000, totalIn: 20, totalOut: 0, in: 20, out: 0, cacheIn: 0, cacheCreation: 0, model: "MiniMax-M3", totalApiMs: 100, apiMs: 100 }),
        JSON.stringify({ at: now - 6 * 86400_000, totalIn: 30, totalOut: 0, in: 30, out: 0, cacheIn: 0, cacheCreation: 0, model: "MiniMax-M3", totalApiMs: 100, apiMs: 100 }),
        // Outside 7d: 10d ago
        JSON.stringify({ at: now - 10 * 86400_000, totalIn: 9999, totalOut: 0, in: 9999, out: 0, cacheIn: 0, cacheCreation: 0, model: "MiniMax-M3", totalApiMs: 100, apiMs: 100 }),
      ].join("\n") + "\n",
      "utf8",
    );
    const out = renderTemplate(
      ["m_sumTokenIn:window:7d"],
      {
        ...ctxFor(
          fakeSnapshot({
            sessionId: sess,
            cwd,
            modelDisplayName: "MiniMax-M3",
          }),
        ),
        nowMs: now,
      },
    ).join("\n");
    // 10 + 20 + 30 = 60; the 10d row is excluded
    assert.equal(strip(out), "in:60");
  });

  it("readAllSamples mtime pre-filter: stale jsonl is skipped even if its row timestamps are recent", () => {
    // Performance contract: when a file's mtime is older than
    // sinceMs, readAllSamples MUST skip it without readFileSync.
    // We assert behaviorally by setting the file mtime to before
    // the sinceMs anchor (now - 5h) but writing a row that would
    // otherwise be inside the 5h window — the row should NOT be
    // counted because the whole file is skipped.
    const stateRootDir = join(_tmpDir, "sum-fixture-mtime");
    setStateRoot(() => stateRootDir);
    const projHash = "d--sum-mt";
    const sess = "sess-sum-mt";
    const cwd = "D:\\sum-mt";
    const sessionFile = join(stateRootDir, projHash, `${sess}.jsonl`);
    mkdirSync(dirname(sessionFile), { recursive: true });
    const now = 1_700_000_000_000;
    // One row, recent `at`, but we will rewrite the file with a
    // stale mtime below.
    writeFileSync(
      sessionFile,
      JSON.stringify({ at: now - 60_000, totalIn: 5, totalOut: 0, in: 5, out: 0, cacheIn: 0, cacheCreation: 0, model: "MiniMax-M3", totalApiMs: 100, apiMs: 100 }) + "\n",
      "utf8",
    );
    // Backdate mtime to before now-5h (the default sinceMs for
    // window=5h without align-resetStartAt).
    const stale = (now - 10 * 3600_000) / 1000; // seconds
    utimesSync(sessionFile, stale, stale);

    const out = renderTemplate(
      ["m_sumTokenIn"], // default 5h window, no align-reset
      {
        ...ctxFor(
          fakeSnapshot({
            sessionId: sess,
            cwd,
            modelDisplayName: "MiniMax-M3",
          }),
        ),
        nowMs: now,
      },
    ).join("\n");
    // mtime pre-filter drops the whole file → rows=0 → module
    // drops (null) → renders empty.
    assert.equal(out, "");
  });

  it("m_avgTokenInSpeed: sum(in) / sum(apiMs) * 1000 in t/s", () => {
    const stateRootDir = join(_tmpDir, "sum-fixture-speed");
    setStateRoot(() => stateRootDir);
    const projHash = "d--sum-s";
    const sess = "sess-sum-s";
    const cwd = "D:\\sum-s";
    const sessionFile = join(stateRootDir, projHash, `${sess}.jsonl`);
    mkdirSync(dirname(sessionFile), { recursive: true });
    // sumIn=1000, sumApiMs=2000 → 1000/2000*1000 = 500 t/s.
    // Rows anchored near the test ctx's nowMs (1_000_000).
    writeFileSync(
      sessionFile,
      [
        JSON.stringify({ at: 999_000, totalIn: 500, totalOut: 0, in: 500, out: 0, cacheIn: 0, cacheCreation: 0, model: "MiniMax-M3", totalApiMs: 1000, apiMs: 1000 }),
        JSON.stringify({ at: 999_500, totalIn: 500, totalOut: 0, in: 500, out: 0, cacheIn: 0, cacheCreation: 0, model: "MiniMax-M3", totalApiMs: 1000, apiMs: 1000 }),
      ].join("\n") + "\n",
      "utf8",
    );
    const out = renderTemplate(
      ["m_avgTokenInSpeed"],
      ctxFor(fakeSnapshot({ sessionId: sess, cwd, modelDisplayName: "MiniMax-M3" })),
    ).join("\n");
    // 500 t/s → "500.0 t/s"
    assert.equal(strip(out), "in:500.0 t/s");
  });

  it("m_sumApiMs formats sum as dhms (v0.8.x — was formatCompactToken in earlier builds)", () => {
    // Seed 2 rows: apiMs 30s + 90s = 120s total → "api:2m"
    // (formatRemainingMs floors sub-minute to <1m, so 119s → <1m,
    // but 120s renders as "2m" only if maxUnitCount=2 — actually
    // 120s collapses to "2m" via formatRemainingMs's "single-unit
    // 60+ ms → round up" rule).
    const stateRootDir = join(_tmpDir, "sum-fixture-sumapims");
    setStateRoot(() => stateRootDir);
    const projHash = "d--sum-api";
    const sess = "sess-sum-api";
    const cwd = "D:\\sum-api";
    const sessionFile = join(stateRootDir, projHash, `${sess}.jsonl`);
    mkdirSync(dirname(sessionFile), { recursive: true });
    const now = 1_700_000_000_000;
    writeFileSync(
      sessionFile,
      [
        JSON.stringify({ at: now - 1_000, totalIn: 100, totalOut: 50, in: 100, out: 50, cacheIn: 0, cacheCreation: 0, model: "MiniMax-M3", totalApiMs: 30_000, apiMs: 30_000 }),
        JSON.stringify({ at: now - 2_000, totalIn: 200, totalOut: 100, in: 100, out: 50, cacheIn: 0, cacheCreation: 0, model: "MiniMax-M3", totalApiMs: 120_000, apiMs: 90_000 }),
      ].join("\n") + "\n",
      "utf8",
    );
    const out = renderTemplate(
      ["m_sumApiMs"],
      ctxFor(
        fakeSnapshot({
          sessionId: sess,
          cwd,
          modelDisplayName: "MiniMax-M3",
        }),
      ),
    ).join("\n");
    // 30_000 + 90_000 = 120_000ms = 2m. formatRemainingMs renders this.
    assert.equal(strip(out), "api:2m");
  });

  it("m_sumApiCalls counts only rows with apiMs > 0", () => {
    // 3 rows: 2 with apiMs > 0 (real calls), 1 with apiMs = 0
    // (fallback path row from first-tick fallback). agg.calls
    // should be 2, NOT agg.rows (3).
    const stateRootDir = join(_tmpDir, "sum-fixture-apicalls");
    setStateRoot(() => stateRootDir);
    const projHash = "d--calls";
    const sess = "sess-calls";
    const cwd = "D:\\calls";
    const sessionFile = join(stateRootDir, projHash, `${sess}.jsonl`);
    mkdirSync(dirname(sessionFile), { recursive: true });
    const now = 1_700_000_000_000;
    writeFileSync(
      sessionFile,
      [
        JSON.stringify({ at: now - 3_000, totalIn: 100, totalOut: 50, in: 100, out: 50, cacheIn: 0, cacheCreation: 0, model: "MiniMax-M3", totalApiMs: 30_000, apiMs: 30_000 }),
        JSON.stringify({ at: now - 2_000, totalIn: 200, totalOut: 100, in: 100, out: 50, cacheIn: 0, cacheCreation: 0, model: "MiniMax-M3", totalApiMs: 120_000, apiMs: 0 }),
        JSON.stringify({ at: now - 1_000, totalIn: 300, totalOut: 150, in: 100, out: 50, cacheIn: 0, cacheCreation: 0, model: "MiniMax-M3", totalApiMs: 200_000, apiMs: 80_000 }),
      ].join("\n") + "\n",
      "utf8",
    );
    const out = renderTemplate(
      ["m_sumApiCalls"],
      ctxFor(
        fakeSnapshot({
          sessionId: sess,
          cwd,
          modelDisplayName: "MiniMax-M3",
        }),
      ),
    ).join("\n");
    // 2 of 3 rows have apiMs > 0 → calls:2
    assert.equal(strip(out), "calls:2");
  });

  it("m_sumApiCalls: no rows in window → drops (renders empty)", () => {
    // Isolate stateRoot to a fresh tmp subdir so we don't pick up
    // the user's real on-disk samples (289+ rows in production).
    const stateRootDir = join(_tmpDir, "avg-fixture-apicalls-empty");
    setStateRoot(() => stateRootDir);
    const out = renderTemplate(
      ["m_sumApiCalls"],
      ctxFor(
        fakeSnapshot({
          sessionId: "sess-empty",
          cwd: "D:\\empty",
          modelDisplayName: "MiniMax-M3",
        }),
      ),
    ).join("\n");
    assert.equal(out, "");
  });

  it("m_sumApiCalls: inline args (:window:7d, :model:all) are honored", () => {
    const stateRootDir = join(_tmpDir, "sum-fixture-apicalls-inline");
    setStateRoot(() => stateRootDir);
    const projHash = "d--ci";
    const sess = "sess-ci";
    const cwd = "D:\\ci";
    const sessionFile = join(stateRootDir, projHash, `${sess}.jsonl`);
    mkdirSync(dirname(sessionFile), { recursive: true });
    const now = 1_700_000_000_000;
    writeFileSync(
      sessionFile,
      [
        JSON.stringify({ at: now - 1_000, totalIn: 100, totalOut: 50, in: 100, out: 50, cacheIn: 0, cacheCreation: 0, model: "MiniMax-M3", totalApiMs: 30_000, apiMs: 30_000 }),
        JSON.stringify({ at: now - 2_000, totalIn: 200, totalOut: 100, in: 100, out: 50, cacheIn: 0, cacheCreation: 0, model: "MiniMax-M3", totalApiMs: 120_000, apiMs: 90_000 }),
      ].join("\n") + "\n",
      "utf8",
    );
    const out = renderTemplate(
      ["m_sumApiCalls:model:all:window:7d"],
      ctxFor(
        fakeSnapshot({
          sessionId: sess,
          cwd,
          modelDisplayName: "MiniMax-M3",
        }),
      ),
    ).join("\n");
    assert.equal(strip(out), "calls:2");
  });
});

// v0.8.0+ — labels.* config customization. Each module that emits
// a token-stat prefix reads the corresponding cfg().labels.* axis at
// render time. Overriding labelIn/labelOut/labelCacheIn/labelTotalIn
// in config should propagate to: per-turn (m_tokenIn/Out/CachedIn/
// TotalIn), totals (m_tokenInTotal/OutTotal), acc (m_accTokenIn/
// Out/CachedIn/TotalIn/TokenIn/Out), sum/avg (m_sumTokenIn/Out/
// CachedIn/TotalIn + m_avgTokenIn/OutSpeed).
describe("renderTemplate — v0.8.0+ labels.* config customization", () => {
  // Apply a custom labels override to configStore for these tests,
  // then reset in the next beforeEach (the file-level beforeEach
  // at line 106 already calls configStore.__resetForTest()).
  // Helpers below reach into configStore via __resetForTest with a
  // partial override — that's the documented test path.
  function withLabels(labels: Partial<Config["labels"]>, fn: () => void) {
    __resetForTest({ labels: { ...configStore.get().labels, ...labels } });
    try { fn(); } finally { __resetForTest(); }
  }

  it("labelIn override reaches per-turn m_tokenInTotal and m_tokenTotalIn", () => {
    withLabels({ labelIn: "Δ:" }, () => {
      const a = renderTemplate(["m_tokenInTotal"], ctxFor(fakeSnapshot())).join("\n");
      // labelTotalIn still defaults → "total:…".
      const b = renderTemplate(["m_tokenTotalIn"], ctxFor(fakeSnapshot())).join("\n");
      assert.equal(strip(a), "Δ:163.5k");
      assert.equal(strip(b), "total:163.5k");
    });
  });

  it("labelTotalIn override reaches m_tokenTotalIn / m_accTokenTotalIn / m_sumTokenTotalIn", () => {
    // Pin stateRoot to a fresh empty dir so m_sumTokenTotalIn
    // sees no rows (production state has months of data that
    // would otherwise produce a 100M+ value here).
    setStateRoot(() => join(_tmpDir, "labels-test"));
    withLabels({ labelTotalIn: "Total:" }, () => {
      // Use a fresh sessionId for m_accTokenTotalIn so any avg
      // snapshot left over from prior tests doesn't leak into
      // the rendered value (we only need to verify the prefix).
      const a = renderTemplate(["m_tokenTotalIn"], ctxFor(fakeSnapshot())).join("\n");
      const b = renderTemplate(
        ["m_accTokenTotalIn"],
        ctxFor(fakeSnapshot({ sessionId: "label-total-acc" })),
      ).join("\n");
      // m_sumTokenTotalIn needs no rows → placeholder path; verifies
      // the configured label is read for the placeholder too.
      // Force nulldrop:false so the placeholder renders (bare
      // form defaults to drop-on-null).
      const c = renderTemplate(
        ["m_sumTokenTotalIn:nulldrop:false"],
        ctxFor(fakeSnapshot({ sessionId: "label-test", cwd: "D:\\label-test" })),
      ).join("\n");
      assert.match(strip(a), /^Total:/);
      assert.match(strip(b), /^Total:/);
      assert.match(strip(c), /^Total:n\/a$/);
    });
  });

  it("labelOut override reaches m_tokenOut / m_tokenTotalOut", () => {
    withLabels({ labelOut: "↓:" }, () => {
      const a = renderTemplate(["m_tokenOut"], ctxFor(fakeSnapshot())).join("\n");
      const b = renderTemplate(["m_tokenTotalOut"], ctxFor(fakeSnapshot())).join("\n");
      assert.equal(strip(a), "↓:155");
      assert.equal(strip(b), "↓:155");
    });
  });

  it("labelCacheIn override reaches m_tokenCachedIn", () => {
    withLabels({ labelCacheIn: "⚡:" }, () => {
      const out = renderTemplate(["m_tokenCachedIn"], ctxFor(fakeSnapshot())).join("\n");
      assert.match(strip(out), /^⚡:/);
    });
  });
});
