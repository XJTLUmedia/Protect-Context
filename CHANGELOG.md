# Changelog

## 3.2.1

- README install badges for Cursor (`https://cursor.com/en/install-mcp`), VS Code, and VS Code Insiders, plus the star-history chart.
- `docs/integrations/` pages for Cursor, Claude Code, VS Code (Copilot agent mode), Cline, Windsurf, Continue, Zed, Codex CLI, Gemini CLI, and pi. Each one uses `uvx protect-context mcp` and the config path from that host's current docs.
- MCP tool descriptions and parameter descriptions now say what the tool does, when to use it, the parameter types and defaults, the return text, and the side effects. Annotations are unchanged. Tool behavior is unchanged.
- `examples/loop-brake-demo` runs `guard_verify` until the loop brake blocks a third `false`, then records a masked `|| true` command as `UNTRUSTED`. `docs/assets/demo.gif` is a rendering of one real run of that script.
- `CONTRIBUTING.md`, GitHub issue templates (bug, feature, host integration), and a pull request template.
- Version 3.2.1 so an npm and PyPI republish carries the current metadata: homepage, repository, and bugs `https://github.com/XJTLUmedia/Protect-Context`, the keywords and classifiers in `pyproject.toml` and `package.json`, and the project URLs in `pyproject.toml`.
