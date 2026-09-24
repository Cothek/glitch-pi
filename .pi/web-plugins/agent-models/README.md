# agent-models (pi-web-ui plugin)

See which model each `.pi/agents/*.md` actually runs on, and whether the pin still resolves.

The point is the **status**, not the list. `.pi/extensions/dispatcher.ts` decides what runs:

```ts
const agentModel = agent.model && !/^opencode(-go)?\//.test(agent.model) ? agent.model : undefined;
const model = agentModel ?? parentModel;
```

Two ways a pin dies silently, both falling back to the **main conversation model**:

1. it matches `^opencode(-go)?/` -> hard-dropped (those providers do not exist on Pi)
2. it is not in the live model runtime -> dropped by the spawn path

Live example when this was built: 10 agents, 2 pins OK, **6 dead pins**, 2 inheriting.

## Surfaces

1. **Right-panel "Agent Models" tab** — one row per agent: name + status badge, `pin -> effective`, then the note.
2. **`/agent-models`** in the chat box (server-side command, no browser needed).
3. **`GET /plugins-api/agent-models/state`** — the JSON the tab renders.
4. **`node scripts/agent-models.mjs`** — the same table on the CLI. `--json`, `--strict` (exit 1 when anything needs attention, usable as a gate), `--help`.

## Statuses

| Status | Meaning |
|---|---|
| `OK` | the pin resolves and the dispatcher honours it |
| `DEAD PIN` | the dispatcher drops it (`opencode/*`, `opencode-go/*`) |
| `UNRESOLVED` | pin parses but is absent from the available model catalog |
| `INHERIT` | no pin at all - follows the main conversation model |

Warnings are separate and structural: `skill("...")` in the body without the `skill` tool, a sub-agent body that instructs `task()` dispatch, a frontmatter name that differs from the file name, a missing tools allowlist.

## Data sources

- **agents**: `host.fs.list(".pi/agents")` + `readText` (workspace-relative, `fs:read`). Project scope only - user-scope agents in `<agent-dir>/agents/` are outside the workspace and would need an access grant, so they are not silently included.
- **catalog**: `host.models.list()` = every model from **authenticated** providers. Passing zero keys means an empty catalog, which this plugin reports as `UNRESOLVED` with an explicit reason rather than pretending the pin is fine.

## Honest limits

- **The main conversation model is not named.** Inherited rows say "main conversation model". `host.onStats` exists in the SDK but the host never fires it, and `host.conversations.list()` returns only `{id,title,cwd,kind,isStreaming}`. Naming it needs a host API addition (a pi-web-ui change), not a plugin change.
- **The CLI's catalog is a disk approximation** (`models.json` + `models-store.json` for credentialed providers). The plugin asks the live runtime. They agreed at build time (507 available models) but they are not the same source; each surface prints which one it used.
- **Read-only by construction**: the manifest requests `ui`, `fs:read`, `http` - no `fs:write`. Phase 1 cannot edit an agent file even by accident.
- **User-scope agents are not listed** (see Data sources).

## Install / update

Source lives in the repo at `.pi/web-plugins/agent-models/`. Install or update:

```powershell
Copy-Item -Recurse -Force "E:\Glitch AI\glitch-pi\.pi\web-plugins\agent-models" "$HOME\.pi-web\plugins\agent-models"
Remove-Item -Recurse -Force "$HOME\.pi-web\plugins\agent-models\client\sdk" -ErrorAction SilentlyContinue
```

The host re-scans `<dataDir>/plugins` on every WS attach (`pluginMgr.ensureLoaded()` in `dist/server/index.js`), so **reloading the browser page picks up a freshly dropped plugin - no server restart**. The settings panel ("界面插件" -> 重新加载) sends `plugins_reload` and does the same. That matters here: the web server hosts the agent session, so restarting it would kill a running turn.

## Tests

```powershell
node --test .pi/web-plugins/agent-models/index.test.mjs
```

15 tests cover the parser (quoting, BOM, bracketed tools, missing frontmatter), every status branch, the lints, the report counts, and the `/state` route payload.

## Phase 2 (not built)

An inline model picker that writes the `model:` line back to an agent file. That needs `fs:write`, a frontmatter-preserving rewrite (comments, key order), a backup, and validation against the catalog - deliberately left out of phase 1 so the panel cannot damage the roster it reports on.
