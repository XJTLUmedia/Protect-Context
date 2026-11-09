"""Evidence ledger: guard_verify runs a command and RECORDS the outcome
(SPEC §1 #2, §4). Failures are never raised — they are recorded; that is the
point.

shell=True is BY DESIGN (SPEC §4): the command is stored and executed verbatim
as the agent issued it (pipes, env prefixes, shell builtins) with the caller's
own privileges. This tool adds evidence, not sandboxing — it must behave
exactly like the agent running the command itself.
"""

from __future__ import annotations

import contextlib
import functools
import math
import os
import re
import shlex
import signal
import subprocess
import tempfile
import time
from pathlib import Path
from typing import Protocol

from . import journal, store

DIGEST_MAX = 2000  # last ≤2000 chars of combined stdout+stderr (SPEC §2)
TIMEOUT_EXIT = 124  # GNU timeout convention for recorded timeouts
TIMEOUT_MIN_S = 1
TIMEOUT_MAX_S = 900  # upper clamp: no single guard_verify call can wedge a session
RECENT_LIMIT_DEFAULT = 5
RECENT_LIMIT_MAX = 20
# Distinct command shapes memoised by loop_key; a session rarely exceeds a few
# dozen, so the cache stays flat while removing the per-row shell scan.
LOOP_KEY_CACHE_MAX = 2048
TAIL_LINES = 4
TAIL_WIDTH = 160

# CSI / OSC / single-character escapes. Color from pytest and compilers would
# otherwise burn the 2000-char digest on sequences the agent cannot use.
_ANSI = re.compile(
    r"\x1b\[[0-?]*[ -/]*[@-~]"
    r"|\x1b\][^\x07]*(?:\x07|\x1b\\)"
    r"|\x1b[@-Z\\-_]"
)
# A trailing failure mask. Applied to the unquoted text only, so
# `echo "|| true"` is not treated as one.
_MASK_TAIL = re.compile(
    r"(?:\|\||;)\s*(?:true|:|exit\s+0)\s*;*\s*$"
)

# Deny-confirm risk patterns (SPEC §5 list, anchored to exact targets).
# guard_verify consults them to LOG (never block — advisory-first): running a
# risky command through the evidence ledger gets journaled as a risk entry.
# Anchoring matches the extension's fingerprint.ts: benign commands (man
# pages, greps, rmmod, absolute-path rm -rf) must not match.
RISK_PATTERNS: list[tuple[str, re.Pattern[str]]] = [
    ("rm -rf /", re.compile(r"rm -rf /(?:\s|$)")),
    ("rm -rf ~", re.compile(r"rm -rf ~(?:/(?:\s|$)|\s|$)")),
    ("git push --force", re.compile(r"git push\b[^|;&]*--force(?!-with-lease)")),
    ("git reset --hard", re.compile(r"git reset --hard")),
    ("mkfs", re.compile(r"\bmkfs[^|;&]*/dev/")),
    ("dd of=/dev/", re.compile(r"\bdd\b[^|;&]*\bof=/dev/")),
    ("chmod -R 777 /", re.compile(r"chmod -R 777 /(?:\s|$)")),
    ("curl | sh", re.compile(r"curl\b[^|;&]*\|\s*(sudo\s+)?(ba|z|da)?sh\b")),
    ("sudo rm", re.compile(r"\bsudo\s+rm(?:\s|$)")),
]


def match_risk(command: str) -> str | None:
    """Return the matched risk-pattern name, or None (mirrors the extension)."""
    cmd = store.fingerprint(command)
    for name, pattern in RISK_PATTERNS:
        if pattern.search(cmd):
            return name
    return None


def strip_ansi(text: str) -> str:
    """Drop terminal color and cursor sequences from captured output."""
    return _ANSI.sub("", text)


class _ShellShape:
    """Unquoted text plus whether a real pipe or ``||`` was seen."""

    __slots__ = ("outside", "pipe", "or_op", "closed")

    def __init__(self, outside: str, pipe: bool, or_op: bool, closed: bool) -> None:
        self.outside = outside
        self.pipe = pipe
        self.or_op = or_op
        self.closed = closed


