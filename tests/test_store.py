"""Store roundtrip + flock; config load/merge; state; fingerprint (SPEC §7)."""

import json
import os
import re
import socket
import subprocess
import sys
import threading
import time
from pathlib import Path

import pytest

from protect_context import store
from protect_context.defaults import DEFAULT_CONFIG

EXPECTED_CONFIG = {
    "loop_block_after": 3,
    "diff_warn_lines": 400,
    "diff_hard_lines": 800,
    "diff_warn_files": 10,
    "ctx_warn_pct": 70,
    "brief_mode": "changed",
    # Added with the precedents work: brief re-injection cap for `lesson` rows
    # (0 disables the section). Pinned here and in extension/test/store.test.ts.
    "brief_max_precedents": 3,
    "risk_confirm": True,
    "preflight_tools": ["git", "python3", "pip", "node", "npm", "rg", "pytest"],
}


def test_default_config_matches_spec_exactly():
    assert DEFAULT_CONFIG == EXPECTED_CONFIG


def test_now_ts_uses_cross_runtime_utc_millisecond_shape():
    assert re.fullmatch(
        r"\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z",
        store.now_ts(),
    )


def test_jsonl_roundtrip(tmp_path):
    p = tmp_path / "x.jsonl"
    store.append_jsonl(p, {"a": 1})
    store.append_jsonl(p, {"b": "two", "tags": []})
    assert store.read_jsonl(p) == [{"a": 1}, {"b": "two", "tags": []}]


def test_read_jsonl_skips_malformed(tmp_path):
    p = tmp_path / "x.jsonl"
    p.write_text(
        '{"ok": 1}\nNOT JSON\nnull\n42\n"scalar"\n[]\n\n{"ok": 2}\n',
        encoding="utf-8",
    )
    assert store.read_jsonl(p) == [{"ok": 1}, {"ok": 2}]


def test_read_jsonl_missing_file(tmp_path):
    assert store.read_jsonl(tmp_path / "nope.jsonl") == []


def test_append_isolates_a_torn_tail(tmp_path):
    """A crashed writer can leave a partial line with no newline. The next
    append must not glue onto it, or both records become unreadable."""
    path = tmp_path / "x.jsonl"
    path.write_bytes(b'{"ok": 1}\n{"ok": "torn"')
    store.append_jsonl(path, {"ok": 2})
    assert store.read_jsonl(path) == [{"ok": 1}, {"ok": 2}]


def test_append_preserves_a_complete_record_that_lacked_a_newline(tmp_path):
    path = tmp_path / "x.jsonl"
    path.write_bytes(b'{"ok": 1}')
    store.append_jsonl(path, {"ok": 2})
    assert store.read_jsonl(path) == [{"ok": 1}, {"ok": 2}]


def test_flock_concurrent_appends_integrity(tmp_path):
    """Many threads appending concurrently → every line intact (flock works)."""
    p = tmp_path / "conc.jsonl"

    def worker(i):
        for j in range(25):
            store.append_jsonl(p, {"w": i, "j": j})

    threads = [threading.Thread(target=worker, args=(i,)) for i in range(8)]
    for t in threads:
        t.start()
    for t in threads:
        t.join()
    rows = store.read_jsonl(p)
    assert len(rows) == 200
    assert all(isinstance(r, dict) and "w" in r and "j" in r for r in rows)


def test_ensure_seeds_config_and_idempotent():
    d = store.ensure()
    assert (d / "config.json").exists()
    assert (
        json.loads((d / "config.json").read_text(encoding="utf-8")) == EXPECTED_CONFIG
    )
    store.ensure()  # second call must not clobber
    assert (
        json.loads((d / "config.json").read_text(encoding="utf-8")) == EXPECTED_CONFIG
    )


