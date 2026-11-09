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
    assert package["runtimeHint"] == "uvx"
    assert build_parser().parse_args(args).verb == "mcp"


def test_repository_url_is_the_current_github_repo():
    assert SERVER["repository"]["url"] == "https://github.com/XJTLUmedia/Protect-Context"
    assert SERVER["repository"]["source"] == "github"
    assert SERVER["websiteUrl"] == "https://github.com/XJTLUmedia/Protect-Context"
    # npm ships the pi extension only (no bin, no MCP server). The registry
    # package is the PyPI distribution that actually serves stdio.
    assert [p["registryType"] for p in SERVER["packages"]] == ["pypi"]


def test_listing_metadata_drops_the_old_repo_slug():
    old = "Protect-Context-Pi-Coding-Agent"
    watched = [
        ROOT / "package.json",
        ROOT / "pyproject.toml",
        ROOT / "server.json",
        ROOT / "README.md",
        ROOT / ".mcp.json",
        ROOT / "glama.json",
    ]
    for path in watched:
        assert old not in path.read_text(), path.name
    package = json.loads((ROOT / "package.json").read_text())
    assert package["homepage"] == "https://github.com/XJTLUmedia/Protect-Context"
    assert package["repository"]["url"] == "git+https://github.com/XJTLUmedia/Protect-Context.git"
    assert package["bugs"]["url"] == "https://github.com/XJTLUmedia/Protect-Context/issues"
    assert "mcp" in package["keywords"]
    assert 'Homepage = "https://github.com/XJTLUmedia/Protect-Context"' in PYPROJECT
    assert 'license = "MIT"' in PYPROJECT
    # setuptools>=77 rejects this classifier next to an SPDX license expression.
    assert "License :: OSI Approved :: MIT License" not in PYPROJECT
    assert "Typing :: Typed" in PYPROJECT


def test_readme_quickstart_leads_with_uvx_and_keeps_pi_first():
    pi = README.index("pi install npm:protect-context")
    uvx = README.index('"command": "uvx"')
    checkout = README.index("/absolute/path/to/protect-context/.venv/bin/python")
    assert pi < uvx < checkout
    assert "claude mcp add protect-context -- uvx protect-context mcp" in README
    assert "docs/assets/demo.gif" in README
    assert "demo-gif-placeholder" not in README
    assert "api.star-history.com/svg?repos=XJTLUmedia/Protect-Context&type=Date" in README
    assert "cursor.com/en/install-mcp?name=protect-context&amp;config=" in README
    assert "vscode.dev/redirect/mcp/install?name=protect-context&amp;config=" in README
    assert "insiders.vscode.dev/redirect/mcp/install?name=protect-context&amp;config=" in README
    assert "docs/integrations/cursor.md" in README
    assert "img.shields.io/pypi/v/protect-context" in README
    assert "img.shields.io/npm/v/protect-context" in README
    assert "img.shields.io/pepy/dt/protect-context" in README
    assert "img.shields.io/npm/dt/protect-context" in README


def test_registry_workflow_publishes_with_oidc_and_no_secrets():
    text = (ROOT / ".github/workflows/publish-mcp.yml").read_text()
    assert "mcp-publisher login github-oidc" in text
    assert "mcp-publisher publish" in text
    assert "workflow_dispatch" in text
    assert '["v*"]' in text
    assert "published" in text
    assert "id-token: write" in text
    assert "secrets." not in text
    assert "npm publish" not in text
    assert "twine" not in text


def test_root_mcp_and_glama_listing_files():
    mcp = json.loads((ROOT / ".mcp.json").read_text())
    server = mcp["mcpServers"]["protect-context"]
    assert server["command"] == "uvx"
    assert server["args"] == ["protect-context", "mcp"]
    glama = json.loads((ROOT / "glama.json").read_text())
    assert glama["maintainers"] == ["XJTLUmedia"]
