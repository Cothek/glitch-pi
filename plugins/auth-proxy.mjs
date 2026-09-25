/**
 * Auth Proxy — sits between cloudflare tunnel and opencode web server.
 * Enforces HTTP Basic Auth on incoming requests. Valid credentials
 * are forwarded to the upstream server with the auth header injected.
 *
 * Credentials accepted via:
 *   - Authorization: Basic <base64> header (browser native auth dialog)
 *   - ?auth_token=<base64> query parameter (bookmarkable one-click URL)
 *   - glitch_auth=<session id> HttpOnly cookie, set automatically on any
 *     successful auth; covers SPA internal fetches that carry no credentials
 *
 * SESSIONS ARE NOT THE CREDENTIAL. The cookie used to hold base64(user:pass),
 * which meant changing the password logged out every browser at once, including
 * the one making the change - the classic "rotate it and lock yourself out".
 * The cookie now holds a random session id, and sessions live in their own file,
 * so credentials and sessions are independent: a credential change affects NEW
 * logins only. A pre-sessions cookie (still holding the old token) is accepted
 * once and upgraded in place, so nobody is logged out by this change either.
 *
 * Session routes (handled before the gate, so they work even when the caller's
 * session is already gone):
 *   GET  /__auth/whoami      -> how you authenticated + when the session expires
 *   POST /__auth/logout      -> revoke the current session (idempotent)
 *   POST /__auth/logout-all  -> revoke every session ("log out everywhere")
 *
 * Usage: node plugins/auth-proxy.mjs [port] [upstream]
 *   Default port: 4101
 *   Default upstream: http://localhost:4102
 */

