#!/usr/bin/env node
/**
 * scripts/restart-watchdog.mjs
 *
 * Detached post-restart health monitor. Launched by scripts/restart-request.mjs
 * alongside the restart engine (scripts/restart-pi-stack.ps1), both via
 * scripts/start-detached.ps1 so both survive the kill of pi-web-ui (the
 * process that hosts the agent session).
 *
 * WHY: the restart engine already health-checks the web server (HTTP 200 with
 * the PI token, 60s window), but when the engine itself dies, the launch chain
 * fails, or the stack never comes back, the engine exits 1 and NOTHING
 * recovers - the agent is dead and a human has to diagnose by hand. The
 * watchdog covers that gap: it independently verifies the stack came back,
 * writes a report the next session can read, and attempts exactly ONE recovery
 * relaunch on failure.
 *
 * State machine (self-synchronizing with the actual restart, immune to timing
 * drift between the engine and this process):
 *   1. PHASE_DOWN_WAIT  - poll both ports every 2s until BOTH are down. Both
 *      ports down is the restart signature (the engine kills both). Deadline:
 *      --delay + --down-wait. On timeout the restart never happened - outcome
 *      "no-restart-signal": the stack is most likely still up, so NO recovery,
 *      report + marker written, exit 0.
 *   2. PHASE_UP_WAIT    - poll until BOTH are up. Deadline: --timeout.
 *      Outcome "success" on both up.
 *   3. PHASE_RECOVERY   - on --timeout expiry: outcome "failed". Gather
 *      diagnostics, attempt exactly ONE recovery relaunch (restart-pi-stack.ps1
 *      -SkipUpdates via start-detached.ps1), then poll for 120s more. Both up
 *      afterwards upgrades the outcome to "recovered".
 *
 * Probes:
 *   - web  : HTTP GET http://127.0.0.1:<web-port>/ with X-PI-Token from
 *     .server-token when the token file exists (same rule as the engine's
 *     health check). ANY HTTP response counts as up (the status code is
 *     recorded for diagnostics). Reason: a 401/500 still proves the HTTP
 *     server is listening - treating only 200 as up would false-trigger a
 *     recovery restart when the token gate answers 401.
 *   - auth : TCP connect to 127.0.0.1:<auth-port> (protocol-agnostic).
 *
 * Safe standalone: when launched with no restart running, phase 1 times out,
 * the outcome is "no-restart-signal" and the process exits 0 without touching
 * the stack. Pass --no-recovery when testing against the live stack.
 *
 * Files written:
 *   - data/monitor/restart-report-<timestamp>.json  (full report per restart)
 *   - data/monitor/restart-status.json              (fixed-path last-outcome
 *     marker; the continuation prompt tells the resumed agent to read this)
 *   - stdout lands in data/logs/restart-watchdog.out.log (via start-detached)
 *
 * Importing this module is side-effect-free (entry guard at the bottom), so a
 * test never triggers a probe, a recovery, or a restart.
 */
