#!/usr/bin/env node
// scripts/lib/tunnel.mjs — Cloudflare tunnel ensure logic (shared).
//
// Consumers:
//   - scripts/launch-pi.mjs                (import: ensureTunnel at launch)
//   - scripts/start-pi-stack.ps1            (CLI: start, after both ports bind)
//   - scripts/stop-pi-stack.ps1             (CLI: stop, same teardown)
//   - .pi/extensions/tunnel-keeper.ts       (spawn: CLI, session-start + periodic)
//
// CLI:  node scripts/lib/tunnel.mjs [start|stop|status] [--reason <label>]
//   (no verb)  ensure  - skip-if-alive, else spawn detached; always exit 0
//   start              - ensure, but exit 0 only when cloudflared is running
//   stop               - stop the tunnel THIS repo started (pidfile owners only)
//   status             - one line; exit 0 = up, 1 = down
//
// A fresh spawn logs to data/logs/cloudflared-tunnel.{out,err}.log, writes
// data/cloudflared-auto.pid, polls the remote URL up to 12s for HTTP
// 401/403/200, and logs each step to data/logs/tunnel-keeper.log.
//
// Ownership: the whole remote-access stack lives in THIS repo (glitch-pi).
//   cloudflared.exe + config/cloudflared-config.yml are in the repo root
//   (both gitignored). One Cloudflare tunnel (credentials in
//   ~/.cloudflared/<uuid>.json — user-level, never inside a repo) serves the
//   glitch / trader hostnames (pi.* kept as a legacy alias); glitch.cothekdesigns.com → auth-proxy :4103
//   → pi-web-ui :8787.

import { existsSync, readFileSync, writeFileSync, openSync, mkdirSync, appendFileSync, unlinkSync } from 'fs';
import { join, dirname, resolve } from 'path';
import { fileURLToPath } from 'url';
import { execFileSync, spawn } from 'child_process';
import net from 'net';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
// Repo root = two levels up from scripts/lib/ — identical whether this module
// is imported by launch-pi.mjs or run directly as a CLI by the extension.
const ROOT_DIR = resolve(__dirname, '..', '..');
const isWin = process.platform === 'win32';

// The auth proxy in front of pi-web-ui. The tunnel is only useful when this
// is listening (glitch.cothekdesigns.com routes here; :4103 fronts :8787).
const AUTH_PROXY_PORT = 4103;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** True when something accepts a TCP connection on 127.0.0.1:<port>. */
function isPortListening(port, timeoutMs = 1500) {
  return new Promise((resolvePromise) => {
    const sock = net.connect({ host: '127.0.0.1', port });
    const finish = (value) => {
      try { sock.destroy(); } catch {}
      resolvePromise(value);
    };
    sock.once('connect', () => finish(true));
    sock.once('error', () => finish(false));
    sock.setTimeout(timeoutMs, () => finish(false));
  });
}

/** Wait up to <timeoutMs> for a port to start listening (stack start races). */
async function waitForPort(port, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await isPortListening(port)) return true;
    await sleep(500);
  }
  return false;
}

