"""Git diff analysis: numstat parsing + verdicts vs configured thresholds
(SPEC §1 #3, #8). Verdicts: ok < warn (400 lines / 10 files) < hard (800 lines).
"""

from __future__ import annotations

import os
import re
import subprocess
from pathlib import Path

from . import store

UNTRACKED_MAX_FILES_SCANNED = 1_000
UNTRACKED_MAX_BYTES_PER_FILE = 1_000_000
UNTRACKED_MAX_BYTES_TOTAL = 8_000_000
_READ_CHUNK = 64 * 1024


class DiffError(RuntimeError):
    """git could not run or refused (e.g. not a repository)."""


_WIN_DRIVE = re.compile(r"^([A-Za-z]):[\\/](.*)$")
_WSL_UNC = re.compile(r"^//wsl(?:\$|\.localhost)/[^/]+/(.*)$", re.IGNORECASE)


def translate_windows_path(text: str) -> str | None:
    """Map a Windows or WSL-UNC absolute path to a POSIX path, or None.

    Windows git.exe on WSL prints ``C:\\repo`` or ``\\\\wsl$\\Distro\\home\\...``.
    On POSIX, Path does not treat ``C:`` as absolute, so using that string as
    the repository root looks up the wrong directory and under-counts the diff.
    """
    raw = text.strip().strip('"')
    if not raw:
        return None
    drive = _WIN_DRIVE.match(raw)
    if drive:
        rest = drive.group(2).replace("\\", "/").strip("/")
        prefix = f"/mnt/{drive.group(1).lower()}"
        return f"{prefix}/{rest}" if rest else prefix
    unc = _WSL_UNC.match(raw.replace("\\", "/"))
    if unc:
        rest = unc.group(1).strip("/")
        return f"/{rest}" if rest else "/"
    return None


def resolve_git_root(raw: str) -> Path:
    """Resolve ``git rev-parse --show-toplevel``, including WSL drive letters."""
    text = raw.strip().strip('"')
    if os.name != "nt":
        translated = translate_windows_path(text)
        if translated is not None:
            candidate = Path(translated)
            try:
                if candidate.exists():
                    return candidate.resolve()
            except OSError:
                pass
    return Path(text).resolve()


def normalize_repo_relpath(path: str) -> str:
    """Prefer ``/`` in repo-relative git paths when the OS separator is ``/``.

    A backslash from Windows git is a separator there and a literal character
    on POSIX, so ``sub\\\\file.txt`` would miss ``sub/file.txt`` and the diff
    line count would be short. Real filenames that contain a backslash are
    rare; under-counting scope is the failure this avoids.
    """
    if os.sep == "/" and "\\" in path:
        return path.replace("\\", "/")
    return path


def _git_bytes(args: list[str], *, stdin: bytes | None = None) -> bytes:
    try:
        r = subprocess.run(
            ["git", *args], input=stdin, capture_output=True, timeout=15
        )
    except (OSError, subprocess.TimeoutExpired) as e:  # pragma: no cover — rare
        raise DiffError(f"git failed: {e}") from e
    if r.returncode != 0:
        msg = r.stderr.decode("utf-8", errors="replace").strip()
        raise DiffError(msg or f"git {' '.join(args)} failed (exit {r.returncode})")
    return r.stdout


def _git(args: list[str]) -> str:
    return _git_bytes(args).decode("utf-8", errors="replace")


def git_head(short: bool = True) -> str | None:
    """Current HEAD sha (short), or None outside a repository / on empty repo."""
    args = ["rev-parse"] + (["--short"] if short else []) + ["HEAD"]
    try:
        return _git(args).strip() or None
    except DiffError:
        return None


def _repo_root() -> Path:
    """Resolved repository root, or DiffError outside a working tree."""
    root = _git(["rev-parse", "--show-toplevel"]).strip()
    if not root:
        raise DiffError("not inside a git work tree")
    return resolve_git_root(root)


def _empty_tree() -> str:
    """Return Git's canonical empty-tree id for this repository's hash format."""
    tree = _git_bytes(["hash-object", "-t", "tree", "--stdin"], stdin=b"").decode(
        "ascii", errors="strict"
    ).strip()
    if not tree:
        raise DiffError("git could not resolve the empty tree")
    return tree


def _resolve_baseline(baseline: str) -> str:
    """Resolve an untrusted revision to a commit id without option parsing.

    `--end-of-options` is essential: MCP/CLI input such as `--output=PATH`
    must be treated as an invalid revision, never as a git-diff option.
    """
    baseline = baseline.strip()
    if not baseline:
        raise DiffError("baseline must not be blank")
    resolved = _git(
        ["rev-parse", "--verify", "--end-of-options", f"{baseline}^{{commit}}"]
    ).strip()
    if not resolved:
        raise DiffError(f"baseline {baseline!r} did not resolve to a commit")
    return resolved


