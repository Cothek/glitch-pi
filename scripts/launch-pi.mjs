#!/usr/bin/env node
// launch-pi.mjs — Pi CLI launch path (Plan 2 §11 Phase 4).
//
// Sequence (order matters):
//   1. interface       — TUI or Web (remembers your last pick; Enter reuses it)
//   2. gitnexus-sync   — detached background index refresh (never blocks)
//   3. web stack       — ONLY for Web / --stack-only: pi-web-ui :8787 +
//                        auth-proxy :4103 (skip-if-alive), then tunnel ensure+verify
//   4. pi              — spawn Pi CLI in glitch-pi workspace (TUI mode only)
//
// Mode separation: TUI = terminal only (no web UI, no tunnel). Web = web UI only
// (no TUI here) plus its tunnel. A stack that is already running is left as-is.
//
// Tunnel verify treats HTTP 401/403 from the auth proxy as SUCCESS (stack is up,
// Basic auth is guarding it). Network failure / 5xx / no cloudflared = warn but
// still launch local Pi (remote access is non-blocking for CLI use).

import { existsSync, readFileSync, appendFileSync, mkdirSync, writeFileSync } from 'fs';
import { join, dirname, resolve } from 'path';
import { fileURLToPath } from 'url';
import { execFileSync, spawn } from 'child_process';
import { createInterface } from 'readline';
import { ensureTunnel, isCloudflaredRunning, tunnelHost } from './lib/tunnel.mjs';
import { printLoginBanner } from './lib/web-auth.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const SCRIPT_DIR = __dirname;
const ROOT_DIR = resolve(SCRIPT_DIR, '..');
// Portable default: the launcher's own repo root, so any install folder launches
// ITS OWN pi (engine + workspace + data all relative to it). GLITCH_PI_ROOT still
// overrides for restart tooling that pins a specific install. Identical behavior
// for the live install, where ROOT_DIR is the previously hardcoded path.
const PI_ROOT = process.env.GLITCH_PI_ROOT || ROOT_DIR;
const isWin = process.platform === 'win32';

const MAGENTA = '\x1b[35m';
const CYAN = '\x1b[36m';
const GREEN = '\x1b[32m';
const RED = '\x1b[31m';
const YELLOW = '\x1b[33m';
const DARK_GREEN = '\x1b[32;2m';
const DARK_YELLOW = '\x1b[33;2m';
const DARK_GRAY = '\x1b[90m';
const RESET = '\x1b[0m';

const LOG_FILE = join(ROOT_DIR, 'data', 'logs', 'launch-pi.log');

function log(color, msg) {
  if (msg === undefined) {
    console.log(color);
  } else {
    console.log(`${color}${msg}${RESET}`);
  }
  try {
    mkdirSync(join(ROOT_DIR, 'data', 'logs'), { recursive: true });
    const plain = msg === undefined ? '' : String(msg).replace(/\x1b\[[0-9;]*m/g, '');
    appendFileSync(LOG_FILE, `[${new Date().toISOString()}] ${plain}\n`, 'utf-8');
  } catch {
    // best-effort
  }
}

// Level-based logger adapter for scripts/lib/tunnel.mjs (info|ok|warn|dim).
const TUNNEL_LOG_COLORS = { info: CYAN, ok: DARK_GREEN, warn: YELLOW, dim: DARK_GRAY };
function tunnelLog(msg, level = 'info') {
  log(TUNNEL_LOG_COLORS[level] || CYAN, `  ${msg}`);
}

function run(cmd, args, opts = {}) {
  try {
    if (isWin && (cmd.endsWith('.cmd') || cmd.endsWith('.bat'))) {
      args = ['/d', '/s', '/c', cmd, ...args];
      cmd = 'cmd.exe';
    }
    const out = execFileSync(cmd, args, {
      encoding: 'utf-8',
      maxBuffer: 10 * 1024 * 1024,
      ...opts,
    });
    return { success: true, stdout: (out || '').toString().trim(), status: 0 };
  } catch (e) {
    return {
      success: false,
      stdout: ((e.stdout || '')).toString().trim(),
      stderr: ((e.stderr || '')).toString().trim(),
      error: e.message || String(e),
      status: e.status,
    };
  }
}

function pwsh(args, opts = {}) {
  return run('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', ...args], opts);
}

