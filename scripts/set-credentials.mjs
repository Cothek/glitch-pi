#!/usr/bin/env node
// scripts/set-credentials.mjs - change the Pi web UI login (username and/or password).
//
// The Pi web UI (:8787) sits behind plugins/auth-proxy.mjs (:4103), which enforces
// HTTP Basic auth built from two optional files at the repo root:
//   .server-username  -> the login username (absent = the 'opencode' default)
//   .server-password  -> the login password (absent = no login possible)
// Both are gitignored. This script writes them, then restarts the auth proxy so
// the change takes effect immediately (the running proxy reads them at startup).
//
// Usage:
//   node scripts/set-credentials.mjs                        rotate the password (random), keep the username
//   node scripts/set-credentials.mjs --username troy        change the username, keep the password
//   node scripts/set-credentials.mjs --password 'hunter2'   set a specific password
//   node scripts/set-credentials.mjs --username troy --password 'hunter2'
//   node scripts/set-credentials.mjs --show                 print the current state (never the password)
//   node scripts/set-credentials.mjs hunter2                legacy positional password (set-password.mjs style)
//
// WARNING: any change invalidates the 7-day glitch_auth cookie and every
// ?auth_token= bookmark, because the token is base64("username:password").
// Re-login once afterwards.

import { existsSync, writeFileSync, openSync, mkdirSync, readFileSync } from 'fs';
import { join, resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { execFileSync, spawn, spawnSync } from 'child_process';
import { randomBytes } from 'crypto';
import {
  printLoginBanner,
  readPassword,
  readUsername,
  PASSWORD_FILE,
  USERNAME_FILE,
  AUTH_USERNAME,
  AUTH_PORT,
  WEBUI_PORT,
  ROOT_DIR,
} from './lib/web-auth.mjs';

const AUTH_PROXY = join(ROOT_DIR, 'plugins', 'auth-proxy.mjs');
const UPSTREAM = `http://localhost:${WEBUI_PORT}`;
const MIN_PASSWORD_LENGTH = 8;
const MAX_USERNAME_LENGTH = 64;

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

/**
 * Reject usernames that cannot survive HTTP Basic auth. The colon is the real
 * trap: the client joins "user:pass" and the server splits on the FIRST colon,
 * so "a:b" would authenticate as "a" with password "b:...". The others are
 * sanity: an empty or blank name is unrunnable, and control characters would
 * corrupt the Authorization header.
 */
function validateUsername(name) {
  if (!name) return 'username is empty';
  if (name.length > MAX_USERNAME_LENGTH) return `username is longer than ${MAX_USERNAME_LENGTH} characters`;
  if (name.includes(':')) return 'username must not contain ":" (Basic auth splits the header on the first colon)';
  if (/\s/.test(name)) return 'username must not contain spaces or tabs';
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(name)) return 'username must not contain control characters';
  return null;
}

function parseArgs(argv) {
  const out = { username: null, password: null, show: false, help: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--username' || a === '-u') out.username = argv[++i] ?? '';
    else if (a.startsWith('--username=')) out.username = a.slice('--username='.length);
    else if (a === '--password' || a === '-p') out.password = argv[++i] ?? '';
    else if (a.startsWith('--password=')) out.password = a.slice('--password='.length);
    else if (a === '--show' || a === '-s') out.show = true;
    else if (a === '--help' || a === '-h') out.help = true;
    else if (!a.startsWith('-') && out.password === null) out.password = a; // legacy positional
  }
  return out;
}

const USAGE = `
  Change the Pi web UI login (username and/or password).

    node scripts/set-credentials.mjs                        rotate the password (random)
    node scripts/set-credentials.mjs --username <name>      change the username
    node scripts/set-credentials.mjs --password <pw>        set a specific password
    node scripts/set-credentials.mjs --username <n> --password <pw>
    node scripts/set-credentials.mjs --show                 show current state (no secrets)

  Files (repo root, gitignored):
    .server-username   login username   (absent = "${AUTH_USERNAME}")
    .server-password   login password   (absent = no login possible)
`;

const args = parseArgs(process.argv.slice(2));

if (args.help) {
  console.log(USAGE);
  process.exit(0);
}