import { execFileSync, execSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import http from "node:http";
import net from "node:net";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { sanitizeNote } from "./restart-request.mjs";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const LOGS = join(ROOT, "data", "logs");
const MONITOR_DIR = join(ROOT, "data", "monitor");
const STACK = join(ROOT, "scripts", "restart-pi-stack.ps1");
const DETACH = join(ROOT, "scripts", "start-detached.ps1");
const TOKEN_PATH = join(ROOT, ".server-token");

const STACK_NAME = "restart-stack";
const RECOVERY_NAME = "restart-recovery";

const POLL_INTERVAL_MS = 2000;
const PROBE_TIMEOUT_MS = 3000;
const RECOVERY_WAIT_SEC = 120;
const DEFAULT_DELAY = 0;
const DEFAULT_DOWN_WAIT = 45;
const DEFAULT_TIMEOUT = 180;
const MAX_TIMEOUT = 600;
const MAX_DOWN_WAIT = 300;
const MAX_NOTE = 300;
const TAIL_LINES = 20;
const MAX_LOG_LINE = 500;

const OUTCOMES = ["success", "recovered", "failed", "no-restart-signal"];

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Tiny argv parser. --delay / --down-wait / --timeout take a number and are
 * range-checked so a bad value exits 2 cleanly instead of producing a nonsense
 * deadline. --web-port / --auth-port take 1..65535. --note takes text.
 * --no-recovery disables the recovery relaunch (used when testing against the
 * live stack). Unknown flags produce a structured error.
 */
export function parseArgs(argv) {
  const out = {
    delay: DEFAULT_DELAY,
    downWait: DEFAULT_DOWN_WAIT,
    timeout: DEFAULT_TIMEOUT,
    webPort: 8787,
    authPort: 4103,
    note: null,
    noRecovery: false,
    json: false,
    help: false,
    error: null,
  };
  const args = Array.isArray(argv) ? argv.slice() : [];
  const num = (flag, v, lo, hi) => {
    if (v === undefined) return { error: `${flag} requires a value` };
    const n = Number(v);
    if (!Number.isFinite(n) || n < lo || n > hi) {
      return { error: `${flag} must be ${lo}..${hi} (got ${v})` };
    }
    return { value: Math.floor(n) };
  };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--delay") {
      const r = num("--delay", args[++i], 0, MAX_DOWN_WAIT);
      if (r.error) { out.error = r.error; return out; }
      out.delay = r.value;
    } else if (a === "--down-wait") {
      const r = num("--down-wait", args[++i], 0, MAX_DOWN_WAIT);
      if (r.error) { out.error = r.error; return out; }
      out.downWait = r.value;
    } else if (a === "--timeout") {
      const r = num("--timeout", args[++i], 30, MAX_TIMEOUT);
      if (r.error) { out.error = r.error; return out; }
      out.timeout = r.value;
    } else if (a === "--web-port") {
      const r = num("--web-port", args[++i], 1, 65535);
      if (r.error) { out.error = r.error; return out; }
      out.webPort = r.value;
    } else if (a === "--auth-port") {
      const r = num("--auth-port", args[++i], 1, 65535);
      if (r.error) { out.error = r.error; return out; }
      out.authPort = r.value;
    } else if (a === "--note") {
      const v = args[++i];
      if (v === undefined) { out.error = "--note requires a value"; return out; }
      out.note = v;
    } else if (a === "--no-recovery") {
      out.noRecovery = true;
    } else if (a === "--json") {
      out.json = true;
    } else if (a === "--help" || a === "-h") {
      out.help = true;
    } else {
      out.error = `unknown flag: ${a}`;
      return out;
    }
  }
  return out;
}

function printHelp() {
  const text = [
    "Usage: node scripts/restart-watchdog.mjs [flags]",
    "",
    "Detached post-restart health monitor. Normally launched by",
    "scripts/restart-request.mjs alongside the restart engine.",
    "",
    "Flags:",
    "  --delay <sec>       mirror of the restart engine -DelaySec (default 0)",
    "  --down-wait <sec>   phase-1 slack after the kill window (default 45)",
    "  --timeout <sec>     phase-2 deadline for both ports up (default 180)",
    "  --web-port <port>   pi-web-ui port (default 8787)",
    "  --auth-port <port>  auth proxy port (default 4103)",
    "  --note <text>       trigger note recorded in the report",
    "  --no-recovery       disable the one recovery relaunch (testing)",
    "  --json              print one JSON summary line at the end",
    "  --help, -h          show this help",
    "",
    "Outcomes: success | recovered | failed | no-restart-signal",
    "Reports: data/monitor/restart-report-<ts>.json + restart-status.json",
  ].join("\n");
  process.stdout.write(text + "\n");
}

