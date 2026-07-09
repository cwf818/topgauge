# ToPGauge-CC — Display Modules Manual (v0.8.14)

This file documents every token you can write inside `statuslineTemplate`
and inside entries of `lineTemplates.<key>` (consumed via
`m_template|<key>…`). All paths, presets, and module names below reflect
**v0.8.14** (provider `MiniMax-M3` for `ANTHROPIC_BASE_URL=https://api.minimaxi.com/anthropic`,
`BALANCE` provider for DeepSeek).

A template is a JSON array of tokens. Two kinds exist:

| Kind  | Shape                            | Meaning                                              |
| ----- | -------------------------------- | ---------------------------------------------------- |
| `m_*` | Display module — colored chunk.  | See the per-module table below.                      |
| `s_*` | Separator reference — literal.   | See the separator table below.                       |

Tokens can be written in **bare form** (`"m_window|term:short"`) or **inline-arg
form** (`"m_window|term:short|color:red|display:remaining"`). Inline args
override per-token; bare form falls back to global config.

> **Inline-arg grammar is two-class since v0.8.33.** The first
> separator is `|` (pipe); pairs inside use `:` (colon) or `=` (equals) as the
> name/value boundary. The first `:` or `=` in a pair splits name from
> value; everything after that is part of the value. The implicit-value
> slot (`m_label|<text>|…`, `m_template|<name>|…`, `s_<n>`)
> is `|`-bounded and may contain `:` or `=` freely. The **bare**
> `|` form for pair boundaries (`"m_window|term|short"`) is **removed** —
> the dispatcher will warn and drop the token. This is a hard breaking
> change: rewrite any legacy config by replacing `|name|value|` with
> `|name:value|` or `|name=value|`.

---

## 1. Inline-arg syntax

```
<token>[|<implicit>][|<name>:<value>][|<name>=<value>]…
```

- The first segment is the module name; if the schema declares an
  `implicit` slot (`m_label`, `m_template`, `s_<n>`), the FIRST
  trailing segment is the implicit value (label text / template name /
  separator alias). The implicit value is `|`-bounded and may contain
  `:` or `=` freely.
- Each subsequent pair is split on the **first** `:` or `=` — the left
  side is the name, the right side is everything that follows (so values
  may themselves contain `:` or `=`).
- Order of `name:value` pairs doesn't matter; duplicates keep the last.
- Unknown `name` or malformed pair (no `:`, no `=`, unknown name,
  resolver-rejected value) → dispatcher warns to stderr and drops the
  token (no partial render).

### 1.1 Shared named parameters

Every `m_*` that takes inline args accepts a common subset. Per-module
exceptions are called out in §3.

