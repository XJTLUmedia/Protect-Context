"""Loop detection: failing-command streaks from events.jsonl + the evidence
ledger (SPEC §1 #9).

A streak for a command fingerprint counts its failed bash tool_result events
since the last *successful* run of that same fingerprint. Failing or unknown
events of other commands do not reset a streak. The extension blocks a re-run
once prior failures for the fingerprint reach loop_block_after - 1; this
module reports the same arithmetic.

guard_verify outcomes are merged into the streaks too (ok=False → +1,
ok=True → reset): the suite's own evidence tool must not be an escape hatch.
verify_runs.jsonl already stores `cmd`, so no §2 change was needed there. Every
verify run is also mirrored into events.jsonl as a tool_call/tool_result pair so
recall and budget see MCP- and CLI-only work; those mirrored rows are skipped
here because the evidence ledger is authoritative for the outcome, and counting
both would charge one attempt twice.

Streak identity is the frozen fingerprint plus a comparison key: a trailing
``;`` outside quotes is ignored (``pytest -q`` and ``pytest -q;`` share a
streak), and a trailing failure mask is stripped (``npm test || true`` is the
same streak as ``npm test``). A success that only masks failure does not
reset that streak. Stored commands are not rewritten.
"""

from __future__ import annotations

import time
from datetime import datetime, timezone

import humanize
from pybreaker import CircuitBreaker, CircuitBreakerError

from . import store, verify

# Tools whose runs may accumulate a streak. Everything else only records a
# reuse key for recall.
STREAK_TOOLS = frozenset(("bash", "guard_verify"))

# Circuit-breaker reset window (the pybreaker/opossum HALF_OPEN idea, SPEC §1
# #9): a streak whose last failure is older than this stops blocking, because
# the workspace or the code has probably changed since. The next identical run
# is then a deliberate probe: if it fails again the streak is still counted and
# blocks immediately. 0 disables expiry, so a command stays blocked until it
# succeeds.
RESET_AFTER_DEFAULT_S = 300


def _timestamp_key(value: object, position: int) -> tuple:
    """Chronological key for JS/Python ISO timestamps, including legacy rows.

    Lexicographic ordering is wrong when one runtime wrote ``Z`` and another
    wrote ``+00:00`` (or used a different fractional precision). Valid ISO
    values are normalized to an instant; malformed legacy values retain a
    deterministic, stable fallback after valid timestamps.
    """
    raw = str(value or "")
    normalized = raw[:-1] + "+00:00" if raw.endswith(("Z", "z")) else raw
    try:
        parsed = datetime.fromisoformat(normalized)
        if parsed.tzinfo is None:
            parsed = parsed.replace(tzinfo=timezone.utc)
        return (0, parsed.timestamp(), position)
    except (TypeError, ValueError, OverflowError):
        return (1, raw, position)


def _reset_after(cfg: dict) -> float:
    """Seconds after which an idle streak stops blocking (0 = never)."""
    try:
        return float(max(0, int(cfg.get("loop_reset_after_s", RESET_AFTER_DEFAULT_S))))
    except (TypeError, ValueError):
        return float(RESET_AFTER_DEFAULT_S)


def _age_seconds(ts: object, now: float | None = None) -> float | None:
    """Seconds since ``ts``, or None when it is missing or unparseable."""
    key = _timestamp_key(ts, 0)
    if key[0] != 0:
        return None
    return max(0.0, (time.time() if now is None else now) - key[1])


def _parse_ts(ts: object) -> float | None:
    """Epoch seconds for a stored timestamp, or None when missing/invalid."""
    key = _timestamp_key(ts, 0)
    if key[0] != 0:
        return None
    return float(key[1])


def _breaker(cfg: dict) -> CircuitBreaker:
    """A throwaway breaker configured to trip at exactly our block threshold."""
    return CircuitBreaker(
        fail_max=max(1, block_threshold(cfg)),
        reset_timeout=_reset_after(cfg),
        throw_new_error_on_trip=False,
    )


