"""Local recall: filters, ranking, provenance, and the rotated ledger window."""

import json

import pytest

from protect_context import loops, recall, store


def _journal(*rows):
    return list(rows)


def _hit_kinds(result):
    return [(hit.provenance, hit.kind, hit.evidence_id, hit.text) for hit in result.hits]


def test_bm25_arithmetic_is_pinned_for_the_typescript_mirror():
    """The ranking numbers are a cross-runtime contract.

    ``extension/test/recall.test.ts`` asserts these exact values. The two hosts
    read the same journal, so a score that drifts here would rank the owner's
    journal differently depending on which one asked.
    """
    assert [recall._idf(df, total) for df, total in [
        (1, 7), (2, 7), (3, 7), (7, 7), (1, 100), (50, 100), (100, 100), (0, 5)
    ]] == [1674, 1163, 827, 65, 4210, 693, 5, 0]
    assert [recall._bm25_term(*case) for case in [
        (1674, 3, 5, 6), (74, 3, 5, 6), (1000, 2, 2, 6), (1674, 12, 60, 6), (500, 1, 3, 6)
    ]] == [2911, 128, 1818, 2125, 645]


def test_a_long_query_widens_to_one_shared_term_and_says_so():
    # The hard floor returned nothing at all when a five-word question shared a
    # single word. The widening pass answers it, but flags the weaker evidence
    # instead of presenting it as a full match.
    journal = [
        {"ts": "t1", "type": "note", "text": "the ledger", "tags": []},
        {"ts": "t2", "type": "note", "text": "unrelated chatter about tests", "tags": []},
    ]
    result = recall.search(
        "explain the ledger rotation policy in detail",
        journal_rows=journal,
        evidence_rows=[],
    )
    assert result.widened is True
    assert [hit.text for hit in result.hits] == ["the ledger"]
    assert "Widened" in recall.render(result)


def test_a_query_that_matches_two_words_is_never_widened():
    # Widening must not run when the strict pass already answered: this is the
    # precision the floor was protecting in the first place.
    journal = [
        {"ts": "t1", "type": "note", "text": "owner prefers broad fixes over docs", "tags": []},
        {"ts": "t2", "type": "note", "text": "the owner", "tags": []},
    ]
    result = recall.search(
        "what did the owner say about tests and docs and release",
        journal_rows=journal,
        evidence_rows=[],
    )
    assert result.widened is False
    assert [hit.text for hit in result.hits] == ["owner prefers broad fixes over docs"]
    assert "Widened" not in recall.render(result)


def test_the_widening_pass_respects_every_filter():
    # A widened hit must still obey type/tag filters: widening is about the word
    # floor, never about ignoring what the caller asked for.
    journal = [
        {"ts": "t1", "type": "note", "text": "the ledger", "tags": ["other"]},
        {"ts": "t2", "type": "risk", "text": "ledger corruption risk", "tags": ["ledger"]},
    ]
    result = recall.search(
        "explain the ledger rotation policy in detail",
        type="decision",
        journal_rows=journal,
        evidence_rows=[],
    )
    assert result.hits == []
    tagged = recall.search(
        "explain the ledger rotation policy in detail",
        tags=["ledger"],
        journal_rows=journal,
        evidence_rows=[],
    )
    assert [hit.text for hit in tagged.hits] == ["ledger corruption risk"]


def test_a_reused_hint_outranks_an_equivalent_one_shot():
    events = []
    for index in range(3):
        events.append(
            {"ts": f"t{index}", "session": "s", "kind": "tool_call", "tool": "bash", "cmd": "rsync a b"}
        )
    events.append(
        {"ts": "t9", "session": "s", "kind": "tool_call", "tool": "bash", "cmd": "rsync c d"}
    )
    result = recall.search("rsync", journal_rows=[], evidence_rows=[], event_rows=events)
    assert [hit.cmd for hit in result.hits] == ["rsync a b", "rsync c d"]
    assert result.hits[0].uses == 3
    assert result.hits[0].strength > result.hits[1].strength


def test_the_reinforcement_boost_is_capped():
    # A row reused a hundred times must not buy an unbounded advantage.
    journal = [
        {"ts": "t1", "type": "note", "text": "alpha ledger note one", "tags": [], "uses": 8},
        {"ts": "t2", "type": "note", "text": "alpha ledger note two", "tags": [], "uses": 100},
    ]
    result = recall.search("alpha", journal_rows=journal, evidence_rows=[])
    assert result.hits[0].strength == result.hits[1].strength


def test_relevance_still_beats_reinforcement():
    # The boost settles near-ties; it may never outvote a genuinely better match.
    journal = [
        {"ts": "t1", "type": "note", "text": "alpha " + "filler " * 40, "tags": [], "uses": 100},
        {"ts": "t2", "type": "note", "text": "alpha ledger", "tags": [], "uses": 0},
    ]
    result = recall.search("alpha ledger", journal_rows=journal, evidence_rows=[])
    assert result.hits[0].text == "alpha ledger"
    assert result.hits[0].strength > result.hits[1].strength


