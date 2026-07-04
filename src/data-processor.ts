// v1.0 — Data processing phase.
//
// Splits the v0.9.x per-tick pipeline into two clean phases:
//
//   1. Data processing (this file) — runs FIRST, once per tick,
//      before any rendering. Owns all writes to status.json
//      (via tickState.mark + the single tickStateCommit() flush).
//      Runs INDEPENDENT of the user's lineTemplate: even an empty
//      template (no m_acc*/m_token*/m_apiMs/...) still processes
//      the tick data. Per user contract 2026-07-04:
//
//        "数据处理早于render,即使没有render也应该梳理数据.
//         不是判断是否存在相应模块才进行数据处理.
//         数据处理本身永远会执行."
//
//   2. Rendering (src/render.ts) — runs SECOND, as a pure read
//      against tickState.pending. NO tickState.mark /
//      statusStore.write* / setAvg / setPrevTick / setLast* calls
//      anywhere in render.ts anymore.
//
// What moved here from render.ts:
//   - setPrevTick, setLastSpeed, setLastApiMs, setLastTokenHitRate
//   - setAvg (and its AvgSnapshot type)
//   - computeAndCacheTickDelta (renamed computeAndCacheTickDeltaPure;
//     the memoization layers _tickDeltaMemo / _tickAvgWriteMemo /
//     _tickCacheWriteMemo are gone — single producer per tick)
//   - accPrimer, accCachePrimer (replaced by processTick's stages)
//   - stashPrevTick, commitPrevTickOnce, _pendingPrevTick (replaced
//     by direct tickState.mark(PREV_TICK_KEY, ...) in Stage 3)
//
// Back-compat: render.ts re-exports setPrevTick / setAvg / setLastSpeed
// / setLastApiMs / setLastTokenHitRate so existing test fixtures that
// import them from "../src/render.ts" still compile. New code should
// import directly from "./data-processor.ts".

import { projectHash } from "./token-store.ts";
import * as statusStore from "./status-store.ts";
import * as tickState from "./tick-state.ts";
import type { TokenSnapshot } from "./types.ts";

// ============================================================================
// Public types (formerly in render.ts)
// ============================================================================

export type PrevTickSnapshot = {
  apiMs: number;
  in: number;
  out: number;
  cacheRead: number;
  totalIn: number;
};

export type TickDeltaResult = {
  hasDelta: boolean;
  deltaIn: number;
  deltaOut: number;
  deltaApi: number;
  // v0.4.0+: delta of current_usage.cache_read_input_tokens
  // across the last tick. Feeds the per-tick-delta-accumulator
  // field accCached (via the m_acc* family). Defaults to 0 when
  // either side of the subtraction is null (stdin lacked the
  // field — see computeAndCacheTickDeltaPure).
  deltaCacheRead: number;
  // v0.8.0+: delta of context_window.total_input_tokens across
  // the last tick. Mirrors the v0.4.x deltaCacheRead shape — both
  // feed per-tick-delta-accumulator fields (accTotalIn, accCached).
  // Source: t.totals.tokenTotalIn; on first tick assumes prev=0.
  deltaTotalIn: number;
  // v0.8.0+: latest session-cumulative context_window.total_input_tokens
  // (snapshot, not delta). Source: t.totals.tokenTotalIn.
  currentTotalIn: number | null;
  writeBack: PrevTickSnapshot | null;
};

export type AvgSnapshot = {
  accIn: number;
  accOut: number;
  accApi: number;
  accCached: number;
  accApiCount: number;
  accTotalIn: number;
};

export type LastSpeedSnapshot = {
  direction: "in" | "out";
  tps: number;
};

// ============================================================================
// Internal: peek helpers (used by computeAndCacheTickDeltaPure + tests)
// ============================================================================

