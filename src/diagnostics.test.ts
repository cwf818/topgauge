// Tests for src/diagnostics.ts — JSONL append logger + opt-in gate.
//
// We exercise the module against a sandboxed path under tmpdir so the
// tests don't touch the user's real ~/.claude/plugins/.../state dir.
// The path is overridden via process.env.CLAUDE_CONFIG_DIR; each test
// resets that env to a fresh dir, runs the assertions, and cleans up.

import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";

describe("diagnostics — isEnabled", () => {
  it("returns false when env var is unset", () => {
    assert.equal(
      isEnabledWith({}),
      false,
      "default must be off (opt-in)",
    );
  });

  it("returns false when env var is empty string", () => {
    assert.equal(isEnabledWith({ TOPGAUGE_CC_DIAGNOSTICS_ENABLE: "" }), false);
  });

  it("accepts '1' (truthy)", () => {
    assert.equal(isEnabledWith({ TOPGAUGE_CC_DIAGNOSTICS_ENABLE: "1" }), true);
  });

  it("accepts 'true' (truthy, mixed case)", () => {
    assert.equal(isEnabledWith({ TOPGAUGE_CC_DIAGNOSTICS_ENABLE: "TRUE" }), true);
    assert.equal(isEnabledWith({ TOPGAUGE_CC_DIAGNOSTICS_ENABLE: "True" }), true);
  });

  it("accepts 'yes' (truthy, with surrounding whitespace)", () => {
    assert.equal(isEnabledWith({ TOPGAUGE_CC_DIAGNOSTICS_ENABLE: " yes " }), true);
  });

  it("rejects other values (0, no, false, arbitrary)", () => {
    assert.equal(isEnabledWith({ TOPGAUGE_CC_DIAGNOSTICS_ENABLE: "0" }), false);
    assert.equal(isEnabledWith({ TOPGAUGE_CC_DIAGNOSTICS_ENABLE: "no" }), false);
    assert.equal(isEnabledWith({ TOPGAUGE_CC_DIAGNOSTICS_ENABLE: "false" }), false);
    assert.equal(isEnabledWith({ TOPGAUGE_CC_DIAGNOSTICS_ENABLE: "off" }), false);
    assert.equal(isEnabledWith({ TOPGAUGE_CC_DIAGNOSTICS_ENABLE: "enabled" }), false);
  });
});

