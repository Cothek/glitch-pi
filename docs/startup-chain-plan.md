# Plan: Pi-Native Startup Chain (glitch-pi)

**Created**: 2026-09-25, **revised 2026-09-26** after post-audit verification
**Status**: draft for Troy's review (not yet executing)
**Revised because**: 5 commits landed after the audit (now HEAD 6ea5aa9). Folded
in: `restart-pi-stack.ps1` + `resume-session.mjs` (the F03 successor, already
built), machine-local prefs (`data/launch-preference.json`), the `--reuse-saved`
prompt gate, `PI_WEB_ALLOW_ORIGINS` (3 copy sites), a 9th extension. Gaps G1-G5
re-verified as still open; new gaps G6-G8 added.
**Companion doc**: docs/startup-feature-audit.md (feature inventory + verdicts)
**Branch for all work**: cut `feat/startup-cleanup` from `develop` (R16: never main; note this repo has no local main)

## Goal

A startup chain that is 100% Pi-native: launch-glitch.bat -> launch-unified.mjs
-> launch-pi.mjs (TUI or Web) with the Pi stack, tunnel, GitNexus sync, skills
sync, memory-repo sync and housekeeping — and zero opencode-era dead weight,
dead menus, or install steps that can never run.

## Approach

Four phases, ordered so every phase is independently shippable and the chain
never breaks. The dead code is currently unreachable (the fork guard hides it),
so Phase 1 deletion is low-risk. Gaps get closed in Phase 2. Phase 3 is the UX
simplification that only makes sense once the dead code is gone. Phase 4 is
optional polish gated on Troy's decisions.

```
Phase 0  Decisions (Troy, blocking)
Phase 1  Deletion sweep (dead code, verify-then-delete)
Phase 2  Gap closure (5 ADDs from the audit)
Phase 3  Dispatcher simplification (one menu, one flow)
Phase 4  Optional polish (deferred items)
```

## Phase 0 — Decisions needed from Troy

| # | Question | Default if no answer |
|---|----------|---------------------|
| D1 | Money dashboard / glitch-trader add-ons: used standalone? Delete or keep files? | **ANSWERED 2026-09-26: KEEP and RUN them.** Troy wants a **control panel in the Pi web UI** that starts add-ons on demand (money, trader, ...) with optional auto-start -> Phase 5 |
| D2 | Handy voice: drop entirely, or port as a Pi extension later? | Drop from startup, keep handy-voice/ dir untouched |
| D3 | Safe-mode parity: want a `--safe` / `--no-extensions` launch flag for recovering from a broken extension? | Defer (Phase 4) |
| D4 | Menu merge: today launching is unified menu (1 item: Pi) then launch-pi's interface menu (TUI/Web). Merge into ONE menu? | Yes, merge in Phase 3 |
| D5 | plugins/ triage: auth-proxy is alive. model-ui, glitch-ui, browser-use, curriculum, tools, mcp-server — which are real? | **ANSWERED + AUDITED 2026-09-26.** DELETE: `model-ui` (dead, superseded by the agent-models web plugin), `glitch-ui` (dead UI kit, only dependency was model-ui), `mcp-server/node_modules` (orphaned deps, no source, no importers). KEEP: `auth-proxy.mjs` (live gate), `browser-use` (**alive, host-side Playwright, currently dormant — needs wiring + a visibility decision**), `curriculum` (just `curriculum-state.json`, a state file for the live curriculum skill, no service), `tools` (utility scripts). MCP: Pi DOES support MCP (`mcpServers` in the CLI bundle) but **no MCP config exists** in this repo or the user config, so GitNexus MCP is documented in AGENTS.md yet not wired up |
| D6 | Stale MEMORY_TRIGGER_FLAG files in data/ (13 now, up from 8): approve wiring the existing `scripts/janitor.mjs --apply` into the launch chain to clean them? (Its 24h rule is sufficient - see G4; no extra liveness guard needed.) | Yes, Phase 2 |

## Phase 1 — Deletion sweep (no behavior change)

Rule: the fork guard makes these unreachable, so removing them cannot change
runtime behavior. Per-file protocol before each delete — with the
**library-vs-standalone-tool split** (added 2026-09-26 after a near-miss:
janitor.mjs, a live CLI tool WITH tests, was on the list purely because nothing
imports it — a CLI tool is executed, never imported):

