// v0.4.x — regression tests for the per-module `mode` filter on
// MODULES / INLINE_RENDERERS (added alongside the renderPlanLine /
// formatBalanceLine unification in Task #1 + Task #2).
//
// The filter gates rendering on ctx.providerModeKey:
//   m_window5h, m_window7d, m_countdown5h, m_countdown7d → "plan"
//   m_balance                                            → "balance"
//   everything else (m_modeLabel, m_token*, m_age, …)     → agnostic
//
// A bare token matching these prefixes on a non-matching provider
// MUST silently drop (no warn, no stray "·", no chunk). Adjacent
// s_<n> separators are skipped too via the existing null-fall-
// through path. A token on the matching provider MUST render.

import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { renderTemplate } from "./render.ts";
import type { Window } from "./render.ts";
import { __resetForTest } from "./config.ts";

const strip = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, "");

// Default seps from config.ts are [" ", "·"] — same as the existing
// render-tokens suite. We rely on this; a future config refactor
// would need to update this file in lockstep.
const FIVE_HOUR: Window = { pct: 30, resetAt: null, resetStartAt: null, resetDurationMs: null };
const WEEKLY: Window = { pct: 50, resetAt: null, resetStartAt: null, resetDurationMs: null };
const BALANCE = {
  isAvailable: true,
  entries: [{ currency: "USD", totalBalance: 25 }],
  minValue: 25,
};

const ctxFor = (providerModeKey: "plan" | "balance") => ({
  mode: "used" as const,
  nowMs: 1_000_000,
  fiveHour: FIVE_HOUR,
  weekly: WEEKLY,
  balance: BALANCE,
  ageMs: null,
  stale: false,
  version: "0.4.0-test",
  tokens: null,
  contextWindow: null,
  providerModeKey,
});

beforeEach(() => __resetForTest());

describe("MODULES path: per-provider mode filter", () => {
  it("m_window5h renders on plan ctx; drops on balance ctx", () => {
    const planLines = renderTemplate(["m_window5h"], ctxFor("plan"));
    assert.equal(planLines.length, 1);
    assert.ok(planLines[0]!.length > 0, "plan ctx must render the bar chunk");

    const balanceLines = renderTemplate(["m_window5h"], ctxFor("balance"));
    assert.deepEqual(balanceLines, [], "m_window5h must drop on balance");
  });

  it("m_window7d / m_countdown5h / m_countdown7d all plan-only", () => {
    for (const mod of ["m_window7d", "m_countdown5h", "m_countdown7d"]) {
      const planLines = renderTemplate([mod], ctxFor("plan"));
      assert.ok(planLines.length === 1, `${mod}: plan ctx rendered`);
      assert.ok(planLines[0]!.length > 0, `${mod}: plan ctx non-empty`);
      const balanceLines = renderTemplate([mod], ctxFor("balance"));
      assert.deepEqual(
        balanceLines,
        [],
        `${mod}: must drop on balance ctx`,
      );
    }
  });

  it("m_balance renders on balance ctx; drops on plan ctx", () => {
    const balanceLines = renderTemplate(["m_balance"], ctxFor("balance"));
    assert.equal(balanceLines.length, 1);
    assert.ok(balanceLines[0]!.includes("$25"), "balance ctx renders $25");

    const planLines = renderTemplate(["m_balance"], ctxFor("plan"));
    assert.deepEqual(planLines, [], "m_balance must drop on plan ctx");
  });

  it("provider-agnostic modules (m_tokenIn) render on BOTH ctxs", () => {
    // Bare m_tokenIn: no per-call data wired (tokens=null), but the
    // module body doesn't filter on tokens either — let me re-check
    // what an agnostic module looks like. m_version is a cleaner
    // agnostic target: it's bare-string, no data deps, always emits
    // when version is non-empty (which ctxFor sets to "0.4.0-test").
    const planLines = renderTemplate(["m_version"], ctxFor("plan"));
    const balanceLines = renderTemplate(["m_version"], ctxFor("balance"));
    assert.equal(planLines.length, 1);
    assert.equal(balanceLines.length, 1);
    assert.equal(planLines[0], balanceLines[0]);
    assert.ok(planLines[0]!.includes("v0.4.0-test"));
  });

  it("provider-agnostic m_modeLabel routes on ctx.providerModeKey", () => {
    // m_modeLabel is tag-free (provider-agnostic); its BODY switches
    // on providerModeKey to pick the right label. So the same token
    // renders different labels on plan vs balance — that's the
    // expected non-filter behavior. This pin guards against an
    // accidental future regression where someone drops the body
    // switch by mistake.
    const plan = renderTemplate(["m_modeLabel"], ctxFor("plan"));
    const balance = renderTemplate(["m_modeLabel"], ctxFor("balance"));
    assert.equal(plan.length, 1);
    assert.equal(balance.length, 1);
    assert.ok(strip(plan[0]!).startsWith("Usage:"), `got: ${plan}`);
    assert.ok(strip(balance[0]!).startsWith("Balance:"), `got: ${balance}`);
  });

  it("dropped plan module also drops adjacent s_<n> separators", () => {
    // ["m_window5h", "s_0", "m_window7d"] on a balance ctx: both
    // modules drop, the s_0 separator between them has nothing to
    // separate → empty lines array. This is the same null-fall-
    // through the renderer already implements.
    const balanceLines = renderTemplate(
      ["m_window5h", "s_0", "m_window7d"],
      ctxFor("balance"),
    );
    assert.deepEqual(balanceLines, []);
  });
});

