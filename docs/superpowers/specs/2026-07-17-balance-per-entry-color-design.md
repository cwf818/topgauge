# Balance per-entry color redesign

**Date:** 2026-07-17
**Status:** approved (brainstorming complete, awaiting implementation)
**Scope:** `m_balance` rendering path only. No new modules. No schema-shape change.

## Problem

`m_balance` currently renders multi-currency entries as a single SGR block whose hue is chosen by `colorForBalance(minValue)` — i.e. **the lowest entry drives the color of every entry**. For a typical multi-currency account like `CNY 110 + USD 3.5`, this paints the entire line RED even though CNY 110 is a healthy bright-green balance.

This violates the intuition that "each currency should reflect its own balance urgency".

## Goal

`m_balance` renders every entry with its own 5-band color, joined by ` · ` with one RESET per entry. `|color|<c>` inline override remains — when supplied it forces every entry to that single color (the existing "force whole account one color" semantic, now spread across multiple SGR blocks instead of one).

## Non-goals

- No change to `Balance` schema shape (entries, isAvailable, minValue all stay).
- No new module (this is an internal rewrite of `formatBalanceEntriesColored`).
- No change to `ensureBalance` logic — `minValue` keeps being computed.
- No change to `m_balance` registration in either `MODULES` or inline-args path.

## Behavior

### Multi-currency, no `|color|` override

**Before (v0.9.x and earlier):**
```
Balance: \x1b[31m￥110 · $3.5\x1b[0m
         ^^^^^ whole line RED because minValue=3.5 hits RED band
```

**After:**
```
Balance: \x1b[92m￥110\x1b[0m · \x1b[31m$3.5\x1b[0m
         ^^^^^^^^         ^^^^^^^
         brightGreen       red
         (CNY 110 →      (USD 3.5 →
          brightGreen)    red)
```

Each entry is its own SGR block: `<color><text>\x1b[0m`. Joined by ` · `. Single RESET at the end of each chunk, no trailing RESET on the joined string beyond the last entry's.

### Multi-currency, with `m_balance|color|cyan`

**Before:**
```
Balance: \x1b[36m￥110 · $3.5\x1b[0m
         whole line cyan
```

**After:**
```
Balance: \x1b[36m￥110\x1b[0m · \x1b[36m$3.5\x1b[0m
         ^^^^^^^^         ^^^^^^^
         cyan              cyan
         (override applies to every entry)
```

Override semantics preserved: "force whole account one color" still holds, but mechanically it's per-entry now.

### Single-currency, no override

**Before:** single SGR block, color = `colorForBalance(totalBalance)`.
**After:** single SGR block, color = `colorForBalance(totalBalance)`. **Identical output** — single entry has no separator to break, so the new per-entry logic produces the same bytes as the old single-block logic.

This matters because DeepSeek (the only common balance provider today) returns a single entry.

### Empty / unavailable / `minValue == null`

**Unchanged.** `formatBalanceEntriesColored` still early-returns `""` on `!isAvailable || entries.length === 0 || minValue == null`. The `m_balance` module's fallback path (`placeholderBare("m_balance", c)` → `balance:n/a`) keeps working.

## `minValue` field — semantic shift

`minValue` keeps existing on the `Balance` schema and keeps being computed by `ensureBalance`. Its new role:

- **Old role (until v0.9.x):** driver of single-block color (`colorForBalance(minValue)`).
- **New role (this redesign):** host-computed worst-case entry value. Renderer no longer consults it. Plugins or future alerting modules can still read it as "global low-water mark of this account".

The shape is preserved so:

1. Existing plugins that emit `minValue` (per `HOW_TO_CREATE_A_PLUGIN.md`) keep working — they don't break.
2. Plugins reading `minValue` for their own purposes (alerting, etc.) keep working.
3. The host's `ensureBalance` computation is unchanged — no schema migration needed.

Only the comments change to reflect the new role.

## Implementation

### Single function edit

`src/render.ts:1138-1146` — rewrite `formatBalanceEntriesColored`:

```ts
function formatBalanceEntriesColored(b: BalanceLike, override?: string): string {
  if (!b.isAvailable || b.entries.length === 0 || b.minValue == null) {
    return "";
  }
  // v2026.07.17+ — per-entry 5-band color. Each entry is its own
  // SGR block so a multi-currency account reflects each currency's
  // own urgency, not the worst case. `override` (from the inline
  // |color| arg) still wins and applies to every entry — preserves
  // the "force whole account one color" semantic.
  return b.entries
    .map((e) => {
      const color = override ?? colorForBalance(e.totalBalance);
      return `${color}${formatBalanceChunk(e.currency, e.totalBalance)}${RESET}`;
    })
    .join(" · ");
}
```

