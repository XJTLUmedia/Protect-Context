"""protect-context MCP server — the explicit/portable guardrail layer
(SPEC §4). Same on-disk store as the pi extension and the CLI
(.agent-guard/ in the server's working directory).

Installed entry point (stdio): `uvx protect-context mcp`, or
`protect-context mcp` after `pip install protect-context`. That console script
is `protect_context.cli:main`; the `mcp` verb calls this module.

From a checkout: `python -m protect_context.mcp_server`.

Hosts configure it via a standard .mcp.json. Published package:

    {"mcpServers": {"protect-context": {
        "command": "uvx",
        "args": ["protect-context", "mcp"]}}}

Checkout interpreter:

    {"mcpServers": {"protect-context": {
        "command": "/abs/path/.venv/bin/python",
        "args": ["-m", "protect_context.mcp_server"]}}}

All tools return compact text; the last line is always an actionable Nudge.
"""

from __future__ import annotations

from typing import Annotated

from fastmcp import FastMCP
from mcp.types import ToolAnnotations
from pydantic import Field

from . import (
    budget,
    contract,
    diffscope,
    journal,
    loops,
    orientation,
    preflight,
    recall,
    report,
    store,
    verify,
)

mcp = FastMCP("protect-context")

_READ_ONLY = ToolAnnotations(
    readOnlyHint=True,
    destructiveHint=False,
    idempotentHint=True,
    openWorldHint=False,
)
_LOCAL_INITIALIZING_READ = ToolAnnotations(
    readOnlyHint=False,
    destructiveHint=False,
    idempotentHint=True,
    openWorldHint=False,
)
_LOCAL_APPEND = ToolAnnotations(
    readOnlyHint=False,
    destructiveHint=False,
    idempotentHint=False,
    openWorldHint=False,
)
_LOCAL_MUTATION = ToolAnnotations(
    readOnlyHint=False,
    destructiveHint=True,
    idempotentHint=False,
    openWorldHint=False,
)
_SHELL_EXECUTION = ToolAnnotations(
    readOnlyHint=False,
    destructiveHint=True,
    idempotentHint=False,
    openWorldHint=True,
)


@mcp.tool(annotations=_LOCAL_INITIALIZING_READ)
def guard_status() -> str:
    """Session dashboard: diff, loops, evidence, contract size, and the last verify.

    Use it at the start of a turn, after a compaction, or before claiming the
    work is done, when you need the current guardrail state in one block.
    It takes no parameters. It returns text beginning with `PC status`: the
    session name (`PC_SESSION_ID`, or `default`), git head, diff stats and
    verdict, up to three loop streaks, the evidence count and last run, the
    merged constraint count, discovered conventions files, and a final Nudge
    line. Side effects: if `.agent-guard/` is missing it is created, `config.json`
    is seeded with the frozen defaults when that file is absent, and the first
    contract read writes the twelve seed constraints to `contract.json`. It also
    runs `git` for the diff. It does not append the journal or the evidence ledger.
    """
    text, _level = report.status()
    return text


@mcp.tool(annotations=_SHELL_EXECUTION)
def guard_verify(
    command: Annotated[
        str,
        Field(
            description=(
                "Shell command to run and record, as one string (pipes and "
                "quotes included). Required. Executed with the caller's "
                "privileges via the shell; this is not a sandbox. A blank "
                "string returns an error line and records nothing."
            )
        ),
    ],
    timeout_s: Annotated[
        int,
        Field(
            description=(
                "Seconds before the child is killed. Integer. Default 180. "
                "Clamped to 1–900; a timeout is recorded as exit 124, not raised."
            )
        ),
    ] = 180,
) -> str:
    """Run a shell command and record the outcome as evidence.

    Use it before claiming a check passed, and cite the returned evidence id.
    Do not use it to retry a command that `guard_loop_check` already says will
    be blocked. `command` is a required string and runs verbatim (`shell=True`)
    with the caller's privileges; stdin is closed. `timeout_s` is an int,
    default 180, clamped to 1–900. It returns a text report: on a real run,
    `PC verify ev-NNNN · exit N · ok|FAIL|UNTRUSTED · <ms>ms`, plus cwd, the
    command, a digest or failure tail, and a Nudge. Exit 0 from a pipeline
    (no pipefail) or a failure mask such as `|| true` is labelled UNTRUSTED
    and is not proof. A blocked loop returns `PC verify blocked` and does not
    add a ledger row. Nonzero exits are recorded, not raised. Side effects: the
    command itself can change files, the network, or anything else the shell
    can do. A run that is not blocked appends one row to
    `.agent-guard/verify_runs.jsonl` and creates the store if needed. The
    loop-brake check can also seed `config.json`.
    """
    if not command.strip():
        return (
            "PC verify · error: command must not be blank\n"
            "Nudge: pass a concrete verification command tied to the claim."
        )
    blocked = loops.command_block(command, store.load_config())
    if blocked:
        return (
            f"PC verify blocked · {store.display_text(blocked['cmd'], 80)} · "
            f"{blocked['count']} prior failures\n"
            "Nudge: change approach or gather new information — do not re-run unchanged."
        )
    return verify.render_entry(verify.run_verify(command, timeout_s))


