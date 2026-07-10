import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  __resetForTest,
  __testing,
  applyProviderOverrides,
  configStore,
  loadConfig,
  DEFAULT_STATUSLINE_TEMPLATE,
  LEGACY_PRESET_NAMES,
  resolveEffectiveIntervals,
} from "./config.ts";
import { queryPluginsDir } from "./api.ts";

const { DEFAULT_CONFIG, setPathResolver, resetPathResolver } = __testing;

let tmpDir: string;
let capturedStderr: string;
let originalWrite: (chunk: string | Uint8Array, ...rest: unknown[]) => boolean;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "config-test-"));
  setPathResolver(() => join(tmpDir, "config.json"));
  __resetForTest();
  capturedStderr = "";
  // process.stderr.write has many overloads (string / Buffer / Uint8Array /
  // encoding+callback). Cast through `any` to capture the existing
  // reference and to assign a single-signature replacement. config.ts
  // only ever calls write(string), so the replacement only needs to
  // handle that case.
  const err = process.stderr as any;
  originalWrite = (err.write as unknown as (chunk: string | Uint8Array, ...rest: unknown[]) => boolean).bind(process.stderr);
  err.write = ((chunk: unknown): boolean => {
    capturedStderr += typeof chunk === "string" ? chunk : Buffer.from(chunk as Uint8Array).toString("utf8");
    return true;
  }) as unknown as typeof err.write;
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
  resetPathResolver();
  (process.stderr as any).write = originalWrite;
});

describe("loadConfig — missing file", () => {
  it("returns DEFAULT_CONFIG silently (no stderr) when the file does not exist", async () => {
    const cfg = await loadConfig();
    assert.deepEqual(cfg, DEFAULT_CONFIG);
    assert.equal(capturedStderr, "");
  });
});

describe("loadConfig — valid override", () => {
  it("applies valid top-level overrides", async () => {
    writeFileSync(
      join(tmpDir, "config.json"),
      JSON.stringify({
        cacheTtlMs: 30_000,
        display: "remaining",
        fetchTimeoutMs: 7_500,
      }),
    );
    const cfg = await loadConfig();
    assert.equal(cfg.cacheTtlMs, 30_000);
    assert.equal(cfg.display, "remaining");
    assert.equal(cfg.fetchTimeoutMs, 7_500);
    // Other fields keep their defaults.
    assert.equal(cfg.bar.width, DEFAULT_CONFIG.bar.width);
    assert.equal(cfg.colors.red, DEFAULT_CONFIG.colors.red);
  });

  it("applies nested overrides (colors, thresholds, bar)", async () => {
    writeFileSync(
      join(tmpDir, "config.json"),
      JSON.stringify({
        colors: { red: "brightBlack", yellow: "\x1b[38;5;226m" },
        thresholds: { percentBands: [10, 30, 50, 70] },
        bar: { width: 12 },
      }),
    );
    const cfg = await loadConfig();
    assert.equal(cfg.colors.red, "\x1b[90m"); // brightBlack shortcut
    assert.equal(cfg.colors.yellow, "\x1b[38;5;226m");
    assert.equal(cfg.colors.brightGreen, DEFAULT_CONFIG.colors.brightGreen); // untouched
    assert.deepEqual(cfg.thresholds.percentBands, [10, 30, 50, 70]);
    assert.deepEqual(cfg.thresholds.balanceBands, [5, 10, 20, 50]); // untouched
    assert.equal(cfg.bar.width, 12);
  });

  it("accepts symbolic color shortcuts", async () => {
    writeFileSync(
      join(tmpDir, "config.json"),
      JSON.stringify({ colors: { brightGreen: "brightGreen", stale: "brightBlack" } }),
    );
    const cfg = await loadConfig();
    assert.equal(cfg.colors.brightGreen, "\x1b[38;5;41m");
    assert.equal(cfg.colors.stale, "\x1b[90m");
  });

  it("normalizes currency.prefixes keys to upper-case", async () => {
    writeFileSync(
      join(tmpDir, "config.json"),
      JSON.stringify({ currency: { prefixes: { usd: "U$", eur: "€" } } }),
    );
    const cfg = await loadConfig();
    assert.equal(cfg.currency.prefixes.USD, "U$");
    assert.equal(cfg.currency.prefixes.EUR, "€");
    // Original keys preserved alongside.
    assert.equal(cfg.currency.prefixes.CNY, "￥");
  });
});

describe("loadConfig — malformed input", () => {
  it("falls back to defaults when JSON is invalid", async () => {
    writeFileSync(join(tmpDir, "config.json"), "{ not valid json");
    const cfg = await loadConfig();
    assert.deepEqual(cfg, DEFAULT_CONFIG);
    assert.match(capturedStderr, /config invalid JSON/);
  });

  it("falls back to defaults when root is not an object", async () => {
    writeFileSync(join(tmpDir, "config.json"), "42");
    const cfg = await loadConfig();
    assert.deepEqual(cfg, DEFAULT_CONFIG);
    assert.match(capturedStderr, /root must be a JSON object/);
  });

  it("falls back to defaults when root is an array", async () => {
    writeFileSync(join(tmpDir, "config.json"), "[1,2,3]");
    const cfg = await loadConfig();
    assert.deepEqual(cfg, DEFAULT_CONFIG);
    assert.match(capturedStderr, /root must be a JSON object/);
  });
});

describe("loadConfig — partial / per-section validation", () => {
  it("drops a bad field but keeps the rest of that section", async () => {
    writeFileSync(
      join(tmpDir, "config.json"),
      JSON.stringify({
        colors: { red: -1, yellow: "\x1b[38;5;226m" }, // bad red, good yellow
      }),
    );
    const cfg = await loadConfig();
    // bad field dropped to default, good field applied
    assert.equal(cfg.colors.red, DEFAULT_CONFIG.colors.red);
    assert.equal(cfg.colors.yellow, "\x1b[38;5;226m");
    assert.match(capturedStderr, /colors\.red/);
  });

  it("does NOT poison unrelated sections when one section is bad", async () => {
    writeFileSync(
      join(tmpDir, "config.json"),
      JSON.stringify({
        colors: "not an object", // entire colors block invalid
        cacheTtlMs: 12_345, // perfectly fine
      }),
    );
    const cfg = await loadConfig();
    assert.equal(cfg.cacheTtlMs, 12_345);
    assert.equal(cfg.colors.red, DEFAULT_CONFIG.colors.red);
    assert.match(capturedStderr, /colors must be an object/);
  });

  it("rejects ascending thresholds that are not 4-tuple", async () => {
    writeFileSync(
      join(tmpDir, "config.json"),
      JSON.stringify({ thresholds: { percentBands: [20, 40] } }),
    );
    const cfg = await loadConfig();
    assert.deepEqual(cfg.thresholds.percentBands, [60, 70, 80, 90]);
    assert.match(capturedStderr, /thresholds\.percentBands/);
  });

  it("rejects non-ascending threshold tuples", async () => {
    writeFileSync(
      join(tmpDir, "config.json"),
      JSON.stringify({ thresholds: { percentBands: [40, 20, 60, 80] } }),
    );
    const cfg = await loadConfig();
    assert.deepEqual(cfg.thresholds.percentBands, [60, 70, 80, 90]);
    assert.match(capturedStderr, /thresholds\.percentBands/);
  });

  it("rejects display values outside the enum", async () => {
    writeFileSync(join(tmpDir, "config.json"), JSON.stringify({ display: "sideways" }));
    const cfg = await loadConfig();
    assert.equal(cfg.display, "used");
    assert.match(capturedStderr, /display/);
  });

  it("rejects bar.width outside [3, 64]", async () => {
    writeFileSync(join(tmpDir, "config.json"), JSON.stringify({ bar: { width: 100 } }));
    const cfg = await loadConfig();
    assert.equal(cfg.bar.width, 8);
    assert.match(capturedStderr, /bar\.width/);
  });

  it("rejects cacheTtlMs that is not a positive number", async () => {
    writeFileSync(join(tmpDir, "config.json"), JSON.stringify({ cacheTtlMs: -1 }));
    const cfg = await loadConfig();
    assert.equal(cfg.cacheTtlMs, 60_000);
    assert.match(capturedStderr, /cacheTtlMs/);
  });

  it("rejects bar.filled containing a newline (statusline injection guard)", async () => {
    writeFileSync(join(tmpDir, "config.json"), JSON.stringify({ bar: { filled: "▓\n" } }));
    const cfg = await loadConfig();
    assert.equal(cfg.bar.filled, "▓");
    assert.match(capturedStderr, /bar\.filled/);
  });
});

