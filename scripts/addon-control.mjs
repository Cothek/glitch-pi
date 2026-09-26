#!/usr/bin/env node
/**
 * addon-control.mjs — single lifecycle owner for companion add-ons.
 *
 * Usage:
 *   node scripts/addon-control.mjs list
 *   node scripts/addon-control.mjs status [id|all]
 *   node scripts/addon-control.mjs start <id>
 *   node scripts/addon-control.mjs stop <id>
 *   node scripts/addon-control.mjs autostart <id> <on|off>
 *   node scripts/addon-control.mjs start-auto
 *
 * Add --json to any verb to print a single JSON object/array on stdout (machine
 * output). Without --json each verb prints short human lines. The process ALWAYS
 * exits 0 — a missing app, a dead PID, or a port timeout is reported in the JSON,
 * never thrown. R22 forbids process-name kills: stop kills the captured PID only
 * (taskkill /PID on Windows, signal on Unix).
 */
import { spawn, execFile } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  appendFileSync,
  unlinkSync,
  openSync,
  closeSync,
} from "node:fs";
import { join, dirname, resolve, isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";
import net from "node:net";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");
const DATA_DIR = join(ROOT, "data");
const ADDONS_DIR = join(DATA_DIR, "addons");
const LOGS_DIR = join(DATA_DIR, "logs");
const FLAGS_FILE = join(ADDONS_DIR, "addons.json");

// ---------------------------------------------------------------------------
// Registry — hardcoded. Order is also the display order in `list`. Env
// overrides let Troy move an app without editing this file.
// ---------------------------------------------------------------------------
const REGISTRY = [
  {
    id: "money",
    label: "Money Dashboard",
    ports: [4110],
    envDir: "MONEY_DASHBOARD_DIR",
    defaultDir: "<ROOT>/../code/glitch-money",
    cmd: ["node", "<ROOT>/../code/glitch-money/dashboard/server.mjs"],
    cwd: "<ROOT>/../code/glitch-money",
    bootGraceMs: 15_000,
  },
  {
    id: "trader",
    label: "Glitch Trader",
    ports: [4120, 3000],
    envDir: "GLITCH_TRADER_DIR",
    defaultDir: "<ROOT>/../code/glitch-trader/engine",
    cmd: [
      "<ROOT>/../code/glitch-trader/engine/.venv/Scripts/python.exe",
      "-m",
      "uvicorn",
      "engine.api.__main__:app",
      "--port",
      "4120",
    ],
    cwd: "<ROOT>/../code/glitch-trader/engine",
    bootGraceMs: 45_000,
  },
  {
    id: "browser-use",
    label: "Browser Use",
    ports: [4105],
    envDir: "BROWSER_USE_DIR",
    defaultDir: "<ROOT>",
    cmd: ["node", "<ROOT>/plugins/browser-use/server.mjs"],
    cwd: "<ROOT>",
    bootGraceMs: 15_000,
  },
];

const REGISTRY_BY_ID = new Map(REGISTRY.map((a) => [a.id, a]));

// ---------------------------------------------------------------------------
// Output helpers
// ---------------------------------------------------------------------------
const argv = process.argv.slice(2);
const wantJson = argv.includes("--json");
const positional = argv.filter((a) => a !== "--json");

function emit(payload) {
  if (wantJson) {
    process.stdout.write(JSON.stringify(payload) + "\n");
    return;
  }
  if (Array.isArray(payload)) {
    for (const item of payload) process.stdout.write(formatHuman(item) + "\n");
    return;
  }
  process.stdout.write(formatHuman(payload) + "\n");
}

function formatHuman(obj) {
  if (typeof obj === "string") return obj;
  if (obj && obj.line) return obj.line;
  return JSON.stringify(obj);
}

// ---------------------------------------------------------------------------
// Filesystem + state helpers
// ---------------------------------------------------------------------------
function ensureDirs() {
  for (const dir of [DATA_DIR, ADDONS_DIR, LOGS_DIR]) {
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  }
}

function pidFile(id) { return join(ADDONS_DIR, `${id}.pid`); }
function logFile(id) { return join(LOGS_DIR, `${id}.log`); }

function readPidFile(id) {
  const f = pidFile(id);
  if (!existsSync(f)) return null;
  try {
    const raw = readFileSync(f, "utf8").trim();
    if (!raw) return null;
    // New shape: {"pid":<n>,"startedAt":"<ISO>"}. Legacy shape: bare integer.
    // A bare integer means no startedAt — the caller treats that as grace-expired
    // so a stale PID file written by an older installer still reads sensibly.
    try {
      const obj = JSON.parse(raw);
      if (obj && typeof obj === "object") {
        const n = Number(obj.pid);
        if (!Number.isFinite(n) || n <= 0) return null;
        const ts = typeof obj.startedAt === "string" ? Date.parse(obj.startedAt) : NaN;
        return { pid: n, startedAt: Number.isFinite(ts) ? ts : null };
      }
    } catch {
      /* fall through to legacy parse */
    }
    const n = Number(raw);
    return Number.isFinite(n) && n > 0 ? { pid: n, startedAt: null } : null;
  } catch {
    return null;
  }
}
function writePidFile(id, pid) {
  const payload = JSON.stringify({ pid, startedAt: new Date().toISOString() });
  writeFileSync(pidFile(id), payload);
}
function deletePidFile(id) {
  const f = pidFile(id);
  if (existsSync(f)) {
    try { unlinkSync(f); } catch { /* best effort */ }
  }
}

function readFlags() {
  if (!existsSync(FLAGS_FILE)) return {};
  try {
    return JSON.parse(readFileSync(FLAGS_FILE, "utf8")) || {};
  } catch {
    return {};
  }
}
function writeFlags(flags) {
  writeFileSync(FLAGS_FILE, JSON.stringify(flags, null, 2));
}

// ---------------------------------------------------------------------------
// Resolvers: env overrides, ROOT substitution, absolute-path checks
// ---------------------------------------------------------------------------
function substituteRoot(s) {
  return String(s).replace(/<ROOT>/g, ROOT);
}

function resolveDir(addon) {
  const fromEnv = process.env[addon.envDir];
  if (fromEnv && fromEnv.trim()) return resolve(fromEnv);
  return resolve(substituteRoot(addon.defaultDir));
}

function resolveCmd(addon) {
  return addon.cmd.map((part) => {
    const subbed = substituteRoot(part);
    return isAbsolute(subbed) || subbed.includes("/") || subbed.includes("\\")
      ? resolve(subbed)
      : subbed;
  });
}
function resolveCwd(addon) {
  return resolve(substituteRoot(addon.cwd));
}

// ---------------------------------------------------------------------------
// Alive + listening probes
// ---------------------------------------------------------------------------
function isAlive(pid) {
  if (!pid) return false;
  // signal 0 = "does this pid exist?"
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM on Windows can mean the process exists but we don't own it
    if (err && err.code === "EPERM") return true;
    return false;
  }
}

