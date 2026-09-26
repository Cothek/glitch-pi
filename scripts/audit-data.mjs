#!/usr/bin/env node

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import readline from 'node:readline';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = path.resolve(__dirname, '..');
const DATA_DIR = path.join(ROOT_DIR, 'data');
const BACKUPS_DIR = path.join(DATA_DIR, 'backups');
const MANIFEST_FILE = path.join(DATA_DIR, 'quarantine-manifest.json');
const LOG_FILE = path.join(DATA_DIR, 'cleanup-log.jsonl');

const GRACE_DAYS = { 'auto-flag': 3, 'maybe-flag': 14 };

const PROTECTED_NAMES = new Set([
  'secrets.json',
  'node', 'node.old', 'bin', 'gh-cli', 'tools', 'downloads',
  'screenshots', 'mulahazah', 'temp', 'tmp',
  'audit-data-state.json', 'audit-root-state.json',
  '.review-pass.json', '.stuck-signal.json',
  'quarantine-manifest.json', 'cleanup-log.jsonl',
  'license',
].map(n => n.toLowerCase()));

const PROTECTED_EXTS = new Set(['.pid']);

const KNOWN_MANIFEST = new Set([
  'backups',
  'free-models.json',
  'model-assignment.json',
  'model-resolver-preference.json',
  'model-update-status.json',
  'nvidia-free-cache.json',
  'nvidia-free-watchlist-cache.json',
  'opencode.pid',
  'restart-kill.log',
  'review-install-ps1-submodule-fix.log',
  'skills-lock.json',
  'update-status.json',
  'auth-proxy.log',
  'auth-proxy-err.log',
  'memory-dispatch-err.log',
  'memory-dispatch-out.log',
  'bootstrap.log',
  'launch.log',
  'server-debug.log',
  'vision-dispatch-log.txt',
  // NOTE: plugins.json, model-assignments.json, and model-registry.json were
  // moved out of data/ in the layered-config refactor (plugins.json and
  // model-assignments.json now live in user/; model-registry.json in config/).
  // Legacy copies in data/ from older installs are no longer protected here —
  // they will be flagged for cleanup if they remain. This is intentional: the
  // new locations are the source of truth.
].map(n => n.toLowerCase()));

const AUTO_FLAG_EXTS = new Set(['.bak', '.tmp', '.old']);

function humanSize(bytes) {
  if (!bytes || bytes === 0) return '0 B';
  const u = ['B', 'KB', 'MB', 'GB'];
  const i = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), u.length - 1);
  const v = bytes / Math.pow(1024, i);
  return `${i === 0 ? v : v.toFixed(1)} ${u[i]}`;
}

