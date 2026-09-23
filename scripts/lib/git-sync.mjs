#!/usr/bin/env node

/**
 * Shared git repo sync module - branch-aware update checking for all Glitch launch scripts.
 *
 * Replaces the old syncMainRepo() pattern that only worked on `main` branch.
 * Now: detects ANY branch, checks its upstream, checks for updates, prompts the user.
 *
 * Exports:
 *   checkRepoUpdates(options)   -- Check glitch-ai repo for updates, prompt if interactive
 *   checkUserRepoUpdates(options) -- Check user/ repo for updates, prompt if interactive
 *
 * Options:
 *   cwd                         -- Repo root (default: process.cwd())
 *   interactive                 -- Show prompts (default: true)
 *   allowBranchSwitch           -- Show "switch to main" option (default: true)
 *   quiet                       -- Suppress "up-to-date" logging (default: false)
 */

import { execFileSync } from 'child_process';
import { createInterface } from 'readline';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';

// ===== Cross-platform helpers =====

const isWin = process.platform === 'win32';

function log(color, msg) {
  if (msg === undefined) {
    console.log(color);
  } else {
    console.log(`${color}${msg}\x1b[0m`);
  }
}

function run(cmd, args, opts = {}) {
  try {
    // On Windows, .cmd/.bat must run through cmd.exe explicitly
    if (isWin && (cmd.endsWith('.cmd') || cmd.endsWith('.bat'))) {
      args = ['/d', '/s', '/c', cmd, ...args];
      cmd = 'cmd.exe';
    }
    const out = execFileSync(cmd, args, {
      encoding: 'utf-8',
      maxBuffer: 10 * 1024 * 1024,
      ...opts,
    });
    return { success: true, stdout: (out || '').toString().trim(), status: 0 };
  } catch (e) {
    return {
      success: false,
      stdout: ((e.stdout || '')).toString().trim(),
      stderr: ((e.stderr || '')).toString().trim(),
      error: e.message || String(e),
      status: e.status,
    };
  }
}

function askQuestion(query) {
  return new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    rl.question(query, (answer) => {
      rl.close();
      resolve(answer);
    });
  });
}

// ===== Color constants =====

const C = {
  MAGENTA: '\x1b[35m',
  CYAN: '\x1b[36m',
  GREEN: '\x1b[32m',
  RED: '\x1b[31m',
  YELLOW: '\x1b[33m',
  DARK_GREEN: '\x1b[32;2m',
  DARK_YELLOW: '\x1b[33;2m',
  DARK_GRAY: '\x1b[90m',
  WHITE: '\x1b[37m',
};

// ===== Core logic =====

/**
 * Get the current git branch name.
 * @param {string} cwd
 * @returns {{ branch: string|null, isDetached: boolean }}
 */
function getCurrentBranch(cwd) {
  const r = run('git', ['symbolic-ref', '--short', 'HEAD'], { cwd, timeout: 5000 });
  if (r.success) {
    const b = r.stdout.trim();
    return { branch: b, isDetached: false };
  }
  const headCheck = run('git', ['rev-parse', '--verify', 'HEAD'], { cwd, timeout: 5000 });
  if (headCheck.success) {
    return { branch: null, isDetached: true };
  }
  return { branch: null, isDetached: false };
}

/**
 * Check if an upstream tracking branch exists.
 * @returns {boolean}
 */
function hasUpstream(cwd, branch) {
  const r = run('git', ['rev-parse', '--abbrev-ref', '--symbolic-full-name', `${branch}@{u}`], { cwd, timeout: 5000 });
  return r.success && r.stdout.trim().length > 0;
}

/**
 * Check if a local branch exists (silent — no fatal noise on missing refs).
 * @returns {boolean}
 */
function branchExists(cwd, branch) {
  const r = run('git', ['rev-parse', '--verify', '--quiet', branch], { cwd, timeout: 5000 });
  return r.success;
}

/**
 * Fetch all branches from origin.
 * @returns {boolean}
 */
function fetchOrigin(cwd) {
  const r = run('git', ['fetch', 'origin'], { cwd, timeout: 30000 });
  return r.success;
}

/**
 * Get behind/ahead counts for a branch vs its remote.
 * @returns {{ behind: number, ahead: number }|null}
 */
