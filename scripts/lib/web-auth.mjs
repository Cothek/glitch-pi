#!/usr/bin/env node
// scripts/lib/web-auth.mjs - single source of truth for Pi web UI login info.
//
// The Pi web UI (pi-web-ui :8787) is gated by plugins/auth-proxy.mjs (:4103),
// which enforces HTTP Basic auth: username = the trimmed contents of
// .server-username, password = the trimmed contents of .server-password (both
// repo root, gitignored, both optional - see below).
//
// IMPORTANT: plugins/auth-proxy.mjs deliberately does NOT import this module.
// The auth gate stays dependency-free (node builtins only) so a broken import
// can never take remote login down. It resolves the SAME two files with its own
// local readers (mirroring its local tunnelHost() copy), so the two agree
// without sharing code. Change the resolution rules here and change them there.
//
// Both credential files are OPTIONAL. Missing .server-username means the
// AUTH_USERNAME default; missing .server-password is an error in the gate (no
// login possible). That keeps an existing install byte-identical: no file, no
// change, and existing cookies keep working.

import { existsSync, readFileSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

/** Default username, used when .server-username is absent. */
export const AUTH_USERNAME = 'opencode';

// Port overrides exist for alternate-port test runs (scripts\pi-stack-window.ps1
// exports them). Display only - the token itself never depends on the ports.
export const WEBUI_PORT = Number(process.env.GLITCH_PI_WEBUI_PORT) || 8787;
export const AUTH_PORT = Number(process.env.GLITCH_PI_AUTH_PORT) || 4103;
export const PASSWORD_FILE = join(ROOT_DIR, '.server-password');
export const USERNAME_FILE = join(ROOT_DIR, '.server-username');
export const DEFAULT_TUNNEL_HOST = 'glitch.cothekdesigns.com';

/** Trimmed password from .server-password, or null when the file is missing. */
export function readPassword() {
  try {
    const pw = readFileSync(PASSWORD_FILE, 'utf-8').trim();
    return pw || null;
  } catch {
    return null;
  }
}

/**
 * Effective login username: .server-username when set, else AUTH_USERNAME.
 * Mirrored in plugins/auth-proxy.mjs (local reader, no import) - keep in sync.
 */
export function readUsername() {
  try {
    const u = readFileSync(USERNAME_FILE, 'utf-8').trim();
    return u || AUTH_USERNAME;
  } catch {
    return AUTH_USERNAME;
  }
}

/** base64("username:password") - the exact token the auth proxy accepts. */
export function authToken(password = readPassword()) {
  return password ? Buffer.from(`${readUsername()}:${password}`).toString('base64') : null;
}

/** Public tunnel hostname (data/cloudflare-domain.txt override, else default). */
export function tunnelHost() {
  try {
    const f = join(ROOT_DIR, 'data', 'cloudflare-domain.txt');
    if (existsSync(f)) {
      const d = readFileSync(f, 'utf-8').trim();
      if (d) return d;
    }
  } catch {}
  return DEFAULT_TUNNEL_HOST;
}

export function localUrl() { return `http://localhost:${WEBUI_PORT}`; }
export function remoteUrl() { return `https://${tunnelHost()}`; }

/** One-click login URL (contains the password - treat it as a secret). */
export function oneClickUrl() {
  const t = authToken();
  return t ? `${remoteUrl()}/?auth_token=${t}` : null;
}

/**
 * Print the login banner.
 * @param {object} [opts]
 * @param {(line: string) => void} [opts.write] sink for each line (default: console.log)
 * @param {boolean} [opts.color] emit ANSI colors (default: true)
 * @param {string|null} [opts.password] override password (default: read .server-password)
 */
export function printLoginBanner(opts = {}) {
  const write = opts.write || ((line) => console.log(line));
  const color = opts.color !== false;
  const password = 'password' in opts ? opts.password : readPassword();

  const c = (code, s) => (color ? `\x1b[${code}m${s}\x1b[0m` : s);
  const BOLD = (s) => c('1', s);
  const CYAN = (s) => c('36', s);
  const DIM = (s) => c('90', s);
  const GREEN = (s) => c('32', s);

  write('');
  write(BOLD('  === Pi web UI login ==='));
  write('');
  if (!password) {
    write(`  ${c('33', 'No password set.')} Run: node scripts/set-credentials.mjs`);
    write(DIM(`  Expected file: ${PASSWORD_FILE}`));
    write('');
    return;
  }

  write(`   Username:  ${BOLD(readUsername())}`);
  write(`   Password:  ${BOLD(password)}`);
  write('');
  write(`   Local:     ${CYAN(localUrl())}  ${DIM('(no auth needed)')}`);
  write(`   Remote:    ${CYAN(remoteUrl())}`);
  const one = oneClickUrl();
  if (one) {
    write('');
    write(`   One-click login ${DIM('(bookmarkable, contains the password)')}:`);
    write(`   ${DIM(one)}`);
  }
  write('');
  write(DIM(`   Username lives in ${USERNAME_FILE} (optional, default ${AUTH_USERNAME})`));
  write(DIM(`   Password lives in ${PASSWORD_FILE}`));
  write(DIM('   Change either with: node scripts/set-credentials.mjs'));
  write(GREEN('   (changing the username or password does NOT log you out - sessions are separate; use --revoke-sessions to log out)'));
  write('');
}