function run(cmd, args, opts = {}) {
  try {
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

// Resolve a tunnel asset (binary or config): explicit override, this repo's
// root, then the sibling glitch-ai repo (pre-migration fallback only).
export function resolveTunnelAsset(explicit, relPath) {
  const candidates = [
    explicit,
    join(ROOT_DIR, relPath),
    join(dirname(ROOT_DIR), 'glitch-ai', relPath),
  ].filter(Boolean);
  for (const c of candidates) if (existsSync(c)) return c;
  return null;
}

export function tunnelHost() {
  try {
    const domainFile = join(ROOT_DIR, 'data', 'cloudflare-domain.txt');
    if (existsSync(domainFile)) {
      const d = readFileSync(domainFile, 'utf-8').trim();
      if (d) return d;
    }
  } catch {}
  return 'glitch.cothekdesigns.com';
}

// The PID file is the ownership record: a tunnel started by ensureTunnel() (or
// by the stack scripts) has one; a manually started cloudflared does not.
function pidFilePath() {
  return join(ROOT_DIR, 'data', 'cloudflared-auto.pid');
}

/**
 * Image name for a PID, or null when the PID does not exist.
 * Windows: 'tasklist /FI "PID eq N" /FO CSV' answers both questions in one
 * call (no output = PID gone, first CSV field = image name).
 */
function imageNameForPid(pid) {
  try {
    if (isWin) {
      const out = execFileSync('tasklist', ['/FI', `PID eq ${pid}`, '/NH', '/FO', 'CSV'], {
        encoding: 'utf-8',
        timeout: 5000,
        windowsHide: true,
      });
      const m = out.match(/^"([^"]+)"/m);
      return m ? m[1].toLowerCase() : null;
    }
    const out = execFileSync('ps', ['-o', 'comm=', '-p', String(pid)], {
      encoding: 'utf-8',
      timeout: 5000,
    });
    const name = (out || '').trim().toLowerCase();
    return name || null;
  } catch {
    return null;
  }
}

function isCloudflaredImage(image) {
  return Boolean(image) && image.startsWith('cloudflared');
}

/** PID of a cloudflared process found by image scan, or null. */
function scanForCloudflaredPid() {
  try {
    if (isWin) {
      const out = execFileSync('tasklist', ['/NH', '/FI', 'IMAGENAME eq cloudflared.exe', '/FO', 'CSV'], {
        encoding: 'utf-8',
        timeout: 5000,
        windowsHide: true,
      });
      const m = out.match(/^"cloudflared\.exe","(\d+)"/m);
      return m ? parseInt(m[1], 10) : null;
    }
    const out = execFileSync('pgrep', ['-x', 'cloudflared'], { encoding: 'utf-8', timeout: 5000 });
    const pid = parseInt((out || '').trim().split(/\s+/)[0], 10);
    return isNaN(pid) ? null : pid;
  } catch {
    return null;
  }
}

/**
 * Where the tunnel stands, and who owns it.
 *
 * source: 'pidfile' when this repo started it (stoppable by stopTunnel()),
 *         'process' when something else did (started manually, or by another
 *         checkout) - visible, but never killed by us.
 *
 * The pidfile is trusted ONLY after confirming the PID still belongs to
 * cloudflared. process.kill(pid, 0) alone was not enough: on Windows a recycled
 * PID makes a stale pidfile report "already running" forever, which silently
 * disabled the tunnel-keeper restart path.
 */
export function tunnelStatus() {
  const pidPath = pidFilePath();
  if (existsSync(pidPath)) {
    const pid = parseInt(readFileSync(pidPath, 'utf-8').trim(), 10);
    if (!isNaN(pid) && pid > 0 && isCloudflaredImage(imageNameForPid(pid))) {
      return { running: true, pid, source: 'pidfile' };
    }
    // Stale: process gone, or the PID was recycled by an unrelated process.
    try { unlinkSync(pidPath); } catch {}
  }
  const scanned = scanForCloudflaredPid();
  if (scanned) return { running: true, pid: scanned, source: 'process' };
  return { running: false, pid: null, source: null };
}

export function isCloudflaredRunning() {
  return tunnelStatus().running;
}

// ensureTunnel(log) — log(message, level) with level ∈ 'info' | 'ok' | 'warn' | 'dim'.
export async function ensureTunnel(log = (msg) => console.log(msg)) {
  if (isCloudflaredRunning()) {
    log('cloudflared already running — leaving tunnel as-is', 'ok');
    return { running: true, started: false, reason: 'already-running' };
  }
  // The tunnel only makes sense with the web stack up: glitch.cothekdesigns.com
  // routes to the auth proxy (:4103), which fronts pi-web-ui (:8787).
  // TUI-only sessions run no web stack, so they spawn no tunnel to nowhere.
  if (!(await waitForPort(AUTH_PROXY_PORT))) {
    log('web stack not running (auth proxy :4103 down) — tunnel not needed, skipping', 'dim');
    return { running: false, started: false, reason: 'stack-down' };
  }
  const bin = resolveTunnelAsset(process.env.GLITCH_TUNNEL_BIN, isWin ? 'cloudflared.exe' : 'cloudflared');
  const cfg = resolveTunnelAsset(process.env.GLITCH_TUNNEL_CONFIG, join('config', 'cloudflared-config.yml'));
  if (!bin || !cfg) {
    log('cloudflared binary or tunnel config not found — auto-start skipped', 'warn');
    log('(expected in the repo root; set GLITCH_TUNNEL_BIN / GLITCH_TUNNEL_CONFIG)', 'dim');
    return { running: false, started: false, reason: 'assets-missing' };
  }
  log('Starting Cloudflare Tunnel (detached)...', 'info');
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
    log(`cloudflared spawned (PID ${child.pid}) — waiting for tunnel...`, 'dim');
    const host = tunnelHost();
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
          log(`tunnel remote: HTTP ${code} (OK)`, 'ok');
          return { running: true, started: true, reason: 'started', verified: true };
        }
      } catch {}
    }
    log('tunnel not answering yet — will retry on the next keeper pass', 'warn');
    return { running: true, started: true, reason: 'started', verified: false };
  } catch (e) {
    log(`tunnel auto-start failed: ${e.message || e}`, 'warn');
    return { running: false, started: false, reason: 'spawn-failed', error: e.message || String(e) };
  }
}

