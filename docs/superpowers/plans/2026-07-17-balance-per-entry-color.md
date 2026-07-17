# Balance per-entry color Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rewrite `formatBalanceEntriesColored` so each balance entry gets its own 5-band color SGR block (joined by ` · `), instead of a single block whose color is driven by `minValue`.

**Architecture:** Single function rewrite in `src/render.ts`. No schema change, no type change, no public API change. The `Balance.minValue` field is retained (host still computes it) but its role shifts from "color driver" to "worst-case indicator"; renderer stops consulting it. Comments across 8 sites + 1 schema fixture updated to reflect the new role.

**Tech Stack:** TypeScript, node:test, esbuild. Default `thresholds.balanceBands` (5/10/20/50 — red/orange/yellow/darkGreen/brightGreen per existing code comment).

## Global Constraints

- **Schema shape preserved.** `Balance.minValue` is NOT removed; `ensureBalance` continues computing it. Renderer no longer reads it for color.
- **Single-entry output is byte-identical** to v0.9.x for the most common case (single-entry DeepSeek); tests must confirm.
- **Override semantics preserved.** `m_balance|color|<c>` inline arg still forces one color across the whole account — but mechanically it's per-entry now.
- **Empty / unavailable / `minValue == null` paths unchanged.** `formatBalanceEntriesColored` still early-returns `""`; `m_balance` module still falls through to `placeholderBare`.
- **Don't auto-commit** (per `git-commit-policy.md`). Commit only at cross-session task switch.
- **After `npm run build`, mirror `dist/index.js` to the runtime cache** (per `local-deploy-procedure.md`). Smoke check: grep `per-entry 5-band` in the cache bundle, count must be `> 0`.

---

## File Map

| File | Role | Touched |
|---|---|---|
| `src/render.ts` | Owns `formatBalanceEntriesColored` + `formatBalanceChunk` + `colorForBalance` + `m_balance` registration in `MODULES` and inline-args | Modify (`formatBalanceEntriesColored` body, comment block) |
| `src/render.test.ts` | Tests for `renderBalanceLine` (multi-currency, single-currency, unavailable, placeholder fallbacks) | Modify (8-10 test bodies) |
| `src/render-providerType.test.ts` | Single entry renderBalanceLine case | Modify (1 site) |
| `src/dispatch.test.ts` | Single entry fixture | Modify (1 site) |
| `src/lineTemplate.test.ts` | 8 template-level sites using `minValue: 25` | Verify-and-modify if color is asserted |
| `src/plugins/data.ts` | `Balance` type definition | Modify (add comment line) |
| `src/plugins/parsers.ts` | `ensureBalance` normalizer | Modify (update comment) |
| `src/__fixtures__/balance.schema.json` | Balance schema fixture with `_about` prose | Modify (`_about` + `_rendererNotes`) |
| `MANUAL.md` | Plugin contract docs | Modify (2 lines: 298 + 317) |
| `HOW_TO_CREATE_A_PLUGIN.md` | Plugin author guide | Modify (2 sites: 208 prose context + 415 type comment) |
| `dist/index.js` | Runtime cache bundle | Mirror after build (deploy step) |

## Task Order Rationale

TDD pattern: failing test → implementation → passing test → commit. Tests are split by file (render.test.ts core, render-providerType.test.ts, dispatch.test.ts, lineTemplate.test.ts) so each task has one focused diff. Doc sync + deploy come at the end as a single sweep.

---

### Task 1: Update existing multi-currency test to expect per-entry colors

**Files:**
- Modify: `src/render.test.ts:881-909` (the "renders all entries, joined by ' · ', single color from lowest" test)

**Interfaces:**
- Consumes: `formatBalanceEntriesColored` (current v0.9.x behavior), `RED`, `BRIGHT_GREEN`, `RESET` exports from `src/render.ts`
- Produces: a failing test that asserts per-entry colors (this task does NOT yet implement the change; only updates the test)

- [ ] **Step 1: Replace the test body**

