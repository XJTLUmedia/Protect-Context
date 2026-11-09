# Cursor

Official references, checked while writing this page:

- [MCP](https://cursor.com/docs/mcp) — `mcp.json` locations and the stdio `command` / `args` shape
- [MCP install links](https://cursor.com/docs/mcp/install-links) — `cursor://anysphere.cursor-deeplink/mcp/install?name=$NAME&config=$BASE64_ENCODED_CONFIG`

`uvx` must be on `PATH` (`uv` from [Astral](https://docs.astral.sh/uv/)).

## One click

The install link carries the base64 of `{"command":"uvx","args":["protect-context","mcp"]}` (compact JSON, no spaces). GitHub does not keep a `cursor://` href, so the README badge uses the HTTPS page with the same `name` and `config` parameters:

[Add protect-context to Cursor](https://cursor.com/en/install-mcp?name=protect-context&config=eyJjb21tYW5kIjoidXZ4IiwiYXJncyI6WyJwcm90ZWN0LWNvbnRleHQiLCJtY3AiXX0%3D)

The `cursor://` form of that same config is:

```text
cursor://anysphere.cursor-deeplink/mcp/install?name=protect-context&config=eyJjb21tYW5kIjoidXZ4IiwiYXJncyI6WyJwcm90ZWN0LWNvbnRleHQiLCJtY3AiXX0=
```

Cursor asks before installing. The badge does not start the server by itself.

## Config file

| Scope | Path |
|---|---|
| Project | `.cursor/mcp.json` |
| All projects | `~/.cursor/mcp.json` |

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

The [stdio field table](https://cursor.com/docs/mcp) lists `type` as `"stdio"`. The copy-paste examples on that same page omit `type` and use `command` plus `args`, which is the shape above. Add `"env": { "PC_SESSION_ID": "my-session" }` when several Cursor sessions share one repo and need separate evidence and loop views.

`guard_verify` runs a shell with your privileges. Leave tool approval on for that tool.