def shell_shape(command: str) -> _ShellShape:
    """Scan a shell command without executing it.

    Quoted regions are ignored, so a pipe or ``|| true`` inside quotes does
    not count. A backslash escapes the next character outside quotes. This is
    a diagnostic scan, not a shell parser: ``$(...)`` is not special.
    """
    if not isinstance(command, str):
        return _ShellShape("", False, False, True)
    outside: list[str] = []
    pipe = False
    or_op = False
    quote: str | None = None
    i = 0
    length = len(command)
    while i < length:
        ch = command[i]
        if quote == "'":
            if ch == "'":
                quote = None
            i += 1
            continue
        if quote == '"':
            if ch == "\\" and i + 1 < length:
                i += 2
                continue
            if ch == '"':
                quote = None
            i += 1
            continue
        if ch in {"'", '"'}:
            quote = ch
            outside.append(" ")
            i += 1
            continue
        if ch == "\\" and i + 1 < length:
            outside.append(command[i + 1])
            i += 2
            continue
        if ch == "|":
            if i + 1 < length and command[i + 1] == "|":
                or_op = True
                outside.append("||")
                i += 2
                continue
            pipe = True
            outside.append("|")
            i += 1
            continue
        outside.append(ch)
        i += 1
    return _ShellShape("".join(outside), pipe, or_op, quote is None)


def _masked_shape(shape: _ShellShape) -> bool:
    """Mask test on an already-scanned command (avoids a second full scan)."""
    return _MASK_TAIL.search(store.fingerprint(shape.outside)) is not None


def failure_masked(command: str) -> bool:
    """True when the command ends by forcing success (``|| true``, ``; :``, …)."""
    return _masked_shape(shell_shape(command))


def trust_issues(command: str) -> list[str]:
    """Reasons an exit-0 result must not be cited as proof. Empty when clean."""
    if not isinstance(command, str) or not command.strip():
        return []
    shape = shell_shape(command)
    masked = _masked_shape(shape)
    issues: list[str] = []
    if masked:
        issues.append(
            "The command masks failure (`|| true`, `|| :`, `; true`, or similar), "
            "so exit 0 does not prove the check passed."
        )
    if shape.pipe:
        issues.append(
            "The command contains a pipeline. Without `set -o pipefail`, the shell "
            "exit status is only the last stage, so an earlier failure can still "
            "look like success."
        )
    elif shape.or_op and not masked:
        issues.append(
            "The command uses `||`. Exit 0 can come from a later alternative "
            "rather than the check you meant to run."
        )
    return issues


def pipefail_rewrite(command: object) -> str:
    """Exact trusted rewrite for a piped command, or "" when it does not apply.

    A pipeline reports only its last stage, so the recorded exit status cannot
    prove the check. POSIX sh has no ``pipefail``, so the rewrite runs the same
    command under bash instead of asking the agent to hand-edit a pipeline.
    """
    if not isinstance(command, str) or "pipefail" in command:
        return ""
    if not shell_shape(command).pipe:
        return ""
    return f"bash -o pipefail -c {shlex.quote(command)}"


def loop_key(command: str) -> str:
    """Streak identity on top of the frozen fingerprint.

    ``store.fingerprint`` itself is unchanged (SPEC §2). Two retries that are
    the same command for the loop brake collapse here: a trailing ``;``
    outside quotes (`pytest -q` vs `pytest -q;`), and a trailing failure mask
    (`npm test` vs `npm test || true`). A semicolon or mask inside quotes is
    left alone. Callers must not treat a masked exit 0 as a reset — see
    ``failure_masked``.
    """
    if not isinstance(command, str):
        return ""
    return _loop_key_cached(command)


@functools.lru_cache(maxsize=LOOP_KEY_CACHE_MAX)
def _loop_key_cached(command: str) -> str:
    """Pure worker for ``loop_key``: streaks re-key the same few commands."""
    fp = store.fingerprint(command)
    while fp.endswith(";") and shell_shape(fp).closed:
        fp = fp[:-1].rstrip()
    outside = store.fingerprint(shell_shape(fp).outside)
    stripped = _MASK_TAIL.sub("", outside).rstrip()
    if stripped and stripped != outside:
        return stripped
    return fp


def outcome_label(entry: dict) -> str:
    """``ok``, ``FAIL``, or ``UNTRUSTED`` (exit 0 that does not prove the check)."""
    if entry.get("ok") is not True:
        return "FAIL"
    cmd = entry.get("cmd")
    if trust_issues(cmd if isinstance(cmd, str) else ""):
        return "UNTRUSTED"
    return "ok"


def _next_id(runs: list[dict]) -> str:
    mx = 0
    for r in runs:
        rid = str(r.get("id", ""))
        if rid.startswith("ev-"):
            try:
                mx = max(mx, int(rid[3:]))
            except ValueError:
                pass
    return f"ev-{mx + 1:04d}"