function getBehindAhead(cwd, branch) {
  const upstreamRef = `origin/${branch}`;

  const behindR = run('git', ['rev-list', '--count', `HEAD..${upstreamRef}`], { cwd, timeout: 10000 });
  if (!behindR.success || !/^\d+$/.test(behindR.stdout)) return null;
  const behind = parseInt(behindR.stdout, 10);

  const aheadR = run('git', ['rev-list', '--count', `${upstreamRef}..HEAD`], { cwd, timeout: 10000 });
  const ahead = aheadR.success && /^\d+$/.test(aheadR.stdout) ? parseInt(aheadR.stdout, 10) : 0;

  return { behind, ahead };
}

/**
 * Fast-forward pull the current branch.
 * @returns {boolean}
 */
function pullBranch(cwd, branch) {
  const r = run('git', ['pull', '--ff-only', 'origin', branch], { cwd, timeout: 30000 });
  return r.success;
}

/**
 * Update submodules.
 */
function syncSubmodules(cwd) {
  run('git', ['submodule', 'update', '--init', '--recursive'], { cwd, timeout: 60000 });
}

/**
 * Check if working tree is dirty (has uncommitted changes).
 * @returns {boolean}
 */
function isDirty(cwd) {
  const r = run('git', ['status', '--porcelain'], { cwd, timeout: 5000 });
  return r.success && r.stdout.trim().length > 0;
}

/**
 * Switch to main branch, stashing changes first if dirty.
 * @returns {boolean}
 */
function switchToMain(cwd, currentBranch) {
  if (isDirty(cwd)) {
    log(C.YELLOW, '  Local changes detected, stashing...');
    run('git', ['stash', 'push', '-m', `glitch-auto-stash: ${currentBranch}`], { cwd, timeout: 15000 });
  }
  const mainExists = run('git', ['rev-parse', '--verify', '--quiet', 'main'], { cwd, timeout: 5000 });
  if (!mainExists.success) {
    run('git', ['remote', 'set-branches', 'origin', '*'], { cwd, timeout: 10000 });
    run('git', ['fetch', 'origin', 'main'], { cwd, timeout: 30000 });
  }
  const r = run('git', ['checkout', 'main'], { cwd, timeout: 30000 });
  return r.success;
}

/**
 * Get list of modified tracked files (diff --name-only).
 * @returns {string[]}
 */
function getModifiedFiles(cwd) {
  const r = run('git', ['diff', '--name-only'], { cwd, timeout: 10000 });
  if (!r.success || !r.stdout) return [];
  return r.stdout.split('\n').filter(l => l.trim().length > 0);
}

/**
 * Get list of files that changed between the previous HEAD and current HEAD.
 * Uses `git diff --name-only HEAD@{1} HEAD` which, after a fast-forward pull,
 * gives exactly the files updated by the pull.
 *
 * Returns null if the reflog entry HEAD@{1} does not exist (first commit,
 * shallow clone, reflog disabled). Callers should treat null as "unknown"
 * and default to restartNeeded: true (safer to restart than to skip).
 *
 * @param {string} cwd
 * @returns {string[]|null}
 */
function getChangedFiles(cwd) {
  const r = run('git', ['diff', '--name-only', 'HEAD@{1}', 'HEAD'], { cwd, timeout: 10000 });
  if (!r.success) return null;
  if (!r.stdout) return [];
  return r.stdout.split('\n').filter(l => l.trim().length > 0);
}

/**
 * Determine whether a changed file is startup-critical: if it changed, the
 * currently-running launch script may be executing stale code and should
 * restart itself to pick up the new version.
 *
 * Matches by prefix and extension (simple string checks, not whole-path regex):
 *   - scripts/        + (.mjs or .ps1)   shared modules and launch scripts
 *   - config/         + any               template configs
 *   - glitch-memorycore/ + any            engine files loaded as instructions
 *   - .opencode/       + any              agent definitions, plugins, instructions
 *   - root files ending in .bat or .sh    entry point launchers in repo root
 *
 * @param {string} filePath - Repo-relative path using forward slashes.
 * @returns {boolean}
 */
