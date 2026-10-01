#!/usr/bin/env node
/**
 * scripts/restart-request.mjs
 *
 * Files a restart request and hands it to scripts/start-detached.ps1, which
 * truly detaches the restart engine (scripts/restart-pi-stack.ps1) from the
 * caller's Job Object. This script MUST return within about a second because
 * the child it starts is going to kill the process tree it was called from
 * (pi-web-ui, which hosts the agent session).
 *
 * Also launches scripts/restart-watchdog.mjs detached, AFTER the engine spawn
 * succeeded: a detached watchdog that survives the kill, verifies the stack
 * came back, writes data/monitor/restart-report-<ts>.json + restart-status.json,
 * and attempts exactly one recovery relaunch on failure. The watchdog launch is
 * additive: if it fails, the restart request still succeeds (a warning goes to
 * stderr and the JSON output carries watchdogSpawned: false). Opt out with
 * --no-watchdog.
 *
 * Two call sites:
 *   - pi-web-ui plugin (POST /restart): plain restart, no resume. The plugin
 *     already knows the session file if needed, but the UI never passes one.
 *     The plugin may pass --apply-updates to run scripts/check-updates.mjs
 *     before the kill.
 *   - agent shell: `node scripts/restart-request.mjs --resume --note "..."`.
 *     With --resume, --session <jsonl> is required (or PI_SESSION_FILE in env).
 *     mtime is unreliable, so we never guess: two session files in one project
 *     carry identical mtimes.
 *
 * Exit codes:
 *   0 success
 *   1 spawn failure
 *   2 bad arguments or unresolved session
 */
import { execFileSync } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const RESTART = join(ROOT, "scripts", "restart-pi-stack.ps1");
const DETACH = join(ROOT, "scripts", "start-detached.ps1");
const LOGS = join(ROOT, "data", "logs");
const NAME = "restart-stack";
const WATCHDOG = join(ROOT, "scripts", "restart-watchdog.mjs");
const WATCHDOG_NAME = "restart-watchdog";
const WATCHDOG_TIMEOUT_SEC = 180;

const DEFAULT_NOTE = "Server restarted on request. Continue where you left off.";
// Appended to every resume note so the post-restart session reads the
// watchdog's status marker instead of assuming the restart worked.
// Metacharacter-free on purpose: the note lands inside double quotes in a
// generated .cmd file parsed by cmd.exe (see sanitizeNote).
const HEALTH_HINT = " After the stack is back, read data/monitor/restart-status.json to confirm restart health.";
const DEFAULT_DELAY = 15;
const MAX_DELAY = 120;
const MAX_NOTE = 300;

/**
 * Reject session values that would survive cmd.exe parsing unchanged and
 * let a network attacker inject arbitrary commands.
 *
 * The session path lands inside double-quotes in buildInnerCommand, and
 * start-detached.ps1 writes the whole command verbatim into a generated
 * .cmd file that cmd.exe parses. A `"` closes the quote, a `%` triggers
 * variable expansion, `^` is the cmd.exe escape, `& | < >` chain commands
 * or redirect IO, and CR / LF break out of the batch line.
 *
 * Returns true when the value is non-empty AND contains none of those
 * characters. Empty values are refused (the caller is asking to send
 * nothing through a quoted string — fail loudly).
 *
 * Pure: no FS, no env, no spawning. The test imports this with zero side
 * effects.
 */
