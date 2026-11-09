"""Local recall: filters, ranking, provenance, and the rotated ledger window."""

import json

import pytest

from protect_context import loops, recall, store


def _journal(*rows):
    return list(rows)


def _hit_kinds(result):
    return [(hit.provenance, hit.kind, hit.evidence_id, hit.text) for hit in result.hits]


def test_rank_strength_then_recency_and_keeps_provenance():
    journal = [
        {
            "ts": "2026-01-01T00:00:00.000Z",
            "type": "decision",
            "text": "alpha lives in the ledger",
            "tags": ["ledger"],
        },
        {
            "ts": "2026-02-01T00:00:00.000Z",
            "type": "note",
            "text": "alpha mentioned",
            "tags": ["agent"],
        },
        {
            "ts": "2026-03-01T00:00:00.000Z",
            "type": "note",
            "text": "no match here",
            "tags": ["other"],
        },
    ]
    evidence = [
        {
            "id": "ev-0007",
            "ts": "2026-01-15T00:00:00.000Z",
            "cmd": "echo alpha",
            "digest": "noise",
            "exit": 0,
        },
        {
            "id": "ev-0009",
            "ts": "2026-04-01T00:00:00.000Z",
            "cmd": "pytest -q",
            "digest": "alpha failed in output",
            "exit": 1,
        },
    ]
    result = recall.search("alpha", journal_rows=journal, evidence_rows=evidence)
    assert result.scanned == 5
    assert result.matched == 4
    assert [hit.provenance + ":" + hit.kind for hit in result.hits] == [
        "agent:note",
        "trusted:decision",
        "trusted:evidence",
        "trusted:evidence",
    ]
    assert result.hits[0].text == "alpha mentioned"
    assert result.hits[1].tags == ["ledger"]
    assert result.hits[2].evidence_id == "ev-0007"
    assert result.hits[2].strength > result.hits[3].strength
    assert result.hits[0].strength == result.hits[1].strength
    assert result.hits[0].recency > result.hits[1].recency
    rendered = recall.render(result)
    assert "agent · note" in rendered
    assert "trusted · decision" in rendered
    assert "ev-0007" in rendered and "exit 1" in rendered
    assert rendered.rstrip().splitlines()[-1].startswith("Nudge:")
    assert "unverified" in rendered.splitlines()[-1]


def test_keywords_rank_by_match_count_and_also_search_tags():
    journal = [
        {"ts": "t1", "type": "decision", "text": "alpha lives in the ledger", "tags": ["other"]},
        {"ts": "t2", "type": "note", "text": "nothing to see", "tags": ["alpha"]},
    ]
    both = recall.search("alpha ledger", journal_rows=journal, evidence_rows=[])
    # Two matched words beat one, so the decision ranks first; the tag-only row
    # still appears because a tag is a synonym the owner wrote themselves.
    assert [hit.text for hit in both.hits] == ["alpha lives in the ledger", "nothing to see"]
    tags_only = recall.search("alpha", journal_rows=journal[1:], evidence_rows=[])
    assert tags_only.matched == 1, "a tag term is searchable"
    assert tags_only.hits[0].tags == ["alpha"]


def test_tags_are_case_insensitive_and():
    journal = [
        {"ts": "t1", "type": "note", "text": "keep both", "tags": ["Search", "py"]},
        {"ts": "t2", "type": "note", "text": "search only", "tags": ["search"]},
    ]
    found = recall.search(tags=["SEARCH", "py"], journal_rows=journal, evidence_rows=[])
    assert [hit.text for hit in found.hits] == ["keep both"]
    missing = recall.search(tags=["search", "missing"], journal_rows=journal, evidence_rows=[])
    assert missing.matched == 0
    # Evidence has no tags, so a tag filter excludes it even when the command matches.
    evidence = [{"id": "ev-0001", "ts": "t3", "cmd": "pytest", "digest": "", "exit": 0}]
    assert recall.search(tags=["py"], journal_rows=[], evidence_rows=evidence).matched == 0


def test_evidence_id_is_exact_and_accepts_short_form():
    evidence = [
        {"id": "ev-0007", "ts": "t1", "cmd": "true", "digest": "ok", "exit": 0},
        {"id": "ev-0008", "ts": "t2", "cmd": "false", "digest": "no", "exit": 1},
    ]
    found = recall.search(evidence_id="ev-7", journal_rows=[], evidence_rows=evidence)
    assert [hit.evidence_id for hit in found.hits] == ["ev-0007"]
    by_keyword = recall.search("ev-0007", journal_rows=[], evidence_rows=evidence)
    assert [hit.evidence_id for hit in by_keyword.hits] == ["ev-0007"]
    with pytest.raises(ValueError, match="ev-NNNN"):
        recall.search(evidence_id="not-an-id", journal_rows=[], evidence_rows=[])


