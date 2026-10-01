#!/usr/bin/env node
/**
 * desktop-control.mjs — Glitch Desktop Control plugin (cua-driver).
 *
 * Owns everything about the desktop-eyes/hands daemon:
 *   - enable/disable flag:   data/config/desktop-control.json { "enabled": bool }
 *   - daemon lifecycle:      cua-driver serve (detached, survives stack restarts)
 *   - MCP wiring check:      id cua-driver in ~/.pi/agent/mcp.json
 *
 * Usage:  node scripts/desktop-control.mjs [on|off|start|stop|status|ensure]
 *   on/off    - flip the enable flag only (wiring stays; no daemon action)
 *   start     - start the daemon now (only when enabled)
 *   stop      - stop the daemon now
 *   status    - print a JSON status summary (exit 0 always)
 *   ensure    - idempotent launcher hook: verifies wiring, starts daemon if
 *               enabled and binary present. Never prompts, never fails hard.
 *
 * The launcher (scripts/launch-unified.mjs) imports ensure() on every launch
 * and every stack restart (--reuse-saved path included). Non-fatal by design:
 * desktop control must never block startup.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { openSync, closeSync } from 'fs';
import { createWriteStream } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { execFileSync, spawn } from 'child_process';
import { homedir } from 'os';

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = join(SCRIPT_DIR, '..');
const CONFIG_PATH = join(ROOT_DIR, 'data', 'config', 'desktop-control.json');
const CUA_BIN = process.env.CUA_DRIVER_BIN ||
  join(process.env.LOCALAPPDATA || join(homedir(), 'AppData', 'Local'),
    'Programs', 'Cua', 'cua-driver', 'bin', 'cua-driver.exe');
const MCP_JSON = join(homedir(), '.pi', 'agent', 'mcp.json');

export function readConfig() {
  try {
    if (!existsSync(CONFIG_PATH)) return { enabled: false, present: false };
    const j = JSON.parse(readFileSync(CONFIG_PATH, 'utf8'));
    return { enabled: !!j.enabled, present: true };
  } catch {
    return { enabled: false, present: true, corrupt: true };
  }
}

function writeConfig(enabled) {
  mkdirSync(dirname(CONFIG_PATH), { recursive: true });
  writeFileSync(CONFIG_PATH, JSON.stringify({ enabled }, null, 2) + '\n', 'utf8');
}

function binaryPresent() {
  return existsSync(CUA_BIN);
}

function mcpWired() {
  try {
    if (!existsSync(MCP_JSON)) return false;
    const j = JSON.parse(readFileSync(MCP_JSON, 'utf8'));
    return !!(j.mcpServers && j.mcpServers['cua-driver']);
  } catch {
    return false;
  }
}

function daemonRunning() {
  try {
    const out = execFileSync(CUA_BIN, ['status'], { encoding: 'utf8', timeout: 8000, windowsHide: true });
    return !/not running/i.test(out);
  } catch {
    return false;
  }
}

export function startDaemon() {
  if (!binaryPresent()) return { ok: false, reason: 'binary-missing' };
  if (daemonRunning()) return { ok: true, already: true };
  mkdirSync(join(ROOT_DIR, 'data', 'logs'), { recursive: true });
  // Detached + unref so the daemon outlives the launcher and any stack restart.
  // Parent stays in the user's interactive session, so the daemon does too.
  const logFd = openSync(join(ROOT_DIR, 'data', 'logs', 'cua-driver.out.log'), 'a');
  const child = spawn(CUA_BIN, ['serve', '--socket', String.raw`\\.\pipe\cua-driver`], {
    detached: true,
    stdio: ['ignore', logFd, logFd],
    windowsHide: true,
  });
  child.unref();
  closeSync(logFd); // spawn() dup'd it for the child
  return { ok: true, pid: child.pid };
}

export function stopDaemon() {
  try {
    execFileSync(CUA_BIN, ['stop'], { encoding: 'utf8', timeout: 8000, windowsHide: true });
    return { ok: true };
  } catch (e) {
    return { ok: false, reason: e && e.message };
  }
}

export function statusSummary() {
  const cfg = readConfig();
  return {
    installed: binaryPresent(),
    enabled: cfg.enabled,
    mcpWired: mcpWired(),
    daemonRunning: binaryPresent() ? daemonRunning() : false,
    binary: CUA_BIN,
    config: CONFIG_PATH,
  };
}

/** Launcher hook: wire check + start if enabled. Always resolves. */
export async function ensure(logFn = console.log) {
  try {
    if (!binaryPresent()) return { skipped: 'binary-missing' };
    const { enabled, present } = readConfig();
    if (!present) {
      // Fresh install where scripts are newer than install.ps1 run: default to
      // enabled when the user already installed the driver via the installer
      // (mcp wiring proves consent). Absent wiring = leave disabled.
      const on = mcpWired();
      writeConfig(on);
      return { initialized: on };
    }
    if (!enabled) return { skipped: 'disabled' };
    if (!mcpWired()) logFn('  (desktop control: MCP wiring missing — re-run installer 4.8)');
    const r = startDaemon();
    return r;
  } catch (e) {
    return { error: e && e.message };
  }
}

// ---- CLI -------------------------------------------------------------------
const cmd = process.argv[2] || 'status';
switch (cmd) {
  case 'on': writeConfig(true); console.log(JSON.stringify(statusSummary())); break;
  case 'off': writeConfig(false); console.log(JSON.stringify(statusSummary())); break;
  case 'start': {
    const { enabled } = readConfig();
    if (!enabled) { console.log(JSON.stringify({ ok: false, reason: 'disabled — use `on` first' })); process.exitCode = 2; break; }
    console.log(JSON.stringify(startDaemon())); break;
  }
  case 'stop': console.log(JSON.stringify(stopDaemon())); break;
  case 'ensure': console.log(JSON.stringify(await ensure())); break;
  default: console.log(JSON.stringify(statusSummary(), null, 1));
}
