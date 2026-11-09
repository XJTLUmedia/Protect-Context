"""Fingerprint-driven loop streaks + cross-format TS events fixture (SPEC §7)."""

from protect_context import loops, store, verify


def _fail(cmd, session="test-session"):
    return {"kind": "tool_result", "tool": "bash", "ok": False, "cmd": cmd, "exit": 1,
            "session": session}


def _ok(cmd=None, tool="bash", session="test-session"):
    return {"kind": "tool_result", "tool": tool, "ok": True, "cmd": cmd, "exit": 0,
            "session": session}


def test_streaks_count_identical_failures(write_events):
    write_events([_fail("pytest -q"), _fail("pytest -q"), _ok("ls")])
    assert loops.streaks() == [{"cmd": "pytest -q", "count": 2}]


def test_success_of_same_command_resets_streak(write_events):
    write_events([_fail("npm test"), _fail("npm test"), _ok("npm test"), _fail("npm test")])
    assert loops.streaks() == [{"cmd": "npm test", "count": 1}]


def test_failing_other_command_does_not_reset(write_events):
    write_events([_fail("pytest -q"), _fail("other-cmd"), _fail("pytest -q")])
    assert loops.streaks() == [
        {"cmd": "pytest -q", "count": 2},
        {"cmd": "other-cmd", "count": 1},
    ]


def test_other_session_ignored(write_events):
    write_events([_fail("pytest -q", session="someone-else"),
                  _fail("pytest -q", session="someone-else")])
    assert loops.streaks() == []
    assert loops.streaks(session="someone-else") == [{"cmd": "pytest -q", "count": 2}]


def test_would_block_uses_loop_block_after(write_events):
    cfg = store.load_config()
    write_events([_fail("pytest -q")])
    s = loops.streaks()
    assert loops.would_block(s, cfg) == []  # 1 failure < 3-1
    write_events([_fail("pytest -q"), _fail("pytest -q")])
    s = loops.streaks()
    assert loops.would_block(s, cfg) == s  # 2 prior failures → 3rd identical blocked
    assert loops.command_block("  pytest   -q ", cfg, s) == s[0]
    assert loops.command_block("pytest -x", cfg, s) is None


def test_verify_outcomes_feed_streaks():
    """guard_verify is not an escape hatch from goal #9: failing verify runs
    accumulate streaks, successful ones reset them (same arithmetic as bash)."""
    from protect_context import verify

    verify.run_verify("false")
    verify.run_verify("false")
    verify.run_verify("true")  # different fingerprint — must not reset 'false'
    assert loops.streaks() == [{"cmd": "false", "count": 2}]


def test_verify_success_resets_streak(tmp_path):
    from protect_context import verify

    # Same command text, failing on the first run, succeeding on the second.
    marker = tmp_path / "flip"
    cmd = f"if [ -f {marker} ]; then exit 0; else touch {marker}; exit 1; fi"
    e1 = verify.run_verify(cmd)
    e2 = verify.run_verify(cmd)
    assert e1["ok"] is False and e2["ok"] is True
    assert loops.streaks() == []


def test_explicit_events_skip_the_ledger_merge(write_events):
    """The pure path (explicit events) stays ledger-free, as pinned elsewhere."""
    from protect_context import verify

    verify.run_verify("false")
    write_events([_fail("pytest -q")])
    assert loops.streaks([_fail("pytest -q")]) == [{"cmd": "pytest -q", "count": 1}]


def test_render_has_nudge(write_events):
    write_events([_fail("pytest -q"), _fail("pytest -q")])
    text = loops.render(loops.streaks(), store.load_config())
    assert "×2" in text and "Nudge:" in text
    empty = loops.render([], store.load_config())
    assert "no repeated failing commands" in empty and "Nudge:" in empty


def test_trailing_semicolon_shares_a_streak(write_events):
    write_events([_fail("pytest -q"), _fail("pytest -q;")])
    assert loops.streaks() == [{"cmd": "pytest -q", "count": 2}]
    cfg = store.load_config()
    blocked = loops.command_block("pytest -q;", cfg)
    assert blocked is not None and blocked["count"] == 2


def test_quoted_semicolon_does_not_merge_with_the_bare_command(write_events):
    write_events([_fail("echo"), _fail('echo ";"')])
    assert {row["cmd"] for row in loops.streaks()} == {"echo", 'echo ";"'}


