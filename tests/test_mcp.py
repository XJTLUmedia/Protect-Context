"""fastmcp in-memory Client smoke over every shipped MCP tool."""

import asyncio
import json
import re
import subprocess

import pytest

from protect_context import contract, store

fastmcp = pytest.importorskip("fastmcp")

EXPECTED_TOOLS = {
    "guard_status",
    "guard_verify",
    "guard_evidence",
    "guard_contract",
    "guard_note",
    "guard_journal",
    "guard_intent",
    "guard_recall",
    "guard_loop_check",
    "guard_diff_audit",
    "guard_preflight",
    "guard_budget",
    "guard_orientation",
}

READ_ONLY_TOOLS = {
    "guard_evidence",
    "guard_journal",
    "guard_intent",
    "guard_recall",
    "guard_budget",
    "guard_orientation",
}

INITIALIZING_READ_TOOLS = {
    "guard_status",
    "guard_loop_check",
    "guard_diff_audit",
    "guard_preflight",
}


def _text(res) -> str:
    return res.content[0].text


def test_all_tools_smoke():
    from fastmcp import Client

    from protect_context.mcp_server import mcp

    async def run():
        async with Client(mcp) as client:
            tools = await client.list_tools()
            assert {t.name for t in tools} == EXPECTED_TOOLS

            results = {}
            results["status"] = _text(await client.call_tool("guard_status", {}))
            results["verify_ok"] = _text(
                await client.call_tool("guard_verify", {"command": "true"}))
            results["verify_fail"] = _text(
                await client.call_tool("guard_verify", {"command": "false"}))
            results["evidence"] = _text(
                await client.call_tool("guard_evidence", {"limit": 2}))
            results["contract_list"] = _text(
                await client.call_tool("guard_contract", {"action": "list"}))
            results["contract_add"] = _text(await client.call_tool(
                "guard_contract", {"action": "add", "text": "Write tests first"}))
            results["note"] = _text(await client.call_tool(
                "guard_note", {"type": "correction", "text": "use rg not grep",
                               "tags": ["search"]}))
            results["journal"] = _text(await client.call_tool(
                "guard_journal", {"limit": 5, "type": "correction"}))
            results["intent"] = _text(await client.call_tool(
                "guard_intent", {"limit": 5}))
            results["recall"] = _text(await client.call_tool(
                "guard_recall", {"query": "rg", "tags": ["search"], "limit": 5}))
            results["loop_check"] = _text(await client.call_tool("guard_loop_check", {}))
            results["diff_audit"] = _text(
                await client.call_tool("guard_diff_audit", {"baseline": None}))
            results["preflight"] = _text(await client.call_tool("guard_preflight", {}))
            results["budget"] = _text(await client.call_tool("guard_budget", {}))
            results["orientation"] = _text(
                await client.call_tool("guard_orientation", {}))
            return results

    res = asyncio.run(run())

    for name, text in res.items():
        assert "Nudge:" in text, f"{name} output lacks a Nudge line"

    # verify recorded evidence across both runs (ok + failing, never raised)
    assert "ev-0001" in res["verify_ok"] and "exit 0" in res["verify_ok"]
    assert "ev-0002" in res["verify_fail"] and "exit 1" in res["verify_fail"]
    assert store.verify_path().exists()

    # contract add returned the new id; remove it to prove remove works too
    m = re.search(r"added (\d{2}-[\w-]+)", res["contract_add"])
    assert m, res["contract_add"]
    added = next(c for c in contract.load() if c["id"] == m.group(1))
    assert added["source"] == "agent"

    async def cleanup():
        from fastmcp import Client

        from protect_context.mcp_server import mcp as server

        async with Client(server) as client:
            return _text(await client.call_tool(
                "guard_contract", {"action": "remove", "id": m.group(1)}))

    removed = asyncio.run(cleanup())
    assert f"removed {m.group(1)}" in removed

    # note actually persisted to the shared journal
    entries = store.read_jsonl(store.journal_path())
    assert entries and entries[-1]["type"] == "correction"
    assert json.loads(json.dumps(entries[-1]["tags"])) == ["search", "agent"]
    assert "use rg not grep" in res["journal"]
    assert "[search,agent]" in res["journal"]
    assert "use rg not grep" in res["recall"]
    assert "agent · correction" in res["recall"]
    assert res["recall"].rstrip().splitlines()[-1].startswith("Nudge:")
    assert "PC orientation" in res["orientation"]


