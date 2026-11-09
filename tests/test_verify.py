"""Verify runner: records true/false outcomes, digest rules, timeout (SPEC §7)."""

import json
import os
import shutil
import subprocess
import sys
import time

import pytest

from protect_context import store, verify


def test_true_is_recorded_ok():
    e = verify.run_verify("true")
    assert e["ok"] is True
    assert e["exit"] == 0
    assert e["id"] == "ev-0001"
    assert e["cmd"] == "true"
    assert isinstance(e["ms"], int)
    assert e["session"] == "test-session"


def test_false_recorded_never_raises():
    e = verify.run_verify("false")
    assert e["ok"] is False
    assert e["exit"] == 1


def test_blank_command_is_rejected_without_evidence():
    with pytest.raises(ValueError, match="must not be blank"):
        verify.run_verify("  \t\n")
    assert verify.count() == 0


def test_ledger_sequence_and_ids():
    verify.run_verify("true")
    e2 = verify.run_verify("echo hello")
    assert e2["id"] == "ev-0002"
    runs = verify.recent()
    assert [r["id"] for r in runs] == ["ev-0001", "ev-0002"]
    assert verify.count() == 2
    assert verify.recent(limit=1)[0]["id"] == "ev-0002"


def test_digest_is_stdout_then_stderr():
    e = verify.run_verify("printf OUT; printf ERR 1>&2")
    assert e["digest"] == "OUTERR"


def test_digest_truncated_to_last_2000_chars():
    e = verify.run_verify("head -c 3000 /dev/zero | tr '\\0' 'x'")
    assert len(e["digest"]) == 2000
    assert e["digest"] == "x" * 2000


def test_large_output_uses_bounded_tail_and_preserves_stdout_then_stderr():
    e = verify.run_verify(
        "head -c 200000 /dev/zero | tr '\\0' 'x'; printf 'stderr-tail' 1>&2"
    )

    assert len(e["digest"]) == verify.DIGEST_MAX
    assert e["digest"].endswith("stderr-tail")
    assert e["digest"] == "x" * (verify.DIGEST_MAX - len("stderr-tail")) + "stderr-tail"


def test_timeout_recorded_as_124():
    e = verify.run_verify("sleep 5", timeout_s=1)
    assert e["ok"] is False
    assert e["exit"] == 124
    assert "timeout" in e["digest"].lower()
    assert e["ms"] >= 900


def test_persisted_ledger_schema():
    e = verify.run_verify("true")
    rows = store.read_jsonl(store.verify_path())
    assert len(rows) == 1
    r = rows[0]
    assert set(r) == {"id", "ts", "session", "cmd", "exit", "ok", "digest", "ms"}
    assert r["id"] == e["id"]


def test_render_entry_nudge():
    good = verify.render_entry(verify.run_verify("true"))
    assert good.rstrip().splitlines()[-1].startswith("Nudge:")
    assert "ev-0001" in good
    bad = verify.render_entry(verify.run_verify("false"))
    assert "FAIL" in bad and "Nudge:" in bad


def test_recent_and_count_scope_to_session():
    """Evidence count/last-verify are session-scoped (parity with the widget)."""
    e1 = verify.run_verify("true")
    other = dict(store.read_jsonl(store.verify_path())[0], session="someone-else")
    store.append_jsonl(store.verify_path(), other)
    assert verify.count() == 2  # whole ledger
    assert verify.count(session="someone-else") == 1
    assert verify.recent(1, session="test-session")[0]["id"] == e1["id"]
    assert verify.recent(1, session="someone-else")[0]["session"] == "someone-else"


def test_recent_limit_is_clamped_and_malformed_value_is_safe():
    for _ in range(25):
        verify.run_verify("true")

    assert len(verify.recent(10**9)) == verify.RECENT_LIMIT_MAX
    assert verify.recent(-1) == []
    assert len(verify.recent("not-a-number")) == verify.RECENT_LIMIT_DEFAULT  # type: ignore[arg-type]


def test_malformed_evidence_objects_are_ignored_by_views_and_count():
    store.ensure()
    store.verify_path().write_text(
        json.dumps({"session": "test-session", "ok": False}) + "\n",
        encoding="utf-8",
    )

    assert verify.recent() == []
    assert verify.count() == 0
    assert verify.run_verify("true")["id"] == "ev-0001"


