// Compatibility shim: write-side stdin processing now lives in
// src/status-store.ts. Keep the previous export surface available while
// callers are migrated to use status-store directly.

export {
  computeAndCacheTickDeltaPure,
  getDeltaForRender,
  peekAvg,
  peekLastApiMs,
  peekLastSpeed,
  peekLastTokenHitRate,
  peekPrevTick,
  processTick,
  resetDataProcessorForTest,
  setAvg,
  setLastApiMs,
  setLastSpeed,
  setLastTokenHitRate,
  setPrevTick,
  type AvgSnapshot,
  type LastActiveValue,
  type PrevTickSnapshot,
  type TickDeltaResult,
} from "./status-store.ts";
