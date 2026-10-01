#!/usr/bin/env node

// Cross-platform dependency update subsystem for the Glitch PI launcher.
// Reads config/tools.json, compares installed vs latest for npm globals and
// standalone binaries, writes data/update-status.json, and can apply updates
// with backup + rollback. Ported in policy (not in code) from the
// glitch-ai PowerShell module.

import {
  readFileSync,
  writeFileSync,
  existsSync,
  mkdirSync,
  rmSync,
  statSync,
  copyFileSync,
  createWriteStream,
  readdirSync,
  renameSync,
  utimesSync
} from 'node:fs';
import { spawn } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline';
import { request as httpsRequest } from 'node:https';
import { request as httpRequest } from 'node:http';
import { tmpdir } from 'node:os';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const DEFAULT_CWD = join(__dirname, '..');

const DEFAULT_MANIFEST = join(DEFAULT_CWD, 'config', 'tools.json');
const STATUS_FILE_NAME = 'update-status.json';

const NPM_TIMEOUT_MS = 120_000;
const PROBE_TIMEOUT_MS = 20_000;
const DOWNLOAD_TIMEOUT_MS = 180_000;
const HTTP_TIMEOUT_MS = 20_000;

// Dedicated cap for `npm i -g` applies. WHY NOT NPM_TIMEOUT_MS: the 120s
// query cap used to bound installs too, but the bundled packages are huge
// (pi-coding-agent ~440MB tree, pi-web-ui ~675MB). A healthy install can
// legitimately run past 2 minutes, and a timeout-kill mid-install is the
// worst outcome possible: rollback fires only on npm's own non-zero exit,
// never on a killed process, so a half-written tree is left behind.
// 10 minutes matches RESTORE_TIMEOUT_MS, the existing install precedent.
// Feedback during the wait comes from streamed npm output + heartbeat below,
// so a long install is visible, never silent.
const INSTALL_TIMEOUT_MS = 600_000;

const MAX_BACKUPS_PER_PACKAGE = 2;

const NO_COLOR = !process.stdout.isTTY || process.env.NO_COLOR === '1' || process.env.TERM === 'dumb';
const DIM = NO_COLOR ? '' : '\x1b[2m';
const GREEN = NO_COLOR ? '' : '\x1b[32m';
const YELLOW = NO_COLOR ? '' : '\x1b[33m';
const CYAN = NO_COLOR ? '' : '\x1b[36m';
const RED = NO_COLOR ? '' : '\x1b[31m';
const RESET = NO_COLOR ? '' : '\x1b[0m';

function colorize(color, msg) {
  return color ? `${color}${msg}${RESET}` : msg;
}
const dim    = (m) => colorize(DIM, m);
const green  = (m) => colorize(GREEN, m);
const yellow = (m) => colorize(YELLOW, m);
const cyan   = (m) => colorize(CYAN, m);
const red    = (m) => colorize(RED, m);

// ── Progress output (stderr) ────────────────────────────────────────────────
//
// EVERYTHING in this block writes to stderr, never stdout. WHY: stdout is a
// machine contract here (--json must parse as pure JSON; the human --apply
// path prints exact summary lines), while stderr is the human channel. The
// launcher's tee (scripts/lib/launch-log.mjs) wraps stderr too, so progress
// also lands in data/launch.log for post-mortems.

function emitLine(msg) {
  try { process.stderr.write(`${msg}\n`); } catch {}
}
const note       = (m) => emitLine(m);
const noteDim    = (m) => emitLine(colorize(DIM, m));
const noteCyan   = (m) => emitLine(colorize(CYAN, m));
const noteGreen  = (m) => emitLine(colorize(GREEN, m));
const noteYellow = (m) => emitLine(colorize(YELLOW, m));
const noteRed    = (m) => emitLine(colorize(RED, m));

// In-place progress line. TTY: `\r` rewrites one line (padded so shorter
// updates erase longer ones). Non-TTY (detached restart service, pipes):
// at most one line every 10s so logs stay readable.
let _lastProgressAt = 0;
function progressInPlace(text) {
  const now = Date.now();
  if (process.stderr.isTTY) {
    try { process.stderr.write(`\r${text}`.padEnd(100).slice(0, 100)); } catch {}
    _lastProgressAt = now;
    return;
  }
  if (now - _lastProgressAt >= 10_000) {
    _lastProgressAt = now;
    emitLine(text);
  }
}

// Close the in-place line and print the final result on a fresh line.
function progressDone(text) {
  if (process.stderr.isTTY) {
    try { process.stderr.write(`\r${text}`.padEnd(100).slice(0, 100) + '\n'); } catch {}
    _lastProgressAt = Date.now();
    return;
  }
  if (text) emitLine(text);
}

