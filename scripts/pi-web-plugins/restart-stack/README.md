# restart-stack

Restart the Glitch web stack (pi-web-ui on :8787 + auth-proxy on :4103) from
the web UI, or trigger it from an agent shell call.

## Surfaces

- Right-panel "Restart Stack" tab: status (PID + listening state per port) and
  one button. The button is always a plain restart, never a resume.
- `GET  /plugins-api/restart-stack/state`     netstat snapshot of both ports.
- `POST /plugins-api/restart-stack/restart`   fire a plain restart. The body
  is `{}` (a small `delay_seconds` is the only accepted field).
- Slash command `/restart-stack [resume] [note]` for the agent terminal.

## HTTP route refuses resume, session, and note

The HTTP route accepts ONLY `delay_seconds`. Any body that carries
`resume`, `session`, or `note` is refused with HTTP 400 and a clear
message. The same `body.session` value used to land inside the generated
.cmd file as a raw double-quoted token, so a `"` from a LAN host would
close the quote and inject arbitrary commands (cmd.exe parsed the rest).
Cutting the surface at the boundary kills the LAN-reachable injection
path. Resume is the CLI's job or the slash command's job — both paths are
local and run under an authenticated agent shell, not an open HTTP route.

```
curl -s -X POST -H "Content-Type: application/json" \
  -d '{"resume":true,"session":"C:/x.jsonl"}' \
  http://localhost:8787/plugins-api/restart-stack/restart
# -> 400 {"ok":false,"error":"resume, session, and note are CLI and slash-command only; HTTP route is plain restart"}
```

## Origin and Content-Type rules on the POST

The POST route enforces two extra gates before the body is read:

1. **Content-Type must be `application/json`.** A cross-origin browser
   POST with a non-JSON content-type is a "simple request" that skips
   CORS preflight, so `express.json` leaves `req.body` as `{}` and the
   handler still fires. Refusing non-JSON turns every cross-site attempt
   into a preflighted request this server never blesses. Failure →
   HTTP 415. No CORS header is emitted on purpose.
2. **Origin header must match the request Host** (same hostname AND port,
   matching the host's WebSocket `originAllowed` rule). Missing Origin
   is allowed (curl, scripts, the agent shell). A literal Origin of
   `"null"` is refused (sandboxed iframe, `file://` pages). Failure →
   HTTP 403.

## Agent path

The CLI and the slash command are the only paths that carry `resume`,
`session`, and `note`. Both routes pass the same `--session` /
`--session-id` value through `isSafeSessionValue`, which rejects any
value containing `" % ^ & | < >` plus CR / LF, and any empty value. The
session file must also exist on disk (`existsSync`) before the launcher
emits the inner command.

```
node scripts/restart-request.mjs --resume --note "..." --session C:/.../abc.jsonl
/restart-stack resume continue with the previous task
```

## Exposure note

The plugin process listens on :8787, which pi-web-ui binds to `0.0.0.0`
with no auth while `PI_WEB_TOKEN` is unset. That means every check in
this file (Origin, Content-Type, body shape) is the entire hardening at
this layer: there is no token, no login, no CORS response header. For
LAN or tunnel exposure, the host's own `PI_WEB_TOKEN` support is the
recommended hardening — that gate sits in front of every
`/plugins-api/*` request via `plugins/auth-proxy.mjs` and is the
right place to lock the surface down. This README does NOT add a token
or a CORS header; the Origin and Content-Type checks are the only
defense this plugin owns.

## Resume rule (UI)

The button never resumes. A user has no safe way to compose a continuation
prompt in a button click, and a stray resume field would inject text into
whichever conversation `PI_SESSION_FILE` happens to name — the wrong default.
Agents that want a resume use the CLI or the slash command and pass the
session file explicitly:

```
node scripts/restart-request.mjs --resume --note "..."
```

`PI_SESSION_FILE` makes the agent path reliable: the pi engine exports it
into every bash tool child. mtime is NOT used to identify the session; two
files in the same project carry identical mtimes, so the only safe
identifiers are `--session <path>` and the env var.

## Pending window

Both the HTTP route and the slash command share the same in-memory
pending window. A second restart inside that window returns
"a restart is already in flight" instead of racing the first kill. The
window is `PENDING_MS = 240_000` (4 minutes: kill + relaunch + 60s health
window + a buffer).

## Auth

Every `/plugins-api/*` request passes through `plugins/auth-proxy.mjs`,
which gates every non-`/__auth/` path. The new route inherits the login
gate for free; no extra wiring is needed. With `PI_WEB_TOKEN` unset, that
gate is open, which is why this README's Exposure section exists.

## Test commands

```
node --check scripts/restart-request.mjs
node --check scripts/pi-web-plugins/restart-stack/index.mjs
node --check scripts/pi-web-plugins/restart-stack/client/entry.mjs

node scripts/pi-web-plugins/restart-stack/index.test.mjs
node scripts/test/test-restart-request.mjs

node scripts/restart-request.mjs --dry-run --json
env -u PI_SESSION_FILE node scripts/restart-request.mjs --dry-run --resume
```