def _annotations(tools, name):
    """Tool annotations, narrowed: every shipped tool must declare them."""
    annotations = tools[name].annotations
    assert annotations is not None, f"{name} must ship annotations"
    return annotations


def test_tool_annotations_describe_reads_and_side_effects():
    from fastmcp import Client

    from protect_context.mcp_server import mcp

    async def run():
        async with Client(mcp) as client:
            return {tool.name: tool for tool in await client.list_tools()}

    tools = asyncio.run(run())
    for name in READ_ONLY_TOOLS:
        annotations = _annotations(tools, name)
        assert annotations.readOnlyHint is True
        assert annotations.destructiveHint is False
        assert annotations.idempotentHint is True
        assert annotations.openWorldHint is False

    for name in INITIALIZING_READ_TOOLS:
        annotations = _annotations(tools, name)
        assert annotations.readOnlyHint is False
        assert annotations.destructiveHint is False
        assert annotations.idempotentHint is True
        assert annotations.openWorldHint is False

    verify_annotations = _annotations(tools, "guard_verify")
    assert verify_annotations.readOnlyHint is False
    assert verify_annotations.destructiveHint is True
    assert verify_annotations.idempotentHint is False
    assert verify_annotations.openWorldHint is True

    note_annotations = _annotations(tools, "guard_note")
    assert note_annotations.readOnlyHint is False
    assert note_annotations.destructiveHint is False
    assert note_annotations.openWorldHint is False

    contract_annotations = _annotations(tools, "guard_contract")
    assert contract_annotations.readOnlyHint is False
    assert contract_annotations.destructiveHint is True
    assert contract_annotations.openWorldHint is False


def test_read_only_annotated_tools_do_not_create_store_in_fresh_repo():
    from fastmcp import Client

    from protect_context.mcp_server import mcp

    subprocess.run(["git", "init", "-q"], check=True, capture_output=True)
    assert not store.guard_dir().exists()

    async def run():
        async with Client(mcp) as client:
            for name in sorted(READ_ONLY_TOOLS):
                result = _text(await client.call_tool(name, {}))
                assert "Nudge:" in result

    asyncio.run(run())
    assert not store.guard_dir().exists()


def test_guard_note_validation_and_guard_journal_bounds():
    from fastmcp import Client

    from protect_context import journal
    from protect_context.mcp_server import mcp

    async def run():
        async with Client(mcp) as client:
            blank = _text(await client.call_tool(
                "guard_note", {"type": "note", "text": "\n\t\x00"}))
            for i in range(journal.READ_LIMIT_MAX + 3):
                await client.call_tool("guard_note", {
                    "type": "decision", "text": f"bounded entry {i}",
                    "tags": ["x" * 100] * 20,
                })
            view = _text(await client.call_tool(
                "guard_journal", {"limit": 9999, "type": "decision"}))
            invalid = _text(await client.call_tool(
                "guard_journal", {"limit": 5, "type": "invalid"}))
            return blank, view, invalid

    blank, view, invalid = asyncio.run(run())
    assert "must not be blank" in blank and "Nudge:" in blank
    assert f"last {journal.READ_LIMIT_MAX} of {journal.READ_LIMIT_MAX + 3}" in view
    assert "bounded entry 0" not in view and "bounded entry 22" in view
    assert "agent" in view
    assert view.rstrip().splitlines()[-1].startswith("Nudge:")
    assert "unknown journal type" in invalid and "Nudge:" in invalid

    entries = store.read_jsonl(store.journal_path())
    assert entries[-1]["tags"].count("agent") == 1
    assert entries[-1]["tags"][-1] == "agent"
    assert len(entries[-1]["tags"]) <= journal.TAG_COUNT_CAP