describe("loadConfig — countdown.resetArrows", () => {
  it("default is the 12-emoji clock face array", () => {
    const cfg = __testing.DEFAULT_CONFIG;
    assert.equal(cfg.countdown.resetArrows.length, 12);
    assert.equal(cfg.countdown.resetArrows[0], "🕛");
    assert.equal(cfg.countdown.resetArrows[11], "🕐");
  });

  it("accepts a custom array of single-line strings", async () => {
    writeFileSync(join(tmpDir, "config.json"), JSON.stringify({
      countdown: { resetArrows: ["⏳", "⌛"] }
    }));
    const cfg = await loadConfig();
    assert.deepEqual(cfg.countdown.resetArrows, ["⏳", "⌛"]);
  });

  it("rejects a non-array resetArrows (e.g. a string) and falls back to defaults", async () => {
    writeFileSync(join(tmpDir, "config.json"), JSON.stringify({
      countdown: { resetArrows: "↻" }
    }));
    const cfg = await loadConfig();
    assert.equal(cfg.countdown.resetArrows.length, 12);
    assert.equal(cfg.countdown.resetArrows[0], "🕛");
    assert.match(capturedStderr, /resetArrows/);
  });

  it("rejects an empty array and falls back to defaults", async () => {
    writeFileSync(join(tmpDir, "config.json"), JSON.stringify({
      countdown: { resetArrows: [] }
    }));
    const cfg = await loadConfig();
    assert.equal(cfg.countdown.resetArrows.length, 12);
    assert.match(capturedStderr, /resetArrows/);
  });

  it("rejects an array containing non-strings or multi-line strings and falls back to defaults", async () => {
    writeFileSync(join(tmpDir, "config.json"), JSON.stringify({
      countdown: { resetArrows: ["OK", 42, "fine\n", null] }
    }));
    const cfg = await loadConfig();
    assert.equal(cfg.countdown.resetArrows.length, 12);
    assert.match(capturedStderr, /resetArrows/);
  });

  it("silently ignores the v0.2.1 resetArrowMore / resetArrowLess keys (now unused)", async () => {
    writeFileSync(join(tmpDir, "config.json"), JSON.stringify({
      stale: { resetArrowMore: "X", resetArrowLess: "Y" }
    }));
    const cfg = await loadConfig();
    // The 12-emoji default is still in place; old keys are silently ignored.
    assert.equal(cfg.countdown.resetArrows.length, 12);
    assert.equal(cfg.countdown.resetArrows[0], "🕛");
  });
});

describe("loadConfig — statuslineTemplate string→array auto-migration (v0.8.14+)", () => {
  // v0.8.14 — `statuslineTemplate` is array-only. The legacy string-
  // form preset-name values from v0.4.0–v0.8.13 are auto-migrated
  // to the equivalent `["m_template|_X"]` form with a one-shot warn.
  // Users should write the array form directly to silence the warn.
  //
  // The validator confirms the name is a known legacy preset
  // (LEGACY_PRESET_NAMES = 7 plan + 2 balance names); the actual
  // array resolution is in src/render.ts (renderProviderLine) and
  // is covered by renderTemplate end-to-end tests in
  // lineTemplate.test.ts.

  it("all 9 LEGACY_PRESET_NAMES auto-migrate to the equivalent m_template|_X form", async () => {
    for (const name of LEGACY_PRESET_NAMES) {
      // Each test uses its own file (writeFileSync is destructive).
      // Reset stderr capture so the loop's previous iteration's warn
      // doesn't bleed into the next assertion.
      capturedStderr = "";
      writeFileSync(join(tmpDir, "config.json"), JSON.stringify({
        statuslineTemplate: name,
      }));
      const cfg = await loadConfig();
      assert.deepEqual(
        cfg.statuslineTemplate,
        [`m_template|_${name}`],
        `legacy preset "${name}" should migrate to ["m_template|_${name}"]`,
      );
      // One warn per migration (not per token — single line).
      assert.match(capturedStderr, /auto-migrating to/);
    }
  });

  it("unknown preset name warns + falls back to default", async () => {
    writeFileSync(join(tmpDir, "config.json"), JSON.stringify({
      statuslineTemplate: "totally-made-up",
    }));
    const cfg = await loadConfig();
    assert.deepEqual(cfg.statuslineTemplate, DEFAULT_STATUSLINE_TEMPLATE.slice());
    assert.match(capturedStderr, /not a known preset/);
    // The warn message lists the valid preset names so the user can
    // fix the typo without reading the docs.
    assert.match(capturedStderr, /standard/);
  });

  it("non-string non-array (e.g. number) warns + falls back to default", async () => {
    writeFileSync(join(tmpDir, "config.json"), JSON.stringify({
      statuslineTemplate: 42,
    }));
    const cfg = await loadConfig();
    assert.deepEqual(cfg.statuslineTemplate, DEFAULT_STATUSLINE_TEMPLATE.slice());
    assert.match(capturedStderr, /statuslineTemplate must be a string\[\]/);
  });
});

describe("display precedence", () => {
  it("config.json wins over the hardcoded default", async () => {
    writeFileSync(join(tmpDir, "config.json"), JSON.stringify({ display: "remaining" }));
    const cfg = await loadConfig();
    assert.equal(cfg.display, "remaining");
  });
});

describe("configStore singleton", () => {
  it("get() reflects the most recently loaded config", async () => {
    assert.equal(configStore.get().display, "used");
    writeFileSync(join(tmpDir, "config.json"), JSON.stringify({ display: "remaining" }));
    await loadConfig();
    assert.equal(configStore.get().display, "remaining");
  });

  it("__resetForTest() restores DEFAULT_CONFIG without touching disk", () => {
    __resetForTest({ cacheTtlMs: 999 });
    assert.equal(configStore.get().cacheTtlMs, 999);
    __resetForTest();
    assert.equal(configStore.get().cacheTtlMs, 60_000);
  });
});

describe("loadConfig — timeFormat (top-level)", () => {
  it("defaults: minUnit='m', maxUnitCount=2", () => {
    const cfg = __testing.DEFAULT_CONFIG;
    assert.equal(cfg.timeFormat.minUnit, "m");
    assert.equal(cfg.timeFormat.maxUnitCount, 2);
  });

  it("accepts minUnit='s' override", async () => {
    writeFileSync(join(tmpDir, "config.json"), JSON.stringify({
      timeFormat: { minUnit: "s" },
    }));
    const cfg = await loadConfig();
    assert.equal(cfg.timeFormat.minUnit, "s");
    // maxUnitCount keeps its default when only minUnit is overridden.
    assert.equal(cfg.timeFormat.maxUnitCount, 2);
  });

  it("accepts maxUnitCount override", async () => {
    writeFileSync(join(tmpDir, "config.json"), JSON.stringify({
      timeFormat: { maxUnitCount: 4 },
    }));
    const cfg = await loadConfig();
    assert.equal(cfg.timeFormat.maxUnitCount, 4);
  });

  it("clamps maxUnitCount to [1, 4]", async () => {
    writeFileSync(join(tmpDir, "config.json"), JSON.stringify({
      timeFormat: { maxUnitCount: 99 },
    }));
    let cfg = await loadConfig();
    assert.equal(cfg.timeFormat.maxUnitCount, 4);
    writeFileSync(join(tmpDir, "config.json"), JSON.stringify({
      timeFormat: { maxUnitCount: 0 },
    }));
    cfg = await loadConfig();
    assert.equal(cfg.timeFormat.maxUnitCount, 1);
  });

  it("accepts minUnit='h' (hour granularity)", async () => {
    writeFileSync(join(tmpDir, "config.json"), JSON.stringify({
      timeFormat: { minUnit: "h" },
    }));
    const cfg = await loadConfig();
    assert.equal(cfg.timeFormat.minUnit, "h");
  });

  it("rejects out-of-enum minUnit and warns", async () => {
    writeFileSync(join(tmpDir, "config.json"), JSON.stringify({
      timeFormat: { minUnit: "d" },
    }));
    const cfg = await loadConfig();
    assert.equal(cfg.timeFormat.minUnit, "m");
    assert.match(capturedStderr, /timeFormat\.minUnit/);
  });

  it("rejects non-numeric maxUnitCount and warns", async () => {
    writeFileSync(join(tmpDir, "config.json"), JSON.stringify({
      timeFormat: { maxUnitCount: "two" },
    }));
    const cfg = await loadConfig();
    assert.equal(cfg.timeFormat.maxUnitCount, 2);
    assert.match(capturedStderr, /timeFormat\.maxUnitCount/);
  });
});

// vX.X.X+ — the `separators` config field is REMOVED. The six
// built-in s_<name> aliases are the only separator tokens. This
// describe block is gone; legacy configs that still carry a
// `separators` key are silently ignored by the loader.