function formatDate(d) {
  const p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

function daysSince(isoStr) {
  return Math.floor((Date.now() - new Date(isoStr).getTime()) / 86400000);
}

async function loadManifest() {
  try {
    const raw = await fs.readFile(MANIFEST_FILE, 'utf8');
    return JSON.parse(raw);
  } catch (e) {
    if (e.code === 'ENOENT') return {};
    throw e;
  }
}

async function saveManifest(manifest) {
  await fs.mkdir(path.dirname(MANIFEST_FILE), { recursive: true });
  const tmp = MANIFEST_FILE + '.tmp';
  try { await fs.unlink(tmp); } catch (e) { if (e.code !== 'ENOENT') throw e; }
  await fs.writeFile(tmp, JSON.stringify(manifest, null, 2) + '\n', 'utf8');
  await fs.rename(tmp, MANIFEST_FILE);
}

async function appendLog(entry) {
  await fs.mkdir(path.dirname(LOG_FILE), { recursive: true });
  await fs.appendFile(LOG_FILE, JSON.stringify(entry) + '\n', 'utf8');
}

function isProtected(name, isDir) {
  const lowerName = name.toLowerCase();
  if (PROTECTED_NAMES.has(lowerName)) return true;
  if (isDir) return false;
  const ext = path.extname(name).toLowerCase();
  if (PROTECTED_EXTS.has(ext)) return true;
  if (KNOWN_MANIFEST.has(lowerName)) return true;
  return false;
}

function categorize(name, isDir, size, relPath) {
  if (isDir) {
    return 'auto-flag';
  }
  if (size === 0) return 'auto-flag';
  if (name.startsWith('test-')) return 'auto-flag';
  const ext = path.extname(name).toLowerCase();
  if (AUTO_FLAG_EXTS.has(ext)) return 'auto-flag';
  if (relPath.startsWith('test-copy-overwrite/')) return 'auto-flag';
  return 'maybe-flag';
}

function isLogPattern(name) {
  const ext = path.extname(name).toLowerCase();
  if (['.log', '.err', '.out'].includes(ext)) return true;
  const logExact = new Set([
    'vision-dispatch-log.txt', 'bootstrap.log', 'launch.log', 'server-debug.log',
    'restart-kill.log', 'review-install-ps1-submodule-fix.log',
    'memory-dispatch-err.log', 'memory-dispatch-out.log',
    'auth-proxy.log', 'auth-proxy-err.log',
  ].map(n => n.toLowerCase()));
  return logExact.has(name.toLowerCase());
}

async function scanDataDir() {
  const candidates = [];

  let entries;
  try {
    entries = await fs.readdir(DATA_DIR, { withFileTypes: true });
  } catch (e) {
    if (e.code === 'ENOENT') return { candidates: [], missing: true };
    throw e;
  }

  for (const entry of entries) {
    const name = entry.name;
    const fullPath = path.join(DATA_DIR, name);
    let st;
    try {
      st = await fs.stat(fullPath);
    } catch {
      continue;
    }

    const isDir = st.isDirectory();

    if (isProtected(name, isDir)) continue;

    if (isDir) {
      if (name.toLowerCase() === 'backups') {
        let backupEntries;
        try {
          backupEntries = await fs.readdir(BACKUPS_DIR, { withFileTypes: true });
        } catch {
          continue;
        }
        for (const bEntry of backupEntries) {
          if (bEntry.name.toLowerCase() === '.last-mode') continue;
          const bPath = path.join(BACKUPS_DIR, bEntry.name);
          let bStat;
          try {
            bStat = await fs.stat(bPath);
          } catch {
            continue;
          }
          if (!bStat.isFile()) continue;
          const relPath = path.join('backups', bEntry.name).replace(/\\/g, '/');
          const cat = categorize(bEntry.name, false, bStat.size, relPath);
          candidates.push({
            name: bEntry.name,
            relPath,
            fullPath: bPath,
            size: bStat.size,
            mtime: bStat.mtimeMs,
            isDir: false,
            category: cat,
            graceDays: GRACE_DAYS[cat],
          });
        }
        continue;
      }

      let children;
      try {
        children = await fs.readdir(fullPath);
      } catch {
        continue;
      }
      if (children.length === 0) {
        const relPath = name;
        candidates.push({
          name,
          relPath,
          fullPath,
          size: 0,
          mtime: st.mtimeMs,
          isDir: true,
          category: 'auto-flag',
          graceDays: GRACE_DAYS['auto-flag'],
        });
      }
      continue;
    }

    const relPath = name;
    const cat = categorize(name, false, st.size, relPath);
    candidates.push({
      name,
      relPath,
      fullPath,
      size: st.size,
      mtime: st.mtimeMs,
      isDir: false,
      category: cat,
      graceDays: GRACE_DAYS[cat],
    });
  }

  return { candidates, missing: false };
}

function updateManifest(manifest, candidates) {
  const now = Date.now();
  const newEntries = [];
  const readyEntries = [];
  const logEntries = [];

  const candidatePaths = new Set(candidates.map(c => c.relPath));
  const candidateMap = new Map(candidates.map(c => [c.relPath, c]));

  for (const [relPath, entry] of Object.entries(manifest)) {
    if (entry.status === 'kept') continue;

    if (!candidatePaths.has(relPath)) {
      delete manifest[relPath];
      logEntries.push({ timestamp: new Date(now).toISOString(), action: 'removed', path: relPath, reason: 'file no longer exists', sizeBytes: 0 });
      continue;
    }

    const candidate = candidateMap.get(relPath);
    if (!candidate) continue;

    entry.lastChecked = new Date(now).toISOString();
    entry.currentMtime = candidate.mtime;
    entry.currentSize = candidate.size;
    entry.changed = (candidate.mtime !== entry.firstMtime || candidate.size !== entry.firstSize);

    if (entry.status === 'watching') {
      if (entry.changed) {
        entry.firstSeen = new Date(now).toISOString();
        entry.firstMtime = candidate.mtime;
        entry.firstSize = candidate.size;
        entry.changed = false;
      } else {
        const age = now - new Date(entry.firstSeen).getTime();
        if (age >= entry.graceDays * 86400000) {
          entry.status = 'ready';
          readyEntries.push({ relPath, ...entry });
          logEntries.push({ timestamp: new Date(now).toISOString(), action: 'ready', path: relPath, reason: `grace period elapsed (${entry.graceDays} days)`, sizeBytes: entry.currentSize });
        }
      }
    } else if (entry.status === 'ready') {
      if (entry.changed) {
        entry.status = 'watching';
        entry.firstSeen = new Date(now).toISOString();
        entry.firstMtime = candidate.mtime;
        entry.firstSize = candidate.size;
        entry.changed = false;
      }
    }
  }

  for (const candidate of candidates) {
    if (manifest[candidate.relPath]) continue;

    const entry = {
      firstSeen: new Date(now).toISOString(),
      firstMtime: candidate.mtime,
      firstSize: candidate.size,
      lastChecked: new Date(now).toISOString(),
      currentMtime: candidate.mtime,
      currentSize: candidate.size,
      changed: false,
      category: candidate.category,
      graceDays: candidate.graceDays,
      status: 'watching',
    };
    manifest[candidate.relPath] = entry;
    newEntries.push({ relPath: candidate.relPath, ...entry });
    logEntries.push({ timestamp: new Date(now).toISOString(), action: 'quarantined', path: candidate.relPath, reason: `new candidate (${candidate.category})`, sizeBytes: candidate.size });
  }

  return { newEntries, readyEntries, logEntries };
}

async function deleteEntry(relPath, manifest) {
  const entry = manifest[relPath];
  if (entry && entry.status === 'kept') {
    console.warn(`[audit-data] REFUSED: ${relPath} is marked 'kept' — cannot delete`);
    await appendLog({ timestamp: new Date().toISOString(), action: 'failed', path: relPath, reason: 'PROTECTED — marked kept', sizeBytes: entry.currentSize || 0 });
    return { success: false, error: 'Protected — marked kept' };
  }
  const fullPath = path.join(DATA_DIR, relPath);
  const sizeBytes = entry ? (entry.currentSize || 0) : 0;

  if (relPath === 'secrets.json') {
    await appendLog({ timestamp: new Date().toISOString(), action: 'failed', path: relPath, reason: 'PROTECTED — secrets.json cannot be deleted', sizeBytes });
    return { success: false, error: 'Protected file' };
  }

  try {
    const st = await fs.stat(fullPath);
    if (st.isDirectory()) {
      await fs.rm(fullPath, { recursive: true, force: true });
    } else {
      await fs.unlink(fullPath);
    }
    await appendLog({ timestamp: new Date().toISOString(), action: 'deleted', path: relPath, reason: 'manual deletion', sizeBytes });
    delete manifest[relPath];
    return { success: true, sizeBytes };
  } catch (e) {
    if (e.code === 'ENOENT') {
      delete manifest[relPath];
      await appendLog({ timestamp: new Date().toISOString(), action: 'removed', path: relPath, reason: 'file no longer exists', sizeBytes });
      return { success: true, sizeBytes: 0 };
    }
    await appendLog({ timestamp: new Date().toISOString(), action: 'failed', path: relPath, reason: e.message, sizeBytes });
    return { success: false, error: e.message };
  }
}

function ask(question) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise(resolve => {
    rl.question(question, answer => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

async function promptClean(manifest, readyItems) {
  if (readyItems.length === 0) {
    console.log('Nothing ready for deletion.');
    return;
  }

  const totalBytes = readyItems.reduce((sum, r) => sum + (r.currentSize || 0), 0);
  console.log(`\n${readyItems.length} item(s) ready for deletion (${humanSize(totalBytes)} total):\n`);
  readyItems.forEach((r, i) => {
    const age = daysSince(r.firstSeen);
    console.log(`  ${i + 1}. ${r.relPath}  (${humanSize(r.currentSize)}, quarantined ${age} days ago, unchanged)`);
  });

  while (true) {
    const answer = await ask(`\nDelete ${readyItems.length} ready files (${humanSize(totalBytes)} total)? [y/N/d(etail)/q] `);
    const lowered = answer.toLowerCase();

    if (lowered === 'y' || lowered === 'yes') {
      let deleted = 0, failed = 0;
      for (const r of readyItems) {
        const result = await deleteEntry(r.relPath, manifest);
        if (result.success) deleted++;
        else failed++;
      }
      await saveManifest(manifest);
      console.log(`\nDeleted ${deleted} item(s).${failed > 0 ? ` ${failed} failed.` : ''}`);
      return;
    }

    if (lowered === 'd') {
      await promptDetail(manifest);
      return;
    }

    if (lowered === 'n' || lowered === '' || lowered === 'q') {
      console.log('Exiting without changes.');
      return;
    }

    console.log('Invalid choice. Enter y, N, d, or q.');
  }
}

async function promptDetail(manifest) {
  const allEntries = Object.entries(manifest);
  if (allEntries.length === 0) {
    console.log('No items in quarantine.');
    return;
  }

  allEntries.sort((a, b) => a[0].localeCompare(b[0]));

  console.log('\nQuarantine Detail View:\n');
  console.log(`  ${'#'.padStart(3)}  ${'Path'.padEnd(50)}  ${'Category'.padEnd(10)}  ${'Status'.padEnd(10)}  ${'Age'.padStart(5)}  ${'Changed'.padStart(7)}  ${'Size'.padStart(10)}`);
  console.log(`  ${'---'.padStart(3)}  ${'----'.padEnd(50)}  ${'--------'.padEnd(10)}  ${'------'.padEnd(10)}  ${'---'.padStart(5)}  ${'-------'.padStart(7)}  ${'----'.padStart(10)}`);

  allEntries.forEach(([relPath, entry], i) => {
    const age = daysSince(entry.firstSeen);
    const changed = entry.changed ? 'yes' : 'no';
    console.log(`  ${String(i + 1).padStart(3)}  ${relPath.padEnd(50)}  ${entry.category.padEnd(10)}  ${entry.status.padEnd(10)}  ${String(age).padStart(5)}  ${changed.padStart(7)}  ${humanSize(entry.currentSize).padStart(10)}`);
  });

  while (true) {
    const answer = await ask('\nAction per file (#:d=delete, #:k=keep, s=skip, q=quit): ');
    const lowered = answer.toLowerCase().trim();

    if (lowered === 'q' || lowered === '') {
      await saveManifest(manifest);
      console.log('Exiting.');
      return;
    }

    if (lowered === 's') continue;

    const match = lowered.match(/^(\d+)\s*:\s*([dk])$/);
    if (!match) {
      console.log('Format: <number>:d or <number>:k (e.g., 3:d to delete item #3)');
      continue;
    }

    const idx = parseInt(match[1], 10) - 1;
    const action = match[2];

    if (idx < 0 || idx >= allEntries.length) {
      console.log(`Invalid number. Range: 1-${allEntries.length}`);
      continue;
    }

    const [relPath] = allEntries[idx];

    if (action === 'd') {
      const result = await deleteEntry(relPath, manifest);
      if (result.success) {
        console.log(`  Deleted: ${relPath}`);
      } else {
        console.log(`  Failed: ${relPath} — ${result.error}`);
      }
      allEntries.splice(idx, 1);
      await saveManifest(manifest);
    } else if (action === 'k') {
      manifest[relPath].status = 'kept';
      await appendLog({ timestamp: new Date().toISOString(), action: 'kept', path: relPath, reason: 'marked keep forever', sizeBytes: manifest[relPath].currentSize });
      console.log(`  Kept: ${relPath}`);
      allEntries.splice(idx, 1);
      await saveManifest(manifest);
    }
  }
}

function printHelp() {
  console.log(`Usage: node scripts/audit-data.mjs [mode]

Modes:
  (default), --report   Scan data/, update quarantine manifest, print summary
  --clean               Scan + prompt to delete items that passed grace period
  --detail              Scan + interactive per-file detail view
  --check               JSON gate: { status, readyCount, readyBytes, newCount }
                        Exit 0 if nothing ready, exit 1 otherwise
  --json                Full JSON dump of quarantine manifest + summary
  --help, -h            Show this help

Quarantine lifecycle:
  1. New candidates are added with status "watching"
  2. After grace period (3d auto-flag, 14d maybe-flag) with no changes → "ready"
  3. Ready items can be deleted with --clean or --detail
  4. Items can be marked "kept" to exclude from future scans

State files:
  data/quarantine-manifest.json   Quarantine state for each candidate
  data/cleanup-log.jsonl          Append-only log of all actions`);
}

async function runScan() {
  const { candidates, missing } = await scanDataDir();
  if (missing) {
    return { manifest: {}, newEntries: [], readyEntries: [], logEntries: [], missing: true, candidates: [] };
  }

  const manifest = await loadManifest();
  const { newEntries, readyEntries, logEntries } = updateManifest(manifest, candidates);

  for (const logEntry of logEntries) {
    await appendLog(logEntry);
  }

  await saveManifest(manifest);

  return { manifest, newEntries, readyEntries, logEntries, missing: false, candidates };
}

async function main() {
  const args = process.argv.slice(2);
  const mode = args.find(a => a.startsWith('--')) || '--report';

  if (mode === '--help' || mode === '-h') {
    printHelp();
    process.exit(0);
  }

  const { manifest, newEntries, readyEntries, missing } = await runScan();

  if (missing) {
    if (mode === '--check') {
      process.stdout.write(JSON.stringify({ status: 'clean', readyCount: 0, readyBytes: 0, newCount: 0 }) + '\n');
      process.exit(0);
    }
    if (mode === '--json') {
      process.stdout.write(JSON.stringify({ timestamp: new Date().toISOString(), manifest: {}, summary: { newCount: 0, readyCount: 0, readyBytes: 0 }, missing: true }, null, 2) + '\n');
      process.exit(0);
    }
    console.log('[audit-data] data/ directory not found. Nothing to audit.');
    process.exit(0);
  }

  const readyBytes = readyEntries.reduce((sum, r) => sum + (r.currentSize || 0), 0);

  if (mode === '--check') {
    const output = {
      status: readyEntries.length === 0 ? 'clean' : 'dirty',
      readyCount: readyEntries.length,
      readyBytes,
      newCount: newEntries.length,
    };
    process.stdout.write(JSON.stringify(output) + '\n');
    process.exit(readyEntries.length === 0 ? 0 : 1);
  }

  if (mode === '--json') {
    const output = {
      timestamp: new Date().toISOString(),
      manifest,
      summary: {
        newCount: newEntries.length,
        readyCount: readyEntries.length,
        readyBytes,
        readyBytesHuman: humanSize(readyBytes),
        totalTracked: Object.keys(manifest).length,
      },
    };
    process.stdout.write(JSON.stringify(output, null, 2) + '\n');
    process.exit(0);
  }

  if (mode === '--clean') {
    console.log(`[audit-data] Scanned data/ — ${newEntries.length} new candidates quarantined, ${readyEntries.length} ready for deletion (${humanSize(readyBytes)})`);

    if (readyEntries.length > 0) {
      console.log('\nReady for deletion:');
      readyEntries.forEach((r, i) => {
        const age = daysSince(r.firstSeen);
        console.log(`  ${i + 1}. ${r.relPath}  (${humanSize(r.currentSize)}, quarantined ${age} days ago, unchanged)`);
      });
    }

    if (newEntries.length > 0) {
      console.log('\nNew candidates (now watching):');
      newEntries.forEach(e => {
        console.log(`  - ${e.relPath} (${e.category}, ${e.graceDays}-day grace)`);
      });
    }

    await promptClean(manifest, readyEntries);
    process.exit(0);
  }

  if (mode === '--detail') {
    console.log(`[audit-data] Scanned data/ — ${newEntries.length} new candidates quarantined, ${readyEntries.length} ready for deletion (${humanSize(readyBytes)})`);

    if (newEntries.length > 0) {
      console.log('\nNew candidates (now watching):');
      newEntries.forEach(e => {
        console.log(`  - ${e.relPath} (${e.category}, ${e.graceDays}-day grace)`);
      });
    }

    await promptDetail(manifest);
    process.exit(0);
  }

  console.log(`[audit-data] Scanned data/ — ${newEntries.length} new candidates quarantined, ${readyEntries.length} ready for deletion (${humanSize(readyBytes)})`);

  if (readyEntries.length > 0) {
    console.log('\nReady for deletion:');
    readyEntries.forEach((r, i) => {
      const age = daysSince(r.firstSeen);
      console.log(`  ${i + 1}. ${r.relPath}  (${humanSize(r.currentSize)}, quarantined ${age} days ago, unchanged)`);
    });
  }

  if (newEntries.length > 0) {
    console.log('\nNew candidates (now watching):');
    newEntries.forEach(e => {
      console.log(`  - ${e.relPath} (${e.category}, ${e.graceDays}-day grace)`);
    });
  }

  if (readyEntries.length === 0 && newEntries.length === 0) {
    console.log('\nNo new candidates, nothing ready. data/ is clean.');
  }

  process.exit(0);
}

main().catch(e => {
  console.error(`[audit-data] Error: ${e.message}`);
  process.exit(1);
});
