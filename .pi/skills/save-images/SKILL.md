---
name: save-images
description: "Use when pasted images need to land on disk for @vision, when checking data/screenshots/NEW_IMAGE_FLAG or manifest.json, or when the user says 'save this image', 'where is that screenshot', or pastes an image and wants vision analysis."
---

# Save Images Skill

## Purpose
User-pasted images must exist as files on disk so sub-agents (especially vision) can read them. On OpenCode this is automatic via `.opencode/plugins/save-images.js`. On Pi the same files and flags are produced when that plugin runs (OpenCode driver) or when a paste is written manually.

## Contract (unchanged from OpenCode plugin)

| File | Role |
|------|------|
| `data/screenshots/manifest.json` | Canonical record of the latest saved image (absolute path + metadata) |
| `data/screenshots/NEW_IMAGE_FLAG` | Trigger: single absolute path of the newest image; delete after dispatch |
| `data/screenshots/chat-image-*.png` (etc.) | The image files |

## Workflow

1. **After a paste** (or if `NEW_IMAGE_FLAG` exists):
   - Read `E:\Glitch AI\glitch-ai\data\screenshots\NEW_IMAGE_FLAG`
   - Path inside = image to analyze
   - Dispatch `task` agent=`vision` (or `vision-alt`) with that path
   - Delete `NEW_IMAGE_FLAG` so it is not reprocessed

2. **If flag is missing but an image was just pasted** (Pi-only, plugin not loaded):
   - Ask the user for the image path, or save the data URI to `data/screenshots/` yourself if content is available
   - Update `manifest.json` with the absolute path

3. **Never** claim "I can't see images" (R7 vision reflex). Use the file path + vision dispatch.

## Manifest shape
```json
{
  "path": "E:\\Glitch AI\\glitch-ai\\data\\screenshots\\chat-image-<ts>-<n>.png",
  "mime": "image/png",
  "savedAt": "<ISO timestamp>"
}
```
(Exact keys may include more fields — treat `path` as source of truth.)

## Related
- Vision agents: `.pi/agents/vision.md`, `.pi/agents/vision-alt.md`
- Plugin source (OpenCode): `.opencode/plugins/save-images.js`