def _clamp_timeout(timeout_s: int) -> int:
    try:
        t = int(timeout_s)
    except (TypeError, ValueError):
        return 180
    return max(TIMEOUT_MIN_S, min(TIMEOUT_MAX_S, t))


class _Killable(Protocol):
    """The only child-process surface the kill helper needs."""

    pid: int

    def kill(self) -> None:
        pass


def _terminate_timed_out_process(p: _Killable) -> None:
    """Kill the POSIX process group, or the child process on other platforms."""
    if os.name == "posix":
        with contextlib.suppress(OSError):
            os.killpg(os.getpgid(p.pid), signal.SIGKILL)
            # The group kill reached the child, so the fallback below is moot.
            return
    with contextlib.suppress(OSError):
        p.kill()


def _wait_for_exit(process: subprocess.Popen, timeout_s: float) -> tuple[bool, int | None]:
    """Return ``(timed_out, returncode)``.

    A child that survives the first kill must not wedge the caller: the second
    wait is bounded, and a still-unreaped process is reported as a timeout.
    """
    try:
        process.wait(timeout=timeout_s)
        return False, process.returncode
    except subprocess.TimeoutExpired:
        pass
    _terminate_timed_out_process(process)
    try:
        process.wait(timeout=5)
    except subprocess.TimeoutExpired:
        _terminate_timed_out_process(process)
        try:
            process.wait(timeout=2)
        except subprocess.TimeoutExpired:
            return True, None
    return True, process.returncode


def _tail_file_text(stream, max_chars: int = DIGEST_MAX) -> str:
    """Decode at most the final ``max_chars`` from a binary temporary file."""
    stream.flush()
    size = stream.seek(0, os.SEEK_END)
    # A UTF-8 code point uses at most four bytes. The small overlap avoids
    # beginning inside a multibyte sequence before the final character slice.
    stream.seek(max(0, size - max_chars * 4 - 4))
    return stream.read().decode("utf-8", errors="replace")[-max_chars:]


def run_verify(command: str, timeout_s: int = 180) -> dict:
    """Run `command` via the shell and append it to verify_runs.jsonl. NEVER
    raises on nonzero exit — records it. A timeout is recorded as exit 124
    with ok=False.

    timeout_s is clamped to [TIMEOUT_MIN_S, TIMEOUT_MAX_S] so a model-supplied
    value cannot wedge the session. On POSIX, the child starts in its own
    process group and the whole group is killed on timeout. Other platforms
    use ``Popen.kill``. Output is redirected to temporary files and only the
    bounded tail is read into memory.
    """
    if not isinstance(command, str) or not command.strip():
        raise ValueError("verification command must not be blank")
    timeout_s = _clamp_timeout(timeout_s)
    cwd = os.getcwd()
    t0 = time.monotonic()
    timed_out = False
    exit_code = 127
    spawn_error: str | None = None
    combined = ""
    # stdin is closed on purpose. MCP serves JSON-RPC on this process's stdin;
    # a command that inherited it could swallow the protocol or hang until the
    # timeout. Verification is not interactive — shell redirects still work.
    popen_kwargs: dict = {
        "stdin": subprocess.DEVNULL,
        "stdout": None,
        "stderr": None,
        "cwd": cwd,
    }
    if os.name == "posix":
        popen_kwargs["start_new_session"] = True
    try:
        with tempfile.TemporaryFile() as out_file, tempfile.TemporaryFile() as err_file:
            popen_kwargs["stdout"] = out_file
            popen_kwargs["stderr"] = err_file
            try:
                # shell=True is the documented design (SPEC §4): the command
                # runs verbatim with the caller's privileges. An evidence
                # ledger, not a sandbox.
                # pi-lens-ignore: python-command-injection
                process = subprocess.Popen(command, shell=True, **popen_kwargs)  # noqa: S602
            except OSError as exc:
                spawn_error = f"{exc.__class__.__name__}: {exc}"
                process = None
            if process is not None:
                timed_out, returncode = _wait_for_exit(process, timeout_s)
                combined = strip_ansi(
                    _tail_file_text(out_file) + _tail_file_text(err_file)
                )[-DIGEST_MAX:]
                if timed_out or returncode is None:
                    timed_out = True
                    exit_code = TIMEOUT_EXIT
                else:
                    exit_code = returncode
    except OSError as exc:
        spawn_error = f"{exc.__class__.__name__}: {exc}"
    if spawn_error:
        combined = f"[guard_verify: could not run command] {spawn_error}"
        exit_code = 127
        timed_out = False
    ok = exit_code == 0 and not timed_out
    if timed_out:
        combined = (combined + f"\n[guard_verify: timeout after {timeout_s}s]")[-DIGEST_MAX:]

    risk = match_risk(command)
    if risk:
        # Advisory-first: risky verify commands are logged for the owner, never blocked.
        try:
            journal.add("risk", f"guard_verify ran a command matching risk pattern '{risk}': {command}")
        except Exception:  # journal is best-effort; never block the evidence write
            pass

    def _make_entry() -> dict:
        # Id allocation happens inside the flock (store.locked_append) so two
        # concurrent guard_verify calls can never read the same max id.
        return {
            "id": _next_id(store.read_jsonl(store.verify_path())),
            "ts": store.now_ts(),
            "session": store.session_id(),
            "cmd": command,
            "exit": exit_code,
            "ok": ok,
            "digest": combined,
            "ms": int((time.monotonic() - t0) * 1000),
        }

    # cwd is for the report the caller is holding. It is not part of the frozen
    # ledger schema, so it is attached after the append.
    stamp_before = _stamp_json()
    known_total = _cached_total(stamp_before)
    recorded = store.locked_append(store.verify_path(), _make_entry)
    if known_total is not None:
        # This run is itself a valid row, so the sidecar can advance instead of
        # going stale: the next process need not parse the ledger to count it.
        _remember_total(known_total + 1)
    shown = dict(recorded)
    shown["cwd"] = cwd
    return shown


