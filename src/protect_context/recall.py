"""Local recall over the retained journal and evidence window.

Readers use ``store.read_jsonl``, so the live ledger plus up to three rotated
segments are concatenated oldest-first — the same window every other reader
sees (SPEC §2). Segments already dropped by rotation are not searched.

No embeddings, no network, and no extra index. Filters combine with AND.

A query is a paraphrase, not a string, so matching is word-start **or equal
stem**: ``retrieving`` reaches a row about ``retrieval``, while ``arch`` still
never reaches ``search``. Common English stopwords are dropped. Each keyword
matches across ``text``, ``cmd``, and ``digest``; a keyword that is itself an
evidence id (``ev-NNNN``) also matches that id. Tags are exact, case-insensitive,
and AND: every requested tag must be present. Evidence rows have no tags, so a
tag filter excludes them.

Rows score by BM25 (``k1=1.5``, ``b=0.75``, Lucene IDF) in integer thousandths:
term frequency saturates, and a row is normalised by its length against the
corpus average so a verbose row cannot win on volume alone. A query of three or
more keywords must still share two words, but when nothing matches at that floor
the search widens once to a single shared term and reports ``widened``.

When a query is given, past bash commands from the events ledger join the
corpus as ``command`` rows (successful calls only, deduplicated by fingerprint
and skipped when the same command is already in the evidence ledger), so
"copy this to that folder" reaches the command that did it last time.

Ranking is match strength, then recency, then a bounded boost from a row's
recorded reuse count. The displayed page collapses near-duplicates
(``dedup``), so restatements of one entry cannot fill it. Journal hits tagged
``agent`` stay unverified; every other journal hit and every evidence row is
trusted.

Keep the weights, constants, and filter rules aligned with
``extension/lib/recall.ts``.
"""

from __future__ import annotations

import math
import re

from cachetools import LRUCache

from . import dedup, store
from . import stem as stemmer

RECALL_TYPES = ("decision", "correction", "risk", "note", "evidence")
LIMIT_DEFAULT = 5
LIMIT_MAX = 20
MAX_KEYWORDS = 12
QUERY_CAP = 500

TEXT_WEIGHT = 3
TAG_WEIGHT = 2
CMD_WEIGHT = 2
DIGEST_WEIGHT = 1
ID_WEIGHT = 4
CMD_EXACT_WEIGHT = 4
CMD_SUB_WEIGHT = 1

# Observed-reuse reinforcement. A hint that already solved this three times is
# worth more than one that was tried once, but the boost is capped and small, so
# it can settle a near-tie and never outvote a genuinely better lexical match.
# This is not ACT-R base-level activation: the ledger stores a count, not the
# dates of each reuse, so there is no history to decay.
USES_BONUS_STEP = 10
USES_BONUS_CAP = 8

# BM25 saturation (k1) and length normalisation (b), in thousandths so the
# arithmetic stays integer and the TypeScript mirror agrees to the unit.
K1_MILLI = 1500
B_MILLI = 750

_EV_ID = re.compile(r"ev-(\d+)$", re.IGNORECASE)
_AGENT_TAG = "agent"

# Query words that carry no signal on their own. Dropped before ranking so a
# paraphrased question ("did the owner take all three follow-ups?") still
# reaches the entry that answers it instead of dying on AND("the", "did").
_STOPWORDS = frozenset(
    (
        "a an and any are as at be been before being but by can could did do does"
        " doing done for from get gets got had has have how i if in into is it"
        " its just me more"
        " most my no not now of on once only or other our out over own same she"
        " should so some such than that the their them then there these they this"
        " those through to too under until up very was we were what when where"
        " which while who whom why will with would you your"
    ).split()
)
# A longer query must share more than one word, or every entry that mentions
# "owner" would match a five-word question.
_MULTI_MATCH_FROM = 3
_MULTI_MATCH_FLOOR = 2



