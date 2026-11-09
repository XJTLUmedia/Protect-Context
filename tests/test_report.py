"""Status dashboard contents (SPEC §4 guard_status row)."""

from protect_context import contract, report, store, verify


def test_status_dashboard_contents():
    contract.load()  # seed 12
    verify.run_verify("true")
    text, level = report.status()
    assert "PC status" in text
    assert "session test-session" in text
    assert "loops: none" in text
    assert "evidence 1 · last ev-0001 exit 0" in text
    assert "contract 12 constraints" in text
    assert level == 1  # scope audit is unavailable outside a Git repository
    assert text.rstrip().splitlines()[-1].startswith("Nudge:")


def test_status_outside_git_repo():
    text, level = report.status()
    assert "Δdiff n/a (not a git repo)" in text
    assert level == 1
    assert "before treating scope status as healthy" in text


def test_status_evidence_is_scoped_to_session():
    """Other sessions' verify runs don't leak into this session's dashboard."""
    store.ensure()
    row = {"id": "ev-0001", "ts": "t", "session": "someone-else", "cmd": "true",
           "exit": 0, "ok": True, "digest": "", "ms": 1}
    store.append_jsonl(store.verify_path(), row)
    text, _level = report.status()
    assert "evidence 0 · last none" in text
    verify.run_verify("true")
    text, _level = report.status()
    assert "evidence 1 · last ev-0002 exit 0" in text


def test_status_includes_conventions_line():
    """Goal #4: conventions files surface on the dashboard (cheap root stats)."""
    contract.load()
    text, _level = report.status()
    assert "conventions:" in text


def test_status_warning_diff_returns_warning_level(monkeypatch):
    monkeypatch.setattr(
        report.diffscope,
        "diff_audit",
        lambda cfg: {"added": 450, "deleted": 0, "files": 1, "verdict": "warn"},
    )

    text, level = report.status()

    assert "verdict warn" in text
    assert level == 1


def test_status_discloses_limited_untracked_scan_as_lower_bound(monkeypatch):
    monkeypatch.setattr(
        report.diffscope,
        "diff_audit",
        lambda cfg: {
            "added": 120,
            "deleted": 0,
            "files": 4,
            "verdict": "ok",
            "untracked_scan_limited": True,
            "untracked_skipped_files": 2,
            "untracked_truncated_files": 1,
        },
    )

    text, level = report.status()

    assert "untracked line count is a lower bound" in text
    assert "2 skipped, 1 truncated" in text
    assert level == 0


def test_status_does_not_re_read_the_evidence_ledger_for_its_count(monkeypatch):
    verify.run_verify("true")
    calls = []
    original = store.read_jsonl

    def counting(path):
        calls.append(path)
        return original(path)

    def no_second_parse(*args, **kwargs):
        raise AssertionError("status must not count via a second ledger parse")

    monkeypatch.setattr(store, "read_jsonl", counting)
    monkeypatch.setattr(verify, "count", no_second_parse)

    report.status()

    # loops.streaks still owns one full read of the evidence ledger (it merges
    # events with verify outcomes); the evidence line shares a single read of
    # its own instead of parsing twice for slice + count.
    assert sum(1 for p in calls if p.name.startswith("verify_runs")) <= 2


def test_status_nudges_on_an_untrusted_last_verify():
    import subprocess

    subprocess.run(["git", "init", "-q"], check=True, capture_output=True)
    verify.run_verify("true || true")
    text, _level = report.status()
    assert "not trustworthy" in text, "a masked exit 0 must drive the nudge"
