# EPE — In-App Help

## Contents

- [Quick start](#quick-start)
- [Wireless targets](#wireless-targets)
- [Transform](#transform)
- [From media](#from-media)
- [Style tuning](#style-tuning)
- [Instruct edit](#instruct-edit)
- [Editor tools](#editor-tools)
- [Library](#library)

## Quick start

**1.** Open **⚙ AI Setup** (title bar) and pick your Ollama model.  
**2.** Under **Wireless targets**, click **+ Add target** and select your CLIP Text Encode node(s).  
**3.** Write a rough idea in the editor.  
**4.** Press **Enhance** — the AI expands it into a full, diffusion-ready prompt.  
**5.** Queue your workflow — the prompt is injected into your targets automatically.

> Tip: pick a Style in **Style tuning** before enhancing to aim the result at a specific look — toggle **Override** to restyle an already art-directed prompt.

## Wireless targets

Wireless targets send your prompt into text widgets elsewhere in the workflow — no wires needed.
- Click **+ Add target** and pick a node (e.g. CLIP Text Encode, Text Widget). On every queue, the current prompt is injected into all targets automatically based on the selected tab.
- The badge by the title shows how many targets are active.
- Prefer to wire it yourself? Use EPE as a prompt editor only — skip targets, then copy the prompt and paste it into your node manually.

## Transform

**Enhance** — expands a short idea into a full, diffusion-ready prompt.  
**Variations** — generates 3 alternative takes on your prompt to pick from.  
**Inverter** — rewrites your prompt into a contrasting aesthetic.

> Tip: results appear in the editor for review — keep them by clicking **Use**, or press **Undo** (Ctrl+Z) to restore your previous text.

## From media

**Image to Prompt** — open any image to describe as a prompt (needs a vision model, e.g. qwen3.5, gemma4).  
**Video to Prompt** — samples multiple frames from a clip and writes an image prompt from a video.  
**Extract from Image** — pulls the embedded prompt from a ComfyUI-generated PNG/JPEG/WebP.

You can also run **Image to Prompt** or **Video to Prompt** directly on any search result from Civitai, Genur.art, or Sea.art, or just run an **Enhance** on the image prompt itself — click on/open a search result and use the button in its detail panel.

## Style tuning

Pick a **Style** (Midjourney, DALL·E, Anime, Cinematic…) to have the AI create a prompt that renders an image close to that look/feel. **Default** resets the style and all sliders. Adjust the sliders alongside the Style for more custom results.

**Override Off** — the style only fills gaps your prompt leaves open.  
**Override On** — the style replaces your prompt's look; subjects, poses, and scene stay.

> Tip: the 6 sliders (Creativity, Length, Focus, Variability, Boldness, Subject grip) fine-tune every transform. Hover over a slider for more tips.

## Instruct edit

- Use the **✎** row above the toolbar to change your prompt in plain language — e.g. "change the lighting to golden hour" or "make her hair red".
- The edit ripples coherently: changing a subject's age, species, or the season also updates related details. Streams into the editor with **Apply** / **Undo**.

## Editor tools

**Tabs** — up to 4 prompts side by side, saved with your workflow.  
**File ▾** — save to Favorites/Snippets, clear, import/export text.  
**Undo/Redo** — Ctrl+Z / Ctrl+Y; also recalls the prompt from before an AI result.  
**Find**, **Aa** (case/sort), **Clean** (strip markdown/weights), **Synonyms**, **Flag words** (weak words → replacements), **Wrap**.

## Library

Search prompts from **Civitai**, **Genur.art**, and **Sea.art** — type a term and scroll to load more. Image/video previews included.
- Click a result to open it, then **Use**, **Enhance**, **Variations**, **Save**, **Image to Prompt** on an image, or **Video to Prompt** on a video result.
- **Workflows** — search and load ComfyUI workflows from the results.
- **Favorites** / **Snippets** — your saved prompts and reusable fragments.
