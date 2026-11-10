"""CLI: `python -m protect_context <verb>` — same verbs as the MCP tools; the
test harness and the no-MCP fallback (SPEC §3).

Exit codes: 0 ok · 1 warning triggered · 2 error.
Every output ends with a one-line actionable "Nudge:".
"""

from __future__ import annotations

import argparse
import os
import shlex
import subprocess

from rich.console import Console

from . import (
    brief,
    budget,
    contract,
    diffscope,
    journal,
    layers,
    loops,
    orientation,
    preflight,
    recall,
    report,
    store,
    verify,
)

_CONSOLE = Console(soft_wrap=True, highlight=False, markup=False, width=200)


def _emit(text: str) -> None:
    """Write one line to stdout through rich.

    rich styles the text when stdout is a terminal and emits the plain string
    when it is not (pipes, tests), so the CLI gains colour for humans without
    changing a single asserted byte.
    """
    _CONSOLE.print(text, markup=False, highlight=False, soft_wrap=True)


NUDGE_ERROR = "Nudge: fix the error above and re-run; thresholds live in .agent-guard/config.json."


def _tags(raw: str) -> list[str]:
    return [t.strip() for t in (raw or "").split(",") if t.strip()]


def cmd_init(args: argparse.Namespace) -> int:
    store.ensure()
    cons = contract.load()  # seeds contract.json on first use
    st = store.load_state()
    sid = store.session_id()
    session_entry = store.session_state(st, sid)
    if not session_entry.get("started"):
        session_entry["started"] = store.now_ts()
    session_entry["git_head"] = diffscope.git_head()
    st["current_session"] = {
        "id": sid,
        "started": session_entry["started"],
        "git_head": session_entry["git_head"],
    }
    store.save_state(st)
    _emit(f"PC store ready · {store.guard_dir()}")
    _emit(
        f"config {len(store.load_config())} keys · contract {len(cons)} constraints · "
        f"session {store.session_id()}"
    )
    # Goal #4: the orientation digest (repo tree, languages, conventions
    # files) ships with init so the CLI surface can orient a fresh session.
    # The digest's own trailing Nudge is dropped — init's Nudge closes the
    # output (every CLI output ends with exactly one Nudge line).
    _emit("\n".join(orientation.digest().splitlines()[:-1]))
    _emit("Nudge: thresholds live in .agent-guard/config.json — tune them any time.")
    return 0


def cmd_status(args: argparse.Namespace) -> int:
    text, level = report.status()
    _emit(text)
    return level


def _join_verify_command(parts: list[str]) -> str:
    """One shell string from argv.

    A single argument is kept verbatim so ``verify "false | true"`` still
    runs the pipeline the user quoted. Several arguments are re-quoted, so
    ``verify pytest -q`` and ``verify echo "hello world"`` work. ``--timeout``
    must come before the command: argparse stops at the remainder.
    """
    parts = [part for part in parts if part != ""]
    if parts and parts[0] == "--":
        # argparse's REMAINDER keeps an explicit separator, so
        # ``verify -- npm run check`` used to run the literal string
        # "-- npm run check": the shell exited 2 and a FAIL row was recorded
        # for a command that passes (found 2026-11-10 by exercising the verbs).
        parts = parts[1:]
    if not parts:
        return ""
    if len(parts) == 1:
        return parts[0]
    if os.name == "nt":
        return subprocess.list2cmdline(parts)
    return " ".join(shlex.quote(part) for part in parts)


