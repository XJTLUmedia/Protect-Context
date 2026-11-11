# SPEC — protect-context · Agent Guardrail Suite

**Version:** 1.0 · **Status:** FROZEN 2026-08-28 (amended 2026-11-03: task anchor, unverified agent notes, `guard_journal` read tool, mid-run re-injection, `input`/`context` events; amended 2026-11-06: local `guard_recall` / `recall` over the retained JSONL window, no embeddings; amended 2026-11-09: `guard_intent` / `intent` owner-intent view — wants, needs, preferences, and corrections captured as `owner-*` tags, an intent-bearing owner prompt becoming a trusted journal row, ≤2 owner statements in the brief, and verify runs mirrored into `events.jsonl` with the evidence ledger authoritative for outcomes; amended 2026-11-11: a fixed English/中文 term bridge for recall, still no embeddings, and no change to the stored row format) · **Owner directive:** treat the 12 failure modes below as standing goals and build tooling (pi extension + MCP server + CLI) that measurably fixes or improves each, as far as possible.

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
| 9 | Repetitive debugging loops | Command fingerprint streaks; identical failing bash blocked on 3rd attempt with change-strategy reason. A masked exit 0 (`cmd \|\| true`) or a pipeline that checked only its last stage counts as an unproven attempt, so masking cannot walk a command back under the threshold | ext + core |
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
- Python `guard_verify` (MCP and CLI) mirrors each run into `events.jsonl` as a
  `tool_call`/`tool_result` pair (`tool="guard_verify"`, same `cmd`/`ok`/`exit`/`ms`),
  so the event ledger describes verify work from every interface, not only pi
  TUI activity. `verify_runs.jsonl` stays
  authoritative for the OUTCOME: loop streaks read `guard_verify` outcomes from
  the evidence ledger and skip these mirrored event rows, so one attempt can
  never count twice.

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
- Ids are `NN-<slug>` and identical on both surfaces (2026-11-11). The pi
  surface used to write a bare number (`13`) while the CLI wrote `13-never-run-…`
  for the same rule, so one store held two id formats and a remove had to know
  which surface created the row. The slug is the first four ASCII words; text
  whose ASCII remnant says nothing keeps its own characters instead
  (`永远不要在生产库执行破坏性 SQL` -> `13-永远不要在生产库-sql`, not `13-sql`).
  English text keeps byte-identical ids.

### Store row rules

- `state.json` holds one baseline **per session** under `sessions[<id>]`, so two
  pi sessions in the same project cannot clobber each other's brief digest or
  watermark counters; `current_session` names the most recently started one.
  A v1 flat `brief_digest`/`notify_watermarks` pair is migrated into that
  session's entry on read (the file is only rewritten on the next save). The
  file is bounded to the 8 newest sessions (`SESSION_KEEP`), always keeping the
  current session.
  current session.