@mcp.tool(annotations=_READ_ONLY)
def guard_evidence(
    limit: Annotated[
        int,
        Field(
            description=(
                "How many newest verification runs to list when evidence_id "
                "is omitted. Integer. Default 5. Clamped to 0–20; 0 returns "
                "the header and nudge only."
            )
        ),
    ] = 5,
    evidence_id: Annotated[
        str | None,
        Field(
            description=(
                "One evidence id to render in full, such as ev-0007. String "
                "or omitted. Default None, which lists recent runs. ev-7 and "
                "ev-0007 are the same id. An unknown id returns an error line."
            )
        ),
    ] = None,
) -> str:
    """Read recorded verification runs.

    Use it to recover a past evidence id, its exit code, and the stored digest
    instead of re-running the command. `limit` is an int, default 5, clamped
    to 0–20, and applies only when `evidence_id` is omitted. `evidence_id` is
    an optional string, default None. With an id, it returns the full single-run
    report (the same shape as `guard_verify`, including why/fix for FAIL and
    UNTRUSTED). Without an id, it returns `PC evidence · last N of TOTAL`, one
    line per run, the last digest line of any non-ok row, and a Nudge. Side
    effects: none. It does not create `.agent-guard/` and does not execute
    commands.
    """
    if evidence_id:
        entry = verify.find(evidence_id)
        if entry is None:
            missing = store.display_text(evidence_id, 40)
            return (
                f"evidence: no recorded run with id {missing}\n"
                "Nudge: call guard_evidence without an id to list the recent window."
            )
        return verify.render_entry(entry)
    runs, total = verify.recent_with_total(limit)
    return verify.render_recent(runs, total)


@mcp.tool(annotations=_LOCAL_MUTATION)
def guard_contract(
    action: Annotated[
        str,
        Field(
            description=(
                "What to do with the project contract. Required string: "
                '"list", "add", or "remove". Any other value returns an error line.'
            )
        ),
    ],
    text: Annotated[
        str | None,
        Field(
            description=(
                "Constraint text for action \"add\". String. Required for add; "
                "ignored for list and remove. A blank or missing value is an error. "
                "The new row is stored with source \"agent\"."
            )
        ),
    ] = None,
    id: Annotated[
        str | None,
        Field(
            description=(
                "Constraint id for action \"remove\", such as "
                "13-write-tests-first. String. Required for remove; ignored "
                "otherwise. Seed ids (source \"seed\") are refused."
            )
        ),
    ] = None,
) -> str:
    """List, add, or remove a project contract constraint.

    Use `list` before acting on rules you might have forgotten, `add` when the
    owner states a durable constraint this session should keep, and `remove`
    only for a constraint this agent added. `action` is a required string:
    `list`, `add`, or `remove`. `text` is an optional string, required for
    `add`. `id` is an optional string, required for `remove`. `list` returns
    the merged contract (project plus personal layer) and a Nudge. `add`
    returns the new id and the rendered contract, or a duplicate notice.
    `remove` returns the rendered contract, or a refusal. Side effects: `list`
    creates `.agent-guard/` and, when `contract.json` is missing, writes the
    twelve seed constraints. `add` and `remove` rewrite the project
    `contract.json` only. This tool never writes the personal layer
    (`--global` / `~/.config/protect-context`). Removing a seed constraint is
    refused; the owner removes those with the CLI or `/guard-contract`.
    """
    if action == "list":
        return contract.render(contract.load()) + \
            "\nNudge: honor these constraints; they are re-injected whenever they change."
    if action == "add":
        if text is None:
            return "contract: 'add' requires text\nNudge: pass the constraint text to add."
        try:
            c, cons = contract.add(text, source="agent")
        except contract.ContractIntegrityError as e:
            return f"contract: {e}\nNudge: repair or restore the contract file, then retry the mutation."
        except ValueError as e:
            return f"contract: {e}\nNudge: pass a concrete, non-blank constraint."
        if c is None:
            return (f"contract: identical constraint already present ({len(cons)} total)\n"
                    "Nudge: reuse the existing constraint instead of duplicating it.")
        warn = contract.brief_cap_warning(len(cons))
        return (f"added {c['id']}\n" + contract.render(cons) +
                (f"\n{warn}" if warn else "") +
                "\nNudge: keep the contract tight — fewer, sharper constraints survive re-injection.")
    if action == "remove":
        if not id:
            return "contract: 'remove' requires id\nNudge: run action=\"list\" to see current ids."
        safe_id = store.display_text(id, contract.RENDER_ID_MAX)
        try:
            removed = contract.remove(id, allow_seed=False)
        except contract.ContractIntegrityError as e:
            return f"contract: {e}\nNudge: repair or restore the contract file, then retry the mutation."
        except contract.SeedConstraintRemovalError:
            return (f"contract: {safe_id} is a seed constraint — model-driven removal is refused\n"
                    "Nudge: only the owner may remove it (CLI `contract remove ID` or /guard-contract remove).")
        if not removed:
            return (f"contract: no constraint with id {safe_id!r}\n"
                    "Nudge: run action=\"list\" to see current ids.")
        return (f"removed {safe_id}\n" + contract.render(contract.load()) +
                "\nNudge: keep the contract tight — fewer, sharper constraints survive re-injection.")
    return "contract: unknown action — use list|add|remove\nNudge: retry with a valid action."


