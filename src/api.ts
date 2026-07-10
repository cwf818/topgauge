// api.ts — single-provider transport + parser module.
//
// Replaces the v0.6.x split of `api.plan.ts` (TOKEN_PLAN) and
// `api.balance.ts` (BALANCE) with one file. Three layers:
//
//   1. Transport layer (`httpTransport` / `execTransport` /
//      `pluginTransport` + `detectTransport` + `queryPluginsDir`) —
//      chooses how to obtain a response body given a provider's
//      ENDPOINT and a provider id. Detected by ENDPOINT prefix:
//        - "http://" or "https://" → httpTransport
//        - non-empty string that doesn't start with http(s)
//          → execTransport (execSync(endpoint))
//        - empty string + query_plugins/<id>/index.js exists
//          → pluginTransport (execFileSync("node", […]))
//        - otherwise → throw
//   2. `fetchForProviderById(name, entry, token, signal)` — runs the
//      transport, JSON-parses the body, narrows by `entry.TYPE` to
//      the matching parser, returns `Remains | Balance | null`.
//      Throws on transport failure (preserves the v0.6.x
//      stale-on-error contract); returns null on parser-shaping
//      failure.
//   3. Parsers (`parseRemains` / `parseBalance`) + helpers + types —
//      ported verbatim from the prior two files, with no behavior
//      change.

import { execSync } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { configStore, resolveEffectiveIntervals } from "./config.ts";
import * as diagnostics from "./diagnostics.ts";
import { resolveSlot } from "./path-expr.ts";
import type {
  IntervalConfig,
  IntervalKey,
  IntervalSlotConfig,
  ProviderEntry,
} from "./types.ts";

// v0.9.0+ — `Remains` carries three independent `Interval`s instead
// of the v0.5.0–v0.8.x pair-of-Windows shape. The renderer-side
// `Window` projection lives in `intervalToWindow` in src/render.ts.
import type { Interval } from "./render";
export type { Interval };

export type Remains = {
  shortInterval: Interval | null;
  midInterval: Interval | null;
  longInterval: Interval | null;
};

export type BalanceEntry = {
  currency: string;
  totalBalance: number;
};

export type Balance = {
  isAvailable: boolean;
  entries: BalanceEntry[];
  minValue: number | null;
};

// ============================================================================
//  Transport layer
// ============================================================================

export type TransportKind = "http" | "exec" | "plugin";

// Resolved location of the user-bundled query_plugins drop-in dir:
// ~/.claude/plugins/topgauge-cc/query_plugins/. Sibling of `state/`
// and `config.json`; survives `/plugin install` cache rolls because
// it lives outside the versioned cache dir. Uses `homedir()` (not
// CLAUDE_CONFIG_DIR) for consistency with config.ts.
export function queryPluginsDir(): string {
  return join(homedir(), ".claude", "plugins", "topgauge-cc", "query_plugins");
}

// Path to the bundled plugin script for a given provider id.
// Re-exported for test convenience + the install-time notes in
// MANUAL.md. Existence is the caller's check (existsSync on this
// path is exactly what detectTransport does below).
//
// Two extensions are accepted:
//   - `index.js`  : the canonical layout. Plain Node ESM when the
//                   parent dir has a sibling `package.json` with
//                   `"type":"module"`, or CommonJS-with-exports
//                   otherwise. Most users will use this.
//   - `index.mjs` : an explicit ESM marker — `import()` and top-
//                   level `await` work without an accompanying
//                   package.json. Useful for one-off plugins.
//
// `index.js` is preferred (so users who copy the bundled fixture
// get the canonical path); `index.mjs` is the fallback for users
// who want to drop a single ESM file with no package.json.
export function queryPluginPath(providerId: string): string {
  return join(queryPluginsDir(), providerId, "index.js");
}

// Resolve the actual on-disk path for a plugin — first `index.js`,
// then `index.mjs`. Returns the canonical `queryPluginPath` if
// neither exists. Caller is expected to `existsSync(...)` this.
//
// Exported so the config-load validator in src/config.ts can reuse
// the .js → .mjs resolution without duplicating it; the validator
// needs the same "which file would pluginTransport actually load"
// signal that detectTransport uses at fetch time.
export function resolvePluginOnDisk(providerId: string): string {
  const js = queryPluginPath(providerId);
  if (existsSync(js)) return js;
  const mjs = join(queryPluginsDir(), providerId, "index.mjs");
  if (existsSync(mjs)) return mjs;
  return js;
}

