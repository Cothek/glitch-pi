# stack-servers — pi-web-ui plugin

Registers the two long-lived stack servers as entries in the pi-web-ui
**Background tasks panel** so each one can be shut down manually from the web
UI. The panel only auto-detects servers an agent launches inside a bash call;
these are started by the launcher outside any session, so they need explicit
registration (same reason the separate `cloudflare-tunnel` plugin exists for
the tunnel).

## Entries

| Entry | Stop button does | Start button does |
| --- | --- | --- |
| `Auth proxy :4103 (PID N)` | `taskkill` the proxy process tree — remote access through the tunnel returns errors until it is restarted | starts the proxy again via `scripts/start-detached.ps1` (writes the same `auth-proxy-pi` logs as the launcher) |
| `Glitch web UI :8787 - stack root (Stop = full stack)` | spawns `scripts/stop-stack-servers.ps1` (auth proxy + tunnel) and then exits the pi-web-ui host itself — the whole stack goes down | never offered — this plugin (and the panel) die with the host; relaunch via the launcher |

The root stop is a full-stack stop on purpose: killing only the web UI would
leave the tunnel pointing at a dead origin. It does **not** run
`stop-pi-stack.ps1`, because that script tree-kills the pi-web-ui listener and
a stop script spawned from inside the host is a descendant of it — the tree
kill would end the script mid-run. So the helper stops everything *except* the
host, and the plugin exits the host process itself. Two button presses on the
auth entry (stop, then start) act as a restart.

## Spawn note

The helper spawns deliberately avoid Node's `detached: true`: under this host
that flag made `powershell.exe` a silent no-op (exit 0, no output, no side
effects) on Windows. Persistence is provided inside `start-detached.ps1`
(`CREATE_BREAKAWAY_FROM_JOB`), so the spawns stay attached and `unref()`'d.

`gitnexus-sync` is deliberately not registered: it is a transient one-shot
index refresh that exits within seconds, not a server.

## Install / update

Source of truth is this folder. The live location
(`~/.pi-web/plugins/stack-servers`) is a directory junction created by:

```
node scripts/install-pi-web-plugins.mjs
```

Reload into a running pi-web-ui without a restart:

```
node scripts/pi-plugin-reload.mjs stack-servers 8787
```