function fmtBytes(n) {
  if (!Number.isFinite(n) || n <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  let v = n;
  let u = 0;
  while (v >= 1024 && u < units.length - 1) { v /= 1024; u++; }
  return `${v >= 100 || u === 0 ? Math.round(v) : v.toFixed(1)} ${units[u]}`;
}

function elapsedSince(startMs) {
  const s = Math.max(0, Math.round((Date.now() - startMs) / 1000));
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m${String(s % 60).padStart(2, '0')}s`;
}

// ── CLI / option parsing ────────────────────────────────────────────────────

function parseCliArgs(argv) {
  const opts = {
    checkOnly: false,
    apply: false,
    yes: false,
    prompt: false,
    json: false,
    filter: []
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--check-only') opts.checkOnly = true;
    else if (a === '--apply') opts.apply = true;
    else if (a === '--yes') opts.yes = true;
    else if (a === '--prompt') opts.prompt = true;
    else if (a === '--json') opts.json = true;
    else if (a === '--filter' && i + 1 < argv.length) {
      opts.filter = argv[++i].split(',').map((s) => s.trim()).filter(Boolean);
    }
  }
  return opts;
}

// ── Manifest helpers ────────────────────────────────────────────────────────

function readManifest(cwd) {
  const manifestPath = join(cwd, 'config', 'tools.json');
  if (!existsSync(manifestPath)) return { manifestPath, manifest: null };
  try {
    const raw = readFileSync(manifestPath, 'utf8');
    const parsed = JSON.parse(raw);
    return { manifestPath, manifest: parsed };
  } catch (err) {
    return { manifestPath, manifest: null, error: err.message };
  }
}

// ── Process invocation (timeout-bounded, no shell) ─────────────────────────

// opts (all optional, additive):
//   onOutput(chunk: string, isStderr: bool) - live child output as it arrives.
//       The stdout/stderr collectors below keep working unchanged, so the
//       failure path still has the full buffered text.
//   heartbeatMs + onHeartbeat(elapsedSec) - liveness ticks while the child
//       runs. Bounded ops (npm install of 400MB+ packages) used to look like
//       dead air for minutes; the heartbeat proves the process is alive.
function runProcess(cmd, args, opts = {}) {
  return new Promise((resolve) => {
    let fullArgs = args;
    let fullCmd = cmd;
    // Windows .cmd / .bat cannot be spawned directly with execFile-like args;
    // route through cmd.exe to avoid CreateProcess quoting quirks.
    if (process.platform === 'win32' && (cmd.endsWith('.cmd') || cmd.endsWith('.bat'))) {
      fullArgs = ['/d', '/s', '/c', cmd, ...args];
      fullCmd = 'cmd.exe';
    }
    const child = spawn(fullCmd, fullArgs, { stdio: 'pipe', ...opts });
    let stdout = '';
    let stderr = '';
    let settled = false;
    const startedAt = Date.now();
    let heartbeat = null;
    const settle = (result) => {
      if (settled) return;
      settled = true;
      if (heartbeat) { clearInterval(heartbeat); heartbeat = null; }
      clearTimeout(timer);
      resolve(result);
    };
    const timer = setTimeout(() => {
      settle({ success: false, status: -1, stdout, stderr, error: 'timeout' });
      try { child.kill('SIGKILL'); } catch {}
    }, opts.timeout ?? 30_000);
    if (opts.heartbeatMs && typeof opts.onHeartbeat === 'function') {
      heartbeat = setInterval(() => {
        try { opts.onHeartbeat(Math.round((Date.now() - startedAt) / 1000)); } catch {}
      }, opts.heartbeatMs);
    }

    if (child.stdout) {
      child.stdout.on('data', (b) => {
        stdout += b.toString();
        if (opts.onOutput) { try { opts.onOutput(b.toString(), false); } catch {} }
      });
    }
    if (child.stderr) {
      child.stderr.on('data', (b) => {
        stderr += b.toString();
        if (opts.onOutput) { try { opts.onOutput(b.toString(), true); } catch {} }
      });
    }
    child.on('error', (err) => {
      settle({ success: false, status: -1, stdout, stderr, error: err.message });
    });
    child.on('close', (code) => {
      settle({ success: code === 0, status: code ?? -1, stdout, stderr });
    });
  });
}

function probeBinary(binaryPath) {
  // Avoid shell:true for binary version checks; shell concatenates args on
  // Windows and breaks flags when paths contain spaces.
  return (async () => {
    const probes = [
      { args: ['--version'], timeout: PROBE_TIMEOUT_MS },
      { args: ['-version'], timeout: PROBE_TIMEOUT_MS }
    ];
    for (const probe of probes) {
      const res = await runProcess(binaryPath, probe.args, { timeout: probe.timeout });
      if (res.success && res.stdout) return { success: true, output: res.stdout };
    }
    return { success: false, output: '' };
  })();
}

// ── Version detection ───────────────────────────────────────────────────────

// Resolve the bundled npm binary by absolute path. WHY: data/node IS the
// project's npm global prefix, so installs and `npm view` / `npm list` must
// run against the bundled copy. A system npm earlier on PATH would install
// to the user's roaming profile or an nvm tree, the version check would
// keep reporting the old number, and the update would silently never take
// effect.
function bundledNpmDir(cwd) {
  return join(cwd, 'data', 'node');
}

// Build the npm invocation as a [cmd, args] pair. WHY: this repo lives at
// `E:\Glitch AI\glitch-pi`, a path containing a space. The previous
// `npm.cmd` resolution passed an absolute path to `runProcess`, which
// routed `.cmd` files through cmd.exe as `cmd.exe /d /s /c "<path>"
// <args>` with the path UNQUOTED. cmd.exe then split on the first space,
// saw `E:\Glitch`, and returned `'E:\Glitch' is not recognized as an
// internal or external command`. Spawning `node.exe npm-cli.js <args>`
// directly avoids cmd.exe entirely, so argv is preserved verbatim and the
// space in the path is irrelevant. The bundle's node.exe is preferred
// over `process.execPath` so the same Node version the bundled npm was
// designed for runs the CLI; process.execPath is the fallback when the
// bundle's node.exe is missing.
function bundledNpmInvocation(cwd) {
  const bundledNode = join(cwd, 'data', 'node', 'node.exe');
  const npmCli = join(cwd, 'data', 'node', 'node_modules', 'npm', 'bin', 'npm-cli.js');
  if (existsSync(npmCli)) {
    const cmd = existsSync(bundledNode) ? bundledNode : process.execPath;
    return [cmd, [npmCli]];
  }
  // Fallback: npm-cli.js is not in the bundle (e.g. a fresh checkout).
  // Best-effort only. This branch is unreachable while
  // data/node/node_modules/npm/bin/npm-cli.js exists, so on a normal
  // install the bundled-npm happy path above handles every call. When it
  // does fire, the npm.cmd shim path is passed UNQUOTED. runProcess
  // already routes .cmd through cmd.exe as `cmd.exe /d /s /c <path>
  // <args>`, so CreateProcess quotes the <path> argument and a space in
  // the repo path is preserved. Wrapping the path in literal double
  // quotes here breaks that on modern Node (Node 20+), because cmd /c
  // then receives one fused `"..."` argument and reports
  // `'"<path>"' is not recognized`; a direct spawn of the quoted string
  // returns ENOENT. So: no quotes around the shim path. The non-Windows
  // path is plain and needs no quoting either.
  const shim = process.platform === 'win32'
    ? join(bundledNpmDir(cwd), 'npm.cmd')
    : join(bundledNpmDir(cwd), 'bin', 'npm');
  return [shim, []];
}

// Build a child-process env that forces every npm invocation to use the
// bundled prefix and to find `node` / `npm` inside data/node first. WHY:
// without this, npm on PATH may belong to a different installation and the
// resulting package would land outside data/node/node_modules.
function buildNpmEnv(cwd) {
  const prefix = bundledNpmDir(cwd);
  const sep = process.platform === 'win32' ? ';' : ':';
  const pathKey = process.platform === 'win32' ? 'Path' : 'PATH';
  const currentPath = process.env[pathKey] || process.env.PATH || '';
  // One entry per env var: setting both `Path` and `PATH` on Windows
  // silently duplicates the same value (Windows is case-insensitive on env
  // names) and on POSIX the two keys collapse to the same property, so a
  // single write through `pathKey` is enough.
  return {
    ...process.env,
    npm_config_prefix: prefix,
    [pathKey]: `${prefix}${sep}${currentPath}`
  };
}

function readNpmInstalledVersion(cwd, packageName) {
  // Fast path: read version directly from the bundled node_modules tree.
  // The bundled tree at data/node/node_modules IS the npm global prefix,
  // and this avoids spawning npm for every check.
  try {
    const pkgJsonPath = join(cwd, 'data', 'node', 'node_modules', packageName, 'package.json');
    if (existsSync(pkgJsonPath)) {
      const raw = readFileSync(pkgJsonPath, 'utf8');
      const pkg = JSON.parse(raw);
      if (pkg.version) return String(pkg.version);
    }
  } catch {}
  // Fallback: ask npm via JSON output so scoped packages (@scope/pkg@x.y.z)
  // parse correctly. Last-resort substring uses the last `@` because scoped
  // package names contain one before the version.
  const [npmCmd, npmArgv] = bundledNpmInvocation(cwd);
  return runProcess(
    npmCmd,
    [...npmArgv, 'list', '-g', '--depth=0', '--json', packageName],
    { timeout: NPM_TIMEOUT_MS, env: buildNpmEnv(cwd) }
  ).then((res) => {
    if (!res.success) return null;
    try {
      const parsed = JSON.parse(res.stdout);
      const v = parsed?.dependencies?.[packageName]?.version;
      if (v) return String(v);
    } catch {}
    const lines = res.stdout.split(/\r?\n/);
    for (const raw of lines) {
      if (!raw.includes(packageName)) continue;
      const at = raw.lastIndexOf('@');
      if (at < 0 || at === raw.length - 1) continue;
      const candidate = raw.slice(at + 1).trim();
      if (candidate) return candidate;
    }
    return null;
  });
}

function readNpmLatestVersion(cwd, packageName) {
  // `npm view <pkg> version` prints just the latest semver string.
  const [npmCmd, npmArgv] = bundledNpmInvocation(cwd);
  return runProcess(
    npmCmd,
    [...npmArgv, 'view', packageName, 'version'],
    { timeout: NPM_TIMEOUT_MS, env: buildNpmEnv(cwd) }
  ).then((res) => {
    if (!res.success) return null;
    return res.stdout.split(/\r?\n/).map((l) => l.trim()).find(Boolean) || null;
  });
}

async function readBinaryInstalledVersion(cwd, binaryPath) {
  let candidate = binaryPath;
  if (!existsSync(candidate)) {
    // Binary path can be a repo-relative name; resolve under cwd.
    candidate = join(cwd, binaryPath);
    if (!existsSync(candidate)) return null;
  }
  const probe = await probeBinary(candidate);
  if (!probe.success) return null;
  const m = probe.output.match(/(\d+\.\d+(?:\.\d+)?)/);
  return m ? m[1] : null;
}

// ── semver-ish comparison ───────────────────────────────────────────────────

// Intentionally minimal: not full semver. Handles the dotted triples we see
// in practice, plus a leading 'v' and common prerelease tags. Unknown / null
// inputs return false from isHigher so call sites can skip safely.
function parseVersion(v) {
  if (typeof v !== 'string' || !v.trim()) return null;
  const cleaned = v.trim().replace(/^v/i, '');
  const m = cleaned.match(/^(\d+)\.(\d+)(?:\.(\d+))?(?:[-+](.+))?$/);
  if (!m) return null;
  const major = Number(m[1]);
  const minor = Number(m[2]);
  const patch = m[3] === undefined ? 0 : Number(m[3]);
  if (!Number.isFinite(major) || !Number.isFinite(minor) || !Number.isFinite(patch)) return null;
  return { major, minor, patch, prerelease: m[4] || '' };
}

export function isHigher(latest, current) {
  const a = parseVersion(latest);
  const b = parseVersion(current);
  if (!a || !b) return false;
  if (a.major !== b.major) return a.major > b.major;
  if (a.minor !== b.minor) return a.minor > b.minor;
  if (a.patch !== b.patch) return a.patch > b.patch;
  // Equal numeric versions: stable beats prerelease.
  if (!a.prerelease && b.prerelease) return true;
  if (a.prerelease && !b.prerelease) return false;
  if (a.prerelease && b.prerelease) return a.prerelease > b.prerelease;
  return false;
}

// ── Binary latest via GitHub releases/latest redirect ────────────────────────

function followGithubLatest(url) {
  return new Promise((resolve) => {
    let parsed;
    try { parsed = new URL(url); } catch { resolve(null); return; }
    if (!/^\/[^/]+\/[^/]+\/releases\/latest$/i.test(parsed.pathname)) {
      resolve(null);
      return;
    }
    const transport = parsed.protocol === 'http:' ? httpRequest : httpsRequest;
    const req = transport(url, { method: 'GET', timeout: HTTP_TIMEOUT_MS }, (res) => {
      res.resume();
      if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        const tag = decodeURIComponent(res.headers.location.split('/').filter(Boolean).pop() || '');
        const cleaned = tag.replace(/^v/i, '');
        resolve({ tag, cleaned });
        return;
      }
      resolve(null);
    });
    req.on('error', () => resolve(null));
    req.on('timeout', () => { req.destroy(); resolve(null); });
    req.end();
  });
}

// ── Node.js latest version via nodejs.org/dist/index.json ──────────────────

export async function fetchNodejsLatest() {
  return new Promise((resolve) => {
    const url = 'https://nodejs.org/dist/index.json';
    const transport = httpsRequest;
    const req = transport(url, { method: 'GET', timeout: HTTP_TIMEOUT_MS }, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        try {
          const releases = JSON.parse(data);
          // Find the latest LTS release
          const latestLTS = releases.find((r) => r.lts !== false && r.version);
          if (latestLTS) {
            resolve({ tag: latestLTS.version, cleaned: latestLTS.version.replace(/^v/i, '') });
          } else {
            // Fallback to latest release
            const latest = releases.find((r) => r.version);
            if (latest) {
              resolve({ tag: latest.version, cleaned: latest.version.replace(/^v/i, '') });
            } else {
              resolve(null);
            }
          }
        } catch {
          resolve(null);
        }
      });
    });
    req.on('error', () => resolve(null));
    req.on('timeout', () => { req.destroy(); resolve(null); });
    req.end();
  });
}

