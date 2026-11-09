"""Preflight: tool presence/versions + git repo check (SPEC §7, §1 #10)."""

import subprocess

from protect_context import preflight
from protect_context.defaults import DEFAULT_CONFIG


def test_preflight_reports_presence_and_missing():
    cfg = dict(DEFAULT_CONFIG, preflight_tools=["python3", "definitely-missing-tool-xyz"])
    res = preflight.run_preflight(cfg)
    by_tool = {t["tool"]: t for t in res["tools"]}
    assert by_tool["python3"]["present"] is True
    assert by_tool["python3"]["version"]  # e.g. "Python 3.12.3"
    assert by_tool["definitely-missing-tool-xyz"]["present"] is False
    assert by_tool["definitely-missing-tool-xyz"]["version"] is None
    assert res["missing"] == ["definitely-missing-tool-xyz"]
    assert res["git_repo"] is False  # plain temp cwd is not a repo


def test_preflight_git_repo_true():
    subprocess.run(["git", "init", "-q"], check=True, capture_output=True)
    res = preflight.run_preflight({"preflight_tools": []})
    assert res["git_repo"] is True
    assert res["tools"] == []


def test_render_nudge_paths():
    bad = preflight.render({"tools": [], "git_repo": False, "missing": ["rg"]})
    assert "NO" in bad and "rg" in bad
    assert bad.rstrip().splitlines()[-1].startswith("Nudge:")
    good = preflight.render({"tools": [], "git_repo": True, "missing": []})
    assert "yes" in good and "Nudge:" in good

    no_repo = preflight.render({"tools": [], "git_repo": False, "missing": []})
    assert "environment looks sane" not in no_repo
    assert "run inside a git repository" in no_repo


def test_preflight_tool_list_and_names_are_bounded():
    configured = [f"missing-{index}" for index in range(30)]
    configured[0] = "bad\nname"

    res = preflight.run_preflight({"preflight_tools": configured})
    text = preflight.render(res)

    assert len(res["tools"]) == preflight.PREFLIGHT_TOOLS_MAX
    assert res["tools"][0]["tool"] == "bad name"
    assert res["omitted_tools"] == 10
    assert "+10 configured entries omitted" in text
    assert text.rstrip().splitlines()[-1].startswith("Nudge:")


def test_probe_bounded_after_kill():
    """A hung tool must not wedge the caller: kill, then reap for at most
    PROBE_KILL_WAIT_S instead of waiting forever."""
    import time

    started = time.monotonic()
    code, text, timed_out = preflight._probe(["/bin/sh", "-c", "sleep 30"], 0.2)
    elapsed = time.monotonic() - started

    assert (code, text, timed_out) == (None, "", True)
    assert elapsed < 5, "the post-kill wait must be bounded"