def cmd_verify(args: argparse.Namespace) -> int:
    command = _join_verify_command(list(args.command))
    if not command.strip():
        _emit("PC verify · error: command must not be blank")
        _emit("example: protect-context verify --timeout 60 pytest -q")
        _emit("Nudge: pass a concrete verification command tied to the claim. Put --timeout before the command.")
        return 2
    cfg = store.load_config()
    if any(part == "--timeout" or part.startswith("--timeout=") for part in args.command):
        # The flags after the command are part of the command; the help says so,
        # but silently running `npm run check --timeout 60` records a bogus FAIL.
        _emit("note: --timeout after the command is part of the command; put it before: verify --timeout 60 <cmd>")
    blocked = loops.command_block(command, cfg)
    if blocked:
        _emit(
            f"PC verify blocked · {store.display_text(blocked['cmd'], 80)} · "
            f"{blocked['count']} prior failures"
        )
        _emit("Nudge: change approach or gather new information — do not re-run unchanged.")
        return 1
    entry = verify.run_verify(command, args.timeout_s)
    _emit(verify.render_entry(entry))
    # Exit 0 is only for a trustworthy pass. A pipeline or failure mask can
    # make the shell return 0 without proving the check; that is a warning.
    if not entry["ok"] or verify.outcome_label(entry) == "UNTRUSTED":
        return 1
    return 0


def cmd_evidence(args: argparse.Namespace) -> int:
    if args.evidence_id:
        entry = verify.find(args.evidence_id)
        if entry is None:
            _emit(f"evidence: no recorded run with id {store.display_text(args.evidence_id, 40)}")
            _emit("Nudge: run `evidence` without --id to list the recent window.")
            return 2
        _emit(verify.render_entry(entry))
        return 0
    runs, total = verify.recent_with_total(args.limit)
    _emit(verify.render_recent(runs, total))
    return 0


def cmd_contract(args: argparse.Namespace) -> int:
    if args.action == "list":
        _emit(contract.render(contract.load()))
        personal = contract.user_constraint_count()
        if personal:
            _emit(
                f"personal layer: {personal} from {layers.user_contract_path()}"
                " (applies to every project; a project row with the same id or text wins)"
            )
        _emit("Nudge: honor these constraints; they are re-injected whenever they change.")
        return 0
    if args.action == "add":
        scope = contract.USER_SCOPE if getattr(args, "global_scope", False) else contract.PROJECT_SCOPE
        try:
            c, cons = contract.add(args.text, scope=scope)
        except contract.ContractIntegrityError as e:
            _emit(f"contract: {e}")
            _emit("Nudge: repair or restore the contract file, then retry the mutation.")
            return 2
        except ValueError as e:
            _emit(f"contract: {e}")
            _emit("Nudge: pass a concrete, non-blank constraint.")
            return 2
        where = "personal layer" if scope == contract.USER_SCOPE else "this project"
        if c is None:
            _emit(f"contract: identical constraint already present ({len(cons)} total)")
            _emit("Nudge: reuse the existing constraint instead of duplicating it.")
            return 0
        _emit(f"added {c['id']} to {where}")
        if len(str(args.text)) > len(c["text"]):
            # A constraint that silently loses its operative tail is worse than a
            # journal row that does: it is re-injected into every session.
            _emit(
                f"note: text truncated {len(str(args.text))} -> {len(c['text'])} chars "
                f"(TEXT_CAP {contract.MAX_TEXT})"
            )
        _emit(contract.render(cons))
        warn = contract.brief_cap_warning(cons)
        if warn:
            _emit(warn)
        _emit("Nudge: keep the contract tight — fewer, sharper constraints survive re-injection.")
        return 0
    if args.action == "remove":
        scope = contract.USER_SCOPE if getattr(args, "global_scope", False) else contract.PROJECT_SCOPE
        try:
            removed = contract.remove(args.id, scope=scope)
        except contract.ContractIntegrityError as e:
            _emit(f"contract: {e}")
            _emit("Nudge: repair or restore the contract file, then retry the mutation.")
            return 2
        safe_id = store.display_text(args.id, contract.RENDER_ID_MAX)
        if removed:
            _emit(f"removed {safe_id}")
            _emit(contract.render(contract.load()))
            _emit("Nudge: keep the contract tight — fewer, sharper constraints survive re-injection.")
            return 0
        if scope == contract.PROJECT_SCOPE and any(
            c.get("id") == args.id for c in contract.load()
        ):
            _emit(f"{safe_id} lives in the personal layer, not this project")
            _emit("Nudge: re-run with --global to remove it from every project.")
            return 2
        _emit(f"no constraint with id {safe_id!r}")
        _emit("Nudge: run 'contract list' to see current ids.")
        return 2
    _emit(NUDGE_ERROR)
    return 2