def test_command_fingerprint_exact_outranks_newer_substring():
    evidence = [
        {"id": "ev-0003", "ts": "2026-03-01T00:00:00.000Z", "cmd": "pytest   -q", "digest": "", "exit": 0},
        {
            "id": "ev-0004",
            "ts": "2026-04-01T00:00:00.000Z",
            "cmd": "pytest -q --tb=short",
            "digest": "",
            "exit": 0,
        },
        {"id": "ev-0005", "ts": "2026-05-01T00:00:00.000Z", "cmd": "npm test", "digest": "", "exit": 0},
    ]
    journal = [{"ts": "2026-06-01T00:00:00.000Z", "type": "note", "text": "pytest -q", "tags": []}]
    found = recall.search(cmd="  pytest   -q ", journal_rows=journal, evidence_rows=evidence)
    assert [hit.evidence_id for hit in found.hits] == ["ev-0003", "ev-0004"]
    assert found.hits[0].strength > found.hits[1].strength
    substring = recall.search(cmd="pytest", journal_rows=[], evidence_rows=evidence)
    assert [hit.evidence_id for hit in substring.hits] == ["ev-0004", "ev-0003"]


def test_type_filter_and_limit_and_empty_query_recency():
    journal = [
        {"ts": "2026-01-01T00:00:00.000Z", "type": "note", "text": "old", "tags": []},
        {"ts": "2026-03-01T00:00:00.000Z", "type": "decision", "text": "mid", "tags": []},
    ]
    evidence = [
        {"id": "ev-0001", "ts": "2026-02-01T00:00:00.000Z", "cmd": "true", "digest": "", "exit": 0},
        {"id": "ev-0002", "ts": "2026-04-01T00:00:00.000Z", "cmd": "pytest -q", "digest": "alpha", "exit": 0},
    ]
    newest = recall.search(limit=2, journal_rows=journal, evidence_rows=evidence)
    assert [hit.kind for hit in newest.hits] == ["evidence", "decision"]
    assert newest.hits[0].evidence_id == "ev-0002"
    only_evidence = recall.search("alpha", type="evidence", journal_rows=journal, evidence_rows=evidence)
    assert [hit.evidence_id for hit in only_evidence.hits] == ["ev-0002"]
    capped = recall.search(limit=100, journal_rows=[{"ts": f"t{i:02d}", "type": "note", "text": str(i), "tags": []} for i in range(25)], evidence_rows=[])
    assert len(capped.hits) == recall.LIMIT_MAX
    assert capped.matched == 25
    assert "5 of 25" not in recall.render(capped)
    assert f"{recall.LIMIT_MAX} of 25 hits" in recall.render(capped)
    none = recall.search(limit=0, journal_rows=journal, evidence_rows=evidence)
    assert none.hits == []
    assert none.matched == 4
    with pytest.raises(ValueError, match="unknown recall type"):
        recall.search(type="invalid", journal_rows=[], evidence_rows=[])


def test_malformed_rows_are_skipped_and_controls_stay_one_line():
    journal = [
        [],
        {"type": "nope", "text": "skip"},
        {"type": "note", "text": 12},
        {"type": "note", "text": "hello\nworld\u0000next", "tags": ["ok"], "ts": "t1"},
    ]
    result = recall.search(journal_rows=journal, evidence_rows=[{"digest": ""}])
    assert result.scanned == 1
    rendered = recall.render(result)
    assert "hello world next" in rendered
    assert "\nworld" not in rendered
    assert rendered.count("\n") == 2  # header, hit, nudge


def test_rotation_window_includes_segments_and_drops_the_overflow():
    journal = store.journal_path()
    journal.parent.mkdir(parents=True, exist_ok=True)
    dropped = journal.with_name("journal.4.jsonl")
    rotated = journal.with_name("journal.1.jsonl")
    rotated.write_text(
        json.dumps({"ts": "t0", "type": "decision", "text": "rotated-marker", "tags": ["keep"]}) + "\n",
        encoding="utf-8",
    )
    dropped.write_text(
        json.dumps({"ts": "t9", "type": "note", "text": "dropped-marker", "tags": []}) + "\n",
        encoding="utf-8",
    )
    journal.write_text(
        "not json\n[]\n"
        + json.dumps({"ts": "t1", "type": "note", "text": "live-marker", "tags": []})
        + "\n",
        encoding="utf-8",
    )
    evidence = store.verify_path()
    evidence.with_name("verify_runs.2.jsonl").write_text(
        json.dumps({"id": "ev-0004", "ts": "t2", "cmd": "old-rotated-cmd", "digest": "from-segment", "exit": 0})
        + "\n",
        encoding="utf-8",
    )
    assert recall.search("rotated-marker").matched == 1
    assert recall.search("dropped-marker").matched == 0
    assert recall.search("live-marker").hits[0].text == "live-marker"
    found = recall.search("from-segment")
    assert found.hits[0].evidence_id == "ev-0004"
    assert found.hits[0].cmd == "old-rotated-cmd"


