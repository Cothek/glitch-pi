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

import { existsSync, statSync, readFileSync, readdirSync } from 'node:fs';
import { execFileSync, execSync } from 'node:child_process';
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

function bashBesideGit(gitRoot) {
  for (const rel of [['usr', 'bin', 'bash.exe'], ['bin', 'bash.exe']]) {
    const candidate = join(gitRoot, ...rel);
    if (existsSync(candidate)) return candidate;
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
  for (const dir of pathDirs) {
    if (!existsSync(join(dir, 'git.exe'))) continue;
    const bash = bashBesideGit(dirname(dir));
    if (bash) return bash;
  }
  // Last resort: common install roots (git.exe may sit in cmd/ or bin/).
  const roots = [
    process.env.LOCALAPPDATA ? join(process.env.LOCALAPPDATA, 'Programs', 'Git') : null,
    'C:\\Program Files\\Git',
    'C:\\Program Files (x86)\\Git',
    'D:\\Program Files\\Git'
  ].filter(Boolean);
  for (const root of roots) {
    for (const sub of ['cmd', 'bin']) {
      if (!existsSync(join(root, sub, 'git.exe'))) continue;
      const bash = bashBesideGit(root);
      if (bash) return bash;
    }
  }
  return null;
}

check('Bash (MinGit)', 'Tools', () => {
  if (isWin) {
    const bashExe = join(ROOT_DIR, 'data', 'mingit', 'usr', 'bin', 'bash.exe');
    if (existsSync(bashExe)) {
      return {
        ok: true,
        version: null,
        path: 'data/mingit/usr/bin/bash.exe',
        note: 'bundled MinGit',
      };
    }
    const sysBash = findBashViaSystemGit();
    if (sysBash) {
      return {
        ok: true,
        version: null,
        path: sysBash,
        note: 'system git bash',
      };
    }
    return {
      ok: false,
      version: null,
      path: null,
      note: 'Bash not found: git is present but no bash sits beside it. Re-run the installer to provision the bundled MinGit (which includes bash), or install Git for Windows.',
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
