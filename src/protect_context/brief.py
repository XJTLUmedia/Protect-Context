"""Compact pre-agent brief (SPEC §5) — Python parity with the pi extension.

The brief used to exist only in ``extension/lib/brief.ts``, so the CLI and the
MCP server could record owner intent that nothing ever re-injected: the store
was shared, the reader was not. Both runtimes now compose the same brief from
the same store, and ``tests/test_brief.py`` renders both from one fixture so a
divergence fails the suite instead of reaching a session.

Pure logic — no MCP, CLI or terminal imports — so the MCP tool, the CLI verb and
the tests all build through the same functions.
"""

from __future__ import annotations

import os
import re
import subprocess
import unicodedata

from . import contract as contract_mod
from . import journal as journal_mod
from . import loops as loops_mod
from . import store
from . import verify as verify_mod

# Budgets are additive, exactly as in brief.ts: owner rows can never evict a
# seed and a seed can never evict an owner row.
BRIEF_MAX_CONTRACT_LINES = contract_mod.BRIEF_MAX_CONTRACT_LINES
BRIEF_MAX_OWNER_CONSTRAINT_LINES = contract_mod.BRIEF_MAX_OWNER_CONSTRAINT_LINES
BRIEF_MAX_DECISIONS = 3
BRIEF_MAX_CORRECTIONS = 3
BRIEF_MAX_UNVERIFIED_CORRECTIONS = 2
BRIEF_MAX_AGENT_NOTES = 2
BRIEF_MAX_LOOPS = 2
# Correction checks (2026-11-11 amendment): how many run per brief, and the
# default deadline when the config does not carry one.
BRIEF_MAX_CHECKS = 3
CHECK_TIMEOUT_DEFAULT_S = 5
BRIEF_MAX_RECALL = 2
BRIEF_MAX_INTENT = 2
BRIEF_MAX_PRECEDENTS = 3
TASK_DISPLAY_MAX = 400
AGENT_NOTE_DISPLAY_MAX = 120
OWNER_INTENT_DISPLAY_MAX = 200
CMD_DISPLAY_MAX = 60
TAG_TEXT_CAP = 40
TAG_COUNT_CAP = 8
ID_DISPLAY_MAX = 80

_CONTROL_CATEGORIES = frozenset(("Cc", "Cf", "Cs"))
_RECALL_STOPWORDS = frozenset(
    (
        "the", "and", "for", "with", "from", "that", "this", "into", "over",
        "when", "than", "your", "have", "will", "just", "about", "only", "also",
        "not", "are", "was", "were", "but", "you", "our", "can", "all", "any",
    )
)


def _codepoints(text: str) -> list[str]:
    # Python strings are already code-point sequences; measuring in characters
    # (not bytes) keeps parity with Array.from(...) on the TS side.
    return list(text)


def trunc(value: str, max_chars: int = 200) -> str:
    """Cut to ``max_chars`` with a trailing ellipsis when longer."""
    if max_chars <= 0:
        return ""
    chars = _codepoints(value)
    if len(chars) <= max_chars:
        return value
    return f"{''.join(chars[: max(0, max_chars - 1)])}…"


def normalise_one_line(value: object, max_chars: int) -> str:
    """One printable, bounded line: control/format/surrogate code points become
    spaces *before* whitespace collapses, so they cannot forge a brief line."""
    raw = str(value if value is not None else "")
    printable = "".join(
        " " if unicodedata.category(ch) in _CONTROL_CATEGORIES else ch for ch in raw
    )
    collapsed = re.sub(r"\s+", " ", printable).strip()
    return "".join(_codepoints(collapsed)[: max(0, max_chars)]).strip()


def trunc_line(value: object, max_chars: int = 200) -> str:
    """Normalise with head-room, then apply the display ellipsis."""
    pre_cap = max(max_chars + 1, 10_000)
    return trunc(normalise_one_line(value, pre_cap), max_chars)


def _tag_candidates(tags: object) -> list[str]:
    if isinstance(tags, str):
        return [tags]
    if isinstance(tags, (list, tuple)):
        return [tag for tag in tags if isinstance(tag, str)]
    return []


def has_agent_tag(tags: object) -> bool:
    """True when the row carries the reserved ``agent`` provenance tag."""
    return any(
        normalise_one_line(tag, TAG_TEXT_CAP).casefold() == "agent"
        for tag in _tag_candidates(tags)
    )


