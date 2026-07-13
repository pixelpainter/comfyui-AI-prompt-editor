comfyui-AI-prompt-editor
# Enhanced Prompt Editor
(This node requires that Ollama is installed on your OS)

A full prompt-writing studio inside a single ComfyUI node — AI-powered editing, style targeting, prompt browsing, and wireless prompt injection, all driven by your local Ollama models.

<img width="923" height="686" alt="EPE_Node" src="https://github.com/user-attachments/assets/489ebbed-2ed2-41ed-af03-fe1652a87f0f" />


## Features

**Editor**
- Multi-tab prompt editor (up to 4 tabs, persistent across restarts)
- Toolbar: undo/redo, version history, find & replace, case/sort/dedupe/trim, cleanup (strip markdown, weights, extra spaces), word wrap, live word + token counts
- **Synonyms** — select a word, get plain and creative alternatives from your Ollama model
- **Flag words** — highlights empty quality words ("beautiful", "4k", "masterpiece") and offers one-click replacements or deletion
- **Instruct edit** — type a natural-language change ("change the lighting to golden hour", "change her eye color to green") and the LLM applies it with coherent ripple effects (changing gender also updates pronouns, clothing, hair; changing season updates lighting, sky, environment), streaming live into the editor with apply/undo

**AI transforms** (via Ollama)
- **Enhance** — expands a short idea into a rich, diffusion-ready prompt
- **Variations** — three distinct aesthetic takes on the same subject
- **Inverter** — rewrites the prompt into a contrasting aesthetic
- Prompts are engineered for modern encoders (Flux, Qwen-Image, and similar): subject-first openings, declarative prose, no negations, spatial placement, verbatim quoted text

**From media**
- **Image to Prompt** — caption any image into a usable prompt (vision model required)
- **Video to Prompt** — samples frames from a clip and writes an image prompt
- **Extract from Image** — pulls the embedded prompt/workflow from PNG metadata

**Style tuning**
- 8 style targets (Midjourney, DALL·E, Imagen, Meta, Photorealistic, Cinematic, Anime, Concept Art) that reshape the AI's aesthetic vocabulary, not just an appended suffix
- **Override toggle** 
- off: the style only fills gaps your prompt leaves open;
- on: the style replaces your prompt's look while subjects, poses, and scene stay
- 6 sliders (Creativity, Length/Density, Focus, Variability, Boldness, Subject grip) that keep working **-on top of any style-**

**Library**
- Browse prompts from **Civitai**, **Genur.art**, and **Sea.art** with image/video previews, infinite scroll, and one-click Use / Enhance / Variations
- Personal **Favorites** and **Snippets** collections, plus a **Workflows** browser
- Search everything from inside the node

**Wireless targets**
- Push the prompt into any text widget in your workflow (CLIP Text Encode, etc.) at run time — no wires needed. Select targets once; every run injects the current prompt automatically.

## Requirements

- **ComfyUI** (recent build)
- **[Ollama](https://ollama.com/download)** installed and running on your Operating System — **this powers all AI features**
  - Text features: any capable instruct model (e.g. `ministral`, `nemotron`, `gpt-oss`)
  - Image/Video to Prompt: a **vision** model (e.g. `qwen3.5`, `Gemma4`, `qwen3.6`)
  - Model quality matters: larger models follow the style system noticeably better
- Python package `av` (installed automatically via `requirements.txt`) for video frame extraction

## Installation

**ComfyUI Manager:** search for "Enhanced Prompt Editor" and install.

**Manual:**
```bash
cd ComfyUI/custom_nodes
git clone https://github.com/pixelpainter/comfyui-AI-prompt-editor
pip install -r comfyui-AI-prompt-editor/requirements.txt
```
Restart ComfyUI.

## Quick start

1. Add the node: double-click the canvas → search **Enhanced Prompt Editor**
2. Open **⚙ AI Setup** (title bar) and pick your Ollama model
3. Under **Wireless targets**, click **+ Add target** and select your CLIP Text Encode node(s)
4. Write a rough idea and press **Enhance**
5. Optional: open **Style tuning**, pick a style, and re-run — toggle **Override** to fully restyle an already art-directed prompt

The prompt is injected into your targets automatically on every queue.

## Notes

- Everything runs locally — no cloud APIs, no keys
- The node has no inputs/outputs; wireless targets replace wiring
- Server routes only accept Ollama addresses on localhost/private networks, refuse fetching internal URLs, and cap upload sizes

## License

GPL-3.0 © pixelpainter — see [LICENSE](LICENSE).

Free to use, including in commercial workflows. Modified or redistributed versions must remain open source under GPL-3.0. Commercial redistribution or resale of this code requires permission from the author.
