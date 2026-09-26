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
  renameSync
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

// ── Process invocation (timeout-bounded, no shell) ───────────────────────────

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
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try { child.kill('SIGKILL'); } catch {}
      resolve({ success: false, status: -1, stdout, stderr, error: 'timeout' });
    }, opts.timeout ?? 30_000);

    if (child.stdout) child.stdout.on('data', (b) => { stdout += b.toString(); });
    if (child.stderr) child.stderr.on('data', (b) => { stderr += b.toString(); });
    child.on('error', (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ success: false, status: -1, stdout, stderr, error: err.message });
    });
    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ success: code === 0, status: code ?? -1, stdout, stderr });
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
  const pkgDir = packageInstallDir(cwd, tool.package);
  const hadInstall = existsSync(pkgDir);
  let backupDir = null;
  if (tool.restartRequired && hadInstall) {
    backupDir = join(backupRoot(cwd), `${flattenPackageName(tool.package)}@${currentVersion || 'unknown'}`);
    try {
      // Fresh backup dir each time so a failed install never sees a stale
      // sibling from a prior run.
      rmSync(backupDir, { recursive: true, force: true });
      mkdirSync(backupRoot(cwd), { recursive: true });
      copyRecursiveSync(pkgDir, backupDir);
    } catch (err) {
      return { ok: false, error: `backup failed: ${err.message}` };
    }
  }

  const [npmCmd, npmArgv] = bundledNpmInvocation(cwd);
  const res = await runProcess(
    npmCmd,
    [...npmArgv, 'i', '-g', `${tool.package}@${latestVersion}`],
    { timeout: NPM_TIMEOUT_MS, env: buildNpmEnv(cwd) }
  );
  if (!res.success) {
    // Roll back: put the backup back without ever removing the live tree
    // before the restore succeeds.
    let rollbackNote = '';
    if (backupDir && existsSync(backupDir)) {
      const rb = rollbackPackageDir(pkgDir, backupDir);
      if (!rb.ok) {
        rollbackNote = `; rollback failed: ${rb.error}; surviving paths: ${rb.surviving.join(', ') || '(none)'}; backup intact at ${backupDir}`;
      }
    } else if (backupDir) {
      rollbackNote = `; no backup available to roll back (backupDir missing: ${backupDir})`;
    }
    return { ok: false, error: `npm install failed (status ${res.status}): ${res.stderr || res.stdout || res.error}${rollbackNote}` };
  }

  // Verify the install actually landed. Without this, a system npm that
  // installed to the wrong prefix would silently leave the old version in
  // place and every future check would keep reporting it.
  const verified = await readNpmInstalledVersion(cwd, tool.package);
  if (verified !== latestVersion) {
    let rollbackNote = '';
    if (backupDir && existsSync(backupDir)) {
      const rb = rollbackPackageDir(pkgDir, backupDir);
      if (!rb.ok) {
        rollbackNote = `; rollback failed: ${rb.error}; surviving paths: ${rb.surviving.join(', ') || '(none)'}; backup intact at ${backupDir}`;
      }
    } else if (backupDir) {
      rollbackNote = `; no backup available to roll back (backupDir missing: ${backupDir})`;
    }
    return { ok: false, error: `installed version ${verified || 'unknown'} does not match expected ${latestVersion}${rollbackNote}` };
  }

  if (tool.restartRequired) await pruneBackups(cwd, tool.package);
  return { ok: true };
}

// ── Minimal HTTP download (no third-party deps) ─────────────────────────────

// Cap on redirect hops. A manifest with a latestUrl that points back at itself
// would otherwise recurse forever and pin a worker. 5 covers normal CDN hops
// (https -> https -> bucket -> asset) while catching loops in one or two.
const MAX_REDIRECT_HOPS = 5;

function downloadToTemp(url, depth = 0) {
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
        resolve(downloadToTemp(res.headers.location, depth + 1));
        return;
      }
      if (res.statusCode !== 200) {
        res.resume();
        resolve({ ok: false, error: `http ${res.statusCode}` });
        return;
      }
      const ws = createWriteStream(tmpPath);
      res.pipe(ws);
      ws.on('finish', () => ws.close(() => resolve({ ok: true, path: tmpPath })));
      ws.on('error', (err) => { try { rmSync(tmpPath, { force: true }); } catch {} resolve({ ok: false, error: err.message }); });
    });
    req.on('error', (err) => resolve({ ok: false, error: err.message }));
    req.on('timeout', () => { req.destroy(); resolve({ ok: false, error: 'timeout' }); });
    req.end();
  });
}