// ---- stopTunnel() - Stop the tunnel THIS repo started ----
// Ownership rule: only a tunnel recorded in data/cloudflared-auto.pid is ours.
// A cloudflared started by hand (or by another checkout) is reported, never
// killed - killing by image name would take out someone else's connector.
// Returns { stopped, reason, pid? }.
export function stopTunnel(log = (msg) => console.log(msg)) {
  const status = tunnelStatus();
  if (!status.running) {
    log('cloudflared not running — nothing to stop', 'dim');
    return { stopped: false, reason: 'not-running' };
  }
  if (status.source !== 'pidfile') {
    log(
      `cloudflared (PID ${status.pid}) was not started by this stack — not killing it`,
      'warn',
    );
    log('stop it manually if that is what you want (taskkill /PID, or Ctrl+C in its window)', 'dim');
    return { stopped: false, reason: 'not-ours', pid: status.pid };
  }
  const pid = status.pid;
  log(`stopping cloudflared (PID ${pid})...`, 'info');
  try {
    if (isWin) {
      // /T so a wrapped cloudflared (wrapper script) dies with it; /F because a
      // graceful stop waits on open QUIC connections.
      run('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: ['ignore', 'pipe', 'ignore'] });
    } else {
      run('kill', [String(pid)], { stdio: ['ignore', 'pipe', 'ignore'] });
    }
  } catch (e) {
    log(`taskkill failed: ${e.message || e}`, 'warn');
    return { stopped: false, reason: 'kill-failed', pid, error: e.message || String(e) };
  }
  try { unlinkSync(pidFilePath()); } catch {}
  // Confirm the connector is really gone rather than trusting the exit code.
  if (tunnelStatus().running) {
    log('cloudflared still reported running after the kill', 'warn');
    return { stopped: false, reason: 'still-running', pid };
  }
  log('cloudflared stopped', 'ok');
  return { stopped: true, reason: 'stopped', pid };
}

// ---- CLI entry (spawned by .pi/extensions/tunnel-keeper.ts and the stack
// scripts) ----
// Verbs (bare / --reason call = 'ensure', unchanged for the keeper extension):
//   ensure   idempotent start, always exits 0  (keeper: fire-and-forget)
//   start    ensure, then exit 0 only when cloudflared is running
//   stop     stop the tunnel this repo started (pidfile owners only)
//   status   print one line; exit 0 when up, 1 when down
const invokedDirectly = (() => {
  try {
    return Boolean(process.argv[1]) && resolve(process.argv[1]) === __filename;
  } catch {
    return false;
  }
})();

if (invokedDirectly) {
  const args = process.argv.slice(2);
  const verb = args[0] && !args[0].startsWith('--') ? args[0] : 'ensure';
  const reasonIdx = args.indexOf('--reason');
  const reason = reasonIdx !== -1 && args[reasonIdx + 1] ? args[reasonIdx + 1] : verb;
  const log = (msg, level = 'info') => {
    try {
      const logDir = join(ROOT_DIR, 'data', 'logs');
      mkdirSync(logDir, { recursive: true });
      appendFileSync(
        join(logDir, 'tunnel-keeper.log'),
        `[${new Date().toISOString()}] (${reason}) [${level}] ${msg}\n`,
        'utf-8',
      );
    } catch {}
  };

  if (verb === 'status') {
    const s = tunnelStatus();
    if (s.running) {
      console.log(`cloudflared: UP (PID ${s.pid}, ${s.source === 'pidfile' ? 'started by this stack' : 'not ours'})`);
      process.exit(0);
    }
    console.log('cloudflared: DOWN');
    process.exit(1);
  }

  if (verb === 'stop') {
    const r = stopTunnel(log);
    if (r.stopped) console.log(`cloudflared: stopped (PID ${r.pid})`);
    else if (r.reason === 'not-running') console.log('cloudflared: already down');
    else if (r.reason === 'not-ours') console.log(`cloudflared: not ours (PID ${r.pid}) — left running`);
    else console.log(`cloudflared: stop failed (${r.reason})`);
    process.exit(r.stopped || r.reason === 'not-running' ? 0 : 1);
  }

  if (verb === 'start') {
    // Operator command (stack scripts) - mirror progress to stdout as well as to
    // the keeper log, so a skipped start or a failed spawn is visible in the
    // launcher output instead of vanishing into data/logs. 'dim' lines are
    // keeper bookkeeping and stay out of the console.
    const logBoth = (msg, level = 'info') => {
      log(msg, level);
      if (level !== 'dim') console.log(`  ${msg}`);
    };
    const r = await ensureTunnel(logBoth);
    if (!r.running) console.log(`cloudflared: DOWN (${r.reason})`);
    process.exit(r.running ? 0 : 1);
  }

  ensureTunnel(log).then(() => process.exit(0));
}
