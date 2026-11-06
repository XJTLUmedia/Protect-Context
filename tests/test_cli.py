"""CLI smoke for EVERY verb; exit codes 0 ok / 1 warning / 2 error (SPEC §3, §7)."""

import json
import os
import subprocess
import sys
from pathlib import Path

from protect_context import journal, store, verify
from protect_context.cli import main


def _fail(cmd, session="test-session"):
    return {"kind": "tool_result", "tool": "bash", "ok": False, "cmd": cmd, "exit": 1,
            "session": session}


def _git(*args):
    subprocess.run(["git", *args], check=True, capture_output=True)


# ---- init -------------------------------------------------------------------

def test_init_creates_store_and_nudges(capsys):
    assert main(["init"]) == 0
    out = capsys.readouterr().out
    assert "Nudge:" in out
    assert (store.guard_dir() / "config.json").exists()
    assert (store.guard_dir() / "contract.json").exists()
    st = store.load_state()
    assert st["current_session"]["id"] == "test-session"


# ---- status -----------------------------------------------------------------

def test_status_smoke(capsys):
    main(["init"])
    assert main(["status"]) == 1
    out = capsys.readouterr().out
    assert "PC status" in out
    assert out.rstrip().splitlines()[-1].startswith("Nudge:")


# ---- verify -----------------------------------------------------------------

def test_verify_ok_and_fail_exit_codes(capsys):
    main(["init"])
    assert main(["verify", "true"]) == 0
    assert main(["verify", "false"]) == 1
    out = capsys.readouterr().out
    assert "ev-0001" in out and "ev-0002" in out
    assert "Nudge:" in out
    assert verify.count() == 2


def test_verify_blank_is_error_and_records_nothing(capsys):
    assert main(["verify", "  \t "]) == 2
    out = capsys.readouterr().out
    assert "must not be blank" in out
    assert out.rstrip().splitlines()[-1].startswith("Nudge:")
    assert verify.count() == 0


def test_third_identical_failed_verify_is_blocked_without_evidence(capsys):
    assert main(["verify", "false"]) == 1
    assert main(["verify", "false"]) == 1
    assert main(["verify", "false"]) == 1

    out = capsys.readouterr().out
    assert "PC verify blocked" in out
    assert out.rstrip().splitlines()[-1].startswith("Nudge:")
    assert verify.count() == 2


# ---- evidence ---------------------------------------------------------------

def test_evidence_smoke(capsys):
    verify.run_verify("true")
    verify.run_verify("true")
    assert main(["evidence", "--limit", "1"]) == 0
    out = capsys.readouterr().out
    assert "last 1 of 2" in out and "ev-0002" in out and "Nudge:" in out


# ---- contract ---------------------------------------------------------------

def test_contract_list_add_remove(capsys):
    assert main(["contract", "list"]) == 0
    out = capsys.readouterr().out
    assert "contract (12 constraints)" in out and "Nudge:" in out

    assert main(["contract", "add", "Keep PRs under 300 lines"]) == 0
    out = capsys.readouterr().out
    assert "13-keep-prs-under-300" in out

    data = json.loads(store.contract_path().read_text(encoding="utf-8"))
    new_id = data["constraints"][-1]["id"]
    assert new_id == "13-keep-prs-under-300"
    assert main(["contract", "remove", new_id]) == 0
    assert main(["contract", "remove", "zzz-unknown"]) == 2  # error
    out = capsys.readouterr().out
    assert "Nudge:" in out


def test_contract_add_blank_is_error(capsys):
    assert main(["contract", "add", "  "]) == 2
    out = capsys.readouterr().out
    assert "must not be blank" in out
    assert out.rstrip().splitlines()[-1].startswith("Nudge:")


# ---- note -------------------------------------------------------------------

def test_note_with_tags(capsys):
    assert main(["note", "correction", "Use rg, not grep", "--tags", "search,env"]) == 0
    out = capsys.readouterr().out
    assert "logged correction #1" in out and "search, env" in out
    assert "Nudge:" in out
    entry = journal.recent(1)[0]
    assert entry["tags"] == ["search", "env"] and entry["type"] == "correction"


def test_note_rejects_blank_text(capsys):
    assert main(["note", "decision", "\n\t"]) == 2
    out = capsys.readouterr().out
    assert "must not be blank" in out and "Nudge:" in out
    assert journal.count() == 0


# ---- journal ---------------------------------------------------------------