def test_guard_intent_reports_owner_statements_and_bounds_the_page():
    from fastmcp import Client

    from protect_context import journal
    from protect_context.mcp_server import mcp

    async def run():
        async with Client(mcp) as client:
            await client.call_tool("guard_note", {
                "type": "decision", "text": "owner wants both runtimes green", "tags": [],
            })
            await client.call_tool("guard_note", {
                "type": "correction", "text": "CORRECTION (owner): the tags were wrong", "tags": [],
            })
            await client.call_tool("guard_note", {
                "type": "note", "text": "unrelated bookkeeping", "tags": [],
            })
            page = _text(await client.call_tool("guard_intent", {"limit": 5}))
            zero = _text(await client.call_tool("guard_intent", {"limit": 0}))
            return page, zero

    page, zero = asyncio.run(run())
    assert "PC intent · 2 of 2 owner statements" in page
    assert "want 1" in page and "correction 1" in page
    assert "owner-want · " in page and "owner-correction · " in page
    assert "unrelated bookkeeping" not in page
    assert page.rstrip().splitlines()[-1].startswith("Nudge:")
    assert "0 of 2 owner statements" in zero and "raise the limit" in zero
    assert len(journal.intent_with_total(5)[0]) == 2


def test_guard_recall_bounds_and_validation():
    from fastmcp import Client

    from protect_context.mcp_server import mcp

    async def run():
        async with Client(mcp) as client:
            for i in range(3):
                await client.call_tool("guard_note", {
                    "type": "decision", "text": f"recall row {i} ledger", "tags": ["ledger"],
                })
            window = _text(await client.call_tool(
                "guard_recall", {"query": "ledger", "type": "decision", "limit": 1}))
            bad_id = _text(await client.call_tool(
                "guard_recall", {"evidence_id": "nope"}))
            bad_type = _text(await client.call_tool(
                "guard_recall", {"type": "invalid"}))
            return window, bad_id, bad_type

    window, bad_id, bad_type = asyncio.run(run())
    assert "1 of 3 hits" in window
    assert "recall row 2" in window and "recall row 0" not in window
    assert "ev-NNNN" in bad_id and bad_id.rstrip().splitlines()[-1].startswith("Nudge:")
    assert "unknown recall type" in bad_type and bad_type.rstrip().splitlines()[-1].startswith("Nudge:")


def test_failed_guard_verify_feeds_loop_streak_at_mcp_boundary():
    """Anti-bypass pinned end-to-end at the MCP boundary (judge fix): two
    failing guard_verify calls must surface as a streak in guard_loop_check —
    the guard's own evidence tool must not be an escape hatch from goal #9.
    The loops.py merging is unit-tested directly; this pins it through the
    real tool boundary."""
    from fastmcp import Client

    from protect_context.mcp_server import mcp

    async def run():
        async with Client(mcp) as client:
            fail1 = _text(await client.call_tool("guard_verify", {"command": "false"}))
            fail2 = _text(await client.call_tool("guard_verify", {"command": "false"}))
            loop = _text(await client.call_tool("guard_loop_check", {}))
            return fail1, fail2, loop

    fail1, fail2, loop = asyncio.run(run())
    assert "ev-0001" in fail1 and "exit 1" in fail1
    assert "ev-0002" in fail2 and "exit 1" in fail2
    # the identical failing fingerprint shows as a streak of 2, at the block
    # threshold (loop_block_after=3 → block on the next identical attempt)
    assert "false ×2" in loop
    assert "next identical run will be blocked" in loop
    assert "Nudge:" in loop


def test_third_identical_mcp_verify_is_blocked_without_new_evidence():
    from fastmcp import Client

    from protect_context import verify
    from protect_context.mcp_server import mcp

    async def run():
        async with Client(mcp) as client:
            first = _text(await client.call_tool("guard_verify", {"command": "false"}))
            second = _text(await client.call_tool("guard_verify", {"command": "false"}))
            third = _text(await client.call_tool("guard_verify", {"command": "false"}))
            blank = _text(await client.call_tool("guard_verify", {"command": "  \t"}))
            return first, second, third, blank

    first, second, third, blank = asyncio.run(run())
    assert "ev-0001" in first and "ev-0002" in second
    assert "PC verify blocked" in third and "Nudge:" in third
    assert "must not be blank" in blank and "Nudge:" in blank
    assert verify.count() == 2


