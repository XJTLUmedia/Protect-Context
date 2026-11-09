"""Orientation digest (SPEC §1 #4): repo tree ≤2 levels, language counts by
file extension, conventions-file detection (CLAUDE.md/AGENTS.md/README...).
Pure local filesystem scanning; no network, no LLM.
"""

from __future__ import annotations

import os
import subprocess
import unicodedata
from pathlib import Path

SKIP_DIRS = {
    ".git", ".hg", ".svn", ".venv", "venv", "env", "node_modules", "__pycache__",
    ".agent-guard", ".pytest_cache", ".mypy_cache", ".ruff_cache", ".tox",
    ".eggs", "dist", "build", "coverage", ".idea", ".vscode",
}

CONVENTIONS_FILES = ("CLAUDE.md", "AGENTS.md", "CONVENTIONS.md", "README.md", "README")

EXT_LANG = {
    ".py": "Python", ".pyw": "Python",
    ".ts": "TypeScript", ".tsx": "TypeScript",
    ".js": "JavaScript", ".jsx": "JavaScript", ".mjs": "JavaScript", ".cjs": "JavaScript",
    ".rs": "Rust", ".go": "Go", ".java": "Java", ".kt": "Kotlin", ".swift": "Swift",
    ".rb": "Ruby", ".php": "PHP", ".cs": "C#",
    ".c": "C", ".h": "C", ".cpp": "C++", ".cc": "C++", ".hpp": "C++",
    ".sh": "Shell", ".bash": "Shell", ".zsh": "Shell",
}

MAX_TREE_ENTRIES = 12
MAX_CHILDREN = 8
MAX_WALK_DEPTH = 3
MAX_FILES_SCANNED = 4000


def orientation_root(start: Path | None = None) -> Path:
    """Return the containing Git worktree root, or the requested directory.

    Agents are commonly launched from a package below the repository root.
    Scanning that package alone can hide a root ``AGENTS.md`` or ``README``.
    Git resolution is bounded and best-effort so non-repositories, missing Git,
    unreadable paths, and bare repositories retain the original safe fallback.
    """
    candidate = Path(start) if start is not None else Path.cwd()
    if not candidate.is_dir():
        return candidate
    try:
        result = subprocess.run(
            ["git", "-C", str(candidate), "rev-parse", "--show-toplevel"],
            capture_output=True,
            text=True,
            timeout=3,
            check=False,
        )
    except (OSError, subprocess.TimeoutExpired):
        return candidate
    if result.returncode != 0:
        return candidate
    value = result.stdout.strip()
    return Path(value).resolve() if value else candidate


def _skip(name: str) -> bool:
    return name.startswith(".") or name in SKIP_DIRS or name.endswith(".egg-info")


def _display(value: object, cap: int = 120) -> str:
    raw = str(value or "")
    clean = "".join(
        " " if unicodedata.category(char) in {"Cc", "Cf", "Cs"} else char
        for char in raw
    )
    return " ".join(clean.split())[:cap].strip() or "(control-only name)"


def _children(d: Path) -> str:
    try:
        entries = sorted(d.iterdir(), key=lambda p: p.name.lower())
    except OSError:
        return ""
    names: list[str] = []
    visible = 0
    for e in entries:
        if _skip(e.name):
            continue
        visible += 1
        if len(names) >= MAX_CHILDREN:
            continue
        shown = _display(e.name)
        names.append(shown + ("/" if e.is_dir() and not e.is_symlink() else ""))
    remaining = max(0, visible - len(names))
    s = ", ".join(names)
    if remaining > 0:
        s += f", +{remaining} more"
    return s


def language_counts(root: Path) -> list[tuple[str, int]]:
    counts: dict[str, int] = {}
    seen = 0
    base_depth = len(root.parts)
    for dirpath, dirnames, filenames in os.walk(root):
        depth = len(Path(dirpath).parts) - base_depth
        dirnames[:] = sorted(d for d in dirnames if not _skip(d))
        if depth >= MAX_WALK_DEPTH:
            dirnames[:] = []
        for f in filenames:
            if seen >= MAX_FILES_SCANNED:
                return sorted(counts.items(), key=lambda kv: (-kv[1], kv[0]))
            seen += 1
            lang = EXT_LANG.get(Path(f).suffix.lower())
            if lang:
                counts[lang] = counts.get(lang, 0) + 1
    return sorted(counts.items(), key=lambda kv: (-kv[1], kv[0]))


def conventions(root: Path | None = None) -> list[str]:
    """Conventions at the containing repo root, or the requested directory."""
    root = orientation_root(root)
    return [c for c in CONVENTIONS_FILES if (root / c).is_file()]


def scan(root: Path | None = None) -> dict:
    root = orientation_root(root)
    dirs: list[str] = []
    files: list[str] = []
    if root.is_dir():
        try:
            entries = sorted(root.iterdir(), key=lambda p: p.name.lower())
        except OSError:
            entries = []
        for e in entries:
            if _skip(e.name):
                continue
            if e.is_dir() and not e.is_symlink():
                kids = _children(e)
                dirs.append(f"{_display(e.name)}/" + (f" ({kids})" if kids else ""))
            elif e.is_file():
                files.append(_display(e.name))
    conv = [c for c in CONVENTIONS_FILES if (root / c).is_file()]
    return {
        "root": root,
        "tree": (dirs + files)[:MAX_TREE_ENTRIES],
        "languages": language_counts(root) if root.is_dir() else [],
        "conventions": conv,
    }


def digest(root: Path | None = None) -> str:
    """Compact orientation brief (ends with Nudge)."""
    s = scan(root)
    name = _display(s["root"].name or str(s["root"]))
    lines = [f"PC orientation · {name}"]
    lines.extend(s["tree"])
    langs = ", ".join(f"{k}={v}" for k, v in s["languages"][:6]) or "none detected"
    lines.append(f"languages: {langs}")
    lines.append("conventions: " + (", ".join(s["conventions"]) or "none found"))
    lines.append("Nudge: read the conventions files and relevant code before the first edit — never code from guesses.")
    return "\n".join(lines)
