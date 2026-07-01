// v0.5.0+ — declarative path resolver for the data-driven provider model.
//
// Each ProviderEntry's `parameters` block maps well-known slots the renderer
// needs (e.g. `remainingPercentInterval`, `endAtWeekly`) onto a path
// expression evaluated against the parsed JSON response. This module is the
// single source of truth for that grammar — adding a new provider is a
// config-only change, no parser code required.
//
// ## Grammar
//
//   path     := segment (('.' segment) | ('[' index ']'))*
//   segment  := [A-Za-z_][A-Za-z0-9_]*      // object key
//   index    := [0-9]+                       // array index
//
// Examples:
//   usages.0.limits.detail.used              // bracket-less form
//   usages[0].limits[0].detail.used          // bracketed form
//   model_remains.0.current_interval_remaining_percent
//   balance_infos                            // the whole array
//
// Two syntactic forms are accepted (and freely mixed) because the
// bracket-less form is the natural way to write "drill into array
// element N" and the bracketed form is the natural way to read
// `obj.prop[N].prop` in code. Both compile to the same internal
// segment list.
//
// ## Type coercion
//
// Slots declare a target type; the resolver applies it after the
// path walk. Permissive on input, strict on output:
//
//   number     — JS numbers and numeric strings ("42", "3.14"). Non-numeric
//                strings, null, booleans, objects reject.
//   epochMs    — same as number, but ISO-8601 strings ("2026-07-07T11:32:40Z")
//                are coerced via Date.parse.
//   boolean    — true/false, 0/1, "true"/"false" (case-insensitive).
//   array      — the whole sub-tree at the path; iteration is the caller's
//                job (per-element slot maps use this).
//
// Missing / null / type-mismatch all resolve to `null`. The plugin never
// throws on a bad path; a malformed config degrades to "no data" rather
// than a crash. The caller is expected to null-check and treat the
// absence as "drop / render placeholder" (matching today's behavior
// for any missing tokenplan field).

export type PathSegment =
  | { kind: "key"; name: string }
  | { kind: "index"; n: number };

export type SlotType = "number" | "epochMs" | "boolean" | "array" | "any";

/** Compile a path expression into a segment list. Throws on syntax errors
 *  so a typo in config.json surfaces at startup, not at every statusline tick. */
export function compilePath(expr: string): PathSegment[] {
  if (typeof expr !== "string" || expr.length === 0) {
    throw new Error(`path expression must be a non-empty string`);
  }
  const out: PathSegment[] = [];
  let i = 0;
  while (i < expr.length) {
    const c = expr[i];
    if (c === ".") {
      i++;
      continue;
    }
    if (c === "[") {
      // [index]
      const close = expr.indexOf("]", i + 1);
      if (close === -1) {
        throw new Error(`path '${expr}': unmatched '[' at offset ${i}`);
      }
      const digits = expr.slice(i + 1, close);
      if (!/^[0-9]+$/.test(digits)) {
        throw new Error(
          `path '${expr}': array index must be a non-negative integer (got '${digits}')`,
        );
      }
      out.push({ kind: "index", n: Number(digits) });
      i = close + 1;
      continue;
    }
    // Bare key — read identifier chars until we hit a delimiter
    const start = i;
    while (i < expr.length) {
      const cc = expr[i];
      if (cc === undefined) break;
      if (cc === "." || cc === "[") break;
      i++;
    }
    const name = expr.slice(start, i);
    if (name.length === 0) {
      throw new Error(`path '${expr}': empty key at offset ${start}`);
    }
    // Bracket-less digit form: a pure-digit token is parsed as an
    // array index (so `usages.0.detail.used` ≡ `usages[0].detail.used`).
    // Mixed alphanumerics (e.g. `m3`, `_42`, `a1b`) remain keys.
    if (/^[0-9]+$/.test(name)) {
      out.push({ kind: "index", n: Number(name) });
      continue;
    }
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
      throw new Error(
        `path '${expr}': invalid key '${name}' (must match [A-Za-z_][A-Za-z0-9_]*)`,
      );
    }
    out.push({ kind: "key", name });
  }
  if (out.length === 0) {
    throw new Error(`path '${expr}': resolved to zero segments`);
  }
  return out;
}

/** Walk a compiled path against a parsed JSON value. Returns the
 *  sub-value at the end of the path, or `null` if any step fails
 *  (missing key, out-of-bounds index, or non-object/non-array
 *  intermediate). */
export function walkPath(root: unknown, segments: readonly PathSegment[]): unknown {
  let cur: unknown = root;
  for (const seg of segments) {
    if (cur == null) return null;
    if (seg.kind === "key") {
      if (typeof cur !== "object") return null;
      cur = (cur as Record<string, unknown>)[seg.name];
    } else {
      if (!Array.isArray(cur)) return null;
      cur = cur[seg.n];
    }
  }
  return cur ?? null;
}

/** Coerce a raw value to the requested slot type. Returns null on
 *  type mismatch. See module header for the full grammar. */
export function coerce(raw: unknown, type: SlotType): unknown {
  if (raw == null) return null;
  switch (type) {
    case "any":
      return raw;
    case "array":
      return Array.isArray(raw) ? raw : null;
    case "boolean":
      return coerceBoolean(raw);
    case "number":
      return coerceNumber(raw);
    case "epochMs":
      return coerceEpochMs(raw);
  }
}

function coerceNumber(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v))) {
    return Number(v);
  }
  return null;
}

function coerceBoolean(v: unknown): boolean | null {
  if (typeof v === "boolean") return v;
  if (v === 0 || v === 1) return v === 1;
  if (typeof v === "string") {
    const lower = v.toLowerCase();
    if (lower === "true") return true;
    if (lower === "false") return false;
  }
  return null;
}

function coerceEpochMs(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string") {
    const trimmed = v.trim();
    if (trimmed === "") return null;
    // Numeric string ("1782302400000") → Number
    if (Number.isFinite(Number(trimmed))) return Number(trimmed);
    // ISO-8601 string ("2026-07-07T11:32:40Z") → Date.parse
    const t = Date.parse(trimmed);
    if (Number.isFinite(t)) return t;
  }
  return null;
}

/** One-shot resolve: compile, walk, coerce. Returns the coerced value
 *  or `null` on any failure (path syntax error, walk failure, type
 *  mismatch). Syntax errors throw (callers should pre-validate at
 *  config load); runtime walks return null. */
export function resolveSlot(
  root: unknown,
  expr: string,
  type: SlotType,
): unknown {
  const segs = compilePath(expr);
  return coerce(walkPath(root, segs), type);
}