def canonical_evidence_id(value: object) -> str | None:
    """Return the allocator's ``ev-NNNN`` shape, or None when ``value`` is not one.

    ``ev-7`` and ``EV-0007`` are the same id. Digit strings longer than eight
    characters are rejected so a huge token cannot be treated as an id.
    """
    if not isinstance(value, str):
        return None
    match = _EV_ID.fullmatch(value.strip())
    if match is None:
        return None
    digits = match.group(1)
    if len(digits) > 8:
        return None
    trimmed = digits.lstrip("0")
    if not trimmed:
        return None
    return f"ev-{trimmed.zfill(4)}"


def bounded_limit(limit: object) -> int:
    """Clamp a recall limit to ``[0, LIMIT_MAX]``.

    Non-numeric values raise. Integral floats are accepted; other floats are
    truncated toward zero, matching the extension.
    """
    if isinstance(limit, bool) or not isinstance(limit, (int, float)):
        raise ValueError("recall limit must be an integer")
    if isinstance(limit, float) and not math.isfinite(limit):
        raise ValueError("recall limit must be an integer")
    return max(0, min(math.trunc(limit), LIMIT_MAX))


def _blank_to_none(value: object) -> str | None:
    if value is None:
        return None
    if not isinstance(value, str):
        raise ValueError("recall filter must be a string")
    text = value.strip()
    return text or None


def _validate_type(value: object) -> str | None:
    text = _blank_to_none(value)
    if text is None:
        return None
    if text not in RECALL_TYPES:
        raise ValueError(
            f"unknown recall type {text!r}; use one of {', '.join(RECALL_TYPES)}"
        )
    return text


def _validate_evidence_id(value: object) -> str | None:
    text = _blank_to_none(value)
    if text is None:
        return None
    canonical = canonical_evidence_id(text)
    if canonical is None:
        raise ValueError("evidence id must look like ev-NNNN")
    return canonical


def _keywords(query: object) -> list[str]:
    if query is None:
        return []
    if not isinstance(query, str):
        raise ValueError("recall query must be a string")
    raw = store.display_text(query, QUERY_CAP).casefold()
    found: list[str] = []
    seen: set[str] = set()
    for part in raw.split():
        if not part or part in seen or part in _STOPWORDS:
            continue
        seen.add(part)
        found.append(part)
        if len(found) >= MAX_KEYWORDS:
            break
    return found


def _raw_tags(value: object) -> list[str]:
    if isinstance(value, str):
        items: list[object] = [value]
    elif isinstance(value, list):
        items = value
    else:
        return []
    tags: list[str] = []
    for item in items:
        if isinstance(item, str):
            tags.append(item)
    return tags


def _tag_key(tag: str) -> str:
    return store.display_text(tag, 40).casefold()


def _requested_tags(tags: object) -> list[str]:
    if tags is None:
        return []
    if isinstance(tags, str):
        items: list[object] = [tags]
    elif isinstance(tags, (list, tuple)):
        items = list(tags)
    else:
        raise ValueError("recall tags must be a list of strings")
    found: list[str] = []
    seen: set[str] = set()
    for item in items:
        if not isinstance(item, str):
            raise ValueError("recall tags must be a list of strings")
        for part in item.split(","):
            key = _tag_key(part)
            if key and key not in seen:
                seen.add(key)
                found.append(key)
    return found


def _is_agent(tags: list[str]) -> bool:
    # Same normalisation as the tag filter (_tag_key), so a stored `Agent` tag is
    # both filterable and labelled unverified instead of trusted.
    return any(_tag_key(tag) == _AGENT_TAG for tag in tags)


def _display_tags(tags: list[str]) -> list[str]:
    shown: list[str] = []
    seen: set[str] = set()
    for tag in tags:
        clean = store.display_text(tag, 40)
        if clean and clean not in seen:
            seen.add(clean)
            shown.append(clean)
        if len(shown) >= 8:
            break
    return shown