// Read the prev-tick baseline from in-memory pending. Mirrors
// render.ts's peekPrevTick (the renderer's read is unchanged).
function peekPrevTickLocal(
  sessionId: string,
  cwd?: string | null,
): PrevTickSnapshot | null {
  void cwd;
  const s = tickState.getState();
  const e = s.pending[statusStore.PREV_TICK_KEY];
  const v = e?.kind === "prevTickStatus" ? e.value : null;
  if (!v) return null;
  // v0.8.x cwf-tickStatus-v2 — the singleton prevTickStatus is
  // shared across ALL sessions in the same cwd. To preserve the
  // "first tick of a new session is a fresh delta" contract
  // (deltaApi = current - 0 = current > 0, hasDelta=true), we
  // MUST treat the singleton as null when its sessionId doesn't
  // match the current sessionId.
  if (v.sessionId !== null && v.sessionId !== sessionId) return null;
  return {
    apiMs: v.totalApiMs,
    in: v.in,
    out: v.out,
    cacheRead: v.cachedIn,
    totalIn: v.totalIn,
  };
}

// ============================================================================
// Public: peek helpers (re-exported for render.ts read paths)
// ============================================================================

export function peekPrevTick(
  sessionId: string,
  cwd?: string | null,
): PrevTickSnapshot | null {
  return peekPrevTickLocal(sessionId, cwd);
}

export function peekLastSpeed(
  _sessionId: string,
  direction: "in" | "out",
  cwd?: string | null,
): number | null {
  void _sessionId;
  void cwd;
  const e = tickState.getState().pending[`lastActive:${direction}`];
  if (!e || e.kind !== "lastActive") return null;
  return Number.isFinite(e.value.tps) ? e.value.tps : null;
}

export function peekLastApiMs(
  _sessionId: string,
  cwd?: string | null,
): number | null {
  void _sessionId;
  void cwd;
  const e = tickState.getState().pending["lastActive:apiMs"];
  if (!e || e.kind !== "lastActive") return null;
  return Number.isFinite(e.value.tps) ? e.value.tps : null;
}

export function peekLastTokenHitRate(
  _sessionId: string,
  cwd?: string | null,
): number | null {
  void _sessionId;
  void cwd;
  const e = tickState.getState().pending["lastActive:tokenHitRate"];
  if (!e || e.kind !== "lastActive") return null;
  return Number.isFinite(e.value.tps) ? e.value.tps : null;
}

export function peekAvg(
  sessionId: string,
  cwd?: string | null,
): AvgSnapshot | null {
  if (!sessionId) return null;
  void cwd;
  const e = tickState.getState().pending[`tickStatus:${sessionId}`];
  if (!e || e.kind !== "tickStatus") return null;
  const v = e.value;
  return {
    accIn: v.accIn,
    accOut: v.accOut,
    accApi: v.accApiMs,
    accCached: v.accCached,
    accApiCount: v.accApiCount,
    accTotalIn: v.accTotalIn,
  };
}

// ============================================================================
// Pure delta math (formerly computeAndCacheTickDelta in render.ts)
//
// Single source of truth for the per-API-call delta math. Lives at
// the top of the data-processing pipeline so every per-API-call
// module (m_tokenIn / m_tokenOut / m_tokenInSpeed / m_tokenOutSpeed)
// sees the same numbers. Memoization is no longer needed because
// processTick calls this exactly once per tick, and render reads
// the result via getDeltaForRender().
//
// Behavior (unchanged from v0.9.x):
//   1. If snapshot data is missing (no sessionId / no
//      totalApiDurationMs / no current.input/output), return
//      hasDelta=false and writeBack=null.
//   2. Otherwise, peek the prevTick. ALWAYS build a writeBack
//      for Stage 3 to land (even when delta computation fails).
//   3. If prev exists and (deltaApi > 0), compute the deltas and
//      return hasDelta=true.
// ============================================================================

