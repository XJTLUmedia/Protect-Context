# Claude Code

Official reference, checked while writing this page: [Connect Claude Code to tools via MCP](https://code.claude.com/docs/en/mcp).

`uvx` must be on `PATH`.

## Command

Local scope is the default. It writes this project’s server into `~/.claude.json` and does not commit it:

```bash
claude mcp add protect-context -- uvx protect-context mcp
```

Everything after `--` is the server command. Check the connection with `claude mcp get protect-context`.

## Config files

| Scope | Stored in | Shared |
|---|---|---|
| Local (default) | `~/.claude.json`, under this project’s path | no |
| User | `~/.claude.json` | no, all of your projects |
| Project | `.mcp.json` at the project root | yes, if you commit it |

Project scope:

```bash
claude mcp add protect-context --scope project -- uvx protect-context mcp
```

Or put the same entry in `.mcp.json` yourself. Claude Code reads an entry with no `type` as stdio, which is what this server is:

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

The equivalent `claude mcp add-json` call, from the same docs, is:

```bash
claude mcp add-json protect-context '{"command":"uvx","args":["protect-context","mcp"]}'
```

Add `--scope project` or `--scope user` to choose the file. A project `.mcp.json` server still needs the project’s approval step before Claude Code connects.

`guard_verify` runs a shell with your privileges. Do not auto-approve it for an untrusted session.
