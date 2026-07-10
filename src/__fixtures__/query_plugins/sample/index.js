// Sample bundled plugin for topgauge-cc.
//
// Drop this script into place to wire it up:
//
//   mkdir -p ~/.claude/plugins/topgauge-cc/query_plugins/sample
//   cp src/__fixtures__/query_plugins/sample/index.js \
//      ~/.claude/plugins/topgauge-cc/query_plugins/sample/index.js
//
// Then add a provider to ~/.claude/plugins/topgauge-cc/config.json:
//
//   "providers": {
//     "sample": {
//       "TYPE": "TOKEN_PLAN",
//       "BASE_URL_COMPARED_TO": "https://example.com",
//       "COMPARE_METHOD": "EXACT",
//       "ENDPOINT": ""
//     }
//   }
//
// Contract (v0.8.46+):
//   - The plugin is a regular ESM module.
//   - Its **default export** must be `{ fetchAccountQuota(token) }`.
//   - `token` is `process.env.ANTHROPIC_AUTH_TOKEN`; whether to
//     honor it is the plugin author's call.
//   - `fetchAccountQuota` returns an object already shaped like the
//     tokenplan.schema (TOKEN_PLAN providers) or balance.schema
//     (BALANCE providers) — the dispatcher does NOT re-parse.
//
// The plugin is loaded in-process via dynamic `import()` (same
// Node runtime, same ESM loader). Throwing inside `fetchAccountQuota` is
// surfaced as a stale-cache fallback by the dispatcher; timing
// out after 5s is a hard error.

const payload = () => {
  const now = Date.now();
  return {
    shortInterval: {
      label: "5h",
      startAt: now,
      endAt: now + 4 * 3600 * 1000,
      intervalMs: 4 * 3600 * 1000,
      remainingPercent: 75,
      usedPercent: 25,
    },
    midInterval: {
      label: "7d",
      startAt: now,
      endAt: now + 7 * 24 * 3600 * 1000,
      intervalMs: 7 * 24 * 3600 * 1000,
      remainingPercent: 50,
      usedPercent: 50,
    },
    longInterval: null,
  };
};

export default {
  /**
   * @param {string} token — process.env.ANTHROPIC_AUTH_TOKEN. Ignored
   *   by this sample (it returns synthetic data); real plugins
   *   should use it as a bearer token against the upstream API.
   * @returns canonical `Remains` shape.
   */
  async fetchAccountQuota(token) {
    return payload();
  },
};