export function computeAndCacheTickDeltaPure(
  tokens: TokenSnapshot | null,
): TickDeltaResult {
  const t = tokens;
  if (!t || !t.sessionId) {
    return {
      hasDelta: false, deltaIn: 0, deltaOut: 0, deltaApi: 0,
      deltaCacheRead: 0, deltaTotalIn: 0, currentTotalIn: null,
      writeBack: null,
    };
  }
  const currentApi = t.cost.totalApiDurationMs;
  const currentIn = t.current.tokenIn;
  const currentOut = t.current.tokenOut;
  const currentCacheRead = t.current.tokenCachedIn;
  // v0.8.0+ — `totals.tokenTotalIn` IS the v0.8.0 `totalIn` (source:
  // context_window.total_input_tokens). May be null on stdin that
  // lacks the field; in that case deltaTotalIn=0 and currentTotalIn=null.
  const currentTotalIn = t.totals?.tokenTotalIn ?? null;
  if (currentApi == null || currentIn == null || currentOut == null) {
    return {
      hasDelta: false, deltaIn: 0, deltaOut: 0, deltaApi: 0,
      deltaCacheRead: 0, deltaTotalIn: 0, currentTotalIn,
      writeBack: null,
    };
  }
  const prev = peekPrevTickLocal(t.sessionId, t.cwd);
  // Always write the current snapshot so the next tick has a
  // baseline for the `deltaApi` math, even when we render "--" /
  // skip the cache accumulator update. The `in` / `out` /
  // `cacheRead` fields of writeBack are unused by the new
  // accumulation model but kept for schema stability.
  const writeBack: PrevTickSnapshot = {
    apiMs: currentApi,
    in: currentIn,
    out: currentOut,
    cacheRead: currentCacheRead ?? 0,
    totalIn: currentTotalIn ?? 0,
  };
  // v0.4.0+ (revised 2026-06-29): when no previous tick exists,
  // assume prev=0 so the first tick still contributes. Matches
  // the per-turn-delta contract: current_usage.* values are THIS
  // turn's contribution, and on the very first turn there is no
  // "previous" to compare against.
  const prevApiMs = prev?.apiMs ?? 0;
  // current_usage.{input_tokens, output_tokens,
  // cache_read_input_tokens} are PER-TURN DELTAS — they report
  // THIS turn's contribution, not a running total. We do NOT
  // subtract prev; the value is already the per-turn delta. The
  // only subtraction is deltaApi, where prev.apiMs tells us
  // "did total_api_duration_ms change this tick?".
  //
  // Gating is deltaApi > 0 ONLY. In / out / cache_read don't all
  // have to move together.
  const deltaApi = currentApi - prevApiMs;
  const deltaIn = currentIn;
  const deltaOut = currentOut;
  const deltaCacheRead = currentCacheRead ?? 0;
  // v0.8.0+ — deltaTotalIn is a TRUE subtraction (totals.input is
  // session-cumulative, NOT a per-turn delta). Same first-tick
  // convention: prev=0, so the first tick contributes the full
  // currentTotalIn. May be negative only if totals.input regressed
  // (cache eviction / model reset) — in that case clamp to 0.
  const deltaTotalIn = currentTotalIn != null
    ? Math.max(0, currentTotalIn - (prev?.totalIn ?? 0))
    : 0;
  const hasDelta = deltaApi > 0;
  return {
    hasDelta, deltaIn, deltaOut, deltaApi, deltaCacheRead,
    deltaTotalIn, currentTotalIn, writeBack,
  };
}

// ============================================================================
// Public: setPrevTick (writes PREV_TICK_KEY to pending)
// ============================================================================

