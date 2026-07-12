import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  __resetForTest,
  __testing,
  configStore,
  loadConfig,
  resolveEffectiveCurrencies,
  resolveEffectiveIntervals,
} from "./config.ts";

let dir: string;
beforeEach(() => {
  __resetForTest();
  dir = mkdtempSync(join(tmpdir(), "topgauge-config-"));
  __testing.setPathResolver(() => join(dir, "config.json"));
});
afterEach(() => {
  __testing.resetPathResolver();
  __resetForTest();
  rmSync(dir, { recursive: true, force: true });
});

describe("provider defaults", () => {
  it("registers MiniMax as Quota and DeepSeek as BALANCE", () => {
    const providers = configStore.get().providers;
    assert.equal(providers.minimax.TYPE, "QUOTA");
    assert.equal(providers.deepseek.TYPE, "BALANCE");
    assert.equal("ENDPOINT" in providers.minimax, false);
  });

  it("uses AUTHENTICATION_KEY as the provider credential field", async () => {
    writeFileSync(join(dir, "config.json"), JSON.stringify({
      providers: {
        custom: {
          TYPE: "BALANCE",
          BASE_URL_COMPARED_TO: "https://custom.example/anthropic",
          COMPARE_METHOD: "EXACT",
          AUTHENTICATION_KEY: "configured",
        },
      },
    }));
    await loadConfig();
    assert.equal(configStore.get().providers.custom.AUTHENTICATION_KEY, "configured");
    assert.equal("BEARER_KEY" in (configStore.get().providers.custom as object), false);
  });
});

describe("provider mapping resolvers", () => {
  // v0.9.x — built-in default interval mappings REMOVED. The
  // minimax built-in plugin owns its own fillQuota() and doesn't
  // read ctx.intervals, so the host-side path-expression layer is
  // inert for built-ins. resolveEffectiveIntervals now returns
  // GLOBAL_DEFAULT_INTERVALS path-only defaults (which still
  // exist for plugin authors who want to drive their own plugin
  // via config — see path-expr.ts). Built-in plugins return
  // canonical Quota objects directly, bypassing this layer.
  it("ships no built-in default interval mappings for minimax", () => {
    const entry = configStore.get().providers.minimax;
    const intervals = resolveEffectiveIntervals("minimax", entry);
    // No path-expr mapping was baked in — only the global label
    // / windowId keys remain. remainingPercent is the bare
    // "shortInterval.remainingPercent" (identity, set by the
    // global defaults) — proving nothing provider-specific was
    // layered on top.
    assert.equal(intervals.shortInterval?.remainingPercent, "shortInterval.remainingPercent");
    assert.equal(intervals.midInterval?.remainingPercent, "midInterval.remainingPercent");
    assert.equal(intervals.shortInterval?.windowId, "5h");
    assert.equal(intervals.midInterval?.windowId, "7d");
  });

  it("keeps the DeepSeek CNY currency mapping", () => {
    const entry = configStore.get().providers.deepseek;
    const currencies = resolveEffectiveCurrencies("deepseek", entry);
    assert.equal(currencies.CNY?.totalBalance, "balance_infos.0.total_balance");
  });
});

describe("config facade", () => {
  it("loads rendering overrides without replacing provider defaults", async () => {
    writeFileSync(join(dir, "config.json"), JSON.stringify({
      display: "remaining",
      modeLabels: { remaining: "Left:" },
    }));
    await loadConfig();
    assert.equal(configStore.get().display, "remaining");
    assert.equal(configStore.get().modeLabels.remaining, "Left:");
    assert.equal(configStore.get().providers.minimax.TYPE, "QUOTA");
  });

  it("exposes the split template constants through config.ts", () => {
    assert.ok(__testing.DEFAULT_CONFIG.statuslineTemplate.length > 0);
    assert.ok(__testing.DEFAULT_CONFIG.lineTemplates.tokens_stat.length > 0);
  });
});

