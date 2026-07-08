# Changelog

## v0.8.29

### Added

- `m_acc*` modules now reconstruct cold slots from the JSONL
  sample stream. Previously, when `state.json` was missing
  (fresh install, after `:clean --purge-runtime`, accidental
  deletion), the first valid tick's `setAvg` seeded the
  `tickStatus:<dim>` slot from the current tick's delta only —
  historical JSONL data was discarded and the user saw a
  misleading `acc:0` followed by a one-tick blip. The new
  Stage 0 cold-slot replay runs BEFORE `setAvg` mutates the
  slot, marks the recovered aggregate into `_tickState.pending`,
  and lets the existing `commit()` flush everything in a single
  full-file rewrite (v1.0 one-write-per-tick invariant preserved).

### Behavior

- Three of the four `m_acc*` scopes participate: `session` /
  `project` / `model`. `ccsession` is intentionally excluded
  — it tracks one claude-code process invocation, so historical
  JSONL is semantically unrelated and replaying would mask
  process restarts. The regression-reset mark at Stage 1
  remains the only legitimate `ccsession` zero.
- The recovered aggregate is `mark()`-ed into `pending` so
  `setAvg` additively merges the current tick's delta on top
  of the recovered base. On invalid ticks (cwd+sessionId
  known but apiMs<=0), the recovered base is flushed standalone
  via `commit()` without this tick's delta — the historical
  truth is preserved without pollution from a bad row.
- `startAt` on the replayed slot is `min(row.startAt || row.at)`
  across matching rows. All-null / all-zero / empty JSONL →
  the natural cold-start `Date.now()` stamp from `setAvg`'s
  first-write branch fires instead. Mixed → `min(finite>0)`.
- Diagnostics: when `TOPGAUGE_CC_DIAGNOSTICS_ENABLE=1`, a
  `replay-acc-init` row is appended to
  `state/<projectHash>/diagnostics.jsonl` per cold-slot
  replay (scope + aggregated counts + startAt). Default off
  → no row.
- Warm slots (where `startAt != null`) short-circuit the
  replay before any JSONL read, so a confirmed value is
  preserved across the wipe-and-rebuild boundary.

### Files

- `src/status-store.ts` — new `replayAccKey` (scope-to-slot
  key resolver), `replayAccInit` (the cold-slot JSONL replay
  helper, returns a `TickStatusValue` ready to `mark()`),
  `readReplaySamples` (per-scope I/O dispatcher), and
  `readProjectSamples` (mirrors `readAllSamples` but only
  walks one `projectHash` subdir — `TokenSample` doesn't
  carry `projectHash`, so the project-scope boundary is
  enforced at the I/O level). New Stage 0 in `processTick`
  (after the `normalizeTick` snapshot is set, before the
  existing Stage 1 regression-reset).
- `src/status-store.replay.test.ts` — NEW. 13 tests covering
  the cold-slot replay matrix: cold session / project /
  model replay, warm-slot short-circuit, empty JSONL fall-
  through, ccsession exclusion, invalid tick gate, regression
  tick interaction, startAt edge cases (all-null / all-zero
  / mixed), and diagnostics env-gate.
- `CHANGELOG.md` — this entry.

## v0.8.27

### Added

- `m_sumStartTime` / `m_sumEndTime` now honor `|align|true`.
  When the inline arg is set AND the matching ctx Window
  (fiveHour or weekly) ships `resetStartAt` / `resetAt`, the
  rendered timestamps reflect the plan window open/close
  — the authoritative "when did this window open / close"
  answer — instead of the empirical min/max of captured
  samples. Pairs cleanly with v0.8.26+ bare modules
  (where `|align|false` is now the default): opt into the
  plan-anchored boundary by passing `|align|true` through
  the inline form or an outer `m_template|<key>|align|true`.

### Behavior

- `m_sumStartTime|window|5h|align|true` →
  `start:<resetStartAt formatted>` when ctx.fiveHour ships
  `resetStartAt`. Falls back to empirical `min(row.startAt)`
  when the Window has no `resetStartAt` (plan anchor
  unavailable, not absent). Empty window (`agg.rows === 0`)
  still renders `start:n/a` placeholder.
- `m_sumEndTime|window|5h|7d|align|true` →
  `end:<resetAt formatted>`. `resetAt` is unconditional in
  `slotsToWindow`, so the anchor branch fires for every
  aligned scan in practice.
- `|align|false` (v0.8.26+ default for bare m_sum*) keeps
  the empirical min/max reading even when the plan anchor
  is available. Align is opt-in, never forced.

### Files