def _as_journal(row: dict) -> dict | None:
    kind = row.get("type")
    if kind not in store.JOURNAL_TYPES:
        return None
    text = row.get("text", "")
    if not isinstance(text, str):
        return None
    ts = row.get("ts")
    tags = _raw_tags(row.get("tags"))
    return {
        "source": "journal",
        "kind": kind,
        "text": text,
        "cmd": "",
        "digest": "",
        "ts": ts if isinstance(ts, str) else "",
        "tags": tags,
        "evidence_id": None,
        "exit_code": None,
        "provenance": "agent" if _is_agent(tags) else "trusted",
        # Carried through rather than dropped: a journal row that records its own
        # reuse count used to rank as if it had never been reused at all.
        "uses": _as_count(row.get("uses")),
    }


def _as_evidence(row: dict) -> dict | None:
    cmd = row.get("cmd", "")
    digest = row.get("digest", "")
    raw_id = row.get("id", "")
    if not isinstance(cmd, str):
        cmd = ""
    if not isinstance(digest, str):
        digest = ""
    if not isinstance(raw_id, str):
        raw_id = ""
    if cmd == "" and digest == "" and raw_id == "":
        return None
    exit_code = row.get("exit")
    if isinstance(exit_code, bool) or not isinstance(exit_code, int):
        exit_code = None
    ts = row.get("ts")
    return {
        "source": "evidence",
        "kind": "evidence",
        "text": "",
        "cmd": cmd,
        "digest": digest,
        "ts": ts if isinstance(ts, str) else "",
        "tags": [],
        "evidence_id": canonical_evidence_id(raw_id),
        "exit_code": exit_code,
        "provenance": "trusted",
    }


# Tools whose rows are shell runs; every other tool leaves a "reuse key" that
# points at the file or pattern it touched.
SHELL_TOOLS = frozenset(("bash", "guard_verify"))


def _file_rows(events: list[dict]) -> list[dict]:
    """Non-shell tool calls grouped by their reuse key, newest first.

    A read/edit/search call records the path or pattern it used, so "where did I
    read this before" is answerable from the ledger instead of re-derived. These
    are hints only: they carry no trust and never drive a loop streak.
    """
    grouped: dict[str, dict] = {}
    for row in events:
        if not isinstance(row, dict) or row.get("kind") != "tool_result":
            continue
        tool = row.get("tool")
        if not isinstance(tool, str) or not tool or tool in SHELL_TOOLS:
            continue
        key = row.get("cmd")
        if not isinstance(key, str) or not key.strip():
            continue
        digest = store.fingerprint(key)
        if not digest:
            continue
        seen = grouped.get(digest)
        if seen is None:
            grouped[digest] = {
                "source": "file",
                "kind": "file",
                "text": "",
                "cmd": key,
                "digest": "",
                "ts": row.get("ts") if isinstance(row.get("ts"), str) else "",
                "tags": [],
                "evidence_id": None,
                "exit_code": None,
                "provenance": "agent",
                "tool": tool,
                "uses": 1,
                "last_ok": None,
                "last_exit": None,
            }
            seen = grouped[digest]
        else:
            seen["uses"] = _as_count(seen.get("uses")) + 1
            seen["ts"] = row.get("ts") if isinstance(row.get("ts"), str) else seen["ts"]
            seen["cmd"] = key
            seen["tool"] = tool
        exit_code = row.get("exit")
        seen["last_ok"] = row.get("ok") if isinstance(row.get("ok"), bool) else None
        seen["last_exit"] = exit_code if isinstance(exit_code, int) and not isinstance(exit_code, bool) else None
    return list(grouped.values())


