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
<img src="assets/anatomy.png" alt="EPE feature map — one node, nine tools" width="920">
</div>

## Features

**Editor** — Multi-tab prompt editor (up to 4 tabs, persistent across restarts) with undo/redo, version history, find & replace, case/sort/dedupe/trim, cleanup (strip markdown, weights, extra spaces), word wrap, and live word + token counts. **Synonyms** suggests plain and creative alternatives for any selected word; **Flag words** highlights empty quality words ("beautiful", "4k", "masterpiece") and offers one-click replacements.

**AI transforms** — **Enhance** expands a short idea into a rich prompt. **Variations** writes three distinct aesthetic takes on the same subject. **Inverter** rewrites the prompt into a contrasting aesthetic.

**Instruct edit** — Type a change in plain language and the LLM rewrites the prompt around it, with coherent ripple effects: changing gender also updates pronouns, clothing and hair; changing season updates lighting, sky and environment. The result streams into a review window with the original kept alongside it — accept the edits with **Use this**, or **Discard** and nothing is lost. Chain Edits together, each one building on the result before it, and the instruction stays in the box so you can tweak a word and run it again. Every instruction applied joins a running **thread** for that prompt, which gives relative follow-ups like *"dial that back"* something to refer to. Save a chain of edits as a reusable **sequence** and run the whole set against any other prompt in one click.

**From media** — **Image to Prompt** captions any image into a usable prompt (vision model required). **Video to Prompt** samples frames from a clip and writes an image prompt. **Extract from Image** pulls an embedded prompt (from embedded workflow) from PNG metadata.

**Style tuning** — 8 style targets and 6 sliders that reshape the AI's aesthetic vocabulary, not just an appended suffix.

**Library** — Browse prompts from **Civitai** and **Genur.art** with image/video previews, infinite scroll, and one-click Use / Enhance / Variations. Personal **Favorites** and **Snippets** collections, plus a **Workflows** browser.

**Collapsible layout** — Fold the Transform rail, the style tuning block or the Library away and the editor takes back the space. Drag any divider, or click its tab.

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
| Text model | Any capable instruct model (e.g. `mistral`, `nemotron`, `gpt-oss`) |
| Vision model | Needed only for Image/Video to Prompt (e.g. `qwen3.5`, `gemma4`) |
| Python `av` | **Optional** — only for Video to Prompt. Install with `pip install "av>=10.0.0,<16"` |

> Model quality matters: larger models follow the style system noticeably better.

### Setting up Ollama