def parse_numstat(text: str) -> list[dict]:
    """Parse `git diff --numstat` output. Lines: 'add\\tdel\\tpath' where '-'
    marks binary (counted as 0 lines, still 1 file). Rename paths keep their
    '{old => new}' form verbatim."""
    rows: list[dict] = []
    for line in text.splitlines():
        if not line.strip():
            continue
        parts = line.split("\t", 2)
        if len(parts) != 3:
            continue
        a, d, path = parts
        binary = a == "-" or d == "-"
        rows.append(
            {
                "add": 0 if a == "-" else _int(a),
                "del": 0 if d == "-" else _int(d),
                "path": path,
                "binary": binary,
            }
        )
    return rows


def _int(s: str) -> int:
    try:
        return int(s)
    except ValueError:
        return 0


def stats(rows: list[dict]) -> dict:
    return {"files": len(rows), "lines": sum(r["add"] + r["del"] for r in rows)}


def _untracked_paths(root: Path) -> list[str]:
    """Return non-ignored paths, excluding this process's runtime store.

    Git porcelain paths are relative to the repository root, while the store
    is relative to the caller's cwd. Deriving the exact root-relative prefix
    also handles a CLI/MCP server launched from a repository subdirectory
    without hiding unrelated `.agent-guard` directories elsewhere.
    """
    raw = _git_bytes(["status", "--porcelain=v1", "-z", "--untracked-files=all", "--"])
    try:
        guard_rel = store.guard_dir().resolve().relative_to(root).as_posix()
    except (OSError, ValueError):
        guard_rel = None
    paths: list[str] = []
    for record in raw.split(b"\0"):
        if record.startswith(b"?? "):
            path = os.fsdecode(record[3:])
            # Loading the audit config creates this runtime directory. It is
            # never part of the user's change, even when a repository has not
            # added the recommended ignore rule yet. All other exclusions
            # remain Git's decision, preserving .gitignore semantics.
            if guard_rel is not None and (
                path == guard_rel or path.startswith(f"{guard_rel}/")
            ):
                continue
            paths.append(path)
    return sorted(set(paths))


def _scan_untracked(root: Path, paths: list[str], hard_line_budget: int) -> dict:
    """Count text lines in untracked files without following symlinks.

    Reads are capped per-file and globally. Once the hard diff threshold is
    reached, further content reads add no decision value, so they stop too.
    File count remains exact for every path reported by `git status`.
    """
    lines = 0
    bytes_scanned = 0
    files_scanned = 0
    binary_files = 0
    skipped_files = 0
    truncated_files = 0

    for rel in paths:
        if files_scanned >= UNTRACKED_MAX_FILES_SCANNED or bytes_scanned >= UNTRACKED_MAX_BYTES_TOTAL:
            skipped_files += 1
            continue
        if lines >= hard_line_budget:
            skipped_files += 1
            continue

        candidate = root / normalize_repo_relpath(rel)
        try:
            # Git paths are root-relative, but defend against malformed output,
            # races, and symlinks that point outside the repository.
            candidate.relative_to(root)
            if candidate.is_symlink() or not candidate.is_file():
                skipped_files += 1
                continue
        except (OSError, ValueError):
            skipped_files += 1
            continue

        file_lines = 0
        last_byte: int | None = None
        file_bytes = 0
        binary = False
        complete = True
        try:
            with candidate.open("rb") as fh:
                while True:
                    remaining_file = UNTRACKED_MAX_BYTES_PER_FILE - file_bytes
                    remaining_total = UNTRACKED_MAX_BYTES_TOTAL - bytes_scanned
                    if remaining_file <= 0 or remaining_total <= 0 or lines + file_lines >= hard_line_budget:
                        complete = False
                        break
                    chunk = fh.read(min(_READ_CHUNK, remaining_file, remaining_total))
                    if not chunk:
                        break
                    file_bytes += len(chunk)
                    bytes_scanned += len(chunk)
                    if b"\0" in chunk:
                        binary = True
                        file_lines = 0
                        break
                    file_lines += chunk.count(b"\n")
                    last_byte = chunk[-1]
        except OSError:
            skipped_files += 1
            continue

        files_scanned += 1
        if binary:
            binary_files += 1
            continue
        if complete and file_bytes and last_byte != 0x0A:
            file_lines += 1
        if not complete:
            truncated_files += 1
        lines += file_lines

    return {
        "files": len(paths),
        "lines": lines,
        "files_scanned": files_scanned,
        "bytes_scanned": bytes_scanned,
        "binary_files": binary_files,
        "skipped_files": skipped_files,
        "truncated_files": truncated_files,
        "scan_limited": bool(skipped_files or truncated_files),
    }


