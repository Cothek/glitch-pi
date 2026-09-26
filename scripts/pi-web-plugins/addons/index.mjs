/**
 * addons — pi-web-ui plugin (server entry).
 *
 * Source of truth lives HERE (repo: scripts/pi-web-plugins/addons/).
 * The live location (~/.pi-web/plugins/addons) is a junction to this folder,
 * created by scripts/install-pi-web-plugins.mjs — edit here only.
 *
 * Surfaces:
 *   1. A "Background tasks" panel entry per RUNNING add-on with a stop button.
 *   2. HTTP routes under /plugins-api/addons/* for an external UI to start/stop
 *      and toggle auto-start flags.
 *   3. Slash command "/addons" that prints a table of every add-on (down +
 *      autostart flags + ports). "/addons start money" works too.
 *   4. On activate: runs `start-auto` so anything marked auto-start actually
 *      starts with the stack.
 *
 * MECHANICS: every server-side action delegates to scripts/addon-control.mjs
 * (the single lifecycle owner). That script is the SOLE place that knows the
 * PID file / log file layout — the plugin just shells out via execFile.
 */
import { execFile } from "node:child_process";
import { join } from "node:path";

const ROOT = process.env.GLITCH_PI_ROOT || "E:\\Glitch AI\\glitch-pi";
const CONTROL = join(ROOT, "scripts", "addon-control.mjs");
const POLL_MS = 15_000;
const TASK_PREFIX = "addon-";

/** Run scripts/addon-control.mjs with the given args, parse its JSON, never throw. */
function runControl(args, timeoutMs = 20_000) {
  return new Promise((resolveP) => {
    execFile(
      process.execPath,
      [CONTROL, ...args, "--json"],
      { timeout: timeoutMs, windowsHide: true, maxBuffer: 4 * 1024 * 1024 },
      (err, stdout) => {
        const text = String(stdout || "").trim();
        if (!text) return resolveP(null);
        try {
          return resolveP(JSON.parse(text));
        } catch {
          return resolveP(null);
        }
      },
    );
  });
}

function json(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(body);
}

async function readState() {
  const arr = await runControl(["status", "all"]);
  if (!Array.isArray(arr)) return { addons: [] };
  return { addons: arr };
}

