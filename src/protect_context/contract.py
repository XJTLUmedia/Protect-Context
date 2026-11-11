"""Contract store CRUD: .agent-guard/contract.json (SPEC §1 #1, §6).

Seeded from DEFAULT_CONTRACT on first use; user-added constraints get
sequential ids (13-, 14-, ...) with a slug derived from the text.
"""

from __future__ import annotations

import re
import unicodedata

from . import layers, store
from .defaults import DEFAULT_CONTRACT

MAX_SLUG = 40
# A slug below this carries no meaning on its own ("sql"), so text the ASCII
# rule can barely describe falls back to its own characters.
MIN_SLUG = 4
MAX_CJK_SLUG = 8
_CJK_RUN = re.compile(r"[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]+")
MAX_TEXT = 500  # free-text cap (parity with the extension): briefs re-inject it
# SPEC §5: the extension's re-injected brief carries at most 12 seed/other
# contract lines, plus at most 6 owner/user lines on their own additive budget.
# The split exists because one shared cap let five owner rules evict seeds
# 08-12 from every brief; neither class may now starve the other. Surfaces that
# exceed a budget must disclose which class is not re-injected.
BRIEF_MAX_CONTRACT_LINES = 12
BRIEF_MAX_OWNER_CONSTRAINT_LINES = 6
OWNER_SOURCES = frozenset(("owner", "user"))
RENDER_ID_MAX = 80
RENDER_MAX_CONSTRAINTS = 24

_CONTROL_CATEGORIES = {"Cc", "Cf", "Cs"}


class ContractIntegrityError(ValueError):
    """Raised when mutating would overwrite unreadable owner contract data."""


class SeedConstraintRemovalError(ValueError):
    """Raised when an agent surface attempts to remove a frozen seed."""


def _normalise_text(value: object, cap: int) -> str:
    """Return bounded single-line text safe for storage and rendering."""
    raw = str(value or "")
    without_controls = "".join(
        " " if unicodedata.category(char) in _CONTROL_CATEGORIES else char
        for char in raw
    )
    return " ".join(without_controls.split())[:cap].strip()


def brief_cap_warning(constraints: list[dict]) -> str:
    """Warning line for constraints the brief cannot re-inject (empty string
    when every row fits its budget).

    Mirrors the extension's ``contractOverflow``: owner/user rows have their own
    additive budget, so the warning names the class that actually overflowed
    instead of implying a single 12-line cap.
    """
    owners = sum(1 for c in constraints if c.get("source") in OWNER_SOURCES)
    hidden_owners = max(0, owners - BRIEF_MAX_OWNER_CONSTRAINT_LINES)
    hidden_others = max(0, len(constraints) - owners - BRIEF_MAX_CONTRACT_LINES)
    if hidden_owners == 0 and hidden_others == 0:
        return ""
    return (
        f"warning: {len(constraints)} constraints exceed the brief budget — "
        f"{hidden_owners} owner and {hidden_others} seed/other are not re-injected "
        f"({BRIEF_MAX_OWNER_CONSTRAINT_LINES} owner + {BRIEF_MAX_CONTRACT_LINES} "
        "seed/other lines); review the complete contract explicitly."
    )


def _row_key(row: dict) -> str:
    return _normalise_text(row.get("id"), RENDER_ID_MAX)


def _row_signature(row: dict) -> str:
    return _normalise_text(row.get("text"), MAX_TEXT)


def _user_rows() -> list[dict]:
    """Read the personal layer, best-effort.

    The personal layer is owner-only surface: a missing file means "no personal
    constraints" (never seeded), and an unreadable one is ignored in memory
    rather than repaired, so a transient error can never rewrite the owner's
    file.
    """
    data = store.read_json(layers.user_contract_path())
    if not isinstance(data, dict) or not isinstance(data.get("constraints"), list):
        return []
    return [
        dict(c)
        for c in data["constraints"]
        if isinstance(c, dict)
        and all(isinstance(c.get(k), str) for k in ("id", "text", "added", "source"))
    ]


