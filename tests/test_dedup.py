"""Near-duplicate suppression: the classifier and the page filter.

The fixtures are duplicated in extension/test/dedup.test.ts so both runtimes
collapse the same pairs.
"""

from protect_context import dedup


def _freq(rows):
    return dedup.DocumentFrequencies([dedup.words(row) for row in rows])


def test_identical_rewrites_collapse_to_one_entry():
    rows = ["Rotation keeps three segments of the ledger."] * 5
    rows.append("Rotation also drops pinned lessons last.")
    kept = dedup.suppress(rows, 5)
    assert [rows[index][:12] for index in kept] == [
        "Rotation kee",
        "Rotation als",
    ]


def test_opposite_sentences_sharing_every_other_word_stay_apart():
    # The failure plain token overlap cannot avoid: same subject, opposite claim.
    # The differing token ("drops" / "keeps") is rare, so the veto fires.
    left = "rotation drops pinned lessons"
    right = "rotation keeps pinned lessons"
    frequencies = _freq([left, right, "unrelated noise about tests"])
    assert dedup.classify(left, right, frequencies) == "none"


def test_exact_tier_ignores_case_and_punctuation():
    frequencies = _freq(["Rotation keeps three segments."])
    assert (
        dedup.classify("Rotation keeps three segments.", "rotation  keeps three segments", frequencies)
        == "exact"
    )


def test_punctuation_only_rows_never_auto_merge():
    frequencies = _freq(["!!", "!!"])
    # An empty normal form identifies nothing, so collapsing it would lose rows.
    assert dedup.classify("!!", "!!", frequencies) == "none"


def test_unrelated_rows_are_not_candidates():
    frequencies = _freq(["recall ranking uses bm25 saturation", "recall searches every row"])
    assert (
        dedup.classify(
            "recall ranking uses bm25 saturation",
            "recall searches every row",
            frequencies,
        )
        == "none"
    )


def test_suppress_stops_at_the_requested_count():
    rows = ["alpha beta gamma", "delta epsilon zeta", "eta theta iota"]
    assert dedup.suppress(rows, 0) == []
    assert dedup.suppress(rows, 2) == [0, 1]
    assert dedup.suppress(rows, 10) == [0, 1, 2]


def test_compound_identifiers_stay_single_tokens():
    # Splitting on the hyphen would make "api" look common and disarm the veto.
    assert dedup.words("rdlp-api ffmpeg-7.1.conf") == ["rdlp-api", "ffmpeg-7.1.conf"]


def test_normalized_keeps_one_space_between_tokens():
    assert dedup.normalized("  Rotation,  keeps: three  ") == "rotation keeps three"


def test_idf_rewards_rarity_and_survives_zero_frequency():
    common = dedup.idf(50, 100)
    rare = dedup.idf(1, 100)
    assert rare > common > 0
    assert dedup.idf(0, 100) > rare