def _command_rows(events: list[dict]) -> list[dict]:
    """Successful bash calls grouped by fingerprint, newest first.

    Only ``tool_call`` rows with a command that was not refused (``ok`` not
    False) are reused: a blocked or declined attempt is not a proven recipe.
    """
    grouped: dict[str, dict] = {}
    # session -> recently issued, still unpaired calls as (tool, fingerprint).
    pending: dict[str, list[tuple[str, str]]] = {}
    for row in events:
        if not isinstance(row, dict):
            continue
        session = row.get("session")
        session_key = session if isinstance(session, str) else ""
        if row.get("kind") == "tool_result":
            stack = pending.get(session_key)
            if not stack:
                continue
            tool = row.get("tool")
            tool = tool if isinstance(tool, str) else ""
            result_cmd = row.get("cmd")
            result_key = store.fingerprint(result_cmd) if isinstance(result_cmd, str) and result_cmd.strip() else ""
            match: int | None = None
            if result_key:
                for index in range(len(stack) - 1, -1, -1):
                    if stack[index][1] == result_key:
                        match = index
                        break
            if match is None:
                # No command to correlate with: attach only when the tool
                # identifies exactly one outstanding call. With two overlapping
                # bash calls the pairing would be a guess, and a mislabelled
                # outcome is worse than no outcome.
                candidates = [i for i, (call_tool, _) in enumerate(stack) if not tool or call_tool == tool]
                if len(candidates) == 1:
                    match = candidates[0]
            if match is None:
                continue
            key = stack.pop(match)[1]
            if key in grouped:
                exit_code = row.get("exit")
                grouped[key]["last_ok"] = row.get("ok") if isinstance(row.get("ok"), bool) else None
                grouped[key]["last_exit"] = exit_code if isinstance(exit_code, int) and not isinstance(exit_code, bool) else None
            continue
        if row.get("kind") != "tool_call" or row.get("ok") is False:
            continue
        cmd = row.get("cmd")
        if not isinstance(cmd, str) or not cmd.strip():
            continue
        key = store.fingerprint(cmd)
        if not key:
            continue
        call_tool = row.get("tool")
        stack = pending.setdefault(session_key, [])
        stack.append((call_tool if isinstance(call_tool, str) else "", key))
        del stack[:-4]  # bounded: only the newest few calls can still be pending
        ts = row.get("ts")
        seen = grouped.get(key)
        if seen is None:
            grouped[key] = {
                "source": "command",
                "kind": "command",
                "text": "",
                "cmd": cmd,
                "digest": "",
                "ts": ts if isinstance(ts, str) else "",
                "tags": [],
                "evidence_id": None,
                "exit_code": None,
                "provenance": "agent",
                "uses": 1,
                "last_ok": None,
                "last_exit": None,
            }
            continue
        seen["uses"] += 1
        if isinstance(ts, str) and ts > seen["ts"]:
            seen["ts"] = ts
            seen["cmd"] = cmd
    return list(grouped.values())


def _canonical_keys(keywords: list[str]) -> list[str | None]:
    """Canonical ev-NNNN form of each keyword, computed once per query."""
    return [canonical_evidence_id(keyword) for keyword in keywords]


# Stem sets are pure functions of a field string, so they are memoised across
# rows and searches. The cap bounds a long-lived process; the retained window is
# far smaller than this, and clearing only costs one re-tokenise.
_STEM_CACHE_MAX = 4096
# LRU rather than "clear everything on overflow": a long session would
# otherwise re-tokenise the whole corpus every 4096 distinct strings.
_stem_cache: LRUCache = LRUCache(maxsize=_STEM_CACHE_MAX)


def _stems(text: str) -> frozenset[str]:
    cached = _stem_cache.get(text)
    if cached is None:
        cached = stemmer.stems(text)
        _stem_cache[text] = cached
    return cached


def term_hit(haystack: str, keyword: str, keyword_stem: str) -> bool:
    """True when ``keyword`` starts a word in ``haystack``, or shares its stem.

    The word-start rule alone made morphology one-way: a query for ``retrieving``
    found nothing in a row about ``retrieval``. Adding stem equality keeps the
    mid-word guard (``arch`` still misses ``search``) while joining inflections.
    """
    if word_hit(haystack, keyword):
        return True
    return keyword_stem != "" and keyword_stem in _stems(haystack)


