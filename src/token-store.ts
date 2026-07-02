// v0.4.0+ — token-sample state file.
//
// Each statusline tick appends one JSON line to
// `<claude-root>/plugins/topgauge-cc/state/<projectHash>/<sessionId>.jsonl`
// (one per project, NOT in a `token-samples/` subdir — see Per-Project Layout below).
// m_token5h / m_token7d read this file (filtered to the window) on every
// render. m_tokenIn / m_tokenOut / m_ctx / m_cacheRead / m_cacheHitRate /
// m_tokenInSpeed / m_tokenOutSpeed do NOT read this file — they read the
// live stdin snapshot directly, which is cheaper and always fresh.
//
// File format (one JSON object per line, append-only):
//   {"at":1782576199672,"session":"b2bee62...","in":163479,"out":155,
//    "ctx_in":38,"ctx_creation":0,"ctx_read":163441}
//
// Size: ~120B per row → 1h ≈ 4.3KB → 7d ≈ 700KB. Far below any IO budget
// concern. We never compact the file — older samples drop out of queries
// naturally when they're older than the largest window (7d).
//
// Why per-session file (D-name1): separate sessions shouldn't share or
// compete for the same append stream. Different projects may run
// concurrently; keeping each session in its own file avoids interleaving
// and lets future cleanup (e.g. `:clean`) target a specific session.
//
// Per-Project Layout (v0.4.x+): all runtime state files
// (cache.json, diagnostics.jsonl, sample jsonl) live under
// `state/<projectHash>/` so that multiple Claude Code instances
// running against different projects never share a write stream.
// `state/upstream-cmd.{sh,txt}` and `state/config.json` stay at
// the top level — they're managed by install/uninstall, not by
// per-tick IO.
//
// Upgrading from a v0.4.0–v0.4.<n-1> install that still has
// `state/token-samples/<hash>/<sid>.jsonl` files: run
// `bash scripts/migrate-state.sh` once to move them to the new
// location. The plugin does NOT auto-migrate on tick — see
// CHANGELOG for the rationale (avoids extra IO on every tick; old
// samples are time-decaying and most users can re-accumulate).

