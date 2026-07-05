// Runtime state boundary for stdin-derived data.
//
// This module owns three related state files under
// `${CLAUDE_CONFIG_DIR}/plugins/topgauge-cc/state/`:
//
//   - `cache.stat.json`                    — cross-project sum/avg stat cache
//   - `<projectHash>/state.json`           — per-project accumulated state
//   - `<projectHash>/<sessionId>.jsonl`    — append-only normalized samples
//
// The write path is intentionally centralized here:
//
//   stdin -> parseTokenSnapshot -> processAndSaveTick -> render
//
// `processAndSaveTick()` loads the project state, normalizes stdin,
// validates it, updates accumulators / prevTickStatus / lastActive,
// flushes `state.json` once, and appends one JSONL row when valid.
//
// Compatibility:
//   - `src/token-store.ts`, `src/tick-state.ts`, and `src/data-processor.ts`
//     are kept as thin compatibility shims that re-export the APIs now
//     implemented here.

import {
  appendFileSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import {
  append as appendDiag,
  logFsList,
  logFsMkdir,
  logFsRead,
  logFsStat,
  logFsWrite,
} from "./diagnostics.ts";
import type { TokenSample, TokenSnapshot } from "./types.ts";

// ----- Persisted value families ------------------------------------------------

export type TickStatusValue = {
  accTokenIn: number;
  accTokenOut: number;
  accTokenCachedIn: number;
  accTokenTotalIn: number;
  accApiMs: number;
  accApiCalls: number;
  // v0.8.10-alpha.3 — derived ratio, computed at processTick write
  // time and persisted alongside the raw accumulators. Render reads
  // it straight (no recompute). Formula:
  //   accTokenHitRate = accTokenCachedIn / accTokenTotalIn * 100
  // Zero denominator (no totalIn accumulated this slot) → 0.
  accTokenHitRate: number;
};

// v0.8.10-alpha.2 — PrevTickStatusValue is the "prev-snapshot" cursor:
// the ONLY field the next tick subtracts against is `totalApiMs`
// (apiMs = current.totalApiMs - prev.totalApiMs). All other per-turn
// fields live on `TokenSnapshot` as snapshot fields and are read
// straight, not derived. Identity (sessionId/cwd/model) is kept for
// stale-baseline detection.
export type PrevTickStatusValue = {
  totalApiMs: number;
  sessionId: string | null;
  cwd: string | null;
  model: string | null;
  // v0.8.15-alpha — carry-over for stdin `context_window.used_percentage`.
  // When the next tick arrives with contextUsedPercent===0 (an
  // observed error from the stdin producer), beginTick falls back
  // to this prev value rather than surfacing a misleading "0%".
  // Null when no prior tick has ever observed a non-null value.
  contextUsedPercent: number | null;
};

export type LastActiveValue = {
  direction: "in" | "out" | "apiMs" | "tokenHitRate";
  tps: number;
};

export const CCSESSION_KEY = "tickStatus:ccsession";
export const PREV_TICK_KEY = "prevTickStatus";

export type Entry =
  | { at: number; value: TickStatusValue; kind: "tickStatus" }
  | { at: number; value: PrevTickStatusValue; kind: "prevTickStatus" }
  | { at: number; value: LastActiveValue; kind: "lastActive" };

export type Store = Record<string, Entry>;

// v0.8.10-alpha.2 — the only derived delta in the whole pipeline.
// Speed modules (m_tokenInSpeed, m_tokenOutSpeed, m_apiMs) use this.
// The rest of the render path reads `TickSnapshot.{in, out, ...}` directly.
export type ApiMsDelta = {
  apiMs: number;        // -1 = regression sentinel, 0 = idle, >0 = real delta
  totalApiMs: number;   // current tick stdin value
};

// v0.8.10-alpha.2 — TickSnapshot replaces TickDeltaResult. It's a flat
// projection of the current tick's stdin snapshot + the single derived
// `apiMs`. No "writeBack" payload — next tick re-reads from disk.
export type TickSnapshot = {
  hasMeasurement: boolean;
  in: number;
  out: number;
  cachedIn: number;
  totalIn: number;
  totalOut: number;
  totalApiMs: number;
  apiMs: number;
};

export type AvgSnapshot = {
  accTokenIn: number;
  accTokenOut: number;
  accApiMs: number;
  accTokenCachedIn: number;
  accApiCalls: number;
  accTokenTotalIn: number;
  // v0.8.10-alpha.3 — mirror of TickStatusValue.accTokenHitRate,
  // pre-computed by the data-processor.
  accTokenHitRate: number;
};

// v0.8.10-alpha.2 — internal per-tick snapshot for the data-processor.
// Carries the full stdin snapshot + the single derived apiMs +
// regression flag + derived speed/rate metrics. Renamed from
// `NormalizedTick` because "normalized" was the old "delta of two
// snapshots" mental model.
type CurrentTick = {
  sessionId: string;
  cwd: string;
  modelDisplayName: string | null;
  // snapshot fields — read straight from stdin, no cross-tick subtract
  in: number;
  out: number;
  cachedIn: number;
  hasCachedIn: boolean;
  cacheCreation: number;
  totalIn: number | null;
  totalOut: number | null;
  totalApiMs: number;
  // the only derived delta
  apiMs: number;
  // baseline cursor + regression detection
  prevTotalApiMs: number | null;
  invalidRegression: boolean;
  // derived metrics used by speed / hit-rate modules
  tokenHitRate: number | null;
  tokenInSpeed: number | null;
  tokenOutSpeed: number | null;
};

export type ProcessResult = {
  valid: boolean;
  snapshot: CurrentTick | null;
  measurement: TickSnapshot;
  wroteState: boolean;
  wroteSample: boolean;
};

export type TickState = {
  cwd: string | null;
  tokens: TokenSnapshot | null;
  loaded: Store;
  pending: Store;
  dirty: boolean;
  prevTick: PrevTickStatusValue | null;
  valid: boolean;
  measurement: TickSnapshot | null;
  snapshot: CurrentTick | null;
  sample: TokenSample | null;
};

export type SumFilter = {
  windowKey: "5h" | "7d" | "all";
  sinceMs: number;
  alignActive: boolean;
  modelFilter?: string;
};

export type StatAggregate = {
  sumIn: number;
  sumOut: number;
  sumCached: number;
  sumTotalIn: number;
  sumApiMs: number;
  rows: number;
  calls: number;
  lastAt: number;
  generatedAt: number;
};

type StatCacheEntry<T> = { at: number; value: T; ttlMs?: number };

const EMPTY_TICK: TickSnapshot = {
  hasMeasurement: false,
  in: 0,
  out: 0,
  cachedIn: 0,
  totalIn: 0,
  totalOut: 0,
  totalApiMs: 0,
  apiMs: 0,
};

const STAT_CACHE_TTL_MS = 300_000;

// ----- Shared state root + path helpers ---------------------------------------

function defaultStateRoot(): string {
  const home = process.env.HOME ?? process.env.USERPROFILE ?? "";
  const claudeRoot = process.env.CLAUDE_CONFIG_DIR ?? join(home, ".claude");
  return join(claudeRoot, "plugins", "topgauge-cc", "state");
}

let _stateRoot: () => string = defaultStateRoot;

export function stateRoot(): string {
  return _stateRoot();
}

export function setStateRoot(fn: () => string): void {
  _stateRoot = fn;
  _loaded.clear();
  _stores.clear();
  __resetStatCacheForTest();
}

export function resetStateRoot(): void {
  _stateRoot = defaultStateRoot;
  _loaded.clear();
  _stores.clear();
  __resetStatCacheForTest();
}

export function projectHash(cwd: string): string {
  return cwd
    .replace(/[\\/:]/g, "-")
    .replace(/[\s\x00-\x1f\x7f]/g, "-")
    .toLowerCase()
    .slice(0, 80);
}

export function stateFilePath(cwd: string): string {
  return join(stateRoot(), projectHash(cwd), "state.json");
}

export function statusFilePath(cwd: string): string {
  return stateFilePath(cwd);
}

export function sampleFilePath(cwd: string, sessionId: string): string {
  return join(stateRoot(), projectHash(cwd), `${sessionId}.jsonl`);
}

export function statCacheFilePath(): string {
  return join(stateRoot(), "cache.stat.json");
}

let _pathResolver: (cwd: string) => string = statusFilePath;
let _statCachePathResolver: () => string = statCacheFilePath;

export function setStatusPathResolver(fn: (cwd: string) => string): void {
  _pathResolver = fn;
}

export function resetStatusPathResolver(): void {
  _pathResolver = statusFilePath;
}

export function setStatCachePathResolver(fn: () => string): void {
  _statCachePathResolver = fn;
}

export function resetStatCachePathResolver(): void {
  _statCachePathResolver = statCacheFilePath;
}

// ----- Per-project store load/flush -------------------------------------------

const _stores = new Map<string, Store>();
const _loaded = new Set<string>();

function cloneStore(store: Store): Store {
  const out: Store = {};
  for (const [key, entry] of Object.entries(store)) {
    if (entry.kind === "prevTickStatus") {
      out[key] = { at: entry.at, kind: entry.kind, value: { ...entry.value } };
      continue;
    }
    if (entry.kind === "lastActive") {
      out[key] = { at: entry.at, kind: entry.kind, value: { ...entry.value } };
      continue;
    }
    out[key] = { at: entry.at, kind: entry.kind, value: { ...entry.value } };
  }
  return out;
}

function parseStore(raw: string): Store {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    process.stderr.write("topgauge-cc: state file is malformed; ignoring\n");
    return {};
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
  const out: Store = {};
  for (const [key, rawEntry] of Object.entries(parsed as Record<string, unknown>)) {
    const e = rawEntry as { at?: unknown; value?: unknown };
    if (typeof e.at !== "number" || !e.value || typeof e.value !== "object") continue;
    if (
      key === "lastActive:in" ||
      key === "lastActive:out" ||
      key === "lastActive:apiMs" ||
      key === "lastActive:tokenHitRate"
    ) {
      const v = e.value as Record<string, unknown>;
      const direction: LastActiveValue["direction"] =
        key === "lastActive:in"
          ? "in"
          : key === "lastActive:out"
            ? "out"
            : key === "lastActive:apiMs"
              ? "apiMs"
              : "tokenHitRate";
      out[key] = {
        at: e.at,
        kind: "lastActive",
        value: {
          direction,
          tps: typeof v.tps === "number" ? v.tps : 0,
        },
      };
      continue;
    }
    if (key === PREV_TICK_KEY) {
      const v = e.value as Record<string, unknown>;
      // v0.8.10-alpha.2 — only totalApiMs + identity participate in
      // any cross-tick math. Legacy `in/out/cachedIn/totalIn` fields
      // on disk (from pre-alpha versions) are silently dropped.
      out[key] = {
        at: e.at,
        kind: "prevTickStatus",
        value: {
          totalApiMs: typeof v.totalApiMs === "number" ? v.totalApiMs : 0,
          sessionId: typeof v.sessionId === "string" ? v.sessionId : null,
          cwd: typeof v.cwd === "string" ? v.cwd : null,
          model: typeof v.model === "string" ? v.model : null,
          // v0.8.15-alpha — backfill contextUsedPercent for legacy
          // prev rows. Missing field → null (start of history); a
          // numeric 0/100 stays 0/100 as parsed.
          contextUsedPercent: typeof v.contextUsedPercent === "number"
            ? v.contextUsedPercent
            : null,
        },
      };
      continue;
    }
    if (key === CCSESSION_KEY || key.startsWith("tickStatus:")) {
      const v = e.value as Record<string, unknown>;
      const accTokenIn = typeof v.accTokenIn === "number" ? v.accTokenIn
        : typeof v.accIn === "number" ? v.accIn : 0;
      const accTokenCachedIn = typeof v.accTokenCachedIn === "number" ? v.accTokenCachedIn
        : typeof v.accCached === "number" ? v.accCached : 0;
      const accTokenTotalIn = typeof v.accTokenTotalIn === "number" ? v.accTokenTotalIn : 0;
      // v0.8.10-alpha.3 — backfill accTokenHitRate for legacy rows
      // that don't have it persisted. Compute from the parsed raw
      // accumulators so a missing field gets a meaningful value
      // on first read (the next processTick will overwrite with
      // the fresh formula anyway). Zero-denominator → 0.
      // Formula: accTokenCachedIn / accTokenTotalIn * 100
      const accTokenHitRate = typeof v.accTokenHitRate === "number"
        ? v.accTokenHitRate
        : accTokenTotalIn > 0 ? (accTokenCachedIn / accTokenTotalIn) * 100 : 0;
      out[key] = {
        at: e.at,
        kind: "tickStatus",
        value: {
          accTokenIn,
          accTokenOut: typeof v.accTokenOut === "number" ? v.accTokenOut
            : typeof v.accOut === "number" ? v.accOut : 0,
          accTokenCachedIn,
          accTokenTotalIn,
          accApiMs: typeof v.accApiMs === "number" ? v.accApiMs : 0,
          accApiCalls: typeof v.accApiCalls === "number" ? v.accApiCalls
            : typeof v.accApiCount === "number" ? v.accApiCount : 0,
          accTokenHitRate,
        },
      };
    }
  }
  return out;
}

function loadStoreFromPath(path: string, cwd: string): Store | null {
  logFsRead(path, "status-store.loadFromDisk", undefined, cwd);
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    return null;
  }
  return parseStore(raw);
}

