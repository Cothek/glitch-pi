# agent-switcher (pi-web-ui plugin)

Switch the primary Glitch agent from the web UI, mid-session, no restart.

## Surfaces

1. **Composer chip** — an "Agent: <mode>" chip next to the chat input. Click opens a menu, pick a mode, it switches the active conversation immediately. On mobile (≤560px) it collapses to the 🤖 icon only — the same breakpoint and metrics the host uses for the model-selector chip (min-width 34, min-height 30, caret hidden; the text node is killed by `font-size:0`, which the ::before emoji ignores). aria-label keeps the full "Agent: <mode>" for screen readers.
2. **Agent tab** — top-bar panel: current mode, clickable mode list, refreshes every 5s.
3. **`/agent <mode>`** in the chat box — pi extension command, listed in the slash picker.
4. **Just ask** — say "switch to glitch omni" in chat; the `switch_agent` tool (from the pi extension) does it.

## Mechanics

This plugin is the web UI half of a two-part system:

- **pi extension** (`glitch-pi/.pi/extensions/agent-switcher.ts`) owns the actual switch: per-turn system prompt swap, `user/agent-mode.json` marker, `.pi/SYSTEM.md` staging, session persistence, optional frontmatter pins (model / thinking / tools / memoryContext).
- **This plugin** discovers modes from `.pi/agent-profiles/*.md` (frontmatter `description:` shows in labels), reads the current mode from `user/agent-mode.json`, and delivers `/agent <mode>` into the active conversation via `host.prompt()` — the same command path as typing it.

Mode discovery has a **global fallback**: profiles from `~/.pi/agent-profiles/*.md` always contribute, so the chip appears in every project folder — even ones with no local `.pi/agent-profiles/`. A same-id workspace profile overrides the global entry (project-specific tweaks win). `AGENT_SWITCHER_GLOBAL_DIR` overrides the global dir (tests use it). On this machine `~/.pi/agent-profiles` is a junction to `E:\Glitch AI\glitch-pi\.pi\agent-profiles`, so editing profiles in the repo propagates everywhere.

Routes (same-origin, auth'd with the web UI session):
- `POST /plugins-api/agent-switcher/switch` `{ mode }` — switch in the active conversation
- `GET /plugins-api/agent-switcher/state` — `{ modes, current }`

The composer select posts to the HTTP route directly (registered at activate; no dependency on the tab having been opened). The tab panel uses the same routes.

## Install / update

Source lives in the repo at `.pi/web-plugins/agent-switcher/`. Install (or update after editing):

**NOTE (this machine):** `$HOME\.pi-web\plugins\agent-switcher` is a **junction** to the repo source — edits are live in the deployed tree immediately. Do NOT Copy-Item into it (a dir copied into itself is what created the old `agent-switcher\agent-switcher` nesting bomb); just reload the plugin (below). The Copy-Item command applies to physical installs only:

```powershell
Copy-Item -Recurse -Force "E:\Glitch AI\glitch-pi\.pi\web-plugins\agent-switcher" "$HOME\.pi-web\plugins\agent-switcher"
```

Then, **depending on what changed**:

- **Brand-new plugin id** → just refresh the browser (the server discovers new ids on attach).
- **Changed code of an already-loaded plugin** (this case) → a browser refresh is NOT enough: the server loads each plugin id once per process (`ensureLoaded` skips ids already in `loaded`). Changed code needs a plugin reload — Settings → UI plugins → rescan/reload, or restart the server. The reload also bumps the plugin epoch, which is what makes browsers re-fetch `client/entry.mjs`.

Diagnostics without a browser: the plugin routes are reachable from loopback with no auth, e.g.

```powershell
curl.exe -s http://127.0.0.1:8787/plugins-api/agent-switcher/state
```

## Tests

```bash
node --test index.test.mjs
```

Uses the SDK's `createMockHost` against a fixture workspace: discovery, select registration, switch delivery, route contract, marker re-sync, empty-workspace behavior.

## Notes

- Mode switching while the agent is mid-stream can fail (the SDK rejects prompts during streaming in some paths) — the plugin surfaces the error; retry when idle.
- The marker is repo-global: switching in one conversation changes gate behavior (routing.ts) for concurrent conversations in the same repo. Same semantics as the TUI flow.
- Requires the pi extension (`glitch-pi/.pi/extensions/agent-switcher.ts`) to be loaded — without it the command text falls through to the model as a normal message.
