// Compatibility shim: per-tick state is now owned by src/status-store.ts.
// Keep these re-exports so existing imports continue to compile while the
// rest of the codebase is rewired to the unified status-store boundary.

export {
  beginTick,
  beginTickForTest,
  CCSESSION_KEY,
  commit,
  emptyPrevTickStatus,
  emptyTickStatus,
  getState,
  mark,
  PREV_TICK_KEY,
  resetTickStateForTest,
  type TickState,
  validateTickForDataProcessor,
} from "./status-store.ts";