def _scoped(runs: list[dict], session: str | None) -> list[dict]:
    if session is None:
        return runs
    return [r for r in runs if r.get("session") == session]


_VALID_RUNS_CACHE: dict[tuple, list[dict]] = {}


def _valid_row(row: dict) -> bool:
    """True when a ledger row is a complete, well-typed evidence row."""
    required_strings = ("id", "ts", "session", "cmd", "digest")
    if not all(isinstance(row.get(key), str) for key in required_strings):
        return False
    if not isinstance(row.get("ok"), bool):
        return False
    exit_code = row.get("exit")
    ms = row.get("ms")
    return not (
        isinstance(exit_code, bool)
        or not isinstance(exit_code, (int, float))
        or not math.isfinite(exit_code)
        or isinstance(ms, bool)
        or not isinstance(ms, (int, float))
        or not math.isfinite(ms)
    )


def _total_cache_path() -> Path:
    return store.guard_dir() / "verify_count.json"


def _stamp_json() -> list:
    return [list(part) for part in store.ledger_stamp(store.verify_path())]


def _cached_total(stamp: list) -> int | None:
    """Total evidence rows recorded for this exact ledger stamp, if known.

    A cold process would otherwise parse the whole ledger just to print "of N".
    The sidecar is stamp-verified: any append, rotation, or foreign writer makes
    it stale, and a stale sidecar is discarded rather than trusted.
    """
    data = store.read_json(_total_cache_path())
    if not isinstance(data, dict) or data.get("stamp") != stamp:
        return None
    total = data.get("total")
    if isinstance(total, bool) or not isinstance(total, int) or total < 0:
        return None
    return total


def _remember_total(total: int) -> None:
    # A read-only tool must never create the store: caching a count in a fresh
    # repo would violate the read-only annotation contract.
    if not store.guard_dir().is_dir():
        return
    try:
        store.write_json(_total_cache_path(), {"stamp": _stamp_json(), "total": total})
    except (OSError, ValueError):
        return  # a cache write must never break the read path


def _valid_runs() -> list[dict]:
    """Typed evidence rows only; malformed JSON objects are ignored safely.

    The filtered list is memoized against the ledger stamps: validation walks
    every row, so on a capped ledger it costs as much as the parse it follows
    (measured ~11 ms per call at 24k rows). The cache only holds immutable
    values, and any append changes a stamp.
    """
    stamp = store.ledger_stamp(store.verify_path())
    cached = _VALID_RUNS_CACHE.get(stamp)
    if cached is not None:
        return cached
    valid: list[dict] = [row for row in store.read_jsonl(store.verify_path()) if _valid_row(row)]
    if len(_VALID_RUNS_CACHE) > 4:
        _VALID_RUNS_CACHE.clear()
    _VALID_RUNS_CACHE[stamp] = valid
    return valid