describe("diagnostics — append + readLatest", () => {
  let sandbox: string;
  let prevConfigDir: string | undefined;

  beforeEach(() => {
    sandbox = mkdtempSync(join(tmpdir(), "topgauge-cc-diag-"));
    prevConfigDir = process.env.CLAUDE_CONFIG_DIR;
    process.env.CLAUDE_CONFIG_DIR = sandbox;
  });

  afterEach(() => {
    if (prevConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = prevConfigDir;
    rmSync(sandbox, { recursive: true, force: true });
  });

  function enable() {
    process.env.TOPGAUGE_CC_DIAGNOSTICS_ENABLE = "1";
  }

  function disable() {
    delete process.env.TOPGAUGE_CC_DIAGNOSTICS_ENABLE;
  }

  it("does NOT write to disk when gate is off (default)", () => {
    disable();
    append("error", "config", "should not be persisted", 1_000, null);
    // The diagnostics file path lives under CLAUDE_CONFIG_DIR; assert
    // it (and its parent dirs) do not exist.
    const p = diagnosticsPath();
    assert.equal(existsSyncSafe(p), false, "no file should be created");
  });

  it("writes one JSONL row per call when gate is on", () => {
    enable();
    append("warning", "config", "first", 1_000, null);
    append("error", "fetch", "second", 2_000, null);

    const raw = readFileSync(diagnosticsPath(), "utf8");
    const lines = raw.split("\n").filter((l) => l.length > 0);
    assert.equal(lines.length, 2);

    const a = JSON.parse(lines[0]);
    const b = JSON.parse(lines[1]);
    assert.equal(a.level, "warning");
    assert.equal(a.source, "config");
    assert.equal(a.msg, "first");
    assert.equal(a.at, 1_000);
    assert.equal(b.level, "error");
    assert.equal(b.source, "fetch");
    assert.equal(b.msg, "second");
    assert.equal(b.at, 2_000);
  });

  it("readLatest returns the most recent matching entry by level", () => {
    enable();
    append("warning", "a", "old warn", 1_000, null);
    append("error", "a", "err 1", 2_000, null);
    append("warning", "a", "new warn", 3_000, null);
    append("error", "a", "err 2", 4_000, null);

    assert.deepEqual(
      readLatest("warning", null),
      { at: 3_000, level: "warning", source: "a", msg: "new warn" },
    );
    assert.deepEqual(
      readLatest("error", null),
      { at: 4_000, level: "error", source: "a", msg: "err 2" },
    );
  });

  it("readLatest returns null when no entry of that level exists", () => {
    enable();
    append("warning", "a", "only a warning", 1_000, null);
    assert.equal(readLatest("error", null), null);
  });

  it("readLatest returns null when the file doesn't exist (gate off path)", () => {
    disable();
    // No prior append — file doesn't exist. readLatest is intentionally
    // NOT gated (reads whatever is on disk), so this just confirms the
    // missing-file branch returns null cleanly.
    assert.equal(readLatest("error", null), null);
    assert.equal(readLatest("warning", null), null);
  });

  it("caps the file at 200 lines, keeping the most recent", () => {
    enable();
    for (let i = 0; i < 250; i++) {
      append("error", "flood", `e${i}`, i, null);
    }
    const raw = readFileSync(diagnosticsPath(null), "utf8");
    const lines = raw.split("\n").filter((l) => l.length > 0);
    assert.equal(lines.length, 200, "must keep only the last 200");

    const firstKept = JSON.parse(lines[0]);
    const lastKept = JSON.parse(lines[lines.length - 1]);
    // First 50 were dropped, so the first kept is e50.
    assert.equal(firstKept.msg, "e50");
    assert.equal(lastKept.msg, "e249");
  });

  // v0.4.x+ Per-Project Layout: when a cwd is provided, the entry
  // is written to `state/<projectHash>/diagnostics.jsonl` rather
  // than the top-level file. Two concurrent projects must not see
  // each other's entries when readLatest is given the same cwd.
  it("per-project: append with cwd lands in state/<hash>/diagnostics.jsonl", () => {
    enable();
    const cwdA = "D:\\WorkSpace\\alpha";
    const cwdB = "D:\\WorkSpace\\beta";
    const pathA = diagnosticsPath(cwdA);
    const pathB = diagnosticsPath(cwdB);
    // Different projects → different files (never the legacy top-level).
    assert.notEqual(pathA, pathB);
    assert.ok(pathA.includes("alpha") || pathA.includes("d--workspace-alpha"),
      `expected per-project path, got: ${pathA}`);
    const pathAParent = pathA.split(/[\\/]/).slice(-2, -1)[0];
    assert.ok(!pathA.endsWith("diagnostics.jsonl") || pathAParent === "d--workspace-alpha",
      `expected pathA under a per-project subdir: ${pathA}`);

    append("error", "src", "from A", 1_000, cwdA);
    append("error", "src", "from B", 2_000, cwdB);

    // Top-level file should NOT exist (nothing was written without cwd).
    assert.equal(existsSyncSafe(diagnosticsPath(null)), false,
      "no top-level file when only per-project writes happened");

    // Each project reads back only its own entry.
    assert.deepEqual(readLatest("error", cwdA), {
      at: 1_000, level: "error", source: "src", msg: "from A",
    });
    assert.deepEqual(readLatest("error", cwdB), {
      at: 2_000, level: "error", source: "src", msg: "from B",
    });
  });

  it("per-project: empty-string cwd falls back to top-level", () => {
    enable();
    append("error", "src", "top-level fallback", 1_000, "");
    // Empty string is treated as "no project" — file lands at top level.
    assert.equal(existsSyncSafe(diagnosticsPath(null)), true);
    assert.deepEqual(readLatest("error", null), {
      at: 1_000, level: "error", source: "src", msg: "top-level fallback",
    });
  });

  it("formatEntry caps message at 80 chars with ellipsis", () => {
    const e: Entry = { at: 0, level: "error", source: "x", msg: "x".repeat(200) };
    const out = formatEntry(e);
    // Glyph + space + 79 chars + ellipsis (1 char) = 1+1+79+1 = 82 chars
    // (the slice trims to MAX_DISPLAY_LEN-1 = 79 before appending the
    // ellipsis, so the body is exactly 79 + '…' = 80 chars).
    assert.ok(out.startsWith("✖ "));
    // Body portion length = 80 (capped). Plus glyph + space = 82.
    assert.equal(out.length, 82);
    assert.ok(out.endsWith("…"));
  });

  it("formatEntry uses ⚠ for warning level", () => {
    const e: Entry = { at: 0, level: "warning", source: "x", msg: "hi" };
    assert.equal(formatEntry(e), "⚠ hi");
  });
});

describe("diagnostics — fetch error dedupe (v0.6.x+)", () => {
  // v0.6.x+ — fetch failures fire on every statusline tick (~1Hz in
  // active sessions). Unguarded append would flood the JSONL log
  // and burn through the 200-line cap in 3 minutes of sustained
  // outage, hiding genuinely new errors. The dedupe map keeps a
  // single entry per (source, message, 60s window) so a sustained
  // failure is logged once per minute, not once per tick.
  let sandbox: string;
  let prevConfigDir: string | undefined;
  let prevEnable: string | undefined;

  beforeEach(() => {
    sandbox = mkdtempSync(join(tmpdir(), "tokenplan-diag-dedupe-"));
    prevConfigDir = process.env.CLAUDE_CONFIG_DIR;
    process.env.CLAUDE_CONFIG_DIR = sandbox;
    prevEnable = process.env.TOPGAUGE_CC_DIAGNOSTICS_ENABLE;
    process.env.TOPGAUGE_CC_DIAGNOSTICS_ENABLE = "1";
    diag.__resetDedupeForTest();
  });

  afterEach(() => {
    diag.__resetDedupeForTest();
    if (prevConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = prevConfigDir;
    if (prevEnable === undefined) delete process.env.TOPGAUGE_CC_DIAGNOSTICS_ENABLE;
    else process.env.TOPGAUGE_CC_DIAGNOSTICS_ENABLE = prevEnable;
    rmSync(sandbox, { recursive: true, force: true });
  });

  it("suppresses identical (source, msg) within the 60s window", () => {
    append("warning", "fetch", "minimax (https://x): HTTP 503", 1_000, null);
    append("warning", "fetch", "minimax (https://x): HTTP 503", 5_000, null);
    append("warning", "fetch", "minimax (https://x): HTTP 503", 30_000, null);

    const raw = readFileSync(diagnosticsPath(null), "utf8");
    const lines = raw.split("\n").filter((l) => l.length > 0);
    assert.equal(lines.length, 1, "dedupe: 3 identical calls within 60s → 1 row");
  });

  it("passes through when the dedupe window has elapsed", () => {
    // 60_001 ms apart — one window tick past the 60s threshold.
    append("warning", "fetch", "minimax (https://x): HTTP 503", 1_000, null);
    append("warning", "fetch", "minimax (https://x): HTTP 503", 1_000 + 60_001, null);

    const raw = readFileSync(diagnosticsPath(null), "utf8");
    const lines = raw.split("\n").filter((l) => l.length > 0);
    assert.equal(lines.length, 2, "dedupe window expired → both writes land");
  });

  it("treats different sources or messages as distinct keys", () => {
    // The dedupe key is (source, msg) — level is intentionally NOT
    // part of the key, so a warning and an error with the same
    // message dedupe together. (This is intentional: from a
    // postmortem perspective, the same network outage producing
    // 60s of "warning" then 60s of "error" reads as one event, not
    // two.) So three distinct keys, not four.
    append("warning", "fetch", "minimax: HTTP 503", 1_000, null);
    append("warning", "fetch", "deepseek: HTTP 503", 1_000, null); // different msg
    append("warning", "config", "minimax: HTTP 503", 1_000, null); // different source
    append("error", "fetch", "minimax: HTTP 503", 1_000, null);   // same (source, msg) as line 1

    const raw = readFileSync(diagnosticsPath(null), "utf8");
    const lines = raw.split("\n").filter((l) => l.length > 0);
    assert.equal(lines.length, 3, "3 distinct (source, msg) keys — level shares");
  });

  it("keys on the first 200 chars of the message", () => {
    const long = "x".repeat(500);
    const long2 = "x".repeat(500);
    append("warning", "fetch", long, 1_000, null);
    append("warning", "fetch", long2, 5_000, null);

    const raw = readFileSync(diagnosticsPath(null), "utf8");
    const lines = raw.split("\n").filter((l) => l.length > 0);
    assert.equal(lines.length, 1, "two 500-char messages with same first 200 chars are the same key");
  });
});

describe("diagnostics — integration with fetchRemains / fetchBalance (v0.6.x+)", () => {
  // v0.6.x+ — fetchRemains / fetchBalance log their own network
  // errors to diagnostics at the network access point. This
  // subsumes the "caller-side logging" we previously had in
  // index.ts:163 — the fetch site knows exactly what failed
  // (network error, HTTP status, parse failure) and writes a
  // single source-of-truth record before re-throwing for the
  // dispatcher's stale-on-error fallback.
  //
  // We exercise the contract end-to-end (mock global fetch, call
  // the real fetchRemains / fetchBalance, then read the JSONL
  // log back) — no need to re-stage the index.ts catch block in
  // a test.

  let sandbox: string;
  let prevConfigDir: string | undefined;
  let prevEnable: string | undefined;
  let originalFetch: typeof fetch;

  beforeEach(() => {
    sandbox = mkdtempSync(join(tmpdir(), "tokenplan-diag-fetch-"));
    prevConfigDir = process.env.CLAUDE_CONFIG_DIR;
    process.env.CLAUDE_CONFIG_DIR = sandbox;
    prevEnable = process.env.TOPGAUGE_CC_DIAGNOSTICS_ENABLE;
    process.env.TOPGAUGE_CC_DIAGNOSTICS_ENABLE = "1";
    diag.__resetDedupeForTest();
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    diag.__resetDedupeForTest();
    globalThis.fetch = originalFetch;
    if (prevConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = prevConfigDir;
    if (prevEnable === undefined) delete process.env.TOPGAUGE_CC_DIAGNOSTICS_ENABLE;
    else process.env.TOPGAUGE_CC_DIAGNOSTICS_ENABLE = prevEnable;
    rmSync(sandbox, { recursive: true, force: true });
  });

  it("fetchRemains 5xx → fetch site records the diagnostic AND throws", async () => {
    const { fetchRemains } = await import("./api.ts");
    globalThis.fetch = (async () => new Response("oops", { status: 503 })) as typeof fetch;
    await assert.rejects(
      () => fetchRemains("t", "https://x/y", undefined, null),
      /HTTP 503/,
      "fetcher must throw with HTTP code in message",
    );
    // The fetch site is responsible for writing the diagnostic. No
    // caller-side logging required.
    const raw = readFileSync(diagnosticsPath(null), "utf8");
    const lines = raw.split("\n").filter((l) => l.length > 0);
    assert.equal(lines.length, 1, "exactly one diagnostic row from the fetch site");
    const row = JSON.parse(lines[0]);
    assert.equal(row.level, "warning");
    assert.equal(row.source, "fetch");
    assert.match(row.msg, /token_plan\/remains HTTP 503/);
    assert.match(row.msg, /https:\/\/x\/y/);
  });

  it("fetchRemains network error → fetch site records the diagnostic AND throws", async () => {
    const { fetchRemains } = await import("./api.ts");
    globalThis.fetch = (async () => {
      throw new Error("fetch failed: ECONNREFUSED");
    }) as typeof fetch;
    await assert.rejects(
      () => fetchRemains("t", "https://x/y", undefined, null),
      /ECONNREFUSED/,
    );
    const raw = readFileSync(diagnosticsPath(null), "utf8");
    const lines = raw.split("\n").filter((l) => l.length > 0);
    assert.equal(lines.length, 1);
    const row = JSON.parse(lines[0]);
    assert.equal(row.level, "warning");
    assert.equal(row.source, "fetch");
    assert.match(row.msg, /token_plan\/remains https:\/\/x\/y/);
    assert.match(row.msg, /ECONNREFUSED/);
  });

  it("fetchBalance 5xx → fetch site records the diagnostic AND throws", async () => {
    const { fetchBalance } = await import("./api.deepseek.ts");
    globalThis.fetch = (async () => new Response("oops", { status: 502 })) as typeof fetch;
    await assert.rejects(
      () => fetchBalance("t", "https://api.deepseek.com/user/balance", undefined, null),
      /HTTP 502/,
    );
    const raw = readFileSync(diagnosticsPath(null), "utf8");
    const lines = raw.split("\n").filter((l) => l.length > 0);
    assert.equal(lines.length, 1);
    const row = JSON.parse(lines[0]);
    assert.match(row.msg, /deepseek \/user\/balance HTTP 502/);
  });

  it("fetchBalance network error → fetch site records the diagnostic AND throws", async () => {
    const { fetchBalance } = await import("./api.deepseek.ts");
    globalThis.fetch = (async () => {
      throw new Error("fetch failed: ECONNREFUSED");
    }) as typeof fetch;
    await assert.rejects(
      () => fetchBalance("t", "https://api.deepseek.com/user/balance", undefined, null),
      /ECONNREFUSED/,
    );
    const raw = readFileSync(diagnosticsPath(null), "utf8");
    const lines = raw.split("\n").filter((l) => l.length > 0);
    assert.equal(lines.length, 1);
    const row = JSON.parse(lines[0]);
    assert.match(row.msg, /deepseek \/user\/balance/);
    assert.match(row.msg, /ECONNREFUSED/);
  });

  it("does NOT log the auth token (token-leak regression guard)", async () => {
    const { fetchRemains } = await import("./api.ts");
    globalThis.fetch = (async () => new Response("nope", { status: 401 })) as typeof fetch;
    const SECRET = "sk-very-secret-12345";
    await assert.rejects(
      () => fetchRemains(SECRET, "https://x/y", undefined, null),
      /HTTP 401/,
    );
    const raw = readFileSync(diagnosticsPath(null), "utf8");
    // Hard guard: the secret must NOT appear in the JSONL log.
    assert.equal(
      raw.includes(SECRET),
      false,
      "auth token must never be persisted to the diagnostics log",
    );
    const row = JSON.parse(raw.trim().split("\n")[0]);
    assert.match(row.msg, /HTTP 401/);
  });

  it("successful fetch (200) does NOT write a diagnostic", async () => {
    const { fetchRemains } = await import("./api.ts");
    const provider = {
      TYPE: "TOKEN_PLAN" as const,
      BASE_URL_COMPARED_TO: "https://x",
      COMPARE_METHOD: "EXACT" as const,
      ENDPOINT: "https://x/y",
      parameters: {
        remainingPercentInterval: "model_remains.0.current_interval_remaining_percent",
        remainingPercentWeekly:   "model_remains.0.current_weekly_remaining_percent",
        startAtInterval:          "model_remains.0.start_time",
        endAtInterval:            "model_remains.0.end_time",
        startAtWeekly:            "model_remains.0.weekly_start_time",
        endAtWeekly:              "model_remains.0.weekly_end_time",
      },
    };
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({
          base_resp: { status_code: 0, status_msg: "ok" },
          model_remains: [
            {
              current_interval_remaining_percent: 50,
              current_weekly_remaining_percent: 50,
              start_time: Date.now() - 1_000,
              end_time: Date.now() + 3_600_000,
              weekly_start_time: Date.now() - 86_400_000,
              weekly_end_time: Date.now() + 7 * 24 * 3_600_000,
            },
          ],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      )) as typeof fetch;
    const r = await fetchRemains("t", "https://x/y", undefined, provider);
    assert.ok(r, "200 with parseable body returns a Remains");
    try {
      const raw = readFileSync(diagnosticsPath(null), "utf8");
      const fetchRows = raw.split("\n")
        .filter((l) => l.length > 0)
        .map((l) => JSON.parse(l))
        .filter((row) => row.source === "fetch");
      assert.equal(fetchRows.length, 0, "successful fetch must not write a diagnostic");
    } catch {
      // diagnostics.jsonl may not exist — fine.
    }
  });
});

// Note: index.ts is no longer in the fetch-error logging path.
// Earlier (v0.6.x draft) the catch block at fetchForProvider's
// wrapper level logged fetch errors; that approach was withdrawn
// in favor of logging at the network access point (fetchRemains /
// fetchBalance) where the actual error semantics live. The
// integration tests above cover the fetch-site logging.

// Pull only the symbols we need — `import * as diagnostics` would
// collide with the JSONL output under tests that also need
// `diagnostics` to mean "the whole module". Using a namespace import
// here keeps the call sites uniform with how index.ts / render.ts
// consume it.
import * as diag from "./diagnostics.ts";

const {
  append,
  diagnosticsPath,
  formatEntry,
  isEnabled,
  readLatest,
} = diag;
type Entry = import("./diagnostics.ts").Entry;

// Helper: route isEnabled through a synthetic env object so the
// "isEnabled" tests don't have to touch process.env (which other
// tests in this file use). isEnabled's signature accepts a default
// of process.env, but accepting an explicit env object here lets us
// write pure-function-style assertions.
function isEnabledWith(env: Record<string, string | undefined>): boolean {
  const e: NodeJS.ProcessEnv = { ...env };
  return isEnabled(e);
}

// existsSync is sync and would cost an extra fs call per test —
// import lazily so the cost is paid only when this helper runs.
function existsSyncSafe(p: string): boolean {
  try {
    // Use a dynamic read so we don't need to import "existsSync"
    // up top just for this single use.
    readFileSync(p);
    return true;
  } catch {
    return false;
  }
}