function loadFromDiskInternal(cwd: string): Store {
  const cached = _stores.get(cwd);
  if (cached) return cached;
  if (_loaded.has(cwd)) {
    const empty: Store = {};
    _stores.set(cwd, empty);
    return empty;
  }
  _loaded.add(cwd);

  const primaryPath = _pathResolver(cwd);
  let store = loadStoreFromPath(primaryPath, cwd);
  if (store == null) store = {};
  _stores.set(cwd, store);
  return store;
}

function flushToDiskInternal(cwd: string, store: Store): void {
  const path = _pathResolver(cwd);
  const dir = dirname(path);
  logFsMkdir(dir, "status-store.flushToDisk", cwd);
  try {
    mkdirSync(dir, { recursive: true });
  } catch {
    process.stderr.write("topgauge-cc: state mkdir failed; in-memory only\n");
    return;
  }
  const payload = JSON.stringify(store);
  logFsWrite(path, "status-store.flushToDisk", payload.length, cwd);
  try {
    writeFileSync(path, payload);
  } catch {
    process.stderr.write("topgauge-cc: state write failed; in-memory only\n");
    return;
  }
  _stores.set(cwd, store);
}

export function loadFromDisk(cwd: string): Store {
  return loadFromDiskInternal(cwd);
}

export function flushToDisk(cwd: string, store: Store): void {
  flushToDiskInternal(cwd, store);
}

