#!/usr/bin/env node
// switch-agent.mjs — switch the primary agent mode (glitch | glitch-omni | glitch-lightweight).
//
// Records the mode in user/agent-mode.json, which routing.ts reads to decide gate
// behavior. That file is gitignored, so switching never dirties the repo.
//
// .pi/SYSTEM.md is deliberately NOT staged here anymore. The mode is carried by
// user/agent-mode.json plus the extension's session entries; the live
// /agent path (agent-switcher.ts) installs the profile via before_agent_start
// on every turn, so no file copy is needed.
//
// MID-SESSION SWITCHING: use the /agent extension (agent-switcher.ts) inside
// a live Pi session instead — no restart needed. This script remains the
// offline/fallback path.
//
// Usage: node scripts/switch-agent.mjs <glitch|glitch-omni|glitch-lightweight> [--status]

import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import { join, dirname, resolve } from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const ROOT_DIR = resolve(__dirname, '..');

const PROFILES_DIR = join(ROOT_DIR, '.pi', 'agent-profiles');
const MODE_FILE = join(ROOT_DIR, 'user', 'agent-mode.json');

const MODES = [
  { id: 'glitch', file: 'glitch.md', desc: 'Full Glitch — dispatch-first workflow, sub-agent delegation, complete rules system' },
  { id: 'glitch-omni', file: 'glitch-omni.md', desc: 'Direct execution — no dispatching, self-fulfilled memory, full tool access' },
  { id: 'glitch-lightweight', file: 'glitch-lightweight.md', desc: 'Trimmed rules — identity + honesty core, minimal payload' },
];

const CYAN = '\x1b[36m';
const GREEN = '\x1b[32m';
const RED = '\x1b[31m';
const YELLOW = '\x1b[33m';
const DARK_GRAY = '\x1b[90m';
const RESET = '\x1b[0m';

function log(color, msg) {
  console.log(`${color}${msg}${RESET}`);
}

function readJson(path) {
  try {
    let content = readFileSync(path, 'utf-8');
    // PowerShell Set-Content writes a UTF-8 BOM — strip it before parsing.
    if (content.charCodeAt(0) === 0xfeff) content = content.slice(1);
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

function currentMode() {
  const marker = readJson(MODE_FILE);
  return marker && marker.mode ? marker.mode : 'glitch';
}

function showStatus() {
  const current = currentMode();
  log(CYAN, '');
  log(CYAN, ' Glitch agent modes');
  log(CYAN, '');
  for (const mode of MODES) {
    const marker = mode.id === current ? ' *  (active)' : '';
    const exists = existsSync(join(PROFILES_DIR, mode.file));
    const avail = exists ? '' : '  [profile not authored yet]';
    log(CYAN, `  ${mode.id}${marker}${avail}`);
    log(DARK_GRAY, `      ${mode.desc}`);
  }
  log(DARK_GRAY, '');
  log(DARK_GRAY, '  Switch: node scripts/switch-agent.mjs <mode>');
  log(DARK_GRAY, '  Mid-session: /agent <mode> (no restart — see agent-switcher.ts).');
  log(DARK_GRAY, '  Restart Pi to apply (system prompt is fixed per session).');
  log('');
}

function switchMode(modeId) {
  const mode = MODES.find(m => m.id === modeId);
  if (!mode) {
    log(RED, `Unknown mode: ${modeId}`);
    log(YELLOW, `Valid modes: ${MODES.map(m => m.id).join(', ')}`);
    process.exit(1);
  }

  const profilePath = join(PROFILES_DIR, mode.file);
  if (!existsSync(profilePath)) {
    log(RED, `Profile not found: ${profilePath}`);
    log(YELLOW, `Ask Glitch to author "${mode.file}" first.`);
    process.exit(1);
  }

  // Record the mode for routing.ts gate behavior.
  const prev = currentMode();
  writeJson(MODE_FILE, {
    mode: mode.id,
    previous_mode: prev,
    switched_at: new Date().toISOString(),
  });

  log(GREEN, `Switched primary agent mode: ${prev} -> ${mode.id}`);
  log(YELLOW, 'Restart Pi (or re-run launch-glitch.bat) to apply — or use /agent inside a live session.');
  log('');
}

const args = process.argv.slice(2);
if (args.includes('--status') || args.length === 0) {
  showStatus();
  process.exit(0);
}

switchMode(args[0].toLowerCase().trim());
