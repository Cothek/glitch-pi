#!/usr/bin/env node
/**
 * One-shot quarantine cleanup — 2026-09-01
 *
 * Moves known junk files to data/quarantine/2026-09-01/ and appends
 * entries to data/quarantine-manifest.json under a "quarantine" key.
 *
 * Usage:
 *   node scripts/one-shot-quarantine.mjs          # dry-run (default)
 *   node scripts/one-shot-quarantine.mjs --apply   # actually move files
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, statSync, unlinkSync, renameSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const ROOT_DIR = join(__dirname, '..');

const args = process.argv.slice(2);
const isApply = args.includes('--apply');

const QUARANTINE_DIR = join(ROOT_DIR, 'data', 'quarantine', '2026-09-01');
const MANIFEST_PATH = join(ROOT_DIR, 'data', 'quarantine-manifest.json');
const NOW = new Date().toISOString();

// ── Files to quarantine ────────────────────────────────────────────────────

// Root dir junk
const ROOT_FILES = [
  'check-db.js',
  'check-db2.js',
  'check-liveness.js',
  'check-providers.js',
  'fix.js',
  'test-stuck.cjs',
  'README.html',
  'query',
];

// data/ junk — memory trigger flags (dynamically discovered)
function getDataTriggerFlags() {
  const dataDir = join(ROOT_DIR, 'data');
  try {
    return readdirSync(dataDir).filter(f => f.startsWith('MEMORY_TRIGGER_FLAG.'));
  } catch {
    return [];
  }
}

// data/ junk — verify scripts and logs
const DATA_VERIFY = [
  'verify-nvidia-fix.ps1',
  'verify-nvidia-fix.log',
  'verify-nvidia-fix-run.err',
  'verify-nvidia-fix-run.out',
  'verify-nvidia-fix2.ps1',
  'verify-nvidia-fix2.log',
  'verify-nvidia-fix2-run.err',
  'verify-nvidia-fix2-run.out',
  'verify-nvidia-fix3.ps1',
  'verify-nvidia-fix3.log',
  'verify-nvidia-fix3-run.err',
  'verify-nvidia-fix3-run.out',
  'verify-refresh-async.log',
  'verify-refresh-async.mjs',
  'verify-remove-popup.mjs',
];

// data/ junk — test files
const DATA_TEST = [
  'test-normal-stderr.log',
  'test-normal-stdout.log',
  'test-safe-stderr.log',
  'test-safe-stdout.log',
  'test-web-stderr.log',
  'test-web-stdout.log',
  'test-stderr.log',
  'test-stdout.log',
  'test-node.mjs',
  'test-spawn.mjs',
  'test-spawn2.mjs',
  'test-window.ps1',
  'test-orig.pid',
  'test-orig.ps1',
  'test.txt',
];

const DATA_TEST_DIRS = ['test-copy-overwrite'];

// data/ junk — cf-test logs
const DATA_CF = [
  'cf-test-a2-err.log',
  'cf-test-a2-out.log',
  'cf-test-b-err.log',
  'cf-test-b-out.log',
];

// data/ junk — misc
const DATA_MISC = [
  'append-shopping.js',
  'money-page-direct.png',
  'money-page-tunnel.png',
  'money-page.html',
  'money-public-page.html',
  'money-public-shot.log',
  'money-public-shot.png',
  'money-redirect-test.log',
  'money-visual-test.log',
  'money-auth-flow.log',
  'money-server-stderr.txt',
  'money-server-stdout.txt',
  'money-tunnel-public.log',
  'audit-data-state.json',
  'audit-root-state.json',
];

// ── Helpers ────────────────────────────────────────────────────────────────

function formatBytes(bytes) {
  if (bytes === 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  return (bytes / Math.pow(1024, i)).toFixed(2) + ' ' + units[i];
}

function getEntry(relPath, reason) {
  try {
    const st = statSync(join(ROOT_DIR, relPath));
    return {
      path: relPath,
      quarantinedAt: NOW,
      reason,
      size: st.size,
      mtime: st.mtime.toISOString(),
    };
  } catch {
    return { path: relPath, quarantinedAt: NOW, reason, size: 0, mtime: null };
  }
}

function moveToQuarantine(relPath) {
  const src = join(ROOT_DIR, relPath);
  const dest = join(QUARANTINE_DIR, relPath);
  const destDir = dirname(dest);
  if (!existsSync(destDir)) mkdirSync(destDir, { recursive: true });
  if (existsSync(dest)) unlinkSync(dest);
  renameSync(src, dest);
}

// ── Main ───────────────────────────────────────────────────────────────────

function main() {
  // Refuse to re-run if quarantine dir already exists and is non-empty
  if (existsSync(QUARANTINE_DIR) && readdirSync(QUARANTINE_DIR).length > 0) {
    console.error('Quarantine for this date already exists — refusing to re-run. Delete the dir or edit the date to re-run.');
    process.exit(1);
  }

  const entries = [];
  let skipped = 0;
  let totalBytes = 0;

  console.log('── One-Shot Quarantine Cleanup (2026-09-01) ──');
  console.log(`  Mode: ${isApply ? 'APPLY (moving files)' : 'DRY-RUN (no changes)'}`);
  console.log('');

  // Collect all files to quarantine
  const allFiles = [];

  for (const f of ROOT_FILES) {
    allFiles.push({ rel: f, reason: 'root debug script / junk' });
  }

  for (const f of getDataTriggerFlags()) {
    allFiles.push({ rel: join('data', f), reason: 'stale memory trigger flag' });
  }

  for (const f of DATA_VERIFY) {
    allFiles.push({ rel: join('data', f), reason: 'one-shot verify script/log' });
  }

  for (const f of DATA_TEST) {
    allFiles.push({ rel: join('data', f), reason: 'one-shot test artifact' });
  }

  for (const d of DATA_TEST_DIRS) {
    allFiles.push({ rel: join('data', d), reason: 'one-shot test directory' });
  }

  for (const f of DATA_CF) {
    allFiles.push({ rel: join('data', f), reason: 'one-shot cf-test log' });
  }

  for (const f of DATA_MISC) {
    allFiles.push({ rel: join('data', f), reason: 'one-shot debug artifact' });
  }

  // Also clear data/tmp and data/temp contents (keep dirs)
  const clearDirs = ['data/tmp', 'data/temp'];
  for (const d of clearDirs) {
    const dirPath = join(ROOT_DIR, d);
    if (!existsSync(dirPath)) continue;
    try {
      const items = readdirSync(dirPath);
      for (const item of items) {
        allFiles.push({ rel: join(d, item), reason: `clear ${d} contents` });
      }
    } catch {
      // skip
    }
  }

  // Process each file
  for (const { rel, reason } of allFiles) {
    const full = join(ROOT_DIR, rel);
    if (!existsSync(full)) {
      skipped++;
      continue;
    }

    const entry = getEntry(rel, reason);
    entries.push(entry);
    totalBytes += entry.size;

    if (isApply) {
      try {
        moveToQuarantine(rel);
      } catch (e) {
        console.error(`  FAILED to move ${rel}: ${e.message}`);
      }
    }
  }

  console.log(`  Files found:    ${entries.length}`);
  console.log(`  Already gone:   ${skipped}`);
  console.log(`  Total size:     ${formatBytes(totalBytes)}`);
  console.log(`  ${isApply ? 'Files moved' : 'Would move'}:    ${entries.length - skipped}`);
  console.log('');

  // Update manifest
  if (isApply && entries.length > 0) {
    let manifest = {};
    try {
      const raw = readFileSync(MANIFEST_PATH, 'utf-8');
      manifest = JSON.parse(raw);
    } catch {
      // New or corrupted — start fresh
    }

    if (!manifest.quarantine) manifest.quarantine = [];
    manifest.quarantine.push(...entries);

    writeFileSync(MANIFEST_PATH, JSON.stringify(manifest, null, 2), 'utf-8');
    console.log(`  Manifest updated: ${MANIFEST_PATH}`);
    console.log(`  Quarantine entries: ${manifest.quarantine.length}`);
  }

  console.log('');
  console.log('  Done.');
}

main();