function isStartupCritical(filePath) {
  if (!filePath || typeof filePath !== 'string') return false;
  const p = filePath.trim();
  if (p.length === 0) return false;

  if (p.startsWith('scripts/')) {
    return p.endsWith('.mjs') || p.endsWith('.ps1');
  }
  if (p.startsWith('config/')) return true;
  if (p.startsWith('glitch-memorycore/')) return true;
  if (p.startsWith('.opencode/')) return true;
  if (p.endsWith('.bat') || p.endsWith('.sh')) return true;
  return false;
}

/**
 * Discard local changes to tracked files (git restore .).
 */
function discardChanges(cwd) {
  run('git', ['restore', '.'], { cwd, timeout: 15000 });
}

/**
 * Compute restart-needed info after a successful pull.
 *
 * Runs `git diff --name-only HEAD@{1} HEAD` to get the files changed by the
 * pull, then filters to startup-critical paths. If the diff command fails
 * (HEAD@{1} unavailable -- first commit, shallow clone, reflog disabled),
 * returns restartNeeded: true with an empty changedStartupFiles list, since
 * it is safer to restart than to silently skip.
 *
 * @param {string} cwd
 * @returns {{ restartNeeded: boolean, changedStartupFiles: string[] }}
 */
function computeRestartInfo(cwd) {
  const changed = getChangedFiles(cwd);
  if (changed === null) {
    // JSDoc: treat null as 'unknown' and default to restartNeeded: true (safer to restart than to skip)
    return { restartNeeded: true, changedStartupFiles: [], reason: 'unable to determine changes' };
  }
  const startupFiles = changed.filter(isStartupCritical);
  return {
    restartNeeded: startupFiles.length > 0,
    changedStartupFiles: startupFiles,
    reason: startupFiles.length > 0 ? 'startup files changed' : 'no startup files changed'
  };
}

/**
 * Switch to a specific branch, stashing changes first if dirty.
 * @returns {boolean}
 */
function switchBranch(cwd, targetBranch, sourceBranch) {
  if (isDirty(cwd)) {
    log(C.YELLOW, '  Local changes detected, stashing...');
    run('git', ['stash', 'push', '-m', `glitch-auto-stash: ${sourceBranch}`], { cwd, timeout: 15000 });
  }
  const r = run('git', ['checkout', targetBranch], { cwd, timeout: 30000 });
  return r.success;
}

const RESTART_MAX_DISPLAY = 8;

/**
 * Update-triggered restart: spawn a fresh process with the updated launch
 * script and exit the current one. This is DIFFERENT from the user-triggered
 * restart path (data/.restart-flag + in-process loop in serve.mjs/launch.mjs).
 *
 * - Uses detached:true + child.unref() so the child survives parent exit
 *   on all platforms (Windows and Unix).
 * - The child inherits the parent's stdio and takes over the console.
 * - If the child fails to start, the parent will see the spawn error.
 * - If the child exits with a non-zero code, the parent logs the failure
 *   before the child's output is lost.
 *
 * @param {Function} spawnFn - spawn function from child_process (passed by caller)
 * @param {{ restartNeeded: boolean, changedStartupFiles: string[] }} syncResult
 * @param {string} cwd - Working directory for the child process (repo root)
 */
