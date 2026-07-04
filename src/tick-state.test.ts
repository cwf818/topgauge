// v1.0 — tests for the data-processor / tick-state pipeline.
// Data-processing (src/data-processor.ts:processTick) owns all
// writes to pending; tick-state.ts (src/tick-state.ts) is the
// in-memory Store backing those writes plus the on-disk commit.
// Each test isolates to a tmp status.json via setStatusPathResolver
// + __resetForTest, mirroring the harness used by render-tokens.test.ts.

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import * as statusStore from "./status-store.ts";
import type { TokenSnapshot } from "./types.ts";

// Minimal valid TokenSnapshot for the validation-gate tests.
// totalIn > 0 AND totalOut > 0 AND totalApiDurationMs > 0 ⇒ valid.
const validTokens = (overrides: Partial<TokenSnapshot> = {}): TokenSnapshot => ({
  sessionId: "sess-test",
  cwd: "D:\\test",
  totals: { tokenTotalIn: 100, tokenTotalOut: 50 },
  current: { tokenIn: 100, tokenOut: 50, tokenCacheCreation: 0, tokenCachedIn: 0 },
  cost: { totalDurationMs: 1000, totalApiDurationMs: 1000, totalLinesAdded: 0, totalLinesRemoved: 0 },
  ...overrides,
});

let _tmpDir: string;
let _prevConfigDir: string | undefined;

beforeEach(() => {
  _tmpDir = mkdtempSync(join(tmpdir(), "topgauge-cc-tick-state-"));
  _prevConfigDir = process.env.CLAUDE_CONFIG_DIR;
  process.env.CLAUDE_CONFIG_DIR = _tmpDir;
  statusStore.setStatusPathResolver(() => join(_tmpDir, "status.json"));
  statusStore.__resetForTest();
  statusStore.resetTickStateForTest();
});

