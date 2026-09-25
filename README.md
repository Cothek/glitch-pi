# Glitch AI

Portable AI companion environment — one clone, one setup, Glitch is ready on Windows, Mac, or Linux.

## Quick Start

### Windows

```powershell
git clone https://github.com/Cothek/glitch-ai.git
cd glitch-ai
.\scripts\setup.ps1            # First-time: init engine + profile wizard
.\launch-glitch.bat            # Start using Glitch
```

Or use the Node.js launcher (works on all platforms):
```powershell
node scripts\launch.mjs        # Cross-platform launcher
```

### Mac / Linux

```bash
# Option 1: Install script (recommended) — auto-clones, sets up user profile, launches
curl -sL https://raw.githubusercontent.com/Cothek/glitch-ai/main/scripts/install.sh | bash

# Option 2: Manual
git clone https://github.com/Cothek/glitch-ai.git
cd glitch-ai
git submodule update --init --recursive
./launch-glitch.sh             # Auto-bootstraps Node.js if not found
```

### For Troy (Returning User, cross-platform)

```bash
git clone https://github.com/Cothek/glitch-ai.git
cd glitch-ai
git submodule update --init --recursive
git clone https://cothek@github.com/Cothek/glitch-user-troy.git user/
./launch-glitch.sh
```

> **Note**: The `.sh` scripts auto-bootstrap Node.js if not found (downloads Node.js 22+ for your platform). The `.bat` scripts (Windows) use npm-installed OpenCode — both call the same `.mjs` launcher under the hood.

**If you get a GitHub login pop-up after `git submodule sync`**, the submodule remote got reset. Fix it:

```powershell
cd glitch-memorycore
git remote set-url origin https://cothek@github.com/Cothek/glitch-engine.git
```

## How It Works

Glitch is split into three layers:

| Layer | Repo | Contents |
|-------|------|----------|
| **Engine** | `Cothek/glitch-engine` (public) | Core identity, prompt rules, 23+ skills, plugins, library |
| **User Data** | `Cothek/glitch-user-troy` (private) | Personal memory, diary, decisions, projects, preferences |
| **Launcher** | `Cothek/glitch-ai` (public) | OpenCode binary, launch scripts, config, bootstrap |

### Launch Flow

1. `launch-glitch.bat` (Windows) or `launch-glitch.sh` (Mac/Linux) calls `scripts/launch.mjs`
2. The `.mjs` launcher detects your user profile (`user/main-memory.md` or `user/{name}/main-memory.md`)
3. Generates a runtime `opencode.json` with engine + user instruction paths from the `config/` template
4. Validates the generated config with `JSON.parse()`
5. Starts OpenCode with the generated config
6. On exit, the session ends — config is regenerated fresh on next launch

> **Legacy**: The original `.ps1` scripts still work on Windows for backward compatibility.

## Access from Anywhere (Phone / Other PC)

**Windows:**
```powershell
.\scripts\setup-tunnel.ps1    # One-time: authenticate Cloudflare + create tunnel
.\launch-glitch.bat           # Each session: select server mode (option 4)
```

**Mac / Linux:**
```bash
./scripts/glitch.sh server    # Start server mode with cloudflared tunnel
```

This starts OpenCode as a web server proxied through Cloudflare Tunnel. No open ports, no VPN required. Login with username `opencode` and the auto-generated password shown in the terminal.

Configure your domain via `.env`: copy `.env.example` to `.env` and set `GLITCH_DOMAIN`.

### Pi Web UI (`glitch.cothekdesigns.com`)

Pi web UI mode starts two local layers: `pi-web-ui` on `:8787` and an auth proxy on `:4103` (HTTP Basic auth) that the Cloudflare tunnel points at.

The **login banner prints in the terminal** whenever the stack starts - username, password, local + remote URLs, and a one-click `?auth_token=` link.

Two start modes:

| Mode | Behaviour | Stop it by |
|---|---|---|
| **windowed** (default) | One visible PowerShell window runs the whole stack. `pi-web-ui` runs in that window's foreground, the auth proxy and the Cloudflare tunnel are children on the same console. | Closing the window (or Ctrl+C in it). |
| **headless** | All three layers start detached with `CREATE_NO_WINDOW` and survive closing every shell. | `scripts\stop-pi-stack.ps1` |