def _aged_out(count: int, ts: object, cfg: dict, now: float | None = None) -> bool:
    """True when an open circuit's reset window has elapsed (HALF_OPEN).

    The OPEN -> HALF_OPEN decision belongs to the vendored breaker, not to this
    module: we build one, open it, and point its ``opened_at`` at the last
    failure so its own ``before_call`` timeout check answers the question. An
    injected ``now`` is applied by shifting ``opened_at`` by the same offset, so
    a test can name the instant it means instead of racing the host clock.

    An unknown timestamp is NOT aged out: a missing ts must never be read as
    "old enough to unblock", or a legacy row would quietly disarm the brake.
    """
    if count < block_threshold(cfg):
        return False  # never tripped
    if _reset_after(cfg) <= 0:
        return False  # 0 means never expire
    at = _parse_ts(ts)
    if at is None:
        return False
    cb = _breaker(cfg)
    cb.open()
    skew = 0.0 if now is None else (time.time() - now)
    cb._state_storage.opened_at = datetime.fromtimestamp(at + skew, tz=timezone.utc)
    try:
        cb.state.before_call(lambda: None)
    except CircuitBreakerError:
        return False  # still open: block
    return True  # timeout elapsed, breaker went half-open: probe allowed


def _is_ledger_mirror(event: dict) -> bool:
    """True for an events row that only mirrors an evidence-ledger outcome.

    ``verify.run_verify`` appends one ``tool_result`` row per run so every
    interface (MCP, CLI, pi) has command history in events.jsonl. verify_runs
    stays authoritative for the outcome: counting both would charge the same
    attempt twice and block a command after half as many real failures.
    """
    return event.get("kind") == "tool_result" and event.get("tool") == "guard_verify"


def _verify_outcomes(session: str) -> list[dict]:
    """guard_verify ledger outcomes for a session as loop-relevant pseudo-events
    (same shape as bash tool_results, so the streak arithmetic below is shared)."""
    out: list[dict] = []
    for r in store.read_jsonl(store.verify_path()):
        if r.get("session") != session or not isinstance(r.get("ok"), bool):
            continue
        cmd = r.get("cmd")
        if not isinstance(cmd, str) or not cmd:
            continue
        out.append(
            {
                "ts": str(r.get("ts") or ""),
                "session": session,
                "kind": "tool_result",
                "tool": "guard_verify",
                "ok": r["ok"],
                "cmd": cmd,
                "exit": r.get("exit"),
                # exit 0 that proves nothing (pipeline or failure mask) is an
                # unproven attempt: the streak must see it, not shrug at it.
                "unproven": r["ok"] is True and bool(verify.trust_issues(cmd)),
            }
        )
    return out


def streaks(events: list[dict] | None = None, session: str | None = None) -> list[dict]:
    """Return [{"cmd": fingerprint, "count": n}, ...] sorted by count desc.

    With no explicit events, bash tool_results are merged with guard_verify
    outcomes (chronological by ts; ties keep file order) so failing verify
    runs accumulate streaks exactly like failing bash runs.
    """
    session = session or store.session_id()
    if events is None:
        combined = [
            event
            for event in store.read_jsonl(store.events_path())
            if not _is_ledger_mirror(event)
        ] + _verify_outcomes(session)
        events = [
            event
            for _position, event in sorted(
                enumerate(combined),
                key=lambda item: _timestamp_key(item[1].get("ts"), item[0]),
            )
        ]
    current: dict[str, int] = {}
    last_ts: dict[str, str] = {}
    for e in events:
        if e.get("session") != session or e.get("kind") != "tool_result":
            continue
        # Only shell runs and the evidence tool can form a streak. Other tools
        # now record a reuse key in `cmd` (a path or pattern) so recall can
        # surface "you read this before"; that key is not a command and must
        # never be blocked.
        tool = e.get("tool")
        if isinstance(tool, str) and tool and tool not in STREAK_TOOLS:
            continue
        cmd = e.get("cmd")
        if not isinstance(cmd, str) or not cmd:
            continue
        # loop_key keeps the frozen fingerprint and also folds a trailing `;`.
        cmd = verify.loop_key(cmd)
        if not cmd:
            continue
        ok = e.get("ok")
        # A masked exit 0 (`cmd || true`) or a pipeline that never checked its
        # earlier stages is an unproven attempt, not a success: it counts like a
        # failure so masking cannot disarm the brake. Only a trusted success
        # resets the streak; ok None (unknown) leaves it alone.
        unproven = bool(e.get("unproven")) or (
            ok is True and verify.failure_masked(e.get("cmd") or "")
        )
        if ok is False or unproven:
            current[cmd] = current.get(cmd, 0) + 1
            # Only a real failure timestamp moves the reset clock.
            if ok is False:
                last_ts[cmd] = str(e.get("ts") or "")
        elif ok is True:
            current.pop(cmd, None)
            last_ts.pop(cmd, None)
    out = [
        {"cmd": cmd, "count": n, "last_ts": last_ts.get(cmd, "")}
        for cmd, n in current.items()
        if n > 0
    ]
    out.sort(key=lambda s: (-s["count"], s["cmd"]))
    return out


