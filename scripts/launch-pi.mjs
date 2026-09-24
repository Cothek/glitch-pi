#!/usr/bin/env node
// launch-pi.mjs — Pi CLI launch path (Plan 2 §11 Phase 4).
//
// Sequence (order matters):
//   1. gitnexus-sync   — detached background index refresh (never blocks)
//   2. start-pi-stack  — pi-web-ui :8787 + auth-proxy :4103 (skip-if-alive)
//   3. tunnel ensure   — auto-start cloudflared detached (skip-if-alive), then verify
//   4. pi              — spawn Pi CLI in glitch-pi workspace
//
// Tunnel verify treats HTTP 401/403 from the auth proxy as SUCCESS (stack is up,
// Basic auth is guarding it). Network failure / 5xx / no cloudflared = warn but
// still launch local Pi (remote access is non-blocking for CLI use).

import { existsSync, readFileSync, appendFileSync, mkdirSync, writeFileSync, openSync } from 'fs';
import { join, dirname, resolve } from 'path';
import { fileURLToPath } from 'url';
import { execFileSync, spawn } from 'child_process';
import { createInterface } from 'readline';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const SCRIPT_DIR = __dirname;
const ROOT_DIR = resolve(SCRIPT_DIR, '..');
const PI_ROOT = process.env.GLITCH_PI_ROOT || 'E:\\Glitch AI\\glitch-pi';
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
const PI_PREF_FILE = join(ROOT_DIR, 'user', 'launch-preference.json');

function readPiPref() {
  try {
    let content = readFileSync(PI_PREF_FILE, 'utf-8');
    if (content.charCodeAt(0) === 0xFEFF) content = content.slice(1);
    return JSON.parse(content);
  } catch {
    return null;
  }
}

function getSavedPiMode() {
  const pref = readPiPref();
  const m = pref && pref.last_pi_mode;
  return m === 'tui' || m === 'web' ? m : null;
}

