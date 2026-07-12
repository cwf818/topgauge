# How to create a plugin

> Wire up **any** provider endpoint — kimi, moonshot, z.ai, a private gateway, etc. — without forking the plugin. This page covers the **user-plugin** model introduced in v0.9.0: a single ESM file dropped into a stable directory silently overrides the built-in plugin chain.

---

## Table of contents

1. [When you need one](#1-when-you-need-one)
2. [The 60-second path](#2-the-60-second-path)
3. [Plugin ABI contract](#3-plugin-abi-contract)
4. [Authoring recipes by provider type](#4-authoring-recipes-by-provider-type)
5. [Registration in `config.json`](#5-registration-in-configjson)
6. [Returned shape — `Partial<Quota>` / `Partial<Balance>`](#6-returned-shape--partialquota--partialbalance)
7. [Error semantics — soft-fail vs hard-fail](#7-error-semantics--soft-fail-vs-hard-fail)
8. [Override resolution order](#8-override-resolution-order)
9. [Testing the plugin standalone](#9-testing-the-plugin-standalone)
10. [Debugging checklist](#10-debugging-checklist)

---

## 1. When you need one

The plugin ships two built-ins — `minimax` (Quota) and `deepseek` (Balance).
You write a plugin when:

- Your provider isn't one of the bundled two (kimi, moonshot, z.ai, GLM, a private gateway, …).
- A bundled provider has changed its upstream and you want a quick patch without waiting for an official release.
- You want to ship a same-id replacement for `minimax` / `deepseek` (e.g. a forked parser); the override is silent.

You do **NOT** need a plugin to:

- Style your statusline — that's `lineTemplates` in `config.json`. See [MANUAL.md](./MANUAL.md).
- Hide the plugin on unsupported providers — it auto-hides when `ANTHROPIC_BASE_URL` doesn't match any registered entry.
- Add a new display module — that's a plugin-side feature, see [CHANGELOG.md](./CHANGELOG.md) for the existing 50+ modules.

---

## 2. The 60-second path

Three commands. Copy-paste-able for kimi:

```bash
# 1. Create the plugin directory (stable across cache rolls).
mkdir -p ~/.claude/plugins/topgauge/query_plugins/kimi

# 2. Drop your plugin file. Both .js and .mjs work; .js is conventional.
cat > ~/.claude/plugins/topgauge/query_plugins/kimi/index.js <<'EOF'
const ENDPOINT = "https://your.provider.example/api/quota";
export default {
  async fetchAccountCredit(authenticationKey, ctx) {
    if (!authenticationKey) return null;
    const r = await fetch(ENDPOINT, {
      headers: { Authorization: `Bearer ${authenticationKey}` },
      signal: ctx?.signal,
    });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const raw = JSON.parse(await r.text());
    return {
      shortInterval: {
        remainingPercent: raw.percent,
        // startAt / endAt optional — renderer's window-fill-aware
        // reset arrow gets its direction from these when present.
        startAt: raw.resetStartMs,
        endAt: raw.resetAtMs,
      },
      midInterval: null,
      longInterval: null,
    };
  },
};
EOF

# 3. Register the provider in config.json. Re-use the same dir name
#    for the provider id (provider name maps 1:1 to the directory).
#    See Section 5 for the full schema.
```

The plugin takes effect on the **next statusline tick** (no `/reload-plugins`
needed — the host calls `cache.peek` instead of caching the override side).

---

## 3. Plugin ABI contract

Your file is loaded as **plain ESM** via Node's dynamic `import()`. The
host reads exactly one symbol from your module: the **default export**.

### Required shape

```ts
export default {
  fetchAccountCredit: (
    authenticationKey: string,      // your entry.AUTHENTICATION_KEY, OR process.env.ANTHROPIC_AUTH_TOKEN
    ctx: {
      providerId: string,             // your registered id, e.g. "kimi"
      type: "QUOTA" | "BALANCE",      // mirrors your config block's TYPE
      currencies: CurrenciesConfig,   // the effective currencies config (BALANCE providers)
      signal?: AbortSignal,           // host's per-tick timeout — MUST forward on fetch
    },
  ) => unknown | Promise<unknown>     // Partial<Quota> | Partial<Balance> | null | throws
};
```

### Mandatory file location

| Selector | Path |
|---|---|
| `<id>.js`   | `~/.claude/plugins/topgauge/query_plugins/<id>/index.js` |
| `<id>.mjs`  | `~/.claude/plugins/topgauge/query_plugins/<id>/index.mjs` |

- `<id>` is the **provider name** registered in `config.json`'s `providers` block. It must match `^[A-Za-z0-9_-]+$` (no `/`, `\\`, `:`, spaces, or control chars).
- `.js` is conventional; `.mjs` is supported for users who'd rather skip the `package.json` inference check.
- The directory is the **stable** one (`plugins/topgauge/query_plugins/`) — it survives `/plugin install` cache rolls and cache wipes. Don't put your plugin under `plugins/cache/topgauge/...`; that gets wiped on every install.

### What the host does with your return value

The host runs the appropriate normalizer:

- `type === "QUOTA"`   → `ensureQuota(yourValue)` → canonical `Quota`
- `type === "BALANCE"` → `ensureBalance(yourValue)` → canonical `Balance`

Your job ends at producing a structurally-shaped object (or `null`). You
don't need to import or understand the canonical types — the host fills
in defaults. See [§6](#6-returned-shape--partialquota--partialbalance) for the exact field names.

### What the host does if your file is missing

If neither `query_plugins/<id>/index.js` nor `index.mjs` exists, the host falls through to:

1. The **built-in** plugin (`dist/plugins/<id>/index.js`) — only `minimax` or `deepseek`.
2. Otherwise: a "missing plugin" failure. The host writes `cache.json[<id>:pluginSource] = "missing"` (so `m_pluginSource` renders ❗) and the renderer drops the quota / balance block on the statusline.

---

## 4. Authoring recipes by provider type

### 4a. Token-plan / quota provider → `type: "QUOTA"`

Returned shape is a `Partial<Quota>`. Three independent interval slots:
`shortInterval`, `midInterval`, `longInterval`. Each can be `null` when
you have no data for that slot.

```js
// Reference: built-in src/plugins/minimax/index.js
const ENDPOINT = "https://www.minimaxi.com/v1/token_plan/remains";

export default {
  async fetchAccountCredit(authenticationKey, ctx) {
    if (!authenticationKey) return null;
    const response = await fetch(ENDPOINT, {
      signal: ctx?.signal,
      headers: {
        Authorization: `Bearer ${authenticationKey}`,
        Accept: "application/json",
      },
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const raw = JSON.parse(await response.text());
    return {
      shortInterval: {
        remainingPercent: raw.pct,
        startAt: raw.startMs,
        endAt: raw.endMs,
      },
      midInterval: null,
      longInterval: null,
    };
  },
};
```

### 4b. Account-balance provider → `type: "BALANCE"`

Returned shape is a `Partial<Balance>`. One `entries` array of currencies.

```js
// Reference: built-in src/plugins/deepseek/index.js
const ENDPOINT = "https://api.deepseek.com/user/balance";

export default {
  async fetchAccountCredit(authenticationKey, ctx) {
    if (!authenticationKey) return null;
    const response = await fetch(ENDPOINT, {
      signal: ctx?.signal,
      headers: { Authorization: `Bearer ${authenticationKey}` },
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const raw = JSON.parse(await response.text());
    return {
      isAvailable: raw.available ?? true,
      entries: (raw.balance_infos ?? []).map((b) => ({
        currency: b.currency,
        totalBalance: Number(b.balance),
        label: b.currency,
      })),
      minValue: raw.min_value ?? null,
    };
  },
};
```

---

## 5. Registration in `config.json`

The provider id (`<id>`) is the directory name; the host looks up the
config block by the same id. Edit `~/.claude/plugins/topgauge/config.json`:

```jsonc
{
  "providers": {
    "kimi": {
      "TYPE": "QUOTA",
      "BASE_URL_COMPARED_TO": "https://api.kimi.com/coding/",
      "COMPARE_METHOD": "INCLUDE",
      "AUTHENTICATION_KEY": "<paste your access_token here>"
    }
  }
}
```

| Field                  | Required | Notes |
|------------------------|----------|-------|
| `TYPE`                 | yes      | `"QUOTA"` (token-plan windows) or `"BALANCE"` (account balance) |
| `BASE_URL_COMPARED_TO` | yes      | Match target for `ANTHROPIC_BASE_URL`. See `COMPARE_METHOD`. |
| `COMPARE_METHOD`       | no       | `"EXACT"` (default) · `"INCLUDE"` (substring) · `"STARTWITH"` (prefix with `/`, `?`, `#` boundary guard) |
| `ENDPOINT`             | no       | URL your plugin hits. Your plugin reads `ENDPOINT` from its own constant — this config field is for the host's URL-matching only, not for the plugin. |
| `AUTHENTICATION_KEY`   | no       | Sent to your plugin as the first arg. Falls back to `process.env.ANTHROPIC_AUTH_TOKEN`. **Never logged / echoed / persisted by the host.** |

Plugin authors sometimes find that the `ENDPOINT` config field is a
footgun — it lures people into believing the host reads it. The host
does **not** call your endpoint directly. Your plugin reads the URL
from its own module-level constant.

---

## 6. Returned shape — `Partial<Quota>` / `Partial<Balance>`

### Quota

```ts
type Interval = {
  windowId:    string | null;       // matches one of DEFAULT_WINDOW_IDS (5h / 7d / 30d)
  label:       string | null;       // free-form, overrides m_windowQuota's  "(5h)" suffix
  startAt:     number | null;       // epoch-ms (Date.now()-compatible)
  endAt:       number | null;
  intervalMs:  number | null;       // optional — host derives from endAt-startAt when both present
  remainingPercent: number | null;  // 0..100
  usedPercent:      number | null;  // 0..100; required for the bar to fill
  remainingQuota:   number | null;  // absolute units
  usedQuota:        number | null;
  limitQuota:       number | null;
};

type Quota = {
  shortInterval: Interval | null;
  midInterval:   Interval | null;
  longInterval:  Interval | null;
};
```

Rules (enforced by `ensureQuota` in `src/plugins/parsers.ts`):

- `usedPercent` is the renderer-facing truth (the bar fills by used%, not by remaining%). If you have `remainingPercent` and a limit, the normalizer derives `usedPercent = 100 − remainingPercent`.
- `startAt` + `endAt` + `intervalMs` need **at least 2 of 3** non-null; the third is derived. If only 1 is present (e.g. `endAt` only), the host collapses the entire time group to nulls and the renderer falls back to its interval-less placeholder. See `ensureTimeGroup` in `src/plugins/parsers.ts:166`.
- `null` for an interval slot means "I have no data for this window" — the renderer's per-term placeholder handles it.

### Balance

```ts
type BalanceEntry = {
  currency:    string;        // ISO 4217 ("USD", "CNY"), or free-form
  totalBalance: number;       // balance value in `currency`
  label:        string;       // short prefix shown in the line (e.g. "$", "￥")
};

type Balance = {
  isAvailable: boolean;
  entries:     BalanceEntry[];   // joined by " · " in the renderer
  minValue:    number | null;    // high-water mark for color banding
};
```

---

## 7. Error semantics — soft-fail vs hard-fail

| Signal                                          | What happens at the host                                                                                  |
|-------------------------------------------------|-----------------------------------------------------------------------------------------------------------|
| Return `null`                                   | **Soft fail.** Host walks the cache; if a recent value exists, renders it stale-gated. No diagnostic row. |
| Throw inside `fetchAccountCredit`               | **Hard fail.** Host writes `diagnostics.jsonl` (warning row prefixed with `user plugin <path>` vs `built-in plugin <path>`). Stale cache takes over on the next render. |
| Return invalid object (not `Partial<Quota>`)    | `ensureQuota` returns `null` — same as soft fail path.                                                    |
| Network fetch throws                            | Same as throwing — the framework forwards the error.                                                       |
| `fetchAccountCredit` not present on default     | `user plugin <path>: default export must be { fetchAccountCredit(authenticationKey, context?) }` warning. |
| File missing entirely                           | Falls through to built-in (or `missing` for unknown ids); see [§8](#8-override-resolution-order).         |

**Rule of thumb**: `null` = "no data this tick, fall back". `throw` = "something broke, log it, fall back, and surface to the user".

The plugin receives `ctx.signal` — the host's per-tick `AbortSignal`. Always forward it on `fetch`. A user-initiated uninstall / a tick that's already past the renderer budget needs the abort to actually win the race; otherwise a hung plugin can stall the statusline.

---

## 8. Override resolution order

For a provider id `<id>`, the host looks in this order:

```
~/.claude/plugins/topgauge/query_plugins/<id>/index.js   ← user override (silently wins)
~/.claude/plugins/topgauge/query_plugins/<id>/index.mjs  ← user override (mjs form)
dist/plugins/<id>/index.js (or src/plugins/<id>/index.js during dev)  ← built-in (only for `minimax` / `deepseek` ids)
```

The resolution side is stashed in `cache.json` under `<id>:pluginSource` so the `m_pluginSource` module can render 📌 (built-in) / 🎨 (user) / ❗ (missing). The renderer reads via `cache.peek` which **ignores TTL** — adding or removing an override file reflects on the next tick even before the data cache row expires.

**Putting a file at `<dist>/plugins/<id>/` won't work** — that's the bundle output, regenerated on every `npm run build`. The user path is `~/.claude/plugins/topgauge/query_plugins/<id>/` (sibling of `state/` and `config.json`).

---

## 9. Testing the plugin standalone

A user plugin imports cleanly as a normal ESM module — no testing harness needed. Drop into `node` and call it:

```bash
# Quick smoke: pipe stdin, see the rendered line.
echo '{}' \
  | ANTHROPIC_BASE_URL=https://api.kimi.com/coding/ \
    ANTHROPIC_AUTH_TOKEN="$(jq -r '.providers.kimi.AUTHENTICATION_KEY' \
      ~/.claude/plugins/topgauge/config.json)" \
    node /path/to/cache/topgauge/topgauge/0.9.1/dist/index.js
```

For unit-level testing of the fill function only:

```js
// Load the plugin file directly (not through the host loader)
import * as plugin from "./query_plugins/kimi/index.js";
const sample = JSON.parse(readFileSync("./fixture.json", "utf8"));
console.log(plugin.fillQuota(sample));
```

The kimi plugin's `[fillQuota, shortInterval, midInterval, longInterval, findCodingUsage]` exports give you all the surface area you'd want to pin. See `src/plugins/kimi.test.ts` for a complete example using the captured-real fixture `src/__fixtures__/quota.real.kimi.json`.

---

## 10. Debugging checklist

| Symptom                                              | Likely cause                                                                  |
|------------------------------------------------------|-------------------------------------------------------------------------------|
| Plugin is ignored; `m_pluginSource` shows 📌 not 🎨  | Wrong provider id — directory name must match the config.json key byte-for-byte. |
| Plugin is ignored; `m_pluginSource` shows ❗           | File isn't actually a valid ESM module — check `~/.claude/plugins/topgauge/state/diagnostics.jsonl` for the load error (60-second dedupe window). |
| Hard-fail warnings every tick                        | Plugin throws on every invocation. Read the `user plugin` prefix in the JSONL row to see WHICH file the host loaded. |
| Network errors but token is correct                  | Plugin forgot to forward `ctx.signal` — Abort timeout fired before the response. |
| Numbers render as `n/a` or `0`                       | Plugin returned `null` (soft-fail) — check `if (!authenticationKey) return null` isn't gating when the key IS present. |
| Built-in prints instead of override                  | Resolution is silently preferring the built-in. Verify the file is at the user path (`~/.claude/plugins/topgauge/query_plugins/<id>/`), not the cache dist dir. |

To enable the diagnostics log:

```bash
export TOPGAUGE_DIAGNOSTICS_ENABLE=1
# Re-trigger a tick; tail the log:
tail -f ~/.claude/plugins/topgauge/state/<projectHash>/diagnostics.jsonl
```

Diagnostic rows are deduplicated within a 60-second window — a sustained error won't flood the file. The `cwd` field on each row tells you which project session it belongs to.

---

## Reference appendix

### Bundle layout reminder

```
~/.claude/plugins/topgauge/
├── config.json                    # ← your providers.<id> block goes here
├── query_plugins/                 # ← user-side override directory
│   ├── kimi/
│   │   └── index.js
│   ├── moonshot/
│   │   └── index.mjs
│   └── <your-id>/
│       └── index.{js,mjs}
└── state/
    └── <projectHash>/
        ├── cache.json
        ├── diagnostics.jsonl
        └── <sessionId>.jsonl
```

### Source pointers

- `src/api.ts` — the host loader (`pluginTransportWithKind`, `fetchForProviderByIdWithKind`, `resolvePluginOnDiskWithKind`). 11 KB.
- `src/plugins/data.ts` — the `Quota`, `Balance`, `Interval`, `AccountCreditPlugin`, `PluginContext` types.
- `src/plugins/parsers.ts` — `ensureQuota` / `ensureBalance` / `ensureInterval` / `ensureTimeGroup` (the rules from §6).
- `src/plugins/minimax/index.js` and `src/plugins/deepseek/index.js` — the two working built-ins. Copy-paste to start a new plugin.
- `src/__fixtures__/query_plugins/sample/index.js` — a fully-commented no-op sample plugin. Drop it into the user path and it'll load against any provider id.
- `src/__fixtures__/quota.real.kimi.json` — captured real-shape reference for the kimi API.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
