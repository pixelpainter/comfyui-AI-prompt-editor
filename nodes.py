"""
Enhanced Prompt Editor — ComfyUI Node Definition

Pure UI node — no inputs, no outputs, nothing to wire. The whole editor is a
DOM widget mounted by js/epe_node.js; this class exists only so ComfyUI has
something to register.

Text reaches the rest of the graph through **wireless targets**: pick any text
widget in the canvas (subgraphs included) from the editor's target bar, and the
prompt is written into it at queue time, just before ComfyUI serializes the
graph. That injection lives in the graphToPrompt hook in epe_node.js, not here.

Muting (mode 2) or bypassing (mode 4) this node — or a subgraph containing it —
switches the injection off, which is the only off switch it has.
"""


class EPENode:
    @classmethod
    def INPUT_TYPES(cls):
        return {"required": {}}

    # ComfyUI reads this class attribute, not the docstring, for the node
    # library and the search results. Without it the one place a new user
    # meets the node says nothing about it.
    DESCRIPTION = ("A full prompt-writing studio in one node — AI enhance, "
                   "variations and instruct-edit through your local Ollama "
                   "models, prompt browsing from Civitai and Genur, a saved "
                   "library, and wireless prompt injection into any text "
                   "widget in the graph.")

    RETURN_TYPES = ()
    FUNCTION = "noop"
    OUTPUT_NODE = True
    CATEGORY = "Enhanced Prompt Editor"

    def noop(self):
        return ()

    @classmethod
    def IS_CHANGED(cls, **kwargs):
        return float("nan")

    @classmethod
    def VALIDATE_INPUTS(cls, **kwargs):
        return True


NODE_CLASS_MAPPINGS = {
    "EPENode": EPENode,
}

NODE_DISPLAY_NAME_MAPPINGS = {
    "EPENode": "Enhanced Prompt Editor",
}
