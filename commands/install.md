---
description: Install or uninstall the topgauge-cc (ToPGauge-CC) statusline wrapper into Claude Code's settings.json
argument-hint: "[--uninstall | --restore | --project | --dry-run]"
allowed-tools: ["Bash(${CLAUDE_PLUGIN_ROOT}/scripts/install.sh:*)"]
---

# topgauge-cc :install

The wrapper writes the latest-cache-dir command into `statusLine.command`,
backs up any pre-existing statusLine to `settings.json.bak.<ISO-timestamp>`,
and preserves the original command in `<claude-root>/plugins/topgauge-cc/state/upstream-cmd.sh`
(sibling of `config.json`, stable across `/plugin install` rolls and cache
wipes) so it can be re-invoked as the upstream. Re-running on an
already-managed statusLine is a no-op (`_topgauge_managed: true`).

The script runs locally with no network access and never prints
`ANTHROPIC_AUTH_TOKEN`.

Execute the install script with whatever arguments were passed to this
command:

```!
"${CLAUDE_PLUGIN_ROOT}/scripts/install.sh" $ARGUMENTS
```