| Name        | Accepted values                                                                | Default            | Effect                                                                                                                                              |
| ----------- | ------------------------------------------------------------------------------ | ------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| `color`     | SGR string OR shortcut (`red`, `green`, `yellow`, `blue`, `cyan`, `magenta`, `white`, `gray`, `orange`, `purple`, plus `rainbow`/`rand-rainbow`/`hue` for `m_quote`) | module's natural palette | Replaces the module's band color. WINS over stale-color / placeholder-color.                                                       |
| `nulldrop`  | `true` \| `false`                                                              | `false`            | `false` → keep placeholder slot when data is missing (`STALE_COLOR`-wrapped `n/a` / `-- <unit>` / empty gauge). `true` → drop the chunk (adjacent separators trimmed). |
| `display`   | `used` \| `remaining`                                                          | global `display`   | **Window modules only** (`m_window|term|short|mid|long`). Flip between "show used %" and "show remaining %". Inline wins over config.              |
| `term`      | `short` \| `mid` \| `long`                                                     | `short`            | **`m_window` / `m_countdown` / `m_quota` only (v0.9.0+).** Selects which `intervals.<term>` slot to read. `short` → 5h, `mid` → 7d, `long` → 30d (or whatever the provider's `intervals` config binds). |
| `type`      | `plan` \| `balance`                                                            | `plan`             | **`m_template` only.** Filter sub-template by provider `TYPE`. **Recommended name (v0.8.15+).** The legacy alias `mode` is still accepted; when both are present on the same token, `type` wins. Neither arg is forwarded via `passThrough` (§1.2). |
| `scope`     | `ccsession` \| `session` \| `project` \| `model`                              | `ccsession`        | **`m_acc*` only.** Pick which slot of the four-layer accumulator to read. See §3.                                                                  |
| `model`     | `active` \| `all` \| `<name>`                                                  | `active`           | **`m_sum*` only.** Narrow the JSONL scan to one model identity or every row.                                                                       |
| `window`    | `<dhms>` (e.g. `5h`, `7d`, `1h30m`, `2d12h`) \| `all` \| `<interval.windowId>` | `all`              | **`m_sum*` only (v0.8.32+).** Time window for the JSONL scan. A free-form `<digits><unit>` chain resolves to wall-clock `[now - N, now]`. The literal `all` scans the entire jsonl with no time anchor (also the bare default). A configured `interval.windowId` (e.g. `"monthly"` against `intervals.longInterval.windowId = "monthly"`) resolves to a plan-aligned scan ONLY when `|align|true` is also passed — see `align` row below. |
| `align`     | `true` \| `false`                                                              | `false`            | **`m_sum*` only (v0.8.32+).** Opt-in flag for declared-windowId resolution. `align=true` causes the resolver to look up `<interval.windowId>` first; on a match the scan runs plan-anchored against that interval's `resetStartAt`. On a miss (or when `align=false`) the resolver falls through to free-form dhms. The literal `all` short-circuits before this lookup regardless of `align`. |
| `freq`      | `s` \| `m` \| `h` \| `d` \| `<digits><unit>`                                   | `h`                | **`m_quote` only.** Bucket size for quote rotation.                                                                                                 |
| `address`   | URL string                                                                     | `""` (empty)       | **`m_quote` only (v0.8.18+, v0.8.19 fallback, v0.8.20 diagnostics).** When non-empty, fetch the URL via `curl -sSf --max-time 5` and use the body as the quote source instead of the bundled `quotes.json`. The fetched body is JSON-parsed; see `fields` for how the strings are extracted. On any failure (curl exit, non-JSON body, all paths miss), the renderer falls back to the local `quotes.json` list so the user always sees something. Each failure also appends a `warning` row to `diagnostics.jsonl` (gated on `TOPGAUGE_CC_DIAGNOSTICS_ENABLE=1`) under `source = "m_quote"` so a postmortem can grep why the local fallback fired. |
| `fields`    | Comma-separated list of dot-paths (e.g. `hitokoto,from,from_who`)               | `""` (empty)       | **`m_quote` only (v0.8.19+).** Each path is walked independently against the JSON response (object keys / array indices / strings — string terminates the walk, anything after is ignored). The collected strings are rendered as `field1: field2:` (colon-joined, trailing colon). Pairs with `address`. v0.8.18's singular `field` is REMOVED. |
| `repeat`    | `<1..8>` (integer)                                                             | `1`                | **`s_*` only (v0.7.2+).** Multiply the separator body.                                                                                             |
| `wrap`      | `true` \| `false`                                                              | `true`             | **`s_*` only (v0.7.2+).** When `true` and the body is printable, pad with one space on each side (so `s_dot|wrap|true` → `" · "`).               |

> **Custom `interval.windowId` rules (v0.8.32+):** Any string is accepted, including digit-prefixed ones (the v0.8.31 digit-prefix restriction is removed). The `"all"` literal is RESERVED as the no-time-anchor sentinel — `parseWindowScope` short-circuits on it before any windowId lookup, so users CANNOT name an `interval.windowId: "all"`. To resolve a `|window|<id>` against a declared ID, pass `|align|true`; with `align=false` (default) the resolver always treats the string as free-form dhms. See the `align` row above.

### 1.2 `m_template` passthrough (v0.8.7+)

When an outer `m_template|<key>|…` expansion receives extra named args
beyond the intrinsics `key`, `type`, and `mode` (the latter two are
different names for the SAME intrinsic — the providerType filter;
only one is typically present, but both are excluded from
passthrough just in case), those args are pushed down to the inner
modules as a **passthrough** view. Inner-explicit-wins: if the inner
token uses the same arg explicitly (e.g. `m_accTokenIn|scope|project`
inside the template body), the inner value beats the passthrough.
`key`, `type`, and `mode` are NEVER pushed down — they are
`m_template`-local concerns.

```jsonc
// Outer scope|project → bare m_accTokenIn inside reads project scope.
// Inner explicit |scope|session → wins; m_accTokenIn reads session scope.
{
  "statuslineTemplate": ["m_template|acc|scope:project"],
  "lineTemplates": {
    "acc": [
      "m_accTokenIn",
      "s_space",
      "m_accTokenIn|scope|session"  // explicit beats passthrough
    ]
  }
}
```

---

## 2. Separators (`s_*`)

Reference a literal from `cfg().separators[]` (numeric form) or one of
six built-in aliases (named form).

### 2.1 Numeric form: `s_<n>`

- `s_0` … `s_<N-1>` — index into `separators` array in `config.json`.
- v0.4.x+ default `separators: []` — the array is empty out of the
  box, so bare `s_0`/`s_1` warn + drop unless the user fills the
  array. Migrate templates to named aliases (below) to keep working.
- Out-of-range index → token dropped (stderr warn).
- Multiple bare `s_0` are NOT collapsed; both render.

### 2.2 Named alias form (always literal, ignores `separators` array)

| Token         | Literal     | Notes                                              |
| ------------- | ----------- | -------------------------------------------------- |
| `s_space`     | `" "`       | Always a single space.                             |
| `s_dot`       | `"·"`       | Middle dot (U+00B7).                               |
| `s_newline`   | `"\n"`      | Line break — splits render into "above / below".   |
| `s_tab`       | `"\t"`      | Tab character.                                     |
| `s_colon`     | `":"`       | Colon.                                             |
| `s_pipe`      | `"\|"`      | Pipe (added v0.7.1+; mirrors the inline-args delimiter). |

**Rule**: the named form always renders the built-in character, even
if the user has overridden `separators[0]` to `"x"`. This makes
self-documenting templates (e.g.
`["m_window|term|short", "s_space", "m_countdown|term|short"]`) immune to user-config
reshuffles.

### 2.3 Separator placement rules

- Adjacent separators around a dropped module are **skipped** — a
  null `m_ctx` won't leave `… · · …` artifacts.
- Leading/trailing separators are trimmed at the renderer level.
- Newlines (`s_newline`) act as hard breaks: output above the break
  is the upstream section, the break itself goes into composition,
  output below is appended.

### 2.4 `repeat` and `wrap` (v0.7.2+)

```
s_dot|repeat:3          → "···"
s_dot|repeat:3|wrap:true → " · · · "
s_space|repeat:4        → "    "   (whitespace body skips wrap padding)
s_newline|repeat:2      → "\n\n"  (control body skips wrap padding)
```

- `repeat` is an integer 1..8; out-of-range → drop.
- `wrap=true` pads printable bodies with one space on each side;
  whitespace / control bodies (newlines, tabs, the `s_space` /
  `s_tab` / `s_newline` aliases, plus any `separators[]` entry that
  matches `isControlBody`) skip the padding.

---

## 3. Module reference (`m_*`)

The table covers every module the renderer recognizes as of v0.8.14.
**Type filter** tells you which provider TYPE the module is gated
to; modules with no entry apply to every provider (and to
provider-less ticks via the `unknown` TYPE fallback).

| Module                             | Renders (shape example)                                                              | Source field                                              | Type filter        | Inline args                            | Notes |
| ---------------------------------- | ------------------------------------------------------------------------------------ | --------------------------------------------------------- | ------------------ | -------------------------------------- | ----- |
| **Provider data (plan / balance)** |                                                                                      |                                                           |                    |                                        |       |
| `m_modeLabel`                      | `Usage:` (plan) / `Remain:` (plan-display="remaining") / `Balance:` (balance).       | derived from `providerType` + global `display`            | (always emits)     | `color`, `nulldrop`                    | First item in default line templates.   |
| `m_window\|term:short\|mid\|long` (default `term=short`) | Bar + colored % of the chosen interval, e.g. `▓░░░░░░░ 9%`.   | `intervals.<term>.usedPercent` / `.remainingPercent` + `.startAt` / `.endAt` (projected through `intervalToWindow`) | plan    | `color`, `display`, `term`, `nulldrop` | v0.9.0+. `term=short` reads `intervals.shortInterval` (default 5h), `term=mid` reads `intervals.midInterval` (default 7d), `term=long` reads `intervals.longInterval` (default 30d). `stale=true` dims bar + tail to `STALE_COLOR`. `display:remaining` flips the % sign. |
| `m_countdown\|term:short\|mid\|long` (default `term=short`) | `(4h47m🕔 5h)` reset countdown with fill-state arrow.    | `intervals.<term>.startAt` / `.endAt` / `.intervalMs`     | plan               | `color`, `term`, `nulldrop`            | v0.9.0+. Arrow from `resetArrows` indexed by `remainingMs / resetDurationMs`. Drops if no `startAt`/`endAt`/`intervalMs`. Renders `<label>:--` placeholder when data is missing and `nulldrop` is false. |
| `m_quota\|term:short\|mid\|long` (default `term=short`) | Quota display, e.g. `quota(5h):100/500` / `quota(5h):0/500` / `quota(5h):100/--`. | `intervals.<term>.usedQuota` / `.limitQuota`              | plan               | `color`, `term`, `nulldrop`            | v0.9.0+. Body rules: `used+limit` → `used/limit`; `limit only` → `0/limit`; `used only` → `used/--`. All three null → drop. |
| `m_balance`                        | `CNY 110.00 · USD 5.00`.                                                            | `balance.entries[]`                                       | balance            | `color`, `nulldrop`                    | Color band driven by the LOWEST `totalBalance`. |
| `m_age`                            | `🔗 5m ago` (fresh) / `⛓️‍💥 5m ago` (stale).                                                | `ageMs`, `stale`                                          | agnostic           | `color`, `nulldrop`                    | Emits at most once per render (ref-deduped across `m_template|` recursion). Forced-visibility fallback appends `⛓️‍💥 X ago` only when the user did NOT list `m_age` and `stale=true`. |
| `m_version`                        | `v0.8.14` plugin version.                                                            | `version` from `.claude-plugin/plugin.json`               | agnostic           | `color`, `nulldrop`                    | Emits nothing when version string is empty. |
| `m_memUsage`                 | System RAM usage, `Mem:15.9G/63.7G` (default label `Mem:`).                          | `os.totalmem()` / `os.freemem()` (Darwin: `vm_stat`)      | agnostic           | `color`, `nulldrop`                    | v0.8.17+. Cross-platform live sample; no caching. 1024-base, G uses `.toFixed(1)`, M/K use `.toFixed(0)`. Query failure → `Mem:n/a` placeholder. Label is user-configurable via `labels.labelMemUsage` (default `"Mem:"`, mirrors ccstatusline). |
| `m_windowMemUsage`           | System RAM used percentage, `RAM%:45.3%`.                                            | `os.totalmem()` / `os.freemem()` (Darwin: `vm_stat`)      | agnostic           | `color`, `nulldrop`                    | v0.8.36+. 5-band colored via `thresholds.percentBands` (same `colorFor` helper used by `m_window`). `|color|<c>` overrides the band color. Distinct from `m_memUsage` (absolute bytes `Mem:X.XG/Y.YG`); both modules coexist. Label configurable via `labels.labelWindowMemUsage` (default `"RAM%:"`). Opt-in — not in any default preset. |
| `m_label\|<text>`                   | Literal `<text>`.                                                                    | inline                                                    | agnostic           | `color`, `nulldrop`                    | `<text>` is the implicit first segment — anything `\|` in the value goes into the `name:value` parse. |
| `m_template\|<key>[\|type:plan\|balance]` | Inserts `lineTemplates.<key>` in place. Recursively expanded (loader strips nested `m_template` at load time). | inline key                                  | filtered by `type` | `type` (legacy alias: `mode`), plus any other args get **passthrough** (§1.2) | `type:plan` skips on a BALANCE provider and vice versa. Default `type=plan`. Legacy `mode` is still accepted (same resolver, same semantics); when both `type` and `mode` are present on the same token, `type` wins. Built-in presets use the `_` prefix — see §4. |
| **Per-turn / Acc / Sum family**    |                                                                                      |                                                           |                    |                                        |       |
| `m_tokenIn` / `m_accTokenIn` / `m_sumTokenIn` | per-turn: `in:154` · acc: `acc(ccs):163.5k` · sum: `in:240k` | per-turn: stdin · acc: `status.json` `accTokenIn[scope]` · sum: cross-project JSONL scan | agnostic           | per-turn: `color`, `nulldrop` · acc: `color`, `nulldrop`, `scope` · sum: `color`, `nulldrop`, `model`, `window`, `align` | Three semantic variants of the same metric. Drops when stdin lacks the field; per-turn value=0 renders as `in:0` (value-zero rule). Acc default scope `ccsession`; sum reads `state/cache.json` cross-project TTL slot. v0.8.32+: `m_sum*` accepts `align:true\|false` (default false) to opt into declared-windowId resolution — `align:true` resolves `window:<id>` against an `interval.windowId` and runs plan-anchored; `align:false` (default) goes straight to free-form dhms wall-clock. Bare `m_sum*` defaults to `window=all`. |
| `m_tokenOut` / `m_accTokenOut` / `m_sumTokenOut` | per-turn: `out:135` · acc: `acc(ccs):120k` · sum: `out:180k` | per-turn: stdin · acc: `status.json` `accTokenOut[scope]` · sum: cross-project JSONL scan | agnostic           | same as `m_tokenIn` row                  | Same as above. |
| `m_tokenCachedIn` / `m_accTokenCachedIn` / `m_sumTokenCachedIn` | per-turn: `cache:62k` · acc: `acc(ccs):1.2M` · sum: `cache:880k` | per-turn: stdin · acc: `status.json` `accTokenCachedIn[scope]` · sum: cross-project JSONL scan | agnostic           | same as `m_tokenIn` row                  | Per-turn renamed from `m_cacheRead` / `m_cachedTokenIn` in v0.8.0. |
| `m_tokenInTotal` / `m_accTokenTotalIn` / `m_sumTokenTotalIn` | per-turn: `in:42k` · acc: `acc(ccs):42k` · sum: `in:240k` | per-turn: `tokens.totals.tokenTotalIn` · acc: `accTokenIn + accTokenCachedIn` · sum: in + cachedIn over window | agnostic           | same as `m_tokenIn` row                  | Per-turn = stdin cumulative input (excludes cache reads); acc/sum variants add cache reads. v0.8.0+ family. |
| `m_apiMs` / `m_accApiMs` / `m_sumApiMs` | per-turn: `api:5s` / `api:1m` / `api:<1m` · acc: `acc(ccs):api:1m` · sum: `api:42m` | per-turn: `cost.totalApiDurationMs` delta · acc: `status.json` `accApiMs[scope]` · sum: cross-project JSONL scan | agnostic           | same as `m_tokenIn` row                  | Per-turn idle tick → cached value, `STALE_COLOR`ed (no `api:n/a` after the v0.8.x R9 unify). Honors `timeFormat.minUnit`. |
| `m_apiCalls` / `m_accApiCalls` / `m_sumApiCalls` | per-turn: `calls:42` · acc: `acc(ccs):calls:42` · sum: `calls:240` | per-turn: `status.json` `accApiCalls` slot · acc: same · sum: cross-project JSONL scan | agnostic           | same as `m_tokenIn` row                  | `calls:0` is real data (value-zero rule) — `nulldrop` is a no-op. |
| `m_tokenHitRate` / `m_accTokenHitRate` / `m_sumTokenHitRate` | per-turn: `hit:99%` · acc: `acc(ccs):hit:99%` · sum: `hit:97%` | per-turn: `current.tokenCachedIn / (tokenCachedIn + tokenIn)` · acc: derived · sum: cross-project JSONL scan | agnostic           | same as `m_tokenIn` row                  | v0.8.x: TTL gate disabled — idle tick surfaces cached value, `STALE_COLOR`ed, never expires. Drops on 0 cache activity. v0.8.x R8: prefix unified across all three variants. |
| `m_tokenInSpeed` / `m_accTokenInSpeed` / `m_sumTokenInSpeed` | per-turn: `in:42 t/s` · acc: `acc(ccs):in:42 t/s` · sum: `in:24 t/s` | per-turn: `lastActive.in` + `tickStatus.tokenIn` · acc: derived · sum: `sumTokenIn / sumApiMs * 1000` | agnostic           | same as `m_tokenIn` row                  | v0.8.13+. Idle tick → cached value, `STALE_COLOR`ed. `color\|scale` (or bare) maps tps to green→red across 5 bands. |
| `m_tokenOutSpeed` / `m_accTokenOutSpeed` / `m_sumTokenOutSpeed` | per-turn: `out:18 t/s` · acc: `acc(ccs):out:18 t/s` · sum: `out:9 t/s` | per-turn: `lastActive.out` · acc: derived · sum: `sumTokenOut / sumApiMs * 1000` | agnostic           | same as `m_tokenIn` row                  | v0.8.13+. Same idle / scale semantics as `m_tokenInSpeed`. |
| `m_tokenTotal` (alias `m_tokenSession`) | Per-turn in+out, `total:289`. | `tokens.current.tokenIn + tokenOut` | agnostic | `color`, `nulldrop` | Standalone per-turn combined metric (not part of the 3-tuple family — no acc / sum variant). |
| `m_contextSize`                    | Cumulative context input tokens, `size:163.5k`.                                      | `tokens.totals.tokenTotalIn`                              | agnostic           | `color`, `nulldrop`                    | Renamed from `m_ctx` in v0.8.0. Single-layer (no acc / sum variant). |
| `m_contextWindowsSize`             | Capacity of the context window, `size:200k`. (typo in name preserved.)              | `context_window.size`                                     | agnostic           | `color`, `nulldrop`                    | Single-layer context-window metadata. |
| `m_contextUsedPercent`             | Percentage of capacity used, `used:82%`.                                            | `context_window.usedPct`                                  | agnostic           | `color`, `nulldrop`                    | Renamed from `m_contextUsed` in v0.8.0. Single-layer. |
| `m_contextRemainingPercent`        | Percentage of capacity remaining, `remain:18%`.                                     | `context_window.remainingPct`                             | agnostic           | `color`, `nulldrop`                    | v0.8.0+ sibling of `m_contextUsedPercent`. Single-layer. |
| **Misc / session metadata**        |                                                                                      |                                                           |                    |                                        |       |
| `m_session`                        | User-defined session name, e.g. `fix-bar-color-regressions`.                        | `tokens.sessionName`                                      | agnostic           | `color`, `nulldrop`                    | Drops when `sessionName` empty. |
| `m_model`                          | Display name of active model, e.g. `MiniMax-M3`.                                     | `tokens.modelDisplayName`                                 | agnostic           | `color`, `nulldrop`                    | |
| `m_effort`                         | Effort level: `low` / `medium` / `high` / `max`.                                    | `tokens.effort`                                           | agnostic           | `color`, `nulldrop`                    | |
| `m_repo`                           | `host/owner/name`, e.g. `github.com/cwf818/topgauge-cc`.                           | `tokens.workspace.repo`                                   | agnostic           | `color`, `nulldrop`                    | Drops when no repo. |
| `m_branch`                         | Current git branch.                                                                  | `git info from cwd`                                       | agnostic           | `color`, `nulldrop`                    | Drops when not a git repo. |
| `m_gitStatus`                      | Git dirty / clean indicator: `dirty` / `clean`.                                      | `git status`                                              | agnostic           | `color`, `nulldrop`                    | |
| `m_ccVersion`                      | Claude Code version, e.g. `2.1.191`.                                                 | `tokens.ccversion`                                        | agnostic           | `color`, `nulldrop`                    | Lowercase alias `m_ccversion` also accepted (legacy). |
| `m_sessionDuration`                | Wall-clock duration of session, `2h 15m`.                                            | `tokens.cost.totalDurationMs`                             | agnostic           | `color`, `nulldrop`                    | |
| `m_sessionApiDuration`             | API-only duration, `1m 23s`.                                                         | `tokens.cost.totalApiDurationMs`                          | agnostic           | `color`, `nulldrop`                    | |
| `m_linesAdded`                     | Lines added in the session, `+ 1.2k`.                                                | `tokens.cost.totalLinesAdded`                             | agnostic           | `color`, `nulldrop`                    | |
| `m_linesRemoved`                   | Lines removed in the session, `- 340`.                                               | `tokens.cost.totalLinesRemoved`                           | agnostic           | `color`, `nulldrop`                    | |
| `m_quote`                          | A rotating quote, frequency-bucketed (local) or strings from a remote endpoint (v0.8.19+). | `quotes.json` (bundled) by default; or `<address>` response when `\|address\|<url>` is set | agnostic           | `freq`, `color`, `address`, `fields`, `nulldrop` | Color shortcuts: `rainbow` (cycles bands), `rand-rainbow` (random per render), `hue` (continuous from wall-clock). When `address` is set, the body is fetched via `curl -sSf --max-time 5`; `fields` is a comma-separated list of dot-paths (e.g. `hitokoto,from,from_who`) — each path is walked independently against the JSON response (object key / array index; a string leaf terminates the walk). The collected strings are rendered as `field1: field2: … fieldN:`. On any fetch / parse / walk failure (curl exit, non-JSON body, all paths miss), the renderer falls back to the local `quotes.json` list **and appends a `warning` row to `diagnostics.jsonl`** (gated on `TOPGAUGE_CC_DIAGNOSTICS_ENABLE=1`) with `source = "m_quote"` and a reason-tokenized `msg`. v0.8.18's singular `field` is REMOVED. |

#### `m_quote` online endpoint examples (v0.8.21+)

Three ready-to-paste `m_quote` tokens that pull from public quote
APIs. The `quote` + `author` named-args each walk a dot-path into
the JSON body; both walks happen in one fetch, and the rendered
output is `~<quote>~` (no author) or `~<quote>--<author>~` (with
author). Wrap with `~…~` by default; pass `wrap|false` to opt
out. On fetch / parse / walk failure the renderer silently falls
back to the bundled local QUOTES list.

```text
m_quote|address:https://v1.hitokoto.cn/|quote:hitokoto|author:from_who
m_quote|address:https://api.quotable.io/random|quote:content|author:author
m_quote|address:https://api.xygeng.cn/one|quote:data.content|author:data.name
```

### Removed in v0.8.0 (no alias)

`m_token5h`, `m_token7d`, `m_tokenInAvg`, `m_tokenOutAvg`, `m_ctx`
(→ `m_contextSize`), `m_cachedTokenIn` / `m_cacheRead`
(→ `m_tokenCachedIn`), `m_contextUsed` (→ `m_contextUsedPercent`),
`m_totalTokenIn`, `m_totalTokenOut`, `m_totalTokenWithCacheIn`
(→ `m_accTokenIn` / `m_accTokenOut` / `m_accTokenCachedIn` with
`scope|ccsession`).

> **Note:** the built-in `_complete` preset (see §4) still references
> a few of these removed module names. If you copy `_complete` into
> your `statuslineTemplate`, manually translate them to the
> `m_accToken*` family with `scope|ccsession` — see §5.

---

## 4. Per-module type filters

The renderer tags each module with a `type` value. A module's emit is
skipped when the active provider's TYPE doesn't match.

| TYPE value | Active when                                       |
| ---------- | ------------------------------------------------- |
| `plan`     | Provider has `TYPE: "TOKEN_PLAN"`.                |
| `balance`  | Provider has `TYPE: "BALANCE"`.                   |
| `unknown`  | No provider entry matched `ANTHROPIC_BASE_URL`.   |

`agnostic` modules (everything not labeled plan/balance) emit on every
tick.

---

## 5. Drop semantics & `nulldrop` recap

| Form                                       | Behavior when underlying data is `null`                              |
| ------------------------------------------ | -------------------------------------------------------------------- |
| `m_*` (bare)                               | DROP — module skipped, adjacent separators trimmed.                  |
| `m_*|nulldrop|false` (default inline)      | PLACEHOLDER — module renders a fixed `STALE_COLOR`-wrapped body so the layout stays stable. |
| `m_*|nulldrop|true`                        | DROP — same as bare form.                                            |

Placeholder shapes per module class:

| Module class                  | Placeholder body                          |
| ----------------------------- | ----------------------------------------- |
| pure number                   | `<prefix>n/a` (e.g. `in:n/a`)             |
| number + unit                 | `-- <unit>` (e.g. `5h:--`)                |
| gauge (window)                | `░░░░░░░░ 0%` (gray)                       |
| countdown / quota             | `<label>:--` (gray) — e.g. `5h:--` for `m_countdown\|term\|short`, `quota(5h):--` for `m_quota\|term\|short` |
| bare string                   | `n/a`                                     |
| ratio (hit-rate family)       | `<prefix>n/a%` (e.g. `hit:n/a%`)          |

`m_window|term|short|mid|long` (any term) always render the gauge
shape with the `STALE_COLOR` band when stale, regardless of `display`
mode.

**Value-zero rule** (since v0.8.x): when the module's data path yields
the literal number `0` (not `null`), the module renders the value as
`0` (e.g. `in:0`, `calls:0`). Divide-by-zero renders as `--`.

---

## 6. Color values accepted by `|color|`

Anything `resolveColor()` accepts. Three categories:

1. **Shortcut name** (one of: `red`, `green`, `yellow`, `blue`, `cyan`,
   `magenta`, `white`, `gray`, `orange`, `purple`) — expands to a
   built-in 256-color SGR.
2. **Raw SGR escape** (any string starting with `\x1b[`).
3. **`m_quote` extras**: `rainbow`, `rand-rainbow`, `hue`.

`STALE_COLOR` (`\x1b[90m` = bright black) and `BROKEN_COLOR`
(`\x1b[31m` = red) are the two implicit fallback colors used when a
module's data is missing or its fetch is broken — see `colors.stale`
and `colors.broken` in `config.json`.

---

## 7. Composition with the upstream statusline

Tokens that produce a `\n` (`s_newline`, or any multi-line body) split
the rendered output into "above the break" and "below the break" chunks:

- Everything ABOVE the first newline is **prepended** to the upstream
  output (whatever `TOPGAUGE_CC_UPSTREAM` contains).
- Everything BELOW is **appended** after the upstream.

This is how `["m_template|_standard", "s_newline", "m_template|_balance_simple|type:balance"]`
renders: a multi-line plan section + a multi-line balance section,
sandwiched around the upstream statusline.

---

## 8. Built-in presets (v0.8.14+)

The seven plan + two balance presets are first-class entries in
`cfg().lineTemplates` with `_`-prefixed keys. Reference them from your
`statuslineTemplate` array via `m_template|_X`. The optional
`|type|plan|balance` second arg constrains dispatch to one provider
TYPE — default is `type|plan`, so a `_balance_*` preset silently
drops on a TOKEN_PLAN provider unless overridden. (The legacy
`|mode|…` form is still accepted.)

| Key                       | Lines | Description                                                                          | Default `type` |
| ------------------------- | ----- | ------------------------------------------------------------------------------------ | -------------- |
| `_1line` / `_simple`      | 1     | Token-plan only, single line (byte-identical aliases).                               | `plan`         |
| `_simple-alone`           | 1     | Single line with explicit `"Usage:"` label prefix (for solo use, no upstream).       | `plan`         |
| `_standard`               | 2     | Line 0 = token-plan, line 1 = context + tokens (no session line).                    | `plan`         |
| `_standard-alone`         | 3     | Adds session info on line 0 (for solo use, no upstream chain).                       | `plan`         |
| `_abundant`               | 4     | Line 0 = session + git (deep git workflow).                                          | `plan`         |
| `_complete`               | 5     | Adds totals on line 3 (verbose — not recommended; see Note below).                  | `plan`         |
| `_balance_simple`         | 1     | Default balance render (`"Balance: <balance>"`).                                     | `balance`      |
| `_balance_simple-alone`   | 1     | Balance render with explicit `"Balance:"` label prefix (for solo use).               | `balance`      |

Usage:

```jsonc
{
  "statuslineTemplate": ["m_template|_standard"],
  // Or, for a DeepSeek (BALANCE) provider, the explicit form:
  // "statuslineTemplate": ["m_template|_balance_simple|type:balance"]
}
```

The `_` prefix marks a built-in preset — user-defined
`lineTemplates.<_*>` entries that collide with a built-in key are
**rejected** (warn + skip). Use a different key for your own presets.

> **Note on `_complete`:** the built-in body still references a few
> modules removed in v0.8.0 (`m_totalTokenIn`, `m_totalTokenOut`,
> `m_totalTokenWithCacheIn`). Treat `_complete` as **deprecated** and
> either pick `_abundant` or hand-roll a 5-line variant that uses
> `m_accTokenIn|scope|ccsession`, `m_accTokenOut|scope|ccsession`,
> `m_accTokenCachedIn|scope|ccsession`.

---

## 9. Quick example templates

```jsonc
// Minimal: just the mode label and 5h window.
"statuslineTemplate": ["m_modeLabel", "s_space", "m_window|term|short"]

// Default-style (with named separators between modules).
"statuslineTemplate": [
  "m_modeLabel|color|yellow",
  "s_space",
  "m_window|term|short",
  "s_dot",
  "s_space",
  "m_window|term|mid",
  "s_space",
  "m_age|color|gray"
]

// Plan-only with custom 5h color override + sum tokens:
// (v0.8.32+: `|window|5h` resolves to free-form dhms wall-clock
// by default (align=false skips the windowId lookup). To opt into
// a plan-anchored scan against shortInterval's resetStartAt, add
// `|align:true` after the windowId-resolution token. See the
// `align` row in §1.1 for the full opt-in matrix.)
"statuslineTemplate": [
  "m_template|plan|type:plan",
  "s_newline",
  "m_template|balance|type:balance"
],
"lineTemplates": {
  "plan": [
    "m_window|term:short|color:red|display:remaining",
    "s_space",
    "m_countdown|term:short",
    "s_dot",
    "s_space",
    "m_window|term:mid",
    "s_space",
    "m_countdown|term:mid",
    "s_newline",
    // Wall-clock 5h — the new bare-default behavior.
    "m_sumTokenIn|window|5h",
    "s_dot",
    "s_space",
    // Plan-aligned against shortInterval's resetStartAt.
    "m_sumTokenHitRate|window:5h|align:true"
  ],
  "balance": [
    "m_balance",
    "s_space",
    "m_age"
  ]
}

// Compose with the upstream statusline via the standard preset:
"statuslineTemplate": ["m_template|_standard"]
```

> **Migration tip:** if you have a pre-v0.7.1 config written with `:`,
> the easiest path is a global replace `s/:/|/g` on every token
> inside `statuslineTemplate` and `lineTemplates.*`. The dispatcher
> only recognizes `|`, so any leftover `:` will silently route the
> token through the bare-MODULES path and warn "unknown module".