// Decide how to obtain a response body for this provider.
//
//   "http"   → endpoint starts with http:// or https://. Use httpTransport.
//   "exec"   → endpoint is non-empty and non-http. Use execTransport
//              (passes the string to `execSync`).
//   "plugin" → endpoint is empty AND a plugin file exists on disk.
//              Use pluginTransport (execFileSync("node", [pluginPath])).
//
// Empty endpoint with no plugin file is an error — the user
// probably forgot to wire one or the other.
export function detectTransport(
  endpoint: string,
  providerId: string,
): TransportKind {
  const e = endpoint ?? "";
  if (e === "") {
    const pluginPath = resolvePluginOnDisk(providerId);
    const mjsPath = join(queryPluginsDir(), providerId, "index.mjs");
    if (existsSync(pluginPath) || existsSync(mjsPath)) return "plugin";
    throw new Error(
      `provider "${providerId}" has ENDPOINT="" and no query_plugins file at ${pluginPath} (or ${mjsPath})`,
    );
  }
  if (e.startsWith("http://") || e.startsWith("https://")) return "http";
  return "exec";
}

// v0.6.0+ — entry.BEARER_KEY wins over the env-sourced `token` arg.
function resolveAuthToken(provider: ProviderEntry | null, token: string): string {
  return provider?.BEARER_KEY ?? token ?? "";
}

// v0.6.0+ — body only when METHOD is not GET AND the user supplied
// one. GET with a body is rejected by the spec; the WHATWG fetch
// impl drops it silently, so we never put one on the wire for GET
// regardless of config.
function resolveBodyJson(provider: ProviderEntry | null): string | undefined {
  const method = provider?.METHOD ?? "GET";
  return method !== "GET" && provider?.BODY !== undefined
    ? JSON.stringify(provider.BODY)
    : undefined;
}