def word_hit(haystack: str, keyword: str) -> bool:
    """True when ``keyword`` starts a word in ``haystack``.

    A plain substring test made "old" hit the tag "threshold" and "arch" hit
    "search", so a query could answer itself with the wrong entry. Matching only
    at a word start keeps the useful morphology ("patch" -> "patches") while
    dropping the mid-word noise.
    """
    if not keyword:
        return False
    haystack = haystack.casefold()
    start = 0
    while True:
        idx = haystack.find(keyword, start)
        if idx < 0:
            return False
        if idx == 0 or not haystack[idx - 1].isalnum():
            return True
        start = idx + 1


def _raw_hit(keyword: str, keyword_stem: str, canonical: str | None, row: dict) -> int:
    """Unweighted hit strength for one keyword against one row."""
    hit = 0
    if term_hit(row["text"], keyword, keyword_stem):
        hit += TEXT_WEIGHT
    if any(term_hit(tag, keyword, keyword_stem) for tag in row["tags"]):
        hit += TAG_WEIGHT
    if term_hit(row["cmd"], keyword, keyword_stem):
        hit += CMD_WEIGHT
    if term_hit(row["digest"], keyword, keyword_stem):
        hit += DIGEST_WEIGHT
    if canonical is not None and canonical == row["evidence_id"]:
        hit += ID_WEIGHT
    return hit


def _idf(df: int, total: int) -> int:
    """BM25 inverse document frequency in thousandths.

    ``ln(1 + (N - df + 0.5) / (df + 0.5))`` is the Lucene form: it is always
    non-negative, so a word present in every row ("owner") scores near zero
    instead of demanding an arbitrary clamp, and a word in one row of a hundred
    dominates the query. The old rule (``N/df`` clamped to [1x, 8x]) could not
    tell a word in 2 rows from a word in 12 — both hit the ceiling.

    Values are rounded to integer thousandths so the TypeScript mirror computes
    the same number: ``floor(x * 1000 + 0.5)`` is a rounding rule both runtimes
    share, unlike banker's rounding.
    """
    if df <= 0 or total <= 0:
        return 0
    value = math.log(1.0 + (total - df + 0.5) / (df + 0.5))
    return math.floor(value * 1000.0 + 0.5)


def _bm25_term(idf_milli: int, tf: int, length: int, average: int) -> int:
    """One BM25 term score, integer-only.

    ``idf * tf * (k1 + 1) / (tf + k1 * (1 - b + b * length / average))`` in
    thousandths. Saturation is what fixes the measured length bias: without a
    ``k1`` ceiling a 60-word filler row outranked a precise 5-word row because
    the old score was a plain sum of weights that never stopped growing.
    """
    if idf_milli <= 0 or tf <= 0 or average <= 0:
        return 0
    # (1 - b + b * length / average) in thousandths.
    norm = (1000 - B_MILLI) + (B_MILLI * length) // average
    denominator = tf * 1000 + (K1_MILLI * norm) // 1000
    if denominator <= 0:
        return 0
    return (idf_milli * tf * (1000 + K1_MILLI)) // denominator


def _uses_bonus(value: object) -> int:
    """Bounded reinforcement from how often a row was reused."""
    return min(_as_count(value), USES_BONUS_CAP) * USES_BONUS_STEP


def _doc_length(row: dict) -> int:
    """Searchable length of a row, for BM25's length normalisation."""
    total = stemmer.count_tokens(row["text"]) + stemmer.count_tokens(row["cmd"])
    total += stemmer.count_tokens(row["digest"])
    for tag in row["tags"]:
        total += stemmer.count_tokens(tag)
    return total


