# Project intent — protect-context

Committed so that a fresh clone, a new session, or a different agent starts from
what the owner actually asked for instead of re-deriving it from chat history.
Runtime state (journal, events, verify runs, session state) stays local; this
document and `.agent-guard/contract.json` are the durable record.

## Mission

protect-context is not a general memory plugin. It exists to defeat twelve
specific ways an AI coding agent fails, and every feature is justified by one of
them. If a change does not fix one of these, it is out of scope.

| # | Failure mode | Where it is enforced |
|---|---|---|
| 01 | Violating explicit instructions or stated constraints | contract re-injected into every brief; `guard_contract_check` |
| 02 | Claiming success without verification | `guard_verify` records exit/digest; only an `ok` id counts as proof |
| 03 | Scope creep | contract 03 + diff audit; unstated edits are findings |
| 04 | Misunderstanding the repo | `guard_orientation` before the first edit in an unfamiliar tree |
| 05 | Plausible-but-wrong code | tests as part of the change, not after it |
| 06 | Losing context after compaction | `session_compact` re-injects trusted context |
| 07 | Repeating an owner correction | corrections are classified, surfaced first, and logged with a tag |
| 08 | Large unreviewable diffs | diff warn/hard limits; 400+ lines is a split signal |
| 09 | Repetitive debugging loops | `guard_loop_check` counts failing streaks and blocks after 2 |
| 10 | Environment/tool failures mistaken for code bugs | `guard_preflight` probes tools first |
| 11 | Permission interruptions | batched shell operations |
| 12 | Token cost and latency | every surface is bounded and announces what it dropped |

The twelve seed constraints encode these; they are frozen in code
(`src/protect_context/defaults.py`, `extension/lib/defaults.ts`) with ids and
texts dated `2026-08-28` and pinned by tests on both sides.

## Owner asks, in order

### 2026-10-29 — origin

Licensing (MIT, holder `XJTLUmedia`) and a gallery preview; the event-schema
fixes (`cmd` stored on `tool_call`, refused calls recorded with `ok=false` and no
`tool_result`); personal/project contract layering; and state, ledger and config
follow-ups.

### 2026-10-30 … 2026-11-05 — registry and packaging

`protect-context@1.2.0` audit follow-ups; first PyPI and registry publication at
version `2.0.0` (matching the npm and git tag, not `1.0.0`); the PyPI token lives
at `~/.pypi-token` (mode 600) and the agent never prints it. npm publishing stays
with the owner — `npm whoami` has repeatedly returned `E401` in-session.

### 2026-11-09 — audit, then defects

"audit and fix all the ts files within extension/lib folder", "fix all problems
within (out of scope)", "capture everything the user want, not only preference,
or user explicitly mentioned LLM to be wrong", "fix all honest limits". Five real
defects landed from exercising wiring rather than re-reading it (double-recorded
verify outcome, a failed verify written as `ok=true`, lessons lost to rotation on
the TS side, symlinked parents escaping the root check, best-effort journaling).

### 2026-11-10 — recall upgrades and the durability question

Vectorless retrieval upgrades (tags as synonyms, IDF weighting, bounded output);
then the owner challenge that ended in this document: *is the knowledge actually
persisted and re-injected, or only recited in chat?* Answer at the time: no —
the five standing preferences existed only as agent-written journal rows, and
`.agent-guard/` was gitignored wholesale.

## Standing preferences (constraints 13-17)

Added `2026-11-10` as owner constraints (`source: user`, project layer) so they
are re-injected rather than remembered:

| id | Rule | Why it exists |
|---|---|---|
| `13-take-the-whole-batch` | Do all N listed follow-ups in one pass; never return with a subset | The owner had to ask for "all three follow-ups" and "fix all honest limits" more than once |
| `14-prefer-the-broad-fix` | Fix the defect class at every call site in both runtimes, keeping diffs separable | Single-instance fixes left the same bug live in the other runtime |
| `15-prove-it-is-used` | Exercise the read path end to end before claiming a loop is closed | Capture worked while retrieval silently did not (owner prompts had no reader) |
| `16-keep-diffs-reviewable-treat` | 400+ changed lines is a stop-and-split signal; releases stay version-only | A devDependency bump once rode along with a release and produced a 2,993-line lockfile diff |
| `17-npm-publish-belongs-to` | Publishing is the owner's action; never publish on their behalf | Registry credentials are the owner's, and `E401` failures wasted a release attempt |

Budgets are additive: up to 6 owner lines plus 12 seed/other lines, so these five
do not evict seeds `08`-`12` from the brief. Past a budget, the write surface
names the class that overflowed instead of implying a single cap.

## How intent is captured and re-read

- **Owner prompt** → journal note tagged `owner-prompt`; classified at read time
  (`owner_authored`) and surfaced by `guard_intent` and `buildBrief`.
  Provenance outranks the claim: `owner-prompt` **and** no `agent` tag.
- **Contract** → `.agent-guard/contract.json`, committed, re-injected each brief.
- **Lessons** → journal rows tagged `lesson`, pinned across ledger rotation.
- **Corrections** → tagged, surfaced before unverified notes, and checked before
  similar work.

## Durable vs local

| Path | Tracked | Holds |
|---|---|---|
| `.agent-guard/contract.json` | yes | owner and seed constraints — project intent |
| `docs/PROJECT-INTENT.md` | yes | this document |
| `.agent-guard/config.json`, `state.json` | yes | thresholds, session state, task anchor |
| `.agent-guard/journal.jsonl` | yes | decisions, corrections, lessons, owner prompts |
| `.agent-guard/events*.jsonl`, `verify_runs.jsonl` | yes | tool traffic and evidence |
| `.agent-guard/*.lock` | no | live lease, meaningless outside the holding process |

The whole store travels (owner decision, 2026-11-10: *"these are not tracked I
think it is wrong, since everyone has a preference"*). The consequence is
explicit: events and journal rows contain prompts, commands and tool output, so
this repository's history carries the working conversation, not just the
contract. A project that needs the intent without the transcript tracks
`contract.json` only instead.

The brief reads all of it through one assembler per runtime —
`extension/lib/brief_source.ts` and `protect_context.brief` — and
`tests/test_brief.py` renders one fixture store through both, requiring byte
equality.

## Honest limits

- The brief is built by both runtimes and pinned by a parity test, so the CLI
  (`protect-context brief`), the MCP tool (`guard_brief`) and the pi extension all
  return the same text. The parity test skips when `node` is unavailable, so a
  Python-only CI job proves the Python brief but not the equality.
- The MCP `guard_contract add` tool stores rows with `source: "agent"`, which the
  brief treats as untrusted and ranks after seeds. Owner rows must be added with
  the CLI (`python -m protect_context contract add`) or the `/guard-contract add`
  slash command.
- Seven owner constraints is already past the owner budget: the oldest is not
  re-injected and the warning says so. Prefer editing an existing rule over
  adding a seventh.