1. Library (in `lib/`, or export-only, no CLI main) → the importer grep is
decisive.
2. Standalone tool (shebang / CLI main in `scripts/`) → also check manual and
   scheduled use, `.pi/skills/`, `docs/`, and other scripts.
3. A tool whose deps are opencode-only (opencode.db, opencode.json) is still
   delete-able; a tool that is merely UNREFERENCED needs Troy's sign-off.

`grep -rl "<filename>" .pi/ plugins/auth-proxy.mjs scripts/ docs/ data/plans/`
— delete only on zero live consumers; anything with a live consumer moves to
the KEEP list and gets noted in the audit doc.

Delete (verified dead — entry points were only the opencode SCRIPT_MAP,
serve.mjs, or opencode.db):

- `scripts/launch.mjs`, `launch-free.mjs`, `launch-local.mjs`, `launch-safe.mjs`
- `scripts/serve.mjs`
- `scripts/glitch.mjs`, `glitch.bat`, `glitch.sh`
- `scripts/restart-glitch.bat`, `restart-glitch.ps1`, `restart-free-model.ps1`
- `serve-glitch.sh` (root)
- `scripts/opencode-sessions-api.mjs`
- `scripts/agent-watchdog.mjs`, `watchdog-external.mjs`,
  `test-agent-watchdog.mjs`, `test-watchdog-external.mjs`,
  `test-get-port-pid.mjs`, `scripts/lib/agent-watchdog-helpers.mjs`
- `scripts/check-models.ps1`, `check-updates.mjs`, `check-updates.ps1`,
  `scripts/detect-lmstudio-context.mjs`, `scripts/lib/lmstudio-context-detector.mjs`
- **RESCUE FIRST, then delete the remains** (2026-09-26, both verified):
  `lib/plugin-manager.mjs` -> becomes the add-on manager (Phase 5);
  `lib/server-mode.mjs` -> extract `startVisibleWindow` into `lib/start-window.mjs`
  because `scripts/addons/money-dashboard.mjs` imports it (a live consumer the
  earlier grep missed because the add-on is not in the launch chain).
- `lib/opencode-supervisor.mjs`,
  `lib/bootstrap-opencode.mjs`, `lib/inject-providers.mjs`, `lib/engine-bootstrap.mjs`,
  `lib/user-profile.mjs`, `lib/sqlite-driver.mjs`, `lib/parse-netstat.mjs`,
  `lib/migrate-assignments.mjs`, `lib/agent-roles.mjs`, `lib/vision-logger.mjs`,
  `lib/review-pass-helper.mjs`, `lib/install-tool.mjs`
- `config/providers.json`, `config/tools.json`, `config/tools-playwright.json`,
  `config/tools-security.json`, `config/tui.json`
- D1 resolved: `scripts/addons/` (money-dashboard, glitch-trader) **STAY** — Troy runs
  them; the control panel (Phase 5) starts them on demand with optional auto-start.
- D5 resolved: DELETE `plugins/model-ui/`, `plugins/glitch-ui/`,
  `plugins/mcp-server/` (node_modules only — orphaned deps). KEEP `plugins/browser-use/`
  (live, dormant), `plugins/curriculum/` (skill state), `plugins/tools/`.

Explicit KEEP (verified alive — do not delete):

- `lib/git-sync.mjs` (unified), `lib/launch-log.mjs` (unified),
  `lib/mulahazah-helpers.mjs` (mulahazah.ts extension),
  `lib/tunnel.mjs` + `lib/web-auth.mjs` (stack), `start-detached.ps1` (stack),
  `gitnexus-sync.mjs` + `sync-skills.mjs` (launch-pi),
  `show-credentials.mjs` (stack banner), `ensure-tools.mjs` (skills),
  `agent-models.mjs` / `agent-model-costs.mjs` / `commandcode-prices.mjs`
  (Pi-native model tooling), `check-install-issues.mjs` (unified auto-fix),
  `pi-plugin-reload.mjs`, `switch-agent.mjs`, all stack/window/tunnel scripts.

Files to change:
- Above deletions; plus `launch-unified.mjs` SCRIPT_MAP shrinks to `{ pi }` and
  the opencode script-existence references go away (they are behind the guard
  but now reference deleted files — clean them up in the same commit).