// HTTP transport — calls globalThis.fetch with the bearer / method /
// body derived from the provider entry. Returns the raw response
// body text; caller JSON-parses.
//
// Network error → diagnostics.append + re-throw. !res.ok → same
// diagnostics + throw.
//
// `labelPrefix` is the diagnostics-tag prefix the caller passes —
// `fetchRemains` passes "token_plan/remains", `fetchBalance` passes
// "deepseek /user/balance". The original split was per-file, so we
// keep the same per-function prefix here (NOT derived from
// `entry.TYPE` — when fetchBalance is called with provider=null, the
// label must still be "deepseek /user/balance" for byte-identical
// backward compat with the pre-merge diagnostics contract).
export async function httpTransport(
  token: string,
  endpoint: string,
  signal: AbortSignal | undefined,
  provider: ProviderEntry | null,
  labelPrefix: string = "token_plan/remains",
): Promise<string> {
  const authToken = resolveAuthToken(provider, token);
  if (!authToken) return "";  // empty token → empty body, parser returns null
  const method = provider?.METHOD ?? "GET";
  const bodyJson = resolveBodyJson(provider);

  let res: Response;
  try {
    res = await fetch(endpoint, {
      method,
      headers: {
        Authorization: `Bearer ${authToken}`,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      signal,
      ...(bodyJson !== undefined ? { body: bodyJson } : {}),
    });
  } catch (e) {
    diagnostics.append(
      "warning", "fetch",
      `${labelPrefix} ${endpoint}: ${(e as Error).message ?? String(e)}`,
      Date.now(),
    );
    throw e;
  }
  if (!res.ok) {
    const msg = `${labelPrefix} HTTP ${res.status}`;
    diagnostics.append("warning", "fetch", `${msg} (${endpoint})`, Date.now());
    throw new Error(msg);
  }
  return res.text();
}

// Exec transport — runs the user's ENDPOINT as a shell command via
// `execSync` and returns stdout. Uses `execSync` (NOT
// `execFileSync`) on purpose: the user-supplied ENDPOINT is a
// free-form shell string ("python3 /opt/fetch.py --user alice",
// "bash -c '…pipeline…'"), and we want the user's shell
// metacharacters to mean what /bin/sh says they mean.
//
// `windowsHide: true` suppresses the spawned console window on
// Windows. `stdio: ["ignore", "pipe", "ignore"]` captures stdout
// (returned) and discards stderr (matches the precedent in
// `render.ts:294` for `vm_stat`). 5-second timeout via child_process
// stdlib.
export async function execTransport(endpoint: string): Promise<string> {
  let out: string;
  try {
    out = execSync(endpoint, {
      encoding: "utf8",
      windowsHide: true,
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 5_000,
    });
  } catch (e) {
    diagnostics.append(
      "warning", "fetch",
      `exec ${endpoint}: ${(e as Error).message ?? String(e)}`,
      Date.now(),
    );
    throw e;
  }
  return out ?? "";
}

// Plugin transport — runs the user's bundled
// query_plugins/<providerId>/index.js via `execFileSync("node", …)`.
// Argv form (no shell) on purpose — the plugin's full path is
// determined by the plugin loader so there's no opportunity for
// argument injection from a misconfigured ENDPOINT.
// ============================================================================
//  Plugin transport contract
// ============================================================================
//
// A query_plugins/<providerId>/index.js file is a regular ESM module
// whose **default export** is an object with a `fetchAccountQuota(token)`
// method. The plugin is loaded via dynamic `import()` (NOT via
// `execFileSync("node", […])`) so the plugin runs in-process with
// our Node.js runtime — same V8, same TypeScript-ESM loader, no
// extra spawn cost.
//
// `token` here is `process.env.ANTHROPIC_AUTH_TOKEN` — the same
// token that `httpTransport` would put in the `Authorization`
// header. **We pass it in unfiltered; the plugin author decides
// whether to use it.** This is deliberate: for some providers
// (token-plan APIs) the bearer token is the only auth needed; for
// others (HTTP basic, OAuth, cookie-jar) the plugin ignores it
// entirely. We do NOT enforce that the plugin forwards the token
// anywhere — we only ensure the user's "user identity" is
// surfaced to plugin code so the plugin doesn't have to dig through
// `process.env` on its own.
//
// `fetchAccountQuota` MUST return an object that already satisfies either
// the tokenplan.schema or balance.schema (per the provider entry's
// `TYPE`). The dispatcher does NOT call parseRemains / parseBalance
// on plugin output — the plugin author is the parser. Returning a
// raw API response (e.g. `{model_remains: [...]}`) here will be
// piped straight to the renderer and produce garbage.
export type QueryPluginModule = {
  fetchAccountQuota: (token: string) => unknown | Promise<unknown>;
};

// Default timeout for the imported plugin module's `fetchAccountQuota`
// promise. The plugin author is expected to fail fast; if they
// hang we surface a stale-on-error via diagnostics.
const PLUGIN_TIMEOUT_MS = 5_000;

// Race `p` against a timed rejection. Standard library has no
// builtin timeout-promise helper, so we roll our own here. (We
// intentionally don't use `AbortSignal.timeout` because the plugin
// author doesn't know about our signal — the timeout fires whether
// or not they've wired it.)
async function withTimeout<T>(
  p: Promise<T>,
  ms: number,
  what: string,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      p,
      new Promise<T>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`${what} timed out after ${ms}ms`)),
          ms,
        );
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

// Plugin transport — dynamically imports
// query_plugins/<providerId>/index.js (ESM, in-process) and
// invokes its default export's `fetchAccountQuota(token)` with the env-
// sourced token. The returned object is **already the canonical
// `Remains`/`Balance` schema** (the plugin author did the parsing);
// the dispatcher in `fetchForProviderById` will NOT call
// `parseRemains` / `parseBalance` on this output.
//
// Failure modes → diagnostics.append + re-throw (consistent with
// the httpTransport / execTransport contract — the stale-on-error
// cache layer in src/index.ts only catches, it doesn't replace):
//   - module doesn't exist (catch-all `import()` rejection)
//   - default export is missing or not an object
//   - default export has no `fetchAccountQuota` method
//   - `fetchAccountQuota` throws or rejects
//   - `fetchAccountQuota` times out after PLUGIN_TIMEOUT_MS
export async function pluginTransport(
  providerId: string,
  token: string,
): Promise<unknown> {
  // Pick up `.mjs` if `.js` is absent (see resolvePluginOnDisk for
  // the rationale). The detectTransport() call in fetchForProviderById
  // has already verified one or the other exists, so this is
  // essentially guaranteed not to fall back to a non-existent path.
  const pluginPath = existsSync(queryPluginPath(providerId))
    ? queryPluginPath(providerId)
    : resolvePluginOnDisk(providerId);
  let mod: { default?: QueryPluginModule } & Record<string, unknown>;
  try {
    // pathToFileURL is mandatory for Windows — bare paths blow up
    // inside the dynamic import loader (`file:///` URLs only).
    mod = (await import(
      pathToFileURL(pluginPath).href
    )) as typeof mod;
  } catch (e) {
    const msg = `plugin ${pluginPath}: ${(e as Error).message ?? String(e)}`;
    diagnostics.append("warning", "fetch", msg, Date.now());
    throw new Error(msg);
  }
  const exp = mod.default;
  if (!exp || typeof exp !== "object" || typeof exp.fetchAccountQuota !== "function") {
    const msg = `plugin ${pluginPath}: default export must be { fetchAccountQuota(token) }`;
    diagnostics.append("warning", "fetch", msg, Date.now());
    throw new Error(msg);
  }
  try {
    return await withTimeout(
      Promise.resolve(exp.fetchAccountQuota(token)),
      PLUGIN_TIMEOUT_MS,
      `plugin ${pluginPath} fetchAccountQuota`,
    );
  } catch (e) {
    const msg = `plugin ${pluginPath} fetchAccountQuota: ${(e as Error).message ?? String(e)}`;
    diagnostics.append("warning", "fetch", msg, Date.now());
    throw new Error(msg);
  }
}

