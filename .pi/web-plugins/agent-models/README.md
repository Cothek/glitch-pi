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
| `free` (green) | every cost field is 0 (the NVIDIA endpoints really are free). |
| `$0.15/$0.5` (amber) | input / output in **USD per million tokens**, published. The tooltip adds cache read/write, context, tier and which file the number came from. |
| `~$10/$50` | **estimated** from another vendor's same-slug listing (openrouter), because this provider publishes nothing. Never presented as a published price. |
| `n/a` (grey) | no price from any source. |

Alongside the price each option carries its **tier** and capability badges, and the picker filters on all of it:
```
All providers 507 | openrouter 392 | commandcode 59 | nvidia 56
All tiers 507 | budget 222 | mid 151 | free 79 | premium 55
Any capability 507 | Vision 315 | 200K+ context 372
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
- `nvidia` - 56 models, every field 0 = genuinely free.

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

47 tests: 35 server-side (parser, status truth table, lints, cost labels, the `/state` payload, the frontmatter rewrite, the write route) and 12 for the CLIENT via a fake DOM (`client.test.mjs`).

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

## Verified end to end (2026-09-24)

Driven through the real UI in the running web UI, not from curl:

- opened the Agent Models view, clicked **Change** on `reviewer`, picker rendered (61 options), searched, clicked `commandcode/z-ai/glm-5.3-flash`
- row flipped `DEAD PIN` -> `OK`, counts went `2 ok / 6 dead` -> `3 ok / 5 dead`, panel showed `saved: opencode/mimo-v2.5-free -> commandcode/z-ai/glm-5.3-flash | backup reviewer-2026-09-24T21-42-30-602Z.md`
- diag line recorded `last set-model:reviewer` and `write reviewer @ 4:42:30 PM`
- on disk: `.pi/agents/reviewer.md` line 5 = `model: commandcode/z-ai/glm-5.3-flash` (everything else untouched), and `.pi/agent-models/backups/reviewer-2026-09-24T21-42-30-602Z.md` holds the original `opencode/mimo-v2.5-free`
- `node scripts/agent-models.mjs` agrees: `3 pinned OK | 5 dead pins | 0 unresolved | 2 inherit`

## Not built

Bulk actions (repin every dead pin in one go) and a provider/key editor. The picker covers one agent at a time by design.