/**
 * HTTP probe. ANY response (including 401/500) resolves ok:true - the point
 * is "is the HTTP server listening", not "is the app healthy" (the engine's
 * own 200 check covers app health during the restart). The token is attached
 * when provided so a token-gated server answers 200 instead of 401, which
 * keeps the recorded status clean. Timeboxed via the request timeout.
 */
export function probeHttp(url, token, timeoutMs = PROBE_TIMEOUT_MS) {
  return new Promise((resolve) => {
    const started = Date.now();
    let settled = false;
    const done = (result) => {
      if (settled) return;
      settled = true;
      resolve(result);
    };
    let req;
    try {
      req = http.request(
        url,
        {
          method: "GET",
          headers: token ? { "X-PI-Token": token } : {},
          timeout: timeoutMs,
        },
        (res) => {
          res.resume(); // drain the body so the socket is released
          done({
            ok: true,
            status: res.statusCode ?? null,
            latencyMs: Date.now() - started,
            error: null,
          });
        },
      );
    } catch (err) {
      done({ ok: false, status: null, latencyMs: Date.now() - started, error: String(err?.message ?? err) });
      return;
    }
    req.on("timeout", () => req.destroy(new Error("timeout")));
    req.on("error", (err) =>
      done({ ok: false, status: null, latencyMs: Date.now() - started, error: String(err?.message ?? err) }),
    );
    req.end();
  });
}

/**
 * TCP connect probe (protocol-agnostic). Used for the auth proxy, whose
 * serving behavior we do not need to interpret - a listening socket is the
 * signal. Timeboxed via the socket timeout.
 */
export function probeTcp(port, timeoutMs = PROBE_TIMEOUT_MS) {
  return new Promise((resolve) => {
    const started = Date.now();
    const socket = new net.Socket();
    let settled = false;
    const done = (ok, error) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve({ ok, latencyMs: Date.now() - started, error: error ?? null });
    };
    socket.setTimeout(timeoutMs);
    socket.once("connect", () => done(true, null));
    socket.once("timeout", () => done(false, "timeout"));
    socket.once("error", (err) => done(false, String(err?.message ?? err)));
    socket.connect(port, "127.0.0.1");
  });
}

/**
 * Parse `netstat -ano` text into { port: [owning PIDs] } for the given ports.
 * Handles IPv4 (0.0.0.0:8787) and IPv6 ([::]:8787) local addresses; ignores
 * non-LISTENING lines. Pure: takes the raw text, no process spawned.
 */
export function parseNetstat(text, ports) {
  const out = {};
  for (const p of ports) out[String(p)] = [];
  if (!text) return out;
  for (const raw of String(text).split(/\r?\n/)) {
    const line = raw.trim();
    if (!line.includes("LISTENING")) continue;
    const parts = line.split(/\s+/);
    // netstat -ano columns: Proto, Local, Foreign, State, PID
    if (parts.length < 5) continue;
    const local = parts[1];
    const pid = parts[4];
    const m = local.match(/:(\d+)$/);
    if (!m) continue;
    const port = m[1];
    if (!(port in out)) continue;
    if (/^\d+$/.test(pid)) out[port].push(Number(pid));
  }
  for (const p of Object.keys(out)) out[p] = [...new Set(out[p])];
  return out;
}

/**
 * Last N non-empty lines of a log text, each capped at MAX_LOG_LINE chars.
 * Pure. Keeps reports bounded no matter how chatty a log got.
 */
export function tailLines(text, n = TAIL_LINES) {
  if (!text) return [];
  return String(text)
    .split(/\r?\n/)
    .filter((l) => l.trim().length > 0)
    .slice(-n)
    .map((l) => (l.length > MAX_LOG_LINE ? l.slice(0, MAX_LOG_LINE) : l));
}

/**
 * Build the powershell.exe command that runs the recovery relaunch: the same
 * restart engine with -SkipUpdates (a recovery must never apply dependency
 * updates; matches the launch-unified --reuse-saved policy). No -WebPort /
 * -AuthPort: engine defaults are the real stack ports.
 *
 * Pure: no FS, no env, no spawning. Testable without touching anything.
 */