// idThreaded transport runner: takes a provider name (the key in
// configStore.get().providers) so plugin transport can resolve the
// correct query_plugins/<name>/index.js. `labelPrefix` is the
// diagnostics-tag for HTTP failures; ignored by the other transports.
//
// `http` and `exec` return raw body *strings* (caller JSON-parses);
// `plugin` returns the **already-parsed JSON object** directly out
// of the plugin author's `fetchAccountQuota(token)`. The dispatcher treats
// these as different shapes — it only `JSON.parse`s the http/exec
// path; on the plugin path the plugin IS the parser.
async function runTransport(
  transport: TransportKind,
  endpoint: string,
  providerId: string,
  token: string,
  signal: AbortSignal | undefined,
  entry: ProviderEntry | null,
  labelPrefix: string = "token_plan/remains",
): Promise<unknown> {
  switch (transport) {
    case "http":
      return httpTransport(token, endpoint, signal, entry, labelPrefix);
    case "exec":
      return execTransport(endpoint);
    case "plugin":
      return pluginTransport(providerId, token);
  }
}

// ============================================================================
//  Unified dispatcher
// ============================================================================

// Type-narrowing dispatcher:
//   1. detectTransport → pick one of three transports.
//   2. transport runs → raw string body.
//   3. JSON.parse(body) → unknown.
//   4. entry.TYPE picks the parser.
//   5. Returns Remains | Balance | null.
//
// Throws on transport failure (caller's stale-on-error cache logic
// in src/index.ts:fetchProviderData catches and surfaces cached
// data). Returns null on parser-shaping failure (transport OK but
// data doesn't fit the schema).
//
// `providerName` is the key in the user's `providers` config block
// — only meaningful when the provider uses the "plugin" transport
// (empty ENDPOINT + query_plugins file). For HTTP and exec, only
// the entry.ENDPOINT value matters.
// Minimal shape check on a plugin's return value: the dispatcher
// won't run parseRemains/parseBalance on plugin output (the plugin
// author is the parser) but the renderer still calls `obj.shortInterval`,
// `obj.isAvailable` etc. — so a `null` / non-object return that
// slipped past upstream would crash the renderer. Validate the
// top-level shape and let bad values turn into `null` (the same
// "no data → no line" contract the parsers uphold) rather than a
// thrown error.
function isPlainObject(x: unknown): x is Record<string, unknown> {
  return typeof x === "object" && x !== null && !Array.isArray(x);
}

// TOKEN_PLAN plugin contract check: must be an object with at
// least one of shortInterval/midInterval/longInterval present and
// object-shaped. Each present key is trusted as an Interval-shape
// sub-object without deep field validation — the renderer is the
// consumer-of-truth and paints "n/a" on anything it doesn't
// understand.
//
// The "at least one interval key must be present" gate is what
// keeps this from accepting every plain object. Without it, an
// empty {} or a legacy {model_remains: [...]} body would match
// (the loop just continues when keys are absent), and the plugin
// transport would silently treat legacy shapes as canonical
// plugin output.
function looksLikeRemains(x: unknown): x is Remains {
  if (!isPlainObject(x)) return false;
  let anyInterval = false;
  for (const k of ["shortInterval", "midInterval", "longInterval"] as const) {
    const v = x[k];
    if (v == null) continue;
    if (!isPlainObject(v)) return false;
    anyInterval = true;
  }
  return anyInterval;
}

