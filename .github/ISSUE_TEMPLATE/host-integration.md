---
name: Host integration
about: Document or fix protect-context on a specific MCP host
title: "[host] "
---

## Host

Name and version (Cursor, Claude Code, VS Code, Cline, Windsurf, Continue, Zed, Codex CLI, Gemini CLI, pi, or another).

## Config file you edited

The path the host actually read, and the snippet you used. `uvx protect-context mcp` is the stdio server. Remove secrets before posting.

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

## What the host did

Did the server connect? Which tools were listed? If a tool call failed, paste the host's error and the `Nudge:` line.

## Official docs

Link the host's current MCP configuration page for the file path and the JSON or TOML shape. A guessed path is not enough to add a page under `docs/integrations/`.
