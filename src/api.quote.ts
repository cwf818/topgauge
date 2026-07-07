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

import { execSync } from "node:child_process";
import * as cache from "./cache.ts";
import { configStore } from "./config.ts";
import * as diagnostics from "./diagnostics.ts";

// POSIX-style shell quoting for an arbitrary URL string, used to
// safe-pass the address to `curl -sSf --max-time 5 …`. Wraps the
// value in single quotes, escaping any embedded single quote as
// the standard `'\''` sequence. Sufficient for the URL grammar
// (which forbids shell metacharacters in the host / path), so we
// don't need fancier escaping.
function shellQuote(s: string): string {
  return `'${s.replace(/'/g, "'\\''")}'`;
}

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
type QuoteTarget = { address: string };

function scanTokens(toks: readonly string[]): QuoteTarget | null {
  for (const tok of toks) {
    const parts = tok.split("|");
    if (parts[0] !== "m_quote") continue;
    let address = "";
    for (let i = 1; i < parts.length - 1; i++) {
      if (parts[i] === "address") {
        address = parts[i + 1] ?? "";
        break;
      }
    }
    if (address.length > 0) return { address };
  }
  return null;
}

function fetchOne(
  address: string,
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
  let body: string;
  try {
    body = execSync(`curl -sSf --max-time 5 ${shellQuote(address)}`, {
      encoding: "utf8",
      windowsHide: true,
      stdio: ["ignore", "pipe", "ignore"],
    });
  } catch (e) {
    // `curl -sSf` exits non-zero on HTTP errors, timeouts, DNS
    // failures, TLS errors, etc. The thrown Error's message starts
    // with the curl exit summary (e.g. "Command failed: curl …
    // HTTP 404\n…") — surface the message verbatim so a postmortem
    // can grep it. timeouts come out as "exit 28", TLS errors as
    // "exit 60", DNS failures as "exit 6", etc.
    return {
      ok: false,
      reason: e instanceof Error ? e.message : String(e),
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

  const result = fetchOne(target.address);
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