@mcp.tool(annotations=_LOCAL_APPEND)
def guard_note(
    type: Annotated[
        str,
        Field(
            description=(
                "Journal type. Required string: decision, correction, risk, "
                "or note. Any other value returns an error line and writes nothing."
            )
        ),
    ],
    text: Annotated[
        str,
        Field(
            description=(
                "The entry body. Required string. Blank or whitespace-only "
                "text is rejected. Stored as one line, capped at 500 characters."
            )
        ),
    ],
    tags: Annotated[
        list[str] | None,
        Field(
            description=(
                "Optional tags. List of strings, default None (no caller tags). "
                "Cleaned, de-duplicated, and capped at 8 tags of 40 characters. "
                "The tag \"agent\" is always appended and cannot be crowded out. "
                "Add \"lesson\" to make a precedent. On a correction, "
                "\"satisfied\" or \"dissatisfied\" records the owner's reaction; "
                "a one-edit typo of those two words is normalized."
            )
        ),
    ] = None,
) -> str:
    """Append one agent-authored journal entry.

    Use it when a decision, correction, risk, or note should survive the
    session and the next compaction. Do not use it for a claim that a command
    passed; that belongs in `guard_verify`. `type` is a required string:
    `decision`, `correction`, `risk`, or `note`. `text` is a required string.
    `tags` is an optional list of strings, default None. The tag `agent` is
    always stored, so the entry stays unverified: it does not enter the trusted
    decisions or corrections the brief treats as owner input. Tag `lesson` to
    make a precedent the brief can re-inject. It returns `logged <type> #N`,
    the stored tags, any normalization notes, and a Nudge. Side effects: appends
    one JSON line to `.agent-guard/journal.jsonl` and creates the store if
    needed. It does not change the contract or the evidence ledger.
    """
    try:
        entry = journal.add(type, text, journal.tags_with_required(tags, "agent"))
    except ValueError as e:
        return f"note: {e}\nNudge: pass non-blank text and a valid journal type."
    return journal.render_ack(entry, journal.count())