afterEach(() => {
  if (_prevConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR;
  else process.env.CLAUDE_CONFIG_DIR = _prevConfigDir;
  statusStore.resetStatusPathResolver();
  statusStore.__resetForTest();
  statusStore.resetTickStateForTest();
});

describe("data-processor — pipeline basics", () => {
  it("beginTick + getState returns the seeded TickState", () => {
    const s = statusStore.beginTick("D:\\test", validTokens());
    assert.equal(s.cwd, "D:\\test");
    assert.ok(s.tokens);
    assert.equal(s.valid, true, "valid totals + totalApiMs → valid=true");
    assert.equal(s.dirty, false);
  });

  it("mark() flips dirty + populates pending; commit() flushes", () => {
    statusStore.beginTick("D:\\test", validTokens());
    statusStore.mark("tickStatus:sess-test", statusStore.emptyTickStatus());
    assert.equal(statusStore.getState().dirty, true);
    statusStore.commit();
    assert.ok(existsSync(join(_tmpDir, "status.json")), "status.json written");
    const raw = readFileSync(join(_tmpDir, "status.json"), "utf8");
    const store = JSON.parse(raw) as Record<string, unknown>;
    assert.ok("tickStatus:sess-test" in store, "key persisted");
  });

  it("commit() is a no-op when dirty=false (pristine tick)", () => {
    statusStore.beginTick("D:\\test", validTokens());
    statusStore.commit();
    assert.equal(existsSync(join(_tmpDir, "status.json")), false, "no file written");
  });
});

describe("data-processor — validation gate", () => {
  it("totalIn=0 → invalid (sample skipped, but staged mark flushes through commit)", () => {
    // v0.8.10-alpha.2 snapshot contract: commit() no longer
    // gates on `valid`. Staged marks (regression-reset, prev
    // baseline update) flush even when the validation gate
    // rejects the tick. Sample append (the JSONL row) is the
    // *only* thing skipped on invalid ticks.
    statusStore.beginTick("D:\\test", validTokens({
      totals: { tokenTotalIn: 0, tokenTotalOut: 50 },
    }));
    assert.equal(statusStore.getState().valid, false);
    statusStore.mark("tickStatus:sess-test", statusStore.emptyTickStatus());
    statusStore.commit();
    assert.equal(existsSync(join(_tmpDir, "status.json")), true,
      "v0.8.10-alpha.2 — invalid tick still flushes staged marks through commit");
  });

  it("totalOut=0 → invalid", () => {
    statusStore.beginTick("D:\\test", validTokens({
      totals: { tokenTotalIn: 100, tokenTotalOut: 0 },
    }));
    assert.equal(statusStore.getState().valid, false);
  });

  it("totalApiDurationMs=0 on first tick → apiMs back-derives from tokenOut → valid (v0.8.10-alpha.2 contract)", () => {
    // v0.8.10-alpha.2 (per user refinement 2026-07-04): when
    // there is no previous tick and totalApiDurationMs=0,
    // apiMs is back-derived via tokenOut * 1000 / 50 (the
    // v0.4.x legacy fallback). For default totalOut=50 that
    // yields apiMs=1000 > 0, so the tick IS valid.
    statusStore.beginTick("D:\\test", validTokens({
      cost: { totalDurationMs: 1000, totalApiDurationMs: 0, totalLinesAdded: 0, totalLinesRemoved: 0 },
    }));
    assert.equal(statusStore.getState().valid, true);
  });

  it("prev exists + deltaApiMs <= 0 → invalid (regression guard)", () => {
    // Seed a prev tick with totalApiMs=1000 first.
    statusStore.beginTick("D:\\test", validTokens({
      cost: { totalDurationMs: 1000, totalApiDurationMs: 1000, totalLinesAdded: 0, totalLinesRemoved: 0 },
    }));
    statusStore.mark(statusStore.PREV_TICK_KEY, {
      ...statusStore.emptyPrevTickStatus(),
      totalApiMs: 1000,
      sessionId: "sess-test",
      cwd: "D:\\test",
      model: null,
    });
    statusStore.commit();

    // Now tick with totalApiMs < prev.totalApiMs (regression).
    statusStore.resetTickStateForTest();
    statusStore.beginTick("D:\\test", validTokens({
      cost: { totalDurationMs: 1000, totalApiDurationMs: 500, totalLinesAdded: 0, totalLinesRemoved: 0 },
    }));
    assert.equal(statusStore.getState().valid, false, "deltaApiMs < 0 → invalid");
  });

  it("null tokens → invalid (parse failure path)", () => {
    statusStore.beginTick("D:\\test", null);
    assert.equal(statusStore.getState().valid, false);
  });

  it("null cwd → valid (commit gates on cwd, not validation)", () => {
    // The validation gate runs on tokens only — cwd=null is
    // commit's concern (commit skips when cwd=null). Validating
    // with valid tokens + null cwd returns valid=true so the
    // in-memory pending map is still consumable by tests.
    statusStore.beginTick(null, validTokens());
    assert.equal(statusStore.getState().valid, true);
    statusStore.mark("tickStatus:sess-test", statusStore.emptyTickStatus());
    statusStore.commit(); // cwd=null → no disk write
    assert.equal(existsSync(join(_tmpDir, "status.json")), false);
  });
});

describe("data-processor — one-write-per-active-tick", () => {
  it("5 mark() calls + commit → 1 disk write of the merged store", () => {
    statusStore.beginTick("D:\\test", validTokens());
    statusStore.mark("tickStatus:sess-test", statusStore.emptyTickStatus());
    statusStore.mark(statusStore.CCSESSION_KEY, statusStore.emptyTickStatus());
    statusStore.mark("lastActive:in", { direction: "in", tps: 12.5 });
    statusStore.mark("lastActive:out", { direction: "out", tps: 8.3 });
    statusStore.mark(statusStore.PREV_TICK_KEY, statusStore.emptyPrevTickStatus());
    statusStore.commit();

    // The on-disk file should be a single JSON object with all 5 keys.
    const raw = readFileSync(join(_tmpDir, "status.json"), "utf8");
    const store = JSON.parse(raw) as Record<string, unknown>;
    assert.equal(
      Object.keys(store).length, 5,
      "exactly 5 entries persisted in one write",
    );
  });
});

describe("data-processor — crash-before-flush", () => {
  it("mark + resetTickStateForTest (no commit) → disk unchanged", () => {
    statusStore.beginTick("D:\\test", validTokens());
    statusStore.mark("tickStatus:sess-test", statusStore.emptyTickStatus());
    // Simulate a crash: clear state without commit.
    statusStore.resetTickStateForTest();
    assert.equal(
      existsSync(join(_tmpDir, "status.json")), false,
      "no file written — write is deferred to commit",
    );
  });
});

describe("data-processor — regression-reset + commit interplay", () => {
  // v1.0 — accPrimer's "immediate statusStore.writeTickStatus"
  // bypass is GONE. The regression-reset is now a regular
  // statusStore.mark(CCSESSION_KEY, emptyTickStatus()) that the
  // data-processor (processTick Stage 1) fires BEFORE the same
  // tick's setAvg (Stage 4). Both flush through a SINGLE commit.
  // Last-mark-wins means setAvg's later mark can either replace
  // the empty reset (delta accumulated) OR be skipped (tick with
  // no delta → reset stays empty). Pin both shapes here.
  it("ccsession reset mark + setAgg accumulation → last-mark-wins at commit", () => {
    // First tick: seed prev with apiMs=0.
    statusStore.beginTick("D:\\test", validTokens());
    statusStore.mark(statusStore.PREV_TICK_KEY, statusStore.emptyPrevTickStatus());
    statusStore.commit();

    // Second tick: regression-reset mark first (empty ccsession),
    // then setAgg-style mark lands with accTokenIn=1000. processTick
    // does exactly this order.
    statusStore.resetTickStateForTest();
    statusStore.beginTick("D:\\test", validTokens());
    statusStore.mark(statusStore.CCSESSION_KEY, statusStore.emptyTickStatus());
    statusStore.mark(statusStore.CCSESSION_KEY, {
      ...statusStore.emptyTickStatus(),
      accTokenIn: 1000,
    });
    statusStore.commit();

    const raw = readFileSync(join(_tmpDir, "status.json"), "utf8");
    const store = JSON.parse(raw) as Record<string, { kind: string; value: { accTokenIn: number } }>;
    // setAgg's later mark wins (last-mark-wins via the flat Map).
    assert.equal(store[statusStore.CCSESSION_KEY]?.value.accTokenIn, 1000);
  });

  it("ccsession reset mark with NO subsequent delta → reset persists empty", () => {
    // Regression-reset fires, but a same-tick hasDelta=false (e.g.
    // current totals == prev totals) means setAgg never lands.
    // The reset entry should be the on-disk truth.
    statusStore.beginTick("D:\\test", validTokens());
    statusStore.mark(statusStore.PREV_TICK_KEY, statusStore.emptyPrevTickStatus());
    statusStore.commit();

    statusStore.resetTickStateForTest();
    statusStore.beginTick("D:\\test", validTokens());
    statusStore.mark(statusStore.CCSESSION_KEY, statusStore.emptyTickStatus());
    // NO setAgg mark follows — simulating hasDelta=false.
    statusStore.commit();

    const raw = readFileSync(join(_tmpDir, "status.json"), "utf8");
    const store = JSON.parse(raw) as Record<string, { kind: string; value: { accTokenIn: number; accTokenOut: number } }>;
    const v = store[statusStore.CCSESSION_KEY]?.value;
    assert.equal(v.accTokenIn, 0);
    assert.equal(v.accTokenOut, 0);
  });
});

describe("data-processor — concurrent-overlay commit (m_template nesting)", () => {
  // m_template creates inner render contexts; mark() calls from
  // the inner overlay must NOT cause the outer mark to lose its
  // value at commit time. The contract: pending is a flat Map;
  // the LAST mark() before commit wins per key (inner sees its
  // own overlay, outer replaces when its own mark lands).
  it("inner mark overlays, outer mark replaces — outer's value wins", () => {
    statusStore.beginTick("D:\\test", validTokens());
    statusStore.mark("tickStatus:sess-test", { ...statusStore.emptyTickStatus(), accTokenIn: 100 });
    statusStore.mark("tickStatus:sess-test", { ...statusStore.emptyTickStatus(), accTokenIn: 200 });
    statusStore.commit();
    const raw = readFileSync(join(_tmpDir, "status.json"), "utf8");
    const store = JSON.parse(raw) as Record<string, { value: { accTokenIn: number } }>;
    assert.equal(store["tickStatus:sess-test"]?.value.accTokenIn, 200, "outer wins");
  });
});

describe("data-processor — getState throws without beginTick", () => {
  it("getState() with no prior beginTick throws a clear error", () => {
    assert.throws(() => statusStore.getState(), /without beginTick\(\)/);
  });
});