- `src/render.ts` — bare + inline renderers of
  `m_sumStartTime` / `m_sumEndTime` consult
  `filter.alignActive` + `ctx.fiveHour` / `ctx.weekly`
  before the empirical `agg.firstAt` / `agg.lastAt`
  fallback.
- `src/render-tokens.test.ts` — 4 new tests pin the
  behavior: 5h `align|true` honors resetStartAt, 7d
  `align|true` honors resetAt, `align|false` keeps
  empirical even when the anchor is available,
  `align|true` falls back to empirical when the Window
  ships no anchor.

## v0.8.26

### Changed

- Bare `m_sum*` modules (`m_sumTokenIn` / `m_sumTokenOut` /
  `m_sumTokenCachedIn` / `m_sumTokenTotalIn` / `m_sumApiMs` /
  `m_sumTokenHitRate` / `m_sumTokenInSpeed` /
  `m_sumTokenOutSpeed` / `m_sumApiCalls` /
  `m_sumStartTime` / `m_sumEndTime`) now default
  `|align|false` instead of `|align|true`. Without the inline
  arg the scan reads the trailing **wall-clock** window
  `[nowMs - N, nowMs]`, matching "last 5h / 7d of activity".
  Inline callers who want the plan-aligned refill bucket
  `[resetStartAt, resetStartAt + duration]` must opt in with
  `|align|true`. The behavior is unchanged when ctx.fiveHour /
  weekly Window doesn't ship a resetStartAt, or when
  `window="all"` — both already collapsed to wall-clock
  before this change.

### Files

- `src/render.ts` — `parseWindowScope` `alignRaw ??` default
  flipped `true` → `false`; `ALIGN_PARAM` doc updated to spell
  out the new default and its narrow scope.
- `src/render-tokens.test.ts` — 2 new tests pin the new default
  for both `bare m_sumTokenIn` and `inline m_sumTokenIn|window|5h|align|false`
  against the same resetStartAt fixture the `align|true` test
  uses, asserting both reads pick up the wall-clock path while
  the existing `align|true` test still gets the aligned bucket.

## v0.8.25

### Added

- `|abs|<true|false>` inline arg on `m_accStartTime` /
  `m_sumStartTime` / `m_sumEndTime`. When `true`, the rendered
  body widens from `HH:MM:SS` (default) to `YYYY-MM-DD HH:MM:SS`
  (sv-SE locale, 24h clock, ASCII-space separator). Default is
  `false` so v0.8.24 renders stay byte-identical after upgrade.
  - Inline form: `m_accStartTime|abs|true|...`,
    `m_sumStartTime|abs|true|...`, `m_sumEndTime|abs|true|...`.
  - Pass-through form: an outer
    `m_template|<key>|abs|true` flips the flag for every
    inner module at once (matches the v0.8.7+ pass-through
    contract used by `scope` / `window` / `model` / `align`).
  - Resolver accepts only literal `true` / `false`; any other
    value (e.g. `abs|yes`) drops the token via the standard
    inline-badarg path. Same discipline as `ALIGN_PARAM`.
- `formatAbsTime(epochMs, opts: { abs?: boolean })` helper
  signature widened. The signature is additive (the second
  arg is optional) — every existing v0.8.24 caller still
  compiles and renders identically.

### Files

- `src/render.ts` — new `ABS_PARAM` schema, three inline-schemas
  extended, six renderer sites updated (3 bare + 3 inline),
  `formatAbsTime` helper widened.
- `src/render-tokens.test.ts` — 6 new tests covering the abs
  helper unit (shape + null/non-finite) and the runtime
  module path (default byte-identical + `abs|true` widens +
  badarg drops + composition with `|color|`).

## v0.8.24

### Added

- `m_accStartTime` / `m_sumStartTime` / `m_sumEndTime` modules.
  `m_accStartTime` reads the ccsession slot's `startAt` (Unix-ms)
  by default and supports `:scope:<session|project|model|ccsession>`.
  `m_sumStartTime` aggregates `min(s.startAt)` over the JSONL
  sample rows; `m_sumEndTime` aggregates `max(s.lastAt)`. Both
  m_sum* modules support the full 5-axis arg surface (`:model:`,
  `:window:`, `:align:`, `:color:`, `:nulldrop:`). Format:
  `HH:MM:SS` local time (sv-SE locale, 24h clock). Default labels:
  `labelStartTime = "start:"`, `labelEndTime = "end:"`.
- `startAt` field on `TickStatusValue` / `AvgSnapshot` — first-write
  instant of the slot (Unix ms), stamped by `setAvg` /
  `bumpDeltaScope` on the first valid write. Refreshed by the
  ccsession regression-reset mark so a Claude Code process restart
  re-opens the window. Legacy rows backfill to `null` (renders
  `start:n/a` placeholder).