// ── Latest-release metadata + shared update decision ───────────────────────

// The releases/latest redirect yields only the tag. Filedate tools
// (Handy: no --version flag) also need the release PUBLISHED date, so they
// take the API path instead. User-Agent is mandatory (GitHub 403s without it).
function apiUrlFor(latestUrl) {
  try {
    const parsed = new URL(latestUrl);
    const m = parsed.pathname.match(/^\/([^/]+)\/([^/]+)\/releases\/latest$/i);
    if (!m) return null;
    return `https://api.github.com/repos/${m[1]}/${m[2]}/releases/latest`;
  } catch { return null; }
}

function fetchGithubReleaseMeta(latestUrl) {
  const apiUrl = apiUrlFor(latestUrl);
  if (!apiUrl) return Promise.resolve(null);
  return new Promise((resolve) => {
    const req = httpsRequest(apiUrl, {
      method: 'GET',
      timeout: HTTP_TIMEOUT_MS,
      headers: { 'User-Agent': 'glitch-pi-update-check', 'Accept': 'application/vnd.github+json' }
    }, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          if (parsed && parsed.tag_name) {
            resolve({ tag: parsed.tag_name, cleaned: parsed.tag_name.replace(/^v/i, ''), publishedAt: parsed.published_at || null });
          } else {
            resolve(null);
          }
        } catch { resolve(null); }
      });
    });
    req.on('error', () => resolve(null));
    req.on('timeout', () => { req.destroy(); resolve(null); });
    req.end();
  });
}