describe("loadConfig — lineTemplates + statuslineTemplate (v0.4.0+, presets flattened v0.8.14+)", () => {
  it("defaults: lineTemplates has {plan, balance} + 9 _-prefixed presets; statuslineTemplate defaults to [m_template|_1line]", () => {
    // v0.4.x — the default template uses NAMED ALIASES (s_space,
    // s_dot) so it works with the empty default separators array.
    // v0.8.14+ — the 7 plan + 2 balance presets are now first-class
    // entries in lineTemplates with `_`-prefix; the default
    // `statuslineTemplate` is the array ["m_template|_1line"]
    // (auto-resolved through `m_template` to the byte-identical
    // body of the v0.4.0–v0.8.13 PLAN_PRESETS["1line"]).
    const cfg = __testing.DEFAULT_CONFIG;
    assert.deepEqual(cfg.lineTemplates.plan, [
      "m_modeLabel", "s_space",
      "m_window|term:short", "s_space", "m_countdown|term:short",
      "s_space", "s_dot", "s_space",
      "m_window|term:mid", "s_space", "m_countdown|term:mid",
    ]);
    assert.deepEqual(cfg.lineTemplates.balance, ["m_modeLabel", "s_space", "m_balance"]);
    // The 9 built-in presets are present with `_`-prefix.
    assert.ok(cfg.lineTemplates._1line);
    assert.ok(cfg.lineTemplates._simple);
    assert.ok(cfg.lineTemplates._simple_alone);
    assert.ok(cfg.lineTemplates._standard);
    assert.ok(cfg.lineTemplates._standard_alone);
    assert.ok(cfg.lineTemplates._abundant);
    assert.ok(cfg.lineTemplates._complete);
    assert.ok(cfg.lineTemplates._balance_simple);
    assert.ok(cfg.lineTemplates._balance_simple_alone);
    // _1line and _simple must be byte-identical (the alias).
    assert.deepEqual(cfg.lineTemplates._1line, cfg.lineTemplates._simple);
    assert.deepEqual(cfg.statuslineTemplate, ["m_template|_1line"]);
  });

  it("statuslineTemplate string 'standard' auto-migrates to ['m_template|_standard']", async () => {
    capturedStderr = "";
    writeFileSync(join(tmpDir, "config.json"), JSON.stringify({
      statuslineTemplate: "standard",
    }));
    const cfg = await loadConfig();
    assert.deepEqual(cfg.statuslineTemplate, ["m_template|_standard"]);
    assert.match(capturedStderr, /auto-migrating to/);
    // The render-time lookup against cfg().lineTemplates._standard
    // is covered by lineTemplate.test.ts; here we just confirm the
    // migration produces the expected array form.
  });

  it("statuslineTemplate array form is passed through verbatim", async () => {
    const tokens = ["m_modeLabel", "s_0", "m_window|term:short"];
    writeFileSync(join(tmpDir, "config.json"), JSON.stringify({
      statuslineTemplate: tokens,
    }));
    const cfg = await loadConfig();
    assert.deepEqual(cfg.statuslineTemplate, tokens);
  });

  it("statuslineTemplate balance preset 'simple' auto-migrates to ['m_template|_balance_simple']", async () => {
    capturedStderr = "";
    writeFileSync(join(tmpDir, "config.json"), JSON.stringify({
      statuslineTemplate: "balance_simple",
    }));
    const cfg = await loadConfig();
    assert.deepEqual(cfg.statuslineTemplate, ["m_template|_balance_simple"]);
    assert.match(capturedStderr, /auto-migrating to/);
  });

  it("lineTemplates user-defined key is preserved verbatim", async () => {
    const foo = ["m_modeLabel", "s_0", "m_balance"];
    writeFileSync(join(tmpDir, "config.json"), JSON.stringify({
      lineTemplates: { foo },
    }));
    const cfg = await loadConfig();
    assert.deepEqual(cfg.lineTemplates.foo, foo);
    // Existing defaults still present (merged, not replaced).
    assert.ok(cfg.lineTemplates.plan.includes("m_window|term:short"));
  });

  it("lineTemplates strips nested m_template tokens (nesting protection)", async () => {
    writeFileSync(join(tmpDir, "config.json"), JSON.stringify({
      lineTemplates: {
        foo: ["m_modeLabel", "m_template|plan", "m_template", "s_0", "m_balance"],
      },
    }));
    const cfg = await loadConfig();
    assert.deepEqual(cfg.lineTemplates.foo, ["m_modeLabel", "s_0", "m_balance"]);
    assert.match(capturedStderr, /m_template is only allowed inside statuslineTemplate/);
  });

  it("lineTemplates non-array entry is rejected with a warning", async () => {
    writeFileSync(join(tmpDir, "config.json"), JSON.stringify({
      lineTemplates: { foo: "not an array" },
    }));
    const cfg = await loadConfig();
    assert.equal(cfg.lineTemplates.foo, undefined);
    assert.match(capturedStderr, /lineTemplates\.foo must be an array of strings/);
  });

  it("lineTemplates empty array entry is rejected with a warning", async () => {
    writeFileSync(join(tmpDir, "config.json"), JSON.stringify({
      lineTemplates: { foo: [] },
    }));
    const cfg = await loadConfig();
    assert.equal(cfg.lineTemplates.foo, undefined);
    assert.match(capturedStderr, /lineTemplates\.foo is empty after cleaning/);
  });

  // v0.8.14+ — `_`-prefix is reserved for built-in presets. Loader
  // rejects user `lineTemplates._*` entries whose name collides with
  // a built-in key (warn + skip). User-defined `_custom` entries
  // that don't collide with a built-in key are preserved.
  it("lineTemplates._1line collides with built-in preset and is rejected", async () => {
    capturedStderr = "";
    writeFileSync(join(tmpDir, "config.json"), JSON.stringify({
      lineTemplates: { _1line: ["m_window|term:short"] },
    }));
    const cfg = await loadConfig();
    // The user's `_1line` entry is dropped; the built-in `_1line`
    // body from DEFAULT_LINE_TEMPLATES survives.
    assert.deepEqual(cfg.lineTemplates._1line, __testing.DEFAULT_CONFIG.lineTemplates._1line);
    assert.notDeepEqual(cfg.lineTemplates._1line, ["m_window|term:short"]);
    assert.match(capturedStderr, /reserved for built-in presets/);
  });

  it("lineTemplates._balance_simple collides with built-in preset and is rejected", async () => {
    capturedStderr = "";
    writeFileSync(join(tmpDir, "config.json"), JSON.stringify({
      lineTemplates: { _balance_simple: ["m_window|term:short"] },
    }));
    const cfg = await loadConfig();
    // The user's `_balance_simple` entry is dropped; the built-in
    // body (BALANCE_PRESETS["simple"] body, "Balance: <balance>")
    // survives.
    assert.deepEqual(
      cfg.lineTemplates._balance_simple,
      __testing.DEFAULT_CONFIG.lineTemplates._balance_simple,
    );
    assert.match(capturedStderr, /reserved for built-in presets/);
  });

  it("lineTemplates._custom (non-builtin _-prefix) is preserved", async () => {
    capturedStderr = "";
    writeFileSync(join(tmpDir, "config.json"), JSON.stringify({
      lineTemplates: { _custom: ["m_window|term:short"] },
    }));
    const cfg = await loadConfig();
    assert.deepEqual(cfg.lineTemplates._custom, ["m_window|term:short"]);
    // No warn — the collision check only fires for keys that
    // actually exist in DEFAULT_LINE_TEMPLATES.
    assert.doesNotMatch(capturedStderr, /reserved for built-in/);
  });

  it("legacy lineTemplate warns once and is ignored (hard break)", async () => {
    writeFileSync(join(tmpDir, "config.json"), JSON.stringify({
      lineTemplate: {
        plan: ["m_window|term:short"],
        balance: ["m_balance"],
      },
    }));
    const cfg = await loadConfig();
    // Defaults remain; the legacy field did NOT auto-migrate.
    // (v0.8.14 — default is the array ["m_template|_1line"], not
    // the v0.4.0–v0.8.13 string "1line".)
    assert.deepEqual(cfg.statuslineTemplate, ["m_template|_1line"]);
    assert.ok(cfg.lineTemplates.plan.includes("m_window|term:short"));
    assert.ok(cfg.lineTemplates.balance.includes("m_balance"));
    assert.match(capturedStderr, /lineTemplate is removed in v0\.4\.0/);
  });
});

describe("loadConfig — modeLabels.balance (v0.2.17)", () => {
  it("defaults to 'Balance:'", () => {
    assert.equal(__testing.DEFAULT_CONFIG.modeLabels.balance, "Balance:");
  });

  it("accepts a custom balance label", async () => {
    writeFileSync(join(tmpDir, "config.json"), JSON.stringify({
      modeLabels: { balance: "Wallet:" },
    }));
    const cfg = await loadConfig();
    assert.equal(cfg.modeLabels.balance, "Wallet:");
    // used/remaining keep their defaults.
    assert.equal(cfg.modeLabels.used, "Usage:");
    assert.equal(cfg.modeLabels.remaining, "Remain:");
  });

  it("rejects a non-string balance label and warns", async () => {
    writeFileSync(join(tmpDir, "config.json"), JSON.stringify({
      modeLabels: { balance: 42 },
    }));
    const cfg = await loadConfig();
    assert.equal(cfg.modeLabels.balance, "Balance:");
    assert.match(capturedStderr, /modeLabels\.balance/);
  });
});