def test_recall_does_not_create_the_store():
    result = recall.search("anything")
    assert result.scanned == 0 and result.matched == 0
    assert not store.guard_dir().exists()
    rendered = recall.render(result)
    assert rendered.startswith("PC recall · 0 hits · scanned 0")
    assert "broaden the query" in rendered.splitlines()[-1]


def test_agent_provenance_is_case_insensitive_like_the_tag_filter():
    rows = _journal(
        {"ts": "2026-01-01T00:00:00.000Z", "type": "note", "text": "alpha", "tags": ["Agent"]}
    )

    by_query = recall.search("alpha", journal_rows=rows, evidence_rows=[])
    assert [hit.provenance for hit in by_query.hits] == ["agent"]

    by_tag = recall.search("", tags=["AGENT"], journal_rows=rows, evidence_rows=[])
    assert [hit.provenance for hit in by_tag.hits] == ["agent"]


def test_paraphrase_query_reaches_the_decision():
    # The owner's question words differ from the entry's; AND over every word
    # used to miss it entirely.
    journal = [
        {
            "ts": "2026-10-29T18:43:00.000Z",
            "type": "decision",
            "text": "Owner took the three follow-ups (ev-0023): preserve unknown config keys.",
            "tags": ["config"],
        }
    ]
    result = recall.search(
        "did the owner take all three follow-ups from the review?",
        journal_rows=journal,
        evidence_rows=[],
        include_commands=False,
    )
    assert result.matched == 1
    assert "three follow-ups" in result.hits[0].text


def test_one_shared_word_cannot_answer_a_long_query():
    journal = [
        {"ts": "t1", "type": "note", "text": "the owner", "tags": []},
        {"ts": "t2", "type": "note", "text": "owner prefers broad fixes over docs", "tags": []},
    ]
    result = recall.search(
        "what did the owner say about tests and docs and release",
        journal_rows=journal,
        evidence_rows=[],
        include_commands=False,
    )
    # One shared word ("owner") is not enough for a long query; two are.
    assert [hit.text for hit in result.hits] == ["owner prefers broad fixes over docs"]


def test_past_command_is_reusable_from_the_events_ledger():
    events = [
        {"ts": "2026-11-01T00:00:00.000Z", "kind": "tool_call", "tool": "bash", "cmd": "rsync -a src/ /backup/folder/"},
        {"ts": "2026-11-02T00:00:00.000Z", "kind": "tool_call", "tool": "bash", "cmd": "rsync -a src/ /backup/folder/"},
        {"ts": "2026-11-03T00:00:00.000Z", "kind": "tool_call", "tool": "bash", "cmd": "true", "ok": False},
        {"ts": "2026-11-04T00:00:00.000Z", "kind": "tool_result", "tool": "bash", "ok": True},
    ]
    result = recall.search(
        "copy folder backup",
        journal_rows=[],
        evidence_rows=[],
        event_rows=events,
    )
    commands = [hit for hit in result.hits if hit.kind == "command"]
    assert len(commands) == 1, "one row per command family"
    assert commands[0].cmd == "rsync -a src/ /backup/folder/"
    assert commands[0].uses == 2, "repeat count proves it worked more than once"
    assert "re-run to verify" in recall.render(result)


def test_past_command_is_reusable_without_supplied_rows(write_events):
    # CLI and MCP call search() with no rows, so the events ledger is read from
    # disk. Regression: `supplied` was computed AFTER the journal/evidence rows
    # were loaded (never None by then), so event_rows was always empty and
    # command reuse silently never worked outside tests.
    write_events(
        [
            {"kind": "tool_call", "tool": "bash", "cmd": "rsync -a src/ /backup/folder/"},
            {"kind": "tool_call", "tool": "bash", "cmd": "rsync -a src/ /backup/folder/"},
        ]
    )
    result = recall.search("copy folder backup")
    commands = [hit for hit in result.hits if hit.kind == "command"]
    assert len(commands) == 1
    assert commands[0].cmd == "rsync -a src/ /backup/folder/"
    assert commands[0].uses == 2


def test_a_command_already_in_evidence_is_not_repeated():
    events = [{"ts": "2026-11-01T00:00:00.000Z", "kind": "tool_call", "tool": "bash", "cmd": "npm test"}]
    evidence = [{"id": "ev-0001", "ts": "2026-11-01T00:00:00.000Z", "cmd": "npm test", "digest": "", "exit": 0}]
    result = recall.search("npm test", journal_rows=[], evidence_rows=evidence, event_rows=events)
    assert [hit.kind for hit in result.hits] == ["evidence"]