def test_timeout_clamped_to_sane_range():
    """A model-supplied timeout can never wedge the session (1–900s clamp)."""
    assert verify._clamp_timeout(10**9) == verify.TIMEOUT_MAX_S
    assert verify._clamp_timeout(0) == verify.TIMEOUT_MIN_S
    assert verify._clamp_timeout(-5) == verify.TIMEOUT_MIN_S
    assert verify._clamp_timeout("bogus") == 180  # type: ignore[arg-type]
    assert verify._clamp_timeout(180) == 180


def test_match_risk_anchors_catastrophic_literals():
    """Benign lookalikes must not match (confirm-fatigue parity with the ext)."""
    assert verify.match_risk("rm -rf /") == "rm -rf /"
    assert verify.match_risk("rm -rf /tmp/build-cache") is None
    assert verify.match_risk("rm -rf ~/.cache/pip") is None
    assert verify.match_risk("sudo rmmod uvcvideo") is None
    assert verify.match_risk("man mkfs.ext4") is None
    assert verify.match_risk("grep -rn mkfs docs/") is None
    assert verify.match_risk("mkfs.ext4 /dev/sda1") == "mkfs"
    assert verify.match_risk("sudo rm -rf build") == "sudo rm"


# ---- timeout clamp + process-group kill (adversarial hardening) --------------

def test_timeout_clamped_to_sane_upper_bound(monkeypatch):
    """A model-supplied timeout_s=86400 must not wedge the session; the upper
    clamp applies (pinned here with a 1s ceiling for test speed)."""
    monkeypatch.setattr(verify, "TIMEOUT_MAX_S", 1)
    e = verify.run_verify("sleep 5", timeout_s=100000)
    assert e["ok"] is False and e["exit"] == 124
    assert e["ms"] < 4000
    assert "timeout" in e["digest"].lower()


def test_timeout_uses_child_kill_on_non_posix(monkeypatch):
    class Process:
        pid = 0
        killed = False

        def kill(self):
            self.killed = True

    process = Process()
    monkeypatch.setattr(verify.os, "name", "nt")

    verify._terminate_timed_out_process(process)

    assert process.killed is True


def _marker_alive(marker: str) -> bool:
    """True when a process whose argv[0] == marker exists (Linux /proc scan;
    zombies have an empty cmdline, so they never count as alive)."""
    for pid in os.listdir("/proc"):
        if not pid.isdigit():
            continue
        try:
            with open(f"/proc/{pid}/cmdline", "rb") as f:
                argv0 = f.read().split(b"\0")[0].decode("utf-8", "replace")
        except OSError:
            continue
        if argv0 == marker:
            return True
    return False


def test_timeout_kills_whole_process_group():
    """Backgrounded grandchildren must not survive as runaway orphans: the
    anti-loop guardrail tool must not create the runaway processes it guards
    against. The child gets its own process group and the WHOLE group is
    SIGKILLed on timeout."""
    if not os.path.isdir("/proc") or shutil.which("bash") is None:
        pytest.skip("needs Linux /proc and bash")
    marker = f"pc-orphan-{os.getpid()}"
    e = verify.run_verify(f"bash -c 'exec -a {marker} sleep 30' & wait", timeout_s=1)
    assert e["exit"] == 124 and e["ok"] is False
    deadline = time.monotonic() + 3
    while time.monotonic() < deadline and _marker_alive(marker):
        time.sleep(0.05)
    assert not _marker_alive(marker), "timeout left an orphaned grandchild running"


# ---- failure previews show the TAIL (token-ux) --------------------------------

def test_render_entry_failure_shows_tail_not_head():
    """Failure diagnostics live at the END of output. A long banner must not
    be the only thing the report shows, and the report must say how to re-run."""
    cmd = "printf 'banner line\\n'; printf 'actual error at the end\\n' 1>&2; exit 3"
    e = verify.run_verify(cmd)
    assert e["ok"] is False
    text = verify.render_entry(e)
    assert "actual error at the end" in text
    assert "why:" in text and "fix:" in text
    assert "cwd:" in text
    assert text.rstrip().splitlines()[-1].startswith("Nudge:")

    long_cmd = (
        "i=0; while [ \"$i\" -lt 30 ]; do echo banner-$i; i=$((i+1)); done; "
        "echo 'actual error at the end' 1>&2; exit 3"
    )
    long_text = verify.render_entry(verify.run_verify(long_cmd))
    assert "actual error at the end" in long_text
    assert "banner-0" not in long_text


