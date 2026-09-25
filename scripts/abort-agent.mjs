#!/usr/bin/env node
// abort-agent.mjs — abort a hung sub-agent session via the opencode web API,
// then optionally kill surviving shell processes by captured PID (R10: never by name).
// Exit 0 on successful abort+verify, 1 on abort failure, 2 on server unreachable,
// 3 on missing auth credentials.

import { DatabaseSync } from 'node:sqlite';
import { execFile } from 'node:child_process';
import { homedir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..');
const SERVER_PASSWORD_FILE = join(REPO_ROOT, '.server-password');
const SERVER_USERNAME_FILE = join(REPO_ROOT, '.server-username');

const DEFAULT_DB = join(homedir(), '.local', 'share', 'opencode', 'opencode.db');
const DEFAULT_BASE_URL = 'http://localhost:4102';

// The opencode web server requires Basic auth (username "opencode" + password
// from .server-password). Without it every request 401s. Read the password from
// disk, fall back to the env var, or fail with a clear error (exit 3).
function getServerPassword() {
  try {
    const raw = readFileSync(SERVER_PASSWORD_FILE, 'utf-8');
    const pw = raw.trim();
    if (pw) return pw;
  } catch (e) {
    // Expected when .server-password doesn't exist — fall through to env.
    console.error(`[abort-agent] .server-password not readable: ${e.message}`);
  }
  const envPw = process.env.OPENCODE_SERVER_PASSWORD;
  if (envPw && envPw.trim()) return envPw.trim();
  return null;
}

function buildAuthHeader(password) {
  // The username follows .server-username too (default 'opencode'), the same rule
  // plugins/auth-proxy.mjs and scripts/lib/web-auth.mjs resolve. Hardcoding it
  // would 401 here the moment the login username changes.
  let username = 'opencode';
  try {
    const u = readFileSync(SERVER_USERNAME_FILE, 'utf-8').trim();
    if (u) username = u;
  } catch {}
  const token = Buffer.from(`${username}:${password}`).toString('base64');
  return `Basic ${token}`;
}

function parseArgs(argv) {
  const args = { baseUrl: DEFAULT_BASE_URL, pid: null, kill: false, db: DEFAULT_DB };
  let sessionID = null;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--base-url') args.baseUrl = argv[++i];
    else if (a === '--pid') args.pid = argv[++i];
    else if (a === '--kill') args.kill = true;
    else if (a === '--db') args.db = argv[++i];
    else if (a === '--help' || a === '-h') {
      console.log('Usage: abort-agent.mjs <sessionID> [--base-url http://localhost:4102] [--pid <pid>] [--kill] [--db <path>]');
      process.exit(0);
    } else if (!sessionID) {
      sessionID = a;
    }
  }
  if (!sessionID) {
    console.error('Error: sessionID is required.');
    console.error('Usage: abort-agent.mjs <sessionID> [--base-url URL] [--pid <pid>] [--kill]');
    process.exit(1);
  }
  return { sessionID, ...args };
}

async function abortSession(sessionID, baseUrl, authHeader) {
  const normalizedBase = baseUrl.replace(/\/$/, '');
  const url = `${normalizedBase}/session/${encodeURIComponent(sessionID)}/abort`;
  try {
    const headers = {};
    if (authHeader) headers['Authorization'] = authHeader;
    const res = await fetch(url, { method: 'POST', headers, signal: AbortSignal.timeout(15000) });
    if (res.status === 200 || res.status === 204) return { ok: true, status: res.status };
    if (res.status === 404) return { ok: false, status: 404, error: 'Session not found' };
    const body = await res.text().catch(() => '');
    return { ok: false, status: res.status, error: `HTTP ${res.status}: ${body.slice(0, 200)}` };
  } catch (e) {
    if (e?.cause?.code === 'ECONNREFUSED' || e?.code === 'ECONNREFUSED') {
      return { ok: false, unreachable: true, error: 'Connection refused — server not running' };
    }
    return { ok: false, error: e.message };
  }
}

function killPid(pid) {
  return new Promise((resolve) => {
    if (process.platform !== 'win32') {
      try { process.kill(parseInt(pid, 10), 'SIGKILL'); resolve({ ok: true }); }
      catch (e) { resolve({ ok: false, error: e.message }); }
      return;
    }
    execFile('taskkill', ['/T', '/F', '/PID', String(pid)], { encoding: 'utf-8' }, (err, stdout, stderr) => {
      if (err) resolve({ ok: false, error: (stderr && stderr.trim()) || err.message });
      else resolve({ ok: true, stdout: stdout && stdout.trim() });
    });
  });
}

function verifyStopped(dbPath, sessionID) {
  let db;
  try {
    db = new DatabaseSync(dbPath, { readonly: true });
  } catch (e) {
    return { verified: false, error: `DB open failed: ${e.message}` };
  }
  try {
    const row = db.prepare(
      `SELECT data FROM part WHERE session_id = ? AND json_extract(data, '$.state.status') = 'running' ORDER BY time_updated DESC LIMIT 1`
    ).get(sessionID);
    db.close();
    if (!row) return { verified: true };
    try {
      const d = JSON.parse(row.data);
      if (d?.state?.status === 'running') return { verified: false, stillRunning: d.tool ?? 'unknown' };
      return { verified: true };
    } catch (e) {
      return { verified: false, error: `Malformed part data: ${e.message}` };
    }
  } catch (e) {
    db.close();
    return { verified: false, error: e.message };
  }
}

async function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function main() {
  const args = parseArgs(process.argv.slice(2));
  console.log(`Aborting session ${args.sessionID} via ${args.baseUrl}...`);

  const password = getServerPassword();
  if (!password) {
    console.error('ERROR: No server password found.');
    console.error(`Tried: ${SERVER_PASSWORD_FILE} and env OPENCODE_SERVER_PASSWORD.`);
    console.error('The opencode web server requires Basic auth — abort cannot proceed without it.');
    process.exit(3);
  }
  const authHeader = buildAuthHeader(password);

  const result = await abortSession(args.sessionID, args.baseUrl, authHeader);
  if (result.unreachable) {
    console.error(`ERROR: ${result.error}`);
    console.error('Is the opencode web server running? (default: localhost:4102)');
    process.exit(2);
  }
  if (!result.ok) {
    console.error(`ERROR: Abort failed — ${result.error}`);
    process.exit(1);
  }
  console.log(`Abort request sent (HTTP ${result.status}).`);

  if (args.kill && args.pid) {
    console.log(`Killing PID ${args.pid} (taskkill /T /F)...`);
    const killResult = await killPid(args.pid);
    if (killResult.ok) console.log(`Process ${args.pid} killed.`);
    else console.error(`Kill failed: ${killResult.error}`);
  } else if (args.kill && !args.pid) {
    console.warn('Warning: --kill passed but no --pid provided — skipping OS kill.');
  }

  console.log('Verifying session stopped (polling up to 10s)...');
  let verified = false;
  let detail = '';
  for (let i = 0; i < 5; i++) {
    await sleep(2000);
    const v = verifyStopped(args.db, args.sessionID);
    if (v.verified) { verified = true; break; }
    detail = v.stillRunning ? `still running: ${v.stillRunning}` : (v.error || 'unknown');
  }
  if (verified) {
    console.log('VERIFIED: No running parts remain. Session stopped.');
    process.exit(0);
  } else {
    console.error(`NOT VERIFIED: ${detail}. The session may still be active.`);
    process.exit(1);
  }
}

main().catch(e => {
  console.error(`Unexpected error: ${e.message}`);
  process.exit(1);
});
