# Glitch Omni Architecture: Local Model Context Detection

## Overview

Glitch Omni now includes automatic context window detection for local models served by LM Studio and compatible OpenAI-compatible servers. This integration uses a **3-tier detection strategy** that runs during provider injection, ensuring models have accurate context limits without manual configuration.

## Detection Strategy (3-Tier Priority)

The detection follows this priority order, from fastest to most accurate:

### Tier 1: API Metadata (`/v1/models`)
- **Source**: Fetch model list from the server's `/v1/models` endpoint
- **Fields checked**: `context_length`, `n_ctx`, `context_length_max`, `max_context_length`, `max_tokens`, `ctx_length`
- **Speed**: Fastest — single HTTP request
- **Fallback**: If no metadata available, proceed to Tier 2

### Tier 2: LM Studio Config File
- **Location**: Windows `%LOCALAPPDATA%\LM Studio\config.json` (also checks `%APPDATA%`)
- **Fields checked**: `n_ctx`, `server.n_ctx`, `settings.n_ctx`, `loadedModels[].n_ctx`, `model.n_ctx`
- **Speed**: Fast — single file read
- **Fallback**: If config not found or n_ctx not present, proceed to Tier 3

### Tier 3: Binary Search via Chat Completions
- **Method**: Send progressively larger dummy requests to `/v1/chat/completions` until the server rejects/truncates
- **Bounds**: Uses known context sizes `[512, 1024, 2048, 4096, 8192, 16384, 24576, 32768, 49152, 65536, 98304, 131072, 262144, 524288, 1048576]`
- **Speed**: Slowest — requires multiple HTTP requests
- **Fallback**: If all probes fail, defaults to `32768`

## Provider Injection Flow

The detection integrates with the provider injection flow in `scripts/lib/inject-providers.mjs`:

1. **Local model discovery** — `discoverLocalModels()` probes LM Studio/FreeToken endpoints and merges discovered models into `providers.json`

2. **Context detection** — For each provider with `auto_detect: true` (or `lmstudio`/`freetoken-wsl` backends):
   - Calls `detectContextSizes(baseUrl)` from `lmstudio-context-detector.mjs`
   - Applies the 3-tier strategy per model
   - Updates model `limit.context` and `limit.output` with detected values
   - Sets `auto_detect: true` and `last_detected` timestamp

3. **NVIDIA registry sync** — After detection, live registry models are synced and culled

4. **Config output** — Updated `providers.json` is written back to disk

## Key Code Integration Points

| File | Purpose |
|------|---------|
| `scripts/lib/lmstudio-context-detector.mjs` | 3-tier context detection module |
| `scripts/lib/inject-providers.mjs` | Orchestrates detection during provider injection |
| `config/providers.json` | Stores `auto_detect` and `last_detected` fields per provider/model |
| `scripts/discover-local-models.mjs` | Probes and discovers local model listings |

## Detection Outcomes

Each model receives a `limit` object with:
- `context`: Detected context window size (number)
- `output`: Truncated output limit (`Math.min(Math.floor(context / 4), 8192)`)

And metadata:
- `auto_detect: true` — flag indicating detection ran successfully
- `last_detected`: ISO timestamp of when detection last ran
- `source`: One of `metadata`, `config_file`, `binary_search`, or `default_fallback`