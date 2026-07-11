// Provider discriminated union. A single `ANTHROPIC_BASE_URL` selects exactly
// one provider at runtime; `null` means "no provider — render nothing".
//
// v0.2.21: Provider widened to `string | null` — providers are now
// data-driven via the `providers` config block (see src/config.ts and
// src/providers.ts). Adding a provider requires a config entry and a
// plugin module, but does not require editing this type union. The TYPE
// discriminator drives the plugin output shape and renderer / fail-label
// path.

export type Provider = string | null;

// Closed enum for now. If a new TYPE is added, the fetcher / renderer /
// template selection logic grows a new branch — data shape changes
// cannot be made data-driven (they need code to interpret them).
export type ProviderType = "Quota" | "BALANCE";

export type CompareMethod = "EXACT" | "INCLUDE" | "STARTWITH";

// v0.9.0+ — intervals namespace.
//
// Each Quota provider describes up to three independent plan
// windows (a 5-hour interval, a 7-day interval, and a 30-day monthly
// interval). Each interval has 11 fields, all of which the user can
// supply through the `intervals` config block (top-level or per-
// provider). `windowId` and `label` have built-in defaults
// (`"5h"` / `"7d"` / `"30d"`); every other field must come from
// the user's config or from the effective context assembled for the
// active plugin. `intervalS` and `intervalMs` are unit twins — a path that
// resolves to a number-of-seconds value goes through `intervalS` and
// is converted to ms internally; both forms are equivalent.
//
// Field groups (parser enforces each independently):
//
//   PERCENT  (remainingPercent, usedPercent) — at least 1 required.
//            If both mapped → used wins. If only one → the other
//            is derived as `100 - x`. If neither → the interval
//            has no % data and the renderer falls back to
//            placeholder.
//
//   TIME     (startAt, endAt, intervalMs) — at least 2 of 3
//            required. If startAt+endAt present → use them
//            (explicit wins). If startAt+intervalMs → endAt
//            derived as startAt + intervalMs. If endAt+intervalMs
//            → startAt derived as endAt - intervalMs. If only 1
//            present → all three fields return null and the
//            interval is treated as time-unknown.
//
//            `intervalMs` has a 3-step fallback chain (uniform
//            across all three intervals):
//              1. path resolution against the API response
//              2. numeric parse (e.g. "18000000" → 18000000,
//                 or intervalS * 1000 if intervalS was a path)
//              3. keyword lookup — probe the response root for
//                 `hour`, `fiveHour`, `day`, `sevenDay`, `week`,
//                 `month`, `year` in that order; each match is
//                 multiplied by the right ms-per-unit
//                 (3600000 / 18000000 / 86400000 / 604800000 /
//                 2592000000 / 31536000000).
//
//   QUOTA    (remainingQuota, usedQuota, limitQuota) — any 1 is
//            preserved verbatim. The renderer (`m_quota`) decides
//            what's enough to render based on what it has:
//              used + limit → "used/limit"
//              limit only   → "0/limit"
//              used only    → "used/--"
//              none         → placeholder/drop.
//
// All path values are dot/bracket expressions (see src/path-expr.ts).
// Non-string path values drop the field with a stderr warn at
// config-load time (see validateIntervalSlot in src/config.ts).
export type IntervalKey = "shortInterval" | "midInterval" | "longInterval";

// vX.X.X+ — currencies namespace. Mirrors the `intervals` shape but
// keyed on a free-form currency code (CNY / USD / …) instead of a
// fixed enum. Each entry declares:
//
//   label        — display prefix rendered before the number. Falls
//                  back to the currency-code key when omitted. The
//                  legacy `cfg().currency.prefixes[code]` lookup is
//                  NO LONGER consulted by the renderer for entries
//                  resolved through this block — `label` is the
//                  single source of truth.
//   totalBalance — path expression; numeric value. Resolved against
//                  the provider response via `resolveSlot(..., "number")`.
//                  Matches the legacy `balance_infos.0.total_balance`
//                  shape (DeepSeek default) out of the box.
//
// The block replaces the v0.5.0–v0.8.x hardcoded `entries` field on
// the `Balance` parser output. Providers that don't ship the new
// shape can still emit `entries` directly via the plugin transport
// — `looksLikeBalance` (in src/api.ts) treats the legacy shape as
// valid when `intervalsConfig`/`currenciesConfig` is absent, and
// skips path resolution.
export type CurrencySlotConfig = {
  label?: string;
  totalBalance?: string;
};

// CurrenciesConfig is keyed by uppercase currency code (CNY, USD,
// …). The renderer's `m_balance` walks the keys in declaration
// order and emits one "label + totalBalance" chunk per key. Free-
// form keys are allowed so non-ISO providers can ship their own
// codes — the resolver doesn't normalize / dedupe.
export type CurrenciesConfig = Record<string, CurrencySlotConfig>;

