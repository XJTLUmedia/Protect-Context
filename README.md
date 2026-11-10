# protect-context · Agent Guardrail Suite

**Durable context, real evidence, and a brake pedal for AI coding agents.**

`protect-context` keeps the rules, decisions, and proof-of-work an agent needs in
front of it — then makes scope creep, unverified claims, and repeated failures
visible *before* they cost you a session.

<!-- mcp-name: io.github.XJTLUmedia/protect-context -->

<p align="center">
  <a href="https://pypi.org/project/protect-context/"><img alt="PyPI" src="https://img.shields.io/pypi/v/protect-context"></a>
  <a href="https://pepy.tech/project/protect-context"><img alt="PyPI downloads" src="https://img.shields.io/pepy/dt/protect-context"></a>
  <a href="https://www.npmjs.com/package/protect-context"><img alt="npm" src="https://img.shields.io/npm/v/protect-context"></a>
  <a href="https://www.npmjs.com/package/protect-context"><img alt="npm downloads" src="https://img.shields.io/npm/dt/protect-context"></a>
  <a href="https://github.com/XJTLUmedia/Protect-Context/blob/feat/complete-v1-spec/LICENSE"><img alt="license: MIT" src="https://img.shields.io/badge/license-MIT-green"></a>
  <a href="https://pi.dev/packages/protect-context"><img alt="pi-package" src="https://img.shields.io/badge/pi--package-gallery-8a2be2"></a>
  <a href="https://registry.modelcontextprotocol.io/"><img alt="MCP Registry" src="https://img.shields.io/badge/MCP%20Registry-io.github.XJTLUmedia%2Fprotect-context-blue"></a>
  <img alt="python 3.10+" src="https://img.shields.io/badge/python-3.10%2B-blue">
  <img alt="enforcement: advisory-first" src="https://img.shields.io/badge/enforcement-advisory--first-lightgrey">
  <img alt="runtime dependencies: zero" src="https://img.shields.io/badge/npm%20runtime%20deps-0-success">
</p>

<p align="center">
  <a href="https://cursor.com/en/install-mcp?name=protect-context&amp;config=eyJjb21tYW5kIjoidXZ4IiwiYXJncyI6WyJwcm90ZWN0LWNvbnRleHQiLCJtY3AiXX0%3D"><picture><source media="(prefers-color-scheme: dark)" srcset="https://cursor.com/deeplink/mcp-install-dark.svg"><img alt="Add protect-context to Cursor" src="https://cursor.com/deeplink/mcp-install-light.svg"></picture></a>
  <a href="https://vscode.dev/redirect/mcp/install?name=protect-context&amp;config=%7B%22command%22%3A%22uvx%22%2C%22args%22%3A%5B%22protect-context%22%2C%22mcp%22%5D%7D"><img alt="Install protect-context in VS Code" src="https://img.shields.io/badge/VS_Code-Install_MCP-0098FF?logo=visualstudiocode&logoColor=white"></a>
  <a href="https://insiders.vscode.dev/redirect/mcp/install?name=protect-context&amp;config=%7B%22command%22%3A%22uvx%22%2C%22args%22%3A%5B%22protect-context%22%2C%22mcp%22%5D%7D&amp;quality=insiders"><img alt="Install protect-context in VS Code Insiders" src="https://img.shields.io/badge/VS_Code_Insiders-Install_MCP-24bfa5?logo=visualstudiocode&logoColor=white"></a>
</p>

![protect-context injects a session brief — contract, decisions, corrections, loops, last evidence — before the agent starts working](./preview.png)

![Protect-Context demo: "Stop wasting agent sessions." An agent fails pytest tests/test_auth.py the same way twice (ev-0012, ev-0013), and the third identical run is blocked; "npm test || true" is flagged UNTRUSTED, while a real "npm test" is recorded as ev-0042 OK; and guard_recall "auth timeout" pulls the auth-timeout lesson from the local journal ("mock the clock, don't bump the timeout") with no vector database and no network.](./docs/assets/demo.gif)

One project-local `.agent-guard/` store · three interfaces backed by the same
logic:

| Interface | Use it for | Runtime |
|---|---|---|
| **pi extension** | Automatic brief injection, status widget, loop blocking, diff warnings, risky-command confirmation | TypeScript, loaded by pi via jiti |
| **MCP server** | Portable model/host access to the same tools | Python 3.10+, `fastmcp` |
| **Python CLI** | People, scripts, CI, and hosts without MCP | Python 3.10+ |

The suite is **advisory-first**. It records evidence and makes unsafe or
repetitive behavior visible; it is not a sandbox and does not prove that a
change is correct. [`SPEC.md`](./SPEC.md) is the frozen v1.0 contract.

![Architecture: the pi extension, MCP server, and Python CLI share a project-local .agent-guard store for rules, journal entries, and evidence; only pi injects briefs automatically](./docs/images/shared-store.svg)

## Contents