// ---- Pi interface choice (TUI vs Web) ----
// Stored alongside launch-unified.mjs's last_mode in user/launch-preference.json.
const PI_PREF_FILE = join(ROOT_DIR, 'data', 'launch-preference.json');
const PI_LEGACY_PREF_FILE = join(ROOT_DIR, 'user', 'launch-preference.json');

// Machine-local store: data/ is gitignored; the user/ memory repo is tracked
// and synced, so it must not hold launch selections. Legacy user/ file is a
// one-time migration read only.
function readPrefFile(path) {
  try {
    let content = readFileSync(path, 'utf-8');
    if (content.charCodeAt(0) === 0xFEFF) content = content.slice(1);
    return JSON.parse(content);
  } catch {
    return null;
  }
}

function readPiPref() {
  return readPrefFile(PI_PREF_FILE) || readPrefFile(PI_LEGACY_PREF_FILE);
}

function getSavedPiMode() {
  const pref = readPiPref();
  const m = pref && pref.last_pi_mode;
  return m === 'tui' || m === 'web' ? m : null;
}

// How the web stack is started: a visible window you close to stop it, or
// detached (CREATE_NO_WINDOW) so it outlives every shell. Remembered only when
// the user picks explicitly via --windowed / --headless.
function getSavedStackMode() {
  const pref = readPiPref();
  const m = pref && pref.pi_stack_mode;
  return m === 'windowed' || m === 'headless' ? m : null;
}

// Best-effort patch of user/launch-preference.json. Never throws: a preference
// write must not block a launch, but it does surface the failure.
function patchPiPref(patch) {
  try {
    const pref = readPiPref() || {};
    Object.assign(pref, patch, { saved_at: new Date().toISOString() });
    mkdirSync(dirname(PI_PREF_FILE), { recursive: true });
    writeFileSync(PI_PREF_FILE, JSON.stringify(pref, null, 2), 'utf-8');
  } catch (e) {
    log(DARK_GRAY, `  (stack preference not saved: ${e.message || e})`);
  }
}

function savePiMode(mode) {
  try {
    const pref = readPiPref() || {};
    pref.last_pi_mode = mode;
    pref.saved_at = new Date().toISOString();
    mkdirSync(dirname(PI_PREF_FILE), { recursive: true });
    writeFileSync(PI_PREF_FILE, JSON.stringify(pref, null, 2), 'utf-8');
  } catch (e) {
    // Best-effort — saving a preference must never block the launch. But a
    // SILENT failure would lose the remembered choice, so surface it instead.
    log(DARK_GRAY, `  (interface preference not saved: ${e.message || e})`);
  }
}

function askPiQuestion(query) {
  return new Promise((resolvePromise) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    rl.question(query, (answer) => {
      rl.close();
      resolvePromise(answer);
    });
  });
}

async function showPiModeMenu(savedMode) {
  log(MAGENTA, '');
  log(MAGENTA, ' Pi interface');
  log(MAGENTA, '');

  const options = [
    { id: 'tui', name: 'TUI', desc: 'terminal Pi CLI in this window (stack still runs for remote access)' },
    { id: 'web', name: 'Web', desc: 'pi-web-ui in the browser (stack runs, no TUI here)' },
  ];

  if (savedMode) {
    const saved = options.find(o => o.id === savedMode);
    log(CYAN, ` Last Pi interface: ${saved ? saved.name : savedMode}`);
    log(DARK_GRAY, ' Press Enter to keep it, or pick a different interface:');
    log('');
  }

  options.forEach((o, i) => {
    const marker = o.id === savedMode ? ' *' : '';
    log(CYAN, `  [${i + 1}] ${o.name}${marker}`);
    log(DARK_GRAY, `       ${o.desc}`);
    log('');
  });

  const prompt = savedMode
    ? `Pi interface (1-${options.length}, Enter for saved): `
    : `Pi interface (1-${options.length}): `;

  while (true) {
    const selection = await askPiQuestion(prompt);
    const raw = selection.trim();
    if (raw === '' && savedMode) return savedMode;
    const num = parseInt(raw, 10);
    if (!isNaN(num) && num >= 1 && num <= options.length) return options[num - 1].id;
    log(RED, `  Invalid selection. Enter 1-${options.length}${savedMode ? ' or press Enter to keep the saved interface' : ''}.`);
  }
}

