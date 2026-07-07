// v0.8.21+ — fetcher for `m_quote|address|…|field|…` tokens.
// Mirrors the data-driven shape of src/api.ts (fetch + tolerant
// JSON parse + diagnostics) and the cache-aside pattern in
// src/index.ts:fetchProviderData (disk-shadowed TTL cache,
// stale-on-error via peek).
//
// Per-tick contract:
//   1. `index.ts:main()` calls `preFetchQuotes(cwd, nowMs)` after
//      stdin is parsed and the provider is resolved, BEFORE
//      `buildProviderLine` runs.
//   2. preFetchQuotes scans `cfg().statuslineTemplate` +
//      `cfg().lineTemplates.*` for every `m_quote|address|…` token
//      and dedupes by address. For the first one:
//        - cache.getWithAge(key, ttlMs) → if within TTL, skip the
//          fetch and reuse the cached body
//        - otherwise, await fetch(url, { signal: AbortSignal.timeout(5s) })
//          → on 2xx, cache.set(key, body, ttlMs)
//        - on non-2xx / network error / timeout, leave the previous
//          cache entry in place (stale-on-error). If no entry
//          exists, append a `warning` row to diagnostics.jsonl.
//   3. The returned body is passed to `buildProviderLine` →
//      `renderProviderLine` → `ctx.quoteBodies`, and the sync
//      renderer reads it via `ctx.quoteBodies.get(address)`.