export function setPrevTick(
  _sessionId: string,
  snap: PrevTickSnapshot,
  cwd?: string | null,
  identity?: { sessionId?: string | null; cwd?: string | null; model?: string | null },
): void {
  void _sessionId;
  void cwd;
  const s = tickState.getState();
  const prevEntry = s.pending[statusStore.PREV_TICK_KEY];
  const prev = prevEntry?.kind === "prevTickStatus"
    ? prevEntry.value
    : statusStore.emptyPrevTickStatus();
  tickState.mark(statusStore.PREV_TICK_KEY, {
    in: snap.in,
    out: snap.out,
    cachedIn: snap.cacheRead,
    totalIn: snap.totalIn,
    totalApiMs: snap.apiMs,
    sessionId: identity?.sessionId ?? prev.sessionId,
    cwd: identity?.cwd ?? prev.cwd,
    model: identity?.model ?? prev.model,
  });
}

// ============================================================================
// Public: lastActive writers (m_tokenInSpeed/OutSpeed/m_apiMs/m_tokenHitRate)
// ============================================================================

export function setLastSpeed(
  _sessionId: string,
  direction: "in" | "out",
  tps: number,
  cwd?: string | null,
): void {
  void _sessionId;
  void cwd;
  tickState.mark(`lastActive:${direction}`, { direction, tps });
}

export function setLastApiMs(
  _sessionId: string,
  deltaApiMs: number,
  cwd?: string | null,
): void {
  void _sessionId;
  void cwd;
  tickState.mark("lastActive:apiMs", { direction: "apiMs", tps: deltaApiMs });
}

export function setLastTokenHitRate(
  _sessionId: string,
  pct: number,
  cwd?: string | null,
): void {
  void _sessionId;
  void cwd;
  tickState.mark("lastActive:tokenHitRate", { direction: "tokenHitRate", tps: pct });
}

// ============================================================================
// Public: setAvg (four-layer accumulator write)
//
// Per-scope contract (v0.8.x cwf-tickStatus-v2, refined 2026-07-04):
//   - tickStatus:<sid>   : DELTA-ACCUMULATE for all scalar fields.
//   - tickStatus:<hash>  : DELTA-ACCUMULATE across sessions/ticks.
//   - tickStatus:ccsession: DELTA-ACCUMULATE for all scalar fields.
//                          Regression-reset is handled by
//                          processTick Stage 1 BEFORE this fires.
//   - tickStatus:<model> : DELTA-ACCUMULATE for all scalar fields.
//
// Caller passes the delta math (computeAndCacheTickDeltaPure already
// produced it). Per-tick `in`/`out`/`cachedIn`/`totalIn`/
// `totalApiMs` fields are NOT stored on tickStatus — they live in
// the singleton `prevTickStatus` slot, which the caller updates via
// setPrevTick BEFORE/AFTER calling setAvg.
// ============================================================================

