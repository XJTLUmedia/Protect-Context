"""Persistent journal: .agent-guard/journal.jsonl (SPEC §1 #6, #7).

Entry shape (FROZEN): {"ts", "type": decision|correction|risk|note,
"text", "tags": []}. Entries survive restarts and are re-injected by the
extension when they change.
"""

from __future__ import annotations

import re
import unicodedata

from . import store

LESSON_TAG = "lesson"
# Owner satisfaction is recorded as convention, so a typo would silently become
# an ordinary tag. These two are the only spellings that mean anything.
SATISFACTION_TAGS = ("satisfied", "dissatisfied")
# Tags that say nothing about when a lesson applies: a lesson carrying only
# these is unreachable by any paraphrase but its own wording.
GENERIC_TAGS = frozenset(
    ("lesson", "agent", "decision", "note", "correction", "risk", "protect-context")
)

# Owner intent (SPEC §1 #6/#7). The journal already keeps the words, but a new
# session has to guess how they were phrased to find them. These four tags name
# what the owner actually expressed — wants, needs, preferences and "you are
# wrong" corrections — and `intent` renders the profile without a query.
INTENT_TAGS = ("owner-want", "owner-need", "owner-preference", "owner-correction")
_ATTR = r"(?:owner|user)"
_INTENT_PATTERNS = {
    "owner-want": re.compile(
        rf"\b{_ATTR}\b[^.]{{0,40}}\b(?:wants?|wanted|asked(?: for)?|said|says|chose|"
        rf"chosen|approved|decided|told|took|insists?|expects?|requires?)\b"
    ),
    "owner-need": re.compile(
        rf"\b{_ATTR}\b[^.]{{0,40}}\b(?:needs?|needed|must|required|has to)\b"
    ),
    "owner-preference": re.compile(
        rf"\b{_ATTR}\b[^.]{{0,60}}\b(?:prefers?|preferred|rather|instead)\b|\bprefers?\b"
    ),
    "owner-correction": re.compile(
        rf"\bcorrection\s*\(\s*owner\s*\)|\byou(?:'re| are| were)?\s+(?:wrong|incorrect)\b"
        rf"|\b{_ATTR}\s+(?:said|says|told\s+me)\b[^.]{{0,40}}\b(?:wrong|incorrect|mistake)\b"
    ),
}

# Text the owner typed or pasted themselves (pi's `input` event) needs no
# attribution: "ship it faster" is the owner's own voice even though the line
# names no owner. Only `owner_authored=True` uses these, so journal prose
# written by the agent is still judged by the attribution patterns above.
_OWNER_AUTHORED = {
    "owner-want": re.compile(
        r"\b(?:i|we)\s+(?:want|wanted|would like|'d like|asked for|expect)\b"
        r"|^\s*(?:please\s+)?(?:fix|add|build|implement|change|make|use|remove|rename|"
        r"update|ensure|keep|drop|replace|ship|finish|land|wire|port)\b"
    ),
    "owner-need": re.compile(r"\b(?:i|we)\s+(?:need|needs|must|have to|require)\b"),
    "owner-preference": re.compile(
        r"\b(?:i|we)\s*(?:'d|would)?\s*(?:prefer|rather)\b|\bprefer\b|\binstead\b"
    ),
    "owner-correction": re.compile(
        r"\b(?:you|it|that|this)\s+(?:is|was|are|were)\s+(?:wrong|incorrect)\b"
        r"|\bthat'?s not what\b|\byou (?:broke|missed|forgot|ignored)\b"
        r"|\bdo not do that again\b|\bstop (?:doing|adding|guessing|re-?running)\b"
    ),
}

NUDGE_BY_TYPE = {
    "decision": "Nudge: re-read journal decisions before resuming work.",
    # Agent-written corrections are re-injected as unverified, never authority;
    # only the owner's own /guard-note entry becomes trusted (contract 07).
    "correction": (
        "Nudge: check logged corrections before doing similar work. "
        "This entry stays unverified — the owner promotes one with /guard-note."
    ),
    "risk": "Nudge: logged risks should drive preflight and risk confirms.",
    "note": "Nudge: the journal persists across restarts — build on it.",
}

TEXT_CAP = 500  # free-text cap: journal text is re-injected into briefs (goal #12)
TAG_COUNT_CAP = 8
TAG_TEXT_CAP = 40
READ_LIMIT_DEFAULT = 5
READ_LIMIT_MAX = 20

_CONTROL_CATEGORIES = {"Cc", "Cf", "Cs"}


