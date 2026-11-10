# Contributing

protect-context is the Python package (`src/protect_context`, CLI, MCP server) and the pi extension (`extension/`). They share the `.agent-guard/` store described in [`SPEC.md`](./SPEC.md). That file is the frozen v1.0 contract; do not change a frozen default or on-disk shape to make a patch smaller.

## Setup

Python 3.10 or newer, and [uv](https://docs.astral.sh/uv/). Node.js 22.19 or newer is required only for the extension checks (`package.json` `engines`).

```sh
uv venv .venv
uv pip install -e ".[dev]"
npm ci --ignore-scripts
```

`uv pip install -e ".[dev]"` installs this checkout plus `pytest` and `build`, which are the `dev` extra in `pyproject.toml`. There is no `uv.lock`. The extension's npm dependencies are devDependencies; the published extension has zero runtime dependencies.

If the default `node` is older than 22.19, the README's `npx -y node@22 …` commands run the same checks without changing the system Node.

## Tests

```sh
.venv/bin/pytest -q
npm test
npm run typecheck
```

`npm run check` is the typecheck and the extension tests together. `npm test` runs `node --experimental-strip-types --test extension/test/*.test.ts`. Pytest uses a temporary working directory per test, so it does not write `.agent-guard/` into the checkout.

The loop-brake script is separate from pytest. From the repository root:

```sh
python3 examples/loop-brake-demo/demo.py
```

It exits 0 when the third identical `guard_verify("false")` is blocked and a masked `|| true` command is labelled `UNTRUSTED`.

## Pull requests

- Run `.venv/bin/pytest -q` and `npm run check`.
- Keep MCP tool behavior the same when you only edit descriptions. `tests/test_mcp.py` covers the annotations and the description text the directories score.
- If you change the version, set the same value in `pyproject.toml`, `package.json` (and the matching `package-lock.json` entries for this package), `server.json` (top level and the PyPI package entry), and `src/protect_context/__init__.py`.
- Leave the `mcp-name: io.github.XJTLUmedia/protect-context` marker in `README.md`. The MCP Registry reads it from the package description.
- The `.agent-guard/` store is tracked on purpose (owner decision, 2026-11-10; see the comment in `.gitignore`): `contract.json`, `config.json`, `state.json`, `journal.jsonl`, `events*.jsonl` and `verify_runs.jsonl` are the record of what was asked and what was proved, so review them in a diff instead of ignoring them. `.agent-guard/*.lock`, `.venv/` and `node_modules/` stay untracked.
- Because the store is tracked, the commands it records are published with it, and those commands contain absolute paths from the machine that ran them. Keep no secret or token in a recorded command, and treat a path that reveals a real home directory as accepted, not accidental, when you commit the store.

`.github/workflows/publish-mcp.yml` publishes `server.json` to the MCP Registry on a release. It does not publish the npm or PyPI packages.