Risks:
- Hidden consumers (a skill or doc referencing a deleted file) -> mitigated by
  the per-file grep protocol; anything ambiguous stays.
- The other Glitch (glitch-ai) still uses its own copies — this deletion is
  glitch-pi-only, zero effect on glitch-ai.

Verification:
- `node scripts/launch-unified.mjs --mode pi --help`-style smoke: unified runs,
  dispatches, launch-pi reaches the interface menu (Ctrl+C to exit).
- `powershell scripts\start-pi-stack.ps1 -Status` still answers.
- `git grep` for each deleted filename returns nothing in live code.
- Full launch of a TUI session once, confirm log lines in data/launch.log.

### Phase 1a — DONE (commit 4acc4cc)

14 files removed; `launch-unified.mjs` now dispatches Pi only (OpenCode-era mode
keys redirect with a log line). Preserved intact: --reuse-saved gate, pref
read/merge, fork guard, branch/update checks. **28 of 42 candidates were SKIPPED**
by the per-file protocol — every one has a real consumer. My original list was
built from launch-chain greps only and missed a whole consumer generation.

### Phase 1b — consumer-first teardown (the actual remainder of Phase 1)

**A. Dead consumers to delete FIRST (they block the main list):**
- `switch-mode.mjs` / `.bat` / `.sh` — no callers; imports `lib/user-profile.mjs`
- `scripts/test/*.test.mjs` — 4 tests whose subjects are dead
  (launch-integration, inject-providers, lmstudio-context-detector,
  detect-lmstudio-context)
- `validate-config.mjs` / `.ps1` — validate opencode.json, call glitch.mjs
- `resolve-models.mjs`, `switch-model.ps1`, `sync-nvidia-models.mjs`
- `check-review-pass.mjs`, `test-review-pass.mjs`, `write-review-pass.mjs`
- `test-vision-dispatch.mjs`, `test-vision-logger.mjs`
- `audit-data.mjs`, `audit-data-review.mjs` — reference model-ui
-
  -> unblocks: launch.mjs / launch-free / launch-local / launch-safe, serve.mjs,
  glitch.mjs+bat+sh, user-profile.mjs, review-pass-helper.mjs, vision-logger.mjs,
  check-models.ps1, detect-lmstudio-context.mjs, lmstudio-context-detector.mjs,
  inject-providers.mjs, plugins/model-ui/, plugins/glitch-ui/

**B. Live files needing a reference cleanup first:**
- `lib/git-sync.mjs` (alive) references `serve.mjs`
- `bootstrap.ps1`, `install.ps1`/`.sh`, `setup.ps1`, `setup-tunnel.ps1`/`.sh`,
  `check-install.mjs`, `audit-root.mjs`, `restart-pi-stack.ps1`, `switch-agent.mjs`
  reference `glitch.bat`
- `plugins/auth-proxy.mjs` routes `/plugins/glitch-ui/*` to the dead model-ui
  port (URL strings only, not a file dependency — safe to delete the dirs)

**C. NEW RESCUES found by the protocol (live consumer — do NOT delete):**
- `scripts/lib/sqlite-driver.mjs` — **actually imported** by
  `lib/mulahazah-helpers.mjs`, which the live mulahazah.ts extension uses
  (network of the same near-miss class as janitor / plugin-manager / startVisibleWindow)
- `config/tools.json` — `ensure-tools.mjs`, used on demand by audit/critique skills
- `config/providers.json` — `discover-local-models.mjs`, `ensure-local-model.mjs`
  (verify those two are alive before deciding)

**D. Doc-only "consumers" (safe to delete despite the grep hits):**
`serve-glitch.sh`, `check-updates.ps1`, `config/tools-playwright.json`,
`config/tools-security.json`, `config/tui.json`, `plugins/mcp-server/`
(its only hit was a `.gitignore` entry).

## Phase 2 — Gap closure (the ADDs)

