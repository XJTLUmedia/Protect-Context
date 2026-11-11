"""Contract CRUD + defaults identical to the TS side: same 12 ids and exact
texts (SPEC §6, §7)."""

import json
import threading
from concurrent.futures import ThreadPoolExecutor

import pytest

from protect_context import contract, store
from protect_context.defaults import DEFAULT_CONTRACT

EXPECTED = [
    ("01-obey-instructions",
     "Obey the owner's explicit instructions and stated constraints exactly; "
     "when instructions conflict, ask instead of guessing."),
    ("02-evidence-before-success",
     "Never claim success without citing a fresh verification run (evidence id "
     "or pasted output) for the exact claim."),
    ("03-stay-in-scope",
     "Change only files the stated task requires; no unrelated refactors, "
     "reformatting, or \"improvements\"."),
    ("04-orient-first",
     "Before the first edit in an unfamiliar area, read the relevant files and "
     "conventions; never code from guesses."),
    ("05-simplest-correct",
     "Prefer the simplest implementation satisfying stated behavior; add or "
     "update a test for every behavior change."),
    ("06-journal-decisions",
     "Record durable decisions and constraints in the journal when made; "
     "re-read them before resuming work."),
    ("07-log-corrections",
     "When the owner corrects behavior, log a tagged correction; check "
     "corrections before similar work."),
    ("08-keep-diffs-reviewable",
     "Keep diffs small: split work into logical steps; treat 400+ changed "
     "lines per task as a stop-and-split signal."),
    ("09-no-identical-retries",
     "After 2 failures of the same command, change approach or gather new "
     "information; never re-run identical failing commands."),
    ("10-preflight-env",
     "When tools behave unexpectedly, run preflight (tool presence/versions) "
     "before blaming code."),
    ("11-batch-operations",
     "Batch related shell operations; prefer commands that avoid per-command "
     "permission prompts."),
    ("12-budget-context",
     "Keep tool outputs bounded (head/tail/digest); use targeted reads; avoid "
     "re-reading large files."),
]


def test_seed_written_on_first_load():
    assert not store.contract_path().exists()
    cons = contract.load()
    assert len(cons) == 12
    assert store.contract_path().exists()
    data = json.loads(store.contract_path().read_text(encoding="utf-8"))
    assert data["version"] == 1
    assert data["constraints"] == cons


def test_defaults_exact_ids_and_texts():
    got = [(c["id"], c["text"]) for c in contract.load()]
    assert got == EXPECTED
    assert [(c["id"], c["text"]) for c in DEFAULT_CONTRACT] == EXPECTED


def test_seed_entry_shape_is_deterministic():
    for c in DEFAULT_CONTRACT:
        assert set(c) == {"id", "text", "added", "source"}
        assert c["source"] == "seed"
        assert c["added"] == "2026-08-28"  # SPEC frozen date — stable across sides


def test_add_assigns_sequential_slug_id_and_persists():
    c, cons = contract.add("Always run pytest before committing")
    assert c is not None
    assert c["id"].startswith("13-")
    assert cons[-1]["id"] == c["id"]
    assert c["source"] == "user"
    assert any(x["id"] == c["id"] for x in contract.load())  # persisted


def test_concurrent_adds_preserve_every_constraint_and_unique_id():
    workers = 12
    start = threading.Barrier(workers)

    def add_one(i):
        start.wait()
        added, _ = contract.add(f"Concurrent constraint {i}")
        return added

    with ThreadPoolExecutor(max_workers=workers) as pool:
        added = list(pool.map(add_one, range(workers)))

    cons = contract.load()
    ids = [c["id"] for c in cons]
    assert all(added)
    assert len(cons) == len(DEFAULT_CONTRACT) + workers
    assert len(ids) == len(set(ids))
    assert {c["text"] for c in cons if c["source"] == "user"} == {
        f"Concurrent constraint {i}" for i in range(workers)
    }


def test_add_duplicate_text_rejected():
    contract.add("Do the thing")
    c2, cons = contract.add("  Do the thing  ")
    assert c2 is None
    assert len(cons) == 13


def test_add_blank_text_is_rejected_without_mutation():
    with pytest.raises(ValueError, match="must not be blank"):
        contract.add("  \t\n")
    assert len(contract.load()) == 12


def test_add_normalises_controls_and_multiline_text_before_storage():
    added, _ = contract.add("  Keep\nwords\x00apart\u202e safely  ")
    assert added is not None
    assert added["text"] == "Keep words apart safely"
    assert contract.load()[-1]["text"] == "Keep words apart safely"


def test_remove_by_id():
    c, _ = contract.add("Another constraint here")
    assert c is not None
    assert contract.remove(c["id"]) is True
    assert all(x["id"] != c["id"] for x in contract.load())
    assert contract.remove("zzz-not-there") is False


