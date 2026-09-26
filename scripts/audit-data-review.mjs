#!/usr/bin/env node

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = path.resolve(__dirname, '..');
const DEFAULT_DATA_DIR = path.join(ROOT_DIR, 'data');
const REVIEWED_FILE = 'last-data-review.json';

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
].map(n => n.toLowerCase()));

const STALE_ARTIFACTS = new Set(['node.old', 'test-copy-overwrite']);

const RECENT_MOVE = new Set(['samples', 'reports', 'tools'].map(n => n.toLowerCase()));

const RUNTIME_NAMES = new Set([
  'node', 'gh-cli', 'bin', 'tools', 'downloads',
  'agent-tier.json', 'update-status.json',
  'free-models.json', 'plugins.json', 'skills-lock.json',
  'secrets.json', '.review-pass.json',
  'audit-data-state.json', 'audit-root-state.json',
  'quarantine-manifest.json', 'cleanup-log.jsonl',
  '.restart-timestamp', 'model-registry.json',
  'model-assignment.json', 'model-assignments.json',
  'model-resolver-preference.json', 'model-update-status.json',
  'nvidia-free-cache.json', 'nvidia-free-watchlist-cache.json',
  'license',
].map(n => n.toLowerCase()));

const RUNTIME_PATTERNS = [
  /^model-.*\.json$/i,
  /^nvidia-.*-cache\.json$/i,
  /\.pid$/i,
];

const ARTIFACT_NAMES = new Set([
  'screenshots', 'mulahazah', 'backups', 'downloads',
  'node.old', 'test-copy-overwrite',
].map(n => n.toLowerCase()));

const ARTIFACT_EXTS = new Set(['.log', '.err', '.out']);

const ARTIFACT_EXACT = new Set([
  'vision-dispatch-log.txt', 'bootstrap.log', 'launch.log',
  'server-debug.log', 'restart-kill.log',
  'review-install-ps1-submodule-fix.log',
  'memory-dispatch-err.log', 'memory-dispatch-out.log',
  'auth-proxy.log', 'auth-proxy-err.log',
].map(n => n.toLowerCase()));

const USER_DATA_NAMES = new Set(['plans'].map(n => n.toLowerCase()));

const TEMP_NAMES = new Set([
  'temp', 'tmp', 'test-node.mjs', 'test.txt', 'append-shopping.js',
].map(n => n.toLowerCase()));

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

function daysBetween(a, b) {
  return Math.floor((a - b) / 86400000);
}

function isProtected(name) {
  const lower = name.toLowerCase();
  if (PROTECTED_NAMES.has(lower)) return true;
  if (KNOWN_MANIFEST.has(lower)) return true;
  const ext = path.extname(name).toLowerCase();
  if (PROTECTED_EXTS.has(ext)) return true;
  return false;
}

function isRuntime(name, isDir) {
  const lower = name.toLowerCase();
  if (RUNTIME_NAMES.has(lower)) return true;
  for (const pat of RUNTIME_PATTERNS) {
    if (pat.test(name)) return true;
  }
  return false;
}

function isArtifact(name, isDir) {
  const lower = name.toLowerCase();
  if (ARTIFACT_NAMES.has(lower)) return true;
  if (ARTIFACT_EXACT.has(lower)) return true;
  const ext = path.extname(name).toLowerCase();
  if (ARTIFACT_EXTS.has(ext)) return true;
  return false;
}

function isRecentMove(name) {
  return RECENT_MOVE.has(name.toLowerCase());
}

function isUserData(name) {
  return USER_DATA_NAMES.has(name.toLowerCase());
}

function isTempScratch(name) {
  const lower = name.toLowerCase();
  if (TEMP_NAMES.has(lower)) return true;
  if (/^\.stuck-signal\.ses_.*\.json$/i.test(name)) return true;
  return false;
}

function categorize(name, isDir) {
  if (isRecentMove(name)) return 'recent-move';
  if (isTempScratch(name)) return 'temp-scratch';
  if (isArtifact(name, isDir)) return 'artifacts';
  if (isUserData(name)) return 'user-data';
  if (isRuntime(name, isDir)) return 'runtime';
  return 'unknown';
}

async function dirSize(dirPath) {
  let total = 0;
  let count = 0;
  let oldest = Infinity;
  let newest = 0;
  try {
    const entries = await fs.readdir(dirPath, { withFileTypes: true });
    for (const entry of entries) {
      const full = path.join(dirPath, entry.name);
      try {
        const st = await fs.stat(full);
        if (st.isDirectory()) {
          const sub = await dirSize(full);
          total += sub.total;
          count += sub.count;
          if (sub.oldest < oldest) oldest = sub.oldest;
          if (sub.newest > newest) newest = sub.newest;
        } else {
          total += st.size;
          count++;
          const mt = st.mtimeMs;
          if (mt < oldest) oldest = mt;
          if (mt > newest) newest = mt;
        }
      } catch { /* skip */ }
    }
  } catch { /* skip */ }
  return { total, count, oldest: oldest === Infinity ? 0 : oldest, newest };
}