import { appendFileSync, mkdirSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import type { TokenSample } from "./types.ts";

// Root of all token-plan plugin state files. Sibling of `upstream-cmd.sh`
// and `config.json` — survives cache rolls and version bumps. (See
// scripts/install.sh for the layout reasoning.)
function defaultStateRoot(): string {
  const home = process.env.HOME ?? process.env.USERPROFILE ?? "";
  const claudeRoot = process.env.CLAUDE_CONFIG_DIR ?? join(home, ".claude");
  return join(claudeRoot, "plugins", "topgauge-cc", "state");
}

// v0.8.0+ — test isolation hook. Tests that touch the on-disk jsonl
// (sum/avg cross-project scanners, setStateRoot-style fixtures)
// point this at a tmp dir so the user's real state is never
// touched. Production code leaves it on `defaultStateRoot` and
// the env-driven resolution applies.
let _stateRoot: () => string = defaultStateRoot;
export function stateRoot(): string {
  return _stateRoot();
}
export function setStateRoot(fn: () => string): void {
  _stateRoot = fn;
}
export function resetStateRoot(): void {
  _stateRoot = defaultStateRoot;
}

// Project hash for the cwd — keeps one project's sessions isolated from
// another's. D-name1: separate subdir per projectDir. Lowercased + with
// path separators AND whitespace/control characters replaced by `-`.
// The whitespace+control pass matters because JSON.parse decodes \t, \n,
// \r as their literal control bytes — without scrubbing, those bytes end
// up in the directory name and Windows mkdir rejects them with ENOENT.
// Length cap so we don't construct arbitrarily deep paths on weird
// Windows-style `cwd`s.
export function projectHash(cwd: string): string {
  return cwd
    .replace(/[\\/:]/g, "-")
    .replace(/[\s\x00-\x1f\x7f]/g, "-")
    .toLowerCase()
    .slice(0, 80);
}

// Build the absolute path for a session's append-only JSONL.
// v0.4.x+ per-project layout: directly under state/<projectHash>/,
// no `token-samples/` intermediate dir.
export function sampleFilePath(cwd: string, sessionId: string): string {
  return join(stateRoot(), projectHash(cwd), `${sessionId}.jsonl`);
}

// Append one sample row. Atomic at the OS level for small writes
// (<= PIPE_BUF, which on Linux is 4096B — well above our ~120B row).
// Creates the directory tree on demand. Errors are swallowed (stderr
// only) so the statusline never blocks on disk failures — if the sample
// can't be written, the next tick still renders correctly off stdin.
//
// v6.x — `session` and `cwd` are NOT carried on the row: the path
// already encodes `<projectHash>/<sessionId>.jsonl`. The optional
// `model` / `apiMs` are stamped at the call site only when
// totalApiDurationMs>0 (idle ticks don't add a row).
export function appendSample(
  cwd: string,
  sessionId: string,
  sample: TokenSample,
): void {
  const path = sampleFilePath(cwd, sessionId);
  try {
    mkdirSync(dirname(path), { recursive: true });
    appendFileSync(path, JSON.stringify(sample) + "\n", "utf8");
  } catch {
    process.stderr.write("topgauge-cc: token-sample append failed\n");
  }
}

// Read all samples for a session, in-memory filtered by `sinceMs`. Used
// by m_token5h/m_token7d to compute window-scoped totals. Returns [] on
// any error (file missing, malformed JSON, etc.) — the renderer falls
// back to "—" rather than throwing.
//
// The 7d upper bound caps the in-memory working set: a busy session
// produces ~700KB of JSONL over 7 days, which fits comfortably in
// memory and is bounded by the window itself. We do NOT rewrite the
// file to evict — when the file exceeds ~1MB, compaction can be a
// future `:clean` action; not in scope for v0.4.0.
//
// v0.8.0+ — `modelFilter` narrows rows to one model. Older rows
// without a stamped `model` are EXCLUDED when filter !== undefined
// (we can't make a model claim for a row we didn't stamp). Pass
// `undefined` / omit for the legacy "all models" scan.
export function readSamples(
  cwd: string,
  sessionId: string,
  sinceMs: number,
  modelFilter?: string,
): TokenSample[] {
  const path = sampleFilePath(cwd, sessionId);
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    return [];
  }
  const out: TokenSample[] = [];
  // split('\n') tolerates a trailing newline. We skip empty lines
  // (which can occur if a previous append was interrupted mid-line —
  // unlikely on POSIX but possible on Windows file locks).
  for (const line of raw.split("\n")) {
    if (!line) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }
    if (!parsed || typeof parsed !== "object") continue;
    const r = parsed as Record<string, unknown>;
    if (
      typeof r.at !== "number" ||
      r.at < sinceMs ||
      typeof r.totalIn !== "number" ||
      typeof r.totalOut !== "number"
    ) {
      // v0.8.0+ — rows missing the renamed `totalIn`/`totalOut`
      // fields (v0.4.x–v0.7.x legacy schema) are skipped. We do
      // NOT migrate legacy fields here — the user direction is
      // "don't carry compat in dev", so v0.8.0 reads new-schema
      // rows only. A legacy row is silently dropped from the
      // sum/avg aggregate; the next tick writes the new schema
      // and the same jsonl file regains full coverage.
      continue;
    }
    const rowModel = typeof r.model === "string" ? r.model : undefined;
    if (modelFilter !== undefined && rowModel !== modelFilter) continue;
    out.push({
      at: r.at,
      totalIn: r.totalIn,
      totalOut: r.totalOut,
      in: typeof r.in === "number" ? r.in : 0,
      out: typeof r.out === "number" ? r.out : 0,
      cacheCreation: typeof r.cacheCreation === "number" ? r.cacheCreation : 0,
      cacheIn: typeof r.cacheIn === "number" ? r.cacheIn : 0,
      // v6.x — older v0.4.x rows also had `session` / `cwd` here;
      // they're ignored (the path encodes them). `model` / `totalApiMs` /
      // `apiMs` are optional; missing → undefined.
      model: rowModel,
      totalApiMs: typeof r.totalApiMs === "number" ? r.totalApiMs : undefined,
      apiMs: typeof r.apiMs === "number" ? r.apiMs : undefined,
    });
  }
  return out;
}

// v0.8.0+ — cross-project jsonl scanner. Walks every
// state/<projectHash>/<sessionId>.jsonl under the configured state
// root, concatenating per-row `TokenSample`s from each session.
// Powers the m_sum* / m_avg* advanced statistics modules that need
// visibility across projects (the `:scope`/window without `:cwd`
// gate). The caller applies the sinceMs / modelFilter post-hoc so
// the same scanner can serve any window / model combination.
//
// Performance: the per-project walk is O(projs * sessions) for the
// stat; the per-row scan is O(rows-in-window). Sum-of-cost is
// bounded by the 7d upper bound + the per-row scan within. We do
// NOT pre-cache the result; the caller (the sum/avg module family)
// keys the result through cache.ts with TTL=300s.
export function readAllSamples(sinceMs: number): TokenSample[] {
  const root = stateRoot();
  const out: TokenSample[] = [];
  let projectDirs: string[];
  try {
    projectDirs = readdirSync(root);
  } catch {
    return [];
  }
  for (const projDir of projectDirs) {
    const projPath = join(root, projDir);
    let st;
    try {
      st = statSync(projPath);
    } catch {
      continue;
    }
    if (!st.isDirectory()) continue;
    let sessions: string[];
    try {
      sessions = readdirSync(projPath);
    } catch {
      continue;
    }
    for (const f of sessions) {
      if (!f.endsWith(".jsonl")) continue;
      const path = join(projPath, f);
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
        const r = parsed as Record<string, unknown>;
        if (
          typeof r.at !== "number" ||
          r.at < sinceMs ||
          typeof r.totalIn !== "number" ||
          typeof r.totalOut !== "number"
        ) {
          // v0.8.0+ — see comment in readSamples above. Legacy
          // rows missing the renamed fields are skipped.
          continue;
        }
        out.push({
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
        });
      }
    }
  }
  return out;
}