@mcp.tool(annotations=_READ_ONLY)
def guard_journal(
    limit: Annotated[
        int,
        Field(
            description=(
                "How many newest journal entries to return. Integer. Default 5. "
                "Clamped to 0–20; 0 returns the header and nudge only."
            )
        ),
    ] = journal.READ_LIMIT_DEFAULT,
    type: Annotated[
        str | None,
        Field(
            description=(
                "Optional type filter. String or omitted. One of decision, "
                "correction, risk, note. Default None, which returns every type. "
                "Any other string returns an error line."
            )
        ),
    ] = None,
) -> str:
    """Read recent journal entries back after a compaction or a capped brief.

    Use it when the brief hid older decisions, corrections, risks, or the
    agent's own notes and you need the stored line, not a search. For a
    keyword, tag, or evidence-id search, use `guard_recall` instead. `limit`
    is an int, default 5, clamped to 0–20. `type` is an optional string,
    default None; when set it must be `decision`, `correction`, `risk`, or
    `note`. It returns `PC journal · last N of TOTAL` (or `PC journal <type>`
    when filtered), one line per entry (`timestamp · type · text [tags]`), and
    a Nudge. Side effects: none. It does not create `.agent-guard/`, does not
    append, and does not promote an `agent` tag to trusted.
    """
    try:
        entries, total = journal.recent_with_total(limit, type)
        return journal.render_recent(entries, total, type)
    except ValueError as e:
        return f"journal: {e}\nNudge: pass a valid type or omit the type filter."


@mcp.tool(annotations=_READ_ONLY)
def guard_recall(
    query: Annotated[
        str,
        Field(
            description=(
                "Keywords to find, as one string. Default empty, which does "
                "not keyword-filter. Case-insensitive; every keyword must match "
                "journal text, a verify command, or a digest. A keyword that is "
                "itself ev-NNNN also matches that evidence id. Capped at 500 "
                "characters and 12 keywords. Stopwords are dropped."
            )
        ),
    ] = "",
    type: Annotated[
        str | None,
        Field(
            description=(
                "Optional row type. String or omitted. One of decision, "
                "correction, risk, note, evidence. Default None (every type). "
                "Any other string returns an error line."
            )
        ),
    ] = None,
    tags: Annotated[
        list[str] | None,
        Field(
            description=(
                "Tags that must all be present (AND). List of strings, or "
                "omitted. Default None. Matching is exact and case-insensitive. "
                "Evidence rows have no tags, so any tag filter excludes them."
            )
        ),
    ] = None,
    limit: Annotated[
        int,
        Field(
            description=(
                "Maximum hits to return. Integer. Default 5. Clamped to 0–20. "
                "A non-integer returns an error line."
            )
        ),
    ] = recall.LIMIT_DEFAULT,
    evidence_id: Annotated[
        str | None,
        Field(
            description=(
                "Exact evidence id to require, such as ev-0007. String or "
                "omitted. Default None. ev-7 and ev-0007 match the same id. "
                "A value that is not an evidence id returns an error line."
            )
        ),
    ] = None,
    cmd: Annotated[
        str | None,
        Field(
            description=(
                "Command fingerprint, or a substring of one, matched against "
                "verify runs only. String or omitted. Default None. "
                "Fingerprint matching is case-sensitive."
            )
        ),
    ] = None,
) -> str:
    """Search the retained journal and evidence window. No embeddings and no network.

    Use it when you remember a word, tag, evidence id, or command but not which
    entry it was, including after the brief's caps hid it. Filters combine with
    AND. `query` is a string, default empty. `type` is an optional string
    (`decision`, `correction`, `risk`, `note`, or `evidence`), default None.
    `tags` is an optional list of strings, default None. `limit` is an int,
    default 5, clamped to 0–20. `evidence_id` and `cmd` are optional strings,
    default None. With a query, past bash commands from the retained events
    window are also eligible as reuse hints. It returns ranked lines labelled
    `trusted` or `agent`, then a Nudge. Rows rotated past the third ledger
    segment are already gone. Side effects: none. It does not create
    `.agent-guard/` and does not write the journal or the evidence ledger.
    Agent hits stay unverified.
    """
    try:
        result = recall.search(
            query,
            type=type,
            tags=tags,
            limit=limit,
            evidence_id=evidence_id,
            cmd=cmd,
        )
    except ValueError as e:
        return (
            f"PC recall · error: {store.display_text(e, 200)}\n"
            "Nudge: pass a valid type, evidence id, or integer limit."
        )
    return recall.render(result)


