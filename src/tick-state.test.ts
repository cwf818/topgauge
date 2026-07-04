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

import * as tickState from "./tick-state.ts";
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
  tickState.resetTickStateForTest();
});

afterEach(() => {
  if (_prevConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR;
  else process.env.CLAUDE_CONFIG_DIR = _prevConfigDir;
  statusStore.resetStatusPathResolver();
  statusStore.__resetForTest();
  tickState.resetTickStateForTest();
});

describe("data-processor — pipeline basics", () => {
  it("beginTick + getState returns the seeded TickState", () => {
    const s = tickState.beginTick("D:\\test", validTokens());
    assert.equal(s.cwd, "D:\\test");
    assert.ok(s.tokens);
    assert.equal(s.valid, true, "valid totals + totalApiMs → valid=true");
    assert.equal(s.dirty, false);
  });

  it("mark() flips dirty + populates pending; commit() flushes", () => {
    tickState.beginTick("D:\\test", validTokens());
    tickState.mark("tickStatus:sess-test", statusStore.emptyTickStatus());
    assert.equal(tickState.getState().dirty, true);
    tickState.commit();
    assert.ok(existsSync(join(_tmpDir, "status.json")), "status.json written");
    const raw = readFileSync(join(_tmpDir, "status.json"), "utf8");
    const store = JSON.parse(raw) as Record<string, unknown>;
    assert.ok("tickStatus:sess-test" in store, "key persisted");
  });

  it("commit() is a no-op when dirty=false (pristine tick)", () => {
    tickState.beginTick("D:\\test", validTokens());
    tickState.commit();
    assert.equal(existsSync(join(_tmpDir, "status.json")), false, "no file written");
  });
});

describe("data-processor — validation gate", () => {
  it("totalIn=0 → invalid (commit is no-op even after mark)", () => {
    tickState.beginTick("D:\\test", validTokens({
      totals: { tokenTotalIn: 0, tokenTotalOut: 50 },
    }));
    assert.equal(tickState.getState().valid, false);
    tickState.mark("tickStatus:sess-test", statusStore.emptyTickStatus());
    tickState.commit();
    assert.equal(existsSync(join(_tmpDir, "status.json")), false);
  });

  it("totalOut=0 → invalid", () => {
    tickState.beginTick("D:\\test", validTokens({
      totals: { tokenTotalIn: 100, tokenTotalOut: 0 },
    }));
    assert.equal(tickState.getState().valid, false);
  });

  it("totalApiDurationMs=0 → invalid (first-tick baseline rule)", () => {
    tickState.beginTick("D:\\test", validTokens({
      cost: { totalDurationMs: 1000, totalApiDurationMs: 0, totalLinesAdded: 0, totalLinesRemoved: 0 },
    }));
    assert.equal(tickState.getState().valid, false);
  });

  it("prev exists + deltaApiMs <= 0 → invalid (regression guard)", () => {
    // Seed a prev tick with totalApiMs=1000 first.
    tickState.beginTick("D:\\test", validTokens({
      cost: { totalDurationMs: 1000, totalApiDurationMs: 1000, totalLinesAdded: 0, totalLinesRemoved: 0 },
    }));
    tickState.mark(statusStore.PREV_TICK_KEY, {
      ...statusStore.emptyPrevTickStatus(),
      totalApiMs: 1000,
      sessionId: "sess-test",
      cwd: "D:\\test",
      model: null,
    });
    tickState.commit();

    // Now tick with totalApiMs < prev.totalApiMs (regression).
    tickState.resetTickStateForTest();
    tickState.beginTick("D:\\test", validTokens({
      cost: { totalDurationMs: 1000, totalApiDurationMs: 500, totalLinesAdded: 0, totalLinesRemoved: 0 },
    }));
    assert.equal(tickState.getState().valid, false, "deltaApiMs < 0 → invalid");
  });

  it("null tokens → invalid (parse failure path)", () => {
    tickState.beginTick("D:\\test", null);
    assert.equal(tickState.getState().valid, false);
  });

  it("null cwd → valid (commit gates on cwd, not validation)", () => {
    // The validation gate runs on tokens only — cwd=null is
    // commit's concern (commit skips when cwd=null). Validating
    // with valid tokens + null cwd returns valid=true so the
    // in-memory pending map is still consumable by tests.
    tickState.beginTick(null, validTokens());
    assert.equal(tickState.getState().valid, true);
    tickState.mark("tickStatus:sess-test", statusStore.emptyTickStatus());
    tickState.commit(); // cwd=null → no disk write
    assert.equal(existsSync(join(_tmpDir, "status.json")), false);
  });
});

describe("data-processor — one-write-per-active-tick", () => {
  it("5 mark() calls + commit → 1 disk write of the merged store", () => {
    tickState.beginTick("D:\\test", validTokens());
    tickState.mark("tickStatus:sess-test", statusStore.emptyTickStatus());
    tickState.mark(statusStore.CCSESSION_KEY, statusStore.emptyTickStatus());
    tickState.mark("lastActive:in", { direction: "in", tps: 12.5 });
    tickState.mark("lastActive:out", { direction: "out", tps: 8.3 });
    tickState.mark(statusStore.PREV_TICK_KEY, statusStore.emptyPrevTickStatus());
    tickState.commit();

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
    tickState.beginTick("D:\\test", validTokens());
    tickState.mark("tickStatus:sess-test", statusStore.emptyTickStatus());
    // Simulate a crash: clear state without commit.
    tickState.resetTickStateForTest();
    assert.equal(
      existsSync(join(_tmpDir, "status.json")), false,
      "no file written — write is deferred to commit",
    );
  });
});

describe("data-processor — regression-reset + commit interplay", () => {
  // v1.0 — accPrimer's "immediate statusStore.writeTickStatus"
  // bypass is GONE. The regression-reset is now a regular
  // tickState.mark(CCSESSION_KEY, emptyTickStatus()) that the
  // data-processor (processTick Stage 1) fires BEFORE the same
  // tick's setAvg (Stage 4). Both flush through a SINGLE commit.
  // Last-mark-wins means setAvg's later mark can either replace
  // the empty reset (delta accumulated) OR be skipped (tick with
  // no delta → reset stays empty). Pin both shapes here.
  it("ccsession reset mark + setAgg accumulation → last-mark-wins at commit", () => {
    // First tick: seed prev with apiMs=0.
    tickState.beginTick("D:\\test", validTokens());
    tickState.mark(statusStore.PREV_TICK_KEY, statusStore.emptyPrevTickStatus());
    tickState.commit();

    // Second tick: regression-reset mark first (empty ccsession),
    // then setAgg-style mark lands with accIn=1000. processTick
    // does exactly this order.
    tickState.resetTickStateForTest();
    tickState.beginTick("D:\\test", validTokens());
    tickState.mark(statusStore.CCSESSION_KEY, statusStore.emptyTickStatus());
    tickState.mark(statusStore.CCSESSION_KEY, {
      ...statusStore.emptyTickStatus(),
      accIn: 1000,
    });
    tickState.commit();

    const raw = readFileSync(join(_tmpDir, "status.json"), "utf8");
    const store = JSON.parse(raw) as Record<string, { kind: string; value: { accIn: number } }>;
    // setAgg's later mark wins (last-mark-wins via the flat Map).
    assert.equal(store[statusStore.CCSESSION_KEY]?.value.accIn, 1000);
  });

  it("ccsession reset mark with NO subsequent delta → reset persists empty", () => {
    // Regression-reset fires, but a same-tick hasDelta=false (e.g.
    // current totals == prev totals) means setAgg never lands.
    // The reset entry should be the on-disk truth.
    tickState.beginTick("D:\\test", validTokens());
    tickState.mark(statusStore.PREV_TICK_KEY, statusStore.emptyPrevTickStatus());
    tickState.commit();

    tickState.resetTickStateForTest();
    tickState.beginTick("D:\\test", validTokens());
    tickState.mark(statusStore.CCSESSION_KEY, statusStore.emptyTickStatus());
    // NO setAgg mark follows — simulating hasDelta=false.
    tickState.commit();

    const raw = readFileSync(join(_tmpDir, "status.json"), "utf8");
    const store = JSON.parse(raw) as Record<string, { kind: string; value: { accIn: number; accOut: number } }>;
    const v = store[statusStore.CCSESSION_KEY]?.value;
    assert.equal(v.accIn, 0);
    assert.equal(v.accOut, 0);
  });
});

describe("data-processor — concurrent-overlay commit (m_template nesting)", () => {
  // m_template creates inner render contexts; mark() calls from
  // the inner overlay must NOT cause the outer mark to lose its
  // value at commit time. The contract: pending is a flat Map;
  // the LAST mark() before commit wins per key (inner sees its
  // own overlay, outer replaces when its own mark lands).
  it("inner mark overlays, outer mark replaces — outer's value wins", () => {
    tickState.beginTick("D:\\test", validTokens());
    tickState.mark("tickStatus:sess-test", { ...statusStore.emptyTickStatus(), accIn: 100 });
    tickState.mark("tickStatus:sess-test", { ...statusStore.emptyTickStatus(), accIn: 200 });
    tickState.commit();
    const raw = readFileSync(join(_tmpDir, "status.json"), "utf8");
    const store = JSON.parse(raw) as Record<string, { value: { accIn: number } }>;
    assert.equal(store["tickStatus:sess-test"]?.value.accIn, 200, "outer wins");
  });
});

describe("data-processor — getState throws without beginTick", () => {
  it("getState() with no prior beginTick throws a clear error", () => {
    assert.throws(() => tickState.getState(), /without beginTick\(\)/);
  });
});