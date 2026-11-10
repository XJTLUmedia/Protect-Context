# Changelog

## Unreleased

The brief is no longer extension-only, and the store travels with the repo.

- **One brief, three surfaces, byte-identical.** `buildBrief` moved out of
  `index.ts` into `extension/lib/brief_source.ts`, and `protect_context.brief`
  is its Python twin. The same store now renders through the pi extension
  (`before_agent_start`), the new CLI verb `protect-context brief`, and the new
  MCP tool `guard_brief` — the 14th MCP tool and the 14th pi tool. A new test
  (`tests/test_brief.py`) drives one fixture store through both runtimes and
  requires byte equality, so a renderer changed on one side fails the suite
  instead of drifting.
- **`+N more owner statements` stopped undercounting.** Both intent views paged
  at `READ_LIMIT_MAX` (20), and the brief assembled from that page while passing
  `journal.length` — so the overflow line reported the page's remainder. The
  classifier is now reachable uncapped (`intentClassified` /
  `intent_classified`) and the brief counts every hidden row.
- **The whole store is tracked by default in this repo.** `.gitignore` keeps
  only `.agent-guard/*.lock`; contract, config, state, journal, events and
  verify runs are committed, because they record what the owner asked for and
  what was proved. README documents the trade-off (events and journal carry the
  working conversation) and the contract-only alternative.
- **Owner constraints no longer evict seeds.** The brief re-injected one shared
  12-line contract budget and selected owner rows first, so adding owner
  constraints silently removed seeds `08`–`12` from every brief. Budgets are now
  additive (≤6 owner + ≤12 seed/other) in both runtimes, with a
  `contractOverflow` helper feeding every write surface's warning, and
  `docs/PROJECT-INTENT.md` records the mission, the 12 failure modes, the ask
  history and the honest limits.

## 3.3.1

- Version 3.3.1 in every artifact (`package.json`, `package-lock.json` in both places npm records it, `pyproject.toml`, `__init__.py`, `server.json`, `bin/pc.mjs`, `CHANGELOG.md`) so npm, PyPI, and the MCP Registry publish this tree. npm 3.3.0 was published before the notes below landed. PyPI is still 3.2.1. The MCP Registry is still 3.2.1.
- README demo GIF (`docs/assets/demo.gif`) replaced with a productivity explainer covering the loop brake, UNTRUSTED versus recorded evidence, and local recall.
- `vendor/` checkouts are registered in `.gitmodules` and fetched by CI. They were gitlinks with no URL, so `actions/checkout` died in `git submodule foreach` before pytest or the extension suite could start.
- PyPI author metadata is Alex Yu. The email stays `xjtlumedia@gmail.com`.

## 3.3.0

Owner intent is now actually tellable, and two contract checks are measured
instead of asserted.

- **Captured prompts are readable intent.** Every substantive owner prompt was
  journaled trusted under `owner-prompt` and then classified by nothing: `intent`
  and the brief's owner-intent slot could not see the owner's own words. Those
  rows are now keyed to the owner-typed rules and always count, falling back to
  the new `owner-statement` kind when no want/need/preference/constraint/
  correction pattern matches.
- **Detection reads real prompts.** The imperative list grew from 17 to 46 verbs
  (`audit`, `review`, `install`, `clone`, `vendor`, `test`, `run`, `revert`, …),
  a leading connective (`now`, `then`, `also`) no longer hides the verb, and a
  start-anchored negation (`do not`, `never`, `avoid`, `must`) is classified as
  the new `owner-constraint` kind. Mirrored in `journal.py` and `journal.ts`.
- **The brief prefers the owner's words to the agent's paraphrase** in its two
  owner-intent lines, and it deduplicates against the precedents the cap really
  shows — a lesson hidden by the cap could previously swallow an identical owner
  statement so that neither appeared.
- **No silent truncation.** Owner-intent lines get 200 chars (was 120, which cut
  the operative tail mid-sentence) and both they and the recall lines now set
  the `journal text truncated` notice when they are cut.
- **`guard_contract_check` measures 02 and 08.** 02 needs a run whose trust label
  is `ok` and whose id the summary cites; 08 compares the real diff against the
  configured hard limit. The output states which items were measured and which
  remain self-report keyword coverage.
- **`status` shows the task anchor** with its source and age, in both runtimes,
  so the dashboard answers "what am I doing" as well as "where is the tree".
- **The pi extension now carries the whole guard surface.** It registered 7 tools
  while MCP registered 13, so an agent running under the extension alone could
  not look up an evidence id, see why a re-run blocked, audit its own diff, check
  the environment, or read the contract. `guard_evidence`, `guard_loop_check`,
  `guard_diff_audit`, `guard_preflight`, `guard_budget`, `guard_contract` and
  `guard_orientation` are now registered too, and both suites pin the parity
  (`tests/test_mcp.py` for the 14 MCP names, `index-lifecycle.test.ts` for those
  14 plus the extension-only `guard_contract_check`).