// ---- 1. GitNexus sync (detached, same pattern as launch.mjs) ----
function startGitnexusSync() {
  try {
    const script = join(SCRIPT_DIR, 'gitnexus-sync.mjs');
    if (!existsSync(script)) {
      log(DARK_GRAY, '  gitnexus-sync.mjs not found — skipping');
      return;
    }
    const nodeBin = isWin
      ? (existsSync(join(ROOT_DIR, 'data', 'node', 'node.exe'))
          ? join(ROOT_DIR, 'data', 'node', 'node.exe')
          : 'node')
      : 'node';
    const proc = spawn(nodeBin, [script], {
      cwd: ROOT_DIR,
      stdio: 'ignore',
      detached: true,
      windowsHide: true,
    });
    proc.unref();
    proc.on('error', (err) => log(YELLOW, `  GitNexus sync failed to start: ${err.message}`));
    log(DARK_GREEN, `  GitNexus index sync started (PID ${proc.pid})`);
  } catch (e) {
    log(YELLOW, `  GitNexus sync skipped: ${e.message || e}`);
  }
}

// ---- 2. Pi stack (web-ui + auth proxy) ----
// windowed = one visible PowerShell window runs the whole stack; closing that
// window stops it. headless = start-detached.ps1 (CREATE_NO_WINDOW), survives
// closing every shell. Both wait for the ports to really bind before reporting,
// so a slow pi-web-ui boot is never logged as a failure.
function startPiStack({ windowed = false } = {}) {
  const statusScript = join(SCRIPT_DIR, 'start-pi-stack.ps1');
  if (!existsSync(statusScript)) {
    log(YELLOW, '  start-pi-stack.ps1 missing — skipping remote stack');
    return { webUi: false, authProxy: false };
  }
  const startArgs = ['-File', statusScript];
  if (windowed) startArgs.push('-Windowed');
  // Generous: the windowed path waits up to 60s for pi-web-ui + 20s for the
  // proxy, and the detached path polls the same way.
  const start = pwsh(startArgs, { timeout: 150000 });
  if (!start.success) {
    log(YELLOW, `  Pi stack start returned non-zero: ${start.stderr || start.error || start.stdout}`);
  }
  const status = pwsh(['-File', statusScript, '-Status'], { timeout: 15000 });
  const out = status.stdout || '';
  const webUi = /pi-web-ui\s+\(8787\):\s*UP/i.test(out);
  const authProxy = /auth-proxy\s+\(4103\):\s*UP/i.test(out);
  log(webUi ? DARK_GREEN : YELLOW, `  pi-web-ui  (8787): ${webUi ? 'UP' : 'DOWN'}`);
  log(authProxy ? DARK_GREEN : YELLOW, `  auth-proxy (4103): ${authProxy ? 'UP' : 'DOWN'}`);
  return { webUi, authProxy };
}

// ---- 3. Tunnel verify (non-blocking warn) ----
function verifyTunnel() {
  // cloudflared process
  const cloudflaredUp = isCloudflaredRunning();
  log(cloudflaredUp ? DARK_GREEN : YELLOW, `  cloudflared process: ${cloudflaredUp ? 'UP' : 'DOWN'}`);

  // Remote URL: 401/403 = auth proxy answering through tunnel = SUCCESS
  let remote = 'unreachable';
  try {
    const host = tunnelHost();
    const r = run(
      isWin ? 'curl.exe' : 'curl',
      ['-sS', '-o', isWin ? 'NUL' : '/dev/null', '-w', '%{http_code}', '--max-time', '8', `https://${host}/`],
      { timeout: 12000, stdio: ['ignore', 'pipe', 'ignore'] },
    );
    const code = (r.stdout || '').trim();
    if (code === '401' || code === '403' || code === '200') {
      remote = `HTTP ${code} (OK)`;
    } else if (code) {
      remote = `HTTP ${code}`;
    }
  } catch (e) {
    remote = `error: ${e.message || e}`;
  }
  const remoteOk = remote.includes('(OK)');
  log(remoteOk ? DARK_GREEN : YELLOW, `  tunnel remote: ${remote}`);
  if (!cloudflaredUp || !remoteOk) {
    log(DARK_YELLOW, '  Tunnel degraded — local Pi still launches.');
    log(DARK_GRAY, '  Check data\\logs\\cloudflared-tunnel.err.log or re-run: node scripts\\launch-pi.mjs --stack-only');
  }
}

