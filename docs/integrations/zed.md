# Zed

Official references, checked while writing this page:

- [Model Context Protocol](https://zed.dev/docs/ai/mcp) — `context_servers`, not `mcpServers`
- [Remote development](https://zed.dev/docs/remote-development) — settings file paths
- [Migrate from VS Code](https://zed.dev/docs/migrate/vs-code) — project settings

`uvx` must be on `PATH`.

## Config file

Open the user settings JSON with the command palette action `zed: open settings file`. Paths named by the remote-development page:

| OS | User settings |
|---|---|
| macOS | `~/.zed/settings.json` |
| Linux | `~/.config/zed/settings.json` |

Project overrides go in `.zed/settings.json` at the project root. This page does not guess the Windows path; use `zed: open settings file` there.

Zed’s key is `context_servers`. A local server is `command`, `args`, and optional `env`:

```json
{
  "context_servers": {
    "protect-context": {
      "command": "uvx",
      "args": ["protect-context", "mcp"],
      "env": {}
    }
  }
}
```

Settings → AI → MCP Servers shows a green dot when the server is active. The MCP page says a remote server with no `Authorization` header starts Zed’s OAuth flow; this stdio entry does not use that path.

`guard_verify` runs a shell with your privileges. Zed’s tool approval still applies.