- `startAt` / `lastAt` fields on `TokenSample` (JSONL rows).
  `startAt` is the per-session first-tick instant, read-once-per-tick
  from the JSONL head line via the new `resolveFirstTickAt` helper
  (sticky across cc process restarts because the JSONL is the only
  stable per-session state). `lastAt` mirrors the row's `at` for
  self-describing min/max aggregation. Legacy rows backfill to
  `null`; `aggregateSamples` filters them out of the `firstAt`
  roll-up via `Number.isFinite` gate.
- `labelStartTime` / `labelEndTime` in the `labels.*` namespace
  (v0.8.24). New fields in the labels type, defaults in
  `DEFAULT_CONFIG.labels`, and entries in the field allowlist.
- `formatAbsTime(ms)` helper in `src/render.ts` — `HH:MM:SS`
  local time via `sv-SE` locale + `hour12: false` (same idiom
  as `diagnostics.ts:localIso`). Returns `"n/a"` on null /
  non-finite / non-positive inputs.
- `StatAggregate.firstAt` field — min(s.startAt) over filtered
  rows. Defaults to 0 when no row carries a valid startAt.

### Changed

- `validateNormalizedTick` adds a `MAX_SAMPLE_API_MS` (300_000 ms,
  5 min) sanity ceiling on per-tick `apiMs` (inclusive). A single
  pathological stdin reading (clock skew, provider bug, stale
  baseline) can no longer pollute the JSONL sample stream or the
  per-session accApiMs sum. Well above any realistic per-tick API
  call (typically <60s) but below the 10min "pathological" marker.
- `ccsession` regression-reset (`detectRegression` trigger) now
  stamps `startAt: Date.now()` on the reset value, so the very
  first frame after a Claude Code process restart renders the
  post-reset "process clock start" instant (not `"n/a"` → next
  tick).

## v0.8.14

### Changed (BREAKING)

- `statuslineTemplate` is **array-only**. Legacy bare-string
  preset-name values (`"1line"`, `"standard"`, etc., from
  v0.4.0–v0.8.13) auto-migrate to the equivalent `["m_template|_X"]`
  form with a one-shot stderr warning. To silence the warning,
  write the array form directly:
  ```diff
  - "statuslineTemplate": "standard",
  + "statuslineTemplate": ["m_template|_standard"],
  ```
- **Balance-provider default render is now silent.** Pre-v0.8.14,
  `statuslineTemplate: "1line"` on a DeepSeek (BALANCE) provider
  silently fell back to `BALANCE_PRESETS["simple"]`. This
  provider-type-aware fallback is GONE — v0.8.14+ requires explicit
  opt-in:
  ```diff
  - "statuslineTemplate": "1line", // used to render BALANCE_PRESETS["simple"]
  + "statuslineTemplate": ["m_template|_balance_simple|mode|balance"],
  ```
  This matches the project's "user is explicit, framework doesn't
  guess" philosophy (cf. v0.8.13's literal `api:` / `calls:` /
  `in:` / `out:` defaults).

### Added

- Built-in presets are now first-class entries in `lineTemplates`
  with `_`-prefixed keys. Plan: `_1line`, `_simple`,
  `_simple-alone`, `_standard`, `_standard-alone`, `_abundant`,
  `_complete`. Balance: `_balance_simple`, `_balance_simple-alone`.
  Reference them via `m_template|_X` (with optional
  `|mode|plan|balance` to constrain dispatch — default `mode:plan`).
- `m_template`'s `mode` filter is now the explicit
  provider-type-aware dispatch mechanism.
- User `lineTemplates` entries whose names start with `_` and
  collide with a built-in preset are warned + skipped (the
  built-in wins). Use a different key for your own presets.

### Removed

- `PLAN_PRESETS` and `BALANCE_PRESETS` exported constants are
  gone — their contents moved into `DEFAULT_LINE_TEMPLATES` with
  `_`-prefixed keys (and the bodies preserved byte-for-byte).

## v0.8.13

### Added

- Extended `labelFor()` resolver with four new axes
  (`labelApi` / `labelApiCalls` / `labelInSpeed` / `labelOutSpeed`)
  so the apiMs / apiCalls / inSpeed / outSpeed module families are
  independently configurable. Defaults match the v0.8.x literal
  strings (`api:` / `calls:` / `in:` / `out:`) so existing renders
  stay byte-identical until the user overrides via config.json
  `labels.*`.
