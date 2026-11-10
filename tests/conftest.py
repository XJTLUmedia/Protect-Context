"""Shared fixtures: every test runs in a temp cwd so .agent-guard is created
in a temp dir (SPEC §7), with a deterministic session id."""

import shutil

import pytest

from protect_context import store


def pytest_configure(config):
    """Fail once, clearly, when `git` is missing.

    Diff, orientation, preflight and the demo all shell out to git; without it
    those tests raise FileNotFoundError one by one (16 confusing failures in a
    slim container on 2026-11-10) instead of saying what is wrong.
    """
    if shutil.which("git") is None:
        raise pytest.UsageError(
            "git is not on PATH; the suite shells out to it (diff, orientation, preflight). "
            "Install git or run where it is available."
        )


@pytest.fixture(autouse=True)
def _isolate(tmp_path, monkeypatch):
    monkeypatch.chdir(tmp_path)
    monkeypatch.setenv("PC_SESSION_ID", "test-session")
    # The personal layer must never be read from the developer's real HOME.
    monkeypatch.setenv("PC_USER_DIR", str(tmp_path / "user-layer"))
    yield


@pytest.fixture
def user_layer(tmp_path):
    """Directory used as the personal layer for this test."""
    d = tmp_path / "user-layer"
    d.mkdir(parents=True, exist_ok=True)
    return d


@pytest.fixture
def write_events():
    """Write events.jsonl entries (already in TS-extension normalized shape)."""

    def _write(events, session="test-session"):
        rows = []
        for e in events:
            row = {
                # Fixed by default so fixtures are deterministic; a test that
                # needs a fresh or stale streak passes its own ts.
                "ts": e.get("ts", "2026-08-28T10:00:00Z"),
                "session": e.get("session", session),
                "kind": e["kind"],
                "tool": e.get("tool", "bash"),
                "ok": e.get("ok"),
                "ms": e.get("ms"),
                "out_chars": e.get("out_chars"),
                "cmd": e.get("cmd"),
                "exit": e.get("exit"),
            }
            rows.append(row)
        p = store.events_path()
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_text("".join(_j(r) + "\n" for r in rows), encoding="utf-8")
        return rows

    return _write


def _j(obj):
    import json

    return json.dumps(obj)