def test_guard_verify_never_raises_on_bad_command():
    from fastmcp import Client

    from protect_context.mcp_server import mcp

    async def run():
        async with Client(mcp) as client:
            return _text(await client.call_tool(
                "guard_verify", {"command": "definitely-missing-binary-xyz"}))

    text = asyncio.run(run())
    assert "exit 127" in text and "Nudge:" in text


def test_guard_contract_refuses_model_driven_seed_removal():
    """A model must not be able to delete its own injected guardrails: seed
    constraints are removable only by the owner (CLI / /guard-contract)."""
    from fastmcp import Client

    from protect_context import contract
    from protect_context.mcp_server import mcp

    async def run():
        async with Client(mcp) as client:
            return (
                _text(await client.call_tool("guard_contract", {"action": "remove", "id": "02-evidence-before-success"})),
                _text(await client.call_tool(
                    "guard_contract", {"action": "add", "text": "temporary constraint"})),
            )

    seed_res, add_res = asyncio.run(run())
    assert "seed constraint" in seed_res and "refused" in seed_res
    assert "Nudge:" in seed_res
    # the seed constraint is still there
    assert any(c["id"] == "02-evidence-before-success" for c in contract.load())

    # a model-added constraint can still be removed by the model
    m = re.search(r"added (\d{2}-[\w-]+)", add_res)
    assert m, add_res

    async def cleanup():
        async with Client(mcp) as client:
            return _text(await client.call_tool("guard_contract", {"action": "remove", "id": m.group(1)}))

    assert f"removed {m.group(1)}" in asyncio.run(cleanup())


def test_guard_note_default_tags_are_not_shared_between_calls():
    from protect_context import journal
    from protect_context.mcp_server import guard_note

    assert "tags: agent" in guard_note("note", "alpha")
    assert "tags: agent" in guard_note("note", "beta")
    assert [entry["tags"] for entry in journal.recent(5)] == [["agent"], ["agent"]]


def test_tool_descriptions_name_use_params_returns_and_side_effects():
    """Glama and other directories score the tools/list text, not the README."""
    from fastmcp import Client

    from protect_context.mcp_server import mcp

    async def run():
        async with Client(mcp) as client:
            return {tool.name: tool for tool in await client.list_tools()}

    tools = asyncio.run(run())
    assert set(tools) == EXPECTED_TOOLS
    for name, tool in tools.items():
        description = tool.description or ""
        lowered = " ".join(description.lower().split())
        assert "use " in lowered, name
        assert "return" in lowered, name
        assert "side effect" in lowered, name
        schema = tool.inputSchema or {}
        for param, spec in (schema.get("properties") or {}).items():
            text = spec.get("description") or ""
            assert len(text) > 20, f"{name}.{param} needs a parameter description"

    journal = tools["guard_journal"]
    assert "default 5" in (journal.description or "")
    limit = journal.inputSchema["properties"]["limit"]
    assert "Default 5" in limit["description"]
    assert "0–20" in limit["description"]
    assert journal.annotations is not None
    assert journal.annotations.readOnlyHint is True
    assert journal.annotations.destructiveHint is False


def test_guard_evidence_reads_one_run_back_by_id():
    from protect_context import verify
    from protect_context.mcp_server import guard_evidence

    run = verify.run_verify("definitely-missing-binary-xyz")
    full = guard_evidence(evidence_id=run["id"])
    assert full.startswith(f"PC verify {run['id']}")
    assert "not found" in full, "the stored failure text must be readable again"
    missing = guard_evidence(evidence_id="ev-9999")
    assert "no recorded run with id ev-9999" in missing
    assert "Nudge:" in missing
