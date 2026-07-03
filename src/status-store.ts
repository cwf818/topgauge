// Per-project tick-status state.
//
// v0.8.x — cwf-tickStatus-v2. The on-disk schema in
// `<projectHash>/status.json` now carries two top-level slot
// families with clearly separated semantic roles:
//
//   (A) tickStatus:<...>  — PURE ACCUMULATORS (the user's
//       "tickStatus 只表示累计状态" rule). Four dimensions, all
//       write-only through setAvg's atomic path in render.ts:
//
//       tickStatus:<sessionId>   per-session (clear-bounded)
//       tickStatus:<projectHash> per-project (cwd-bounded, no prefix)
//       tickStatus:<model>       per-model (modelDisplayName)
//       tickStatus:ccsession     per-claude-code-process (singleton,
//                                no sessionId suffix; reset on
//                                totalApiMs regression — see render.ts)
//
//       value shape (TickStatusValue):
//         accIn        — accumulated current.input   across API calls
//         accOut       — accumulated current.output  across API calls
//         accCached    — accumulated current.cacheRead across API calls
//         accTotalIn   — per-tick-delta-accumulator of totalIn
//         accApiMs     — session-cumulative cost.totalApiDurationMs
//                        at the last write (NOT a delta accumulator;
//                        mirrors stdin's monotonic field)
//         accApiCount  — accumulated API-call count
//
//   (B) prevTickStatus  — SINGLETON, NOT per-dimension. Holds the
//       last tick's stdin snapshot. Pure std cache used by the
//       writer to (i) compute the per-tick delta in/out/cachedIn/
//       totalIn/totalApiMs and (ii) detect a ccsession reset (the
//       user-defined rule: if current totalApiMs <
//       prevTickStatus.totalApiMs, the Claude Code process
//       restarted and the ccsession accumulator must be reset).
//
//       value shape (PrevTickStatusValue):
//         in          — prev tick's current.input
//         out         — prev tick's current.output
//         cachedIn    — prev tick's current.cacheRead
//         totalIn     — prev tick's session-cumulative totalIn
//         totalApiMs  — prev tick's session-cumulative cost.totalApiDurationMs
//         sessionId   — prev tick's stdin session_id (debug aid)
//         cwd         — prev tick's stdin cwd
//         model       — prev tick's stdin modelDisplayName
//
// Why a separate file (vs. cache.json)?
//   - The legacy `state/cache.json` is the home for provider-specific
//     data (minimax, deepseek) AND the v0.8.0+ sum/avg cross-project
//     cache (see D4 in v0.8.0 plan). Tick-status data is per-tick
//     stdin state — a completely different concern. Keeping them apart
//     means `:clean --purge-runtime` can keep provider caches
//     intact while wiping per-tick state.
//   - The file lives under `state/<projectHash>/` so concurrent
//     Claude Code instances running against different projects never
//     share a write stream.
//
// Mutation model:
//   - Reads return a snapshot of the entry's `value` (or null on
//     miss / file error).
//   - Writes are full-file rewrites — the file is small (a handful
//     of entries, < 1KB total), so an in-memory read-modify-write
//     followed by a single synchronous writeFileSync is the simplest
//     correct strategy. The per-tick child-process model means we
//     only have ONE writer per file (no concurrent-process races
//     within the same project), so we don't need an append journal.
//   - Failures are swallowed (stderr only) so a write error never
//     blocks the statusline.