def test_a_journal_row_keeps_its_recorded_reuse_count():
    # Regression: _as_journal() used to drop "uses", so a row that recorded its
    # own reuse counted as never reused.
    journal = [{"ts": "t1", "type": "note", "text": "owned it", "tags": [], "uses": 4}]
    result = recall.search("owned", journal_rows=journal, evidence_rows=[])
    assert result.hits[0].uses == 4
    # A non-integer count is not a count.
    parsed = recall._as_journal({"type": "note", "text": "x", "uses": "4"})
    assert parsed is not None and parsed["uses"] == 0
    parsed_negative = recall._as_journal({"type": "note", "text": "x", "uses": -3})
    assert parsed_negative is not None and parsed_negative["uses"] == 0


def test_equal_strength_breaks_the_tie_on_recency():
    # Two rows of identical length and weight score the same, so the newer one
    # must rank first. This is the tiebreak the ranking now exposes only when the
    # BM25 scores are actually equal.
    journal = [
        {"ts": "2026-01-01T00:00:00.000Z", "type": "note", "text": "alpha ledger note one", "tags": []},
        {"ts": "2026-02-01T00:00:00.000Z", "type": "note", "text": "alpha ledger note two", "tags": []},
    ]
    result = recall.search("alpha", journal_rows=journal, evidence_rows=[])
    assert result.hits[0].strength == result.hits[1].strength
    assert result.hits[0].recency > result.hits[1].recency
    assert "note two" in result.hits[0].text


def test_a_verbose_row_does_not_outrank_a_precise_one():
    # The measured length bias: a 60-word filler row used to beat a precise
    # five-word row because the old score was an unbounded sum of weights.
    journal = [
        {"ts": "t1", "type": "decision", "text": "rotation keeps three segments", "tags": []},
        {"ts": "t2", "type": "note", "text": "rotation " + "filler " * 60, "tags": []},
    ]
    result = recall.search("rotation", journal_rows=journal, evidence_rows=[])
    assert result.hits[0].text == "rotation keeps three segments"


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
    # BM25 ranks by term score, not by row kind: the two-word journal note wins,
    # the short command row beats the longer decision row, and a row that only
    # mentions "alpha" in its digest comes last.
    assert [hit.provenance + ":" + hit.kind for hit in result.hits] == [
        "agent:note",
        "trusted:evidence",
        "trusted:decision",
        "trusted:evidence",
    ]
    assert result.hits[0].text == "alpha mentioned"
    assert result.hits[2].tags == ["ledger"]
    assert result.hits[1].evidence_id == "ev-0007"
    assert result.hits[1].strength > result.hits[3].strength
    assert [hit.strength for hit in result.hits] == sorted(
        (hit.strength for hit in result.hits), reverse=True
    ), "ranked by strength, descending"
    # Pinned: the TypeScript mirror asserts the same four numbers.
    assert [hit.strength for hit in result.hits] == [512, 447, 426, 235]
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
    dropped = journal.with_name("journal.7.jsonl")
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


def test_inflected_query_reaches_the_row_about_another_form():
    # Word-start matching was one-way, so every one of these returned nothing.
    journal = [
        {"ts": "t1", "type": "decision", "text": "The retrieval path walks every row.", "tags": []},
        {"ts": "t2", "type": "decision", "text": "Every decision is journalled.", "tags": []},
    ]
    for query in ["retrieving", "retrieval", "retrieved"]:
        hits = recall.search(query, journal_rows=journal, evidence_rows=[]).hits
        assert hits and "retrieval" in hits[0].text, query
    # Plural query against the singular stored form, and the odd spelling pair.
    assert recall.search("decisions", journal_rows=journal, evidence_rows=[]).matched == 1
    assert recall.search("journalling", journal_rows=journal, evidence_rows=[]).matched == 1


def test_stemming_does_not_reintroduce_mid_word_noise():
    # A stem must be a whole token, never a substring: "arch" may not reach
    # "search" and "old" may not reach "threshold" just because stems exist.
    rows = [
        {"ts": "1", "type": "note", "text": "raise the threshold", "tags": []},
        {"ts": "2", "type": "note", "text": "search the index", "tags": []},
    ]
    assert recall.search("old", journal_rows=rows, evidence_rows=[]).matched == 0
    assert recall.search("arch", journal_rows=rows, evidence_rows=[]).matched == 0