def sanitize_tags(tags: object) -> list[str]:
    """Clean, deduplicate and bound tags before they reach a brief line."""
    clean: list[str] = []
    seen: set[str] = set()
    for tag in _tag_candidates(tags):
        value = normalise_one_line(tag, TAG_TEXT_CAP)
        if value and value not in seen:
            clean.append(value)
            seen.add(value)
        if len(clean) >= TAG_COUNT_CAP:
            break
    return clean


def _is_owner_row(row: dict) -> bool:
    return row.get("source") in contract_mod.OWNER_SOURCES


def select_brief_constraints(rows: list[dict]) -> list[dict]:
    """Owner rows up to their own budget, then seed/other rows up to theirs.

    Authority outranks append order: newest owner rows win their budget, and the
    two budgets are separate so neither class can starve the other.
    """
    indexed = list(enumerate(rows))
    owners = [(i, r) for i, r in indexed if _is_owner_row(r)]
    owners.sort(key=lambda pair: (str(pair[1].get("added") or ""), pair[0]), reverse=True)
    seeds = [r for _i, r in indexed if r.get("source") == "seed"]
    others = [r for _i, r in indexed if r.get("source") != "seed" and not _is_owner_row(r)]
    return [
        *[r for _i, r in owners[:BRIEF_MAX_OWNER_CONSTRAINT_LINES]],
        *[*seeds, *others][:BRIEF_MAX_CONTRACT_LINES],
    ]


def contract_overflow(rows: list[dict]) -> dict[str, int]:
    """How many rows each budget drops (parity with ``contractOverflow``)."""
    owners = sum(1 for row in rows if _is_owner_row(row))
    hidden_owners = max(0, owners - BRIEF_MAX_OWNER_CONSTRAINT_LINES)
    hidden_others = max(0, len(rows) - owners - BRIEF_MAX_CONTRACT_LINES)
    return {
        "hidden": hidden_owners + hidden_others,
        "hidden_owners": hidden_owners,
        "hidden_others": hidden_others,
    }


def clamp_precedents_cap(value: object) -> int:
    """Config-supplied precedent cap, clamped to the 0-10 range of config.json."""
    if isinstance(value, bool) or not isinstance(value, int):
        return BRIEF_MAX_PRECEDENTS
    return max(0, min(value, 10))


def task_recall_keywords(task: str) -> list[str]:
    """Task tokens that may match a journal tag (short/function words dropped)."""
    found: list[str] = []
    for token in re.split(r"[^a-z0-9]+", normalise_one_line(task, 2000).lower()):
        if len(token) < 3 or token in _RECALL_STOPWORDS or token in found:
            continue
        found.append(token)
        if len(found) >= 12:
            break
    return found


def rank_precedents(task: str, entries: list[dict]) -> list[dict]:
    """Order precedents by how much of the owner task they answer, then recency."""
    keywords = task_recall_keywords(task)
    if not keywords or len(entries) < 2:
        return entries
    scored = []
    for index, entry in enumerate(entries):
        haystack = " ".join(
            [normalise_one_line(entry.get("text"), 10_000), *_tag_candidates(entry.get("tags"))]
        ).lower()
        scored.append((sum(1 for keyword in keywords if keyword in haystack), index, entry))
    scored.sort(key=lambda item: (-item[0], item[1]))
    return [entry for _score, _index, entry in scored]


def visible_journal_text(
    precedents: list[dict], decisions: list[dict], corrections: list[dict]
) -> set[str]:
    """Journal text already shown above, so a row is never printed twice."""
    visible: set[str] = set()
    for entry in [
        *precedents,
        *decisions[:BRIEF_MAX_DECISIONS],
        *corrections[:BRIEF_MAX_CORRECTIONS],
    ]:
        full = normalise_one_line(entry.get("text"), 10_000)
        if full:
            visible.add(full)
    return visible


def select_task_recall(task: str, pool: list[dict], visible: set[str]) -> list[dict]:
    """Newest trusted rows whose tags match the task and are not already shown."""
    keywords = set(task_recall_keywords(task))
    if not keywords or not pool:
        return []
    task_fold = normalise_one_line(task, 2000).lower()
    hits: list[dict] = []
    for entry in pool:
        tags = [tag.lower() for tag in sanitize_tags(entry.get("tags"))]
        if "agent" in tags:
            continue
        matched = any(
            tag in keywords or (" " in tag and tag in task_fold) for tag in tags
        )
        if not matched:
            continue
        full = normalise_one_line(entry.get("text"), 10_000)
        if not full or full in visible:
            continue
        hits.append(entry)
        if len(hits) >= BRIEF_MAX_RECALL:
            break
    return hits