// One dispatcher for "what is the latest" per binary tool: nodejs.org JSON,
// GitHub API (filedate tools need publishedAt), GitHub redirect otherwise.
function fetchLatestForTool(tool) {
  if (!tool.latestUrl) return Promise.resolve(null);
  if (/^https?:\/\/nodejs\.org\//i.test(tool.latestUrl)) return fetchNodejsLatest();
  if (tool.versionStrategy === 'filedate') return fetchGithubReleaseMeta(tool.latestUrl);
  return followGithubLatest(tool.latestUrl);
}

// Single source of truth for "does this binary tool need an update" - used
// by the status check, the interactive prompt, and the apply path so the
// three can never disagree.
//   probe tools (cloudflared, node):     compare probed versions
//   filedate tools (Handy):              compare binary mtime with the
//                                         release published date (no --version flag exists)
//   missing binary:                      install (the manifest declares the
//                                         tool belongs on this machine)
export async function binaryUpdateNeeded(tool, cwd) {
  const meta = await fetchLatestForTool(tool);
  if (!meta) return { error: `latest lookup failed for ${tool.latestUrl}` };
  const binPath = join(cwd, tool.binary);
  if (tool.versionStrategy === 'filedate') {
    if (!existsSync(binPath)) {
      return { needed: true, current: 'not installed', latest: meta.cleaned, tag: meta.tag };
    }
    let mtime = null;
    try { mtime = statSync(binPath).mtime; } catch {}
    if (!mtime) return { needed: true, current: 'unknown (file date)', latest: meta.cleaned, tag: meta.tag };
    const published = meta.publishedAt ? new Date(meta.publishedAt) : null;
    const needed = published ? mtime.getTime() < published.getTime() : false;
    return {
      needed,
      current: `${mtime.toISOString().slice(0, 10)} (file date)`,
      latest: meta.cleaned,
      tag: meta.tag
    };
  }
  const current = await readBinaryInstalledVersion(cwd, tool.binary);
  return {
    needed: !current || isHigher(meta.cleaned, current),
    current: current || 'not installed',
    latest: meta.cleaned,
    tag: meta.tag
  };
}

// ── Backup + rollback for npm install ───────────────────────────────────────

function backupRoot(cwd) {
  return join(cwd, 'data', 'backups', 'npm');
}

// Separate root for binary-file backups so a single prune sweep cannot
// accidentally drop a binary snapshot while pruning an npm backup, and
// vice versa. WHY: npm and binary backup entries have different naming
// shapes (a package name vs a binary filename) and live on different
// lifecycles; mixing them under one root would let one lifecycle prune
// the other's entries.
function binaryBackupRoot(cwd) {
  return join(cwd, 'data', 'backups', 'bin');
}

function packageInstallDir(cwd, packageName) {
  return join(cwd, 'data', 'node', 'node_modules', packageName);
}

// One source of truth for backup-directory naming. WHY: scoped packages
// such as `@earendil-works/pi-coding-agent` carry a path separator in the
// name. If the backup lives at `data/backups/npm/@earendil-works/<pkg>@<ver>`
// then it nests, top-level entries become `@earendil-works`, and any
// `startsWith('@earendil-works/pi-coding-agent@')` prune filter silently
// drops every backup. Flatten the name to a single directory component so
// the path and the prune prefix stay in sync. Both path-builder and
// prune-prefix-builder below go through this helper, so the two cannot
// drift.
function flattenPackageName(packageName) {
  return String(packageName).replace(/[\\/]/g, '__');
}

// Recursive copy without third-party modules. Bounded by the merged tree
// inside data/node/node_modules.
function copyRecursiveSync(src, dest) {
  const st = statSync(src);
  if (st.isDirectory()) {
    mkdirSync(dest, { recursive: true });
    for (const entry of readdirSync(src)) {
      copyRecursiveSync(join(src, entry), join(dest, entry));
    }
  } else if (st.isFile()) {
    copyFileSync(src, dest);
  }
}

async function pruneBinaryBackups(cwd, binaryName) {
  const root = binaryBackupRoot(cwd);
  if (!existsSync(root)) return;
  const prefix = `${flattenPackageName(binaryName)}@`;
  // mtime-descending retention of 2, identical to npm backups. Keeps the
  // newest two copies and lets an older drop out automatically.
  const entries = readdirSync(root)
    .filter((n) => n.startsWith(prefix))
    .map((n) => {
      const full = join(root, n);
      let mtime = 0;
      try { mtime = statSync(full).mtimeMs; } catch {}
      return { name: n, full, mtime };
    })
    .sort((a, b) => b.mtime - a.mtime);
  const toDrop = entries.slice(MAX_BACKUPS_PER_PACKAGE);
  for (const e of toDrop) {
    try { rmSync(e.full, { recursive: true, force: true }); } catch {}
  }
}

async function pruneBackups(cwd, packageName) {
  const root = backupRoot(cwd);
  if (!existsSync(root)) return;
  // Match the same flattened name the backup path uses so a scoped package
  // like `@earendil-works/pi-coding-agent@1.2.3` lands at
  // `data/backups/npm/@earendil-works__pi-coding-agent@1.2.3` and is found
  // by prune. Pre-existing nested legacy directories (the old per-scope
  // layout) are harmless and ignored here on purpose — see task R2.
  const prefix = `${flattenPackageName(packageName)}@`;
  // Order by mtime descending so the newest backup is kept. Lexicographic
  // sort mis-orders dotted triples (1.10.0 before 1.9.0) and would drop
  // the newest backup after an upgrade.
  const entries = readdirSync(root)
    .filter((n) => n.startsWith(prefix))
    .map((n) => {
      const full = join(root, n);
      let mtime = 0;
      try { mtime = statSync(full).mtimeMs; } catch {}
      return { name: n, full, mtime };
    })
    .sort((a, b) => b.mtime - a.mtime);
  const toDrop = entries.slice(MAX_BACKUPS_PER_PACKAGE);
  for (const e of toDrop) {
    try { rmSync(e.full, { recursive: true, force: true }); } catch {}
  }
}

// ── Apply logic ─────────────────────────────────────────────────────────────

// Roll a package directory back to a prior, known-good copy without ever
// risking a window where the live directory is empty. The old version
// deleted the live tree before copying back; if the copy failed the
// package was simply gone. The new sequence:
//   1. Copy the backup into a sibling staging directory (`<pkgDir>.restore-<ts>`).
//   2. Rename the broken `pkgDir` aside to `<pkgDir>.broken-<ts>` (atomic).
//   3. Rename the staging directory over `pkgDir` (atomic on the same volume).
// If any step fails the live directory is still the original backup copy or
// the broken install, never missing. The returned error names every
// surviving path so a human can recover by hand.
// Invariant: a failed update must never leave the package missing.
function rollbackPackageDir(pkgDir, backupDir) {
  const ts = Date.now();
  const stagingDir = `${pkgDir}.restore-${ts}`;
  const brokenDir = `${pkgDir}.broken-${ts}`;
  let stagingOk = false;
  let brokenAsided = false;
  try {
    copyRecursiveSync(backupDir, stagingDir);
    stagingOk = true;
    // If the live dir is still there, rename it aside before putting the
    // staging dir in its place. renameSync fails if the destination already
    // exists, so this is safe even when the broken install was not written.
    if (existsSync(pkgDir)) {
      renameSync(pkgDir, brokenDir);
      brokenAsided = true;
    }
    renameSync(stagingDir, pkgDir);
    return { ok: true, stagingDir, brokenDir, brokenAsided };
  } catch (err) {
    // Clean up the staging dir if it exists, leaving only the original
    // pkgDir and (if we got far enough) the backup copy plus the broken-
    // install sidecar. Return every surviving path so the caller reports
    // them in the error.
    try { if (stagingOk) rmSync(stagingDir, { recursive: true, force: true }); } catch {}
    const surviving = [];
    if (existsSync(backupDir)) surviving.push(backupDir);
    if (existsSync(pkgDir)) surviving.push(pkgDir);
    if (brokenAsided && existsSync(brokenDir)) surviving.push(brokenDir);
    return { ok: false, error: err.message || String(err), surviving, stagingDir, brokenDir, brokenAsided };
  }
}


async function applyNpmUpdate(tool, currentVersion, latestVersion, cwd) {
  const t0 = Date.now();
  noteCyan(`  Updating ${tool.name}: ${currentVersion || 'not installed'} -> ${latestVersion}`);
  const pkgDir = packageInstallDir(cwd, tool.package);
  const hadInstall = existsSync(pkgDir);
  let backupDir = null;
  if (tool.restartRequired && hadInstall) {
    backupDir = join(backupRoot(cwd), `${flattenPackageName(tool.package)}@${currentVersion || 'unknown'}`);
    // The backup copies the whole installed tree (pi-coding-agent is ~440MB),
    // so it can take tens of seconds on its own - it gets its own progress
    // line instead of dead air.
    const tb = Date.now();
    noteDim(`  backing up ${tool.package}@${currentVersion || 'unknown'}...`);
    try {
      // Fresh backup dir each time so a failed install never sees a stale
      // sibling from a prior run.
      rmSync(backupDir, { recursive: true, force: true });
      mkdirSync(backupRoot(cwd), { recursive: true });
      copyRecursiveSync(pkgDir, backupDir);
    } catch (err) {
      noteRed(`  ${tool.name}: backup failed: ${err.message}`);
      return { ok: false, error: `backup failed: ${err.message}` };
    }
    noteDim(`  backup done in ${elapsedSince(tb)}`);
  }

  noteDim(`  installing ${tool.package}@${latestVersion} (npm, up to ${INSTALL_TIMEOUT_MS / 1000}s)...`);
  const [npmCmd, npmArgv] = bundledNpmInvocation(cwd);
  const res = await runProcess(
    npmCmd,
    [...npmArgv, 'i', '-g', `${tool.package}@${latestVersion}`],
    {
      timeout: INSTALL_TIMEOUT_MS,
      env: buildNpmEnv(cwd),
      // Stream npm's own output live (warnings, added-N-packages) and
      // tick elapsed time every 10s so a big fetch is never silent.
      onOutput: (chunk) => {
        for (const line of String(chunk).split(/\r\n|\r|\n/)) {
          const t = line.trim();
          if (t) noteDim(`  npm: ${t}`);
        }
      },
      heartbeatMs: 10_000,
      onHeartbeat: (elapsedSec) => progressInPlace(`  installing ${tool.name}... ${elapsedSec}s elapsed`)
    }
  );
  progressDone(`  npm install finished in ${elapsedSince(t0)}`);
  if (!res.success) {
    noteRed(`  ${tool.name}: npm install failed${res.error === 'timeout' ? ` (timeout after ${INSTALL_TIMEOUT_MS / 1000}s)` : ''}`);
    // Roll back: put the backup back without ever removing the live tree
    // before the restore succeeds.
    let rollbackNote = '';
    if (backupDir && existsSync(backupDir)) {
      noteYellow(`  rolling ${tool.package} back to ${currentVersion || 'unknown'}...`);
      const rb = rollbackPackageDir(pkgDir, backupDir);
      if (!rb.ok) {
        rollbackNote = `; rollback failed: ${rb.error}; surviving paths: ${rb.surviving.join(', ') || '(none)'}; backup intact at ${backupDir}`;
        noteRed(`  rollback failed - backup intact at ${backupDir}`);
      } else {
        noteGreen(`  rolled back to ${currentVersion || 'unknown'}`);
      }
    } else if (backupDir) {
      rollbackNote = `; no backup available to roll back (backupDir missing: ${backupDir})`;
    }
    return { ok: false, error: `npm install failed (status ${res.status}): ${res.stderr || res.stdout || res.error}${rollbackNote}` };
  }

  // Verify the install actually landed. Without this, a system npm that
  // installed to the wrong prefix would silently leave the old version in
  // place and every future check would keep reporting it.
  noteDim('  verifying installed version...');
  const verified = await readNpmInstalledVersion(cwd, tool.package);
  if (verified !== latestVersion) {
    noteRed(`  ${tool.name}: installed ${verified || 'unknown'} != expected ${latestVersion}`);
    let rollbackNote = '';
    if (backupDir && existsSync(backupDir)) {
      noteYellow(`  rolling ${tool.package} back to ${currentVersion || 'unknown'}...`);
      const rb = rollbackPackageDir(pkgDir, backupDir);
      if (!rb.ok) {
        rollbackNote = `; rollback failed: ${rb.error}; surviving paths: ${rb.surviving.join(', ') || '(none)'}; backup intact at ${backupDir}`;
      } else {
        noteGreen(`  rolled back to ${currentVersion || 'unknown'}`);
      }
    } else if (backupDir) {
      rollbackNote = `; no backup available to roll back (backupDir missing: ${backupDir})`;
    }
    return { ok: false, error: `installed version ${verified || 'unknown'} does not match expected ${latestVersion}${rollbackNote}` };
  }

  if (tool.restartRequired) await pruneBackups(cwd, tool.package);
  noteGreen(`  ${tool.name}: ${latestVersion} installed in ${elapsedSince(t0)}`);
  return { ok: true };
}

// ── Minimal HTTP download (no third-party deps) ─────────────────────────────

// Cap on redirect hops. A manifest with a latestUrl that points back at itself
// would otherwise recurse forever and pin a worker. 5 covers normal CDN hops
// (https -> https -> bucket -> asset) while catching loops in one or two.
const MAX_REDIRECT_HOPS = 5;

// onProgress(loadedBytes, totalBytes|null) fires as bytes arrive; total comes
// from content-length when the server sends it. The callback is threaded
// through redirect hops so the caller sees one continuous progress stream.
function downloadToTemp(url, depth = 0, onProgress = null) {
  return new Promise((resolve) => {
    if (depth > MAX_REDIRECT_HOPS) {
      resolve({ ok: false, error: 'too many redirects' });
      return;
    }
    let parsed;
    try { parsed = new URL(url); } catch { resolve({ ok: false, error: 'invalid url' }); return; }
    // Reject non-http(s) targets on every hop so a redirect to file:// or
    // javascript: is refused instead of trusted.
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      resolve({ ok: false, error: 'unsupported protocol' });
      return;
    }
    const baseName = (parsed.pathname.split('/').pop() || 'bin').replace(/[^a-zA-Z0-9._-]/g, '_') || 'bin';
    const tmpPath = join(tmpdir(), `update-${Date.now()}-${baseName}`);
    const transport = parsed.protocol === 'http:' ? httpRequest : httpsRequest;
    const req = transport(url, { method: 'GET', timeout: DOWNLOAD_TIMEOUT_MS }, (res) => {
      if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        resolve(downloadToTemp(res.headers.location, depth + 1, onProgress));
        return;
      }
      if (res.statusCode !== 200) {
        res.resume();
        resolve({ ok: false, error: `http ${res.statusCode}` });
        return;
      }
      const total = Number(res.headers['content-length'] || 0) || null;
      let loaded = 0;
      // Byte counting does not consume the stream: pipe registers its own
      // listener; this one just observes chunks as they flow to the file.
      res.on('data', (c) => {
        loaded += c.length;
        if (onProgress) { try { onProgress(loaded, total); } catch {} }
      });
      const ws = createWriteStream(tmpPath);
      res.pipe(ws);
      ws.on('finish', () => ws.close(() => resolve({ ok: true, path: tmpPath, size: loaded })));
      ws.on('error', (err) => { try { rmSync(tmpPath, { force: true }); } catch {} resolve({ ok: false, error: err.message }); });
    });
    req.on('error', (err) => resolve({ ok: false, error: err.message }));
    req.on('timeout', () => { req.destroy(); resolve({ ok: false, error: 'timeout' }); });
    req.end();
  });
}