export function emptyTickStatus(): TickStatusValue {
  return {
    accTokenIn: 0,
    accTokenOut: 0,
    accTokenCachedIn: 0,
    accTokenTotalIn: 0,
    accApiMs: 0,
    accApiCalls: 0,
    accTokenHitRate: 0,
  };
}

export function emptyPrevTickStatus(): PrevTickStatusValue {
  return {
    totalApiMs: 0,
    sessionId: null,
    cwd: null,
    model: null,
    // v0.8.15-alpha — null = no prior history; beginTick does NOT
    // substitute when prev is also null (a fresh install or after
    // `clean` naturally surfaces the first tick's stdin value as-is,
    // including a 0 from a malformed probe).
    contextUsedPercent: null,
  };
}

function makeEntry(key: string, value: Entry["value"]): Entry {
  if (key === PREV_TICK_KEY) {
    return { at: Date.now(), kind: "prevTickStatus", value: value as PrevTickStatusValue };
  }
  if (
    key === "lastActive:in" ||
    key === "lastActive:out" ||
    key === "lastActive:apiMs" ||
    key === "lastActive:tokenHitRate"
  ) {
    return { at: Date.now(), kind: "lastActive", value: value as LastActiveValue };
  }
  if (key === CCSESSION_KEY || key.startsWith("tickStatus:")) {
    return { at: Date.now(), kind: "tickStatus", value: value as TickStatusValue };
  }
  throw new Error(
    `status-store: unknown key "${key}" — must be ${PREV_TICK_KEY}, ` +
      `tickStatus:<dim>, ${CCSESSION_KEY}, or lastActive:<in|out|apiMs|tokenHitRate>`,
  );
}

function activeStoreFor(cwd: string | null | undefined): Store | null {
  if (_tickState) {
    if (_tickState.cwd == null) return _tickState.pending;
    if (cwd == null) return _tickState.pending;
    if (_tickState.cwd === cwd) return _tickState.pending;
  }
  if (cwd) return loadFromDiskInternal(cwd);
  return null;
}

export function readTickStatus(
  cwd: string | null | undefined,
  key: string,
): TickStatusValue | null {
  const store = activeStoreFor(cwd);
  if (!store) return null;
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
  const store = cloneStore(loadFromDiskInternal(cwd));
  store[key] = { at: Date.now(), kind: "tickStatus", value };
  // v0.8.10-alpha.2 — also seed the in-memory pending map so
  // a subsequent processTick on this cwd sees the seed without
  // requiring an explicit beginTick + load from disk. The
  // activeStoreFor fallback returns _tickState.pending when
  // _tickState.cwd is null (the test setup convention
  // beginTickForTest(null, null)), so updating pending is
  // the only way to reach the read path even when the active
  // tick's cwd doesn't match this write's cwd.
  if (_tickState) {
    _tickState.pending[key] = { at: Date.now(), kind: "tickStatus", value };
    _tickState.dirty = true;
  }
  flushToDiskInternal(cwd, store);
}

export function readPrevTickStatus(
  cwd: string | null | undefined,
): PrevTickStatusValue | null {
  const store = activeStoreFor(cwd);
  if (!store) return null;
  const e = store[PREV_TICK_KEY];
  if (!e || e.kind !== "prevTickStatus") return null;
  return e.value;
}

export function writePrevTickStatus(
  cwd: string | null | undefined,
  value: PrevTickStatusValue,
): void {
  if (!cwd) return;
  const store = cloneStore(loadFromDiskInternal(cwd));
  store[PREV_TICK_KEY] = { at: Date.now(), kind: "prevTickStatus", value };
  // v0.8.10-alpha.2 — also seed the in-memory pending map so a
  // subsequent beginTickForTest on this cwd sees the seed
  // (beginTick loads from disk into pending, so the on-disk
  // write is the source of truth — but seeding pending as well
  // means a test that fires setPrevTick then beginTickForTest
  // doesn't lose the seed to a "pending was empty" race).
  if (_tickState) {
    _tickState.pending[PREV_TICK_KEY] = {
      at: Date.now(),
      kind: "prevTickStatus",
      value,
    };
    _tickState.dirty = true;
  }
  flushToDiskInternal(cwd, store);
}

export const LAST_ACTIVE_TTL_MS = 60_000;

export function readLastActive(
  cwd: string | null | undefined,
  direction: "in" | "out" | "apiMs" | "tokenHitRate",
): number | null {
  const store = activeStoreFor(cwd);
  if (!store) return null;
  const e = store[`lastActive:${direction}`];
  if (!e || e.kind !== "lastActive") return null;
  return Number.isFinite(e.value.tps) ? e.value.tps : null;
}

export function writeLastActive(
  cwd: string | null | undefined,
  direction: "in" | "out" | "apiMs" | "tokenHitRate",
  tps: number,
): void {
  if (!cwd) return;
  const store = cloneStore(loadFromDiskInternal(cwd));
  store[`lastActive:${direction}`] = {
    at: Date.now(),
    kind: "lastActive",
    value: { direction, tps },
  };
  flushToDiskInternal(cwd, store);
}

// ----- Sample JSONL ownership --------------------------------------------------

export function appendSample(
  cwd: string,
  sessionId: string,
  sample: TokenSample,
): void {
  const path = sampleFilePath(cwd, sessionId);
  const dir = dirname(path);
  logFsMkdir(dir, "status-store.appendSample", cwd);
  try {
    mkdirSync(dir, { recursive: true });
    const payload = JSON.stringify(sample) + "\n";
    logFsWrite(path, "status-store.appendSample", payload.length, cwd);
    appendFileSync(path, payload, "utf8");
  } catch {
    process.stderr.write("topgauge-cc: token-sample append failed\n");
  }
}

function coerceSampleRow(r: Record<string, unknown>, sinceMs: number): TokenSample | null {
  if (
    typeof r.at !== "number" ||
    r.at < sinceMs ||
    typeof r.totalIn !== "number" ||
    typeof r.totalOut !== "number"
  ) {
    return null;
  }
  return {
    at: r.at,
    totalIn: r.totalIn,
    totalOut: r.totalOut,
    in: typeof r.in === "number" ? r.in : 0,
    out: typeof r.out === "number" ? r.out : 0,
    cacheCreation: typeof r.cacheCreation === "number" ? r.cacheCreation : 0,
    cacheIn: typeof r.cacheIn === "number" ? r.cacheIn : 0,
    model: typeof r.model === "string" ? r.model : undefined,
    totalApiMs: typeof r.totalApiMs === "number" ? r.totalApiMs : undefined,
    apiMs: typeof r.apiMs === "number" ? r.apiMs : undefined,
    prevApiMs:
      r.prevApiMs === null
        ? null
        : typeof r.prevApiMs === "number"
          ? r.prevApiMs
          : undefined,
  };
}

