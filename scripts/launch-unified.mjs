#!/usr/bin/env node

import { readFileSync, existsSync, writeFileSync, mkdirSync, unlinkSync } from 'fs';
import { join, dirname, resolve } from 'path';
import { fileURLToPath } from 'url';
import { execFileSync, execSync, spawn } from 'child_process';
import { createInterface } from 'readline';
import { checkRepoUpdates, checkUserRepoUpdates, handleRestartOnUpdate } from './lib/git-sync.mjs';
import { initLaunchLog, logToFile } from './lib/launch-log.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const SCRIPT_DIR = __dirname;
const ROOT_DIR = resolve(SCRIPT_DIR, '..');

// Install tee wrapper on stdout/stderr so every console.log line is also
// appended to data/launch.log (ANSI-stripped, ISO-timestamped).
initLaunchLog();

// Launch-time selections are MACHINE-LOCAL state: they live in data/ (the
// parent repo gitignores data/), NOT in the user/ memory repo which is
// committed and synced. The user/ path remains as a legacy migration fallback
// read only, and is untracked there going forward.
const PrefFile = join(ROOT_DIR, 'data', 'launch-preference.json');
const LegacyPrefFile = join(ROOT_DIR, 'user', 'launch-preference.json');

const MAGENTA = '\x1b[35m';
const CYAN = '\x1b[36m';
const GREEN = '\x1b[32m';
const RED = '\x1b[31m';
const YELLOW = '\x1b[33m';
const DARK_GREEN = '\x1b[32;2m';
const DARK_YELLOW = '\x1b[33;2m';
const DARK_GRAY = '\x1b[90m';
const WHITE = '\x1b[37m';
const RESET = '\x1b[0m';