- Fixed two pre-existing off-by-one dispatcher skipLen bugs in
  `src/render.ts`: `m_sumTokenInSpeed` was 19 (correct: 18),
  `m_sumTokenOutSpeed` was 20 (correct: 19). Both caused the
  `|nulldrop|false` inline form to silently drop with an
  "unknown lineTemplate module" warning.

## v0.7.0

### Renamed

- Plugin renamed from `tokenplan-usage-hud` to `topgauge-cc` (formal
  product name **ToPGauge-CC**). Every user-visible identifier is updated:
  - Package id (`package.json.name`), plugin name
    (`.claude-plugin/plugin.json.name`), marketplace id
    (`.claude-plugin/marketplace.json.name`).
  - Slash command prefix: `/tokenplan-usage-hud:<verb>` →
    `/topgauge-cc:<verb>`.
  - Env-var namespace: `TOKENPLAN_*` → `TOPGAUGE_CC_*`
    (`TOKENPLAN_UPSTREAM` → `TOPGAUGE_CC_UPSTREAM`,
    `TOKENPLAN_UPSTREAM_CMD` → `TOPGAUGE_CC_UPSTREAM_CMD`,
    `TOKENPLAN_DIAGNOSTICS_ENABLE` → `TOPGAUGE_CC_DIAGNOSTICS_ENABLE`).
  - `settings.json.statusLine._tokenplan_managed` marker →
    `_topgauge_managed`.
  - Internal state-dir path: `~/.claude/plugins/tokenplan-usage-hud/state/`
    → `~/.claude/plugins/topgauge-cc/state/`.
  - Stderr banner: `tokenplan-usage-hud:` → `topgauge-cc:`.
  - Plugin cache glob: `plugins/cache/tokenplan-usage-hud/tokenplan-usage-hud/*/`
    → `plugins/cache/topgauge-cc/topgauge-cc/*/`.
  - GitHub URLs: `github.com/cwf818/tokenplan-usage-hud` →
    `github.com/cwf818/topgauge-cc`. README badges, install/upgrade
    recipes, and `gh repo create` instructions all updated.

### Preserved (intentional)

- Provider-string constants — `minimax`, `MiniMax`, `MiniMax-M3`,
  `minimaxi.com`, `TOKEN_PLAN`, `BALANCE`, `DeepSeek`, `deepseek`,
  `/v1/token_plan/remains`, `/user/balance` — are NOT renamed. They
  reference external API surfaces and are stable contract.
- Repo directory `D:\WorkSpace\tokenplan-usage-hud` is NOT renamed on
  disk in this release; only the plugin's user-visible identifiers
  change.

### Migration paths

- `scripts/install.sh` performs a **one-shot state-dir migration**: if
  `~/.claude/plugins/tokenplan-usage-hud/state/` exists and
  `~/.claude/plugins/topgauge-cc/state/` does NOT, the legacy tree is
  copied forward (preserving `upstream-cmd.sh`, `upstream-cmd.txt`,
  `cache.json`, `diagnostics.jsonl`, and any `<projectHash>/` token-sample
  sub-dirs). Idempotent: a re-run is a no-op. The legacy tree is left
  in place for inspection.
- `scripts/uninstall.sh` and `scripts/dev-uninstall.sh` perform a
  **one-release legacy dual-strip**: they recognize BOTH
  `tokenplan-usage-hud` and `topgauge-cc` (cache dirs, marketplace
  dirs, state dirs, `enabledPlugins` keys, `_tokenplan_managed` AND
  `_topgauge_managed` markers in `settings.json`). Existing pre-rename
  installs uninstall cleanly.
- `scripts/clean.sh --purge-runtime` and `scripts/clean-cache.sh` also
  walk both the new and the legacy cache/state roots so users get a
  fully purged system after one invocation.
- `scripts/test-install.sh` has a new regression test
  `--legacy one-shot state migration (v0.7.0: tokenplan-usage-hud -> topgauge-cc)`
  asserting the install script copies the legacy state dir forward
  when upgrading.

### Internals

- `scripts/uninstall.sh` was refactored to drive every dir / key
  lookup from a single `PLUGIN_NAMES=("topgauge-cc"
  "tokenplan-usage-hud")` array so the legacy dual-strip lives in one
  place rather than being sprayed across the script.
- `scripts/install.sh` and `scripts/lib/edit-settings.mjs` updated to
  write the new marker / cache glob / env-var wiring. The marker in
  `settings.json` becomes `_topgauge_managed`.
