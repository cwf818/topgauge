import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { compilePath, walkPath, coerce, resolveSlot } from "./path-expr.ts";

describe("compilePath", () => {
  it("parses single key", () => {
    assert.deepEqual(compilePath("foo"), [{ kind: "key", name: "foo" }]);
  });
  it("parses nested keys", () => {
    assert.deepEqual(compilePath("a.b.c"), [
      { kind: "key", name: "a" },
      { kind: "key", name: "b" },
      { kind: "key", name: "c" },
    ]);
  });
  it("parses bracket form", () => {
    assert.deepEqual(compilePath("a[0].b"), [
      { kind: "key", name: "a" },
      { kind: "index", n: 0 },
      { kind: "key", name: "b" },
    ]);
  });
  it("parses bracket-less digit form", () => {
    assert.deepEqual(compilePath("a.0.b"), [
      { kind: "key", name: "a" },
      { kind: "index", n: 0 },
      { kind: "key", name: "b" },
    ]);
  });
  it("parses leading underscore keys", () => {
    assert.deepEqual(compilePath("_a.x"), [
      { kind: "key", name: "_a" },
      { kind: "key", name: "x" },
    ]);
  });
  it("rejects empty string", () => {
    assert.throws(() => compilePath(""), /non-empty/);
  });
  it("rejects unmatched bracket", () => {
    assert.throws(() => compilePath("a[0"), /unmatched/);
  });
  it("rejects non-integer index", () => {
    assert.throws(() => compilePath("a[x]"), /non-negative integer/);
    assert.throws(() => compilePath("a[1.5]"), /non-negative integer/);
    assert.throws(() => compilePath("a[-1]"), /non-negative integer/);
  });
  it("rejects invalid key chars", () => {
    assert.throws(() => compilePath("a-b"), /invalid key/);
  });
  it("rejects malformed identifier (digit then letter)", () => {
    // `a.0b` is ambiguous — not a pure-digit array index, and `0b` is
    // not a valid identifier. Must throw.
    assert.throws(() => compilePath("a.0b"), /invalid key/);
  });
  it("accepts consecutive dots (degenerate but valid)", () => {
    // `a..b` collapses to `[a, b]` — the empty segment between two
    // dots is silently dropped, matching how the renderer would have
    // walked a deeply-nested-but-missing level. We don't reject the
    // form; we just emit fewer segments.
    assert.deepEqual(compilePath("a..b"), [
      { kind: "key", name: "a" },
      { kind: "key", name: "b" },
    ]);
  });
});

describe("walkPath", () => {
  const data = {
    usages: [
      { detail: { used: "42" } },
      { detail: { used: "99" } },
    ],
    model_remains: {
      0: { current_interval_remaining_percent: 66 },
    },
  };
  it("walks object keys", () => {
    assert.equal(walkPath(data, [{ kind: "key", name: "usages" }]), data.usages);
  });
  it("walks array indices", () => {
    assert.equal(
      walkPath(data, [
        { kind: "key", name: "usages" },
        { kind: "index", n: 0 },
        { kind: "key", name: "detail" },
        { kind: "key", name: "used" },
      ]),
      "42",
    );
  });
  it("returns null on out-of-bounds index", () => {
    assert.equal(
      walkPath(data, [
        { kind: "key", name: "usages" },
        { kind: "index", n: 5 },
      ]),
      null,
    );
  });
  it("returns null on missing key", () => {
    assert.equal(
      walkPath(data, [{ kind: "key", name: "missing" }]),
      null,
    );
  });
  it("returns null when intermediate is not an object", () => {
    assert.equal(
      walkPath(data, [
        { kind: "key", name: "usages" },
        { kind: "index", n: 0 },
        { kind: "key", name: "detail" },
        { kind: "key", name: "used" },
        { kind: "key", name: "oops" },
      ]),
      null,
    );
  });
  it("returns null when intermediate is not an array", () => {
    assert.equal(
      walkPath({ a: "string" }, [
        { kind: "key", name: "a" },
        { kind: "index", n: 0 },
      ]),
      null,
    );
  });
});

describe("coerce", () => {
  it("coerces numbers", () => {
    assert.equal(coerce(42, "number"), 42);
    assert.equal(coerce("42", "number"), 42);
    assert.equal(coerce("3.14", "number"), 3.14);
    assert.equal(coerce(NaN, "number"), null);
    assert.equal(coerce("abc", "number"), null);
    assert.equal(coerce(null, "number"), null);
  });
  it("coerces booleans", () => {
    assert.equal(coerce(true, "boolean"), true);
    assert.equal(coerce(1, "boolean"), true);
    assert.equal(coerce(0, "boolean"), false);
    assert.equal(coerce("true", "boolean"), true);
    assert.equal(coerce("FALSE", "boolean"), false);
    assert.equal(coerce("yes", "boolean"), null);
  });
  it("coerces epoch ms (numeric + ISO)", () => {
    assert.equal(coerce(1782302400000, "epochMs"), 1782302400000);
    assert.equal(coerce("1782302400000", "epochMs"), 1782302400000);
    assert.equal(
      coerce("2026-07-07T11:32:40Z", "epochMs"),
      Date.parse("2026-07-07T11:32:40Z"),
    );
    assert.equal(coerce("not a date", "epochMs"), null);
    assert.equal(coerce("", "epochMs"), null);
  });
  it("coerces arrays", () => {
    assert.deepEqual(coerce([1, 2], "array"), [1, 2]);
    assert.equal(coerce("not array", "array"), null);
    assert.equal(coerce({}, "array"), null);
  });
  it("any passes through", () => {
    assert.equal(coerce("foo", "any"), "foo");
    assert.equal(coerce(42, "any"), 42);
  });
});

describe("resolveSlot (end-to-end)", () => {
  const data = {
    usages: [
      {
        detail: { used: "42", remaining: "58" },
        limits: [{ detail: { used: "100" } }],
      },
    ],
    reset_at: "2026-07-07T11:32:40Z",
  };
  it("resolves numeric slot through path", () => {
    assert.equal(resolveSlot(data, "usages[0].limits[0].detail.used", "number"), 100);
  });
  it("resolves bracket-less digit form", () => {
    assert.equal(resolveSlot(data, "usages.0.detail.used", "number"), 42);
  });
  it("resolves ISO-8601 reset to epoch ms", () => {
    assert.equal(
      resolveSlot(data, "reset_at", "epochMs"),
      Date.parse("2026-07-07T11:32:40Z"),
    );
  });
  it("returns null on type mismatch", () => {
    assert.equal(resolveSlot(data, "usages.0.detail.used", "boolean"), null);
  });
  it("returns null on missing path", () => {
    assert.equal(resolveSlot(data, "missing.path", "number"), null);
  });
});
