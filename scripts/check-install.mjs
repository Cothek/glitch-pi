#!/usr/bin/env node
/**
 * Glitch AI -- Install Status Checker
 *
 * Verifies that all Glitch AI components are installed correctly.
 * Run: node scripts/check-install.mjs
 *
 * Exit codes:
 *   0 = all critical components present
 *   1 = one or more critical components missing
 */

import { existsSync, statSync, readFileSync, readdirSync, realpathSync, lstatSync } from 'node:fs';
import { execFileSync, execSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const ROOT_DIR = dirname(__dirname);

// Platform-aware binary paths
const isWin = process.platform === 'win32';
const isMac = process.platform === 'darwin';
const NODE_BUNDLED = isWin
  ? join(ROOT_DIR, 'data', 'node', 'node.exe')
  : join(ROOT_DIR, 'data', 'node', 'bin', 'node');
const CLOUDFLARED = isWin
  ? join(ROOT_DIR, 'cloudflared.exe')
  : join(ROOT_DIR, 'cloudflared');
// Pi engine entry points (kept in sync with scripts/bootstrap-pi.ps1).
// Windows layout: npm globals land in data/node/node_modules; unix uses
// data/node/lib/node_modules. Both are checked.
const piNodeModulesDir = isWin
  ? join(ROOT_DIR, 'data', 'node', 'node_modules')
  : join(ROOT_DIR, 'data', 'node', 'lib', 'node_modules');
const PI_CLI_JS = join(piNodeModulesDir, '@earendil-works', 'pi-coding-agent', 'dist', 'bundle', 'cli.js');
const PI_PKG_JSON = join(piNodeModulesDir, '@earendil-works', 'pi-coding-agent', 'package.json');
const PI_WEB_UI_ENTRY = join(piNodeModulesDir, 'pi-web-ui', 'bin', 'pi-web-ui.mjs');
const HANDY_BIN = isWin
  ? join(ROOT_DIR, 'handy-voice', 'Handy', 'handy.exe')
  : isMac
    ? join(ROOT_DIR, 'handy-voice', 'Handy.app', 'Contents', 'MacOS', 'Handy')
    : join(ROOT_DIR, 'handy-voice', 'Handy.AppImage');

// ANSI colors (no deps)
const C = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  dim: '\x1b[2m',
  green: '\x1b[32m',
  red: '\x1b[31m',
  yellow: '\x1b[33m',
  cyan: '\x1b[36m',
  gray: '\x1b[90m',
};