export function buildRecoveryCommand({ root }) {
  const r = String(root ?? "");
  return `powershell.exe -NoProfile -ExecutionPolicy Bypass -File "${join(r, "scripts", "restart-pi-stack.ps1")}" -DelaySec 0 -SkipUpdates`;
}

/**
 * Read the PI web token the same way the engine's health check does: from
 * .server-token at the repo root, trimmed, or null when absent.
 */
function readToken() {
  if (!existsSync(TOKEN_PATH)) return null;
  try {
    const v = String(readFileSync(TOKEN_PATH, "utf8")).trim();
    return v || null;
  } catch {
    return null;
  }
}

function readTextFile(path) {
  if (!existsSync(path)) return null;
  try {
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
}

/**
 * Gather failure diagnostics: netstat port->PID parse for the two ports, last
 * 20 lines of the restart engine's out/err logs, and the engine PID file.
 * Every step is individually guarded - diagnostics collection must never be
 * the thing that crashes the watchdog.
 */
function gatherDiagnostics(webPort, authPort, extraLogs = {}) {
  const diag = { netstat: null, logs: {}, pidFile: null };
  try {
    const text = execSync("netstat -ano", {
      timeout: 10_000,
      windowsHide: true,
      encoding: "utf8",
    });
    diag.netstat = parseNetstat(text, [webPort, authPort]);
  } catch (err) {
    diag.netstat = { error: String(err?.message ?? err) };
  }
  for (const [label, path] of Object.entries({
    "restart-stack.out.log": join(LOGS, `${STACK_NAME}.out.log`),
    "restart-stack.err.log": join(LOGS, `${STACK_NAME}.err.log`),
    ...extraLogs,
  })) {
    const text = readTextFile(path);
    diag.logs[label] = { path, tail: tailLines(text) };
  }
  const pidText = readTextFile(join(LOGS, `${STACK_NAME}.pid`));
  if (pidText && /^\d+$/.test(pidText.trim())) diag.pidFile = Number(pidText.trim());
  return diag;
}

/**
 * Attempt exactly ONE recovery relaunch, detached via start-detached.ps1.
 * Returns { attempted, pid, error }. Detached so the watchdog does not block
 * on the relaunch (which runs the full startup chain) - it polls instead.
 */
function spawnRecovery() {
  const cmd = buildRecoveryCommand({ root: ROOT });
  try {
    execFileSync(
      "powershell.exe",
      [
        "-NoProfile",
        "-ExecutionPolicy",
        "Bypass",
        "-File",
        DETACH,
        "-Command",
        cmd,
        "-Name",
        RECOVERY_NAME,
      ],
      { timeout: 20_000, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] },
    );
  } catch (err) {
    return { attempted: true, pid: null, error: String(err?.message ?? err) };
  }
  // PID file written by start-detached.ps1 (best effort read).
  const pidText = readTextFile(join(LOGS, `${RECOVERY_NAME}.pid`));
  const pid = pidText && /^\d+$/.test(pidText.trim()) ? Number(pidText.trim()) : null;
  return { attempted: true, pid, error: null };
}

/**
 * Shape the full report. Pure. Everything the next session (or a human) needs
 * to reconstruct what happened during the restart window.
 */
export function buildReport({
  startedAt,
  finishedAt,
  outcome,
  triggerNote,
  delaySec,
  downWaitSec,
  timeoutSec,
  webPort,
  authPort,
  poll,
  recovery,
  diagnostics,
}) {
  return {
    watchdog: "restart-watchdog",
    version: 1,
    startedAt,
    finishedAt,
    outcome,
    triggerNote: triggerNote ?? "",
    config: { delaySec, downWaitSec, timeoutSec, webPort, authPort },
    poll,
    recovery: recovery ?? { attempted: false, pid: null, error: null },
    diagnostics: diagnostics ?? null,
  };
}