Single function. No new exports. No type changes. No host changes.

### Comment updates (no behavior)

| Location | Old | New |
|---|---|---|
| `src/render.ts:1143` | `// Color follows the LOWEST entry — most urgent currency drives the hue.` | `// v2026.07.17+: per-entry 5-band. See comment above.` (drop entirely; the new docblock covers it) |
| `src/plugins/data.ts:43` | (no comment) | `// v2026.07.17+: host-computed worst-case entry value. Renderer no longer consults this for color (per-entry 5-band now drives hue). Plugins may still read it for alerting / introspection.` |
| `src/plugins/parsers.ts:158` | `// derive \`minValue\` over the surviving entries, and guard the final shape.` | add `(retained post per-entry-color redesign; no longer drives color)` |
| `MANUAL.md:298` | `minValue:    number \| null,  // high-water mark for color banding` | `minValue:    number \| null,  // host-computed worst-case entry value; renderer no longer uses for color` |
| `MANUAL.md:317` | `- \`minValue\` host-computed as \`min(entries[].totalBalance)\`.` | add `(renderer no longer reads; per-entry 5-band drives hue)` |
| `HOW_TO_CREATE_A_PLUGIN.md:208` | `minValue: raw.min_value ?? null,` | update nearby prose explaining the new role |
| `HOW_TO_CREATE_A_PLUGIN.md:415` | `minValue:    number \| null;    // high-water mark for color banding` | `// host-computed worst-case entry value; not consulted by renderer` |
| `src/__fixtures__/balance.schema.json:5` | describes `ensureBalance` 入口会算 minValue ... 驱动 colorFor 的 5-band 调色板 | describe minValue is worst-case indicator; renderer does per-entry color |

## Tests

### Tests to update

1. **`src/render.test.ts:891-909`** — "renders all entries, joined by ' · ', single color from lowest"
   - Drop "single color from lowest" → "each entry its own band color"
   - Drop `line.startsWith(\`Balance: ${RED}\`)` assertion
   - Drop the `colored` single-block slice assertion
   - Add: `line.includes(\`${BRIGHT_GREEN}￥110${RESET}\`)` and `line.includes(\`${RED}$3.5${RESET}\`)`

2. **`src/render.test.ts:911-921`** — "integer formatting per-chunk"
   - Replace `minValue: 100` (used to drive whole-block color) with the assertion that each entry shows in its own band.
   - Both CNY 100 and USD 200.5 are likely brightGreen in default thresholds; verify against `balanceBands` config default.

3. **`src/render.test.ts:865, 867, 873, 876, 2300, 2316, 2336, 2348`** — single-entry cases
   - Strip output unchanged.
   - Color assertion changes from "starts with one color for the whole block" to "wraps the single chunk in that color".
   - In practice the bytes may be identical (single entry, single SGR block) — confirm via test run.

4. **`src/render-providerType.test.ts:39`** — single-entry case
   - Same pattern as #3.

5. **`src/dispatch.test.ts:37`** — single-entry case
   - Same pattern as #3.

6. **`src/lineTemplate.test.ts` (8 sites)** — verify the templates don't assert color literally; if they do, fix per #3.

### New tests to add

1. **`render.test.ts`** — `it("renders multi-currency with each entry in its own 5-band color")`
   - Two entries hitting different bands, assert each chunk's color matches its own totalBalance band lookup.
   - Assert joined output has N+1 RESETs (one per entry, not just one at the end).

2. **`render.test.ts`** — `it("override |color|cyan forces every entry to cyan, multi-currency")`
   - Inline-args path: `m_balance|color|cyan` with 2 entries → both chunks wrapped in cyan, joined by ` · `.

3. **`render.test.ts`** — `it("single entry with override still produces single cyan block")`
   - Inline-args path: 1 entry + override → same byte output as before, no regression.

## Risk

**Low.** Single function rewrite, no schema change, no type change, no public API change. Test assertions need mechanical updates but the byte output for the most common case (single-entry DeepSeek) is identical.

## Deploy

Per `local-deploy-procedure.md`: minimal overwrite path.

1. `npm run typecheck`
2. `npm test`
3. `npm run build`
4. `cp dist/index.js <HIGHEST_VERSION>/dist/index.js`
5. Smoke check: grep the new comment marker (e.g. `per-entry 5-band`) in the cache bundle. Must be `> 0` — confirms the rewritten function reached the runtime.

## Commit

Per `git-commit-policy.md`: do NOT auto-commit. User commits at the next cross-session task switch.