// ── Archive + tree helpers (zip via Expand-Archive, msi via msiexec /a) ─────

function extractZip(zipPath, destDir) {
  if (process.platform === 'win32') {
    const ps = `Expand-Archive -LiteralPath '${zipPath.replace(/'/g, "''")}' -DestinationPath '${destDir.replace(/'/g, "''")}' -Force`;
    return runProcess('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', ps], { timeout: 300_000, windowsHide: true });
  }
  return runProcess('unzip', ['-o', zipPath, '-d', destDir], { timeout: 300_000 });
}

// /a = administrative install: extracts the MSI payload WITHOUT installing
// anything; /qn keeps it silent. Windows-only by definition.
function extractMsi(msiPath, destDir) {
  if (process.platform !== 'win32') {
    return Promise.resolve({ success: false, status: -1, stderr: 'msi archives are Windows-only' });
  }
  return runProcess('msiexec.exe', ['/a', msiPath, '/qn', `TARGETDIR=${destDir}`], { timeout: 300_000, windowsHide: true });
}

function findFileInTree(root, wanted) {
  const target = String(wanted || '').toLowerCase();
  if (!target) return null;
  const walk = (dir) => {
    let entries;
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return null; }
    for (const entry of entries) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        const found = walk(full);
        if (found) return found;
      } else if (entry.name.toLowerCase() === target) {
        return full;
      }
    }
    return null;
  };
  return walk(root);
}

function copyDirContents(src, dest) {
  mkdirSync(dest, { recursive: true });
  for (const entry of readdirSync(src)) {
    copyRecursiveSync(join(src, entry), join(dest, entry));
  }
}

// Carry files the new payload lacks but the previous install had (MSI
// extraction can drop merge-module payloads like the VC++ runtime).
function mergeMissingFiles(fromDir, intoDir) {
  let merged = 0;
  const walk = (src, dest) => {
    let entries;
    try { entries = readdirSync(src, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      const srcPath = join(src, entry.name);
      const destPath = join(dest, entry.name);
      if (entry.isDirectory()) {
        mkdirSync(destPath, { recursive: true });
        walk(srcPath, destPath);
      } else if (!existsSync(destPath)) {
        try { copyFileSync(srcPath, destPath); merged++; } catch {}
      }
    }
  };
  walk(fromDir, intoDir);
  return merged;
}

// Stop ONLY the process whose executable path matches - never kill by name
// alone (R22: a name match can hit unrelated processes).
function stopProcessByExePath(exePath) {
  if (process.platform !== 'win32') return Promise.resolve(false);
  const ps = `$ErrorActionPreference='SilentlyContinue'; $p = Get-Process | Where-Object { $_.Path -eq '${exePath.replace(/'/g, "''")}' }; if ($p) { $p | Stop-Process -Force; 'stopped' } else { 'none' }`;
  return runProcess('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', ps], { timeout: 30_000, windowsHide: true })
    .then((res) => (res.stdout || '').includes('stopped'));
}

// rename can fail transiently while a just-killed process drains its
// handles; retry instead of failing the whole update.
async function renameWithRetry(from, to, tries = 10, delayMs = 500) {
  for (let i = 0; i < tries; i++) {
    try { renameSync(from, to); return true; } catch {}
    await new Promise((r) => setTimeout(r, delayMs));
  }
  return false;
}

function sameVersion(a, b) {
  const norm = (v) => String(v || '').trim().replace(/^v/i, '');
  return norm(a) === norm(b);
}

// data/node IS the npm global prefix, so replacing the Node tree wipes every
// installed global (pi, pi-web-ui, gitnexus). Capture the exact installed
// versions first and reinstall those after the swap - the user's chosen
// versions win; @latest only when the pre-swap version is unknown.
const RESTORE_TIMEOUT_MS = 600_000;

async function snapshotNpmGlobals(cwd) {
  const { manifest } = readManifest(cwd);
  const snap = [];
  if (!manifest) return snap;
  for (const t of manifest.tools || []) {
    if (t.type !== 'npm' || t.updateType === 'none') continue;
    snap.push({ name: t.name, package: t.package, version: await readNpmInstalledVersion(cwd, t.package) });
  }
  return snap;
}

async function restoreNpmGlobals(cwd, snap) {
  const failed = [];
  if (snap.length > 0) {
    noteDim(`  restoring ${snap.length} npm global(s) wiped by the node swap (up to ${RESTORE_TIMEOUT_MS / 1000}s each)...`);
  }
  for (const entry of snap) {
    const spec = entry.version ? `${entry.package}@${entry.version}` : `${entry.package}@latest`;
    const t0 = Date.now();
    noteDim(`  restoring ${spec}...`);
    const [npmCmd, npmArgv] = bundledNpmInvocation(cwd);
    const res = await runProcess(
      npmCmd,
      [...npmArgv, 'i', '-g', spec],
      {
        timeout: RESTORE_TIMEOUT_MS,
        env: buildNpmEnv(cwd),
        heartbeatMs: 10_000,
        onHeartbeat: (elapsedSec) => progressInPlace(`  restoring ${entry.name}... ${elapsedSec}s elapsed`),
        onOutput: (chunk) => {
          for (const line of String(chunk).split(/\r\n|\r|\n/)) {
            const t = line.trim();
            if (t) noteDim(`  npm: ${t}`);
          }
        }
      }
    );
    progressDone(`  ${entry.name}: npm install finished in ${elapsedSince(t0)}`);
    if (!res.success) { failed.push(entry.name); continue; }
    if (!(await readNpmInstalledVersion(cwd, entry.package))) failed.push(entry.name);
  }
  return { failed };
}

// ── Binary apply: dispatcher + per-shape handlers ───────────────────────────

// URL templates, resolved at apply time from the LATEST probe so a
// versioned asset URL never goes stale:
//   ${version} = cleaned semver (asset names, e.g. Handy_0.9.7_x64_en-US.msi)
//   ${tag}     = raw release tag (dist paths, e.g. nodejs.org/dist/v24.21.0/)
//   ${arch}    = x64 | arm64
export async function applyBinaryUpdate(tool, latestVersion, cwd, latestTag = null) {
  const t0 = Date.now();
  const platform = tool.platforms?.[process.platform];
  if (!platform || !platform.url) return { ok: false, error: 'no platform config' };
  const tag = latestTag != null ? String(latestTag) : `v${latestVersion}`;
  const arch = process.arch === 'arm64' ? 'arm64' : 'x64';
  const url = String(platform.url)
    .replace(/\$\{version\}/g, String(latestVersion))
    .replace(/\$\{tag\}/g, tag)
    .replace(/\$\{arch\}/g, arch);
  const target = join(cwd, tool.binary);
  noteCyan(`  Updating ${tool.name}: -> ${latestVersion}`);
  noteDim(`  downloading ${url}`);
  const dlRes = await downloadToTemp(url, 0, (loaded, total) => {
    const pct = total ? ` (${Math.round((loaded / total) * 100)}%)` : '';
    progressInPlace(`  downloading ${tool.name}: ${fmtBytes(loaded)}${total ? ` / ${fmtBytes(total)}` : ''}${pct}`);
  });
  try {
    if (!dlRes.ok) {
      progressDone('');
      noteRed(`  ${tool.name}: download failed: ${dlRes.error}`);
      return { ok: false, error: `download failed: ${dlRes.error}` };
    }
    progressDone(`  downloaded ${fmtBytes(dlRes.size || 0)} in ${elapsedSince(t0)}`);
    let res;
    if (platform.archive === 'msi') res = await applyMsiArchiveUpdate(tool, dlRes.path, target, cwd, latestVersion, platform);
    else if (platform.archive === 'zip') res = await applyZipArchiveUpdate(tool, dlRes.path, target, cwd, latestVersion, platform);
    else res = await applyDirectBinaryUpdate(tool, dlRes.path, target, cwd, latestVersion, platform);
    if (res.ok) noteGreen(`  ${tool.name}: ${latestVersion} installed in ${elapsedSince(t0)}`);
    else noteRed(`  ${tool.name}: update failed: ${res.error}`);
    return res;
  } finally {
    try { rmSync(dlRes.path, { force: true }); } catch {}
  }
}