export default {
  activate(host) {
    /** add-on id -> BackgroundTask handle (null while we don't hold one). */
    const tasks = new Map();
    let timer = null;
    const cleanup = [];

    host.log?.("info", "[addons] activated");

    /** Poll: refresh state, register/update tasks for every RUNNING add-on. */
    async function refresh() {
      const { addons } = await readState();
      const seen = new Set();
      for (const a of addons) {
        seen.add(a.id);
        if (!a.up) {
          // Down: drop any stale task entry.
          const t = tasks.get(a.id);
          if (t) {
            try { t.unregister?.(); } catch { /* ignore */ }
            tasks.delete(a.id);
          }
          continue;
        }
        const taskId = TASK_PREFIX + a.id;
        const label = `${a.label} (PID ${a.pid ?? "?"})`;
        const stopFn = async () => {
          // The host deletes this entry right after stop() returns, and the stale
          // handle's update() then no-ops silently. Drop the handle BEFORE calling
          // stop so the next poll re-registers the entry with the new state
          // (running -> stopped). Two presses therefore = stop + start.
          const t = tasks.get(a.id);
          tasks.delete(a.id);
          try { t?.unregister?.(); } catch { /* ignore */ }
          await runControl(["stop", a.id], 25_000);
        };
        const existing = tasks.get(a.id);
        if (existing) {
          try { existing.update({ label, status: "running" }); } catch { /* ignore */ }
        } else {
          const reg = host.registerBackgroundTask({
            id: taskId,
            label,
            status: "running",
            stop: stopFn,
          });
          tasks.set(a.id, reg);
        }
      }
      // catch the case where an add-on disappeared from the registry entirely
      for (const [id, t] of tasks) {
        if (!seen.has(id)) {
          try { t.unregister?.(); } catch { /* ignore */ }
          tasks.delete(id);
        }
      }
    }

    void refresh();
    timer = setInterval(() => void refresh(), POLL_MS);
    timer.unref?.();

    // HTTP routes — the panel (or any external UI) drives state from here.
    cleanup.push(
      host.route("GET", "/state", async (_req, res) => {
        try {
          const state = await readState();
          json(res, 200, state);
        } catch (err) {
          json(res, 500, { ok: false, error: err?.message ?? String(err) });
        }
      }),
    );
    cleanup.push(
      host.route("POST", "/start", async (req, res) => {
        // express.json parses the body; same caveat as agent-switcher: do NOT
        // try req.on('data')/('end') here.
        const id = String(req?.body?.id ?? "").trim();
        if (!id) return json(res, 400, { ok: false, error: "missing id" });
        const r = await runControl(["start", id], 25_000);
        if (!r) return json(res, 500, { ok: false, error: "addon-control.mjs produced no output" });
        return json(res, r.ok ? 200 : 400, r);
      }),
    );
    cleanup.push(
      host.route("POST", "/stop", async (req, res) => {
        const id = String(req?.body?.id ?? "").trim();
        if (!id) return json(res, 400, { ok: false, error: "missing id" });
        const r = await runControl(["stop", id], 25_000);
        if (!r) return json(res, 500, { ok: false, error: "addon-control.mjs produced no output" });
        return json(res, r.ok ? 200 : 400, r);
      }),
    );
    cleanup.push(
      host.route("POST", "/autostart", async (req, res) => {
        const id = String(req?.body?.id ?? "").trim();
        const on = req?.body?.on;
        if (!id) return json(res, 400, { ok: false, error: "missing id" });
        const onWord = on ? "on" : "off";
        const r = await runControl(["autostart", id, onWord]);
        if (!r) return json(res, 500, { ok: false, error: "addon-control.mjs produced no output" });
        return json(res, r.ok ? 200 : 400, r);
      }),
    );

    // Slash command — runs server-side, no client needed.
    cleanup.push(
      host.registerCommand({
        name: "addons",
        description: "List / start / stop companion add-ons and toggle auto-start",
        argumentHint: "[status|start|stop|autostart] [id] [on|off]",
        async run(args) {
          const parts = String(args ?? "").trim().split(/\s+/).filter(Boolean);
          const verb = parts[0];
          if (!verb || verb === "status" || verb === "list") {
            const { addons } = await readState();
            if (!addons.length) return "(no add-ons registered)";
            const rows = addons.map((a) => {
              const portList = a.ports?.map((p) => `${p.port}${p.listening ? " (UP)" : ""}`).join(", ") ?? "";
              return `${a.up ? "UP  " : "DOWN"}  ${a.id.padEnd(12)} ${a.label.padEnd(20)} ${portList}  autostart=${a.autostart ? "on" : "off"}`;
            });
            return ["Add-ons:", ...rows].join("\n");
          }
          if (verb === "start" || verb === "stop") {
            const id = parts[1];
            if (!id) return `usage: /addons ${verb} <id>`;
            const r = await runControl([verb, id], 25_000);
            return r ? JSON.stringify(r) : "(no response from addon-control.mjs)";
          }
          if (verb === "autostart") {
            const id = parts[1];
            const on = parts[2];
            if (!id || !on) return "usage: /addons autostart <id> <on|off>";
            const r = await runControl(["autostart", id, on]);
            return r ? JSON.stringify(r) : "(no response from addon-control.mjs)";
          }
          if (verb === "start-auto") {
            const r = await runControl(["start-auto"], 60_000);
            return r ? JSON.stringify(r) : "(no response from addon-control.mjs)";
          }
          return `unknown verb "${verb}". usage: /addons [status|start|stop|autostart|start-auto] [...]`;
        },
      }),
    );

    // Run start-auto on activate — this is what makes auto-start real.
    void (async () => {
      try {
        const r = await runControl(["start-auto"], 60_000);
        if (r && (r.started?.length || r.skipped?.length)) {
          host.log?.(
            "info",
            `[addons] start-auto: started=${JSON.stringify(r.started)} skipped=${JSON.stringify(r.skipped)}`,
          );
        } else {
          host.log?.("info", "[addons] start-auto: nothing to start");
        }
      } catch (err) {
        host.log?.("warn", `[addons] start-auto failed: ${err?.message ?? err}`);
      }
    })();

    return () => {
      if (timer) clearInterval(timer);
      timer = null;
      for (const t of tasks.values()) {
        try { t.unregister?.(); } catch { /* ignore */ }
      }
      tasks.clear();
      for (const off of cleanup) {
        try { off?.(); } catch { /* ignore */ }
      }
    };
  },
};
