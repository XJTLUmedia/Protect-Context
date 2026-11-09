# Codex CLI

Official references, checked while writing this page:

- [Configuration reference](https://learn.chatgpt.com/docs/config-file/config-reference) — `~/.codex/config.toml` and project `.codex/config.toml`
- [Sample configuration](https://learn.chatgpt.com/docs/config-file/config-sample.md) — the `[mcp_servers.<name>]` stdio keys

`uvx` must be on `PATH`. Codex reads a project `.codex/config.toml` only after you trust the project.

## Config file

| Scope | Path |
|---|---|
| All projects | `~/.codex/config.toml` (`$CODEX_HOME/config.toml` when `CODEX_HOME` is set) |
| This trusted project | `.codex/config.toml` |

The sample’s stdio block is `command`, `args`, and optional `env`. There is no `type` field; a `url` is the HTTP form instead.

```toml
[mcp_servers.protect-context]
command = "uvx"
args = ["protect-context", "mcp"]
```

`enabled` defaults to true in the sample comments. This page does not document a `codex mcp add` invocation; the configuration reference and sample checked here specify the TOML file, not a subcommand.

`guard_verify` can run any shell command. Codex tool-approval settings still apply; `supports_parallel_tool_calls` on this server should stay at its default (`false`) because the tools share one project store.
