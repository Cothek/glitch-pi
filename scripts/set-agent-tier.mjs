#!/usr/bin/env node

import { readFileSync, existsSync, writeFileSync, mkdirSync } from 'fs';
import { join, dirname, resolve } from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const ROOT_DIR = resolve(__dirname, '..');

const DataDir = join(ROOT_DIR, 'data');
const TierFile = join(DataDir, 'agent-tier.json');

const VALID_TIERS = ['free', 'paid'];
const DEFAULT_TIER = 'free';

const RESET = '\x1b[0m', CYAN = '\x1b[36m', GREEN = '\x1b[32m', YELLOW = '\x1b[33m', RED = '\x1b[31m', DARK_GRAY = '\x1b[90m', WHITE = '\x1b[37m', BOLD = '\x1b[1m';
function log(color, msg) { if (msg === undefined) console.log(color); else console.log(color + msg + RESET); }
function readJson(path) { try { let c = readFileSync(path, 'utf-8'); if (c.charCodeAt(0) === 0xFEFF) c = c.slice(1); return JSON.parse(c); } catch { return null; } }

function getCurrentTier() {
  const fileExists = existsSync(TierFile);
  if (!fileExists) return { tier: DEFAULT_TIER, isDefault: true, fileExists: false };
  const data = readJson(TierFile);
  if (!data || !data.tier) return { tier: DEFAULT_TIER, isDefault: true, fileExists: true };
  return { tier: data.tier, isDefault: false, fileExists: true };
}

function writeTier(tier) {
  if (!existsSync(DataDir)) mkdirSync(DataDir, { recursive: true });
  const content = JSON.stringify({ tier }, null, 2) + '\n';
  writeFileSync(TierFile, content, 'utf-8');
}

function showUsage() {
  log(CYAN, '\n  Agent Tier Switcher\n');
  log(CYAN, '  Usage:');
  log(WHITE, '    node scripts/set-agent-tier.mjs free');
  log(WHITE, '    node scripts/set-agent-tier.mjs paid');
  log(WHITE, '    node scripts/set-agent-tier.mjs --status');
  log('');
  log(DARK_GRAY, '  Arguments:');
  log(DARK_GRAY, '    free              Set agent tier to free (free models only)');
  log(DARK_GRAY, '    paid              Set agent tier to paid (paid fallbacks enabled)');
  log(DARK_GRAY, '    --status, -s      Show current agent tier');
  log(DARK_GRAY, '    status            Alias for --status');
  log('');
}

function main() {
  const args = process.argv.slice(2);

  if (args.length === 0) {
    showUsage();
    process.exit(0);
  }

  const arg = args[0].toLowerCase();

  if (arg === '--status' || arg === '-s' || arg === 'status') {
    const { tier, isDefault, fileExists } = getCurrentTier();
    if (isDefault && fileExists) {
      log(YELLOW, '  Agent tier: ' + tier + ' (default, file corrupt)');
      process.stderr.write(YELLOW + '  Warning: data/agent-tier.json exists but is unreadable or invalid — treating as free.' + RESET + '\n');
    } else if (isDefault) {
      log(GREEN, '  Agent tier: ' + tier + ' (default)');
    } else {
      log(GREEN, '  Agent tier: ' + tier);
    }
    process.exit(0);
  }

  if (!VALID_TIERS.includes(arg)) {
    process.stderr.write(RED + '  Invalid tier: ' + arg + RESET + '\n');
    process.stderr.write(YELLOW + '  Valid tiers: ' + VALID_TIERS.join(', ') + RESET + '\n');
    process.exit(1);
  }

  try {
    writeTier(arg);
    log(GREEN, '  Agent tier set to: ' + BOLD + arg + RESET);
    process.exit(0);
  } catch (e) {
    process.stderr.write(RED + '  Failed to write tier file: ' + e.message + RESET + '\n');
    process.exit(1);
  }
}

main().catch((e) => {
  log(RED, '  Fatal error: ' + (e.message || e));
  process.exit(1);
});