import {
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { projectHash } from "./token-store.ts";

// ----- Acc shape (per-dimension tickStatus value) -----
//
// Pure accumulator. No per-tick / per-session-cumulative fields —
// those live in prevTickStatus.
export type TickStatusValue = {
  accIn: number;
  accOut: number;
  accCached: number;
  accTotalIn: number;
  accApiMs: number;
  accApiCount: number;
};

// ----- Prev-tick std snapshot (singleton) -----
export type PrevTickStatusValue = {
  in: number;
  out: number;
  cachedIn: number;
  totalIn: number;
  totalApiMs: number;
  sessionId: string | null;
  cwd: string | null;
  model: string | null;
};

export type LastActiveValue = {
  direction: "in" | "out";
  tps: number;
};

// ----- Key taxonomy -----
//
// tickStatus:* — acc-only. The dimension is encoded in the suffix
// (sid | hash | model) OR the bare `tickStatus:ccsession` for the
// process-lifetime singleton. There is intentionally NO bare
// `tickStatus` (no suffix) — that was the v0.8.0 project-wide
// slot, now keyed by projectHash.
//
// lastActive:in / lastActive:out — per-direction tps cache, 60s TTL.

export const CCSESSION_KEY = "tickStatus:ccsession";
export const PREV_TICK_KEY = "prevTickStatus";

type Entry =
  | { at: number; value: TickStatusValue; kind: "tickStatus" }
  | { at: number; value: PrevTickStatusValue; kind: "prevTickStatus" }
  | { at: number; value: LastActiveValue; kind: "lastActive" };

type Store = Record<string, Entry>;

function stateRoot(): string {
  const home = process.env.HOME ?? process.env.USERPROFILE ?? "";
  const claudeRoot = process.env.CLAUDE_CONFIG_DIR ?? join(home, ".claude");
  return join(claudeRoot, "plugins", "topgauge-cc", "state");
}

// Public: per-project status file path. Exported so tests can point
// the resolver at a tmp dir.
export function statusFilePath(cwd: string): string {
  return join(stateRoot(), projectHash(cwd), "status.json");
}

let _pathResolver: (cwd: string) => string = statusFilePath;

// Test-only path hook. Production code never sets this.
export function setStatusPathResolver(fn: (cwd: string) => string): void {
  _pathResolver = fn;
}

export function resetStatusPathResolver(): void {
  _pathResolver = statusFilePath;
}

// Per-cwd lazy-load guard so we read the file at most once per
// (cwd, process). The statusStore is small (a handful of entries)
// and persists across per-tick child-process invocations through the
// on-disk file, just like cache.ts. The parsed `Store` is cached
// in-memory keyed by cwd so subsequent read-modify-write cycles
// within the same child process see prior writes without needing
// to re-parse the file every time.
const _stores = new Map<string, Store>();
const _loaded = new Set<string>();

function loadFromDisk(cwd: string): Store {
  const cached = _stores.get(cwd);
  if (cached) return cached;
  if (_loaded.has(cwd)) {
    // First call saw a missing/malformed file — return an empty
    // store for this cwd so writes still get flushed, but don't
    // re-attempt the disk read on every call.
    const empty: Store = {};
    _stores.set(cwd, empty);
    return empty;
  }
  _loaded.add(cwd);
  let raw: string;
  try {
    raw = readFileSync(_pathResolver(cwd), "utf8");
  } catch {
    const empty: Store = {};
    _stores.set(cwd, empty);
    return empty;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    process.stderr.write(
      "topgauge-cc: status file is malformed; ignoring\n",
    );
    const empty: Store = {};
    _stores.set(cwd, empty);
    return empty;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    const empty: Store = {};
    _stores.set(cwd, empty);
    return empty;
  }
  const out: Store = {};
  for (const [key, rawEntry] of Object.entries(parsed as Record<string, unknown>)) {
    const e = rawEntry as { at?: unknown; value?: unknown };
    if (typeof e.at !== "number" || !e.value || typeof e.value !== "object") continue;
    if (key === "lastActive:in" || key === "lastActive:out") {
      const v = e.value as Record<string, unknown>;
      const dir: "in" | "out" = key === "lastActive:in" ? "in" : "out";
      const tps = typeof v.tps === "number" ? v.tps : 0;
      out[key] = {
        at: e.at,
        value: { direction: dir, tps },
        kind: "lastActive",
      };
      continue;
    }
    if (key === PREV_TICK_KEY) {
      const v = e.value as Record<string, unknown>;
      out[key] = {
        at: e.at,
        value: {
          in: typeof v.in === "number" ? v.in : 0,
          out: typeof v.out === "number" ? v.out : 0,
          cachedIn: typeof v.cachedIn === "number" ? v.cachedIn : 0,
          totalIn: typeof v.totalIn === "number" ? v.totalIn : 0,
          totalApiMs: typeof v.totalApiMs === "number" ? v.totalApiMs : 0,
          sessionId: typeof v.sessionId === "string" ? v.sessionId : null,
          cwd: typeof v.cwd === "string" ? v.cwd : null,
          model: typeof v.model === "string" ? v.model : null,
        },
        kind: "prevTickStatus",
      };
      continue;
    }
    if (key === CCSESSION_KEY || key.startsWith("tickStatus:")) {
      const v = e.value as Record<string, unknown>;
      out[key] = {
        at: e.at,
        value: {
          accIn: typeof v.accIn === "number" ? v.accIn : 0,
          accOut: typeof v.accOut === "number" ? v.accOut : 0,
          accCached: typeof v.accCached === "number" ? v.accCached : 0,
          accTotalIn: typeof v.accTotalIn === "number" ? v.accTotalIn : 0,
          accApiMs: typeof v.accApiMs === "number" ? v.accApiMs : 0,
          accApiCount: typeof v.accApiCount === "number" ? v.accApiCount : 0,
        },
        kind: "tickStatus",
      };
    }
  }
  _stores.set(cwd, out);
  return out;
}

function flushToDisk(cwd: string, store: Store): void {
  const path = _pathResolver(cwd);
  try {
    mkdirSync(dirname(path), { recursive: true });
  } catch {
    process.stderr.write(
      "topgauge-cc: status mkdir failed; in-memory only\n",
    );
    return;
  }
  try {
    writeFileSync(path, JSON.stringify(store));
  } catch {
    process.stderr.write(
      "topgauge-cc: status write failed; in-memory only\n",
    );
  }
}

// Construct a fresh empty TickStatusValue (zeroed). Centralized so
// the read and write paths agree on the field set.
export function emptyTickStatus(): TickStatusValue {
  return {
    accIn: 0,
    accOut: 0,
    accCached: 0,
    accTotalIn: 0,
    accApiMs: 0,
    accApiCount: 0,
  };
}

export function emptyPrevTickStatus(): PrevTickStatusValue {
  return {
    in: 0,
    out: 0,
    cachedIn: 0,
    totalIn: 0,
    totalApiMs: 0,
    sessionId: null,
    cwd: null,
    model: null,
  };
}

// ----- tickStatus (per-dimension acc) -----

export function readTickStatus(
  cwd: string | null | undefined,
  key: string,
): TickStatusValue | null {
  if (!cwd) return null;
  const store = loadFromDisk(cwd);
  const e = store[key];
  if (!e || e.kind !== "tickStatus") return null;
  return e.value;
}

export function writeTickStatus(
  cwd: string | null | undefined,
  key: string,
  value: TickStatusValue,
): void {
  if (!cwd) return;
  const store = loadFromDisk(cwd);
  store[key] = { at: Date.now(), value, kind: "tickStatus" };
  flushToDisk(cwd, store);
}

// ----- prevTickStatus (singleton) -----

export function readPrevTickStatus(
  cwd: string | null | undefined,
): PrevTickStatusValue | null {
  if (!cwd) return null;
  const store = loadFromDisk(cwd);
  const e = store[PREV_TICK_KEY];
  if (!e || e.kind !== "prevTickStatus") return null;
  return e.value;
}

export function writePrevTickStatus(
  cwd: string | null | undefined,
  value: PrevTickStatusValue,
): void {
  if (!cwd) return;
  const store = loadFromDisk(cwd);
  store[PREV_TICK_KEY] = { at: Date.now(), value, kind: "prevTickStatus" };
  flushToDisk(cwd, store);
}

// ----- lastActive (v0.4.x) --------------------------------------------
//
// The pre-existing `tickSpeedDisplay:<direction>:<sessionId>` cache
// slot survives, simplified: no session dimension (single global
// per-project entry) and a 60s TTL. Used by m_tokenInSpeed /
// m_tokenOutSpeed so an idle tick (no API call this turn) can
// surface the last-active-tick tps instead of rendering "-- t/s".

const LAST_ACTIVE_TTL_MS = 60_000;

export function readLastActive(
  cwd: string | null | undefined,
  direction: "in" | "out",
): number | null {
  if (!cwd) return null;
  const store = loadFromDisk(cwd);
  const key = `lastActive:${direction}`;
  const e = store[key];
  if (!e || e.kind !== "lastActive") return null;
  if (Date.now() - e.at > LAST_ACTIVE_TTL_MS) return null;
  return Number.isFinite(e.value.tps) ? e.value.tps : null;
}

export function writeLastActive(
  cwd: string | null | undefined,
  direction: "in" | "out",
  tps: number,
): void {
  if (!cwd) return;
  const store = loadFromDisk(cwd);
  const key = `lastActive:${direction}`;
  store[key] = {
    at: Date.now(),
    value: { direction, tps },
    kind: "lastActive",
  };
  flushToDisk(cwd, store);
}

// Test-only: wipe the in-memory cache so the next call hits disk
// again. Mirrors cache.ts's `__resetForTest`.
export function __resetForTest(): void {
  _loaded.clear();
  _stores.clear();
}