// v0.8.0+ → v0.8.22: top-level `labels` overrides for the
// token-stat prefix axes. v0.8.0 had four axes (labelIn /
// labelOut / labelCacheIn / labelTotalIn); v0.8.13+ extended the
// resolver with four more (labelApi / labelApiCalls / labelInSpeed
// / labelOutSpeed). v0.8.22 unified every label name under the
// `labelToken*` / `labelApi*` namespace (and added labelTokenTotalOut
// + labelTokenHitRate), so the resolver is now symmetric across
// the per-turn / acc / sum-avg families. Old names (labelIn /
// labelOut / labelCacheIn / labelTotalIn / labelApi /
// labelInSpeed / labelOutSpeed) are accepted as deprecated
// aliases — see the "v0.8.22+ deprecation aliases" describe
// below. Partial-merge semantics match modeLabels: each field
// optional, invalid type → warn + default retained.
describe("loadConfig — labels (v0.8.22+ unified labelToken* / labelApi* namespace)", () => {
  it("defaults reproduce v0.7.x literal-string behavior for the four base axes", () => {
    assert.equal(__testing.DEFAULT_CONFIG.labels.labelTokenIn, "in:");
    assert.equal(__testing.DEFAULT_CONFIG.labels.labelTokenOut, "out:");
    assert.equal(__testing.DEFAULT_CONFIG.labels.labelTokenCachedIn, "cache:");
    assert.equal(__testing.DEFAULT_CONFIG.labels.labelTokenTotalIn, "total:");
  });

  it("v0.8.13+ defaults for labelApiMs / labelApiCalls / labelTokenInSpeed / labelTokenOutSpeed match v0.8.x literals", () => {
    assert.equal(__testing.DEFAULT_CONFIG.labels.labelApiMs, "api:");
    assert.equal(__testing.DEFAULT_CONFIG.labels.labelApiCalls, "calls:");
    assert.equal(__testing.DEFAULT_CONFIG.labels.labelTokenInSpeed, "in:");
    assert.equal(__testing.DEFAULT_CONFIG.labels.labelTokenOutSpeed, "out:");
  });

  it("v0.8.17+ default for labelMemUsage matches v0.8.x literal", () => {
    assert.equal(__testing.DEFAULT_CONFIG.labels.labelMemUsage, "Mem:");
  });

  it("v0.8.22+ default for labelTokenHitRate matches the v0.8.x hardcoded 'hit:'", () => {
    // v0.8.22+ — hit-rate ratio was hardcoded "hit:" in v0.8.x R8
    // and is now surfaced in the labels namespace as
    // labelTokenHitRate (no separate labelTokenTotalOut axis —
    // m_tokenTotalOut shares labelTokenOut).
    assert.equal(__testing.DEFAULT_CONFIG.labels.labelTokenHitRate, "hit:");
  });

  it("v0.8.23+ context-window defaults reproduce the v0.8.22 hardcoded literals", () => {
    // m_contextSize / m_contextWindowsSize / m_contextUsedPercent
    // / m_contextRemainingPercent were hardcoded "size:" / "size:"
    // / "used:" / "remain:" in v0.8.22 — defaults preserve them so
    // existing renders stay byte-identical.
    assert.equal(__testing.DEFAULT_CONFIG.labels.labelContextSize, "size:");
    assert.equal(__testing.DEFAULT_CONFIG.labels.labelContextWindowsSize, "size:");
    assert.equal(__testing.DEFAULT_CONFIG.labels.labelContextUsedPercent, "used:");
    assert.equal(__testing.DEFAULT_CONFIG.labels.labelContextRemainingPercent, "remain:");
  });

  it("accepts a custom labelTokenIn; other axes keep defaults", async () => {
    writeFileSync(join(tmpDir, "config.json"), JSON.stringify({
      labels: { labelTokenIn: "Δ:" },
    }));
    const cfg = await loadConfig();
    assert.equal(cfg.labels.labelTokenIn, "Δ:");
    assert.equal(cfg.labels.labelTokenOut, "out:");
    assert.equal(cfg.labels.labelTokenCachedIn, "cache:");
    assert.equal(cfg.labels.labelTokenTotalIn, "total:");
    assert.equal(cfg.labels.labelApiMs, "api:");
    assert.equal(cfg.labels.labelApiCalls, "calls:");
    assert.equal(cfg.labels.labelTokenInSpeed, "in:");
    assert.equal(cfg.labels.labelTokenOutSpeed, "out:");
    assert.equal(cfg.labels.labelMemUsage, "Mem:");
    assert.equal(cfg.labels.labelTokenHitRate, "hit:");
  });

  it("accepts overrides for all ten axes simultaneously", async () => {
    writeFileSync(join(tmpDir, "config.json"), JSON.stringify({
      labels: {
        labelTokenIn: "In:",
        labelTokenOut: "Out:",
        labelTokenCachedIn: "Cache:",
        labelTokenTotalIn: "Total:",
        labelApiMs: "ms:",
        labelApiCalls: "calls²:",
        labelTokenInSpeed: "speed-in:",
        labelTokenOutSpeed: "speed-out:",
        labelMemUsage: "RAM:",
        labelTokenHitRate: "CacheRate:",
      },
    }));
    const cfg = await loadConfig();
    assert.equal(cfg.labels.labelTokenIn, "In:");
    assert.equal(cfg.labels.labelTokenOut, "Out:");
    assert.equal(cfg.labels.labelTokenCachedIn, "Cache:");
    assert.equal(cfg.labels.labelTokenTotalIn, "Total:");
    assert.equal(cfg.labels.labelApiMs, "ms:");
    assert.equal(cfg.labels.labelApiCalls, "calls²:");
    assert.equal(cfg.labels.labelTokenInSpeed, "speed-in:");
    assert.equal(cfg.labels.labelTokenOutSpeed, "speed-out:");
    assert.equal(cfg.labels.labelMemUsage, "RAM:");
    assert.equal(cfg.labels.labelTokenHitRate, "CacheRate:");
  });

  it("rejects a non-string label field and warns", async () => {
    writeFileSync(join(tmpDir, "config.json"), JSON.stringify({
      labels: { labelTokenIn: 42 },
    }));
    const cfg = await loadConfig();
    assert.equal(cfg.labels.labelTokenIn, "in:");
    assert.match(capturedStderr, /labels\.labelTokenIn/);
  });

  it("rejects non-string v0.8.22+ label fields and warns", async () => {
    writeFileSync(join(tmpDir, "config.json"), JSON.stringify({
      labels: { labelApiMs: 42, labelTokenHitRate: 99 },
    }));
    const cfg = await loadConfig();
    assert.equal(cfg.labels.labelApiMs, "api:");
    assert.equal(cfg.labels.labelTokenHitRate, "hit:");
    assert.match(capturedStderr, /labels\.labelApiMs/);
    assert.match(capturedStderr, /labels\.labelTokenHitRate/);
  });

  it("rejects labels as a non-object and warns", async () => {
    writeFileSync(join(tmpDir, "config.json"), JSON.stringify({
      labels: "nope",
    }));
    const cfg = await loadConfig();
    assert.equal(cfg.labels.labelTokenIn, "in:");
    assert.match(capturedStderr, /labels must be an object/);
  });
});

// v0.8.22+ — old v0.8.13–v0.8.21 names are NOT aliases anymore.
// They are dropped with a one-shot warn so a stale config surfaces
// in the postmortem log. We deliberately do NOT mirror values
// silently: a stray old name adopting a new prefix would mask
// config bugs and a noisy warn + drop is the right failure mode.
// Users must rename in their config.json (labelIn → labelTokenIn,
// labelOut → labelTokenOut, labelCacheIn → labelTokenCachedIn,
// labelTotalIn → labelTokenTotalIn, labelApi → labelApiMs,
// labelInSpeed → labelTokenInSpeed,
// labelOutSpeed → labelTokenOutSpeed).
// labelApiCalls and labelMemUsage were not renamed — they keep
// the same identifier.
describe("loadConfig — labels v0.8.22+ removed names", () => {
  it("labelIn triggers a 'removed' warn and is dropped (default retained)", async () => {
    writeFileSync(join(tmpDir, "config.json"), JSON.stringify({
      labels: { labelIn: "Δ:" },
    }));
    const cfg = await loadConfig();
    assert.equal(cfg.labels.labelTokenIn, "in:");
    assert.match(capturedStderr, /labels\.labelIn is removed in v0\.8\.22/);
  });

  it("labelOut triggers a 'removed' warn and is dropped", async () => {
    writeFileSync(join(tmpDir, "config.json"), JSON.stringify({
      labels: { labelOut: "Out2:" },
    }));
    const cfg = await loadConfig();
    assert.equal(cfg.labels.labelTokenOut, "out:");
    assert.match(capturedStderr, /labels\.labelOut is removed in v0\.8\.22/);
  });

  it("labelCacheIn triggers a 'removed' warn and is dropped", async () => {
    writeFileSync(join(tmpDir, "config.json"), JSON.stringify({
      labels: { labelCacheIn: "Cache2:" },
    }));
    const cfg = await loadConfig();
    assert.equal(cfg.labels.labelTokenCachedIn, "cache:");
    assert.match(capturedStderr, /labels\.labelCacheIn is removed in v0\.8\.22/);
  });

  it("labelTotalIn triggers a 'removed' warn and is dropped", async () => {
    writeFileSync(join(tmpDir, "config.json"), JSON.stringify({
      labels: { labelTotalIn: "Tot2:" },
    }));
    const cfg = await loadConfig();
    assert.equal(cfg.labels.labelTokenTotalIn, "total:");
    assert.match(capturedStderr, /labels\.labelTotalIn is removed in v0\.8\.22/);
  });

  it("labelApi triggers a 'removed' warn and is dropped", async () => {
    writeFileSync(join(tmpDir, "config.json"), JSON.stringify({
      labels: { labelApi: "ms2:" },
    }));
    const cfg = await loadConfig();
    assert.equal(cfg.labels.labelApiMs, "api:");
    assert.match(capturedStderr, /labels\.labelApi is removed in v0\.8\.22/);
  });

  it("labelInSpeed triggers a 'removed' warn and is dropped", async () => {
    writeFileSync(join(tmpDir, "config.json"), JSON.stringify({
      labels: { labelInSpeed: "speedIn2:" },
    }));
    const cfg = await loadConfig();
    assert.equal(cfg.labels.labelTokenInSpeed, "in:");
    assert.match(capturedStderr, /labels\.labelInSpeed is removed in v0\.8\.22/);
  });

  it("labelOutSpeed triggers a 'removed' warn and is dropped", async () => {
    writeFileSync(join(tmpDir, "config.json"), JSON.stringify({
      labels: { labelOutSpeed: "speedOut2:" },
    }));
    const cfg = await loadConfig();
    assert.equal(cfg.labels.labelTokenOutSpeed, "out:");
    assert.match(capturedStderr, /labels\.labelOutSpeed is removed in v0\.8\.22/);
  });

  it("labelTokenTotalOut (transient v0.8.22 axis) is rejected — no separate field exists", async () => {
    writeFileSync(join(tmpDir, "config.json"), JSON.stringify({
      labels: { labelTokenTotalOut: "TotalOut:" },
    }));
    const cfg = await loadConfig();
    // labelTokenTotalOut is not a Config.labels field; the warn
    // fires and the value is NOT mirrored to labelTokenOut.
    assert.equal(cfg.labels.labelTokenOut, "out:");
    assert.match(capturedStderr, /labels\.labelTokenTotalOut is removed in v0\.8\.22/);
  });

  it("new name is unaffected when both new + old are present", async () => {
    writeFileSync(join(tmpDir, "config.json"), JSON.stringify({
      labels: {
        labelIn: "old-value:",
        labelTokenIn: "new-value:",
      },
    }));
    const cfg = await loadConfig();
    assert.equal(cfg.labels.labelTokenIn, "new-value:");
    assert.match(capturedStderr, /labels\.labelIn is removed in v0\.8\.22/);
  });
});

