"""guard_preflight: tool presence/versions + git repo check (SPEC §1 #10).
Reduces mid-task discovery of environment problems. No network, no LLM.
"""

from __future__ import annotations

import contextlib
import os
import shutil
import signal
import subprocess
import tempfile
import time

from . import store

PREFLIGHT_TOOLS_MAX = 20
TOOL_NAME_MAX = 120
VERSION_DISPLAY_MAX = 60
PROBE_OUTPUT_MAX_BYTES = 4096
PROBE_TIMEOUT_S = 2.0
PREFLIGHT_DEADLINE_S = 15.0
PROBE_KILL_WAIT_S = 5.0  # bound the post-kill reap: an unkillable child must not hang the call


def _terminate_probe(process: subprocess.Popen) -> None:
    """Best-effort kill of the probe and, on POSIX, its whole process group."""
    if os.name == "posix":
        with contextlib.suppress(OSError):
            os.killpg(os.getpgid(process.pid), signal.SIGKILL)
            # The group kill reached the child, so the fallback below is moot.
            return
    with contextlib.suppress(OSError):
        process.kill()


def _probe(argv: list[str], timeout_s: float) -> tuple[int | None, str, bool]:
    """Run a bounded probe without retaining arbitrary child output in RAM."""
    if timeout_s <= 0:
        return None, "", True
    with tempfile.TemporaryFile() as output:
        try:
            if os.name == "posix":
                process = subprocess.Popen(
                    argv,
                    stdout=output,
                    stderr=subprocess.STDOUT,
                    start_new_session=True,
                )
            else:
                process = subprocess.Popen(
                    argv, stdout=output, stderr=subprocess.STDOUT
                )
        except OSError:
            return None, "", False
        timed_out = False
        try:
            process.wait(timeout=timeout_s)
        except subprocess.TimeoutExpired:
            timed_out = True
            _terminate_probe(process)
            # Bound the reap: an unkillable child (e.g. stuck in D-state) must
            # not block the tool call; the OS reaps it whenever it can.
            with contextlib.suppress(subprocess.TimeoutExpired):
                process.wait(timeout=PROBE_KILL_WAIT_S)
        output.seek(0)
        raw = output.read(PROBE_OUTPUT_MAX_BYTES)
    text = raw.decode("utf-8", errors="replace")
    return (None if timed_out else process.returncode), text, timed_out


def _compact_version(tool: str, line: str) -> str:
    """`git version 2.43.0` → `2.43.0`; `pip 24.0 from /x (python 3.12)` → `24.0`.

    The renderer prints the tool name itself, so a repeated token is noise; the
    path after " from " is cut before truncation so a long directory cannot eat
    the whole budget and hide the number.
    """
    first = line.strip().split(" from ", 1)[0]
    words = first.split()
    tool_token = tool.rsplit("/", 1)[-1].casefold()
    # `git version 2.43.0` and `pytest 9.1.1` both lead with a token the renderer
    # already prints; strip tool name and the literal "version", in either order.
    while len(words) > 1 and words[0].casefold() in {"version", tool_token}:
        words = words[1:]
    return store.display_text(" ".join(words), VERSION_DISPLAY_MAX)


def _version(tool: str, timeout_s: float = PROBE_TIMEOUT_S) -> tuple[str | None, bool]:
    """Return a compact version line and whether the probe was incomplete.

    Found 2026-11-10: preflight printed `git git 2.43.0` and truncated pip's
    path mid-directory, because the old code stripped the literal `version `
    and then cut the line at 60 chars.
    """
    returncode, text, timed_out = _probe([tool, "--version"], timeout_s)
    if timed_out or returncode != 0:
        return None, True
    first_raw = next((line for line in text.splitlines() if line.strip()), "")
    if not first_raw.strip():
        return None, True
    compact = _compact_version(tool, first_raw)
    return compact or None, False


def in_git_repo(timeout_s: float = PROBE_TIMEOUT_S) -> bool:
    git = shutil.which("git")
    if git is None:
        return False
    returncode, text, timed_out = _probe(
        [git, "rev-parse", "--is-inside-work-tree"], timeout_s
    )
    return not timed_out and returncode == 0 and text.strip() == "true"


def run_preflight(cfg: dict | None = None) -> dict:
    cfg = cfg if cfg is not None else store.load_config()
    tools = []
    probe_issues: list[str] = []
    configured = cfg.get("preflight_tools", [])
    configured = configured if isinstance(configured, list) else []
    deadline = time.monotonic() + PREFLIGHT_DEADLINE_S
    git_repo = in_git_repo(min(PROBE_TIMEOUT_S, max(0.0, deadline - time.monotonic())))
    for raw_tool in configured[:PREFLIGHT_TOOLS_MAX]:
        if not isinstance(raw_tool, str):
            continue
        t = store.display_text(raw_tool, TOOL_NAME_MAX)
        if not t:
            continue
        executable = shutil.which(t)
        present = executable is not None
        version = None
        if executable is not None:
            remaining = max(0.0, deadline - time.monotonic())
            version, incomplete = _version(executable, min(PROBE_TIMEOUT_S, remaining))
            if incomplete:
                probe_issues.append(t)
        tools.append({"tool": t, "present": present, "version": version})
    missing = [t["tool"] for t in tools if not t["present"]]
    return {
        "tools": tools,
        "git_repo": git_repo,
        "missing": missing,
        "omitted_tools": max(0, len(configured) - PREFLIGHT_TOOLS_MAX),
        "probe_issues": probe_issues,
    }


def render(res: dict) -> str:
    lines = [f"PC preflight · git repo: {'yes' if res['git_repo'] else 'NO'}"]
    present = [t for t in res["tools"] if t["present"]]
    if present:
        lines.append(
            " · ".join(
                f"{t['tool']} {t['version'] or '(version unavailable)'}" for t in present
            )
        )
    probe_issues = res.get("probe_issues", [])
    if probe_issues:
        visible = probe_issues[:5]
        suffix = f" (+{len(probe_issues) - len(visible)} more)" if len(probe_issues) > len(visible) else ""
        lines.append("version probe incomplete: " + ", ".join(visible) + suffix)
    if res["missing"]:
        lines.append("missing: " + ", ".join(res["missing"]))
        if not res["git_repo"]:
            lines.append(
                "Nudge: install the missing tools and run inside a git repository before debugging code."
            )
        else:
            lines.append("Nudge: install the missing tools before debugging code — this is an environment problem.")
    elif res.get("omitted_tools") or probe_issues:
        lines.append("missing: none among checked tools")
        lines.append(
            "Nudge: preflight is incomplete — inspect unavailable versions and "
            "check omitted tools separately."
        )
    else:
        lines.append("missing: none")
        if res["git_repo"]:
            lines.append("Nudge: environment looks sane — investigate code, not the sandbox.")
        else:
            lines.append(
                "Nudge: run inside a git repository (or initialize one) before relying on diff guardrails."
            )
    if res.get("omitted_tools"):
        # Keep the actionable Nudge last while disclosing a bounded config view.
        nudge = lines.pop()
        lines.append(f"tool list bounded: +{res['omitted_tools']} configured entries omitted")
        lines.append(nudge)
    return "\n".join(lines)
