#!/usr/bin/env node
// scripts/lib/tunnel.mjs — Cloudflare tunnel ensure logic (shared).
//
// Consumers:
//   - scripts/launch-pi.mjs                (import: ensureTunnel at launch)
//   - .pi/extensions/tunnel-keeper.ts      (spawn: CLI, session-start + periodic)
//
// CLI:  node scripts/lib/tunnel.mjs [--reason <label>]
//   Skip-if-alive: cloudflared already running → exits 0 silently.
//   Otherwise: spawns `cloudflared tunnel --config <cfg> run` detached
//   (logs → data/logs/cloudflared-tunnel.{out,err}.log), writes
//   data/cloudflared-auto.pid, polls the remote URL up to 12s for
//   HTTP 401/403/200, and logs each step to data/logs/tunnel-keeper.log.
//
// Ownership: the whole remote-access stack lives in THIS repo (glitch-pi).
//   cloudflared.exe + config/cloudflared-config.yml are in the repo root
//   (both gitignored). One Cloudflare tunnel (credentials in
//   ~/.cloudflared/<uuid>.json — user-level, never inside a repo) serves the
//   glitch / trader / pi hostnames; pi.cothekdesigns.com → auth-proxy :4103
//   → pi-web-ui :8787.

import { existsSync, readFileSync, writeFileSync, openSync, mkdirSync, appendFileSync } from 'fs';
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
// is listening (pi.cothekdesigns.com routes here; :4103 fronts :8787).
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
  return 'pi.cothekdesigns.com';
}

export function isCloudflaredRunning() {
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
  // Image-name scan (also covers tunnels started by other tools).
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

// ensureTunnel(log) — log(message, level) with level ∈ 'info' | 'ok' | 'warn' | 'dim'.
export async function ensureTunnel(log = (msg) => console.log(msg)) {
  if (isCloudflaredRunning()) {
    log('cloudflared already running — leaving tunnel as-is', 'ok');
    return;
  }
  // The tunnel only makes sense with the web stack up: pi.cothekdesigns.com
  // routes to the auth proxy (:4103), which fronts pi-web-ui (:8787).
  // TUI-only sessions run no web stack, so they spawn no tunnel to nowhere.
  if (!(await waitForPort(AUTH_PROXY_PORT))) {
    log('web stack not running (auth proxy :4103 down) — tunnel not needed, skipping', 'dim');
    return;
  }
  const bin = resolveTunnelAsset(process.env.GLITCH_TUNNEL_BIN, isWin ? 'cloudflared.exe' : 'cloudflared');
  const cfg = resolveTunnelAsset(process.env.GLITCH_TUNNEL_CONFIG, join('config', 'cloudflared-config.yml'));
  if (!bin || !cfg) {
    log('cloudflared binary or tunnel config not found — auto-start skipped', 'warn');
    log('(expected in the repo root; set GLITCH_TUNNEL_BIN / GLITCH_TUNNEL_CONFIG)', 'dim');
    return;
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
          return;
        }
      } catch {}
    }
    log('tunnel not answering yet — will retry on the next keeper pass', 'warn');
  } catch (e) {
    log(`tunnel auto-start failed: ${e.message || e}`, 'warn');
  }
}

// ---- CLI entry (spawned by .pi/extensions/tunnel-keeper.ts) ----
const invokedDirectly = (() => {
  try {
    return Boolean(process.argv[1]) && resolve(process.argv[1]) === __filename;
  } catch {
    return false;
  }
})();

if (invokedDirectly) {
  const reasonIdx = process.argv.indexOf('--reason');
  const reason = reasonIdx !== -1 && process.argv[reasonIdx + 1] ? process.argv[reasonIdx + 1] : 'manual';
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
  ensureTunnel(log).then(() => process.exit(0));
}