def recent_with_total(
    limit: int = RECENT_LIMIT_DEFAULT, session: str | None = None
) -> tuple[list[dict], int]:
    """``(slice, total)`` from ONE ledger read.

    Every surface that renders both a count and a slice (status, CLI evidence,
    MCP guard_evidence) would otherwise parse the whole ledger twice.
    """
    try:
        bounded_limit = max(0, min(int(limit), RECENT_LIMIT_MAX))
    except (TypeError, ValueError):
        bounded_limit = RECENT_LIMIT_DEFAULT
    if session is None and bounded_limit > 0:
        stamp = _stamp_json()
        total = _cached_total(stamp)
        if total is not None:
            tail = store.tail_jsonl(store.verify_path(), bounded_limit)
            window = [row for row in (tail or []) if _valid_row(row)]
            if len(window) == bounded_limit:
                return window, total
        runs = _valid_runs()
        _remember_total(len(runs))
        return runs[-bounded_limit:], len(runs)
    runs = _scoped(_valid_runs(), session)
    total = len(runs)
    if bounded_limit <= 0:
        return [], total
    return runs[-bounded_limit:], total


def recent(limit: int = RECENT_LIMIT_DEFAULT, session: str | None = None) -> list[dict]:
    """Recent runs, oldest first. session=None → the whole ledger; a session
    label scopes to that session's runs (parity with the extension, which
    counts evidence per session)."""
    return recent_with_total(limit, session)[0]


def count(session: str | None = None) -> int:
    """Number of recorded runs; session=None → whole ledger."""
    if session is None:
        stamp = _stamp_json()
        cached = _cached_total(stamp)
        if cached is not None:
            return cached
        total = len(_valid_runs())
        _remember_total(total)
        return total
    return len(_scoped(_valid_runs(), session))


def find(evidence_id: object) -> dict | None:
    """One recorded run by id (case-insensitive), or None.

    The ledger view is a window; this is the read path for an older row whose
    failure text would otherwise be unreachable after the fact.
    """
    wanted = str(evidence_id or "").strip().casefold()
    if not wanted:
        return None
    for row in reversed(_valid_runs()):
        rid = row.get("id")
        if isinstance(rid, str) and rid.casefold() == wanted:
            return row
    return None


def _tail_lines(digest: str, n: int = TAIL_LINES, width: int = TAIL_WIDTH) -> list[str]:
    """Last non-blank digest lines. Failure diagnostics live at the END of
    output (and the digest itself is already the last ≤2000 chars), so a
    one-line head preview is spent on banners and hides the assertion."""
    lines = [ln.strip() for ln in digest.splitlines() if ln.strip()]
    return [store.display_text(ln, width) for ln in lines[-n:]]


def _failure_guidance(entry: dict) -> tuple[str, str]:
    """``(why, fix)`` for a recorded failure. Both are one line of advice."""
    exit_code = entry.get("exit")
    digest = str(entry.get("digest") or "")
    low = digest.lower()
    cmd = str(entry.get("cmd") or "")
    if digest.startswith("[guard_verify: could not run command]"):
        return (
            "The verification runner could not start the command, so nothing was verified.",
            "Check that the working directory still exists and the command is a valid shell string, then re-verify.",
        )
    if exit_code == TIMEOUT_EXIT or "guard_verify: timeout" in low:
        return (
            f"Timed out (recorded as exit {TIMEOUT_EXIT}). The child process group was killed.",
            "Fix the hang, or pass a larger timeout_s (max 900). Stdin is closed, so a command that reads input sees EOF instead of waiting.",
        )
    if exit_code == 127 or "command not found" in low or "not found" in low:
        return (
            "Exit 127 usually means the program is not on PATH.",
            "Check the executable name, the cwd above, and that the tool is installed (`guard_preflight` lists common tools). Then re-verify.",
        )
    if exit_code == 126:
        return (
            "Exit 126 means the command was found but could not be executed.",
            "Check that the path is a program rather than a directory, and that it has execute permission.",
        )
    if isinstance(exit_code, int) and not isinstance(exit_code, bool) and exit_code < 0:
        return (
            f"The process was killed by signal {-exit_code}.",
            "Read the tail for the crash. Do not treat this as a passing run.",
        )
    if "syntax error" in low and ("[[" in cmd or "[[" in digest):
        return (
            "The shell rejected the command. guard_verify uses `/bin/sh`, which may not be bash.",
            "Rewrite without bashisms, or run `bash -c '...'` explicitly, then re-verify.",
        )
    if "no such file" in low or "cannot find the path" in low:
        return (
            "A path in the command does not exist from this working directory.",
            "Paths are relative to the cwd above. `cd` inside the command, or pass a path that exists, then re-verify.",
        )
    return (
        f"Exit {exit_code} — the command failed.",
        "Read the tail, fix the cause, and re-verify the same claim. Do not claim success from this id.",
    )