def cmd_note(args: argparse.Namespace) -> int:
    try:
        entry = journal.add(args.type, args.text, _tags(args.tags))
    except ValueError as e:
        _emit(f"PC error: {e}")
        _emit(NUDGE_ERROR)
        return 2
    _emit(journal.render_ack(entry, journal.count()))
    return 0


def cmd_journal(args: argparse.Namespace) -> int:
    entries, total = journal.recent_with_total(args.limit, args.type)
    _emit(journal.render_recent(entries, total, args.type))
    return 0


def cmd_intent(args: argparse.Namespace) -> int:
    rows, total, counts = journal.intent_with_total(args.limit)
    _emit(journal.render_intent(rows, total, counts))
    return 0


def cmd_brief(args: argparse.Namespace) -> int:
    """The same brief the pi extension injects, built from the same store."""
    _emit(brief.render(brief.compose_brief(), args.limit))
    return 0


def cmd_recall(args: argparse.Namespace) -> int:
    try:
        result = recall.search(
            args.query or "",
            type=args.type,
            tags=_tags_and(args.tag),
            limit=args.limit,
            evidence_id=args.evidence_id,
            cmd=args.cmd,
        )
    except ValueError as e:
        _emit(f"PC recall · error: {store.display_text(e, 200)}")
        _emit(NUDGE_ERROR)
        return 2
    _emit(recall.render(result))
    return 0


def _tags_and(raw_list: list[str] | None) -> list[str]:
    found: list[str] = []
    for raw in raw_list or []:
        found.extend(_tags(raw))
    return found


def cmd_loops(args: argparse.Namespace) -> int:
    cfg = store.load_config()
    streak_list = loops.streaks()
    _emit(loops.render(streak_list, cfg))
    return 1 if loops.would_block(streak_list, cfg) else 0


def cmd_diff(args: argparse.Namespace) -> int:
    st = diffscope.diff_audit(args.baseline)
    _emit(diffscope.render(st))
    if "error" in st:
        return 2
    return 0 if st["verdict"] == "ok" else 1


def cmd_preflight(args: argparse.Namespace) -> int:
    res = preflight.run_preflight()
    _emit(preflight.render(res))
    return 1 if (
        res["missing"]
        or not res["git_repo"]
        or res.get("omitted_tools")
        or res.get("probe_issues")
    ) else 0


def cmd_budget(args: argparse.Namespace) -> int:
    _emit(budget.render(budget.compute()))
    return 0


def cmd_orientation(args: argparse.Namespace) -> int:
    _emit(orientation.digest())
    return 0


def cmd_mcp(args: argparse.Namespace) -> int:
    # Same stdio server as `python -m protect_context.mcp_server`; this verb is
    # what the registry package entry launches (`uvx protect-context mcp`).
    from .mcp_server import main as serve

    serve()
    return 0