- One version for every artifact (`package.json`, `package-lock.json` in both
  places npm records it, `pyproject.toml`, `__init__.py`, `server.json`,
  `bin/pc.mjs`, `CHANGELOG.md`), enforced by
  `tests/test_registry.py::test_one_version_everywhere`, and a CI workflow that
  runs the extension suite and pytest on push and pull request — with the
  extension job installing `git`, `python3` and the package itself, because
  three of its tests are the cross-runtime contract tests.
- **The published package imports in a clean environment.** `store.py` imports
  `tenacity` and `layers.py` imports `dotenv`, and neither was declared, so
  `pip install protect-context` produced a package that failed at import unless
  the machine already had both by hand. All twelve third-party imports are now
  declared, and `tests/test_registry.py::test_every_third_party_import_is_declared`
  fails if a new import appears without a dependency (it caught nothing else,
  which is the point of pinning it).
- **Python 3.10 works again in a checkout.** The vendored `pydantic-settings`
  imports `typing.Self`, so under 3.10 the vendoring bootstrap took the whole
  package down (`ImportError` at `import protect_context`). A checkout that
  cannot be imported on the running interpreter is now dropped from `sys.path`
  and the installed distribution is used instead — the same fallback the module
  already promised for a *missing* checkout.
- **`preflight` stops repeating tool names and printing paths.** It showed
  `git git 2.43.0` and cut pip's install path mid-directory, because the old
  code stripped only the literal `version `. Versions are now compacted
  consistently in both runtimes (`git 2.43.0`, `pip 24.0`, `pytest 9.1.1`).
- **CI is validated, not asserted.** The workflow's two jobs were run in
  containers on node 22 and on Python 3.10/3.12, which is how the two failures
  above were found; `tests/test_registry.py` now pins the jobs and their
  prerequisites so a later edit cannot quietly drop one.
- **`verify -- <cmd>` runs the command, not the separator.** argparse keeps an
  explicit `--` in the remainder, so `verify -- npm run check` executed the
  literal string `-- npm run check`, exited 2, and *recorded a FAIL row* for a
  command that passes. The separator is now dropped, and a `--timeout` written
  after the command (a documented footgun) gets a one-line hint instead of a
  silently mangled command.
- **A truncated constraint is announced.** `contract add` cut text at the
  500-char cap and said only "added <id>" — and unlike a journal row, a
  constraint is re-injected into every session, so the loss is permanent
  behaviour. CLI, MCP tool, pi tool and `/guard-contract` now print
  `note: text truncated N -> M chars (TEXT_CAP 500)`.
- **CI covers every version the package claims.** pyproject classifies 3.10–3.13
  while the matrix tested 3.10 and 3.12; 3.11 and 3.13 were green in containers,
  so both run now. The workflow also takes `contents: read`, keeps no
  credentials in the checkout, and pins each action by commit SHA with the
  release in a comment (a movable tag is a supply-chain input to every run).
- **`guard_loop_check` stops promising a block it will not apply.** A streak older
  than `loop_reset_after_s` is a probe on the next identical run, but the
  extension's renderer said "another identical failure will trigger a block" —
  Python had the aged-out branch, the TypeScript layer did not. Both now say
  `N streak(s) aged past loop_reset_after_s=Ns — the next identical run is a probe`.
- **A missing `git` fails loudly once.** The suite shells out to git for diff,
  orientation, preflight and the demo; in a slim container that surfaced as 16
  separate `FileNotFoundError` failures. `tests/conftest.py` now raises one
  `pytest.UsageError` naming the missing binary.

## 3.2.1

- README install badges for Cursor (`https://cursor.com/en/install-mcp`), VS Code, and VS Code Insiders, plus the star-history chart.
- `docs/integrations/` pages for Cursor, Claude Code, VS Code (Copilot agent mode), Cline, Windsurf, Continue, Zed, Codex CLI, Gemini CLI, and pi. Each one uses `uvx protect-context mcp` and the config path from that host's current docs.
- MCP tool descriptions and parameter descriptions now say what the tool does, when to use it, the parameter types and defaults, the return text, and the side effects. Annotations are unchanged. Tool behavior is unchanged.
- `examples/loop-brake-demo` runs `guard_verify` until the loop brake blocks a third `false`, then records a masked `|| true` command as `UNTRUSTED`. The 3.2.1 README GIF was a rendering of one real run of that script.
- `CONTRIBUTING.md`, GitHub issue templates (bug, feature, host integration), and a pull request template.
- Version 3.2.1 so an npm and PyPI republish carries the current metadata: homepage, repository, and bugs `https://github.com/XJTLUmedia/Protect-Context`, the keywords and classifiers in `pyproject.toml` and `package.json`, and the project URLs in `pyproject.toml`.