// vX.X.X+ — entry-level currencies block (layer 3 of the 4-layer
// merge in resolveEffectiveCurrencies). Same shape as the top-level
// `currencies` block.
export type ProviderCurrenciesConfig = CurrenciesConfig;

export type IntervalSlotConfig = {
  // Built-in defaults: shortInterval → "5h", midInterval → "7d",
  // longInterval → "30d". When omitted, the parser fills these in.
  //
  // vX.X.X+ — windowId is now an arbitrary opaque label. The
  // m_sum* `|window|<id>` resolver distinguishes named IDs from
  // dhms via the `|align|` param (align=true → look up windowId
  // first, then fall through to dhms; align=false → always dhms,
  // never windowId), so user-supplied IDs no longer need to be
  // guarded against parseDhms. The literal `"all"` is reserved as
  // the no-time-anchor sentinel and CANNOT be used as a windowId
  // — `parseWindowScope` short-circuits on it before any lookup.
  windowId?: string;
  // Built-in default: same as windowId. The renderer reads this
  // to print the window's display label (e.g. "5h" in
  // `quota(5h):123/500`).
  label?: string;
  // Path expression; numeric value [0, 100].
  remainingPercent?: string;
  // Path expression; numeric value [0, 100]. Used wins over
  // remainingPercent when both are mapped.
  usedPercent?: string;
  // Path expression; epoch-ms number.
  startAt?: string;
  // Path expression; epoch-ms number.
  endAt?: string;
  // Raw seconds value (NOT a path). Converted to intervalMs
  // internally. Used in step 2 of the intervalMs fallback chain.
  intervalS?: number;
  // Raw ms value (NOT a path). Used in step 2 of the intervalMs
  // fallback chain when the user prefers explicit milliseconds.
  intervalMs?: number;
  // Path expression; integer quota (free-form units — no
  // normalization across providers).
  remainingQuota?: string;
  // Path expression; integer quota.
  usedQuota?: string;
  // Path expression; integer quota.
  limitQuota?: string;
};

export type IntervalConfig = Partial<Record<IntervalKey, IntervalSlotConfig>>;

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
// v0.8.0+ — TokenSample field rename. The previous names were
// semantically backward (e.g. `in` actually held the session-cumulative
// `totals.input`, while `ctx_in` held the per-turn delta). v0.8.0
// aligns the field names with the module family they feed into:
//
//   totalIn        = session-cumulative input tokens (was `in`)
//                      → m_tokenTotalIn, m_sumTokenTotalIn
//   totalOut       = session-cumulative output tokens (was `out`)
//                      → m_tokenTotalOut (v0.8.0+ rename from
//                        m_tokenOutTotal), m_sumTokenOut
//   in             = per-turn input delta (was `ctx_in`)
//                      → m_tokenIn, m_sumTokenIn
//   cacheIn        = per-turn cache_read_input_tokens (was `ctx_read`)
//                      → m_tokenCachedIn, m_sumTokenCachedIn
//   cacheCreation  = per-turn cache_creation_input_tokens (was `ctx_creation`)
//                      → no module yet (reserved)
//   totalApiMs     = session-cumulative cost.totalApiDurationMs (was `apiMs`)
//                      → recorded for off-line audit; not consumed by
//                        any module directly (m_accApiMs reads in-memory)
//   apiMs          = per-tick delta of cost.totalApiDurationMs (was `deltaApiMs`)
//                      → m_apiMs, m_sumApiMs
//
// v0.8.0 is still pre-release; this rename is not backward-compatible
// with v0.4.x / v0.5.x / v0.6.x / v0.7.x jsonl rows. On-disk files
// from those versions are NOT migrated — the next tick writes the
// new schema and old rows are simply ignored by the v0.8.0 reader
// (no `at`/`totalIn`/`totalOut` → skipped). This is consistent with
// the v0.8.0 major-version bump and avoids a complex field-by-field
// migration for stale state files.
export type TokenSample = {
  at: number;
  // Required numeric fields — the reader drops rows that lack these
  // (older v0.4.x–v0.7.x rows missing the renamed fields are skipped).
  totalIn: number;
  totalOut: number;
  // Per-turn deltas — sum of these over a window = m_sumTokenIn /
  // m_sumTokenOut. Added in v0.8.0+; m_sumTokenOut was previously
  // broken because it summed the cumulative `out` column. Now
  // symmetric with `in` (also per-turn).
  in: number;
  out: number;
  cacheIn: number;
  cacheCreation: number;
  // v6.x — session+cwd are encoded in the path
  // (`state/<projectHash>/<sessionId>.jsonl`), so the row no longer
  // carries them. `model` and `totalApiMs` are stamped when
  // totalApiDurationMs>0 so per-model splits are available to
  // m_sumTokenIn:window:5h / m_sumTokenIn:window:7d consumers (the
  // v0.8.0+ replacements for the v0.4.x m_token5h / m_token7d
  // modules). `apiMs` (formerly `deltaApiMs`) is the per-tick
  // increment of `cost.totalApiDurationMs` since the prior append
  // (first tick assumes prior=0), so off-line consumers can
  // reconstruct per-API-call latency without replaying the in-memory
  // prev-tick cache. It also feeds the v0.8.0+ m_apiMs module and
  // the m_sumApiMs aggregate. Older rows without these optional
  // fields read as undefined.
  model?: string;
  totalApiMs?: number;
  apiMs?: number;
  // v0.8.x — the cached prev apiMs at write time. Lets off-line
  // inspectors distinguish a real delta from a fallback path:
  //   prevApiMs === null  → cache miss on first tick (no baseline);
  //                          apiMs may be the fallback value (out/50*1000)
  //                          or the full session total if totalApiMs > 0.
  //   prevApiMs === 0     → cache hit but baseline was zero.
  //   prevApiMs > 0       → normal case, apiMs = totalApiMs - prevApiMs.
  // undefined for legacy rows written before this field existed.
  prevApiMs?: number | null;
  // v0.8.24+ — per-row time anchor. The "first tick of this
  // session" wall-clock instant. m_sumStartTime aggregates via
  // min(s.startAt) so the "earliest session start in the
  // window" reading is one lookup away. Read-once-per-tick
  // from the JSONL head line at processTick time.
  // `null` for legacy rows (pre-v0.8.24) — the aggregate's
  // Number.isFinite gate filters them out.
  startAt?: number | null;
  // v0.8.24+ — the "current tick" anchor. Mirrors `at` for the
  // current row; m_sumEndTime aggregates via max(s.lastAt) so
  // the field is self-describing without re-deriving from `at`.
  // `null` for legacy rows.
  lastAt?: number | null;
};