describe("configStore.setVersion (v0.2.17)", () => {
  it("mutates cfg().version", () => {
    __resetForTest();
    assert.equal(configStore.get().version, "");
    configStore.setVersion("0.2.17");
    assert.equal(configStore.get().version, "0.2.17");
    __resetForTest();
    // Re-read the singleton — __resetForTest installs a fresh object.
    assert.equal(configStore.get().version, "");
  });
});

// ----- providers (v0.2.21) -----
//
// The providers block is a Record<string, ProviderEntry>. The defaults
// reproduce v0.2.20's hardcoded behavior; user config deep-merges on
// top. A partial user entry inherits the missing fields from the
// default; an invalid field on an otherwise-OK entry drops the whole
// entry (no partial-apply — a half-configured provider could fetch
// from the wrong endpoint).
describe("loadConfig — providers (defaults)", () => {
  it("reproduces the v0.2.20 hardcoded values", () => {
    const cfg = __testing.DEFAULT_CONFIG;
    assert.equal(cfg.providers.minimax.TYPE, "TOKEN_PLAN");
    assert.equal(cfg.providers.minimax.BASE_URL_COMPARED_TO,
      "https://api.minimaxi.com/anthropic");
    assert.equal(cfg.providers.minimax.COMPARE_METHOD, "EXACT");
    assert.equal(cfg.providers.minimax.ENDPOINT,
      "https://www.minimaxi.com/v1/token_plan/remains");
    assert.equal(cfg.providers.deepseek.TYPE, "BALANCE");
    assert.equal(cfg.providers.deepseek.BASE_URL_COMPARED_TO,
      "https://api.deepseek.com/anthropic");
    assert.equal(cfg.providers.deepseek.COMPARE_METHOD, "EXACT");
    assert.equal(cfg.providers.deepseek.ENDPOINT,
      "https://api.deepseek.com/user/balance");
  });

  it("is included in the merged config when the user has no providers key", async () => {
    writeFileSync(
      join(tmpDir, "config.json"),
      JSON.stringify({ cacheTtlMs: 30_000 }),
    );
    const cfg = await loadConfig();
    assert.deepEqual(cfg.providers, __testing.DEFAULT_CONFIG.providers);
    assert.equal(capturedStderr, "");
  });
});

describe("loadConfig — providers (full override)", () => {
  it("replaces a provider's fields when the user provides the full entry", async () => {
    writeFileSync(
      join(tmpDir, "config.json"),
      JSON.stringify({
        providers: {
          minimax: {
            TYPE: "TOKEN_PLAN",
            BASE_URL_COMPARED_TO: "https://staging.minimaxi.com/anthropic",
            COMPARE_METHOD: "INCLUDE",
            ENDPOINT: "https://staging.minimaxi.com/v1/token_plan/remains",
          },
        },
      }),
    );
    const cfg = await loadConfig();
    assert.equal(cfg.providers.minimax.BASE_URL_COMPARED_TO,
      "https://staging.minimaxi.com/anthropic");
    assert.equal(cfg.providers.minimax.COMPARE_METHOD, "INCLUDE");
    // deepseek entry stays at its default (deep-merge, not replace).
    assert.equal(cfg.providers.deepseek.BASE_URL_COMPARED_TO,
      "https://api.deepseek.com/anthropic");
  });
});

describe("loadConfig — providers (partial override)", () => {
  it("fills missing fields from the default when the user provides only one", async () => {
    // The user just wants to swap the ENDPOINT — they shouldn't have
    // to restate TYPE / BASE_URL_COMPARED_TO / COMPARE_METHOD.
    writeFileSync(
      join(tmpDir, "config.json"),
      JSON.stringify({
        providers: {
          minimax: {
            ENDPOINT: "https://internal.proxy.example/token_plan/remains",
          },
        },
      }),
    );
    const cfg = await loadConfig();
    assert.equal(cfg.providers.minimax.TYPE, "TOKEN_PLAN");
    assert.equal(cfg.providers.minimax.BASE_URL_COMPARED_TO,
      "https://api.minimaxi.com/anthropic");
    assert.equal(cfg.providers.minimax.COMPARE_METHOD, "EXACT");
    assert.equal(cfg.providers.minimax.ENDPOINT,
      "https://internal.proxy.example/token_plan/remains");
    // No stderr noise — partial override is the documented happy path.
    assert.equal(capturedStderr, "");
  });

  it("merges each provided field independently (e.g. just COMPARE_METHOD)", async () => {
    writeFileSync(
      join(tmpDir, "config.json"),
      JSON.stringify({
        providers: {
          deepseek: { COMPARE_METHOD: "STARTWITH" },
        },
      }),
    );
    const cfg = await loadConfig();
    assert.equal(cfg.providers.deepseek.COMPARE_METHOD, "STARTWITH");
    assert.equal(cfg.providers.deepseek.TYPE, "BALANCE");
    assert.equal(cfg.providers.deepseek.ENDPOINT,
      "https://api.deepseek.com/user/balance");
    assert.equal(capturedStderr, "");
  });
});

describe("loadConfig — providers (new key)", () => {
  it("appends a user-defined provider not in DEFAULT_PROVIDERS", async () => {
    writeFileSync(
      join(tmpDir, "config.json"),
      JSON.stringify({
        providers: {
          moonshot: {
            TYPE: "BALANCE",
            BASE_URL_COMPARED_TO: "https://api.moonshot.cn/anthropic",
            COMPARE_METHOD: "EXACT",
            ENDPOINT: "https://api.moonshot.cn/v1/users/me/balance",
          },
        },
      }),
    );
    const cfg = await loadConfig();
    assert.ok(cfg.providers.moonshot);
    assert.equal(cfg.providers.moonshot.ENDPOINT,
      "https://api.moonshot.cn/v1/users/me/balance");
    // Existing defaults still present.
    assert.ok(cfg.providers.minimax);
    assert.ok(cfg.providers.deepseek);
    assert.equal(capturedStderr, "");
  });
});

describe("loadConfig — providers (validation)", () => {
  it("drops an entry with an invalid TYPE and warns", async () => {
    writeFileSync(
      join(tmpDir, "config.json"),
      JSON.stringify({
        providers: {
          minimax: { TYPE: "WHATEVER", BASE_URL_COMPARED_TO: "x",
            COMPARE_METHOD: "EXACT", ENDPOINT: "https://x.example/foo" },
        },
      }),
    );
    const cfg = await loadConfig();
    // The malformed minimax entry is dropped; deepseek is preserved.
    assert.equal(cfg.providers.minimax, undefined);
    assert.ok(cfg.providers.deepseek);
    assert.match(capturedStderr, /provider TYPE/);
  });

  it("drops an entry with an empty BASE_URL_COMPARED_TO and warns", async () => {
    writeFileSync(
      join(tmpDir, "config.json"),
      JSON.stringify({
        providers: {
          minimax: { TYPE: "TOKEN_PLAN", BASE_URL_COMPARED_TO: "",
            COMPARE_METHOD: "EXACT", ENDPOINT: "https://x.example/foo" },
        },
      }),
    );
    const cfg = await loadConfig();
    assert.equal(cfg.providers.minimax, undefined);
    assert.match(capturedStderr, /BASE_URL_COMPARED_TO/);
  });

  it("drops an entry with an out-of-enum COMPARE_METHOD and warns", async () => {
    writeFileSync(
      join(tmpDir, "config.json"),
      JSON.stringify({
        providers: {
          minimax: { TYPE: "TOKEN_PLAN", BASE_URL_COMPARED_TO: "x",
            COMPARE_METHOD: "REGEX", ENDPOINT: "https://x.example/foo" },
        },
      }),
    );
    const cfg = await loadConfig();
    assert.equal(cfg.providers.minimax, undefined);
    assert.match(capturedStderr, /COMPARE_METHOD/);
  });

  it("warns on a non-http(s) ENDPOINT but keeps the entry (exec transport)", async () => {
    // vX.X.X+ — non-http ENDPOINTs are now accepted as shell
    // commands (execTransport in src/api.ts). The validator logs a
    // warning so the user notices if they typo'd a URL but still
    // loads the entry, because that's the whole point of the
    // query_plugins/exec feature.
    writeFileSync(
      join(tmpDir, "config.json"),
      JSON.stringify({
        providers: {
          minimax: { TYPE: "TOKEN_PLAN", BASE_URL_COMPARED_TO: "x",
            COMPARE_METHOD: "EXACT", ENDPOINT: "file:///etc/passwd" },
        },
      }),
    );
    const cfg = await loadConfig();
    assert.ok(cfg.providers.minimax);
    assert.match(capturedStderr, /ENDPOINT.*shell command|ENDPOINT.*does not start with/);
  });

  it("drops a non-object provider entry and warns", async () => {
    writeFileSync(
      join(tmpDir, "config.json"),
      JSON.stringify({ providers: { minimax: "not-an-object" } }),
    );
    const cfg = await loadConfig();
    assert.equal(cfg.providers.minimax, undefined);
    assert.match(capturedStderr, /provider entry must be an object/);
  });

  it("falls back to all defaults when the providers block is not an object", async () => {
    writeFileSync(
      join(tmpDir, "config.json"),
      JSON.stringify({ providers: "nope" }),
    );
    const cfg = await loadConfig();
    assert.deepEqual(cfg.providers, __testing.DEFAULT_CONFIG.providers);
    assert.match(capturedStderr, /providers must be an object/);
  });

  it("isolates a bad entry: deepseek stays valid even if minimax is malformed", async () => {
    writeFileSync(
      join(tmpDir, "config.json"),
      JSON.stringify({
        providers: {
          minimax: { TYPE: "BOGUS", BASE_URL_COMPARED_TO: "x",
            COMPARE_METHOD: "EXACT", ENDPOINT: "https://x.example/foo" },
          // deepseek: untouched → defaults apply.
        },
      }),
    );
    const cfg = await loadConfig();
    assert.equal(cfg.providers.minimax, undefined);
    assert.deepEqual(cfg.providers.deepseek,
      __testing.DEFAULT_CONFIG.providers.deepseek);
  });
});