def merged(project: list[dict]) -> list[dict]:
    """Project rows first, then personal rows the project does not already
    carry (same id or identical text). SPEC §2: the project overrides the
    personal layer."""
    return layers.merge_unique(
        (project, _user_rows()), key=_row_key, signature=_row_signature
    )


def user_constraint_count() -> int:
    """Constraints the personal layer contributes to the merged view."""
    return len(_user_rows())


def _project_unlocked() -> list[dict]:
    """Load the project rows, seeding contract.json from DEFAULT_CONTRACT if
    the file is missing. A corrupt file falls back to in-memory defaults."""
    p = store.contract_path()
    if not p.exists():
        data = [dict(c) for c in DEFAULT_CONTRACT]
        store.ensure()
        store.write_json(p, {"version": 1, "constraints": data})
        return data
    data = store.read_json(p)
    if not isinstance(data, dict) or not isinstance(data.get("constraints"), list):
        return [dict(c) for c in DEFAULT_CONTRACT]
    raw = data["constraints"]
    required = ("id", "text", "added", "source")
    valid = [
        dict(c)
        for c in raw
        if isinstance(c, dict)
        and all(isinstance(c.get(key), str) for key in required)
    ]
    # An explicitly empty list is a valid owner choice. A non-empty list made
    # entirely of malformed rows is corruption, so fail back to the frozen
    # seeds instead of silently disabling every guardrail.
    if raw and not valid:
        return [dict(c) for c in DEFAULT_CONTRACT]
    return valid


def _load_unlocked() -> list[dict]:
    """Effective contract: project rows plus the personal layer (SPEC §2)."""
    return merged(_project_unlocked())


def _load_for_mutation_unlocked() -> list[dict]:
    """Load only a fully valid contract for read-modify-write operations.

    Read surfaces may conservatively filter/fall back around damaged legacy
    rows. A mutation is different: saving that filtered view would silently
    erase the owner's unreadable data, so it must fail closed instead.
    """
    p = store.contract_path()
    if not p.exists():
        return _project_unlocked()
    data = store.read_json(p)
    if not isinstance(data, dict) or not isinstance(data.get("constraints"), list):
        raise ContractIntegrityError(
            "contract file is malformed; repair .agent-guard/contract.json before mutating it"
        )
    raw = data["constraints"]
    required = ("id", "text", "added", "source")
    if any(
        not isinstance(row, dict)
        or not all(isinstance(row.get(key), str) for key in required)
        for row in raw
    ):
        raise ContractIntegrityError(
            "contract contains malformed rows; repair .agent-guard/contract.json before mutating it"
        )
    return [dict(row) for row in raw]


def load_readonly() -> list[dict]:
    """Effective contract for a read surface: never seeds and never repairs.

    ``load()`` seeds a missing store, which is right for an initialising surface
    and wrong for a tool annotated read-only: ``guard_brief`` must not create
    ``.agent-guard/`` behind the caller's back (SPEC §7).
    """
    return merged(_project_rows_readonly())


def load() -> list[dict]:
    """Load the current contract.

    The shared lock also serializes first-load seeding. Mutating callers use
    ``_load_unlocked`` while already holding the lease, keeping each complete
    read-modify-write cycle inside one critical section.
    """
    with store.store_lock():
        return _load_unlocked()


def _save_unlocked(constraints: list[dict]) -> None:
    store.ensure()
    store.write_json(store.contract_path(), {"version": 1, "constraints": constraints})


def save(constraints: list[dict]) -> None:
    """Replace the contract while holding the shared cross-runtime lock."""
    with store.store_lock():
        _save_unlocked(constraints)


def _num(cid: str) -> int:
    m = re.match(r"(\d+)", str(cid))
    return int(m.group(1)) if m else 0


