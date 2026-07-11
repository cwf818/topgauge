// Template defaults and template-only types. This module has no config-store
// or provider dependencies so it can be reused by the config facade.

// ----- Defaults — must match today's hardcoded values exactly -----

// Default separator strings referenced from lineTemplate as s_0, s_1, ….
// Empty by default in v0.4.x — the v0.4.0-release style built-in
// characters (" ", "·") are now also available as NAMED ALIASES
// vX.X.X+ — `separators` config array and the numeric `s_<n>`
// dispatch are REMOVED. The six built-in characters
// (`s_space` / `s_dot` / `s_newline` / `s_tab` / `s_colon` /
// `s_pipe`) are the only separator tokens. To render any other
// literal in your template, use `m_label|<your-text>` (or just
// drop a free-form token — the renderer emits unknown tokens
// verbatim now).

// Default line layout. A template is an ordered list of tokens; each
// token is either a display module ("m_<name>"), a named separator
// ("s_space" / "s_dot" / …), or a free-form literal. The renderer
// walks the list left-to-right and concatenates the output of each
// module, with s_<name> rendered as the built-in literal character.
// See render.ts:renderTemplate for the full grammar.
//
// Defaults reproduce the v0.2.16 output byte-for-byte:
//   plan:    "Usage: <5h> <countdown5h> · <7d> <countdown7d>"
//   balance: "Balance: <balance>"
// with s_space / s_dot / s_space composing " · " between windows.
//
// v0.4.0+ — kept around as the SOURCE OF TRUTH for the `plan` / `balance`
// entries inside `DEFAULT_LINE_TEMPLATES`. The legacy top-level
// `lineTemplate: { plan, balance }` config field is REMOVED in v0.4.0+
// (loader warns + ignores); the `m_template` module reads from
// `lineTemplates[key]` instead. Tests still reference this constant via
// __testing, so don't remove.
const DEFAULT_LINE_TEMPLATE: {
  plan: string[];
  balance: string[];
} = {
  // v0.4.x — the default template uses the NAMED ALIASES (s_space,
  // s_dot) so it works with the new empty default `separators`
  // array. The visual output is byte-for-byte identical to the
  // v0.4.0 release: the `s_0 + s_1 + s_0` composition is replaced
  // with `s_space + s_dot + s_space`, both producing " · ".
  plan: [
    "m_modeLabel", "s_space",
    "m_windowQuota|term:short", "s_space", "m_countdown|term:short",
    "s_space", "s_dot", "s_space",
    "m_windowQuota|term:mid", "s_space", "m_countdown|term:mid",
  ],
  balance: ["m_modeLabel", "s_space", "m_balance"],
};

// v0.4.0+ — registry of reusable template fragments. Each value is a
// token array (the same shape as the v0.3.x `lineTemplate.{plan,balance}`
// entries). Allowed tokens: `m_*` modules EXCEPT `m_template`, plus
// `s_*` separators. The loader strips `m_template:` tokens at load
// time so nesting is impossible.
//
// Keys are user-chosen (e.g. `foo`, `myWorkload`). The renderer reads
// from this registry when it encounters an `m_template|<key>` token
// inside `statuslineTemplate`. The legacy `PLAN_PRESETS` /
// `BALANCE_PRESETS` tables (v0.4.0–v0.8.13) are GONE in v0.8.14 — the
// seven plan + two balance presets are now first-class entries in
// this registry with `_`-prefixed keys. Plan presets
// (`_1line` / `_simple` / `_simple-alone` / `_standard` /
// `_standard-alone` / `_abundant` / `_complete`) target Quota
// providers; balance presets (`_balance_simple` /
// `_balance_simple-alone`) target BALANCE providers (DeepSeek). The
// user references them via `m_template|_X` (with optional
// `|mode|plan|balance` to constrain dispatch to one provider type —
// `m_template` defaults to `mode:plan`).
//
// `_`-prefix = built-in preset, NOT overridable by user. The loader
// rejects user `lineTemplates._*` entries whose name collides with a
// built-in key (warn + skip). Use a different key for user-defined
// presets.
//
// Default entries point at the same arrays DEFAULT_LINE_TEMPLATE uses,
// so the legacy "plan" / "balance" key names continue to resolve for
// backward-compatible lookups via `m_template:plan` / `:balance`.
export type LineTemplates = Record<string, string[]>;


// v0.8.14+ — `statuslineTemplate` is array-only. The legacy string-form
// preset-name value (`"1line"`, `"standard"`, etc.) is auto-migrated
// by `applyOverrides` to the equivalent `["m_template|_X"]` form with
// a one-shot stderr warning. Use the array form directly to silence
// the warning. The PLAN_PRESETS / BALANCE_PRESETS tables (v0.4.0–
// v0.8.13) are gone — presets are now first-class entries in
// `DEFAULT_LINE_TEMPLATES` with `_`-prefixed keys.
export type StatuslineTemplate = string[];

