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


def test_compact_version_does_not_repeat_the_tool_or_truncate_a_path():
    """The renderer prints "<tool> <version>", so a repeated token is noise.

    Regression: preflight printed `git git 2.43.0` (the old code stripped only
    the literal "version ") and cut pip's install path at 60 chars, hiding the
    number inside a directory name (found 2026-11-10).
    """
    assert preflight._compact_version("git", "git version 2.43.0\n") == "2.43.0"
    assert preflight._compact_version("pytest", "pytest 9.1.1\n") == "9.1.1"
    assert (
        preflight._compact_version(
            "pip",
            "pip 24.0 from /home/you/.venvs/very-long-name/lib/python3.12/site-packages/pip (python 3.12)\n",
        )
        == "24.0"
    )
    assert preflight._compact_version("node", "v26.13.0\n") == "v26.13.0"
    # ripgrep names itself differently from the binary, so its token survives.
    assert preflight._compact_version("rg", "ripgrep 14.1.0 (rev 4649aa9)\n") == "ripgrep 14.1.0 (rev 4649aa9)"
