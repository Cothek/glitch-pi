/**
 * stack-servers — pi-web-ui plugin.
 *
 * Source of truth lives HERE (repo: scripts/pi-web-plugins/stack-servers/).
 * The live location (~/.pi-web/plugins/stack-servers) is a junction to this
 * folder, created by scripts/install-pi-web-plugins.mjs — edit here only.
 *
 * Registers the two long-lived stack servers the Background tasks panel cannot
 * see on its own (it only auto-detects servers an agent launches inside a bash
 * call; these are started by the launcher outside any session):
 *
 *   Auth proxy :4103  — UP: label shows PID, panel button stops it (taskkill).
 *                       DOWN: label says down, panel button starts it again
 *                       through start-detached.ps1 (auth-proxy-pi logs).
 *                       Stop then start = restart, same contract as the
 *                       cloudflare-tunnel plugin.
 *
 *   Glitch web UI :8787 (stack root) — only registered while the port is up.
 *                       Stop takes down the whole stack in two safe halves:
 *                       this plugin spawns scripts/stop-stack-servers.ps1
 *                       (auth proxy + tunnel) and then exits the host process
 *                       itself. It MUST NOT use stop-pi-stack.ps1 for that:
 *                       that script tree-kills the pi-web-ui listener, and a
 *                       stop script spawned from inside the host is itself a
 *                       descendant of it, so the tree kill would end the
 *                       script mid-run.
 *
 * SPAWN NOTE (why no `detached: true`): spawning powershell.exe with
 * `detached: true` under this host silently produces nothing at all — exit 0,
 * no output, no side effects (reproduced three ways). The persistence that
 * detached was meant to buy is already provided inside start-detached.ps1
 * (CREATE_BREAKAWAY_FROM_JOB), so these spawns stay attached + unref'd.
 *
 * gitnexus-sync is intentionally NOT registered: it is a transient one-shot
 * index refresh that exits on its own within seconds, not a server.
 */
import { execFile, spawn } from "node:child_process";
import { join } from "node:path";

// Root resolution — single source of truth (honors GLITCH_PI_ROOT first).
import { glitchRoot } from "../../../.pi/lib/root.mjs";

const ROOT = glitchRoot();
const WEB_PORT = Number(process.env.GLITCH_PI_WEBUI_PORT ?? 8787);
const AUTH_PORT = Number(process.env.GLITCH_PI_AUTH_PORT ?? 4103);
const POLL_MS = 15_000;
const AUTH_TASK_ID = "auth-proxy";
const ROOT_TASK_ID = "pi-stack-root";
// Delay before the host exits itself on a root stop: long enough for the panel
// ack (and the spawned stop helper's first kill) to go out first.
const ROOT_EXIT_DELAY_MS = 1500;

// ---------------------------------------------------------------------------
// Pure helpers (named exports so index.test.mjs can import them without a
// host, network, or spawned process).

/**
 * Parse one netstat -ano dump and return the deduped listening PIDs for the
 * given port. Lines look like:
 *   TCP    0.0.0.0:8787    0.0.0.0:0    LISTENING    1234
 * Matching rule: the port token is `:NNN` followed by whitespace, and the
 * line contains LISTENING. Same contract as restart-stack's helper.
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

/** Panel label for the auth proxy given its listener PIDs (empty = down). */
export function authLabel(pids) {
  const pid = Array.isArray(pids) && pids.length > 0 ? pids[0] : null;
  return pid
    ? `Auth proxy :${AUTH_PORT} (PID ${pid})`
    : `Auth proxy :${AUTH_PORT} (down)`;
}

/** Panel status for the auth proxy: "running" while it owns its port. */
export function authStatus(pids) {
  return Array.isArray(pids) && pids.length > 0 ? "running" : "stopped";
}

/** Panel label for the stack root (pi-web-ui itself). */
export function rootLabel() {
  return `Glitch web UI :${WEB_PORT} - stack root (Stop = full stack)`;
}

/**
 * Build the -Command string start-detached.ps1 expects for the auth proxy.
 * Mirrors the invocation in scripts/start-pi-stack.ps1 (quoted node + quoted
 * script path, ports as bare tokens) so the panel restart is identical to a
 * launcher start, writing to the same auth-proxy-pi log files.
 */
export function buildAuthStartCommand({ root, nodeExe, authPort, webPort }) {
  const r = String(root ?? ROOT);
  const node = String(nodeExe ?? process.execPath);
  const auth = join(r, "plugins", "auth-proxy.mjs");
  return `"${node}" "${auth}" ${authPort ?? AUTH_PORT} http://localhost:${webPort ?? WEB_PORT}`;
}

/** Argv for the detached-start helper that brings the auth proxy back up. */
export function buildAuthStartArgs({ root, nodeExe, authPort, webPort } = {}) {
  const r = String(root ?? ROOT);
  return [
    "-NoProfile", "-ExecutionPolicy", "Bypass",
    "-File", join(r, "scripts", "start-detached.ps1"),
    "-Command", buildAuthStartCommand({ root: r, nodeExe, authPort, webPort }),
    "-Name", "auth-proxy-pi",
  ];
}