def verdict(st: dict, cfg: dict) -> str:
    """ok | warn | hard. An incomplete count can never be declared OK."""
    if st["lines"] >= cfg["diff_hard_lines"]:
        return "hard"
    if (
        st["lines"] >= cfg["diff_warn_lines"]
        or st["files"] >= cfg["diff_warn_files"]
        or st.get("untracked_scan_limited", False)
    ):
        return "warn"
    return "ok"


def diff_audit(baseline: str | None = None, cfg: dict | None = None) -> dict:
    """Diff working tree vs baseline (default HEAD); returns stats + verdict,
    or {"error": ...} if git fails (never raises to callers)."""
    cfg = cfg if cfg is not None else store.load_config()
    try:
        root = _repo_root()
        unborn = False
        if baseline is not None:
            ref = baseline.strip()
            resolved = _resolve_baseline(baseline)
            rows = parse_numstat(_git(["diff", "--numstat", resolved, "--"]))
        else:
            head = git_head(short=False)
            if head is None:
                unborn = True
                ref = "unborn HEAD"
                # One tree-to-worktree comparison reports the final content.
                # Adding cached and unstaged numstats would double-count a
                # staged file that was edited again before the first commit.
                rows = parse_numstat(
                    _git(["diff", "--numstat", _empty_tree(), "--"])
                )
            else:
                ref = "HEAD"
                rows = parse_numstat(_git(["diff", "--numstat", head, "--"]))
        untracked = _scan_untracked(
            root,
            _untracked_paths(root),
            max(0, cfg["diff_hard_lines"] - sum(r["add"] + r["del"] for r in rows)),
        )
    except DiffError as e:
        return {"error": e.args[0]}
    tracked = stats(rows)
    st = {
        "files": tracked["files"] + untracked["files"],
        "lines": tracked["lines"] + untracked["lines"],
        "untracked_scan_limited": untracked["scan_limited"],
    }
    st.update(
        {
            "added": sum(r["add"] for r in rows) + untracked["lines"],
            "deleted": sum(r["del"] for r in rows),
            "baseline": ref,
            "unborn": unborn,
            "untracked_files": untracked["files"],
            "untracked_lines": untracked["lines"],
            "untracked_files_scanned": untracked["files_scanned"],
            "untracked_bytes_scanned": untracked["bytes_scanned"],
            "untracked_binary_files": untracked["binary_files"],
            "untracked_skipped_files": untracked["skipped_files"],
            "untracked_truncated_files": untracked["truncated_files"],
            "verdict": verdict(st, cfg),
            "warn_lines": cfg["diff_warn_lines"],
            "warn_files": cfg["diff_warn_files"],
            "hard_lines": cfg["diff_hard_lines"],
        }
    )
    return st


def render(st: dict) -> str:
    if "error" in st:
        error = store.display_text(st["error"], 240) or "Git audit unavailable"
        return f"PC diff · error: {error}\nNudge: run inside a git repository, or pass an explicit baseline ref."
    if st.get("untracked_scan_limited") and st["verdict"] != "hard":
        advice = (
            "Nudge: untracked scope is only a lower bound — inspect skipped or "
            "truncated files before treating the diff as within budget."
        )
    else:
        advice = {
            "ok": "Nudge: diff is within budget — keep unrelated changes out.",
            "warn": f"Nudge: ≥ {st['warn_lines']} changed lines or ≥ {st['warn_files']} files — split the change into logical steps.",
            "hard": f"Nudge: ≥ {st['hard_lines']} changed lines — stop and split; large diffs are unreviewable.",
        }[st["verdict"]]
    detail = (
        f"untracked: {st.get('untracked_files', 0)} files · "
        f"+{st.get('untracked_lines', 0)} lines"
    )
    if st.get("untracked_scan_limited"):
        detail += (
            f" · bounded scan ({st.get('untracked_files_scanned', 0)} read, "
            f"{st.get('untracked_skipped_files', 0)} skipped, "
            f"{st.get('untracked_truncated_files', 0)} truncated)"
        )
    return (
        f"PC diff · vs {st['baseline']} · +{st['added']}/-{st['deleted']} · "
        f"{st['files']} files · verdict {st['verdict']}\n{detail}\n{advice}"
    )
