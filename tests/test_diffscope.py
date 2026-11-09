"""Numstat parser + verdicts vs thresholds (SPEC §7)."""

import subprocess
from pathlib import Path

from protect_context import diffscope
from protect_context.defaults import DEFAULT_CONFIG

NUMSTAT = (
    "10\t2\tsrc/a.py\n0\t0\timg.png\n-\t-\tlogo.bin\n3\t1\tdocs/{old => new}/guide.md\n"
)


def test_parse_numstat():
    rows = diffscope.parse_numstat(NUMSTAT)
    assert [(r["add"], r["del"]) for r in rows] == [(10, 2), (0, 0), (0, 0), (3, 1)]
    assert rows[2]["binary"] is True
    assert rows[2]["path"] == "logo.bin"
    assert rows[3]["path"] == "docs/{old => new}/guide.md"
    assert rows[1]["binary"] is False


def test_parse_numstat_empty():
    assert diffscope.parse_numstat("") == []


def test_stats():
    assert diffscope.stats(diffscope.parse_numstat(NUMSTAT)) == {
        "files": 4,
        "lines": 16,
    }


def test_verdict_thresholds():
    cfg = dict(DEFAULT_CONFIG)
    assert diffscope.verdict({"files": 2, "lines": 399}, cfg) == "ok"
    assert diffscope.verdict({"files": 2, "lines": 400}, cfg) == "warn"
    assert diffscope.verdict({"files": 10, "lines": 5}, cfg) == "warn"
    assert diffscope.verdict({"files": 9, "lines": 5}, cfg) == "ok"
    assert diffscope.verdict({"files": 2, "lines": 800}, cfg) == "hard"
    assert diffscope.verdict({"files": 50, "lines": 900}, cfg) == "hard"


def _git(*args):
    subprocess.run(["git", *args], check=True, capture_output=True)


def test_diff_audit_in_real_repo():
    _git("init", "-q")
    _git(
        "-c",
        "user.email=pc@test",
        "-c",
        "user.name=pc",
        "commit",
        "--allow-empty",
        "-qm",
        "init",
    )
    with open("f.txt", "w", encoding="utf-8") as f:
        f.write("x\n" * 5)
    _git("add", "f.txt")
    st = diffscope.diff_audit()
    assert st["files"] == 1 and st["lines"] == 5 and st["verdict"] == "ok"
    assert st["baseline"] == "HEAD" and st["added"] == 5


def test_diff_audit_with_baseline_ref():
    _git("init", "-q")
    _git(
        "-c",
        "user.email=pc@test",
        "-c",
        "user.name=pc",
        "commit",
        "--allow-empty",
        "-qm",
        "c1",
    )
    with open("f.txt", "w", encoding="utf-8") as f:
        f.write("x\n")
    _git("add", "f.txt")
    _git("-c", "user.email=pc@test", "-c", "user.name=pc", "commit", "-qm", "c2")
    st = diffscope.diff_audit(baseline="HEAD~1")
    assert st["files"] == 1 and st["lines"] == 1


def test_diff_audit_counts_untracked_but_respects_gitignore():
    _git("init", "-q")
    Path(".gitignore").write_text("ignored.txt\n", encoding="utf-8")
    _git("add", ".gitignore")
    _git(
        "-c",
        "user.email=pc@test",
        "-c",
        "user.name=pc",
        "commit",
        "-qm",
        "init",
    )
    Path("new.txt").write_text("x\n" * 600, encoding="utf-8")
    Path("ignored.txt").write_text("x\n" * 900, encoding="utf-8")

    st = diffscope.diff_audit()

    assert st["files"] == 1 and st["lines"] == 600
    assert st["untracked_files"] == 1 and st["untracked_lines"] == 600
    assert st["verdict"] == "warn"


def test_diff_audit_excludes_its_own_untracked_runtime_directory():
    _git("init", "-q")
    _git(
        "-c",
        "user.email=pc@test",
        "-c",
        "user.name=pc",
        "commit",
        "--allow-empty",
        "-qm",
        "init",
    )
    guard = Path(".agent-guard")
    guard.mkdir()
    (guard / "runtime.txt").write_text("not part of the user diff\n", encoding="utf-8")

    st = diffscope.diff_audit()

    assert st["files"] == 0 and st["lines"] == 0
    assert st["untracked_files"] == 0


def test_diff_audit_excludes_runtime_store_when_called_from_repo_subdir(monkeypatch):
    _git("init", "-q")
    _git(
        "-c",
        "user.email=pc@test",
        "-c",
        "user.name=pc",
        "commit",
        "--allow-empty",
        "-qm",
        "init",
    )
    nested = Path("packages/app")
    nested.mkdir(parents=True)
    guard = nested / ".agent-guard"
    guard.mkdir()
    (guard / "runtime.txt").write_text("runtime only\n", encoding="utf-8")
    Path("other/.agent-guard").mkdir(parents=True)
    Path("other/.agent-guard/user.txt").write_text("user-owned\n", encoding="utf-8")
    monkeypatch.chdir(nested)

    st = diffscope.diff_audit()

    assert st["untracked_files"] == 1
    assert st["untracked_lines"] == 1


def test_explicit_baseline_is_resolved_not_parsed_as_git_option(tmp_path):
    _git("init", "-q")
    _git(
        "-c",
        "user.email=pc@test",
        "-c",
        "user.name=pc",
        "commit",
        "--allow-empty",
        "-qm",
        "init",
    )
    target = tmp_path / "must-not-be-created"

    st = diffscope.diff_audit(baseline=f"--output={target}")

    assert "error" in st
    assert not target.exists()


