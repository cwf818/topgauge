// Unit tests for the kimi user plugin's fill contract.
// Loads the captured real-shape fixture at
// src/__fixtures__/quota.real.kimi.json and asserts each of the
// three interval slots (shortInterval / midInterval / longInterval)
// maps to the right raw sub-tree and exposes the right derived
// fields.
//
// The host loader never touches these functions — they exist solely
// to pin the contract so a regression in fillQuota surfaces here
// before reaching the statusline.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
// kimi/index.js is plain ESM JS with no .d.ts — typecheck allows
// the runtime import to resolve loosely. Tests stay pinned to the
// live plugin (no test-only re-implementation of fillQuota).
// @ts-expect-error no .d.ts for the user plugin
import { MID_INTERVAL_MS, fillQuota } from "../../query_plugins/kimi/index.js";

const fixturePath = fileURLToPath(
  new URL("../__fixtures__/quota.real.kimi.json", import.meta.url),
);

function loadFixture(): unknown {
  return JSON.parse(readFileSync(fixturePath, "utf8"));
}

describe("kimi plugin — fillQuota against quota.real.kimi.json", () => {
  const raw = loadFixture();
  const quota = fillQuota(raw as never);

  it("returns a non-null Partial<Quota>", () => {
    assert.ok(quota, "fillQuota should produce a quota");
  });

  // shortInterval ← usages.limits[0].detail. duration 300 minutes →
  // intervalMs = 300 × 60 × 1000 = 18_000_000 ms.
  describe("shortInterval", () => {
    it("reads remaining from usages.limits[0].detail.remaining", () => {
      assert.equal(quota!.shortInterval!.remainingPercent, 100);
      assert.equal(quota!.shortInterval!.remainingQuota, 100);
    });
    it("derives intervalMs from window.duration minutes", () => {
      assert.equal(quota!.shortInterval!.intervalMs, 300 * 60 * 1000);
    });
    it("back-derives startAt = resetTime − intervalMs", () => {
      const resetAt = Date.parse("2026-07-02T03:32:40.140865Z");
      assert.equal(quota!.shortInterval!.endAt, resetAt);
      assert.equal(
        quota!.shortInterval!.startAt,
        resetAt - 300 * 60 * 1000,
      );
    });
    it("limits[0].detail.limit populates limitQuota", () => {
      assert.equal(quota!.shortInterval!.limitQuota, 100);
    });
  });

  // midInterval ← usages.detail (the primary 7-day cycle).
  describe("midInterval", () => {
    it("reads remaining from usages.detail.remaining", () => {
      assert.equal(quota!.midInterval!.remainingPercent, 58);
      assert.equal(quota!.midInterval!.usedPercent, 42);
    });
    it("uses the fixed 1-week intervalMs (7d)", () => {
      assert.equal(quota!.midInterval!.intervalMs, MID_INTERVAL_MS);
      assert.equal(MID_INTERVAL_MS, 7 * 24 * 60 * 60 * 1000);
    });
    it("back-derives startAt = resetTime − 7d", () => {
      const resetAt = Date.parse("2026-07-07T11:32:40.140865Z");
      assert.equal(quota!.midInterval!.endAt, resetAt);
      assert.equal(quota!.midInterval!.startAt, resetAt - MID_INTERVAL_MS);
    });
    it("pulls limit/used from usages.detail.limit/used", () => {
      assert.equal(quota!.midInterval!.limitQuota, 100);
      assert.equal(quota!.midInterval!.usedQuota, 42);
    });
  });

  // longInterval ← totalQuota.remaining. Only the percentage —
  // Kimi ships no resetTime / cycle anchor for this field, so
  // startAt / endAt / intervalMs are all null.
  describe("longInterval", () => {
    it("reads remaining from totalQuota.remaining", () => {
      assert.equal(quota!.longInterval!.remainingPercent, 92);
    });
    it("leaves startAt / endAt / intervalMs null (no anchor available)", () => {
      assert.equal(quota!.longInterval!.startAt, null);
      assert.equal(quota!.longInterval!.endAt, null);
      assert.equal(quota!.longInterval!.intervalMs, null);
    });
    it("populates remainingQuota + usedQuota + limitQuota", () => {
      assert.equal(quota!.longInterval!.remainingQuota, 92);
      assert.equal(quota!.longInterval!.usedQuota, 8);
      assert.equal(quota!.longInterval!.limitQuota, 100);
    });
  });

  it("returns null when no FEATURE_CODING usage is present", () => {
    const empty = fillQuota({ usages: [], totalQuota: { remaining: "92" } } as never);
    assert.equal(empty, null);
  });
});