export function readSamples(
  cwd: string,
  sessionId: string,
  sinceMs: number,
  modelFilter?: string,
): TokenSample[] {
  const path = sampleFilePath(cwd, sessionId);
  logFsRead(path, "status-store.readSamples", undefined, cwd);
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    return [];
  }
  const out: TokenSample[] = [];
  for (const line of raw.split("\n")) {
    if (!line) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }
    if (!parsed || typeof parsed !== "object") continue;
    const sample = coerceSampleRow(parsed as Record<string, unknown>, sinceMs);
    if (!sample) continue;
    if (modelFilter !== undefined && sample.model !== modelFilter) continue;
    out.push(sample);
  }
  return out;
}

export function readAllSamples(sinceMs: number): TokenSample[] {
  const root = stateRoot();
  const out: TokenSample[] = [];
  logFsList(root, "status-store.readAllSamples");
  let projectDirs: string[];
  try {
    projectDirs = readdirSync(root);
  } catch {
    return [];
  }
  for (const projDir of projectDirs) {
    const projPath = join(root, projDir);
    logFsStat(projPath, "status-store.readAllSamples");
    let st;
    try {
      st = statSync(projPath);
    } catch {
      continue;
    }
    if (!st.isDirectory()) continue;
    logFsList(projPath, "status-store.readAllSamples");
    let sessions: string[];
    try {
      sessions = readdirSync(projPath);
    } catch {
      continue;
    }
    for (const f of sessions) {
      if (!f.endsWith(".jsonl")) continue;
      const path = join(projPath, f);
      if (sinceMs > 0) {
        logFsStat(path, "status-store.readAllSamples");
        let fst;
        try {
          fst = statSync(path);
        } catch {
          continue;
        }
        if (fst.mtimeMs < sinceMs) continue;
      }
      logFsRead(path, "status-store.readAllSamples");
      let raw: string;
      try {
        raw = readFileSync(path, "utf8");
      } catch {
        continue;
      }
      for (const line of raw.split("\n")) {
        if (!line) continue;
        let parsed: unknown;
        try {
          parsed = JSON.parse(line);
        } catch {
          continue;
        }
        if (!parsed || typeof parsed !== "object") continue;
        const sample = coerceSampleRow(parsed as Record<string, unknown>, sinceMs);
        if (!sample) continue;
        out.push(sample);
      }
    }
  }
  return out;
}

// ----- Stat cache ownership ----------------------------------------------------

const _statCacheStore = new Map<string, StatCacheEntry<unknown>>();
let _statCacheLoaded = false;

function loadStatCacheFromDisk(): void {
  if (_statCacheLoaded) return;
  _statCacheLoaded = true;
  const path = _statCachePathResolver();
  logFsRead(path, "status-store.loadStatCache", undefined, null);
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    return;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    process.stderr.write("topgauge-cc: stat cache file is malformed; ignoring\n");
    return;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return;
  for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
    const e = value as { at?: unknown; value?: unknown; ttlMs?: unknown };
    if (typeof e.at !== "number" || !("value" in e)) continue;
    const ttlMs = typeof e.ttlMs === "number" && e.ttlMs > 0 ? e.ttlMs : undefined;
    _statCacheStore.set(key, { at: e.at, value: e.value, ttlMs });
  }
}

function flushStatCacheToDisk(): void {
  const path = _statCachePathResolver();
  const dir = dirname(path);
  logFsMkdir(dir, "status-store.flushStatCache", null);
  try {
    mkdirSync(dir, { recursive: true });
  } catch {
    process.stderr.write("topgauge-cc: stat cache mkdir failed; in-memory only\n");
    return;
  }
  const now = Date.now();
  const obj: Record<string, StatCacheEntry<unknown>> = {};
  for (const [k, v] of _statCacheStore) {
    if (v.ttlMs != null && now - v.at > v.ttlMs) {
      _statCacheStore.delete(k);
      continue;
    }
    obj[k] = v;
  }
  const payload = JSON.stringify(obj);
  logFsWrite(path, "status-store.flushStatCache", payload.length, null);
  try {
    writeFileSync(path, payload);
  } catch {
    process.stderr.write("topgauge-cc: stat cache write failed; in-memory only\n");
  }
}

function getStatCache<T>(key: string, ttlMs: number): T | null {
  loadStatCacheFromDisk();
  const e = _statCacheStore.get(key) as StatCacheEntry<T> | undefined;
  if (!e) return null;
  if (Date.now() - e.at > ttlMs) return null;
  return e.value;
}

function setStatCache<T>(key: string, value: T, ttlMs: number): void {
  loadStatCacheFromDisk();
  _statCacheStore.set(key, { at: Date.now(), value, ttlMs });
  flushStatCacheToDisk();
}

export function __resetStatCacheForTest(): void {
  _statCacheStore.clear();
  _statCacheLoaded = false;
}

function aggregateSamples(samples: TokenSample[]): StatAggregate {
  let sumIn = 0;
  let sumOut = 0;
  let sumCached = 0;
  let sumApiMs = 0;
  let lastAt = 0;
  let calls = 0;
  for (const s of samples) {
    sumIn += s.in;
    sumOut += s.out;
    sumCached += s.cacheIn;
    sumApiMs += s.apiMs ?? 0;
    if ((s.apiMs ?? 0) > 0) calls += 1;
    if (s.at > lastAt) lastAt = s.at;
  }
  return {
    sumIn,
    sumOut,
    sumCached,
    sumTotalIn: sumIn + sumCached,
    sumApiMs,
    rows: samples.length,
    calls,
    lastAt,
    generatedAt: Date.now(),
  };
}

export function getStatAggregate(filter: SumFilter): StatAggregate {
  const key = `stat:${filter.modelFilter ?? "all"}:${filter.windowKey}:${filter.alignActive}`;
  const cached = getStatCache<StatAggregate>(key, STAT_CACHE_TTL_MS);
  if (cached) return cached;
  const samples = readAllSamples(filter.sinceMs);
  const filtered =
    filter.modelFilter === undefined
      ? samples
      : samples.filter((s) => s.model === filter.modelFilter);
  const agg = aggregateSamples(filtered);
  setStatCache(key, agg, STAT_CACHE_TTL_MS);
  return agg;
}

// ----- In-memory tick state ----------------------------------------------------

let _tickState: TickState | null = null;

