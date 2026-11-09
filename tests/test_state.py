"""Per-session state.json (SPEC §2): concurrent sessions must not clobber."""

import json

from protect_context import store
from protect_context.store import DEFAULT_STATE


def test_default_state_has_no_shared_baseline():
    assert DEFAULT_STATE["sessions"] == {}
    assert "brief_digest" not in DEFAULT_STATE
    assert "notify_watermarks" not in DEFAULT_STATE


def test_two_sessions_keep_separate_baselines():
    store.ensure()
    state = store.load_state()

    a = store.session_state(state, "session-a")
    a["brief_digest"] = "digest-a"
    a["notify_watermarks"] = {"ctx_pct": 70, "diff_lines": 400, "diff_files": 10}
    state["current_session"] = {"id": "session-a", "started": "2026-10-30T00:00:00Z", "git_head": None}
    store.save_state(state)

    # A second process starts in the same project.
    second = store.load_state()
    b = store.session_state(second, "session-b")
    assert b["brief_digest"] is None, "a new session starts with an empty baseline"
    assert b["notify_watermarks"]["ctx_pct"] == 0
    b["brief_digest"] = "digest-b"
    second["current_session"] = {"id": "session-b", "started": "2026-10-30T01:00:00Z", "git_head": None}
    store.save_state(second)

    final = store.load_state()
    assert final["sessions"]["session-a"]["brief_digest"] == "digest-a", "session A is not clobbered"
    assert final["sessions"]["session-a"]["notify_watermarks"]["ctx_pct"] == 70
    assert final["sessions"]["session-b"]["brief_digest"] == "digest-b"
    assert final["current_session"]["id"] == "session-b"


def test_legacy_flat_state_is_migrated_in_memory():
    store.ensure()
    (store.guard_dir() / "state.json").write_text(
        json.dumps(
            {
                "current_session": {"id": "legacy", "started": "2026-10-01T00:00:00Z", "git_head": "abc"},
                "brief_digest": "old-digest",
                "notify_watermarks": {"ctx_pct": 30, "diff_lines": 120, "diff_files": 2},
                "counters": {"orient_sha1": "xyz"},
            }
        ),
        encoding="utf-8",
    )
    st = store.load_state()
    entry = st["sessions"]["legacy"]
    assert entry["brief_digest"] == "old-digest", "a v1 flat baseline is not silently dropped"
    assert entry["notify_watermarks"] == {"ctx_pct": 30, "diff_lines": 120, "diff_files": 2}
    assert entry["git_head"] == "abc"
    assert st["counters"]["orient_sha1"] == "xyz"


def test_save_prunes_old_sessions_but_keeps_the_current_one():
    store.ensure()
    st = store.load_state()
    for index in range(store.SESSION_KEEP + 4):
        entry = store.session_state(st, f"s-{index}")
        entry["updated"] = f"2026-10-{index + 1:02d}T00:00:00Z"
    st["current_session"] = {"id": "s-0", "started": "2026-10-01", "git_head": None}
    st["sessions"]["s-0"]["updated"] = "2026-10-01T00:00:00Z"  # oldest on purpose
    store.save_state(st)

    saved = json.loads((store.guard_dir() / "state.json").read_text(encoding="utf-8"))
    assert len(saved["sessions"]) == store.SESSION_KEEP
    assert "s-0" in saved["sessions"], "the current session is never pruned"
    assert "s-11" in saved["sessions"], "newest sessions are retained"
    assert "s-1" not in saved["sessions"], "the oldest non-current session is dropped"


def test_corrupt_session_entry_is_dropped_so_save_cannot_crash():
    """A hand-edited/non-dict session entry is corrupt data: reads stay safe and
    save_state (which prunes by reading timestamps) must not raise."""
    store.ensure()
    (store.guard_dir() / "state.json").write_text(
        json.dumps(
            {
                "current_session": {"id": "test-session", "started": None, "git_head": None},
                "sessions": {"test-session": {"started": None, "git_head": None}, "ghost": 5},
            }
        ),
        encoding="utf-8",
    )

    st = store.load_state()
    assert "ghost" not in st["sessions"]

    store.save_state(st)  # would raise AttributeError before the fix
    saved = json.loads((store.guard_dir() / "state.json").read_text(encoding="utf-8"))
    assert "ghost" not in saved["sessions"]
    assert "test-session" in saved["sessions"]