- All shell-script test fixtures (`scripts/test-install.sh`,
  `scripts/test-edit-settings.sh`, `scripts/test-clean-cache.sh`) and
  Node-side tests (`src/diagnostics.test.ts`,
  `src/render-tokens.test.ts`, `src/dispatch.test.ts`,
  `src/index-parse.test.ts`) were updated for the new names. The repo
  field in the captured `src/__fixtures__/stdin.real.json` fixture
  pins `name: topgauge-cc` to match the renamed plugin.

## v0.6.0

### Added

- Three optional per-provider HTTP request overrides on `ProviderEntry`:
  - `BEARER_KEY` — Bearer token sent in the `Authorization` header.
    Always wins over `process.env.ANTHROPIC_AUTH_TOKEN` when present;
    no env fallback.
  - `METHOD` — closed enum (`"GET" | "POST" | "PUT" | "PATCH" |
    "DELETE"`). Defaults to `"GET"`. Bad values drop the whole entry
    (strict).
  - `BODY` — static JSON object sent as the request body. Only
    meaningful when `METHOD` is not GET. Plain object required;
    arrays / strings / numbers drop just the field (lenient). No
    template placeholders.
- `fetchBalance` accepts the same `provider` 4th argument as
  `fetchRemains` so BALANCE providers can declare the same overrides
  symmetrically. The dispatcher in `src/providers.ts` now passes the
  entry to both fetchers.
- `src/index.ts` no longer short-circuits the whole tick when
  `ANTHROPIC_AUTH_TOKEN` is empty — the fetcher decides whether to
  make the call (it sees `entry.BEARER_KEY`). This makes per-provider
  credential rotation work in CI / sandboxed environments that don't
  carry the env var.

See `README.md § HTTP request overrides` for the worked example and
the strict-vs-lenient validation rules.

## v0.4.0

### Added

- 16 new statusline modules reading the captured Claude Code stdin
  payload (verbatim from `/statusline`'s stdin pipe):
  - `m_session`, `m_model`, `m_effort`, `m_repo`, `m_ccVersion` —
    session identity / metadata.
  - `m_sessionDuration`, `m_sessionApiDuration` — elapsed wall-clock
    duration in `1d2h3m` format.
  - `m_linesAdded`, `m_linesRemoved` — `+ 3965` / `- 967` style.
  - `m_tokenInTotal`, `m_tokenTotalOut` — session-cumulative input
    / output tokens (replaces the pre-v0.4.0 `m_tokenIn` /
    `m_tokenOut` semantics).
  - `m_contextSize`, `m_contextUsed` — context window size (compact
    form) and used percentage.
  - `m_windowContext` — bar + 5-band-colored percentage, parallel
    to `m_window5h` / `m_window7d`.
- New `src/__fixtures__/stdin.real.json` reference fixture capturing
  the full Claude Code session JSON shape (verified 2026-06-29).
- `TokenSnapshot` widened with new nullable sub-fields
  (`sessionName`, `modelDisplayName`, `effort`, `repo`, `ccversion`,
  `contextWindow`, `cost.totalApiDurationMs`, `cost.totalLinesAdded`,
  `cost.totalLinesRemoved`).
- `RenderContext` widened with `contextWindow: Window | null`
  (synthesized from `tokens.contextWindow.usedPct` for
  `m_windowContext`).
- `:display:used` / `:display:remaining` inline-args override for
  `m_window5h`, `m_window7d`, `m_windowContext`. Scoped to that
  module's bar computation only — does NOT mutate the global
  `display` config field. Accepts `used` / `remaining` verbatim
  (case-sensitive); anything else drops the token and warns once.
  The bare `m_window5h` form is byte-for-byte unchanged (still
  reads the global `display` config). Combine with `:color:` for
  both axes, e.g. `m_window5h:display:remaining:color:yellow`.
- `m_tokenInAvg` / `m_tokenOutAvg` modules — running-average per-API-call
  speed (`sum(current_tokens) / sum(delta_api) * 1000`, where
  `current_tokens` is the per-turn delta `current_usage.*`
  directly, NOT `current - prev`), backed by a per-session
  accumulator in `state/cache.json` (separate key
  `tickAvg:<sessionId>`, distinct from the per-tick `tickSpeed:`
  snapshot). Only valid-API-call ticks contribute
  (`delta_api > 0`); idle ticks don't accumulate. IN and OUT
  don't have to move together (a thinking-only turn adds 0
  input but real output, or vice versa), so we no longer
  require `delta_in >= 0 AND delta_out >= 0` — the contract
  `current_usage.*` is non-negative per-turn delta means
  regressions can't happen. First tick assumes `prev=0` and
  contributes. Like the speed modules, these always render —
  the slot in `lineTemplate.plan` is stable. Optional
  `:color:` override.