// v0.8.11-alpha — the prev cursor carries ONLY totalApiMs. Returns
// it (as the baseline for `apiMs = current - baseline`) or null when
// there's no history. The "session" / "ccsession" distinction lives
// entirely on the value side of this comparison: if the time-series
// rolled forward, the difference is the api-call duration; if it
// rolled backward, the cumulative counter restarted (cc restarted)
// and detectRegression flags the tick as a reset. Nothing about
// sessionId identity participates in this math — the numeric
// direction IS the truth.
function resolvePreviousBaseline(
  tokens: TokenSnapshot | null,
  prev: PrevTickStatusValue | null,
): { prevTotalApiMs: number | null } {
  if (!tokens?.sessionId || !prev) {
    return { prevTotalApiMs: null };
  }
  return { prevTotalApiMs: prev.totalApiMs };
}

// v0.8.15-alpha — stdin-side error guard for context_window.used_percentage.
// Observed stdins from error states occasionally surface
// `used_percentage=0` instead of `null`, which the renderer would
// display as a literal "0%". When the prev tick carries a usable
// value (non-null), fall back to it so the line stays consistent.
// Three-state decision matrix:
//   stdin === null      → keep null (real "no data")
//   stdin  > 0          → keep as-is (real percentage)
//   stdin === 0         → error sentinel: substitute prev IF prev is
//                         non-null; otherwise leave the 0 for
//                         transparency (no carry-over to lie about)
// The substitution target is `tokens.contextWindow.contextUsedPercent`,
// since `m_contextUsedPercent` reads stdin's path verbatim — no
// separate propagation through the TickSnapshot / measurement layer.
function applyContextUsedPercentCarryOver(
  tokens: TokenSnapshot,
  prev: PrevTickStatusValue | null,
): void {
  const cw = tokens.contextWindow;
  if (!cw) return;
  const stdinPct = cw.contextUsedPercent;
  if (stdinPct === null || stdinPct === undefined) return;
  if (stdinPct !== 0) return;
  // stdin reports 0 — only substitute when prev has a real prior value.
  if (prev && prev.contextUsedPercent !== null) {
    tokens.contextWindow = {
      ...cw,
      contextUsedPercent: prev.contextUsedPercent,
    };
  }
}

// v0.8.11-alpha — regression detection: current.totalApiMs <
// prev.totalApiMs means the cumulative counter rolled backward
// (cc process restarted). Triggers a ccsession-slot zero reset.
// The check is purely numerical — no identity guard.
function detectRegression(
  tokens: TokenSnapshot | null,
  prev: PrevTickStatusValue | null,
): boolean {
  if (!tokens?.sessionId || !prev) return false;
  const currentTotalApiMs = tokens.cost.totalApiDurationMs;
  if (currentTotalApiMs == null || !Number.isFinite(currentTotalApiMs)) return false;
  // v0.8.15-alpha — stdin-side error guard: when the caller observes
  // `contextUsedPercent===0` AND no carry-over applies (prev null),
  // `currentTotalApiMs` may roll backward as a side effect of the
  // malformed probe rather than a real cc restart. Suppress the
  // regression flag in that case so the ccsession slot doesn't
  // get zeroed on a noisy probe. When carry-over substitutes a
  // non-zero prev value, contextUsedPercent is already != 0 by the
  // time detectRegression runs (normalizeTick applies carry-over
  // first), so the guard naturally does not fire.
  const cw = tokens.contextWindow;
  if (cw && cw.contextUsedPercent === 0) return false;
  return currentTotalApiMs < prev.totalApiMs;
}

function normalizeTick(
  tokens: TokenSnapshot | null,
  prev: PrevTickStatusValue | null,
): { snapshot: CurrentTick | null; measurement: TickSnapshot } {
  if (!tokens || !tokens.sessionId || !tokens.cwd) {
    return { snapshot: null, measurement: EMPTY_TICK };
  }
  // v0.8.15-alpha — stdin-side error guard for context_window.used_percentage.
  // Observed stdins from error states occasionally surface
  // `used_percentage=0` instead of `null`, which the renderer would
  // display as a literal "0%". When the prev tick carries a usable
  // value (non-null, non-zero error sentinel), fall back to it so
  // the line stays consistent. This mutation is in-place against
  // the caller's TokenSnapshot — render reads `tokens.contextWindow.
  // contextUsedPercent` directly off the same reference, so no
  // separate propagation path is needed.
  applyContextUsedPercentCarryOver(tokens, prev);
  const in_ = tokens.current.tokenIn;
  const out_ = tokens.current.tokenOut;
  const totalApiMs = tokens.cost.totalApiDurationMs;
  const totalIn = tokens.totals.tokenTotalIn ?? null;
  const totalOut = tokens.totals.tokenTotalOut ?? null;
  if (
    in_ == null ||
    !Number.isFinite(in_) ||
    out_ == null ||
    !Number.isFinite(out_) ||
    totalApiMs == null ||
    !Number.isFinite(totalApiMs) ||
    totalIn == null ||
    totalOut == null
  ) {
    return { snapshot: null, measurement: EMPTY_TICK };
  }

  const { prevTotalApiMs } = resolvePreviousBaseline(tokens, prev);
  // v0.8.11-alpha — regression detection is purely numerical and
  // independent of sessionId identity: a backward totalApiMs jump
  // always means the cumulative counter restarted (cc restarted),
  // regardless of whose sessionId the prev baseline belonged to.
  const invalidRegression = detectRegression(tokens, prev);
  // apiMs is THE unique cross-tick delta. When prevTotalApiMs is
  // null (no history yet — first tick after install/cache wipe),
  // back-derive apiMs from tokenOut via the legacy v0.4.x formula:
  // apiMs = tokenOut * 1000 / 50 (assumes a 50 t/s fall-back rate so
  // the first tick's speed gates render a real value rather than 0).
  const apiMs = invalidRegression || prevTotalApiMs === null
      ? (out_ * 1000) / 50
      : totalApiMs - prevTotalApiMs;
  const cachedIn = tokens.current.tokenCachedIn ?? 0;
  const hasCachedIn = tokens.current.tokenCachedIn != null;
  // v0.8.10-alpha.2 — validation gate uses session-cumulative totals
  // (user contract pinned to the totals.* fields). The per-turn
  // current.tokenIn / tokenOut are snapshot fields, not gates.
  const valid = totalIn > 0 && totalOut > 0 && apiMs > 0;
  const tokenHitRate =
    totalIn > 0 ? (cachedIn / totalIn) * 100 : null;
  const tokenInSpeed = apiMs > 0 ? (in_ / apiMs) * 1000 : null;
  const tokenOutSpeed = apiMs > 0 ? (out_ / apiMs) * 1000 : null;

  // v0.8.11-alpha — full-snapshot smoke diagnostic at the post-derive
  // point: env-gated (default off), one line per tick carrying every
  // field computed above so a postmortem can confirm accTokenHitRate /
  // accTokenTotalIn pre-compute math at the source rather than chasing
  // it through the read path.
  if (process.env.TOPGAUGE_CC_DIAGNOSTICS_ENABLE === "1") {
    appendDiag(
      "info",
      "smoke-normalizeTick",
      `invalidRegression=${invalidRegression} valid=${valid} totalApiMs=${totalApiMs} apiMs=${apiMs.toFixed(3)} in=${in_} out=${out_} cachedIn=${cachedIn} totalIn=${totalIn} totalOut=${totalOut} tokenHitRate=${tokenHitRate?.toFixed(2) ?? "null"} tokenInSpeed=${tokenInSpeed?.toFixed(2) ?? "null"} tokenOutSpeed=${tokenOutSpeed?.toFixed(2) ?? "null"} sid=${tokens?.sessionId ?? "null"}`,
      Date.now(),
      tokens?.cwd ?? undefined,
      "status-store.normalizeTick",
    );
  }

  const measurement: TickSnapshot = {
    hasMeasurement: valid,
    in: valid ? in_ : 0,
    out: valid ? out_ : 0,
    cachedIn: valid && hasCachedIn ? cachedIn : 0,
    totalIn: totalIn ?? 0,
    totalOut: totalOut ?? 0,
    totalApiMs,
    apiMs: valid ? apiMs : 0,
  };

  return {
    snapshot: {
      sessionId: tokens.sessionId,
      cwd: tokens.cwd,
      modelDisplayName: tokens.modelDisplayName ?? null,
      in: in_,
      out: out_,
      cachedIn,
      hasCachedIn,
      cacheCreation: tokens.current.tokenCacheCreation ?? 0,
      totalIn,
      totalOut,
      totalApiMs,
      apiMs,
      prevTotalApiMs,
      invalidRegression,
      tokenHitRate,
      tokenInSpeed,
      tokenOutSpeed,
    },
    measurement,
  };
}