def build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(
        prog="protect_context",
        description="protect-context guardrail CLI (advisory-first; no network, no LLM)",
    )
    sub = p.add_subparsers(dest="verb", required=True)

    sp = sub.add_parser("init", help="create .agent-guard/ with default config + seed contract")
    sp.set_defaults(func=cmd_init)

    sp = sub.add_parser("status", help="compact status dashboard")
    sp.set_defaults(func=cmd_status)

    sp = sub.add_parser(
        "verify",
        help="run a shell command and record evidence (put --timeout before the command)",
    )
    sp.add_argument("--timeout", dest="timeout_s", type=int, default=180)
    sp.add_argument(
        "command",
        nargs=argparse.REMAINDER,
        help="shell command: one quoted string, or words (flags such as -q are part of the command)",
    )
    sp.set_defaults(func=cmd_verify)

    sp = sub.add_parser("evidence", help="recent verify runs")
    sp.add_argument("--limit", type=int, default=5)
    sp.add_argument("--id", dest="evidence_id", default=None, help="show one run in full (ev-NNNN)")
    sp.set_defaults(func=cmd_evidence)

    sp = sub.add_parser("contract", help="contract store: list | add TEXT | remove ID")
    csub = sp.add_subparsers(dest="action", required=True)
    csub.add_parser("list")
    a = csub.add_parser("add")
    a.add_argument("text")
    a.add_argument(
        "--global",
        dest="global_scope",
        action="store_true",
        help="add to the personal layer (~/.config/protect-context) instead of this project",
    )
    r = csub.add_parser("remove")
    r.add_argument("id")
    r.add_argument(
        "--global",
        dest="global_scope",
        action="store_true",
        help="remove from the personal layer instead of this project",
    )
    sp.set_defaults(func=cmd_contract)

    sp = sub.add_parser("note", help="journal entry: decision|correction|risk|note TEXT")
    sp.add_argument("type", choices=list(store.JOURNAL_TYPES))
    sp.add_argument("text")
    sp.add_argument("--tags", default="", help="comma-separated tags")
    sp.set_defaults(func=cmd_note)

    sp = sub.add_parser("journal", help="read recent journal entries")
    sp.add_argument("--limit", type=int, default=journal.READ_LIMIT_DEFAULT)
    sp.add_argument("--type", choices=list(store.JOURNAL_TYPES), default=None)
    sp.set_defaults(func=cmd_journal)

    sp = sub.add_parser(
        "intent",
        help="owner wants, needs, preferences and corrections from the journal",
    )
    sp.add_argument("--limit", type=int, default=journal.READ_LIMIT_DEFAULT)
    sp.set_defaults(func=cmd_intent)

    sp = sub.add_parser(
        "brief",
        help="the compact pre-agent brief, rendered from this project's store",
    )
    sp.add_argument("--limit", type=int, default=20)
    sp.set_defaults(func=cmd_brief)

    sp = sub.add_parser(
        "recall",
        help="search the retained journal and evidence window (no embeddings)",
    )
    sp.add_argument("query", nargs="?", default="", help="keywords (AND); case-insensitive substring")
    sp.add_argument("--type", choices=list(recall.RECALL_TYPES), default=None)
    sp.add_argument(
        "--tag",
        action="append",
        default=[],
        help="required tag (repeatable, AND). Commas inside one flag are also AND",
    )
    sp.add_argument("--limit", type=int, default=recall.LIMIT_DEFAULT)
    sp.add_argument("--evidence-id", default=None, help="exact evidence id (ev-NNNN)")
    sp.add_argument(
        "--cmd",
        default=None,
        help="fingerprint or substring matched against verify-run commands",
    )
    sp.set_defaults(func=cmd_recall)

    sp = sub.add_parser("loops", help="failing-command streaks")
    sp.set_defaults(func=cmd_loops)

    sp = sub.add_parser("diff", help="diff audit vs HEAD (or --baseline ref)")
    sp.add_argument("--baseline", default=None)
    sp.set_defaults(func=cmd_diff)

    sp = sub.add_parser("preflight", help="tool presence/versions + git repo check")
    sp.set_defaults(func=cmd_preflight)

    sp = sub.add_parser("budget", help="session tool-output budget")
    sp.set_defaults(func=cmd_budget)

    sp = sub.add_parser("orientation", help="bounded repo tree, languages, and conventions")
    sp.set_defaults(func=cmd_orientation)

    sp = sub.add_parser("mcp", help="serve the MCP tools on stdio (terminal session)")
    sp.set_defaults(func=cmd_mcp)

    return p


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    try:
        return int(args.func(args))
    except KeyboardInterrupt:  # pragma: no cover
        _emit(NUDGE_ERROR)
        return 2
    except Exception as e:  # CLI boundary: report compactly, never crash ugly
        _emit(f"PC error: {store.display_text(e, 240) or 'operation failed'}")
        _emit(NUDGE_ERROR)
        return 2


if __name__ == "__main__":  # `python -m protect_context.cli` = `python -m protect_context`
    raise SystemExit(main())
