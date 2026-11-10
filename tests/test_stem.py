"""Suffix stemmer: the morphology layer under recall matching.

The golden table below is duplicated verbatim in ``extension/test/stem.test.ts``.
That is deliberate: the two runtimes must produce the same stems or the same
journal ranks differently depending on which host asked, so a change here must be
mirrored there and will fail one suite until it is.
"""

import pytest

from protect_context import stem

# (token, expected stem) — mirrored in extension/test/stem.test.ts.
GOLDEN = [
    ("retrieving", "retriev"),
    ("retrieval", "retriev"),
    ("retrieve", "retriev"),
    ("retrieved", "retriev"),
    ("decisions", "decision"),
    ("decision", "decision"),
    ("journalling", "journal"),
    ("journalled", "journal"),
    ("journal", "journal"),
    ("memories", "memory"),
    ("memory", "memory"),
    ("verified", "verify"),
    ("verifying", "verify"),
    ("verifies", "verify"),
    ("searched", "search"),
    ("searching", "search"),
    ("rotations", "rotation"),
    ("rotated", "rotat"),
    ("running", "run"),
    ("stopped", "stop"),
    ("adding", "add"),
    ("added", "add"),
    ("moved", "move"),
    ("cached", "cach"),
    ("queues", "queu"),
    # Guarded: too short, or the guard is what keeps them apart.
    ("old", "old"),
    ("is", "is"),
    ("total", "total"),
    ("note", "note"),
    ("normal", "normal"),
    ("formal", "formal"),
    ("organic", "organic"),
    ("organization", "organization"),
    ("hop", "hop"),
    # Not ASCII letters: returned untouched.
    ("ev-0007", "ev-0007"),
    ("src/recall.py", "src/recall.py"),
    ("检索", "检索"),
    ("", ""),
]


@pytest.mark.parametrize(("token", "expected"), GOLDEN)
def test_golden_stems(token, expected):
    assert stem.stem(token) == expected


def test_inflections_of_one_word_share_a_stem():
    # The measured gap: word_hit() matched a keyword at a word start only, so a
    # query for the inflected form found nothing.
    families = [
        ["retrieving", "retrieval", "retrieve", "retrieved"],
        ["decisions", "decision"],
        ["journalling", "journalled", "journal"],
        ["memories", "memory"],
        ["verified", "verifying", "verifies"],
        ["adding", "added", "add"],
    ]
    for family in families:
        assert len({stem.stem(word) for word in family}) == 1, family


def test_distinct_words_keep_distinct_stems():
    # Over-stemming is the failure a conservative rule set is trading against:
    # these pairs must not collapse, or recall starts answering the wrong entry.
    pairs = [
        ("old", "threshold"),
        ("arch", "search"),
        ("normal", "form"),
        ("formal", "form"),
        ("organic", "organization"),
        ("is", "his"),
        ("total", "tot"),
        ("hop", "hoped"),
    ]
    for left, right in pairs:
        assert stem.stem(left) != stem.stem(right), (left, right)


def test_zero_length_word_preserved():
    assert stem.stem("") == ""


def test_tokens_split_on_punctuation_but_keep_cjk_whole():
    assert stem.tokens("src/recall.py: word_hit") == ["src", "recall", "py", "word", "hit"]
    assert stem.tokens("检索 匹配") == ["检索", "匹配"]
    assert stem.tokens("") == []


def test_stems_is_the_membership_set():
    found = stem.stems("The retrieval path changed after rotation.")
    assert "retriev" in found
    assert "rotation" in found
    assert "retriev" in stem.stems("retrieving")