def block_threshold(cfg: dict) -> int:
    """Prior failures at which the NEXT identical re-run gets blocked."""
    return max(1, int(cfg.get("loop_block_after", 3)) - 1)


def would_block(
    streak_list: list[dict], cfg: dict, now: float | None = None
) -> list[dict]:
    """Streaks that block the next identical run right now.

    A streak that has aged past the reset window is a half-open circuit: the
    probe is allowed, and its outcome decides whether the brake closes again.
    ``now`` is injectable so tests stay deterministic instead of racing a clock.
    """
    t = block_threshold(cfg)
    return [
        s
        for s in streak_list
        if s["count"] >= t and not _aged_out(s["count"], s.get("last_ts"), cfg, now)
    ]


def command_block(
    command: str, cfg: dict, streak_list: list[dict] | None = None, now: float | None = None
) -> dict | None:
    """Return the matching at-threshold streak, if this command must block."""
    fp = verify.loop_key(command)
    if not fp:
        return None
    streak_list = streaks() if streak_list is None else streak_list
    threshold = block_threshold(cfg)
    return next(
        (
            s
            for s in streak_list
            if s["cmd"] == fp
            and s["count"] >= threshold
            and not _aged_out(s["count"], s.get("last_ts"), cfg, now)
        ),
        None,
    )


def _render_age(seconds: float) -> str:
    """Age for the loop view: 12s under a minute, then humanised ("4 minutes")."""
    total = int(max(0.0, seconds))
    if total < 60:
        return f"{total}s"
    return humanize.naturaldelta(total)


def render(streak_list: list[dict], cfg: dict, now: float | None = None) -> str:
    lines = [f"PC loops · session {store.display_text(store.session_id(), 80)}"]
    if not streak_list:
        lines.append("no repeated failing commands")
        lines.append("Nudge: before re-running a failed command, read the error and change something.")
        return "\n".join(lines)
    for s in streak_list[:5]:
        age = _age_seconds(s.get("last_ts"), now)
        when = "" if age is None else f" · last {_render_age(age)} ago"
        lines.append(f"{store.display_text(s['cmd'], 60)} ×{s['count']}{when}")
    threshold = block_threshold(cfg)
    blocking = would_block(streak_list, cfg, now)
    aged_out = [
        s
        for s in streak_list
        if s["count"] >= threshold and s not in blocking
    ]
    if blocking:
        lines.append(f"next identical run will be blocked (loop_block_after={cfg.get('loop_block_after', 3)})")
        lines.append(
            "Nudge: change approach or gather new information — do not re-run unchanged; "
            "raise loop_block_after in .agent-guard/config.json to override."
        )
    elif aged_out:
        # Half-open: the streak still exists but has gone idle, so the probe is
        # allowed. Saying "another failure will trigger a block" here would be a lie.
        lines.append(
            f"{len(aged_out)} streak(s) aged past loop_reset_after_s="
            f"{int(_reset_after(cfg))}s — the next identical run is a probe"
        )
        lines.append(
            "Nudge: the failure is no longer fresh, so a re-run is allowed; "
            "if it fails again the brake re-arms immediately."
        )
    else:
        lines.append("Nudge: another identical failure will trigger a block — change approach now.")
    return "\n".join(lines)