// ---- 4. Spawn Pi CLI ----
function resolvePiCmd() {
  const candidates = [
    join(PI_ROOT, 'data', 'node', 'pi.cmd'),
    join(PI_ROOT, 'data', 'node', 'pi.ps1'),
    join(PI_ROOT, 'data', 'node', 'pi'),
  ];
  for (const c of candidates) {
    if (existsSync(c)) return c;
  }
  return null;
}

// Preferred: spawn node + cli.js directly with array args (no shell).
// A shell spawn of pi.cmd breaks on paths containing spaces — cmd.exe
// splits "E:\Glitch AI\..." and 'E:\Glitch' is not recognized.
function resolvePiInvocation() {
  const cliJs = join(PI_ROOT, 'data', 'node', 'node_modules', '@earendil-works', 'pi-coding-agent', 'dist', 'bundle', 'cli.js');
  const localNode = isWin
    ? join(PI_ROOT, 'data', 'node', 'node.exe')
    : join(PI_ROOT, 'data', 'node', 'node');
  if (existsSync(cliJs)) {
    if (existsSync(localNode)) return { command: localNode, args: [cliJs], desc: cliJs };
    if (process.execPath) return { command: process.execPath, args: [cliJs], desc: `${process.execPath} ${cliJs}` };
  }
  const piBin = resolvePiCmd();
  if (piBin) {
    if (isWin) {
      // Fallback: run pi.cmd through cmd.exe; Node quotes the path arg
      // (spaces-safe) and /s /c preserve the quoted command.
      return { command: 'cmd.exe', args: ['/d', '/s', '/c', piBin], desc: piBin };
    }
    return { command: piBin, args: [], desc: piBin };
  }
  return null;
}

function launchPiCli(extraArgs) {
  const inv = resolvePiInvocation();
  if (!inv) {
    log(RED, `  ERROR: pi CLI not found under ${PI_ROOT}\\data\\node\\`);
    log(YELLOW, '  Set GLITCH_PI_ROOT or install Pi into glitch-pi.');
    process.exit(1);
  }
  log(CYAN, `  Starting Pi (${inv.desc})...`);
  log('');
  return new Promise((resolvePromise) => {
    const child = spawn(inv.command, [...inv.args, ...extraArgs], {
      cwd: PI_ROOT,
      stdio: 'inherit',
      env: process.env,
      windowsHide: false,
      shell: false,
    });
    child.on('error', (err) => {
      log(RED, `  Pi failed to start: ${err.message}`);
      process.exit(1);
    });
    child.on('close', (code) => {
      resolvePromise(code ?? 0);
    });
  });
}

