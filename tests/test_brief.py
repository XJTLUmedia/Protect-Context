"""Cross-runtime brief parity (SPEC §5).

The brief is the one surface that must be identical everywhere: the pi
extension injects it before every turn, the CLI prints it, and the MCP
``guard_brief`` tool returns it. Two implementations of "what the owner asked
for" is exactly how a store starts disagreeing with itself, so this test renders
the same fixture store through both runtimes and requires byte equality.

The fixture deliberately avoids clock- and ordering-sensitive rows (no event
streaks: `would_block` is time-based on both sides) while covering every
section: task, both contract budgets, owner intent, precedents, decisions,
corrections, unverified corrections, agent notes, recall, and last evidence.
"""

from __future__ import annotations

import json
import os
import shutil
import subprocess
from pathlib import Path

import pytest

from protect_context import brief, journal, store
from protect_context.defaults import DEFAULT_CONTRACT

SESSION = "test-session"
EXTENSION = Path(__file__).resolve().parents[1] / "extension"
NODE = shutil.which("node")

pytestmark = pytest.mark.skipif(
    NODE is None, reason="node is required to prove cross-runtime brief parity"
)

CONTRACT_ROWS = [
    *[dict(row) for row in DEFAULT_CONTRACT],
    {
        "id": "13-take-the-whole-batch",
        "text": "Take the whole batch: do all N follow-ups in one pass.",
        "added": "2026-11-10",
        "source": "user",
    },
]

JOURNAL_ROWS = [
    {
        "ts": "2026-11-09T10:00:00.000Z",
        "type": "decision",
        "text": "Owner approved layering; project rows override the personal layer.",
        "tags": ["contract", "layers"],
    },
    {
        "ts": "2026-11-09T11:00:00.000Z",
        "type": "note",
        "text": "Owner asked whether journal and events are used as precedent.",
        "tags": ["owner-want", "recall"],
    },
    {
        "ts": "2026-11-09T12:00:00.000Z",
        "type": "correction",
        "text": "Stop folding a dependency bump into a release.",
        "tags": ["releases"],
    },
    {
        "ts": "2026-11-09T13:00:00.000Z",
        "type": "decision",
        "text": "Seeds are frozen in code with ids and texts dated 2026-08-28.",
        "tags": ["contract"],
    },
    {
        "ts": "2026-11-09T14:00:00.000Z",
        "type": "decision",
        "text": "Take all follow-ups in one pass (lesson).",
        "tags": ["lesson", "contract"],
    },
    {
        "ts": "2026-11-09T15:00:00.000Z",
        "type": "correction",
        "text": "Agent-written correction, never treated as authority.",
        "tags": ["agent", "contract"],
    },
    {
        "ts": "2026-11-09T16:00:00.000Z",
        "type": "note",
        "text": "Agent note about the contract cap split.",
        "tags": ["agent", "recall"],
    },
    {
        "ts": "2026-11-09T17:00:00.000Z",
        "type": "correction",
        "text": "Owner correction: do not publish on the owner's behalf.",
        "tags": ["owner-correction", "releases"],
    },
    {
        "ts": "2026-11-09T18:00:00.000Z",
        "type": "note",
        "text": "Owner preference: keep diffs reviewable.",
        "tags": ["owner-preference", "contract"],
    },
    # Tag-matched recall: the tag names a word in the owner task and the row is
    # trusted, so it is injected once even though no cap would have reached it.
    {
        "ts": "2026-11-09T18:30:00.000Z",
        "type": "note",
        "text": "The brief is digest-gated, so extra lines are paid only on change.",
        "tags": ["brief", "recall"],
    },
]

VERIFY_ROWS = [
    {
        "id": "ev-0001",
        "ts": "2026-11-09T19:00:00.000Z",
        "session": SESSION,
        "cmd": "npm run check",
        "ok": True,
        "exit": 0,
        "ms": 1234,
        # `digest` is required by the extension's isVerifyRun(): a row without
        # one is dropped there, so a fixture without it would silently test
        # "both sides agree on no evidence" instead of the evidence line.
        "digest": "ok",
    }
]


def _write_store(root: Path) -> None:
    guard = root / store.GUARD_DIR
    guard.mkdir(parents=True, exist_ok=True)
    (guard / "contract.json").write_text(
        json.dumps({"version": 1, "constraints": CONTRACT_ROWS}, indent=0),
        encoding="utf-8",
    )
    (guard / "journal.jsonl").write_text(
        "".join(f"{json.dumps(row)}\n" for row in JOURNAL_ROWS), encoding="utf-8"
    )
    (guard / "verify_runs.jsonl").write_text(
        "".join(f"{json.dumps(row)}\n" for row in VERIFY_ROWS), encoding="utf-8"
    )
    (guard / "events.jsonl").write_text("", encoding="utf-8")
    (guard / "state.json").write_text(
        json.dumps(
            {
                "current_session": {"started": "2026-11-09T09:00:00.000Z", "git_head": None},
                "sessions": {},
                "task": {
                    "text": "Make the brief identical across the extension, CLI and MCP.",
                    "source": "owner",
                    "ts": "2026-11-09T09:30:00.000Z",
                },
            }
        ),
        encoding="utf-8",
    )