if (args.show) {
  const user = readUsername();
  const pw = readPassword();
  const userFrom = existsSync(USERNAME_FILE) ? USERNAME_FILE : `(default - no ${USERNAME_FILE})`;
  console.log('');
  console.log('  Pi web UI login');
  console.log(`    Username:  ${user}`);
  console.log(`               from ${userFrom}`);
  console.log(`    Password:  ${pw ? `set (${pw.length} chars) in ${PASSWORD_FILE}` : `NOT SET - create one: node scripts/set-credentials.mjs`}`);
  console.log(`    Local:     http://localhost:${WEBUI_PORT}  (no auth needed)`);
  console.log('');
  process.exit(0);
}

const changingUsername = args.username !== null;
const changingPassword = args.password !== null || !changingUsername;

if (changingUsername) {
  const name = String(args.username).trim();
  const problem = validateUsername(name);
  if (problem) {
    console.error(`  Invalid username: ${problem}`);
    console.error('  Example: node scripts/set-credentials.mjs --username troy');
    process.exit(1);
  }
  args.username = name;
}

// A password file must exist no matter what we change: the gate hard-exits
// without it, so a username-only edit on a broken install would leave it broken.
const existingPassword = readPassword();
if (!existingPassword) {
  console.error(`  No password file found at ${PASSWORD_FILE}`);
  console.error('  Create one first (this command also generates it): node scripts/set-credentials.mjs');
  process.exit(1);
}

const password = changingPassword
  ? (args.password && String(args.password).trim()) || randomBytes(15).toString('base64url')
  : existingPassword;

if (changingPassword && password.length < MIN_PASSWORD_LENGTH) {
  console.error(`  Password too short - minimum ${MIN_PASSWORD_LENGTH} characters.`);
  process.exit(1);
}

if (!existsSync(AUTH_PROXY)) {
  console.error(`  auth-proxy not found: ${AUTH_PROXY}`);
  process.exit(1);
}

// Idempotence guard: --username with the same value and no password change is a
// no-op, and restarting the proxy for it would drop live connections for nothing.
const currentUsername = readUsername();
if (changingUsername && !changingPassword && args.username === currentUsername) {
  console.log(`  Username is already "${currentUsername}" - nothing to do.`);
  process.exit(0);
}

console.log('');
if (changingUsername) {
  console.log(`  Username: ${currentUsername} -> ${args.username}`);
} else {
  console.log(`  Username: ${currentUsername} (unchanged)`);
}
console.log(`  Password: ${changingPassword ? 'new value written' : 'unchanged'}`);

// 1. Write the files BEFORE touching the proxy: the gate hard-exits when
//    .server-password is missing, and it reads both files at startup.
if (changingUsername) {
  writeFileSync(USERNAME_FILE, args.username, 'utf-8');
  console.log(`  Written: ${USERNAME_FILE}`);
}
if (changingPassword) {
  writeFileSync(PASSWORD_FILE, password, 'utf-8');
  console.log(`  Written: ${PASSWORD_FILE}`);
}

// 2. Restart the auth proxy so the new credentials take effect immediately.
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

// 3. Confirm the port came back (a different PID means it is our new proxy).
let up = false;
for (let i = 0; i < 12; i++) {
  await sleep(500);
  const pid = findPidOnPort(AUTH_PORT);
  if (pid && pid !== oldPid) { up = true; break; }
}

if (!up) {
  console.error(`  auth-proxy did not come back up - check ${join(logDir, 'auth-proxy-pi.err.log')}`);
  process.exit(1);
}
console.log(`  auth-proxy restarted on :${AUTH_PORT} (PID ${child.pid})`);

if (!findPidOnPort(WEBUI_PORT)) {
  console.log(`  NOTE: pi-web-ui (:${WEBUI_PORT}) is not running - start it with:`);
  console.log('        node scripts/launch-pi.mjs --stack-only');
}

// 4. The banner is the shared helper, so it always matches what the gate expects.
printLoginBanner({ password, color: process.stdout.isTTY === true });
console.log('  Local http://localhost:%d needs no auth.', WEBUI_PORT);
console.log('  Old cookies / ?auth_token= bookmarks are invalidated - re-auth once.');
console.log('');