async function main() {
  const args = process.argv.slice(2);
  if (args.includes('--help') || args.includes('-h')) {
    console.log(`
  Glitch AI - Pi launch path

  Usage: node scripts/launch-pi.mjs [options]

  Options:
    --help, -h     Show this help
    --stack-only   Start gitnexus-sync + pi stack + tunnel auto-start, then exit
                   (does not spawn the Pi CLI)
    --tui          Skip the interface menu - launch the terminal Pi CLI
    --web          Skip the interface menu - run pi-web-ui only (no TUI)
    --windowed     Run the web stack in a visible window - CLOSE IT to stop the
                   stack (also remembered for next time)
    --headless     Run the web stack detached, no window (also remembered)

  The interface menu (TUI vs Web) remembers your last choice — press Enter to keep it.

  Web stack default: a visible window you CLOSE to stop the stack (the servers
  also show in the web UI's Background tasks panel); --headless runs detached
  with no window.

  Sequence: gitnexus-sync -> start-pi-stack -> tunnel verify -> pi
  Workspace: ${PI_ROOT}
  Override root: env GLITCH_PI_ROOT
    `);
    process.exit(0);
  }
  const stackOnly = args.includes('--stack-only');
  const wantTui = args.includes('--tui');
  const wantWeb = args.includes('--web');
  const wantWindowed = args.includes('--windowed');
  const wantHeadless = args.includes('--headless');

  log(MAGENTA, '');
  log(MAGENTA, ' Glitch AI - Pi Mode');
  log(MAGENTA, '');

  if (!existsSync(PI_ROOT)) {
    log(RED, `  ERROR: Pi workspace not found: ${PI_ROOT}`);
    process.exit(1);
  }

  // Interface choice: explicit flag > saved preference > interactive menu.
  // The saved pick is written ONLY on a real choice (flag or menu answer) —
  // non-TTY automation falls back to it without persisting, so a scripted run
  // can never clobber what the user last selected.
  let piMode = null;
  let modeChosen = false;
  if (stackOnly) {
    // stack-only: no interface, no prompt, no save
  } else if (wantTui) {
    piMode = 'tui';
    modeChosen = true;
  } else if (wantWeb) {
    piMode = 'web';
    modeChosen = true;
  } else if (process.env.GLITCH_REUSE_SAVED === '1' || args.includes('--reuse-saved')) {
    // Automation/restart: saved choice wins, 'web' fallback (the web stack is
    // the thing being restarted). Never persisted: reuse cannot clobber a real
    // pick. Distinct from the plain non-TTY fallback below (stays 'tui').
    piMode = getSavedPiMode() || 'web';
  } else if (process.stdin.isTTY) {
    piMode = await showPiModeMenu(getSavedPiMode());
    modeChosen = true;
  } else {
    piMode = getSavedPiMode() || 'tui';
  }
  if (modeChosen) savePiMode(piMode);
  if (piMode) log(DARK_GRAY, `  Pi interface: ${piMode}`);

  // How to run the web stack. Explicit flag wins and is remembered (same
  // contract as the interface mode); otherwise a console launch gets a visible
  // window Troy can close, and a no-console launch (extension, automation,
  // cron) stays detached because nobody is there to close a window.
  let stackMode;
  let stackModeChosen = false;
  if (wantWindowed) {
    stackMode = 'windowed';
    stackModeChosen = true;
  } else if (wantHeadless) {
    stackMode = 'headless';
    stackModeChosen = true;
  } else if (process.env.GLITCH_REUSE_SAVED === '1' || args.includes('--reuse-saved')) {
    // Restart/automation: saved stack mode wins, detached headless otherwise.
    stackMode = getSavedStackMode() || 'headless';
  } else {
    stackMode = getSavedStackMode() || (process.stdout.isTTY ? 'windowed' : 'headless');
  }
  if (stackModeChosen) patchPiPref({ pi_stack_mode: stackMode });

  startGitnexusSync();

  // Mode separation: the web stack (pi-web-ui :8787 + auth proxy :4103 +
  // Cloudflare tunnel) is started ONLY for Web mode and --stack-only. TUI mode
  // runs the terminal alone — and never touches a stack that is already up.
  if (stackOnly || piMode === 'web') {
    log(DARK_GRAY, stackMode === 'windowed'
      ? '  Web stack: visible window (close it to stop the stack)'
      : '  Web stack: detached, no window (stop from the Background tasks panel or scripts\\stop-pi-stack.ps1)');
    startPiStack({ windowed: stackMode === 'windowed' });
    await ensureTunnel(tunnelLog);
    verifyTunnel();
  } else {
    log(DARK_GRAY, '  TUI mode — no web UI, no tunnel (choose Web for remote access)');
  }

  if (stackOnly) {
    log(GREEN, '  Stack-only mode complete.');
    // Console-only login banner (kept out of data/logs/launch-pi.log).
    printLoginBanner({ color: true });
    process.exit(0);
  }

  if (piMode === 'web') {
    log(GREEN, '  Pi is running in Web mode.');
    log(CYAN, `  Local:  http://localhost:8787`);
    log(DARK_GRAY, `  Remote: https://${tunnelHost()}`);
    // Login banner goes to the console ONLY - never to data/logs/launch-pi.log,
    // so the password is not duplicated into another plaintext file.
    printLoginBanner({ color: true });
    log(DARK_GRAY, '  (credentials printed above; stored in .server-password)');
    if (stackMode === 'windowed') {
      log(DARK_GRAY, '  Stop it by CLOSING the Pi web UI window (Ctrl+C in it also works).');
    } else {
      log(DARK_GRAY, '  Stop it: Background tasks panel (stack root -> Stop) or scripts\\stop-pi-stack.ps1');
    }
    log(MAGENTA, '');
    process.exit(0);
  }

  const code = await launchPiCli(args.filter((a) =>
    a !== '--stack-only' && a !== '--tui' && a !== '--web' && a !== '--windowed' && a !== '--headless'));
  log(MAGENTA, '');
  log(MAGENTA, ' Pi session ended.');
  process.exit(code);
}

main().catch((e) => {
  log(RED, `  Fatal error: ${e.message || e}`);
  process.exit(1);
});