describe("applyProviderOverrides — three-layer precedence", () => {
  // v0.4.0+ — `providerEntry.config` lets a user override ANY top-level
  // config key for one specific provider. Three-layer precedence:
  //   defaults  ⊕  config.json top-level  ⊕  providerEntry.config
  //             (lowest)                  (highest)
  // Tests below use __resetForTest to set a known baseline (the
  // "user-level config" layer), then call applyProviderOverrides to
  // simulate index.ts:main() merging the provider layer on top.

  it("provider.config overrides a top-level field (cacheTtlMs)", () => {
    __resetForTest({ cacheTtlMs: 30_000 });
    assert.equal(configStore.get().cacheTtlMs, 30_000);
    applyProviderOverrides({ cacheTtlMs: 5_000 });
    assert.equal(configStore.get().cacheTtlMs, 5_000, "provider override wins");
  });

  it("provider.config preserves fields it does NOT override", () => {
    __resetForTest({
      cacheTtlMs: 30_000,
      display: "remaining",
      timeFormat: { minUnit: "s", maxUnitCount: 4 },
    });
    applyProviderOverrides({ fetchTimeoutMs: 9_000 });
    const cfg = configStore.get();
    // Overridden → new value
    assert.equal(cfg.fetchTimeoutMs, 9_000);
    // Untouched → user-level value preserved
    assert.equal(cfg.cacheTtlMs, 30_000);
    assert.equal(cfg.display, "remaining");
    assert.equal(cfg.timeFormat.minUnit, "s");
    assert.equal(cfg.timeFormat.maxUnitCount, 4);
  });

  it("provider.config can override nested object fields (colors)", () => {
    __resetForTest();
    applyProviderOverrides({
      colors: { red: "\x1b[38;5;201m" },
    });
    const cfg = configStore.get();
    // Overridden → new value
    assert.equal(cfg.colors.red, "\x1b[38;5;201m");
    // Untouched → default preserved
    assert.equal(cfg.colors.brightGreen, DEFAULT_CONFIG.colors.brightGreen);
  });

  it("provider.config can override statuslineTemplate (v0.8.14+ string[] form)", () => {
    __resetForTest();
    // v0.8.14+ — `statuslineTemplate` is always `string[]`. Test
    // passes an array via provider.config override; the only form
    // the loader accepts at the provider-config layer is also `string[]`.
    const tokens = ["m_modeLabel", "s_0", "m_window|term:short"];
    applyProviderOverrides({
      statuslineTemplate: tokens,
    });
    const cfg = configStore.get();
    assert.deepEqual(cfg.statuslineTemplate, tokens);
    // Other fields untouched.
    assert.equal(cfg.cacheTtlMs, DEFAULT_CONFIG.cacheTtlMs);
  });

  it("provider.config can override lineTemplates (user-defined key)", () => {
    __resetForTest();
    applyProviderOverrides({
      lineTemplates: { foo: ["m_modeLabel", "s_0", "m_balance"] },
    });
    const cfg = configStore.get();
    assert.deepEqual(cfg.lineTemplates.foo, ["m_modeLabel", "s_0", "m_balance"]);
  });

  it("rejects a nested 'providers' key and warns", () => {
    __resetForTest();
    // Capture baseline before the bad override.
    const before = JSON.stringify(configStore.get().colors);
    applyProviderOverrides({
      providers: { evil: {} }, // should be stripped with a warn
    });
    const after = JSON.stringify(configStore.get().colors);
    assert.equal(after, before, "providers key must not affect the snapshot");
    assert.match(capturedStderr, /must not contain a nested 'providers'/);
  });

  it("invalid field values fall back to the prior layer (not defaults)", () => {
    __resetForTest({ cacheTtlMs: 30_000 });
    applyProviderOverrides({ cacheTtlMs: -1 }); // invalid: not positive
    // After provider-config rejects -1, the active value should be the
    // user-level 30_000 (the layer beneath provider-config), NOT the
    // hardcoded default of 60_000. Three-layer semantics: each layer
    // falls back to the layer below it, not to the bottom.
    assert.equal(configStore.get().cacheTtlMs, 30_000);
    assert.match(capturedStderr, /cacheTtlMs must be a positive number/);
  });

  it("empty provider.config is a no-op", () => {
    __resetForTest({ cacheTtlMs: 42_000 });
    applyProviderOverrides({});
    assert.equal(configStore.get().cacheTtlMs, 42_000);
  });

  it("stale-on-error: bad provider.config field leaves other fields intact", () => {
    __resetForTest({
      cacheTtlMs: 30_000,
      fetchTimeoutMs: 9_000,
    });
    applyProviderOverrides({
      // Valid override on one field…
      timeFormat: { minUnit: "s" },
      // …alongside an invalid override on another field (bad value).
      cacheTtlMs: -1, // invalid: not positive
    });
    const cfg = configStore.get();
    // timeFormat.minUnit: provider override wins.
    assert.equal(cfg.timeFormat.minUnit, "s");
    // cacheTtlMs: bad value rejected → falls back to the user-level
    // value (30_000), not the hardcoded default.
    assert.equal(cfg.cacheTtlMs, 30_000);
    // fetchTimeoutMs: untouched → user-level value preserved.
    assert.equal(cfg.fetchTimeoutMs, 9_000);
    assert.match(capturedStderr, /cacheTtlMs must be a positive number/);
  });
});

describe("validateProviderEntry — config block (v0.4.0+)", () => {
  // The shape validator (called by mergeConfig during config.json load)
  // ensures the `config` key is a plain object and rejects a nested
  // `providers` key. Per-field validation happens later, when
  // applyProviderOverrides runs the merged view through the same
  // validators as the top-level config.

  it("drops a provider entry whose config is not an object", async () => {
    writeFileSync(
      join(tmpDir, "config.json"),
      JSON.stringify({
        providers: {
          minimax: {
            TYPE: "TOKEN_PLAN",
            BASE_URL_COMPARED_TO: "x",
            COMPARE_METHOD: "EXACT",
            ENDPOINT: "https://x.example/foo",
            config: "not-an-object",
          },
        },
      }),
    );
    const cfg = await loadConfig();
    assert.equal(cfg.providers.minimax, undefined);
    assert.match(capturedStderr, /provider\.config must be an object/);
  });

  it("drops a provider entry whose config contains a nested 'providers' key", async () => {
    writeFileSync(
      join(tmpDir, "config.json"),
      JSON.stringify({
        providers: {
          minimax: {
            TYPE: "TOKEN_PLAN",
            BASE_URL_COMPARED_TO: "x",
            COMPARE_METHOD: "EXACT",
            ENDPOINT: "https://x.example/foo",
            config: { providers: { evil: {} } },
          },
        },
      }),
    );
    const cfg = await loadConfig();
    assert.equal(cfg.providers.minimax, undefined);
    assert.match(capturedStderr, /must not contain a nested 'providers'/);
  });

  it("accepts a provider entry with an empty config block", async () => {
    writeFileSync(
      join(tmpDir, "config.json"),
      JSON.stringify({
        providers: {
          minimax: {
            TYPE: "TOKEN_PLAN",
            BASE_URL_COMPARED_TO: "x",
            COMPARE_METHOD: "EXACT",
            ENDPOINT: "https://x.example/foo",
            config: {},
          },
        },
      }),
    );
    const cfg = await loadConfig();
    assert.ok(cfg.providers.minimax);
    assert.deepEqual(cfg.providers.minimax.config, {});
  });

  it("forwards a valid config block onto the validated entry", async () => {
    writeFileSync(
      join(tmpDir, "config.json"),
      JSON.stringify({
        providers: {
          minimax: {
            TYPE: "TOKEN_PLAN",
            BASE_URL_COMPARED_TO: "x",
            COMPARE_METHOD: "EXACT",
            ENDPOINT: "https://x.example/foo",
            config: { cacheTtlMs: 5_000, fetchTimeoutMs: 3_000 },
          },
        },
      }),
    );
    const cfg = await loadConfig();
    assert.ok(cfg.providers.minimax);
    assert.deepEqual(cfg.providers.minimax.config, {
      cacheTtlMs: 5_000,
      fetchTimeoutMs: 3_000,
    });
  });
});

