// v1.0 — per-tick in-memory accumulator for `status.json`.
//
// Owns the load → validate → commit pipeline that backs the
// two-phase per-tick pipeline (data-processor writes, then render
// reads). The plugin runs as a fresh process on every statusline
// tick, so the tick begins with no in-memory state; beginTick()
// reads the entire status.json into memory once, validates the
// incoming TokenSnapshot, and exposes a single pending Store for
// the data-processor (src/data-processor.ts) to mutate. commit()
// runs IMMEDIATELY after the data-processor finishes, BEFORE
// render begins, so a render crash leaves an up-to-date status.json
// on disk.
//
// Two-phase pipeline (per user contract 2026-07-04):
//   1. Data processing (src/data-processor.ts:processTick) — owns
//      all writes to pending. Always runs, independent of the
//      user's lineTemplate. Even an empty template still has the
//      data-processor fire (so the next tick has a baseline).
//   2. Rendering (src/render.ts) — pure read against pending. NO
//      tickState.mark / statusStore.write* calls anywhere in
//      render.ts anymore.
//
// Why this exists:
//   - The previous code path fired 5–13 writeFileSync calls per
//     render because every module (`accPrimer`, `accCachePrimer`,
//     `setLastSpeed`, `setPrevTick`) wrote the entire file
//     individually. This module collapses that to one write per
//     tick (or zero on invalid ticks).
//   - Reads are now uniformly in-memory: the renderer's
//     `tickState.getState().pending[key]` consults the same Map that
//     `mark()` writes to, so mid-render reads see their own writes
//     immediately — same behavior as the previous read-after-write
//     via the _stores Map, but without the per-call full-file
//     rewrite.
//
// Validation gate (per user contract 2026-07-04):
//   totalIn > 0 AND totalOut > 0 AND deltaApiMs > 0
//
//   `totalIn` / `totalOut` come from the parsed TokenSnapshot
//   (`tokens.totals.tokenTotalIn / tokenTotalOut`); `deltaApiMs` is
//   `cost.totalApiDurationMs - prevTickStatus.totalApiMs` when a
//   prev baseline exists, or `cost.totalApiDurationMs` alone on the
//   first tick (a 0-cost tick is a no-op by definition).
//
//   When validation fails, `commit()` short-circuits — no file
//   rewrite happens. The renderer can still read `pending` (which
//   starts as a clone of `loaded`) so the in-memory view stays
//   coherent; only the disk side is skipped.
//
// On-disk schema:
//   The Store / TickStatusValue / PrevTickStatusValue / LastActiveValue
//   shapes are byte-identical to the previous on-disk format. No
//   migration is required for existing installs. The validation gate
//   is the only new contract — invalid past ticks were already silent
//   no-ops via the `hasDelta=false` short-circuits in render.ts; this
//   module makes the policy explicit at the start of the tick instead
//   of distributed across render.ts.

import {
  type Entry,
  type Store,
  CCSESSION_KEY,
  PREV_TICK_KEY,
  emptyTickStatus,
  emptyPrevTickStatus,
  flushToDisk as flushToDiskPublic,
  loadFromDisk as loadFromDiskPublic,
} from "./status-store.ts";
import type { TokenSnapshot } from "./types.ts";

// ----- Tick state shape -----
//
// `loaded` is the snapshot from disk at beginTick() time. `pending`
// is the in-memory mutation copy that `mark()` writes to. Both are
// kept as separate Map references (sharing the same Record type) so
// the commit step can distinguish "dirty since load" from
// "byte-identical to load" via a single comparison, and so the
// renderer can never accidentally read a stale view — every read
// goes through `getState().pending[key]`.
export type TickState = {
  cwd: string | null;
  tokens: TokenSnapshot | null;
  loaded: Store;
  pending: Store;
  dirty: boolean;
  prevTick: import("./status-store.ts").PrevTickStatusValue | null;
  valid: boolean;
  // v1.0 — TickDeltaResult computed by processTick Stage 2. Stashed
  // here (NOT in `pending`) because it's a transient per-tick
  // reading, not part of status.json. Render modules read it via
  // `getDeltaForRender()` from data-processor.ts. Set by processTick
  // once per tick; never read by commit(); never serialized to disk.
  delta: import("./data-processor.ts").TickDeltaResult | null;
};

let _state: TickState | null = null;

// Deep-clone a Store Record. Entry objects are flat (at + value +
// kind) — a simple spread suffices. The clone decouples `pending`
// from `loaded` so a renderer's `mark()` mutation cannot bleed
// back into the cached parsed-on-disk view across ticks. We
// rebuild the entry as a fresh object so TypeScript narrows the
// kind back to the discriminated Entry shape without an unsafe
// cast on the whole value field.
function cloneStore(store: Store): Store {
  const out: Store = {};
  for (const k of Object.keys(store)) {
    const e = store[k]!;
    out[k] = makeEntryForExisting(e);
  }
  return out;
}