// BALANCE plugin contract check.
function looksLikeBalance(x: unknown): x is Balance {
  if (!isPlainObject(x)) return false;
  if (typeof x.isAvailable !== "boolean") return false;
  if (!Array.isArray(x.entries)) return false;
  // minValue is optional (null/undefined OK).
  return true;
}

export async function fetchForProviderById(
  providerName: string | null,
  entry: ProviderEntry | null,
  token: string,
  signal: AbortSignal | undefined,
): Promise<unknown> {
  if (!entry) return null;
  const id = providerName ?? "";
  let transport: TransportKind;
  try {
    transport = detectTransport(entry.ENDPOINT, id);
  } catch (e) {
    diagnostics.append(
      "warning", "fetch",
      `${id}: ${(e as Error).message ?? String(e)}`,
      Date.now(),
    );
    throw e;
  }
  const body = await runTransport(
    transport,
    entry.ENDPOINT,
    id,
    token,
    signal,
    entry,
    entry.TYPE === "BALANCE" ? "deepseek /user/balance" : "token_plan/remains",
  );

  // Plugin transport short-circuit: the plugin author is the parser.
  // Don't `JSON.parse` (the body is already an object) and don't
  // pipe through parseRemains/parseBalance (the plugin owns the
  // canonical schema). We do a one-line shape check so a plugin
  // that returns the wrong type cleanly degrades to "no data"
  // instead of crashing the renderer downstream.
  if (transport === "plugin") {
    if (entry.TYPE === "TOKEN_PLAN") {
      return looksLikeRemains(body) ? body : null;
    }
    if (entry.TYPE === "BALANCE") {
      return looksLikeBalance(body) ? body : null;
    }
    const _exhaustive: never = entry.TYPE;
    throw new Error(`unsupported provider TYPE: ${_exhaustive}`);
  }

  // http / exec: body is a UTF-8 string; parse it.
  if (typeof body !== "string") return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return null;
  }
  if (entry.TYPE === "TOKEN_PLAN") {
    return parseRemains(parsed, entry, resolveEffectiveIntervals(id, entry));
  }
  if (entry.TYPE === "BALANCE") {
    return parseBalance(parsed);
  }
  const _exhaustive: never = entry.TYPE;
  throw new Error(`unsupported provider TYPE: ${_exhaustive}`);
}

// Legacy compatibility wrappers — preserved so the v0.6.x test
// signatures still compile. `fetchRemains` / `fetchBalance` only
// mattered in the pre-providers-config era when there was exactly
// one TOKEN_PLAN provider (minimax) and one BALANCE provider
// (deepseek); their ENDPOINT was hardcoded to those URLs. The new
// dispatcher (`fetchForProviderById`) is the canonical entry point
// going forward.

export async function fetchRemains(
  token: string,
  endpoint: string,
  signal?: AbortSignal,
  provider: ProviderEntry | null = null,
): Promise<Remains | null> {
  // Legacy 4-arg signature doesn't carry a provider id; we use
  // "minimax" as a sentinel (only relevant when endpoint === "" AND
  // query_plugins/minimax/index.js exists — a niche setup).
  const id = "minimax";
  let transport: TransportKind;
  try {
    transport = detectTransport(endpoint, id);
  } catch (e) {
    throw e;
  }
  const body = await runTransport(transport, endpoint, id, token, signal, provider, "token_plan/remains");
  // Plugin path → body is the plugin's parsed object; skip the JSON
  // round-trip and trust the contract shape check.
  if (transport === "plugin") {
    return looksLikeRemains(body) ? body : null;
  }
  if (typeof body !== "string") return null;
  if (!body) return null;
  let parsed: unknown;
  try { parsed = JSON.parse(body); } catch { return null; }
  return parseRemains(parsed, provider, resolveEffectiveIntervals(id, provider));
}