def _slug(text: str) -> str:
    """A readable id fragment: ASCII words when they describe the text, the
    text's own characters when they cannot.

    Non-Latin text used to keep only its ASCII remnant — 永远不要在生产库执行破坏性
    SQL became ``14-sql`` — so two 中文 constraints were indistinguishable in a
    brief and the id said nothing about the rule (measured 2026-11-11). English
    text keeps the exact ids it had.
    """
    words = re.findall(r"[a-z0-9]+", text.lower())[:4]
    ascii_slug = ("-".join(words)[:MAX_SLUG]).strip("-")
    cjk = "".join(_CJK_RUN.findall(text))[:MAX_CJK_SLUG]
    if not cjk:
        return ascii_slug or "constraint"
    if len(ascii_slug) >= MIN_SLUG and len(words) >= 2:
        return f"{ascii_slug[: MAX_SLUG - len(cjk) - 1]}-{cjk}"
    return f"{cjk}-{ascii_slug}" if ascii_slug else cjk


PROJECT_SCOPE = "project"
USER_SCOPE = "user"
SCOPES = (PROJECT_SCOPE, USER_SCOPE)


def _check_scope(scope: str) -> str:
    if scope not in SCOPES:
        raise ValueError(f"unknown contract scope {scope!r}")
    return scope


def _scope_lock(scope: str):
    """Lease for the layer being written: the project store, or the personal
    directory (two projects must never share the wrong lease)."""
    if scope == USER_SCOPE:
        return store.store_lock(directory=layers.user_dir())
    return store.store_lock()


def _project_rows_readonly() -> list[dict]:
    """Project rows without seeding or writing, as a basis for personal-layer
    mutations (never hold the user lease while writing the project store)."""
    data = store.read_json(store.contract_path())
    if not isinstance(data, dict) or not isinstance(data.get("constraints"), list):
        return [dict(c) for c in DEFAULT_CONTRACT]
    rows = [
        dict(c)
        for c in data["constraints"]
        if isinstance(c, dict)
        and all(isinstance(c.get(k), str) for k in ("id", "text", "added", "source"))
    ]
    if data["constraints"] and not rows:
        return [dict(c) for c in DEFAULT_CONTRACT]
    return rows


def _user_rows_for_mutation() -> list[dict]:
    """Personal rows for a read-modify-write cycle.

    A missing personal layer is not an error (it is never seeded); a damaged
    one fails closed so a mutation cannot silently erase owner data.
    """
    p = layers.user_contract_path()
    if not p.exists():
        return []
    data = store.read_json(p)
    if not isinstance(data, dict) or not isinstance(data.get("constraints"), list):
        raise ContractIntegrityError(
            f"personal contract is malformed; repair {p} before mutating it"
        )
    rows = data["constraints"]
    if any(
        not isinstance(row, dict)
        or not all(isinstance(row.get(k), str) for k in ("id", "text", "added", "source"))
        for row in rows
    ):
        raise ContractIntegrityError(
            f"personal contract contains malformed rows; repair {p} before mutating it"
        )
    return [dict(row) for row in rows]


def _scope_rows_for_mutation(scope: str) -> list[dict]:
    return _user_rows_for_mutation() if scope == USER_SCOPE else _load_for_mutation_unlocked()


def _save_scope_unlocked(scope: str, constraints: list[dict]) -> None:
    if scope == USER_SCOPE:
        store.write_json(layers.user_contract_path(), {"version": 1, "constraints": constraints})
        return
    _save_unlocked(constraints)


def _effective_after(scope: str, scope_rows: list[dict]) -> list[dict]:
    """Effective contract after a write to ``scope``."""
    if scope == USER_SCOPE:
        return merged(_project_rows_readonly())
    return merged(scope_rows)


