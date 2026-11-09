# pi coding agent

Official reference, checked while writing this page: [MCP servers](https://pi.dev/docs/latest/mcp).

This is the host MCP client. The protect-context **extension** (`pi install npm:protect-context`) is separate: it injects the brief and the widget inside pi and does not need this file. Add the MCP server when you want the same tools from pi’s MCP client, including in a project that does not load the extension.

`uvx` must be on `PATH`.

## Command

User-level servers are the default (`~/.pi/agent/mcp.json`, or `$PI_CODING_AGENT_DIR/mcp.json` when that variable is set):

```bash
pi mcp add protect-context -- uvx protect-context mcp
```

`--local` or `-l` writes the project file instead. Project servers load only after the project is trusted, and a project entry replaces a user entry with the same name. Run `/reload` after editing a server from outside the session. `pi mcp list` shows whether it connected.

## Config file

| Scope | Path |
|---|---|
| All projects | `~/.pi/agent/mcp.json` |
| This trusted project | `.pi/mcp.json` |

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

`command` is one executable and `args` are its arguments; pi does not run this through a shell. `type` is optional: a `command` selects stdio. Server names may contain letters, digits, `_`, and `-`. Pi replaces every other character in that name with `_` when it builds tool names, and the docs' tool-filter example is `mcp__radius__*`. Names that differ only by `-` and `_` are the same server.

The repo root [`.mcp.json`](../../.mcp.json) is the file pi-mcp-adapter reads. Pi’s built-in client reads `.pi/mcp.json`, not `.mcp.json`.

`guard_verify` runs a shell with your privileges.