async function scanDir(dataDir, opts) {
  const now = Date.now();
  const { daysThreshold, sizeThresholdMB } = opts;
  const sizeThreshold = sizeThresholdMB * 1024 * 1024;

  let entries;
  try {
    entries = await fs.readdir(dataDir, { withFileTypes: true });
  } catch (e) {
    if (e.code === 'ENOENT') return { missing: true, items: [], totalSize: 0 };
    throw e;
  }

  const items = [];
  let totalSize = 0;

  for (const entry of entries) {
    const name = entry.name;
    const fullPath = path.join(dataDir, name);
    let st;
    try {
      st = await fs.stat(fullPath);
    } catch {
      continue;
    }

    const isDir = st.isDirectory();
    let size = st.size;
    let dirInfo = null;

    if (isDir) {
      dirInfo = await dirSize(fullPath);
      size = dirInfo.total;
    }

    totalSize += size;

    const mtime = st.mtimeMs;
    const mtimeDate = new Date(mtime);
    const ageDays = daysBetween(now, mtime);
    const category = categorize(name, isDir);
    const prot = isProtected(name);

    let recommendation;
    let note = '';

    if (STALE_ARTIFACTS.has(name.toLowerCase())) {
      recommendation = 'CLEANUP CANDIDATE';
      note = `stale — ${humanSize(size)}, recommend reviewing protection`;
    } else if (category === 'recent-move') {
      recommendation = 'INFO';
      note = 'moved to data/ 2026-08-08';
    } else if (category === 'runtime' && prot) {
      recommendation = 'KEEP';
    } else if (category === 'runtime') {
      recommendation = 'KEEP';
    } else if (category === 'user-data') {
      recommendation = 'KEEP';
    } else if (category === 'artifacts') {
      if (name.toLowerCase() === 'backups') {
        recommendation = 'REVIEW';
        const bc = dirInfo ? dirInfo.count : 0;
        note = `${bc} backups — consider pruning >90 days old`;
      } else if (name.toLowerCase() === 'screenshots') {
        recommendation = 'REVIEW';
        const sc = dirInfo ? dirInfo.count : 0;
        const oldestDays = dirInfo && dirInfo.oldest ? daysBetween(now, dirInfo.oldest) : 'N/A';
        note = `${sc} screenshots, oldest ${oldestDays} — cleanup-screenshots.mjs exists (14-day default)`;
      } else if (name.toLowerCase() === 'downloads') {
        recommendation = 'REVIEW';
        note = `installer cache — flag .zip/.exe older than ${daysThreshold} days`;
      } else if (name.toLowerCase() === 'mulahazah') {
        recommendation = 'REVIEW';
        note = `observability data — ${humanSize(size)}`;
      } else if (prot) {
        recommendation = 'REVIEW';
        note = 'known manifest file — protected by audit-data.mjs';
      } else if (size > sizeThreshold) {
        recommendation = 'CLEANUP CANDIDATE';
        note = `large artifact (${humanSize(size)})`;
      } else {
        recommendation = 'CLEANUP CANDIDATE';
      }
    } else if (category === 'temp-scratch') {
      if (/^\.stuck-signal\.ses_/i.test(name)) {
        if (ageDays > 7) {
          recommendation = 'CLEANUP CANDIDATE';
          note = `stale session signal (${ageDays}d old)`;
        } else {
          recommendation = 'KEEP';
          note = `recent signal (${ageDays}d old)`;
        }
      } else {
        recommendation = 'CLEANUP CANDIDATE';
      }
    } else {
      recommendation = 'REVIEW';
      note = 'uncategorized';
    }

    items.push({
      name,
      type: isDir ? 'dir' : 'file',
      size,
      sizeHuman: humanSize(size),
      mtime: mtimeDate.toISOString(),
      mtimeFormatted: formatDate(mtimeDate),
      ageDays,
      category,
      recommendation,
      note,
      protected: prot,
    });
  }

  items.sort((a, b) => a.name.localeCompare(b.name));
  return { missing: false, items, totalSize };
}

