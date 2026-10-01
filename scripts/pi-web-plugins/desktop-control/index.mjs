#!/usr/bin/env node
/**
 * desktop-control — pi-web-ui plugin (server entry).
 *
 * Source of truth lives HERE (repo: scripts/pi-web-plugins/desktop-control/).
 * The live location (~/.pi-web/plugins/desktop-control) is a junction to this
 * folder, created by scripts/install-pi-web-plugins.mjs — edit here only.
 *
 * What it does:
 *   - Toggle the cua-driver daemon on/off (flag: <glitch-pi>/data/config/
 *     desktop-control.json — the SAME file launch-unified.mjs reads on every
 *     launch and stack restart, so the UI toggle is the only switch needed).
 *   - Start/stop the daemon process immediately when toggled.
 *   - Register agent tool `desktop_screenshot`: runs scripts/capture-desktop.ps1
 *     (window-composited desktop capture; works over RDP where
 *     get_desktop_state fails with 0x80070006).
 *
 * Surfaces:
 *   GET  /plugins-api/desktop-control/state  -> {installed, enabled, mcpWired, daemonRunning}
 *   POST /plugins-api/desktop-control/toggle {enabled: bool}
 *
 * Origin discipline mirrors restart-stack: POSTs require
 * Content-Type: application/json and an allowed Origin.
 */
import { execFile, spawn } from "node:child_process";
import { openSync, closeSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

const ROOT = process.env.GLITCH_PI_ROOT || "E:\\Glitch AI\\glitch-pi";
const CONFIG_PATH = join(ROOT, "data", "config", "desktop-control.json");
const CAPTURE_PS1 = join(ROOT, "scripts", "capture-desktop.ps1");
const CUA_BIN = process.env.CUA_DRIVER_BIN ||
  join(process.env.LOCALAPPDATA || join(homedir(), "AppData", "Local"),
    "Programs", "Cua", "cua-driver", "bin", "cua-driver.exe");
const MCP_JSON = join(homedir(), ".pi", "agent", "mcp.json");
const LOGS = join(ROOT, "data", "logs");

function readConfig() {
  try {
    if (!existsSync(CONFIG_PATH)) return { enabled: false, present: false };
    const j = JSON.parse(readFileSync(CONFIG_PATH, "utf8"));
    return { enabled: !!j.enabled, present: true };
  } catch {
    return { enabled: false, present: true, corrupt: true };
  }
}

function writeConfig(enabled) {
  mkdirSync(dirname(CONFIG_PATH), { recursive: true });
  writeFileSync(CONFIG_PATH, JSON.stringify({ enabled }, null, 2) + "\n", "utf8");
}

function json(res, status, payload) {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(payload));
}

function cuaExec(args, timeoutMs = 8000) {
  return new Promise((resolveP) => {
    execFile(
      CUA_BIN, args,
      { timeout: timeoutMs, windowsHide: true, maxBuffer: 8 * 1024 * 1024 },
      (err, stdout, stderr) => {
        resolveP({ err, stdout: String(stdout ?? ""), stderr: String(stderr ?? "") });
      },
    );
  });
}

async function daemonRunning() {
  if (!existsSync(CUA_BIN)) return false;
  const r = await cuaExec(["status"], 6000);
  return !/not running/i.test(r.stdout + r.stderr);
}

async function state() {
  const cfg = readConfig();
  let mcpWired = false;
  try {
    const j = JSON.parse(readFileSync(MCP_JSON, "utf8"));
    mcpWired = !!(j.mcpServers && j.mcpServers["cua-driver"]);
  } catch { /* leave false */ }
  return {
    ok: true,
    installed: existsSync(CUA_BIN),
    enabled: cfg.enabled,
    daemonRunning: existsSync(CUA_BIN) ? await daemonRunning() : false,
    mcpWired,
    binary: CUA_BIN,
    config: CONFIG_PATH,
  };
}

async function startDaemon() {
  if (await daemonRunning()) return { ok: true, already: true };
  mkdirSync(LOGS, { recursive: true });
  const fd = openSync(join(LOGS, "cua-driver.out.log"), "a");
  const child = spawn(CUA_BIN, ["serve", "--socket", String.raw`\\.\pipe\cua-driver`], {
    detached: true,
    stdio: ["ignore", fd, fd],
    windowsHide: true,
  });
  child.unref();
  closeSync(fd);
  return { ok: true, pid: child.pid };
}

async function toggle(host, enabled) {
  writeConfig(enabled);
  if (!enabled) {
    const r = await cuaExec(["stop"], 8000);
    host.notify?.("info", "Desktop control disabled", `daemon stop: ${r.err ? r.err.message : "ok"}`);
    return { ok: true, enabled: false };
  }
  const r = await startDaemon();
  host.notify?.("info", "Desktop control enabled", `daemon pid ${r.pid ?? "(already running)"}`);
  return { ok: true, enabled: true, ...r };
}