| # | Gap | Change | Where |
|---|-----|--------|-------|
| G1 | Skills drift (F31) | call `node scripts/sync-skills.mjs --pi` synchronously-but-time-capped (30s, non-fatal) before spawning pi / printing "stack-only complete" | `launch-pi.mjs` |
| G2 | Update-restart misses Pi config (F09) | add `.pi/` to isStartupCritical (extensions, settings, agent-profiles, skills are startup-critical here); keep config/ + scripts/ rules as-is | `scripts/lib/git-sync.mjs` |
| G3 | Memory repo not synced on launch (F12) | port checkUserRepoUpdates into the pi path: interactive pull prompt when TTY, silent best-effort when not; called from unified BEFORE dispatch (so it covers both TUI and Web) | `launch-unified.mjs` (import stays in git-sync.mjs) |
| G4 | Housekeeping rot (F50) | **Wire in the EXISTING `scripts/janitor.mjs`, do not rewrite it** (REV 09-26): it already deletes `MEMORY_TRIGGER_FLAG.*` older than 24h, rotates protected logs, clears temp dirs, and has `test-janitor.mjs`. Add a launch-time `--apply` call (15s cap, never fatal) from launch-unified before dispatch. Flags went 8 -> 13 unchecked. Note: the 24h mtime rule is the repo's tested behavior and is fine — the mulahazah heartbeat is 15 min, so a 24h-old flag cannot belong to a live session; no extra liveness check needed (this supersedes the earlier "liveness-aware" wording). | `launch-unified.mjs` (caller) |
| G5 | Bootstrap installs the wrong engine (F05) | new `scripts/bootstrap-pi.ps1`: Node portable -> MinGit -> submodules -> `npm install -g @earendil-works/pi-coding-agent pi-web-ui` into data/node -> cloudflared.exe. Drops opencode + Handy steps. launch-glitch.bat points at bootstrap-pi when data/node missing. | new script + `launch-glitch.bat`/`.sh` swap |
| G6 | Allow-list drift (NP14) | `PI_WEB_ALLOW_ORIGINS` is duplicated in 3 places, one of them OUTSIDE the repo (`%USERPROFILE%\pi-web-ui-launcher.cmd`), with a comment saying "change all three together". Single-source it: the two in-repo stack scripts already set it; regenerate the outside-repo launcher from a repo file, or drop the file dependency by having the stack scripts launch pi-web-ui directly. Decision needed on which. | `start-pi-stack.ps1`, `pi-stack-window.ps1`, + whatever replaces launcher.cmd |
| G7 | Machine-local state still committed | The legacy `user/launch-preference.json` is still present in the tracked/synced `user/` repo — exactly the leak the data/ move fixed. Remove it from the user repo's tracking and add it to that repo's ignore pattern. | `user/` repo (its own .gitignore) |
| G8 | Saved stack mode lost | **RESOLVED 2026-09-26 — Troy's intent: the Pi web server always starts in its OWN window; a restart is a separate service that closes it, restarts, and opens a new window.** Verified the mechanism already matches: windowed mode runs `start-pi-stack-window.ps1`, which uses `Start-Process powershell` -> a genuine NEW console window even when the parent is a detached restart service, and closing it stops web UI + proxy + tunnel. `restart-pi-stack.ps1` already IS the separate restart service (kill by port PID -> full chain -> HTTP health check). Left to do: restore `pi_stack_mode=windowed` (one `--windowed` run) OR flip the reuse-saved fallback from 'headless' to 'windowed'. | `launch-pi.mjs` (+ one run to re-persist) |