def _append_journal_section(
    lines: list[str],
    heading: str,
    entries: list[dict],
    cap: int,
    text_max: int = 200,
) -> tuple[int, bool]:
    """Render one section within its cap and report what the cap dropped."""
    if not entries:
        return 0, False
    if cap <= 0:
        return len(entries), False
    lines.append(heading)
    truncated = False
    for entry in entries[:cap]:
        full = normalise_one_line(entry.get("text"), 10_000)
        shown = trunc(full, text_max)
        if shown != full:
            truncated = True
        tags = sanitize_tags(entry.get("tags"))
        tag_s = f" [{','.join(tags)}]" if tags else ""
        lines.append(f"- {shown}{tag_s}")
    return max(0, len(entries) - cap), truncated


def build_brief(data: dict) -> str:
    """Render the compact brief from already-classified input.

    Mirrors ``buildBrief`` in brief.ts section for section: anything a cap drops
    is announced with the read path instead of vanishing silently.
    """
    lines: list[str] = []

    task = trunc_line(data.get("task") or "", TASK_DISPLAY_MAX)
    if task:
        lines.append(f"task: {task}")

    contract_rows = data.get("contract") or []
    contract_lines = select_brief_constraints(contract_rows)
    if contract_lines:
        lines.append("contract:")
        for row in contract_lines:
            source = trunc_line(row.get("source"), 40)
            src = f" [{source}]" if source and source != "seed" else ""
            cid = trunc_line(row.get("id"), ID_DISPLAY_MAX) or "(missing-id)"
            lines.append(f"{cid}{src}: {trunc_line(row.get('text'))}")
        hidden = contract_overflow(contract_rows)["hidden"]
        if hidden > 0:
            lines.append(f"+{hidden} more constraints hidden — run /guard-contract list")

    ranked_precedents = rank_precedents(
        data.get("task") or "", data.get("precedents") or []
    )
    precedents_shown = ranked_precedents[: clamp_precedents_cap(data.get("precedents_cap"))]
    already_visible = visible_journal_text(
        precedents_shown, data.get("decisions") or [], data.get("corrections") or []
    )
    intents_filtered = [
        entry
        for entry in (data.get("owner_intent") or [])
        if normalise_one_line(entry.get("text"), 10_000) not in already_visible
    ]
    intents = [
        *[entry for entry in intents_filtered if not has_agent_tag(entry.get("tags"))],
        *[entry for entry in intents_filtered if has_agent_tag(entry.get("tags"))],
    ]
    intent_truncated = False
    if intents:
        lines.append("owner intent:")
        for entry in intents[:BRIEF_MAX_INTENT]:
            full = normalise_one_line(entry.get("text"), 10_000)
            shown = trunc(full, OWNER_INTENT_DISPLAY_MAX)
            if shown != full:
                intent_truncated = True
            unverified = " (unverified)" if has_agent_tag(entry.get("tags")) else ""
            lines.append(f"- {shown}{unverified}")
        more = len(intents) - min(len(intents), BRIEF_MAX_INTENT)
        if more > 0:
            lines.append(f"+{more} more owner statements — guard_intent lists them")

    sections = [
        _append_journal_section(
            lines,
            "precedents:",
            ranked_precedents,
            clamp_precedents_cap(data.get("precedents_cap")),
        ),
        _append_journal_section(
            lines, "decisions:", data.get("decisions") or [], BRIEF_MAX_DECISIONS
        ),
        _append_journal_section(
            lines, "corrections:", data.get("corrections") or [], BRIEF_MAX_CORRECTIONS
        ),
        _append_journal_section(
            lines,
            "corrections (unverified):",
            data.get("unverified_corrections") or [],
            BRIEF_MAX_UNVERIFIED_CORRECTIONS,
            AGENT_NOTE_DISPLAY_MAX,
        ),
        _append_journal_section(
            lines,
            "agent notes (unverified):",
            data.get("agent_notes") or [],
            BRIEF_MAX_AGENT_NOTES,
            AGENT_NOTE_DISPLAY_MAX,
        ),
    ]
    hidden_entries = sum(hidden for hidden, _truncated in sections)
    truncated_entries = any(truncated for _hidden, truncated in sections) or intent_truncated

    recalled = select_task_recall(
        data.get("task") or "",
        data.get("recall_pool") or [],
        visible_journal_text(
            precedents_shown, data.get("decisions") or [], data.get("corrections") or []
        ),
    )
    if recalled:
        lines.append("recall:")
        for entry in recalled:
            full = normalise_one_line(entry.get("text"), 10_000)
            shown = trunc(full, AGENT_NOTE_DISPLAY_MAX)
            if shown != full:
                truncated_entries = True
            tags = sanitize_tags(entry.get("tags"))
            tag_s = f" [{','.join(tags)}]" if tags else ""
            kind = trunc_line(entry.get("type"), 16) or "entry"
            lines.append(f"- {kind}: {shown}{tag_s}")

    checks = data.get("checks") or []
    if checks:
        lines.append("checks:")
        for check in checks[:BRIEF_MAX_CHECKS]:
            lines.append(
                f"- {trunc_line(check.get('id'), 40) or '(no id)'}: "
                f"{trunc_line(check.get('status'), 16)} · "
                f"{trunc_line(check.get('cmd'), CMD_DISPLAY_MAX)}"
            )
    elif data.get("checks_disabled"):
        # Silent disabling would make an unproved correction look checked.
        lines.append("checks: not run (brief_checks=false) — commands are in guard_journal")

    loops = data.get("loops") or []
    if loops:
        lines.append("loops:")
        for loop in loops[:BRIEF_MAX_LOOPS]:
            lines.append(f"- '{trunc_line(loop.get('cmd'), CMD_DISPLAY_MAX)}' failed {loop.get('failures')}x")

    evidence = data.get("last_evidence")
    if evidence:
        ms = evidence.get("ms")
        suffix = "" if ms is None else f" {float(ms) / 1000:.1f}s"
        lines.append(
            f"last verify: {trunc_line(evidence.get('id'), 40)} exit={evidence.get('exit')} "
            f"{evidence.get('label')} '{trunc_line(evidence.get('cmd'), CMD_DISPLAY_MAX)}'{suffix}"
        )

    if hidden_entries > 0:
        lines.append(
            f"+{hidden_entries} more journal entries — guard_journal reads them; "
            "guard_recall searches the retained window"
        )
    if truncated_entries:
        lines.append("journal text truncated — guard_journal shows the full entry")

    return "\n".join(lines)