def _keyword_score(
    keywords: list[str],
    kw_stems: list[str],
    canon_ids: list[str | None],
    row: dict,
    idf: list[int],
    length: int,
    average: int,
    floor: int | None = None,
) -> int | None:
    """BM25 partial-match score, or None when the row is too weak.

    Every hit adds a saturated, length-normalised term score instead of casting
    an all-or-nothing vote, so a paraphrase still finds the entry that answers
    most of it. The floor keeps precision: a three-or-more-word query must share
    at least two words. ``floor`` overrides that rule for the widening pass, where
    a single shared term is all the query has left.
    """
    if not keywords:
        return 0
    score = 0
    hits = 0
    tag_hit = False
    for index, (keyword, canonical) in enumerate(zip(keywords, canon_ids, strict=True)):
        raw = _raw_hit(keyword, kw_stems[index], canonical, row)
        if not raw:
            continue
        hits += 1
        if any(term_hit(tag, keyword, kw_stems[index]) for tag in row["tags"]):
            tag_hit = True
        score += _bm25_term(idf[index], raw, length, average)
    if floor is None:
        floor = 1 if len(keywords) < _MULTI_MATCH_FROM else _MULTI_MATCH_FLOOR
    # A tag is a synonym the owner wrote on purpose, so one tag match is a
    # deliberate signal and beats the word-count floor that stops stray matches.
    if hits < floor and not tag_hit:
        return None
    return score


def _document_frequencies(
    keywords: list[str], kw_stems: list[str], canon_ids: list[str | None], corpus: list[dict]
) -> list[int]:
    """How many corpus rows each keyword reaches (the idf input)."""
    counts = [0] * len(keywords)
    for row in corpus:
        for index, (keyword, canonical) in enumerate(zip(keywords, canon_ids, strict=True)):
            if _raw_hit(keyword, kw_stems[index], canonical, row):
                counts[index] += 1
    return counts


def _cmd_bonus(cmd_query: str | None, row: dict) -> int | None:
    if cmd_query is None:
        return 0
    if row["source"] != "evidence":
        return None
    needle = store.fingerprint(cmd_query)
    if needle == "":
        return 0
    haystack = store.fingerprint(row["cmd"])
    if needle == haystack:
        return CMD_EXACT_WEIGHT
    if needle in haystack:
        return CMD_SUB_WEIGHT
    return None


def _matches_tags(requested: list[str], row: dict) -> bool:
    if not requested:
        return True
    if row["source"] != "journal":
        return False
    present = {_tag_key(tag) for tag in row["tags"]}
    present.discard("")
    return all(tag in present for tag in requested)


def _as_count(value: object) -> int:
    """Usage counter from a row: non-negative int, anything else zero."""
    if isinstance(value, bool) or not isinstance(value, int):
        return 0
    return max(0, value)


class Hit:
    """One ranked recall hit. Fields are display-ready and provenance-labelled."""

    def __init__(self, row: dict, strength: int, recency: int) -> None:
        self.kind: str = row["kind"]
        self.provenance: str = row["provenance"]
        self.ts: str = row["ts"]
        self.text: str = row["text"]
        self.tags: list[str] = _display_tags(row["tags"])
        self.evidence_id: str | None = row["evidence_id"]
        self.cmd: str = row["cmd"]
        self.exit_code: int | None = row["exit_code"]
        self.uses: int = _as_count(row.get("uses"))
        tool_value = row.get("tool")
        self.tool: str = tool_value if isinstance(tool_value, str) else ""
        self.last_ok: bool | None = row.get("last_ok") if isinstance(row.get("last_ok"), bool) else None
        self.last_exit: int | None = row.get("last_exit") if isinstance(row.get("last_exit"), int) and not isinstance(row.get("last_exit"), bool) else None
        self.strength: int = strength
        self.recency: int = recency

    def line(self, index: int) -> str:
        if self.kind == "command":
            uses = f" · ran {self.uses}×" if self.uses > 1 else ""
            outcome = ""
            if self.last_ok is True:
                exit_s = "" if self.last_exit is None else f" exit {self.last_exit}"
                outcome = f" · last ok{exit_s}"
            elif self.last_ok is False:
                exit_s = "" if self.last_exit is None else f" exit {self.last_exit}"
                outcome = f" · last FAILED{exit_s} — change it before reuse"
            cmd = store.display_text(self.cmd, 120) or "(no command)"
            return f"{index}. {self.provenance} · command · re-run to verify{uses}{outcome} · {cmd}"
        if self.kind == "file":
            uses = f" · used {self.uses}×" if self.uses > 1 else ""
            tool = store.display_text(self.tool or "tool", 24)
            key = store.display_text(self.cmd, 120) or "(no path)"
            outcome = " · last FAILED" if self.last_ok is False else ""
            return f"{index}. {self.provenance} · {tool} · reuse{uses}{outcome} · {key}"
        if self.kind == "evidence":
            evidence_id = store.display_text(self.evidence_id, 16) or "(no id)"
            exit_s = "" if self.exit_code is None else f" · exit {self.exit_code}"
            cmd = store.display_text(self.cmd, 80) or "(no command)"
            return f"{index}. {self.provenance} · evidence · {evidence_id}{exit_s} · {cmd}"
        ts = store.display_text(self.ts, 32) or "unknown-time"
        text = store.display_text(self.text, 160) or "(blank)"
        tag_s = f" [{','.join(self.tags)}]" if self.tags else ""
        return f"{index}. {self.provenance} · {self.kind} · {ts} · {text}{tag_s}"


