# model-catalog (pi-web-ui plugin)

List every NVIDIA free model, mark the relevant ones, and turn each on or
off from the web UI. Bulk-apply the recommended set, resync from the live
catalog, or restore the previous models.json from backup.

The plugin is a thin view over a frozen engine CLI
(`scripts/nvidia-models.mjs`, owned by another coder). Every write goes
through that engine — the plugin never reads or writes
`~/.pi/agent/models.json` itself. The engine owns the pin guard,
atomic-write, read-back verification, and the model-count check.

## Surfaces

1. **Right-panel "NVIDIA Models" tab** — opens via the composer button.
2. **Composer button** (slot `composer.actions`, order 136: after model
   chip 120, agent-models 135). Registered as `kind: "view"`, so the stock
   client navigates to `view: "plugin:model-catalog"` on click — no custom
   client code on the click path. Restyled to the native chip look (25x25
   desktop and narrow, matching the native composer dropdowns) by the
   client entry so it sits next to the
   model-selector and `agent-models` chips.
3. **`/model-catalog`** in the chat box (server-side slash command, no
   browser needed).
4. **`GET  /plugins-api/model-catalog/status`** — JSON report.
5. **`POST /plugins-api/model-catalog/sync`** — resync from the live catalog.
6. **`POST /plugins-api/model-catalog/set`** — toggle one model on/off.
7. **`POST /plugins-api/model-catalog/bulk`** — recommended / enable all / disable all.
8. **`POST /plugins-api/model-catalog/restore`** — restore the last backup.

## Routes

All routes shell out to `scripts/nvidia-models.mjs` via `host.bash` with
explicit argv tokens (never interpolated from request text). The cached
id whitelist in `data/nvidia-models-state.json` (refreshed after every
engine call) is the only place the engine binary can take ids from; the
HTTP body cannot inject new ids.

| Method | Path | Body | Engine call | Timeout |
|---|---|---|---|---|
| GET  | /status | - | `--status --json` | 60s |
| POST | /sync   | - | `--sync --json` | 180s |
| POST | /set    | `{id, enabled}` | `--enable <id> --json` or `--disable <id> --json` | 180s |
| POST | /bulk   | `{action: recommended\|all\|none}` | `--apply-recommended --json` or `--enable <id1> <id2> ... --json` or `--disable <id1> <id2> ... --json` | 180s |
| POST | /restore | - | `--restore-backup --json` | 180s |

The plugin returns the parsed engine object verbatim and surfaces the
engine's `blocked[]` field (pin-guard refusals) to the client unchanged,
so a refused change explains itself.

Status responses carry two extra fields on top of the engine payload:
`healthy` (boolean, true when the engine returned `ok: true`) and
`cli_present` (boolean, true when `scripts/nvidia-models.mjs` exists on
disk). When `cli_present` is false the panel renders an in-pane
diagnostic explaining that the engine is missing — the panel never
shows a blank box.

## Mount contract

Followed exactly from the agent-models reference. Two key facts:

1. The client entry (`client/entry.mjs`) is served from
   `/plugins/<id>/client/*` and **must have zero imports** — a relative
   import lands on the SPA fallback and kills the module.
2. `mount(el, ctx)` must never throw. The host replaces the pane with a
   bare fallback on throw, and a permanently "loading" pane produces no
   console error and no server log. The plugin's defensive shape:
   - Wraps the body of `mount()` in try/catch; failures render in-panel
     with the real message (`nv-error` box).
   - Per-container `WeakMap` keyed by the container element, so a
     repeat mount in the same container replaces the previous instance
     (real remount) while a different container lives alongside. A
     module-level singleton would tear down the wrong pane.
   - Generation counter on async work so a stale response never paints
     into a destroyed or replaced instance.
   - Always-visible diagnostic line at the bottom of the pane:
     `nvidia-models v0.2.0 | mounts N | visible|hidden|detached | last <action> @ <time> | fetch ok/fail | write <agent> @ <time> | models N`.
     The visibility field is deliberate: a panel can be mounted,
     connected and fetching while sitting in a hidden pane.
   - Stylesheet compared by **content** before reassigning, never by
     id-only "already injected" — the `<style>` element outlives a
     mount, and an id-only check pinned the first deploy's CSS for the
     life of the page.
   - Polls every 15s (`POLL_MS`) but pauses while a mutation is in
     flight (`state.busy`), so the panel never races a save.

## Engine dependency

This plugin does NOT work without the engine. While the engine
(`scripts/nvidia-models.mjs`) is still landing:

- `cli_present: false` in `/status` responses.
- Every `/set` and `/bulk` call rejects with HTTP 502
  (`engine exited with code 1`) because the bash invocation fails.
- The client renders an in-pane hint: "Engine not installed at
  scripts/nvidia-models.mjs. Install it then click Resync."

