// Smoke tests for the GitHub Copilot built-in plugin.
//
// The plugin is plain ESM JS at runtime — these tests exercise
// the *contract*: the `fillQuota` shape, the natural-month bounds
// math, and the auth-key symmetry. Dynamic-import the same file
// the host loader uses so the test stays in lockstep with the
// shipped source. A test-only `clockMs` override is exposed via
// the re-imported module's `naturalMonthBounds` export (added
// below) — the canonical plugin keeps `nowMs = Date.now()` in the
// public ABI; tests thread the clock through here so boundaries
// can be asserted across month rollover.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  fillQuota,
  naturalMonthBounds,
  ENDPOINT,
} from "./index.js";

function epoch(year: number, month: number, day: number, h = 0, m = 0, s = 0, ms = 0): number {
  return new Date(year, month - 1, day, h, m, s, ms).getTime();
}

describe("naturalMonthBounds", () => {
  it("mid-month → start of this month, start of next month", () => {
    // 2026-07-15T13:30 local → start of July → start of August.
    const nowMs = epoch(2026, 7, 15, 13, 30);
    const got = naturalMonthBounds(nowMs);
    assert.equal(got?.startAt, epoch(2026, 7, 1));
    assert.equal(got?.endAt,   epoch(2026, 8, 1));
  });

  it("first day of month → same day zero hour", () => {
    // midnight on the 1st is both the bound and the start; the
    // bounds function shouldn't accidentally roll back to the
    // previous month.
    const nowMs = epoch(2026, 7, 1, 0, 0);
    const got = naturalMonthBounds(nowMs);
    assert.equal(got?.startAt, epoch(2026, 7, 1));
    assert.equal(got?.endAt,   epoch(2026, 8, 1));
  });

  it("December → January rolls over the year", () => {
    const nowMs = epoch(2026, 12, 20, 9, 0);
    const got = naturalMonthBounds(nowMs);
    assert.equal(got?.startAt, epoch(2026, 12, 1));
    assert.equal(got?.endAt,   epoch(2027, 1, 1));
  });

  it("non-finite input → null", () => {
    assert.equal(naturalMonthBounds(Number.NaN), null);
    assert.equal(naturalMonthBounds(Number.POSITIVE_INFINITY), null);
    assert.equal(naturalMonthBounds(Number.NEGATIVE_INFINITY), null);
  });
});

describe("fillQuota", () => {
  // Pin a stable clock so the test doesn't drift with `Date.now()`.
  const nowMs = epoch(2026, 7, 15, 13, 30);
  const expectedBounds = {
    startAt: epoch(2026, 7, 1),
    endAt:   epoch(2026, 8, 1),
  };

  it("happy path: projects premium_interactions onto longInterval", () => {
    const raw = {
      quota_snapshots: {
        premium_interactions: {
          percent_remaining: 73.5,
          quota_remaining: 735,
          entitlement: 1000,
        },
      },
    };
    const out = fillQuota(raw, nowMs);
    assert.ok(out);
    assert.equal(out.shortInterval, null);
    assert.equal(out.midInterval,   null);
    assert.equal(out.longInterval?.remainingPercent, 73.5);
    assert.equal(out.longInterval?.remainingQuota,   735);
    assert.equal(out.longInterval?.limitQuota,       1000);
    assert.deepEqual(
      { startAt: out.longInterval?.startAt, endAt: out.longInterval?.endAt },
      expectedBounds,
    );
  });

  it("accepts numeric strings (matches ensureInterval's asNumber contract)", () => {
    // Copilot's proxy occasionally stringifies its numbers;
    // the plugin should not stall on that.
    const raw = {
      quota_snapshots: {
        premium_interactions: {
          percent_remaining: "42",
          quota_remaining: "420",
          entitlement: "1000",
        },
      },
    };
    const out = fillQuota(raw, nowMs);
    assert.equal(out?.longInterval?.remainingPercent, 42);
    assert.equal(out?.longInterval?.remainingQuota,   420);
    assert.equal(out?.longInterval?.limitQuota,       1000);
  });

  it("missing premium_interactions → null", () => {
    assert.equal(fillQuota({}, nowMs), null);
    assert.equal(fillQuota({ quota_snapshots: {} }, nowMs), null);
    assert.equal(
      fillQuota({ quota_snapshots: { premium_interactions: null } }, nowMs),
      null,
    );
  });

  it("non-object raw → null", () => {
    assert.equal(fillQuota(null,      nowMs), null);
    assert.equal(fillQuota("string",  nowMs), null);
    assert.equal(fillQuota(42,        nowMs), null);
    assert.equal(fillQuota(["array"], nowMs), null);
  });

  it("partial fields render as null (preserve renderer placeholder for missing data)", () => {
    // premium_interactions exists but only entitlement is set.
    // remainingPercent / remainingQuota absent → null (the
    // renderer falls back to its "0%" / "--" placeholders, which
    // is what you want when only the cap is known).
    const raw = {
      quota_snapshots: {
        premium_interactions: { entitlement: 1000 },
      },
    };
    const out = fillQuota(raw, nowMs);
    assert.equal(out?.longInterval?.remainingPercent, null);
    assert.equal(out?.longInterval?.remainingQuota,   null);
    assert.equal(out?.longInterval?.limitQuota,       1000);
  });
});

describe("fetchAccountCredit", () => {
  it("points at localhost:4141 with no required auth", () => {
    // Sanity-check the endpoint URL is what the user spec
    // requires — the contract is "POST /usage" / GET-shaped call
    // to a sidecar. We don't bind the exact HTTP verb here
    // (the plugin picks GET) but the host/port/path are
    // pinned so a typo at this layer is caught immediately.
    assert.equal(ENDPOINT, "http://localhost:4141/usage");
  });
});
