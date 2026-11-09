## What changed

<!-- One short paragraph. Say which surface: Python, MCP, pi extension, docs. -->

## Why

<!-- The failure or the docs gap this closes. Link an issue if there is one. -->

## How tested

- [ ] `.venv/bin/pytest -q`
- [ ] `npm run check` (`npm run typecheck` and `npm test`)
- [ ] If MCP tool descriptions changed: `tests/test_mcp.py` still passes and tool behavior did not
- [ ] If the version changed: `pyproject.toml`, `package.json`, `server.json`, and `__version__` match

## Checklist

- [ ] `README.md` still contains `mcp-name: io.github.XJTLUmedia/protect-context`
- [ ] No secrets, credentials, or `.agent-guard/` runtime files
- [ ] New host instructions cite that host's current docs and use `uvx protect-context mcp`