def test_unborn_repo_is_a_clean_audit_not_raw_head_error():
    _git("init", "-q")
    Path("new.txt").write_text("one\ntwo\nthree\n", encoding="utf-8")

    untracked = diffscope.diff_audit()
    assert untracked["baseline"] == "unborn HEAD"
    assert untracked["unborn"] is True
    assert untracked["files"] == 1 and untracked["lines"] == 3

    _git("add", "new.txt")
    staged = diffscope.diff_audit()
    assert staged["baseline"] == "unborn HEAD"
    assert staged["files"] == 1 and staged["lines"] == 3


def test_unborn_repo_counts_final_worktree_not_staged_plus_unstaged():
    _git("init", "-q")
    Path("changed.txt").write_text("staged\n", encoding="utf-8")
    _git("add", "changed.txt")
    Path("changed.txt").write_text("final one\nfinal two\n", encoding="utf-8")

    st = diffscope.diff_audit()

    assert st["baseline"] == "unborn HEAD"
    assert st["files"] == 1
    assert st["added"] == 2 and st["deleted"] == 0 and st["lines"] == 2


def test_untracked_content_read_is_bounded_and_disclosed(monkeypatch):
    _git("init", "-q")
    Path("new.txt").write_text("a\nb\nc\n", encoding="utf-8")
    monkeypatch.setattr(diffscope, "UNTRACKED_MAX_BYTES_PER_FILE", 4)

    st = diffscope.diff_audit()

    assert st["untracked_scan_limited"] is True
    assert st["untracked_truncated_files"] == 1
    assert "bounded scan" in diffscope.render(st)


def test_diff_audit_outside_repo_is_error_not_raise():
    st = diffscope.diff_audit()
    assert "error" in st


def test_render_nudge_lines():
    assert "Nudge:" in diffscope.render({"error": "nope"})
    ok = diffscope.render(
        {
            "baseline": "HEAD",
            "added": 1,
            "deleted": 0,
            "files": 1,
            "lines": 1,
            "verdict": "ok",
            "warn_lines": 400,
            "warn_files": 10,
            "hard_lines": 800,
        }
    )
    assert "verdict ok" in ok and ok.rstrip().splitlines()[-1].startswith("Nudge:")


def test_render_bounds_and_normalizes_git_errors():
    text = diffscope.render({"error": "bad\nforged " + "x" * 1000})

    assert "bad forged" in text
    assert len(text) < 400
    assert text.rstrip().splitlines()[-1].startswith("Nudge:")


def test_git_head_none_outside_repo():
    assert diffscope.git_head() is None


def test_translate_windows_and_wsl_unc_paths():
    assert diffscope.translate_windows_path(r"C:\repo\sub") == "/mnt/c/repo/sub"
    assert diffscope.translate_windows_path("D:/Work/proj") == "/mnt/d/Work/proj"
    assert diffscope.translate_windows_path(r"\\wsl$\Ubuntu\home\me\proj") == "/home/me/proj"
    assert diffscope.translate_windows_path("//wsl.localhost/Debian/home/me/proj") == "/home/me/proj"
    assert diffscope.translate_windows_path("/already/posix") is None


def test_resolve_git_root_prefers_an_existing_translation(monkeypatch, tmp_path):
    target = tmp_path / "repo"
    target.mkdir()
    monkeypatch.setattr(diffscope, "translate_windows_path", lambda _text: str(target))
    assert diffscope.resolve_git_root(r"C:\repo") == target.resolve()


def test_resolve_git_root_falls_back_when_translation_is_missing(monkeypatch, tmp_path):
    monkeypatch.chdir(tmp_path)
    missing = tmp_path / "missing-mnt"
    monkeypatch.setattr(diffscope, "translate_windows_path", lambda _text: str(missing))
    assert diffscope.resolve_git_root("relative-root") == (tmp_path / "relative-root").resolve()


def test_untracked_backslash_paths_are_counted_on_posix(tmp_path):
    root = tmp_path / "repo"
    nested = root / "sub"
    nested.mkdir(parents=True)
    (nested / "file.txt").write_text("one\ntwo\n", encoding="utf-8")
    scan = diffscope._scan_untracked(root.resolve(), [r"sub\file.txt"], 800)
    assert scan["lines"] == 2
    assert scan["skipped_files"] == 0


def test_a_symlinked_parent_cannot_escape_the_repository(tmp_path):
    """A git path is root-relative, so only resolving both sides proves the
    read stays inside: `link/secret.txt` is lexically inside while the bytes
    live outside."""
    outside = tmp_path / "outside"
    outside.mkdir()
    (outside / "secret.txt").write_text("a\nb\nc\n", encoding="utf-8")
    root = tmp_path / "repo"
    root.mkdir()
    (root / "link").symlink_to(outside, target_is_directory=True)

    scan = diffscope._scan_untracked(root.resolve(), ["link/secret.txt"], 800)
    assert scan["lines"] == 0, "the outside file must not be counted"
    assert scan["files_scanned"] == 0
    assert scan["skipped_files"] == 1
    assert scan["scan_limited"] is True, "an unread path makes the count incomplete"


def test_partial_cfg_falls_back_to_builtin_defaults():
    """diff_audit accepts a partial cfg (public signature) without KeyError."""
    from protect_context.defaults import DEFAULT_CONFIG

    st = diffscope.diff_audit(cfg={"diff_warn_lines": 1})
    assert "error" in st or st["hard_lines"] == DEFAULT_CONFIG["diff_hard_lines"]
    if "error" not in st:
        assert st["warn_lines"] == 1
        assert st["warn_files"] == DEFAULT_CONFIG["diff_warn_files"]