def _normalise_text(value: object, cap: int) -> str:
    """Return bounded, single-line text safe for storage and rendering.

    Journal content is model-supplied and later rendered into terminal/MCP
    output. Replace Unicode control, format, and surrogate code points with
    spaces before collapsing whitespace, so controls cannot forge lines or
    invisibly join otherwise separate words.
    """
    raw = str(value or "")
    without_controls = "".join(
        " " if unicodedata.category(char) in _CONTROL_CATEGORIES else char
        for char in raw
    )
    return " ".join(without_controls.split())[:cap].strip()


def detect_intent(text: object, owner_authored: bool = False) -> list[str]:
    """Return the owner-intent tags the text expresses, in INTENT_TAGS order.

    Deterministic and query-free: the point is that a later session can find
    what the owner wanted without reproducing today's wording. Attribution is
    required for wants/needs (an agent's own "I want to check" is not owner
    intent); a bare "prefer" counts because the owner writes it that way.

    ``owner_authored=True`` relaxes the attribution requirement for text the
    owner typed themselves (the pi `input` event), so a paraphrase with no
    "owner"/"user" noun — "ship it faster", "I'd rather split this" — is still
    captured. Callers must only set it for owner-typed text.
    """
    folded = _normalise_text(text, TEXT_CAP).casefold()
    patterns = [
        (tag, _INTENT_PATTERNS[tag], _OWNER_AUTHORED.get(tag) if owner_authored else None)
        for tag in INTENT_TAGS
    ]
    return [
        tag
        for tag, attributed, first_person in patterns
        if attributed.search(folded) or (first_person is not None and first_person.search(folded))
    ]


def _entry_intent(entry: dict) -> list[str]:
    """Explicit owner-intent tags plus text detection (covers legacy rows)."""
    tags = {tag.casefold() for tag in _normalise_tags(entry.get("tags"))}
    detected = set(detect_intent(entry.get("text")))
    return [tag for tag in INTENT_TAGS if tag in tags or tag in detected]


def _merge_intent_tags(text: str, tags: list[str], notes: list[str]) -> list[str]:
    """Tag a captured owner intent so a future session can find it by tag.

    The reserved `agent` provenance tag is kept in the last slot, exactly like
    tags_with_required: a capped tag list must never drop provenance and
    promote a model note to trusted memory.
    """
    present = {tag.casefold() for tag in tags}
    missing = [tag for tag in detect_intent(text) if tag.casefold() not in present]
    if not missing:
        return tags
    notes.append("owner intent detected — tagged " + ", ".join(missing))
    provenance = [tag for tag in tags if tag.casefold() == "agent"]
    rest = [tag for tag in tags if tag.casefold() != "agent"]
    room = max(0, TAG_COUNT_CAP - len(provenance))
    return (missing + rest)[:room] + provenance


def _normalise_tags(tags: object) -> list[str]:
    """Clean, deduplicate, and bound tags, dropping post-cleaning blanks."""
    if tags is None:
        return []
    if isinstance(tags, str):
        candidates = [tags]
    elif isinstance(tags, (list, tuple, set)):
        candidates = tags
    else:
        # MCP/CLI schemas supply arrays, but the core API is public: malformed
        # legacy/direct-call values should be ignored rather than crashing a
        # journal render or write.
        return []
    clean: list[str] = []
    seen: set[str] = set()
    for tag in candidates:
        value = _normalise_text(tag, TAG_TEXT_CAP)
        if value and value not in seen:
            clean.append(value)
            seen.add(value)
        if len(clean) >= TAG_COUNT_CAP:
            break
    return clean


def tags_with_required(tags: object, required: str) -> list[str]:
    """Return bounded tags with exactly one normalized required tag.

    The required tag is placed last and cannot be crowded out by an
    over-limit caller list. This lets delivery boundaries preserve authorship
    provenance without changing the frozen journal entry shape.
    """
    required_clean = _normalise_text(required, TAG_TEXT_CAP)
    if not required_clean:
        raise ValueError("required journal tag must not be blank")
    clean = [tag for tag in _normalise_tags(tags) if tag != required_clean]
    return clean[:TAG_COUNT_CAP - 1] + [required_clean]


def _supplied_tag(tags: object, wanted: str) -> bool:
    """True when the caller's raw tag input named `wanted` (case-insensitive)."""
    if isinstance(tags, str):
        candidates: object = [tags]
    elif isinstance(tags, (list, tuple, set)):
        candidates = tags
    else:
        return False
    return any(_normalise_text(tag, TAG_TEXT_CAP).casefold() == wanted for tag in candidates)


