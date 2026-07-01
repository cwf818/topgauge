// Provider discriminated union. A single `ANTHROPIC_BASE_URL` selects exactly
// one provider at runtime; `null` means "no provider — render nothing".
//
// v0.2.21: Provider widened to `string | null` — providers are now
// data-driven via the `providers` config block (see src/config.ts and
// src/providers.ts). Adding a new provider no longer requires editing
// this type union; just add a new entry to config.json's `providers`
// map. The TYPE discriminator below drives which fetcher / template /
// fail-label path the dispatcher takes.

export type Provider = string | null;

// Closed enum for now. If a new TYPE is added, the fetcher / renderer /
// template selection logic grows a new branch — data shape changes
// cannot be made data-driven (they need code to interpret them).
export type ProviderType = "TOKEN_PLAN" | "BALANCE";

export type CompareMethod = "EXACT" | "INCLUDE" | "STARTWITH";

// ----- v0.4.0+ token-usage module ---------------------------------------
//
// One row appended per statusline tick. Source = stdin (per probe schema
// captured 2026-06-27). Persisted to disk so m_token5h/m_token7d can
// query "how many tokens in the last N hours" across ticks.
//
// `at` is the wall-clock timestamp (Unix ms) when this tick fired.
// `in`/`out` mirror `context_window.total_input_tokens` /
// `total_output_tokens` — the per-tick cumulative numbers from Claude
// Code. `ctx_*` mirror `context_window.current_usage.*` — the
// post-turn context snapshot. `cwd` is the project working directory
// from stdin, used to scope the on-disk path (see token-store.ts).
export type TokenSample = {
  at: number;
  session: string;
  cwd: string;
  in: number;
  out: number;
  ctx_in: number;
  ctx_creation: number;
  ctx_read: number;
};

// What the renderer needs to know about a single tick. Built once in
// src/index.ts (drains stdin, samples, appends to disk) and passed to
// the renderer's `RenderContext` extension below.
//
// `current` = post-turn snapshot (used by m_ctx, m_cacheRead,
//            m_cacheHitRate, m_tokenIn, m_tokenOut, m_tokenInSpeed,
//            m_tokenOutSpeed). `totals` = session cumulative (used by
//            m_tokenInTotal, m_tokenOutTotal, m_tokenTotal).
//            `cost` = stdin.cost block. `contextWindow` = context
//            window size + used% (m_contextSize, m_contextUsed,
//            m_windowContext). The session-identity / metadata
//            fields (sessionName, modelDisplayName, effort, repo,
//            ccversion) feed the corresponding m_* modules verbatim.
export type TokenSnapshot = {
  sessionId: string | null;
  cwd: string | null;
  totals: {
    input: number | null;
    output: number | null;
  };
  current: {
    input: number | null;
    output: number | null;
    cacheCreation: number | null;
    cacheRead: number | null;
  };
  cost: {
    totalDurationMs: number | null;
    // v0.4.0+ — extended cost fields. Marked optional so older
    // test fixtures (pre-v0.4.0) type-check; the parser always
    // populates them on the live path.
    totalApiDurationMs?: number | null;
    totalLinesAdded?: number | null;
    totalLinesRemoved?: number | null;
  };
  // v0.4.0+ — session identity / metadata read from stdin root.
  // Marked optional (with `?`) so existing test fixtures that
  // construct a TokenSnapshot without the v0.4.0+ fields still
  // type-check. The parser always populates them; the renderer
  // null-checks each field before reading. Optional types better
  // reflect the "missing is fine" contract at the renderer level.
  sessionName?: string | null;
  modelDisplayName?: string | null;
  effort?: string | null;
  repo?: { host: string | null; owner: string | null; name: string | null } | null;
  ccversion?: string | null;
  // v0.4.0+ — context window stats read from stdin.context_window.
  contextWindow?: {
    size: number | null;
    usedPct: number | null;
    remainingPct: number | null;
  };
};

// One provider's declarative config block. All fields are required;
// the mergeConfig validator drops malformed entries (with a stderr
// warn) rather than auto-filling them, so a typo can't silently
// produce a half-configured provider.
//
// v0.4.0+ — added optional `config` block: a per-provider override
// of any top-level Config field (cacheTtlMs, colors, timeFormat,
// lineTemplate, etc.). Merged into the active Config at startup in
// main() via configStore.applyProviderOverrides(provider). The
// `providers` key is forbidden inside `config` to avoid recursion;
// other top-level keys can be safely overridden on a per-provider
// basis (e.g. "minimax needs fetchTimeoutMs=3000 because the API is
// slow; deepseek uses the default 5000").
//
// v0.5.0+ — added optional `parameters` block: a per-provider mapping
// from well-known renderer slots (e.g. `remainingPercentInterval`,
// `endAtWeekly`) onto path expressions evaluated against the API
// response. Replaces the v0.4.x hardcoded `parseRemains` parser.
// Path expressions follow the grammar in src/path-expr.ts (a
// `a.b[0].c` / `a.0.b.0.c` style with permissive type coercion).
// Slot name → type mapping is type-driven (ProviderType discriminator);
// the loader validates at config-load time and warns on bad entries
// rather than throwing.
export type ProviderEntry = {
  TYPE: ProviderType;
  BASE_URL_COMPARED_TO: string;
  COMPARE_METHOD: CompareMethod;
  ENDPOINT: string;
  // Provider-specific Config overrides. Same shape as the top-level
  // config.json (minus the `providers` key itself). Validated at
  // config-load time: must be a plain object; unknown keys are
  // forwarded to the existing per-field validators (same warn
  // behavior as the top-level config).
  config?: Record<string, unknown>;
  // v0.5.0+ — well-known-slot → path-expression mapping. Keys are
  // slot names (camelCase, type-driven list). Values are dot/bracket
  // path expressions evaluated against the parsed API response.
  // Missing slots resolve to null at fetch time; the renderer treats
  // null as "no data" (drop / placeholder per module contract).
  parameters?: Record<string, string>;
  // v0.6.0+ — per-provider HTTP request overrides. All three are
  // optional; absence means "use the v0.5.x default": GET, env-var
  // bearer, no body. Each field is validated independently at
  // config-load time (see validateProviderEntry in src/config.ts).
  //
  // BEARER_KEY always wins over process.env.ANTHROPIC_AUTH_TOKEN
  // when present — there is no env fallback. This is the contract
  // that makes per-provider credential rotation possible without
  // touching the env. The token is sent in the standard
  // `Authorization: Bearer <key>` header.
  BEARER_KEY?: string;
  // HTTP method. Closed enum; bad values (typo, wrong casing, "OPTIONS",
  // …) drop the whole entry at config-load. Defaults to "GET" when
  // absent — the same default the v0.5.x fetchers used unconditionally.
  METHOD?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  // Static JSON body sent with the request. Only meaningful when
  // METHOD is not GET (POST/PUT/PATCH carry a payload; DELETE
  // tolerates a body but most servers ignore it). Serialized with
  // JSON.stringify at fetch time. Must be a plain object — arrays,
  // strings, numbers are rejected at config-load. No template
  // placeholders; this is intentionally a static shape so the
  // provider config remains declarative (no template engine).
  BODY?: Record<string, unknown>;
};