def test_masked_success_does_not_reset_and_matches_the_underlying_command(write_events):
    write_events([
        _fail("npm test"),
        _fail("npm test"),
        _ok("npm test || true"),
    ])
    # A masked exit 0 is an unproven attempt, not a success: it counts too, so
    # `|| true` cannot walk a command back under the block threshold.
    assert loops.streaks() == [{"cmd": "npm test", "count": 3}]
    cfg = store.load_config()
    blocked = loops.command_block("npm test || true", cfg)
    assert blocked is not None and blocked["cmd"] == "npm test"
    # A real success of the same command still clears the streak.
    write_events([_fail("npm test"), _fail("npm test"), _ok("npm test")])
    assert loops.streaks() == []


def test_whitespace_variants_share_one_fingerprint(write_events):
    # cmd is stored fingerprint-normalized (SPEC §2); if un-normalized data
    # sneaks in, streaks still collapse whitespace variants together.
    write_events([_fail("pytest  -q"), _fail("pytest\t-q")])
    assert loops.streaks() == [{"cmd": "pytest -q", "count": 2}]


def test_malformed_command_fields_are_ignored():
    events = [_fail("pytest -q"), _fail(7), _ok(cmd={"not": "a command"})]
    assert loops.streaks(events) == [{"cmd": "pytest -q", "count": 1}]


def test_cross_format_parses_ts_extension_events_fixture():
    """Python parses a TS-format events.jsonl fixture string (SPEC §2 schema)."""
    fixture = (
        '{"ts":"2026-08-28T10:00:00Z","session":"ext-1","kind":"tool_call","tool":"bash",'
        '"ok":null,"ms":null,"out_chars":null,"cmd":"npm test","exit":null}\n'
        '{"ts":"2026-08-28T10:00:05Z","session":"ext-1","kind":"tool_result","tool":"bash",'
        '"ok":false,"ms":1200,"out_chars":3542,"cmd":"npm test","exit":1}\n'
        '{"ts":"2026-08-28T10:01:00Z","session":"ext-1","kind":"tool_result","tool":"read",'
        '"ok":true,"ms":3,"out_chars":210,"cmd":null,"exit":null}\n'
        '{"ts":"2026-08-28T10:02:00Z","session":"ext-1","kind":"tool_result","tool":"bash",'
        '"ok":false,"ms":1180,"out_chars":3542,"cmd":"npm test","exit":1}\n'
        '{"ts":"2026-08-28T10:03:00Z","session":"ext-2","kind":"tool_result","tool":"bash",'
        '"ok":false,"ms":10,"out_chars":10,"cmd":"npm test","exit":1}\n'
    )
    store.ensure()
    store.events_path().write_text(fixture, encoding="utf-8")
    events = store.read_jsonl(store.events_path())
    assert len(events) == 5
    assert events[0]["kind"] == "tool_call" and events[0]["ok"] is None
    # streak for ext-1 only; ext-2 is a different session
    assert loops.streaks(events, session="ext-1") == [{"cmd": "npm test", "count": 2}]
    # budget math over the same TS fixture: only tool_result out_chars count
    from protect_context import budget

    b = budget.compute(events, session="ext-1")
    assert b["chars"] == 3542 * 2 + 210 and b["events"] == 3
    assert b["top"] == [("bash", 3542 * 2), ("read", 210)]


def test_cross_ledger_merge_parses_offsets_instead_of_sorting_raw_strings():
    """An earlier TS failure must precede a later legacy Python success.

    Raw string order puts ``+00:00`` before ``Z`` and would leave the failure
    open. Parsed instant order correctly lets the later success reset it.
    """
    event = {
        "ts": "2026-08-28T10:00:00.900+00:00",
        "session": "test-session",
        "kind": "tool_result",
        "tool": "bash",
        "ok": True,
        "ms": 1,
        "out_chars": 0,
        "cmd": "npm test",
        "exit": 0,
    }
    run = {
        "id": "ev-0001",
        "ts": "2026-08-28T10:00:00.100Z",
        "session": "test-session",
        "cmd": "npm test",
        "exit": 1,
        "ok": False,
        "digest": "failed",
        "ms": 1,
    }
    store.append_jsonl(store.events_path(), event)
    store.append_jsonl(store.verify_path(), run)

    assert loops.streaks() == []


def test_masked_successes_accumulate_so_masking_cannot_disarm_the_brake():
    cfg = store.load_config()
    for _ in range(3):
        verify.run_verify("pytest -q || true")
    streak = loops.streaks()
    assert streak and streak[0]["count"] == 3, streak
    assert loops.command_block("pytest -q || true", cfg) is not None


def test_piped_verify_runs_count_as_unproven_attempts():
    # exit 0 through a pipe proves only the last stage: not a success.
    for _ in range(3):
        verify.run_verify("true | tail -1")
    streak = loops.streaks()
    assert streak and streak[0]["count"] == 3, streak
    assert loops.command_block("true | tail -1", store.load_config()) is not None
