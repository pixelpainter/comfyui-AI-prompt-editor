<div align="center">

# Enhanced Prompt Editor (EPE)

[![ComfyUI Registry](https://img.shields.io/badge/dynamic/json?url=https%3A%2F%2Fapi.comfy.org%2Fnodes%2Fcomfyui-ai-prompt-editor&query=%24.latest_version.version&prefix=v&label=ComfyUI%20Registry&labelColor=1c2431&color=4a90d9)](https://registry.comfy.org/nodes/comfyui-ai-prompt-editor)
[![Downloads](https://img.shields.io/badge/dynamic/json?url=https%3A%2F%2Fapi.comfy.org%2Fnodes%2Fcomfyui-ai-prompt-editor&query=%24.downloads&label=downloads&labelColor=1c2431&color=44cc88)](https://registry.comfy.org/nodes/comfyui-ai-prompt-editor)
[![GitHub Stars](https://img.shields.io/github/stars/pixelpainter/comfyui-AI-prompt-editor?style=flat&logo=github&label=Stars&labelColor=1c2431&color=8a9aac)](https://github.com/pixelpainter/comfyui-AI-prompt-editor/stargazers)
[![License: GPL-3.0](https://img.shields.io/badge/license-GPL--3.0-31415a?labelColor=1c2431)](LICENSE)
[![Buy me a coffee](https://img.shields.io/badge/Buy%20me%20a%20coffee-%E2%98%95-ffdd00?labelColor=1c2431)](https://buymeacoffee.com/pixelpainter)

**A full prompt-writing studio inside a single ComfyUI node** — AI-powered editing, style targeting,
prompt browsing, and wireless prompt injection, all driven by your local [Ollama](https://ollama.com) models.<br>
No cloud APIs. No keys. Nothing leaves your machine.

<img src="EPE_Node.png" alt="Enhanced Prompt Editor node" width="850">

</div>

---

## What it does

EPE replaces the humble prompt textbox with a complete writing environment. Write a rough idea, and your local LLM expands it into a rich, diffusion-ready prompt engineered for modern encoders (Flux, Qwen-Image, and similar): subject-first openings, declarative prose, no negations, spatial placement, verbatim quoted text. Then refine it in plain language, aim it at a specific aesthetic, and push it into any node in your workflow — without a single wire.

<div align="center">
<img src="assets/anatomy.png" alt="EPE feature map — one node, seven tools" width="920">
</div>

## Features

**Editor** — Multi-tab prompt editor (up to 4 tabs, persistent across restarts) with undo/redo, version history, find & replace, case/sort/dedupe/trim, cleanup (strip markdown, weights, extra spaces), word wrap, and live word + token counts. **Synonyms** suggests plain and creative alternatives for any selected word; **Flag words** highlights empty quality words ("beautiful", "4k", "masterpiece") and offers one-click replacements.

**AI transforms** — **Enhance** expands a short idea into a rich prompt. **Variations** writes three distinct aesthetic takes on the same subject. **Inverter** rewrites the prompt into a contrasting aesthetic.

**Instruct edit** — Type a natural-language change and the LLM applies it with coherent ripple effects: changing gender also updates pronouns, clothing, and hair; changing season updates lighting, sky, and environment. Streams live into the editor with apply/undo.

**From media** — **Image to Prompt** captions any image into a usable prompt (vision model required). **Video to Prompt** samples frames from a clip and writes an image prompt. **Extract from Image** pulls an embedded prompt (from embedded workflow) from PNG metadata.

**Style tuning** — 8 style targets and 6 sliders that reshape the AI's aesthetic vocabulary, not just an appended suffix.

**Library** — Browse prompts from **Civitai**, **Genur.art**, and **Sea.art** with image/video previews, infinite scroll, and one-click Use / Enhance / Variations. Personal **Favorites** and **Snippets** collections, plus a **Workflows** browser.

**Wireless targets** — Push the prompt into any text widget in your workflow at run time — no wires needed.

## Installation

### ComfyUI Manager (recommended)

1. Open **Manager → Custom Nodes Manager**
2. Search for **Enhanced Prompt Editor**
3. Click **Install**, then restart ComfyUI

### comfy CLI

```bash
comfy node install comfyui-ai-prompt-editor
```

### Manual (git)

```bash
cd ComfyUI/custom_nodes
git clone https://github.com/pixelpainter/comfyui-AI-prompt-editor
pip install -r comfyui-AI-prompt-editor/requirements.txt
```

Restart ComfyUI after installation.

### Requirements

| Requirement | Notes |
|---|---|
| **ComfyUI** | Any recent build |
| **[Ollama](https://ollama.com/download)** | Must be installed and running — **this powers all AI features** |
| Text model | Any capable instruct model (e.g. `ministral`, `nemotron`, `gpt-oss`) |
| Vision model | Needed only for Image/Video to Prompt (e.g. `qwen3.5`, `gemma4`) |
| Python `av` | Installed automatically via `requirements.txt` (video frame extraction) |

> Model quality matters: larger models follow the style system noticeably better.

### Setting up Ollama

1. **Install Ollama** — download the installer for Windows or macOS from [ollama.com/download](https://ollama.com/download) and run it. On Linux: `curl -fsSL https://ollama.com/install.sh | sh`. Once installed, Ollama runs quietly in the background.
2. **Download a model** — open a terminal (Command Prompt / PowerShell on Windows) and pull a model:

```bash
# a text model for Enhance, Variations, Instruct edit, Synonyms…
ollama pull ministral

# a vision model for Image to Prompt / Video to Prompt
ollama pull qwen3-vl
```

3. **Verify** — `ollama list` shows your installed models. That's it: EPE finds them automatically in **⚙ AI Setup**.

## Quick start

1. Add the node: double-click the canvas → search **Enhanced Prompt Editor**
2. Open **⚙ AI Setup** (title bar) and pick your Ollama model
3. Under **Wireless targets**, click **+ Add target** and select your CLIP Text Encode node(s)
4. Write a rough idea and press **Enhance**
5. Queue — the prompt is injected into your targets automatically on every run

<div align="center">
<img src="assets/enhance.gif" alt="Enhance: a rough idea becomes a diffusion-ready prompt" width="840">
</div>

## Instruct edit

Describe the change; the model rewrites the prompt coherently — one instruction can ripple through lighting, shadows, and atmosphere while everything else stays put.

<div align="center">
<img src="assets/instruct.gif" alt="Instruct edit: change the lighting to golden hour" width="840">
</div>

## Style tuning

Pick a style target and the AI writes *for* that aesthetic. **Override Off** fills only the gaps your prompt leaves open; **Override On** re-art-directs the look while subjects, poses, and scene stay. Six sliders fine-tune every transform, on top of any style.

<div align="center">
<img src="assets/style-tuning.png" alt="Style tuning: 8 style targets, override modes, 6 sliders" width="920">
</div>

## Wireless targets

Select target nodes once — every queue injects the current prompt into all of them automatically. The badge by the title shows how many targets are active. Prefer wiring things yourself? Skip targets and use EPE purely as an editor.

<div align="center">
<img src="assets/wireless.gif" alt="Wireless targets: prompt injected into CLIP Text Encode at queue time" width="840">
</div>

### Adding a target

Click **+ Add target** and a picker opens listing every text widget in your graph — subgraphs included, searchable by node name, widget, or ID. Pick your CLIP Text Encode and its chip joins the bar; the number on the chip is the node's ID, and widgets that are already targets are marked so you can't double-add them.

<div align="center">
<img src="assets/targetpicker.gif" alt="Adding a wireless target: the picker lists every text widget in the graph" width="840">
</div>

## Library

Search **Civitai**, **Genur.art**, and **Sea.art** without leaving the node — image *and* video results, with infinite scroll. Open any result to see its full prompt on a detail card: **Use** sends it to the main editor, **Enhance** / **Variations** transform it on the spot, and **Save as New** / **Snippets** file it into your collections. The media itself is workable too — **Image to Prompt** (or **Video to Prompt** on video results) writes a fresh prompt from the image using your vision model.

<div align="center">
<img src="assets/library.gif" alt="Library: search, open the detail card, Use the prompt, and run Image to Prompt" width="840">
</div>

### Workflows

Results whose images carry an embedded ComfyUI graph appear in the **Workflows** tab — one click on **⬇ Load Workflow** opens the full node graph on your canvas, ready to queue.

<div align="center">
<img src="assets/workflows.gif" alt="Workflows: search and load a full ComfyUI graph from the library" width="640">
</div>

### Favorites & Snippets

Two personal collections: **Favorites** store whole prompts (save from the File ▾ menu or any detail card); **Snippets** are reusable fragments — click one and it drops straight into your prompt.

<div align="center">
<img src="assets/favsnips.gif" alt="Favorites store whole prompts; snippets drop fragments into the editor" width="840">
</div>

## Notes

- Everything runs locally — no cloud APIs, no keys
- The node has no inputs/outputs; wireless targets replace wiring
- Server routes only accept Ollama addresses on localhost/private networks, refuse fetching internal URLs, and cap upload sizes
- In-app help: click **? Help** in the node's title bar

## Support

Bugs and feature requests → [open an issue](https://github.com/pixelpainter/comfyui-AI-prompt-editor/issues).

⭐ If EPE has earned a place in your workflow, a star helps others find it — and I always love a good cup of [coffee](https://buymeacoffee.com/pixelpainter). ☕

## License

GPL-3.0 © pixelpainter — see [LICENSE](LICENSE).

Free to use, including in commercial workflows. Modified or redistributed versions must remain open source under GPL-3.0. Commercial redistribution or resale of this code requires permission from the author.
