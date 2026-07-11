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
//       "TYPE": "Quota",
//       "BASE_URL_COMPARED_TO": "https://example.com",
//       "COMPARE_METHOD": "EXACT",
//       "AUTHENTICATION_KEY": "optional-plugin-key"
//     }
//   }
//
// Contract (plugin ABI):
//   - The plugin is a regular ESM module.
//   - Its **default export** must be `{ fetchAccountCredit(authenticationKey, context) }`.
//   - `authenticationKey` is the configured key or `process.env.ANTHROPIC_AUTH_TOKEN`.
//   - `fetchAccountCredit` returns an object already shaped like the
//     canonical Quota or Balance data — the dispatcher does NOT re-parse.
//
// The plugin is loaded in-process via dynamic `import()` (same
// Node runtime, same ESM loader). Throwing inside `fetchAccountCredit` is
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
   * @param {string} authenticationKey — configured key or env fallback.
   *   This sample ignores it (it returns synthetic data); real plugins
   *   should use it as a bearer token against the upstream API.
   * @returns canonical `Quota` shape.
   */
  async fetchAccountCredit(authenticationKey) {
    return payload();
  },
};
