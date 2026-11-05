"""The official MCP registry entry (`server.json`) must stay in sync with the
package it points at, or publishing fails validation (SPEC §3, §4)."""

import json
import re
from pathlib import Path

from protect_context.cli import build_parser

ROOT = Path(__file__).resolve().parent.parent
SERVER = json.loads((ROOT / "server.json").read_text())
README = (ROOT / "README.md").read_text()
PYPROJECT = (ROOT / "pyproject.toml").read_text()


def _project_field(name):
    m = re.search(rf'^{name} = "([^"]+)"$', PYPROJECT, re.MULTILINE)
    assert m, f"{name} missing from [project]"
    return m.group(1)


def test_server_json_versions_match_the_package():
    assert SERVER["version"] == _project_field("version")
    (package,) = SERVER["packages"]
    assert package["version"] == SERVER["version"]


def test_pypi_package_entry_points_at_this_package():
    (package,) = SERVER["packages"]
    assert package["registryType"] == "pypi"
    assert package["identifier"] == _project_field("name")
    assert package["transport"] == {"type": "stdio"}


def test_readme_carries_the_ownership_marker():
    # PyPI serves README.md as the package description; the registry reads that
    # description and requires the exact `mcp-name: $SERVER_NAME` token.
    assert f"mcp-name: {SERVER['name']}" in README


def test_description_fits_the_registry_limit():
    assert 0 < len(SERVER["description"]) <= 100


def test_declared_launch_arguments_reach_the_mcp_verb():
    # Clients run `<runtime> <identifier> <packageArguments>`; the positional
    # arguments must land on a CLI verb that actually serves MCP on stdio.
    (package,) = SERVER["packages"]
    args = [a["value"] for a in package["packageArguments"] if a["type"] == "positional"]
    assert args == ["mcp"]
    assert build_parser().parse_args(args).verb == "mcp"