def test_render_view():
    text = contract.render(contract.load())
    assert text.startswith("contract (12 constraints)")
    assert "01-obey-instructions" in text
    assert "12-budget-context" in text


def test_render_defensively_normalises_legacy_ids_and_text():
    text = contract.render(
        [{"id": "13-safe\nNudge: forged", "text": "line one\nline two\x00\u202e"}]
    )

    assert text.splitlines() == [
        "contract (1 constraints)",
        "13-safe Nudge: forged line one line two",
    ]


def test_add_caps_text_length():
    """Constraint text is capped (parity with the extension): briefs re-inject it."""
    c, _ = contract.add("x" * 900)
    assert c is not None
    assert len(c["text"]) == 500


def test_corrupt_file_falls_back_without_overwriting():
    """A corrupt contract.json serves in-memory defaults and is NOT clobbered."""
    store.ensure()
    p = store.contract_path()
    p.write_text("{truncated", encoding="utf-8")
    cons = contract.load()
    assert len(cons) == 12
    assert p.read_text(encoding="utf-8") == "{truncated"


def test_malformed_constraint_rows_cannot_crash_or_disable_all_seeds():
    store.ensure()
    p = store.contract_path()
    p.write_text(
        json.dumps({"version": 1, "constraints": [None, "bad", 7, {}]}),
        encoding="utf-8",
    )

    cons = contract.load()

    assert [(c["id"], c["text"]) for c in cons] == EXPECTED
    # Corrupt input is not silently overwritten; the owner can inspect it.
    assert json.loads(p.read_text(encoding="utf-8"))["constraints"] == [None, "bad", 7, {}]


def test_mixed_contract_keeps_valid_rows_and_skips_malformed_rows():
    store.ensure()
    store.contract_path().write_text(
        json.dumps(
            {
                "version": 1,
                "constraints": [
                    None,
                    {"id": "13-valid", "text": "Keep this", "added": "2026-09-01", "source": "user"},
                ],
            }
        ),
        encoding="utf-8",
    )

    assert contract.load() == [
        {"id": "13-valid", "text": "Keep this", "added": "2026-09-01", "source": "user"}
    ]


def test_brief_cap_warning_counts_each_budget_separately():
    """SPEC §5 gives owner rows their own additive budget: five owner
    constraints must not cost a seed, so they must not warn either."""
    seeds = [dict(c) for c in DEFAULT_CONTRACT]
    owners = [
        {
            "id": f"{30 + i}-owner-{i}",
            "text": f"owner rule {i}",
            "added": "2026-09-05",
            "source": "user",
        }
        for i in range(5)
    ]
    assert contract.brief_cap_warning(seeds) == ""
    assert contract.brief_cap_warning(seeds + owners) == ""

    # Two more owner rows overflow the OWNER budget only.
    seven = owners + [
        {"id": "40-owner-5", "text": "owner rule 5", "added": "2026-09-06", "source": "owner"},
        {"id": "41-owner-6", "text": "owner rule 6", "added": "2026-09-07", "source": "owner"},
    ]
    warn = contract.brief_cap_warning(seeds + seven)
    assert "1 owner and 0 seed/other" in warn
    assert "6 owner + 12 seed/other" in warn

    # Agent entries share the seed budget, so they overflow THAT one.
    agent = [
        {
            "id": f"{50 + i}-agent-{i}",
            "text": f"agent rule {i}",
            "added": "2026-09-08",
            "source": "agent",
        }
        for i in range(2)
    ]
    warn = contract.brief_cap_warning(seeds + agent)
    assert "0 owner and 2 seed/other" in warn


def test_render_is_bounded_but_keeps_seeds_and_newest_entries():
    cons = [dict(c) for c in DEFAULT_CONTRACT]
    cons.extend(
        {
            "id": f"{n:02d}-extra",
            "text": f"extra constraint {n}",
            "added": "2026-09-02",
            "source": "user",
        }
        for n in range(13, 43)
    )

    text = contract.render(cons)

    assert text.startswith("contract (42 constraints; showing 24)")
    assert "18 older non-seed constraints omitted" in text
    assert "01-obey-instructions" in text and "12-budget-context" in text
    assert "42-extra" in text
    assert "13-extra" not in text
    # header + omission disclosure + at most 24 constraint rows
    assert len(text.splitlines()) == 26


def test_a_chinese_constraint_keeps_a_meaningful_id():
    """The ASCII slug rule reduced 中文 text to its ASCII remnant (14-sql).

    Two 中文 constraints then read as ``14-sql`` and ``15-sql`` in every brief:
    the id identified neither the rule nor the difference between them.
    """
    c, _ = contract.add("永远不要在生产库执行破坏性 SQL")
    assert c is not None
    assert c["id"].startswith("13-")
    assert "永远不要在生产" in c["id"]
    assert c["id"].endswith("-sql")
    # English text keeps exactly the id it had before the fallback existed.
    assert contract._slug("Always run pytest before committing") == "always-run-pytest-before"