export function handleRestartOnUpdate(spawnFn, syncResult, cwd) {
  if (!syncResult.restartNeeded) return;

  if (typeof spawnFn !== 'function') {
    log(C.RED, '  Restart failed: spawnFn must be a function');
    process.exit(1);
  }

  const restartFlagPath = join(cwd, 'data', '.restart-timestamp');
  if (existsSync(restartFlagPath)) {
    try {
      const lastRestart = parseInt(readFileSync(restartFlagPath, 'utf8').trim(), 10);
      const now = Date.now();
      if (now - lastRestart < 15000) {
        // Less than 15 seconds since last restart - skip to prevent loop
        // Log warning so user knows startup-critical files were updated but not applied
        log(C.DARK_YELLOW, '  Recent restart detected (<15s) — skipping restart to prevent loop');
        log(C.DARK_YELLOW, '  If startup-critical files were updated, manually restart Glitch to apply them');
        return;
      }
    } catch {
      // Corrupt flag — ignore and proceed
    }
  }

  try {
    const dataDir = join(cwd, 'data');
    if (!existsSync(dataDir)) {
      mkdirSync(dataDir, { recursive: true });
    }
    writeFileSync(restartFlagPath, Date.now().toString());
  } catch {
    // Can't write flag — proceed with restart anyway
  }

  log(C.CYAN, '');
  log(C.CYAN, '  Startup scripts updated. Restarting to apply changes...');
  if (syncResult.changedStartupFiles && syncResult.changedStartupFiles.length > 0) {
    log(C.DARK_GRAY, `  ${syncResult.changedStartupFiles.length} file(s) changed:`);
    for (const f of syncResult.changedStartupFiles.slice(0, RESTART_MAX_DISPLAY)) {
      log(C.DARK_GRAY, `    ${f}`);
    }
    if (syncResult.changedStartupFiles.length > RESTART_MAX_DISPLAY) {
      log(C.DARK_GRAY, `    ... and ${syncResult.changedStartupFiles.length - RESTART_MAX_DISPLAY} more`);
    }
  }
  log('');

  if (!process.argv[1]) {
    log(C.RED, '  Cannot restart: no script path (process.argv[1] is empty)');
    process.exit(1);
  }

  const childArgs = [process.argv[1], ...process.argv.slice(2)];

  if (isWin) {
    // Windows: blocking re-exec keeps the SAME console window (detached spawn
    // would flash a new window and the bat would close the old one).
    try {
      execFileSync(process.execPath, childArgs, {
        cwd,
        stdio: 'inherit',
        timeout: 0,
      });
      process.exit(0);
    } catch (e) {
      const code = e.status ?? 1;
      log(C.RED, `  Restarted process exited with code ${code} — check logs for errors`);
      process.exit(code);
    }
  }

  // Unix: detached spawn survives parent exit (SIGHUP isolation)
  const child = spawnFn(process.execPath, childArgs, {
    cwd,
    stdio: 'inherit',
    detached: true,
  });

  child.unref();

  child.on('error', (err) => {
    log(C.RED, '  Restart failed: ' + err.message);
    process.exit(1);
  });

  child.on('exit', (code) => {
    if (code !== 0) {
      log(C.RED, `  Restarted process exited with code ${code} — check logs for errors`);
    }
  });

  process.exit(0);
}

// ===== Exported functions =====

/**
 * Check a git repo for updates. Prompts interactively if updates found.
 *
 * @param {Object} options
 * @param {string} [options.cwd] - Repo root (default: process.cwd())
 * @param {string} [options.label='Repo'] - Display label for logs
 * @param {boolean} [options.interactive=true] - Show prompts
 * @param {boolean} [options.allowBranchSwitch=true] - Show "switch to main" option
 * @param {boolean} [options.quiet=false] - Suppress "up-to-date" logs
 * @returns {Promise<{ checked: boolean, updated: boolean, switchedBranch: boolean, restartNeeded: boolean, changedStartupFiles: string[] }>}
 */