def test_ensure_rechecks_config_after_waiting_for_the_store_lock(monkeypatch):
    config = store.config_path()
    first_missing_check = threading.Event()
    original_exists = Path.exists

    def observed_exists(path: Path) -> bool:
        exists = original_exists(path)
        if (
            path == config
            and threading.current_thread().name == "ensure-peer"
            and not exists
        ):
            first_missing_check.set()
        return exists

    monkeypatch.setattr(Path, "exists", observed_exists)
    errors: list[Exception] = []

    def initialize() -> None:
        try:
            store.ensure()
        except (OSError, RuntimeError) as exc:  # pragma: no cover - asserted below
            errors.append(exc)

    owner_config = {"loop_block_after": 9}
    with store.store_lock():
        peer = threading.Thread(target=initialize, name="ensure-peer")
        peer.start()
        assert first_missing_check.wait(timeout=1)
        store.write_json(config, owner_config)
    peer.join(timeout=1)

    assert not peer.is_alive()
    assert errors == []
    assert json.loads(config.read_text(encoding="utf-8")) == owner_config


def test_config_load_merge_defaults_and_override():
    store.ensure()
    assert store.load_config() == EXPECTED_CONFIG
    store.write_json(store.config_path(), {"loop_block_after": 5, "bogus_key": 1})
    cfg = store.load_config()
    assert cfg["loop_block_after"] == 5  # file overrides default
    assert cfg["diff_warn_lines"] == 400  # defaults preserved
    assert cfg["bogus_key"] == 1  # unknown keys are preserved, never interpreted


def test_state_roundtrip():
    st = store.load_state()
    assert st == store.DEFAULT_STATE
    # Per-session baselines (SPEC §2): the top level holds no digest/watermarks.
    view = store.session_state(st, "roundtrip")
    view["brief_digest"] = "abc123"
    view["notify_watermarks"]["ctx_pct"] = 80
    st["current_session"] = {"id": "roundtrip", "started": "2026-10-30", "git_head": None}
    st["counters"]["x"] = 1
    store.save_state(st)
    loaded = store.load_state()
    assert loaded["sessions"]["roundtrip"]["brief_digest"] == "abc123"
    assert loaded["counters"] == {"x": 1}
    assert loaded["sessions"]["roundtrip"]["notify_watermarks"]["ctx_pct"] == 80
    assert "brief_digest" not in loaded, "no flat baseline is written any more"


def test_state_keeps_the_extension_task_anchor():
    """The pi extension stores its owner task anchor in state.json (SPEC §2).

    Python never interprets it, but a CLI/MCP save must not silently delete a
    key the extension depends on: load_state copies unknown top-level keys and
    save_state writes the merged mapping back.
    """
    task = {"text": "Ship the audit fixes", "source": "owner", "ts": "2026-11-03T00:00:00Z"}
    store.ensure()
    store.write_json(
        store.state_path(),
        {
            "current_session": {"id": "test-session", "started": "2026-11-03", "git_head": None},
            "sessions": {},
            "counters": {},
            "task": task,
        },
    )
    st = store.load_state()
    assert st["task"] == task
    store.save_state(st)
    assert store.load_state()["task"] == task


def test_fingerprint_trim_and_collapse_only():
    assert store.fingerprint("  ls   -la\n") == "ls -la"
    assert store.fingerprint("pytest\t-q   -x") == "pytest -q -x"
    assert store.fingerprint("pytest -q") == "pytest -q"
    assert store.fingerprint("") == ""


def test_session_id_env_default(monkeypatch):
    monkeypatch.setenv("PC_SESSION_ID", "s-42")
    assert store.session_id() == "s-42"
    monkeypatch.delenv("PC_SESSION_ID", raising=False)
    assert store.session_id() == "default"


def test_locked_append_builds_inside_critical_section(tmp_path):
    """locked_append runs the factory under the same flock as the append, so
    id allocation cannot race between writers (SPEC §2, §7)."""
    p = tmp_path / "ids.jsonl"

    def build():
        return {"n": len(store.read_jsonl(p)) + 1}

    for _ in range(3):
        entry = store.locked_append(p, build)
        assert set(entry) == {"n"}
    assert store.read_jsonl(p) == [{"n": 1}, {"n": 2}, {"n": 3}]


def test_store_lock_is_reentrant_for_the_same_thread(tmp_path):
    p = tmp_path / "nested.jsonl"
    with store.store_lock(timeout_s=0.1):
        assert store.lease_path().is_dir()
        # Both public helpers reacquire the same lock internally. They must
        # share the outer lease instead of self-deadlocking.
        store.append_jsonl(p, {"n": 1})
        with store.store_lock(timeout_s=0.1):
            store.append_jsonl(p, {"n": 2})
    assert store.read_jsonl(p) == [{"n": 1}, {"n": 2}]
    assert not store.lease_path().exists()


