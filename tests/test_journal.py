"""Journal writes and the bounded read/render surface (SPEC §1 #6/#7)."""

import pytest

from protect_context import journal, store


def test_add_shape_and_type_validation():
    e = journal.add("correction", "use rg", ["search"])
    assert e["type"] == "correction"
    assert e["text"] == "use rg"
    assert e["tags"] == ["search"]
    assert set(e) == {"ts", "type", "text", "tags"}
    with pytest.raises(ValueError):
        journal.add("nope", "x")
    with pytest.raises(ValueError, match="must not be blank"):
        journal.add("note", " \n\t\x00\u200b ")


def test_text_capped_at_500_chars():
    """Free text is capped at write time: journal text is re-injected (goal #12)."""
    e = journal.add("note", "y" * 900)
    assert len(e["text"]) == 500
    rows = store.read_jsonl(store.journal_path())
    assert rows[-1]["text"] == "y" * 500


def test_control_chars_and_tags_are_normalised_and_bounded():
    tags = ["first\nline", "first line", "\x00", "x" * 100] + [f"tag-{i}" for i in range(20)]
    e = journal.add("decision", "keep\nwords\x00apart\u202e safely", tags)

    assert e["text"] == "keep words apart safely"
    assert e["tags"][0] == "first line"
    assert len(e["tags"]) == journal.TAG_COUNT_CAP
    assert all(tag and len(tag) <= journal.TAG_TEXT_CAP for tag in e["tags"])
    assert e["tags"][1] == "x" * journal.TAG_TEXT_CAP


def test_malformed_non_iterable_tags_are_ignored():
    entry = journal.add("note", "safe", 7)  # type: ignore[arg-type]
    assert entry["tags"] == []


def test_required_tag_is_deduped_after_cleaning_and_cannot_be_crowded_out():
    tags = ["agent\n", "owner"] + [f"tag-{i}" for i in range(20)]
    clean = journal.tags_with_required(tags, "agent")

    assert len(clean) == journal.TAG_COUNT_CAP
    assert clean.count("agent") == 1
    assert clean[-1] == "agent"


def test_recent_is_capped_and_can_filter_by_type():
    for i in range(journal.READ_LIMIT_MAX + 4):
        journal.add("decision" if i % 2 == 0 else "note", f"entry {i}")

    assert len(journal.recent(10_000)) == journal.READ_LIMIT_MAX
    decisions = journal.recent(10_000, "decision")
    assert decisions
    assert all(entry["type"] == "decision" for entry in decisions)
    assert journal.recent(0) == []
    with pytest.raises(ValueError):
        journal.recent(5, "unknown")


def test_render_recent_is_one_line_per_entry_and_defensively_bounded():
    raw = {
        "ts": "now\nforged",
        "type": "note\u202e",
        "text": "line one\nline two" + "z" * 900,
        "tags": ["tag\nvalue"] + ["x" * 100] * 20,
    }
    text = journal.render_recent([raw] * (journal.READ_LIMIT_MAX + 3), 99)
    lines = text.splitlines()

    assert lines[0] == f"PC journal · last {journal.READ_LIMIT_MAX} of 99"
    assert len(lines) == journal.READ_LIMIT_MAX + 2
    assert "forged" in lines[1] and "line one line two" in lines[1]
    assert all(len(line) <= 32 + 3 + 16 + 3 + journal.TEXT_CAP + 2
               + journal.TAG_COUNT_CAP * (journal.TAG_TEXT_CAP + 1)
               for line in lines[1:-1])
    assert lines[-1].startswith("Nudge:")


def test_recent_with_total_reads_the_ledger_once(monkeypatch):
    journal.add("decision", "only entry")
    calls = []
    original = store.read_jsonl

    def counting(path):
        calls.append(path)
        return original(path)

    monkeypatch.setattr(store, "read_jsonl", counting)
    entries, total = journal.recent_with_total(5)
    assert len(calls) == 1, "the journal view must not parse the ledger twice"
    assert total == 1 and entries[0]["text"] == "only entry"


def test_correction_ack_names_the_trusted_channel():
    e = journal.add("correction", "stop folding dep bumps into releases")
    ack = journal.render_ack(e, journal.count())
    assert "logged correction" in ack
    assert "/guard-note" in ack, "the operator promotion path must be discoverable"
    assert "unverified" in ack


