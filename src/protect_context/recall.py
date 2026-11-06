"""Local recall over the retained journal and evidence window.

Readers use ``store.read_jsonl``, so the live ledger plus up to three rotated
segments are concatenated oldest-first — the same window every other reader
sees (SPEC §2). Segments already dropped by rotation are not searched.

No embeddings, no network, and no extra index. Filters combine with AND.
Keywords are AND across the query and OR across ``text``, ``cmd``, and
``digest``; a keyword that is itself an evidence id (``ev-NNNN``) also matches
that id. Tags are exact, case-insensitive, and AND: every requested tag must
be present. Evidence rows have no tags, so a tag filter excludes them.

Ranking is match strength, then recency. Recency is the stored timestamp
string (writers use ISO-8601, newest last), with read order as a tiebreak.
Journal hits tagged ``agent`` stay unverified; every other journal hit and
every evidence row is trusted.

Keep the weights and filter rules aligned with ``extension/lib/recall.ts``.
"""

from __future__ import annotations

import math
import re

from . import store

RECALL_TYPES = ("decision", "correction", "risk", "note", "evidence")
LIMIT_DEFAULT = 5
LIMIT_MAX = 20
MAX_KEYWORDS = 12
QUERY_CAP = 500

TEXT_WEIGHT = 3
CMD_WEIGHT = 2
DIGEST_WEIGHT = 1
ID_WEIGHT = 4
CMD_EXACT_WEIGHT = 4
CMD_SUB_WEIGHT = 1

_EV_ID = re.compile(r"ev-(\d+)$", re.IGNORECASE)
_AGENT_TAG = "agent"


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
    number = int(digits)
    if number < 1:
        return None
    return f"ev-{number:04d}"


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
        if not part or part in seen:
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
    return any(store.display_text(tag, 40) == _AGENT_TAG for tag in tags)


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


def _keyword_score(keywords: list[str], row: dict) -> int | None:
    if not keywords:
        return 0
    text = row["text"].casefold()
    cmd = row["cmd"].casefold()
    digest = row["digest"].casefold()
    evidence_id = row["evidence_id"]
    score = 0
    for keyword in keywords:
        hit = 0
        if keyword in text:
            hit += TEXT_WEIGHT
        if keyword in cmd:
            hit += CMD_WEIGHT
        if keyword in digest:
            hit += DIGEST_WEIGHT
        canonical = canonical_evidence_id(keyword)
        if canonical is not None and canonical == evidence_id:
            hit += ID_WEIGHT
        if hit == 0:
            return None
        score += hit
    return score


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
        self.strength: int = strength
        self.recency: int = recency

    def line(self, index: int) -> str:
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
    def __init__(self, hits: list[Hit], scanned: int, matched: int) -> None:
        self.hits = hits
        self.scanned = scanned
        self.matched = matched


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
) -> RecallResult:
    """Search the retained window. Reads the store unless rows are supplied.

    Does not create ``.agent-guard/``. Invalid type, evidence id, limit, or
    tag shapes raise ``ValueError`` before any ranking.
    """
    kind = _validate_type(type)
    wanted_id = _validate_evidence_id(evidence_id)
    bounded = bounded_limit(limit)
    keywords = _keywords(query)
    wanted_tags = _requested_tags(tags)
    cmd_filter = _blank_to_none(cmd)

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

    matched: list[tuple[dict, int, int]] = []
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
        keyword_score = _keyword_score(keywords, row)
        if keyword_score is None:
            continue
        matched.append((row, keyword_score + bonus, seq))

    matched.sort(key=lambda item: (item[0]["ts"], item[2]))
    ranked = [
        Hit(row, strength, recency)
        for recency, (row, strength, _seq) in enumerate(matched)
    ]
    ranked.sort(key=lambda hit: (hit.strength, hit.recency), reverse=True)
    shown = ranked[:bounded] if bounded else []
    return RecallResult(shown, scanned=len(corpus), matched=len(ranked))


def _nudge(hits: list[Hit]) -> str:
    if not hits:
        return (
            "Nudge: nothing matched in the retained window — "
            "broaden the query or drop a filter."
        )
    if any(hit.provenance == "agent" for hit in hits):
        return (
            "Nudge: agent hits stay unverified — confirm them before acting; "
            "cite evidence ids."
        )
    return "Nudge: cite evidence ids and re-read trusted hits before acting on them."


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
    lines.append(_nudge(result.hits))
    return "\n".join(lines)