function isListening(port, timeoutMs = 800) {
  return new Promise((resolveP) => {
    const sock = net.createConnection({ host: "127.0.0.1", port });
    let settled = false;
    const finish = (v) => {
      if (settled) return;
      settled = true;
      try { sock.destroy(); } catch { /* noop */ }
      resolveP(v);
    };
    sock.once("connect", () => finish(true));
    sock.once("error", () => finish(false));
    setTimeout(() => finish(false), timeoutMs);
  });
}

async function checkPorts(addon) {
  const results = [];
  for (const port of addon.ports) {
    const listening = await isListening(port);
    results.push({ port, listening });
  }
  return results;
}

// ---------------------------------------------------------------------------
// Spawn / kill
// ---------------------------------------------------------------------------
function spawnAddon(addon) {
  const cmd = resolveCmd(addon);
  const cwd = resolveCwd(addon);
  const log = logFile(addon.id);
  appendFileSync(log, `[addon-control] ${new Date().toISOString()} start ${addon.id}\n`);

  const fd = openSync(log, "a");
  let child;
  try {
    child = spawn(cmd[0], cmd.slice(1), {
      cwd,
      detached: true,
      windowsHide: true,
      stdio: ["ignore", fd, fd],
      env: { ...process.env },
    });
  } catch (err) {
    try { closeSync(fd); } catch { /* ignore */ }
    return { ok: false, error: `spawn failed: ${err?.message ?? err}` };
  }
  // Close the parent's copy so the child owns the fd.
  try { closeSync(fd); } catch { /* ignore */ }

  if (!child.pid) return { ok: false, error: "spawn returned no pid" };

  writePidFile(addon.id, child.pid);
  try { child.unref(); } catch { /* ignore */ }
  return { ok: true, pid: child.pid };
}