export function setAvg(
  sessionId: string,
  snap: AvgSnapshot,
  cwd?: string | null,
  extras?: {
    modelDisplayName?: string | null;
    deltaApiCount?: number;
    currentApiMs?: number;
    // Per-tick deltas to ADD into the project-wide / ccsession /
    // per-provider aggregate accumulators. When omitted (legacy
    // callers), the aggregate slots are not bumped.
    deltaIn?: number;
    deltaOut?: number;
    deltaCache?: number;
    deltaApiMs?: number;
    deltaTotalIn?: number;
  },
): void {
  if (!sessionId) return;
  const incrementCount = extras?.deltaApiCount ?? 0;

  // Per-session slot — DELTA-ACCUMULATE for ALL scalar fields
  // including accApiMs (v0.8.x — broken out from the prior
  // ABSOLUTE-write behavior).
  void cwd;
  const sid = `tickStatus:${sessionId}`;
  const sidEntry = tickState.getState().pending[sid];
  const next: statusStore.TickStatusValue =
    sidEntry?.kind === "tickStatus"
      ? { ...sidEntry.value }
      : statusStore.emptyTickStatus();
  next.accIn += snap.accIn;
  next.accOut += snap.accOut;
  if (extras?.deltaApiMs) next.accApiMs += extras.deltaApiMs;
  next.accCached += snap.accCached;
  next.accApiCount += snap.accApiCount;
  next.accTotalIn += snap.accTotalIn;
  tickState.mark(sid, next);

  // Per-project aggregate — ACCUMULATE per-tick deltas.
  if (
    incrementCount > 0 ||
    extras?.deltaIn ||
    extras?.deltaOut ||
    extras?.deltaCache ||
    extras?.deltaApiMs ||
    extras?.deltaTotalIn
  ) {
    if (cwd) {
      const projectKey = `tickStatus:${projectHash(cwd)}`;
      const projEntry = tickState.getState().pending[projectKey];
      const agg: statusStore.TickStatusValue =
        projEntry?.kind === "tickStatus"
          ? { ...projEntry.value }
          : statusStore.emptyTickStatus();
      if (extras?.deltaIn) agg.accIn += extras.deltaIn;
      if (extras?.deltaOut) agg.accOut += extras.deltaOut;
      if (extras?.deltaCache) agg.accCached += extras.deltaCache;
      if (extras?.deltaApiMs) agg.accApiMs += extras.deltaApiMs;
      if (extras?.deltaTotalIn) agg.accTotalIn += extras.deltaTotalIn;
      if (incrementCount > 0) agg.accApiCount += incrementCount;
      tickState.mark(projectKey, agg);
    }
  }

  // ccsession accumulation. The slot was already reset to zero
  // by processTick Stage 1 on a regression, so a positive-delta
  // tick that follows lands on the clean baseline.
  {
    const ccsEntry = tickState.getState().pending[statusStore.CCSESSION_KEY];
    const ccs: statusStore.TickStatusValue =
      ccsEntry?.kind === "tickStatus"
        ? { ...ccsEntry.value }
        : statusStore.emptyTickStatus();
    if (extras?.deltaIn) ccs.accIn += extras.deltaIn;
    if (extras?.deltaOut) ccs.accOut += extras.deltaOut;
    if (extras?.deltaCache) ccs.accCached += extras.deltaCache;
    if (extras?.deltaApiMs) ccs.accApiMs += extras.deltaApiMs;
    if (extras?.deltaTotalIn) ccs.accTotalIn += extras.deltaTotalIn;
    if (incrementCount > 0) ccs.accApiCount += incrementCount;
    // Only persist when at least one field changed; otherwise
    // the read+write is a no-op disk touch on every tick.
    if (
      extras?.deltaIn ||
      extras?.deltaOut ||
      extras?.deltaCache ||
      extras?.deltaApiMs ||
      extras?.deltaTotalIn ||
      incrementCount > 0
    ) {
      tickState.mark(statusStore.CCSESSION_KEY, ccs);
    }
  }

  // Per-provider slot (model display name). Optional — only
  // exists when the caller supplied a modelDisplayName.
  const model = extras?.modelDisplayName;
  if (model && model.length > 0) {
    void cwd;
    const provKey = `tickStatus:${model}`;
    const provEntry = tickState.getState().pending[provKey];
    const prov: statusStore.TickStatusValue =
      provEntry?.kind === "tickStatus"
        ? { ...provEntry.value }
        : statusStore.emptyTickStatus();
    if (extras?.deltaIn) prov.accIn += extras.deltaIn;
    if (extras?.deltaOut) prov.accOut += extras.deltaOut;
    if (extras?.deltaCache) prov.accCached += extras.deltaCache;
    if (extras?.deltaApiMs) prov.accApiMs += extras.deltaApiMs;
    if (extras?.deltaTotalIn) prov.accTotalIn += extras.deltaTotalIn;
    if (incrementCount > 0) prov.accApiCount += incrementCount;
    tickState.mark(provKey, prov);
  }
}

// ============================================================================
// Public: getDeltaForRender — read path for render modules
//
// Returns the TickDeltaResult computed by processTick this tick.
// Render modules call this instead of running the math themselves.
// Single producer per tick means no memo needed.
// ============================================================================

