/**
 * cloudflare-tunnel — pi-web-ui plugin.
 *
 * Source of truth lives HERE (repo: scripts/pi-web-plugins/cloudflare-tunnel/).
 * The live location (~/.pi-web/plugins/cloudflare-tunnel) is a junction to this
 * folder, created by scripts/install-pi-web-plugins.mjs — edit here only.
 *
 * The Background tasks panel normally only notices processes that open a NEW
 * listening TCP port right after an AI bash call. cloudflared listens on
 * nothing locally and is started outside the AI session, so this plugin
 * registers it explicitly via host.registerBackgroundTask:
 *
 *   Tunnel UP   → label shows PID,  panel button stops it (tunnel.mjs stop)
 *   Tunnel DOWN → label says down,  panel button starts it (tunnel.mjs start)
 *
 * The host removes a task entry after its button is pressed, so the 15s poll
 * re-registers the entry with the fresh state. Stop then start = restart.
 */
import { execFile } from "node:child_process";
import { join } from "node:path";

// Root resolution — single source of truth (honors GLITCH_PI_ROOT first).
import { glitchRoot } from "../../../.pi/lib/root.mjs";

const ROOT = glitchRoot();
const TUNNEL_SCRIPT = join(ROOT, "scripts", "lib", "tunnel.mjs");
const POLL_MS = 15_000;
const TASK_ID = "cloudflare-tunnel";

function tunnelVerb(verb) {
  return new Promise((res) => {
    execFile(
      process.execPath,
      [TUNNEL_SCRIPT, verb],
      { timeout: 20_000, windowsHide: true },
      (err, stdout) => res({ ok: !err, out: String(stdout || "").trim() }),
    );
  });
}

async function tunnelState() {
  // status prints "cloudflared: UP (PID 12504, started by this stack)" / "DOWN".
  const r = await tunnelVerb("status");
  const up = /^cloudflared:\s*UP/i.test(r.out);
  const pidMatch = r.out.match(/PID (\d+)/);
  return { up, pid: pidMatch ? pidMatch[1] : null };
}

export default {
  activate(host) {
    let reg = null;
    let timer = null;
    host.log?.("info", "[cloudflare-tunnel] activated");

    async function refresh() {
      const s = await tunnelState();
      const label = s.up
        ? `Cloudflare tunnel (PID ${s.pid ?? "?"})`
        : "Cloudflare tunnel (down)";
      const status = s.up ? "running" : "stopped";
      const stop = async () => {
        // The host deletes this entry right after stop() returns, and the stale
        // handle's update() then no-ops silently. Drop the handle first so the
        // next poll re-registers the entry with the new state
        // (up -> down, down -> up).
        reg = null;
        // Re-read the LIVE state at press time: the host's update() refreshes
        // only the label, so a "(down)" label can sit on a stop callback that
        // still carries an up-snapshot (and the reverse). The button must act
        // on the tunnel's real state, not on the last poll's snapshot.
        const fresh = await tunnelState();
        await tunnelVerb(fresh.up ? "stop" : "start");
      };
      if (reg) reg.update({ label, status });
      else reg = host.registerBackgroundTask({ id: TASK_ID, label, status, stop });
    }

    void refresh();
    timer = setInterval(() => void refresh(), POLL_MS);
    timer.unref?.();

    return () => {
      if (timer) clearInterval(timer);
      timer = null;
      reg?.unregister?.();
      reg = null;
    };
  },
};
