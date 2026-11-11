"""Journal writes and the bounded read/render surface (SPEC §1 #6/#7)."""

import json
import re

import pytest

from protect_context import journal, store


def test_add_shape_and_type_validation():
    e = journal.add("correction", "use rg", ["search"])
    assert e["type"] == "correction"
    assert e["text"] == "use rg"
    assert e["tags"] == ["search"]
    # `session` is the join key to the events/evidence ledgers; `id` is the
    # citable handle. Both are part of the stored row, not display-only.
    assert set(e) == {"id", "session", "ts", "type", "text", "tags"}
    assert re.fullmatch(r"jn-\d{4,}", e["id"]), "every entry needs a stable, citable id"
    with pytest.raises(ValueError):
        journal.add("nope", "x")
    with pytest.raises(ValueError, match="must not be blank"):
        journal.add("note", " \n\t\x00\u200b ")


def test_long_text_is_kept_and_truncation_is_reported():
    """A decision longer than the cap must survive, and the cut must be visible.

    The cap used to be 500, which silently cut 70% of this repo's own journal
    mid-word; a silent cut loses the rationale and the acknowledgement claimed
    success anyway.
    """
    e = journal.add("note", "y" * 900)
    assert len(e["text"]) == 900, "900 chars is under the 4000 cap and must be kept whole"
    assert "truncated" not in journal.render_ack(e, 1)

    big = journal.add("note", "z" * 9000)
    assert len(big["text"]) == journal.TEXT_CAP
    assert "truncated" in journal.render_ack(big, 2)
    rows = store.read_jsonl(store.journal_path())
    assert rows[-1]["text"] == "z" * journal.TEXT_CAP


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
    # Display notes stay off disk: the row carries its id, session and the
    # frozen four fields, and nothing else.
    stored = store.read_jsonl(store.journal_path())[-1]
    assert set(stored) == {"id", "session", "ts", "type", "text", "tags"}
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
    # Naming the tag is not expressing the intent: with `\b` the tag literal
    # "owner-want" matched (boundary between "owner" and "-want").
    assert journal.detect_intent("tags: owner-want and owner-need") == []
    assert journal.detect_intent("the owner-preference tag is set") == []
    # A quotation is about intent, not an expression of it.
    assert journal.detect_intent('the test text "owner wants X" is a fixture') == []
    assert journal.detect_intent("the fixture `owner wants X` is copy-pasted") == []
    # ... but quoting inside a real request keeps the request.
    assert journal.detect_intent('fix the "flaky" test', owner_authored=True) == ["owner-want"]


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


def test_detect_intent_reads_real_owner_prompts():
    """The first detector knew 17 verbs and needed them at position 0, so the
    owner's real prompts ("now audit the full plugin", "Reinstall the venv") were
    captured as prompts and detected as no intent at all (2026-11-10)."""
    assert journal.detect_intent("now audit the full plugin", owner_authored=True) == [
        "owner-want"
    ]
    assert journal.detect_intent("Reinstall the venv from scratch", owner_authored=True) == [
        "owner-want"
    ]
    assert journal.detect_intent("now reload the extension and audit", owner_authored=True) == [
        "owner-want"
    ]
    # A start-anchored negation is a standing constraint, not a correction.
    assert journal.detect_intent("never commit straight to main", owner_authored=True) == [
        "owner-constraint"
    ]
    assert journal.detect_intent(
        "Do not touch the README; use the vendor folder", owner_authored=True
    ) == ["owner-constraint"]
    # Owner-typed only: the same words in agent prose stay unclassified.
    assert journal.detect_intent("never commit straight to main") == []
    assert journal.detect_intent("audit the full plugin") == []