// Clone helper — like makeEntry but reads the existing entry's
// `kind` tag instead of inferring it from the key. Needed for
// cloneStore (and reserved for any future code that needs to
// re-shape an Entry without changing its value). The kind
// narrows the value field so the resulting Entry is fully
// typed.
function makeEntryForExisting(e: Entry): Entry {
  if (e.kind === "prevTickStatus") {
    return { at: e.at, kind: "prevTickStatus", value: e.value };
  }
  if (e.kind === "lastActive") {
    return { at: e.at, kind: "lastActive", value: e.value };
  }
  return { at: e.at, kind: "tickStatus", value: e.value };
}

// Map a logical key to its Entry kind AND its value type. The
// Store shape is a flat Record; the renderer doesn't carry the
// kind tag, so we infer it from the key prefix and use the
// inferred kind to narrow the Entry union at the construction
// site:
//   `tickStatus:*`        → tickStatus (NOT for PREV_TICK_KEY)
//   `lastActive:<dir>`    → lastActive
//   PREV_TICK_KEY         → prevTickStatus
// Anything else throws — keeping the contract narrow means a typo
// at a call site fails fast at runtime instead of silently
// misclassifying the slot.
function makeEntry(
  key: string,
  value: Entry["value"],
): Entry {
  if (key === PREV_TICK_KEY) {
    return { at: Date.now(), kind: "prevTickStatus", value: value as import("./status-store.ts").PrevTickStatusValue };
  }
  if (
    key === "lastActive:in" ||
    key === "lastActive:out" ||
    key === "lastActive:apiMs" ||
    key === "lastActive:tokenHitRate"
  ) {
    return { at: Date.now(), kind: "lastActive", value: value as import("./status-store.ts").LastActiveValue };
  }
  if (key === CCSESSION_KEY || key.startsWith("tickStatus:")) {
    return { at: Date.now(), kind: "tickStatus", value: value as import("./status-store.ts").TickStatusValue };
  }
  throw new Error(
    `tick-state: unknown key "${key}" — must be ${PREV_TICK_KEY}, ` +
      `tickStatus:<dim>, ${CCSESSION_KEY}, or lastActive:<in|out|apiMs|tokenHitRate>`,
  );
}

// Validate the parsed snapshot against the user contract:
//   totalIn > 0 AND totalOut > 0 AND deltaApiMs > 0
//
// `tokens` may be null when stdin was empty / malformed (parse
// returned null). In that case validation fails — we have no
// usable state to commit. `tokens.totals.tokenTotalIn / tokenTotalOut`
// may also be null when the corresponding fields aren't shipped;
// those also fail validation.
//
// For `deltaApiMs`: the simplest formulation that matches the user
// contract is `cost.totalApiDurationMs > 0 AND
// (totalApiMs - prev.apiMs) > 0 when prev exists`. On the first
// tick prev is null and the rule collapses to `totalApiMs > 0`.
//
// Returns false in all invalid cases. The store parameter is
// unused today but reserved for future checks (e.g. "first-tick
// prev == null" vs "session-restart prev.totalApiMs > 0" might
// distinguish a fresh baseline vs a regression).
function validateTick(
  tokens: TokenSnapshot | null,
  prev: import("./status-store.ts").PrevTickStatusValue | null,
): boolean {
  if (!tokens) return false;
  const totalIn = tokens.totals?.tokenTotalIn ?? null;
  const totalOut = tokens.totals?.tokenTotalOut ?? null;
  const totalApiMs = tokens.cost?.totalApiDurationMs ?? null;
  if (totalIn == null || totalIn <= 0) return false;
  if (totalOut == null || totalOut <= 0) return false;
  if (totalApiMs == null || totalApiMs <= 0) return false;
  // deltaApiMs > 0 — when prev is null we already enforced
  // totalApiMs > 0 above (which implies deltaApiMs > 0 on a fresh
  // baseline). When prev exists, enforce the explicit delta.
  if (prev != null && totalApiMs - prev.totalApiMs <= 0) return false;
  return true;
}

// v1.0 — exported so data-processor's processTick can re-validate
// against the actual tokens it received (beginTick's `valid` was
// computed against whatever tokens the beginTick-for-test path
// passed in — sometimes null, sometimes a stale parse — and
// processTick must trust the same tokens the renderer will).
export const validateTickForDataProcessor = validateTick;