// Cross-platform kill by captured PID only (never by image name — R22).
function killByPid(pid) {
  return new Promise((resolveK) => {
    if (process.platform === "win32") {
      execFile("taskkill", ["/PID", String(pid), "/T", "/F"], { windowsHide: true }, (err) => {
        if (err) return resolveK({ ok: false, error: err.message });
        resolveK({ ok: true });
      });
      return;
    }
    try {
      process.kill(pid, "SIGTERM");
    } catch (err) {
      return resolveK({ ok: false, error: err?.message ?? String(err) });
    }
    setTimeout(() => {
      try { process.kill(pid, "SIGKILL"); } catch { /* already gone */ }
      resolveK({ ok: true });
    }, 2000);
  });
}

// ---------------------------------------------------------------------------
// Verbs
// ---------------------------------------------------------------------------
async function verbList() {
  const out = REGISTRY.map((a) => ({ id: a.id, label: a.label, ports: a.ports }));
  emit(out);
  return out;
}

async function statusOne(addon) {
  const pidRec = readPidFile(addon.id);
  const pid = pidRec ? pidRec.pid : null;
  const alive = pid ? isAlive(pid) : false;
  const ports = await checkPorts(addon);
  const flags = readFlags();
  const autostart = !!(flags[addon.id] && flags[addon.id].autostart);
  const allListening = ports.every((p) => p.listening);
  // `up` keeps its current meaning: alive AND at least one port listening. New
  // `state` is the richer three-valued indicator the panel reads.
  const up = alive && allListening;
  let state;
  if (alive && allListening) {
    state = "up";
  } else if (alive && !allListening) {
    // Grace only applies when we know when the process started. Legacy PID files
    // have no startedAt -> assume expired: a long-running boot that simply never
    // bound a port still reads as "down" so the panel can act on it.
    const startedAt = pidRec?.startedAt;
    if (startedAt != null && Date.now() - startedAt < (addon.bootGraceMs ?? 0)) {
      state = "starting";
    } else {
      state = "down";
    }
  } else {
    state = "down";
  }
  return {
    id: addon.id,
    label: addon.label,
    up,
    state,
    pid: alive ? pid : null,
    ports,
    autostart,
    logPath: logFile(addon.id),
    bootGraceMs: addon.bootGraceMs,
  };
}

async function verbStatus(arg) {
  if (arg && arg !== "all" && REGISTRY_BY_ID.has(arg)) {
    const r = await statusOne(REGISTRY_BY_ID.get(arg));
    emit(r);
    return [r];
  }
  const all = await Promise.all(REGISTRY.map(statusOne));
  emit(all);
  return all;
}

async function verbStart(id) {
  const addon = REGISTRY_BY_ID.get(id);
  if (!addon) return emit({ id, ok: false, error: `unknown add-on "${id}"` });

  // pre-flight: is the app even on disk?
  const cwd = resolveCwd(addon);
  if (!existsSync(cwd)) {
    const msg = `app directory missing: ${cwd}`;
    appendFileSync(logFile(addon.id), `[addon-control] ${new Date().toISOString()} start FAILED: ${msg}\n`);
    return emit({ id, ok: false, error: msg });
  }

  // skip-if-alive: pid alive AND at least one port listening
  const existing = readPidFile(addon.id);
  if (existing && isAlive(existing.pid)) {
    const ports = await checkPorts(addon);
    if (ports.every((p) => p.listening)) {
      return emit({ id, ok: true, action: "already_up", pid: existing.pid, ports });
    }
    // Process alive but port(s) not yet bound. If we are still inside bootGraceMs,
    // do NOT spawn a duplicate — the first attempt is still booting. Outside grace
    // (or no startedAt -> grace expired by default), clear the stale file and
    // proceed with a fresh spawn.
    if (existing.startedAt != null && Date.now() - existing.startedAt < (addon.bootGraceMs ?? 0)) {
      return emit({ id, ok: true, action: "already_starting", pid: existing.pid });
    }
    deletePidFile(addon.id);
  }

  const result = spawnAddon(addon);
  if (!result.ok) {
    appendFileSync(logFile(addon.id), `[addon-control] ${new Date().toISOString()} start FAILED: ${result.error}\n`);
    return emit({ id, ok: false, error: result.error });
  }
  emit({ id, ok: true, action: "started", pid: result.pid, logPath: logFile(addon.id) });
  return result;
}

