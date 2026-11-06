"""protect-context MCP server — the explicit/portable guardrail layer
(SPEC §4). Same on-disk store as the pi extension and the CLI
(.agent-guard/ in the server's working directory).

Run: python -m protect_context.mcp_server   (stdio transport)

Hosts configure it via a standard .mcp.json, e.g.:

    {"mcpServers": {"protect-context": {
        "command": "/abs/path/.venv/bin/python",
        "args": ["-m", "protect_context.mcp_server"]}}}

All tools return compact text; the last line is always an actionable Nudge.
"""

from __future__ import annotations

from fastmcp import FastMCP
from mcp.types import ToolAnnotations

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
    """Dashboard: session, diff delta, loop streaks, evidence count, contract size, last verify."""
    text, _level = report.status()
    return text


@mcp.tool(annotations=_SHELL_EXECUTION)
def guard_verify(command: str, timeout_s: int = 180) -> str:
    """Run a command and RECORD the outcome as evidence (id, exit, digest) in
    verify_runs.jsonl. shell=True is by design: the command runs verbatim with
    the caller's own privileges — this is an evidence ledger, not a sandbox.
    Never raises on nonzero exit; failures are recorded (that is the point).
    timeout_s is clamped to [1, 900] so a runaway value cannot wedge the host.
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
def guard_evidence(limit: int = 5) -> str:
    """Recent verification runs from the evidence ledger."""
    return verify.render_recent(verify.recent(limit), verify.count())


@mcp.tool(annotations=_LOCAL_MUTATION)
def guard_contract(action: str, text: str | None = None, id: str | None = None) -> str:
    """Contract store: action="list" | "add" (with text) | "remove" (with id).
    Seed constraints (source="seed") cannot be removed by the model — the owner
    removes them via the CLI or /guard-contract, so a model cannot delete its
    own injected guardrails (e.g. 02-evidence-before-success)."""
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
def guard_note(type: str, text: str, tags: list[str] = []) -> str:
    """Journal an agent-authored entry with a durable ``agent`` provenance tag."""
    try:
        entry = journal.add(type, text, journal.tags_with_required(tags, "agent"))
    except ValueError as e:
        return f"note: {e}\nNudge: pass non-blank text and a valid journal type."
    return journal.render_ack(entry, journal.count())


@mcp.tool(annotations=_READ_ONLY)
def guard_journal(limit: int = journal.READ_LIMIT_DEFAULT, type: str | None = None) -> str:
    """Read recent journal entries, optionally filtered by journal type.

    limit is clamped to a compact, finite range at the journal boundary.
    """
    try:
        entries = journal.recent(limit, type)
        return journal.render_recent(entries, journal.count(type), type)
    except ValueError as e:
        return f"journal: {e}\nNudge: pass a valid type or omit the type filter."


@mcp.tool(annotations=_READ_ONLY)
def guard_recall(
    query: str = "",
    type: str | None = None,
    tags: list[str] | None = None,
    limit: int = recall.LIMIT_DEFAULT,
    evidence_id: str | None = None,
    cmd: str | None = None,
) -> str:
    """Search the retained journal and evidence window. No embeddings.

    Keywords are case-insensitive substrings of text, cmd, and digest; every
    keyword must match (a keyword that is itself ev-NNNN also matches that
    evidence id). tags are AND and case-insensitive; evidence rows have no
    tags, so a tag filter excludes them. type is decision|correction|risk|note
    |evidence. evidence_id is an exact ev-NNNN id (ev-7 and ev-0007 match).
    cmd is a fingerprint or substring of a verify run. Hits are ranked by
    match strength, then recency, and labelled trusted or agent. Read-only:
    does not create the store. limit is clamped to 0–20 (default 5).
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
    """Failing-command streaks for this session + change-strategy advice."""
    cfg = store.load_config()
    return loops.render(loops.streaks(), cfg)


@mcp.tool(annotations=_LOCAL_INITIALIZING_READ)
def guard_diff_audit(baseline: str | None = None) -> str:
    """Diff audit vs HEAD (or a baseline ref): numstat stats + verdict vs thresholds."""
    return diffscope.render(diffscope.diff_audit(baseline))


@mcp.tool(annotations=_LOCAL_INITIALIZING_READ)
def guard_preflight() -> str:
    """Tool presence/versions for configured tools + git-repo check."""
    return preflight.render(preflight.run_preflight())


@mcp.tool(annotations=_READ_ONLY)
def guard_budget() -> str:
    """Session tool-output chars, estimated tokens (chars/4), top-5 tools."""
    return budget.render(budget.compute())


@mcp.tool(annotations=_READ_ONLY)
def guard_orientation() -> str:
    """Bounded repository tree, language counts, and conventions files."""
    return orientation.digest()


def main() -> None:
    # stdio transport (default). No banner: it probes PyPI for a newer fastmcp
    # on start, and an MCP server must not depend on network/proxy health to
    # serve stdio (a SOCKS proxy without socksio aborts before the first frame).
    mcp.run(show_banner=False)


if __name__ == "__main__":
    main()