// ----- v0.6.0+ HTTP overrides on ProviderEntry -----
//
// Each new field is validated independently at config-load time:
//   BEARER_KEY / BODY  → LENIENT (drop the field, keep the entry)
//   METHOD             → STRICT (drop the whole entry on bad value)
//
// These tests exercise mergeConfig → validateProviderEntry through
// the public loadConfig path so we cover the same warn-on-stderr
// behavior as existing tests.
describe("validateProviderEntry — v0.6.0 HTTP overrides", () => {
  const base = {
    TYPE: "TOKEN_PLAN",
    BASE_URL_COMPARED_TO: "https://api.example.com",
    COMPARE_METHOD: "EXACT",
    ENDPOINT: "https://api.example.com/v1/usage",
  };

  it("accepts a full BEARER_KEY/METHOD/BODY block", async () => {
    writeFileSync(
      join(tmpDir, "config.json"),
      JSON.stringify({
        providers: {
          custom: {
            ...base,
            BEARER_KEY: "secret-key",
            METHOD: "POST",
            BODY: { team: "alpha", n: 1 },
          },
        },
      }),
    );
    const cfg = await loadConfig();
    assert.ok(cfg.providers.custom);
    assert.equal(cfg.providers.custom.BEARER_KEY, "secret-key");
    assert.equal(cfg.providers.custom.METHOD, "POST");
    assert.deepEqual(cfg.providers.custom.BODY, { team: "alpha", n: 1 });
    assert.equal(capturedStderr, "");
  });

  it("drops the whole entry on a bad METHOD value", async () => {
    writeFileSync(
      join(tmpDir, "config.json"),
      JSON.stringify({
        providers: {
          bad: { ...base, METHOD: "FETCH" },
        },
      }),
    );
    const cfg = await loadConfig();
    assert.equal(cfg.providers.bad, undefined, "entry must be dropped");
    assert.match(capturedStderr, /METHOD must be one of/);
  });

  it("drops just BODY when BODY is an array (lenient)", async () => {
    writeFileSync(
      join(tmpDir, "config.json"),
      JSON.stringify({
        providers: {
          partial: { ...base, BODY: [1, 2, 3] },
        },
      }),
    );
    const cfg = await loadConfig();
    assert.ok(cfg.providers.partial, "entry must survive a bad BODY");
    assert.equal(
      cfg.providers.partial.BODY,
      undefined,
      "BODY field must be dropped",
    );
    assert.match(capturedStderr, /BODY must be a plain object/);
  });

  it("drops just BEARER_KEY when it's an empty string (lenient)", async () => {
    writeFileSync(
      join(tmpDir, "config.json"),
      JSON.stringify({
        providers: {
          partial2: { ...base, BEARER_KEY: "" },
        },
      }),
    );
    const cfg = await loadConfig();
    assert.ok(cfg.providers.partial2, "entry must survive a bad BEARER_KEY");
    assert.equal(
      cfg.providers.partial2.BEARER_KEY,
      undefined,
      "BEARER_KEY field must be dropped",
    );
    assert.match(capturedStderr, /BEARER_KEY must be a non-empty string/);
  });
});

