// v0.8.x — pure helpers for resolving `apiMs` on a TokenSample row.
//
// Extracted from src/index.ts so the policy is unit-testable without
// piping real stdin / spawning statusLine. Decision table:
//
//   prev=null + (totalIn>0 || totalOut>0)  → FALLBACK.
//     No trustworthy baseline. Writing apiMs = totalApiMs (which is
//     session-cumulative) would attribute the entire history to one
//     tick. Use ceil(out / 50) * 1000 instead. Stamp prevApiMs=null.
//
//   prev=null + totalIn==0 + totalOut==0   → SKIP.
//     No activity to record.
//
//   prev!=null + deltaApiMs > 0            → WRITE apiMs = delta.
//     Real per-tick API advance. Stamp prevApiMs = prev.apiMs.
//
//   prev!=null + deltaApiMs == 0 + tokens advanced → WARN.
//     Cost data didn't advance despite token activity. Anomaly.
//
//   prev!=null + deltaApiMs == 0 + idle    → SKIP.
//
//   prev!=null + deltaApiMs < 0            → SKIP.
//     Clock skew or upstream bug. Never write a negative apiMs.

import type { TokenSample } from "./types.ts";

export type ApiMsDecision =
  | { kind: "write"; sample: TokenSample }
  | { kind: "skip" }
  | { kind: "warn"; message: string };

export type CurrentUsageLite = {
  input: number | null;
  output: number | null;
  cacheRead: number | null;
  cacheCreation: number | null;
};

export type ApiMsInputs = {
  at: number;
  totalIn: number;
  totalOut: number;
  current: CurrentUsageLite;
  modelDisplayName?: string | null;
  totalApiMs: number;
  prev: { apiMs: number } | null;
  sessionId?: string;
};

export function resolveApiMsSample(inp: ApiMsInputs): ApiMsDecision {
  // First-tick (no prev baseline) — always fallback when there's
  // any token activity, regardless of totalApiMs. We do NOT trust
  // totalApiMs as a per-tick delta because it's session-cumulative
  // and would inflate the first row's apiMs to the entire session
  // total, polluting subsequent deltaApiMs calculations.
  if (inp.prev == null) {
    const out = inp.current.output ?? 0;
    const totalInGt = inp.totalIn > 0;
    const totalOutGt = inp.totalOut > 0;
    if (!totalInGt && !totalOutGt) {
      return { kind: "skip" };
    }
    const fallbackMs = Math.ceil(out / 50) * 1000;
    return {
      kind: "write",
      sample: {
        at: inp.at,
        totalIn: inp.totalIn,
        totalOut: inp.totalOut,
        in: inp.current.input ?? 0,
        out,
        cacheCreation: inp.current.cacheCreation ?? 0,
        cacheIn: inp.current.cacheRead ?? 0,
        model: inp.modelDisplayName ?? undefined,
        totalApiMs: inp.totalApiMs,
        apiMs: fallbackMs,
        prevApiMs: null,
      },
    };
  }

  // prev != null — normal case.
  const deltaApiMs = inp.totalApiMs - inp.prev.apiMs;

  if (deltaApiMs > 0) {
    return {
      kind: "write",
      sample: {
        at: inp.at,
        totalIn: inp.totalIn,
        totalOut: inp.totalOut,
        in: inp.current.input ?? 0,
        out: inp.current.output ?? 0,
        cacheCreation: inp.current.cacheCreation ?? 0,
        cacheIn: inp.current.cacheRead ?? 0,
        model: inp.modelDisplayName ?? undefined,
        totalApiMs: inp.totalApiMs,
        apiMs: deltaApiMs,
        prevApiMs: inp.prev.apiMs,
      },
    };
  }

  if (deltaApiMs === 0) {
    // Anomaly check: did tokens advance even though cost didn't?
    const cur = inp.current;
    const tokenActivity =
      (cur.input ?? 0) > 0 ||
      (cur.output ?? 0) > 0 ||
      (cur.cacheRead ?? 0) > 0 ||
      (cur.cacheCreation ?? 0) > 0;
    if (tokenActivity) {
      const warnMsg =
        `deltaApiMs=0 with token activity: sid=${inp.sessionId ?? "?"} ` +
        `totalIn=${inp.totalIn} totalOut=${inp.totalOut} ` +
        `in=${cur.input ?? 0} out=${cur.output ?? 0} ` +
        `cacheRead=${cur.cacheRead ?? 0} cacheCreation=${cur.cacheCreation ?? 0} ` +
        `totalApiMs=${inp.totalApiMs}`;
      return { kind: "warn", message: warnMsg };
    }
    return { kind: "skip" };
  }

  // deltaApiMs < 0: clock skew or upstream bug — skip silently
  // (writing a negative apiMs would corrupt sums).
  return { kind: "skip" };
}