def add(
    text: str, source: str = "user", scope: str = PROJECT_SCOPE
) -> tuple[dict | None, list[dict]]:
    """Add a constraint to ``scope`` (project store or personal layer).

    Returns (constraint_or_None_if_duplicate, effective_contract).
    """
    text = _normalise_text(text, MAX_TEXT)
    if not text:
        raise ValueError("constraint text must not be blank")
    scope = _check_scope(scope)
    with _scope_lock(scope):
        cons = _scope_rows_for_mutation(scope)
        # Dedupe and number against the EFFECTIVE contract so a personal
        # constraint is never duplicated into the project, and ids never
        # collide across layers.
        effective = merged(cons) if scope == PROJECT_SCOPE else merged(_project_rows_readonly())
        for c in effective:
            if _normalise_text(c.get("text"), MAX_TEXT) == text:
                return None, effective
        num = 1 + max([_num(c.get("id", "")) for c in effective] or [0])
        base = f"{num:02d}-{_slug(text)}"
        cid = base
        taken = {c.get("id") for c in effective}
        n = 2
        while cid in taken:
            cid = f"{base}-{n}"
            n += 1
        constraint = {
            "id": cid,
            "text": text,
            "added": store.now_ts()[:10],
            "source": source,
        }
        cons.append(constraint)
        _save_scope_unlocked(scope, cons)
        return constraint, _effective_after(scope, cons)


def remove(cid: str, *, allow_seed: bool = True, scope: str = PROJECT_SCOPE) -> bool:
    """Remove a constraint from ``scope`` by exact id. False if not found.

    ``allow_seed=False`` performs the provenance check inside the same lock as
    the write, so a concurrent replacement cannot bypass an agent surface's
    frozen-seed protection.
    """
    scope = _check_scope(scope)
    with _scope_lock(scope):
        cons = _scope_rows_for_mutation(scope)
        targets = [c for c in cons if c.get("id") == cid]
        if not targets:
            return False
        if not allow_seed and any(c.get("source") == "seed" for c in targets):
            raise SeedConstraintRemovalError(
                "seed constraint removal is refused on agent-driven surfaces"
            )
        kept = [c for c in cons if c.get("id") != cid]
        _save_scope_unlocked(scope, kept)
        return True


def _render_subset(cons: list[dict], limit: int) -> list[dict]:
    """Keep frozen seeds plus the newest remaining constraints under a cap."""
    if len(cons) <= limit:
        return cons
    seed_indexes = [i for i, c in enumerate(cons) if c.get("source") == "seed"]
    chosen = set(seed_indexes[:limit])
    for i in range(len(cons) - 1, -1, -1):
        if len(chosen) >= limit:
            break
        chosen.add(i)
    return [cons[i] for i in sorted(chosen)]


def render(cons: list[dict], limit: int = RENDER_MAX_CONSTRAINTS) -> str:
    """Compact, bounded contract view (no Nudge; callers append one).

    The frozen seeds stay visible when ordinary owner/agent entries overflow;
    remaining capacity shows the newest entries. The header and omission line
    make the bounded view explicit instead of presenting it as complete.
    """
    try:
        bounded_limit = max(1, min(int(limit), RENDER_MAX_CONSTRAINTS))
    except (TypeError, ValueError):
        bounded_limit = RENDER_MAX_CONSTRAINTS
    visible = _render_subset(cons, bounded_limit)
    lines = []
    for c in visible:
        cid = _normalise_text(c.get("id"), RENDER_ID_MAX) or "unknown-id"
        text = _normalise_text(c.get("text"), MAX_TEXT) or "(blank legacy constraint)"
        lines.append(f"{cid} {text}")
    if len(visible) == len(cons):
        header = f"contract ({len(cons)} constraints)"
    else:
        omitted = len(cons) - len(visible)
        header = f"contract ({len(cons)} constraints; showing {len(visible)})"
        lines.insert(0, f"… {omitted} older non-seed constraints omitted from this compact view")
    return header + "\n" + "\n".join(lines)