function validateNormalizedTick(tick: CurrentTick | null): boolean {
  if (!tick) return false;
  // v0.8.10-alpha.2 — session-cumulative totals (per user contract).
  return (tick.totalIn ?? 0) > 0 && (tick.totalOut ?? 0) > 0 && tick.apiMs > 0;
}

export function beginTick(cwd: string | null, tokens: TokenSnapshot | null): TickState {
  const loaded = cwd ? loadFromDiskInternal(cwd) : {};
  const prevEntry = loaded[PREV_TICK_KEY];
  const prev = prevEntry?.kind === "prevTickStatus" ? prevEntry.value : null;
  const { snapshot, measurement } = normalizeTick(tokens, prev);
  _tickState = {
    cwd,
    tokens,
    loaded,
    pending: cloneStore(loaded),
    dirty: false,
    prevTick: prev,
    valid: validateNormalizedTick(snapshot),
    measurement,
    snapshot,
    sample: null,
  };
  return _tickState;
}

export function getState(): TickState {
  if (!_tickState) {
    throw new Error(
      "status-store: getState() called without beginTick() — every render must be wrapped in a tick",
    );
  }
  return _tickState;
}

export function mark(key: string, value: Entry["value"]): void {
  const s = getState();
  s.pending[key] = makeEntry(key, value);
  s.dirty = true;
}

export function commit(): void {
  const s = _tickState;
  if (!s) return;
  if (!s.cwd) return;
  // v0.8.10-alpha.2 — flush on dirty regardless of `valid`. The
  // regression-reset mark (ccsession slot zero) needs to reach disk
  // on the regression tick itself even though the tick is invalid
  // (apiMs = -1). Validation gate now governs sample-row emission
  // only (see processTick — `s.sample` stays null on invalid).
  // v1.0 invariant preserved: at most one full-file rewrite per
  // tick (one or zero).
  if (!s.dirty) return;
  flushToDiskInternal(s.cwd, s.pending);
}

export function resetTickStateForTest(): void {
  _tickState = null;
}

export function beginTickForTest(
  cwd: string | null = null,
  tokens: TokenSnapshot | null = null,
): TickState {
  beginTick(cwd, tokens);
  _tickState!.dirty = false;
  return _tickState!;
}

// ----- Render/query helpers ----------------------------------------------------

// v0.8.10-alpha.2 — peekPrevTick returns just the prev-cursor (the
// one field the next tick subtracts against). Identity match is
// still applied so a stale baseline from a different sessionId is
// masked out.
export type PrevTickSnapshot = {
  totalApiMs: number;
};

export function peekPrevTick(
  sessionId: string,
  cwd?: string | null,
): PrevTickSnapshot | null {
  const prev = readPrevTickStatus(cwd);
  if (!prev) return null;
  if (prev.sessionId !== null && prev.sessionId !== sessionId) return null;
  return { totalApiMs: prev.totalApiMs };
}

export function peekLastSpeed(
  _sessionId: string,
  direction: "in" | "out",
  cwd?: string | null,
): number | null {
  void _sessionId;
  return readLastActive(cwd, direction);
}

export function peekLastApiMs(
  _sessionId: string,
  cwd?: string | null,
): number | null {
  void _sessionId;
  return readLastActive(cwd, "apiMs");
}

export function peekLastTokenHitRate(
  _sessionId: string,
  cwd?: string | null,
): number | null {
  void _sessionId;
  return readLastActive(cwd, "tokenHitRate");
}

export function peekAvg(
  sessionId: string,
  cwd?: string | null,
): AvgSnapshot | null {
  if (!sessionId) return null;
  const v = readTickStatus(cwd, `tickStatus:${sessionId}`);
  if (!v) return null;
  return {
    accTokenIn: v.accTokenIn,
    accTokenOut: v.accTokenOut,
    accApiMs: v.accApiMs,
    accTokenCachedIn: v.accTokenCachedIn,
    accApiCalls: v.accApiCalls,
    accTokenTotalIn: v.accTokenTotalIn,
    accTokenHitRate: v.accTokenHitRate,
  };
}

export function readAccumulator(
  scope: "session" | "project" | "model" | "ccsession",
  args: {
    sessionId?: string | null;
    cwd?: string | null;
    modelDisplayName?: string | null;
  },
): AvgSnapshot | null {
  let key: string | null = null;
  if (scope === "session") {
    if (!args.sessionId) return null;
    key = `tickStatus:${args.sessionId}`;
  } else if (scope === "project") {
    if (!args.cwd) return null;
    key = `tickStatus:${projectHash(args.cwd)}`;
  } else if (scope === "ccsession") {
    key = CCSESSION_KEY;
  } else {
    if (!args.modelDisplayName) return null;
    key = `tickStatus:${args.modelDisplayName}`;
  }
  const v = readTickStatus(args.cwd, key);
  if (!v) return null;
  return {
    accTokenIn: v.accTokenIn,
    accTokenOut: v.accTokenOut,
    accApiMs: v.accApiMs,
    accTokenCachedIn: v.accTokenCachedIn,
    accApiCalls: v.accApiCalls,
    accTokenTotalIn: v.accTokenTotalIn,
    accTokenHitRate: v.accTokenHitRate,
  };
}

// v0.8.10-alpha.2 — render-facing snapshot accessor. Returns the
// current tick's snapshot + the derived apiMs (or EMPTY_TICK when
// no tick is active). Render reads it for speed/apiMs modules and
// pulls per-turn fields straight from here without any
// "delta of two snapshots" math.
export function getDeltaForRender(): TickSnapshot {
  return _tickState?.measurement ?? EMPTY_TICK;
}

// ----- Write-side helpers (compat with old data-processor surface) ------------