export function isSafeSessionValue(value) {
  if (value == null) return false;
  const s = String(value);
  if (s.length === 0) return false;
  return !/["%^&|<>\r\n]/.test(s);
}

/**
 * Strip shell metacharacters and collapse whitespace from the note text.
 *
 * WHY so aggressive: the note is written verbatim into a generated .cmd file
 * by start-detached.ps1, then parsed by cmd.exe. A stray `"` ends the quote,
 * a `%VAR%` is expanded by cmd.exe, `&` `|` `<` `>` chain commands or
 * redirect IO, `^` is cmd.exe's escape char, CR/LF break out of the line.
 * The text must be safe to embed between two double-quotes and survive cmd.exe
 * parsing without altering the meaning of the surrounding command.
 */
export function sanitizeNote(text) {
  if (text == null) return "";
  const s = String(text)
    .replace(/["%^&|<>\r\n]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return s.length > MAX_NOTE ? s.slice(0, MAX_NOTE) : s;
}

/**
 * Build the powershell.exe command line that runs the restart engine.
 *
 * The inner command is what start-detached.ps1 will run detached. It invokes
 * restart-pi-stack.ps1 with -DelaySec and, when present, -ContinuePath plus
 * -ContinueText. Every path is wrapped in double-quotes; the inner command is
 * itself emitted as a single argument of powershell.exe so cmd.exe parsing on
 * the way down does not see the embedded quotes as terminators.
 *
 * Pure: no FS, no env, no spawning. The test imports this with zero side
 * effects.
 */
export function buildInnerCommand({ root, delaySec, continuePath, continueId, continueText, applyUpdates }) {
  const r = String(root ?? "");
  const d = Math.max(0, Math.floor(Number(delaySec) || 0));
  const ps = join(r, "scripts", "restart-pi-stack.ps1");
  let cmd = `powershell.exe -NoProfile -ExecutionPolicy Bypass -File "${ps}" -DelaySec ${d}`;
  // The continuation rule: the engine accepts either a path (-ContinuePath)
  // or a live conversation id (-ContinueId), paired with a continuation
  // text. We only emit one of the two, never both, never either alone.
  if (continueText) {
    if (continuePath) {
      cmd += ` -ContinuePath "${continuePath}" -ContinueText "${continueText}"`;
    } else if (continueId) {
      cmd += ` -ContinueId "${continueId}" -ContinueText "${continueText}"`;
    }
  }
  // -ApplyUpdates: the engine runs scripts/check-updates.mjs --apply --yes
  // BEFORE the kill and continues the restart even on a checker failure.
  // We only emit the switch when applyUpdates is truthy, so the default
  // plain-restart path is byte-identical to its prior output.
  if (applyUpdates) {
    cmd += ` -ApplyUpdates`;
  }
  return cmd;
}

/**
 * Build the command line that runs the post-restart watchdog. Mirrors the
 * engine's -DelaySec so the watchdog's phase-1 deadline (delay + down-wait)
 * lines up with the engine's kill window. Timeout clamped to 30..600, ports
 * clamped to 1..65535, note re-sanitized (idempotent) and only emitted when
 * non-empty. Pure: no FS, no env, no spawning.
 */
export function buildWatchdogCommand({ root, nodeExe, delaySec, webPort, authPort, timeoutSec, note }) {
  const r = String(root ?? "");
  const node = String(nodeExe ?? "");
  const d = Math.max(0, Math.floor(Number(delaySec) || 0));
  const w = Math.max(1, Math.floor(Number(webPort) || 8787));
  const a = Math.max(1, Math.floor(Number(authPort) || 4103));
  const t = Math.min(600, Math.max(30, Math.floor(Number(timeoutSec) || WATCHDOG_TIMEOUT_SEC)));
  let cmd = `"${node}" "${join(r, "scripts", "restart-watchdog.mjs")}" --delay ${d} --timeout ${t} --web-port ${w} --auth-port ${a}`;
  const n = sanitizeNote(note ?? "");
  if (n) cmd += ` --note "${n}"`;
  return cmd;
}

/**
 * Resolve the continuation note that will be passed to the restart engine.
 *
 * Pure: no FS, no env, no spawning. Pulled out of main() so the B3 fallback
 * rule (empty-after-sanitize -> DEFAULT_NOTE) is testable without spawning.
 * The resolved note always carries the health hint that tells the resumed
 * session to read the watchdog's status marker.
 */
export function resolveResumeNote(parsed) {
  if (!parsed?.resume) return "";
  const base = sanitizeNote(parsed.note ?? "") || DEFAULT_NOTE;
  return base + HEALTH_HINT;
}

/**
 * Tiny argv parser. Each flag is one shot: --resume is a switch, --note and
 * --session take the next token, --delay takes the next token as a number.
 * Unknown flags produce a structured error so the caller can exit 2 cleanly.
 * Returns an object plus an `error` string; caller decides the exit code.
 */
export function parseArgs(argv) {
  const out = {
    resume: false,
    note: null,
    delay: DEFAULT_DELAY,
    session: null,
    sessionId: null,
    applyUpdates: false,
    noWatchdog: false,
    json: false,
    dryRun: false,
    help: false,
    error: null,
  };
  const args = Array.isArray(argv) ? argv.slice() : [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--resume") {
      out.resume = true;
    } else if (a === "--note") {
      const v = args[++i];
      if (v === undefined) {
        out.error = "--note requires a value";
        return out;
      }
      out.note = v;
    } else if (a === "--delay") {
      const v = args[++i];
      const n = Number(v);
      if (!Number.isFinite(n) || n < 0 || n > MAX_DELAY) {
        out.error = `--delay must be 0..${MAX_DELAY} (got ${v})`;
        return out;
      }
      out.delay = Math.floor(n);
    } else if (a === "--session") {
      const v = args[++i];
      if (v === undefined) {
        out.error = "--session requires a path";
        return out;
      }
      out.session = v;
    } else if (a === "--session-id") {
      const v = args[++i];
      if (v === undefined) {
        out.error = "--session-id requires a value";
        return out;
      }
      out.sessionId = v;
    } else if (a === "--apply-updates") {
      out.applyUpdates = true;
    } else if (a === "--no-watchdog") {
      out.noWatchdog = true;
    } else if (a === "--json") {
      out.json = true;
    } else if (a === "--dry-run") {
      out.dryRun = true;
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
    "Usage: node scripts/restart-request.mjs [flags]",
    "",
    "Flags:",
    "  --resume            resume the current conversation after restart",
    "  --note <text>       continuation prompt (default: built-in)",
    "  --delay <sec>       seconds before the kill (default 15, max 120)",
    "  --session <path>    session jsonl path (overrides PI_SESSION_FILE)",
    "  --session-id <id>   live conversation id (rarely stable)",
    "  --apply-updates     run scripts/check-updates.mjs --apply --yes before the kill",
    "  --no-watchdog       skip the post-restart health watchdog",
    "  --json              print one JSON object instead of a short line",
    "  --dry-run           print the inner command, do not spawn",
    "  --help, -h          show this help",
    "",
    "Resume resolution: --session, else PI_SESSION_FILE. mtime is not used.",
    "Exits 2 when --resume is set and no session file can be resolved.",
  ].join("\n");
  process.stdout.write(text + "\n");
}

function readPidFile() {
  const f = join(LOGS, `${NAME}.pid`);
  if (!existsSync(f)) return null;
  try {
    const v = String(readFileSync(f, "utf8")).trim();
    return /^\d+$/.test(v) ? Number(v) : null;
  } catch {
    return null;
  }
}

function main() {
  const parsed = parseArgs(process.argv.slice(2));
  if (parsed.help) {
    printHelp();
    process.exit(0);
  }
  if (parsed.error) {
    process.stderr.write(`restart-request: ${parsed.error}\n`);
    process.exit(2);
  }

  let sessionFile = null;
  let sessionId = null;
  if (parsed.resume) {
    sessionFile = parsed.session || process.env.PI_SESSION_FILE || "";
    sessionId = parsed.sessionId || "";
    // B2: --session-id is a usable target on its own. Exit 2 only when
    // --resume is set AND no path AND no id can be resolved.
    if (!sessionFile && !sessionId) {
      process.stderr.write(
        "no session file: pass --session or --session-id, or run with PI_SESSION_FILE set\n",
      );
      process.exit(2);
    }
    // H1 residual: reject unsafe values before they reach the command.
    // A LAN-reachable HTTP route used to forward --session verbatim; we
    // still need the guard at this layer because the slash command and
    // the CLI also feed the same pipeline.
    if (sessionFile && !isSafeSessionValue(sessionFile)) {
      process.stderr.write(
        "restart-request: --session contains a shell metacharacter (one of \" % ^ & | < > CR LF); refusing\n",
      );
      process.exit(2);
    }
    if (sessionId && !isSafeSessionValue(sessionId)) {
      process.stderr.write(
        "restart-request: --session-id contains a shell metacharacter (one of \" % ^ & | < > CR LF); refusing\n",
      );
      process.exit(2);
    }
    // And require the file to exist before it ever reaches the command.
    // A user-supplied path that does not exist would crash the launcher
    // mid-restart; refuse early with a clean exit code.
    if (sessionFile && !existsSync(sessionFile)) {
      process.stderr.write("restart-request: session file not found\n");
      process.exit(2);
    }
  }

  // B3: when --resume is set and the note sanitizes to empty (e.g. --note ""),
  // fall back to DEFAULT_NOTE so the resume actually carries a continuation.
  // Logic lives in resolveResumeNote so the test can lock the rule.
  const note = resolveResumeNote(parsed);
  const delay = parsed.delay;

  const inner = buildInnerCommand({
    root: ROOT,
    delaySec: delay,
    continuePath: sessionFile || "",
    continueId: sessionId || "",
    continueText: note,
    applyUpdates: parsed.applyUpdates,
  });

  // Post-restart watchdog command (shown in --dry-run; spawned below).
  // Mirrors the engine delay so the watchdog's phase-1 deadline lines up with
  // the engine's kill window.
  const watchdogCommand = parsed.noWatchdog
    ? null
    : buildWatchdogCommand({
        root: ROOT,
        nodeExe: process.execPath,
        delaySec: delay,
        note: parsed.note,
      });

  const pidFile = join(LOGS, `${NAME}.pid`);
  const outLog = join(LOGS, `${NAME}.out.log`);
  const errLog = join(LOGS, `${NAME}.err.log`);

  if (parsed.dryRun) {
    if (parsed.json) {
      const payload = {
        ok: true,
        mode: parsed.resume ? "resume" : "plain",
        delaySeconds: delay,
        sessionFile: sessionFile || null,
        sessionId: sessionId || null,
        applyUpdates: parsed.applyUpdates === true,
        innerCommand: inner,
        pid: null,
        outLog,
        errLog,
        pidFile,
        watchdogSpawned: null,
        watchdogCommand,
      };
      process.stdout.write(JSON.stringify(payload) + "\n");
    } else {
      process.stdout.write(
        `dry-run: would spawn detached "${inner}" (logs: ${outLog})\n` +
          `watchdog: ${watchdogCommand ?? "disabled (--no-watchdog)"}\n`,
      );
    }
    process.exit(0);
  }

  let spawnErr = null;
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
        inner,
        "-Name",
        NAME,
      ],
      { timeout: 20_000, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] },
    );
  } catch (err) {
    spawnErr = err;
  }

  if (spawnErr) {
    if (parsed.json) {
      process.stdout.write(
        JSON.stringify({
          ok: false,
          error: spawnErr?.message ?? String(spawnErr),
        }) + "\n",
      );
    } else {
      process.stderr.write(`restart-request: spawn failed: ${spawnErr?.message ?? spawnErr}\n`);
    }
    process.exit(1);
  }

  // ---- Post-restart watchdog (additive: never blocks or fails the request) ----
  // Launched AFTER the engine spawn succeeded: the engine is already queued,
  // so a watchdog failure is a warning, not a failed restart request. The
  // watchdog runs detached via the same start-detached.ps1 mechanism as the
  // engine, so it survives the kill of this process tree.
  let watchdogSpawned = false;
  let watchdogError = null;
  if (watchdogCommand) {
    if (!isSafeSessionValue(process.execPath) || !isSafeSessionValue(WATCHDOG)) {
      watchdogError = "watchdog path contains a shell metacharacter; skipped";
    } else {
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
            watchdogCommand,
            "-Name",
            WATCHDOG_NAME,
          ],
          { timeout: 20_000, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] },
        );
        watchdogSpawned = true;
      } catch (err) {
        watchdogError = err?.message ?? String(err);
      }
    }
  }
  if (watchdogError) {
    process.stderr.write(`restart-request: watchdog not launched: ${watchdogError}\n`);
  }

  const pid = readPidFile();
  if (parsed.json) {
    process.stdout.write(
      JSON.stringify({
        ok: true,
        mode: parsed.resume ? "resume" : "plain",
        delaySeconds: delay,
        sessionFile: sessionFile || null,
        sessionId: sessionId || null,
        applyUpdates: parsed.applyUpdates === true,
        innerCommand: inner,
        pid,
        outLog,
        errLog,
        pidFile,
        watchdogSpawned,
        watchdogCommand,
      }) + "\n",
    );
  } else {
    process.stdout.write(
      `restart queued${parsed.resume ? " (resume)" : ""}${parsed.applyUpdates ? " (+updates)" : ""} delay=${delay}s pid=${pid ?? "?"} log=${outLog}${watchdogSpawned ? " +watchdog" : ""}\n`,
    );
  }
  process.exit(0);
}

// Only run main() when this file is the program entry point. Importing the
// module (e.g. from the test file) MUST be side-effect-free so a test never
// triggers an actual restart - that would kill the very agent session doing
// the work.
import { pathToFileURL } from "node:url";
const entry = process.argv[1] ? pathToFileURL(process.argv[1]).href : null;
if (entry === import.meta.url) main();