// ----- v0.X.X+ ENDPOINT="" routed to query_plugins/<id>/index.{js,mjs} -----
//
// The validator used to drop any provider entry with an empty ENDPOINT,
// which silently broke the "wire a bundled plugin script" workflow
// (kimi being the first real user): the entry dropped → matchProvider
// returned null → providerType === "unknown" → every type:"plan"/
// "balance" module silently disappeared from the render. Fix: when
// ENDPOINT is the empty string, look up query_plugins/<id>/index.js
// (then .mjs) and accept if either exists; otherwise keep the old
// drop+warn.
//
// These tests mock HOME/USERPROFILE so queryPluginsDir() resolves
// under tmpDir, mirroring the pattern in src/api.test.ts:723-738.
describe("validateProviderEntry — ENDPOINT=\"\" + query_plugins presence", () => {
  const base = {
    TYPE: "TOKEN_PLAN",
    BASE_URL_COMPARED_TO: "https://api.example.com",
    COMPARE_METHOD: "EXACT",
  };
  let sandbox: string;
  let originalHome: string | undefined;
  let originalProfile: string | undefined;

  beforeEach(() => {
    sandbox = mkdtempSync(join(tmpdir(), "topgauge-cc-validate-plugin-"));
    originalHome = process.env.HOME;
    originalProfile = process.env.USERPROFILE;
    // queryPluginsDir() uses homedir() which honors USERPROFILE on
    // Windows and HOME elsewhere — override both so the resolved
    // query_plugins root lands inside our sandbox.
    process.env.HOME = sandbox;
    process.env.USERPROFILE = sandbox;
  });

  afterEach(() => {
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
    if (originalProfile === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = originalProfile;
    rmSync(sandbox, { recursive: true, force: true });
  });

  it("accepts ENDPOINT=\"\" when query_plugins/<id>/index.js exists", async () => {
    const pluginDir = join(queryPluginsDir(), "kimi");
    mkdirSync(pluginDir, { recursive: true });
    writeFileSync(join(pluginDir, "index.js"), "process.stdout.write('{}');");

    writeFileSync(
      join(tmpDir, "config.json"),
      JSON.stringify({
        providers: { kimi: { ...base, ENDPOINT: "" } },
      }),
    );
    const cfg = await loadConfig();
    assert.ok(cfg.providers.kimi, "entry must survive when plugin file is present");
    assert.equal(cfg.providers.kimi.ENDPOINT, "");
    assert.equal(capturedStderr, "");
  });

  it("accepts ENDPOINT=\"\" when only index.mjs is present (no .js)", async () => {
    const pluginDir = join(queryPluginsDir(), "kimi");
    mkdirSync(pluginDir, { recursive: true });
    writeFileSync(join(pluginDir, "index.mjs"), "export default {};");

    writeFileSync(
      join(tmpDir, "config.json"),
      JSON.stringify({
        providers: { kimi: { ...base, ENDPOINT: "" } },
      }),
    );
    const cfg = await loadConfig();
    assert.ok(cfg.providers.kimi, ".mjs fallback must also satisfy the validator");
    assert.equal(capturedStderr, "");
  });

  it("drops ENDPOINT=\"\" when neither index.js nor index.mjs exists", async () => {
    // Don't create any plugin file under queryPluginsDir("kimi").
    writeFileSync(
      join(tmpDir, "config.json"),
      JSON.stringify({
        providers: { kimi: { ...base, ENDPOINT: "" } },
      }),
    );
    const cfg = await loadConfig();
    assert.equal(cfg.providers.kimi, undefined, "entry must be dropped without a plugin file");
    assert.match(capturedStderr, /ENDPOINT="" but no query_plugins\/kimi\/index/);
  });

  it("does not affect non-empty ENDPOINT (regression guard)", async () => {
    // Make sure the new branch did not loosen the existing http/exec path.
    writeFileSync(
      join(tmpDir, "config.json"),
      JSON.stringify({
        providers: {
          kimi: { ...base, ENDPOINT: "https://api.example.com/kimi" },
        },
      }),
    );
    const cfg = await loadConfig();
    assert.ok(cfg.providers.kimi);
    // The non-http warn only fires for empty or non-http — https should
    // be silent.
    assert.equal(capturedStderr, "");
  });
});

// ----- v0.X.X+ resolveEffectiveIntervals 4-layer merge -----
//
// The 4 layers are merged in order (each overlays fields on the
// previous). Layer 1 and layer 3 fire ONLY when the active provider
// id matches the layer's key — so a kimi active provider never
// inherits minimax defaults, and a user's providers.minimax.intervals
// block is never applied to a non-minimax provider.
//
//   layer 0  GLOBAL_DEFAULT_INTERVALS              (always)
//   layer 1  BUILTIN_PROVIDER_INTERVALS[id]        (id-gated)
//   layer 2  configStore.get().intervals           (always)
//   layer 3  entry.intervals                        (id-gated)
//
// Seed the configStore via __resetForTest — applyProviderOverrides
// rejects `providers` (it would recurse), so providers are seeded
// only via the test hook.
describe("resolveEffectiveIntervals — 4-layer merge", () => {
  beforeEach(() => {
    // Reset to a clean DEFAULT_CONFIG so each test seeds its own
    // providers + intervals cleanly.
    __resetForTest();
  });

  it("active=minimax + no user intervals → layer 1 minimax defaults + layer 0 longInterval", () => {
    const entry = configStore.get().providers.minimax;
    assert.ok(entry);
    const r = resolveEffectiveIntervals("minimax", entry);
    // layer 1 fires for minimax: short + mid populated with model_remains[0].* paths.
    assert.equal(
      r.shortInterval?.remainingPercent,
      "model_remains.0.current_interval_remaining_percent",
    );
    assert.equal(
      r.shortInterval?.startAt,
      "model_remains.0.start_time",
    );
    assert.equal(
      r.midInterval?.remainingPercent,
      "model_remains.0.current_weekly_remaining_percent",
    );
    // longInterval has no built-in minimax mapping (layer 1 empty),
    // so layer 0's standard plugin-schema mapping wins. This is
    // fine because minimax's actual API doesn't return a 30d window,
    // so parseRemains would just leave longInterval null at runtime.
    assert.equal(r.longInterval?.windowId, "30d");
    assert.equal(r.longInterval?.remainingPercent, "longInterval.remainingPercent");
  });

  it("active=minimax + user top-level intervals → layer 2 overrides layer 1 on conflict", () => {
    __resetForTest({
      intervals: {
        shortInterval: { remainingPercent: "user.top.path" },
      },
    });
    const entry = configStore.get().providers.minimax;
    assert.ok(entry);
    const r = resolveEffectiveIntervals("minimax", entry);
    // layer 2 wins on conflict for the shared field.
    assert.equal(r.shortInterval?.remainingPercent, "user.top.path");
    // layer 1 still contributes the non-conflicting fields.
    assert.equal(r.shortInterval?.startAt, "model_remains.0.start_time");
    assert.equal(r.shortInterval?.endAt, "model_remains.0.end_time");
    // layer 1 still populates mid (no layer-2 conflict).
    assert.equal(
      r.midInterval?.remainingPercent,
      "model_remains.0.current_weekly_remaining_percent",
    );
  });

  it("active=kimi + no user intervals → layer 0 standard mapping; layer 1 minimax NOT applied", () => {
    // Seed a kimi provider so resolveEffectiveIntervals can look it up.
    __resetForTest({
      providers: {
        kimi: {
          TYPE: "TOKEN_PLAN",
          BASE_URL_COMPARED_TO: "https://kimi.example",
          COMPARE_METHOD: "EXACT",
          ENDPOINT: "https://kimi.example/quota",
        },
      },
    });
    const entry = configStore.get().providers.kimi;
    assert.ok(entry);
    const r = resolveEffectiveIntervals("kimi", entry);
    // Layer 0 (standard plugin-schema mapping) fires for kimi.
    assert.equal(r.shortInterval?.remainingPercent, "shortInterval.remainingPercent");
    assert.equal(r.shortInterval?.startAt, "shortInterval.startAt");
    assert.equal(r.shortInterval?.endAt, "shortInterval.endAt");
    assert.equal(r.shortInterval?.windowId, "5h");
    assert.equal(r.midInterval?.remainingPercent, "midInterval.remainingPercent");
    assert.equal(r.midInterval?.windowId, "7d");
    assert.equal(r.longInterval?.windowId, "30d");
    // Layer 1 (minimax model_remains[0].* paths) must NOT apply for kimi.
    assert.notEqual(
      r.shortInterval?.remainingPercent,
      "model_remains.0.current_interval_remaining_percent",
    );
  });

  it("active=kimi + user top-level intervals → layer 2 wins; layer 1 minimax still NOT applied", () => {
    __resetForTest({
      providers: {
        kimi: {
          TYPE: "TOKEN_PLAN",
          BASE_URL_COMPARED_TO: "https://kimi.example",
          COMPARE_METHOD: "EXACT",
          ENDPOINT: "https://kimi.example/quota",
        },
      },
      intervals: {
        shortInterval: { remainingPercent: "kimi.short" },
      },
    });
    const entry = configStore.get().providers.kimi;
    assert.ok(entry);
    const r = resolveEffectiveIntervals("kimi", entry);
    // layer 2 wins on conflict for shortInterval.remainingPercent.
    assert.equal(r.shortInterval?.remainingPercent, "kimi.short");
    // layer 0 still contributes the non-conflicting time fields.
    assert.equal(r.shortInterval?.startAt, "shortInterval.startAt");
    assert.equal(r.shortInterval?.windowId, "5h");
    // midInterval is unaffected by layer 2 (no user override).
    assert.equal(r.midInterval?.remainingPercent, "midInterval.remainingPercent");
    // layer 1 (minimax) still must NOT bleed in.
    assert.notEqual(
      r.shortInterval?.remainingPercent,
      "model_remains.0.current_interval_remaining_percent",
    );
  });

  it("active=kimi + providers.minimax.intervals set → layer 3 NOT applied; layer 0 still works", () => {
    // Critical gate test: even if the user has a minimax entry with
    // intervals, an active kimi provider must not pick them up.
    // Layer 0 still applies (it's unconditional), giving kimi a
    // working standard mapping out of the box.
    __resetForTest({
      providers: {
        minimax: {
          TYPE: "TOKEN_PLAN",
          BASE_URL_COMPARED_TO: "https://api.minimaxi.com/anthropic",
          COMPARE_METHOD: "EXACT",
          ENDPOINT: "https://www.minimaxi.com/v1/token_plan/remains",
          intervals: {
            shortInterval: { remainingPercent: "user.minimax.override" },
          },
        },
        kimi: {
          TYPE: "TOKEN_PLAN",
          BASE_URL_COMPARED_TO: "https://kimi.example",
          COMPARE_METHOD: "EXACT",
          ENDPOINT: "https://kimi.example/quota",
        },
      },
    });
    const kimiEntry = configStore.get().providers.kimi;
    assert.ok(kimiEntry);
    const r = resolveEffectiveIntervals("kimi", kimiEntry);
    // Layer 3 (providers.minimax.intervals) must NOT apply to kimi.
    assert.notEqual(r.shortInterval?.remainingPercent, "user.minimax.override");
    // Layer 0 still provides the standard plugin-schema mapping.
    assert.equal(r.shortInterval?.remainingPercent, "shortInterval.remainingPercent");
  });

  it("active=deepseek + no user intervals → layer 0 still fires (deepseek layer 1 is empty by design)", () => {
    // parseBalance doesn't read intervalsConfig today, but the
    // resolver still runs and produces the layer-0 mapping for
    // symmetry / future-proofing. Test that the resolver doesn't
    // blow up on BALANCE entries.
    const entry = configStore.get().providers.deepseek;
    assert.ok(entry);
    const r = resolveEffectiveIntervals("deepseek", entry);
    // Layer 1 fires for deepseek but is empty, so layer 0 wins.
    assert.equal(r.shortInterval?.remainingPercent, "shortInterval.remainingPercent");
    assert.equal(r.midInterval?.remainingPercent, "midInterval.remainingPercent");
    assert.equal(r.longInterval?.remainingPercent, "longInterval.remainingPercent");
  });

  it("active=minimax + user providers.minimax.intervals → layer 3 wins on conflict", () => {
    __resetForTest({
      providers: {
        minimax: {
          TYPE: "TOKEN_PLAN",
          BASE_URL_COMPARED_TO: "https://api.minimaxi.com/anthropic",
          COMPARE_METHOD: "EXACT",
          ENDPOINT: "https://www.minimaxi.com/v1/token_plan/remains",
          intervals: {
            shortInterval: { remainingPercent: "user.minimax.short" },
          },
        },
      },
    });
    const entry = configStore.get().providers.minimax;
    assert.ok(entry);
    const r = resolveEffectiveIntervals("minimax", entry);
    // layer 3 (user providers.minimax.intervals) wins over layer 1.
    assert.equal(r.shortInterval?.remainingPercent, "user.minimax.short");
    // Non-conflicting layer 1 fields survive.
    assert.equal(r.shortInterval?.startAt, "model_remains.0.start_time");
  });

  it("entry=null falls back to layers 0 + 2 only (no layer 1/3)", () => {
    // Defensive: null entry shouldn't crash; layers 1 and 3 just
    // don't fire.
    __resetForTest({
      intervals: {
        shortInterval: { remainingPercent: "user.top" },
      },
    });
    const r = resolveEffectiveIntervals("anything", null);
    // layer 2 wins on conflict.
    assert.equal(r.shortInterval?.remainingPercent, "user.top");
    // layer 0 still populates mid/long (unconditional).
    assert.equal(r.midInterval?.remainingPercent, "midInterval.remainingPercent");
    assert.equal(r.longInterval?.remainingPercent, "longInterval.remainingPercent");
  });

  it("layer 0 covers the kimi plugin body out of the box (parser smoke)", () => {
    // End-to-end smoke: the user's actual kimi plugin shape +
    // resolveEffectiveIntervals("kimi", entry) should produce a
    // mapping that parseRemains can use WITHOUT any user-level
    // intervalsConfig. The user only configures the provider
    // entry; the rest is the global default.
    __resetForTest({
      providers: {
        kimi: {
          TYPE: "TOKEN_PLAN",
          BASE_URL_COMPARED_TO: "https://kimi.example",
          COMPARE_METHOD: "EXACT",
          ENDPOINT: "node C:/path/to/kimi/index.js",
        },
      },
    });
    const entry = configStore.get().providers.kimi;
    assert.ok(entry);
    const r = resolveEffectiveIntervals("kimi", entry);
    // Each slot has the canonical path expressions.
    assert.equal(r.shortInterval?.remainingPercent, "shortInterval.remainingPercent");
    assert.equal(r.midInterval?.remainingPercent, "midInterval.remainingPercent");
    assert.equal(r.longInterval?.remainingPercent, "longInterval.remainingPercent");
    // Static windowId/label set per slot.
    assert.equal(r.shortInterval?.windowId, "5h");
    assert.equal(r.midInterval?.windowId, "7d");
    assert.equal(r.longInterval?.windowId, "30d");
  });
});
