---
name: image-generation
description: "MUST use when the user asks to: generate images, make a picture, create artwork, 'draw something', 'create an image', 'generate a photo', or when any task requires image generation output."
---

# Image Generation Skill

## Activation
When this skill activates, output: "Image generation ready..." followed by a brief status check (is ComfyUI running?).

## Architecture Overview
- **Backend**: ComfyUI running on local machine
- **Model**: SDXL base (1024x1024 default)
- **Bridge**: MCP server at `.opencode/plugins/glitch-image-gen.mjs`
- **Output**: Images saved to `data/screenshots/`
- **Setup**: Install via `scripts/install-image-gen.ps1`, start via `scripts/start-comfyui.ps1`

## Before Generating
1. Check if ComfyUI is running by calling `comfyui_status` tool
2. If not running: offer to start it or guide the user
3. If not installed: tell user to run `scripts/install-image-gen.ps1`

## Prompt Guidance for SDXL

### Structure
Follow this format: `[subject], [details], [environment], [lighting], [mood], [style]`

### SDXL Sweet Spots
- **Resolution**: 1024x1024 (default), or 1216x832 (landscape), 832x1216 (portrait)
- **CFG Scale**: 7.0 (default), range 4-9
- **Steps**: 20 (default), 15-30 for best quality
- **Sampler**: DPM++ 2M Karras (default)

### Style Modifiers
- Photorealistic: "photograph, shot on 35mm film, natural lighting, 8k, highly detailed"
- Cinematic: "cinematic lighting, dramatic composition, film grain, anamorphic"
- Digital art: "digital painting, concept art, trending on ArtStation, detailed"
- Anime: "anime style, cel shaded, vibrant colors, detailed linework"

### What to Avoid
- Negative prompt defaults: "blurry, low quality, distorted, ugly, bad anatomy, watermark, text"
- For portraits: add "asymmetric eyes, bad face" to negative

## Generating the Image
1. Call `generate_image` tool with the crafted prompt
2. Parameters to expose to the user: prompt, negative_prompt, width, height, steps
3. After generation: report the file path to the user
4. Offer to show the image if possible, or refine and regenerate

## Model File Info
- **Checkpoint**: `sd_xl_base_1.0.safetensors` (~6.9GB)
- **Location**: `data/comfyui/models/checkpoints/`
- **Alternatives**: If user wants a different model, it must be downloaded separately

## Level History
- **Lv.1** — Base: Basic prompt pipeline, SDXL txt2img, save to data/screenshots/