1. **Install Ollama** — download the installer for Windows or macOS from [ollama.com/download](https://ollama.com/download) and run it. On Linux: `curl -fsSL https://ollama.com/install.sh | sh`. Once installed, Ollama runs quietly in the background.
2. **Download a model** — open a terminal (Command Prompt / PowerShell on Windows) and pull a model:

```bash
# a text model for Enhance, Variations, Instruct edit, Synonyms…
ollama pull mistral

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

> In-app help lives in the node's **?** button, and the same reference is available offline in [`HELP.md`](HELP.md).

<div align="center">
<img src="assets/enhance.gif" alt="Enhance: open a new tab, write a rough idea, and it becomes a diffusion-ready prompt" width="840">
</div>

## Example workflows

A ready-to-run example lives in [`example_workflows/`](example_workflows). Once EPE is installed it also appears in ComfyUI's **Workflow → Browse Templates** menu.

- **[Krea 2 Turbo — Text to Image (with EPE)](example_workflows/Krea2-Turbo_Text-to-Image_EPE.json)** — EPE writes the prompt and injects it into the CLIP Text Encode node wirelessly, driving a Krea-2 Turbo text-to-image graph.

To load it, drag the `.json` onto your canvas, or use **Workflow → Open**.

## Instruct edit

Describe the change; the model rewrites the prompt coherently — one instruction can ripple through lighting, shadows, and atmosphere while everything else stays put.

<div align="center">
<img src="assets/instruct.gif" alt="Instruct edit: red hair, then a harvest moon, then wings — each edit builds on the last" width="840">
</div>

## Style tuning

Pick a style target and the AI writes *for* that aesthetic. **Override Off** fills only the gaps your prompt leaves open; **Override On** re-art-directs the look while subjects, poses, and scene stay. Six sliders fine-tune every transform, on top of any style.

<div align="center">
<img src="assets/style-tuning.png" alt="Style tuning: 8 style targets, override modes, 6 sliders" width="760">
</div>

## Collapsible layout

Three dividers, three panels. Drag one to resize, or click its pull-tab to fold that panel away entirely — the Transform rail, the style tuning block and the Library each collapse on their own, and the editor takes back every pixel they give up. Panels keep their place when you switch away and come back.

<div align="center">
<img src="assets/layout.gif" alt="Collapsible layout: fold the rail, the tuning block or the Library away and the editor takes the space" width="840">
</div>

## Wireless targets

Bind as many text widgets as you like and the prompt is injected into every one
of them on each queue — no wires, no reroutes, nothing on the canvas to redraw
when you change your mind. Targets are saved with your workflow.

<div align="center">
<img src="assets/wireless.gif" alt="Queue the graph and the prompt lands in two CLIP Text Encode nodes that have no wires" width="840">
</div>

### Adding a target

Click **+ Add target** and a picker opens listing every text widget in your graph — subgraphs included, searchable by node name, widget, or ID. Pick your CLIP Text Encode and its chip joins the bar; the number on the chip is the node's ID, and widgets that are already targets are marked so you can't double-add them.

<div align="center">
<img src="assets/targetpicker.gif" alt="Adding a wireless target: the picker lists every text widget in the graph" width="840">
</div>

## Library

Search **Civitai** and **Genur.art** without leaving the node — image *and* video results, with infinite scroll. Open any result to see its full prompt on a detail card: **Use** sends it to the main editor, **Enhance** / **Variations** transform it on the spot, and **Save as New** / **Snippets** file it into your collections. The media itself is workable too — **Image to Prompt** (or **Video to Prompt** on video results) writes a fresh prompt from the image using your vision model.

<div align="center">
<img src="assets/library.gif" alt="Library: search, open the detail card, Use the prompt, and run Image to Prompt" width="840">
</div>

### Workflows

The **Workflows** tab searches Civitai's ComfyUI workflow listings directly — one click on **⬇ Load Workflow** opens the full node graph in a new canvas tab, ready to queue. Image results can carry workflows too: when a Civitai or Genur.art image has one embedded in its PNG metadata, the **⚡ Workflow** button lights up to load it.

<div align="center">
<img src="assets/workflows.gif" alt="Workflows: search and load a full ComfyUI graph into a new canvas tab" width="840">
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

## Changelog

### 1.0.20

- **Ten prompt tabs**, up from four. Each keeps its own prompt, instruct edit direction thread and undo history. Workflows saved by an older build open with all their tabs visible.
- **Send to tab.** Every result screen — Enhance, Variations, Instruct edit, img2img, vid2prompt — has a **Send to tab** button beside **Use this**. Pick any open tab or a new one and the result lands there as that tab's prompt, while you stay where you are with the review still open. Keep a promising Enhance in tab 3, run a different style on the same prompt, compare the two before committing to either. It warns before overwriting a tab that already has a prompt, and Ctrl+Z in that tab puts the old one back.
- **What's in the prompt box is what renders**, in every state. The one exception is Variations, where there's no single prompt in the box — three cards instead — so queueing sends your committed prompt until you pick one.
- Instruct edit directions stay with their prompt across reloads, tab switches and workflow switches.
- Undo works per tab and across workflows, and a reopened tab comes back with its direction thread and edit history.
- Memory holds steady across a session, including nodes inside subgraphs.
- Startup cleanup removes only files EPE wrote, and clears its own scratch folder afterwards.
- Ollama checks no longer stall ComfyUI when several nodes ask at once.
- Library and saved sequences keep your newest entries if you hit the storage limit.
- Workflow browsing pages through the full result set, and a workflow inside a `.zip` opens as the right one.
- Workflow files can't reach past EPE's own settings.

### 1.0.19
- **Embedded workflows load.** Opening a Civitai or Genur result that carries a ComfyUI workflow pulls the graph through. Verified against 759 saved images.
- **Workflow search works again.** Civitai changed how search results are paged, which left the Workflows tab empty. Search and infinite scroll are back.
- **Only workflows you can actually load are listed.** Civitai lets creators require a login to download, and those used to fill the results and then fail on open. They are now filtered out, so what you see is what loads.
- Workflow results stay on screen after you load one. The list used to empty itself when the node redrew.
- **Undo steps back through Instruct edits.** ↶ (Ctrl+Z) moves back one edit at a time through a chain.
- Closing a prompt tab during a review now ends the review cleanly, and keeps unsaved text in the tab you were working in.
- Hardened the server routes that fetch remote images, videos and workflow files, and tightened how the Ollama address is handled. Recommended update for anyone whose ComfyUI is reachable beyond localhost.
- In-app help (**? Help**) rewritten for Instruct edit — chaining, the steps chip and saved sequences — and now covers the collapsible layout.

### 1.0.18
- Chained Instruct edits now stay put while you work. Clicking back into the instruction box keeps the current result on screen and the direction thread intact, so you can stack several edits and accept them together at the end.
- Switching prompt tabs now ends an open review cleanly, so each tab keeps its committed prompt.

### 1.0.17
- **Instruct edit** — describe a change in plain language and the model rewrites the prompt around it, streaming into the editor with Use this / Discard. Changes ripple coherently: ask for a different season and the light, sky and ground follow.
- Instructions build a running thread for that prompt, so a relative follow-up like "dial that back" knows what you meant.
- Save a thread as a reusable sequence and run the whole set against any other prompt.
- The instruct box could not be clicked until something else resized the node — fixed.
- The node's minimum width now follows the Library column, so collapsing the Library lets the node get properly narrow.
- Favorites and Snippets cards now collapse to a single title row with their token count, instead of leaving a shrunken editor and both button rows on show.
- The Transform rail, style tuning block and Library can each be folded away — drag the divider or click its tab, and the editor takes back the space. Panels keep their place when you switch away.
- Style sliders remapped so each one moves a single quality instead of several at once.
- Rewritten prompt construction — layered fidelity with an invention quota, so enhanced prompts stay closer to what you actually asked for.
- Per-prompt **↺ Default** now sticks instead of resetting when you come back to it.

### 1.0.16
- The Civitai browser now runs on Civitai's public API. More stable, but search works differently: it matches words against prompt text across the feed rather than searching the whole site index, so expect different — sometimes fewer — results, and narrow terms take a couple of seconds longer.
- Search no longer matches inside words. Searching "elf" returned every prompt containing "herself".
- Fixed the Library detail card overlapping its buttons on a short node.
- Sea.art browsing removed due to instability.

### 1.0.15
- Library now browses without a search — Civitai, Genur.art and Sea.art open on a live feed you can scroll straight away; type any time to search.
- Added a **Models** filter to the Civitai and Genur browsers to focus the feed on chosen base models (multi-select on Civitai, single on Genur).
- Rebuilt the Sea.art browser on Sea.art's current API — fixes search (their old endpoint stopped working), adds category chips (Fan Art, GPT image 2, Trending Seedance, Short Film, Viral Clips), and restores video prompts and playback.
- Sea.art results are filtered to posts that actually carry a prompt, so no more empty detail cards.
- The Library panel is now resizable — drag the divider between the editor and the panel; double-click to reset.
- Fixed Variations sometimes returning only two results (or a truncated third) by giving it a larger generation budget.

### 1.0.14
- Fixed Ollama initialization on Linux — the node now starts Ollama automatically if it isn't running. Auto-start only works if Ollama is on your PATH.
- Clearer message and a longer connection timeout when Ollama can't be reached.
- Ollama requests now route through the ComfyUI backend — fixes empty model lists and failed generation when ComfyUI is opened from another machine (browser CORS). No OLLAMA_ORIGINS needed.
- Workflow extraction now also detects API-format graphs embedded in image metadata.

## License

GPL-3.0 © pixelpainter — see [LICENSE](LICENSE).

Free to use, including in commercial workflows. Modified or redistributed versions must remain open source under GPL-3.0. Commercial redistribution or resale of this code requires permission from the author.