@mcp.tool(annotations=_LOCAL_INITIALIZING_READ)
def guard_loop_check() -> str:
    """Report failing-command streaks for this session and whether the next rerun blocks.

    Use it before repeating a command that just failed. The same normalized
    command, including a trailing `;` or a trailing `|| true` mask, shares one
    streak. It takes no parameters. It returns `PC loops`, up to five
    `command × count` lines, and a Nudge. When a streak is at
    `loop_block_after` (default 3), the text says the next identical run will
    be blocked. Streaks come from bash tool results and from `guard_verify`
    rows for `PC_SESSION_ID` (or `default`). An unproven exit 0 does not reset
    a streak. Side effects: if `.agent-guard/` is missing it is created, and
    `config.json` is seeded when that file is absent. It does not run the
    command and does not append the journal or the evidence ledger.
    """
    cfg = store.load_config()
    return loops.render(loops.streaks(), cfg)


@mcp.tool(annotations=_LOCAL_INITIALIZING_READ)
def guard_diff_audit(
    baseline: Annotated[
        str | None,
        Field(
            description=(
                "Git ref to diff the working tree against. String or omitted. "
                "Default None, which means HEAD (an unborn repository is "
                "compared as an unborn HEAD). Example: a commit sha. A ref git "
                "cannot resolve is reported in the text; it is not raised."
            )
        ),
    ] = None,
) -> str:
    """Audit the working tree's size against the configured line and file thresholds.

    Use it before a large edit, or when status shows a warn or hard diff, to
    see added/deleted lines, file count, and the verdict. `baseline` is an
    optional git ref string, default None (HEAD). Thresholds come from config:
    warn at 400 lines or 10 files, hard at 800 lines, unless the project or
    personal config overrides them. It returns the rendered diff audit,
    including a bounded-scan note when untracked reads hit their caps, and a
    Nudge. Outside a git repo the text says the diff is unavailable. Side
    effects: creates `.agent-guard/` and seeds `config.json` if that file is
    missing, and runs `git`. Untracked content reads are capped (1000 files,
    1 MB per file, 8 MB total). It does not modify the worktree or the ledgers.
    """
    return diffscope.render(diffscope.diff_audit(baseline))


@mcp.tool(annotations=_LOCAL_INITIALIZING_READ)
def guard_preflight() -> str:
    """Check configured tool presence and versions, and whether this directory is a git worktree.

    Use it when a tool fails in a surprising way, before blaming the code.
    It takes no parameters. The tool list is `preflight_tools` from config
    (default git, python3, pip, node, npm, rg, pytest). At most 20 entries are
    probed; extras are counted as omitted. Each present tool is run as
    `<tool> --version` with a 2 second cap, a 15 second overall deadline, and
    at most 4 KiB of output. It returns `PC preflight`, git yes/no, present
    and missing tools, any incomplete version probes, and a Nudge. Side
    effects: creates `.agent-guard/` and seeds `config.json` if needed, and
    executes those version probes. It does not install tools and does not
    append the journal or the evidence ledger.
    """
    return preflight.render(preflight.run_preflight())


@mcp.tool(annotations=_READ_ONLY)
def guard_budget() -> str:
    """Report this session's recorded tool-output size.

    Use it when the context watermark is climbing or a turn is getting large,
    to see which tools produced the bytes. It takes no parameters. It reads
    `events.jsonl` for the current session (`PC_SESSION_ID`, or `default`) and
    returns `PC budget`, the character total, an estimate of tokens (integer
    division of characters by 4), the tool-result count, the top 5 tools by
    characters, and a Nudge. Side effects: none. It does not create
    `.agent-guard/` and does not write events. A missing ledger is an empty budget.
    """
    return budget.render(budget.compute())


@mcp.tool(annotations=_READ_ONLY)
def guard_orientation() -> str:
    """Bounded repository digest: tree, languages, and conventions files.

    Use it before the first edit in an unfamiliar checkout, so the next read
    starts from CLAUDE.md, AGENTS.md, CONVENTIONS.md, README.md, or README
    when those files exist. It takes no parameters. The scan starts at the git
    worktree root when one is found, otherwise the working directory. The tree
    is capped (12 entries, 8 children, depth 3, 4000 files). It returns
    `PC orientation`, the capped tree, up to six language counts by extension,
    the conventions files found, and a Nudge. Side effects: none. It only
    reads the filesystem. It does not create `.agent-guard/` and does not use
    the network.
    """
    return orientation.digest()


def main() -> None:
    # stdio transport (default). No banner: it probes PyPI for a newer fastmcp
    # on start, and an MCP server must not depend on network/proxy health to
    # serve stdio (a SOCKS proxy without socksio aborts before the first frame).
    mcp.run(show_banner=False)


if __name__ == "__main__":
    main()