function savePiMode(mode) {
  try {
    const pref = readPiPref() || {};
    pref.last_pi_mode = mode;
    pref.saved_at = new Date().toISOString();
    mkdirSync(dirname(PI_PREF_FILE), { recursive: true });
    writeFileSync(PI_PREF_FILE, JSON.stringify(pref, null, 2), 'utf-8');
  } catch {
    // best-effort — saving a preference must never block the launch
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
function startPiStack() {
  const statusScript = join(SCRIPT_DIR, 'start-pi-stack.ps1');
  if (!existsSync(statusScript)) {
    log(YELLOW, '  start-pi-stack.ps1 missing — skipping remote stack');
    return { webUi: false, authProxy: false };
  }
  const start = pwsh(['-File', statusScript], { timeout: 60000 });
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

// ---- 3a. Tunnel ensure (auto-start, skip-if-alive) ----
// The tunnel is owned by the mainline glitch-ai repo: cloudflared.exe and
// config/cloudflared-config.yml live there (one Cloudflare tunnel serves the
// glitch / trader / pi hostnames). When Pi runs standalone from glitch-pi,
// resolve those assets via the sibling directory. Env overrides for custom
// layouts: GLITCH_TUNNEL_BIN, GLITCH_TUNNEL_CONFIG.
function resolveTunnelAsset(explicit, relPath) {
  const candidates = [
    explicit,
    join(ROOT_DIR, relPath),
    join(dirname(ROOT_DIR), 'glitch-ai', relPath),
  ].filter(Boolean);
  for (const c of candidates) if (existsSync(c)) return c;
  return null;
}

function tunnelHost() {
  try {
    const domainFile = join(ROOT_DIR, 'data', 'cloudflare-domain.txt');
    if (existsSync(domainFile)) {
      const d = readFileSync(domainFile, 'utf-8').trim();
      if (d) return d;
    }
  } catch {}
  return 'pi.cothekdesigns.com';
}

function isCloudflaredRunning() {
  // Fast path: PID file written by a previous ensureTunnel() spawn.
  try {
    const pidFile = join(ROOT_DIR, 'data', 'cloudflared-auto.pid');
    if (existsSync(pidFile)) {
      const pid = parseInt(readFileSync(pidFile, 'utf-8').trim(), 10);
      if (!isNaN(pid) && pid > 0) {
        try { process.kill(pid, 0); return true; } catch {}
      }
    }
  } catch {}
  // Image-name scan (also covers tunnels started by server mode / other tools).
  try {
    if (isWin) {
      const out = execFileSync('tasklist', ['/NH', '/FI', 'IMAGENAME eq cloudflared.exe'], {
        encoding: 'utf-8',
        timeout: 5000,
      });
      return out.includes('cloudflared.exe');
    }
    execFileSync('pgrep', ['-x', 'cloudflared'], { encoding: 'utf-8', timeout: 5000 });
    return true;
  } catch {
    return false;
  }
}

async function ensureTunnel() {
  if (isCloudflaredRunning()) {
    log(DARK_GREEN, '  cloudflared already running — leaving tunnel as-is');
    return;
  }
  const bin = resolveTunnelAsset(process.env.GLITCH_TUNNEL_BIN, isWin ? 'cloudflared.exe' : 'cloudflared');
  const cfg = resolveTunnelAsset(process.env.GLITCH_TUNNEL_CONFIG, join('config', 'cloudflared-config.yml'));
  if (!bin || !cfg) {
    log(YELLOW, '  cloudflared binary or tunnel config not found — auto-start skipped');
    log(DARK_GRAY, '  (expected in sibling glitch-ai; set GLITCH_TUNNEL_BIN / GLITCH_TUNNEL_CONFIG)');
    return;
  }
  log(CYAN, '  Starting Cloudflare Tunnel (detached)...');
  try {
    const logDir = join(ROOT_DIR, 'data', 'logs');
    mkdirSync(logDir, { recursive: true });
    const outFd = openSync(join(logDir, 'cloudflared-tunnel.out.log'), 'a');
    const errFd = openSync(join(logDir, 'cloudflared-tunnel.err.log'), 'a');
    const child = spawn(bin, ['tunnel', '--config', cfg, 'run'], {
      detached: true,
      stdio: ['ignore', outFd, errFd],
      windowsHide: true,
    });
    child.unref();
    try {
      writeFileSync(join(ROOT_DIR, 'data', 'cloudflared-auto.pid'), String(child.pid), 'utf-8');
    } catch {}
    log(DARK_GRAY, `  cloudflared spawned (PID ${child.pid}) — waiting for tunnel...`);
    const host = tunnelHost();
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    for (let attempt = 0; attempt < 4; attempt++) {
      await sleep(3000);
      try {
        const r = run(
          isWin ? 'curl.exe' : 'curl',
          ['-sS', '-o', isWin ? 'NUL' : '/dev/null', '-w', '%{http_code}', '--max-time', '5', `https://${host}/`],
          { timeout: 8000, stdio: ['ignore', 'pipe', 'ignore'] },
        );
        const code = (r.stdout || '').trim();
        if (code === '401' || code === '403' || code === '200') {
          log(DARK_GREEN, `  tunnel remote: HTTP ${code} (OK)`);
          return;
        }
      } catch {}
    }
    log(YELLOW, '  tunnel not answering yet — verifyTunnel() will report the final status');
  } catch (e) {
    log(YELLOW, `  tunnel auto-start failed: ${e.message || e}`);
  }
}

// ---- 3b. Tunnel verify (non-blocking warn) ----
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

  The interface menu (TUI vs Web) remembers your last choice — press Enter to keep it.

  Sequence: gitnexus-sync -> start-pi-stack -> tunnel verify -> pi
  Workspace: ${PI_ROOT}
  Override root: env GLITCH_PI_ROOT
    `);
    process.exit(0);
  }
  const stackOnly = args.includes('--stack-only');
  const wantTui = args.includes('--tui');
  const wantWeb = args.includes('--web');

  log(MAGENTA, '');
  log(MAGENTA, ' Glitch AI - Pi Mode');
  log(MAGENTA, '');

  if (!existsSync(PI_ROOT)) {
    log(RED, `  ERROR: Pi workspace not found: ${PI_ROOT}`);
    process.exit(1);
  }

  // Interface choice: explicit flag > saved preference > interactive menu.
  // Non-TTY (automation) falls back to the saved choice, then TUI.
  let piMode = null;
  if (wantTui) piMode = 'tui';
  else if (wantWeb) piMode = 'web';
  else if (process.stdin.isTTY) piMode = await showPiModeMenu(getSavedPiMode());
  else piMode = getSavedPiMode() || 'tui';
  savePiMode(piMode);
  log(DARK_GRAY, `  Pi interface: ${piMode}`);

  startGitnexusSync();
  startPiStack();
  await ensureTunnel();
  verifyTunnel();

  if (stackOnly) {
    log(GREEN, '  Stack-only mode complete.');
    process.exit(0);
  }

  if (piMode === 'web') {
    log(GREEN, '  Pi is running in Web mode.');
    log(CYAN, '  Local:  http://localhost:8787');
    log(DARK_GRAY, '  Remote: https://pi.cothekdesigns.com  (auth via .server-password)');
    log(DARK_GRAY, '  Stop it from the web UI (/pi-web-ui:quit) or by killing the :8787 listener.');
    log(MAGENTA, '');
    process.exit(0);
  }

  const code = await launchPiCli(args.filter((a) => a !== '--stack-only' && a !== '--tui' && a !== '--web'));
  log(MAGENTA, '');
  log(MAGENTA, ' Pi session ended.');
  process.exit(code);
}

main().catch((e) => {
  log(RED, `  Fatal error: ${e.message || e}`);
  process.exit(1);
});
