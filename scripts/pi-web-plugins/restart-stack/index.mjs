/**
 * restart-stack — pi-web-ui plugin (server entry).
 *
 * Source of truth lives HERE (repo: scripts/pi-web-plugins/restart-stack/).
 * The live location (~/.pi-web/plugins/restart-stack) is a junction to this
 * folder, created by scripts/install-pi-web-plugins.mjs — edit here only.
 *
 * Surfaces:
 *   1. Right-panel "Restart Stack" tab: status + one button.
 *      The button does a plain restart (no resume, no note). The UI is the
 *      wrong place to ask a user to compose a continuation prompt.
 *   2. GET  /plugins-api/restart-stack/state  -> netstat snapshot.
 *   3. POST /plugins-api/restart-stack/restart -> spawns the launcher
 *      detached and returns immediately. The process answering this request
 *      is the process the restart will kill.
 *   4. Slash command /restart-stack [resume] [note] for the agent terminal.
 *      "resume" is the first whitespace token; the rest becomes the note.
 *
 * No agent tool: the plugin process cannot tell which conversation called it,
 * and there is no reliable id without the caller passing --session itself.
 *
 * State comes from `netstat -ano`. A PID owning a LISTENING port is not proof
 * of a healthy HTTP response, only proof something owns the port — the
 * comment in state() captures that caveat. The client treats a state fetch
 * during the restart window as "stack is down, waiting" not as an error.
 */
import { execFile } from "node:child_process";
import { join } from "node:path";

const ROOT = process.env.GLITCH_PI_ROOT || "E:\\Glitch AI\\glitch-pi";
const REQUEST = join(ROOT, "scripts", "restart-request.mjs");
const WEB_PORT = Number(process.env.GLITCH_PI_WEBUI_PORT ?? 8787);
const AUTH_PORT = Number(process.env.GLITCH_PI_AUTH_PORT ?? 4103);

// 4 minutes covers the kill + relaunch + 60s health window + a buffer.
// A second POST inside this window answers 409 with retryAfterMs.
const PENDING_MS = 240_000;

/**
 * Origin / Host admission for the POST route.
 *
 * Mirrors the host's WebSocket rule in
 * data/node/node_modules/pi-web-ui/dist/server/index.js (originAllowed).
 * The host does NOT apply any Origin check to HTTP routes, so this plugin
 * has to do it itself.
 *
 * Rules:
 *   - missing Origin header → allow (curl, scripts, non-browser clients).
 *   - literal Origin of "null" → refuse (sandboxed iframe, file://, etc.).
 *   - otherwise parse the Origin and allow only when hostname AND port
 *     both equal the request Host header's hostname and port.
 *
 * Pure: no FS, no env, no network. Exported so the test can import it.
 *
 * @param {{host: string|undefined|null, origin: string|undefined|null}} args
 * @returns {boolean}
 */
export function originOk({ host, origin } = {}) {
  if (origin == null || origin === "") return true;
  const o = String(origin).trim().toLowerCase();
  if (o === "null") return false;
  let oHost = "";
  let oPort = "";
  try {
    const u = new URL(o);
    oHost = u.hostname.toLowerCase();
    oPort = u.port;
  } catch {
    return false;
  }
  let rHost = "";
  let rPort = "";
  try {
    const u2 = new URL(`http://${String(host ?? "").toLowerCase()}`);
    rHost = u2.hostname.toLowerCase();
    rPort = u2.port;
  } catch {
    return false;
  }
  return oHost === rHost && oPort === rPort;
}

/**
 * Parse one chunk of `netstat -ano` text and return the deduped listening
 * PIDs for the given port. Lines look like:
 *   TCP    0.0.0.0:8787    0.0.0.0:0    LISTENING    1234
 * Matching rule: the port token is `:NNN` followed by whitespace, and the
 * line contains LISTENING. Pure helper, exported so the test can import it
 * without spinning up the host.
 */
export function parseNetstatPids(text, port) {
  const want = String(port);
  const needle = `:${want} `;
  const out = [];
  const seen = new Set();
  const lines = String(text ?? "").split(/\r?\n/);
  for (const line of lines) {
    if (!line.includes(needle)) continue;
    if (!line.includes("LISTENING")) continue;
    const trimmed = line.trim();
    const parts = trimmed.split(/\s+/);
    const last = parts[parts.length - 1];
    if (/^\d+$/.test(last) && !seen.has(last)) {
      seen.add(last);
      out.push(Number(last));
    }
  }
  return out;
}

