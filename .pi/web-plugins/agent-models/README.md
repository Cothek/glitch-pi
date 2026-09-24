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

## Costs in the picker

Every option carries a cost chip, and so does each row (the price of its current pin):

| Chip | Meaning |
|---|---|
| `free` (green) | every cost field is 0. The NVIDIA endpoints really are free. |
| `$0.8/$1.6` (amber) | input / output in **USD per million tokens**. Hover shows cache read/write prices and the source file. |
| `n/a` (grey) | the provider publishes no pricing anywhere on this machine. |

The header line adds the coverage, e.g. `cost: 448 known (372 priced, 76 free)`.

### Where the numbers come from, and the honest gap

The host API a plugin gets (`host.models.list()`) carries id/provider/vision only, and the real prices live in `<agent-dir>/models.json` and `models-store.json`, which are **outside the workspace**. A plugin may not read those without a directory grant, so the prices are collected by a script and dropped into the workspace:

```
node scripts/agent-model-costs.mjs
```

That writes `.pi/agent-models/costs.json` (gitignored, runtime data) with a generation timestamp, which the panel and the CLI both read. Nothing prompts for permissions.

Coverage on this machine, stated plainly:

- `openrouter` - 392 models with real prices
- `nvidia` - 56 models, every field 0 = free
- `commandcode` - **59 models with no pricing data anywhere.** The config lists only id, name and context window, so those rows say `n/a` and no amount of processing invents a number.

To fill that gap, write the prices you know into `.pi/agent-models/prices.json`; manual entries win over everything else:

```json
{ "commandcode/Qwen/Qwen3.6-Plus": { "in": 0.4, "out": 2.0 } }
```

Re-run the generator after editing, and the panel picks it up on the next refresh. The CLI (`node scripts/agent-models.mjs`) shows the same labels in a COST column, so the two surfaces cannot disagree about a price.

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

## Mount contract (learned from the first broken deploy)

The host has **two different plugin-view mount paths**, and knowing which one you are in is the difference between a working panel and a mystery:

| Path | Host class | Used by | Behaviour |
|---|---|---|---|
| `Ms` | `.plugin-page` | Settings plugin page, right-panel slot tabs | lazily imports the bundle, renders load/mount errors into a red `.plugin-page-error` box |
| `nm` | `.plugin-view` | **main-area plugin views** (what a pinned topbar tab opens) | calls `entry.module.mount()` **synchronously from the host's already-loaded module map**, with a bare text fallback if the module is missing or mount throws |

The pinned tab itself is not a right-panel entry. The server auto-injects one hidden UI item per plugin (`id "__view"`, kind `view`, `view "plugin:<id>"`, `hidden: true`); pinning unhides it, which renders a `.tb-tab.plugin-tab` whose click does `setView("plugin:<id>")`.

**The failure mode to avoid:** if the plugin is not in the loaded-modules map when the view is active, the host renders `.plugin-view-fallback` — either "插件视图加载中…" forever (not failed) or "插件视图加载失败" with a Retry button. A permanently "loading" pane is indistinguishable from "this plugin is broken", and it produces **no console error and no server log**, so there is nothing to read.

What this plugin does about it:

1. `preload: true` in the manifest, so the client bundle is loaded at startup rather than only on demand.
2. `mount()` never throws: the body is wrapped, and any failure renders an in-panel `.am-error` with the real message.
3. **One instance per CONTAINER** (a WeakMap keyed by the container element), not a module-level singleton. This matters: the host mounts the same module in more than one place (main view pane, Settings plugin page, right-panel slot tabs), and a global singleton made the second mount tear the first one down - which can empty the very pane the user is looking at. Only a repeat mount in the *same* container replaces the previous instance.
4. A stale fetch cannot render into a destroyed instance (generation counter).
5. An always-visible diagnostic line: `agent-models vX | mounts N | visible|hidden|detached | last <action> @ <time> | fetch ok/fail | write <agent> @ <time> | agents N`. The visibility field is deliberate: a panel can be mounted, connected and fetching while sitting in a hidden pane, which looks exactly like a dead page.

If the pane ever shows the host's "loading" fallback again, the client bundle is not reaching the host's module map. Check in this order: `curl -s -o /dev/null -w "%{http_code} %{content_type}" localhost:8787/plugins/agent-models/client/entry.mjs` (expect 200 + `text/javascript`), then reload the plugin (`plugins_reload`) to bump the epoch and force a re-import, then reload the page.