export async function fetchBalance(
  token: string,
  endpoint: string,
  signal?: AbortSignal,
  provider: ProviderEntry | null = null,
): Promise<Balance | null> {
  const id = "deepseek";
  let transport: TransportKind;
  try {
    transport = detectTransport(endpoint, id);
  } catch (e) {
    throw e;
  }
  const body = await runTransport(transport, endpoint, id, token, signal, provider, "deepseek /user/balance");
  if (transport === "plugin") {
    return looksLikeBalance(body) ? body : null;
  }
  if (typeof body !== "string") return null;
  if (!body) return null;
  let parsed: unknown;
  try { parsed = JSON.parse(body); } catch { return null; }
  return parseBalance(parsed);
}

// ============================================================================
//  Shared parser helpers
// ============================================================================

function asNumber(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v))) {
    return Number(v);
  }
  return null;
}

// ============================================================================
//  TOKEN_PLAN parser (v0.9.0+)
// ============================================================================

const DEFAULT_WINDOW_IDS: Record<IntervalKey, "5h" | "7d" | "30d"> = {
  shortInterval: "5h",
  midInterval:   "7d",
  longInterval:  "30d",
};

const INTERVAL_MS_KEYWORD_TABLE: ReadonlyArray<readonly [string, number]> = [
  ["hour",     3_600_000],
  ["fiveHour", 18_000_000],
  ["day",      86_400_000],
  ["sevenDay", 604_800_000],
  ["week",     604_800_000],
  ["month",    2_592_000_000],
  ["year",     31_536_000_000],
];

function resolvePercentGroup(
  root: unknown,
  slot: IntervalSlotConfig,
): { remainingPercent: number | null; usedPercent: number | null } {
  const usedRaw = slot.usedPercent
    ? asNumber(resolveSlot(root, slot.usedPercent, "number"))
    : null;
  const remRaw = slot.remainingPercent
    ? asNumber(resolveSlot(root, slot.remainingPercent, "number"))
    : null;
  if (usedRaw != null) {
    return { usedPercent: usedRaw, remainingPercent: 100 - usedRaw };
  }
  if (remRaw != null) {
    return { remainingPercent: remRaw, usedPercent: 100 - remRaw };
  }
  return { remainingPercent: null, usedPercent: null };
}

function resolveTimeGroup(
  root: unknown,
  slot: IntervalSlotConfig,
): { startAt: number | null; endAt: number | null; intervalMs: number | null } {
  const startRaw = slot.startAt
    ? asNumber(resolveSlot(root, slot.startAt, "epochMs"))
    : null;
  const endRaw = slot.endAt
    ? asNumber(resolveSlot(root, slot.endAt, "epochMs"))
    : null;

  let intervalMsRaw: number | null = null;
  if (typeof slot.intervalMs === "number" && Number.isFinite(slot.intervalMs)) {
    intervalMsRaw = slot.intervalMs;
  } else if (slot.intervalMs != null) {
    const v = asNumber(resolveSlot(root, String(slot.intervalMs), "number"));
    if (v != null) intervalMsRaw = v;
  } else if (typeof slot.intervalS === "number" && Number.isFinite(slot.intervalS)) {
    intervalMsRaw = slot.intervalS * 1000;
  } else if (slot.intervalS != null) {
    const v = asNumber(resolveSlot(root, String(slot.intervalS), "number"));
    if (v != null) intervalMsRaw = v * 1000;
  }

  if (intervalMsRaw == null && root && typeof root === "object") {
    const r = root as Record<string, unknown>;
    for (const [key, msPerUnit] of INTERVAL_MS_KEYWORD_TABLE) {
      const v = asNumber(r[key]);
      if (v != null) {
        intervalMsRaw = v * msPerUnit;
        break;
      }
    }
  }

  const nonNullCount = (startRaw != null ? 1 : 0)
    + (endRaw != null ? 1 : 0)
    + (intervalMsRaw != null ? 1 : 0);
  if (nonNullCount < 2) {
    return { startAt: null, endAt: null, intervalMs: null };
  }

  let startAt = startRaw;
  let endAt = endRaw;
  if (startAt != null && endAt != null) {
    return { startAt, endAt, intervalMs: intervalMsRaw ?? (endAt - startAt) };
  }
  if (startAt != null && intervalMsRaw != null) {
    endAt = startAt + intervalMsRaw;
    return { startAt, endAt, intervalMs: intervalMsRaw };
  }
  if (endAt != null && intervalMsRaw != null) {
    startAt = endAt - intervalMsRaw;
    return { startAt, endAt, intervalMs: intervalMsRaw };
  }
  return { startAt: null, endAt: null, intervalMs: null };
}