When the engine is in place:

- `/status` returns `ok: true` and the cached payload includes
  `models[]`, `counts`, `recommended[]`, `enabled[]`, `blocked[]`,
  `synced_at`.
- `/set` and `/bulk` shell out to the engine with the cached id
  whitelist applied.

The plugin NEVER calls the engine with a write flag
(`--apply-recommended`, `--enable`, `--disable`, `--restore-backup`)
against the real config during development. Only `--status` and `--sync`
are used by the host; write flags go through `/set`, `/bulk`, and
`/restore` which the user triggers explicitly from the panel.

## Install / update

Source lives in the repo at `scripts/pi-web-plugins/model-catalog/`.
Install or update with one command:

```bash
node scripts/install-pi-web-plugins.mjs
```

That creates a junction `~/.pi-web/plugins/model-catalog ->
scripts/pi-web-plugins/model-catalog` (Windows junction, no admin
required). The install script is idempotent: an existing correct
junction is left alone; a stray real directory in the live location is
adopted into the repo copy (first-one-wins per file), then replaced with
the junction.

The host re-scans `<dataDir>/plugins` on every WS attach
(`pluginMgr.ensureLoaded()` in the running pi-web-ui), so **reloading
the browser page picks up a freshly dropped plugin — no server restart**.
The settings panel ("界面插件" -> 重新加载) sends `plugins_reload` and
does the same. That matters: the web server hosts the agent session, so
restarting it would kill a running turn.

After install:

```bash
node scripts/nvidia-models.mjs --sync --json
```

Run once to populate `data/nvidia-models-state.json` with the live
NVIDIA catalog so the panel has something to show.

## Tier judgement

Tier A (Recommended, 14): `z-ai/glm-5.3`, `z-ai/glm-5.3-flash`,
`moonshotai/kimi-k3`, `moonshotai/kimi-k2.6`,
`deepseek-ai/deepseek-v4.1-flash`, `nvidia/nemotron-3-ultra-550b-a55b`,
`nvidia/nemotron-3-super-120b-a12b`,
`nvidia/nemotron-3.5-lightning-30b-a3b`,
`nvidia/nemotron-3-nano-omni-30b-a3b-reasoning`,
`nvidia/llama-3.1-nemotron-ultra-253b-v1`, `openai/gpt-oss-20b`,
`meta/muse-glimmer-30b`, `mistralai/mistral-nemotron`,
`poolside/laguna-xs-2.1`.

Tier B (Optional): the remaining chat-capable models (mistral-large-2,
the llama-3.2 vision pair, the remaining nemotron sizes, phi-3.5-moe,
gemma-3-12b, gemma-4-31b, granite 8b/34b-code, codestral, mistral-7b,
mixtral-8x22b, palmyra family, codellama-70b, deepseek-coder-6.7b,
cosmos-reason2-8b, nemotron-nano-3-30b-a3b, llama3-chatqa-70b,
nv-mistral-nemo-12b, zamba2-7b).

Tier C (Not relevant, off by default): tiny, superseded, or narrow
models (gemma-2b, gemma-3-4b, recurrentgemma-2b, granite-3.0-3b,
mistral-nemo-minitron-8b-8k, llama2-70b, yi-large, jamba-1.5,
sea-lion-7b, starcoder2-15b, dbrx, codegemma pair, diffusiongemma-26b,
phi-3-vision-128k, palmyra-fin/med-32k, ising-calibration-1.5-31b,
unknown ids).

Tier X (Non-chat, never listed as chat): regex on id for `embed`,
`embedqa`, `nemoretriever`, `nvclip`, `neva`, `vila`, `kosmos`, `deplot`,
`fuyu`, `guard`, `safety`, `content-safety`, `topic-control`, `reward`,
`parse`, `riva-translate`, `rerank`, `synthetic-video`, `arctic-embed`.

The full rules and engine-implementation details live in the engine
session plan at `data/plans/sessions/01a0de28-0081-7411-a49b-8636ff4ff2ee/current-plan.md`.
The plugin just renders whatever tier the engine assigns.

## Tests

```bash
node --check scripts/pi-web-plugins/model-catalog/index.mjs
node --check scripts/pi-web-plugins/model-catalog/client/entry.mjs
node scripts/pi-web-plugins/model-catalog/index.test.mjs
```

The server-side test (`index.test.mjs`) covers each route against a mock
host with a stubbed bash, plus the two failure paths the panel must
survive:

- `/status` when the engine is missing (`cli_present: false`, no throw).
- The pin-guard blocked path (engine returns `blocked[]` in its JSON and
  the plugin must relay it to the client verbatim).

Plain Node + `node:assert` only. No test framework, no new dependencies.
Prints one `PASS: <name>` line per group and exits 0.