- **Rotation keeps lessons:** a `journal` row tagged `lesson` is copied into the
  fresh live file when its segment is dropped, once, so a durable precedent
  cannot be deleted by size-based rotation.
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
  "loop_reset_after_s": 300,
  "diff_warn_lines": 400,
  "diff_hard_lines": 800,
  "diff_warn_files": 10,
  "ctx_warn_pct": 70,
  "brief_mode": "changed",
  "brief_max_precedents": 3,
  "brief_checks": true,
  "brief_check_max": 3,
  "brief_check_timeout_s": 5,
  "risk_confirm": true,
  "preflight_tools": ["git", "python3", "pip", "node", "npm", "rg", "pytest"]
}
```

### Amendment 2026-11-11 — correction checks

The owner asked whether feedback actually changes behaviour next session; the
store could record a correction but never test it. A **correction** may now
carry one shell command that proves the rule still holds
(`guard_note correction "…" --check "npm run check"`, CLI `note --check`, MCP/pi
`guard_note` param `check`, ≤200 chars, one line). The brief runs at most
`brief_check_max` of them (newest first) at session start and prints
`- <journal id>: HONORED|VIOLATED|TIMEOUT · <command>` — the id is citable, and
the command is always shown, so a check never runs invisibly.

This is the one place a *read* surface executes store content, and the store is
committed to the repository, so the limits are explicit rather than implied:
only `correction` rows, only checks written through the explicit flag, at most
`brief_check_max`, each killed at `brief_check_timeout_s`, with stdin and both
streams discarded (a proving command answers with its exit code, not its log).
`brief_checks: false` (or `brief_check_max: 0`) stops execution and the brief
says `checks: not run (brief_checks=false)` — a disabled check is never silently
absent. `shell=True` is by design, exactly as in `guard_verify` (SPEC §4): the
command runs verbatim with the caller's own privileges. An owner who does not
want store content executed must set `brief_checks: false`.

## 3. Python package `src/protect_context/`

Journal entry shape stays frozen (`ts`, `type`, `text`, `tags`); two tag
conventions make an entry reusable rather than merely stored:
`lesson` marks a durable precedent that the brief re-injects every turn (ranked
by task relevance, cap `brief_max_precedents`, default 3, 0 disables, ahead of
the recent decision/note caps), and `satisfied` / `dissatisfied` on a
correction records how the owner reacted plus the action that caused it.
Recall is paraphrase-tolerant: stopwords are dropped, keywords match only at a
word start (`old` does not hit `threshold`, `patch` still finds `patches`), tags
are searched as synonyms (one tag match satisfies the multi-word floor on its
own), hits are rarity-weighted with integer idf math mirrored in both runtimes so
the two surfaces cannot disagree (a query of 3+ words otherwise needs 2 real
matches), and a query also reaches past successful `bash` commands from
`events.jsonl` as half-weight `command` rows — paired with their last
`tool_result` outcome (by command when the result names one, otherwise only when
exactly one call is outstanding, so an overlap is never guessed), with
`last FAILED` families demoted — plus `file` rows for non-shell tools (a
`read`/`edit`/search call records the path or pattern it touched) so a repeated
chore reuses what already worked instead of re-deriving it. Only `bash` and
`guard_verify` rows may form a loop streak; reuse keys are paths, not commands.
Search tools are not indexed (`QUERY_TOOLS` in `recall.py`, mirrored in
`recall.ts`): the key a search records is the query itself, so indexing it let a
query answer itself — for any wording the store had not seen before, the echo of
the search was rank 1 and carried no knowledge (2026-11-11: a 中文 query returned
four rows and every one was a command that ran that query). A reuse hint points
at content, never at a question.

Ledger reads are memoized against per-segment `(name, mtime_ns, size)` stamps
(`store.read_jsonl`, `verify._valid_runs`), so a repeat read costs one `stat`
per segment rather than a parse, and `store.tail_jsonl` reads only the live
segment for recent-row windows — scanning backwards in doubling blocks, so a
small window on a large segment stays cheap — returning None (fall back to a
full read) when it cannot prove the answer complete. `verify_count.json` carries
the valid-row total with the same stamp, so a cold process can answer
`count()`/`recent(N)` without parsing the ledger; a stamp mismatch discards it
instead of trusting it, and it is written by an append only when the previous
total was already known.

Modules: `store.py` (paths, ensure, jsonl append/read + flock, config load/merge, state), `contract.py` (CRUD + DEFAULT_CONTRACT), `journal.py`, `loops.py` (streaks from events), `diffscope.py` (git numstat parser + verdict), `verify.py` (subprocess runner + evidence ledger), `preflight.py`, `budget.py` (chars/token estimate: chars/4, per-tool breakdown), `orientation.py` (tree ≤2 levels, language counts by extension, conventions-file detection), `report.py` (status dashboard), `cli.py`, `mcp_server.py`, `defaults.py` (DEFAULT_CONTRACT, DEFAULT_CONFIG — single source for both).

CLI verbs (mirror MCP tools; exit 0 ok / 1 warning triggered / 2 error):
`init · status · verify CMD · evidence [--limit N] [--id ev-NNNN] · contract list|add TEXT|remove ID · note TYPE TEXT [--tags a,b] · loops · diff · preflight · budget`

`pyproject.toml`: name `protect-context`, `requires-python >=3.10`, deps `fastmcp>=3,<4`; dev: `pytest`. Dev setup: `python3 -m venv .venv && .venv/bin/pip install -e '.[dev]'`.

## 4. MCP tools (names FROZEN; all return compact text, last line = actionable `Nudge:`)

| Tool | Args | Returns |
| --- | --- | --- |
| `guard_status` | — | dashboard: session, Δdiff, loop streaks, evidence count, contract size, last verify |
| `guard_verify` | `command: str, timeout_s: int = 180` | evidence id, exit, digest; records to verify_runs.jsonl |
| `guard_evidence` | `limit: int = 5, evidence_id?: str` | recent verify runs (each non-ok row carries its last output line), or one run in full by id |
| `guard_contract` | `action: "list"\|"add"\|"remove", text?, id?` | updated contract view |
| `guard_note` | `type: "decision"\|"correction"\|"risk"\|"note", text, tags: [str] \| null = null` | ack |
| `guard_loop_check` | — | failing-command streaks + advice |
| `guard_diff_audit` | `baseline: str = null` | numstat vs HEAD/baseline, verdict vs thresholds |
| `guard_preflight` | — | tool presence/versions, git-repo check |
| `guard_brief` | — | the injected brief itself, rendered from the store (Python parity with `buildBrief`) |
| `guard_budget` | — | session tool-output chars, est. tokens, top-5 tools |
| `guard_journal` | `type?: "decision"\|"correction"\|"risk"\|"note", limit: int = 5` | recent journal rows, newest last, bounded; ends with a Nudge |
| `guard_intent` | `limit: int = 5` | owner wants/needs/preferences/constraints/corrections/statements, provenance-labelled, no query |
| `guard_recall` | `query?, type?, tag?, limit?, evidence_id?, cmd?` | ranked hits over the retained journal + evidence window (amendment 2026-11-06/2026-11-10) |
| `guard_orientation` | — | repo tree, languages, conventions files, task anchor; memory digest for a new session |

`guard_verify` runs via `subprocess.run(cmd, shell=True, timeout=timeout_s, capture_output=True)`; never raises on nonzero exit — it RECORDS it (that is the point).

### Amendment 2026-11-06 — local recall

The frozen tool table and CLI verb list above are unchanged. A later read-only
surface searches the retained journal and evidence window (live JSONL plus the
rotated segments readers already concatenate):

- MCP and pi: `guard_recall`
- CLI: `recall [QUERY] [--type decision|correction|risk|note|evidence] [--tag TAG] [--limit N] [--evidence-id ev-NNNN] [--cmd FINGERPRINT]`

Keywords are a case-insensitive AND over `text`, `cmd`, and `digest` (an
`ev-NNNN` token also matches that evidence id). Tags are case-insensitive AND.
Command matching is the frozen fingerprint, or a substring of it, and applies
to verify runs. Hits are ranked by match strength, then recency, and labelled
`trusted` or `agent`. No vector database and no embeddings. The pi brief may
add one hint when a cap hides entries, plus at most two trusted tag matches
for the owner task. See README.

### Amendment 2026-11-10 — recall ranking quality

The 2026-11-06 tool surface and filters are unchanged, and "no vector database
and no embeddings" still holds. What changes is how a matching row is scored and
which rows are shown, because the previous ranker had four measured defects:
morphology was one-way (`retrieving` found nothing in a row about `retrieval`),
a verbose row beat a precise one, restatements filled the whole page, and a
recorded reuse count was ignored.

- **Morphology.** Matching is a word-start hit *or* an equal stem. The stemmer is
  a small suffix stripper with length guards (`src/protect_context/stem.py`,
  mirrored in `extension/lib/stem.ts`), chosen over Porter because Porter
  collapses `organization` to `organ` and starts answering `organic`. The
  mid-word guard is unchanged: `arch` still never reaches `search`.
- **Non-Latin keywords (2026-11-11).** A keyword that is not pure ASCII matches
  as a plain substring. Scripts written without spaces have no word start to
  anchor on: in `…在生产库上…` every neighbour of a match is a letter, so the
  boundary rule returned nothing for a query the store literally contained
  (measured: `生产库` matched 0 rows). The mid-word noise the rule prevents
  (`arch` in `search`) needs an ASCII word structure that Chinese does not have,
  so the relaxation is keyed on the *keyword*, not on the haystack — an ASCII
  keyword still never matches mid-word, even next to a 中文 character
  (`表格old` does not answer `old`). Cross-lingual paraphrase needed a learned
  model, which this SPEC excludes; the deterministic half is now a curated term
  bridge (below), not an embedding.
- **Scoring.** BM25 (`k1 = 1.5`, `b = 0.75`) in integer thousandths, with the
  Lucene IDF `ln(1 + (N - df + 0.5) / (df + 0.5))`. Term frequency saturates and
  is normalised by row length against the corpus average. Both runtimes compute
  the same integers; each suite pins the same value table.
- **Widening.** When a query of three or more keywords matches nothing under the
  two-word floor, the search runs once more at one shared term and reports
  `widened`, which the Nudge line states. The strict pass always runs first, so
  widening can only fill an empty result, never dilute a precise one.
- **Near-duplicates.** The displayed page collapses `exact` and `candidate` pairs
  (`src/protect_context/dedup.py`, mirrored in `extension/lib/dedup.ts`):
  IDF-weighted cosine at or above 0.9 with at least two shared tokens, vetoed
  when a token absent on one side appears in at most two rows. This never merges
  ledger rows — it filters the answer only — and `matched` still counts every
  ranked row.
- **Reinforcement.** A recorded reuse count adds a bounded boost
  (`min(uses, 8) * 10`) so a hint that already worked outranks an equivalent
  one-shot. The ledger stores a count, not per-use dates, so this is NOT ACT-R
  base-level activation; relevance always dominates.
- **Questions are not answers (2026-11-11).** A row that records the *query* is
  dropped from the corpus: a `guard_recall` tool row, a shell row that talks to
  this project's own recall surface (`protect-context recall …`, or
  `from protect_context import recall` inside a `python -c` one-liner), and a
  `guard_verify` row whose stored command is such an invocation. Measured on the
  real store: the probe command that ran a query ranked first or second in all
  four of its own result sets, and two verify rows outranked the entries they
  were searching for — the search looked like it had found something when the
  store held only the question. A path such as
  `src/protect_context/recall.py` still indexes: a file is content, and the
  trailing dot is what tells the two apart.

See README for the measured before/after on each defect.

### Amendment 2026-11-11 — bilingual term bridge

The 2026-11-11 non-Latin fix made a 中文 keyword match inside an unsegmented run,
but two rows that state the same rule in different languages still shared no
characters: a query for `生产库` could not reach "never run destructive SQL on the
production database". Learned cross-lingual paraphrase stays out (no embeddings,
no model, no network). What is added is the deterministic half:

- **A term table, not a model — in two tiers.** `src/protect_context/lexicon.tsv`
  is generated by `scripts/build_lexicon.mjs` and read by BOTH runtimes, so the
  Python and TypeScript tables cannot drift by construction, and
  `test_recall.py` runs each loader and compares the results. The curated tier
  (`data/curated.tsv`, 59 pairs) is the vocabulary this tool records and is
  returned first, uncapped.
  The dictionary tier (~64k pairs) is derived from CC-CEDICT via the
  `cc-cedict` npm package, a build-time dependency nothing imports at runtime;
  it reaches ordinary words nobody curated (`deadlock` ↔ 死锁, `firewall` ↔ 防火墙,
  `thread` ↔ 线程, `gateway` ↔ 网关). A dictionary sense can be wrong for this
  domain — CC-CEDICT answers "branch" with 分所 where this project means 分支 —
  which is why the curated tier leads and the dictionary tier is capped at
  `DICTIONARY_CAP = 6` counterparts per query term.
- **Licensing travels with the data.** The dictionary section is CC BY-SA 4.0
  (CC-CEDICT, © MDBG and contributors); `NOTICE` records the attribution, and the
  generated file carries it in its header. The curated section, the code, and
  the rest of the repository stay MIT.
- **Applied at query time; the store is untouched.** Each query keyword is
  expanded to its counterparts and a row may match any of them. Nothing is
  translated on write, so the JSONL format is unchanged and an old store needs
  no migration.
- **One hop, script-matched.** A keyword is matched against the side of the pair
  written in its own script, so a translation is never chained into a second
  translation. English is matched by word start or shared stem; 中文 by substring
  in either direction (so `生产` also reaches the `生产库` entry).
- **Alternates are alternatives, not extra terms.** The query keeps its
  AND-over-keywords shape and its floor: a translation satisfies the same term
  the literal keyword would have.
- **Literal still wins.** A hit reached only through the bridge is scaled by
  `TRANSLATION_WEIGHT_MILLI = 600` (0.6) in both runtimes, so a literal row of
  the same rarity outranks a translated one. IDF is computed from the literal
  keyword only, so enabling a bridge never lowers the score of a row that
  already matched literally.
- **Bounded and stated.** Only pairs in the table bridge. A paraphrase outside
  it misses exactly as before; this is recall for written-down terms, not
  translation. The table is data, not an index: a process pays tens of
  milliseconds to load it on the first search and ~1 ms afterwards, and a
  missing table degrades to no bridge instead of failing the search.

See README for the measured before/after on each defect.

### Amendment 2026-11-09 — owner intent

`guard_intent` (MCP + pi) and `intent [--limit N]` (CLI) answer "what does the
owner want" with no keyword query: every journal row whose text expresses an
owner want, need, preference, or an explicit "you are wrong" correction, plus
rows carrying `owner-want` / `owner-need` / `owner-preference` /
`owner-correction`. New journal rows are tagged automatically from their text
(detection is deterministic; the reserved `agent` tag is never dropped by the
tag cap). Text the owner typed themselves needs no attribution — a leading
imperative or first-person want is enough — while journal prose the agent
writes still requires an `owner`/`user` attribution, so the agent's own "I want
to check" is never captured as owner intent. Chinese is matched by a parallel
pattern set in both runtimes (`_CJK_INTENT_PATTERNS` / `_CJK_OWNER_AUTHORED` in
`journal.py`, `CJK_INTENT_PATTERNS` / `CJK_OWNER_AUTHORED` in `journal.ts`):
`\b` has no meaning between Chinese characters, so the English patterns alone
left every 中文 statement untyped — stored, then invisible to the view
(2026-11-11). `我要求/我希望/我需要/最好/不要再/必须/…错了/我说的是` are recognised,
with the same attribution rule: a bare 必须/不要 counts only for owner-typed
text. Quotation marks are blanked in both languages (`"…"`, `` `…` ``, `“…”`,
`「…」`, `『…』`). Rows render as
`<kind> · <ts> · <text> [provenance]` with per-kind counts and an
`owner N · agent M` split, newest first, bounded to `READ_LIMIT_MAX` lines;
`agent` provenance stays unverified. A read never writes and never creates
`.agent-guard/`.

### Amendment 2026-11-10 — intent completeness, brief fidelity, measured checks

The 2026-11-09 view shipped, and a full audit found that the owner's literal
request was captured and then unreadable: the `input` handler wrote every
substantive prompt as a trusted `owner-prompt` row, and no reader classified that
tag, so `intent` and the brief's owner-intent slot showed only the agent's
paraphrase. Fixed without changing any store format:

- **Two new kinds.** `owner-constraint` (a start-anchored negation — `do not`,
  `never`, `avoid`, `must`, `stop`) joins the four intent kinds, and
  `owner-statement` is the read-time fallback for an `owner-prompt` row that
  matches no pattern. Kind order is want, need, preference, constraint,
  correction, statement; the counts line names all six.
- **`owner-prompt` rows are judged as owner-typed text** (no attribution noun
  needed) and can never be dropped from the view. Detection is still
  deterministic and still mirrored in both runtimes.
- **Detection reads real prompts.** The imperative list grew from 17 to 46 verbs
  (`audit`, `review`, `install`, `clone`, `vendor`, `test`, `run`, `revert`, …)
  and an optional leading connective (`please`, `now`, `then`, `also`, `next`,
  `first`, `so`, `ok`) no longer hides the verb behind it.
- **Brief.** The two owner-intent lines prefer trusted rows over agent-tagged
  ones (an agent paraphrase must not displace the owner's instruction), its
  budget is 200 chars, and a cut line sets the `journal text truncated` notice —
  as does a cut recall line. Dedupe against journal sections now uses the
  precedents the cap actually shows; using the uncapped list let a hidden lesson
  swallow an identical owner statement so neither appeared.
- **`guard_contract_check` measures 02 and 08** instead of certifying prose: 02
  requires the newest run to carry the `ok` trust label *and* be cited by id in
  the summary; 08 compares the real diff against the configured hard limit. The
  output prints a `basis:` line naming the measurement and the `ok`/`FAIL`/
  `UNTRUSTED` label, plus the ids that remain self-report keyword coverage.
- **`status` prints the task anchor** with its source and age in both runtimes.
- **One version for every artifact**, enforced by
  `tests/test_registry.py::test_one_version_everywhere`, and a CI workflow
  (`.github/workflows/check.yml`) that runs the extension suite and pytest.

## 5. pi extension (`extension/`)

Entry `extension/index.ts` + pure-logic modules in `extension/lib/` (no pi imports → testable via `node --test --experimental-strip-types`). `typebox`/`@earendil-works/pi-coding-agent` type imports are provided by the pi runtime. Loaded via jiti — no build step.

Event behaviors (all thresholds from config):

- `session_start`: ensure store; new session id; record git HEAD (null if no repo); load config/contract/journal; render widget.
- `before_agent_start`: build compact brief via `extension/lib/brief_source.ts` (the Python twin `protect_context.brief.compose_brief` is what `guard_brief` returns; `tests/test_brief.py` pins byte equality). Shape: `task:` line ≤400 chars, contract ≤12 seed/other lines plus ≤6 owner lines, 2 owner statements carrying an `owner-*` intent tag or detected owner intent — an agent-tagged row is marked unverified — 3 most-recent trusted decisions, 3 trusted corrections, 2 unverified corrections, 2 unverified model notes, open loops ≤2, last evidence with its trust label, plus a read-path line when caps hid or truncated entries) → if `brief_mode=="changed"` and sha1(brief)==`brief_digest`, skip; else inject `{customType:"guard-brief", content, display:false}`, save the digest, and clear any pending mid-run re-injection.
- `context`: only while a mid-run re-injection is pending (armed by `session_compact`) — if the conversation holds no persisted `guard-brief` message, append `{role:"custom", customType:"guard-brief", content, display:false}` to `event.messages`. The result is per-request, so it is re-applied on each request until a persisted block is seen; with no pending flag the handler is an O(1) no-op.
- `input`: capture the first substantive owner prompt (≥20 chars, not a slash command) as `state.task` (source `prompt`) and invalidate the brief digest, so `task:` is re-injected on that same turn. An intent-bearing prompt (wants, needs, preferences, an explicit "you are wrong") is also appended to the journal as a TRUSTED row — the owner typed those words, so it carries no `agent` tag — with the detected `owner-*` tags and type `correction` when a correction was detected, `note` otherwise; the same text is not captured twice. `/guard-task` writes source `owner` and always wins; short follow-ups ("continue") never replace a task.
- `tool_call` (bash only): (a) risk patterns → `ctx.hasUI && risk_confirm` → single `ctx.ui.confirm("Risky command", …)`; no-UI → log only, never block; a declined confirm appends `tool_call` (`cmd`, `ok=false`); (b) loop check: prior failed attempts for fingerprint ≥ `loop_block_after - 1` → append `tool_call` (`cmd`, `ok=false`) and return `{block:true, reason:"guard: '<cmd>' already failed N times this session — do not re-run unchanged; change approach or read the error. (Raise loop_block_after in .agent-guard/config.json to override.)"}`; (c) else append `tool_call` event with `cmd`.
- `tool_execution_start`: record start time by toolCallId (map, pruned on end).
- `tool_execution_end`: append `tool_result` event (`ok=!isError`, ms, out_chars=sum of text content lengths; bash adds cmd fingerprint + exit); update widget.
- `turn_end`: `ctx.getContextUsage()` → notify once per 10% watermark ≥ `ctx_warn_pct` (suggest /compact); `git diff --shortstat HEAD` → threshold notifies (warn/hard, once per level); update widget.
- `session_compact`: invalidate `brief_digest` and `counters.orient_sha1` (the next turn re-injects even unchanged text) and arm the `context` re-assertion, because a threshold/overflow compaction resumes the run via `AgentStart`, where `before_agent_start` never fires.
- `session_shutdown`: persist state.json.
- Widget (single line): `PC Δ+123L/4f 1loop ev2 ctx41%`.

Risk patterns (deny-confirm list): `rm -rf /`, `rm -rf ~`, `git push --force` (not `--force-with-lease`), `git reset --hard`, `mkfs`, `dd of=/dev/`, `chmod -R 777 /`, `curl|…| bash/sh`, `sudo rm`.

Commands: `/guard-status`, `/guard-contract add|remove|list [text]`, `/guard-verify <cmd>`, `/guard-note <type> <text>`, `/guard-task [<text>|--clear]` (show/replace/clear the owner task anchor), `/guard-report` (full session summary, printed).

Model-callable tools (typebox params): `guard_verify`, `guard_note`, `guard_journal` (read-only; `limit` clamped to 0-20 with default 5, optional `type` filter; renders one line per entry plus a `Nudge:` tail, mirroring the MCP tool), `guard_intent` (read-only; owner wants/needs/preferences/constraints/corrections, `limit` 0-20 default 5, provenance-labelled), `guard_contract_check` (deterministic checklist: 02 and 08 measured from the store, the rest keyword coverage of the supplied summary, and a `basis:` line that says which is which), `guard_status` (includes journal totals and the task anchor so the read path is discoverable), and the read-only surfaces that previously existed only over MCP (amendment 2026-11-10): `guard_evidence` (`limit` 0-20 default 5, or one `evidence_id`), `guard_loop_check`, `guard_diff_audit`, `guard_preflight`, `guard_budget`, `guard_contract` (`action` list|add|remove; a model-called write lands in the project layer only), `guard_orientation`. `guard_brief` (read-only; `limit` bounds the returned lines, default 20) returns the same text `before_agent_start` injects, built by `protect_context.brief` — the Python twin of `extension/lib/brief.ts`. Parity is pinned on both sides: `tests/test_mcp.py` asserts the 14 MCP names and `extension/test/index-lifecycle.test.ts` asserts the same 14 plus the extension-only `guard_contract_check`; `tests/test_brief.py` renders one fixture store through both runtimes and requires byte equality.

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

### Amendment 2026-11-10 — packaging, portability and CI

No store format, tool signature or CLI verb changes. What changes is that the
package is installable and runnable where the docs say it is, because a clean
container disagreed with the developer venv in three ways:

- **Every third-party import is a declared dependency.** `store.py` imports
  `tenacity` and `layers.py` imports `dotenv`, and neither was declared, so
  `pip install protect-context` into an empty environment produced a package
  that raised ImportError before running a single command. All twelve direct
  imports are now declared, and
  `tests/test_registry.py::test_every_third_party_import_is_declared` reads the
  source with `ast` and fails when an import has no dependency.
- **A vendored checkout that cannot import is skipped, not fatal.**
  `vendored.activate()` prepends `vendor/*` so the vendored copies win. The
  vendored `pydantic-settings` imports `typing.Self`, so on Python 3.10 the
  bootstrap raised ImportError and took `import protect_context` with it. A
  checkout that fails to import now loses its `sys.path` entry and the installed
  distribution is used — the fallback the module already promised for a missing
  checkout.
- **CI is pinned, not assumed.** `.github/workflows/check.yml` runs the extension
  suite on node 22 and pytest on 3.10 and 3.12. The extension job also installs
  `git`, `python3` and the package itself, because three of its tests are the
  cross-runtime contract tests that import `protect_context` from the child
  interpreter. `tests/test_registry.py` pins both jobs and those prerequisites so
  a later edit cannot drop one silently. Both jobs were executed in containers
  (node 22, Python 3.10, Python 3.12) rather than only read.
- **One version means the lockfile too.** `package-lock.json` records the root
  version twice and `npm ci` tolerates a mismatch, so it had drifted to 3.2.2;
  both fields join `test_one_version_everywhere`.
- **A CLI separator is not part of the command.** `verify -- <cmd>` used to run
  the literal `-- <cmd>`, which exits 2 and records a FAIL row for a passing
  command — the worst failure mode for a tool whose point is trustworthy
  evidence. The `--` is dropped, and a `--timeout` written after the command
  (the help already says to put it first) gets a hint instead of a mangled run.
- **Owner constraints no longer evict seeds.** The brief re-injected one shared
  12-line contract budget and selected owner rows first, so adding five owner
  constraints silently removed seeds `08-keep-diffs-reviewable` …
  `12-budget-context` from every brief — the diff, retry, preflight, batching
  and budget rules traded away for the owner's own. The budgets are now
  additive (≤6 owner + ≤12 seed/other), and `contract add` reports which class
  overflowed instead of implying a single 12-line cap.
- **Contract text cannot be shortened silently.** `contract add` cut at the
  500-char cap and reported only the new id. Because the brief re-injects the
  constraint every prompt, a lost tail changes behaviour permanently, so all
  four writers (CLI, MCP, pi tool, slash command) now print
  `note: text truncated N -> M chars (TEXT_CAP 500)`.
- **The matrix covers the classifiers.** 3.11 and 3.13 joined 3.10 and 3.12 in
  `check.yml`; both were green in containers first. The workflow is
  least-privilege (`contents: read`), persists no credentials, and pins every
  action by commit SHA with the release name in a comment.

## 7. Testing requirements

Python (pytest, in `.venv`): store roundtrip + flock; contract CRUD + defaults identical to TS (12 ids + exact texts); fingerprint + loop streaks; numstat parser + verdicts; verify runner (uses `true`/`false` shell commands); budget math; orientation digest; CLI smoke for every verb (tmp HOME-cwd fixture so `.agent-guard` is created in a temp dir); **fastmcp in-memory Client smoke over ALL 14 MCP tools**; cross-format: Python parses a TS-format events.jsonl fixture string.

Cross-runtime: `tests/test_brief.py` writes one fixture store and asserts the Python brief equals the extension's byte for byte (skipped when `node` is unavailable), so a change to either renderer that is not mirrored fails the suite.

TypeScript (`node --test --experimental-strip-types`, tests in `extension/test/`, lib modules stay pi-import-free): fingerprint; risk pattern list (match/non-match cases); loop streak logic; brief digest stability; widget render; numstat/shortstat parser (fixture strings); config load/merge defaults.

Typecheck: `npm run typecheck` (`tsc --noEmit -p extension/tsconfig.json` via the pinned `typescript` devDependency; the older `npx -y typescript@latest tsc` form now dies with TS5042/TS5112 before checking anything, so use the project script) with a minimal `tsconfig.json` (node builtin types via `@types/node` — if this proves flaky, downgrade to best-effort and record the result; do NOT add runtime deps).

## 8. Docs requirements (README.md, written in Polish phase)

Quickstart (extension install = copy/symlink into `~/.pi/agent/extensions/protect-context` or `.pi/extensions/`; MCP = `.mcp.json` snippet with `command: .venv/bin/python, args: [-m, protect_context.mcp_server]` + generic-host JSON; CLI usage); the §1 traceability table reproduced; configuration reference; limitations (advisory-first; blocking scope; no sandbox); non-goals.

## 9. Non-goals

No network/LLM calls. Not a sandbox. Not an auto-fixer. No secrets in the store. Does not replace pi's own permissions — complements them.

## 10. Definition of Done

1. pytest green (all suites) AND node tests green — twice consecutively.
2. All 14 MCP tools callable via fastmcp client smoke.
3. Extension module compiles under jiti semantics (typecheck best-effort documented) and lib tests pass on node 22.
4. README complete with the 12-goal mapping.
5. git repo initialized with one conventional initial commit (`.gitignore`: `.agent-guard/`, `.venv/`, `__pycache__/`, `node_modules/`).
6. Every §1 row traceable to shipped code + at least one test or documented manual verification.

### Amendment 2026-11-10 — capture completeness

Measured on this repo's own `.agent-guard/` after twelve days of real work: the
journal had 50 rows, **35 of them (70%) cut at the 500-character cap, 31
mid-word**; journal rows had no stable handle; `edit` rows recorded only a path;
`bash` rows recorded only `out_chars`; the events ledger had already rotated
away all but one day of a twelve-day history; and no record joined a task to the
files and evidence it produced. Those were the recorded answers to "can I
recover what I actually did", and the store failed several of them.

What does **not** change: the three ledgers and their names, `ev-NNNN`
allocation, the verify/is-authoritative-for-outcomes rule, the tool surface
(`guard_note`, `guard_journal`, `guard_recall`, `guard_intent`), the brief
budget, and the no-embeddings rule. Nothing here adds a network call.

Behaviour changes:

1. **Journal text cap 500 → 4000** (`journal.TEXT_CAP`, `TEXT_CAP` in
   `extension/lib/journal.ts`). 500 discarded the rationale of most real
   decisions. Truncation is no longer silent: `journal.add` attaches a
   display note and the CLI/extension acknowledgement states the cut, and the
   extension also logs it to stderr through pino.
2. **Journal rows gain an `id`** (`jn-0001`), allocated from
   `state.counters.journal_seq` so rotation can never reissue one, with legacy
   rows bounding the floor. This is the journal's `ev-NNNN`: a decision is now
   citable instead of addressable only by recency position. Rows written before
   the field existed are numbered once, in file order, so ids sort
   chronologically; the repair is idempotent.
   Journal rows also gain **`session`**, the join key to `events.jsonl` and
   `verify_runs.jsonl`. Until now a decision and the run that proved it related
   only by timestamp proximity (45 of 52 happened to fall within five minutes).
   Legacy rows keep an empty session: the session was never recorded, and
   inferring it from time brackets would be a fabrication rather than a record.
3. **`events.jsonl` rows may carry `out_tail`** — the last ≤400 characters of
   the tool's result. `out_chars` said how much output there was but never why
   a run failed. Optional field: legacy rows and `tool_call` rows omit it.
   Rows may also carry **`diff_stat`** (`+12/-3`), the size of the change an
   `edit`/`write` call made, plus **`diff_lines`** (`12-18`, or `7` for a single
   line) and **`diff_at`** (the first changed line, trimmed) naming WHERE it
   landed. Size and location are both measured from a snapshot of the file taken
   at tool start against the file on disk at tool end, so they describe the real
   change rather than the arguments the model supplied. A deletion reports the
   line it followed, so "where" stays answerable. A line count is the smallest unit that answers
   "one-liner or rewrite" while remaining far too small to reconstruct content;
   a full diff is deliberately not stored. The counter lives in
   `extension/lib/diffstat.ts` and `src/protect_context/diffstat.py`, asserted
   against the same fixtures in both suites.

   **`TaskCapture.files`** records the paths one task changed (bounded, first
   touch order). The event stream proves an edit happened but rotates away;
   the anchor does not, so it is what answers "which files did this task touch"
   once the events are gone.
4. **A failing verify keeps both ends of its digest.** Passing runs still keep
   the trailing 2000 characters, but a non-zero exit keeps the head (the
   originating error or first failing assertion) as well as the tail.
5. **Ledger retention 1 MB × 3 → 4 MB × 6** (`LEDGER_MAX_BYTES`,
   `LEDGER_SEGMENTS`). At the old bound a busy day evicted the rest.
6. **The owner's turn is journaled.** Every real prompt becomes a row tagged
   `owner-prompt` (plus any detected intent tag), not only prompts that happen
   to contain an intent keyword, so what was asked survives independent of the
   agent's paraphrase.
7. **The task anchor gains `session`**, the join key that relates one task to
   the events and evidence rows of the same session.

Both runtimes implement 1–3 and the mirrors are covered by tests on each side
(`tests/test_journal.py`, `extension/test/journal.test.ts`); 4–5 are Python
only because the digest and rotation live there.

## 11. Parallel-writer ownership map (build time)

- **PY agent** owns: `src/**`, `tests/**`, `pyproject.toml`, `.gitignore`, `.venv/` — nothing else.
- **TS agent** owns: `extension/**` — nothing else.
- Verify/fix/polish agents run sequentially and may touch anything under the repo root (never `SPEC.md`).
- Nobody: edits `SPEC.md`, runs `git init`/`git commit` except the Polish agent.