- Three per-session running-total modules — `m_totalTokenIn`,
  `m_totalTokenOut`, `m_totalTokenWithCacheIn`. Accumulate
  `current_usage.{input_tokens, output_tokens,
  cache_read_input_tokens}` directly across all
  valid-API-call ticks (`delta(total_api_duration_ms) > 0`;
  first tick assumes `prev=0`). The running totals live in
  the SAME `tickAvg:<sessionId>` cache slot that
  `m_tokenInAvg` / `m_tokenOutAvg` use — single source of
  truth. `AvgSnapshot` is extended with a `sumCache` field;
  both module families fire `setAvg` (idempotent — guarded by
  a per-render `_tickAvgWriteMemo` WeakMap so a template that
  mixes avg + totals + per-API-call modules still accumulates
  each delta exactly once). Always render — the first tick
  contributes (no more `in:0` / `out:0` / `cache:0` sentinels
  on the first tick), and idle ticks don't accumulate
  (`deltaApi <= 0`). `m_totalTokenWithCacheIn` renders
  `cache:--` when stdin lacks `current_usage.cache_read_input_tokens`
  (honest "data unavailable" signal, distinct from "no
  contributions yet"); otherwise `cache:<compact>`. Optional
  `:color:` override. The dispatcher lists
  `m_totalTokenWithCacheIn:` BEFORE the shorter
  `m_totalTokenIn:` / `m_totalTokenOut:` prefixes for
  prefix-shadowing safety (no actual shadowing — chars at
  index 17 differ — but listed first defensively).

### Changed

- `m_tokenIn` and `m_tokenOut` now read **`current_usage.{input,
  output}_tokens` directly as the per-turn delta** (Claude
  Code's session JSON already reports per-turn contribution —
  verified against the `stdin.real.json` fixture: `current_usage.
  input_tokens=140` while `total_input_tokens=126860`). The
  only subtraction is `delta(cost.total_api_duration_ms) > 0`
  — when API time grew this turn, the per-turn delta is
  valid. **No more `current - prev` subtraction**: the value
  IS the per-turn delta. The prev cache is only used to
  measure API time growth, not to compute token deltas. These
  modules **always render** — when no API call landed between
  ticks (idle tick with `delta(totalApiDurationMs) <= 0`) the
  chunk is **`in:0`**. First tick of a session, session change,
  or any cache miss now assumes **`prev.apiMs=0`** so the
  first turn still contributes its per-turn delta (no more
  `in:0` sentinel on first tick). For session-cumulative
  totals, use `m_tokenInTotal` / `m_tokenTotalOut` (or the
  existing `m_tokenTotal` / `m_tokenSession` for the
  in+out+cache total).
- `m_tokenInSpeed` and `m_tokenOutSpeed` compute the per-API-call
  throughput as **`current_usage.input_tokens /
  delta(total_api_duration_ms) * 1000`** (the per-turn delta
  is `current.*` directly, not `current - prev`). The renderer
  caches the previous tick's `totalApiDurationMs` (keyed by
  `sessionId`, disk-shadowed to `state/cache.json`). The
  direction-specific zero-rejection gate that previously
  collapsed `deltaIn == 0` to `-- t/s` is **gone** — a
  thinking-only turn that adds 0 input tokens but a real
  output rate shows the truthful `0.0 t/s` rate, not
  `-- t/s`. (A zero-delta gate conflated "API call landed but
  added nothing" with "no data / no API call" — a confusion
  the new contract removes.) **Always render** — only a true
  `deltaApi <= 0` (no API call) renders as `in:-- t/s`.
  First tick assumes `prev=0` and contributes its rate. The
  slot in `lineTemplate.plan` stays stable.
- `m_tokenInSpeed` / `m_tokenOutSpeed` cache the **last
  ACTIVE-tick tps per session** (key
  `tickSpeedDisplay:<sessionId>`, separate from
  `tickSpeed:<sessionId>`). On an idle tick
  (`deltaApi <= 0`), the module falls back to the cached tps
  and renders in **STALE_COLOR** (gray) — so the user reads
  the gray as "this is a stale measurement from a previous
  API call, not a real one now", and the speed module stops
  blinking through `-- t/s` between real measurements during
  fast statusline ticks. Idle ticks do NOT overwrite the
  cache — the cached value is "the last thing I measured"
  until the next active tick replaces it.