// Default render = `["m_template|_1line"]`. The `_1line` body is the
// byte-identical rename of the v0.4.0–v0.8.13 `PLAN_PRESETS["1line"]`
// body, so existing users with no config.json see the same render
// they did before v0.8.14 (Quota provider — the default mode of
// `m_template` matches).
export const DEFAULT_STATUSLINE_TEMPLATE: StatuslineTemplate = ["m_template|_1line"];

// v0.8.14 — Set of all legacy preset names (with the `_` prefix
// stripped). `applyOverrides` uses this to detect legacy string-form
// `statuslineTemplate` values and auto-migrate them to the equivalent
// `["m_template|_X"]` form. `balance_simple` and `balance_simple-alone`
// include the `_balance_` infix (e.g. `balance_simple` becomes the
// `_balance_simple` key). Order matches the bodies above; do not add
// names here without adding the corresponding key to
// DEFAULT_LINE_TEMPLATES.
export const LEGACY_PRESET_NAMES: ReadonlyArray<string> = [
  "1line", "simple", "simple-alone", "standard",
  "standard-alone", "abundant", "complete",
  "balance_simple", "balance_simple-alone",
];

// v0.8.14 — built-in presets are now first-class entries in
// DEFAULT_LINE_TEMPLATES with `_`-prefix. Bodies were migrated
// byte-for-byte from the v0.4.0–v0.8.13 PLAN_PRESETS /
// BALANCE_PRESETS tables; the bodies themselves are unchanged.
//
// Naming convention (carried over from the legacy PLAN_PRESETS /
// BALANCE_PRESETS tables):
//
//   Quota presets (default mode of `m_template` is "plan", so
//   no `|mode|plan` arg needed):
//     _1line / _simple       : tokenplan only, single line, compact
//                              (_simple is an alias of _1line — same body)
//     _simple-alone          : single line with "Usage:" label prefix
//                              (for the user running this plugin as
//                              the SOLE statusline — no upstream chain)
//     _standard              : 2 lines (tokenplan on line 0, context
//                              & token on line 1). Companion: this
//                              plugin chains an upstream statusline
//                              for session info.
//     _standard-alone        : 3 lines (adds session on line 0).
//     _abundant              : 4 lines (adds git on line 0).
//     _complete              : 5 lines (adds totals on line 3).
//
//   BALANCE presets (use `m_template|_X|mode|balance` to constrain
//   dispatch to BALANCE providers — the default `m_template` mode of
//   "plan" would silently drop these on a Quota provider):
//     _balance_simple        : default balance render
//                              ("Balance: <balance>")
//     _balance_simple-alone  : balance render with explicit
//                              "Balance:" label prefix for solo use.
//
// Per-module coloring is omitted from the presets (no `:color:` arg)
// — the user can override per module by inlining the preset into
// their own array if they want.
export const DEFAULT_LINE_TEMPLATES: LineTemplates = {
  // Legacy "plan" / "balance" entries — preserved for back-compat
  // with pre-v0.8.14 configs that referenced `m_template:plan` /
  // `:balance`. Bodies match DEFAULT_LINE_TEMPLATE (the `s_space +
  // s_dot + s_space` composition that produces " · " between
  // windows).
  plan: DEFAULT_LINE_TEMPLATE.plan,
  balance: DEFAULT_LINE_TEMPLATE.balance,

  // ----- Built-in presets (v0.8.14+) -----
  _1line: [
    "m_modeLabel", "s_space",
    "m_windowQuota|term:short", "s_space", "m_countdown|term:short",
    "s_space", "s_dot", "s_space",
    "m_windowQuota|term:mid", "s_space", "m_countdown|term:mid",
  ],
  // alias of _1line — same shape, more discoverable name
  _simple: [
    "m_modeLabel", "s_space",
    "m_windowQuota|term:short", "s_space", "m_countdown|term:short",
    "s_space", "s_dot", "s_space",
    "m_windowQuota|term:mid", "s_space", "m_countdown|term:mid",
  ],
  // single line with "Usage:" label prefix
  _simple_alone: [
    "m_label|Usage|color:yellow", "s_newline",
    "m_windowQuota|term:short|nulldrop:false", "s_space",
    "m_countdown|term:short|nulldrop:false",
    "s_space", "s_dot|color:red", "s_space",
    "m_windowQuota|term:mid|nulldrop:false", "s_space",
    "m_countdown|term:mid|nulldrop:false",
  ],
  // 2 lines: line 0 = tokenplan, line 1 = context & token.
  _standard: [
    "m_modeLabel", "s_space",
    "m_windowQuota|term:short", "s_space", "m_countdown|term:short",
    "s_space", "s_dot", "s_space",
    "m_windowQuota|term:mid", "s_space", "m_countdown|term:mid",
    "s_newline",
    "m_sessionApiDuration|nulldrop:false", "s_space",
    "m_tokenIn|nulldrop:false", "s_space",
    "m_tokenInSpeed|nulldrop:false", "s_space",
    "m_tokenOut|nulldrop:false", "s_space",
    "m_tokenOutSpeed|nulldrop:false", "s_space",
    "m_ctx|nulldrop:false", "s_space",
    "m_tokenHitRate|nulldrop:false",
  ],
  // 3 lines: line 0 = session, line 1 = tokenplan, line 2 = context.
  _standard_alone: [
    "m_label|Session|color:yellow", "s_space",
    "m_session|nulldrop:false", "s_space",
    "m_model|nulldrop:false", "s_space",
    "m_ccVersion|nulldrop:false",
    "s_newline",
    "m_label|Usage|color:yellow", "s_newline",
    "m_windowQuota|term:short|nulldrop:false", "s_space",
    "m_countdown|term:short|nulldrop:false",
    "s_space", "s_dot|color:red", "s_space",
    "m_windowQuota|term:mid|nulldrop:false", "s_space",
    "m_countdown|term:mid|nulldrop:false",
    "s_newline",
    "m_label|Context|color:yellow", "s_newline",
    "m_sessionApiDuration|nulldrop:false", "s_space",
    "m_tokenIn|nulldrop:false", "s_space",
    "m_tokenInSpeed|nulldrop:false", "s_space",
    "m_tokenOut|nulldrop:false", "s_space",
    "m_tokenOutSpeed|nulldrop:false", "s_space",
    "m_ctx|nulldrop:false", "s_space",
    "m_tokenHitRate|nulldrop:false",
  ],
  // 4 lines: line 0 = session + git, line 1 = tokenplan, line 2 =
  // context, line 3 = (none — see _complete for the 5-line form).
  _abundant: [
    "m_label|Session|color:yellow", "s_space",
    "m_session|nulldrop:false", "s_space",
    "m_model|nulldrop:false", "s_space",
    "m_branch|nulldrop:false", "s_space",
    "m_gitStatus|nulldrop:false", "s_space",
    "m_ccVersion|nulldrop:false",
    "s_newline",
    "m_label|Usage|color:yellow", "s_newline",
    "m_windowQuota|term:short|nulldrop:false", "s_space",
    "m_countdown|term:short|nulldrop:false",
    "s_space", "s_dot|color:red", "s_space",
    "m_windowQuota|term:mid|nulldrop:false", "s_space",
    "m_countdown|term:mid|nulldrop:false",
    "s_newline",
    "m_label|Context|color:yellow", "s_newline",
    "m_sessionApiDuration|nulldrop:false", "s_space",
    "m_tokenIn|nulldrop:false", "s_space",
    "m_tokenInSpeed|nulldrop:false", "s_space",
    "m_tokenOut|nulldrop:false", "s_space",
    "m_tokenOutSpeed|nulldrop:false", "s_space",
    "m_ctx|nulldrop:false", "s_space",
    "m_tokenHitRate|nulldrop:false",
  ],
  // 5 lines: line 0 = session + git, line 1 = tokenplan, line 2 =
  // context, line 3 = totals. NOT recommended — verbose.
  _complete: [
    "m_label|Session|color:yellow", "s_space",
    "m_session|nulldrop:false", "s_space",
    "m_model|nulldrop:false", "s_space",
    "m_branch|nulldrop:false", "s_space",
    "m_gitStatus|nulldrop:false", "s_space",
    "m_ccVersion|nulldrop:false",
    "s_newline",
    "m_label|Usage|color:yellow", "s_newline",
    "m_windowQuota|term:short|nulldrop:false", "s_space",
    "m_countdown|term:short|nulldrop:false",
    "s_space", "s_dot|color:red", "s_space",
    "m_windowQuota|term:mid|nulldrop:false", "s_space",
    "m_countdown|term:mid|nulldrop:false",
    "s_newline",
    "m_label|Context|color:yellow", "s_newline",
    "m_sessionApiDuration|nulldrop:false", "s_space",
    "m_tokenIn|nulldrop:false", "s_space",
    "m_tokenInSpeed|nulldrop:false", "s_space",
    "m_tokenOut|nulldrop:false", "s_space",
    "m_tokenOutSpeed|nulldrop:false", "s_space",
    "m_ctx|nulldrop:false", "s_space",
    "m_tokenHitRate|nulldrop:false",
    "s_newline",
    "m_label|Total|color:yellow", "s_newline",
    "m_totalTokenIn|nulldrop:false", "s_space",
    "m_totalTokenOut|nulldrop:false", "s_space",
    "m_totalTokenWithCacheIn|nulldrop:false", "s_space",
    "m_linesAdded|nulldrop:false", "s_space",
    "m_linesRemoved|nulldrop:false",
  ],
  // ----- BALANCE presets (use |mode|balance when dispatching) -----
  // Default balance render — "Balance: <balance>".
  _balance_simple: ["m_modeLabel", "s_space", "m_balance"],
  // Balance render with explicit "Balance:" label prefix for solo use.
  _balance_simple_alone: [
    "m_label|Balance|color:yellow", "s_space",
    "m_balance|nulldrop:false",
  ],
};

