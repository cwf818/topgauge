import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { resolveApiMsSample } from "./api-ms.ts";

describe("resolveApiMsSample — first-tick fallback", () => {
  it("prev=null + tokens advanced: FALLBACK regardless of totalApiMs", () => {
    // v0.8.x revision — even when totalApiMs is large (session-
    // cumulative from a long-lived session), prev=null means we
    // have no trustworthy baseline. Writing apiMs = totalApiMs
    // would inflate this tick's contribution by the entire session
    // history. Fallback to ceil(out/50)*1000 instead.
    const d = resolveApiMsSample({
      at: 1000,
      totalIn: 100,
      totalOut: 50,
      current: { input: 100, output: 50, cacheRead: 0, cacheCreation: 0 },
      totalApiMs: 60_000,
      prev: null,
    });
    assert.equal(d.kind, "write");
    if (d.kind === "write") {
      assert.equal(d.sample.apiMs, 1000); // ceil(50/50)*1000
      assert.equal(d.sample.at, 1000);
      assert.equal(d.sample.prevApiMs, null);
    }
  });

  it("prev=null + huge totalApiMs (long-running session) still falls back", () => {
    // Mirrors the live case where the user wiped cache.json and
    // the first tick reports totalApiMs=10M (a session that's been
    // running 3 hours). Fallback must still apply.
    const d = resolveApiMsSample({
      at: 1783056713633,
      totalIn: 146036,
      totalOut: 639,
      current: { input: 116, output: 639, cacheRead: 145920, cacheCreation: 0 },
      totalApiMs: 10_521_994,
      prev: null,
    });
    assert.equal(d.kind, "write");
    if (d.kind === "write") {
      // ceil(639/50)*1000 = 13*1000 = 13000
      assert.equal(d.sample.apiMs, 13_000);
      assert.equal(d.sample.prevApiMs, null);
      assert.equal(d.sample.totalApiMs, 10_521_994); // totalApiMs preserved
    }
  });

  it("deltaApiMs > 0 with prev: writes apiMs = current - prev", () => {
    const d = resolveApiMsSample({
      at: 2000,
      totalIn: 200,
      totalOut: 100,
      current: { input: 100, output: 50, cacheRead: 0, cacheCreation: 0 },
      totalApiMs: 90_000,
      prev: { apiMs: 30_000 },
    });
    assert.equal(d.kind, "write");
    if (d.kind === "write") {
      assert.equal(d.sample.apiMs, 60_000); // 90_000 - 30_000
      // v0.8.x — real prev baseline carried into the row.
      assert.equal(d.sample.prevApiMs, 30_000);
    }
  });

  it("deltaApiMs > 0 with prev=0 baseline: stamps prevApiMs=0 (not null)", () => {
    const d = resolveApiMsSample({
      at: 2000,
      totalIn: 100,
      totalOut: 50,
      current: { input: 100, output: 50, cacheRead: 0, cacheCreation: 0 },
      totalApiMs: 60_000,
      prev: { apiMs: 0 },
    });
    assert.equal(d.kind, "write");
    if (d.kind === "write") {
      assert.equal(d.sample.apiMs, 60_000);
      // Distinguish "prev was actually 0" from "prev was missing".
      assert.equal(d.sample.prevApiMs, 0);
    }
  });

  it("prev=null + totalIn=0 + totalOut=0: skip (no activity to record)", () => {
    const d = resolveApiMsSample({
      at: 1000,
      totalIn: 0,
      totalOut: 0,
      current: { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 },
      totalApiMs: 0,
      prev: null,
    });
    assert.equal(d.kind, "skip");
  });

  it("prev=null + out=150: fallback gives ceil(150/50)*1000 = 3000ms", () => {
    const d = resolveApiMsSample({
      at: 1000,
      totalIn: 100,
      totalOut: 150,
      current: { input: 100, output: 150, cacheRead: 0, cacheCreation: 0 },
      totalApiMs: 0,
      prev: null,
    });
    assert.equal(d.kind, "write");
    if (d.kind === "write") {
      assert.equal(d.sample.apiMs, 3000);
    }
  });

  it("fallback rounds up: out=51 → 2000ms (ceil(51/50)=2)", () => {
    const d = resolveApiMsSample({
      at: 1000,
      totalIn: 100,
      totalOut: 51,
      current: { input: 50, output: 51, cacheRead: 0, cacheCreation: 0 },
      totalApiMs: 0,
      prev: null,
    });
    assert.equal(d.kind, "write");
    if (d.kind === "write") {
      assert.equal(d.sample.apiMs, 2000);
      assert.equal(d.sample.prevApiMs, null);
    }
  });

  it("fallback: out=1 → 1000ms (ceil(1/50)=1)", () => {
    const d = resolveApiMsSample({
      at: 1000,
      totalIn: 100,
      totalOut: 1,
      current: { input: 99, output: 1, cacheRead: 0, cacheCreation: 0 },
      totalApiMs: 0,
      prev: null,
    });
    assert.equal(d.kind, "write");
    if (d.kind === "write") {
      assert.equal(d.sample.apiMs, 1000);
    }
  });
});

