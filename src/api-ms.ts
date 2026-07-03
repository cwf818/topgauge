// v0.8.x — pure helpers for resolving `apiMs` on a TokenSample row.
//
// Extracted from src/index.ts so the policy is unit-testable without
// piping real stdin / spawning statusLine. Decision table:
//
//   prev=null OR prev.apiMs=0  + (totalIn>0 || totalOut>0)  → FALLBACK.
//     No trustworthy baseline. Writing apiMs = totalApiMs (which is
//     session-cumulative) would attribute the entire history to one
//     tick. Use ceil(out / 50) * 1000 instead. Stamp prevApiMs=null.
//     (prev.apiMs=0 is treated as null: a real-zero prev baseline
//     and a missing one are indistinguishable in this decision —
//     both mean "I have no history to subtract against".)
//
//   prev=null OR prev.apiMs=0  + totalIn==0 + totalOut==0   → SKIP.
//     No activity to record.
//
//   prev!=null (apiMs>0) + deltaApiMs > 0            → WRITE apiMs = delta.
//     Real per-tick API advance. Stamp prevApiMs = prev.apiMs.
//
//   prev!=null (apiMs>0) + deltaApiMs == 0 + tokens advanced → WARN.
//     Cost data didn't advance despite token activity. Anomaly.
//
//   prev!=null (apiMs>0) + deltaApiMs == 0 + idle    → SKIP.
//
//   prev!=null (apiMs>0) + deltaApiMs < 0            → SKIP.
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
  // First-tick (no prev baseline, OR a zero-valued prev baseline)
  // — always fallback when there's any token activity, regardless
  // of totalApiMs. We do NOT trust totalApiMs as a per-tick delta
  // because it's session-cumulative and would inflate the first
  // row's apiMs to the entire session total, polluting subsequent
  // deltaApiMs calculations. The `prev.apiMs == 0` case is folded
  // in here because a "real-zero prev" and a "missing prev" are
  // observationally identical for this decision (both mean "no
  // history to subtract against") — see user's 2026-07-03 log:
  //   {"prevApiMs": 0, "apiMs": 13158865, ...}  // whole-session
  //     attributed to one tick because prev.apiMs was 0
  // "No real history" baseline: prev row missing OR its apiMs is 0.
  // Both are observationally identical for the delta decision — see
  // 2026-07-03 user log where a row with prevApiMs=0 caused
  // apiMs=13158865 (the entire session-cumulative) to be written
  // as a per-tick value. A `prev` const + non-null assertion lets
  // TS narrow the rest of the function (mirroring the original
  // `if (inp.prev == null)` shape).
  const prev = inp.prev;
  if (prev == null || prev.apiMs === 0) {
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

  // prev != null AND prev.apiMs > 0 — normal case.
  const deltaApiMs = inp.totalApiMs - prev.apiMs;

  if (deltaApiMs > 0) {
    // v0.8.2 — gate on token activity. The user's "三者都不等于0"
    // contract: a valid apiMs row requires BOTH deltaApiMs>0
    // (real cost advance) AND (totalIn>0 || totalOut>0) (real
    // token activity). When the session-cumulative totals are
    // both zero, the cost advance is suspicious — it can be
    // model loading, infra warm-up, or a stuck-then-flush pattern
    // that produces apiMs>0 without producing user-visible
    // tokens. Writing such a row pollutes sum/avg aggregates the
    // same way the v0.7.4 prev=0 case did. Mirror the
    // prev==null branch's gate here.
    if (inp.totalIn === 0 && inp.totalOut === 0) {
      return { kind: "skip" };
    }
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
        prevApiMs: prev.apiMs,
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