// Plain binary download (e.g. cloudflared). Windows locks a running exe
// against overwrite, so the live file is renamed aside first - renaming a
// running executable's directory entry works even while it executes.
async function applyDirectBinaryUpdate(tool, dlPath, target, cwd, latestVersion, platform) {
  noteDim('  verifying downloaded binary...');
  // The download temp file can lack the target's extension (redirect URLs
  // and name sanitizing); Windows needs .exe to execute it for the probe.
  let probePath = dlPath;
  if (process.platform === 'win32' && /\.(exe|bat|cmd)$/i.test(target) && !/\.(exe|bat|cmd)$/i.test(dlPath)) {
    const ext = (target.match(/(\.[a-z]+)$/i) || [])[1] || '.exe';
    const withExt = dlPath + ext;
    try { rmSync(withExt, { force: true }); } catch {}
    renameSync(dlPath, withExt);
    probePath = withExt;
  }

  const probe = await probeBinary(probePath);
  if (!probe.success) {
    try { rmSync(probePath, { force: true }); } catch {}
    return { ok: false, error: 'downloaded binary failed version probe' };
  }

  // Snapshot the live binary (when its version is known) so the replace
  // stays roll-backable. A failed backup must never touch the live target.
  if (existsSync(target)) {
    let currentVersion = null;
    try { currentVersion = await readBinaryInstalledVersion(cwd, target); } catch {}
    if (currentVersion) {
      const backupPath = join(binaryBackupRoot(cwd), `${flattenPackageName(tool.binary)}@${currentVersion}`);
      noteDim(`  backing up current binary (${currentVersion})...`);
      try {
        mkdirSync(binaryBackupRoot(cwd), { recursive: true });
        rmSync(backupPath, { recursive: true, force: true });
        copyFileSync(target, backupPath);
      } catch (err) {
        return { ok: false, error: `backup of current binary failed: ${err.message}; live target at ${target} left untouched` };
      }
    }
  }

  noteDim(`  replacing ${tool.binary}...`);
  mkdirSync(dirname(target), { recursive: true });
  const staging = `${target}.new`;
  const oldTarget = `${target}.old`;
  try {
    copyFileSync(probePath, staging);
    if (existsSync(target)) {
      try { rmSync(oldTarget, { force: true }); } catch {}
      renameSync(target, oldTarget);
    }
    renameSync(staging, target);
    // Old binary may still be held by a running process; cleaned later.
    try { rmSync(oldTarget, { force: true }); } catch {}
    await pruneBinaryBackups(cwd, tool.binary);
    return { ok: true };
  } catch (err) {
    if (existsSync(oldTarget) && !existsSync(target)) {
      try { renameSync(oldTarget, target); } catch {}
    }
    try { rmSync(staging, { force: true }); } catch {}
    return { ok: false, error: `target locked: ${target}: ${err.message}` };
  } finally {
    try { if (probePath !== dlPath) rmSync(probePath, { force: true }); } catch {}
  }
}

// Zip archives. With replaceDir set (the bundled Node tree) the whole
// directory is swapped: rename the live tree aside, copy the fresh one in,
// restore the npm globals the swap wiped, roll everything back on failure.
async function applyZipArchiveUpdate(tool, dlPath, target, cwd, latestVersion, platform) {
  const extractDir = join(tmpdir(), `glitch-zip-${Date.now()}`);
  mkdirSync(extractDir, { recursive: true });
  try {
    noteDim(`  extracting archive (${fmtBytes(statSync(dlPath).size)})...`);
    const ex = await extractZip(dlPath, extractDir);
    if (!ex.success) {
      return { ok: false, error: `zip extract failed: ${ex.stderr || ex.error || `status ${ex.status}`}` };
    }
    const wanted = (platform.extract || [])[0];
    const found = findFileInTree(extractDir, wanted);
    if (!found) {
      return { ok: false, error: `extracted archive does not contain ${wanted || '(no extract list)'}` };
    }
    const rootDir = dirname(found);
    // Verify the payload actually reports the expected version before it
    // goes anywhere near the live tree.
    noteDim('  verifying extracted payload version...');
    const probe = await probeBinary(found);
    if (!probe.success) return { ok: false, error: `extracted ${wanted} failed version probe` };
    const m = probe.output.match(/v?(\d+\.\d+(?:\.\d+)?)/);
    if (!m || !sameVersion(m[1], latestVersion)) {
      return { ok: false, error: `extracted version ${m ? m[1] : 'unknown'} does not match expected ${latestVersion}` };
    }

    if (platform.replaceDir) {
      const dest = join(cwd, platform.replaceDir);
      const oldDir = `${dest}.old`;
      let snap = [];
      if (tool.restoreNpmGlobals) {
        noteDim('  snapshotting installed npm globals (the swap wipes them)...');
        snap = await snapshotNpmGlobals(cwd);
      }
      try { rmSync(oldDir, { recursive: true, force: true }); } catch {}
      let renamed = false;
      if (existsSync(dest)) {
        noteDim(`  moving current ${platform.replaceDir} aside...`);
        renamed = await renameWithRetry(dest, oldDir);
        if (!renamed) return { ok: false, error: `could not move ${dest} aside (${oldDir} locked?) - nothing changed` };
      }
      noteDim(`  copying new tree into ${platform.replaceDir}...`);
      try {
        mkdirSync(dest, { recursive: true });
        copyDirContents(rootDir, dest);
      } catch (err) {
        // The live tree must never be left partial: undo the swap.
        noteYellow('  copy failed - rolling the tree back...');
        try { rmSync(dest, { recursive: true, force: true }); } catch {}
        if (renamed) { try { renameSync(oldDir, dest); } catch {} }
        return { ok: false, error: `copying extracted tree failed: ${err.message}; rolled back` };
      }
      if (tool.restoreNpmGlobals) {
        const rr = await restoreNpmGlobals(cwd, snap);
        if (rr.failed.length > 0) {
          // A stack that cannot start is worse than a skipped update.
          noteYellow(`  npm global restore failed (${rr.failed.join(', ')}) - rolling the tree back...`);
          try { rmSync(dest, { recursive: true, force: true }); } catch {}
          if (renamed) { try { renameSync(oldDir, dest); } catch {} }
          return { ok: false, error: `npm global restore failed (${rr.failed.join(', ')}) - node tree rolled back` };
        }
      }
      // The old tree may still be held by running processes (node.exe locks
      // its own dir until exit); the next update with the stack down cleans it.
      try { rmSync(oldDir, { recursive: true, force: true }); } catch {}
      await pruneBinaryBackups(cwd, tool.binary);
      return { ok: true };
    }

    // Plain single-file zip payload: reuse the direct replace logic.
    return await applyDirectBinaryUpdate(tool, found, target, cwd, latestVersion, platform);
  } finally {
    try { rmSync(extractDir, { recursive: true, force: true }); } catch {}
  }
}

// MSI archives (Handy voice). msiexec /a extracts the payload; the app dir
// is swapped whole, with the previous install's extra files merged in.
async function applyMsiArchiveUpdate(tool, dlPath, target, cwd, latestVersion, platform) {
  if (process.platform !== 'win32') return { ok: false, error: 'msi archives are Windows-only' };
  const extractDir = join(tmpdir(), `glitch-msi-${Date.now()}`);
  mkdirSync(extractDir, { recursive: true });
  try {
    noteDim(`  extracting MSI payload (${fmtBytes(statSync(dlPath).size)}) - this runs msiexec, can take a minute...`);
    const ex = await extractMsi(dlPath, extractDir);
    if (!ex.success) {
      return { ok: false, error: `msi extract failed: ${ex.stderr || ex.error || `status ${ex.status}`}` };
    }
    const wanted = (platform.extract || [])[0];
    const found = findFileInTree(extractDir, wanted);
    if (!found) {
      return { ok: false, error: `msi payload does not contain ${wanted || '(no extract list)'}` };
    }
    const srcDir = dirname(found);
    const targetDir = dirname(target);
    noteDim(`  stopping ${wanted} if running (by exe path, never by name)...`);
    await stopProcessByExePath(target); // path-scoped; no-op when not running
    const oldDir = `${targetDir}.old`;
    try { rmSync(oldDir, { recursive: true, force: true }); } catch {}
    let renamed = false;
    if (existsSync(targetDir)) {
      noteDim('  moving current install aside...');
      renamed = await renameWithRetry(targetDir, oldDir);
      if (!renamed) return { ok: false, error: `could not move ${targetDir} aside - is ${wanted} running?` };
    }
    noteDim(`  installing new files into ${targetDir}...`);
    try {
      copyDirContents(srcDir, targetDir);
      if (renamed) {
        const merged = mergeMissingFiles(oldDir, targetDir);
        if (merged > 0) noteDim(`  merged ${merged} file(s) from the previous install`);
      }
      // Stamp mtime: extraction preserves the payload's build date, which
      // can predate the release and would re-flag the update forever
      // (filedate tools compare mtime with the release date).
      try { utimesSync(target, new Date(), new Date()); } catch {}
    } catch (err) {
      noteYellow('  replace failed - rolling the install back...');
      try { rmSync(targetDir, { recursive: true, force: true }); } catch {}
      if (renamed && existsSync(oldDir)) { try { renameSync(oldDir, targetDir); } catch {} }
      return { ok: false, error: `replace failed: ${err.message}` };
    }
    if (renamed) { try { rmSync(oldDir, { recursive: true, force: true }); } catch {} }
    await pruneBinaryBackups(cwd, tool.binary);
    return { ok: true };
  } finally {
    try { rmSync(extractDir, { recursive: true, force: true }); } catch {}
  }
}