def _journal_entries() -> list[dict]:
    return [
        entry
        for entry in store.read_jsonl(store.journal_path())
        if isinstance(entry, dict)
    ]


def _trusted(entries_newest: list[dict], jtype: str) -> list[dict]:
    return [
        entry
        for entry in entries_newest
        if entry.get("type") == jtype and not journal_mod._is_agent_entry(entry)
    ]


def _agent_entries(entries_newest: list[dict]) -> list[dict]:
    # `risk` rows are telemetry, not memory: they never reach the brief.
    return [
        entry
        for entry in entries_newest
        if entry.get("type") != "risk" and journal_mod._is_agent_entry(entry)
    ]


def brief_inputs(cfg: dict | None = None) -> dict:
    """Assemble ``build_brief`` input from the store (parity with composeBrief)."""
    # Read-only surface: never seed the store just to render a brief.
    cfg = store.load_config(create=False) if cfg is None else cfg
    state = store.read_json(store.state_path())
    task_value = state.get("task") if isinstance(state, dict) else None
    task = task_value.get("text") if isinstance(task_value, dict) else None

    entries = _journal_entries()
    newest = list(reversed(entries))
    agent_entries = _agent_entries(newest)

    streak_list = loops_mod.streaks()
    blocking = loops_mod.would_block(streak_list, cfg)
    blocking.sort(key=lambda s: (-s["count"], s["cmd"]))
    brief_loops = [
        {"cmd": s["cmd"], "failures": s["count"]} for s in blocking[:BRIEF_MAX_LOOPS]
    ]

    runs = [r for r in store.read_jsonl(store.verify_path()) if isinstance(r, dict)]
    last = runs[-1] if runs else None
    last_evidence = (
        {
            "id": last.get("id"),
            "exit": last.get("exit"),
            "cmd": last.get("cmd"),
            "ms": last.get("ms"),
            "label": verify_mod.outcome_label(last),
        }
        if last
        else None
    )

    return {
        "task": task,
        "contract": contract_mod.load_readonly(),
        "precedents": [
            entry
            for entry in newest
            if "lesson" in set(journal_mod._normalise_tags(entry.get("tags")))
        ],
        "precedents_cap": cfg.get("brief_max_precedents", BRIEF_MAX_PRECEDENTS),
        "decisions": _trusted(newest, "decision"),
        "corrections": _trusted(newest, "correction"),
        "unverified_corrections": [
            entry for entry in agent_entries if entry.get("type") == "correction"
        ],
        "agent_notes": [entry for entry in agent_entries if entry.get("type") != "correction"],
        # Trusted non-agent history, newest first: the tag-matched recall pool.
        "recall_pool": [
            entry
            for entry in newest
            if entry.get("type") in ("decision", "correction", "note")
            and not journal_mod._is_agent_entry(entry)
        ],
        "owner_intent": [entry for entry, _kinds in reversed(journal_mod.intent_classified(entries))],
        "loops": brief_loops,
        "last_evidence": last_evidence,
        "checks": collect_checks(entries, cfg),
        # A cap of 0 disables execution too: the brief must not imply a check
        # ran when the budget forbade it.
        "checks_disabled": not bool(cfg.get("brief_checks", True))
        or _bounded_int(cfg.get("brief_check_max"), BRIEF_MAX_CHECKS, 0, 20) == 0,
    }


