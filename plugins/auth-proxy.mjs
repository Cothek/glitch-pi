/**
 * Auth Proxy — sits between cloudflare tunnel and opencode web server.
 * Enforces HTTP Basic Auth on incoming requests. Valid credentials
 * are forwarded to the upstream server with the auth header injected.
 *
 * Credentials accepted via:
 *   - Authorization: Basic <base64> header (browser native auth dialog)
 *   - ?auth_token=<base64> query parameter (bookmarkable one-click URL)
 *   - glitch_auth=<base64> HttpOnly cookie (set automatically on any
 *     successful auth; covers SPA internal fetches that carry no
 *     credentials, e.g. Model Switcher /models/api/* calls)
 *
 * Usage: node plugins/auth-proxy.mjs [port] [upstream]
 *   Default port: 4101
 *   Default upstream: http://localhost:4102
 */

import http from 'node:http';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const rootDir = resolve(__dirname, '..');
const pwFile = resolve(rootDir, '.server-password');

// Login details printed on startup. The username MUST match
// scripts/lib/web-auth.mjs (AUTH_USERNAME) - that module is the single source
// of truth for the banner printed by the launchers. This file stays
// dependency-free on purpose (node builtins only) so the auth gate can never
// be taken down by a broken import.
const USERNAME = 'opencode';

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
const authToken = Buffer.from(`${USERNAME}:${password}`).toString('base64');
const AUTH_COOKIE = `glitch_auth=${authToken}; HttpOnly; Path=/; SameSite=Lax; Max-Age=604800`;

const PROXY_PORT = parseInt(process.argv[2] || '4101', 10);
const UPSTREAM_URL = process.argv[3] || 'http://localhost:4102';
const upstream = new URL(UPSTREAM_URL);

/**
 * Extract and validate credentials from request.
 * Returns true if auth matches, false otherwise.
 * Checks: Authorization header, then auth_token query param, then glitch_auth cookie.
 */
function isAuthenticated(req) {
  // Check Authorization header
  const authHeader = req.headers['authorization'];
  if (authHeader) {
    const match = authHeader.match(/^Basic\s+(.+)$/i);
    if (match && match[1] === authToken) {
      return true;
    }
  }

  // Check auth_token query parameter (bookmarkable URL support)
  if (req.url) {
    try {
      const parsed = new URL(req.url, 'http://localhost');
      const tokenParam = parsed.searchParams.get('auth_token');
      if (tokenParam === authToken) {
        return true;
      }
    } catch {}
  }

  // Check glitch_auth HttpOnly cookie (set on any successful auth; covers
  // SPA internal fetches that carry no Authorization header or query param)
  const cookieHeader = req.headers['cookie'];
  if (cookieHeader) {
    const cookies = cookieHeader.split(';');
    for (const cookie of cookies) {
      const eq = cookie.indexOf('=');
      if (eq === -1) continue;
      const name = cookie.slice(0, eq).trim();
      const value = cookie.slice(eq + 1).trim();
      if (name === 'glitch_auth' && value === authToken) {
        return true;
      }
    }
  }

  return false;
}

/**
 * Merge the glitch_auth HttpOnly cookie into the upstream response headers.
 * Node's res.writeHead(statusCode, headers) REPLACES any same-name header
 * previously set via res.setHeader(), so we must merge set-cookie explicitly
 * here in each proxy branch rather than relying on setHeader() at the top.
 */
function withAuthCookie(upstreamHeaders) {
  const merged = { ...upstreamHeaders };
  const upstreamCookies = upstreamHeaders['set-cookie'];
  if (upstreamCookies) {
    merged['set-cookie'] = Array.isArray(upstreamCookies)
      ? [...upstreamCookies, AUTH_COOKIE]
      : [upstreamCookies, AUTH_COOKIE];
  } else {
    merged['set-cookie'] = AUTH_COOKIE;
  }
  return merged;
}

const server = http.createServer((req, res) => {
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

  // ---- Authentication gate (applies to all paths except /money above) ----
  if (!isAuthenticated(req)) {
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
      res.writeHead(proxyRes.statusCode, withAuthCookie(proxyRes.headers));
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
      res.writeHead(proxyRes.statusCode, withAuthCookie(proxyRes.headers));
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
    res.writeHead(proxyRes.statusCode, withAuthCookie(proxyRes.headers));
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