The **Cloudflare tunnel** (`glitch.cothekdesigns.com` -> auth proxy `:4103` -> `pi-web-ui :8787`, with `pi.cothekdesigns.com` kept as a legacy alias on the same origin) is part of the stack, not a separate service. It is started once both ports are confirmed bound, and skipped when the auth proxy is down, because a connector with no origin just serves 502s. Windowed mode ties it to the window; detached mode spawns it detached so it outlives the shell. `scripts\stop-pi-stack.ps1` stops it again through `scripts\lib\tunnel.mjs`, which owns the lifecycle: only a tunnel this repo started (recorded in `data\cloudflared-auto.pid`) is ever stopped, and a second start is skipped instead of adding a duplicate connector to the same tunnel (Cloudflare would accept one without complaining). The `tunnel-keeper` Pi extension is the safety net: it re-checks every 5 minutes and restarts the tunnel if it died mid-session.

```powershell
.\scripts\start-pi-stack.ps1                  # detached (survives closing every shell)
.\scripts\start-pi-stack.ps1 -Windowed        # visible window you close to stop
.\scripts\start-pi-stack-window.ps1           # same, opens the window directly
.\scripts\start-pi-stack.ps1 -Status          # check only (web UI, auth proxy, tunnel)
.\scripts\start-pi-stack.ps1 -NoTunnel        # local only, no Cloudflare
.\scripts\stop-pi-stack.ps1                   # stop the stack and its tunnel, either start mode
.\scripts\stop-pi-stack.ps1 -NoTunnel         # stop the stack, leave the tunnel running
```

```bash
node scripts/lib/tunnel.mjs status            # one line, exit 0 when up / 1 when down
node scripts/lib/tunnel.mjs start             # idempotent: skips when already running
node scripts/lib/tunnel.mjs stop              # stops only a tunnel this repo started
```

```bash
node scripts/launch-pi.mjs --web --windowed   # force a visible window (remembered)
node scripts/launch-pi.mjs --web --headless   # force detached (remembered)
node scripts/show-credentials.mjs             # reprint username / password / login URLs
node scripts/set-credentials.mjs              # rotate the password (random)
node scripts/set-credentials.mjs --username troy            # change the login username
node scripts/set-credentials.mjs --password 'a-real-secret' # set a specific password
node scripts/set-credentials.mjs --show                     # current username / whether a password is set
```

**Credentials**: the login is HTTP Basic auth built from two optional, gitignored files at the repo root. `.server-username` holds the username (absent means the `opencode` default) and `.server-password` holds the password (absent means no login is possible). `scripts/set-credentials.mjs` writes either one and restarts the auth proxy, so a change takes effect immediately. The colon is rejected in a username on purpose: Basic auth splits the header on the first colon, so `a:b` would silently authenticate as `a`.

**Sessions are separate from the credentials.** The `glitch_auth` cookie holds a random session id - not the credential - and sessions live in `data/auth-sessions.json` (gitignored, 7-day sliding expiry). So changing the username or password affects **new logins only**: the browser you are using, and any other logged-in device, stay logged in. That is deliberate, because making the cookie *be* the credential is what used to log you out the instant you rotated it. To revoke anyway:

```bash
node scripts/set-credentials.mjs --revoke-sessions   # log out every device (credentials unchanged)
```

The gate also exposes, behind the login itself:

| Route | Purpose |
|---|---|
| `GET /__auth/whoami` | how you authenticated (session / basic / token) |
| `POST /__auth/logout` | revoke the current session |
| `POST /__auth/logout-others` | revoke every other session, keep yours |
| `POST /__auth/logout-all` | revoke every session |

A pre-sessions cookie (one still holding the old `base64(user:pass)` value) is accepted once and upgraded in place, so upgrading does not log anyone out. And a missing or corrupt session store is never a lockout: Basic auth and `?auth_token=` stay independent of it.

Start mode is remembered in `user/launch-preference.json` (`pi_stack_mode`) only when you pass `--windowed` or `--headless`; otherwise a console launch gets a window and a no-console launch (extension, automation) stays detached.

Either mode polls the ports until they really bind, so a slow `pi-web-ui` boot is never reported as a failure.

The password lives in `.server-password` (repo root, gitignored). It is printed to the console only - never written to `data/logs/`.

## Repository Structure