function readNetstat() {
  return new Promise((resolveP) => {
    execFile(
      "netstat",
      ["-ano"],
      { timeout: 10_000, windowsHide: true, maxBuffer: 4 * 1024 * 1024 },
      (err, stdout) => {
        if (err) return resolveP("");
        resolveP(String(stdout ?? ""));
      },
    );
  });
}

function json(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(body);
}

function spawnRequest(argv) {
  return new Promise((resolveP) => {
    execFile(
      process.execPath,
      [REQUEST, ...argv],
      { timeout: 20_000, windowsHide: true, maxBuffer: 4 * 1024 * 1024 },
      (err, stdout, stderr) => {
        const text = String(stdout ?? "").trim();
        let parsed = null;
        if (text) {
          try { parsed = JSON.parse(text); } catch { /* leave null */ }
        }
        resolveP({ err, stdout: text, stderr: String(stderr ?? ""), parsed });
      },
    );
  });
}

export default {
  activate(host) {
    const cleanup = [];
    let pendingUntil = 0;
    let lastRestartAt = 0;
    let lastMode = null;
    let lastLogPaths = null;

    host.log?.("info", "[restart-stack] activated");

    async function state() {
      const net = await readNetstat();
      const webPids = parseNetstatPids(net, WEB_PORT);
      const authPids = parseNetstatPids(net, AUTH_PORT);
      const webPid = webPids[0] ?? null;
      const authPid = authPids[0] ?? null;
      const up = webPid != null && authPid != null;
      const now = Date.now();
      const pending = now < pendingUntil;
      const remaining = pending ? Math.max(0, pendingUntil - now) : 0;
      return {
        ok: true,
        up,
        webPort: WEB_PORT,
        webPid,
        authPort: AUTH_PORT,
        authPid,
        pending,
        lastRestartAt,
        lastMode,
        pendingRemainingMs: remaining,
        logPaths: lastLogPaths,
      };
    }

    cleanup.push(
      host.route("GET", "/state", async (_req, res) => {
        try {
          const payload = await state();
          json(res, 200, payload);
        } catch (err) {
          json(res, 500, { ok: false, error: err?.message ?? String(err) });
        }
      }),
    );

    /**
     * Shared "fire a restart" routine used by both the HTTP route and the
     * slash command. The route and the command used to call spawnRequest
     * independently, so a slash-command restart could race a UI restart
     * (M2 in the review). One function, one pending window.
     *
     * Returns:
     *   { ok: true, parsed }   on success; the caller decides the wire format.
     *   { ok: false, error, retryAfterMs? }  on rejection; the route maps
     *     this to 409, the command prints the message verbatim.
     *
     * Sets pendingUntil on success and clears it on spawn / parse failure.
     * `mode` is "plain" or "resume" for the /state snapshot.
     */
    async function fireRestart({ argv, mode }) {
      const now = Date.now();
      if (now < pendingUntil) {
        return {
          ok: false,
          error: "a restart is already in flight",
          retryAfterMs: Math.max(0, pendingUntil - now),
        };
      }
      // Set pending BEFORE the spawn so a concurrent second caller loses the
      // race to the guard above and gets a clean 409.
      pendingUntil = Date.now() + PENDING_MS;
      lastRestartAt = Date.now();
      lastMode = mode;
      try {
        const r = await spawnRequest(argv);
        if (r.err) {
          pendingUntil = 0;
          return {
            ok: false,
            error: r.err?.message ?? String(r.err),
            stderr: r.stderr,
          };
        }
        if (!r.parsed) {
          pendingUntil = 0;
          return {
            ok: false,
            error: "restart-request produced no parseable JSON",
            raw: r.stdout.slice(0, 500),
          };
        }
        if (r.parsed.outLog) {
          lastLogPaths = {
            outLog: r.parsed.outLog,
            errLog: r.parsed.errLog,
            pidFile: r.parsed.pidFile,
          };
        }
        return { ok: true, parsed: r.parsed };
      } catch (err) {
        pendingUntil = 0;
        return { ok: false, error: err?.message ?? String(err) };
      }
    }

    cleanup.push(
      host.route("POST", "/restart", async (req, res) => {
        // The HTTP route is a plain restart only. resume / session / note
        // belong to the CLI and the slash command, because the session
        // string and the note reach a cmd.exe-parsed command verbatim —
        // the H1/H2 injection vector. Refusing them at the boundary kills
        // the LAN-reachable injection path entirely.
        const body = req?.body ?? {};
        const wantsResume = body?.resume === true
          || (typeof body?.session === "string" && body.session.trim() !== "")
          || (typeof body?.note === "string" && body.note !== "");
        if (wantsResume) {
          return json(res, 400, {
            ok: false,
            error: "resume, session, and note are CLI and slash-command only; HTTP route is plain restart",
          });
        }

        // Content-Type gate. A cross-origin browser POST with a non-JSON
        // content-type is a "simple request" that skips CORS preflight, so
        // forcing application/json turns every cross-site attempt into a
        // preflighted request the server never blesses. No CORS header is
        // sent on purpose.
        const ctype = String(req?.headers?.["content-type"] ?? "")
          .split(";")[0]
          .trim()
          .toLowerCase();
        if (ctype !== "application/json") {
          return json(res, 415, {
            ok: false,
            error: "Content-Type must be application/json",
          });
        }

        // Origin gate. Browsers attach an Origin header; non-browser
        // clients (curl, the agent shell) usually do not. See originOk().
        const origin = req?.headers?.origin;
        const hostHeader = req?.headers?.host;
        if (!originOk({ host: hostHeader, origin })) {
          return json(res, 403, {
            ok: false,
            error: "Origin not allowed",
          });
        }

        let delay = Number(body?.delay_seconds);
        if (!Number.isFinite(delay)) delay = 8;
        if (delay < 0) delay = 0;
        if (delay > 120) delay = 120;

        const argv = ["--json", "--delay", String(Math.floor(delay))];
        const result = await fireRestart({ argv, mode: "plain" });
        if (!result.ok) {
          if (result.retryAfterMs != null) {
            return json(res, 409, {
              ok: false,
              error: result.error,
              retryAfterMs: result.retryAfterMs,
            });
          }
          return json(res, 500, {
            ok: false,
            error: result.error,
            stderr: result.stderr,
            raw: result.raw,
          });
        }
        // Reply immediately. The process answering this request is the
        // process the restart will kill, so any extra await here is paid
        // for by a half-dead pi-web-ui.
        return json(res, 200, {
          ok: true,
          mode: "plain",
          delaySeconds: Math.floor(delay),
          logPaths: lastLogPaths,
        });
      }),
    );

    cleanup.push(
      host.registerCommand({
        name: "restart-stack",
        description: "Restart the glitch-pi web stack (pi-web-ui and auth proxy)",
        argumentHint: "[resume] [note]",
        async run(args) {
          const text = String(args ?? "").trim();
          const firstSpace = text.indexOf(" ");
          const head = firstSpace === -1 ? text : text.slice(0, firstSpace);
          const tail = firstSpace === -1 ? "" : text.slice(firstSpace + 1).trim();
          const resume = head.toLowerCase() === "resume";
          const argv = ["--json", "--delay", "8"];
          if (resume) {
            argv.push("--resume");
            const session = process.env.PI_SESSION_FILE || "";
            if (!session) {
              return "no session file: set PI_SESSION_FILE or pass --session via the CLI";
            }
            argv.push("--session", session);
            if (tail) argv.push("--note", tail);
          }
          // Slash command shares the same pending window as the HTTP route
          // via fireRestart. A concurrent UI restart blocks the agent path
          // with the same "already in flight" message.
          const result = await fireRestart({ argv, mode: resume ? "resume" : "plain" });
          if (result.ok) {
            const where = result.parsed.outLog ? ` log=${result.parsed.outLog}` : "";
            return `restart queued${resume ? " (resume)" : ""} delay=${result.parsed.delaySeconds}s pid=${result.parsed.pid ?? "?"}${where}`;
          }
          return `restart failed: ${result.error ?? "unknown"}`;
        },
      }),
    );

    return () => {
      for (const off of cleanup) {
        try { off?.(); } catch { /* ignore */ }
      }
    };
  },
};