def render_entry(entry: dict) -> str:
    """Single-run view (ends with Nudge). Failures say why and how to re-run.

    Exit 0 is recorded honestly, but a pipeline or a failure mask is labelled
    UNTRUSTED so it cannot be cited as proof.
    """
    label = outcome_label(entry)
    evidence_id = store.display_text(entry.get("id"), 40)
    lines = [
        f"PC verify {evidence_id} · exit {entry.get('exit')} · {label} · {entry.get('ms')}ms"
    ]
    cwd = entry.get("cwd")
    if isinstance(cwd, str) and cwd.strip():
        lines.append(f"cwd: {store.display_text(cwd, 200)}")
    cmd = store.display_text(entry.get("cmd"), 160)
    if cmd:
        lines.append(f"cmd: {cmd}")
    digest = str(entry.get("digest") or "")
    if label == "FAIL":
        tail = _tail_lines(digest)
        lines.append("tail:" if tail else "tail: (no output)")
        lines.extend(f"  {ln}" for ln in tail)
        why, fix = _failure_guidance(entry)
        lines.append(f"why: {why}")
        lines.append(f"fix: {fix}")
        lines.append("Nudge: do not claim success from this run — fix the cause and re-verify.")
        return "\n".join(lines)
    first = next((ln.strip() for ln in digest.splitlines() if ln.strip()), "")
    lines.append("digest: " + (store.display_text(first, 160) if first else "(no output)"))
    if label == "UNTRUSTED":
        lines.append("why: " + " ".join(trust_issues(str(entry.get("cmd") or ""))))
        rewrite = pipefail_rewrite(entry.get("cmd"))
        if rewrite:
            lines.append(
                "fix: re-run exactly this so every pipeline stage counts: "
                f"{rewrite} — do not cite this id as proof."
            )
        else:
            lines.append(
                "fix: drop the trailing failure mask and re-run the command as-is. "
                "Do not cite this id as proof."
            )
        lines.append("Nudge: this run is recorded, but exit 0 here is not evidence of success.")
        return "\n".join(lines)
    if not digest.strip():
        lines.append(
            "Nudge: cite this evidence id when claiming success. "
            "The command printed nothing — confirm it actually checks the claim."
        )
    else:
        lines.append("Nudge: cite this evidence id when claiming success.")
    return "\n".join(lines)


def _last_digest_line(digest: object) -> str:
    """Last non-blank digest line, bounded: the failure payload in one line."""
    text = digest if isinstance(digest, str) else ""
    for line in reversed(text.splitlines()):
        if line.strip():
            return store.display_text(line.strip(), TAIL_WIDTH)
    return ""


def render_recent(runs: list[dict], total: int) -> str:
    """Compact ledger view (ends with Nudge).

    A row that is not ok carries the last line of its digest, so a past failure
    can be understood instead of only counted; UNTRUSTED marks exit 0 that does
    not prove the check (pipeline or failure mask).
    """
    lines = [f"PC evidence · last {len(runs)} of {total}"]
    labels: list[str] = []
    for r in runs:
        cmd = store.display_text(r.get("cmd"), 60)
        evidence_id = store.display_text(r.get("id"), 40)
        label = outcome_label(r)
        labels.append(label)
        lines.append(f"{evidence_id} {label} exit {r.get('exit')} · {r.get('ms')}ms · {cmd}")
        if label != "ok":
            last = _last_digest_line(r.get("digest"))
            if last:
                lines.append(f"  └ {last}")
    # One nudge for the worst row present: telling the model to cite evidence
    # when the window is all failures would be actively wrong.
    if "FAIL" in labels:
        lines.append(
            "Nudge: a FAIL row proves the check failed — fix the cause and "
            "re-verify before claiming success."
        )
    elif "UNTRUSTED" in labels:
        lines.append(
            "Nudge: UNTRUSTED rows exited 0 but do not prove the check — "
            "re-run them without a pipe or `|| true`."
        )
    else:
        lines.append("Nudge: cite evidence ids, not memory, when claiming success.")
    return "\n".join(lines)
