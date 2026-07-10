// Sample bundled plugin for topgauge-cc.
//
// Drop this script into a sibling location to wire it up:
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
// The plugin loader (src/api.ts:pluginTransport) runs this script via
// `node <path>` and treats stdout as the response body. Anything
// written to stderr is discarded. Exit code 0 is success; non-zero
// triggers a diagnostics warning + the standard stale-cache fallback.
//
// This fixture prints a synthetic parseRemains-shaped JSON so users
// can verify the wiring end-to-end without needing a real API.

'use strict';

// Use the safe JSON.stringify form below to avoid printing literal
// NaN / undefined that strict JSON parsers reject.
const payload = JSON.stringify({
  base_resp: { status_code: 0, status_msg: "sample fixture" },
  model_remains: [
    {
      model_name: "sample",
      current_interval_remaining_percent: 75,
      current_weekly_remaining_percent: 50,
      start_time: Date.now(),
      end_time: Date.now() + 4 * 3600 * 1000,
      weekly_start_time: Date.now(),
      weekly_end_time: Date.now() + 7 * 24 * 3600 * 1000,
    },
  ],
});

process.stdout.write(payload);