Order: G2 (tiny) -> G1 -> G3 -> G4 -> G5 -> G6 -> G7. Each is one commit.
G8 is report-only (Troy's call, no commit).

Risks:
- G1 sync-skills --strict semantics could fail a launch -> non-fatal by design
  (log warn, continue), same contract as the old launch.mjs call.
- G4 deleting a flag a live-but-idle session still wants -> liveness check is
  conservative (48h + not-running), and mulahazah recreates flags on demand.
- G3 interactive prompt on every launch -> mirror glitch-ai behavior: only
  prompts when actually behind; remembers skip per session.

Verification:
- G1: delete a skill file in .pi/skills, launch, confirm it is restored from
  the engine tree and the log line appears.
- G2: touch a file under .pi/extensions/, run the update check, confirm
  restartNeeded=true.
- G3: commit a change in the user repo from another machine (or simulate behind
  state), launch, confirm the pull prompt / silent pull happens.
- G4: plant a fake old flag file + oversized log, launch, confirm both cleaned.
- G5: rename data/node temporarily, run launch-glitch.bat, confirm bootstrap-pi
  installs Node + pi + pi-web-ui and the launch proceeds.

## Phase 3 — Dispatcher simplification (after D4)

HARD CONSTRAINT [REV 09-26]: `restart-pi-stack.ps1` restarts the stack through
`launch-unified.mjs --reuse-saved` and depends on that exact contract (no
branch/update prompts, saved selections win, nothing re-saved, 'web'/'headless'
fallbacks). This refactor MUST preserve the contract's behavior, or every agent
self-restart breaks. The restart test is part of Phase 3's acceptance criteria.

One menu instead of two:

```
Glitch AI - Pi
  [1] TUI   terminal in this window
  [2] Web   pi-web-ui + stack + tunnel
  [3] Safe  no extensions (if D3 approved)
```

- launch-unified.mjs loses the delivery list, tier list, SCRIPT_MAP indirection
  and the fork guard (nothing left to guard). It becomes: branch check ->
  update check -> install-issues -> user-repo sync -> janitor -> interface
  choice -> exec launch-pi.mjs --tui/--web.
- Saved prefs stay compatible: `--mode pi` keeps working (accepted, ignored);
  last_pi_mode carries over as the default.
- --reset keeps clearing preferences.

Risks: preference-format drift for the one file user/launch-preference.json ->
keep keys unchanged, additive only.

Verification: every entry route still works — fresh (no prefs), saved-prefs
Enter-Enter flow, `--mode pi` legacy, `--web` flag, non-TTY (extension) path
falls back to saved prefs without prompting.

## Phase 4 — Optional polish (deferred until asked)

- O1: `--safe` launch path (skip .pi/settings.json extensions) per D3.
- O2: root audit warning in unified (audit-root.mjs is generic).
- O3: silent-crash guard port: pi exiting 0 in <5s prints diag hints.
- O4: pi-coding-agent version check vs npm latest (successor of F22/F26).
- O5: Handy voice as a Pi extension (if D2 says port it).
- O6: LM Studio context-length sync into .pi/agent-profiles (Pi-native F19).

## Phase 5 — Add-on control panel (from D1/D5, 2026-09-26)

**STATUS 2026-09-26 (session 01a0dddd): CORE BUILT + VERIFIED.**
- `scripts/addon-control.mjs` — lifecycle engine (list/status/start/stop/autostart/start-auto).
  Verified live: money start -> 4110 LISTENING -> second start idempotent (same PID) ->
  stop -> port free; browser-use start -> 4105 LISTENING -> stop clean.
- `scripts/pi-web-plugins/addons/` — manifest + index.mjs (15s status poll, one background
  task per RUNNING add-on with a stop button, routes GET /state + POST /start|/stop|/autostart,
  `/addons` slash command, auto-start of flagged add-ons on activate). Linked live:
  the installer reports `addons: linked`.
- Client tab deliberately SKIPPED: the Background tasks panel already provides the same
  start/stop buttons and `/addons` prints the full table, so a tab would duplicate both.
  It stays a one-file follow-up (defineView pattern) if Troy wants inline auto-start
  checkboxes and clickable port links.
- `data/browser-use/config.json` set to `{"headless": false}` for the visible, interactive
  browser Troy asked for.

**OPEN GAP (verified — blocks real browsing):** browser-use runs in **STUB MODE**. Its log
says `browser-use installed: false` / "Running in stub mode — install browser-use to enable
automation". `plugins/browser-use/node_modules` does not exist, so its declared dependency
(`browser-use: latest`) was never installed. Chromium IS present (ms-playwright holds
chromium-1223..1243), so the only missing piece is the package install:
`cd plugins/browser-use && npm install` (or `scripts/install-browser-use.ps1`). Until that
runs, the panel manages a server that cannot automate anything.

**NOTE:** `data/` is gitignored, so `config.json` (headless:false) is machine-local. Durable
fix: have `addon-control.mjs` ensure that key when starting browser-use, or ship a template.

Goal: start/stop the companion apps from inside the Pi web UI, with optional
auto-start when the stack comes up.

Verified constraints (read, not assumed):
- Web plugins live in `.pi/web-plugins/<id>/` (manifest.json + index.mjs +
  client/entry.mjs). Surfaces proven by agent-models: chat-bar chip, right-panel
  tab, `/slash` command, `GET /plugins-api/<id>/state`.
- The plugin SDK exposes permissions ui / fs:read / fs:write / http / view /
  dom:anchor / llm only — **no process-spawn capability**. A plugin cannot start
  a service on its own.
- The repo's established privileged-action pattern is **web plugin (UI) + Pi
  extension (executes)** — exactly how agent-switcher.ts works.
- A complete lifecycle engine already exists but is unreachable:
  `lib/plugin-manager.mjs` (registry, manifests with
  start_command/port/visible_window/default_enabled/dependencies,
  enable/disable/toggle, start/stop, skip-if-alive by PID+port, visible-window
  start, default-enabled collection). Rescue it instead of writing new.
- Add-on prerequisites verified on disk: `code/glitch-trader` has
  `engine/main.py` + `engine/.venv/Scripts/python.exe`; `code/glitch-money`
  exists; browser-use is Playwright + Chromium on :4105, headless by default,
  and **nothing starts it today**.

Design:
1. `lib/addon-manager.mjs` — ported plugin-manager. Registry `data/addons.json`
   (machine-local, like the launch prefs). Manifests: keep
   `plugins/browser-use/manifest.json`; add entries for money (4110) and trader
   (api 4120, web 3000, python engine).
2. `lib/start-window.mjs` — `startVisibleWindow` extracted from server-mode.mjs,
   so add-ons keep a visible-window option without the dead opencode code.
3. `.pi/web-plugins/addons/` — the control panel: right-panel tab listing each
   add-on with UP/DOWN (port probe), Start/Stop, an auto-start toggle, and a link
   to the add-on's own UI; plus `/addons` and `GET /plugins-api/addons/state`.
4. `.pi/extensions/addon-controller.ts` — the privileged half: runs
   `node scripts/addon-control.mjs <start|stop|status> <name>` (spawn rights) and
   on session start starts the auto-start list (mirroring tunnel-keeper's
   contract: sub-agents skip, fire-and-forget, never throw).

Open design questions: browser headless vs visible on the host; persistence of
logins/cookies; per-add-on auto-start defaults; whether the panel may stop a
service a live session is using.

## Files to Change (summary)

Phase 1: ~35 deletions + SCRIPT_MAP cleanup in launch-unified.mjs.
Phase 2: launch-pi.mjs (G1), lib/git-sync.mjs (G2), launch-unified.mjs (G3, G4
caller), new scripts/janitor.mjs (G4), new scripts/bootstrap-pi.ps1 + root
wrappers (G5).
Phase 3: launch-unified.mjs rewrite, launch-pi.mjs accepts forwarded interface
choice.

## Risks & Mitigations (global)

- Multi-session hazard: another session's plan owns data/plans/current-plan.md
  and a session-scoped plan-ownership fix is in flight. Mitigation: this plan
  lives in docs/ (durable), execution happens in its own session with its own
  plan file, and no step here touches another session's files.
- Killing live tunnel/stack during testing: stack scripts are skip-if-alive
  and stop-pi-stack only kills port-holders; verification uses -Status and a
  scratch port set (-WebPort/-AuthPort) where possible.
- Deleting something Troy actually uses: Phase 0 decisions + per-file grep
  protocol + git history as the safety net.

## Verification (end state)

1. Fresh-clone simulation (G5): only bootstrap-pi.ps1 runs; result launches Pi.
2. TUI launch: banner, prefs honored, gitnexus + skills sync lines in log.
3. Web launch: windowed stack, banner with credentials, tunnel UP, remote
   401/403 verified, stop-pi-stack cleanly stops all three layers.
4. `--stack-only`, `-Status`, `stop`, tunnel-keeper session-start: all behave.
5. **Restart chain** (NP10/NP11) [REV 09-26]: `restart-pi-stack.ps1` with no
   continuation frees both ports, relaunches the full chain, sees HTTP 200, and
   exits 0. With `-ContinuePath <session.jsonl> -ContinueText "continue"` the
   conversation resumes in the restarted stack. With `GLITCH_REUSE_SAVED=1` no
   prompt ever appears and the saved interface/stack mode is used.
6. Store check [REV 09-26]: after an explicit (non-reuse) launch,
   `data/launch-preference.json` exists carrying last_mode + last_pi_mode +
   pi_stack_mode, and the legacy `user/` file is no longer written.
7. Deletion safety (Phase 1) [REV 09-26]: for every deleted file, the recorded
   classification (library vs tool) + grep output is in the commit message.
5. `git grep opencode` across scripts/ returns only historical notes in docs/.
