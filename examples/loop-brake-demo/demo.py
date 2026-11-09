#!/usr/bin/env python3
"""Show the loop brake and an UNTRUSTED masked success.

Runs in a temporary git repository so it does not write ``.agent-guard/``
into this checkout. It calls ``guard_verify`` directly — the same function
the MCP server exposes — then checks the two results this demo exists to show:

- the third identical ``false`` is refused and does not add evidence;
- ``python3 -c 'raise SystemExit(1)' || true`` exits 0 and is labelled
  UNTRUSTED.

Usage, from the repository root:

    python3 examples/loop-brake-demo/demo.py

From a dev checkout, ``python3`` re-runs itself with ``.venv/bin/python``
when that environment exists and the current interpreter has no ``fastmcp``.
Exit 0 means both checks held.
"""

from __future__ import annotations

import os
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]
FAILING = "false"
MASKED = "python3 -c 'raise SystemExit(1)' || true"


def _import_guard_verify():
    """Import the checkout's server, re-execing the project venv if needed.

    ``mcp_server`` imports fastmcp. A bare ``python3`` on a machine whose
    system interpreter does not have that dependency cannot load it; the
    dev environment documented in CONTRIBUTING.md can.
    """
    src = ROOT / "src"
    venv_python = ROOT / ".venv" / "bin" / "python"
    if src.is_dir() and str(src) not in sys.path:
        sys.path.insert(0, str(src))
    try:
        from protect_context.mcp_server import guard_verify
    except ModuleNotFoundError as exc:
        if exc.name != "fastmcp" or not venv_python.is_file():
            raise
        # Do not resolve the venv symlink: uv's `.venv/bin/python` points at
        # the system interpreter, and the venv is selected by argv[0].
        if Path(sys.executable) == venv_python:
            raise
        os.execv(str(venv_python), [str(venv_python), *sys.argv])
    return guard_verify


def main() -> int:
    guard_verify = _import_guard_verify()
    start = Path.cwd()
    work = tempfile.mkdtemp(prefix="pc-loop-brake-")
    try:
        subprocess.run(["git", "init", "-q"], cwd=work, check=True)
        os.chdir(work)
        print(f"temporary repo: {work}")
        print("same function the MCP server registers as guard_verify")
        print()

        runs = []
        for _ in range(3):
            print(f"$ guard_verify({FAILING!r})")
            text = guard_verify(FAILING)
            print(text)
            print()
            runs.append(text)

        print(f"$ guard_verify({MASKED!r})")
        masked = guard_verify(MASKED)
        print(masked)
        print()
    finally:
        os.chdir(start)
        shutil.rmtree(work, ignore_errors=True)

    blocked = runs[2]
    ok = True
    if "ev-0001" not in runs[0] or "exit 1" not in runs[0]:
        print("check failed: first failing command was not recorded", file=sys.stderr)
        ok = False
    if "ev-0002" not in runs[1] or "exit 1" not in runs[1]:
        print("check failed: second failing command was not recorded", file=sys.stderr)
        ok = False
    if "PC verify blocked" not in blocked or "2 prior failures" not in blocked:
        print("check failed: third identical command was not blocked", file=sys.stderr)
        ok = False
    if "ev-" in blocked.splitlines()[0]:
        print("check failed: the blocked call recorded new evidence", file=sys.stderr)
        ok = False
    if "UNTRUSTED" not in masked or "exit 0" not in masked:
        print("check failed: masked || true success was not UNTRUSTED", file=sys.stderr)
        ok = False
    if "failure mask" not in masked:
        print("check failed: UNTRUSTED report did not name the failure mask", file=sys.stderr)
        ok = False
    if not ok:
        return 1
    print("checks ok: loop brake blocked the third `false`; masked exit 0 is UNTRUSTED")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