export function computeAndCacheTickDeltaPure(
  tokens: TokenSnapshot | null,
): TickSnapshot {
  const prev = _tickState?.prevTick ?? null;
  return normalizeTick(tokens, prev).measurement;
}

// v0.8.10-alpha.2 — setPrevTick now stamps only totalApiMs (the one
// field the next tick subtracts against for `apiMs`). Identity
// (sessionId/cwd/model) is preserved across ticks so peekPrevTick's
// identity-mismatch guard has something to compare against.
export function setPrevTick(
  _sessionId: string,
  snap: PrevTickSnapshot,
  cwd?: string | null,
  identity?: { sessionId?: string | null; cwd?: string | null; model?: string | null; contextUsedPercent?: number | null },
): void {
  void _sessionId;
  if (!cwd) return;
  // v0.8.10-alpha.2 — delegate to writePrevTickStatus so the
  // seed reaches BOTH disk (so the next beginTickForTest's
  // loadFromDiskInternal picks it up) AND the in-memory pending
  // map (so a same-tick setAvg call sees the seed). The earlier
  // mark-only path wrote only to pending, which got clobbered
  // by beginTick's loadFromDiskInternal overwrite.
  const prev = readPrevTickStatus(cwd) ?? emptyPrevTickStatus();
  // v0.8.15-alpha — caller (processTick) stamps the current
  // tick's effective contextUsedPercent into identity. We preserve
  // the prior value when caller omits the field so a future caller
  // that forgets to thread it doesn't accidentally wipe history
  // (a wiped prev.contextUsedPercent would silently disable the
  // carry-over fallback the next tick).
  const nextContextUsedPercent = identity?.contextUsedPercent !== undefined
    ? identity.contextUsedPercent
    : prev.contextUsedPercent;
  writePrevTickStatus(cwd, {
    totalApiMs: snap.totalApiMs,
    sessionId: identity?.sessionId ?? prev.sessionId,
    cwd: identity?.cwd ?? prev.cwd,
    model: identity?.model ?? prev.model,
    contextUsedPercent: nextContextUsedPercent,
  });
}

export function setLastSpeed(
  _sessionId: string,
  direction: "in" | "out",
  tps: number,
  cwd?: string | null,
): void {
  void _sessionId;
  void cwd;
  mark(`lastActive:${direction}`, { direction, tps });
}

export function setLastApiMs(
  _sessionId: string,
  deltaApiMs: number,
  cwd?: string | null,
): void {
  void _sessionId;
  void cwd;
  mark("lastActive:apiMs", { direction: "apiMs", tps: deltaApiMs });
}

export function setLastTokenHitRate(
  _sessionId: string,
  pct: number,
  cwd?: string | null,
): void {
  void _sessionId;
  void cwd;
  mark("lastActive:tokenHitRate", { direction: "tokenHitRate", tps: pct });
}

export function setAvg(
  sessionId: string,
  snap: AvgSnapshot,
  cwd?: string | null,
  extras?: {
    modelDisplayName?: string | null;
    deltaApiCalls?: number;
    currentApiMs?: number;
    deltaTokenIn?: number;
    deltaTokenOut?: number;
    deltaTokenCachedIn?: number;
    deltaApiMs?: number;
    deltaTokenTotalIn?: number;
  },
): void {
  if (!sessionId) return;
  const incrementCalls = extras?.deltaApiCalls ?? 0;
  const deltaTokenIn = extras?.deltaTokenIn ?? 0;
  const deltaTokenOut = extras?.deltaTokenOut ?? 0;
  const deltaTokenCachedIn = extras?.deltaTokenCachedIn ?? 0;
  const deltaApiMs = extras?.deltaApiMs ?? 0;
  const deltaTokenTotalIn = extras?.deltaTokenTotalIn ?? 0;

  const sessionKey = `tickStatus:${sessionId}`;
  const sessionCurrent = readTickStatus(cwd, sessionKey) ?? emptyTickStatus();
  const sessionNext: TickStatusValue = { ...sessionCurrent };
  // v0.8.10-alpha.2 (per user refinement 2026-07-04) —
  // `accTokenTotalIn` is an ACCUMULATE-ADDITIVE accumulator
  // following the same shape as accTokenIn / accTokenOut /
  // accTokenCachedIn:
  //   accTokenTotalIn = accTokenTotalIn + tokenTotalIn
  // The naming convention is `acc<Field>` matching the
  // stdout prefix schema (m_accTokenTotalIn) and the on-disk
  // TickStatusValue field. The "tokenTotalIn" value from
  // stdin IS a per-tick snapshot (NOT cross-tick cumulative),
  // but the ACCUMULATOR aggregates it across ticks for
  // cross-session analytics — that's a deliberate
  // accumulator choice, NOT a semantic confusion with
  // "total_api_duration_ms" which IS truly cross-tick
  // cumulative.
  sessionNext.accTokenIn += snap.accTokenIn;
  sessionNext.accTokenOut += snap.accTokenOut;
  sessionNext.accTokenCachedIn += snap.accTokenCachedIn;
  sessionNext.accApiMs += snap.accApiMs;
  sessionNext.accTokenTotalIn += snap.accTokenTotalIn;
  sessionNext.accApiCalls += snap.accApiCalls;
  // v0.8.10-alpha.3 — recompute accTokenHitRate from the post-add
  // raw accumulators. Persisted to disk on next commit() so the
  // render pipeline can read it straight without recomputing.
  // Formula: accTokenCachedIn / accTokenTotalIn * 100
  sessionNext.accTokenHitRate = sessionNext.accTokenTotalIn > 0
    ? (sessionNext.accTokenCachedIn / sessionNext.accTokenTotalIn) * 100
    : 0;
  mark(sessionKey, sessionNext);

  const bumpDeltaScope = (key: string) => {
    const current = readTickStatus(cwd, key) ?? emptyTickStatus();
    const next: TickStatusValue = { ...current };
    next.accTokenIn += deltaTokenIn;
    next.accTokenOut += deltaTokenOut;
    next.accTokenCachedIn += deltaTokenCachedIn;
    next.accApiMs += deltaApiMs;
    // v0.8.10-alpha.2 — all 4 scopes (session / project /
    // model / ccsession) accumulate `accTokenTotalIn`
    // additively: `+= tokenTotalIn` per tick, identical to
    // accTokenIn / accTokenOut / accTokenCachedIn.
    next.accTokenTotalIn += deltaTokenTotalIn;
    next.accApiCalls += incrementCalls;
    // v0.8.10-alpha.3 — same derived-field recompute as the
    // session slot. After every scope bump, the cached ratio is
    // refreshed so m_accTokenHitRate can read straight.
    // Formula: accTokenCachedIn / accTokenTotalIn * 100
    next.accTokenHitRate = next.accTokenTotalIn > 0
      ? (next.accTokenCachedIn / next.accTokenTotalIn) * 100
      : 0;
    mark(key, next);
  };

  if (cwd && (incrementCalls > 0 || deltaTokenIn || deltaTokenOut || deltaTokenCachedIn || deltaApiMs || deltaTokenTotalIn)) {
    bumpDeltaScope(`tickStatus:${projectHash(cwd)}`);
  }
  if (incrementCalls > 0 || deltaTokenIn || deltaTokenOut || deltaTokenCachedIn || deltaApiMs || deltaTokenTotalIn) {
    bumpDeltaScope(CCSESSION_KEY);
  }
  if (extras?.modelDisplayName && (incrementCalls > 0 || deltaTokenIn || deltaTokenOut || deltaTokenCachedIn || deltaApiMs || deltaTokenTotalIn)) {
    bumpDeltaScope(`tickStatus:${extras.modelDisplayName}`);
  }
}