/**
 * Shape the fixed-path status marker from the report. Pure. Small on purpose:
 * the continuation prompt tells the resumed agent to read this file on boot.
 */
export function buildMarker(report) {
  const last = report.poll?.lastProbe ?? { web: { ok: false }, auth: { ok: false } };
  return {
    timestamp: report.finishedAt,
    outcome: report.outcome,
    webPort: report.config?.webPort ?? null,
    authPort: report.config?.authPort ?? null,
    webUp: last.web?.ok === true,
    authUp: last.auth?.ok === true,
    webLatencyMs: last.web?.latencyMs ?? null,
    recoveryAttempted: report.recovery?.attempted === true,
    note: report.triggerNote ?? "",
  };
}

function writeOutputs(report) {
  mkdirSync(MONITOR_DIR, { recursive: true });
  const stamp = report.startedAt.replace(/[:]/g, "-");
  const reportPath = join(MONITOR_DIR, `restart-report-${stamp}.json`);
  try {
    writeFileSync(reportPath, JSON.stringify(report, null, 2) + "\n");
  } catch (err) {
    process.stderr.write(`restart-watchdog: report write failed: ${String(err?.message ?? err)}\n`);
  }
  const markerPath = join(MONITOR_DIR, "restart-status.json");
  try {
    writeFileSync(markerPath, JSON.stringify(buildMarker(report), null, 2) + "\n");
  } catch (err) {
    process.stderr.write(`restart-watchdog: marker write failed: ${String(err?.message ?? err)}\n`);
  }
  return { reportPath, markerPath };
}