- New `:color:scale` inline-args value for `m_tokenInSpeed` /
  `m_tokenOutSpeed` (and the bare default — no `:color:` is
  now scale-aware). The scale maps tps to one of 5 colors
  (bright green / dark green / yellow / orange / red, faster
  = greener), with the OUT thresholds at `[10, 20, 40, 80]`
  t/s and the IN thresholds at `[50, 100, 200, 400]` t/s
  (input streams naturally run ~5× hotter than output).
  Thresholds are config-driven under
  `tokenFormat.speedScaleBands = { in, out }` — defaults
  match the values above. `:color:red` (or any other named
  shortcut / raw SGR) overrides scale on the **active**
  tick only — idle ticks always render STALE_COLOR
  regardless of `:color:` (gray is the canonical "inactive"
  signal, and inverting the override on idle ticks would
  conflate "stale measurement" with "this turn was actually
  this slow"). The MODULES path (bare `m_tokenInSpeed`)
  also defaults to scale, so the bare form and
  `:color:scale` are byte-equivalent.
- `m_ccversion` renamed to `m_ccVersion` for consistency with
  the other camelCase metadata modules (`m_sessionDuration`,
  `m_windowContext`, etc.). Module key, schema, renderer,
  dispatcher branch, tests, and docs updated. The bare
  `m_ccversion` token is no longer recognized and will hit the
  standard "unknown lineTemplate module" warn path.
- `parseTokenSnapshot` is shape-tolerant on the new `effort` field
  (accepts both bare strings and `{ level: "high" }` objects) and
  on the new `workspace.repo` field (preserves the sub-object even
  when some sub-fields are null, so the renderer can decide whether
  to render the partial join).
- `:nulldrop:<true|false>` inline-args parameter on every `m_*`
  module. **Default = `:nulldrop:false` (force placeholder when
  data is null)** so the slot stays in `lineTemplate.plan` and
  the line layout doesn't shift when stdin lacks a field (e.g.
  after `/clear` starts a new session and `used_percentage` is
  missing). `:nulldrop:true` opts OUT of the placeholder and
  preserves the v0.3.x drop-on-null behaviour for users who
  prefer the slot to disappear. Placeholder shape per family:
  pure-number → `<prefix>n/a` (e.g. `ctx:n/a`, `in:n/a`),
  number+unit → `-- <unit>` (e.g. `5h:--`, `+ --`, `- --`,
  `in:-- t/s`), gauge → `░░░░░░░░ 0%` (or `▓▓▓▓▓▓▓▓ 100%` in
  remaining mode), bare-string → `n/a`. The default color is
  `STALE_COLOR`; `:color:<c>` overrides as with every other
  inline module. The bare MODULES path is **unchanged** — bare
  `m_ctx` / `m_windowContext` / etc. still drop on null, since
  pre-v0.4.0 configs that listed bare tokens must not silently
  change behaviour. To opt a bare-style config into the
  placeholder, add the trailing colon (`m_ctx:`) — the inline
  form defaults to placeholder. Modules whose inline renderers
  already force a placeholder via the always-render rule
  (`m_tokenIn` / `m_tokenOut` / speed / avg / totals / `m_token5h`
  / `m_token7d`) accept `:nulldrop:` for schema uniformity but
  the parameter has no effect on their output.

### Changed (BREAKING)

- **`lineTemplate` config field is REMOVED in v0.4.0** — replaced
  by two new top-level fields:
  - **`lineTemplates`** — a registry of reusable template fragments.
    Values are token arrays. Allowed tokens: any `m_*` module
    **EXCEPT `m_template`**, plus `s_*` separators. Keys are
    user-chosen. Default-merged with the legacy `{ plan, balance }`
    shape so existing internal lookups keep working.
  - **`statuslineTemplate`** — the actual template the renderer
    walks. Accepts **a fixed preset name** (e.g. `"1line"`,
    `"simple"`, `"standard"`, `"abundant"`, `"complete"`,
    `"simple-alone"`, `"simple-alone"` for balance) **OR a raw
    token array**. Array form may include `m_template:` tokens
    and any other `m_*` / `s_*`. String form does NOT accept
    arbitrary `lineTemplates` keys — only the fixed preset names.
  - **Migration is a HARD BREAK** — the loader emits one
    `tokenplan-usage-hud: config lineTemplate is removed in v0.4.0`
    warning per config load and ignores the legacy field
    entirely. There is no auto-promotion of `lineTemplate.plan`
    → `lineTemplates.plan`. v0.3.x users who customized the
    `lineTemplate` block must rename it to `statuslineTemplate`
    (string preset or raw array) and move reusable fragments to
    `lineTemplates`. v0.4.0's default config produces the same
    rendering as v0.3.6's default — only customized configs
    require manual migration.

### Added (v0.4.0+)