/** Argv for the helper that stops the servers around pi-web-ui (root stop). */
export function buildRootStopArgs({ root } = {}) {
  const r = String(root ?? ROOT);
  return [
    "-NoProfile", "-ExecutionPolicy", "Bypass",
    "-File", join(r, "scripts", "stop-stack-servers.ps1"),
  ];
}

// ---------------------------------------------------------------------------

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

/**
 * Spawn a helper that must outlive this call. Never `detached: true` here:
 * under this host that flag produced a silent no-op (see the module header).
 * `unref()` is enough — the helper's own breakaway (inside start-detached.ps1)
 * is what keeps the real server alive, and Windows does not kill children when
 * the parent exits normally.
 */
function spawnHelper(file, args, { capture = false, onOutput } = {}) {
  const child = spawn(file, args, {
    windowsHide: true,
    stdio: capture ? ["ignore", "pipe", "pipe"] : "ignore",
  });
  if (capture) {
    let out = "";
    let err = "";
    child.stdout?.on("data", (d) => { out += String(d); });
    child.stderr?.on("data", (d) => { err += String(d); });
    child.on("exit", (code) => onOutput?.({ code, out, err }));
  } else {
    child.on("error", () => { /* best-effort; the next poll reports the truth */ });
  }
  child.unref();
  return child;
}

function killTree(pid) {
  return new Promise((resolveP) => {
    execFile(
      "taskkill",
      ["/PID", String(pid), "/T", "/F"],
      { windowsHide: true },
      () => resolveP(),
    );
  });
}

export default {
  activate(host) {
    let authReg = null;
    let rootReg = null;
    let timer = null;
    let inFlight = false;
    host.log?.("info", "[stack-servers] activated");

    function startAuthProxy() {
      spawnHelper("powershell.exe", buildAuthStartArgs({ root: ROOT, nodeExe: process.execPath }), {
        capture: true,
        onOutput: ({ code, err }) => {
          if (code !== 0) {
            host.log?.("warn", `[stack-servers] auth proxy start helper exited ${code}: ${err.slice(0, 300)}`);
          }
        },
      });
    }

    async function refresh() {
      if (inFlight) return; // a slow netstat must not stack up polls
      inFlight = true;
      try {
        const net = await readNetstat();

        // ---- Auth proxy :4103 (stop/start toggle) ----
        const authPids = parseNetstatPids(net, AUTH_PORT);
        const authUp = authPids.length > 0;
        const aLabel = authLabel(authPids);
        const aStatus = authStatus(authPids);
        const authStop = async () => {
          // Null the handle FIRST: the host deletes this entry right after
          // stop() returns, and a stale handle's update() then no-ops
          // silently (the cloudflare-tunnel lesson). Dropping the handle
          // makes the next poll re-register with the fresh state.
          authReg = null;
          // Re-read the LIVE state at press time. The host's update() only
          // refreshes label/status - the stop callback stays the one captured
          // at registration, so a "(down)" label can sit on an entry whose
          // captured snapshot still says the proxy was up (and the other way
          // round). Trusting the snapshot pressed "start" and killed a dead
          // PID instead (found live). Netstat is the truth.
          const fresh = parseNetstatPids(await readNetstat(), AUTH_PORT);
          if (fresh.length > 0) {
            await killTree(fresh[0]);
          } else {
            startAuthProxy();
          }
        };
        if (authReg) authReg.update({ label: aLabel, status: aStatus });
        else authReg = host.registerBackgroundTask({ id: AUTH_TASK_ID, label: aLabel, status: aStatus, stop: authStop });

        // ---- Stack root :8787 (registered only while up) ----
        const webPids = parseNetstatPids(net, WEB_PORT);
        if (webPids.length > 0) {
          const rLabel = rootLabel();
          const rStatus = "running";
          const rootStop = async () => {
            rootReg = null;
            // 1. Stop the servers around the host from a helper process.
            spawnHelper("powershell.exe", buildRootStopArgs({ root: ROOT }));
            // 2. Then exit the host itself, so the whole stack is down. The
            //    delay lets the panel ack this press before the connection
            //    drops (the entry is already removed by the host).
            setTimeout(() => process.exit(0), ROOT_EXIT_DELAY_MS);
          };
          if (rootReg) rootReg.update({ label: rLabel, status: rStatus });
          else rootReg = host.registerBackgroundTask({ id: ROOT_TASK_ID, label: rLabel, status: rStatus, stop: rootStop });
        } else if (rootReg) {
          // Port went away without our button (crash, external stop):
          // stop advertising a stop button for a dead host.
          rootReg?.unregister?.();
          rootReg = null;
        }
      } finally {
        inFlight = false;
      }
    }

    void refresh();
    timer = setInterval(() => void refresh(), POLL_MS);
    timer.unref?.();

    return () => {
      if (timer) clearInterval(timer);
      timer = null;
      authReg?.unregister?.();
      rootReg?.unregister?.();
      authReg = null;
      rootReg = null;
    };
  },
};
