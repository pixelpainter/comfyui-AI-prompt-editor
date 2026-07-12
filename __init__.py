"""
Enhanced Prompt Editor — Standalone ComfyUI Extension
A self-contained prompt editor node with AI tools, browser tabs, and library.

Installation:
  Place this folder in ComfyUI/custom_nodes/Comfyui_Enhanced_Prompt_Editor/
  Restart ComfyUI.

Requirements:
  - Ollama (optional, for AI features): https://ollama.com
  - PyAV (optional, for video features): pip install av
"""

import logging

EPE_VERSION = "1.0.13"

logger = logging.getLogger("EPE")

# ── Node classes ──────────────────────────────────────────────────────────────
from .nodes import NODE_CLASS_MAPPINGS, NODE_DISPLAY_NAME_MAPPINGS

# ── Web assets directory ───────────────────────────────────────────────────────
WEB_DIRECTORY = "./js"

# ── API routes ────────────────────────────────────────────────────────────────
def _register_routes():
    try:
        from . import api  # importing registers all @routes decorators
        logger.info("EPE: API routes registered successfully")
    except Exception as e:
        logger.error(f"EPE: Failed to register API routes: {e}", exc_info=True)

_register_routes()

__all__ = ["NODE_CLASS_MAPPINGS", "NODE_DISPLAY_NAME_MAPPINGS", "WEB_DIRECTORY"]