- New `m_template:<key>[:mode:<plan|balance>][:nulldrop:<bool>]`
  inline-args module — expands the registered
  `lineTemplates[key]` fragment into the current render. Mode
  filter (`mode:<plan|balance>`, default `plan`) hides the
  chunk on the wrong provider type, so a single
  `lineTemplates` key can render differently for plan vs
  balance providers (e.g. share the `Usage:` / `Balance:`
  label, customize the body). Nesting is impossible: the
  loader strips `m_template:` tokens from any `lineTemplates`
  entry at load time. Missing key → warns + drops. Mode
  mismatch → silent drop (no warn). `:color:` is silently
  ignored on `m_template`; put `:color:` on the inner
  modules if needed.

### Changed (BREAKING) — Per-Project State Layout

The plugin's runtime state directory is now partitioned by
project, so multiple Claude Code sessions running in
**different** project directories never contend over the same
files. Assumption: one project directory → one Claude Code
session; multi-Claude workflows come from opening the project
in different directories.

**New layout** under
`~/.claude/plugins/tokenplan-usage-hud/state/`:

```
state/
  upstream-cmd.sh              # top-level — install/uninstall dependency, NOT touched
  upstream-cmd.txt             # top-level — install/uninstall dependency, NOT touched
  config.json                  # top-level — install/uninstall dependency, NOT touched
  <projectHash>/               # e.g. d--workspace-tokenplan-usage-hud
    cache.json                 # disk-shadowed TTL cache (per-project key isolation)
    diagnostics.jsonl          # append-only warning/error log (per-project)
    <sessionId>.jsonl          # token samples (was state/token-samples/<hash>/<sid>.jsonl)
```

- `cache.json`, `diagnostics.jsonl`, and token-samples have
  moved **off the top-level** and into
  `state/<projectHash(cwd)>/`. The `projectHash(cwd)` helper
  (lowercased, `\/: ` → `-`, control chars stripped, capped at
  80 chars) was already exported from `src/token-store.ts` —
  every per-tick IO path now derives its path from the cwd in
  `TokenSnapshot`.
- Cache key isolation across projects: `src/render.ts` prefixes
  every cache key with `<projectHash>:<key>`. The cache module
  API itself is unchanged — the prefix lives in render.ts so
  the disk format stays single-keyed and cache tests still pass
  with no mocks. Per-project `cache.json` files never share
  keys.
- Diagnostics: `append(level, source, msg, now?, cwd?)` /
  `readLatest(level, cwd?)` / `diagnosticsPath(cwd?)` gained
  an optional `cwd` argument. When omitted or null, writes fall
  back to the legacy top-level `state/diagnostics.jsonl` so
  plugin-level errors (e.g. config-parse warnings) still have
  somewhere to go. `src/index.ts` passes `tokens?.cwd ?? null`.
- Token samples: `sampleFilePath` now builds
  `state/<projectHash(cwd)>/<sessionId>.jsonl` directly (the
  intermediate `token-samples/` directory is gone). The
  `m_token5h` / `m_token7d` modules continue to call
  `readSamples(t.cwd, ...)` and get per-project isolation
  transparently.

**Migration for users upgrading from v0.4.0–v0.4.<n-1>**:
legacy top-level `cache.json` and `diagnostics.jsonl` are NOT
auto-migrated (no project information is recoverable from
them — start fresh). Legacy
`state/token-samples/<projectHash>/<sessionId>.jsonl` files
are also not auto-migrated on tick (would cost 3–10ms IO per
tick for time-decaying data). To preserve old token samples,
run the bundled one-shot helper:

```bash
bash scripts/migrate-state.sh         # actually move
bash scripts/migrate-state.sh --dry-run  # preview only
```

It `mv -n`s each
`state/token-samples/<hash>/<sid>.jsonl` →
`state/<hash>/<sid>.jsonl`, then `rmdir`s the empty project
subdirs and the empty `token-samples/` parent. Idempotent.

**Cleanup**: `clean.sh --purge-runtime` now walks every
`state/*/` subdir and removes its `cache.json`,
`diagnostics.jsonl`, and `<*.jsonl>` files. It still cleans
the legacy top-level `cache.json` / `diagnostics.jsonl` and
the `state/token-samples/` tree (one-shot upgrade path for
users who don't bother with `migrate-state.sh`). Top-level
`upstream-cmd.{sh,txt}` and `config.json` are NEVER purged —
install/uninstall depends on them.

`scripts/uninstall.sh` is unchanged at the code level — the
existing `rm -rf "$STATE_DIR"` is naturally compatible with
the per-project layout.

## v0.3.6

- `m_quote` module: numeric time format for `:freq` inline-args.