export function processTick(
  cwd: string | null,
  tokens: TokenSnapshot | null,
): void {
  const s = getState();
  const prevEntry = s.pending[PREV_TICK_KEY];
  const prev = prevEntry?.kind === "prevTickStatus" ? prevEntry.value : null;
  const { snapshot, measurement } = normalizeTick(tokens, prev);
  // v0.8.15-alpha — measurement reflects the freshest normalizeTick
  // result even on invalid ticks. The render path's computeTickDelta
  // reads r.in / r.out here, gated on r.hasMeasurement; surfacing a
  // 0-with-hasMeasurement-false on invalid keeps the line consistent
  // with the prior v1.0 contract (no partial-write visibility to
  // render) rather than carrying the EMPTY_TICK zeros forward.
  s.snapshot = snapshot;
  s.valid = validateNormalizedTick(snapshot);
  s.measurement = measurement;

  // v0.8.10-alpha.2 — regression-reset (ccsession slot zero) and
  // prev-tick baseline update fire BEFORE the validity guard, so
  // they reach disk even on a regression tick (apiMs == -1 → invalid).
  // The commit gate in commit() is no longer gated on `valid`, so
  // `dirty === true` is sufficient to flush `pending`.
  if (process.env.TOPGAUGE_CC_DIAGNOSTICS_ENABLE === "1") {
    appendDiag(
      "info",
      "smoke-ccsession",
      `invalidRegression=${snapshot?.invalidRegression} totalApiMs=${snapshot?.totalApiMs ?? "null"} hasSnapshot=${snapshot != null} sid=${tokens?.sessionId ?? "null"} valid=${s.valid}`,
      Date.now(),
      cwd ?? undefined,
      "status-store.processTick",
    );
  }
  if (snapshot?.invalidRegression) {
    mark(CCSESSION_KEY, emptyTickStatus());
  }

  if (!s.valid || !snapshot || !tokens?.sessionId) {
    s.sample = null;
    return;
  }

  // Stage the prev-cursor. The next tick reads `prev.totalApiMs`
  // to compute `apiMs = current - prev`, and `prev.contextUsedPercent`
  // to substitute a real prior value when stdin mistakenly reports
  // `used_percentage=0` (see applyContextUsedPercentCarryOver).
  // `tokens.contextWindow.contextUsedPercent` is already the
  // post-carry-over value when normalizeTick has run, so reading
  // it here persists the substituted value to disk.
  mark(PREV_TICK_KEY, {
    totalApiMs: snapshot.totalApiMs,
    sessionId: tokens.sessionId,
    cwd,
    model: tokens.modelDisplayName ?? null,
    contextUsedPercent: tokens.contextWindow?.contextUsedPercent ?? null,
  });

  // Accumulators get the current snapshot values straight — no
  // cross-tick subtraction on per-turn fields. `accTokenTotalIn` keeps its
  // own internal last-value semantics (see setAvg) so the user's
  // `m_accTokenIn|field|total` line-template still gets a meaningful
  // delta accumulator.
  // v0.8.10-alpha.3 — accTokenHitRate is pre-computed here (raw
  // accumulators) so the per-session slot READS it directly
  // without recomputation. Stage 4 below refines it on subsequent
  // ticks; this initial value is correct for the very first tick
  // when no prior state exists.
  const initialCachedIn = snapshot.hasCachedIn ? snapshot.cachedIn : 0;
  const initialTokenTotalIn = snapshot.totalIn ?? 0;
  setAvg(tokens.sessionId, {
    accTokenIn: snapshot.in,
    accTokenOut: snapshot.out,
    accApiMs: snapshot.apiMs,
    accTokenCachedIn: initialCachedIn,
    accApiCalls: 1,
    accTokenTotalIn: initialTokenTotalIn,
    accTokenHitRate: initialTokenTotalIn > 0
      ? (initialCachedIn / initialTokenTotalIn) * 100
      : 0,
  }, cwd, {
    modelDisplayName: tokens.modelDisplayName ?? null,
    deltaApiCalls: 1,
    deltaTokenIn: snapshot.in,
    deltaTokenOut: snapshot.out,
    deltaTokenCachedIn: snapshot.hasCachedIn ? snapshot.cachedIn : 0,
    deltaApiMs: snapshot.apiMs,
    deltaTokenTotalIn: snapshot.totalIn ?? 0,
  });

  if (snapshot.tokenInSpeed != null) {
    setLastSpeed(tokens.sessionId, "in", snapshot.tokenInSpeed, cwd);
  }
  if (snapshot.tokenOutSpeed != null) {
    setLastSpeed(tokens.sessionId, "out", snapshot.tokenOutSpeed, cwd);
  }
  setLastApiMs(tokens.sessionId, snapshot.apiMs, cwd);
  if (snapshot.tokenHitRate != null) {
    setLastTokenHitRate(tokens.sessionId, snapshot.tokenHitRate, cwd);
  }

  s.sample =
    snapshot.totalIn != null && snapshot.totalOut != null
      ? {
          at: Date.now(),
          totalIn: snapshot.totalIn,
          totalOut: snapshot.totalOut,
          in: snapshot.in,
          out: snapshot.out,
          cacheCreation: snapshot.cacheCreation,
          cacheIn: snapshot.cachedIn,
          model: snapshot.modelDisplayName ?? undefined,
          totalApiMs: snapshot.totalApiMs,
          apiMs: snapshot.apiMs,
          prevApiMs: snapshot.prevTotalApiMs,
        }
      : null;
}

export function processAndSaveTick(
  cwd: string | null,
  tokens: TokenSnapshot | null,
): ProcessResult {
  beginTick(cwd, tokens);
  processTick(cwd, tokens);
  const s = getState();
  // v0.8.10-alpha.2 — `s.valid` no longer gates flush. Sample-row
  // emission is still gated on `s.valid` (invalid ticks don't have
  // a meaningful row to append).
  const shouldWriteState = !!s.cwd && s.dirty;
  commit();
  let wroteSample = false;
  if (s.valid && s.sample && tokens?.sessionId && cwd) {
    appendSample(cwd, tokens.sessionId, s.sample);
    wroteSample = true;
  }
  return {
    valid: s.valid,
    snapshot: s.snapshot,
    measurement: s.measurement ?? EMPTY_TICK,
    wroteState: shouldWriteState,
    wroteSample,
  };
}

export function resetDataProcessorForTest(): void {
  // no-op compatibility stub; write-side state is entirely module-local now
}

// ----- Test-only resets --------------------------------------------------------

export function __resetForTest(): void {
  _loaded.clear();
  _stores.clear();
  _tickState = null;
}
