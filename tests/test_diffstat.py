"""Bounded diff digest, asserted with the same fixtures as diffstat.test.ts."""

import pytest

from protect_context import diffstat


def test_a_replacement_does_not_double_count_shared_lines():
    # Duplicated verbatim in extension/test/diffstat.test.ts: both runtimes must
    # report one added and one removed for a single changed middle line.
    assert diffstat.bounded_diff_stat("a\nb\nc\n", "a\nB\nc\n") == (1, 1)


def test_appends_and_deletions_are_counted_separately():
    assert diffstat.bounded_diff_stat("a\n", "a\nb\nc\n") == (2, 0)
    assert diffstat.bounded_diff_stat("a\nb\nc\n", "a\n") == (0, 2)


def test_creating_and_emptying_a_file():
    assert diffstat.bounded_diff_stat("", "x\ny\n") == (2, 0)
    assert diffstat.bounded_diff_stat("x\ny\n", "") == (0, 2)
    assert diffstat.bounded_diff_stat("same\n", "same\n") == (0, 0)


def test_the_ledger_form_is_compact_and_empty_changes_are_omitted():
    assert diffstat.format_diff_stat((12, 3)) == "+12/-3"
    assert diffstat.format_diff_stat((0, 0)) is None
    assert diffstat.format_diff_stat(None) is None
    assert diffstat.line_count("") == 0
    assert diffstat.line_count("a") == 1


@pytest.mark.parametrize("text", ["a\n", "a"])
def test_a_trailing_newline_never_adds_a_phantom_line(text):
    assert diffstat.line_count(text) == 1


def test_the_changed_span_names_where_the_edit_landed():
    # Duplicated verbatim in extension/test/diffstat.test.ts: line numbers refer
    # to the new text on both runtimes.
    assert diffstat.changed_span("a\nb\nc\nd\n", "a\nb\nC\nd\n") == (3, 3, "C")


def test_insertions_report_the_inserted_lines_and_deletions_the_seat():
    assert diffstat.changed_span("a\nb\n", "a\nnew1\nnew2\nb\n") == (2, 3, "new1")
    assert diffstat.changed_span("a\nb\nc\n", "a\nc\n") == (2, 2, "a")
    assert diffstat.changed_span("same\n", "same\n") == (0, 0, "")
