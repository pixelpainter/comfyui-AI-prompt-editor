"""
Enhanced Prompt Editor — Standalone ComfyUI Extension
A self-contained prompt editor node with AI tools, browser tabs, and library.

Installation:
  ComfyUI Manager, or clone this repository into ComfyUI/custom_nodes/ and
  restart ComfyUI. The folder may be called anything; nothing here depends on
  its name.

Requirements:
  - Ollama (optional, for AI features): https://ollama.com
  - PyAV (optional, for video-to-prompt):
        pip install "av>=10.0.0,<16"
    The video routes detect its absence and say so plainly, so everything
    else works without it. (A source install can also use the extra:
    `pip install ".[video]"` from the cloned folder.)
"""

import logging
import os
import re

logger = logging.getLogger("EPE")


def _read_version():
    """The version, from the one place it is actually declared.

    This used to be EPE_VERSION = "1.0.19", hand-typed, and read by nothing
    in the codebase. A duplicate nobody consumes is a duplicate nobody
    notices going stale — and the first code to start using it would have
    reported whatever number was last remembered rather than the one that
    shipped.
    """
    # Installed from the registry or with pip: the package metadata is
    # authoritative.
    try:
        from importlib.metadata import version, PackageNotFoundError
        try:
            return version("comfyui-ai-prompt-editor")
        except PackageNotFoundError:
            pass
    except Exception:
        pass
    # Cloned straight into custom_nodes, which is how most people run it —
    # read the pyproject.toml sitting next to this file. Deliberately a regex
    # and not tomllib: tomllib is 3.11+, and this package supports 3.9.
    try:
        p = os.path.join(os.path.dirname(os.path.abspath(__file__)), "pyproject.toml")
        with open(p, "r", encoding="utf-8") as f:
            m = re.search(r'^\s*version\s*=\s*"([^"]+)"', f.read(), re.M)
        if m:
            return m.group(1)
    except Exception:
        pass
    return "unknown"


EPE_VERSION = _read_version()

# ── Node classes ──────────────────────────────────────────────────────────────
from .nodes import NODE_CLASS_MAPPINGS, NODE_DISPLAY_NAME_MAPPINGS

# ── Web assets directory ───────────────────────────────────────────────────────
WEB_DIRECTORY = "./js"

# ── API routes ────────────────────────────────────────────────────────────────
# Set by _register_routes. A failure here is NOT fatal — the node class and
# the web assets still register, so ComfyUI reports the pack as loaded — but
# every AI feature will 404, and the user has no way to tell that from a bug.
# So it is said again on the "loaded" line, which is the one line anyone
# actually looks for in a startup log thousands of lines long.
ROUTES_OK = False


def _routes_already_live():
    """Did an EARLIER import of api.py already register the routes?

    api.py parks its state in sys.modules["_epe_singleton_state_v1"] and sets
    _EPE_ALREADY_REGISTERED there on first import, precisely so a second copy
    of the pack contributes nothing. If this copy's import then fails, the
    routes are still live and the alarm below would be false — which is worse
    than saying nothing, because it is the one line anyone looks for in a
    startup log thousands of lines long.
    """
    try:
        import sys as _sys
        _h = _sys.modules.get("_epe_singleton_state_v1")
        return bool(_h is not None and getattr(_h, "_EPE_ALREADY_REGISTERED", False))
    except Exception:
        return False


def _register_routes():
    global ROUTES_OK
    try:
        from . import api  # importing registers all @routes decorators
        ROUTES_OK = True
        logger.info("EPE: API routes registered successfully")
    except Exception as e:
        if _routes_already_live():
            # A second copy of the pack, whose import failed. The first copy's
            # routes are answering; this one has nothing to add and no reason
            # to raise an alarm about it.
            ROUTES_OK = True
            logger.warning(
                "EPE: this copy failed to import (%s), but another copy of "
                "the pack has already registered the API routes. You have two "
                "EPE folders in custom_nodes — remove one.", e)
        else:
            logger.error(f"EPE: Failed to register API routes: {e}", exc_info=True)

_register_routes()

# Logged so a bug report carries the version without anyone having to go
# looking for it.
logger.info("EPE %s loaded%s", EPE_VERSION,
            "" if ROUTES_OK else
            "  ***  WITHOUT API ROUTES — every AI feature will fail  ***")

__all__ = ["NODE_CLASS_MAPPINGS", "NODE_DISPLAY_NAME_MAPPINGS", "WEB_DIRECTORY",
           "ROUTES_OK"]
