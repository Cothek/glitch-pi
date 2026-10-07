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

1. **Chat-bar button** — a small 🧠 chip in the composer, right of the thinking dropdown (order 135: after model 120 / thinking 130, before the DSH chips). Click opens the page. Registered as `kind:"view"`, so the stock client's click handler does the navigation — no custom client code on the click path. Restyled by the client entry to the native chip look (25x25, radius 8) so it matches the native composer dropdowns.
2. **Right-panel "Agent Models" tab** — one row per agent: name + status badge, `pin -> effective`, then the note.
3. **`/agent-models`** in the chat box (server-side command, no browser needed).
4. **`GET /plugins-api/agent-models/state`** — the JSON the tab renders (now includes a `configs` summary list).
5. **`GET /plugins-api/agent-models/configs`** — full saved config list (with pins).
6. **`POST /plugins-api/agent-models/configs/save`** — snapshot current pins into a named preset (upserts by slug id). Send `editId` to rename an existing preset **and re-capture its pins** from the live agents.
7. **`POST /plugins-api/agent-models/configs/apply`** — batch-apply a saved preset; validates each pin against the live catalog, skips unresolvable ones.
8. **`POST /plugins-api/agent-models/configs/delete`** — remove a saved preset.
9. **`POST /plugins-api/agent-models/set-models`** — apply ONE model to MANY agents in a single validated, backed-up batch (the panel's multi-select).
10. **`node scripts/agent-models.mjs`** — the same table on the CLI, plus `--save-config`, `--apply-config`, `--list-configs`, `--delete-config`, `--edit-config`, `--config-desc`, and `--dry-run`. `--json`, `--strict` (exit 1 when anything needs attention, usable as a gate), `--help`.

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
| `free` (green) | every cost field is 0 (the NVIDIA endpoints really are free). |
| `$0.15/$0.5` (amber) | input / output in **USD per million tokens**, published. The tooltip adds cache read/write, context, tier and which file the number came from. |
| `~$10/$50` | **estimated** from another vendor's same-slug listing (openrouter), because this provider publishes nothing. Never presented as a published price. |
| `n/a` (grey) | no price from any source. |

Alongside the price each option carries its **tier** and capability badges, and the picker filters on all of it:
```
All providers 476 | openrouter 392 | commandcode 59 | nvidia 25
All tiers 476 | budget 222 | mid 151 | free 48 | premium 55
Any capability 476 | Vision 314 | 200K+ context 372
```

Tiers are DERIVED, not published: `blended = 0.75*in + 0.25*out`, then free = 0, budget < 1, mid < 5, premium >= 5. The thresholds live in `scripts/agent-model-costs.mjs` and the tier is stored in the data, so changing them is a one-line edit with no UI change. Vision comes from the live host model list; 200K+ context comes from the cost table.

### Where the numbers come from, and the honest gap

The host API a plugin gets (`host.models.list()`) carries id/provider/vision only, and the real prices live in `<agent-dir>/models.json` and `models-store.json`, which are **outside the workspace**. A plugin may not read those without a directory grant, so the prices are collected by a script and dropped into the workspace:

```
node scripts/agent-model-costs.mjs
```

That writes `.pi/agent-models/costs.json` (gitignored, runtime data) with a generation timestamp, which the panel and the CLI both read. Nothing prompts for permissions.

Coverage on this machine, stated plainly:

- `commandcode` - **all 59 configured models are priced**, from Command Code's own published GOAT plan rates ($0.50/$3.00 for Qwen 3.6 Plus, $0.15/$0.50 for glm-5.3-flash). Their docs page embeds a structured catalog; `scripts/commandcode-prices.mjs` extracts it into `config/commandcode-prices.json` (checked in, re-run when prices change). It also carries context window, vision and reasoning per model, and lists 82 models against the 59 pi has configured.
- `openrouter` - 392 models with real list prices, from the official catalog cache.
- `nvidia` - 25 curated models (filtered from 56 live NIM ids by `scripts/sync-nvidia-models.mjs`; `NVIDIA_CURATED=0` restores the full list), every field 0 = genuinely free.

Precedence, lowest to highest: `models-store.json`, `models.json`, `config/commandcode-prices.json`, then `.pi/agent-models/prices.json`. Anything still unpriced gets an **openrouter same-slug estimate**, shown with a `~` and named in the tooltip. On this machine that count is legitimately 0 because the docs cover everything, so the path is proven by a synthetic probe instead of by hope.

To override anything by hand, write `.pi/agent-models/prices.json`; manual entries win over everything else:

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

```
node --test .pi/web-plugins/agent-models/index.test.mjs .pi/web-plugins/agent-models/client.test.mjs
```

102 tests: 62 server-side (parser, status truth table, lints, cost labels, the `/state` payload, the frontmatter rewrite, the single-agent write route, the bulk `/set-models` route - batch apply + per-agent backups, dedupe, empty/traversal/unknown-agent/bad-model/over-cap guards - and the config save/apply/delete/edit routes, including edit re-captures the pins and the response carries the post-write config list) and 40 for the CLIENT via a fake DOM (`client.test.mjs`), including 15 tests for the presets bar (render, save flow, empty-name guard, save-button-enabled-on-name-type, apply, apply-error, delete, config count in the `/state` payload, edit rename + edit-on-unknown-id, a preset update clearing the stale per-agent saved note, and the 2026-10-04 stale-editId regressions: save-current clears a cancelled edit, delete-then-save-new sends no editId, the Update label, a failed-save retry honors the visible name) and 5 for bulk selection (checkbox count, Select all/Clear, bulk picker gating, apply POST body + summary note, error surfaced with selection kept).

The client harness exists because every bug this plugin actually shipped was client-side and invisible to the server tests: a picker whose tail referenced a variable removed in a refactor (the panel rendered "Render failed"), an id-only stylesheet guard that pinned the first deploy's CSS for the life of the page, and a flex container that squashed rows instead of scrolling. The harness mounts the client, clicks a row to open the picker, filters by provider/tier/capability, applies a model (asserting the POST body), rolls back, and re-mounts over a deliberately stale stylesheet. It is a regression net for wiring mistakes, not a substitute for looking at the real page.

## Parity with the OpenCode model-ui app

The OpenCode app (`glitch-ai/plugins/model-ui`) was audited feature by feature against this page:

| OpenCode feature | Here |
|---|---|
| Agent list with the assigned model | yes (row per agent: pin, effective model, status) |
| Cost badges per model, in USD per million tokens | yes, and with a published/estimated/free distinction it did not have |
| Provider filter | yes (chips with counts) |
| Tier filter (free / budget / mid / premium) | yes, derived from price |
| Capability filter | yes (vision from the host, 200K+ context from the cost table) |
| Search | yes (in-place filtering, caret preserved) |
| Rollback | yes, per agent, restore the newest backup; the pre-rollback state is saved first so a second click steps back again |
| Refresh models | yes (header Refresh + the 15s poll) |
| Pending changes then Apply / Clear | **not ported** - see below |
| Apply & restart / manual restart | **not ported** - OpenCode needed a restart after rewriting its config; pi applies a pin immediately |
| Model registry refresh endpoint | n/a - pi's catalog comes from the live runtime on every read |

**Why staging was left out.** OpenCode staged edits because applying meant rewriting `opencode.json` and restarting the harness, so it had to batch. In pi a write is instant, per-agent, validated against the live catalog and backed up first, with rollback available. Staging would add clicks without adding safety. If it is ever wanted, it is a client-side map plus an Apply loop over the existing endpoint.

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
- **Flex items shrink by default, and that SHRINKS CARDS instead of scrolling them.** A flex column with a fixed height and `overflow-y: auto` will distribute a deficit across its items before it ever scrolls: with the default `flex-shrink: 1` an expanded row got allocated ~390px out of its ~770px of content and clipped its own picker, while the other rows squished to a single line - and because nothing overflowed, the list could not scroll at all. Rows are `flex: none` here, which is what makes the agents list actually scroll and keeps expanded cards full height. When a scrollable region "never scrolls" and its children look squished, suspect flex-shrink first, not overflow.
- **A CRLF file's LAST frontmatter key needs its `\r` stripped.** `splitFrontmatter` splits on `/\r?\n/`, which removes `\r\n` PAIRS but leaves a lone `\r` on the final header line (its `\n` became the closing-fence index). That matters because in JavaScript `.` does not match `\r`, so `(.*)$` cannot span it and the key regex fails **silently**. Since `model:` is normally the last key, a pinned CRLF agent reported as having no pin at all. Not hypothetical: git normalized the agent files to CRLF on checkout and the CLI started claiming ten agents had no model while every file on disk was correct. If a frontmatter key ever goes missing, check line endings before believing the report.

**Deploy without a restart**: `node scripts/pi-plugin-reload.mjs agent-models` sends the host's `plugins_reload` over a throwaway WebSocket, which re-imports the bundle with a new epoch. No server restart, so no session loss.
- **Nested server-side imports are cached by the Node ESM loader.** The host cache-busts the plugin ENTRY on every reload, but a static `import "./resolver.mjs"` keeps the old module for the life of the process, so adding an export produced `does not provide an export named 'setModelInFrontmatter'` on a perfectly good file. `index.mjs` imports its helper through a per-activation nonce URL for this reason.

## Changing a model (write path)

The panel can set a model per agent, because that was the whole point of the exercise. **Clicking anywhere on a row expands that agent's inline picker** under it (the row itself is the toggle, a real `<button>` with a caret that flips when open, so keyboard and screen readers work for free): a search box plus the model catalog (`provider/model` ids, searchable, 60 shown at a time), with **Inherit (no pin)** always first. Clicking a model applies it immediately.

Safety, in order:

1. The agent name must match a file actually discovered in `.pi/agents` (and must match `^[A-Za-z0-9._-]+$`), so no path traversal and no invented agents.
2. The model must exist in the live catalog (`host.models.list()`, the same 507 authenticated models the panel reports). An unknown pin would silently fall back to the main model, which is the exact failure this plugin exists to expose - so it is refused rather than written.
3. The file is backed up to `.pi/agent-models/backups/<agent>-<ISO>.md` (workspace-relative on purpose: a cross-directory write would need a separate user directory grant) BEFORE the first byte changes.
4. `setModelInFrontmatter()` rewrites only the `model:` line. Comments, key order, blank lines, the body, the BOM and the file's own line endings all survive. Picking **Inherit** removes the line.

`POST /plugins-api/agent-models/set-model` accepts `{ agent, model }` (`model: null` = inherit) and returns `{ ok, agent, model, previous, changed, reason, backup, report }`, where `report` is the refreshed roster so the UI updates in one round trip. The manifest therefore requests `fs:write`; the plugin could not write a byte without it.

## Row layout (dense, single line)

Each agent item is **one vertically centered line**, following the `ui-craft-dense-dashboard` variant (density 9, motion 3, craft 7): `.am-row-line` is a single flex row at `min-height:28px` holding, in order, the selection checkbox, the agent name, the status badge, `pin -> effective`, the cost/tier/think chips, an issues marker, and the caret. Nothing stacks underneath, so a 14-agent roster is one screen instead of three.

Text treatment follows the same skill: the agent name and the model ids are set in the mono face because they are **identifiers**, cost chips carry `tabular-nums`, the status badge is sentence case (11px, 4px grid - no uppercase + letterspacing, which the anti-slop rules ban), and every spacing value sits on the 4/8px grid. Warnings and the `why` reason no longer get their own line: they collapse to a truncating `.am-issues` marker whose `title` holds the full text. A ticked row gets an accent tint plus an accent border so the selection is visible at a glance.

## Multi-agent selection and bulk apply

Every agent row carries a selection checkbox (`data-am-select="<agent>"`), a **sibling** of the row toggle button (nesting an input inside a button is invalid HTML). Both share one horizontal line - `.am-row-line`, `display:flex` - so the checkbox sits inline to the **left of the agent name** and costs no extra row height; the open picker still stacks below that line at full width. Ticking it selects the agent and never opens that row's picker.

A bulk bar sits between the presets bar and the filter row: **Select all** (every row matching the current filter), **Clear**, a live `N selected` count (`data-am-bulk-count`), and **Set model on selected…** (disabled until something is ticked). Opening it renders the same inline picker as a single row - search box, **provider / tier / capability quick-filter chips**, tier + vision + 200K+ badges, cost chips, and the Inherit option - and clicking a model applies it to **every** selected agent in one POST.

The bulk chips read the same `modelFacets()` helper as the row picker, so both surfaces report identical counts. Bulk filters keep their own state (`bulkProvider` / `bulkTier` / `bulkCapability`), so opening the bulk picker never inherits a narrowing left behind in a row picker; a chip click updates the option list **in place** (no full re-render, so the search caret survives), and all filters **reset when the picker is opened or closed** so a stale narrow filter can never silently shape the next bulk apply.

`POST /plugins-api/agent-models/set-models` accepts `{ agents: [...], model }` (`model: null` = inherit) and returns `{ ok, model, summary: { requested, applied, unchanged, failed }, results, report }`. Validation runs **once for the whole batch**, never per row:

- names are deduped and trimmed, then must match `/^[A-Za-z0-9._-]+$/` and resolve to a file actually discovered in `.pi/agents` (path traversal is rejected before any filesystem access)
- the model must be in the live catalog or be an explicit inherit, so an unknown pin can never be written
- at most 100 agents per call

Each affected file is backed up **before** its first byte changes, using one shared timestamp so a single apply is one recognizable backup group. A per-agent failure (unreadable file, no frontmatter) does not abort the batch: it is reported in `results` and counted in `summary.failed`, matching the configs/apply behavior. On success the panel clears the selection and shows the summary; on failure the error is shown and the selection is kept so a retry is one click.

## Saved configurations (presets)

Between the header and the filters there is a bar that snapshots the **current** pin of every agent into a named, editable preset, so a whole model setup can be swapped in one click instead of repinning agents one by one.

**Where presets live:** `.pi/agent-models/configs.json` (gitignored, like `costs.json`). The host plugin writes it directly via `fs:write` (already requested). The format is:

```json
{
  "configs": [
    { "id": "free-tier", "name": "Free Tier", "description": "All free models",
      "createdAt": "2026-09-25T12:00:00Z", "updatedAt": "2026-09-25T12:00:00Z",
      "agentCount": 3, "pins": { "coder": "nvidia/nvidia/nemotron-4", "reviewer": "opencode/mimo-v2.5-free", "vision": null } }
  ]
}
```

`id` is a slug of the name; `pins` captures the model line (or `null` for inherit) for each agent as it is right now.

**In the panel:** the bar shows a dropdown (or "No saved presets"), a **Save current** button, an **Apply** button, an **Edit** button (enabled when a preset is selected), and a **×** delete button.

**Styling (matches the agent drop-down):** the dropdown button reuses the agent-switcher chip recipe — `var(--chip-bg,var(--bg-elev2))` surface, 1px border, radius 8, 25px metrics (padding 4px 10px, font 13px, line-height 15px), caret `::after` with the open-state 180° rotation via `aria-expanded`. The menu clones the agent drop-down menu: same surface, radius 10, padding 6, `0 12px 40px #00000080` shadow, z-index 1000, compact 340-480px width, `max-height:min(360px,100vh - 240px)` with scroll, an uppercase 11px **Saved presets** header, and a ✓ on the current row. Verified by computed-style capture (headless Edge + CDP).

**Toggle bug (found live, fixed):** the dropdown toggle used to call `renderConfigBar()` synchronously during the click dispatch, so the bubbling document-level outside-click handler saw the original button node as detached ("outside") and closed the menu in the same tick — the dropdown could never stay open. Fix: `event.stopPropagation()` in the toggle listener, pinned by a client test that models real click bubbling in the FakeNode fixture.

**Stale-editId bug (found live, fixed 2026-10-04):** `editingConfigId` was set by Edit and never cleared — not on save success, not on Cancel/Escape, not by Save current, not by delete. Two live symptoms, one root cause:
1. **Save current after an Edit session silently RENAMED the old config** (id kept, pins never re-captured) instead of creating the new one the name asked for — editing appeared to do nothing.
2. **Edit → delete → save a new config 404'd** with `config not found: <id>` — the stale editId pointed at the deleted config.
Fix: `editingConfigId` is cleared on save success, on save FAILURE (a retry from the still-open form honors the visible name — save as new/upsert — instead of re-404ing the stale id), by Save current (it always captures a fresh snapshot), by Cancel/Escape, and when the edited config is deleted. The form's Save button reads **Update** while an edit session is active. Pinned by 4 client tests (save-current-after-edit, delete-then-save-new, Update label, failed-save retry). Verified live via a headless Edge CDP drive: all flows pass against the real server, and the control group (page reload resets client state) proves the server routes were never the problem.

- **Save current** opens an inline form (name + optional description). Saving POSTs `POST /plugins-api/agent-models/configs/save` with `{ name, description }`. If a config is currently selected and being edited, the `editId` is also sent — the server renames the existing config and re-captures its pins, keeping the same id. Otherwise the server slugifies the id, upserts by id, and returns the refreshed `report` (which includes the updated config list).
- **Edit** (enabled when a preset is selected) pre-fills the same save form with the config's current name and description. Saving renames the preset in place and **re-captures the pins from the live agents**, so the models you just chose are what the preset holds afterwards. The id never changes, so apply and delete keep working. Sharing pins is deliberate: to keep a preset frozen, save a copy under a new name instead of editing it. On the CLI this is `--edit-config <id>` paired with `--save-config "<new name>" --config-desc "<new desc>"`.
- **Apply** sends `POST /plugins-api/agent-models/configs/apply` with `{ id }`. The server walks every pin: each one is re-validated against the **live** catalog. Models that still exist are written (with backup + frontmatter rewrite, exactly like the per-agent write); models that no longer resolve are **skipped** and counted as `invalid` in the summary rather than being written to an invalid pin. The response carries `{ ok, id, name, summary: { applied, invalid, skipped }, report }`.
- **Delete** POSTs `POST /plugins-api/agent-models/configs/delete` with `{ id }` and requires a browser `confirm()`. The server removes the config and returns the new list.
- **Feedback**: a preset save/apply reports its own result in the config bar (for example `updated Free: 14 agents captured`). A preset write clears any per-agent `saved: ...` line first, because leaving it under the row made the preset save look like it had written that agent.

**On the CLI:**

```
node scripts/agent-models.mjs --save-config "Free Tier" --config-desc "All free"
node scripts/agent-models.mjs --list-configs
node scripts/agent-models.mjs --apply-config free-tier
node scripts/agent-models.mjs --delete-config free-tier
node scripts/agent-models.mjs --edit-config free-tier --save-config "Free Tier" --config-desc "All on free endpoints"   # renames AND re-captures the current pins
```

`--save-config` captures the current pins of every agent file found (reads frontmatter, same as the panel). `--apply-config` walks the saved pins and writes each agent file using `setModelInFrontmatter`, skipping any whose model is no longer in the catalog with a warning (the CLI also has `--dry-run` to preview without writing).

Config summaries (id, name, description, createdAt, updatedAt, agentCount) are included in every `/state` payload, so the bar needs no extra fetch.

## Verified end to end (2026-09-24)

Driven through the real UI in the running web UI, not from curl:

- opened the Agent Models view, clicked **Change** on `reviewer`, picker rendered (61 options), searched, clicked `commandcode/z-ai/glm-5.3-flash`
- row flipped `DEAD PIN` -> `OK`, counts went `2 ok / 6 dead` -> `3 ok / 5 dead`, panel showed `saved: opencode/mimo-v2.5-free -> commandcode/z-ai/glm-5.3-flash | backup reviewer-2026-09-24T21-42-30-602Z.md`
- diag line recorded `last set-model:reviewer` and `write reviewer @ 4:42:30 PM`
- on disk: `.pi/agents/reviewer.md` line 5 = `model: commandcode/z-ai/glm-5.3-flash` (everything else untouched), and `.pi/agent-models/backups/reviewer-2026-09-24T21-42-30-602Z.md` holds the original `opencode/mimo-v2.5-free`
- `node scripts/agent-models.mjs` agrees: `3 pinned OK | 5 dead pins | 0 unresolved | 2 inherit`

## Why a change can take up to 15s to appear

Every write path adopts the roster the server returns **in the same response**, so rows repaint as soon as the POST lands. `applyModel` (one agent), `applyRestore` (rollback), `applyBulk` (multi-agent) and `applyConfig` (preset) all assign `state.report = payload.report`.

`POLL_MS = 15000` is the safety net for edits made **outside** this panel (a hand-edited `.pi/agents/*.md`, a CLI write). It is not the update path. When a write response was discarded, the rows sat on the previous report until the next tick, which looked like a 15-second hang after the files were already written. The regression test asserts a preset apply repaints the rows with **no** additional `/state` request, so the poll cannot mask a regression.

Measured server cost on this box (curl, direct to :8787 with the loopback token): `/state` cache hit 4 ms, forced `/state?refresh=1` 17 ms across three runs. The write itself is a handful of local file operations per agent.

## Why a change can take up to 15s to appear

Every write path adopts the roster the server returns **in the same response**, so rows repaint as soon as the POST lands. `applyModel` (one agent), `applyRestore` (rollback), `applyBulk` (multi-agent) and `applyConfig` (preset) all assign `state.report = payload.report`.

`POLL_MS = 15000` is the safety net for edits made **outside** this panel (a hand-edited `.pi/agents/*.md`, a CLI write). It is not the update path. When a write response was discarded, the rows sat on the previous report until the next tick, which looked like a 15-second hang after the files were already written. The regression test asserts a preset apply repaints the rows with **no** additional `/state` request, so the poll cannot mask a regression.

Measured server cost on this box (curl, direct to :8787 with the loopback token): `/state` cache hit 4 ms, forced `/state?refresh=1` 17 ms across three runs. The write itself is a handful of local file operations per agent.

## Notes on the note bars

Two different green summary lines share one colour but not one box. The per-row saved line (`.am-saved`) is left aligned under its row and keeps a bottom pad; the bulk bar summary (`.am-bulk-note`) spans the bar on its own line, is horizontally centered, and carries `align-self:center` with an explicit `line-height` so it sits on the bar's vertical center. They are deliberately separate classes - sharing one made the bulk text ride high in its box.

## If a new route 404s on the live server

Server routes register when the plugin **activates**. A page reload alone never re-activates a loaded plugin (`ensureLoaded` skips ids it already holds), so a route added to a live plugin 404s with the SPA fallback until the plugin is re-activated: **Settings -> Plugins -> Rescan** (sends the `plugins_reload` socket message, disposes and re-activates every plugin with an epoch cache-buster) or a server restart. The client detects the non-JSON fallback and names this fix in the error instead of a bare status code.

## Not built

Bulk actions on **multiple agents** are built (select rows, apply one model to all - see below). Not built: a "repin every dead pin in one go" sweep, and a provider/key editor.