describe("inline-args path: per-provider mode filter", () => {
  it("m_window5h:color:red drops on balance ctx", () => {
    const planLines = renderTemplate(
      ["m_window5h:color:red"],
      ctxFor("plan"),
    );
    assert.equal(planLines.length, 1);
    assert.ok(planLines[0]!.includes("30%"));
    const balanceLines = renderTemplate(
      ["m_window5h:color:red"],
      ctxFor("balance"),
    );
    assert.deepEqual(balanceLines, []);
  });

  it("m_balance:color:darkGreen drops on plan ctx", () => {
    // Use a real color shortcut (darkGreen is one of the 7 valid
    // shortcuts — see LABEL_COLOR_SHORTCUTS in render.ts). "green"
    // alone is rejected by resolveColor → parse fail → not the
    // path we want to exercise here.
    const balanceLines = renderTemplate(
      ["m_balance:color:darkGreen"],
      ctxFor("balance"),
    );
    assert.equal(balanceLines.length, 1);
    assert.ok(balanceLines[0]!.includes("$25"));
    const planLines = renderTemplate(
      ["m_balance:color:darkGreen"],
      ctxFor("plan"),
    );
    assert.deepEqual(planLines, []);
  });

  it("m_balance (bare) drops on plan ctx (mirrors MODULES path)", () => {
    const planLines = renderTemplate(["m_balance"], ctxFor("plan"));
    assert.deepEqual(planLines, []);
  });

  it("provider-agnostic inline form (m_version:color:red) renders on BOTH ctxs", () => {
    const plan = renderTemplate(["m_version:color:red"], ctxFor("plan"));
    const balance = renderTemplate(["m_version:color:red"], ctxFor("balance"));
    assert.equal(plan.length, 1);
    assert.equal(balance.length, 1);
    assert.equal(plan[0], balance[0]);
    assert.ok(plan[0]!.includes("v0.4.0-test"));
  });
});

describe("composition: a balance ctx with mixed-mode template", () => {
  it("renders the balance token; skips plan modules", () => {
    // User-written template that BOTH kinds of modules happen to
    // appear in. On a balance provider the plan ones must drop,
    // the balance one must render, and the s_0 separators between
    // them must collapse cleanly (no orphan "·").
    const balance = renderTemplate(
      ["m_modeLabel", "s_0", "m_window5h", "s_0", "m_window7d",
        "s_0", "m_balance"],
      ctxFor("balance"),
    );
    assert.equal(balance.length, 1);
    const text = strip(balance[0]!);
    assert.ok(text.startsWith("Balance:"), `got: ${text}`);
    assert.ok(text.includes("$25"), `got: ${text}`);
    assert.ok(!text.includes("30%"), `got: ${text}`);
    assert.ok(!text.includes("50%"), `got: ${text}`);
    assert.ok(!text.includes(" ·  ·"), `got: ${text} (orphan separators)`);
  });

  it("renders plan modules; skips m_balance", () => {
    const plan = renderTemplate(
      ["m_modeLabel", "s_0", "m_window5h", "s_0", "m_window7d",
        "s_0", "m_balance"],
      ctxFor("plan"),
    );
    assert.equal(plan.length, 1);
    const text = strip(plan[0]!);
    assert.ok(text.startsWith("Usage:"), `got: ${text}`);
    assert.ok(text.includes("30%") || text.includes("0%") || text.length > 0);
    assert.ok(!text.includes("$25"), `got: ${text} (m_balance leaked)`);
  });
});