function buildReport(scanResult, opts) {
  const { items, totalSize, missing } = scanResult;
  if (missing) {
    return { text: 'data/ directory not found. Nothing to review.', json: { missing: true } };
  }

  const categories = ['runtime', 'user-data', 'artifacts', 'recent-move', 'temp-scratch'];
  const grouped = {};
  for (const cat of categories) grouped[cat] = [];
  grouped['unknown'] = [];

  for (const item of items) {
    const cat = categories.includes(item.category) ? item.category : 'unknown';
    grouped[cat].push(item);
  }

  const candidates = items.filter(i => i.recommendation === 'CLEANUP CANDIDATE');
  const reclaimable = candidates.reduce((s, i) => s + i.size, 0);

  const lines = [];
  lines.push('# data/ Review Report');
  lines.push('');
  lines.push(`**Total size**: ${humanSize(totalSize)} | **Entries**: ${items.length} | **Cleanup candidates**: ${candidates.length} | **Reclaimable**: ${humanSize(reclaimable)}`);
  lines.push(`**Thresholds**: age > ${opts.daysThreshold}d, size > ${opts.sizeThresholdMB} MB`);
  lines.push('');

  const catLabels = {
    runtime: 'Runtime (needed to run)',
    'user-data': 'User Data',
    artifacts: 'Artifacts (regenerable)',
    'recent-move': 'Recent Move (informational)',
    'temp-scratch': 'Temp / Scratch',
    unknown: 'Uncategorized',
  };

  for (const cat of [...categories, 'unknown']) {
    const group = grouped[cat];
    if (group.length === 0) continue;
    const catSize = group.reduce((s, i) => s + i.size, 0);
    lines.push(`## ${catLabels[cat]} (${group.length} entries, ${humanSize(catSize)})`);
    lines.push('');
    for (const item of group) {
      const recTag = item.recommendation === 'KEEP' ? '✅ KEEP'
        : item.recommendation === 'CLEANUP CANDIDATE' ? '🗑️ CLEANUP'
        : item.recommendation === 'INFO' ? 'ℹ️ INFO'
        : '🔍 REVIEW';
      let line = `- \`${item.name}\` [${item.type}] ${item.sizeHuman} — ${item.mtimeFormatted} (${item.ageDays}d) — ${recTag}`;
      if (item.note) line += ` — ${item.note}`;
      if (item.protected && item.recommendation !== 'CLEANUP CANDIDATE') line += ' *(protected)*';
      lines.push(line);
    }
    lines.push('');
  }

  lines.push('---');
  lines.push('');
  lines.push('Deletion is handled by: `node scripts/audit-data.mjs --clean` (quarantine flow)');
  lines.push('');

  const json = {
    timestamp: new Date().toISOString(),
    totalSize,
    totalSizeHuman: humanSize(totalSize),
    entryCount: items.length,
    candidateCount: candidates.length,
    reclaimable,
    reclaimableHuman: humanSize(reclaimable),
    thresholds: { days: opts.daysThreshold, sizeMB: opts.sizeThresholdMB },
    categories: {},
  };
  for (const cat of [...categories, 'unknown']) {
    const group = grouped[cat];
    if (group.length === 0) continue;
    json.categories[cat] = {
      count: group.length,
      size: group.reduce((s, i) => s + i.size, 0),
      items: group.map(i => ({
        name: i.name,
        type: i.type,
        size: i.size,
        sizeHuman: i.sizeHuman,
        ageDays: i.ageDays,
        recommendation: i.recommendation,
        note: i.note || undefined,
        protected: i.protected,
      })),
    };
  }

  return { text: lines.join('\n'), json };
}

async function markReviewed(dataDir) {
  const fp = path.join(dataDir, REVIEWED_FILE);
  await fs.mkdir(path.dirname(fp), { recursive: true });
  const tmp = fp + '.tmp';
  try { await fs.unlink(tmp); } catch (e) { if (e.code !== 'ENOENT') throw e; }
  await fs.writeFile(tmp, JSON.stringify({ lastReview: new Date().toISOString() }, null, 2) + '\n', 'utf8');
  await fs.rename(tmp, fp);
}

function printHelp() {
  console.log(`Usage: node scripts/audit-data-review.mjs [options]

Options:
  --json              Output machine-readable JSON to stdout
  --days N            Age threshold for "old" items (default: 30)
  --size N            Size threshold in MB for "large" items (default: 10)
  --data-dir PATH     Override data/ directory (for testing)
  --mark-reviewed     Write data/last-data-review.json with current timestamp
  --help              Show this help

This is a READ-ONLY review tool. Deletion is handled by:
  node scripts/audit-data.mjs --clean`);
}

async function main() {
  const args = process.argv.slice(2);

  if (args.includes('--help') || args.includes('-h')) {
    printHelp();
    process.exit(0);
  }

  const jsonMode = args.includes('--json');
  const markMode = args.includes('--mark-reviewed');

  let daysThreshold = 30;
  const daysIdx = args.indexOf('--days');
  if (daysIdx !== -1 && args[daysIdx + 1]) {
    daysThreshold = parseInt(args[daysIdx + 1], 10) || 30;
  }

  let sizeThresholdMB = 10;
  const sizeIdx = args.indexOf('--size');
  if (sizeIdx !== -1 && args[sizeIdx + 1]) {
    sizeThresholdMB = parseInt(args[sizeIdx + 1], 10) || 10;
  }

  let dataDir = DEFAULT_DATA_DIR;
  const dirIdx = args.indexOf('--data-dir');
  if (dirIdx !== -1 && args[dirIdx + 1]) {
    dataDir = path.resolve(args[dirIdx + 1]);
  }

  if (markMode) {
    await markReviewed(dataDir);
    console.log(`Marked reviewed: ${path.join(dataDir, REVIEWED_FILE)}`);
    process.exit(0);
  }

  const opts = { daysThreshold, sizeThresholdMB };
  const scanResult = await scanDir(dataDir, opts);
  const { text, json } = buildReport(scanResult, opts);

  if (jsonMode) {
    process.stdout.write(JSON.stringify(json, null, 2) + '\n');
  } else {
    process.stdout.write(text + '\n');
  }

  process.exit(0);
}

main().catch(e => {
  console.error(`[audit-data-review] Error: ${e.message}`);
  process.exit(1);
});