def _typescript_brief(root: Path) -> str:
    """Render the same store through the extension's assembler."""
    runner = root / "parity_runner.ts"
    runner.write_text(
        "import { composeBriefFromStore } from "
        f'"{EXTENSION.as_uri()}/lib/brief_source.ts";\n'
        "const root = process.env.PC_PARITY_DIR as string;\n"
        "const session = process.env.PC_PARITY_SESSION as string;\n"
        "process.stdout.write(composeBriefFromStore(root, session));\n",
        encoding="utf-8",
    )
    env = {
        **os.environ,
        "PC_PARITY_DIR": str(root),
        "PC_PARITY_SESSION": SESSION,
        # The extension must not read the developer's real personal layer.
        "PC_USER_DIR": str(root / "user-layer"),
    }
    result = subprocess.run(
        [
            str(NODE),
            "--experimental-strip-types",
            "--no-warnings",
            str(runner),
        ],
        capture_output=True,
        text=True,
        env=env,
        timeout=120,
    )
    assert result.returncode == 0, f"node brief failed: {result.stderr[-2000:]}"
    return result.stdout


def test_python_and_typescript_render_the_same_brief(tmp_path):
    """Byte equality: one fixture store, two runtimes, one brief."""
    _write_store(tmp_path)
    python_brief = brief.compose_brief()
    typescript_brief = _typescript_brief(tmp_path)
    assert python_brief == typescript_brief


def test_python_brief_covers_every_section(tmp_path):
    """The parity fixture must actually exercise the sections it claims to."""
    _write_store(tmp_path)
    rendered = brief.compose_brief()
    for heading in (
        "task:",
        "contract:",
        "owner intent:",
        "precedents:",
        "decisions:",
        "corrections:",
        "corrections (unverified):",
        "agent notes (unverified):",
        "recall:",
        "last verify:",
    ):
        assert heading in rendered, f"{heading} missing from the Python brief"
    # Both budgets are in play: the owner constraint and every seed.
    assert "13-take-the-whole-batch [user]:" in rendered
    for seed in DEFAULT_CONTRACT:
        assert f"{seed['id']}:" in rendered
    assert "more constraints hidden" not in rendered


def test_python_brief_announces_contract_overflow(tmp_path):
    """Past the owner budget the brief says what it hid, per class."""
    _write_store(tmp_path)
    guard = tmp_path / store.GUARD_DIR
    extra = [
        {
            "id": f"{20 + i}-owner-extra-{i}",
            "text": f"extra owner rule {i}",
            "added": f"2026-11-1{i}",
            "source": "user",
        }
        for i in range(7)
    ]
    (guard / "contract.json").write_text(
        json.dumps({"version": 1, "constraints": [*CONTRACT_ROWS, *extra]}),
        encoding="utf-8",
    )
    rendered = brief.compose_brief()
    assert "+2 more constraints hidden" in rendered
    # Every seed still survives: the owner budget is additive.
    for seed in DEFAULT_CONTRACT:
        assert f"{seed['id']}:" in rendered


def test_a_correction_check_runs_and_is_labelled():
    entry = journal.add("correction", "split changes over 400 lines", check="true")
    rendered = brief.compose_brief()
    assert "checks:" in rendered
    assert f"- {entry['id']}: HONORED · true" in rendered


def test_a_violated_check_says_violated_not_honored():
    journal.add("correction", "npm publish belongs to the owner", check="false")
    rendered = brief.compose_brief()
    assert "VIOLATED · false" in rendered
    assert "HONORED" not in rendered


def test_checks_disabled_prints_the_command_instead_of_running_it():
    journal.add("correction", "split changes over 400 lines", check="true")
    cfg = {**store.DEFAULT_CONFIG, "brief_checks": False}
    rendered = brief.compose_brief(cfg)
    # Silent disabling would make an unproved correction read as checked.
    assert "checks: not run (brief_checks=false)" in rendered
    assert "HONORED" not in rendered

    capped = {**store.DEFAULT_CONFIG, "brief_check_max": 0}
    capped_rendered = brief.compose_brief(capped)
    assert "checks: not run (brief_checks=false)" in capped_rendered