def _validate_type(jtype: str | None) -> None:
    if jtype is not None and jtype not in store.JOURNAL_TYPES:
        raise ValueError(
            f"unknown journal type {jtype!r}; use one of {', '.join(store.JOURNAL_TYPES)}"
        )


def _bounded_limit(limit: int) -> int:
    return max(0, min(int(limit), READ_LIMIT_MAX))


def _within_one_edit(left: str, right: str) -> bool:
    """True when the two strings differ by at most one edit (Levenshtein)."""
    if left == right:
        return True
    if abs(len(left) - len(right)) > 1:
        return False
    if len(left) == len(right):
        return sum(1 for a, b in zip(left, right, strict=True) if a != b) == 1
    short, long = (left, right) if len(left) < len(right) else (right, left)
    index = 0
    while index < len(short) and short[index] == long[index]:
        index += 1
    return short[index:] == long[index + 1 :]


def _fix_satisfaction_tags(tags: list[str], notes: list[str]) -> list[str]:
    """Normalize near-miss `satisfied`/`dissatisfied` tags and say so."""
    fixed: list[str] = []
    for tag in tags:
        match = next((want for want in SATISFACTION_TAGS if _within_one_edit(tag.casefold(), want)), None)
        if match is not None and tag != match:
            notes.append(f"tag {tag!r} normalized to {match!r} (owner satisfaction is a fixed word)")
            tag = match
        if tag not in fixed:
            fixed.append(tag)
    return fixed


def _note_lesson_triggers(jtype: str | None, tags: list[str], notes: list[str]) -> None:
    """Warn when a lesson carries no word a future query could plausibly use."""
    if LESSON_TAG not in {tag.casefold() for tag in tags}:
        return
    if any(tag.casefold() not in GENERIC_TAGS for tag in tags):
        return
    notes.append(
        "this lesson has no trigger tag, so only its own wording will find it — "
        "add the owner's words (e.g. tags=['annoyed', 'narrow-patch'])"
    )


def add(jtype: str, text: str, tags: list[str] | None = None) -> dict:
    """Append a cleaned journal entry; reject unknown types and blank text."""
    _validate_type(jtype)
    clean_text = _normalise_text(text, TEXT_CAP)
    if not clean_text:
        raise ValueError("journal text must not be blank")
    notes: list[str] = []
    clean_tags = _fix_satisfaction_tags(_normalise_tags(tags), notes)
    # The display cap must never drop provenance: a row that was written as an
    # agent note stays unverified. Callers that use tags_with_required are
    # already safe; a direct add() (CLI --tags) is not, until now.
    if _supplied_tag(tags, "agent") and not any(t.casefold() == "agent" for t in clean_tags):
        clean_tags = clean_tags[: TAG_COUNT_CAP - 1] + ["agent"]
    clean_tags = _merge_intent_tags(clean_text, clean_tags, notes)
    _note_lesson_triggers(jtype, clean_tags, notes)
    entry = {
        "ts": store.now_ts(),
        "type": jtype,
        "text": clean_text,
        "tags": clean_tags,
    }
    # The row is written with the frozen four keys only; display notes are
    # attached to the returned copy afterwards, so they never reach disk.
    stored = dict(entry)
    store.append_jsonl(store.journal_path(), stored)
    if notes:
        entry["ack_notes"] = notes
    return entry


def _filtered(jtype: str | None) -> list[dict]:
    """Every entry of one validated type (or every entry)."""
    _validate_type(jtype)
    entries = store.read_jsonl(store.journal_path())
    if jtype is None:
        return entries
    return [entry for entry in entries if entry.get("type") == jtype]


def recent_with_total(
    limit: int = READ_LIMIT_DEFAULT, jtype: str | None = None
) -> tuple[list[dict], int]:
    """``(slice, total)`` from ONE ledger read: every journal view shows both."""
    entries = _filtered(jtype)
    bounded = _bounded_limit(limit)
    if bounded == 0:
        return [], len(entries)
    return entries[-bounded:], len(entries)


def recent(limit: int = READ_LIMIT_DEFAULT, jtype: str | None = None) -> list[dict]:
    """Return a bounded recent slice, oldest first, optionally by type."""
    return recent_with_total(limit, jtype)[0]


def count(jtype: str | None = None) -> int:
    """Count all entries, or only entries of one validated journal type."""
    return len(_filtered(jtype))