// Initialize the per-tick state. Called exactly once per tick from
// index.ts:main right after parseTokenSnapshot. Reads the entire
// status.json into `loaded`, clones it to `pending`, runs
// validation, and stashes the result in `_state`.
//
// Cwd is nullable — the per-project directory path only exists
// after a successful parse. When cwd is null the per-tick state
// has empty loaded/pending stores and validation fails (no cwd →
// no file → no write). The renderer can still consume the parsed
// tokens; it just has no persistent state to read or write.
export function beginTick(cwd: string | null, tokens: TokenSnapshot | null): TickState {
  const loaded: Store = cwd ? loadFromDiskPublic(cwd) : {};
  const prevEntry = loaded[PREV_TICK_KEY];
  const prev = prevEntry?.kind === "prevTickStatus" ? prevEntry.value : null;
  const valid = validateTick(tokens, prev);
  _state = {
    cwd,
    tokens,
    loaded,
    pending: cloneStore(loaded),
    dirty: false,
    prevTick: prev,
    valid,
    delta: null,
  };
  return _state;
}

// Retrieve the active tick state. Throws if beginTick() wasn't
// called — the contract is "every render call happens inside a
// tick that began with beginTick()". Production always satisfies
// this; the throw exists to surface renderer-module ordering bugs
// during development.
export function getState(): TickState {
  if (!_state) {
    throw new Error(
      "tick-state: getState() called without beginTick() — " +
        "every render must be wrapped in a tick started by index.ts:main",
    );
  }
  return _state;
}

// Write a value into `pending[key]`. Cheap (single Map set) and
// has no filesystem side effects — the actual write happens at
// commit() time. The value type is inferred from the key (see
// makeEntry) so callers don't need to specify the Entry shape.
// Use the `value` type guards on statusStore (TickStatusValue,
// PrevTickStatusValue, LastActiveValue) at the call site to keep
// TypeScript happy.
export function mark(
  key: string,
  value: Entry["value"],
): void {
  const s = getState();
  s.pending[key] = makeEntry(key, value);
  s.dirty = true;
}

// Flush the pending store to disk as a single full-file rewrite.
// No-op when:
//   - `_state` is null (beginTick() not called — guard against
//     post-render calls); OR
//   - `dirty === false` (nothing was marked since load — saves a
//     redundant disk touch on idle ticks where only prevTick was
//     updated, AND on freshly-loaded ticks that don't need a
//     rewrite at all); OR
//   - `valid === false` (validation gate failed — see validateTick
//     for the rule).
//
// When cwd is null (no per-project dir available), the call is a
// silent no-op: there's no path to write to. The renderer saw the
// parsed tokens via getState().tokens but persistent state was
// never an option this tick.
//
// Crash-tolerance: if the process dies between the render output
// and commit(), this tick's `pending` mutations are lost. The
// next tick re-reads from disk and rebuilds — the only cost is
// "one tick of acc growth / lastActive cache freshness", which
// the statusline recovers from on its own. We deliberately do NOT
// add an `on('exit')` flush hook: Node doesn't reliably emit
// exit/ beforeExit synchronously with stdout close, and adding
// a second flush point re-introduces the write amplification the
// module is meant to eliminate.
export function commit(): void {
  const s = _state;
  if (!s) return;
  if (!s.dirty || !s.valid) return;
  if (!s.cwd) return;
  flushToDiskPublic(s.cwd, s.pending);
}

// Test-only: clear the module-global _state between tests, so a
// subsequent beginTick() builds a fresh TickState. Mirrors the
// pattern in cache.ts:__resetForTest and status-store.ts:
// __resetForTest. Production code never calls this.
export function resetTickStateForTest(): void {
  _state = null;
}

// Test-only: bootstrap a valid TickState without going through the
// index.ts:main pipeline. Tests that drive render functions
// directly (peekPrevTick, setLastSpeed, etc.) need a populated
// _state before any tickState.mark() / tickState.getState() call
// fires, otherwise the throw in getState() aborts the render.
//
// This wraps beginTick() and immediately re-arms the state with
// `dirty=false` so a subsequent test that doesn't mutate anything
// won't fire a spurious disk write. Tests that need the validation
// gate can call this without arguments (validation will fail on
// null tokens, but tests that only need the in-memory pending map
// work fine with valid=false).
export function beginTickForTest(
  cwd: string | null = null,
  tokens: TokenSnapshot | null = null,
): TickState {
  beginTick(cwd, tokens);
  _state!.dirty = false;
  return _state!;
}

// Re-export helpers so renderers don't have to reach into
// status-store.ts for the key constants or empty-value
// constructors. The empty TickStatusValue is used by the
// regression-reset path in render.ts (the one place where
// immediate disk writes are still required); exporting it here
// keeps render.ts's import surface narrow.
export { CCSESSION_KEY, PREV_TICK_KEY, emptyTickStatus, emptyPrevTickStatus };