def test_empty_query_keeps_the_recent_window_shape():
    events = [{"ts": "2026-11-01T00:00:00.000Z", "kind": "tool_call", "tool": "bash", "cmd": "npm test"}]
    result = recall.search(journal_rows=[], evidence_rows=[], event_rows=events)
    assert result.hits == [] and result.scanned == 0


def test_rare_words_outrank_common_ones():
    # "owner" is in every row, "annoyed" in one: the rare word must decide.
    journal = [
        {"ts": f"t{i}", "type": "note", "text": "owner asked for a small change", "tags": []}
        for i in range(6)
    ]
    journal.append({"ts": "t9", "type": "decision", "text": "owner prefers broad fixes", "tags": ["annoyed"]})
    result = recall.search("owner annoyed", journal_rows=journal, evidence_rows=[])
    assert result.hits[0].text == "owner prefers broad fixes"


def test_tag_synonyms_bridge_a_vocabulary_gap():
    # The owner's own words are the bridge: the text never says "annoyed".
    journal = [
        {"ts": "t1", "type": "decision", "text": "prefer the broad fix", "tags": ["annoyed", "narrow-patch"]}
    ]
    for query in ["why did the owner get annoyed", "narrow patch again"]:
        hits = recall.search(query, journal_rows=journal, evidence_rows=[]).hits
        assert hits and hits[0].text == "prefer the broad fix", query


def test_command_hint_carries_its_last_observed_outcome():
    events = [
        {"ts": "t1", "session": "s", "kind": "tool_call", "tool": "bash", "cmd": "cp -r a/ b/"},
        {"ts": "t2", "session": "s", "kind": "tool_result", "tool": "bash", "ok": True, "exit": 0},
        {"ts": "t3", "session": "s", "kind": "tool_call", "tool": "bash", "cmd": "cp -r a/ b/"},
        {"ts": "t4", "session": "s", "kind": "tool_result", "tool": "bash", "ok": False, "exit": 1},
    ]
    result = recall.search("cp copy", journal_rows=[], evidence_rows=[], event_rows=events)
    hit = next(h for h in result.hits if h.kind == "command")
    assert hit.uses == 2
    assert hit.last_ok is False and hit.last_exit == 1
    assert "last FAILED" in recall.render(result)


def test_a_keyword_must_start_a_word():
    rows = [
        {"ts": "1", "type": "note", "text": "raise the threshold", "tags": []},
        {"ts": "2", "type": "decision", "text": "the old policy is gone", "tags": []},
    ]
    hits = recall.search("old", journal_rows=rows, evidence_rows=[]).hits
    assert [h.text for h in hits] == ["the old policy is gone"]
    # Prefix morphology still works in the useful direction.
    assert recall.search("thresh", journal_rows=rows, evidence_rows=[]).matched == 1
    assert recall.word_hit("patches land", "patch")
    assert not recall.word_hit("patches land", "atch")


def test_an_ambiguous_outcome_is_not_attached_to_a_command():
    events = [
        {"kind": "tool_call", "session": "s", "tool": "bash", "cmd": "rsync a b", "ok": None},
        {"kind": "tool_call", "session": "s", "tool": "bash", "cmd": "rsync c d", "ok": None},
        # No cmd to correlate with, two calls outstanding: a guess would be a lie.
        {"kind": "tool_result", "session": "s", "tool": "bash", "ok": False, "exit": 1},
    ]
    rows = recall._command_rows(events)
    assert [r["last_ok"] for r in rows] == [None, None]
    # A result that names its command pairs exactly, even after an overlap.
    events[2]["cmd"] = "rsync a b"
    rows = recall._command_rows(events)
    paired = {r["cmd"]: (r["last_ok"], r["last_exit"]) for r in rows}
    assert paired["rsync a b"] == (False, 1)
    assert paired["rsync c d"] == (None, None)


def test_a_read_tool_leaves_a_reusable_file_hint():
    events = [
        {"kind": "tool_result", "session": "s", "tool": "read", "cmd": "src/protect_context/store.py", "ok": True},
        {"kind": "tool_result", "session": "s", "tool": "read", "cmd": "src/protect_context/store.py", "ok": True},
        {"kind": "tool_result", "session": "s", "tool": "bash", "cmd": "pytest -q", "ok": True},
    ]
    result = recall.search("store.py", journal_rows=[], evidence_rows=[], event_rows=events)
    kinds = [h.kind for h in result.hits]
    assert kinds == ["file"], kinds
    hit = result.hits[0]
    assert hit.uses == 2 and hit.tool == "read"
    assert "read · reuse" in hit.line(1)
    # The key is a path, never a shell command: it may not form a loop streak.
    assert loops.streaks(events, session="s") == []