def render_ack(entry: dict, total: int) -> str:
    """Compact acknowledgement for a freshly logged entry (ends with Nudge)."""
    jtype = _normalise_text(entry.get("type"), 16)
    tags = _normalise_tags(entry.get("tags"))
    tag_s = (" · tags: " + ", ".join(tags)) if tags else ""
    nudge = NUDGE_BY_TYPE.get(jtype, "Nudge: review the journal before resuming work.")
    notes = entry.get("ack_notes")
    head = f"logged {jtype or 'entry'} #{total}{tag_s}"
    if isinstance(notes, list) and notes:
        head += "".join(f"\nnote: {store.display_text(note, 200)}" for note in notes)
    return f"{head}\n{nudge}"


def render_recent(entries: list[dict], total: int, jtype: str | None = None) -> str:
    """Render a bounded journal view; every entry occupies exactly one line."""
    _validate_type(jtype)
    bounded_entries = entries[-READ_LIMIT_MAX:]
    scope = f" {jtype}" if jtype else ""
    lines = [f"PC journal{scope} · last {len(bounded_entries)} of {max(0, int(total))}"]
    for entry in bounded_entries:
        ts = _normalise_text(entry.get("ts"), 32) or "unknown-time"
        entry_type = _normalise_text(entry.get("type"), 16) or "unknown"
        text = _normalise_text(entry.get("text"), TEXT_CAP) or "(blank legacy entry)"
        tags = _normalise_tags(entry.get("tags"))
        tag_s = f" [{','.join(tags)}]" if tags else ""
        lines.append(f"{ts} · {entry_type} · {text}{tag_s}")
    lines.append("Nudge: re-read durable decisions and corrections before resuming work.")
    return "\n".join(lines)


def intent_with_total(
    limit: int = READ_LIMIT_DEFAULT,
) -> tuple[list[tuple[dict, list[str]]], int, dict[str, int]]:
    """``(rows, total, counts)`` for owner-intent entries, oldest first.

    Reads the journal once. A row counts when it carries an ``owner-*`` tag or
    when its text detects as owner intent, so rows written before this view
    existed are still captured. ``counts`` covers every row, not the page, so a
    bounded render never lies about how much the owner asked for.
    """
    entries = [entry for entry in store.read_jsonl(store.journal_path()) if isinstance(entry, dict)]
    classified = [(entry, _entry_intent(entry)) for entry in entries]
    classified = [(entry, kinds) for entry, kinds in classified if kinds]
    counts = {
        tag: sum(1 for _entry, kinds in classified if tag in kinds) for tag in INTENT_TAGS
    }
    # Provenance split: how much of the profile is the owner's own record and how
    # much is the agent's report of it (unverified). Without this a page of
    # [agent] lines looks like owner authority.
    counts["owner"] = sum(1 for entry, _kinds in classified if not _is_agent_entry(entry))
    counts["agent"] = len(classified) - counts["owner"]
    bounded = _bounded_limit(limit)
    page = [] if bounded == 0 else classified[-bounded:]
    return page, len(classified), counts


def _is_agent_entry(entry: dict) -> bool:
    """True when the row carries the reserved `agent` provenance tag."""
    return "agent" in {tag.casefold() for tag in _normalise_tags(entry.get("tags"))}


def render_intent(
    rows: list[tuple[dict, list[str]]], total: int, counts: dict[str, int]
) -> str:
    """One line per owner statement, newest first, with per-kind counts."""
    shown = rows[-READ_LIMIT_MAX:]
    counts_s = " · ".join(
        f"{tag.removeprefix('owner-')} {counts.get(tag, 0)}" for tag in INTENT_TAGS
    )
    lines = [
        f"PC intent · {len(shown)} of {max(0, int(total))} owner statements · {counts_s}"
        f" · owner {counts.get('owner', 0)} · agent {counts.get('agent', 0)}"
    ]
    for entry, kinds in reversed(shown):
        ts = _normalise_text(entry.get("ts"), 32) or "unknown-time"
        text = store.display_text(entry.get("text"), 160) or "(blank legacy entry)"
        provenance = "agent" if _is_agent_entry(entry) else "owner"
        lines.append(f"{kinds[0]} · {ts} · {text} [{provenance}]")
    if not shown:
        hint = "raise the limit" if total > 0 else "capture one with guard_note"
        lines.append(f"Nudge: no owner statement shown — {hint}.")
    else:
        lines.append(
            "Nudge: re-read the owner's wants, needs and corrections before acting; "
            "agent lines stay unverified."
        )
    return "\n".join(lines)
