"""Orientation digest: tree ≤2 levels, language counts, conventions files (SPEC §7)."""

import subprocess

from protect_context import orientation


def test_digest_counts_and_conventions(tmp_path):
    (tmp_path / "src" / "pkg").mkdir(parents=True)
    (tmp_path / "src" / "pkg" / "a.py").write_text("x = 1\n")
    (tmp_path / "src" / "b.py").write_text("x = 2\n")
    (tmp_path / "lib.ts").write_text("export {};\n")
    (tmp_path / "tool.sh").write_text("#!/bin/sh\n")
    (tmp_path / "CLAUDE.md").write_text("# conventions\n")
    (tmp_path / "README.md").write_text("# r\n")
    (tmp_path / "node_modules").mkdir()
    (tmp_path / "node_modules" / "x.js").write_text("")
    (tmp_path / ".git").mkdir()
    (tmp_path / ".git" / "hidden.py").write_text("")

    d = orientation.digest(tmp_path)
    assert "Python=2" in d
    assert "TypeScript=1" in d
    assert "Shell=1" in d
    assert "CLAUDE.md" in d and "README.md" in d
    assert "node_modules" not in d  # skipped entirely
    assert ".git" not in d
    assert "pkg" in d  # level-2 children shown
    assert d.rstrip().splitlines()[-1].startswith("Nudge:")


def test_digest_empty_dir(tmp_path):
    d = orientation.digest(tmp_path)
    assert "none detected" in d
    assert "none found" in d
    assert d.rstrip().splitlines()[-1].startswith("Nudge:")


def test_tree_limited_to_two_levels(tmp_path):
    (tmp_path / "a" / "b" / "c").mkdir(parents=True)
    (tmp_path / "a" / "b" / "c" / "deep.py").write_text("")
    (tmp_path / "a" / "child.txt").write_text("")
    d = orientation.digest(tmp_path)
    assert "a/ (b/, child.txt)" in d
    assert "deep.py" not in d  # level 3 never listed


def test_orientation_sanitizes_names_caps_tree_and_does_not_follow_dir_symlinks(tmp_path):
    outside = tmp_path.parent / f"{tmp_path.name}-outside"
    outside.mkdir()
    (outside / "secret.py").write_text("x = 1\n")
    (tmp_path / "linked").symlink_to(outside, target_is_directory=True)
    (tmp_path / "bad\nname.ts").write_text("export {}\n")
    for index in range(20):
        (tmp_path / f"file-{index:02d}.txt").write_text("x\n")

    scan = orientation.scan(tmp_path)
    rendered = orientation.digest(tmp_path)

    assert len(scan["tree"]) <= orientation.MAX_TREE_ENTRIES
    assert "bad name.ts" in rendered and "bad\nname.ts" not in rendered
    assert "Python" not in dict(scan["languages"]), "directory symlink was traversed"


def test_orientation_resolves_nested_start_to_git_root(tmp_path):
    subprocess.run(["git", "init", "-q", str(tmp_path)], check=True)
    nested = tmp_path / "packages" / "app"
    nested.mkdir(parents=True)
    (tmp_path / "AGENTS.md").write_text("# root instructions\n")
    (tmp_path / "root.py").write_text("x = 1\n")

    scan = orientation.scan(nested)

    assert scan["root"] == tmp_path.resolve()
    assert "AGENTS.md" in scan["conventions"]
    assert dict(scan["languages"])["Python"] == 1


def test_child_summary_counts_every_visible_entry(tmp_path):
    pkg = tmp_path / "pkg"
    pkg.mkdir()
    for index in range(orientation.MAX_CHILDREN + 4):
        (pkg / f"f-{index:02d}.txt").write_text("x\n")
    rendered = orientation.digest(tmp_path)
    assert "+4 more" in rendered