function resolveQuotaGroup(
  root: unknown,
  slot: IntervalSlotConfig,
): { remainingQuota: number | null; usedQuota: number | null; limitQuota: number | null } {
  return {
    remainingQuota: slot.remainingQuota
      ? asNumber(resolveSlot(root, slot.remainingQuota, "number"))
      : null,
    usedQuota: slot.usedQuota
      ? asNumber(resolveSlot(root, slot.usedQuota, "number"))
      : null,
    limitQuota: slot.limitQuota
      ? asNumber(resolveSlot(root, slot.limitQuota, "number"))
      : null,
  };
}

function buildInterval(
  root: unknown,
  slot: IntervalSlotConfig,
  key: IntervalKey,
): Interval | null {
  const percent = resolvePercentGroup(root, slot);
  const time = resolveTimeGroup(root, slot);
  const quota = resolveQuotaGroup(root, slot);

  const hasPercent = percent.remainingPercent != null || percent.usedPercent != null;
  const hasQuota = quota.remainingQuota != null || quota.usedQuota != null || quota.limitQuota != null;
  if (!hasPercent && !hasQuota) return null;

  const windowId = slot.windowId ?? DEFAULT_WINDOW_IDS[key];
  return {
    windowId,
    label: slot.label ?? slot.windowId ?? DEFAULT_WINDOW_IDS[key],
    startAt: time.startAt,
    endAt: time.endAt,
    intervalMs: time.intervalMs,
    remainingPercent: percent.remainingPercent,
    usedPercent: percent.usedPercent,
    remainingQuota: quota.remainingQuota,
    usedQuota: quota.usedQuota,
    limitQuota: quota.limitQuota,
  };
}

function pickMostActiveIndex(
  arr: unknown[],
  intervalsConfig: IntervalConfig,
): number {
  if (arr.length === 0) return -1;
  const short = intervalsConfig?.shortInterval;
  if (!short) return -1;
  const remainingPath = short.remainingPercent;
  const usedPath = short.usedPercent;
  if (!remainingPath && !usedPath) return -1;
  function reindexTail(path: string, idx: number): string {
    const tail = path.replace(
      /^(model_remains|modelRemains)\.?\[?0\]?\.?/,
      "",
    );
    return tail ? `model_remains.${idx}.${tail}` : `model_remains.${idx}`;
  }
  const root = { model_remains: arr };
  let bestIdx = 0;
  let bestScore = -Infinity;
  for (let i = 0; i < arr.length; i++) {
    let usedEquiv: number | null = null;
    if (remainingPath) {
      const v = asNumber(resolveSlot(root, reindexTail(remainingPath, i), "number"));
      if (v != null) usedEquiv = 100 - v;
    }
    if (usedEquiv == null && usedPath) {
      const v = asNumber(resolveSlot(root, reindexTail(usedPath, i), "number"));
      if (v != null) usedEquiv = v;
    }
    const score = usedEquiv ?? 0;
    if (score > bestScore) {
      bestScore = score;
      bestIdx = i;
    }
  }
  return bestIdx;
}

function reindexPaths(
  config: IntervalConfig,
  idx: number,
): IntervalConfig {
  const out: IntervalConfig = {};
  for (const k of ["shortInterval", "midInterval", "longInterval"] as IntervalKey[]) {
    const slot = config?.[k];
    if (!slot) continue;
    const next: IntervalSlotConfig = {};
    for (const [field, value] of Object.entries(slot)) {
      if (typeof value === "string") {
        next[field as keyof IntervalSlotConfig] = value.replace(
          /^(model_remains|modelRemains)\.?\[?0\]?\.?/,
          `$1.${idx}.`,
        ) as never;
      } else {
        (next as Record<string, unknown>)[field] = value;
      }
    }
    out[k] = next;
  }
  return out;
}