### Two traps worth remembering

- **A hidden pane answers reads but cannot be clicked.** The host renders one pane per plugin and hides the inactive ones. Elements in a hidden pane are still in the DOM (so a `querySelector` finds them) but measure 0x0, and clicking them does nothing visible. Address a row only after confirming the view is active; the diag line's `visible` field says which state you are in.
- **The row toggles the picker.** Clicking a row whose picker is already open closes it, so a verifying script that clicks and then looks for the picker reports "picker did not open" and is wrong - it just closed it. Check for an existing picker first, and only click when there is none. The row is a real `<button>` (Enter/Space and screen readers work) and the picker is a SIBLING of it: nesting its option buttons inside a button would be invalid HTML.
- **An injected `<style>` element outlives a mount.** `injectStyles()` must compare CSS by CONTENT, not by "is the id already in `<head>`": the element persists across remounts, plugin reloads and SPA navigation, so an id-only check pins the FIRST deploy's stylesheet for the life of the page and every later CSS change is silently ignored - new DOM, stale CSS. That is how the full-bleed row toggle above first rendered 11px inset with the host's default button padding (`1px 6px`): the old `.am-row` padding rule was still the only one in the document. When a stylesheet change seems not to apply, check the COMPUTED style, not the source.
- **Nested server-side imports are cached by the Node ESM loader.** The host cache-busts the plugin ENTRY on every reload, but a static `import "./resolver.mjs"` keeps the old module for the life of the process, so adding an export produced `does not provide an export named 'setModelInFrontmatter'` on a perfectly good file. `index.mjs` imports its helper through a per-activation nonce URL for this reason.

## Changing a model (write path)

The panel can set a model per agent, because that was the whole point of the exercise. **Clicking anywhere on a row expands that agent's inline picker** under it (the row itself is the toggle, a real `<button>` with a caret that flips when open, so keyboard and screen readers work for free): a search box plus the model catalog (`provider/model` ids, searchable, 60 shown at a time), with **Inherit (no pin)** always first. Clicking a model applies it immediately.

Safety, in order:

1. The agent name must match a file actually discovered in `.pi/agents` (and must match `^[A-Za-z0-9._-]+$`), so no path traversal and no invented agents.
2. The model must exist in the live catalog (`host.models.list()`, the same 507 authenticated models the panel reports). An unknown pin would silently fall back to the main model, which is the exact failure this plugin exists to expose - so it is refused rather than written.
3. The file is backed up to `.pi/agent-models/backups/<agent>-<ISO>.md` (workspace-relative on purpose: a cross-directory write would need a separate user directory grant) BEFORE the first byte changes.
4. `setModelInFrontmatter()` rewrites only the `model:` line. Comments, key order, blank lines, the body, the BOM and the file's own line endings all survive. Picking **Inherit** removes the line.

`POST /plugins-api/agent-models/set-model` accepts `{ agent, model }` (`model: null` = inherit) and returns `{ ok, agent, model, previous, changed, reason, backup, report }`, where `report` is the refreshed roster so the UI updates in one round trip. The manifest therefore requests `fs:write`; the plugin could not write a byte without it.

## Verified end to end (2026-09-24)

Driven through the real UI in the running web UI, not from curl:

- opened the Agent Models view, clicked **Change** on `reviewer`, picker rendered (61 options), searched, clicked `commandcode/z-ai/glm-5.3-flash`
- row flipped `DEAD PIN` -> `OK`, counts went `2 ok / 6 dead` -> `3 ok / 5 dead`, panel showed `saved: opencode/mimo-v2.5-free -> commandcode/z-ai/glm-5.3-flash | backup reviewer-2026-09-24T21-42-30-602Z.md`
- diag line recorded `last set-model:reviewer` and `write reviewer @ 4:42:30 PM`
- on disk: `.pi/agents/reviewer.md` line 5 = `model: commandcode/z-ai/glm-5.3-flash` (everything else untouched), and `.pi/agent-models/backups/reviewer-2026-09-24T21-42-30-602Z.md` holds the original `opencode/mimo-v2.5-free`
- `node scripts/agent-models.mjs` agrees: `3 pinned OK | 5 dead pins | 0 unresolved | 2 inherit`

## Not built

Bulk actions (repin every dead pin in one go) and a provider/key editor. The picker covers one agent at a time by design.
