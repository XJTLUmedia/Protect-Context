# SPEC — protect-context · Agent Guardrail Suite

**Version:** 1.0 · **Status:** FROZEN 2026-08-28 (amended 2026-11-03: task anchor, unverified agent notes, `guard_journal` read tool, mid-run re-injection, `input`/`context` events) · **Owner directive:** treat the 12 failure modes below as standing goals and build tooling (pi extension + MCP server + CLI) that measurably fixes or improves each, as far as possible.

## 0. Mission & principles

protect-context is a guardrail suite for AI coding agents. Three deliverables, one shared on-disk store:

1. **pi extension** (`extension/`, TypeScript) — the *automatic* layer: event-driven telemetry, loop blocking, diff budget, context budget, contract/correction re-injection, risk confirm, persistent status widget. Requires zero model cooperation.
2. **MCP server** (`src/protect_context/mcp_server.py`, Python + fastmcp) — the *explicit/portable* layer: same store, callable from pi (via pi-mcp-adapter `.mcp.json`) and any MCP host.
3. **CLI** (`python -m protect_context …`) — same verbs for scripts/skills; doubles as the test harness and the no-MCP fallback.

Principles: advisory-first (nudge before block); block only for repeated identical failures and risky commands; every threshold configurable in `.agent-guard/config.json`; all outputs compact (token discipline is goal #12); no network calls, no LLM calls inside the tooling.

## 1. The 12 goals → shipped mitigations (traceability matrix)

| # | Failure mode | Mitigation (shipped feature) | Component |
| --- | --- | --- | --- |
| 1 | Violating instructions | Contract store (`.agent-guard/contract.json`); compact contract re-injected into LLM context when it changes; `guard_contract` tools/CLI | ext + core |
| 2 | Claiming success without verification | `guard_verify` evidence ledger (`.agent-guard/verify_runs.jsonl`); status shows evidence count + last run; contract seed forbids unevidenced success claims | ext + core |
| 3 | Editing too much / scope creep | Session diff tracking vs baseline (files/lines via git); warn thresholds; widget shows Δ; contract seed bans unrelated refactors | ext + core |
| 4 | Misunderstanding repo before acting | `guard_start`/orientation brief: repo tree, languages, conventions files (CLAUDE.md/AGENTS.md/README), injected at session start | ext + core |
| 5 | Plausible-but-subtly-wrong code | `guard_contract_check` deterministic checklist over a change summary; verify gate; test-required contract seed | ext + core |
| 6 | Losing earlier context/constraints | Persistent journal (`.agent-guard/journal.jsonl`, decisions/notes); owner task anchor; trusted entries re-injected on change and after every compaction (including mid-run threshold/overflow); model notes re-injected as explicitly unverified; `guard_journal` reads the full text; survives restarts | ext + core |
| 7 | Repeated corrections of same behavior | Corrections journal entries with tags, re-injected like contract; `guard_note type=correction` | ext + core |
| 8 | Large diffs → review burden | Diff gates: warn 400 lines / 10 files, hard 800 lines (notify + widget + status verdict, split advice) | ext + core |
| 9 | Repetitive debugging loops | Command fingerprint streaks; identical failing bash blocked on 3rd attempt with change-strategy reason | ext + core |
| 10 | Environment/sandbox/tool failures | `guard_preflight` (tool presence + versions, git repo check); structured error capture in events | core |
| 11 | Too many permission interruptions | One grouped risk-confirm for dangerous bash (replaces ad-hoc surprises); preflight reduces mid-task discovery | ext |
| 12 | Token/API cost & latency | Context usage % watermarks + /compact advice; char budget on tool telemetry; brief injection only-on-change; compact output formats everywhere | ext + core |

## 2. Shared store: `.agent-guard/` (formats FROZEN)
```
.agent-guard/
  config.json         thresholds (below)
  contract.json       {"version":1,"constraints":[{"id","text","added","source"}]}
  journal.jsonl       {"ts","type":"decision|correction|risk|note","text","tags":[]}
  events.jsonl        {"ts","session","kind":"tool_call|tool_result","tool","ok":bool|null,
                       "ms":num|null,"out_chars":int|null,"cmd":str|null,"exit":int|null}
  verify_runs.jsonl   {"id":"ev-0001","ts","session","cmd","exit","ok":bool,"digest","ms"}
  state.json          {"current_session":{"id","started","git_head"},
                       "sessions":{"<id>":{"started","git_head","brief_digest",
                                           "notify_watermarks":{"ctx_pct","diff_lines","diff_files"},
                                           "updated"}},
                       "counters":{},
                       "task":{"text","source":"prompt|owner","ts"}}   # optional
```

- `cmd` is stored for bash rows on both sides of a call: the fingerprint-normalized
  command on `tool_call`, and again on `tool_result` (where `ok`/`exit` are known).
- A refused bash call (loop block, declined risk confirm) is recorded as a
  `tool_call` row with `cmd` + `ok=false` and no matching `tool_result`; loop
  streaks read `tool_result` rows only, so a refusal never counts as a run.

### Personal layer (outside the project store)

Built-in seeds and defaults live in code and are identical for every install.
Above them, an **optional personal layer** applies to every project on the
machine, and the project store stays authoritative:

```text
built-in defaults  <  ~/.config/protect-context/  <  .agent-guard/
                        contract.json                 contract.json
                        config.json                   config.json
```

- Directory: `$PC_USER_DIR`, else `$XDG_CONFIG_HOME/protect-context`, else
  `~/.config/protect-context`. Only these two files are read; the layer never
  holds events, evidence, or session state.
- Precedence: a project row/pair with the same id overrides the personal one.
  Personal constraints identical in text to a project row are not listed twice.
- Config: the personal layer is weaker than the project. Because a seeded
  `config.json` records every default value, a project value **identical to the
  built-in default means "no opinion"** and the personal value still applies;
  any different value is an explicit project choice and wins.
- Owner-only surface: the layer is never seeded or repaired automatically. A
  missing file means "no personal constraints"; an unreadable one is ignored in
  memory and left untouched. Agent-callable surfaces (`guard_contract` MCP tool)
  write the project layer only.
- Writes: `contract add|remove … --global` (CLI) and `/guard-contract
  add|remove … --global` (pi) target the personal layer. Each layer is mutated
  under its own store lease, so two projects never share the wrong lock.
- Removing a personal id needs `--global`; a project-scope remove reports that
  the id lives in the personal layer instead of deleting it.

### Store row rules

- `state.json` holds one baseline **per session** under `sessions[<id>]`, so two
  pi sessions in the same project cannot clobber each other's brief digest or
  watermark counters; `current_session` names the most recently started one.
  A v1 flat `brief_digest`/`notify_watermarks` pair is migrated into that
  session's entry on read (the file is only rewritten on the next save). The
  file is bounded to the 8 newest sessions (`SESSION_KEEP`), always keeping the
  current session.
  current session.
- **Ledger bounding:** `events.jsonl`, `verify_runs.jsonl` and `journal.jsonl`
  rotate to `<stem>.1.jsonl` … `<stem>.3.jsonl` once a live file passes 1 MiB
  (`LEDGER_MAX_BYTES`, `LEDGER_SEGMENTS`), dropping the oldest segment. Readers
  concatenate oldest-first, so "last N rows" and the maximum `ev-NNNN` id (the
  basis for allocating the next id) always survive; totals that scan a whole
  ledger (`budget`, loop streaks) describe the retained window.
- **Fingerprint normalization:** trim, collapse all whitespace runs to single spaces. Nothing else.
- **Digest:** last ≤2000 chars of combined stdout+stderr.
- **Locking:** best-effort `fcntl.flock` on `.agent-guard/.lock` around appends (both implementations).
- **Session label:** extension uses its session id; Python uses env `PC_SESSION_ID` else `"default"`.
- `.agent-guard/` is gitignored except nothing — the whole dir is runtime state; defaults live in code on both sides (pinned identical by tests: same 12 constraint ids and texts). Rotated ledger segments (`<stem>.N.jsonl`) are runtime state too and stay ignored.

### config.json defaults (both sides identical)

```json
{
  "loop_block_after": 3,
  "diff_warn_lines": 400,
  "diff_hard_lines": 800,
  "diff_warn_files": 10,
  "ctx_warn_pct": 70,
  "brief_mode": "changed",
  "risk_confirm": true,
  "preflight_tools": ["git", "python3", "pip", "node", "npm", "rg", "pytest"]
}
```

## 3. Python package `src/protect_context/`

Modules: `store.py` (paths, ensure, jsonl append/read + flock, config load/merge, state), `contract.py` (CRUD + DEFAULT_CONTRACT), `journal.py`, `loops.py` (streaks from events), `diffscope.py` (git numstat parser + verdict), `verify.py` (subprocess runner + evidence ledger), `preflight.py`, `budget.py` (chars/token estimate: chars/4, per-tool breakdown), `orientation.py` (tree ≤2 levels, language counts by extension, conventions-file detection), `report.py` (status dashboard), `cli.py`, `mcp_server.py`, `defaults.py` (DEFAULT_CONTRACT, DEFAULT_CONFIG — single source for both).

CLI verbs (mirror MCP tools; exit 0 ok / 1 warning triggered / 2 error):
`init · status · verify CMD · evidence · contract list|add TEXT|remove ID · note TYPE TEXT [--tags a,b] · loops · diff · preflight · budget`

`pyproject.toml`: name `protect-context`, `requires-python >=3.10`, deps `fastmcp>=3,<4`; dev: `pytest`. Dev setup: `python3 -m venv .venv && .venv/bin/pip install -e '.[dev]'`.

## 4. MCP tools (names FROZEN; all return compact text, last line = actionable `Nudge:`)

| Tool | Args | Returns |
| --- | --- | --- |
| `guard_status` | — | dashboard: session, Δdiff, loop streaks, evidence count, contract size, last verify |
| `guard_verify` | `command: str, timeout_s: int = 180` | evidence id, exit, digest; records to verify_runs.jsonl |
| `guard_evidence` | `limit: int = 5` | recent verify runs |
| `guard_contract` | `action: "list"\|"add"\|"remove", text?, id?` | updated contract view |
| `guard_note` | `type: "decision"\|"correction"\|"risk"\|"note", text, tags: [str] = []` | ack |
| `guard_loop_check` | — | failing-command streaks + advice |
| `guard_diff_audit` | `baseline: str = null` | numstat vs HEAD/baseline, verdict vs thresholds |
| `guard_preflight` | — | tool presence/versions, git-repo check |
| `guard_budget` | — | session tool-output chars, est. tokens, top-5 tools |

`guard_verify` runs via `subprocess.run(cmd, shell=True, timeout=timeout_s, capture_output=True)`; never raises on nonzero exit — it RECORDS it (that is the point).

## 5. pi extension (`extension/`)

Entry `extension/index.ts` + pure-logic modules in `extension/lib/` (no pi imports → testable via `node --test --experimental-strip-types`). **Zero npm dependencies** (node builtins only); `typebox`/`@earendil-works/pi-coding-agent` type imports are provided by the pi runtime. Loaded via jiti — no build step.

Event behaviors (all thresholds from config):

- `session_start`: ensure store; new session id; record git HEAD (null if no repo); load config/contract/journal; render widget.
- `before_agent_start`: build compact brief (`task:` line, contract ≤12 lines, 3 most-recent trusted decisions, 3 trusted corrections, 2 unverified model notes, open loops ≤2, last evidence, plus a read-path line when caps hid or truncated entries) → if `brief_mode=="changed"` and sha1(brief)==`brief_digest`, skip; else inject `{customType:"guard-brief", content, display:false}`, save the digest, and clear any pending mid-run re-injection.
- `context`: only while a mid-run re-injection is pending (armed by `session_compact`) — if the conversation holds no persisted `guard-brief` message, append `{role:"custom", customType:"guard-brief", content, display:false}` to `event.messages`. The result is per-request, so it is re-applied on each request until a persisted block is seen; with no pending flag the handler is an O(1) no-op.
- `input`: capture the first substantive owner prompt (≥20 chars, not a slash command) as `state.task` (source `prompt`) and invalidate the brief digest, so `task:` is re-injected on that same turn. `/guard-task` writes source `owner` and always wins; short follow-ups ("continue") never replace a task.
- `tool_call` (bash only): (a) risk patterns → `ctx.hasUI && risk_confirm` → single `ctx.ui.confirm("Risky command", …)`; no-UI → log only, never block; a declined confirm appends `tool_call` (`cmd`, `ok=false`); (b) loop check: prior failed attempts for fingerprint ≥ `loop_block_after - 1` → append `tool_call` (`cmd`, `ok=false`) and return `{block:true, reason:"guard: '<cmd>' already failed N times this session — do not re-run unchanged; change approach or read the error. (Raise loop_block_after in .agent-guard/config.json to override.)"}`; (c) else append `tool_call` event with `cmd`.
- `tool_execution_start`: record start time by toolCallId (map, pruned on end).
- `tool_execution_end`: append `tool_result` event (`ok=!isError`, ms, out_chars=sum of text content lengths; bash adds cmd fingerprint + exit); update widget.
- `turn_end`: `ctx.getContextUsage()` → notify once per 10% watermark ≥ `ctx_warn_pct` (suggest /compact); `git diff --shortstat HEAD` → threshold notifies (warn/hard, once per level); update widget.
- `session_compact`: invalidate `brief_digest` and `counters.orient_sha1` (the next turn re-injects even unchanged text) and arm the `context` re-assertion, because a threshold/overflow compaction resumes the run via `AgentStart`, where `before_agent_start` never fires.
- `session_shutdown`: persist state.json.
- Widget (single line): `PC Δ+123L/4f 1loop ev2 ctx41%`.

Risk patterns (deny-confirm list): `rm -rf /`, `rm -rf ~`, `git push --force` (not `--force-with-lease`), `git reset --hard`, `mkfs`, `dd of=/dev/`, `chmod -R 777 /`, `curl|…| bash/sh`, `sudo rm`.

Commands: `/guard-status`, `/guard-contract add|remove|list [text]`, `/guard-verify <cmd>`, `/guard-note <type> <text>`, `/guard-task [<text>|--clear]` (show/replace/clear the owner task anchor), `/guard-report` (full session summary, printed).

Model-callable tools (typebox params): `guard_verify`, `guard_note`, `guard_journal` (read-only; `limit` clamped to 0-20 with default 5, optional `type` filter; renders one line per entry plus a `Nudge:` tail, mirroring the MCP tool), `guard_contract_check` (deterministic checklist: for each constraint, mark addressed/unclear from the supplied summary text — heuristic keyword coverage, no LLM), `guard_status` (includes journal totals so the read path is discoverable).

Constraints: **no background processes/sockets/timers from the factory** (defer to `session_start`); idempotent `session_shutdown` cleanup; guard every `ctx.ui.*` with `ctx.hasUI`; never throw from event handlers (catch → `ctx.ui.notify`).

## 6. Seed contract — DEFAULT_CONTRACT (FROZEN text; ids used in tests)

1. `01-obey-instructions` — Obey the owner's explicit instructions and stated constraints exactly; when instructions conflict, ask instead of guessing.
2. `02-evidence-before-success` — Never claim success without citing a fresh verification run (evidence id or pasted output) for the exact claim.
3. `03-stay-in-scope` — Change only files the stated task requires; no unrelated refactors, reformatting, or "improvements".
4. `04-orient-first` — Before the first edit in an unfamiliar area, read the relevant files and conventions; never code from guesses.
5. `05-simplest-correct` — Prefer the simplest implementation satisfying stated behavior; add or update a test for every behavior change.
6. `06-journal-decisions` — Record durable decisions and constraints in the journal when made; re-read them before resuming work.
7. `07-log-corrections` — When the owner corrects behavior, log a tagged correction; check corrections before similar work.
8. `08-keep-diffs-reviewable` — Keep diffs small: split work into logical steps; treat 400+ changed lines per task as a stop-and-split signal.
9. `09-no-identical-retries` — After 2 failures of the same command, change approach or gather new information; never re-run identical failing commands.
10. `10-preflight-env` — When tools behave unexpectedly, run preflight (tool presence/versions) before blaming code.
11. `11-batch-operations` — Batch related shell operations; prefer commands that avoid per-command permission prompts.
12. `12-budget-context` — Keep tool outputs bounded (head/tail/digest); use targeted reads; avoid re-reading large files.

## 7. Testing requirements

Python (pytest, in `.venv`): store roundtrip + flock; contract CRUD + defaults identical to TS (12 ids + exact texts); fingerprint + loop streaks; numstat parser + verdicts; verify runner (uses `true`/`false` shell commands); budget math; orientation digest; CLI smoke for every verb (tmp HOME-cwd fixture so `.agent-guard` is created in a temp dir); **fastmcp in-memory Client smoke over ALL 9 MCP tools**; cross-format: Python parses a TS-format events.jsonl fixture string.

TypeScript (`node --test --experimental-strip-types`, tests in `extension/test/`, lib modules stay pi-import-free): fingerprint; risk pattern list (match/non-match cases); loop streak logic; brief digest stability; widget render; numstat/shortstat parser (fixture strings); config load/merge defaults.

Typecheck: `npx -y typescript@latest tsc --noEmit` on `extension/` with a minimal `tsconfig.json` (node builtin types via `@types/node` — if this proves flaky, downgrade to best-effort and record the result; do NOT add runtime deps).

## 8. Docs requirements (README.md, written in Polish phase)

Quickstart (extension install = copy/symlink into `~/.pi/agent/extensions/protect-context` or `.pi/extensions/`; MCP = `.mcp.json` snippet with `command: .venv/bin/python, args: [-m, protect_context.mcp_server]` + generic-host JSON; CLI usage); the §1 traceability table reproduced; configuration reference; limitations (advisory-first; blocking scope; no sandbox); non-goals.

## 9. Non-goals

No network/LLM calls. Not a sandbox. Not an auto-fixer. No secrets in the store. Does not replace pi's own permissions — complements them.

## 10. Definition of Done

1. pytest green (all suites) AND node tests green — twice consecutively.
2. All 9 MCP tools callable via fastmcp client smoke.
3. Extension module compiles under jiti semantics (typecheck best-effort documented) and lib tests pass on node 22.
4. README complete with the 12-goal mapping.
5. git repo initialized with one conventional initial commit (`.gitignore`: `.agent-guard/`, `.venv/`, `__pycache__/`, `node_modules/`).
6. Every §1 row traceable to shipped code + at least one test or documented manual verification.

## 11. Parallel-writer ownership map (build time)

- **PY agent** owns: `src/**`, `tests/**`, `pyproject.toml`, `.gitignore`, `.venv/` — nothing else.
- **TS agent** owns: `extension/**` — nothing else.
- Verify/fix/polish agents run sequentially and may touch anything under the repo root (never `SPEC.md`).
- Nobody: edits `SPEC.md`, runs `git init`/`git commit` except the Polish agent.