import http from 'node:http';
import { readFileSync, writeFileSync, statSync, renameSync, mkdirSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const rootDir = resolve(__dirname, '..');
const pwFile = resolve(rootDir, '.server-password');
const userFile = resolve(rootDir, '.server-username');

// Login details printed on startup. Both credentials resolve the SAME files as
// scripts/lib/web-auth.mjs (that module is the single source of truth for the
// banner printed by the launchers). This file stays dependency-free on purpose
// (node builtins only) so the auth gate can never be taken down by a broken
// import - hence the local readers instead of importing web-auth.
// Change the resolution rules here and change them there too.
const DEFAULT_USERNAME = 'opencode';

/** .server-username when set, else DEFAULT_USERNAME. Missing file is not an error. */
function readUsername() {
  try {
    const u = readFileSync(userFile, 'utf-8').trim();
    return u || DEFAULT_USERNAME;
  } catch {
    return DEFAULT_USERNAME;
  }
}

// Public hostname for the login URL (data/cloudflare-domain.txt wins, else the
// known tunnel host). Local helper on purpose - see note above.
function tunnelHost() {
  try {
    const f = resolve(rootDir, 'data', 'cloudflare-domain.txt');
    const d = readFileSync(f, 'utf-8').trim();
    if (d) return d;
  } catch {}
  return 'glitch.cothekdesigns.com';
}

let password;
try {
  password = readFileSync(pwFile, 'utf-8').trim();
} catch {
  console.error('Error: .server-password not found at', pwFile);
  process.exit(1);
}
const USERNAME = readUsername();
const authToken = Buffer.from(`${USERNAME}:${password}`).toString('base64');
const AUTH_COOKIE_NAME = 'glitch_auth';

// ---- Session store ---------------------------------------------------------
// `data/` is already gitignored, so the session list never lands in git. Read is
// cached by mtime and pruned of expired entries, so the usual per-request cost is
// one statSync. A missing or corrupt store reads as "no sessions" - it can never
// throw, because Basic auth and ?auth_token= stay independent of this file and
// must keep working even if the store is gone.
const SESSIONS_FILE = resolve(rootDir, 'data', 'auth-sessions.json');
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000; // matches the old cookie Max-Age
const SESSION_EXTEND_AFTER_MS = 60 * 60 * 1000; // throttle: extend at most hourly

let sessionCache = { mtimeMs: -1, data: null };

function emptyStore() {
  return { version: 1, sessions: {} };
}

function readStore() {
  let stat;
  try {
    stat = statSync(SESSIONS_FILE);
  } catch {
    // Deleted or never created: no remembered sessions. Never a lockout, Basic still works.
    return emptyStore();
  }
  if (sessionCache.data && sessionCache.mtimeMs === stat.mtimeMs) return sessionCache.data;

  let parsed;
  try {
    parsed = JSON.parse(readFileSync(SESSIONS_FILE, 'utf-8'));
  } catch {
    console.error('auth-proxy: sessions file unreadable - treating as no sessions');
    parsed = emptyStore();
  }
  if (!parsed || typeof parsed !== 'object' || !parsed.sessions || typeof parsed.sessions !== 'object') {
    parsed = emptyStore();
  }
  const now = Date.now();
  for (const [id, s] of Object.entries(parsed.sessions)) {
    if (!s || typeof s.expiresAt !== 'number' || s.expiresAt <= now) delete parsed.sessions[id];
  }
  sessionCache = { mtimeMs: stat.mtimeMs, data: parsed };
  return parsed;
}

function writeStore(store) {
  try {
    mkdirSync(dirname(SESSIONS_FILE), { recursive: true });
    const tmp = `${SESSIONS_FILE}.tmp`;
    writeFileSync(tmp, JSON.stringify(store), 'utf-8');
    renameSync(tmp, SESSIONS_FILE); // atomic within the same volume
    try {
      sessionCache = { mtimeMs: statSync(SESSIONS_FILE).mtimeMs, data: store };
    } catch {}
    return true;
  } catch (e) {
    // Degrade, never fail the request: the session just will not be remembered.
    console.error('auth-proxy: could not persist sessions:', e.message);
    return false;
  }
}

function createSession() {
  const store = readStore();
  const id = randomBytes(32).toString('hex');
  const now = Date.now();
  store.sessions[id] = { createdAt: now, lastSeenAt: now, expiresAt: now + SESSION_TTL_MS };
  writeStore(store);
  return id;
}

/** Sliding expiry, throttled so an active page does not rewrite the file per request. */
function touchSession(id) {
  const store = readStore();
  const s = store.sessions[id];
  if (!s) return false;
  const now = Date.now();
  if (typeof s.expiresAt !== 'number' || s.expiresAt <= now) return false;
  if (now - (s.lastSeenAt || 0) > SESSION_EXTEND_AFTER_MS) {
    s.lastSeenAt = now;
    s.expiresAt = now + SESSION_TTL_MS;
    writeStore(store);
  }
  return true;
}

function revokeSession(id) {
  const store = readStore();
  if (!store.sessions[id]) return false;
  delete store.sessions[id];
  writeStore(store);
  return true;
}

function revokeAllSessions() {
  const n = Object.keys(readStore().sessions).length;
  writeStore(emptyStore());
  return n;
}

/** Revoke every session EXCEPT one - "log out my other devices". */
function revokeOtherSessions(keepId) {
  const store = readStore();
  let n = 0;
  for (const id of Object.keys(store.sessions)) {
    if (id === keepId) continue;
    delete store.sessions[id];
    n++;
  }
  if (n > 0) writeStore(store);
  return n;
}

function sessionCookie(sid) {
  return `${AUTH_COOKIE_NAME}=${sid}; HttpOnly; Path=/; SameSite=Lax; Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}`;
}

function expiredCookie() {
  return `${AUTH_COOKIE_NAME}=; HttpOnly; Path=/; SameSite=Lax; Max-Age=0`;
}

/** Value of one cookie, or null. */
function readCookie(req, name) {
  const header = req.headers['cookie'];
  if (!header) return null;
  for (const cookie of header.split(';')) {
    const eq = cookie.indexOf('=');
    if (eq === -1) continue;
    if (cookie.slice(0, eq).trim() !== name) continue;
    return cookie.slice(eq + 1).trim();
  }
  return null;
}

const PROXY_PORT = parseInt(process.argv[2] || '4101', 10);
const UPSTREAM_URL = process.argv[3] || 'http://localhost:4102';
const upstream = new URL(UPSTREAM_URL);

/**
 * Resolve the caller's identity.
 * Returns { ok: true, sid, via } or { ok: false }. `sid` is the session id to
 * (re)issue as the cookie, so every authenticated response refreshes it.
 *
 * Order: the session cookie first (the normal path afterwards - and checking it
 * before Basic matters, because a browser holding stale cached Basic credentials
 * would otherwise be judged on a header it cannot stop sending), then Basic,
 * then ?auth_token=, then a pre-sessions cookie which is upgraded in place.
 */
function authenticate(req) {
  const cookieValue = readCookie(req, AUTH_COOKIE_NAME);
  if (cookieValue && touchSession(cookieValue)) {
    return { ok: true, sid: cookieValue, via: 'session' };
  }

  // Authorization: Basic header (browser native dialog, scripts, abort-agent).
  const authHeader = req.headers['authorization'];
  if (authHeader) {
    const match = authHeader.match(/^Basic\s+(.+)$/i);
    if (match && match[1] === authToken) return { ok: true, sid: createSession(), via: 'basic' };
  }

  // ?auth_token= query parameter (bookmarkable one-click URL).
  if (req.url) {
    try {
      const parsed = new URL(req.url, 'http://localhost');
      if (parsed.searchParams.get('auth_token') === authToken) {
        return { ok: true, sid: createSession(), via: 'token' };
      }
    } catch {}
  }

  // Pre-sessions cookie: its value WAS base64(user:pass). Accept it once and let
  // the response swap it for a session id, so this upgrade logs nobody out.
  if (cookieValue && cookieValue === authToken) {
    return { ok: true, sid: createSession(), via: 'legacy-cookie' };
  }

  return { ok: false };
}

/**
 * Merge the glitch_auth HttpOnly cookie into the upstream response headers.
 * Node's res.writeHead(statusCode, headers) REPLACES any same-name header
 * previously set via res.setHeader(), so we must merge set-cookie explicitly
 * here in each proxy branch rather than relying on setHeader() at the top.
 */
function withAuthCookie(upstreamHeaders, sid) {
  const cookie = sessionCookie(sid);
  const merged = { ...upstreamHeaders };
  const upstreamCookies = upstreamHeaders['set-cookie'];
  if (upstreamCookies) {
    merged['set-cookie'] = Array.isArray(upstreamCookies)
      ? [...upstreamCookies, cookie]
      : [upstreamCookies, cookie];
  } else {
    merged['set-cookie'] = cookie;
  }
  return merged;
}

const server = http.createServer((req, res) => {
  // ---- Session routes -------------------------------------------------------
  // Handled before everything else, deliberately: logout must work even when the
  // caller's session is already dead, and whoami is how a client proves a fresh
  // credential pair works without touching the session it is already using.
  if (req.url && req.url.startsWith('/__auth/')) {
    const path = req.url.split('?')[0];
    const auth = authenticate(req);

    if (path === '/__auth/logout') {
      // Idempotent: revoke whichever session the caller presented, if any.
      const sid = readCookie(req, AUTH_COOKIE_NAME);
      const revoked = sid ? revokeSession(sid) : false;
      res.writeHead(200, {
        'Content-Type': 'application/json',
        'Set-Cookie': expiredCookie(),
        'Cache-Control': 'no-store',
      });
      res.end(JSON.stringify({ ok: true, revoked }) + '\n');
      return;
    }

    if (!auth.ok) {
      res.writeHead(401, {
        'WWW-Authenticate': 'Basic realm="Glitch AI", charset="UTF-8"',
        'Content-Type': 'text/plain',
      });
      res.end('Authorization required');
      return;
    }

    if (path === '/__auth/whoami') {
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify({ ok: true, username: readUsername(), via: auth.via }) + '\n');
      return;
    }

    if (path === '/__auth/logout-others') {
      const count = revokeOtherSessions(auth.sid);
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify({ ok: true, revoked: count, kept: 'this session' }) + '\n');
      return;
    }

    if (path === '/__auth/logout-all') {
      const count = revokeAllSessions();
      res.writeHead(200, {
        'Content-Type': 'application/json',
        'Set-Cookie': expiredCookie(),
        'Cache-Control': 'no-store',
      });
      res.end(JSON.stringify({ ok: true, revoked: count }) + '\n');
      return;
    }

    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('Unknown auth route');
    return;
  }

  // ---- Route /money to glitch-money dashboard (port 4110) ----
  // The money dashboard has its own token auth (glitch_dash cookie / Bearer).
  // The proxy does NOT gate /money requests — the dashboard serves its login
  // page publicly and protects /api/* with its own token. This mirrors the
  // dashboard server's own auth model (page shell public, /api/* gated).
  if (req.url && (req.url === '/money' || req.url.startsWith('/money/') || req.url.startsWith('/money?'))) {
    // Normalize /money -> /money/ so relative asset URLs (styles.css) resolve correctly
    if (req.url === '/money' || req.url.startsWith('/money?')) {
      const queryIndex = req.url.indexOf('?');
      const query = queryIndex >= 0 ? req.url.slice(queryIndex) : '';
      res.writeHead(301, { Location: `/money/${query}` });
      res.end();
      return;
    }
    const moneyUpstream = new URL('http://localhost:4110');
    let targetPath = req.url.replace('/money', '') || '/';
    // Strip auth_token from forwarded URL
    try {
      const parsed = new URL(targetPath, 'http://localhost');
      parsed.searchParams.delete('auth_token');
      targetPath = parsed.pathname + parsed.search;
    } catch {}
    const options = {
      hostname: moneyUpstream.hostname,
      port: moneyUpstream.port,
      path: targetPath,
      method: req.method,
      headers: {
        ...(Object.fromEntries(
          Object.entries(req.headers)
            .filter(([key]) => !['host', 'authorization'].includes(key.toLowerCase()))
        )),
        host: moneyUpstream.host,
      },
    };
    const proxyReq = http.request(options, (proxyRes) => {
      res.writeHead(proxyRes.statusCode, proxyRes.headers);
      proxyRes.pipe(res);
    });
    proxyReq.on('error', (err) => {
      console.error(`Money dashboard proxy error for ${req.method} ${req.url}:`, err.message);
      if (!res.headersSent) {
        res.writeHead(502, { 'Content-Type': 'text/plain' });
        res.end('Money dashboard server unavailable');
      }
    });
    req.pipe(proxyReq);
    return;
  }

  // ---- Authentication gate (applies to all paths except /money and /__auth above) ----
  const auth = authenticate(req);
  if (!auth.ok) {
    res.writeHead(401, {
      'WWW-Authenticate': 'Basic realm="Glitch AI", charset="UTF-8"',
      'Content-Type': 'text/plain',
    });
    res.end('Authorization required');
    return;
  }

  // ---- Auth cookie is merged into each proxy branch via withAuthCookie() ----
  // (res.writeHead replaces same-name headers set via res.setHeader, so we
  // cannot set the cookie once at the top — it must be merged per branch.)

  // ---- Route /models to model UI server (port 4104) ----
  if (req.url && (req.url === '/models' || req.url.startsWith('/models/') || req.url.startsWith('/models?'))) {
    const modelUIUpstream = new URL('http://localhost:4104');
    let targetPath = req.url.replace('/models', '') || '/';
    // Strip auth_token from forwarded URL
    try {
      const parsed = new URL(targetPath, 'http://localhost');
      parsed.searchParams.delete('auth_token');
      targetPath = parsed.pathname + parsed.search;
    } catch {}
    const options = {
      hostname: modelUIUpstream.hostname,
      port: modelUIUpstream.port,
      path: targetPath,
      method: req.method,
      headers: {
        ...(Object.fromEntries(
          Object.entries(req.headers)
            .filter(([key]) => !['host', 'authorization'].includes(key.toLowerCase()))
        )),
        host: modelUIUpstream.host,
      },
    };
    const proxyReq = http.request(options, (proxyRes) => {
      res.writeHead(proxyRes.statusCode, withAuthCookie(proxyRes.headers, auth.sid));
      proxyRes.pipe(res);
    });
    proxyReq.on('error', (err) => {
      console.error(`Model UI proxy error for ${req.method} ${req.url}:`, err.message);
      if (!res.headersSent) {
        res.writeHead(502, { 'Content-Type': 'text/plain' });
        res.end('Model UI server unavailable');
      }
    });
    req.pipe(proxyReq);
    return;
  }

  // ---- Route /plugins/glitch-ui/* to model UI server (port 4104) ----
  if (req.url && req.url.startsWith('/plugins/glitch-ui/')) {
    const modelUIUpstream = new URL('http://localhost:4104');
    let targetPath = req.url;
    // Strip auth_token from forwarded URL
    try {
      const parsed = new URL(targetPath, 'http://localhost');
      parsed.searchParams.delete('auth_token');
      targetPath = parsed.pathname + parsed.search;
    } catch {}
    const options = {
      hostname: modelUIUpstream.hostname,
      port: modelUIUpstream.port,
      path: targetPath,
      method: req.method,
      headers: {
        ...(Object.fromEntries(
          Object.entries(req.headers)
            .filter(([key]) => !['host', 'authorization'].includes(key.toLowerCase()))
        )),
        host: modelUIUpstream.host,
      },
    };
    const proxyReq = http.request(options, (proxyRes) => {
      res.writeHead(proxyRes.statusCode, withAuthCookie(proxyRes.headers, auth.sid));
      proxyRes.pipe(res);
    });
    proxyReq.on('error', (err) => {
      console.error(`Model UI asset proxy error for ${req.method} ${req.url}:`, err.message);
      if (!res.headersSent) {
        res.writeHead(502, { 'Content-Type': 'text/plain' });
        res.end('Model UI asset server unavailable');
      }
    });
    req.pipe(proxyReq);
    return;
  }

  // Strip directory and workspace params from /agent requests
  // (server bug: workspace crashes, directory filters out custom agents)
  let targetPath = req.url;
  if (req.url) {
    try {
      const url = new URL(req.url, 'http://localhost');
      if (url.pathname === '/agent') {
        url.searchParams.delete('directory');
        url.searchParams.delete('workspace');
      }
      // Strip auth_token from forwarded URL (upstream doesn't need it)
      url.searchParams.delete('auth_token');
      targetPath = url.pathname + url.search;
    } catch {}
  }

  const options = {
    hostname: upstream.hostname,
    port: upstream.port || 80,
    path: targetPath,
    method: req.method,
    headers: {
      ...(Object.fromEntries(
        Object.entries(req.headers)
          .filter(([key]) => !['host', 'authorization'].includes(key.toLowerCase()))
      )),
      host: upstream.host,
      authorization: `Basic ${authToken}`,
    },
  };

  const proxyReq = http.request(options, (proxyRes) => {
    // For API responses, disable caching so sessions always refresh
    if (targetPath.startsWith('/api/') || targetPath.startsWith('/session/') || targetPath.startsWith('/assets/')) {
      proxyRes.headers['cache-control'] = 'no-cache, no-store, must-revalidate';
      proxyRes.headers['pragma'] = 'no-cache';
      proxyRes.headers['expires'] = '0';
    }
    res.writeHead(proxyRes.statusCode, withAuthCookie(proxyRes.headers, auth.sid));
    proxyRes.pipe(res);
  });

  proxyReq.on('error', (err) => {
    console.error(`Proxy error for ${req.method} ${req.url}:`, err.message);
    if (!res.headersSent) {
      res.writeHead(502, { 'Content-Type': 'text/plain' });
      res.end('Bad Gateway');
    }
  });

  req.pipe(proxyReq);
});