// What the renderer needs to know about a single tick. Built once in
// src/index.ts (drains stdin, samples, appends to disk) and passed to
// the renderer's `RenderContext` extension below.
//
// `current` = post-turn snapshot (used by m_tokenIn, m_tokenOut,
//            m_tokenCachedIn, m_tokenHitRate, m_tokenInSpeed,
//            m_tokenOutSpeed). `totals` = session cumulative (used by
//            m_tokenInTotal, m_tokenTotalOut, m_tokenTotalIn).
//            `cost` = stdin.cost block. `contextWindow` = context
//            window size + used% (m_contextSize, m_contextUsedPercent,
//            m_windowContext). The session-identity / metadata
//            fields (sessionName, modelDisplayName, effort, repo,
//            ccversion) feed the corresponding m_* modules verbatim.
//
// v0.8.0+ — semantic clarification:
//   - `current.tokenIn` / `current.tokenOut` / `current.tokenCachedIn`
//     are PER-TURN DELTAS (the contract formalized in
//     [[per-turn-delta-contract]]). The user's invariant
//     `total_input_tokens == input_tokens + cache_read_input_tokens`
//     must hold; a diagnostics warning is emitted on violation.
//   - `totals.tokenTotalIn` / `totals.tokenTotalOut` are session-cumulative.
//
// v0.9.x — module-keyed field naming. Each parse-time field is now
// named for its primary reader module so the path from stdin to
// renderer is one hop, no layer of indirection. The `current` group
// still encodes "per-turn delta" (vs the `totals` group encoding
// "session-cumulative") because the type-level invariant rides on
// that distinction. Naming summary:
//
//   current.tokenIn         ← m_tokenIn,         stdin: current_usage.input_tokens
//   current.tokenOut        ← m_tokenOut,        stdin: current_usage.output_tokens
//   current.tokenCachedIn   ← m_tokenCachedIn,   stdin: current_usage.cache_read_input_tokens
//   current.tokenCacheCreation ← (no module yet), stdin: current_usage.cache_creation_input_tokens
//   totals.tokenTotalIn     ← m_tokenTotalIn / m_tokenInTotal / m_contextSize
//                                  stdin: context_window.total_input_tokens
//   totals.tokenTotalOut    ← m_tokenTotalOut,   stdin: context_window.total_output_tokens
//   contextWindow.contextWindowSize        ← m_contextWindowsSize (typo preserved),
//                                                stdin: context_window.context_window_size
//   contextWindow.contextUsedPercent       ← m_contextUsedPercent,
//                                                stdin: context_window.used_percentage
//   contextWindow.contextRemainingPercent  ← m_contextRemainingPercent,
//                                                stdin: context_window.remaining_percentage
export type TokenSnapshot = {
  sessionId: string | null;
  cwd: string | null;
  totals: {
    tokenTotalIn: number | null;
    tokenTotalOut: number | null;
  };
  current: {
    tokenIn: number | null;
    tokenOut: number | null;
    tokenCacheCreation: number | null;
    tokenCachedIn: number | null;
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
    contextWindowSize: number | null;
    contextUsedPercent: number | null;
    contextRemainingPercent: number | null;
  };
};