// v1.0 — callers treat absence-of-delta the same as hasDelta=false
// (idle tick without a prior baseline). Returning a sentinel object
// removes null-handling from every render module.
const _NO_DELTA: TickDeltaResult = {
  hasDelta: false,
  deltaIn: 0,
  deltaOut: 0,
  deltaApi: 0,
  deltaCacheRead: 0,
  deltaTotalIn: 0,
  currentTotalIn: null,
  writeBack: null,
};

export function getDeltaForRender(): TickDeltaResult {
  return tickState.getState().delta ?? _NO_DELTA;
}

// ============================================================================
// Public: processTick — the entry point called from index.ts:main
//
// Called ONCE per tick, immediately after beginTick and BEFORE
// appendSample (so appendSample still sees pending[PREV_TICK_KEY]
// = the load-time prev baseline, not the current tick's writeBack).
//
// Stages:
//   1. Regression-reset (ccsession slot = empty if cost.totalApiMs
//      dropped vs prev.totalApiMs — i.e. CC process restarted)
//   2. Compute deltas (computeAndCacheTickDeltaPure) — stash on
//      _state.delta for render's getDeltaForRender() reads.
//   3. setPrevTick — overwrite pending[PREV_TICK_KEY] with current
//      snapshot (so the NEXT tick has a baseline).
//   4. setAvg for the session slot — delta-accumulate in/out/api/
//      cached/totalIn/apiCount.
//   4b. setAvg for the cache track — only when stdin shipped
//      cache_read_input_tokens (accCached gets the delta; other
//      fields stay zero so we don't double-count).
//   5. lastActive:* marks — tps in/out, apiMs, tokenHitRate.
//
// Stages 1-5 are gated on the validation flag from beginTick:
// _state.valid === true (totalIn>0 AND totalOut>0 AND
// deltaApiMs>0). When validation fails, processTick is a no-op
// for the data writes — render still works (renders n/a) and
// tickStateCommit will be a no-op (the validation gate also
// guards commit's flush).
// ============================================================================

