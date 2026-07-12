"""
Enhanced Prompt Editor — ComfyUI Node Definition
Pure UI node — no inputs or outputs.
Use Import from Node / Send to Node buttons inside the EPE to exchange text with the graph.
"""


class EPENode:
    @classmethod
    def INPUT_TYPES(cls):
        return {"required": {}}

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