def test_store_lock_is_not_reentrant_across_threads_even_with_same_pid():
    acquired: list[bool] = []
    errors: list[TimeoutError] = []

    def contender() -> None:
        try:
            with store.store_lock(timeout_s=0.05, retry_s=0.005):
                acquired.append(True)
        except TimeoutError as exc:
            errors.append(exc)

    with store.store_lock():
        # Make the lease old enough to exercise the live-owner check too: a
        # same-process contender must still not steal it.
        old = time.time() - store.STORE_LOCK_MIN_STALE_S - 1
        os.utime(store.lease_path(), (old, old))
        thread = threading.Thread(target=contender)
        thread.start()
        thread.join(timeout=1)
        assert not thread.is_alive()

    assert acquired == []
    assert len(errors) == 1 and isinstance(errors[0], TimeoutError)


@pytest.mark.skipif(not hasattr(os, "fork"), reason="fork is POSIX-only")
def test_store_lock_drops_inherited_reentrancy_state_after_fork(tmp_path):
    marker = tmp_path / "child-entered"
    with store.store_lock():
        pid = os.fork()
        if pid == 0:  # pragma: no branch - child exits directly
            try:
                with store.store_lock(timeout_s=0.05, retry_s=0.005):
                    marker.write_text("unsafe", encoding="utf-8")
            except TimeoutError:
                os._exit(0)
            os._exit(2)
        _, status = os.waitpid(pid, 0)

    assert os.waitstatus_to_exitcode(status) == 0
    assert not marker.exists()


def test_store_lock_reclaims_an_old_lease_from_a_dead_local_pid():
    child = subprocess.Popen([sys.executable, "-c", "pass"])
    child.wait(timeout=5)
    lock_dir = store.lease_path()
    lock_dir.parent.mkdir(parents=True)
    lock_dir.mkdir()
    abandoned = f"abandoned-{child.pid}"
    (lock_dir / "owner.json").write_text(
        json.dumps(
            {
                "token": abandoned,
                "pid": child.pid,
                "hostname": socket.gethostname(),
                "created_ms": 0,
            }
        ),
        encoding="utf-8",
    )
    old = time.time() - store.STORE_LOCK_MIN_STALE_S - 1
    os.utime(lock_dir, (old, old))

    with store.store_lock(timeout_s=0.2, stale_s=store.STORE_LOCK_MIN_STALE_S):
        owner = json.loads(
            (store.lease_path() / "owner.json").read_text(encoding="utf-8")
        )
        assert owner["token"] != abandoned

    assert not store.lease_path().exists()
    assert list(store.guard_dir().glob(".lock.d.reap.*")) == []


def test_store_lock_never_steals_an_old_foreign_host_lease():
    lock_dir = store.lease_path()
    lock_dir.parent.mkdir(parents=True)
    lock_dir.mkdir()
    owner = {
        "token": "foreign-owner",
        "pid": 2_147_483_647,
        "hostname": f"not-{socket.gethostname()}",
        "created_ms": 0,
    }
    (lock_dir / "owner.json").write_text(json.dumps(owner), encoding="utf-8")
    old = time.time() - store.STORE_LOCK_MIN_STALE_S - 1
    os.utime(lock_dir, (old, old))

    with (
        pytest.raises(TimeoutError, match="timed out acquiring store lock"),
        store.store_lock(timeout_s=0.02, stale_s=store.STORE_LOCK_MIN_STALE_S),
    ):
        pytest.fail("foreign lease was stolen")

    assert json.loads((lock_dir / "owner.json").read_text(encoding="utf-8")) == owner


def test_store_lock_releases_after_body_error():
    with pytest.raises(ValueError, match="body failed"), store.store_lock():
        raise ValueError("body failed")
    assert not store.lease_path().exists()


