"""Ledger bounding (SPEC §2): rotation keeps reads correct and ids monotonic."""

import json

from protect_context import store, verify


def _rows(path):
    return store.read_jsonl(path)


def test_rotation_preserves_order_and_newest_rows(monkeypatch):
    monkeypatch.setattr(store, "LEDGER_MAX_BYTES", 200)
    path = store.events_path()
    for index in range(40):
        store.append_jsonl(path, {"ts": f"t{index:02d}", "kind": "tool_result", "n": index})

    assert store.ledger_files(path), "at least the live file exists"
    rotated = [p for p in store.ledger_files(path) if p != path]
    assert rotated, "the ledger rotated once it passed the size bound"

    rows = _rows(path)
    numbers = [r["n"] for r in rows]
    assert numbers == list(range(numbers[0], 40)), "rows come back as one ordered run ending at the newest"
    assert numbers[-1] == 39, "the newest row is always in the live file"
    assert numbers[0] > 0, "the oldest rows were rotated away, not the newest"
    # Rotation happens when the live file is already past the bound, so it can
    # hold one row more than the threshold — but never the whole history.
    assert path.stat().st_size < 400, "the live file holds only the tail of the ledger"


def test_segment_count_is_bounded(monkeypatch):
    monkeypatch.setattr(store, "LEDGER_MAX_BYTES", 150)
    path = store.events_path()
    for index in range(200):
        store.append_jsonl(path, {"ts": f"t{index:03d}", "n": index})

    segments = [p for p in store.ledger_files(path) if p != path]
    assert len(segments) <= store.LEDGER_SEGMENTS, "rotation drops the oldest segment instead of growing forever"
    rows = _rows(path)
    assert rows[-1]["n"] == 199
    assert len(rows) < 200, "retention is bounded, not the whole history"


def test_evidence_ids_stay_monotonic_across_rotations(monkeypatch):
    monkeypatch.setattr(store, "LEDGER_MAX_BYTES", 200)
    path = store.verify_path()
    last = None
    for index in range(30):
        entry = store.locked_append(path, lambda index=index: {"id": f"ev-{index + 1:04d}", "n": index})
        last = entry
    assert last is not None
    assert verify._next_id(_rows(path)) == "ev-0031", "the max id is never rotated away"
    assert _rows(path)[-1]["id"] == "ev-0030"


def test_rotated_file_is_valid_jsonl(monkeypatch):
    monkeypatch.setattr(store, "LEDGER_MAX_BYTES", 120)
    path = store.journal_path()
    for index in range(20):
        store.append_jsonl(path, {"type": "note", "text": f"n{index}"})
    segments = [p for p in store.ledger_files(path) if p != path]
    assert segments
    for segment in segments:
        for line in segment.read_text(encoding="utf-8").splitlines():
            assert isinstance(json.loads(line), dict), f"{segment.name} stays parseable"


def test_a_damaged_ledger_byte_does_not_take_the_guard_down(tmp_path):
    """A non-UTF-8 byte used to raise UnicodeDecodeError out of every reader.

    Writes are atomic, but a ledger can still be damaged from outside (a
    half-synced disk, a truncated copy, a hand edit). The guard must salvage the
    intact rows instead of failing closed on the whole file — otherwise one bad
    byte disables status, recall, loops and verify at once.
    """
    from protect_context import store

    ledger = tmp_path / "events.jsonl"
    ledger.write_bytes(
        b'{"kind":"tool_result","ok":true,"tool":"bash"}\n'
        b"\xff\xfe truncated garbage \x00\n"
        b'{"kind":"tool_result","ok":false,"tool":"bash","cmd":"pytest -q"}\n'
    )

    rows = store.read_jsonl(ledger)

    assert len(rows) == 2, "the two intact rows must survive the damaged one"
    assert rows[0]["ok"] is True
    assert rows[1]["cmd"] == "pytest -q"
