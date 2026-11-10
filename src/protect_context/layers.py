"""Personal layer above the per-project store (SPEC §2).

The built-in seeds live in code (`defaults.py`), identical for every install.
Above them sits an optional *personal* layer that applies to every project on
this machine, and above that the project store, which stays authoritative:

    built-in defaults  <  ~/.config/protect-context  <  .agent-guard/

`PC_USER_DIR` overrides the personal directory (tests, or a dotfiles repo you
sync yourself). Nothing is ever written to the personal layer implicitly: it is
owner-only surface, created by `contract add --global` or by hand.
"""

from __future__ import annotations

from collections.abc import Callable, Iterable
from pathlib import Path

from dotenv import find_dotenv, load_dotenv
from pydantic_settings import BaseSettings, SettingsConfigDict

USER_DIR_ENV = "PC_USER_DIR"
USER_DIR_NAME = "protect-context"


class _LayerEnv(BaseSettings):
    """Environment that selects the personal layer (SPEC §2 precedence).

    pydantic-settings reads PC_USER_DIR and XDG_CONFIG_HOME case-insensitively,
    so the documented names are the model field names and no manual environ
    lookup is needed.
    """

    model_config = SettingsConfigDict(extra="ignore", case_sensitive=False)

    pc_user_dir: str = ""
    xdg_config_home: str = ""


def user_dir() -> Path:
    """Personal layer directory: PC_USER_DIR, else $XDG_CONFIG_HOME, else ~/.config."""
    # A project .env may set PC_USER_DIR; real environment variables always win
    # (override=False), so a committed file can never hijack a shell setting.
    load_dotenv(find_dotenv(usecwd=True), override=False)
    env = _LayerEnv()
    override = env.pc_user_dir.strip()
    if override:
        return Path(override).expanduser()
    xdg = env.xdg_config_home.strip()
    base = Path(xdg).expanduser() if xdg else Path.home() / ".config"
    return base / USER_DIR_NAME


def user_contract_path() -> Path:
    return user_dir() / "contract.json"


def user_config_path() -> Path:
    return user_dir() / "config.json"


def merge_unique(
    layers: Iterable[Iterable[dict]],
    *,
    key: Callable[[dict], str],
    signature: Callable[[dict], str],
) -> list[dict]:
    """Concatenate layers strongest-first, dropping rows already represented.

    Precedence is positional: the first layer to claim an id, or an identical
    signature, wins. Callers pass the project layer first, so a project row
    always overrides a personal row with the same id, and a personal
    constraint identical to a project one is not listed twice.
    """
    out: list[dict] = []
    seen_keys: set[str] = set()
    seen_signatures: set[str] = set()
    for rows in layers:
        for row in rows:
            row_key = key(row)
            row_signature = signature(row)
            if row_key in seen_keys or row_signature in seen_signatures:
                continue
            seen_keys.add(row_key)
            seen_signatures.add(row_signature)
            out.append(row)
    return out
