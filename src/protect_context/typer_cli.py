"""Typed front door for the guard CLI, built on typer.

`typer` owns parsing, help text and shell completion; every command delegates to
the same ``cli.cmd_*`` handler that the argparse entry point uses, so a verb has
exactly one implementation. Exit codes are propagated unchanged, which keeps the
two front doors behaviourally identical where the tests care.

Run it with ``python -m protect_context.typer_cli <verb>`` or the
``protect-context-typer`` console script.
"""

from __future__ import annotations

from argparse import Namespace

import typer

from . import cli, journal, recall, store

app = typer.Typer(
    add_completion=False,
    no_args_is_help=True,
    help="protect-context guardrail CLI (typer front door; advisory-first, no network, no LLM)",
)


def _run(handler, **kwargs: object) -> None:
    """Call an argparse-shaped handler and turn its code into a typer exit."""
    raise typer.Exit(code=int(handler(Namespace(func=handler, **kwargs))))


@app.command()
def init() -> None:
    """create .agent-guard/ with default config + seed contract"""
    _run(cli.cmd_init)


@app.command()
def status() -> None:
    """compact status dashboard"""
    _run(cli.cmd_status)


@app.command()
def verify(
    command: list[str] = typer.Argument(..., help="verification command and its arguments"),
    timeout_s: int = typer.Option(60, "--timeout", help="seconds before the run is killed"),
) -> None:
    """run a command, record it as evidence, report trusted/untrusted"""
    _run(cli.cmd_verify, command=command, timeout_s=timeout_s)


@app.command()
def evidence(
    limit: int = typer.Option(journal.READ_LIMIT_DEFAULT, "--limit"),
    evidence_id: str | None = typer.Option(None, "--id", help="exact evidence id (ev-NNNN)"),
) -> None:
    """list the recent evidence window, or one run by id"""
    _run(cli.cmd_evidence, limit=limit, evidence_id=evidence_id)


@app.command()
def note(
    kind: str = typer.Argument(..., metavar="TYPE", help="decision|correction|risk|note"),
    text: str = typer.Argument(..., help="the journal entry"),
    tags: str = typer.Option("", "--tags", help="comma-separated tags"),
) -> None:
    """journal entry: decision|correction|risk|note TEXT"""
    _run(cli.cmd_note, type=kind, text=text, tags=tags)


@app.command()
def journal_(
    limit: int = typer.Option(journal.READ_LIMIT_DEFAULT, "--limit"),
    kind: str | None = typer.Option(None, "--type"),
) -> None:
    """read recent journal entries"""
    _run(cli.cmd_journal, limit=limit, type=kind)


app.command(name="journal")(journal_)


@app.command()
def intent(limit: int = typer.Option(journal.READ_LIMIT_DEFAULT, "--limit")) -> None:
    """owner wants, needs, preferences and corrections"""
    _run(cli.cmd_intent, limit=limit)


@app.command()
def recall_(
    query: str = typer.Argument("", help="keywords (AND); case-insensitive substring"),
    kind: str | None = typer.Option(None, "--type"),
    tags: str = typer.Option("", "--tags"),
    cmd: str = typer.Option("", "--cmd"),
    limit: int = typer.Option(recall.LIMIT_DEFAULT, "--limit"),
) -> None:
    """search the retained journal and evidence window"""
    _run(cli.cmd_recall, query=query, type=kind, tags=tags, cmd=cmd, limit=limit)


app.command(name="recall")(recall_)


@app.command()
def loops() -> None:
    """failing-command streaks"""
    _run(cli.cmd_loops)


@app.command()
def diff(baseline: str | None = typer.Option(None, "--baseline")) -> None:
    """diff audit vs HEAD (or --baseline ref)"""
    _run(cli.cmd_diff, baseline=baseline)


@app.command()
def preflight() -> None:
    """tool presence/versions + git repo check"""
    _run(cli.cmd_preflight)


@app.command()
def budget(limit: int = typer.Option(5, "--limit")) -> None:
    """session tool-output budget"""
    _run(cli.cmd_budget, limit=limit)


@app.command()
def orientation() -> None:
    """bounded repo tree, languages, and conventions"""
    _run(cli.cmd_orientation)


@app.command()
def mcp() -> None:
    """serve the MCP tools on stdio (terminal session)"""
    _run(cli.cmd_mcp)


@app.command()
def contract_(
    action: str = typer.Argument(..., metavar="ACTION", help="list|add|remove"),
    text: str = typer.Argument("", help="constraint text (add)"),
    cid: str = typer.Argument("", metavar="ID", help="constraint id (remove)"),
) -> None:
    """manage this project's contract"""
    _run(cli.cmd_contract, action=action, text=text, id=cid)


app.command(name="contract")(contract_)


if __name__ == "__main__":
    app()


__all__ = ["app", "store"]