// ---- WebSocket upgrades ------------------------------------------------------
// Without an 'upgrade' listener Node destroys every upgrade request, so the
// SPA's wss:// connection dies and the app hangs on "connecting" forever when
// opened through the tunnel (localhost works because it talks to :8787
// directly). Browsers cannot set an Authorization header on a WebSocket, so
// remote WS clients authenticate with the glitch_auth session cookie (set on
// any earlier HTTP response; same-origin WS carries cookies) or ?auth_token=.
server.on('upgrade', (req, socket, head) => {
  const auth = authenticate(req);
  if (!auth.ok) {
    socket.write(
      'HTTP/1.1 401 Unauthorized\r\n' +
        'WWW-Authenticate: Basic realm="Glitch AI", charset="UTF-8"\r\n' +
        'Content-Type: text/plain\r\n' +
        'Content-Length: 22\r\n' +
        'Connection: close\r\n' +
        '\r\n' +
        'Authorization required'
    );
    socket.destroy();
    return;
  }

  // Same routing table as the HTTP branches above: /money -> :4110,
  // /models and /plugins/glitch-ui/* -> :4104, everything else -> the upstream.
  // auth_token is stripped, it must never reach the origin.
  let targetPath = req.url || '/';
  try {
    const parsed = new URL(targetPath, 'http://localhost');
    parsed.searchParams.delete('auth_token');
    targetPath = parsed.pathname + parsed.search;
  } catch {}

  const url = req.url || '';
  let target;
  let forwardCredentials = true; // the default branch injects Basic like the HTTP proxy does
  if (url === '/money' || url.startsWith('/money/') || url.startsWith('/money?')) {
    target = new URL('http://localhost:4110');
    forwardCredentials = false;
  } else if (
    url === '/models' ||
    url.startsWith('/models/') ||
    url.startsWith('/models?') ||
    url.startsWith('/plugins/glitch-ui/')
  ) {
    target = new URL('http://localhost:4104');
    forwardCredentials = false;
  } else {
    target = upstream;
  }

  const headers = Object.fromEntries(
    Object.entries(req.headers).filter(([key]) => !['host', 'authorization'].includes(key.toLowerCase()))
  );
  headers.host = target.host;
  if (forwardCredentials) headers.authorization = `Basic ${authToken}`;

  const proxyReq = http.request({
    hostname: target.hostname,
    port: target.port || 80,
    path: targetPath,
    method: req.method,
    headers,
  });

  proxyReq.on('upgrade', (proxyRes, proxySocket, proxyHead) => {
    // Raw socket from here: status line and headers written by hand.
    let out = `HTTP/1.1 ${proxyRes.statusCode} ${proxyRes.statusMessage || ''}\r\n`;
    for (let i = 0; i < proxyRes.rawHeaders.length; i += 2) {
      out += `${proxyRes.rawHeaders[i]}: ${proxyRes.rawHeaders[i + 1]}\r\n`;
    }
    out += '\r\n';
    socket.write(out);
    if (head?.length) proxySocket.write(head);
    if (proxyHead?.length) socket.write(proxyHead);
    proxySocket.pipe(socket);
    socket.pipe(proxySocket);
    const kill = () => {
      proxySocket.destroy();
      socket.destroy();
    };
    proxySocket.on('error', kill);
    socket.on('error', kill);
    proxySocket.on('close', () => socket.destroy());
    socket.on('close', () => proxySocket.destroy());
  });

  // Upstream answered with a plain HTTP response instead of an upgrade (bad
  // path, ws disabled): forward it once, then both ends close on their own.
  proxyReq.on('response', (proxyRes) => {
    let out = `HTTP/1.1 ${proxyRes.statusCode} ${proxyRes.statusMessage || ''}\r\n`;
    for (let i = 0; i < proxyRes.rawHeaders.length; i += 2) {
      out += `${proxyRes.rawHeaders[i]}: ${proxyRes.rawHeaders[i + 1]}\r\n`;
    }
    out += '\r\n';
    socket.write(out);
    proxyRes.pipe(socket);
  });

  proxyReq.on('error', (err) => {
    console.error(`Upgrade proxy error for ${req.method} ${req.url}:`, err.message);
    socket.write(
      'HTTP/1.1 502 Bad Gateway\r\n' +
        'Content-Type: text/plain\r\n' +
        'Content-Length: 11\r\n' +
        'Connection: close\r\n' +
        '\r\n' +
        'Bad Gateway'
    );
    socket.destroy();
  });

  proxyReq.end();
});

server.listen(PROXY_PORT, () => {
  console.log(`  Auth proxy listening on :${PROXY_PORT} -> ${UPSTREAM_URL}`);
  console.log(`  /models -> http://localhost:4104`);
  console.log(`  /plugins/glitch-ui/ -> http://localhost:4104`);
  console.log(`  Auth: Basic header | ?auth_token= | glitch_auth cookie`);
  console.log('');
  console.log(`  === Pi web UI login ===`);
  console.log(`   Username:  ${USERNAME}`);
  console.log(`   Password:  ${password}`);
  console.log(`   Remote:    https://${tunnelHost()}`);
  // Local URL = our actual upstream (argv[3]), not a hardcoded port - the proxy
  // is also started on alternate ports by scripts\pi-stack-window.ps1.
  console.log(`   Local:     ${UPSTREAM_URL.replace(/\/$/, '')}  (no auth needed)`);
  console.log('');
});