export async function checkRepoUpdates(options = {}) {
  const {
    cwd = process.cwd(),
    label = 'Repo',
    interactive = true,
    allowBranchSwitch = true,
    quiet = false,
  } = options;

  if (!quiet) log(C.CYAN, `  Checking ${label} updates...`);

  // 1. Check .git exists
  if (!existsSync(join(cwd, '.git'))) {
    if (!quiet) log(C.DARK_YELLOW, `  ${label}: not a git repository, skipping`);
    return { checked: false, updated: false, switchedBranch: false, restartNeeded: false, changedStartupFiles: [] };
  }

  // 2. Detect current branch
  const { branch, isDetached } = getCurrentBranch(cwd);
  if (!branch) {
    if (isDetached) {
      if (!quiet) log(C.DARK_YELLOW, `  ${label}: detached HEAD -- skipping`);
    } else {
      if (!quiet) log(C.DARK_YELLOW, `  ${label}: could not detect branch -- skipping`);
    }
    return { checked: false, updated: false, switchedBranch: false, restartNeeded: false, changedStartupFiles: [] };
  }

  // 3. Check upstream exists
  if (!hasUpstream(cwd, branch)) {
    if (!quiet) log(C.DARK_YELLOW, `  ${label}: branch '${branch}' has no upstream -- skipping`);
    return { checked: true, updated: false, switchedBranch: false, restartNeeded: false, changedStartupFiles: [] };
  }

  // 4. Fetch origin
  if (!fetchOrigin(cwd)) {
    if (!quiet) log(C.DARK_YELLOW, `  ${label}: could not fetch (offline?)`);
    return { checked: false, updated: false, switchedBranch: false, restartNeeded: false, changedStartupFiles: [] };
  }

  // 5. Check behind/ahead for current branch
  const ba = getBehindAhead(cwd, branch);
  if (!ba) {
    if (!quiet) log(C.DARK_YELLOW, `  ${label}: could not check behind count`);
    return { checked: false, updated: false, switchedBranch: false, restartNeeded: false, changedStartupFiles: [] };
  }

  // 6. Check divergence
  if (ba.behind > 0 && ba.ahead > 0) {
    log(C.YELLOW, `  ${label}: '${branch}' diverged (${ba.ahead} ahead, ${ba.behind} behind).`);
    log(C.YELLOW, `  Run: git pull origin ${branch}`);
    return { checked: true, updated: false, switchedBranch: false, restartNeeded: false, changedStartupFiles: [] };
  }

  // 7. Check main status for reference (only if on a different branch)
  let mainBehind = 0;
  if (branch !== 'main' && branchExists(cwd, 'main') && hasUpstream(cwd, 'main')) {
    const mainBA = getBehindAhead(cwd, 'main');
    if (mainBA) mainBehind = mainBA.behind;
  }

  // 8. Up-to-date
  if (ba.behind <= 0) {
    if (!quiet) {
      if (mainBehind > 0 && branch !== 'main') {
        log(C.DARK_GREEN, `  ${label}: ${branch} up-to-date; main is ${mainBehind} commit(s) behind`);
      } else {
        log(C.DARK_GREEN, `  ${label}: up-to-date (branch: ${branch})`);
      }
    }
    return { checked: true, updated: false, switchedBranch: false, restartNeeded: false, changedStartupFiles: [] };
  }

  // ===== Updates available =====

  if (!interactive) {
    // Silent/headless mode -- only auto-pull on main
    if (branch !== 'main') {
      if (!quiet) log(C.DARK_YELLOW, `  ${label}: ${branch} is ${ba.behind} behind (auto-sync only on main)`);
      return { checked: true, updated: false, switchedBranch: false, restartNeeded: false, changedStartupFiles: [] };
    }
    log(C.DARK_GRAY, `  ${label}: ${ba.behind} commit(s) behind, syncing...`);
    if (pullBranch(cwd, branch)) {
      log(C.DARK_GREEN, `  ${label}: synced`);
      syncSubmodules(cwd);
      return { checked: true, updated: true, switchedBranch: false, ...computeRestartInfo(cwd) };
    }
    log(C.DARK_YELLOW, `  ${label}: pull failed (need manual update)`);
    return { checked: true, updated: false, switchedBranch: false, restartNeeded: false, changedStartupFiles: [] };
  }

  // ===== Interactive prompt =====

  log('');
  log(C.YELLOW, '  ╔══════════════════════════════════════════════════╗');
  log(C.YELLOW, '  ║     Updates Available                           ║');
  log(C.YELLOW, '  ╚══════════════════════════════════════════════════╝');
  log(C.YELLOW, `  ${label}: '${branch}' is ${ba.behind} commit(s) behind origin/${branch}`);
  if (mainBehind > 0 && branch !== 'main') {
    log(C.DARK_YELLOW, `  main is ${mainBehind} commit(s) behind origin/main`);
  }
  log('');
  log(C.WHITE, '  [P] Pull updates now (fast-forward) [default]');
  log(C.WHITE, '  [s] Skip (update later)');
  if (allowBranchSwitch && branch !== 'main') {
    log(C.WHITE, '  [m] Switch to main & update (recommended)');
  }
  log('');

  const choice = (await askQuestion('  > ')).trim().toLowerCase();

  if (choice === '' || choice === 'p') {
    log(C.CYAN, `  Pulling origin/${branch}...`);
    if (pullBranch(cwd, branch)) {
      log(C.GREEN, `  ${label}: updated!`);
      syncSubmodules(cwd);
      return { checked: true, updated: true, switchedBranch: false, ...computeRestartInfo(cwd) };
    }
    // Pull failed -- likely dirty working tree. Show conflicts and offer discard.
    log(C.YELLOW, `  ${label}: pull failed (local changes may be blocking).`);
    const modified = getModifiedFiles(cwd);
    if (modified.length > 0) {
      log(C.YELLOW, `  ${modified.length} tracked file(s) modified locally:`);
      for (const f of modified.slice(0, 10)) {
        log(C.DARK_GRAY, `    ${f}`);
      }
      if (modified.length > 10) {
        log(C.DARK_GRAY, `    ... and ${modified.length - 10} more`);
      }
    }
    log('');
    log(C.WHITE, '  [d] Discard local changes and retry (reverts tracked files only)');
    log(C.WHITE, `  [m] Commit the ${modified.length} listed file(s) and retry`);
    log(C.WHITE, '  [c] Cancel (keep changes, update later)');
    const retry = (await askQuestion('  > ')).trim().toLowerCase();
    if (retry === 'd') {
      log(C.CYAN, '  Discarding local changes...');
      discardChanges(cwd);
      if (pullBranch(cwd, branch)) {
        log(C.GREEN, `  ${label}: updated!`);
        syncSubmodules(cwd);
        return { checked: true, updated: true, switchedBranch: false, ...computeRestartInfo(cwd) };
      }
      log(C.RED, `  ${label}: pull still failed after discarding. Check git status.`);
    }
    if (retry === 'm') {
      log(C.CYAN, '  Committing local changes...');
      const commitMsg = `glitch-auto: commit ${modified.length} modified file(s) before pull (interactive recovery)`;
      const addRes = run('git', ['add', ...modified], { cwd, timeout: 15000 });
      const commitRes = run('git', ['commit', '-m', commitMsg], { cwd, timeout: 15000 });
      if (addRes.success && commitRes.success) {
        if (pullBranch(cwd, branch)) {
          log(C.GREEN, `  ${label}: updated!`);
          syncSubmodules(cwd);
          return { checked: true, updated: true, switchedBranch: false, ...computeRestartInfo(cwd) };
        }
        log(C.RED, `  ${label}: pull still failed after committing. Check git status.`);
        log(C.YELLOW, `  ${label}: local changes committed but NOT pushed (local-only commit).`);
      } else {
        log(C.YELLOW, `  ${label}: commit failed (${commitRes.stderr || commitRes.error || 'nothing to commit?'})`);
        log(C.YELLOW, '  Try [d] discard, or commit manually.');
      }
    }
    return { checked: true, updated: false, switchedBranch: false, restartNeeded: false, changedStartupFiles: [] };
  }

  if (choice === 'm' && allowBranchSwitch && branch !== 'main') {
    log(C.CYAN, `  Switching to main...`);
    if (!switchToMain(cwd, branch)) {
      log(C.RED, `  ${label}: failed to switch to main. Check git status.`);
      return { checked: true, updated: false, switchedBranch: false, restartNeeded: false, changedStartupFiles: [] };
    }
    log(C.CYAN, '  Pulling origin/main...');
    if (pullBranch(cwd, 'main')) {
      log(C.GREEN, `  ${label}: switched to main and updated!`);
      syncSubmodules(cwd);
      return { checked: true, updated: true, switchedBranch: true, ...computeRestartInfo(cwd) };
    }
    log(C.RED, `  ${label}: pull failed after switching. Check git status.`);
    return { checked: true, updated: false, switchedBranch: true, restartNeeded: false, changedStartupFiles: [] };
  }

  // 's' — explicit skip
  if (!quiet) log(C.DARK_YELLOW, `  ${label}: skipping update.`);
  return { checked: true, updated: false, switchedBranch: false };
}

/**
 * Check the user/ sub-repo for updates. Branch-aware variant.
 * User repos typically live on main, but we check the actual current branch.
 *
 * @param {Object} options - Same as checkRepoUpdates
 * @returns {Promise<{ checked: boolean, updated: boolean, switchedBranch: boolean }>}
 */
export async function checkUserRepoUpdates(options = {}) {
  return checkRepoUpdates({
    label: 'User data',
    ...options,
    // User repos are more conservative -- no branch switching
    allowBranchSwitch: false,
  });
}
