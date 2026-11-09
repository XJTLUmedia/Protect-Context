# Gemini CLI

Official references, checked while writing this page:

- [MCP servers with Gemini CLI](https://geminicli.com/docs/tools/mcp-server/)
- [Gemini CLI configuration](https://geminicli.com/docs/reference/configuration/) — settings file locations

`uvx` must be on `PATH`. The configuration reference says discovered tools are prefixed with `mcp_` and the server name, and to avoid `_` in that name because the policy parser splits on the first underscore after `mcp_`. `protect-context` uses a hyphen.

## Command

`gemini mcp add` writes `settings.json`. The default scope is `project`:

```bash
gemini mcp add protect-context uvx protect-context mcp
```

`--scope user` writes the user file instead. `--transport` defaults to `stdio`.

## Config file

| Scope | Path |
|---|---|
| User | `~/.gemini/settings.json` |
| Project | `.gemini/settings.json` |

The configuration reference also lists system files. On Linux those are `/etc/gemini-cli/system-defaults.json` (lowest of the four files) and `/etc/gemini-cli/settings.json` (overrides user and project). The [enterprise page](https://geminicli.com/docs/cli/enterprise/) says `mcpServers` objects are merged and the same server name keeps the highest-precedence definition, System over workspace over user. A server defined in the system settings file is not replaced by a user entry of the same name.

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

One of `command`, `url`, or `httpUrl` is required. `trust` defaults to `false`, so tool calls still ask. Leave it false: `guard_verify` runs a shell with your privileges.
