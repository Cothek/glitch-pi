# Glitch-AI Startup System — Feature Inventory

Source: `E:/Glitch AI/glitch-ai` launch scripts, audited 2026-09-25 (glitch-pi HEAD 3fafaf3).
Re-verified 2026-09-26 at HEAD 6ea5aa9: 5 commits landed after the audit —
corrections are marked [REV 09-26].
Purpose: master feature list of how glitch-ai's startup scripts work, to compare
against glitch-pi's startup path. Every feature carries an ID (F##) so the
comparison can reference it as keep / drop / add.

Note on scope: "startup scripts" = the launch chain a user actually runs
(launch-glitch.* -> launch-unified.mjs -> mode scripts) plus the processes they
spawn and the helpers those scripts call. Install/repair tooling
(install.ps1, check-install.mjs, audit-*.mjs) is included only where the launch
chain invokes it.

---

## 1. Entry Layer (root wrappers)

### F01 — launch-glitch.bat / launch-glitch.sh (thin wrappers)
- PATH prep: bundled Node (`data/node/`) preferred, system node fallback.
- PATH prep: bundled MinGit (`data/mingit/`) on Windows.
- **Auto-bootstrap trigger**: if no Node at all, runs `scripts/bootstrap.ps1`
  (downloads Node) before continuing. Bash variant inlines the same logic.
- ASCII banner from `assets/glitch-head.txt`.
- Launch-log init: truncates `data/launch.log`, writes start line + args.
- Hands off to `scripts/launch-unified.mjs` with args, live output.
- Non-zero exit: logged + `pause` on Windows (keeps window open).

### F02 — serve-glitch.sh (server-mode entry)
- Same Node bootstrap logic as F01, then `exec scripts/serve.mjs`.

### F03 — restart-glitch.bat / restart-glitch.ps1 (external restart)
- Captures running `opencode.exe` PID via tasklist, `taskkill /f`, 2s wait,
  then relaunches `launch-glitch.bat` (Start-Process / `start ""`).
- ps1 variant is designed for schtasks (fully independent of a console).

### F04 — glitch.mjs CLI (in-session mode switcher)
- MODES registry: normal / free / local / safe (template, launch script,
  default model, agent list per mode).
- `switch`: backup config -> regenerate from target template -> kill running
  opencode -> relaunch DETACHED IN A NEW WINDOW (Start-Process cmd.exe on Win,
  terminal-emulator probing on Unix).
- `status`: current mode marker, active agents, config model, git branch.
- Repo-update check before switching (same engine as F09).

### F05 — bootstrap.ps1 (first-time setup installer)
Steps (per-step error tolerance, spinner UI, arch detection, dual log to file):
1. Portable Node.js -> `data/node/`
2. MinGit -> `data/mingit/`
3. Git submodules (zip-clone detection: silent skip vs loud failure)
4. OpenCode binary -> `opencode/`
5. Handy voice -> `handy-voice/`
6. cloudflared.exe -> repo root
Summary report at the end.

---

## 2. Dispatcher Layer

### F06 — launch-unified.mjs (mode dispatcher, the real brain)
1. **Launch-log tee** (F23): every console line also appended to
   `data/launch.log`, ANSI-stripped, ISO-timestamped.
2. **Branch check first**: prompt to switch to main; auto-stash + checkout;
   `GLITCH_BRANCH_OK` env prevents re-prompt; lists leftover
   `glitch-auto-stash:` entries.
3. **Repo update check** (F09) with restart-on-update.
4. **Restart-flag cleanup**: `data/.restart-timestamp` removed 5s after
   successful launch.
5. **Install-issues auto-fix**: if `data/install-issues.md` exists, runs
   `check-install-issues.mjs --fix` (submodule failures etc.).