class RecallResult:
    """Ranked hits plus the window size and whether the query was widened."""

    def __init__(
        self, hits: list[Hit], scanned: int, matched: int, widened: bool = False
    ) -> None:
        self.hits = hits
        self.scanned = scanned
        self.matched = matched
        # True when the strict pass matched nothing and the search relaxed to a
        # single shared term. The hits are then weaker evidence, so the caller is
        # told rather than left to assume precision it did not get.
        self.widened = widened


def search(
    query: object = "",
    *,
    type: object = None,
    tags: object = None,
    limit: object = LIMIT_DEFAULT,
    evidence_id: object = None,
    cmd: object = None,
    journal_rows: list[dict] | None = None,
    evidence_rows: list[dict] | None = None,
    event_rows: list[dict] | None = None,
    include_commands: bool = True,
) -> RecallResult:
    """Search the retained window. Reads the store unless rows are supplied.

    Does not create ``.agent-guard/``. Invalid type, evidence id, limit, or
    tag shapes raise ``ValueError`` before any ranking.
    """
    kind = _validate_type(type)
    wanted_id = _validate_evidence_id(evidence_id)
    bounded = bounded_limit(limit)
    keywords = _keywords(query)
    kw_stems = [stemmer.stem(keyword) for keyword in keywords]
    canon_ids = _canonical_keys(keywords)
    wanted_tags = _requested_tags(tags)
    cmd_filter = _blank_to_none(cmd)

    # Capture what the caller supplied BEFORE loading: after the two loads
    # below these variables are never None, which used to make `supplied`
    # always true and silently disable reuse from the events ledger on the
    # ordinary on-disk path (CLI and MCP).
    rows_supplied = journal_rows is not None or evidence_rows is not None
    if journal_rows is None:
        journal_rows = store.read_jsonl(store.journal_path())
    if evidence_rows is None:
        evidence_rows = store.read_jsonl(store.verify_path())

    corpus: list[dict] = []
    for row in journal_rows:
        if isinstance(row, dict):
            parsed = _as_journal(row)
            if parsed is not None:
                corpus.append(parsed)
    for row in evidence_rows:
        if isinstance(row, dict):
            parsed = _as_evidence(row)
            if parsed is not None:
                corpus.append(parsed)
    # Reuse beats rewriting: a query also reaches commands that already solved a
    # similar task. Skipped without a query (the plain recent window stays
    # ledger-shaped) and skipped when the same command is already evidence.
    if include_commands and (keywords or cmd_filter):
        if event_rows is None:
            event_rows = [] if rows_supplied else store.read_jsonl(store.events_path())
        known = {store.fingerprint(row["cmd"]) for row in corpus if row["cmd"]}
        for row in _command_rows(event_rows):
            if store.fingerprint(row["cmd"]) in known:
                continue
            corpus.append(row)
        for row in _file_rows(event_rows):
            if store.fingerprint(row["cmd"]) in known:
                continue
            known.add(store.fingerprint(row["cmd"]))
            corpus.append(row)

    idf = [
        _idf(df, len(corpus))
        for df in _document_frequencies(keywords, kw_stems, canon_ids, corpus)
    ]
    # BM25 normalises by how long a row is relative to the corpus average, so a
    # verbose row no longer wins just by holding more chances to match.
    lengths = [_doc_length(row) for row in corpus]
    average = max(1, sum(lengths) // len(lengths)) if lengths else 1

    def collect(floor: int | None) -> list[tuple[dict, int, int]]:
        found: list[tuple[dict, int, int]] = []
        for seq, row in enumerate(corpus):
            if kind is not None and row["kind"] != kind:
                continue
            if wanted_id is not None and row["evidence_id"] != wanted_id:
                continue
            if not _matches_tags(wanted_tags, row):
                continue
            bonus = _cmd_bonus(cmd_filter, row)
            if bonus is None:
                continue
            keyword_score = _keyword_score(
                keywords, kw_stems, canon_ids, row, idf, lengths[seq], average, floor
            )
            if keyword_score is None:
                continue
            if row["kind"] in ("command", "file"):
                keyword_score //= 2
                if row.get("last_ok") is False:
                    keyword_score //= 2
            found.append((row, keyword_score + bonus + _uses_bonus(row.get("uses")), seq))
        return found

    matched = collect(None)
    widened = False
    # The widening ladder: when a long query shares two words with nothing, one
    # shared term still deserves an answer. The strict pass ran first, so this
    # can only add rows to an empty list — precision where it exists, recall
    # where it does not.
    if not matched and len(keywords) >= _MULTI_MATCH_FROM:
        matched = collect(1)
        widened = bool(matched)

    matched.sort(key=lambda item: (item[0]["ts"], item[2]))
    ranked = [
        Hit(row, strength, recency)
        for recency, (row, strength, _seq) in enumerate(matched)
    ]
    ranked.sort(key=lambda hit: (hit.strength, hit.recency), reverse=True)
    # Collapse rewrites of one entry before the page is cut, so five restatements
    # of a decision cannot fill the answer. `matched` still counts every ranked
    # row; only the displayed page is deduped.
    page = dedup.suppress([hit.text or hit.cmd for hit in ranked], bounded) if bounded else []
    shown = [ranked[index] for index in page]
    return RecallResult(shown, scanned=len(corpus), matched=len(ranked), widened=widened)


def _nudge(hits: list[Hit], widened: bool = False) -> str:
    if not hits:
        return (
            "Nudge: nothing matched in the retained window — "
            "broaden the query or drop a filter."
        )
    prefix = ""
    if widened:
        prefix = "Widened: no entry shared two words, so these share one term. "
    if any(hit.provenance == "agent" for hit in hits):
        return (
            prefix
            + "Nudge: agent hits stay unverified — confirm them before acting; "
            "cite evidence ids."
        )
    return prefix + "Nudge: cite evidence ids and re-read trusted hits before acting on them."


def render(result: RecallResult) -> str:
    """Compact hit list. The last line is always a Nudge."""
    if result.matched > len(result.hits):
        header = (
            f"PC recall · {len(result.hits)} of {result.matched} hits · "
            f"scanned {result.scanned}"
        )
    else:
        header = f"PC recall · {len(result.hits)} hits · scanned {result.scanned}"
    lines = [header]
    for index, hit in enumerate(result.hits, start=1):
        lines.append(hit.line(index))
    lines.append(_nudge(result.hits, result.widened))
    return "\n".join(lines)