describe("resolveApiMsSample — stuck-cost anomaly", () => {
  it("deltaApiMs == 0 + prev!=null + all token fields 0 → skip silently", () => {
    const d = resolveApiMsSample({
      at: 2000,
      totalIn: 100,
      totalOut: 50,
      current: { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 },
      totalApiMs: 60_000,
      prev: { apiMs: 60_000 },
    });
    assert.equal(d.kind, "skip");
  });

  it("deltaApiMs == 0 + prev!=null + input>0 → warn (no row written)", () => {
    const d = resolveApiMsSample({
      at: 2000,
      totalIn: 150,
      totalOut: 50,
      current: { input: 50, output: 0, cacheRead: 0, cacheCreation: 0 },
      totalApiMs: 60_000,
      prev: { apiMs: 60_000 },
    });
    assert.equal(d.kind, "warn");
    if (d.kind === "warn") {
      assert.match(d.message, /deltaApiMs=0 with token activity/);
      assert.match(d.message, /totalIn=150/);
      assert.match(d.message, /in=50/);
    }
  });

  it("deltaApiMs == 0 + prev!=null + output>0 → warn", () => {
    const d = resolveApiMsSample({
      at: 2000,
      totalIn: 100,
      totalOut: 70,
      current: { input: 0, output: 20, cacheRead: 0, cacheCreation: 0 },
      totalApiMs: 60_000,
      prev: { apiMs: 60_000 },
    });
    assert.equal(d.kind, "warn");
  });

  it("deltaApiMs == 0 + prev!=null + cacheRead>0 → warn", () => {
    const d = resolveApiMsSample({
      at: 2000,
      totalIn: 200,
      totalOut: 100,
      current: { input: 0, output: 0, cacheRead: 100, cacheCreation: 0 },
      totalApiMs: 60_000,
      prev: { apiMs: 60_000 },
    });
    assert.equal(d.kind, "warn");
  });

  it("deltaApiMs == 0 + prev!=null + cacheCreation>0 → warn", () => {
    const d = resolveApiMsSample({
      at: 2000,
      totalIn: 200,
      totalOut: 100,
      current: { input: 0, output: 0, cacheRead: 0, cacheCreation: 50 },
      totalApiMs: 60_000,
      prev: { apiMs: 60_000 },
    });
    assert.equal(d.kind, "warn");
  });

  it("deltaApiMs < 0: skip silently (clock skew / upstream bug)", () => {
    const d = resolveApiMsSample({
      at: 2000,
      totalIn: 100,
      totalOut: 50,
      current: { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 },
      totalApiMs: 30_000,
      prev: { apiMs: 60_000 },
    });
    assert.equal(d.kind, "skip");
  });
});