function log(color, msg) {
  if (msg === undefined) {
    console.log(color);
  } else {
    console.log(`${color}${msg}${RESET}`);
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

function runGit(cmd, args, opts = {}) {
  try {
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

async function checkBranchBeforeLaunch() {
  if (process.env.GLITCH_BRANCH_OK !== undefined && process.env.GLITCH_BRANCH_OK !== '') {
    return;
  }

  const branch = runGit('git', ['symbolic-ref', '--short', 'HEAD'], { cwd: ROOT_DIR, timeout: 5000 });
  if (!branch.success) return;
  const current = branch.stdout.trim();
  if (current === 'main') return;

  // Develop-only repo: no local main and no origin/main — skip the prompt
  // entirely instead of offering a switch that can only fail.
  const localMain = runGit('git', ['rev-parse', '--verify', '--quiet', 'main'], { cwd: ROOT_DIR, timeout: 5000 });
  const originMain = runGit('git', ['rev-parse', '--verify', '--quiet', 'origin/main'], { cwd: ROOT_DIR, timeout: 5000 });
  if (!localMain.success && !originMain.success) {
    log(DARK_GRAY, '  develop-only repo (no main branch) — skipping main check');
    return;
  }

  log(YELLOW, '');
  log(YELLOW, `  !! Currently on branch '${current}', not 'main'`);
  log(YELLOW, '  Glitch is designed to run from the main branch for stability.');
  log(WHITE, '  [Y/n] Switch to main now (recommended)');

  let wantsSwitch = true;
  while (true) {
    const choice = await askQuestion('  > ');
    const raw = (choice ?? '').trim().toLowerCase();
    if (raw === 'n' || raw === 'no') {
      wantsSwitch = false;
      break;
    }
    if (raw === '' || raw === 'y' || raw === 'yes') {
      wantsSwitch = true;
      break;
    }
    log(YELLOW, '  Please answer y (or press Enter) to switch, or n to stay on current branch.');
  }

  if (!wantsSwitch) {
    process.env.GLITCH_BRANCH_OK = '1';
    log(DARK_YELLOW, '  Continuing on current branch (may have unstable config)');
    log('');
    return;
  }

  log(CYAN, '  Switching to main...');

  const mainExists = runGit('git', ['rev-parse', '--verify', 'main'], { cwd: ROOT_DIR, timeout: 5000 });
  if (!mainExists.success) {
    log(DARK_GRAY, '  main branch not found locally, fetching...');
    runGit('git', ['remote', 'set-branches', 'origin', '*'], { cwd: ROOT_DIR, timeout: 10000 });
    runGit('git', ['fetch', 'origin', 'main'], { cwd: ROOT_DIR, timeout: 30000 });
  }

  const status = runGit('git', ['status', '--porcelain'], { cwd: ROOT_DIR, timeout: 5000 });
  const isDirty = status.success && status.stdout.trim().length > 0;
  if (isDirty) {
    log(YELLOW, '  Local changes detected, stashing before switch...');
    const stashMsg = `glitch-auto-stash: ${current}`;
    const stash = runGit('git', ['stash', 'push', '-m', stashMsg], { cwd: ROOT_DIR, timeout: 15000 });
    if (!stash.success) {
      log(RED, `  Failed to stash: ${stash.stderr || stash.error}`);
      log(YELLOW, '  Continuing on current branch...');
      log('');
      process.env.GLITCH_BRANCH_OK = '1';
      return;
    }
  }

  const checkout = runGit('git', ['checkout', 'main'], { cwd: ROOT_DIR, timeout: 30000 });
  if (!checkout.success) {
    log(RED, `  Failed to switch: ${checkout.stderr || checkout.error}`);
    log(YELLOW, '  Continuing on current branch...');
    log('');
    process.env.GLITCH_BRANCH_OK = '1';
    return;
  }

  log(GREEN, '  Switched to main.');
  // Continue in the SAME process — no detached spawn, no exit.
  // The launcher reads config templates from disk fresh, so it picks up
  // main's templates naturally. GLITCH_BRANCH_OK prevents re-prompting.
  process.env.GLITCH_BRANCH_OK = '1';
  log('');
  return;
}

function readJson(path) {
  try {
    let content = readFileSync(path, 'utf-8');
    if (content.charCodeAt(0) === 0xFEFF) content = content.slice(1);
    return JSON.parse(content);
  } catch {
    return null;
  }
}

function writeJson(path, data) {
  const dir = dirname(path);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(path, JSON.stringify(data, null, 2), 'utf-8');
}

function normalizeMode(mode) {
  if (!mode) return null;
  mode = mode.toLowerCase().trim();

  // Old server mode -> normal-paid
  if (mode === 'serve' || mode === 'server') return 'normal-paid';

  // Safe is a delivery (not a tier). Accept bare 'safe' or legacy 'normal-safe'/'web-safe'.
  if (mode === 'safe' || mode === 'normal-safe' || mode === 'web-safe') return 'safe';

  // Pi is a delivery with no tier (Phase 4 migration path).
  if (mode === 'pi') return 'pi';

  // Already in combined format
  if (mode.includes('-')) {
    const parts = mode.split('-');
    if (parts.length !== 2) return null;
    const [delivery, modelTier] = parts;
    if (DELIVERIES.some(d => d.id === delivery) && MODELS.some(m => m.id === modelTier)) {
      return mode;
    }
    return null;
  }

  // Old single-word mode IDs -> normal-{mode}
  if (MODELS.some(m => m.id === mode)) {
    return `normal-${mode}`;
  }

  return null;
}

function readPref() {
  // data/ store wins; adopt the legacy user/ file only when data/ is absent.
  return readJson(PrefFile) || readJson(LegacyPrefFile);
}

function getSavedMode() {
  const pref = readPref();
  if (pref && pref.last_mode) return normalizeMode(pref.last_mode);
  return null;
}

function saveMode(mode) {
  // Merge, never clobber: launch-pi.mjs stores last_pi_mode / pi_stack_mode
  // in the same file.
  const pref = readPref() || {};
  writeJson(PrefFile, { ...pref, last_mode: mode, saved_at: new Date().toISOString() });
}

const DELIVERIES = [
  { id: 'normal', name: 'Terminal (TUI)', desc: 'terminal interface' },
  { id: 'web', name: 'Web', desc: 'web server' },
  { id: 'pi', name: 'Pi', desc: 'Pi CLI (migrated — gitnexus + pi stack + tunnel)' },
  { id: 'safe', name: 'Safe', desc: 'minimal config for fixing broken setup' },
];

// Pi-only fork guard (Phase 4): OpenCode organs were stripped from this repo.
// Only offer OpenCode-based deliveries when the binary actually exists;
// otherwise Pi is the sole delivery and saved OpenCode prefs are ignored.
const isWin = process.platform === 'win32';
const OpenCodeAvailable = existsSync(join(ROOT_DIR, 'opencode', isWin ? 'opencode.exe' : 'opencode'));
const AVAILABLE_DELIVERIES = OpenCodeAvailable
  ? DELIVERIES
  : DELIVERIES.filter(d => d.id === 'pi');

const MODELS = [
  { id: 'paid', name: 'Paid', desc: 'recommended' },
  { id: 'free', name: 'Free', desc: 'all agents use free models only' },
  { id: 'local', name: 'Local', desc: 'all agents via LM Studio (local LLM)' },
];

const SCRIPT_MAP = {
  // Pi is the sole delivery in this fork (Phase 4 migration path).
  // OpenCode-era modes (normal-paid/free/local, web-*, safe) have no SCRIPT_MAP
  // entry and are redirected to Pi by the mode-validation block below.
  'pi': { script: 'launch-pi.mjs', args: [] },
};

function getModeLabel(combinedKey) {
  // Safe / Pi are deliveries with no tier — handle before splitting.
  if (combinedKey === 'safe' || combinedKey === 'pi') {
    const d = DELIVERIES.find(x => x.id === combinedKey);
    return d ? d.name : combinedKey;
  }
  const [deliveryId, modelId] = combinedKey.split('-');
  const delivery = DELIVERIES.find(d => d.id === deliveryId);
  const model = MODELS.find(m => m.id === modelId);
  if (!delivery || !model) return combinedKey;
  return `${delivery.name} + ${model.name}`;
}

async function showGlitchModeMenu(savedDeliveryId) {
  log(MAGENTA, '');
  log(MAGENTA, ' Glitch AI - Unified Launcher');
  log(MAGENTA, '');

  if (savedDeliveryId) {
    const saved = AVAILABLE_DELIVERIES.find(d => d.id === savedDeliveryId);
    if (saved) {
      log(CYAN, ` Last Glitch mode: ${saved.name}`);
      log(DARK_GRAY, ' Press Enter to keep it, or pick a different Glitch mode:');
      log('');
    }
  }

  AVAILABLE_DELIVERIES.forEach((delivery, i) => {
    const marker = delivery.id === savedDeliveryId ? ' *' : '';
    log(CYAN, `  [${i + 1}] ${delivery.name}${marker}`);
    log(DARK_GRAY, `       ${delivery.desc}`);
    log('');
  });

  const prompt = savedDeliveryId
    ? `Glitch mode (1-${AVAILABLE_DELIVERIES.length}, Enter for saved): `
    : `Glitch mode (1-${AVAILABLE_DELIVERIES.length}): `;

  while (true) {
    const selection = await askQuestion(prompt);
    const raw = selection.trim();
    if (raw === '' && savedDeliveryId) return savedDeliveryId;
    const num = parseInt(raw, 10);
    if (!isNaN(num) && num >= 1 && num <= AVAILABLE_DELIVERIES.length) {
      return AVAILABLE_DELIVERIES[num - 1].id;
    }
    log(RED, `  Invalid selection. Please enter a number 1-${AVAILABLE_DELIVERIES.length}${savedDeliveryId ? ' or press Enter to keep the saved mode' : ''}.`);
  }
}

async function showModelMenu(savedModelId) {
  log(MAGENTA, '');
  log(MAGENTA, ' Select Model Tier');
  log(MAGENTA, '');

  if (savedModelId) {
    const saved = MODELS.find(m => m.id === savedModelId);
    if (saved) {
      log(CYAN, ` Last model: ${saved.name}${saved.id === 'paid' ? ' (recommended)' : ''}`);
      log(DARK_GRAY, ' Press Enter to keep it, or pick a different model:');
      log('');
    }
  }

  MODELS.forEach((model, i) => {
    const marker = model.id === savedModelId ? ' *' : '';
    const rec = model.id === 'paid' ? ' (recommended)' : '';
    log(GREEN, `  [${i + 1}] ${model.name}${rec}${marker}`);
    log(DARK_GRAY, `       ${model.desc}`);
    log('');
  });

  const prompt = savedModelId
    ? `Model tier (1-${MODELS.length}, Enter for saved): `
    : `Model tier (1-${MODELS.length}): `;

  while (true) {
    const selection = await askQuestion(prompt);
    const raw = selection.trim();
    if (raw === '' && savedModelId) return savedModelId;
    const num = parseInt(raw, 10);
    if (!isNaN(num) && num >= 1 && num <= MODELS.length) {
      return MODELS[num - 1].id;
    }
    log(RED, `  Invalid selection. Please enter a number 1-${MODELS.length}${savedModelId ? ' or press Enter to keep the saved model' : ''}.`);
  }
}

function runScript(scriptName, extraArgs = []) {
  const scriptPath = join(SCRIPT_DIR, scriptName);
  if (!existsSync(scriptPath)) {
    log(RED, `  ERROR: Script not found: ${scriptPath}`);
    process.exit(1);
  }

  const argStr = extraArgs.length ? ` ${extraArgs.join(' ')}` : '';
  log(CYAN, `  Starting ${scriptName}${argStr}...`);
  log('');

  try {
    execFileSync('node', [scriptPath, ...extraArgs], {
      cwd: ROOT_DIR,
      stdio: 'inherit',
      timeout: 0,
      env: process.env
    });
    return { success: true, status: 0 };
  } catch (e) {
    if (e.status !== null) {
      log(RED, `  Script exited with code ${e.status}`);
      logToFile(`Script exited with code ${e.status}`);
    } else {
      log(RED, `  Script error: ${e.message || e}`);
      logToFile(`ERROR: ${e.message || e}`);
    }
    return { success: false, error: e };
  }
}

async function main() {
  // ---- Help: before anything interactive (branch prompt, menus) ----
  const args = process.argv.slice(2);
  if (args.includes('--help') || args.includes('-h')) {
    console.log(`
  Glitch AI - Unified Launcher

  Usage: node scripts/launch-unified.mjs [options]

  Options:
    --help, -h       Show this help
    --mode <key>     Skip menu, launch specific mode directly
                     Pi mode (this fork): pi                (sole delivery)
                     OpenCode-era keys (normal-*, web-*, safe) are accepted
                     for backward compatibility and redirect to Pi.
    --reset          Clear saved preference and show menu
    --reuse-saved    Restart mode: skip ALL prompts (branch, update, menu).
                     Triggered automatically when stdin is not a TTY, or when
                     env GLITCH_REUSE_SAVED=1 is set. Also skips dependency
                     updates so a restart never applies updates on its own.
    --skip-updates   Skip dependency updates (npm + binaries) this run.
                     Equivalent to env GLITCH_SKIP_UPDATES=1. Wins over
                     --apply-updates when both are passed, matching
                     scripts/restart-pi-stack.ps1 where -SkipUpdates
                     overrides -ApplyUpdates. A true no-op: no import,
                     no network, no status-file write.
    --apply-updates  Apply ALL available dependency updates without prompting.
                     Equivalent to env GLITCH_APPLY_UPDATES=1. Mutually
                     exclusive with --reuse-saved in spirit (--reuse-saved
                     wins); meant for an explicit "update then relaunch".
                     Ignored when --skip-updates is also passed.

  The launcher remembers your last choice. Next time, just press Enter.
    `);
    process.exit(0);
  }

  // Reuse-saved gate: restarts and automation must never hang on a prompt
  // (the branch menu, the update prompt, and every launcher menu). Triggered
  // by --reuse-saved, env GLITCH_REUSE_SAVED=1, or a non-TTY stdin (detached
  // runs). Saved selections win; an explicit choice anywhere still persists.
  const REUSE_SAVED = args.includes('--reuse-saved') || process.env.GLITCH_REUSE_SAVED === '1' || !process.stdin.isTTY;

  // ---- Branch check + repo updates: interactive only ------------------------
  // Under reuse-saved, never prompt for a branch switch, a repo update, or a
  // dependency update mid-restart. The point is relaunching exactly what the
  // user last selected; a restart must never apply updates on its own. An
  // explicit restart with updates is handled by scripts/restart-pi-stack.ps1
  // -ApplyUpdates, which runs the checker BEFORE the kill (see that script).
  if (REUSE_SAVED) {
    log(DARK_GRAY, '  (reuse-saved: branch, repo-update, and dependency-update prompts skipped)');
  } else {
    // ---- Branch check: FIRST thing, before repo updates ----
    await checkBranchBeforeLaunch();

    // ---- Check for repo updates before anything else ----
    const branchOkSet = process.env.GLITCH_BRANCH_OK !== undefined && process.env.GLITCH_BRANCH_OK !== '';
    const syncResult = await checkRepoUpdates({ cwd: ROOT_DIR, interactive: true, allowBranchSwitch: !branchOkSet });
    handleRestartOnUpdate(spawn, syncResult, ROOT_DIR);
  }

  // ---- Dependency updates (npm + standalone binaries) ----------------------
  // Only runs on the non-REUSE_SAVED path. The earlier `if (REUSE_SAVED)`
  // branch logs a skip note and falls through; it does not return. The
  // operative gate is the `if (!REUSE_SAVED)` check immediately below.
  // Every call is dynamic import + try/catch so a missing or broken
  // checker (the other coder owns scripts/check-updates.mjs) never blocks
  // startup. Headless runs (no TTY) are covered by the REUSE_SAVED gate
  // above, which sets REUSE_SAVED=true on every non-TTY stdin; this block
  // therefore only ever runs with a TTY attached, by design. Skip wins
  // over Apply when both are passed, to match
  // scripts/restart-pi-stack.ps1 where -SkipUpdates overrides
  // -ApplyUpdates.
  if (!REUSE_SAVED) {
    const skipUpdates = args.includes('--skip-updates') || process.env.GLITCH_SKIP_UPDATES === '1';
    const applyUpdates = !skipUpdates && (args.includes('--apply-updates') || process.env.GLITCH_APPLY_UPDATES === '1');
    const checkerPath = join(SCRIPT_DIR, 'check-updates.mjs');

    if (skipUpdates) {
      // --skip-updates / GLITCH_SKIP_UPDATES=1 is a real no-op: no import,
      // no network, no status-file write. Matches scripts/restart-pi-stack.ps1
      // where -SkipUpdates overrides -ApplyUpdates.
      log(DARK_GRAY, '  (updates: skipped via --skip-updates / GLITCH_SKIP_UPDATES)');
    } else if (!existsSync(checkerPath)) {
      // Module not present yet (the other coder owns it). Brief note on
      // interactive runs so the user knows updates were skipped on purpose.
      if (process.stdin.isTTY) {
        log(DARK_GRAY, '  (dependency updates: checker not present, skipping)');
      }
    } else {
      // The dynamic import runs only on the apply or interactive branches;
      // skip stays a true no-op above. Both branches funnel through the
      // same try/catch so a missing or broken checker never blocks startup.
      try {
        const checker = await import('./check-updates.mjs');
        if (applyUpdates) {
          log(DARK_GRAY, '  (updates: applying all without prompt)');
          await checker.checkAndPromptUpdates({ cwd: ROOT_DIR, interactive: false, autoApplyAll: true });
        } else {
          // Interactive TTY: prompt the user.
          await checker.checkAndPromptUpdates({ cwd: ROOT_DIR, interactive: true, autoApplyAll: false });
        }
      } catch (e) {
        log(DARK_YELLOW, `  (dependency-update check failed: ${e && e.message ? e.message : 'unknown error'} - continuing)`);
      }
    }

    // ---- Gap G3: sync the user/ memory repo on launch ---------------------
    // The user/ repo is where main-memory.md and the diary live; if it is a
    // git repo with an upstream, we want it pulled on the same path as the
    // main repo so cross-machine memory stays fresh. Skipped under REUSE_SAVED
    // (the parent branch already returns above). Non-fatal: a broken memory
    // sync must never block startup.
    try {
      await checkUserRepoUpdates({ cwd: join(ROOT_DIR, 'user'), interactive: true });
    } catch (e) {
      log(DARK_YELLOW, `  (user/ repo sync failed: ${e && e.message ? e.message : 'unknown error'} - continuing)`);
    }
  }

  const restartFlagPath = join(ROOT_DIR, 'data', '.restart-timestamp');
  // Clean up restart flag after successful launch (5 second delay to ensure we're past the critical startup phase)
  const cleanupTimer = setTimeout(() => {
    try {
      if (existsSync(restartFlagPath)) {
        unlinkSync(restartFlagPath);
      }
    } catch {
      // Best-effort cleanup
    }
  }, 5000);

  // Clear timer if process exits before timer fires
  process.on('exit', () => {
    clearTimeout(cleanupTimer);
  });

  // ---- Check for install issues (submodule failures, etc.) ----
  const issuesFile = join(ROOT_DIR, 'data', 'install-issues.md');
  if (existsSync(issuesFile)) {
    log(YELLOW, '  Install issues detected — attempting auto-fix...');
    try {
      const result = execFileSync('node', [join(SCRIPT_DIR, 'check-install-issues.mjs'), '--fix'], {
        cwd: ROOT_DIR,
        encoding: 'utf-8',
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout: 120000,
      });
      const parsed = JSON.parse(result.trim());
      if (parsed.status === 'fixed') {
        log(GREEN, '  All install issues resolved!');
      } else if (parsed.status === 'partial') {
        log(YELLOW, `  ${parsed.remainingIssues.length} issue(s) could not be auto-fixed.`);
        log(YELLOW, '  Ask Glitch to "check install issues" for help resolving them.');
      } else {
        log(GREEN, '  No install issues found.');
      }
      log('');
    } catch (e) {
      log(YELLOW, '  Could not run install issues check. Ask Glitch to "check install issues".');
      log('');
    }
  }

  // ---- Check if user profile needs GitHub sync setup ----
  const userDir = join(ROOT_DIR, 'user');
  const userGitDir = join(userDir, '.git');
  const userMainMem = join(userDir, 'main-memory.md');

  if (existsSync(userMainMem) && !existsSync(userGitDir)) {
    // user/ has no own .git — check if it's tracked by the parent repo
    let trackedByParent = false;
    try {
      const output = execSync('git ls-files user', { cwd: ROOT_DIR, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
      trackedByParent = output.trim().length > 0;
    } catch {
      trackedByParent = false;
    }

    if (!trackedByParent) {
      // User profile exists but is not a git repo - offer to set up sync
      log(YELLOW, '  User profile is local-only (not synced to GitHub).');
      log(YELLOW, '  To enable cross-machine sync, run:');
      log(DARK_GRAY, '    cd user && git init && git remote add origin <your-repo-url> && git push');
      log('');
    }
  }

  // ---- Check if user profile needs GitHub sync setup ----

  if (args.includes('--reset')) {
    if (existsSync(PrefFile)) {
      unlinkSync(PrefFile);
      log(GREEN, '  Saved mode preference cleared.');
    }
  }

  let modeId = null;
  const modeIdx = args.indexOf('--mode');
  if (modeIdx !== -1 && modeIdx < args.length - 1) {
    modeId = normalizeMode(args[modeIdx + 1]);
  }

  // Explicit --mode guard: OpenCode-based modes need the opencode binary
  // (otherwise launch.mjs bootstraps a fresh OpenCode download). Redirect to Pi.
  if (modeId && modeId !== 'pi' && !OpenCodeAvailable) {
    log(YELLOW, `  OpenCode not present in this fork — redirecting '${modeId}' to Pi.`);
    modeId = 'pi';
  }

  if (!modeId) {
    // Parse saved preference into delivery + model parts
    const savedMode = getSavedMode();
    let savedDelivery = null;
    let savedModel = null;
    if (savedMode) {
      // Safe is a single-word delivery (no tier) — handle before splitting.
      if (savedMode === 'safe' || savedMode === 'pi') {
        savedDelivery = savedMode;
        savedModel = null;
      } else {
        const parts = savedMode.split('-');
        if (parts.length === 2) {
          savedDelivery = parts[0];
          savedModel = parts[1];
        }
      }
    }

    // Ignore saved modes pointing at stripped deliveries (OpenCode archived
    // in this fork) so a stale pref can't dead-end the launcher into a
    // bootstrap download.
    if (savedDelivery && !AVAILABLE_DELIVERIES.some(d => d.id === savedDelivery)) {
      log(DARK_YELLOW, `  Saved mode '${savedMode}' unavailable (OpenCode not present) — defaulting to Pi.`);
      savedDelivery = null;
    }

    // Reuse-saved never opens the menus: the saved delivery wins, else the
    // first available delivery (Pi, on this fork). Interactive behavior is
    // unchanged outside the gate.
    const deliveryId = REUSE_SAVED
      ? (savedDelivery || AVAILABLE_DELIVERIES[0].id)
      : (AVAILABLE_DELIVERIES.length === 1
          ? AVAILABLE_DELIVERIES[0].id
          : await showGlitchModeMenu(savedDelivery));

    // Safe / Pi are deliveries with no tier — skip the model menu entirely.
    if (deliveryId === 'safe' || deliveryId === 'pi') {
      modeId = deliveryId;
    } else {
      // Level 2: Model tier (use saved model only if delivery didn't change)
      const modelDefault = deliveryId === savedDelivery ? savedModel : null;
      const modelId = REUSE_SAVED ? (modelDefault || MODELS[0].id) : await showModelMenu(modelDefault);
      modeId = `${deliveryId}-${modelId}`;
    }
  }

  if (!modeId) {
    log(RED, ' No mode selected. Exiting.');
    logToFile('ERROR: No mode selected');
    process.exit(1);
  }

  let config = SCRIPT_MAP[modeId];
  if (!config) {
    // OpenCode-era modes (normal-*, web-*, safe) reach this block in the
    // Pi-only fork — normalizeMode validated the key but SCRIPT_MAP only
    // carries Pi. Redirect to Pi with a clear log line instead of erroring.
    log(YELLOW, `  OpenCode-era mode '${modeId}' is gone in this fork — launching Pi.`);
    logToFile(`OpenCode-era mode '${modeId}' redirected to Pi`);
    modeId = 'pi';
    config = SCRIPT_MAP[modeId];
    if (!config) {
      // Truly invalid key (should be unreachable: normalizeMode returns null
      // for unrecognized input, caught by the !modeId guard above).
      log(RED, ` Unknown mode: ${modeId}`);
      logToFile(`ERROR: Unknown mode: ${modeId}`);
      process.exit(1);
    }
  }

  // Persist explicit choices only; a reused selection is never re-saved
  // (matches launch-pi's "automation never clobbers a real pick" contract).
  if (!REUSE_SAVED) saveMode(modeId);
  logToFile(`Mode selected: ${modeId}`);
  log(GREEN, ` Launching ${getModeLabel(modeId)}...`);
  logToFile(`Launching ${getModeLabel(modeId)}`);
  log('');

  // GitNexus index sync: spawned once by launch-pi.mjs (single spawn per
  // launch — this file used to spawn a second, duplicate sync before every
  // launch-pi run).

  const result = runScript(config.script, config.args);
  if (!result.success) {
    process.exit(result.error?.status || 1);
  }
}

main().catch(e => {
  log(RED, ` Fatal error: ${e.message || e}`);
  logToFile(`ERROR: ${e.message || e}`);
  process.exit(1);
});
