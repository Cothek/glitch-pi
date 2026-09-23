#!/usr/bin/env node
// launch-pi.mjs — Pi CLI launch path (Plan 2 §11 Phase 4).
//
// Sequence (order matters):
//   1. gitnexus-sync   — detached background index refresh (never blocks)
//   2. start-pi-stack  — pi-web-ui :8787 + auth-proxy :4103 (skip-if-alive)
//   3. tunnel verify   — cloudflared process + https://pi.cothekdesigns.com reachability
//   4. pi              — spawn Pi CLI in glitch-pi workspace
//
// Tunnel verify treats HTTP 401/403 from the auth proxy as SUCCESS (stack is up,
// Basic auth is guarding it). Network failure / 5xx / no cloudflared = warn but
// still launch local Pi (remote access is non-blocking for CLI use).

import { existsSync, readFileSync, appendFileSync, mkdirSync } from 'fs';
import { join, dirname, resolve } from 'path';
import { fileURLToPath } from 'url';
import { execFileSync, spawn } from 'child_process';

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

// ---- 3. Tunnel verify (non-blocking warn) ----
function verifyTunnel() {
  // cloudflared process
  let cloudflaredUp = false;
  try {
    if (isWin) {
      const out = execFileSync('tasklist', ['/NH', '/FI', 'IMAGENAME eq cloudflared.exe'], {
        encoding: 'utf-8',
        timeout: 5000,
      });
      cloudflaredUp = out.includes('cloudflared.exe');
    }
  } catch {
    cloudflaredUp = false;
  }
  log(cloudflaredUp ? DARK_GREEN : YELLOW, `  cloudflared process: ${cloudflaredUp ? 'UP' : 'DOWN'}`);

  // Remote URL: 401/403 = auth proxy answering through tunnel = SUCCESS
  let remote = 'unreachable';
  try {
    const domainFile = join(ROOT_DIR, 'data', 'cloudflare-domain.txt');
    let host = 'pi.cothekdesigns.com';
    if (existsSync(domainFile)) {
      const d = readFileSync(domainFile, 'utf-8').trim();
      if (d) host = d;
    }
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
    log(DARK_YELLOW, '  Tunnel degraded — local Pi still launches. Run scripts\\setup-tunnel.ps1 to repair.');
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

function launchPiCli(extraArgs) {
  const piBin = resolvePiCmd();
  if (!piBin) {
    log(RED, `  ERROR: pi CLI not found under ${PI_ROOT}\\data\\node\\`);
    log(YELLOW, '  Set GLITCH_PI_ROOT or install Pi into glitch-pi.');
    process.exit(1);
  }
  log(CYAN, `  Starting Pi (${piBin})...`);
  log('');
  return new Promise((resolvePromise) => {
    // Windows: .cmd/.bat must go through a shell (Node EINVAL without it).
    const spawnOpts = {
      cwd: PI_ROOT,
      stdio: 'inherit',
      env: process.env,
      windowsHide: false,
      ...(isWin && /\.(cmd|bat)$/i.test(piBin) ? { shell: true } : {}),
    };
    const child = spawn(piBin, extraArgs, spawnOpts);
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
    --stack-only   Start gitnexus-sync + pi stack + tunnel verify, then exit
                   (does not spawn the Pi CLI)

  Sequence: gitnexus-sync -> start-pi-stack -> tunnel verify -> pi
  Workspace: ${PI_ROOT}
  Override root: env GLITCH_PI_ROOT
    `);
    process.exit(0);
  }
  const stackOnly = args.includes('--stack-only');

  log(MAGENTA, '');
  log(MAGENTA, ' Glitch AI - Pi Mode');
  log(MAGENTA, '');

  if (!existsSync(PI_ROOT)) {
    log(RED, `  ERROR: Pi workspace not found: ${PI_ROOT}`);
    process.exit(1);
  }

  startGitnexusSync();
  startPiStack();
  verifyTunnel();

  if (stackOnly) {
    log(GREEN, '  Stack-only mode complete.');
    process.exit(0);
  }

  const code = await launchPiCli(args.filter((a) => a !== '--stack-only'));
  log(MAGENTA, '');
  log(MAGENTA, ' Pi session ended.');
  process.exit(code);
}

main().catch((e) => {
  log(RED, `  Fatal error: ${e.message || e}`);
  process.exit(1);
});