def test_journal_reads_recent_entries_and_filters_type(capsys):
    journal.add("decision", "Keep the public API stable", ["api"])
    journal.add("correction", "Use rg, not grep", ["search"])

    assert main(["journal", "--limit", "1"]) == 0
    out = capsys.readouterr().out
    assert "last 1 of 2" in out and "Use rg, not grep" in out
    assert "Keep the public API stable" not in out
    assert out.rstrip().splitlines()[-1].startswith("Nudge:")

    assert main(["journal", "--type", "decision", "--limit", "9999"]) == 0
    out = capsys.readouterr().out
    assert "PC journal decision · last 1 of 1" in out
    assert "Keep the public API stable" in out
    assert "Use rg, not grep" not in out


# ---- recall -----------------------------------------------------------------

def test_recall_filters_keywords_tags_and_evidence_id(capsys):
    journal.add("decision", "Prefer ripgrep for search", ["search"])
    journal.add("note", "agent thought about embeddings", ["agent"])
    verify.run_verify("true")

    assert main(["recall", "ripgrep", "--tag", "search"]) == 0
    out = capsys.readouterr().out
    assert "trusted · decision" in out and "Prefer ripgrep" in out
    assert "embeddings" not in out
    assert out.rstrip().splitlines()[-1].startswith("Nudge:")

    assert main(["recall", "--evidence-id", "ev-1", "--limit", "5"]) == 0
    out = capsys.readouterr().out
    assert "ev-0001" in out and "trusted · evidence" in out
    assert "ripgrep" not in out

    assert main(["recall", "--evidence-id", "not-an-id"]) == 2
    out = capsys.readouterr().out
    assert "ev-NNNN" in out
    assert out.rstrip().splitlines()[-1].startswith("Nudge:")


def test_recall_does_not_create_a_store(capsys):
    assert main(["recall", "anything"]) == 0
    out = capsys.readouterr().out
    assert "0 hits" in out and out.rstrip().splitlines()[-1].startswith("Nudge:")
    assert not store.guard_dir().exists()


# ---- loops ------------------------------------------------------------------

def test_loops_exit_1_at_block_threshold(write_events, capsys):
    write_events([_fail("pytest -q"), _fail("pytest -q")])
    assert main(["loops"]) == 1
    out = capsys.readouterr().out
    assert "pytest -q ×2" in out and "Nudge:" in out


def test_loops_exit_0_below_threshold(write_events, capsys):
    write_events([_fail("pytest -q")])
    assert main(["loops"]) == 0
    assert "Nudge:" in capsys.readouterr().out


# ---- diff -------------------------------------------------------------------

def test_diff_error_outside_repo(capsys):
    assert main(["diff"]) == 2
    out = capsys.readouterr().out
    assert "error" in out and "Nudge:" in out


def test_diff_ok_then_warn_in_repo(capsys):
    _git("init", "-q")
    _git("-c", "user.email=pc@test", "-c", "user.name=pc", "commit", "--allow-empty",
         "-qm", "init")
    Path("f.txt").write_text("x\n" * 5)
    _git("add", "f.txt")  # untracked files are invisible to `git diff HEAD`
    assert main(["diff"]) == 0
    Path("f.txt").write_text("x\n" * 450)
    assert main(["diff"]) == 1
    out = capsys.readouterr().out
    assert "verdict warn" in out and "Nudge:" in out


# ---- preflight --------------------------------------------------------------

def test_preflight_exit_codes_follow_missing_tools(capsys):
    store.ensure()
    from protect_context.defaults import DEFAULT_CONFIG

    store.write_json(store.config_path(),
                     dict(DEFAULT_CONFIG, preflight_tools=["python3"]))
    assert main(["preflight"]) == 1  # tools exist, but cwd is not a git repo
    _git("init", "-q")
    assert main(["preflight"]) == 0
    store.write_json(store.config_path(),
                     dict(DEFAULT_CONFIG, preflight_tools=["no-such-tool-xyz"]))
    assert main(["preflight"]) == 1
    assert "Nudge:" in capsys.readouterr().out


# ---- budget -----------------------------------------------------------------

def test_budget_smoke(capsys):
    main(["init"])
    assert main(["budget"]) == 0
    out = capsys.readouterr().out
    assert "0 chars" in out and "Nudge:" in out


# ---- error mapping ----------------------------------------------------------

def test_missing_binary_is_warning_not_error(capsys):
    rc = main(["verify", "definitely-missing-binary-xyz"])
    assert rc == 1  # recorded evidence of failure, not a tool error
    out = capsys.readouterr().out
    assert "exit 127" in out and "Nudge:" in out


# ---- orientation wiring (goal #4) --------------------------------------------

def test_init_includes_orientation_digest(capsys):
    """`init` folds the orientation brief (tree, languages, conventions) into
    its output — goal #4 must be reachable from the CLI delivery surface."""
    assert main(["init"]) == 0
    out = capsys.readouterr().out
    assert "PC orientation" in out
    assert "languages:" in out and "conventions:" in out
    assert out.rstrip().splitlines()[-1].startswith("Nudge:")


