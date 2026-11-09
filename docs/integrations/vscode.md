# VS Code (Copilot agent mode)

Official references, checked while writing this page:

- [MCP configuration reference](https://code.visualstudio.com/docs/agents/reference/mcp-configuration)
- [MCP developer guide](https://code.visualstudio.com/api/extension-guides/ai/mcp) — install URLs

`uvx` must be on `PATH`. Copilot agent mode reads the portable format directly. VS Code can also forward servers from its own `mcp.json`, except entries that need interactive `${input:...}` prompts.

## Portable format (what the agent reads)

| Scope | Path | Top-level key |
|---|---|---|
| This workspace | `.mcp.json` | `mcpServers` |
| Your user | `$COPILOT_HOME/mcp-config.json`, or `~/.copilot/mcp-config.json` when `COPILOT_HOME` is unset | `mcpServers` |

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

This matches the local Playwright example in the configuration reference (`command` and `args`, no `type` field).

## VS Code format (editor file)

| Scope | Path | Top-level key |
|---|---|---|
| This workspace | `.vscode/mcp.json` | `servers` |
| User profile | the file opened by **MCP: Open User Configuration** | `servers` |

The agent does not read `.vscode/mcp.json` itself. VS Code forwards eligible servers from it. In this format `type` is required:

```json
{
  "servers": {
    "protect-context": {
      "type": "stdio",
      "command": "uvx",
      "args": ["protect-context", "mcp"]
    }
  }
}
```

Command line, which writes the user-profile VS Code file rather than the portable Copilot file:

```bash
code --add-mcp '{"name":"protect-context","type":"stdio","command":"uvx","args":["protect-context","mcp"]}'
```

## Install badges

The configuration reference’s developer guide documents `vscode:mcp/install?` plus a URL-encoded JSON object, and the shareable wrapper `https://vscode.dev/redirect?url=<url-encoded-vscode-URL>`. Insiders uses the `vscode-insiders:` scheme.

The README badges use the live `name` and `config` redirect, which responds with that same install URL. Checked with `curl -I` while writing this page:

- VS Code: `https://vscode.dev/redirect/mcp/install?name=protect-context&config=<url-encoded {"command":"uvx","args":["protect-context","mcp"]}>` returns `302` to `vscode:mcp/install?...` with the name added to the JSON.
- VS Code Insiders: the same path on `https://insiders.vscode.dev` returns `302` to `vscode:` unless the link also has `&quality=insiders`. With that parameter the `Location` is `vscode-insiders:mcp/install?...`.

`guard_verify` runs a shell with your privileges. Approve that tool when the agent asks.
