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
//   - Legacy per-project `status.json` is fallback-read when `state.json`
//     does not exist yet.
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
  logFsList,
  logFsMkdir,
  logFsRead,
  logFsStat,
  logFsWrite,
} from "./diagnostics.ts";
import type { TokenSample, TokenSnapshot } from "./types.ts";

// ----- Persisted value families ------------------------------------------------

export type TickStatusValue = {
  accIn: number;
  accOut: number;
  accCached: number;
  accTotalIn: number;
  accApiMs: number;
  accApiCount: number;
};

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
  deltaCacheRead: number;
  deltaTotalIn: number;
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

type NormalizedTick = {
  sessionId: string;
  cwd: string;
  modelDisplayName: string | null;
  tokenIn: number;
  tokenOut: number;
  tokenCachedIn: number;
  hasTokenCachedIn: boolean;
  tokenCacheCreation: number;
  tokenTotalIn: number | null;
  tokenTotalOut: number | null;
  totalApiMs: number;
  apiMs: number;
  prev: PrevTickSnapshot | null;
  prevApiMsForSample: number | null;
  regressionReset: boolean;
  tokenHitRate: number | null;
  tokenInSpeed: number | null;
  tokenOutSpeed: number | null;
  deltaTotalIn: number;
};

export type ProcessResult = {
  valid: boolean;
  normalized: NormalizedTick | null;
  delta: TickDeltaResult;
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
  delta: TickDeltaResult | null;
  normalized: NormalizedTick | null;
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

const NO_DELTA: TickDeltaResult = {
  hasDelta: false,
  deltaIn: 0,
  deltaOut: 0,
  deltaApi: 0,
  deltaCacheRead: 0,
  deltaTotalIn: 0,
  currentTotalIn: null,
  writeBack: null,
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

function legacyStatusFilePath(cwd: string): string {
  return join(stateRoot(), projectHash(cwd), "status.json");
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
      out[key] = {
        at: e.at,
        kind: "prevTickStatus",
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
      };
      continue;
    }
    if (key === CCSESSION_KEY || key.startsWith("tickStatus:")) {
      const v = e.value as Record<string, unknown>;
      out[key] = {
        at: e.at,
        kind: "tickStatus",
        value: {
          accIn: typeof v.accIn === "number" ? v.accIn : 0,
          accOut: typeof v.accOut === "number" ? v.accOut : 0,
          accCached: typeof v.accCached === "number" ? v.accCached : 0,
          accTotalIn: typeof v.accTotalIn === "number" ? v.accTotalIn : 0,
          accApiMs: typeof v.accApiMs === "number" ? v.accApiMs : 0,
          accApiCount: typeof v.accApiCount === "number" ? v.accApiCount : 0,
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

function usingDefaultStatusResolver(): boolean {
  return _pathResolver === statusFilePath;
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
  if (store == null && usingDefaultStatusResolver()) {
    store = loadStoreFromPath(legacyStatusFilePath(cwd), cwd);
  }
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

function resolvePreviousBaseline(
  tokens: TokenSnapshot | null,
  prev: PrevTickStatusValue | null,
): { prev: PrevTickSnapshot | null; regressionReset: boolean; invalidRegression: boolean } {
  if (!tokens?.sessionId || !prev) {
    return { prev: null, regressionReset: false, invalidRegression: false };
  }
  if (prev.sessionId != null && prev.sessionId !== tokens.sessionId) {
    return { prev: null, regressionReset: false, invalidRegression: false };
  }
  const currentTotalApiMs = tokens.cost.totalApiDurationMs;
  if (
    currentTotalApiMs != null &&
    Number.isFinite(currentTotalApiMs) &&
    currentTotalApiMs < prev.totalApiMs
  ) {
    return { prev: null, regressionReset: true, invalidRegression: true };
  }
  return {
    prev: {
      apiMs: prev.totalApiMs,
      in: prev.in,
      out: prev.out,
      cacheRead: prev.cachedIn,
      totalIn: prev.totalIn,
    },
    regressionReset: false,
    invalidRegression: false,
  };
}

function normalizeTick(
  tokens: TokenSnapshot | null,
  prev: PrevTickStatusValue | null,
): { normalized: NormalizedTick | null; delta: TickDeltaResult } {
  if (!tokens || !tokens.sessionId || !tokens.cwd) {
    return { normalized: null, delta: NO_DELTA };
  }
  const tokenIn = tokens.current.tokenIn;
  const tokenOut = tokens.current.tokenOut;
  const totalApiMs = tokens.cost.totalApiDurationMs;
  if (
    tokenIn == null ||
    !Number.isFinite(tokenIn) ||
    tokenOut == null ||
    !Number.isFinite(tokenOut) ||
    totalApiMs == null ||
    !Number.isFinite(totalApiMs)
  ) {
    return { normalized: null, delta: NO_DELTA };
  }

  const { prev: baseline, regressionReset, invalidRegression } = resolvePreviousBaseline(tokens, prev);
  const apiMs = invalidRegression
    ? -1
    : baseline
      ? totalApiMs - baseline.apiMs
      : (tokenOut * 1000) / 50;
  const tokenCachedIn = tokens.current.tokenCachedIn ?? 0;
  const hasTokenCachedIn = tokens.current.tokenCachedIn != null;
  const tokenTotalIn = tokens.totals.tokenTotalIn ?? null;
  const tokenTotalOut = tokens.totals.tokenTotalOut ?? null;
  const deltaTotalIn =
    tokenTotalIn != null ? Math.max(0, tokenTotalIn - (baseline?.totalIn ?? 0)) : 0;
  const tokenHitRate =
    tokenTotalIn != null && tokenTotalIn > 0
      ? (tokenCachedIn / tokenTotalIn) * 100
      : null;
  const tokenInSpeed = apiMs > 0 ? (tokenIn / apiMs) * 1000 : null;
  const tokenOutSpeed = apiMs > 0 ? (tokenOut / apiMs) * 1000 : null;

  const writeBack: PrevTickSnapshot = {
    apiMs: totalApiMs,
    in: tokenIn,
    out: tokenOut,
    cacheRead: tokenCachedIn,
    totalIn: tokenTotalIn ?? 0,
  };

  const valid = tokenIn > 0 && tokenOut > 0 && apiMs > 0;
  const delta: TickDeltaResult = {
    hasDelta: valid,
    deltaIn: valid ? tokenIn : 0,
    deltaOut: valid ? tokenOut : 0,
    deltaApi: valid ? apiMs : 0,
    deltaCacheRead: valid && hasTokenCachedIn ? tokenCachedIn : 0,
    deltaTotalIn: valid ? deltaTotalIn : 0,
    currentTotalIn: tokenTotalIn,
    writeBack,
  };

  return {
    normalized: {
      sessionId: tokens.sessionId,
      cwd: tokens.cwd,
      modelDisplayName: tokens.modelDisplayName ?? null,
      tokenIn,
      tokenOut,
      tokenCachedIn,
      hasTokenCachedIn,
      tokenCacheCreation: tokens.current.tokenCacheCreation ?? 0,
      tokenTotalIn,
      tokenTotalOut,
      totalApiMs,
      apiMs,
      prev: baseline,
      prevApiMsForSample: baseline ? baseline.apiMs : null,
      regressionReset,
      tokenHitRate,
      tokenInSpeed,
      tokenOutSpeed,
      deltaTotalIn,
    },
    delta,
  };
}

function validateNormalizedTick(tick: NormalizedTick | null): boolean {
  if (!tick) return false;
  return tick.tokenIn > 0 && tick.tokenOut > 0 && tick.apiMs > 0;
}

export function validateTickForDataProcessor(
  tokens: TokenSnapshot | null,
  prev: PrevTickStatusValue | null,
): boolean {
  return validateNormalizedTick(normalizeTick(tokens, prev).normalized);
}

export function beginTick(cwd: string | null, tokens: TokenSnapshot | null): TickState {
  const loaded = cwd ? loadFromDiskInternal(cwd) : {};
  const prevEntry = loaded[PREV_TICK_KEY];
  const prev = prevEntry?.kind === "prevTickStatus" ? prevEntry.value : null;
  const { normalized, delta } = normalizeTick(tokens, prev);
  _tickState = {
    cwd,
    tokens,
    loaded,
    pending: cloneStore(loaded),
    dirty: false,
    prevTick: prev,
    valid: validateNormalizedTick(normalized),
    delta,
    normalized,
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
  if (!s.valid || !s.dirty) return;
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

export function peekPrevTick(
  sessionId: string,
  cwd?: string | null,
): PrevTickSnapshot | null {
  const prev = readPrevTickStatus(cwd);
  if (!prev) return null;
  if (prev.sessionId !== null && prev.sessionId !== sessionId) return null;
  return {
    apiMs: prev.totalApiMs,
    in: prev.in,
    out: prev.out,
    cacheRead: prev.cachedIn,
    totalIn: prev.totalIn,
  };
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
    accIn: v.accIn,
    accOut: v.accOut,
    accApi: v.accApiMs,
    accCached: v.accCached,
    accApiCount: v.accApiCount,
    accTotalIn: v.accTotalIn,
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
    accIn: v.accIn,
    accOut: v.accOut,
    accApi: v.accApiMs,
    accCached: v.accCached,
    accApiCount: v.accApiCount,
    accTotalIn: v.accTotalIn,
  };
}

export function getDeltaForRender(): TickDeltaResult {
  return _tickState?.delta ?? NO_DELTA;
}

// ----- Write-side helpers (compat with old data-processor surface) ------------

export function computeAndCacheTickDeltaPure(
  tokens: TokenSnapshot | null,
): TickDeltaResult {
  const prev = _tickState?.prevTick ?? null;
  return normalizeTick(tokens, prev).delta;
}

export function setPrevTick(
  _sessionId: string,
  snap: PrevTickSnapshot,
  cwd?: string | null,
  identity?: { sessionId?: string | null; cwd?: string | null; model?: string | null },
): void {
  void _sessionId;
  void cwd;
  const prev = readPrevTickStatus(_tickState?.cwd ?? null) ?? emptyPrevTickStatus();
  mark(PREV_TICK_KEY, {
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
    deltaApiCount?: number;
    currentApiMs?: number;
    deltaIn?: number;
    deltaOut?: number;
    deltaCache?: number;
    deltaApiMs?: number;
    deltaTotalIn?: number;
  },
): void {
  if (!sessionId) return;
  const incrementCount = extras?.deltaApiCount ?? 0;
  const deltaIn = extras?.deltaIn ?? 0;
  const deltaOut = extras?.deltaOut ?? 0;
  const deltaCache = extras?.deltaCache ?? 0;
  const deltaApiMs = extras?.deltaApiMs ?? 0;
  const deltaTotalIn = extras?.deltaTotalIn ?? 0;

  const sessionKey = `tickStatus:${sessionId}`;
  const sessionCurrent = readTickStatus(cwd, sessionKey) ?? emptyTickStatus();
  const sessionNext: TickStatusValue = { ...sessionCurrent };
  sessionNext.accIn += snap.accIn;
  sessionNext.accOut += snap.accOut;
  sessionNext.accCached += snap.accCached;
  sessionNext.accApiMs += snap.accApi;
  sessionNext.accTotalIn += snap.accTotalIn;
  sessionNext.accApiCount += snap.accApiCount;
  mark(sessionKey, sessionNext);

  const bumpDeltaScope = (key: string) => {
    const current = readTickStatus(cwd, key) ?? emptyTickStatus();
    const next: TickStatusValue = { ...current };
    next.accIn += deltaIn;
    next.accOut += deltaOut;
    next.accCached += deltaCache;
    next.accApiMs += deltaApiMs;
    next.accTotalIn += deltaTotalIn;
    next.accApiCount += incrementCount;
    mark(key, next);
  };

  if (cwd && (incrementCount > 0 || deltaIn || deltaOut || deltaCache || deltaApiMs || deltaTotalIn)) {
    bumpDeltaScope(`tickStatus:${projectHash(cwd)}`);
  }
  if (incrementCount > 0 || deltaIn || deltaOut || deltaCache || deltaApiMs || deltaTotalIn) {
    bumpDeltaScope(CCSESSION_KEY);
  }
  if (extras?.modelDisplayName && (incrementCount > 0 || deltaIn || deltaOut || deltaCache || deltaApiMs || deltaTotalIn)) {
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
  const { normalized, delta } = normalizeTick(tokens, prev);
  s.normalized = normalized;
  s.valid = validateNormalizedTick(normalized);
  s.delta = delta;

  if (!s.valid || !normalized || !tokens?.sessionId) {
    s.sample = null;
    return;
  }

  if (normalized.regressionReset) {
    mark(CCSESSION_KEY, emptyTickStatus());
  }

  setPrevTick(tokens.sessionId, {
    apiMs: normalized.totalApiMs,
    in: normalized.tokenIn,
    out: normalized.tokenOut,
    cacheRead: normalized.tokenCachedIn,
    totalIn: normalized.tokenTotalIn ?? 0,
  }, cwd, {
    sessionId: tokens.sessionId,
    cwd,
    model: tokens.modelDisplayName ?? null,
  });

  setAvg(tokens.sessionId, {
    accIn: normalized.tokenIn,
    accOut: normalized.tokenOut,
    accApi: normalized.apiMs,
    accCached: normalized.hasTokenCachedIn ? normalized.tokenCachedIn : 0,
    accApiCount: 1,
    accTotalIn: normalized.deltaTotalIn,
  }, cwd, {
    modelDisplayName: tokens.modelDisplayName ?? null,
    deltaApiCount: 1,
    deltaIn: normalized.tokenIn,
    deltaOut: normalized.tokenOut,
    deltaCache: normalized.hasTokenCachedIn ? normalized.tokenCachedIn : 0,
    deltaApiMs: normalized.apiMs,
    deltaTotalIn: normalized.deltaTotalIn,
  });

  if (normalized.tokenInSpeed != null) {
    setLastSpeed(tokens.sessionId, "in", normalized.tokenInSpeed, cwd);
  }
  if (normalized.tokenOutSpeed != null) {
    setLastSpeed(tokens.sessionId, "out", normalized.tokenOutSpeed, cwd);
  }
  setLastApiMs(tokens.sessionId, normalized.apiMs, cwd);
  if (normalized.tokenHitRate != null) {
    setLastTokenHitRate(tokens.sessionId, normalized.tokenHitRate, cwd);
  }

  s.sample =
    normalized.tokenTotalIn != null && normalized.tokenTotalOut != null
      ? {
          at: Date.now(),
          totalIn: normalized.tokenTotalIn,
          totalOut: normalized.tokenTotalOut,
          in: normalized.tokenIn,
          out: normalized.tokenOut,
          cacheCreation: normalized.tokenCacheCreation,
          cacheIn: normalized.tokenCachedIn,
          model: normalized.modelDisplayName ?? undefined,
          totalApiMs: normalized.totalApiMs,
          apiMs: normalized.apiMs,
          prevApiMs: normalized.prevApiMsForSample,
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
  const shouldWriteState = !!s.cwd && s.valid && s.dirty;
  commit();
  let wroteSample = false;
  if (s.valid && s.sample && tokens?.sessionId && cwd) {
    appendSample(cwd, tokens.sessionId, s.sample);
    wroteSample = true;
  }
  return {
    valid: s.valid,
    normalized: s.normalized,
    delta: s.delta ?? NO_DELTA,
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