// ── Status aggregation ──────────────────────────────────────────────────────

function emptyItem(tool) {
  return {
    name: tool.name,
    current: '',
    latest: '',
    update_available: false,
    update_type: tool.updateType === 'sync' ? 'sync' : (tool.updateType === 'manual' ? 'manual' : 'none'),
    restart_required: !!tool.restartRequired,
    status: 'ok',
    error_message: ''
  };
}

async function checkSingle(tool, cwd) {
  const item = emptyItem(tool);
  try {
    if (tool.updateType === 'none') {
      item.update_type = 'none';
      item.update_available = false;
      return item;
    }
    if (tool.updateType === 'manual') {
      item.update_type = 'manual';
      // Surface current version but never compare or report as an update.
      if (tool.type === 'npm') {
        item.current = await readNpmInstalledVersion(cwd, tool.package) || '';
      } else if (tool.type === 'binary') {
        item.current = await readBinaryInstalledVersion(cwd, tool.binary) || '';
      }
      return item;
    }
    // updateType === 'sync'
    item.update_type = 'sync';
    if (tool.type === 'npm') {
      item.current = (await readNpmInstalledVersion(cwd, tool.package)) || '';
      item.latest  = (await readNpmLatestVersion(cwd, tool.package)) || '';
      // An empty `latest` means the npm registry lookup did not produce a
      // version string. NEVER claim "up to date" for a lookup that never
      // returned a value: that would silently hide a broken CLI,
      // offline machine, or registry failure as a non-update. Mark the
      // entry as an error instead, name which lookup failed, and leave
      // update_available false.
      if (!item.latest) {
        item.status = 'error';
        item.error_message = `npm view ${tool.package} version returned no version`;
        return item;
      }
    } else if (tool.type === 'binary') {
      const decision = await binaryUpdateNeeded(tool, cwd);
      if (decision.error) {
        item.status = 'error';
        item.error_message = decision.error;
        return item;
      }
      item.current = decision.current;
      item.latest = decision.latest;
      item.update_available = !!decision.needed;
      return item;
    } else {
      item.error_message = `unknown tool type: ${tool.type}`;
      item.status = 'error';
      return item;
    }
    // A missing current version means "install": the manifest declares the
    // tool belongs on this machine, so its absence is an actionable gap,
    // not "up to date".
    item.update_available = !!item.latest && (!item.current || isHigher(item.latest, item.current));
  } catch (err) {
    item.status = 'error';
    item.error_message = err.message || String(err);
  }
  return item;
}

async function collectStatuses(manifest, cwd) {
  const items = [];
  const errors = [];
  for (const tool of manifest.tools || []) {
    // Per-tool liveness during the check: version lookups (`npm view`, a
    // binary --version probe, a GitHub API hit) can each take seconds, and
    // without this line the whole check phase was dead air.
    noteDim(`  checking ${tool.name}...`);
    const item = await checkSingle(tool, cwd);
    items.push(item);
    if (item.status === 'error' && item.error_message) {
      errors.push(`${tool.name}: ${item.error_message}`);
    }
  }
  return {
    checked_at: new Date().toISOString(),
    checked: true,
    updates_available: items.filter((i) => i.update_available).length,
    items,
    errors
  };
}

function writeStatusFile(cwd, status) {
  // Status writes must never throw: --check-only runs main() unwrapped, and
  // a single unwritable status file (full disk, read-only volume, antivirus
  // lock) must not turn a check into an exit-1 apply failure. Returns the
  // path on success, or null if the write did not land, so callers can
  // observe the outcome without try/catch noise.
  const out = join(cwd, 'data', STATUS_FILE_NAME);
  try {
    mkdirSync(dirname(out), { recursive: true });
    writeFileSync(out, `${JSON.stringify(status, null, 2)}\n`, 'utf8');
    return out;
  } catch {
    return null;
  }
}

// ── Exported entry points ───────────────────────────────────────────────────

export async function checkUpdatesOnly({ cwd = DEFAULT_CWD } = {}) {
  const { manifest, error } = readManifest(cwd);
  if (!manifest) {
    // A truly broken manifest should not throw - write a status with the
    // error so the launcher can surface it but continue.
    if (error) {
      const status = {
        checked_at: new Date().toISOString(),
        checked: true,
        updates_available: 0,
        items: [],
        errors: [error]
      };
      writeStatusFile(cwd, status);
      return status;
    }
    return null;
  }
  try {
    const status = await collectStatuses(manifest, cwd);
    writeStatusFile(cwd, status);
    return status;
  } catch (err) {
    const status = {
      checked_at: new Date().toISOString(),
      checked: true,
      updates_available: 0,
      items: [],
      errors: [err.message || String(err)]
    };
    try { writeStatusFile(cwd, status); } catch {}
    return status;
  }
}

function askLine(prompt) {
  return new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    rl.question(prompt, (ans) => {
      rl.close();
      resolve(ans ?? '');
    });
  });
}

// Shared end-of-apply summary for BOTH apply branches (interactive selection
// and autoApplyAll). stderr so stdout contracts stay byte-identical; the
// restart-required notice is the piece users most need to see (an updated
// pi-coding-agent / pi-web-ui only takes effect after the stack restarts).
function reportApplyOutcome(applied, pending) {
  for (const name of applied.applied) noteGreen(`  ${name}: updated`);
  for (const name of applied.failed) noteRed(`  ${name}: FAILED`);
  if (applied.applied.length > 0) noteGreen('  Updates complete.');
  const restartNames = pending
    .filter((i) => i.restart_required && applied.applied.includes(i.name))
    .map((i) => i.name);
  if (restartNames.length > 0) {
    noteYellow(`  Restart required to use: ${restartNames.join(', ')}`);
  }
}

export async function checkAndPromptUpdates({
  cwd = DEFAULT_CWD,
  interactive = true,
  autoApplyAll = false,
  filter = []
} = {}) {
  const { manifest } = readManifest(cwd);
  if (!manifest) {
    return { checked: false, updatesAvailable: 0, updatesApplied: 0, skipped: 0, items: [] };
  }
  const status = await collectStatuses(manifest, cwd);
  writeStatusFile(cwd, status);

  const items = status.items;
  const updates = items.filter((i) => i.update_available);
  const matchesFilter = (name) => !filter.length || filter.includes(name);
  const pending = updates.filter((i) => matchesFilter(i.name));
  const skipped = updates.length - pending.length;

  if (pending.length === 0) {
    return { checked: true, updatesAvailable: updates.length, updatesApplied: 0, skipped, items };
  }

  if (!interactive || autoApplyAll) {
    const applied = await applyAllUpdates({ cwd, filter });
    reportApplyOutcome(applied, pending);
    return {
      checked: true,
      updatesAvailable: updates.length,
      updatesApplied: applied.applied.length,
      skipped,
      items
    };
  }

  // Interactive: numbered-list selection, matching the glitch-ai launcher UX
  // (pick by numbers, Enter = apply all, 's' = skip all).
  console.log('');
  console.log(yellow('  ===== Updates Available ====='));
  pending.forEach((item, i) => {
    console.log(cyan(`  [${i + 1}] ${item.name}`));
    console.log(`      ${item.current || '(not installed)'} -> ${item.latest}`);
  });
  console.log('');
  console.log(dim('  Large packages (pi ~440MB) can take a few minutes to download and install.'));
  console.log(dim('  Live progress is shown while applying - the window is NOT hung.'));
  console.log('');
  console.log("  Enter numbers to select (e.g. '1,3'),");
  console.log("  press Enter to apply all, or type 's' to skip:");
  const selection = await askLine('  > ');
  const trimmed = selection.trim().toLowerCase();
  if (trimmed === 's') {
    console.log(yellow('  Skipping updates.'));
    return { checked: true, updatesAvailable: updates.length, updatesApplied: 0, skipped: pending.length, items };
  }
  let selectedNames = [];
  if (trimmed === '') {
    selectedNames = pending.map((i) => i.name);
  } else {
    const indices = selection.split(',').map((s) => parseInt(s.trim(), 10)).filter((n) => !isNaN(n));
    for (const idx of indices) {
      const num = idx - 1;
      if (num >= 0 && num < pending.length) selectedNames.push(pending[num].name);
    }
  }
  if (selectedNames.length === 0) {
    console.log(yellow('  No valid selection - skipping updates.'));
    return { checked: true, updatesAvailable: updates.length, updatesApplied: 0, skipped: pending.length, items };
  }
  console.log(cyan(`  Applying ${selectedNames.length} update(s)...`));
  const applied = await applyAllUpdates({ cwd, filter: selectedNames });
  reportApplyOutcome(applied, pending);
  // Refresh the status file so UI surfaces reflect the applied state.
  try {
    const { manifest: m } = readManifest(cwd);
    if (m) writeStatusFile(cwd, await collectStatuses(m, cwd));
  } catch {}
  return {
    checked: true,
    updatesAvailable: updates.length,
    updatesApplied: applied.applied.length,
    skipped: pending.length - selectedNames.length,
    items
  };
}