def test_owner_prompt_rows_are_always_owner_statements():
    store.append_jsonl(
        store.journal_path(),
        {
            "ts": "2026-01-01T00:00:00Z",
            "type": "note",
            "text": "cold start on the parser",
            "tags": ["owner-prompt"],
        },
    )
    journal.add("decision", "Owner approved the upgrade", ["agent"])
    # Provenance outranks the claim: a model row cannot borrow the tag.
    store.append_jsonl(
        store.journal_path(),
        {
            "ts": "2026-01-02T00:00:00Z",
            "type": "note",
            "text": "audit the plugin",
            "tags": ["owner-prompt", "agent"],
        },
    )

    rows, total, counts = journal.intent_with_total(5)
    text = journal.render_intent(rows, total, counts)

    assert total == 2, "the captured prompt joins the agent's paraphrase"
    assert counts["owner-statement"] == 1
    assert counts["owner"] == 1 and counts["agent"] == 1
    assert "owner-statement · 2026-01-01T00:00:00Z · cold start on the parser [owner]" in text


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
    assert "want 1 · need 0 · preference 1 · constraint 0 · correction 0" in text
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

def test_legacy_rows_get_ids_in_file_order_and_the_repair_is_idempotent():
    path = store.journal_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    legacy = [
        {"ts": "t1", "type": "decision", "text": "first", "tags": []},
        {"ts": "t2", "type": "note", "text": "second", "tags": []},
        {"ts": "t3", "type": "correction", "text": "third", "tags": []},
    ]
    path.write_text("".join(json.dumps(row) + "\n" for row in legacy), encoding="utf-8")

    fresh = journal.add("note", "fourth")
    rows = store.read_jsonl(path)
    # Ids sort chronologically: file order is the only assignment that cannot
    # reorder history, and the new row continues the sequence.
    assert [row["id"] for row in rows] == ["jn-0001", "jn-0002", "jn-0003", "jn-0004"]
    assert fresh["id"] == "jn-0004"
    assert [row["text"] for row in rows] == ["first", "second", "third", "fourth"]

    # A second write must not renumber anything.
    journal.add("note", "fifth")
    assert [row["id"] for row in store.read_jsonl(path)][-2:] == ["jn-0004", "jn-0005"]


def test_detect_intent_reads_chinese_statements():
    """中文 feedback was stored and never classified (measured 2026-11-11).

    The English patterns anchor on ``\\b``, which has no meaning between Chinese
    characters, so a 中文 correction reached the journal and stopped there: the
    intent view reported "0 of 0 owner statements" while the correction sat one
    row away.
    """
    assert journal.detect_intent("我要求先拆小改动再提交，400 行以上必须拆分", True) == [
        "owner-want",
        "owner-constraint",
    ]
    assert journal.detect_intent("不要再把版本号和非版本改动混在一个提交里", True) == [
        "owner-constraint"
    ]
    assert journal.detect_intent("最好先跑一遍完整测试再提交", True) == ["owner-preference"]
    # 我需要 must read as a need, not reach the bare 要 and report a want.
    assert journal.detect_intent("我需要两个运行时都通过", True) == ["owner-need"]
    # Attribution wording works for agent prose too, exactly like "the owner wants".
    assert journal.detect_intent("主人要求每个改动都要有验证证据") == ["owner-want"]
    # A bare imperative in agent prose is the agent's own instruction, not the
    # owner's: it only counts for owner-typed text.
    assert journal.detect_intent("必须重新运行整套测试") == []
    assert journal.detect_intent("必须重新运行整套测试", True) == ["owner-constraint"]
    # Quoted 中文 is about the owner's words, not an expression of them.
    assert journal.detect_intent("他说「不要提交」", True) == []


def test_a_correction_can_carry_the_check_that_proves_it():
    """The store can hold the command that proves a correction still holds.

    Without it "did the correction change behaviour" was unanswerable next
    session: the correction was recorded and never tested.
    """
    entry = journal.add("correction", "split changes over 400 lines", check="true")
    assert entry["check"] == "true"
    assert store.read_jsonl(store.journal_path())[-1]["check"] == "true"

    # The field is one line: a second line would be a shell script, not a check.
    multiline = journal.add("correction", "no publish", check="echo a\necho b")
    assert multiline["check"] == "echo a echo b"

    # A check on anything but a correction would execute with nothing to prove.
    with pytest.raises(ValueError):
        journal.add("note", "a note", check="true")
    assert "check" not in journal.add("note", "a note without a check")