In `src/render.test.ts`, replace lines 881-909 (the entire `describe("renderBalanceLine — multi-currency joined by ·", ...)` block's first `it(...)` test) with:

```ts
  it("renders all entries, joined by ' · ', each entry in its own band color", () => {
    // v2026.07.17+ — each entry is its own SGR block; color follows
    // each entry's totalBalance through colorForBalance, NOT the
    // minValue across all entries. CNY 110 → BRIGHT_GREEN band;
    // USD 3.5 → RED band; both rendered as independent chunks.
    const line = renderBalanceLine({
      isAvailable: true,
      entries: [
        { currency: "CNY", totalBalance: 110 },
        { currency: "USD", totalBalance: 3.5 },
      ],
      minValue: 3.5,
    });
    assert.equal(strip(line), "Balance: ￥110 · $3.5");
    // Each entry wrapped in its own color + RESET.
    assert.ok(line.includes(`${BRIGHT_GREEN}￥110${RESET}`), `expected CNY chunk in BRIGHT_GREEN, got: ${line}`);
    assert.ok(line.includes(`${RED}$3.5${RESET}`), `expected USD chunk in RED, got: ${line}`);
    // Joined by ' · ' between chunks.
    assert.ok(line.includes(`${RESET} · ${RED}`), `expected ' · ' separator between chunks, got: ${line}`);
  });
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -- --test-name-pattern "renders all entries, joined by ' · ', each entry"`
Expected: FAIL. The current implementation produces a single `RED` block wrapping both chunks; the new test expects two separate blocks (`BRIGHT_GREEN` + `RED`) and a `RESET · RED` separator that doesn't exist yet.

- [ ] **Step 3: Commit the failing test**

```bash
git add src/render.test.ts
git commit -m "test(render): multi-currency balance expects per-entry band colors"
```

---

### Task 2: Rewrite `formatBalanceEntriesColored` to per-entry blocks

**Files:**
- Modify: `src/render.ts:1130-1146` (the `formatBalanceEntriesColored` function + its docblock)

**Interfaces:**
- Consumes: `BalanceLike` (defined locally in `src/render.ts:1120-1128`), `colorForBalance` (export from `src/render.ts:1074`), `formatBalanceChunk` (`src/render.ts:1092`), `RESET` constant (`src/render.ts:350`)
- Produces: same function signature `formatBalanceEntriesColored(b: BalanceLike, override?: string): string` with new internal behavior

- [ ] **Step 1: Replace the function body**

In `src/render.ts`, replace the block at lines 1130-1146 with:

```ts
// v0.2.17: refactor of the balance-line renderer so the m_balance module can
// produce a complete colored chunk (prefix + " · "-joined entries
// wrapped in a single SGR block). Returns "" when there's nothing to
// render so the m_balance module can return null and the template
// renderer skips the surrounding s_0 separators cleanly.
//
// v0.3.3+ `override` parameter: when supplied, replaces the band-based
// `colorForBalance` choice (used by the inline-args m_balance path).
//
// v2026.07.17+ — per-entry 5-band color: each entry is rendered as its
// own `<color><text>${RESET}` block, joined by ` · `. Color follows
// each entry's totalBalance through colorForBalance, NOT minValue.
// This means a multi-currency account reflects each currency's own
// urgency (CNY 110 → BRIGHT_GREEN, USD 3.5 → RED, both visible
// independently). `override` (when supplied) is applied to every
// entry — preserves the "force whole account one color" semantic
// while mechanically operating per-entry.
function formatBalanceEntriesColored(b: BalanceLike, override?: string): string {
  if (!b.isAvailable || b.entries.length === 0 || b.minValue == null) {
    return "";
  }
  return b.entries
    .map((e) => {
      const color = override ?? colorForBalance(e.totalBalance);
      return `${color}${formatBalanceChunk(e.currency, e.totalBalance)}${RESET}`;
    })
    .join(" · ");
}
```

- [ ] **Step 2: Run the multi-currency test from Task 1**

Run: `npm test -- --test-name-pattern "renders all entries, joined by ' · ', each entry"`
Expected: PASS.

- [ ] **Step 3: Run the full test suite to find broken assertions**

Run: `npm test`
Expected: a handful of single-entry tests will likely still pass (single entry = byte-identical), but some tests that asserted the previous "whole block in one color" form for multi-entry data may now fail. Note every failure.

- [ ] **Step 4: Commit the implementation**

```bash
git add src/render.ts
git commit -m "feat(render): per-entry 5-band color for m_balance multi-currency"
```

---

### Task 3: Fix single-entry test assertions across the test suite

**Files:**
- Modify: `src/render.test.ts:855-921` (single-entry + integer formatting tests)
- Modify: `src/render-providerType.test.ts:30-50` (single-entry case)
- Modify: `src/dispatch.test.ts:30-50` (single-entry fixture)
- Possibly modify: `src/lineTemplate.test.ts` (8 sites — only if a site asserts color literally)

**Interfaces:**
- Consumes: same as Task 2
- Produces: tests that pass under the new per-entry implementation. Single-entry case is byte-identical, so existing assertions on `strip(line)` remain valid; color assertions need to confirm the wrapper is still `${COLOR}<chunk>${RESET}` (which it is).

- [ ] **Step 1: Re-run the full test suite and inventory failures**

Run: `npm test 2>&1 | tee /tmp/balance-test-failures.txt`
Expected: list of failing test names + assertion messages. Group them by file.

- [ ] **Step 2: For each single-entry test that asserts a color, update the assertion shape**

For tests like the one at `src/render.test.ts:873-877`:

```ts
  it("falls into RED band when balance is very low", () => {
    const red = renderBalanceLine({ isAvailable: true, entries: [{ currency: "CNY", totalBalance: 3.5 }], minValue: 3.5 });
    assert.equal(strip(red), "Balance: ￥3.5");
    assert.ok(red.startsWith(`Balance: ${RED}`));
    assert.ok(red.endsWith(RESET));
  });
```

Replace `red.startsWith(\`Balance: ${RED}\`)` with `red.includes(\`${RED}￥3.5${RESET}\`)` (and similar for other band tests). The bytes are identical for single entries — the assertion just needs to verify the SGR wraps the single chunk, not "starts with" the color (which is a weaker check that still works, but the new pattern is more precise about per-entry wrapping).

Run the affected test after each edit. Confirm PASS.

- [ ] **Step 3: For each multi-entry test other than Task 1's, update similarly**

If `src/render.test.ts:911-921` (integer formatting per-chunk) has a per-entry color assertion to add, do so:

```ts
  it("integer formatting per-chunk", () => {
    const line = renderBalanceLine({
      isAvailable: true,
      entries: [
        { currency: "CNY", totalBalance: 100 },
        { currency: "USD", totalBalance: 200.5 },
      ],
      minValue: 100,
    });
    assert.equal(strip(line), "Balance: ￥100 · $200.5");
    // v2026.07.17+: both 100 and 200.5 fall into BRIGHT_GREEN band
    // (default thresholds: balanceBands = [5,10,20,50]; anything
    // ≥ 50 is brightGreen). Each chunk is its own SGR block.
    assert.ok(line.includes(`${BRIGHT_GREEN}￥100${RESET}`), `got: ${line}`);
    assert.ok(line.includes(`${BRIGHT_GREEN}$200.5${RESET}`), `got: ${line}`);
  });
```

- [ ] **Step 4: Grep `lineTemplate.test.ts` for color assertions on balance chunks**

Run: `grep -n -i "balance\|minvalue" src/lineTemplate.test.ts | grep -iE "red|green|yellow|orange|\\\\x1b|color"`
Expected: zero hits (lineTemplate tests usually don't assert literal ANSI escapes — they assert strip-output). If any hits appear, fix them per the per-entry pattern. If no hits, no edit needed; verify by running the file: `npm test -- src/lineTemplate.test.ts`.

- [ ] **Step 5: Run the full test suite**

Run: `npm test`
Expected: PASS. Zero failures.

- [ ] **Step 6: Commit the test fixes**

```bash
git add src/render.test.ts src/render-providerType.test.ts src/dispatch.test.ts src/lineTemplate.test.ts
git commit -m "test(render): update single-entry color assertions to per-entry pattern"
```

---

### Task 4: Add new tests for per-entry override behavior

**Files:**
- Modify: `src/render.test.ts` (add 3 tests in the `renderBalanceLine — multi-currency joined by ·` describe block, after the existing tests)

**Interfaces:**
- Consumes: `m_balance|color|cyan` inline-args dispatch path through `formatBalanceEntriesColored(ctx.balance, override)`; `BRIGHT_GREEN`, `RED`, `RESET` constants
- Produces: tests covering (a) multi-currency per-entry colors with no override, (b) override forces one color per entry, (c) override + single entry byte-identical to v0.9.x

- [ ] **Step 1: Add the three tests**

Insert after the existing tests in `renderBalanceLine — multi-currency joined by ·` describe block:

```ts
  it("override |color|cyan forces every entry to cyan, multi-currency", () => {
    // v2026.07.17+: |color| inline arg applies to every entry. Same
    // "force whole account one color" semantic as v0.9.x, but
    // mechanically it's per-entry now (each chunk wrapped in cyan +
    // RESET).
    const line = renderBalanceLine({
      isAvailable: true,
      entries: [
        { currency: "CNY", totalBalance: 110 },
        { currency: "USD", totalBalance: 3.5 },
      ],
      minValue: 3.5,
    }, "cyan");
    assert.equal(strip(line), "Balance: ￥110 · $3.5");
    assert.ok(line.includes(`${CYAN}￥110${RESET}`), `expected CNY chunk in CYAN, got: ${line}`);
    assert.ok(line.includes(`${CYAN}$3.5${RESET}`), `expected USD chunk in CYAN, got: ${line}`);
  });

  it("single entry with override produces single color block (byte-identical to v0.9.x)", () => {
    const line = renderBalanceLine({
      isAvailable: true,
      entries: [{ currency: "USD", totalBalance: 25 }],
      minValue: 25,
    }, "cyan");
    assert.equal(strip(line), "Balance: $25");
    assert.ok(line.includes(`${CYAN}$25${RESET}`), `got: ${line}`);
    // Only one RESET (no separator needed for single entry).
    assert.equal((line.match(/\x1b\[0m/g) ?? []).length, 1);
  });

  it("multi-entry with no override: count of RESETs equals entries.length", () => {
    // v2026.07.17+: each entry contributes exactly one RESET
    // (the wrapper around its own SGR block). Joined string has no
    // trailing RESET beyond the last entry's.
    const line = renderBalanceLine({
      isAvailable: true,
      entries: [
        { currency: "CNY", totalBalance: 110 },
        { currency: "USD", totalBalance: 3.5 },
        { currency: "EUR", totalBalance: 50 },
      ],
      minValue: 3.5,
    });
    assert.equal((line.match(/\x1b\[0m/g) ?? []).length, 3, `expected 3 RESETs, got: ${line}`);
  });
```

Note: `renderBalanceLine` currently does not take an `override` parameter in the test signature. Look up the existing signature in `src/render.test.ts:124` — if it only takes `b`, update these tests to call the underlying `formatBalanceEntriesColored` directly OR refactor `renderBalanceLine` to accept an optional override (and update all callers).

If the simpler path is preferred, replace the override tests with direct calls to `formatBalanceEntriesColored` (it's exported from `src/render.ts` for testability per the existing `BalanceLike` test pattern in `src/render.test.ts`):

```ts
import { formatBalanceEntriesColored } from "./render.js";
// ...
const line = `${COLOR_PREFIX}${formatBalanceEntriesColored(balance, CYAN)}${RESET}`;
```

Pick whichever path matches the existing test infrastructure; if `formatBalanceEntriesColored` is not currently exported, add it to the export list in `src/render.ts` (only one line change at the bottom of the function).

- [ ] **Step 2: Run the new tests**

Run: `npm test -- --test-name-pattern "override |color|cyan|single entry with override|multi-entry with no override"`
Expected: PASS.

- [ ] **Step 3: Commit the new tests**

```bash
git add src/render.test.ts
git commit -m "test(render): per-entry override + RESET count invariants"
```

---

### Task 5: Update `Balance` type comment + `ensureBalance` comment

**Files:**
- Modify: `src/plugins/data.ts:40-44` (Balance type)
- Modify: `src/plugins/parsers.ts:157-188` (ensureBalance comment + body)

**Interfaces:**
- Consumes: existing `Balance` type and `ensureBalance` function
- Produces: same code, updated comments

- [ ] **Step 1: Update `src/plugins/data.ts` Balance type comment**

Replace lines 40-44 with:

```ts
export type Balance = {
  isAvailable: boolean;
  entries: BalanceEntry[];
  // v2026.07.17+: host-computed worst-case entry value (lowest
  // totalBalance). The renderer no longer consults this for color
  // (per-entry 5-band now drives hue). The field is retained so
  // plugins reading it for alerting/introspection keep working,
  // and ensureBalance keeps computing it.
  minValue: number | null;
};
```

- [ ] **Step 2: Update `src/plugins/parsers.ts` ensureBalance comment**

In `src/plugins/parsers.ts`, replace the comment block at lines 157-163 with:

```ts
// Apply the is_available fallback contract (missing → optimistic
// true), derive `minValue` over the surviving entries, and guard the
// final shape. The plugin layer is responsible for projecting
// `raw → Partial<Balance>`; this function is the host's normaliser
// and is the ONLY place the canonical `Balance` shape is produced.
//
// v2026.07.17+ — `minValue` is no longer consulted by the renderer
// for color (per-entry 5-band drives hue). The field is still
// computed here for downstream plugins / alerting / introspection.
```

- [ ] **Step 3: Run typecheck and tests**

Run: `npm run typecheck && npm test`
Expected: PASS. No behavior change, only comments.

- [ ] **Step 4: Commit the comment updates**

```bash
git add src/plugins/data.ts src/plugins/parsers.ts
git commit -m "docs(plugins): Balance.minValue is worst-case indicator, not color driver"
```

---

### Task 6: Update schema fixture + MANUAL + plugin-author docs

**Files:**
- Modify: `src/__fixtures__/balance.schema.json:2-5` (`_about` + `_rendererNotes[1]`)
- Modify: `MANUAL.md:298` + `MANUAL.md:317`
- Modify: `HOW_TO_CREATE_A_PLUGIN.md:208` + `HOW_TO_CREATE_A_PLUGIN.md:415`

**Interfaces:**
- Consumes: prose in fixture/MANUAL/HOW_TO_CREATE_A_PLUGIN
- Produces: updated prose reflecting new role

- [ ] **Step 1: Update `src/__fixtures__/balance.schema.json`**

Replace line 2 (`_about`) with:

```json
  "_about": "topgauge BALANCE 标准 schema —— 插件(用户脚本)的输出契约。插件读取 provider API 原始响应,把它转换(或裁剪)成本 schema 的形状,host 通过 ensureBalance() 把它规约成 canonical Balance。设计原则:1) currency 是 ISO-4217 字符串(如 'CNY' / 'USD'),渲染器内部 CNY/RMB→￥、USD→$ 符号映射，其他货币按原码大写输出;2) totalBalance 是已规约的 number;3) isAvailable 显式声明 true / false;字段缺失 / null 时 fallback 为 true(乐观渲染 entries);4) 多 currency 全部塞进 entries[],每个 entry 走自己的 5-band 调色板(v2026.07.17+;早于本版时取 entries 中 min totalBalance 驱动整段颜色,现 deprecated);5) minValue 仍由 host 计算 = min(entries[].totalBalance),作为账户 worst-case 指示保留供下游 alert / introspection,但 renderer 不再消费。",
```

Replace `_rendererNotes[1]` (line 5) with:

```json
    "ensureBalance 入口会算 minValue = min(entries[].totalBalance);该字段在 v2026.07.17+ 之前驱动 colorFor 的 5-band 调色板,现保留作为账户 worst-case 指示。渲染器走 per-entry 5-band 调色板 (colorForBalance(e.totalBalance) 逐 entry 取色)。",
```

- [ ] **Step 2: Update `MANUAL.md:298`**

Replace line 298:

```markdown
  minValue:    number | null,  // host-computed worst-case entry value; renderer no longer uses for color (v2026.07.17+)
```

- [ ] **Step 3: Update `MANUAL.md:317`**

Replace line 317:

```markdown
- `minValue` host-computed as `min(entries[].totalBalance)` (renderer no longer reads it; per-entry 5-band drives hue since v2026.07.17+).
```

- [ ] **Step 4: Update `HOW_TO_CREATE_A_PLUGIN.md:208` surrounding prose**

Read lines 195-215 in `HOW_TO_CREATE_A_PLUGIN.md` to confirm the prose context, then add a sentence after the example: "Note: `minValue` is optional — if you don't provide one, `ensureBalance` will compute it from your entries. As of v2026.07.17+ the renderer no longer reads this field for color; it is retained as a worst-case indicator for plugins/alerting."

- [ ] **Step 5: Update `HOW_TO_CREATE_A_PLUGIN.md:415`**

Replace line 415:

```typescript
  minValue:    number | null;    // host-computed worst-case entry value; renderer no longer uses for color (v2026.07.17+)
```

- [ ] **Step 6: Run typecheck and tests**

Run: `npm run typecheck && npm test`
Expected: PASS.

- [ ] **Step 7: Commit the doc sync**

```bash
git add src/__fixtures__/balance.schema.json MANUAL.md HOW_TO_CREATE_A_PLUGIN.md
git commit -m "docs(balance): minValue is worst-case indicator, not color driver (v2026.07.17+)"
```

---

### Task 7: Build + deploy + smoke check

**Files:**
- Create/Modify: `dist/index.js` (mirror to runtime cache)

**Interfaces:**
- Consumes: `dist/index.js` from `npm run build`
- Produces: runtime cache bundle with the new per-entry logic

- [ ] **Step 1: Build**

Run: `npm run build`
Expected: builds successfully. `dist/index.js` regenerated.

- [ ] **Step 2: Mirror to runtime cache**

Run:
```bash
HIGHEST=$(ls -d ~/.claude/plugins/cache/topgauge/topgauge/*/ | sort -V | tail -1)
cp dist/index.js "${HIGHEST}dist/index.js"
```

Expected: cp succeeds silently. Verify with `ls -la "${HIGHEST}dist/index.js"` — mtime should be current.

- [ ] **Step 3: Smoke check**

Run:
```bash
grep -c "per-entry 5-band" "${HIGHEST}dist/index.js"
```

Expected: count `> 0` (esbuild bundles comments inside functions, so this comment marker should survive). If count is 0, check whether esbuild stripped comments — fallback smoke check: `grep -c "formatBalanceEntriesColored" "${HIGHEST}dist/index.js"` should be `> 0` (function name is preserved).

- [ ] **Step 4: Live render smoke test (optional but recommended)**

Pipe a multi-currency fixture into the deployed bundle and visually confirm per-entry colors:

Run:
```bash
cat <<'EOF' | node "${HIGHEST}dist/index.js"
{"session_id":"smoke","cwd":"D:\\WorkSpace\\topgauge","model":{"id":"test"},"context_window":{"total_input_tokens":100,"total_output_tokens":50,"size":200000,"current_usage":{"input_tokens":10,"output_tokens":5,"cache_creation_input_tokens":0,"cache_read_input_tokens":0}},"cost":{"total_duration_ms":1000,"total_api_duration_ms":1000}}
EOF
```

Expected: a statusline with `￥110` in BRIGHT_GREEN and `$3.5` in RED (when using a Balance fixture with both currencies — requires the balance to be in cache; otherwise you may see only the placeholder). Skip if balance cache isn't populated for the test path.

- [ ] **Step 5: NO commit (per `git-commit-policy.md`)**

The deploy step modifies `dist/index.js` in the cache, which is OUTSIDE the repo. No repo commit needed.

---

## Self-Review

### 1. Spec coverage

| Spec section | Task |
|---|---|
| Problem statement | (background; no code) |
| Goal — multi-currency per-entry color | Task 2 |
| Goal — single-currency byte-identical | Task 3 (verify single-entry tests stay green) |
| Goal — `\|color\|` override preserved | Task 4 (test 1) |
| Goal — empty/unavailable unchanged | Task 2 (early return) + Task 3 (placeholder tests) |
| Non-goal — no schema shape change | Task 5 (Balance type) + Task 6 (schema fixture `additionalProperties: false` still holds) |
| Non-goal — no new module | (all tasks touch existing `formatBalanceEntriesColored`) |
| Non-goal — `ensureBalance` computation unchanged | Task 5 (comment-only edit) |
| Implementation — single function rewrite | Task 2 |
| Comments update table (8 sites) | Tasks 5 + 6 |
| Tests update | Tasks 1, 3 |
| Tests add (3) | Task 4 |
| Deploy | Task 7 |

No gaps.

### 2. Placeholder scan

- "TBD" / "TODO" / "implement later" — none.
- "Add appropriate error handling" — none (no new error paths).
- "Similar to Task N" — none; each task has its own complete code.
- "Write tests for the above" without code — none; tests are fully written.
- References to undefined types — `BalanceLike` defined locally in `src/render.ts:1120-1128`; `Balance` defined in `src/plugins/data.ts`; `formatBalanceChunk` defined `src/render.ts:1092`; `colorForBalance` defined `src/render.ts:1074`; `RESET` defined `src/render.ts:350`. All resolve.

### 3. Type consistency

- `BalanceLike.minValue: number | null` — used in `formatBalanceEntriesColored` early-return guard. Signature unchanged.
- `formatBalanceEntriesColored(b, override?)` — signature unchanged. Internal body changes only.
- `m_balance` registration in `MODULES` and inline-args paths — both still call `formatBalanceEntriesColored(ctx.balance [, color])`. No signature changes there.
- `Balance` type in `src/plugins/data.ts` — schema fields unchanged; comment-only edit.

If Task 4's tests need to import `formatBalanceEntriesColored` and it's not currently exported, Task 4's "If the simpler path is preferred" paragraph covers the addition — one-line export at the bottom of the function definition.

---

## Out of Scope (explicitly)

- Removing `Balance.minValue` schema field — deferred per user choice (worst-case indicator).
- Adding per-currency label / icon overlays — not requested.
- Changing the ` · ` separator — preserved.
- Threshold values — default `balanceBands` unchanged.
- Cross-platform behavior (Windows-specific path handling in `dist/index.js`) — not affected by this change.