def test_orientation_read_surface(capsys):
    Path("AGENTS.md").write_text("# rules\n", encoding="utf-8")

    assert main(["orientation"]) == 0

    out = capsys.readouterr().out
    assert "PC orientation" in out and "AGENTS.md" in out
    assert out.rstrip().splitlines()[-1].startswith("Nudge:")


# ---- contract add: brief-cap warning -----------------------------------------

def test_contract_add_warns_past_brief_cap(capsys):
    """The 13th constraint exceeds the frozen cap: the ack must disclose
    provenance-aware selection rather than claim append-order truncation."""
    assert main(["contract", "add", "Keep PRs under 300 lines"]) == 0
    out = capsys.readouterr().out
    assert "highest-priority owner/seed" in out
    assert "Nudge:" in out
    assert out.rstrip().splitlines()[-1].startswith("Nudge:")


# ---- module entry -------------------------------------------------------------

def test_cli_module_entry_runs_the_cli(tmp_path):
    """`python -m protect_context.cli` must run the CLI, never silently no-op
    with exit 0 (goal 2: no unevidenced success)."""
    proc = subprocess.run(
        [sys.executable, "-m", "protect_context.cli", "status"],
        capture_output=True,
        text=True,
        cwd=tmp_path,
        env={**os.environ, "PC_SESSION_ID": "test-session"},
    )
    assert proc.returncode in (0, 1)
    assert "PC status" in proc.stdout
    assert proc.stdout.rstrip().splitlines()[-1].startswith("Nudge:")


def _speak_mcp(tmp_path, env_extra):
    """Drive `python -m protect_context mcp` through initialize + tools/list.

    Returns (returncode, stderr, initialize result, tools list). Responses are
    read one per write because a real host keeps stdin open.
    """
    init = {
        "jsonrpc": "2.0", "id": 1, "method": "initialize",
        "params": {"protocolVersion": "2025-06-18", "capabilities": {},
                   "clientInfo": {"name": "pytest", "version": "0"}},
    }
    follow_up = [
        {"jsonrpc": "2.0", "method": "notifications/initialized"},
        {"jsonrpc": "2.0", "id": 2, "method": "tools/list"},
    ]
    proc = subprocess.Popen(
        [sys.executable, "-m", "protect_context", "mcp"],
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        cwd=tmp_path,
        env={**os.environ, "PC_SESSION_ID": "test-session", **env_extra},
    )
    stdin, stdout, stderr_pipe = proc.stdin, proc.stdout, proc.stderr
    assert stdin is not None and stdout is not None and stderr_pipe is not None
    try:
        stdin.write(json.dumps(init) + "\n")
        stdin.flush()
        hello = json.loads(stdout.readline())
        stdin.write("".join(json.dumps(r) + "\n" for r in follow_up))
        stdin.flush()
        listed = json.loads(stdout.readline())
    finally:
        stdin.close()
        stderr = stderr_pipe.read()
        stderr_pipe.close()
        proc.wait(timeout=60)
    return proc.returncode, stderr, hello, listed


def test_mcp_verb_serves_mcp_on_stdio(tmp_path):
    """`protect-context mcp` is the launch command the MCP registry entry
    declares (`uvx protect-context mcp`), so it must speak MCP on stdio."""
    rc, stderr, hello, listed = _speak_mcp(tmp_path, {})
    assert rc == 0, stderr
    assert hello["result"]["serverInfo"]["name"] == "protect-context"
    assert "guard_status" in {t["name"] for t in listed["result"]["tools"]}


def test_mcp_verb_starts_even_when_proxy_env_is_broken(tmp_path):
    """fastmcp's start banner probes PyPI for a newer version and only catches
    httpx.HTTPError, so a SOCKS proxy without `socksio` aborts the server before
    the first frame. The server must never depend on network health to serve
    stdio (regression: `uvx protect-context mcp` died behind such a proxy)."""
    socks = "socks5://127.0.0.1:9"
    rc, stderr, hello, listed = _speak_mcp(tmp_path, {
        # cold version-check cache: the fetch would run if the banner ran
        "FASTMCP_HOME": str(tmp_path / "fastmcp-home"),
        "ALL_PROXY": socks, "all_proxy": socks,
        "HTTP_PROXY": socks, "http_proxy": socks,
        "HTTPS_PROXY": socks, "https_proxy": socks,
    })
    assert rc == 0, stderr
    assert hello["result"]["serverInfo"]["name"] == "protect-context"
    assert "guard_status" in {t["name"] for t in listed["result"]["tools"]}