async function applyBinaryUpdate(tool, latestVersion, cwd) {
  const platform = tool.platforms?.[process.platform];
  if (!platform || !platform.url) return { ok: false, error: 'no platform config' };
  const target = join(cwd, tool.binary);
  const dlRes = await downloadToTemp(platform.url);
  if (!dlRes.ok) return { ok: false, error: dlRes.error };

  // Probe the freshly downloaded file before touching the live target.
  const probe = await probeBinary(dlRes.path);
  if (!probe.success) {
    try { rmSync(dlRes.path, { force: true }); } catch {}
    return { ok: false, error: 'downloaded binary failed version probe' };
  }

  // Snapshot the live binary, if there is one AND we know its version, so
  // a successful replace remains roll-backable. The probe-based version
  // lookup is the same the pre-flight uses; if it fails we have no name
  // for the backup, so skip the snapshot rather than write a misnamed
  // entry. Backup failures must never leave the live target missing, so a
  // backup that fails only reports the error and the live target stays.
  if (existsSync(target)) {
    let currentVersion = null;
    try {
      currentVersion = await readBinaryInstalledVersion(cwd, target);
    } catch {}
    if (currentVersion) {
      const backupPath = join(binaryBackupRoot(cwd), `${flattenPackageName(tool.binary)}@${currentVersion}`);
      try {
        mkdirSync(binaryBackupRoot(cwd), { recursive: true });
        rmSync(backupPath, { recursive: true, force: true });
        copyFileSync(target, backupPath);
      } catch (err) {
        try { rmSync(dlRes.path, { force: true }); } catch {}
        return { ok: false, error: `backup of current binary failed: ${err.message}; live target at ${target} left untouched` };
      }
    }
  }

  mkdirSync(dirname(target), { recursive: true });
  const staging = `${target}.new`;
  try {
    // Stage the new binary beside the live target, then rename over it.
    // rename is atomic on the same volume, so the live file is never half
    // written. If rename fails, the live target is unchanged and the
    // .new file is removed.
    copyFileSync(dlRes.path, staging);
    renameSync(staging, target);
    try { rmSync(dlRes.path, { force: true }); } catch {}
    await pruneBinaryBackups(cwd, tool.binary);
    return { ok: true };
  } catch (err) {
    try { rmSync(staging, { force: true }); } catch {}
    try { rmSync(dlRes.path, { force: true }); } catch {}
    return { ok: false, error: `target locked: ${target}: ${err.message}` };
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
      item.current = (await readBinaryInstalledVersion(cwd, tool.binary)) || '';
      if (!tool.latestUrl) {
        item.error_message = 'binary entry missing latestUrl';
        item.status = 'error';
        return item;
      }
      const gh = await followGithubLatest(tool.latestUrl);
      item.latest = gh ? gh.cleaned : '';
      // Same honesty rule for the GitHub latest probe: a null result is a
      // failed lookup, not a confirmation that the binary is current.
      if (!gh) {
        item.status = 'error';
        item.error_message = `github latest lookup failed for ${tool.latestUrl}`;
        return item;
      }
    } else {
      item.error_message = `unknown tool type: ${tool.type}`;
      item.status = 'error';
      return item;
    }
    item.update_available = !!item.current && !!item.latest && isHigher(item.latest, item.current);
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

function askYN(prompt) {
  return new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    rl.question(prompt, (ans) => {
      rl.close();
      resolve(/^y(es)?$/i.test(ans.trim()));
    });
  });
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
    return {
      checked: true,
      updatesAvailable: updates.length,
      updatesApplied: applied.applied.length,
      skipped,
      items
    };
  }

  // Interactive: prompt per entry.
  let appliedCount = 0;
  for (const item of pending) {
    const choice = await askYN(`Apply update ${item.name} ${item.current} -> ${item.latest}? [y/N] `);
    if (!choice) continue;
    const res = await applyAllUpdates({ cwd, filter: [item.name] });
    appliedCount += res.applied.length;
  }
  return {
    checked: true,
    updatesAvailable: updates.length,
    updatesApplied: appliedCount,
    skipped,
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
        if (!currentVersion || !isHigher(latestVersion, currentVersion)) continue;
        const res = await applyNpmUpdate(tool, currentVersion, latestVersion, cwd);
        if (res.ok) result.applied.push(tool.name);
        else result.failed.push(tool.name);
      } else if (tool.type === 'binary') {
        if (!tool.latestUrl) continue;
        const cachedCurrent = currentByName && currentByName.get(tool.name);
        const currentVersion = cachedCurrent != null
          ? cachedCurrent
          : await readBinaryInstalledVersion(cwd, tool.binary);
        const cachedLatest = latestByName && latestByName.get(tool.name);
        const latestVersion = cachedLatest != null
          ? cachedLatest
          : ((gh = await followGithubLatest(tool.latestUrl)), gh ? gh.cleaned : null);
        if (!latestVersion) { result.failed.push(tool.name); continue; }
        if (!currentVersion || !isHigher(latestVersion, currentVersion)) continue;
        const res = await applyBinaryUpdate(tool, latestVersion, cwd);
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
          let current = '';
          let latest = '';
          if (tool.type === 'npm') {
            current = (await readNpmInstalledVersion(cwd, tool.package)) || '';
            latest  = (await readNpmLatestVersion(cwd, tool.package)) || '';
          } else if (tool.type === 'binary') {
            if (!tool.latestUrl) continue;
            current = (await readBinaryInstalledVersion(cwd, tool.binary)) || '';
            const gh = await followGithubLatest(tool.latestUrl);
            latest = gh ? gh.cleaned : '';
          } else {
            continue;
          }
          if (!current || !latest) continue;
          if (!isHigher(latest, current)) continue;
          pending.push({ name: tool.name, current, latest });
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
