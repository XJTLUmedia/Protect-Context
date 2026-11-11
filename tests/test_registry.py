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


def _declared_dependencies():
    """`[project].dependencies`, single- or multi-line (tomllib needs 3.11)."""
    block = re.search(r"^dependencies = \[(.*?)\]", PYPROJECT, re.MULTILINE | re.DOTALL)
    assert block, "dependencies missing from [project]"
    return re.findall(r'"([^"]+)"', block.group(1))


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


def test_check_workflow_runs_both_suites_and_their_prerequisites():
    """The only enforcement of "green before shipping" (SPEC §7) is this
    workflow, so a dropped job or prerequisite would go unnoticed.

    Found 2026-11-10 by running the extension job in a bare container: it needs
    `git` and `python3`, and three cross-runtime tests import `protect_context`
    from the child interpreter, so a bare interpreter is not enough either.
    """
    text = (ROOT / ".github/workflows/check.yml").read_text()
    assert "npm run check" in text, "extension suite"
    assert "pytest -q" in text, "python suite"
    assert 'node-version: "22"' in text
    assert '"3.10", "3.11", "3.12", "3.13"' in text, "python matrix matches the classifiers"
    # Prerequisites for the extension job's cross-runtime tests.
    assert "pip install -e ." in text, "cross-runtime tests import the package"
    assert "pull_request" in text and "push" in text
    # Supply-chain hardening: a movable action tag is an input to every run.
    for line in text.splitlines():
        stripped = line.strip()
        if not stripped.startswith("- uses: "):
            continue
        ref = stripped.split("uses: ", 1)[1].split()[0]
        action, _, pin = ref.partition("@")
        assert action.startswith("actions/"), action
        assert re.fullmatch(r"[0-9a-f]{40}", pin), f"{action} must be pinned by commit SHA"
    assert "permissions:" in text and "contents: read" in text
    assert text.count("persist-credentials: false") == 2
    # vendor/ is a set of gitlinks. Checkout runs `git submodule foreach` even
    # when it is not asked to recurse, and that command exits 128 unless every
    # gitlink has a URL. Both jobs must also fetch the checkouts: the Python
    # import bootstrap prefers them over site-packages.
    assert text.count("submodules: true") == 2


def test_vendor_gitlinks_have_gitmodules_urls():
    """Checkout dies before any test if a vendor gitlink has no URL.

    actions/checkout runs `git submodule foreach` while removing credentials.
    Git 2.56 exits 128 with `No url found for submodule path 'vendor/...'`
    when the index has a gitlink and `.gitmodules` does not name it.
    """
    import subprocess

    listed = subprocess.run(
        ["git", "ls-tree", "HEAD", "vendor/"],
        check=True,
        capture_output=True,
        text=True,
        cwd=ROOT,
    )
    gitlinks = []
    for line in listed.stdout.splitlines():
        mode, _typ, _sha, path = line.split(maxsplit=3)
        assert mode == "160000", line
        gitlinks.append(path)
    assert gitlinks, "vendor/ checkouts disappeared"
    modules = (ROOT / ".gitmodules").read_text()
    for path in gitlinks:
        assert f'path = {path}\n' in modules, path
        # The URL is the next line in the block git writes.
        block = modules.split(f'[submodule "{path}"]', 1)
        assert len(block) == 2, path
        body = block[1].split("\n[", 1)[0]
        assert "url = https://github.com/" in body, path
        assert body.strip().endswith(".git"), path


def test_root_mcp_and_glama_listing_files():
    """The project file must run THIS checkout, not the published wheel.

    It pointed at `uvx protect-context mcp`, which serves PyPI 3.3.1 — the same
    version string as this tree but an older surface (13 tools, no
    `guard_brief`), so every MCP client pointed at the project tested the
    artifact instead of the code (measured 2026-11-11).
    """
    mcp = json.loads((ROOT / ".mcp.json").read_text())
    server = mcp["mcpServers"]["protect-context"]
    assert server["command"] != "uvx", "the project file must not run the published wheel"
    assert server["command"].endswith("python")
    assert server["args"] == ["-m", "protect_context", "mcp"]
    assert server["env"]["PYTHONPATH"] == "src"
    glama = json.loads((ROOT / "glama.json").read_text())
    assert glama["maintainers"] == ["XJTLUmedia"]


def test_one_version_everywhere():
    """A release reads its version from six files; drift ships a package whose
    --version disagrees with the registry entry (found 2026-11-10: 3.2.2 in
    package.json and bin/pc.mjs, 3.2.1 everywhere else — and then again in
    package-lock.json after the fix, which is why the lockfile is pinned too)."""
    import protect_context

    expected = _project_field("version")
    assert protect_context.__version__ == expected, "__init__.__version__"
    assert SERVER["version"] == expected, "server.json"
    assert json.loads((ROOT / "package.json").read_text())["version"] == expected, "package.json"
    # npm records the root version twice in the lockfile; `npm ci` tolerates a
    # mismatch here, so only an explicit assertion keeps them honest.
    lock = json.loads((ROOT / "package-lock.json").read_text())
    assert lock["version"] == expected, "package-lock.json version"
    assert lock["packages"][""]["version"] == expected, "package-lock.json packages[''].version"
    bin_text = (ROOT / "bin" / "pc.mjs").read_text()
    assert f'.version("{expected}")' in bin_text, "bin/pc.mjs"
    changelog = (ROOT / "CHANGELOG.md").read_text()
    assert f"## {expected}" in changelog, "CHANGELOG.md has a section for the shipped version"


# Which distribution provides each third-party import the package uses.
_IMPORT_TO_DIST = {
    "cachetools": "cachetools",
    "dotenv": "python-dotenv",
    "fastmcp": "fastmcp",
    "humanize": "humanize",
    "mcp": "mcp",
    "orjson": "orjson",
    "pybreaker": "pybreaker",
    "pydantic": "pydantic",
    "pydantic_settings": "pydantic-settings",
    "rich": "rich",
    "tenacity": "tenacity",
    "typer": "typer",
}


def test_every_third_party_import_is_declared():
    """A wheel must declare what it imports.

    Found 2026-11-10: `pip install protect-context` into a clean container left
    `store.py` importing an undeclared `tenacity` and `layers.py` an undeclared
    `dotenv`, so the package failed at import time — invisible from a dev venv
    where both were installed by hand.
    """
    import ast
    import sys

    src = ROOT / "src" / "protect_context"
    local = {p.stem for p in src.glob("*.py")} | {"protect_context"}
    imported = set()
    for path in src.rglob("*.py"):
        for node in ast.walk(ast.parse(path.read_text())):
            if isinstance(node, ast.Import):
                names = [a.name for a in node.names]
            elif isinstance(node, ast.ImportFrom) and node.level == 0 and node.module:
                names = [node.module]
            else:
                continue
            for name in names:
                top = name.split(".")[0]
                if top not in sys.stdlib_module_names and top not in local:
                    imported.add(top)

    declared = {
        re.split(r"[<>=!~\[]", dep, maxsplit=1)[0].strip().lower()
        for dep in _declared_dependencies()
    }
    undeclared_imports = sorted(imported - set(_IMPORT_TO_DIST))
    assert not undeclared_imports, f"add these to _IMPORT_TO_DIST: {undeclared_imports}"
    missing = sorted({_IMPORT_TO_DIST[m] for m in imported} - declared)
    assert not missing, f"imports without a declared dependency: {missing}"