describe("statuslineTemplate — string-form preset lookup (vX.X.X+)", () => {
  // Each string-form statuslineTemplate in config.json is resolved
  // against DEFAULT_STATUSLINE_PRESETS at load time. The loader
  // clones the preset body so a later mutation doesn't leak back.
  it('"simple" resolves to the simple preset body', async () => {
    writeFileSync(join(dir, "config.json"), JSON.stringify({ statuslineTemplate: "simple" }));
    const cfg = await loadConfig();
    assert.deepEqual(cfg.statuslineTemplate[0], "m_pluginSource");
    assert.ok(cfg.statuslineTemplate.includes("m_template|quota|type:quota"));
    assert.ok(cfg.statuslineTemplate.includes("m_template|balance|type:balance"));
  });

  it('"standard" resolves to the standard preset body', async () => {
    writeFileSync(join(dir, "config.json"), JSON.stringify({ statuslineTemplate: "standard" }));
    const cfg = await loadConfig();
    assert.ok(cfg.statuslineTemplate[0].startsWith("m_template|information"));
    assert.ok(cfg.statuslineTemplate.includes("m_template|tick_eval"));
    assert.ok(cfg.statuslineTemplate.includes("m_template|stat_eval"));
    assert.ok(cfg.statuslineTemplate.includes("m_version|color:yellow"));
  });

  it('"abundant" resolves to the abundant preset body', async () => {
    writeFileSync(join(dir, "config.json"), JSON.stringify({ statuslineTemplate: "abundant" }));
    const cfg = await loadConfig();
    assert.ok(cfg.statuslineTemplate[0].startsWith("m_template|information"));
    assert.ok(cfg.statuslineTemplate.includes("m_template|tokens_stat|window:2h"));
    assert.ok(cfg.statuslineTemplate.includes("m_template|tokens_stat|window:5h|align:true"));
    assert.ok(cfg.statuslineTemplate.includes("m_template|tokens_stat|window:7d|align:true"));
    assert.ok(cfg.statuslineTemplate.includes("m_statTtlStatus"));
    assert.ok(cfg.statuslineTemplate.includes("m_quota|term:long|display:remaining|nulldrop:true"));
  });

  it('"compact" resolves to the compact preset body', async () => {
    // Lock the v0.9.0+ compact body shape: 4 lines, no information /
    // git_info header (that's `standard`), no quote / per-scope tokens
    // (that's `abundant`). If a future refactor re-points `compact`
    // at a different fragment, this test breaks loudly so we don't
    // silently swap a 1-line `simple` body into a 4-line slot or
    // vice-versa.
    writeFileSync(join(dir, "config.json"), JSON.stringify({ statuslineTemplate: "compact" }));
    const cfg = await loadConfig();
    // Line 0: tick_eval; line 1: acc_eval; line 2: stat_eval (each
    // followed by s_newline, so the array starts with the three
    // fragments interleaved with newlines).
    assert.equal(cfg.statuslineTemplate[0], "m_template|tick_eval");
    assert.ok(cfg.statuslineTemplate.includes("m_template|acc_eval"));
    assert.ok(cfg.statuslineTemplate.includes("m_template|stat_eval"));
    // Final line: provider-type dispatch + m_age + mem_info + version.
    assert.ok(cfg.statuslineTemplate.includes("m_pluginSource"));
    assert.ok(cfg.statuslineTemplate.includes("m_template|quota|type:quota"));
    assert.ok(cfg.statuslineTemplate.includes("m_template|balance|type:balance"));
    assert.ok(cfg.statuslineTemplate.includes("m_template|mem_info"));
    assert.ok(cfg.statuslineTemplate.includes("m_version|color:yellow"));
    // 4 logical lines = 3 newlines in the array.
    const newlines = cfg.statuslineTemplate.filter((t) => t === "s_newline").length;
    assert.equal(newlines, 3, `expected 3 s_newline (4-line layout), got ${newlines}`);
    // No header fragments (those belong to `standard` / `abundant`).
    assert.ok(!cfg.statuslineTemplate.some((t) => t.startsWith("m_template|information")));
    assert.ok(!cfg.statuslineTemplate.some((t) => t.startsWith("m_template|git_info")));
    // No quote / per-scope / per-window stat tokens (those belong to `abundant`).
    assert.ok(!cfg.statuslineTemplate.some((t) => t.startsWith("m_quote")));
    assert.ok(!cfg.statuslineTemplate.some((t) => t.startsWith("m_template|tokens_acc|scope:")));
    assert.ok(!cfg.statuslineTemplate.some((t) => t.startsWith("m_template|tokens_stat|")));
  });

  it("unknown string falls back to DEFAULT_STATUSLINE_TEMPLATE with one warn", async () => {
    writeFileSync(join(dir, "config.json"), JSON.stringify({ statuslineTemplate: "bogus" }));
    const cfg = await loadConfig();
    assert.deepEqual(cfg.statuslineTemplate, ["m_template|quota|type:quota", "m_template|balance|type:balance"]);
  });

  it("array-form statuslineTemplate still works (no preset lookup)", async () => {
    writeFileSync(
      join(dir, "config.json"),
      JSON.stringify({ statuslineTemplate: ["m_modeLabel", "s_space", "m_balance"] }),
    );
    const cfg = await loadConfig();
    assert.deepEqual(cfg.statuslineTemplate, ["m_modeLabel", "s_space", "m_balance"]);
  });

  it("fragment key (DEFAULT_LINE_TEMPLATES-only) is NOT a valid preset name", async () => {
    // tokens_tick is in DEFAULT_LINE_TEMPLATES but NOT in
    // DEFAULT_STATUSLINE_PRESETS. Setting it as statuslineTemplate
    // must fall back with a warn, NOT silently resolve.
    writeFileSync(join(dir, "config.json"), JSON.stringify({ statuslineTemplate: "tokens_tick" }));
    const cfg = await loadConfig();
    assert.deepEqual(cfg.statuslineTemplate, ["m_template|quota|type:quota", "m_template|balance|type:balance"]);
  });
});