def test_a_chinese_keyword_matches_inside_an_unsegmented_run():
    """CJK has no word starts, so the boundary rule hid every 中文 match.

    Measured 2026-11-11: a query for 生产库 returned 0 hits against a row that
    literally contains 在生产库上, because the character before the match is a
    letter. Substring is the correct unit for a script with no spaces; the
    mid-word noise the boundary rule stops ("arch" in "search") needs an ASCII
    word structure Chinese does not have.
    """
    row = "永远不要在生产库上执行破坏性 SQL 迁移"
    assert recall.word_hit(row, "生产库")
    assert recall.word_hit(row, "破坏性")
    assert not recall.word_hit(row, "生产表")

    rows = [{"ts": "1", "type": "correction", "text": row, "tags": []}]
    hits = recall.search("生产库", journal_rows=rows, evidence_rows=[]).hits
    assert [h.text for h in hits] == [row]

    # ASCII keeps the strict rule: a 中文 neighbour does not license a mid-word hit.
    assert not recall.word_hit("表格old", "old")


def test_a_search_never_answers_itself():
    """The store records the query a search ran; that echo is not knowledge.

    Measured 2026-11-11 on the real store: a 中文 query returned four rows and
    every one of them was a command that ran that same query, so the search
    looked like it had found something when the store held nothing at all.
    """
    events = [
        {
            "kind": "tool_result",
            "session": "s",
            "tool": "guard_recall",
            "cmd": "拆分改动 400 行",
            "ok": True,
            "ts": "2026-11-11T02:00:00Z",
        },
        {
            "kind": "tool_result",
            "session": "s",
            # MCP clients qualify the name; the last segment is the real tool.
            "tool": "mcp__protect_context__guard_recall",
            "cmd": "拆分改动",
            "ok": True,
            "ts": "2026-11-11T02:01:00Z",
        },
        {
            "kind": "tool_result",
            "session": "s",
            "tool": "read",
            "cmd": "src/protect_context/recall.py",
            "ok": True,
            "ts": "2026-11-11T02:02:00Z",
        },
    ]
    result = recall.search("拆分改动", journal_rows=[], evidence_rows=[], event_rows=events)
    assert [h.text for h in result.hits] == []
    # Non-query hints still index: the fix must not blind the reuse ledger.
    file_hits = recall.search(
        "recall.py", journal_rows=[], evidence_rows=[], event_rows=events
    ).hits
    assert [h.cmd for h in file_hits] == ["src/protect_context/recall.py"]


def test_a_chinese_query_reaches_the_english_row_with_the_same_rule():
    """The measured cross-lingual gap: no shared characters, so no hit.

    SPEC excludes embeddings, so the bridge is the curated dictionary in
    ``glossary.py``, applied at query time. 生产库 expands to "production
    database"/"production", and the English row is reachable without changing
    what is stored. A literal row of the same rarity must still rank first: the
    translated term is scaled to 0.6.
    """
    english = {
        "ts": "t1",
        "type": "correction",
        "text": "Never run destructive SQL on the production database.",
        "tags": [],
    }
    chinese = {
        "ts": "t2",
        "type": "correction",
        "text": "永远不要在生产库上执行破坏性 SQL 迁移",
        "tags": [],
    }
    rows = [english, chinese]

    zh_hits = recall.search(
        "生产库", journal_rows=rows, evidence_rows=[], include_commands=False
    ).hits
    assert [hit.text for hit in zh_hits] == [chinese["text"], english["text"]]

    en_hits = recall.search(
        "production database", journal_rows=rows, evidence_rows=[], include_commands=False
    ).hits
    assert [hit.text for hit in en_hits] == [english["text"], chinese["text"]]

    # One term is enough for the other language too.
    assert [hit.text for hit in recall.search(
        "破坏性", journal_rows=rows, evidence_rows=[], include_commands=False
    ).hits] == [chinese["text"], english["text"]]
    assert english["text"] in [
        hit.text
        for hit in recall.search(
            "destructive", journal_rows=rows, evidence_rows=[], include_commands=False
        ).hits
    ]


def test_the_bilingual_bridge_is_one_hop_and_bounded():
    """A dictionary is not a translation model: unknown pairs still miss.

    Honesty matters more than reach here. The table bridges only the terms it
    lists; a paraphrase outside it behaves exactly as before (no hit), and a
    keyword never matches a row through a chain of two translations.
    """
    rows = [{"ts": "t1", "type": "note", "text": "Ship the release on Friday.", "tags": []}]
    # "发布" is in the table ("release"), "上线" (a common synonym) is not.
    assert recall.search("上线", journal_rows=rows, evidence_rows=[]).matched == 0
    assert recall.search("发布", journal_rows=rows, evidence_rows=[]).matched == 1
    # The ASCII mid-word guard is untouched by the bridge.
    assert recall.word_hit("表格old", "old") is False


def test_the_glossary_mirrors_the_typescript_table():
    """Two hand-maintained lists drift silently; this pins them to each other."""
    from pathlib import Path

    from protect_context import glossary

    source = (Path(__file__).resolve().parents[1] / "extension/lib/glossary.ts").read_text()
    pairs = []
    for line in source.splitlines():
        stripped = line.strip()
        if not stripped.startswith('["'):
            continue
        english, chinese = stripped.rstrip(",").strip("[]").split('", "')
        pairs.append((english.lstrip('"'), chinese.rstrip('"')))
    assert tuple(pairs) == glossary.PAIRS