- [Why this exists](#why-this-exists)
- [What it does](#what-it-does)
- [Quick start](#quick-start)
  - [Install the pi extension](#install-the-pi-extension)
  - [Install the MCP server](#install-the-mcp-server)
    - [Cursor / Claude Code / any stdio host](#cursor--claude-code--any-stdio-host-recommended)
    - [From a checkout](#from-a-checkout)
  - [Install the Python CLI](#install-the-python-cli)
  - [From source](#from-source)
- [See it work](#see-it-work)
- [A 30-second tour](#a-30-second-tour)
- [Interface comparison](#interface-comparison)
- [Reference](#reference)
  - [pi commands and tools](#pi-commands-and-tools)
  - [MCP tools](#mcp-tools)
  - [CLI](#cli)
  - [Configuration](#configuration)
  - [Environment variables](#environment-variables)
  - [Runtime store and concurrency](#runtime-store-and-concurrency)
- [The 12 failure modes and what ships](#the-12-failure-modes-and-what-ships)
- [How it works](#how-it-works)
  - [Session lifecycle](#session-lifecycle)
  - [The brief](#the-brief)
  - [Local recall](#local-recall)
  - [Evidence and loop detection](#evidence-and-loop-detection)
  - [Scope audit](#scope-audit)
  - [Trust and provenance](#trust-and-provenance)
  - [Context budget](#context-budget)
- [Development and validation](#development-and-validation)
- [Troubleshooting](#troubleshooting)
- [Limitations and security boundary](#limitations-and-security-boundary)
- [Design sources](#design-sources)
- [Non-goals](#non-goals)
- [License](#license)

## Why this exists

Long agent sessions fail in boring, expensive ways:

- the constraints you stated at minute two are gone by minute forty;
- "done" is claimed with no command output behind it;
- a "quick fix" quietly rewrites six unrelated files;
- decisions get re-litigated because nothing recorded the reasoning;
- the same failing command is retried until the context window dies.

`protect-context` treats those as **state** problems, not intelligence problems.
A durable store plus three small habits — brief before work, evidence after
work, journal when something is decided — removes most of the failure surface
without turning the agent into a different agent.

## What it does

| Primitive | What it gives you | Where you meet it |
|---|---|---|
| **Brief** | Owner task, contract, recent trusted decisions and corrections, a short unverified section for the agent's own notes, open loops, and the last evidence ID — injected before a turn and re-asserted mid-run after a compaction | Automatic in pi; `orientation`, `status`, `guard_journal` elsewhere |
| **Orientation** | Bounded repo digest: tree, languages, and conventions files (`CLAUDE.md`, `AGENTS.md`, `CONVENTIONS.md`, `README.md`, `README`) | Injected once per digest in pi; `orientation` in CLI/MCP |
| **Evidence ledger** | Every verification run recorded as `ev-NNNN` with exit code, duration, command, and a bounded output digest | `guard_verify`, `protect-context verify`, `guard_evidence` |
| **Loop brake** | Identical failing commands are fingerprinted; the Nth attempt is blocked instead of re-run | Hard block in pi and the CLI; reported through MCP |
| **Scope audit** | `git` diff stats over tracked, staged, and bounded untracked work, with `ok` / `warn` / `hard` verdicts | Widget and `status` in pi; `diff`, `guard_diff_audit` |
| **Journal** | Durable `decision` / `correction` / `risk` / `note` entries with tags and trust levels | `guard_note`, `protect-context note`, `guard_journal` |
| **Recall** | Keyword, tag, type, evidence-id, and command search over the retained journal and evidence window — no embeddings | `guard_recall`, `protect-context recall`; the brief names it when a cap hides entries |
| **Risky-command confirm** | Nine catastrophic shell patterns get one grouped confirmation instead of none | pi, when a UI is available |
| **Preflight** | Tool presence and versions plus Git worktree detection | `preflight`, `guard_preflight` |
| **Context budget** | Watermarks on context usage and hard caps on every injected block | Widget, `budget`, `guard_budget` |

## Quick start

Python 3.10+ is required for the CLI and MCP server. Node 22.19+ is required
only to validate the TypeScript extension from a checkout — pi supplies the
extension's runtime modules, and the extension has **zero npm runtime
dependencies**.

### Install the pi extension

Installed from npm. The package declares `"pi": { "extensions":
["./extension/index.ts"], "image": "./preview.png" }` and the `pi-package`
keyword required by the Pi package gallery:

```sh
pi install npm:protect-context

# Try it for one run without adding it to settings
pi -e npm:protect-context
```

Install it through pi, not through `npm install`. The extension declares pi's
host modules (`@earendil-works/pi-ai`, `@earendil-works/pi-coding-agent`,
`typebox`) as `"*"` peer dependencies, as Pi requires; Pi suppresses peer
installation for managed npm packages, while a plain `npm install
protect-context` does not. The second path downloads the whole pi runtime and
surfaces advisories from that tree, which belong to the host and not to this
zero-runtime-dependency extension.

Remove any hand-installed copy first — a directory such as
`~/.pi/agent/extensions/protect-context` or `.pi/extensions/protect-context`,
or `pi remove npm:protect-context` if that copy came from npm. Two copies
register the same tool names, and pi drops the second one:

```text
Error: Failed to load extension "…/.pi/npm/node_modules/protect-context/extension/index.ts":
Tool "guard_verify" conflicts with /home/you/.pi/agent/extensions/protect-context/index.ts
```

One error is reported per tool (`guard_verify`, `guard_note`,
`guard_contract_check`, `guard_status`, `guard_journal`, `guard_recall`), so
nothing from the npm copy loads until the other copy is gone.

Or copy/symlink the checkout into a trusted extension directory:

```sh
# Personal
mkdir -p ~/.pi/agent/extensions
cp -r extension ~/.pi/agent/extensions/protect-context

# Project-local (read after the project is trusted)
mkdir -p .pi/extensions
cp -r extension .pi/extensions/protect-context
```

Start a session and you get a single-line status widget, a brief before the
first turn, and five slash commands. No configuration file is needed: the
extension seeds `.agent-guard/config.json` with the frozen defaults on first
session start.

### Install the MCP server

The MCP server is the PyPI package. With uv installed, `uvx protect-context mcp`
serves it on stdio. After `pip install protect-context`, the same entry point
is `protect-context mcp`. Both run the `protect-context` console script
(`protect_context.cli:main`); the `mcp` verb starts `protect_context.mcp_server`.

#### Cursor / Claude Code / any stdio host (recommended)

**Cursor** — project `.cursor/mcp.json` or global MCP settings:

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

**Claude Code** — CLI:

```bash
claude mcp add protect-context -- uvx protect-context mcp
```

Or hand-edit Claude Desktop / Claude Code MCP config with the same `command` /
`args` shape.

**Generic `.mcp.json`** (pi-mcp-adapter and other hosts). This repository
checks in the same file at the root:

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

Set `"env": { "PC_SESSION_ID": "my-session" }` when several host sessions share
one repo and need separate evidence and loop views.

The same `uvx protect-context mcp` command, with each host's current config
path, is copied in full under [`docs/integrations/`](./docs/integrations):

- [Cursor](./docs/integrations/cursor.md)
- [Claude Code](./docs/integrations/claude-code.md)
- [VS Code (Copilot agent mode)](./docs/integrations/vscode.md)
- [Cline](./docs/integrations/cline.md)
- [Windsurf](./docs/integrations/windsurf.md)
- [Continue](./docs/integrations/continue.md)
- [Zed](./docs/integrations/zed.md)
- [Codex CLI](./docs/integrations/codex-cli.md)
- [Gemini CLI](./docs/integrations/gemini-cli.md)
- [pi](./docs/integrations/pi.md)

#### From a checkout

An editable install uses that environment's interpreter:

```json
{
  "mcpServers": {
    "protect-context": {
      "command": "/absolute/path/to/protect-context/.venv/bin/python",
      "args": ["-m", "protect_context.mcp_server"]
    }
  }
}
```

`PC_SESSION_ID` uses the same `env` object as the stdio examples above.

The MCP surface exposes the nine frozen v1.0 tools plus later read surfaces
(`guard_journal`, `guard_orientation`, and `guard_recall`). Tools carry
conservative MCP annotations; in particular
`guard_verify` is marked destructive and open-world because it can run any
shell command. Annotations are host hints, not enforcement — configure the host
to require human approval for that tool.

### Install the Python CLI

```sh
pip install protect-context      # or: pipx install protect-context
protect-context init             # seed .agent-guard/ in the current project
protect-context status
protect-context verify "pytest -q"
protect-context mcp               # serve the MCP tools on stdio
```

The CLI and MCP server are distributed through PyPI; the npm package ships only
the pi extension. Both read the same `.agent-guard/` directory, so a project can
use the extension in pi and scripted verification in CI at the same time.

### From source

```sh
# Python package, CLI, MCP server, and Python tests
python3 -m venv .venv
.venv/bin/python -m pip install -e ".[dev]"

# Reproducible extension development checks (dev dependencies only)
npm ci --ignore-scripts
npm run check
```

If the machine's default Node is older than 22.19, run the same checks with an
ephemeral Node 22 binary after `npm ci`:

```sh
npx -y node@22 node_modules/typescript/bin/tsc --noEmit -p extension/tsconfig.json
npx -y node@22 --experimental-strip-types --test extension/test/*.test.ts
```

## A 30-second tour

Excerpts from a real session in this repository.

Ask for the current state:

```console
$ protect-context status
PC status · session default · git 91fad4d
Δdiff +88/-8 · 6 files · verdict ok
loops: none
contract 12 constraints
conventions: README.md
Nudge: verify changes with guard_verify and cite the evidence id before claiming success.
```

Record proof instead of asserting it:

```console
$ protect-context verify --timeout 180 npm run check
PC verify ev-0005 · exit 0 · ok · 1440ms
cwd: /path/to/project
cmd: npm run check
digest: …
Nudge: cite this evidence id when claiming success.
```

A pipeline or `|| true` is still recorded with the shell's real exit code, but
the report says `UNTRUSTED` and the CLI exits 1. That exit 0 is not proof.

Re-run the same failing command a third time and the brake engages:

```console
$ protect-context verify "npm test"
PC verify blocked · npm test · 3 prior failures
Nudge: change approach or gather new information — do not re-run unchanged.
```

What pi injects before the agent starts working (sections elided):

```console
contract:
01-obey-instructions: Obey the owner's explicit instructions and stated constraints exactly; when instructions conflict, ask instead of guessing.
02-evidence-before-success: Never claim success without citing a fresh verification run (evidence id or pasted output) for the exact claim.
…
decisions:
- Use the atomic-mkdir lease, not fcntl alone; Python must interoperate with the extension. [locking,spec]
last verify: ev-0005 exit=0 ok 'npm run check' 1.4s
```

And the always-on one-line widget:

```console
PC Δ+88L/6f 0loop ev5 ctx8%
```

![Illustrative pi widget: Δ+123L/4f means 123 changed lines across 4 files, 1loop means one command at the blocking threshold, ev2 counts two verification runs this session, and ctx41% shows context usage](./docs/images/status-widget.svg)

## See it work

[`examples/loop-brake-demo/demo.py`](./examples/loop-brake-demo/demo.py) calls
`guard_verify` in a temporary git repository. Two identical `false` runs are
recorded. The third is blocked and adds no evidence id. A different command
that forces exit 0 with `|| true` is stored as `UNTRUSTED`. The temporary
directory name and the millisecond timings change every run. This is one run:

```console
$ guard_verify('false')
PC verify blocked · false · 2 prior failures
Nudge: change approach or gather new information — do not re-run unchanged.

$ guard_verify("python3 -c 'raise SystemExit(1)' || true")
PC verify ev-0003 · exit 0 · UNTRUSTED · 16ms
cwd: /tmp/pc-loop-brake-4tqwi013
cmd: python3 -c 'raise SystemExit(1)' || true
digest: (no output)
why: The command masks failure (`|| true`, `|| :`, `; true`, or similar), so exit 0 does not prove the check passed.
fix: drop the trailing failure mask and re-run the command as-is. Do not cite this id as proof.
Nudge: this run is recorded, but exit 0 here is not evidence of success.
```

The full transcript, including the two recorded failures, is in the
[demo README](./examples/loop-brake-demo/README.md). From a dev checkout:

```sh
python3 examples/loop-brake-demo/demo.py
```

## Interface comparison

| Capability | pi extension | MCP server | CLI |
|---|---|---|---|
| Brief injected automatically before a turn | yes (change-triggered) | — | — |
| Orientation digest (tree, languages, conventions) | injected once per digest | `guard_orientation` | `orientation` |
| Verification evidence (`ev-NNNN`) | `guard_verify`, `guard_evidence`, `/guard-verify` | `guard_verify`, `guard_evidence` | `verify`, `evidence` |
| Loop blocking | blocks the command; `guard_loop_check` explains why | `guard_loop_check` reports and advises | `verify` refuses; `loops` exits 1 |
| Scope audit | session-start baseline + warnings, `guard_diff_audit` on demand | `guard_diff_audit` (explicit baseline) | `diff --baseline REF` |
| Journal write/read | `guard_note`, `/guard-note`, `guard_journal` | `guard_note`, `guard_journal` | `note`, `journal` |
| Recall across the retained window | `guard_recall`; brief may surface 1–2 trusted tag matches | `guard_recall` | `recall` |
| Owner intent (wants, needs, preferences, constraints, corrections) | `guard_intent` | `guard_intent` | `intent` |
| Trusted re-injection of decisions | yes, after change and after every compaction (incl. mid-run) | read views only | read views only |
| Re-injection of the agent's own notes | yes, in an explicitly unverified section | read views only | read views only |
| Owner task anchor | `/guard-task`, auto-captured from the first prompt | — | — |
| Contract management | `guard_contract`, `/guard-contract` | `guard_contract` | `contract list\|add\|remove` |
| Environment preflight | `guard_preflight` | `guard_preflight` | `preflight` |
| Context budget | `guard_budget` (per session) | `guard_budget` | `budget` |
| Risky-command confirmation | one grouped confirm | host approval policy | — |
| Status widget | yes | — | `status` |

## Reference

### pi commands and tools

Slash commands:

| Command | Action |
|---|---|
| `/guard-status` | Compact session status: diff verdict, loops, evidence, contract, context |
| `/guard-contract` | `list` · `add <text>` · `remove <id>` — edit the persistent contract |
| `/guard-verify` | Run a command through the evidence ledger |
| `/guard-note` | Journal a `decision` · `correction` · `risk` · `note` |
| `/guard-task` | Show · set `<text>` · `--clear` the owner task anchor that the brief re-injects |
| `/guard-report` | Full session summary for handoff or review |

Model-callable tools:

| Tool | Arguments | Notes |
|---|---|---|
| `guard_verify` | `command`, `timeout_s` (default 180, clamped 1–900) | Records `ev-NNNN`; refusal on a blocked loop |
| `guard_note` | `type`, `text`, optional `tags` | Forced to the `agent` trust level |
| `guard_evidence` | `limit` (default 5), optional `evidence_id` | Read-only; the window shows each non-ok row's last output line, and `evidence_id` returns one run in full |
| `guard_journal` | `limit` (0–20, default 5), optional `type` | Read-only; recovers decisions, corrections, and the agent's own earlier notes after a compaction |
| `guard_recall` | `query`, `type`, `tags` (AND), `limit` (0–20, default 5), `evidence_id`, `cmd` | Read-only scan of the retained window; hits labelled `trusted` or `agent` |
| `guard_intent` | `limit` (0–20, default 5) | Read-only owner wants, needs, preferences, constraints, corrections and statements; no query needed, provenance-labelled |
| `guard_contract_check` | `summary` | Checklist where 02 (evidence cited) and 08 (diff size) are measured from the store; the rest is keyword coverage, labelled as self-report |
| `guard_status` | — | Same data that feeds the widget, including journal totals and the task anchor |
| `guard_loop_check` | — | Read-only failing-command streaks and whether the next identical re-run blocks |
| `guard_diff_audit` | — | Read-only diff size against the configured warn/hard thresholds |
| `guard_preflight` | — | Read-only tool presence and versions; a slow probe reads `(version unavailable)`, never `missing` |
| `guard_budget` | — | Read-only per-session tool-output characters and the top 5 tools |
| `guard_contract` | `action` (`list`\|`add`\|`remove`), `text` | A model-called write lands in the project layer only; the personal layer stays owner-only |
| `guard_orientation` | — | Read-only bounded tree, language counts, and conventions files |

### MCP tools

| Tool | Annotation class | Purpose |
|---|---|---|
| `guard_status` | local, initializing read | Session status digest |
| `guard_verify` | **shell execution** (destructive, open-world) | Run a command, record evidence |
| `guard_evidence` | read-only | Recent verification entries |
| `guard_contract` | local mutation | `list` · `add` · `remove` |
| `guard_note` | local append | Journal an entry (tagged `agent`) |
| `guard_journal` | read-only | Recent journal entries, optionally filtered by type |
| `guard_recall` | read-only | Search the retained journal and evidence window by keyword, tag, type, evidence id, or command |
| `guard_intent` | read-only | Owner wants, needs, preferences, constraints, corrections and statements from the journal (no query) |
| `guard_loop_check` | local, initializing read | Failing-command streaks and advice |
| `guard_diff_audit` | local, initializing read | Diff stats and verdict vs thresholds |
| `guard_preflight` | local, initializing read | Tool/version and worktree check |
| `guard_budget` | read-only | Context-budget watermarks |
| `guard_orientation` | read-only | Repo digest and conventions files |

### CLI

Every command returns `0` for OK, `1` for a triggered warning or failed
verification, and `2` for an input/environment error.

```sh
protect-context init
protect-context status
protect-context verify [--timeout 180] pytest -q
protect-context evidence [--limit 5]
protect-context contract list
protect-context contract add "Keep the public API stable" [--global]
protect-context contract remove ID [--global]
protect-context note correction "use rg, not grep" --tags search
protect-context journal [--limit 5] [--type decision]
protect-context recall [QUERY] [--type decision|correction|risk|note|evidence] [--tag TAG] [--limit 5] [--evidence-id ev-NNNN] [--cmd FINGERPRINT]
protect-context orientation
protect-context loops
protect-context diff [--baseline REF]
protect-context preflight
protect-context budget
protect-context mcp
```

### Configuration

The extension seeds `.agent-guard/config.json` on first session start; `init`
does the same for CLI/MCP-first use. Unknown, wrongly typed, fractional, or
out-of-range values fall back to the frozen default.

| Key | Default | Meaning |
|---|---:|---|
| `loop_block_after` | `3` | Block the Nth identical failing command attempt |
| `diff_warn_lines` | `400` | Changed-line warning threshold |
| `diff_hard_lines` | `800` | Changed-line hard-level threshold |
| `diff_warn_files` | `10` | Changed-file warning threshold |
| `ctx_warn_pct` | `70` | First context-usage warning watermark |
| `brief_mode` | `"changed"` | Inject only when the brief digest changes; `"always"` injects every turn |
| `brief_max_precedents` | `3` | `lesson` precedents re-injected per brief (0–10; `0` disables the section) |
| `risk_confirm` | `true` | Ask once before a matching risky pi bash command when UI is available |
| `preflight_tools` | `git`, `python3`, `pip`, `node`, `npm`, `rg`, `pytest` | Executables checked by preflight |

Numeric thresholds may be set to zero; the extension records an explicit first
notification so a zero watermark does not silently disable alerts. Preflight
checks at most 20 configured tool entries. If more are configured, it lists the
omitted count and returns a warning instead of claiming the environment is
fully checked. Version probes have a two-second per-tool timeout, share a
15-second overall deadline, and decode at most 4 KiB of output; a missing
version is reported as an incomplete preflight.

### Making it yours: the personal layer

The twelve seeds and the config defaults are the same for everyone, on purpose:
they are the floor that makes the guardrail comparable across machines. What is
*yours* goes in a personal layer that every project inherits:

```text
built-in defaults  <  ~/.config/protect-context/  <  .agent-guard/
                        contract.json                 contract.json
                        config.json                   config.json
```

The directory is `$PC_USER_DIR`, else `$XDG_CONFIG_HOME/protect-context`, else
`~/.config/protect-context`. Write it from the owner surfaces:

```console
$ protect-context contract add "Prefer stdlib over new dependencies" --global
added 13-prefer-stdlib-over-new-dependencies to personal layer
…

$ protect-context contract list          # every project sees it
personal layer: 1 from /home/you/.config/protect-context/contract.json (applies to every project; a project row with the same id or text wins)
```

The same flag works in pi: `/guard-contract add <text> --global` and
`/guard-contract remove <id> --global`. Without it, writes go to the project
store as before, and `guard_contract` (the agent-callable tool) never touches
the personal layer.

Rules that make the layering predictable:

- **The project wins.** A project row with the same id overrides the personal
  one, and a personal constraint identical in text to a project row is not
  listed twice. Give a personal override the same id (e.g. `03-stay-in-scope`) to
  reword a seed for every repo.
- **Defaults mean "no opinion".** The extension seeds `config.json` with every
  default value; a project value equal to the built-in default therefore does not
  pin it, so your personal `ctx_warn_pct` still applies. Any *different* project
  value is an explicit choice and wins.
- **Nothing is created behind your back.** The layer is never seeded or repaired:
  a missing file means "no personal constraints", and an unreadable one is
  ignored in memory and left untouched. Deleting a personal constraint requires
  `--global`; a project-scope remove says so instead of silently doing nothing.
- **Each layer has its own lease.** A `--global` write locks the personal
  directory, not the project store, so two projects writing personal state cannot
  race each other.

### Sharing a contract (and the rest of the store) with a team

`.agent-guard/` defaults to local runtime state for a new project, but every
file in it is the project's memory: the contract, the config, the session state
with the owner task, the journal of decisions and corrections, the evidence
ledger, and the event ledger. A team that wants one shared record tracks the
whole store and ignores only live lock artifacts:

```gitignore
.agent-guard/*.lock
```

That is what this repository does: `git add .agent-guard/` stages the contract,
config, state, journal, events and verify runs. The trade-off is explicit —
events and journal rows contain prompts, commands and tool output, so a public
mirror publishes the working conversation along with the intent. Track only
`contract.json` instead when the conversation must stay private:

```gitignore
.agent-guard/*
!.agent-guard/contract.json
```

Personal constraints still apply on top — each teammate's personal layer is
weaker than a shared project row.

The nine catastrophic patterns that trigger the pi confirmation are frozen and
deliberately narrow, so benign lookalikes stay silent:

`rm -rf /` · `rm -rf ~` · `git push --force` (not `--force-with-lease`) ·
`git reset --hard` · `mkfs … /dev/…` · `dd … of=/dev/…` ·
`chmod -R 777 /` · `curl … | sh` · `sudo rm`

### Environment variables

| Variable | Effect |
|---|---|
| `PC_SESSION_ID` | Names the session used for evidence and loop views, so parallel hosts do not share a view |
| `PC_USER_DIR` | Overrides the personal-layer directory (default `$XDG_CONFIG_HOME/protect-context` or `~/.config/protect-context`) |

### Runtime store and concurrency

Runtime files stay in the frozen `.agent-guard/` layout. Every file below is
committable — this repository tracks all of them — and only `.lock` (a live
lease, meaningless outside the process that holds it) stays ignored:

`config.json` · `contract.json` · `journal.jsonl` · `events.jsonl` ·
`verify_runs.jsonl` · `state.json` · `verify_count.json` (a stamp-verified
evidence-count sidecar, discarded rather than trusted when the ledger moves)

Every interface writes the same ledgers: a `guard_verify` run from the MCP
server or the CLI is recorded in `verify_runs.jsonl` **and** mirrored as a
`tool_call`/`tool_result` pair in `events.jsonl`, so the event ledger describes
verify work from every interface instead of pi TUI activity only (budget and
loop history no longer depend on which surface ran the check). The evidence
ledger stays authoritative for the outcome — loop streaks read `guard_verify`
outcomes from `verify_runs.jsonl` and skip the mirrored rows, so one attempt
can never count twice.

The optional personal layer lives outside the repository at
`~/.config/protect-context/` (`contract.json`, `config.json`) and is never
written implicitly; see *Making it yours* above.

Ledgers bound themselves instead of growing forever: once `events.jsonl`,
`verify_runs.jsonl` or `journal.jsonl` passes 1 MiB it rotates to
`<name>.1.jsonl`, keeping at most three rotated segments and dropping the oldest.
Reads concatenate the segments oldest-first, so recent rows and the highest
evidence id always survive; `budget` and loop streaks describe the retained
window. Rotation is lesson-aware: `journal` rows tagged `lesson` are carried
into the fresh live file when their segment is dropped, so a durable precedent
cannot be deleted by size-based rotation (each lesson is copied once, and a
copy that somehow fails never breaks the append that triggered the rotation). Session baselines are keyed per session inside `state.json`, so parallel
pi sessions in one repo no longer overwrite each other's watermarks.

Python and TypeScript use the same atomic-directory lease at
`.agent-guard/.lock.d`, with an owner token, PID/hostname checks, bounded
waiting, and conservative stale recovery. Python also takes its legacy local
`fcntl.flock` inside that lease. Evidence-ID allocation, JSONL appends, and
contract read-modify-write operations hold the shared lease, preventing
duplicate IDs and lost contract updates across runtimes. JSON file replacement
uses unique temporary files.

The lease follows the atomic `mkdir` design used by mature lock libraries while
remaining dependency-free and interoperable with Python. A crashed same-host
owner is reclaimable after the stale interval; a stale foreign-host owner fails
closed because process liveness cannot be proved safely without an external
coordinator. Recovery retains a small identity-bound `.lock.d.stale.*`
directory as a durable race guard; it does not block new writers and lives
inside the already-ignored runtime store. Contract mutations also fail closed
when owner rows are malformed, preserving the original file for repair.

## The 12 failure modes and what ships

| # | Failure mode | Shipped mitigation | Enforcement |
|---|---|---|---|
| 1 | Violating instructions | Persistent contract; provenance-aware, change-triggered brief injection; seed-removal refusal at the MCP boundary | Context/advisory |
| 2 | Claiming success without verification | Verification ledger, evidence IDs, status/evidence views, failure digests | Recorded evidence; not semantic proof |
| 3 | Editing too much / scope creep | Git diff audit over tracked, staged, and bounded non-ignored untracked work; safe explicit baselines | Warn/advisory |
| 4 | Misunderstanding the repo | Worktree-root-aware bounded orientation digest in pi, CLI, and MCP; conventions-file discovery | Automatic context + explicit read |
| 5 | Plausible but subtly wrong code | Deterministic contract checklist, verification gate, test-required seed | Heuristic/advisory |
| 6 | Losing earlier context | Persistent journal; owner task anchor; recent trusted decisions re-injected after change and after every compaction (including mid-run threshold/overflow); agent notes re-injected as unverified; `guard_journal` read views; `guard_recall` searches the retained window | Automatic context + explicit read |
| 7 | Repeating corrected behavior | Bounded tagged corrections; trusted corrections re-injected; model-authored entries retained for owner review | Automatic context + trust boundary |
| 8 | Large diffs | Configurable line/file warning and hard-level notifications, status verdict, widget | Warn/advisory |
| 9 | Repetitive debugging loops | Shared bash/evidence streak reconstruction; third identical failing command blocked by default in pi, CLI, and MCP | Hard block at configured threshold |
| 10 | Environment/tool failures | Tool/version and Git-worktree preflight with warning exit outside a repository | Diagnostic |
| 11 | Permission interruptions | One grouped pi confirmation for the frozen risky-command patterns; environment preflight | Interactive confirmation where UI exists |
| 12 | Token/API cost and latency | Bounded brief sections, journal/contract text, evidence digests, untracked reads, output previews, and context watermarks | Automatic budgeting/advisory |

"Shipped" means the mitigation is reachable and tested. It does not turn an
advisory signal into a security or correctness guarantee.

## How it works

### Session lifecycle

The extension is a thin event layer over the shared store. Nothing leaves your
machine: there are no network calls and no LLM calls in the guardrail logic.

| Event | What happens |
|---|---|
| `session_start` | Seed config if missing, scan orientation, freeze the diff baseline, start the status widget |
| `before_agent_start` | Build the brief; inject orientation and/or brief as a hidden message when their digests changed |
| `tool_call` (bash) | Match the nine risky patterns → one grouped confirm; check the loop fingerprint → block at the threshold; record the normalized command, with `ok=false` when the call was refused |
| `tool_execution_start` / `tool_execution_end` | Record bash outcomes and verify results into the shared loop state and evidence ledger |
| `turn_end` | Refresh the widget: diff stats, open loops, evidence count, context percentage |
| `session_compact` | Re-inject trusted context so compaction cannot silently erase it |
| `session_shutdown` | Flush state and clear the widget |

### The brief

The brief is deliberately tiny — a persistent prompt that grows without bound is
its own failure mode. Within two separate, additive budgets — 6 owner lines
plus 12 seed/other lines:

1. newest **owner** constraints fill the 6-line owner budget first,
2. then the frozen seed constraints fill the 12-line seed/other budget,
3. then other entries take whatever the seed budget has left.

Neither class can starve the other: an agent-authored constraint cannot crowd
out a seed, and five owner rules cannot push seed constraints 08-12 out of
every brief. Anything past a budget is announced with a read path. Below the
contract it carries up to 2 owner statements (wants, needs, preferences,
constraints, corrections and plain statements — trusted rows first, an
agent-tagged one is marked `(unverified)` and only fills a line the owner's own
words did not need), up to 3 recent trusted decisions, up to 3 trusted
corrections, up to 2 unverified corrections, up to 2 unverified agent notes,
up to 2 open loops, and the last evidence ID with its trust label (`ok`,
`FAIL`, `UNTRUSTED`), exit code, duration, and a truncated command. An owner
statement gets 200 characters and a truncated one sets the
`journal text truncated` line, so the operative tail of an instruction is never
lost silently. Corrections
the model wrote get their own unverified slot so a newer ordinary note cannot
starve the record of what the owner corrected. When a cap
hides journal entries, the brief points at `guard_recall`. If the owner task's
words match a tag on a trusted entry that did not fit, it also injects at most
two of those matches. `brief_mode: "changed"` (default) injects only when the
rendered digest actually changed, so a quiet turn costs nothing.

### Owner intent

`guard_intent` (and `protect-context intent`) answers "what does the owner
want" without a keyword query. Every substantive prompt the owner types is
journaled as a trusted `owner-prompt` row, and the view counts it: a prompt that
names a want, need, preference, standing constraint (`do not`, `never`,
`avoid`, `must` at the start) or correction is tagged accordingly, and one that
names none still appears as an `owner-statement` rather than vanishing. Journal
entries are also tagged automatically from their text (deterministic regexes, no
model call); the imperative list covers 46 verbs and tolerates a leading
`please`/`now`/`then`/`also`, so "now audit the plugin" and "reinstall the venv"
are read as requests. A prompt row carries **no** `agent` tag — the owner is the
author, so it is trusted. Journal prose written by the agent still needs an
`owner`/`user` attribution before it counts, so the agent's own "I want to
check" is never recorded as owner intent. The view prints one line per row
(`kind · timestamp · text [owner|agent]`) with per-kind counts and an
`owner N · agent M` split, newest first: a page of `[agent]` lines is visibly
the model's report rather than owner authority. The reserved `agent` tag keeps
the last slot when the 8-tag cap is reached, so a crowded tag list can never
promote a model note to trusted memory.

### Local recall

`guard_recall` (and `protect-context recall`) scans the retained window: the
live `journal.jsonl` and `verify_runs.jsonl` files plus the rotated segments
the other readers already concatenate. It does not embed text and it does not
add a vector index.

Filters combine with AND:

- **keywords** — every word must start a word or share a stem with one, in
  journal text, a verify command, or a verify digest. Matching is case-insensitive
  and never mid-word (`arch` does not reach `search`), but inflections meet:
  `retrieving` finds `retrieval`, and `decisions` finds `decision`. A word that is
  itself `ev-NNNN` also matches that evidence id (`ev-7` and `ev-0007` are the
  same id).
- **`--type` / `type`** — `decision`, `correction`, `risk`, `note`, or `evidence`.
- **`--tag` / `tags`** — every tag must be present. Matching is exact and
  case-insensitive. Evidence rows have no tags, so a tag filter excludes them.
- **`--evidence-id` / `evidence_id`** — one exact evidence id.
- **`--cmd` / `cmd`** — the frozen command fingerprint, or a substring of it,
  against verify runs only. Fingerprint matching stays case-sensitive.

Hits are scored with BM25 (`k1 = 1.5`, `b = 0.75`): a term's contribution
saturates, and a long row is discounted against the corpus average, so a verbose
row can no longer outrank a precise one. Text outweighs a command, which
outweighs a digest; an exact fingerprint outweighs a substring. Ties break on
recency, and a bounded boost (`min(uses, 8) × 10`) rewards an entry that has
already been reused — enough to settle a near-tie, never enough to outvote a
better lexical match. When a query of three or more words matches nothing at the
two-word floor, the search widens once to a single shared term and the `Nudge:`
line says `Widened:` so weaker evidence is never presented as a full match. The
displayed page then collapses near-duplicates (IDF-weighted cosine ≥ 0.9 with a
rare-token veto), so five restatements of one decision cannot fill the answer.
With no keywords and no filters, that is simply the newest retained rows. Each
line is labelled `trusted` or `agent`. Agent hits stay unverified. `limit`
clamps to 0–20 and defaults to 5. The command is read-only and does not create
`.agent-guard/` when the store is absent. Rows rotated past the third segment
are already gone and are not searched.

### Evidence and loop detection

`guard_verify` runs your command with the caller's privileges, spools output to
temporary files to bound RAM, and records one append-only entry: ID, exit code,
duration, command, and a digest of the output. Stdin is closed, so a command
cannot read the MCP protocol stream or hang waiting for input. IDs are
allocated inside the shared lease, so parallel pi and CLI processes never
collide. If the ledger's last line was torn by a crash, the next append starts
on its own line instead of gluing two JSON values together.

The report is the part an agent should read. A failure includes the tail of
the output, why that exit happened, and a concrete fix. Exit 0 is recorded
honestly, but a pipeline (no `pipefail`) or a failure mask (`|| true`, `; :`)
is labelled `UNTRUSTED` and must not be cited as proof. The CLI exits 1 for
that case. ANSI color is stripped before the 2000-character digest cap so the
tail stays readable.

Loop detection still stores the frozen fingerprint (whitespace collapsed,
nothing else). The streak key also ignores a trailing `;` outside quotes and a
trailing failure mask, so `pytest -q;` and `npm test || true` count as the
same command as `pytest -q` and `npm test`. An unproven exit 0 — a failure
mask, or a pipeline that never checked its earlier stages — does not reset the
streak; it counts as one more attempt, so masking repeatedly cannot walk a
command back under the threshold. At `loop_block_after` the attempt is
refused, with the prior failure count and a change-strategy nudge.

![Verification workflow: run a command, persist its evidence, and cite the result. With the default threshold, two failures of the same normalized command block its third attempt; only that command succeeding resets its streak](./docs/images/evidence-loop.svg)

### Scope audit

Diffs are computed with `git` porcelain/numstat over tracked, staged, and
bounded non-ignored untracked files, then compared against the configured line
and file thresholds to produce `ok`, `warn`, or `hard`. The pi extension freezes
its baseline at session start, so committing mid-session does not reset the
scope; CLI and MCP default to `HEAD` and accept an explicit baseline.

Untracked content reads are capped at 1,000 files, 1 MB per file, and 8 MB
total, and stop once the hard line threshold is known. A truncated scan is
reported as a bounded scan, promoted to at least a warning (CLI exit `1`), and
its count treated as a lower bound — the widget renders it as `Δ≥`.

### Precedents and satisfaction

Recording is not the same as remembering. Two conventions make a journal entry
reusable instead of merely stored:

- A `lesson` needs trigger words you would actually search: `guard_note` says
  so when a `lesson` carries no tag outside the generic set, because a lesson
  whose only tag is `lesson` is reachable by nothing but its own wording.
- Tag an entry `lesson` and it becomes a **precedent**: the brief re-injects it
  under `precedents:`, ahead of the recent `decisions:` and
  `agent notes (unverified):` caps, so a lesson the owner already paid for
  cannot be pushed out by newer session chatter. Precedents are ranked by how
  much of the current task they answer, then by recency, and the cap is
  `brief_max_precedents` in `config.json` (default 3, 0 disables the section).
  Keep each to one actionable sentence — "when a review lists N follow-ups,
  take all N" — because it is re-sent every turn.
- Tag a correction `satisfied` or `dissatisfied` to record how the owner
  reacted to a decision, plus the action that produced that reaction. The next
  similar situation then starts from the outcome instead of re-litigating it.
  These two words are a fixed vocabulary: a near-miss such as `dissatisfed` is
  normalized on write and reported in the acknowledgement, so owner feedback
  cannot silently decay into an ordinary tag.

Recall is paraphrase-tolerant rather than exact-string: common stopwords are
dropped, **tags are searched as synonyms**, and terms are weighted by rarity
(Lucene IDF), so a word that appears in every entry cannot outvote the one word
that answers the question. "why did the owner get annoyed?" therefore reaches a
lesson tagged `annoyed` even though the text says "prefers the broad fix" — the
tag is the owner's own word, written once and reused forever. One tag match also
satisfies the multi-word floor on its own; otherwise a three-or-more-word query
needs two real matches, and falls back to a single shared term only when that
finds nothing (reported as `Widened:`).

Matching is word-boundary aware and morphology-aware: `old` no longer hits
`threshold` or `search`, `patch` still finds `patches`, and now `retrieving`
finds `retrieval` — previously the direction only worked from the shorter form,
so an inflected query returned nothing at all. The stemmer is a conservative
suffix stripper rather than Porter, because Porter turns `organization` into
`organ` and starts answering `organic`.

Length no longer buys relevance: scoring is BM25, so term frequency saturates
and each row is normalised against the corpus average. Measured on the fixtures
in `tests/test_recall.py`, a 60-word filler row used to beat a precise 5-word
row; it now ranks below it.

When a query is given, past successful `bash` commands from `events.jsonl` join
the hits as `command · re-run to verify · ran N× · last ok exit 0` rows at half
weight — a repeated chore ("copy these to that folder") starts from the command
that already worked instead of being re-derived, and the row carries the
outcome the command last had, because a command that ran is not a command that
still works. A family whose last observed run failed is demoted and labelled
`last FAILED — change it before reuse`; refused or declined calls are never
reused. Non-shell tools leave their own trail: a `read`/`edit`/search call
records the path or pattern it touched, so the same query also returns
`read · reuse · used 2× · <path>` hints — "you were here before" instead of
re-deriving where the code lives. Those keys are paths, never commands, and only
`bash` and `guard_verify` rows may form a loop streak, so a hint can never be
blocked as a repeated failure.

### Trust and provenance

Direct CLI and pi slash-command contract writes are treated as owner input.
MCP/model journal writes are forcibly tagged `agent`: they never enter the
trusted `decisions:`/`corrections:` sections. They are not discarded either —
the brief shows the newest two under `corrections (unverified):` when they
are corrections, else `agent notes (unverified):`, clearly labelled and capped
shorter than trusted text, and `guard_journal` returns the
full stored entry. That keeps the model's own reasoning recoverable after a
compaction without granting it authority. CLI and pi slash-command journal
entries are trusted. Untagged
legacy entries are treated as trusted for backward compatibility, because the
frozen journal schema has no dedicated author field.

This is a provenance convention, not authentication. A model that already has
shell access can invoke the CLI and appear on that trusted path; use host-level
tool permissions when the distinction must be a security boundary.

All newly stored contract, journal, and tag text is normalized to one bounded
line, and legacy values are normalized again when rendered. This prevents
terminal-line forging and unbounded persistent prompt growth; it does not make
untrusted prose safe to follow.

### Context budget

Every injected and printed block has a cap: brief sections, journal and contract
text, evidence digests, orientation output, and previews. Context-watermark
notifications fire at `ctx_warn_pct` and above, and the widget always shows the
current percentage. The result is a guardrail layer whose own cost stays
constant while a session grows.

## Development and validation

```sh
.venv/bin/pytest -q                          # Python suites
npm run typecheck                            # extension types (tsc --noEmit)
npm test                                     # extension unit tests (node --test)
.venv/bin/python -m compileall -q src        # byte-compile check
.venv/bin/python -m build --outdir /tmp/protect-context-dist
```

`npm run check` runs the typecheck and the extension tests together. CI
(`.github/workflows/check.yml`) runs the same suite plus pytest on Python 3.10
and 3.12 for every push and pull request, so a green claim no longer depends on
the operator remembering to type the command. The
definition-of-done checks are run twice consecutively before release. The dated
audit records the observed counts, integration probes, and package smoke test
instead of leaving stale numbers in this README.

| Path | Contents |
|---|---|
| `src/protect_context/` | Store, contract, journal, recall, verify, loops, diff scope, orientation, preflight, budget, report, CLI, MCP server |
| `extension/` | pi entry point (`index.ts`) and pi-import-free `lib/` modules |
| `tests/` | pytest suites, including a fastmcp in-memory client smoke over every MCP tool |
| `extension/test/` | `node --test` suites for fingerprinting, risk patterns, loops, brief digest, widget, git parsing, config |
| `SPEC.md` | Frozen v1.0 contract — structure, defaults, and definition of done |

## Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| No brief appears in pi | Digest unchanged (`brief_mode: "changed"`) and nothing new to say | Expected on quiet turns; set `brief_mode: "always"` to see it every turn |
| `Δ?` in the widget | Not a Git worktree, so no diff baseline | Run inside a repository, or use the CLI with an explicit `--baseline` |
| `Δ≥` in the widget | Bounded untracked scan hit a cap | Treat the count as a lower bound; narrow the scan or review scope manually |
| Loop never blocks | Commands differ by flags or paths. A trailing semicolon or an or-true failure mask shares a streak; other edits do not | Compare with `loops` / `guard_loop_check`. Change the command for real — do not mask the failure |
| Verify says UNTRUSTED, or CLI verify exits 1 after exit 0 | The shell status is only the last stage of a pipeline, or the command forces success with `true` | Re-run without the mask. For a pipeline the tool returns the exact rewrite to paste (`bash -o pipefail -c '<command>'`). Do not cite that evidence id |
| Verify timed out, or an MCP session stalled on an old build | The command waited on stdin, or it exceeded timeout_s (clamped to 1–900, recorded as exit 124) | Current builds close stdin. Fix the hang or pass a larger `timeout_s` |
| Agent forgot its own earlier decision after a compaction | The brief shows only the newest 2 agent notes (plus 2 unverified corrections), 120 chars each | Read the full entry with `guard_journal`, or search tags and evidence with `guard_recall` |
| No guard block after an automatic compaction | Host emits no `context` event, so mid-run re-assertion cannot run | It returns at the next user prompt; check the host supports the `context` hook |
| `task:` line is wrong or missing | Auto-capture ignores short prompts and slash commands, and an owner task always wins | Set it explicitly with `/guard-task <text>` or `/guard-task --clear` |
| `PC_SESSION_ID` changes nothing in evidence | It scopes ledger *views*, not `state.json` | Expected: state is project-global by design |
| MCP tool missing in host | Host is not launching the PyPI server, or a checkout server is not using its venv interpreter | Use `command` `uvx` and `args` `["protect-context", "mcp"]`. From a checkout, point `command` at `.venv/bin/python` and pass `-m protect_context.mcp_server` |
| Extension does not load | Node older than 22.19 or pi not restarted | Check `pi list`, then restart; use `pi -ne` to start without extensions |
| Contract edit rejected over MCP | Removing a frozen seed constraint | Seeds are protected; use the CLI or a pi slash command as the owner |
| Published, but `pi.dev/packages` says "No packages match" | The gallery index is built from npm search, and npm drops search documents whose `downloads.monthly` is `0`. A publish rewrites that document with the download figure of that moment, so publishing before npm's first download rollup pins it at `0` | Run `scripts/check-discoverability.sh`; if the document's downloads are `0` while the downloads API reports traffic, publish once the rollup exists (npm re-crawls documents on its own as well, typically within a week) |

## Limitations and security boundary

#### Shell execution

- `guard_verify` deliberately invokes a shell with the caller's privileges. It
  can modify files, access the network, or disclose data. The pi layer asks for
  confirmation only when one of the frozen regex patterns matches; the MCP layer
  relies on host approval. Neither is a shell parser or a sandbox.
- MCP annotations are untrusted hints. A client may ignore them. Do not expose
  `guard_verify` to an untrusted model without a real host sandbox/approval
  policy.

#### Evidence

- An evidence record proves only that one command returned one exit code. It is
  not cryptographically bound to a commit/worktree, has no freshness policy, and
  does not prove the claimed behavior. Exit 0 from a pipeline or a failure mask
  is labelled UNTRUSTED in the report for that reason. The stored `ok` field
  stays the shell's real status.

#### Scope

- The pi extension freezes its diff baseline at session start, so committing
  mid-session does not reset its scope. CLI/MCP audits default to current
  `HEAD`; pass them an explicit baseline for cross-commit scope. Binary files
  count as files but zero lines.
- Untracked-file content reads are capped at 1,000 files, 1 MB per file, and
  8 MB total, and stop once the hard line threshold is known. Output explicitly
  reports a bounded scan, promotes it to at least a warning/CLI exit 1, and
  treats the truncated count as a lower bound.

#### Determinism

- The frozen brief carries at most 12 constraints, 3 trusted decisions, 3
  trusted corrections, 2 unverified corrections, and 2 agent notes, plus at
  most 2 trusted tag matches
  when the owner task names a journal tag the caps hid. Overflow is visible
  (each section announces what it hid) and points at `guard_journal` and
  `guard_recall`, but hidden entries are not enforced by context injection.
- Frozen fingerprint normalization collapses whitespace everywhere, including
  inside quoted shell strings. Semantically different commands can therefore
  share a loop fingerprint.
- The deterministic contract checker is keyword coverage, not program analysis.
  Treat every `addressed` result as a review prompt, not proof.

#### Compaction

- Re-injection is only as good as the store. A constraint, decision, or task
  that was never written down cannot be restored, and the brief is a bounded
  pointer rather than a transcript; `guard_journal` returns the full entry.
- A mid-run compaction (threshold or overflow recovery) resumes the turn
  through `AgentStart`, where `before_agent_start` does not run. The extension
  arms a `context` hook on `session_compact` and re-asserts the block on every
  request until a persisted one is back in the conversation. On a host that
  does not emit `context`, the block returns at the next user prompt instead.
- Task capture stores the first substantive prompt (≤400 chars) in
  `.agent-guard/state.json`. That is conversation content: this repository tracks
  the whole store, so review `state.json` and `journal.jsonl` before publishing
  or mirroring it, and clear the anchor with `/guard-task --clear`.
- Agent notes are unverified context, never authority. A model that journals
  "ignore the contract" is shown that sentence back under an explicitly
  unverified heading; treat it as data, and keep owner constraints in the
  contract where they are trusted.

#### Store

- `state.json` is project-global. Atomic replacement prevents torn JSON, but
  simultaneous sessions can still overwrite notification/session state; use
  `PC_SESSION_ID` to separate ledger views, not state files.
- Commands and the last 2,000 output characters are stored verbatim. There is
  no automatic secret detector or redactor; never put credentials in commands or
  verification output.
- JSONL ledgers rotate once the live file passes 1 MiB, keeping three older
  segments. Recall and the other readers see that retained window only; rows
  rotated past the third segment are gone. Output views stay bounded.
- Python verification bounds RAM by spooling output to temporary files, but a
  very noisy command can consume temporary disk until it exits. On Windows,
  killing the direct process cannot guarantee that every descendant exits.

## Design sources

The implementation was checked against primary or professional sources:

- Git's stable porcelain/other-file interfaces for non-ignored untracked
  enumeration: [git-status](https://git-scm.com/docs/git-status) and
  [git-ls-files](https://git-scm.com/docs/git-ls-files).
- Pi's documented lifecycle, tool, context, and UI APIs:
  [Pi extension documentation](https://pi.dev/docs/latest/extensions).
- The mature `proper-lockfile` design, which uses atomic `mkdir` rather than
  `O_EXCL`: [moxystudio/node-proper-lockfile](https://github.com/moxystudio/node-proper-lockfile).
  The package itself was not added because the frozen extension requirement is
  zero runtime dependencies and the lock must interoperate with Python.
- Operational-safety evidence motivating explicit constraints, failure
  transparency, and safe-halt behavior: [What Breaks When LLMs Code?](https://arxiv.org/abs/2605.30777)
  (ASE 2026), plus evidence-conditioned execution results in
  [Preventing Premature Commitment in Coding Agents](https://arxiv.org/abs/2607.28815).
- MCP's own warning that annotations are risk vocabulary rather than
  enforcement: [Tool Annotations as Risk Vocabulary](https://blog.modelcontextprotocol.io/posts/2026-03-16-tool-annotations/).

## Non-goals

No network or LLM calls are made by the guardrail logic itself. It is not a
sandbox, policy engine, auto-fixer, secret manager, or replacement for pi/MCP
host permissions. Recall is a local scan of the retained JSONL window: the
suite does not embed journal or evidence text and does not add a vector
database. The suite complements host permissions with durable context,
evidence, telemetry, and narrowly scoped blocking.

If this saved you a re-run, a [star](https://github.com/XJTLUmedia/Protect-Context) helps other people find it.

[![Star history](https://api.star-history.com/svg?repos=XJTLUmedia/Protect-Context&type=Date)](https://star-history.com/#XJTLUmedia/Protect-Context&Date)

## License

MIT — see [`LICENSE`](./LICENSE). Copyright (c) 2026 XJTLUmedia.