def collect_checks(entries: list[dict], cfg: dict) -> list[dict]:
    """Run the commands that prove recent corrections still hold.

    A correction may carry ``check`` (``guard_note correction … --check CMD``).
    This is the one place protect-context executes store content, so the rules
    are deliberately narrow: only ``correction`` rows, newest first, at most
    ``brief_check_max``, each killed at ``brief_check_timeout_s``, output
    discarded (a proving command answers with its exit code, not its log), and
    ``brief_checks = false`` turns execution off while still printing the
    command. Returns ``[]`` when the owner disabled checks.
    """
    if not cfg.get("brief_checks", True):
        return []
    limit = _bounded_int(cfg.get("brief_check_max"), BRIEF_MAX_CHECKS, 0, 20)
    if limit == 0:
        return []
    timeout = _bounded_int(cfg.get("brief_check_timeout_s"), CHECK_TIMEOUT_DEFAULT_S, 1, 30)
    checks: list[dict] = []
    for entry in reversed(entries):
        if len(checks) >= limit:
            break
        if entry.get("type") != "correction":
            continue
        command = entry.get("check")
        if not isinstance(command, str) or not command:
            continue
        checks.append(
            {
                "id": trunc_line(entry.get("id"), 40) or "(no id)",
                "cmd": trunc_line(command, CMD_DISPLAY_MAX),
                "status": _run_check(command, timeout),
            }
        )
    return checks


def _bounded_int(value: object, default: int, low: int, high: int) -> int:
    if not isinstance(value, int) or isinstance(value, bool):
        return default
    return max(low, min(value, high))


def _run_check(command: str, timeout_s: int) -> str:
    """HONORED / VIOLATED / TIMEOUT / ERROR — never raises, never blocks long."""
    try:
        # shell=True is BY DESIGN, exactly as in verify.py (SPEC §4): a check is
        # a shell command the owner wrote (pipes, env prefixes, builtins) and it
        # runs with the caller's own privileges. This is not a sandbox; the
        # mitigating controls are the explicit --check flag, the correction-only
        # rule, the cap, the timeout and the opt-out — not argument escaping.
        # pi-lens-ignore: python-command-injection
        completed = subprocess.run(  # noqa: S602
            command,
            shell=True,
            cwd=os.getcwd(),
            stdin=subprocess.DEVNULL,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            timeout=timeout_s,
        )
    except subprocess.TimeoutExpired:
        return "TIMEOUT"
    except (OSError, ValueError):
        return "ERROR"
    return "HONORED" if completed.returncode == 0 else "VIOLATED"


def compose_brief(cfg: dict | None = None) -> str:
    """Render the brief for this project from the shared store."""
    return build_brief(brief_inputs(cfg))


def render(brief: str, limit: int = 20) -> str:
    """Bounded view for the CLI/MCP surfaces: the brief plus a fix-it nudge."""
    lines = brief.splitlines() if brief else []
    shown = lines[: max(1, limit)]
    out = list(shown)
    if len(lines) > len(shown):
        out.append(f"+{len(lines) - len(shown)} more brief lines — raise the limit")
    out.append(
        "Nudge: honor the brief; guard_journal, guard_recall and guard_contract read the rest."
    )
    return "\n".join(out)