def test_pipeline_exit_zero_is_recorded_but_untrusted():
    """`false | true` exits 0 because the shell reports only the last stage.
    The ledger keeps that honest exit code and the report refuses to call it proof."""
    e = verify.run_verify("false | true")
    assert e["ok"] is True and e["exit"] == 0
    assert verify.outcome_label(e) == "UNTRUSTED"
    text = verify.render_entry(e)
    assert "UNTRUSTED" in text and "pipefail" in text
    assert "not evidence of success" in text
    assert text.rstrip().splitlines()[-1].startswith("Nudge:")
    # The frozen ledger row is unchanged: cwd is a report field, not a column.
    row = store.read_jsonl(store.verify_path())[-1]
    assert set(row) == {"id", "ts", "session", "cmd", "exit", "ok", "digest", "ms"}
    assert row["ok"] is True


def test_failure_mask_is_untrusted():
    e = verify.run_verify("false || true")
    assert e["ok"] is True
    text = verify.render_entry(e)
    assert verify.outcome_label(e) == "UNTRUSTED"
    assert "masks failure" in text
    assert "Do not cite this id as proof." in text


def test_quoted_pipe_and_quoted_mask_stay_trusted():
    piped = verify.run_verify("echo 'a|b'")
    assert piped["ok"] is True
    assert verify.outcome_label(piped) == "ok"
    assert "UNTRUSTED" not in verify.render_entry(piped)
    masked = verify.run_verify('echo "|| true"')
    assert verify.outcome_label(masked) == "ok"
    assert verify.failure_masked('echo "|| true"') is False
    assert verify.failure_masked("false || true") is True
    assert verify.failure_masked("false; exit 0") is True
    assert verify.loop_key("npm test; exit 0") == "npm test"


def test_missing_command_explains_how_to_fix():
    text = verify.render_entry(verify.run_verify("definitely-missing-binary-xyz"))
    assert "FAIL" in text
    assert "PATH" in text
    assert "cwd:" in text
    assert "why:" in text and "fix:" in text
    assert "guard_preflight" in text


def test_ansi_sequences_do_not_consume_the_digest():
    e = verify.run_verify(r"printf '\033[31mRED\033[0m'")
    assert "RED" in e["digest"]
    assert "\x1b" not in e["digest"]


def test_runner_oserror_is_recorded_as_evidence(monkeypatch):
    def boom(*_args, **_kwargs):
        raise OSError("cwd gone")

    monkeypatch.setattr(verify.subprocess, "Popen", boom)
    e = verify.run_verify("true")
    assert e["ok"] is False and e["exit"] == 127
    assert "could not run command" in e["digest"]
    assert verify.count() == 1
    assert "could not start" in verify.render_entry(e)


def test_timeout_does_not_hang_when_the_child_is_not_reaped(monkeypatch):
    class Fake:
        def __init__(self):
            self.returncode = None
            self.waits = 0

        def wait(self, timeout=None):
            self.waits += 1
            raise subprocess.TimeoutExpired("cmd", timeout or 1)

        def kill(self):
            return None

    fake = Fake()
    monkeypatch.setattr(verify.subprocess, "Popen", lambda *_a, **_k: fake)
    monkeypatch.setattr(verify, "_terminate_timed_out_process", lambda _p: None)
    e = verify.run_verify("sleep 100", timeout_s=1)
    assert e["exit"] == 124 and e["ok"] is False
    assert fake.waits == 3
    assert e["ms"] < 4000


def test_verify_does_not_inherit_an_open_stdin():
    """A command that reads stdin must see EOF. Inheriting the parent stdin
    would hang `read` (and, under MCP, could consume the protocol stream)."""
    script = (
        "import json,sys\n"
        "from protect_context import verify\n"
        "e = verify.run_verify('read line', timeout_s=3)\n"
        "json.dump({'exit': e['exit'], 'ms': e['ms']}, sys.stdout)\n"
    )
    read_fd, write_fd = os.pipe()
    try:
        proc = subprocess.Popen(
            [sys.executable, "-c", script],
            stdin=read_fd,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
        )
        os.close(read_fd)
        read_fd = -1
        out, err = proc.communicate(timeout=8)
    finally:
        if read_fd >= 0:
            os.close(read_fd)
        os.close(write_fd)
    assert proc.returncode == 0, err.decode("utf-8", "replace")
    payload = json.loads(out)
    assert payload["exit"] != 124
    assert payload["ms"] < 1500