import { execFileSync } from "node:child_process";
import { openSync, readFileSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import * as cache from "./cache.ts";
import { configStore } from "./config.ts";
import * as diagnostics from "./diagnostics.ts";

// v0.8.21+ — fixed cache key. Shared across processes / projects
// so all readers see the same body. No per-project prefix.
const QUOTE_CACHE_KEY = "quote";
const QUOTE_CACHE_TTL_MS = 60_000;

type QuoteCacheEntry = { address: string; body: string };

function truncateForLog(s: string): string {
  return s.length > 120 ? s.slice(0, 119) + "…" : s;
}

// Walk a token list for the first `m_quote|address|<addr>|field|<path>`
// entry. We only ever cache one body — multiple address tokens in
// the same template collapse to a single endpoint.
//
// v0.8.21+ — `insecureTls` reflects the `|insecureTls|<b>` inline
// arg on the token so callers can opt into curl `-k` per-token
// without touching config.json. When the arg is absent, the value
// is `undefined` and the global `cfg().quoteInsecureTls` gate is
// authoritative; an explicit `|insecureTls|true|false` on the
// token overrides it for that tick.
type QuoteTarget = { address: string; insecureTls?: boolean };

function scanTokens(toks: readonly string[]): QuoteTarget | null {
  for (const tok of toks) {
    const parts = tok.split("|");
    if (parts[0] !== "m_quote") continue;
    let address = "";
    let insecureTls: boolean | undefined;
    for (let i = 1; i < parts.length - 1; i++) {
      if (parts[i] === "address") {
        address = parts[i + 1] ?? "";
      } else if (parts[i] === "insecureTls") {
        const v = (parts[i + 1] ?? "").toLowerCase();
        if (v === "true" || v === "1") insecureTls = true;
        else if (v === "false" || v === "0") insecureTls = false;
      }
    }
    if (address.length > 0) return { address, insecureTls };
  }
  return null;
}

function fetchOne(
  address: string,
  insecureTls?: boolean,
): { ok: true; body: string } | { ok: false; reason: string } {
  let url: URL;
  try {
    url = new URL(address);
  } catch {
    return { ok: false, reason: "unsupported scheme" };
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return { ok: false, reason: "unsupported scheme" };
  }
  // Capture stderr to a temp file so curl's exit-status detail
  // (e.g. "curl: (6) Could not resolve host") is preserved for
  // diagnostics instead of swallowed by stdio:[…,"ignore"]. tmp
  // filename: `<tmpdir>/topgauge-cc-curl-<pid>.log` — unique per
  // process so concurrent ticks (rare but possible) don't clobber
  // each other's stderr. Cleaned in catch / finally.
  //
  // v0.8.21 — use execFileSync("curl", argvArray) instead of
  // execSync("curl … <shellQuote(addr)>"). Node spawns curl
  // directly without an intermediate shell, so the URL arg is
  // passed verbatim — no risk of cmd.exe treating the single
  // quotes as a string wrapper (Windows would silently strip
  // them) or MSYS2 path-mangling the URL. argv length is also
  // uncapped by the shell's MAX_ARG_STRS limit on old Windows.
  const stderrPath = `${tmpdir()}/topgauge-cc-curl-${process.pid}.log`;
  // v0.8.21+ — opt-in TLS skip. Precedence (highest first):
  //   1. inline `|insecureTls|true|false` on the m_quote token
  //      (`insecureTls` arg from preFetchQuotes)
  //   2. `cfg().quoteInsecureTls === true` from config.json
  //   3. `TOPGAUGE_CC_QUOTE_INSECURE_TLS=1` env var (seeds the
  //      same config flag at loadConfig time)
  // When the flag is set we append `-k` / `--insecure` to the curl
  // argv so self-signed / expired / untrusted-CA HTTPS endpoints
  // work without modifying the system CA bundle. The flag stays
  // OFF by default — a misconfigured upstream still surfaces TLS
  // errors loudly.
  const insecure = insecureTls ?? configStore.get().quoteInsecureTls === true;
  const curlArgs = ["-sSf", "--max-time", "5", "-S"];
  if (insecure) curlArgs.push("-k");
  curlArgs.push(address);
  let body: string;
  try {
    body = execFileSync("curl", curlArgs, {
      encoding: "utf8",
      windowsHide: true,
      stdio: ["ignore", "pipe", openSync(stderrPath, "w")],
    });
    // Success — drop the temp file quietly.
    try { unlinkSync(stderrPath); } catch { /* benign */ }
  } catch (e) {
    // Read whatever curl wrote to stderr, append to reason so a
    // postmortem can see "exit 6 (DNS)" / "exit 28 (timeout)" /
    // "exit 60 (TLS cert)" / "exit 22 (HTTP >=400)" verbatim.
    let stderrTail = "";
    try {
      stderrTail = readFileSync(stderrPath, "utf8").trim();
    } catch { /* file gone or unreadable */ }
    try { unlinkSync(stderrPath); } catch { /* benign */ }
    const base = e instanceof Error ? e.message : String(e);
    return {
      ok: false,
      reason: stderrTail.length > 0 ? `${base} | stderr: ${stderrTail}` : base,
    };
  }
  return { ok: true, body };
}

// Pre-fetch the first `m_quote|address|…` source referenced by the
// active lineTemplate + lineTemplates.* fragments. Returns a
// per-tick Map<address, body> for the renderer to read. Failures
// are recorded to diagnostics.jsonl (and reflected as a missing
// Map entry); successes are written to the disk-shadowed cache
// so the next tick (or the next process) can skip the fetch.
//
// The Map is intentionally per-tick (rebuilt every invocation) —
// the persistent cache lives in `src/cache.ts`. No module-level
// state survives between ticks.
export async function preFetchQuotes(
  cwd: string | null,
  nowMs: number,
): Promise<Map<string, string>> {
  void cwd; // per-project isolation lives in the global cache key
            // — all projects share the same row, so cwd is unused
  const out = new Map<string, string>();

  const cfg = configStore.get();
  const template = cfg.statuslineTemplate ?? [];
  const lineTemplates = cfg.lineTemplates ?? {};

  let target: QuoteTarget | null = scanTokens(template);
  if (target === null) {
    for (const k of Object.keys(lineTemplates)) {
      const t = scanTokens(lineTemplates[k] ?? []);
      if (t !== null) {
        target = t;
        break;
      }
    }
  }
  if (target === null) return out;

  // Cache-aside: within-TTL hit AND same address → skip fetch.
  const cached = cache.getWithAge<QuoteCacheEntry>(
    QUOTE_CACHE_KEY,
    QUOTE_CACHE_TTL_MS,
  );
  if (cached !== null && cached.value.address === target.address) {
    out.set(target.address, cached.value.body);
    return out;
  }

  const result = fetchOne(target.address, target.insecureTls);
  if (!result.ok) {
    // Stale-on-error: keep the previous entry (peek ignores TTL so
    // a 60s-old entry is still surfaced for this tick). If no entry
    // exists at all, log a warning so a postmortem can see the
    // network failure — but DON'T add to the returned Map; the
    // renderer will fall back to local QUOTES.
    const stale = cache.peek<QuoteCacheEntry>(QUOTE_CACHE_KEY);
    if (stale === null || stale.address !== target.address) {
      diagnostics.append(
        "warning",
        "m_quote",
        `address fetch failed (curl exit): ${truncateForLog(target.address)} (reason=${result.reason})`,
        nowMs,
      );
    } else {
      out.set(target.address, stale.body);
    }
    return out;
  }

  cache.set(
    QUOTE_CACHE_KEY,
    { address: target.address, body: result.body } satisfies QuoteCacheEntry,
    QUOTE_CACHE_TTL_MS,
  );
  out.set(target.address, result.body);
  return out;
}
