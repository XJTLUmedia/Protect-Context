# Windsurf

Windsurf’s Cascade MCP page now lives on the Devin docs. Official references, checked while writing this page:

- [Windsurf Cascade MCP](https://docs.devin.ai/windsurf/plugins/cascade/mcp) — legacy Cascade
- [Configuration file](https://docs.devin.ai/cli/reference/configuration/config-file) — Devin Local / CLI since v3000.3

`uvx` must be on `PATH`. Which file you edit depends on which agent the tab is using.

## Legacy Cascade

Cascade’s **Open MCP config file** action opens the Cortex-managed file:

| OS | Path |
|---|---|
| macOS and Linux | `~/.config/devin/mcp_config.json`, or `$XDG_CONFIG_HOME/devin/mcp_config.json` when `XDG_CONFIG_HOME` is set |
| Windows | `%APPDATA%/devin/mcp_config.json` |

The editor’s own discovery file is separate: `~/.codeium/windsurf/mcp_config.json` (Next builds: `~/.codeium/windsurf-next/mcp_config.json`). The Cascade page says that file is used only when `chat.mcp.discovery.enabled` includes the `windsurf` source. It is not the file the Cascade action opens.

## Devin Local and the Devin CLI

Since v3000.3 (Local 3.6), MCP servers live in dedicated files. Older builds stored an `mcpServers` key in the main config; current builds migrate that key on startup.

| Scope | Path |
|---|---|
| All projects | `~/.config/devin/mcp_config.json` (`%APPDATA%\devin\mcp_config.json` on Windows) |
| This project, committed | `.devin/mcp_config.json` |
| This project, local | `.devin/mcp_config.local.json` |

## Snippet

Both of those docs use `mcpServers` with `command` and `args` for a local stdio server:

```json
{
  "mcpServers": {
    "protect-context": {
      "command": "uvx",
      "args": ["protect-context", "mcp"]
    }
  }
}
```

`guard_verify` runs a shell with your privileges. Do not treat Cascade approval as a sandbox.
