# Continue

Official reference, checked while writing this page: [How to set up MCP in Continue](https://docs.continue.dev/customize/deep-dives/mcp).

Continue’s docs say MCP can only be used in agent mode. `uvx` must be on `PATH`.

## Workspace block file

The quick start creates `.continue/mcpServers/<name>.yaml` and requires `name`, `version`, and `schema` on a standalone block. The stdio transport example on the same page sets `type: stdio` plus `command` and `args`.

`.continue/mcpServers/protect-context.yaml`:

```yaml
name: protect-context
version: 0.0.1
schema: v1
mcpServers:
  - name: protect-context
    type: stdio
    command: uvx
    args:
      - protect-context
      - mcp
```

`version` here is the block file’s own metadata, not the protect-context package version.

## JSON from another client

The same page says a Claude, Cursor, or Cline JSON file can be copied into `.continue/mcpServers/` and is picked up. Their example path is `.continue/mcpServers/mcp.json`:

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

You can also add the same `mcpServers` list (the YAML list, not the JSON object) to the Continue config file that already holds your models. The deep dive shows that list inside the config and does not give a second path for it; the workspace file above is the path the quick start names.

`guard_verify` runs a shell with your privileges.