async function main() {
  const parsed = parseArgs(process.argv.slice(2));
  if (parsed.help) {
    printHelp();
    process.exit(0);
  }
  if (parsed.error) {
    process.stderr.write(`restart-watchdog: ${parsed.error}\n`);
    process.exit(2);
  }

  const note = sanitizeNote(parsed.note ?? "").slice(0, MAX_NOTE);
  const token = readToken();
  const startedAt = new Date().toISOString();
  const poll = { attempts: 0, firstDownAt: null, webUpAt: null, authUpAt: null, lastProbe: null };

  const probeOnce = async () => {
    const web = await probeHttp(`http://127.0.0.1:${parsed.webPort}/`, token);
    const auth = await probeTcp(parsed.authPort);
    poll.attempts += 1;
    poll.lastProbe = { at: new Date().toISOString(), web, auth };
    return { web, auth };
  };

  // ---- Phase 1: wait for the restart signature (both ports down) ------------
  // The engine kills both ports; both down means the kill happened. Deadline
  // is the engine delay plus the down-wait slack.
  const downDeadline = Date.now() + parsed.delay * 1000 + parsed.downWait * 1000;
  let sawDown = false;
  while (Date.now() < downDeadline) {
    const { web, auth } = await probeOnce();
    if (!web.ok && !auth.ok) {
      sawDown = true;
      poll.firstDownAt = new Date().toISOString();
      break;
    }
    await sleep(POLL_INTERVAL_MS);
  }

  if (!sawDown) {
    // The restart never happened: the engine likely died before the kill.
    // The stack is most likely still up - do NOT attempt a recovery restart.
    const diagnostics = gatherDiagnostics(parsed.webPort, parsed.authPort);
    const finishedAt = new Date().toISOString();
    const report = buildReport({
      startedAt, finishedAt, outcome: "no-restart-signal", triggerNote: note,
      delaySec: parsed.delay, downWaitSec: parsed.downWait, timeoutSec: parsed.timeout,
      webPort: parsed.webPort, authPort: parsed.authPort, poll, diagnostics,
    });
    const { reportPath, markerPath } = writeOutputs(report);
    process.stdout.write(
      JSON.stringify({ outcome: "no-restart-signal", reportPath, markerPath, attempts: poll.attempts }) + "\n",
    );
    process.exit(0);
  }

  // ---- Phase 2: wait for both ports to come back up --------------------------
  const upDeadline = Date.now() + parsed.timeout * 1000;
  while (Date.now() < upDeadline) {
    const { web, auth } = await probeOnce();
    if (web.ok) poll.webUpAt ??= new Date().toISOString();
    if (auth.ok) poll.authUpAt ??= new Date().toISOString();
    if (web.ok && auth.ok) {
      const finishedAt = new Date().toISOString();
      const report = buildReport({
        startedAt, finishedAt, outcome: "success", triggerNote: note,
        delaySec: parsed.delay, downWaitSec: parsed.downWait, timeoutSec: parsed.timeout,
        webPort: parsed.webPort, authPort: parsed.authPort, poll,
      });
      const { reportPath, markerPath } = writeOutputs(report);
      process.stdout.write(
        JSON.stringify({ outcome: "success", reportPath, markerPath, attempts: poll.attempts }) + "\n",
      );
      process.exit(0);
    }
    await sleep(POLL_INTERVAL_MS);
  }

  // ---- Phase 3: failed -> diagnostics + ONE recovery relaunch ----------------
  const recoveryLogs = {};
  let recovery = { attempted: false, pid: null, error: null };
  if (!parsed.noRecovery) {
    recovery = spawnRecovery();
    if (recovery.error) {
      process.stderr.write(`restart-watchdog: recovery spawn failed: ${recovery.error}\n`);
    }
    recoveryLogs["restart-recovery.out.log"] = join(LOGS, `${RECOVERY_NAME}.out.log`);
    recoveryLogs["restart-recovery.err.log"] = join(LOGS, `${RECOVERY_NAME}.err.log`);
    // Poll while the recovery relaunch brings the stack back (timeboxed).
    const recDeadline = Date.now() + RECOVERY_WAIT_SEC * 1000;
    while (Date.now() < recDeadline) {
      const { web, auth } = await probeOnce();
      if (web.ok) poll.webUpAt ??= new Date().toISOString();
      if (auth.ok) poll.authUpAt ??= new Date().toISOString();
      if (web.ok && auth.ok) {
        const diagnostics = gatherDiagnostics(parsed.webPort, parsed.authPort, recoveryLogs);
        const finishedAt = new Date().toISOString();
        const report = buildReport({
          startedAt, finishedAt, outcome: "recovered", triggerNote: note,
          delaySec: parsed.delay, downWaitSec: parsed.downWait, timeoutSec: parsed.timeout,
          webPort: parsed.webPort, authPort: parsed.authPort, poll, recovery, diagnostics,
        });
        const { reportPath, markerPath } = writeOutputs(report);
        process.stdout.write(
          JSON.stringify({ outcome: "recovered", reportPath, markerPath, attempts: poll.attempts }) + "\n",
        );
        process.exit(0);
      }
      await sleep(POLL_INTERVAL_MS);
    }
  }

  const diagnostics = gatherDiagnostics(parsed.webPort, parsed.authPort, recoveryLogs);
  const finishedAt = new Date().toISOString();
  const report = buildReport({
    startedAt, finishedAt, outcome: "failed", triggerNote: note,
    delaySec: parsed.delay, downWaitSec: parsed.downWait, timeoutSec: parsed.timeout,
    webPort: parsed.webPort, authPort: parsed.authPort, poll, recovery, diagnostics,
  });
  const { reportPath, markerPath } = writeOutputs(report);
  process.stdout.write(
    JSON.stringify({ outcome: "failed", reportPath, markerPath, attempts: poll.attempts }) + "\n",
  );
  process.exit(0);
}

// Only run main() when this file is the program entry point. Importing the
// module (e.g. from a test file) MUST be side-effect-free so a test never
// triggers probes or a recovery restart.
const entry = process.argv[1] ? pathToFileURL(process.argv[1]).href : null;
if (entry === import.meta.url) main();
