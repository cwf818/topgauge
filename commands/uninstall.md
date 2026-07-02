---
description: Uninstall topgauge-cc (ToPGauge-CC), restore settings.json, and wipe the plugin's cache, marketplace, and loader rows
argument-hint: "[--project | --dry-run]"
allowed-tools: ["Bash(${CLAUDE_PLUGIN_ROOT}/scripts/uninstall.sh:*)"]
---

# topgauge-cc :uninstall

Restores the original `statusLine.command` from the stable
`plugins/topgauge-cc/state/upstream-cmd.txt` (sibling of
`config.json`) if available, otherwise falls back to the most recent
pre-managed `settings.json.bak.<ts>`. Strips `topgauge-cc@topgauge-cc`
from `enabledPlugins` and `extraKnownMarketplaces`, wipes
`cache/topgauge-cc/`, the marketplace dir, the stable
`plugins/topgauge-cc/state/` dir, and the plugin's row from
`installed_plugins.json` and `known_marketplaces.json`. Backs up
`settings.json` and the two JSON files with `.<name>.bak.<timestamp>`
before any destructive change. Runs `scripts/clean.sh` as its final step
to trim old backups (keeps only the most recent per file; user-named
backups like `settings.json.bak-pre-v0.1.8` are not touched). Idempotent
— re-running on a clean system prints "nothing to do" and exits 0.

The `env` block of `settings.json` is never touched (your
`ANTHROPIC_AUTH_TOKEN` and other env vars are preserved).

v0.7.0 — this script also recognizes the LEGACY plugin name
(`tokenplan-usage-hud`) for uninstall: cache dir, marketplace dir,
enabledPlugins key, and extraKnownMarketplaces key. Users upgrading
from a pre-rename install can still uninstall cleanly without first
running any migration. Kept for at least one release.

Execute the uninstall script with whatever arguments were passed to this
command:

```!
"${CLAUDE_PLUGIN_ROOT}/scripts/uninstall.sh" $ARGUMENTS
```

After uninstall, re-install with:

```
/plugin marketplace add cwf818/topgauge-cc
/plugin install topgauge-cc@topgauge-cc
/reload-plugins
/topgauge-cc:install
```