function originOk(headers) {
  const origin = headers?.origin;
  if (origin == null || origin === "") return true;
  const o = String(origin).trim().toLowerCase();
  if (o === "null") return false;
  let u;
  try { u = new URL(o); } catch { return false; }
  let h;
  try { h = new URL(`http://${String(headers?.host ?? "").toLowerCase()}`); } catch { return false; }
  return u.hostname.toLowerCase() === h.hostname.toLowerCase() && u.port === h.port;
}

function captureDesktop(timeoutMs = 90000) {
  return new Promise((resolveP) => {
    execFile(
      "powershell",
      ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", CAPTURE_PS1],
      { timeout: timeoutMs, windowsHide: true, maxBuffer: 4 * 1024 * 1024 },
      (err, stdout, stderr) => {
        const text = String(stdout ?? "").trim();
        try {
          resolveP({ ok: !err, ...(text ? JSON.parse(text) : { error: stderr || err?.message }) });
        } catch {
          resolveP({ ok: false, error: stderr || err?.message || "no JSON output", raw: text.slice(0, 400) });
        }
      },
    );
  });
}

export default {
  activate(host) {
    const cleanup = [];
    host.log?.("info", "[desktop-control] activated root=" + ROOT);

    cleanup.push(
      host.route("GET", "/state", async (_req, res) => {
        try { json(res, 200, await state()); }
        catch (err) { json(res, 500, { ok: false, error: err?.message ?? String(err) }); }
      }),
    );

    cleanup.push(
      host.route("POST", "/toggle", async (req, res) => {
        const ctype = String(req?.headers?.["content-type"] ?? "").split(";")[0].trim().toLowerCase();
        if (ctype !== "application/json") {
          return json(res, 415, { ok: false, error: "Content-Type must be application/json" });
        }
        if (!originOk(req?.headers)) {
          return json(res, 403, { ok: false, error: "Origin not allowed" });
        }
        const enabled = req?.body?.enabled === true;
        try {
          const r = await toggle(host, enabled);
          updateUiState();
          json(res, 200, { ok: true, ...r, state: await state() });
        } catch (err) {
          json(res, 500, { ok: false, error: err?.message ?? String(err) });
        }
      }),
    );

    // Agent tool: desktop-wide screenshot that works over live RDP sessions.
    cleanup.push(
      host.registerAgentTool({
        name: "desktop_screenshot",
        label: "Desktop Screenshot",
        description:
          "Capture the whole Windows desktop as one PNG (composited from per-window captures; works over active RDP where cua-driver get_desktop_state fails with 0x80070006). Writes glitch-pi/data/desktop-compose.png and returns its path plus per-window stats. Use this for desktop-wide views; use cua-driver get_window_state for one window.",
        parameters: { type: "object", properties: {}, additionalProperties: false },
        async execute() {
          try {
            const r = await captureDesktop();
            return r;
          } catch (err) {
            return { ok: false, error: err?.message ?? String(err) };
          }
        },
      }),
    );

    // Header action button (topbar.primary, next to Chat/Git/Plugins). Icon-only:
    // the client bundle hides the label span and colors the icon (green = on,
    // dim = off). The host icon set has no monitor glyph, so this uses iconSvg
    // drawn in the same house style (24 viewBox, currentColor, stroke-width 2).
    const UI_ID = "desktop-control-toggle";
    // Stable prefix the client selector keys on: data-tip = hint ?? label.
    const TIP = "Desktop control";
    function updateUiState() {
      try {
        const cfg = readConfig();
        const hint = cfg.enabled
          ? "Desktop control: ON — click to stop the cua-driver daemon"
          : "Desktop control: OFF — click to start the cua-driver daemon";
        // The host renders label for non-Chinese locales as labelEn ?? label and
        // hint as hint ?? hintEn, so patch BOTH spellings of each field.
        host.ui.update(UI_ID, {
          label: TIP,
          labelEn: TIP,
          hint,
          hintEn: hint,
        });
      } catch { /* ui not ready yet */ }
    }
    try {
      cleanup.push(host.ui.register({
        slot: "topbar.primary",
        id: UI_ID,
        label: TIP,
        labelEn: TIP,
        iconSvg: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="3" width="20" height="14" rx="2"/><path d="M8 21h8"/><path d="M12 17v4"/></svg>',
        kind: "action",
        action: "desktop-control:toggle",
        order: 25,
        align: "end",
        group: "views",
        hint: TIP,
        hintEn: TIP,
      }));
      updateUiState();
      // Periodic refresh so the label tracks reality (daemon crash, flag edit).
      const timer = setInterval(updateUiState, 5000);
      cleanup.push(() => clearInterval(timer));
    } catch (err) {
      host.log?.("warn", "[desktop-control] ui.register skipped: " + (err?.message ?? err));
    }

    return () => {
      for (const off of cleanup) {
        try { off?.(); } catch { /* ignore */ }
      }
    };
  },
};
