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

from . import (
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
    print(f"PC store ready · {store.guard_dir()}")
    print(
        f"config {len(store.load_config())} keys · contract {len(cons)} constraints · "
        f"session {store.session_id()}"
    )
    # Goal #4: the orientation digest (repo tree, languages, conventions
    # files) ships with init so the CLI surface can orient a fresh session.
    # The digest's own trailing Nudge is dropped — init's Nudge closes the
    # output (every CLI output ends with exactly one Nudge line).
    print("\n".join(orientation.digest().splitlines()[:-1]))
    print("Nudge: thresholds live in .agent-guard/config.json — tune them any time.")
    return 0


def cmd_status(args: argparse.Namespace) -> int:
    text, level = report.status()
    print(text)
    return level


def _join_verify_command(parts: list[str]) -> str:
    """One shell string from argv.

    A single argument is kept verbatim so ``verify "false | true"`` still
    runs the pipeline the user quoted. Several arguments are re-quoted, so
    ``verify pytest -q`` and ``verify echo "hello world"`` work. ``--timeout``
    must come before the command: argparse stops at the remainder.
    """
    parts = [part for part in parts if part != ""]
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
        print("PC verify · error: command must not be blank")
        print("example: protect-context verify --timeout 60 pytest -q")
        print("Nudge: pass a concrete verification command tied to the claim. Put --timeout before the command.")
        return 2
    cfg = store.load_config()
    blocked = loops.command_block(command, cfg)
    if blocked:
        print(
            f"PC verify blocked · {store.display_text(blocked['cmd'], 80)} · "
            f"{blocked['count']} prior failures"
        )
        print("Nudge: change approach or gather new information — do not re-run unchanged.")
        return 1
    entry = verify.run_verify(command, args.timeout_s)
    print(verify.render_entry(entry))
    # Exit 0 is only for a trustworthy pass. A pipeline or failure mask can
    # make the shell return 0 without proving the check; that is a warning.
    if not entry["ok"] or verify.outcome_label(entry) == "UNTRUSTED":
        return 1
    return 0


def cmd_evidence(args: argparse.Namespace) -> int:
    if args.evidence_id:
        entry = verify.find(args.evidence_id)
        if entry is None:
            print(f"evidence: no recorded run with id {store.display_text(args.evidence_id, 40)}")
            print("Nudge: run `evidence` without --id to list the recent window.")
            return 2
        print(verify.render_entry(entry))
        return 0
    runs, total = verify.recent_with_total(args.limit)
    print(verify.render_recent(runs, total))
    return 0


def cmd_contract(args: argparse.Namespace) -> int:
    if args.action == "list":
        print(contract.render(contract.load()))
        personal = contract.user_constraint_count()
        if personal:
            print(
                f"personal layer: {personal} from {layers.user_contract_path()}"
                " (applies to every project; a project row with the same id or text wins)"
            )
        print("Nudge: honor these constraints; they are re-injected whenever they change.")
        return 0
    if args.action == "add":
        scope = contract.USER_SCOPE if getattr(args, "global_scope", False) else contract.PROJECT_SCOPE
        try:
            c, cons = contract.add(args.text, scope=scope)
        except contract.ContractIntegrityError as e:
            print(f"contract: {e}")
            print("Nudge: repair or restore the contract file, then retry the mutation.")
            return 2
        except ValueError as e:
            print(f"contract: {e}")
            print("Nudge: pass a concrete, non-blank constraint.")
            return 2
        where = "personal layer" if scope == contract.USER_SCOPE else "this project"
        if c is None:
            print(f"contract: identical constraint already present ({len(cons)} total)")
            print("Nudge: reuse the existing constraint instead of duplicating it.")
            return 0
        print(f"added {c['id']} to {where}")
        print(contract.render(cons))
        warn = contract.brief_cap_warning(len(cons))
        if warn:
            print(warn)
        print("Nudge: keep the contract tight — fewer, sharper constraints survive re-injection.")
        return 0
    if args.action == "remove":
        scope = contract.USER_SCOPE if getattr(args, "global_scope", False) else contract.PROJECT_SCOPE
        try:
            removed = contract.remove(args.id, scope=scope)
        except contract.ContractIntegrityError as e:
            print(f"contract: {e}")
            print("Nudge: repair or restore the contract file, then retry the mutation.")
            return 2
        safe_id = store.display_text(args.id, contract.RENDER_ID_MAX)
        if removed:
            print(f"removed {safe_id}")
            print(contract.render(contract.load()))
            print("Nudge: keep the contract tight — fewer, sharper constraints survive re-injection.")
            return 0
        if scope == contract.PROJECT_SCOPE and any(
            c.get("id") == args.id for c in contract.load()
        ):
            print(f"{safe_id} lives in the personal layer, not this project")
            print("Nudge: re-run with --global to remove it from every project.")
            return 2
        print(f"no constraint with id {safe_id!r}")
        print("Nudge: run 'contract list' to see current ids.")
        return 2
    print(NUDGE_ERROR)
    return 2


def cmd_note(args: argparse.Namespace) -> int:
    try:
        entry = journal.add(args.type, args.text, _tags(args.tags))
    except ValueError as e:
        print(f"PC error: {e}")
        print(NUDGE_ERROR)
        return 2
    print(journal.render_ack(entry, journal.count()))
    return 0


def cmd_journal(args: argparse.Namespace) -> int:
    entries, total = journal.recent_with_total(args.limit, args.type)
    print(journal.render_recent(entries, total, args.type))
    return 0


def cmd_intent(args: argparse.Namespace) -> int:
    rows, total, counts = journal.intent_with_total(args.limit)
    print(journal.render_intent(rows, total, counts))
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
        print(f"PC recall · error: {store.display_text(e, 200)}")
        print(NUDGE_ERROR)
        return 2
    print(recall.render(result))
    return 0


def _tags_and(raw_list: list[str] | None) -> list[str]:
    found: list[str] = []
    for raw in raw_list or []:
        found.extend(_tags(raw))
    return found


def cmd_loops(args: argparse.Namespace) -> int:
    cfg = store.load_config()
    streak_list = loops.streaks()
    print(loops.render(streak_list, cfg))
    return 1 if loops.would_block(streak_list, cfg) else 0


def cmd_diff(args: argparse.Namespace) -> int:
    st = diffscope.diff_audit(args.baseline)
    print(diffscope.render(st))
    if "error" in st:
        return 2
    return 0 if st["verdict"] == "ok" else 1


def cmd_preflight(args: argparse.Namespace) -> int:
    res = preflight.run_preflight()
    print(preflight.render(res))
    return 1 if (
        res["missing"]
        or not res["git_repo"]
        or res.get("omitted_tools")
        or res.get("probe_issues")
    ) else 0


def cmd_budget(args: argparse.Namespace) -> int:
    print(budget.render(budget.compute()))
    return 0


def cmd_orientation(args: argparse.Namespace) -> int:
    print(orientation.digest())
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
        print(NUDGE_ERROR)
        return 2
    except Exception as e:  # CLI boundary: report compactly, never crash ugly
        print(f"PC error: {store.display_text(e, 240) or 'operation failed'}")
        print(NUDGE_ERROR)
        return 2


if __name__ == "__main__":  # `python -m protect_context.cli` = `python -m protect_context`
    raise SystemExit(main())