def test_store_lock_does_not_remove_a_replacement_owner():
    replacement = {
        "token": "replacement",
        "pid": os.getpid(),
        "hostname": socket.gethostname(),
        "created_ms": int(time.time() * 1000),
    }
    with (
        pytest.raises(RuntimeError, match="ownership changed before release"),
        store.store_lock(),
    ):
        (store.lease_path() / "owner.json").write_text(
            json.dumps(replacement), encoding="utf-8"
        )

    assert (
        json.loads((store.lease_path() / "owner.json").read_text(encoding="utf-8"))
        == replacement
    )
    # Use the token-aware release helper so the test leaves no lock behind.
    store._release_lease(store.lease_path(), replacement["token"])


def test_store_lock_body_error_survives_a_failed_release():
    """A failed release must not replace the error that aborted the body."""
    replacement = {
        "token": "replacement",
        "pid": os.getpid(),
        "hostname": socket.gethostname(),
        "created_ms": int(time.time() * 1000),
    }
    with pytest.raises(ValueError, match="body failed"), store.store_lock():
        (store.lease_path() / "owner.json").write_text(
            json.dumps(replacement), encoding="utf-8"
        )
        raise ValueError("body failed")

    # Use the token-aware release helper so the test leaves no lock behind.
    store._release_lease(store.lease_path(), replacement["token"])


def test_read_jsonl_is_memoized_and_invalidated_by_append(tmp_path):
    path = tmp_path / "rows.jsonl"
    store.append_jsonl(path, {"i": 1})
    store.append_jsonl(path, {"i": 2})
    first = store.read_jsonl(path)
    assert [r["i"] for r in first] == [1, 2]
    second = store.read_jsonl(path)
    assert second is first, "an unchanged ledger is served from the cache"
    store.append_jsonl(path, {"i": 3})
    assert [r["i"] for r in store.read_jsonl(path)] == [1, 2, 3], "an append invalidates the stamp"


def test_tail_jsonl_reads_the_live_segment_only(tmp_path):
    path = tmp_path / "rows.jsonl"
    for i in range(10):
        store.append_jsonl(path, {"i": i})
    assert [r["i"] for r in store.tail_jsonl(path, 3) or []] == [7, 8, 9]
    assert store.tail_jsonl(path, 0) == []
    # Not enough rows in the live file: say so instead of returning a short list.
    assert store.tail_jsonl(path, 50) is None
    # Rows in rotated segments are out of scope for the tail reader.
    rotated = tmp_path / "rows.1.jsonl"
    rotated.write_text('{"i": 99}\n', encoding="utf-8")
    assert [r["i"] for r in store.tail_jsonl(path, 2) or []] == [8, 9]


def test_tail_jsonl_refuses_a_torn_tail(tmp_path):
    path = tmp_path / "rows.jsonl"
    store.append_jsonl(path, {"i": 1})
    with open(path, "a", encoding="utf-8") as handle:
        handle.write('{"i": 2')
    assert store.tail_jsonl(path, 1) is None


def test_brief_max_precedents_is_validated(tmp_path):
    store.ensure()
    store.write_json(store.config_path(), {"brief_max_precedents": 7})
    assert store.load_config()["brief_max_precedents"] == 7
    store.write_json(store.config_path(), {"brief_max_precedents": 99})
    assert store.load_config()["brief_max_precedents"] == store.DEFAULT_CONFIG["brief_max_precedents"]
    store.write_json(store.config_path(), {"brief_max_precedents": "many"})
    assert store.load_config()["brief_max_precedents"] == store.DEFAULT_CONFIG["brief_max_precedents"]


def test_lessons_survive_ledger_rotation(monkeypatch):
    store.ensure()
    journal = store.journal_path()
    store.append_jsonl(journal, {"ts": "t0", "type": "decision", "text": "keep me", "tags": ["lesson"]})
    monkeypatch.setattr(store, "LEDGER_MAX_BYTES", 400)
    for index in range(12):
        store.append_jsonl(
            journal,
            {"ts": f"n{index}", "type": "note", "text": "noise " + "x" * 120, "tags": []},
        )
    assert len(store.ledger_files(journal)) > 1, "the fixture must actually rotate"
    texts = [row["text"] for row in store.read_jsonl(journal) if "lesson" in row.get("tags", [])]
    # Copied once when its segment was dropped, not once per rotation.
    assert texts == ["keep me"]