def test_trust_issues_reports_a_failure_mask_once():
    """A masked command is one issue, not a mask plus an `||` duplicate."""
    issues = verify.trust_issues("npm test || true")
    assert len(issues) == 1
    assert "masks failure" in issues[0]

    piped = verify.trust_issues("pytest -q | tail -5")
    assert len(piped) == 1 and "pipeline" in piped[0]


def test_recent_with_total_reads_the_ledger_once(monkeypatch):
    verify.run_verify("true")
    calls = []
    original = store.read_jsonl

    def counting(path):
        calls.append(path)
        return original(path)

    monkeypatch.setattr(store, "read_jsonl", counting)
    runs, total = verify.recent_with_total(5)
    assert len(calls) == 1, "count and slice must come from one parse"
    assert total == 1 and runs[0]["id"] == "ev-0001"


def test_loop_key_is_memoised_and_still_guards_odd_input():
    verify._loop_key_cached.cache_clear()
    assert verify.loop_key("pytest -q") == "pytest -q"
    info = verify._loop_key_cached.cache_info()
    assert verify.loop_key("pytest -q") == "pytest -q"
    assert verify._loop_key_cached.cache_info().hits == info.hits + 1

    assert verify.loop_key("npm test || true") == "npm test"
    assert verify.loop_key("pytest -q;") == "pytest -q"
    assert verify.loop_key(None) == ""  # type: ignore[arg-type]


def test_recent_view_shows_the_failure_payload_not_just_the_label():
    ok = verify.run_verify("true")
    bad = verify.run_verify("definitely-missing-binary-xyz")
    text = verify.render_recent(verify.recent(5), 2)
    assert f"{ok['id']} ok" in text
    assert f"{bad['id']} FAIL" in text
    assert "└" in text, "a non-ok row must carry its last digest line"
    assert "not found" in text, "the failure text is the payload, not the label"
    assert "fix the cause and re-verify" in text.lower()


def test_untrusted_row_nudges_failure_and_untrusted_separately():
    verify.run_verify("false")
    text = verify.render_recent(verify.recent(1), 1)
    assert "proves the check failed" in text
    assert "cite evidence ids" not in text


def test_evidence_can_be_read_back_by_id_after_the_window():
    for _ in range(6):
        verify.run_verify("true")
    first = verify.recent(20)[0]
    found = verify.find(first["id"].upper())
    assert found is not None and found["id"] == first["id"], "ids are case-insensitive"
    assert verify.find("ev-9999") is None
    assert verify.find(None) is None
    full = verify.render_entry(found)
    assert full.startswith(f"PC verify {first['id']}")


def test_pipefail_rewrite_is_exact_and_narrow():
    assert verify.pipefail_rewrite("pytest -q | tail -3") == (
        "bash -o pipefail -c 'pytest -q | tail -3'"
    )
    assert verify.pipefail_rewrite("bash -o pipefail -c 'a | b'") == ""
    assert verify.pipefail_rewrite("pytest -q") == ""
    assert verify.pipefail_rewrite("pytest -q || true") == ""
    assert verify.pipefail_rewrite(None) == ""
    piped = verify.run_verify("echo 'a|b' | tail -1")
    assert verify.pipefail_rewrite(piped["cmd"]).startswith("bash -o pipefail -c 'echo ")


def test_recent_window_uses_the_count_sidecar_instead_of_a_cold_parse():
    verify.run_verify("true")
    verify.run_verify("true")
    rows, total = verify.recent_with_total(2)
    assert total == 2
    # Simulate a fresh process: no in-memory cache, only the sidecar on disk.
    verify._VALID_RUNS_CACHE.clear()

    def _explode(*_args, **_kwargs):
        raise AssertionError("the ledger must not be parsed when the sidecar is valid")

    original = store.read_jsonl
    store.read_jsonl = _explode
    try:
        rows, total = verify.recent_with_total(2)
        assert total == 2
        assert [row["id"] for row in rows] == [r["id"] for r in verify.recent(2)]
    finally:
        store.read_jsonl = original


def test_a_stale_sidecar_is_discarded_not_trusted():
    verify.run_verify("true")
    verify.recent_with_total(1)  # warms the sidecar
    store.write_json(store.verify_path().with_name("verify_count.json"), {"stamp": ["bogus"], "total": 999})
    verify._VALID_RUNS_CACHE.clear()
    assert verify.count() == 1
