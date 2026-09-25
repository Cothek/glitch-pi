#!/usr/bin/env node
// scripts/set-password.mjs — set or change the Pi web login password.
//
// The password gates the auth proxy (:4103) that sits in FRONT of pi-web-ui
// (:8787). Browsers see it as HTTP Basic auth: username "opencode", password =
// the contents of .server-password (repo root, gitignored). Changing it
// invalidates existing glitch_auth cookies and ?auth_token= bookmarks
// (both encode the old password).
//
// Usage:
//   node scripts/set-password.mjs                 # generate a strong random password
//   node scripts/set-password.mjs "my password"   # set a specific password
//
// What it does:
//   1. writes .server-password
//   2. restarts the auth proxy on :4103 (kills the old listener by PID,
//      spawns THIS repo's plugins/auth-proxy.mjs detached)
//   3. prints the new password once

import { existsSync, writeFileSync, openSync, mkdirSync } from 'fs';
import { join, dirname, resolve } from 'path';
import { fileURLToPath } from 'url';
import { execFileSync, spawn, spawnSync } from 'child_process';
import { randomBytes } from 'crypto';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = resolve(__dirname, '..');
const PW_FILE = join(ROOT_DIR, '.server-password');
const AUTH_PROXY = join(ROOT_DIR, 'plugins', 'auth-proxy.mjs');
const AUTH_PORT = 4103;
const WEBUI_PORT = 8787;
const UPSTREAM = 'http://localhost:8787';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function findPidOnPort(port) {
  try {
    const out = execFileSync('netstat', ['-ano'], { encoding: 'utf-8', timeout: 10000 });
    for (const line of out.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (trimmed.includes('LISTENING') && new RegExp(`:${port}\\s`).test(trimmed)) {
        const m = trimmed.match(/(\d+)\s*$/);
        if (m) return parseInt(m[1], 10);
      }
    }
  } catch {}
  return null;
}

const argPassword = process.argv[2];
const password = argPassword && argPassword.trim()
  ? argPassword.trim()
  : randomBytes(15).toString('base64url'); // 20 chars, url-safe

if (password.length < 8) {
  console.error('  Password too short — minimum 8 characters.');
  process.exit(1);
}

if (!existsSync(AUTH_PROXY)) {
  console.error(`  auth-proxy not found: ${AUTH_PROXY}`);
  process.exit(1);
}

// 1. Write the password BEFORE touching the proxy (auth-proxy hard-exits
//    when .server-password is missing).
writeFileSync(PW_FILE, password, 'utf-8');
console.log(`  Password written: ${PW_FILE}`);

// 2. Restart the auth proxy so the new password takes effect immediately.
const oldPid = findPidOnPort(AUTH_PORT);
if (oldPid) {
  spawnSync('taskkill', ['/PID', String(oldPid), '/F'], { stdio: 'ignore' });
  console.log(`  Stopped old auth-proxy (PID ${oldPid})`);
  await sleep(1200);
}

const logDir = join(ROOT_DIR, 'data', 'logs');
mkdirSync(logDir, { recursive: true });
const outFd = openSync(join(logDir, 'auth-proxy-pi.out.log'), 'a');
const errFd = openSync(join(logDir, 'auth-proxy-pi.err.log'), 'a');
const child = spawn(process.execPath, [AUTH_PROXY, String(AUTH_PORT), UPSTREAM], {
  detached: true,
  stdio: ['ignore', outFd, errFd],
  windowsHide: true,
});
child.unref();

// 3. Confirm the port came back (different PID = our new proxy).
let up = false;
for (let i = 0; i < 12; i++) {
  await sleep(500);
  const pid = findPidOnPort(AUTH_PORT);
  if (pid && pid !== oldPid) { up = true; break; }
}

if (!up) {
  console.error('  auth-proxy did not come back up — check data\\logs\\auth-proxy-pi.err.log');
  process.exit(1);
}
console.log(`  auth-proxy restarted on :${AUTH_PORT} (PID ${child.pid})`);

if (!findPidOnPort(WEBUI_PORT)) {
  console.log('  NOTE: pi-web-ui (:8787) is not running — start it with:');
  console.log('        node scripts/launch-pi.mjs --stack-only');
}

console.log('');
console.log('  NEW Pi web password:');
console.log(`    ${password}`);
console.log('');
console.log('  Log in at https://glitch.cothekdesigns.com   (username: opencode)');
console.log('  Local http://localhost:8787 needs no auth.');
console.log('  Old cookies / ?auth_token= bookmarks are invalidated — re-auth once.');
console.log('');