async function verbStop(id) {
  const addon = REGISTRY_BY_ID.get(id);
  if (!addon) return emit({ id, ok: false, error: `unknown add-on "${id}"` });

  const existing = readPidFile(addon.id);
  if (!existing) return emit({ id, ok: true, action: "not_running" });
  const pid = existing.pid;
  if (!isAlive(pid)) {
    deletePidFile(addon.id);
    return emit({ id, ok: true, action: "not_running" });
  }

  const killResult = await killByPid(pid);
  deletePidFile(addon.id);
  if (!killResult.ok) {
    return emit({ id, ok: false, error: `kill failed: ${killResult.error}` });
  }

  // confirm port(s) free within 5s
  const freeDeadline = Date.now() + 5000;
  let allFree = false;
  while (Date.now() < freeDeadline) {
    const ports = await checkPorts(addon);
    if (ports.every((p) => !p.listening)) { allFree = true; break; }
    await new Promise((r) => setTimeout(r, 250));
  }
  emit({ id, ok: true, action: "stopped", portsFree: allFree });
  return { id, ok: true, action: "stopped", portsFree: allFree };
}

async function verbAutostart(id, onRaw) {
  const addon = REGISTRY_BY_ID.get(id);
  if (!addon) return emit({ id, ok: false, error: `unknown add-on "${id}"` });
  const on = String(onRaw ?? "").toLowerCase();
  if (!["on", "off", "true", "false", "1", "0"].includes(on)) {
    return emit({ id, ok: false, error: `expected on|off, got "${onRaw}"` });
  }
  const wanted = on === "on" || on === "true" || on === "1";
  const flags = readFlags();
  flags[addon.id] = { ...(flags[addon.id] || {}), autostart: wanted };
  writeFlags(flags);
  emit({ id, ok: true, autostart: wanted });
  return { id, ok: true, autostart: wanted };
}

async function verbStartAuto() {
  const flags = readFlags();
  const started = [];
  const skipped = [];
  for (const addon of REGISTRY) {
    if (flags[addon.id] && flags[addon.id].autostart) {
      const cwd = resolveCwd(addon);
      if (!existsSync(cwd)) {
        skipped.push({ id: addon.id, reason: "missing app dir" });
        continue;
      }
      const r = await verbStart(addon.id);
      if (r && r.ok && (r.action === "started" || r.action === "already_up")) {
        started.push({ id: addon.id, pid: r.pid ?? readPidFile(addon.id)?.pid });
      } else {
        skipped.push({ id: addon.id, reason: r?.error ?? "unknown" });
      }
    }
  }
  emit({ ok: true, started, skipped });
  return { ok: true, started, skipped };
}

// ---------------------------------------------------------------------------
// Dispatcher
// ---------------------------------------------------------------------------
async function main() {
  ensureDirs();
  const verb = positional[0];
  switch (verb) {
    case "list": return verbList();
    case "status": return verbStatus(positional[1]);
    case "start": return verbStart(positional[1]);
    case "stop": return verbStop(positional[1]);
    case "autostart": return verbAutostart(positional[1], positional[2]);
    case "start-auto": return verbStartAuto();
    default:
      emit({
        ok: false,
        error: `unknown verb "${verb}". Use list | status [id|all] | start <id> | stop <id> | autostart <id> <on|off> | start-auto`,
      });
  }
}

main().catch((err) => {
  emit({ ok: false, error: err?.message ?? String(err) });
  process.exit(0);
});
