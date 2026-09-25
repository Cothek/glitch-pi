#!/usr/bin/env node
// scripts/resume-session.mjs  -  inject a continuation prompt into a pi-web-ui
// conversation over the same WebSocket the browser uses.
//
// Built for scripts/restart-pi-stack.ps1: an agent session dies when
// pi-web-ui is killed (the pi engine runs inside that process), but the
// conversation persists on disk. After the stack is back up, this script
// switches to the conversation and sends a prompt, resuming the session
// exactly where a human typing into the reopened tab would.
//
// Protocol (decoded from pi-web-ui's client bundle):
//   send {type:'hello', clientId, locale}
//   send {type:'switch_conversation', id}
//   send {type:'prompt', text, queue:false}
//
// Usage:
//   node scripts/resume-session.mjs --list
//   node scripts/resume-session.mjs --id <conversationId> --text "continue"
//   node scripts/resume-session.mjs --id <conversationId> --file prompt.md
//   --url ws://localhost:8787/ws   (override; local port needs no auth)
//
// Exit codes: 0 success, 1 failure. Requires pi-web-ui to be listening.

import { readFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { join, dirname, isAbsolute } from 'node:path';
import { randomBytes } from 'node:crypto';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');

// ---- args -------------------------------------------------------------------
const args = process.argv.slice(2);
const flag = (name) => {
  const i = args.indexOf(name);
  return i >= 0 && i + 1 < args.length ? args[i + 1] : null;
};
const LIST = args.includes('--list');
const ID = flag('--id');
const PATH = flag('--path');
const TEXT = flag('--text');
let FILE = flag('--file');
const URL_OVERRIDE = flag('--url');
const WS_URL = URL_OVERRIDE || 'ws://localhost:8787/ws';

if (!LIST && !ID && !PATH) {
  console.error('usage: --list | (--id <conversationId> | --path <sessionFile>) (--text "..." | --file <prompt.md>) [--url ws://...]');
  process.exit(1);
}
if (LIST && (ID || PATH)) {
  console.error('--list and --id/--path are mutually exclusive');
  process.exit(1);
}
if (!LIST && !TEXT && !FILE) {
  console.error('either --text or --file is required with --id/--path');
  process.exit(1);
}
let promptText = TEXT;
if (FILE) {
  if (!isAbsolute(FILE)) FILE = join(process.cwd(), FILE);
  promptText = readFileSync(FILE, 'utf-8');
}

// ---- ws client from the portable install ------------------------------------
// The repo has no package.json dependency on ws; pi-web-ui bundles it in its
// own node_modules. Import by absolute file URL (candidates cover a future
// hoisted layout).
let WebSocket;
try {
  const candidates = [
    join(ROOT, 'data', 'node', 'node_modules', 'pi-web-ui', 'node_modules', 'ws', 'index.js'),
    join(ROOT, 'data', 'node', 'node_modules', 'ws', 'index.js'),
  ];
  let mod;
  for (const c of candidates) {
    try { mod = await import(pathToFileURL(c).href); break; } catch {}
  }
  if (!mod) throw new Error('ws not found in any known location');
  WebSocket = mod.default?.WebSocket || mod.default || mod.WebSocket;
} catch (e) {
  console.error('cannot load ws package:', e.message);
  process.exit(1);
}

const clientId = randomBytes(8).toString('hex');
const t0 = Date.now();
const log = (m) => console.log(`[resume-session +${Date.now() - t0}ms] ${m}`);
let done = false;

const sock = new WebSocket(WS_URL, { handshakeTimeout: 10000 });
const send = (obj) => sock.send(JSON.stringify(obj));
const finish = (code, msg) => {
  if (done) return;
  done = true;
  if (msg) log(msg);
  try { sock.close(); } catch {}
  setTimeout(() => process.exit(code), 150);
};

// Overall watchdog: never hang the caller (the restart script waits on us).
const watchdog = setTimeout(() => finish(1, 'watchdog timeout (25s)  -  aborting'), 25000);

sock.on('open', () => {
  log(`connected to ${WS_URL}`);
  send({ type: 'hello', clientId, locale: 'en' });
  if (LIST) {
    send({ type: 'get_state' });
    send({ type: 'list_sessions' });
    return;
  }
  if (ID) {
    send({ type: 'switch_conversation', id: ID });
  } else {
    // Path-based resume: conversation ids are per-boot, the jsonl path is the
    // stable handle across restarts.
    send({ type: 'switch_session', path: PATH });
  }
  // Give the server a moment to switch before prompting.
  setTimeout(() => {
    send({ type: 'prompt', text: promptText, queue: false });
    log(`prompt sent (${promptText.length} chars) to conversation ${ID}`);
    // Drain briefly so the server has accepted the prompt before we go.
    setTimeout(() => {
      clearTimeout(watchdog);
      finish(0, 'done');
    }, 2000);
  }, 500);
});

sock.on('message', (data) => {
  if (!LIST) return;
  let msg;
  try { msg = JSON.parse(data.toString()); } catch { return; }
  if (msg.type === 'sessions' && Array.isArray(msg.sessions)) {
    for (const s of msg.sessions) {
      const when = s.modified ? new Date(s.modified).toISOString().slice(0, 16) : '-';
      console.log(`${s.path}\t${when}\t${s.messageCount ?? '?'} msgs\t${(s.firstMessage || s.name || '').toString().slice(0, 80)}`);
    }
    clearTimeout(watchdog);
    finish(0, `sessions list received (${msg.sessions.length})`);
    return;
  }
  if (msg.type === 'snapshot' && msg.state) {
    const st = msg.state;
    console.log(`[active] conversationId=${st.conversationId} sessionId=${st.sessionId ?? '-'} sessionFile=${st.sessionFile ?? '-'}`);
    if (!LIST) return; // non-list mode: identity not needed, wait for prompt flow
    // LIST mode: identity printed above; keep waiting for the sessions push.
    return;
  }
  // Any other message carrying an array of id-bearing objects under a
  // conversation-ish key (sessions push after list_sessions, etc.) - dump it.
  for (const k of Object.keys(msg)) {
    if (!/conversation|session|chat/i.test(k)) continue;
    const v = msg[k];
    if (Array.isArray(v) && v.length && typeof v[0] === 'object' && v[0] && v[0].id !== undefined) {
      for (const c of v) {
        const title = (c.title || c.name || c.summary || c.path || '').toString().slice(0, 70);
        console.log(`${k}\t${c.id}\t${title}`);
      }
      clearTimeout(watchdog);
      finish(0, `${k} list received`);
    }
  }
});

sock.on('error', (e) => {
  clearTimeout(watchdog);
  finish(1, `ws error: ${e.message}`);
});
sock.on('close', () => {
  if (LIST) {
    clearTimeout(watchdog);
    finish(1, 'connection closed before state arrived');
  }
});