```
glitch-ai/                    ← This repo (public)
├── glitch-memorycore/        ← Submodule: public engine (glitch-engine)
│   ├── core/                 ← Generic Glitch identity (no user data)
│   ├── plugins/glitch-skills/ ← 23 skills + registry
│   ├── library/              ← Knowledge library
│   └── users/_template/      ← New-user profile template
│
├── user/                     ← Your personal data (gitignored / private submodule)
│   ├── main-memory.md        ← Your profile, preferences, history
│   ├── current-session.md    ← Session context
│   ├── daily-diary/          ← Session diary
│   └── projects/             ← Active projects
│
├── scripts/                  ← Launch & utility scripts
│   ├── install.sh            ← Mac/Linux installer (curl | bash)
│   ├── launch.mjs            ← Cross-platform launcher (primary)
│   ├── launch-free.mjs       ← Free mode launcher
│   ├── launch-safe.mjs       ← Safe mode launcher
│   ├── serve.mjs             ← Web server mode
│   ├── glitch.sh             ← Mode switcher (Mac/Linux wrapper)
│   ├── switch-mode.sh        ← Mode switcher (Mac/Linux wrapper)
│   ├── validate-config.mjs   ← Config + syntax validator
│   ├── bootstrap.ps1         ← Windows dependency downloader
│   ├── setup.ps1             ← Windows profile wizard
│   ├── check-updates.ps1     ← Windows update checker
│   ├── check-models.ps1      ← Windows model discovery
│   ├── switch-branch.ps1     ← Windows branch manager
│   ├── switch-model.ps1      ← Windows model selector
│   ├── sync-user.ps1         ← Windows user sync helper
│   ├── fix-paths.mjs         ← SQLite path normalizer
│   └── query-opencode-db.*   ← Session DB query tools
│
├── config/                   ← Configuration files
│   ├── tui.json              ← Terminal UI preferences
│   ├── cloudflared-config.yml← Cloudflare Tunnel config
│   └── query                 ← (internal tool config)
│
├── data/                     ← Auto-generated runtime data (gitignored)
│   ├── update-status.json    ← Dependency check results
│   ├── model-update-status.json
│   ├── skills-lock.json
│   └── screenshots/          ← Vision agent screenshots + generated images
│
├── launch-glitch.bat         ← Unified launcher (Windows) — all modes
├── launch-glitch.sh          ← Unified launcher (Mac/Linux) — all modes
├── opencode.json             ← Engine-only base config
├── .env.example              ← Domain/port configuration template
├── plugins/                  ← Auth proxy, helpers
├── opencode/                 ← OpenCode binary
├── handy-voice/              ← Offline voice-to-text
└── cloudflared.exe           ← Cloudflare Tunnel binary
```

## What's Inside

| Item | Description |
|------|-------------|
| `glitch-memorycore/` | Engine submodule — Glitch identity, rules, skills, plugins |
| `user/` | Your personal memory, diary, projects (gitignored) |
| `scripts/` | Launch, setup, validation, and utility scripts (.mjs cross-platform, .sh for Mac/Linux, .ps1 legacy for Windows) |
| `config/` | Terminal UI config, Cloudflare Tunnel config, providers.json |
| `data/` | Auto-generated status files (gitignored) |
| `launch-glitch.bat` / `.sh` | Unified launcher — all modes (normal, free, local, safe, server) |
| `opencode.json` | Engine-only base config (user data added at runtime) |
| `.env.example` | Domain/port configuration template |
| `handy-voice/` | [Handy](https://handy-voice.org) — offline voice-to-text |
| `opencode/` | [OpenCode](https://opencode.ai) — AI agent runtime |
| `plugins/auth-proxy.mjs` | Basic auth proxy for mobile access |
| `docs/` | Documentation (architecture, user guide, developer guide, configuration) |

## Modifying Config / Launch Scripts

Changes to `opencode.json`, `scripts/launch.mjs`, `scripts/serve.mjs`, `config/` templates, or any launch script require:
1. A review pass (@reviewer) before applying
2. `validate-config.mjs` passing after the change
3. A restart of OpenCode to pick up the new config

This is enforced by **R14** in `glitch-memorycore/prompt-rules.md` (immutable rule).

## Requirements

- **Windows** 10 or 11, **macOS** 13+, or **Linux** (x86_64)
- **Node.js** 22+ (required for the cross-platform launcher)
- **API key** for an LLM provider (configured via OpenCode's `/connect` or env vars)
- **GitHub account** (for cloning)
- **NVIDIA GPU with CUDA** (recommended for Handy speed on Windows)
- **[Cloudflare](https://cloudflare.com)** account (free) — for remote access

> **Windows-only features**: Handy voice input, automatic binary sync from npm. All core features work cross-platform.
