"""Bounded "what changed" digest for file-changing tool calls (SPEC §2 events).

The ledgers recorded that an edit happened and on which path, never how much
changed, so a past task could not be reconstructed without git. A line count is
the smallest unit that answers "one-liner or rewrite" while staying far too
small to be a copy of the file. Mirrors extension/lib/diffstat.ts.
"""

from __future__ import annotations


def _lines(text: str) -> list[str]:
    """Split into lines, ignoring one trailing newline.

    Without this a POSIX-terminated file reads as having a phantom final line,
    which inflates every count by one.
    """
    if text == "":
        return []
    return (text[:-1] if text.endswith("\n") else text).split("\n")


def line_count(text: str) -> int:
    """Number of lines in a block; the empty string is zero, not one."""
    return len(_lines(text))


def bounded_diff_stat(before: str, after: str) -> tuple[int, int]:
    """(added, removed) line counts between two texts.

    Common leading and trailing lines are stripped, and whatever remains is
    counted. No LCS: a full diff is O(n*m) on a large file and the extra
    accuracy does not change "how big was this change".
    """
    if before == after:
        return (0, 0)
    old, new = _lines(before), _lines(after)
    head = 0
    while head < len(old) and head < len(new) and old[head] == new[head]:
        head += 1
    tail = 0
    while (
        tail < len(old) - head
        and tail < len(new) - head
        and old[len(old) - 1 - tail] == new[len(new) - 1 - tail]
    ):
        tail += 1
    return (len(new) - head - tail, len(old) - head - tail)


def format_diff_stat(stat: tuple[int, int] | None) -> str | None:
    """Compact ledger form, e.g. '+12/-3'; None when nothing changed."""
    if stat is None:
        return None
    added, removed = stat
    if added == 0 and removed == 0:
        return None
    return f"+{added}/-{removed}"

def changed_span(before: str, after: str, hint_cap: int = 80) -> tuple[int, int, str]:
    """(start_line, end_line, first_line) of the change, 1-based in the new text.

    Zero start/end when nothing changed. A change that only deletes lines has no
    new range, so the span collapses to the line the deletion followed and the
    caller still learns where it happened. Mirrors changedSpan in diffstat.ts.
    """
    if before == after:
        return (0, 0, "")
    old, new = _lines(before), _lines(after)
    head = 0
    while head < len(old) and head < len(new) and old[head] == new[head]:
        head += 1
    tail = 0
    while (
        tail < len(old) - head
        and tail < len(new) - head
        and old[len(old) - 1 - tail] == new[len(new) - 1 - tail]
    ):
        tail += 1

    changed = len(new) - head - tail
    start_line = head + 1
    end_line = start_line if changed == 0 else len(new) - tail
    hint = (new[head - 1] if head > 0 else "") if changed == 0 else (new[head] if head < len(new) else "")
    return (start_line, end_line, hint.strip()[:hint_cap])