export async function applyAllUpdates({
  cwd = DEFAULT_CWD,
  filter = [],
  latestByName = null,
  currentByName = null
} = {}) {
  const { manifest } = readManifest(cwd);
  const result = { applied: [], failed: [] };
  if (!manifest) return result;
  const matches = (name) => !filter.length || filter.includes(name);
  for (const tool of manifest.tools || []) {
    if (!matches(tool.name)) continue;
    if (tool.updateType !== 'sync') continue;
    try {
      // Covers the silent lookup gap (npm view / GitHub probe) before the
      // apply step prints its own header. Placed after the filter + sync
      // gates so an empty-filter no-op run prints nothing.
      noteDim(`  ${tool.name}: checking latest...`);
      if (tool.type === 'npm') {
        const currentVersion = await readNpmInstalledVersion(cwd, tool.package);
        // Reuse a pre-computed latest when the caller already paid for it
        // (the CLI pre-flight is one such case). Avoids duplicating the
        // `npm view` round-trip between the human-visible pre-flight and
        // the apply call. Falls back to the live probe if the caller did
        // not provide it (programmatic callers, tests).
        const cachedLatest = latestByName && latestByName.get(tool.name);
        const latestVersion  = cachedLatest != null
          ? cachedLatest
          : await readNpmLatestVersion(cwd, tool.package);
        if (!latestVersion) { result.failed.push(tool.name); continue; }
        // A missing current version is an install (the manifest says this
        // tool belongs on this machine), not a skip.
        if (currentVersion && !isHigher(latestVersion, currentVersion)) continue;
        const res = await applyNpmUpdate(tool, currentVersion, latestVersion, cwd);
        if (res.ok) result.applied.push(tool.name);
        else result.failed.push(tool.name);
      } else if (tool.type === 'binary') {
        const platform = tool.platforms?.[process.platform];
        if (!tool.latestUrl || !platform || !platform.url) continue;
        // Single source of truth for the update decision (probe / filedate /
        // install-when-missing). The old inline version also had a
        // strict-mode bug: an undeclared `gh` global threw on the uncached
        // path and the catch block silently turned it into a FAILED entry.
        const decision = await binaryUpdateNeeded(tool, cwd);
        if (decision.error) { result.failed.push(tool.name); continue; }
        if (!decision.needed) continue;
        const res = await applyBinaryUpdate(tool, decision.latest, cwd, decision.tag);
        if (res.ok) result.applied.push(tool.name);
        else result.failed.push(tool.name);
      }
    } catch {
      result.failed.push(tool.name);
    }
  }
  return result;
}

// ── CLI dispatch ────────────────────────────────────────────────────────────

async function main() {
  const opts = parseCliArgs(process.argv.slice(2));
  const cwd = DEFAULT_CWD;

  if (opts.checkOnly) {
    const status = await checkUpdatesOnly({ cwd });
    if (opts.json && status) console.log(JSON.stringify(status, null, 2));
    else if (status) {
      console.log(JSON.stringify(status));
      // Human-readable --check-only must surface failed lookups so a
      // silent network outage or broken CLI cannot hide behind an empty
      // `latest`. --json output stays untouched (the same items array).
      const failed = (status.items || []).filter((i) => i.status === 'error');
      if (failed.length > 0) {
        const names = failed.map((i) => i.name).join(', ');
        console.error(yellow(`  Warning: ${failed.length} update check(s) failed for: ${names}`));
      }
    }
    process.exit(0);
  }

  if (opts.apply) {
    // Pre-flight: enumerate what would be applied (current < latest, sync,
    // filter match) so the human-visible output can name them. The actual
    // apply still goes through applyAllUpdates() so behaviour stays
    // identical to the programmatic entry point.
    const { manifest } = readManifest(cwd);
    const matches = (name) => !opts.filter.length || opts.filter.includes(name);
    const pending = [];
    if (manifest) {
      for (const tool of manifest.tools || []) {
        if (!matches(tool.name)) continue;
        if (tool.updateType !== 'sync') continue;
        try {
          // stderr liveness during the pre-flight lookups; after the gates so
          // the empty-filter no-op run prints nothing on either stream.
          noteDim(`  ${tool.name}: checking latest...`);
          if (tool.type === 'npm') {
            const current = (await readNpmInstalledVersion(cwd, tool.package)) || '';
            const latest  = (await readNpmLatestVersion(cwd, tool.package)) || '';
            if (!latest) continue;
            if (current && !isHigher(latest, current)) continue;
            pending.push({ name: tool.name, current: current || 'not installed', latest, restart_required: !!tool.restartRequired });
          } else if (tool.type === 'binary') {
            const platform = tool.platforms?.[process.platform];
            if (!tool.latestUrl || !platform || !platform.url) continue;
            const decision = await binaryUpdateNeeded(tool, cwd);
            if (decision.error || !decision.needed) continue;
            pending.push({ name: tool.name, current: decision.current, latest: decision.latest, restart_required: !!tool.restartRequired });
          }
        } catch {
          // Pre-flight is best-effort; applyAllUpdates below is authoritative.
        }
      }
    }

    const res = await applyAllUpdates({
      cwd,
      filter: opts.filter,
      latestByName: new Map(pending.map((p) => [p.name, p.latest])),
      currentByName: new Map(pending.map((p) => [p.name, p.current]))
    });
    if (opts.json) {
      console.log(JSON.stringify(res, null, 2));
    } else {
      const latestByName = new Map(pending.map((p) => [p.name, p.latest]));
      if (res.applied.length === 0 && res.failed.length === 0) {
        if (opts.filter.length) {
          console.log(`  Nothing to update (filter: ${opts.filter.join(',')}).`);
        } else {
          console.log('  Nothing to update.');
        }
      } else {
        for (const p of pending) {
          console.log(`  ${p.name} ${p.current} -> ${p.latest}`);
        }
        for (const name of res.applied) {
          const v = latestByName.get(name) || '';
          console.log(`  applied ${name}${v ? ` ${v}` : ''}`);
        }
        for (const name of res.failed) {
          console.log(`  FAILED ${name} update failed`);
        }
        console.log(`  applied ${res.applied.length}, failed ${res.failed.length}`);
      }
      // Restart-required notice on the human path too (the --json path
      // stays untouched). restart-pi-stack -ApplyUpdates runs BEFORE the
      // kill, so this notice names exactly what the restart will pick up.
      const restartNames = pending
        .filter((p) => p.restart_required && res.applied.includes(p.name))
        .map((p) => p.name);
      if (restartNames.length > 0) {
        noteYellow(`  Restart required to use: ${restartNames.join(', ')}`);
      }
    }
    process.exit(res.failed.length === 0 ? 0 : 1);
  }

  if (opts.prompt) {
    const res = await checkAndPromptUpdates({
      cwd,
      interactive: true,
      autoApplyAll: opts.yes,
      filter: opts.filter
    });
    if (opts.json) console.log(JSON.stringify(res, null, 2));
    process.exit(0);
  }

  // Default invocation without flags: behave like --check-only.
  const status = await checkUpdatesOnly({ cwd });
  if (opts.json && status) console.log(JSON.stringify(status, null, 2));
  process.exit(0);
}

// Only run the CLI when invoked directly; safe to import in tests.
const invokedDirectly = (() => {
  try {
    return process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
  } catch { return false; }
})();

if (invokedDirectly) {
  main().catch((err) => {
    console.error(red(`check-updates failed: ${err.message || err}`));
    process.exit(1);
  });
}
