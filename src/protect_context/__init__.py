"""protect-context — agent guardrail suite (Python core: shared store, MCP server, CLI).

The mature third-party projects this suite builds on are vendored under
``vendor/`` (see :mod:`protect_context.vendored`).  Activation happens here, on
package import, so it runs before any submodule asks for ``pybreaker``,
``tenacity``, ``typer`` or ``pydantic_settings`` — those names then resolve to
the checkout instead of to a separately installed release.
"""

from . import vendored

vendored.activate()

__version__ = "3.3.0"

__all__ = ["__version__", "vendored"]
