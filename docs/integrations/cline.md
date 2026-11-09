# Cline

Official references, checked while writing this page:

- [MCP](https://docs.cline.bot/mcp/mcp-overview)
- [Config](https://docs.cline.bot/getting-started/config)

`uvx` must be on `PATH`.

## Config file

Global MCP settings for the CLI, IDE extensions, and SDK are `~/.cline/data/settings/cline_mcp_settings.json`. Override that path with `CLINE_MCP_SETTINGS_PATH`.

In the IDE extension, the same docs say to open it from the panel instead of guessing a `globalStorage` path: Cline panel → MCP Servers icon → Configure tab → **Configure MCP Servers**. That opens the JSON the extension is using. Add the entry under `mcpServers`.

```json
{
  "mcpServers": {
    "protect-context": {
      "command": "uvx",
      "args": ["protect-context", "mcp"],
      "disabled": false,
      "autoApprove": []
    }
  }
}
```

`autoApprove` is left empty on purpose. `guard_verify` runs a shell with your privileges, so it should stay on the approval list. `disabled: false` matches the local stdio example in the MCP overview. Omit `type` for stdio; the overview uses `type` for remote HTTP/SSE servers, and omitting it on a remote URL selects the legacy SSE transport.

The CLI reads this file too. `cline config mcp` prints the MCP configuration.