const SYM = {
  ok: `${C.green}OK${C.reset}`,
  fail: `${C.red}X${C.reset}`,
  warn: `${C.yellow}!${C.reset}`,
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function safeExec(cmd, args = []) {
  try {
    if (isWin && (cmd.endsWith('.cmd') || cmd.endsWith('.bat'))) {
      args = ['/d', '/s', '/c', cmd, ...args];
      cmd = 'cmd.exe';
    }
    const out = execFileSync(cmd, args, {
      cwd: ROOT_DIR,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 5000,
    });
    return out.trim();
  } catch {
    return null;
  }
}

function tryReadVersion(filePath, versionFlag = '--version') {
  if (!existsSync(filePath)) return null;
  const out = safeExec(filePath, [versionFlag]);
  if (!out) return null;
  // Extract first version-like token (e.g. v1.2.3, 22.14.0, 2026.2.0)
  const match = out.match(/v?\d+(?:\.\d+){1,3}(?:-[\w.]+)?/);
  return match ? match[0] : out.split(/\s+/)[0];
}

function getGitBranch() {
  const out = safeExec('git', ['symbolic-ref', '--short', 'HEAD']);
  return out || null;
}

function getGitRemote() {
  const out = safeExec('git', ['config', '--get', 'remote.origin.url']);
  if (!out) return null;
  // Normalize to owner/repo
  const m = out.match(/github\.com[:/](.+?)\.git$/);
  return m ? m[1] : out;
}

function pad(s, n) {
  s = String(s);
  return s.length >= n ? s : s + ' '.repeat(n - s.length);
}

// ---------------------------------------------------------------------------
// Checks
// ---------------------------------------------------------------------------

const checks = [];

function check(name, group, run) {
  checks.push({ name, group, run });
}

// --- Core ---

check('Node.js', 'Core', () => {
  const bundledPath = isWin ? 'data/node/node.exe' : 'data/node/bin/node';
  if (existsSync(NODE_BUNDLED)) {
    const v = tryReadVersion(NODE_BUNDLED);
    return {
      ok: true,
      version: v || 'unknown',
      path: bundledPath,
      note: 'bundled',
    };
  }
  // Fall back to system node
  const v = safeExec('node', ['--version']);
  if (v) {
    return {
      ok: true,
      version: v.replace(/^v/, ''),
      path: 'system',
      note: 'system PATH',
    };
  }
  return {
    ok: false,
    version: null,
    path: null,
    note: 'install: scripts/bootstrap.ps1',
  };
});

// Reads the version out of an installed npm package.json (best-effort).
function readPkgVersion(pkgJsonPath) {
  try {
    const pkg = JSON.parse(readFileSync(pkgJsonPath, 'utf-8'));
    return pkg && pkg.version ? pkg.version : null;
  } catch {
    return null;
  }
}

// The Pi CLI is the fork's engine (TUI mode). bootstrap-pi.ps1 installs it as an
// npm global into data/node; launch-pi.mjs spawns its dist/bundle/cli.js.
check('Pi CLI', 'Core', () => {
  if (!existsSync(PI_CLI_JS)) {
    return {
      ok: false,
      version: null,
      path: null,
      note: 'install: scripts/bootstrap-pi.ps1 (npm -g @earendil-works/pi-coding-agent)',
    };
  }
  return {
    ok: true,
    version: readPkgVersion(PI_PKG_JSON) || 'unknown',
    path: 'data/node/node_modules/@earendil-works/pi-coding-agent',
    note: 'pi engine (TUI)',
  };
});

// pi-web-ui is the fork's Web delivery (web stack on :8787). Installed by the
// same bootstrap step; start-pi-stack.ps1 runs its bin/pi-web-ui.mjs.
check('pi-web-ui', 'Core', () => {
  if (!existsSync(PI_WEB_UI_ENTRY)) {
    return {
      ok: false,
      version: null,
      path: null,
      note: 'install: scripts/bootstrap-pi.ps1 (npm -g pi-web-ui)',
    };
  }
  return {
    ok: true,
    version: readPkgVersion(join(piNodeModulesDir, 'pi-web-ui', 'package.json')) || 'unknown',
    path: 'data/node/node_modules/pi-web-ui',
    note: 'web delivery (stack)',
  };
});

check('Git Repo', 'Core', () => {
  const gitDir = join(ROOT_DIR, '.git');
  if (!existsSync(gitDir)) {
    return {
      ok: false,
      version: null,
      path: null,
      note: 'repo not cloned',
    };
  }
  const branch = getGitBranch();
  const remote = getGitRemote();
  return {
    ok: true,
    version: branch || 'detached',
    path: remote || 'local',
    note: null,
  };
});

check('glitch-memorycore', 'Core', () => {
  const f = join(ROOT_DIR, 'glitch-memorycore', 'glitch.md');
  if (!existsSync(f)) {
    return {
      ok: false,
      version: null,
      path: null,
      note: 'submodule not initialized -- run: git submodule update --init',
    };
  }
  return {
    ok: true,
    version: 'initialized',
    path: 'glitch-memorycore/glitch.md',
    note: null,
  };
});

// --- Tools ---

check('Handy', 'Tools', () => {
  const exePath = isWin
    ? 'handy-voice/Handy/handy.exe'
    : isMac
      ? 'handy-voice/Handy.app/Contents/MacOS/Handy'
      : 'handy-voice/Handy.AppImage';
  if (!existsSync(HANDY_BIN)) {
    return {
      ok: false,
      version: null,
      path: null,
      note: 'optional -- voice input',
    };
  }
  return {
    ok: true,
    version: 'installed',
    path: exePath,
    note: null,
  };
});

check('Cloudflared', 'Tools', () => {
  const exePath = isWin ? 'cloudflared.exe' : 'cloudflared';
  if (!existsSync(CLOUDFLARED)) {
    return {
      ok: false,
      version: null,
      path: null,
      note: 'optional -- tunnel access',
    };
  }
  const v = tryReadVersion(CLOUDFLARED);
  return {
    ok: true,
    version: v || 'unknown',
    path: exePath,
    note: null,
  };
});

function persistedPathDirs() {
  // The installer's own rule: session PATH is NOT authoritative (launch
  // scripts prepend bundled paths per launch, and a fresh terminal can lack
  // git entirely), so git discovery reads the persisted User/Machine PATH.
  // The checker must agree, or a machine whose git lives only on the
  // persisted PATH clones fine but reports "Bash not found".
  const dirs = [];
  const queries = [
    ['reg.exe', ['query', 'HKCU\\Environment', '/v', 'Path']],
    ['reg.exe', ['query', 'HKLM\\SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Environment', '/v', 'Path']]
  ];
  for (const [cmd, args] of queries) {
    try {
      const out = execFileSync(cmd, args, { encoding: 'utf-8', timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'] });
      for (const m of String(out).matchAll(/REG_(?:EXPAND_)?SZ\s+Path\s+([^\r\n]+)/gi)) {
        for (const p of m[1].split(';')) {
          const t = p.trim().replace(/^"|"$/g, '');
          if (t) dirs.push(t);
        }
      }
    } catch { /* reg unavailable or key missing: session PATH + roots still apply */ }
  }
  return dirs;
}
// Walk up to 4 ancestors from git.exe probing usr\bin\bash.exe then
// bin\bash.exe at each level. Mirrors Test-BashBesideGit in install-pi.ps1
// so the installer and the checker agree on every git layout (cmd\,
// mingw64\bin, bin\, scoop, chocolatey shim, portable git).
function bashBesideGitExe(gitExe) {
  if (!gitExe) return null;
  let dir = dirname(gitExe);
  for (let i = 0; i < 4; i++) {
    for (const rel of [['usr', 'bin', 'bash.exe'], ['bin', 'bash.exe']]) {
      const candidate = join(dir, ...rel);
      if (existsSync(candidate)) return candidate;
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

function findBashViaSystemGit() {
  if (process.platform !== 'win32') return null;
  const seen = new Set();
  const pathDirs = [];
  for (const d of [...persistedPathDirs(), ...(process.env.PATH || process.env.Path || '').split(';')]) {
    const t = d.trim().replace(/^"|"$/g, '');
    if (t && !seen.has(t.toLowerCase())) { seen.add(t.toLowerCase()); pathDirs.push(t); }
  }
  // Collect git.exe candidates (every PATH dir that contains git.exe). We
  // reuse this list for the FAILURE note so the user can see what was probed.
  const gitCandidates = [];
  for (const dir of pathDirs) {
    const gitExe = join(dir, 'git.exe');
    if (existsSync(gitExe)) gitCandidates.push(gitExe);
  }
  // Helper: derive the git ROOT from `git --exec-path` output by stripping
  // the trailing \mingw64\libexec\git-core / \mingw64\libexec / \libexec\git-core.
  // Returns null when the exec fails or the result does not look like a path.
  function rootFromExecPath(gitExe) {
    let out;
    try {
      out = spawnSync(gitExe, ['--exec-path'], { encoding: 'utf-8', timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'] });
    } catch { return null; }
    if (!out || out.status !== 0 || !out.stdout) return null;
    let root = String(out.stdout).split(/\r?\n/)[0].trim().replace(/^"|"$/g, '');
    if (!root) return null;
    // Normalize forward slashes (git on Windows emits POSIX-style paths).
    const rootLower = root.replace(/\//g, '\\').toLowerCase();
    for (const suffix of ['\\mingw64\\libexec\\git-core', '\\mingw64\\libexec', '\\libexec\\git-core']) {
      const idx = rootLower.lastIndexOf(suffix);
      if (idx >= 0 && idx + suffix.length === rootLower.length) {
        root = root.slice(0, idx);
        break;
      }
    }
    return root || null;
  }
  // Pass 1 (NEW): ask git itself via --exec-path. git on PATH can be a
  // chocolatey shim, scoop or portable install whose real root no
  // dirname(dirname()) walk resolves; --exec-path gives the layout-proof
  // root and we probe usr\bin/bash.exe + bin/bash.exe under it.
  for (const gitExe of gitCandidates) {
    const root = rootFromExecPath(gitExe);
    if (!root) continue;
    for (const rel of [['usr', 'bin', 'bash.exe'], ['bin', 'bash.exe']]) {
      const candidate = join(root, ...rel);
      if (existsSync(candidate)) return candidate;
    }
    // Also try the cmd/git.exe convention even when --exec-path yielded a
    // non-empty root (covers layouts where git.exe is in cmd\ and bash is
    // under cmd\..\usr\bin, which the ancestor walk already covers -- kept
    // as a safety net).
    const cmdGit = join(root, 'cmd', 'git.exe');
    if (existsSync(cmdGit)) {
      const bash = bashBesideGitExe(cmdGit);
      if (bash) return bash;
    }
  }
  // Pass 2: every PATH dir with git.exe; resolve bash by walking up from git.exe.
  for (const gitExe of gitCandidates) {
    const bash = bashBesideGitExe(gitExe);
    if (bash) return bash;
  }
  // Pass 3: bare bash.exe sitting directly in a PATH dir (scoop/chocolatey
  // shims, standalone MinGit, etc.) -- git on PATH not required.
  for (const dir of pathDirs) {
    const bashExe = join(dir, 'bash.exe');
    if (existsSync(bashExe)) return bashExe;
  }
  // Pass 4: last-ditch known install roots. git.exe may live in cmd\ or bin\.
  const roots = [
    process.env.LOCALAPPDATA ? join(process.env.LOCALAPPDATA, 'Programs', 'Git') : null,
    'C:\\Program Files\\Git',
    'C:\\Program Files (x86)\\Git',
    'D:\\Program Files\\Git'
  ].filter(Boolean);
  for (const root of roots) {
    for (const sub of ['cmd', 'bin']) {
      const gitExe = join(root, sub, 'git.exe');
      if (!existsSync(gitExe)) continue;
      const bash = bashBesideGitExe(gitExe);
      if (bash) return bash;
    }
  }
  // Attach diagnostic info so callers can produce a self-explaining note.
  findBashViaSystemGit.lastDiagnostics = {
    gitCandidates,
    bareBashOnPath: pathDirs.some((d) => existsSync(join(d, 'bash.exe'))),
  };
  return null;
}

// Execution probe: bash.exe being on disk is necessary, not sufficient.
// Mirrors the install-pi.ps1 self-test that runs `bash --version` after
// MinGit is finalized: a file that exists may still fail to launch (busybox
// shim that exits immediately, DLL search-path mismatch, blocked by AV, etc.).
// Returns { ok, shortVersion, error }. shortVersion is X.Y[.Z]; error is a
// short human-readable reason on failure.
function probeBashExecutable(bashExe) {
  let out;
  try {
    out = execFileSync(bashExe, ['--version'], {
      encoding: 'utf-8',
      timeout: 5000,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (e) {
    const msg = (e && (e.message || String(e))) || 'unknown error';
    const short = msg.split('\n')[0].slice(0, 200);
    return { ok: false, shortVersion: null, error: short };
  }
  const text = String(out || '').trim();
  if (!text) {
    return { ok: false, shortVersion: null, error: 'no output' };
  }
  const m = text.match(/version\s+(\d+\.\d+(?:\.\d+)?)/i);
  const shortVersion = m ? m[1] : text.split('\n')[0].slice(0, 40);
  return { ok: true, shortVersion, error: null };
}

check('Bash (MinGit)', 'Tools', () => {
  if (isWin) {
    const bashExe = join(ROOT_DIR, 'data', 'mingit', 'usr', 'bin', 'bash.exe');
    if (existsSync(bashExe)) {
      const probe = probeBashExecutable(bashExe);
      if (probe.ok) {
        return {
          ok: true,
          version: null,
          path: 'data/mingit/usr/bin/bash.exe',
          note: `bundled MinGit (bash ${probe.shortVersion})`,
        };
      }
      return {
        ok: false,
        version: null,
        path: 'data/mingit/usr/bin/bash.exe',
        note: `bundled MinGit bash.exe is present at data\\mingit\\usr\\bin\\bash.exe but failed to execute (${probe.error}). Glitch's bash tool will not work. Re-run the installer to re-extract MinGit, or delete data\\mingit and let it re-provision.`,
      };
    }
    const sysBash = findBashViaSystemGit();
    if (sysBash) {
      const probe = probeBashExecutable(sysBash);
      if (probe.ok) {
        return {
          ok: true,
          version: null,
          path: sysBash,
          note: `system git bash (bash ${probe.shortVersion})`,
        };
      }
      return {
        ok: false,
        version: null,
        path: sysBash,
        note: `system git bash at ${sysBash} exists but failed to execute (${probe.error}). Glitch's bash tool will not work.`,
      };
    }
    const diag = findBashViaSystemGit.lastDiagnostics || { gitCandidates: [], bareBashOnPath: false };
    const candList = diag.gitCandidates.length
      ? diag.gitCandidates.join(', ')
      : '(none on PATH)';
    const bareOnPath = diag.bareBashOnPath ? 'yes' : 'no';
    return {
      ok: false,
      version: null,
      path: null,
      note: `Bash not found. git.exe candidates: ${candList}; bare bash.exe on PATH: ${bareOnPath}. Re-run the installer to provision the bundled MinGit (includes bash), or install Git for Windows.`,
    };
  }
  const v = safeExec('bash', ['--version']);
  if (v) {
    const m = v.match(/version\s+(\d+\.\d+(?:\.\d+)?)/i);
    return {
      ok: true,
      version: m ? m[1] : 'available',
      path: 'system',
      note: null,
    };
  }
  return {
    ok: false,
    version: null,
    path: null,
    note: 'bash not found -- install: apt install bash / brew install bash',
  };
});

// Resolve `gitnexus` on PATH or in the bundled node tree. On Windows the global
// npm install creates gitnexus.cmd (and gitnexus.exe on newer npm); on Unix it's
// a single binary. We scan PATH entries directly so we don't depend on
// `where`/`which` being available, and so we can report the exact resolved path.
// We also check the bundled node tree (data/node on Windows, data/node/bin on
// Unix) since launch-glitch.bat/sh prepends it to PATH at runtime.
function resolveGitNexus() {
  const pathEnv = process.env.PATH || process.env.Path || '';
  const sep = isWin ? ';' : ':';
  const exeNames = isWin ? ['gitnexus.cmd', 'gitnexus.exe', 'gitnexus'] : ['gitnexus'];

  // Scan PATH entries
  for (const dir of pathEnv.split(sep)) {
    if (!dir) continue;
    for (const name of exeNames) {
      const candidate = join(dir, name);
      if (existsSync(candidate)) return candidate;
    }
  }

  // Also check the bundled node tree (not always on PATH during check)
  const bundledDirs = isWin
    ? [join(ROOT_DIR, 'data', 'node')]
    : [join(ROOT_DIR, 'data', 'node', 'bin')];
  for (const dir of bundledDirs) {
    for (const name of exeNames) {
      const candidate = join(dir, name);
      if (existsSync(candidate)) return candidate;
    }
  }

  return null;
}

check('GitNexus MCP', 'Tools', () => {
  const resolved = resolveGitNexus();
  if (resolved) {
    const v = tryReadVersion(resolved, '--version');
    return {
      ok: true,
      version: v || 'installed',
      path: resolved,
      note: null,
    };
  }

  // Direct existence check of bundled global install dir (catches installs
  // where the binary is present but not on PATH and tryReadVersion failed)
  const bundledGlobalDir = isWin
    ? join(ROOT_DIR, 'data', 'node', 'node_modules', 'gitnexus')
    : join(ROOT_DIR, 'data', 'node', 'lib', 'node_modules', 'gitnexus');
  if (existsSync(bundledGlobalDir)) {
    return {
      ok: true,
      version: 'installed',
      path: bundledGlobalDir,
      note: 'bundled npm global',
    };
  }

  // Fallback: ask npm whether gitnexus is in the global tree. This catches
  // installs where the binary is on a PATH not visible to this process
  // (e.g. user PATH vs system PATH on Windows). Prefer bundled npm if present
  // (fresh machines may not have system npm).
  const bundledNpm = isWin
    ? join(ROOT_DIR, 'data', 'node', 'npm.cmd')
    : join(ROOT_DIR, 'data', 'node', 'bin', 'npm');
  const npmCmd = existsSync(bundledNpm) ? bundledNpm : (isWin ? 'npm.cmd' : 'npm');
  const npmList = safeExec(npmCmd, ['list', '-g', '--depth=0', 'gitnexus']);
  if (npmList && /gitnexus@/.test(npmList)) {
    const m = npmList.match(/gitnexus@([\w.\-]+)/);
    return {
      ok: true,
      version: m ? m[1] : 'installed',
      path: 'npm global',
      note: 'binary not on PATH but installed globally',
    };
  }
  return {
    ok: false,
    version: null,
    path: null,
    note: 'install: npm install -g gitnexus',
  };
});

check('GitNexus MCP Config', 'Tools', () => {
  const runtimeConfig = join(ROOT_DIR, 'opencode.json');
  if (!existsSync(runtimeConfig)) {
    return {
      ok: true,
      version: null,
      path: null,
      note: 'runtime config not generated yet (created on first launch)',
    };
  }
  let cfg = null;
  try {
    cfg = JSON.parse(readFileSync(runtimeConfig, 'utf-8'));
  } catch (err) {
    const note = err && err.code === 'EISDIR'
      ? 'opencode.json is a directory, not a file'
      : 'opencode.json exists but is unreadable/invalid JSON';
    return {
      ok: false,
      version: null,
      path: null,
      note,
    };
  }
  const gn = cfg && cfg.mcp && cfg.mcp.gitnexus;
  if (gn && Array.isArray(gn.command) && String(gn.command[0]).includes('gitnexus')) {
    return {
      ok: true,
      version: 'configured',
      path: 'opencode.json -> mcp.gitnexus',
      note: null,
    };
  }
  return {
    ok: false,
    version: null,
    path: null,
    note: 'opencode.json missing mcp.gitnexus — regenerate by running launch-glitch.bat, or fix config/opencode-*.json template',
  };
});

check('Image Gen', 'Tools', () => {
  // ComfyUI / image-gen marker -- check for the install script or a known marker
  const script = join(ROOT_DIR, 'scripts', 'install-image-gen.ps1');
  if (!existsSync(script)) {
    return {
      ok: false,
      version: null,
      path: null,
      note: 'install: scripts/install-image-gen.ps1',
    };
  }
  return {
    ok: true,
    version: 'available',
    path: 'scripts/install-image-gen.ps1',
    note: 'installer present',
  };
});

// --- Config ---

check('Agent Config', 'Config', () => {
  // The Pi fork's agent organs live under .pi/ (profiles, subagents, extensions).
  const piDir = join(ROOT_DIR, '.pi');
  const profilesDir = join(piDir, 'agent-profiles');
  const agentsDir = join(piDir, 'agents');
  const extensionsDir = join(piDir, 'extensions');
  if (!existsSync(piDir)) {
    return {
      ok: false,
      version: null,
      path: null,
      note: '.pi/ missing -- repo incomplete',
    };
  }
  const missing = [!existsSync(profilesDir) && 'agent-profiles/', !existsSync(agentsDir) && 'agents/', !existsSync(extensionsDir) && 'extensions/'].filter(Boolean);
  if (missing.length > 0) {
    return {
      ok: false,
      version: null,
      path: null,
      note: `missing: ${missing.join(', ')}`,
    };
  }
  return {
    ok: true,
    version: 'present',
    path: '.pi/{agent-profiles,agents,extensions}',
    note: null,
  };
});

// .pi/skills is generated from the glitch-memorycore submodule by
// scripts/sync-skills.mjs --pi (bootstrap-pi.ps1 step 5). Empty here means the
// TUI starts with zero engine skills.
check('Engine Skills', 'Config', () => {
  const skillsDir = join(ROOT_DIR, '.pi', 'skills');
  if (!existsSync(skillsDir)) {
    return {
      ok: false,
      version: null,
      path: null,
      note: 'run: node scripts/sync-skills.mjs --pi',
    };
  }
  let count = 0;
  try {
    count = readdirSync(skillsDir).length;
  } catch {
    count = 0;
  }
  if (count === 0) {
    return {
      ok: false,
      version: '0',
      path: '.pi/skills',
      note: 'empty -- run: node scripts/sync-skills.mjs --pi',
    };
  }
  return {
    ok: true,
    version: String(count),
    path: '.pi/skills',
    note: null,
  };
});

check('Launch Script', 'Config', () => {
  const bat = join(ROOT_DIR, 'launch-glitch.bat');
  const sh = join(ROOT_DIR, 'launch-glitch.sh');
  const hasBat = existsSync(bat);
  const hasSh = existsSync(sh);
  if (!hasBat && !hasSh) {
    return {
      ok: false,
      version: null,
      path: null,
      note: 'launch-glitch.bat / launch-glitch.sh missing',
    };
  }
  const found = [];
  if (hasBat) found.push('bat');
  if (hasSh) found.push('sh');
  return {
    ok: true,
    version: found.join('+'),
    path: `launch-glitch.${found[0]}`,
    note: found.length > 1 ? `also: launch-glitch.${found[1]}` : null,
  };
});

check('User Profile', 'Config', () => {
  const userDir = join(ROOT_DIR, 'user');
  const gitDir = join(userDir, '.git');
  if (!existsSync(userDir)) {
    return {
      ok: false,
      version: null,
      path: null,
      note: 'user memory not initialized',
    };
  }
  const synced = existsSync(gitDir);
  return {
    ok: true,
    version: synced ? 'synced' : 'local-only',
    path: 'user/',
    note: synced ? null : 'no .git -- local only',
  };
});

// The user memory repo lives at <root>/user and reaches the Pi engine through
// a user-side link (%USERPROFILE%\.pi\agent\user on Windows, $HOME/.pi/agent/
// user elsewhere). If the link is missing or points elsewhere, the engine
// reads and writes a DIFFERENT memory directory and the two silently diverge.
// Compare the physical (realpath) target of both sides.
check('User Memory Link', 'Config', () => {
  const home = isWin ? process.env.USERPROFILE : process.env.HOME;
  if (!home) {
    return {
      ok: false,
      version: null,
      path: null,
      note: 'no home dir (USERPROFILE/HOME unset) -- cannot verify the user memory link',
    };
  }
  const userSide = join(home, '.pi', 'agent', 'user');
  const repoSide = join(ROOT_DIR, 'user');
  const makeParent = isWin
    ? `md "${dirname(userSide)}"`
    : `mkdir -p "${dirname(userSide)}"`;
  const makeLink = isWin
    ? `cmd /c mklink /J "${userSide}" "${repoSide}"`
    : `ln -s "${repoSide}" "${userSide}"`;
  let realUser = null;
  try {
    realUser = realpathSync(userSide);
  } catch {
    realUser = null;
  }
  if (!realUser) {
    return {
      ok: false,
      version: null,
      path: null,
      note: `${userSide} is missing -- memory not linked. Repair: ${makeParent} then ${makeLink}`,
    };
  }
  let realRepo = null;
  try {
    realRepo = realpathSync(repoSide);
  } catch {
    realRepo = null;
  }
  if (!realRepo) {
    return {
      ok: false,
      version: null,
      path: null,
      note: `${repoSide} is missing -- user memory not initialized (see User Profile)`,
    };
  }
  const sameDir = isWin
    ? realUser.toLowerCase() === realRepo.toLowerCase()
    : realUser === realRepo;
  if (sameDir) {
    return {
      ok: true,
      version: 'linked',
      path: '.pi/agent/user -> user/',
      note: null,
    };
  }
  // User side exists but resolves elsewhere. A real directory (not a link)
  // must be merged/moved BY HAND first -- warn, never suggest deleting it.
  let isLink = false;
  try {
    isLink = lstatSync(userSide).isSymbolicLink();
  } catch {
    isLink = false;
  }
  if (isLink) {
    const removeLink = isWin ? `rmdir "${userSide}"` : `rm "${userSide}"`;
    return {
      ok: false,
      version: null,
      path: userSide,
      note: `link points to ${realUser}, not ${realRepo} -- repair: ${removeLink} then ${makeLink}`,
    };
  }
  return {
    ok: false,
    version: null,
    path: userSide,
    note: `real directory exists at ${userSide} (not a link) -- merge/move its contents into ${repoSide} BY HAND, then repair: ${makeLink}`,
  };
});

// Informational only (never a failure): the install-time root record written
// by scripts/write-root-record.mjs (called from install-pi.ps1 near the end
// of a successful install) so a Glitch install can be located from inside
// itself. Reports whether the record exists and whether its recorded root
// matches the actual root.
check('Root Record', 'Config', () => {
  const recordPath = join(ROOT_DIR, 'data', 'config', 'root.json');
  const relPath = 'data/config/root.json';
  if (!existsSync(recordPath)) {
    return {
      ok: true,
      version: 'none',
      path: relPath,
      note: 'informational: not written yet -- run: node scripts/write-root-record.mjs',
    };
  }
  let recordedRoot = null;
  try {
    recordedRoot = JSON.parse(readFileSync(recordPath, 'utf-8')).root;
  } catch {
    return {
      ok: true,
      version: 'unreadable',
      path: relPath,
      note: 'informational: exists but unreadable/invalid JSON',
    };
  }
  if (typeof recordedRoot !== 'string' || !recordedRoot) {
    return {
      ok: true,
      version: 'incomplete',
      path: relPath,
      note: 'informational: exists but has no root field',
    };
  }
  const actualRoot = ROOT_DIR.replace(/\\/g, '/');
  const matches = isWin
    ? recordedRoot.toLowerCase() === actualRoot.toLowerCase()
    : recordedRoot === actualRoot;
  return {
    ok: true,
    version: matches ? 'ok' : 'mismatch',
    path: relPath,
    note: matches
      ? null
      : `informational: recorded root ${recordedRoot} != actual root ${actualRoot}`,
  };
});

check('Glitch Head', 'Config', () => {
  const f = join(ROOT_DIR, 'assets', 'glitch-head.txt');
  if (!existsSync(f)) {
    return {
      ok: false,
      version: null,
      path: null,
      note: 'optional -- startup banner',
    };
  }
  return {
    ok: true,
    version: 'found',
    path: 'assets/glitch-head.txt',
    note: null,
  };
});

// ---------------------------------------------------------------------------
// Run + Report
// ---------------------------------------------------------------------------

const CRITICAL = new Set(['Node.js', 'Pi CLI', 'pi-web-ui', 'Git Repo', 'glitch-memorycore']);

function runAll() {
  const results = checks.map((c) => ({ name: c.name, group: c.group, ...c.run() }));
  return results;
}

function render(results) {
  const lines = [];
  const groups = ['Core', 'Tools', 'Config'];

  lines.push(`${C.bold}${C.cyan}Glitch AI -- Install Status${C.reset}`);
  lines.push(`${C.cyan}${'='.repeat(34)}${C.reset}`);
  lines.push('');

  for (const g of groups) {
    const items = results.filter((r) => r.group === g);
    if (items.length === 0) continue;
    lines.push(` ${C.bold}${g}${C.reset}`);
    for (const r of items) {
      const sym = r.ok ? SYM.ok : SYM.fail;
      const ver = r.ok ? pad(r.version || 'ok', 12) : pad('--', 12);
      const path = r.path || '--';
      const note = r.note ? `  ${C.dim}${r.note}${C.reset}` : '';
      lines.push(`  ${sym} ${pad(r.name, 14)} ${ver} ${C.gray}(${path})${C.reset}${note}`);
    }
    lines.push('');
  }

  const total = results.length;
  const passed = results.filter((r) => r.ok).length;
  const criticalFailed = results.filter((r) => !r.ok && CRITICAL.has(r.name));

  let verdict;
  let verdictColor;
  if (criticalFailed.length > 0) {
    verdict = 'FAIL';
    verdictColor = C.red;
  } else if (passed === total) {
    verdict = 'PASS';
    verdictColor = C.green;
  } else {
    verdict = 'PARTIAL';
    verdictColor = C.yellow;
  }

  lines.push(
    `${C.bold}Result: ${passed}/${total} components OK -- ${verdictColor}${verdict}${C.reset}`
  );

  if (criticalFailed.length > 0) {
    lines.push('');
    lines.push(`${C.red}Critical missing:${C.reset}`);
    for (const r of criticalFailed) {
      lines.push(`  ${SYM.fail} ${r.name} -- ${r.note || 'required'}`);
    }
  }

  return lines.join('\n');
}

function main() {
  const results = runAll();
  const report = render(results);
  console.log(report);

  const criticalFailed = results.filter((r) => !r.ok && CRITICAL.has(r.name));
  process.exit(criticalFailed.length > 0 ? 1 : 0);
}

// Export for programmatic use (e.g. from @general dispatch)
export { runAll, render, CRITICAL };

// Run when invoked directly
const isMain =
  process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1].replace(/\\/g, '/');
if (isMain || process.argv[1]?.endsWith('check-install.mjs')) {
  main();
}