def test_a_misspelled_satisfaction_tag_is_normalized_and_reported():
    entry = journal.add("correction", "owner wanted the broad fix", ["dissatisfed", "agent"])
    # The owner-want tag is detected from the text and prepended, so the stored
    # row is discoverable by tag as well as by wording.
    assert entry["tags"] == ["owner-want", "dissatisfied", "agent"]
    ack = journal.render_ack(entry, 1)
    assert "normalized to 'dissatisfied'" in ack
    # The note is display-only: the frozen four-key row never gains extra fields.
    stored = store.read_jsonl(store.journal_path())[-1]
    assert set(stored) == {"ts", "type", "text", "tags"}
    assert stored["tags"] == ["owner-want", "dissatisfied", "agent"]


def test_a_lesson_without_a_trigger_tag_is_flagged():
    entry = journal.add("decision", "take all follow-ups from a review", ["lesson"])
    assert "no trigger tag" in journal.render_ack(entry, 1)
    tagged = journal.add("decision", "take all follow-ups from a review", ["lesson", "followup"])
    assert "no trigger tag" not in journal.render_ack(tagged, 2)


def test_detect_intent_names_wants_needs_preferences_and_corrections():
    assert journal.detect_intent("owner wants the broad fix") == ["owner-want"]
    assert journal.detect_intent("the user needs both runtimes green") == ["owner-need"]
    assert journal.detect_intent("I prefer minimal diffs") == ["owner-preference"]
    assert journal.detect_intent("CORRECTION (owner): you are wrong about tags") == [
        "owner-correction"
    ]
    # An agent's own plan is not owner intent, and neither is a plain result.
    assert journal.detect_intent("I want to check the ledger") == []
    assert journal.detect_intent("ran pytest: 258 passed") == []


def test_detect_intent_captures_owner_authored_paraphrase():
    """Text the owner typed needs no attribution noun; agent prose still does."""
    assert journal.detect_intent("ship it faster", owner_authored=True) == ["owner-want"]
    assert journal.detect_intent("ship it faster") == []
    assert journal.detect_intent("I'd rather split this into two commits", owner_authored=True) == [
        "owner-preference"
    ]
    assert journal.detect_intent("I need both runtimes green", owner_authored=True) == [
        "owner-need"
    ]
    assert journal.detect_intent("this is wrong", owner_authored=True) == ["owner-correction"]
    assert journal.detect_intent("unrelated bookkeeping", owner_authored=True) == []


def test_add_tags_owner_intent_and_never_evicts_provenance():
    entry = journal.add("correction", "owner wants the broad fix", ["agent"])
    assert entry["tags"] == ["owner-want", "agent"]
    assert "owner intent detected" in journal.render_ack(entry, 1)

    crowded = journal.add(
        "note", "owner needs the audit", [f"t{i}" for i in range(10)] + ["agent"]
    )
    assert len(crowded["tags"]) == journal.TAG_COUNT_CAP
    assert crowded["tags"][-1] == "agent", "provenance survives a full tag list"
    assert crowded["tags"][0] == "owner-need"


def test_intent_view_groups_counts_and_labels_provenance():
    journal.add("decision", "owner approved layering", ["agent"])
    journal.add("note", "owner prefers broad fixes")
    journal.add("note", "unrelated entry")

    rows, total, counts = journal.intent_with_total(5)
    text = journal.render_intent(rows, total, counts)
    assert total == 2
    assert counts["owner-want"] == 1 and counts["owner-preference"] == 1
    # Provenance split: how much of the profile is the owner's own record.
    assert counts["owner"] == 1 and counts["agent"] == 1
    assert "PC intent · 2 of 2 owner statements" in text
    assert "want 1 · need 0 · preference 1 · correction 0" in text
    assert "owner 1 · agent 1" in text
    assert "[agent]" in text and "[owner]" in text
    # Newest first, so today's want is easier to act on than last week's.
    assert text.index("owner-preference") < text.index("owner-want")
    assert text.rstrip().splitlines()[-1].startswith("Nudge:")


def test_intent_view_reaches_untagged_rows_and_bounds_the_page():
    store.append_jsonl(
        store.journal_path(),
        {
            "ts": "2026-01-01T00:00:00Z",
            "type": "decision",
            "text": "the user wants both runtimes green",
            "tags": [],
        },
    )
    rows, total, counts = journal.intent_with_total(0)
    assert rows == [] and total == 1, "the count still reports what exists"
    text = journal.render_intent(rows, total, counts)
    assert "0 of 1 owner statements" in text
    assert "raise the limit" in text