export function parseRemains(
  raw: unknown,
  _provider: ProviderEntry | null = null,
  intervalsConfig: IntervalConfig = {},
): Remains | null {
  if (!raw || typeof raw !== "object") return null;
  const root = raw as Record<string, unknown>;

  const baseResp = root.base_resp;
  if (baseResp && typeof baseResp === "object") {
    const code = asNumber((baseResp as Record<string, unknown>).status_code);
    if (code !== null && code !== 0) return null;
  }

  // NOTE on the v0.9.0+ plugin schema
  // ({shortInterval, midInterval, longInterval} at root, any subset):
  // query_plugins/<id>/index.js authors emit this shape, and an exec'd
  // plugin (`ENDPOINT="node …"`) produces the same. parseRemains does
  // NOT recognize it as a fast-path — instead the plugin author (or
  // user) declares the field mapping via intervalsConfig the same way
  // they would for an http endpoint. This keeps a single parser path
  // for all transports: model_remains[] array OR path-based
  // extraction, no parallel "looks like Remains" branch that could
  // diverge on schema details (field names, units, required vs
  // optional fields). The plugin transport short-circuits this
  // parser entirely and trusts looksLikeRemains instead; for exec
  // plugins, configure intervalsConfig.

  const arr = root.model_remains ?? root.modelRemains;

  let scopeRoot: unknown = root;
  if (Array.isArray(arr) && arr.length > 0) {
    const chosenIdx = pickMostActiveIndex(arr, intervalsConfig);
    if (chosenIdx >= 0) {
      const reindexed = reindexPaths(intervalsConfig, chosenIdx);
      const short = buildInterval(scopeRoot, reindexed.shortInterval ?? {}, "shortInterval");
      const mid = buildInterval(scopeRoot, reindexed.midInterval ?? {}, "midInterval");
      const long = buildInterval(scopeRoot, reindexed.longInterval ?? {}, "longInterval");
      if (short || mid || long) {
        return { shortInterval: short, midInterval: mid, longInterval: long };
      }
    }
  }

  const hasAnySlot =
    intervalsConfig?.shortInterval ||
    intervalsConfig?.midInterval ||
    intervalsConfig?.longInterval;
  if (hasAnySlot) {
    const short = buildInterval(scopeRoot, intervalsConfig?.shortInterval ?? {}, "shortInterval");
    const mid = buildInterval(scopeRoot, intervalsConfig?.midInterval ?? {}, "midInterval");
    const long = buildInterval(scopeRoot, intervalsConfig?.longInterval ?? {}, "longInterval");
    if (short || mid || long) {
      return { shortInterval: short, midInterval: mid, longInterval: long };
    }
  }

  return null;
}

// ============================================================================
//  BALANCE parser (v0.x — ported verbatim from api.balance.ts)
// ============================================================================

function normalizeEntry(raw: unknown): BalanceEntry | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const totalBalance = asNumber(r.total_balance);
  if (totalBalance == null) return null;
  const currency = typeof r.currency === "string" && r.currency !== ""
    ? r.currency
    : configStore.get().currency.default;
  return { currency, totalBalance };
}

export function parseBalance(raw: unknown): Balance | null {
  if (!raw || typeof raw !== "object") return null;
  const root = raw as Record<string, unknown>;

  // is_available contract: explicit false (or string "false") →
  // false; otherwise → true (optimistic render).
  const availRaw = root.is_available;
  const explicitlyFalse =
    availRaw === false ||
    (typeof availRaw === "string" && availRaw.toLowerCase() === "false");
  const isAvailable = !explicitlyFalse;

  const arr = root.balance_infos;
  let entries: BalanceEntry[] = [];
  if (Array.isArray(arr)) {
    entries = arr.map(normalizeEntry).filter((e): e is BalanceEntry => e !== null);
  }

  if (!isAvailable) {
    return {
      isAvailable: false,
      entries,
      minValue: entries.length === 0 ? null : Math.min(...entries.map((e) => e.totalBalance)),
    };
  }

  let minValue: number | null = null;
  if (entries.length > 0) {
    minValue = entries[0].totalBalance;
    for (let i = 1; i < entries.length; i++) {
      if (entries[i].totalBalance < minValue) minValue = entries[i].totalBalance;
    }
  }

  return { isAvailable: true, entries, minValue };
}

// ============================================================================
//  Deprecated: DeepSeek URL shim (kept for one minor version)
// ============================================================================

const DEEPSEEK_PREFIX = "https://api.deepseek.com";

/**
 * @deprecated v0.2.21: use `matchProvider(baseUrl) === "deepseek"`
 * from src/providers.ts.
 */
export function isDeepSeekBaseUrl(baseUrl: string | undefined | null): boolean {
  if (!baseUrl) return false;
  const lower = baseUrl.toLowerCase();
  if (!lower.startsWith(DEEPSEEK_PREFIX)) return false;
  const tail = baseUrl[DEEPSEEK_PREFIX.length];
  return tail === undefined || tail === "/" || tail === "?" || tail === "#";
}