// v0.8.0+ — per-session / per-model / per-project accumulator
// snapshot. Replaces the v0.4.x `AvgSnapshot` type (which used the
// `sum*` prefix). The setAvg / peekAvg / __resetAvgForTest helpers in
// src/render.ts return / consume this shape. Field semantics:
//
//   accTokenIn        — accumulated current.input across API calls
//   accTokenOut       — accumulated current.output across API calls
//   accTokenCachedIn  — accumulated current.cacheRead across API calls
//                       (renamed from `accTokenCachedIn` so the name matches
//                       the per-turn module `m_tokenCachedIn`)
//   accApiMs          — accumulated cost.total_api_duration_ms across API
//                       calls (cumulative, not per-tick delta — the
//                       per-tick writeBack uses `apiMs` directly)
//   accApiCalls       — count of valid API calls that produced
//                       input tokens (see sumApiCount contract in
//                       render.ts:computeTickAvg)
//
// The same shape is persisted at three slots in `status.json`:
//   tickStatus             (project-wide, accumulating)
//   tickStatus:<sessionId> (per-session, absolute since reset)
//   tickStatus:<modelName> (per-model, accumulating)
//
// All three are kept in sync by setAvg's atomic three-slot write
// (see render.ts:947-1035).
export type AccSnapshot = {
  accTokenIn: number;
  accTokenOut: number;
  accTokenCachedIn: number;
  accApiMs: number;
  accApiCalls: number;
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
// v0.9.0+ — added optional `intervals` block: a per-provider mapping
// from the three interval terms (`shortInterval` / `midInterval` /
// `longInterval`) onto per-interval slot configs. Each slot config
// declares the path expressions (and optional numeric defaults) the
// parser uses to project the provider's JSON response into one of
// three `Interval` objects (see `Interval` in src/render.ts).
// Replaces the v0.5.0–v0.8.x flat `parameters` block (8 fixed slot
// names: `remainingPercentInterval`, `usedPercentInterval`,
// `remainingPercentWeekly`, `usedPercentWeekly`, `startAtInterval`,
// `endAtInterval`, `startAtWeekly`, `endAtWeekly`). Path expressions
// follow the grammar in src/path-expr.ts (`a.b[0].c` / `a.0.b.0.c`
// style with permissive type coercion). The per-provider `intervals`
// block is deep-merged on top of the top-level `intervals` block at
// config-load time (see validateProviderEntry in src/config.ts).
export type ProviderEntry = {
  TYPE: ProviderType;
  BASE_URL_COMPARED_TO: string;
  COMPARE_METHOD: CompareMethod;
  // Provider-specific Config overrides. Same shape as the top-level
  // config.json (minus the `providers` key itself). Validated at
  // config-load time: must be a plain object; unknown keys are
  // forwarded to the existing per-field validators (same warn
  // behavior as the top-level config).
  config?: Record<string, unknown>;
  // v0.9.0+ — interval-term → slot-config mapping. Each key is one
  // of `shortInterval` / `midInterval` / `longInterval`; each value
  // is an `IntervalSlotConfig` declaring which fields the parser
  // should populate from the provider response. Missing terms resolve
  // to a fully-null `Interval` at fetch time; the renderer treats a
  // null `Interval` as "no data" (drop / placeholder per module
  // contract). The legacy flat `parameters` field (v0.5.0–v0.8.x) is
  // REMOVED — old configs with `parameters` are silently ignored (no
  // stderr warn; top-level provider keys not declared on
  // `ProviderEntry` are dropped).
  intervals?: IntervalConfig;
  // vX.X.X+ — per-provider currencies block. Mirrors the
  // top-level `currencies` config: maps currency codes
  // (CNY / USD / …) onto `{ label, totalBalance }` slot configs.
  // Resolved against the BALANCE provider's raw response at fetch
  // time by `resolveEffectiveCurrencies(id, entry)` in src/config.ts;
  // the built-in parser (`parseBalance` in src/plugins/parsers.ts) walks the resolved map
  // and pulls each entry's `totalBalance` value via the configured
  // path expression. Used by DeepSeek out of the box (CNY default),
  // and by any BALANCE provider that wants a data-driven currency
  // map. Layer 3 of the 4-layer merge — overrides the top-level
  // `currencies` block entirely for the active provider.
  currencies?: ProviderCurrenciesConfig;
  // Provider-specific credential. It takes precedence over
  // process.env.ANTHROPIC_AUTH_TOKEN and is passed to the plugin's
  // fetchAccountCredit method.
  AUTHENTICATION_KEY?: string;
};