6. **User-profile GitHub sync hint** when `user/` is not a git repo.
7. **Two-level mode menu**:
   - Delivery: Terminal (TUI) / Web / Pi / Safe
   - Model tier: Paid / Free / Local (skipped for Safe + Pi)
   - Saved preference `user/launch-preference.json` (Enter keeps last);
     `--mode <key>` skips menus; `--reset` clears preference.
   - Legacy alias normalization (`serve` -> web-paid, bare tier -> normal-tier).
8. Dispatch table:
   `normal-*` -> launch.mjs | `web-*` -> launch.mjs --serve |
   `safe` -> launch-safe.mjs | `pi` -> launch-pi.mjs
   (free/local have dedicated fork scripts).

---

## 3. Main Launch Pipeline (launch.mjs, normal-paid TUI)

Ordered startup steps; launch-free/local share this skeleton with mode-specific
additions (F35 / F36), serve.mjs runs a silent variant (F17, F39).

| # | Feature | What it does |
|---|---------|--------------|
| F07 | Zip-snapshot detection | No `.git/` -> warn git features unavailable |
| F08 | Branch check + auto-stash listing | Same as F06.2, refuses switch when dirty (vs unified's stash) |
| F10 | OpenCode self-bootstrap | Downloads latest opencode release tarball if binary missing (lib/bootstrap-opencode.mjs) |
| F11 | Submodule self-heal | `git submodule update --init --recursive` if `glitch-memorycore/glitch.md` missing |
| F12 | User-data repo sync | `user/` is a nested git repo; interactive pull check (lib/git-sync.mjs) |
| F13 | Handy voice input | Ensure installed (download per-OS), start detached if not running, reinstall+retry once on failure, `portable` flag on Win |
| F14 | Config backup | Timestamped copy of opencode.json to `data/backups/` (never overwritten) |
| F15 | User profile detection | `GLITCH_USER` env -> single-profile dir -> auto-discover; **self-heals** missing `main-memory.md` from git HEAD (lib/user-profile.mjs) |
| F16 | TUI config | `user/tui.json` -> `OPENCODE_TUI_CONFIG` env |
| F17 | Runtime config generation | Template `config/opencode-*.json` -> inject providers from `config/providers.json` (NVIDIA double-prefix fix, free-model culling) -> inject instruction files -> append memory refs to glitch/glitch-omni prompts -> apply `user/model-assignments.json` overrides -> sync `model:` lines into `.opencode/agents/*.md` |
| F18 | Model-assignments migration | One-time move legacy `data/model-assignments.json` -> `user/` |
| F19 | LM Studio context detection | Background probe, `--apply-if-changes`, non-blocking |
| F20 | Mode marker | `data/backups/.last-mode` JSON (mode, timestamp, model) |
| F21 | fix-paths | Windows backslash-path normalization (fix-paths.ps1/mjs) |
| F22 | Dependency update prompt | check-updates.mjs interactive (deps of the stack) |
| F24 | New-model check | check-models.ps1 (Win only) -> `data/model-update-status.json`, prints new models + **agent model dashboard table** |
| F25 | Model resolver | resolve-models.mjs keeps assignments current; when new models exist, one-time autonomy prompt (`data/model-resolver-preference.json`), auto-apply or skip |
| F26 | OpenCode self-update | npm minor/patch auto-update + sync global binary -> local `opencode/`; major = warn only |
| F27 | Root audit warning | audit-root.mjs --check: untracked artifacts warning |
| F28 | Start plugins | lib/plugin-manager.mjs: registry + manifests, skip-if-alive (PID + port), visible-window option, default-enabled set. [REV 09-26] RESCUE: this lifecycle engine is the base for the add-on control panel (NP16), not dead weight |
| F29 | External watchdog spawn | watchdog-external.mjs detached, PID file `data/logs/watchdog-external.pid` (see F36) |
| F30 | GitNexus sync spawn | gitnexus-sync.mjs detached background index refresh |
| F31 | Skills sync | Engine tree -> `.agents/skills/` (sync, before opencode starts, never deletes, non-blocking failure) |
| F32 | TUI launch + supervisor | superviseOpenCodeTUI: spawn opencode, `data/opencode.pid` lifecycle, inherit stdio |
| F33 | Restart loop (user restart) | `data/.restart-flag` (contains PID): wait old PID exit + port 4102 free, REGENERATE config, loop back — opencode-only restart, siblings reused |
| F34 | Silent-crash guard | opencode exit 0 in <5s = crashed before render; prints troubleshooting (broken release / fatal plugin / corrupt config) |

---

## 4. Variant Launchers

### F35 — launch-free.mjs (free-tier fork)
Everything in section 3 plus:
- **Free-model system**: model groups from `data/free-models.json` (cache
  refreshed by check-models.ps1) with hardcoded fallback groups (OpenCode Zen
  free, NVIDIA free endpoint, OpenRouter free).
- **Interactive model picker** with saved preference
  (`user/free-model-preference.json`); NVIDIA availability check
  (requires `/connect nvidia` in TUI); `nvidia/nvidia/` double-prefix fix.
- Engine bootstrap via lib/engine-bootstrap.mjs (zip-clone path).
- Premium-feature caveats in agent prompts.

### F36 — launch-local.mjs (LM Studio fork)
Everything in section 3 plus:
- **LM Studio model discovery** (http://192.168.86.139:1234, 5s timeout),
  registers every served model into the runtime config provider.
- **Local-mode prompt injection** ("all agents served locally, no external
  API, stick to 5 local agents").
- Default-model warning when LM Studio unreachable.

### F37 — launch-safe.mjs (recovery shell)
- Neutralizes config files opencode reads beyond the minimum.
- Neutralizes plugins not in the safe-mode whitelist.
- Sanitizes `auth.json` (prevents Provider.list crash).
- Handy start, opencode version print, silent-crash guard (F34).
- Prints where to fix what (template / engine / agents / branch).

### F38 — launch-pi.mjs (Pi migration path)
1. gitnexus-sync detached (F30 pattern).
2. `start-pi-stack.ps1`: pi-web-ui (:8787) + auth-proxy (:4103) detached via
   start-detached.ps1, skip-if-alive, `-Status` verb.
3. **Tunnel verify** (non-blocking warn): cloudflared process check + remote
   URL check where 401/403 = healthy behind Basic auth; repair hint.
4. Spawn Pi CLI in glitch-pi workspace (`GLITCH_PI_ROOT` override,
   .cmd/.bat shell handling).
5. `--stack-only` flag (no CLI spawn). Logs to `data/logs/launch-pi.log`.

---

## 5. Web Delivery (serve.mjs + lib/server-mode.mjs)

### F39 — serve.mjs (silent server entry)
- Silent variants of F08/F10-F17 (no prompts), plus:
- **.env loading** (repo root).
- **Janitor**: stale flags, old logs, temp dirs — 15s cap, never blocks.
- Ends in launchServer() (F40).

### F40 — launchServer (server-mode.mjs)
1. **Port conflict resolution**: netstat PID lookup; two-tier kill policy
   (glitch-specific names auto-kill vs generic `node`/`powershell` require
   explicit yes; pid-file match upgrades generic to auto); dead-process
   lingering-socket wait; 3 retries + final force-kill; winnat hint.
2. **Auth proxy reuse**: skip-if-alive via `data/auth-proxy.pid`
   (restarts reuse siblings; only opencode restarts).
3. **Cloudflare tunnel lifecycle**: config from template, tunnel UUID +
   credential check, **auto-setup** (`setup-tunnel.ps1 -Auto` + lock file),
   interactive browser login (`cloudflared tunnel login`), domain from
   `data/cloudflare-domain.txt` / config / env, skip-if-alive via
   `data/cloudflared.pid`, visible-window spawn on Win / detached on Unix.
4. **Password management**: `OPENCODE_SERVER_PASSWORD` env or
   `.server-password` file (random 16-byte hex, Windows ACL lock-down).
5. **Auth token + project slug**: base64(opencode:pw) + base64url(project dir)
   for project-pinned URLs.
6. Handy start (F13).
7. **Sessions API** (:4191) — opencode session browser backend.
8. **Env-gated add-ons**: GLITCH_ENABLE_MONEY (:4110 dashboard),
   GLITCH_ENABLE_TRADER, GLITCH_ENABLE_ANTIGRAVITY.
9. Plugins (F28).
10. **URL banner**: tunnel/local URLs with auth tokens, model-switcher :4104,
    plugin URLs.
11. **Periodic path fixer** — fix-paths every 5 min (interval, unref'd).
12. `opencode web --port 4102 --hostname 0.0.0.0` blocking, `data/opencode.pid`.
13. **cleanup() on SIGINT/SIGTERM**: kills tracked children + visible-window
    hosts by PID files, removes pid files.

---

## 6. Support Infrastructure

| # | Feature | What it does |
|---|---------|--------------|
| F23 | lib/launch-log.mjs | stdout/stderr tee wrapper -> `data/launch.log`, ANSI strip (SGR/OSC/CSI), line buffering, ISO timestamps; children with stdio:inherit intentionally NOT captured |
| F41 | lib/opencode-supervisor.mjs | `data/opencode.pid` write/clear + TUI supervision promise |
| F09 | lib/git-sync.mjs | Update engine: branch ops, fetch + behind/ahead, pull, submodule sync, dirty detection, auto-stash, **startup-critical file classification** (isStartupCritical -> restart decision), **restart-on-update** (detached respawn + `data/.restart-timestamp` 15s loop guard), user-repo sync (checkUserRepoUpdates) |
| F42 | lib/plugin-manager.mjs | Registry `data/plugins.json` + manifests (cmd/port/web_path/enabled), enable/disable/toggle/list, start/stop, skip-if-alive (PID + port), visible-window start, default-enabled collection. [REV 09-26] Has a live consumer again: the control panel (NP16) builds on it |
| F43 | lib/user-profile.mjs | Profile self-heal from git, detection (env -> dir -> discover), buildUserInstructions, buildMemoryPromptRefs |
| F44 | lib/inject-providers.mjs | Merge `config/providers.json` into runtime config; NVIDIA native double-prefix (`nvidia/nvidia/...`); cull unusable free models |
| F45 | lib/engine-bootstrap.mjs | Ensure engine content: submodule update path OR direct download fallback (zip installs) |
| F46 | lib/bootstrap-opencode.mjs | OpenCode release discovery + download + tar extraction |
| F47 | check-updates.mjs | Dependency freshness check + interactive update prompt (checkAndPromptUpdates / checkUpdatesOnly) |
| F52 | watchdog-external.mjs | OUT-OF-PROCESS watchdog: polls opencode SQLite DB for wedged bash tool calls (15-min threshold, 30s poll), kills hung process tree from outside (in-process watchdog dies when the event loop blocks), abort-agent.mjs integration, env-configurable paths |
| F53 | agent-watchdog.mjs | IN-PROCESS watchdog: idle-session detection -> signal files `data/.agent-idle.<sessionID>.json` (read-only DB) |
| F48 | start-detached.ps1 | Detached process launcher: CREATE_BREAKAWAY_FROM_JOB (survives opencode Job Object kill), logs -> `data/logs/<name>.log`, PID file, used by launch-pi/stack scripts |
| F49 | startVisibleWindow (server-mode.mjs) | Spawns service in a visible console window with PID capture (auth-proxy, cloudflared, plugins). [REV 09-26] Still has a live consumer: `scripts/addons/money-dashboard.mjs` imports it -> extract to `lib/start-window.mjs` BEFORE deleting the rest of server-mode.mjs |
| F50 | janitor.mjs | Stale-flag/old-log/temp-dir cleanup, time-capped. Tool is LIVE (has tests) but the only caller is serve.mjs (dead path) — never invoked at launch [REV 09-26] |
| F51 | check-install-issues.mjs --fix | Auto-repair of recorded install issues (invoked by dispatcher when flag file exists) |

---

## 7. Cross-Cutting Patterns (the "design language" of the system)

| # | Pattern | Where |
|---|---------|-------|
| P1 | Bundled-tool preference (Node, MinGit, cloudflared, opencode) with system fallback | everywhere |
| P2 | Skip-if-alive by PID file + process name (+ port check) instead of kill-and-respawn | auth-proxy, cloudflared, plugins, pi stack |
| P3 | Restart = restart the engine only; siblings (proxies, tunnels, dashboards) are reused | F33, F40 |
| P4 | Two restart paths: update-triggered detached respawn vs user `.restart-flag` in-process loop | F09 vs F33 |
| P5 | Every long-running child is detached + unref'd + PID-filed + logged | watchdog, gitnexus, tunnel, plugins |
| P6 | Non-blocking background extras (never gate the main launch) | LM Studio probe, gitnexus sync, watchdog |
| P7 | Timestamped config backups, never overwritten | F14 |
| P8 | Self-heal on boot (submodules, engine, profile file, Handy reinstall, install issues) | F05, F10, F11, F15, F51 |
| P9 | Zip-clone tolerance (no .git -> degrade gracefully) | F07, F45, bootstrap |
| P10 | Windows/Unix dual paths throughout (visible window vs detached spawn; tasklist vs pgrep) | all |

---

## 8. Quick comparison notes (observed, not yet decided)

- glitch-pi inherited the ENTIRE launch family as identical copies; divergence
  so far: `launch-pi.mjs` (264 -> 482 lines, rewritten),
  `launch-unified.mjs` (+120 lines), `start-pi-stack.ps1` (90 -> 256 lines),
  small deltas in lib/git-sync.mjs and lib/server-mode.mjs.
- glitch-pi ADDED: `stop-pi-stack.ps1`, `pi-stack-window.ps1`,
  `start-pi-stack-window.ps1`, `setup-tunnel.ps1/sh` (moved from glitch-ai?).
- The opencode-specific features (F17 config generation, F24-F26 model system,
  F35-F37 free/local/safe variants, F40 opencode web) are the candidates to
  prune in a Pi-native startup path; the infrastructure patterns (P1-P10,
  F23/F41/F42/F48) are the candidates to keep/reuse.

## 8a. Pi-native features ADDED in glitch-pi (not in the glitch-ai list)

These already exist in glitch-pi and are part of its startup story:

| ID | Feature | Where |
|----|---------|-------|
| NP1 | Interface menu TUI/Web with saved prefs (last_pi_mode in data/launch-preference.json [REV 09-26]), --tui/--web/--reuse-saved, non-TTY fallback | launch-pi.mjs |
| NP2 | Windowed vs headless stack modes with ownership semantics (close window = stop stack) | start-pi-stack.ps1, pi-stack-window.ps1, start-pi-stack-window.ps1 |
| NP3 | Tunnel single lifecycle owner: ensure/start/stop/status, PID-file ownership + PID-recycle guard, origin gate (no tunnel to dead stack), remote verify | lib/tunnel.mjs |
| NP4 | Tunnel-keeper extension: session-start + 5-min watchdog, sub-agents skip, never throws | .pi/extensions/tunnel-keeper.ts |
| NP5 | Login banner single source (.server-username + .server-password, console-only password hygiene); credential changer set-credentials.mjs [REV 09-26] | lib/web-auth.mjs, scripts/show-credentials.mjs, scripts/set-credentials.mjs |
| NP6 | Stop verb: kills whatever holds the stack ports however it was started; stops only tunnels this repo owns | stop-pi-stack.ps1 |
| NP7 | Pi extensions loaded at session start (mulahazah, stuck-detector v2, routing, agent-switcher, dispatcher, memory-tools, nvidia-model-sync, tunnel-keeper, commandcode-usage [REV 09-26]) | .pi/settings.json |
| NP8 | pi-web-ui as web delivery (separate npm app in data/node) | ~/pi-web-ui-launcher.cmd |
| NP9 | Fork guard: OpenCode deliveries hidden when binary absent; --mode redirects to Pi | launch-unified.mjs (diverged) |
| NP10 | **Full-chain stack restart** [REV 09-26]: kills stack by port-owning PID (never by name, R22), waits for ports free, then restarts through the REAL startup chain (`launch-unified.mjs --reuse-saved`) so agent config/sync/banner come back (a bare launcher.cmd restart left the agent switcher missing), HTTP-200 health check (60s), optional **continuation injection** into the target conversation (`-ContinueId`/`-ContinuePath` + `-ContinueText`/`-ContinueFile`), `-DelaySec` so an agent can finish its message before its own session is killed | scripts/restart-pi-stack.ps1 |
| NP11 | Continuation injector: drives pi-web-ui's own WebSocket (hello -> switch_conversation -> prompt), so a restarted stack resumes the conversation exactly where a human retyping would. `--list`, `--id`, `--path`; local port needs no auth | scripts/resume-session.mjs |
| NP12 | Machine-local launch preferences: `data/launch-preference.json` (gitignored) replaces the synced `user/` copy, which stays as a read-only legacy fallback; writes MERGE, never clobber, so launch-unified and launch-pi share one file | launch-unified.mjs, launch-pi.mjs |
| NP13 | `--reuse-saved` / `GLITCH_REUSE_SAVED=1` gate: restarts and automation never hang on a prompt (branch check, update prompt, delivery menu, interface menu). Saved selections win; a reused selection is never re-saved, so automation can't clobber a real pick. Non-TTY also triggers it | launch-unified.mjs, launch-pi.mjs |
| NP14 | Origin allow-list `PI_WEB_ALLOW_ORIGINS` (pi-web-ui 403s browser WS upgrades whose Origin != Host; behind proxy/tunnel Host is localhost). **Duplicated in 3 places, one OUTSIDE the repo** (%USERPROFILE%\pi-web-ui-launcher.cmd) — drift hazard (G6) | start-pi-stack.ps1, pi-stack-window.ps1, launcher.cmd |
| NP15 | Pi-native model pricing/usage stack: `.pi/agent-models/` (prices.json, costs.json) + agent-models web plugin + commandcode-usage.ts extension reading lib/commandcode-usage.mjs | .pi/, config/commandcode-prices.json |
| NP16 | Add-on control panel (PLANNED, from D1): manage companion apps from the Pi web UI - status (port probe), Start/Stop, auto-start toggle, link to each app's UI. Shape verified from the SDK: `.pi/web-plugins/addons/` (UI; permissions are ui/fs/http only - **no spawn**) + `.pi/extensions/addon-controller.ts` (privileged half, the agent-switcher pattern) + `lib/addon-manager.mjs` (rescued plugin-manager). Targets: money :4110, trader api :4120 / web :3000, browser-use :4105 | planned: .pi/web-plugins/addons/, .pi/extensions/addon-controller.ts, lib/addon-manager.mjs |
| NP17 | Browser control (browser-use): a real host-side automation plugin - `server.mjs` + Playwright/Chromium, port 4105, `headless: config?.headless !== false` (headless by default), manifest default_enabled false. The skill talks to `localhost:4105`, so **the browser already spawns on the HOST** and a remote client never drives it. Currently DORMANT: nothing in the Pi chain starts it | plugins/browser-use/ |
| NP18 | MCP status: the pi CLI DOES support MCP (`mcpServers` in the bundle), but **no MCP config exists** - not in `.pi/settings.json`, not in the user settings, no `.mcp.json` anywhere. AGENTS.md documents GitNexus MCP as available while it is not wired up. `plugins/mcp-server/` is orphaned `node_modules` only (no source, no package.json, no importers) | .pi/settings.json (absent) |

## 9. Comparison verdicts (glitch-pi, 2026-09-25, re-verified 2026-09-26 at HEAD 6ea5aa9)

Verified against the live repo: NO opencode binary, NO opencode.json, NO
.opencode/, no opencode-*.json templates (already deleted), develop-based
branches, Troy's live prefs = pi / web / windowed. [REV 09-26] 9 loaded
extensions (commandcode-usage added); launch prefs now target
data/launch-preference.json while the legacy user/ file still exists as a
read-only fallback; `pi_stack_mode` is MISSING from that legacy file, so the
next --reuse-saved restart falls back to headless instead of windowed (G8 —
reported, not silently changed).

Legend: KEEP (alive + wanted) - DROP (dead, delete) - ADD (missing, build) -
PORT (concept survives, implementation changes) - DECIDE (Troy's call).

| Feature | State in glitch-pi | Verdict |
|---------|--------------------|---------|
| F01 root wrappers | alive, dispatch via unified | KEEP |
| F02 serve-glitch.sh | dead (serve.mjs is opencode) | DROP |
| F03 restart-glitch.* | dead (kills opencode.exe) | DROP the glitch-ai script — SUPERSEDED by NP10 (restart-pi-stack.ps1 is Pi-native and strictly better: port-PID discipline, full-chain restart, health check, continuation injection) [REV 09-26] |
| F04 glitch.mjs switcher | dead | DROP (agent-switcher ext + switch-agent.mjs cover it) |
| F05 bootstrap.ps1 | installs opencode+Handy, does NOT install pi | PORT: rewrite as bootstrap-pi |
| F06 unified dispatcher | alive with fork guard (NP9) | KEEP + simplify (Phase 3) |
| F07 zip-snapshot guard | only in dead scripts | optional ADD to launch-pi |
| F08 branch check | alive, develop-only guard works | KEEP |
| F09 git-sync update engine | alive; isStartupCritical misses .pi/ | KEEP + ADD .pi/ paths |
| F10 opencode bootstrap | dead | DROP |
| F11 submodule self-heal | alive via git-sync | KEEP |
| F12 user-repo sync | MISSING in Pi path (lived in launch.mjs) | ADD (silent pull check in the pi path) |
| F13 Handy voice | zero refs in .pi/ | DECIDE: drop from startup, or port later |
| F14 config backup | N/A (Pi config is git-managed) | DROP |
| F15 user-profile detect | N/A (memory via AGENTS.md imports) | DROP |
| F16 tui.json env | dead | DROP |
| F17 runtime config gen | dead | DROP |
| F18 assignments migration | dead | DROP |
| F19 LM Studio context detect | dead form; Pi has local models via profiles | DEFER (Pi-native variant possible) |
| F20 mode marker | dead | DROP |
| F21 fix-paths | dead | DROP |
| F22 check-updates | dead | DROP (optional pi version check later) |
| F24-F26 model system | dead chain; Pi-native successor stack exists | DROP from chain. [REV 09-26] Successor: `.pi/agent-models/` (prices.json/costs.json) + agent-models web plugin + nvidia-model-sync.ts + commandcode-usage.ts. `config/commandcode-prices.json` is KEEP (live readers) |
| F27 root audit | generic, dead wiring | optional ADD to unified |
| F28 plugin manager | DEAD as a chassis, ALIVE as logic: nothing in Pi starts plugins today, but the engine is exactly what the control panel needs | RESCUE -> port to `lib/addon-manager.mjs` (NP16); triage plugins/ per D5 [REV 09-26] |
| F29 external watchdog | dead (opencode.db) | DROP; stuck-detector.ts is the Pi-native port |
| F30 gitnexus sync | alive in launch-pi | KEEP |
| F31 skills sync | GAP: sync-skills.mjs has --pi flag, launch-pi never calls it | ADD call (non-blocking) |
| F32 TUI supervisor | dead | DROP |
| F33 restart loop | dead (nothing writes .restart-flag in Pi) | DROP |
| F34 silent-crash guard | dead | optional PORT to launch-pi |
| F35/F36 free/local forks | dead | DROP |
| F37 safe mode | dead script, concept valuable (broken extension recovery) | DROP script; DECIDE on --safe flag |
| F38 launch-pi.mjs | ALIVE, heavily evolved (NP1) | KEEP (primary script) |
| F39/F40 serve/server-mode | dead; replaced by stack scripts + tunnel.mjs + web-auth.mjs | DROP both |
| sessions API (F40.7) | dead | DROP opencode-sessions-api.mjs |
| add-ons money/trader | no live refs in the launch chain, but both apps exist on disk WITH prerequisites (trader: engine/main.py + .venv; money: code/glitch-money) | KEEP - Troy runs them; the control panel starts them on demand (NP16). money-dashboard imports `startVisibleWindow` from the dead server-mode.mjs -> rescue first [REV 09-26] |
| F23 launch-log tee | alive (unified) + launch-pi own log | KEEP |
| F41 supervisor lib | dead | DROP |
| F42 plugin-manager lib | unreachable but functionally needed | RESCUE -> `lib/addon-manager.mjs` for the control panel [REV 09-26] |
| F43 user-profile lib | dead | DROP |
| F44 inject-providers | dead; config/providers.json + tools*.json + tui.json unreferenced | DROP + delete leftover config files |
| F45 engine-bootstrap | dead (submodule path suffices) | DROP |
| F46 bootstrap-opencode | dead | DROP |
| F47 check-updates | dead | DROP |
| F52/F53 watchdog scripts | dead | DROP (stuck-detector.ts replaces) |
| F48 start-detached.ps1 | ALIVE (detached stack) | KEEP |
| F49 visible window | replaced by pi-stack-window family for the stack; server-mode's copy is still imported by money-dashboard | KEEP new; EXTRACT `startVisibleWindow` to `lib/start-window.mjs`, then drop the rest [REV 09-26] |
| F50 janitor | Tool EXISTS and is tested; never invoked (flags 8 -> 13, actively accumulating) | KEEP the tool + WIRE IT IN at launch (G4). Do NOT write a new janitor [REV 09-26] |
| F51 install-issues auto-fix | alive via unified | KEEP |
| mulahazah-helpers.mjs | USED by live mulahazah.ts extension | KEEP |
| ensure-tools.mjs | used by skills (audit/critique) on demand | KEEP |
| P1-P10 patterns | alive or re-implemented Pi-natively | KEEP as design language |

Dead-weight summary: ~35 files deletable (launch forks, opencode libs, watchdog
scripts, opencode-era config files, restart/serve entries) pending the per-file
verify protocol in the plan.

[REV 09-26] DELETION PROTOCOL CORRECTION: "no importers" proves a LIBRARY is
dead, but proves nothing about a STANDALONE CLI TOOL (janitor.mjs was nearly
deleted on exactly that mistake). Classify first: file in lib/ or exports-only
-> importer test is decisive. File with a shebang/CLI main in scripts/ -> also
check manual use, skills, docs, and scheduled invocations. Standalone tools on
the opencode-coupling argument (they read opencode.db/config) stay delete;
tools that are merely unreferenced need Troy's sign-off.

[REV 09-26] Stale docs to clean (not blockers, not startup code):
docs/architecture.md + docs/configuration.md still describe the opencode-era
pipeline (providers.json, inject-providers, lmstudio-context-detector);
.pi/skills/code-review/SKILL.md lists launch.mjs/launch-free/launch-safe/
serve.mjs as the startup scripts. Update after Phase 1 lands. Execution plan: docs/startup-chain-plan.md.
