"""Import bootstrap for the third-party projects cloned into ``vendor/``.

The repositories under ``vendor/`` are upstream checkouts, not packages this
project owns.  Their names collide with same-named releases on PyPI, so this
module puts the clone roots on ``sys.path`` *ahead* of site-packages: when the
CLI or the MCP server imports ``tenacity``, ``typer``, ``pybreaker`` or
``pydantic_settings`` it gets the vendored checkout, which is the point of
vendoring them.

Call :func:`activate` once, before importing any of those names.  It is safe to
call repeatedly, safe when a checkout is missing, and safe when a checkout
cannot be imported on the running interpreter (the path is dropped and the
installed package is used instead).  The last case is not hypothetical: the
vendored ``pydantic-settings`` checkout imports ``typing.Self``, so on Python
3.10 it raises ImportError and used to take the whole package down with it
(found 2026-11-10 by running the checkout on 3.10).
"""

from __future__ import annotations

import importlib
import sys
from pathlib import Path

VENDOR_ROOT = Path(__file__).resolve().parents[2] / "vendor"

# Each entry is the directory that must be on sys.path for the package to be
# importable.  Upstream layouts differ, so these are literal relative paths.
VENDOR_PATHS: tuple[tuple[str, str], ...] = (
    ("pybreaker", "pybreaker/src"),
    ("tenacity", "tenacity"),
    ("typer", "typer"),
    ("pydantic_settings", "pydantic-settings"),
)


def activate() -> list[str]:
    """Prepend every vendored package root to ``sys.path``.

    Returns the paths that are now active.  A checkout that cannot be imported
    here is removed again rather than left on the path: a broken checkout must
    degrade to the installed distribution, not break ``import protect_context``.
    """
    active: list[str] = []
    for name, relative in VENDOR_PATHS:
        root = VENDOR_ROOT / relative
        if not root.is_dir():
            continue
        entry = str(root)
        if entry in sys.path:
            sys.path.remove(entry)
        sys.path.insert(0, entry)
        try:
            importlib.import_module(name)
        except Exception:  # noqa: BLE001 - any import failure means "unusable here"
            sys.path.remove(entry)
            continue
        active.append(entry)
    return active


def origin(module: object) -> str:
    """Return the file a module was loaded from, for provenance checks."""
    return str(getattr(module, "__file__", "") or "")


def is_vendored(module: object) -> bool:
    """True when ``module`` was imported from the ``vendor/`` checkout."""
    return origin(module).startswith(str(VENDOR_ROOT))