export function processTick(
  cwd: string | null,
  tokens: TokenSnapshot | null,
): void {
  const s = tickState.getState();

  // Stage 1: regression-reset. Runs regardless of _state.valid
  // because even on an invalid tick we want the disk to reflect
  // the process restart so the NEXT valid tick starts clean.
  if (cwd && tokens?.sessionId) {
    const prevEntry = s.pending[statusStore.PREV_TICK_KEY];
    const prevPrev = prevEntry?.kind === "prevTickStatus" ? prevEntry.value : null;
    const currentApi = tokens.cost?.totalApiDurationMs;
    if (
      prevPrev != null &&
      currentApi != null &&
      currentApi < prevPrev.totalApiMs
    ) {
      // v1.0 — replaces the v0.9.x accPrimer's immediate
      // statusStore.writeTickStatus bypass. Now a regular mark;
      // commit() flushes it in the same full-file rewrite as
      // every other write this tick.
      tickState.mark(statusStore.CCSESSION_KEY, statusStore.emptyTickStatus());
    }
  }

  // Stage 2: compute deltas + stash on _state for render reads.
  const r = computeAndCacheTickDeltaPure(tokens);
  s.delta = r;

  // Stages 3-5 require a valid tick. Re-validate against the
  // ACTUAL tokens we received + the prev baseline that beginTick
  // loaded — beginTick's cached `valid` may have been computed
  // against null tokens (the test path) or a stale parse. We
  // trust processTick's own input here because by the time we
  // reach this point, parseTokenSnapshot has handed us the live
  // session JSON the renderer will see.
  const prevEntry2 = s.pending[statusStore.PREV_TICK_KEY];
  const prevForRecheck =
    prevEntry2?.kind === "prevTickStatus" ? prevEntry2.value : null;
  s.valid = tickState.validateTickForDataProcessor(tokens, prevForRecheck);
  if (!s.valid) return;
  if (!tokens?.sessionId) return;

  // Stage 3: setPrevTick. Always fires (not gated on hasDelta)
  // so the next tick's peekPrevTick sees the fresh baseline
  // even when this tick was idle.
  if (r.writeBack) {
    setPrevTick(tokens.sessionId, r.writeBack, cwd, {
      sessionId: tokens.sessionId,
      cwd,
      model: tokens.modelDisplayName ?? null,
    });
  }

  // Stage 4: setAvg for the session slot. Gated on hasDelta so
  // idle ticks don't re-fire on an unchanged baseline.
  if (r.hasDelta) {
    const incrementCount =
      r.deltaApi > 0 &&
      tokens.current.tokenIn != null &&
      tokens.current.tokenIn > 0
        ? 1
        : 0;
    const currentApi = tokens.cost?.totalApiDurationMs ?? 0;
    // Session slot — DELTAS for in/out/cached/totalIn; absolute
    // accApi (legacy field, still accepted for back-compat); 0
    // accCached here (Stage 4b handles the cache track separately).
    const sessionNext: AvgSnapshot = {
      accIn: r.deltaIn,
      accOut: r.deltaOut,
      accApi: currentApi,
      accCached: 0,
      accApiCount: incrementCount,
      accTotalIn: r.deltaTotalIn,
    };
    setAvg(tokens.sessionId, sessionNext, cwd, {
      modelDisplayName: tokens.modelDisplayName ?? null,
      deltaApiCount: incrementCount,
      currentApiMs: currentApi,
      deltaIn: r.deltaIn,
      deltaOut: r.deltaOut,
      // deltaCache deliberately omitted: do NOT accumulate the
      // missing-field 0 into accCached.
      deltaApiMs: r.deltaApi,
      deltaTotalIn: r.deltaTotalIn,
    });

    // Stage 4b: setAvg for the cache track — only when stdin
    // shipped cache_read_input_tokens (the "field not shipped"
    // contract). Zero every other field so we don't double-count
    // Stage 4's accumulation.
    if (tokens.current.tokenCachedIn != null) {
      const cacheNext: AvgSnapshot = {
        accIn: 0,
        accOut: 0,
        accApi: 0,
        accCached: r.deltaCacheRead,
        accApiCount: 0,
        accTotalIn: 0,
      };
      setAvg(tokens.sessionId, cacheNext, cwd, {
        modelDisplayName: tokens.modelDisplayName ?? null,
        currentApiMs: currentApi,
        deltaCache: r.deltaCacheRead,
      });
    }

    // Stage 5: lastActive cache. Compute tpsIn/tpsOut/apiMs
    // /tokenHitRate from r + tokens and mark pending.
    const tpsIn = (r.deltaIn / r.deltaApi) * 1000;
    const tpsOut = (r.deltaOut / r.deltaApi) * 1000;
    tickState.mark("lastActive:in", { direction: "in", tps: tpsIn });
    tickState.mark("lastActive:out", { direction: "out", tps: tpsOut });
    tickState.mark("lastActive:apiMs", { direction: "apiMs", tps: r.deltaApi });
    // tokenHitRate: per-turn cache_read / total_in percentage.
    if (tokens.totals?.tokenTotalIn && tokens.current.tokenCachedIn != null) {
      const pct = (tokens.current.tokenCachedIn / tokens.totals.tokenTotalIn) * 100;
      tickState.mark("lastActive:tokenHitRate", {
        direction: "tokenHitRate",
        tps: pct,
      });
    }
  }
}

// ============================================================================
// Test-only: clear the per-process data-processor state.
// Production code never calls this.
// ============================================================================

export function resetDataProcessorForTest(): void {
  // No module-level state in v1.0 (the old _pendingPrevTick
  // array + _tickDeltaMemo / _tickAvgWriteMemo / _tickCacheWriteMemo
  // WeakMaps are all gone). Kept as a no-op stub for back-compat
  // with test imports.
}