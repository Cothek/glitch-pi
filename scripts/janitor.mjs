#!/usr/bin/env node
/**
 * Janitor — conservative runtime cleanup for data/ and root dir junk.
 *
 * Rules:
 *   1. Delete data/MEMORY_TRIGGER_FLAG.* older than 24h (mtime)
 *   2. Delete logs matching data/*.log, data/*-err.log, data/*.err, data/*.out
 *      older than 7 days, EXCEPT protected logs (truncated to last 2000 lines
 *      when >5MB instead of deleted)
 *   3. Clear contents of data/temp/, data/tmp/, data/scratch/ (create if missing)
 *   4. Exit silently with code 0 when nothing to do
 *
 * Usage:
 *   node scripts/janitor.mjs              # dry-run (default)
 *   node scripts/janitor.mjs --apply      # actually clean
 *   node scripts/janitor.mjs --base /path # test with custom base dir
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, statSync, unlinkSync, appendFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// ── Parse args ─────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
const isApply = args.includes('--apply');
const baseIdx = args.indexOf('--base');
const baseDir = baseIdx !== -1 && args[baseIdx + 1]
  ? args[baseIdx + 1]
  : join(__dirname, '..');

// ── Constants ──────────────────────────────────────────────────────────────
const DATA_DIR = join(baseDir, 'data');

const FLAG_TTL_MS = 24 * 60 * 60 * 1000;  // 24 hours
const LOG_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

// Logs that get truncated, not deleted
const PROTECTED_LOGS = [
  'launch.log',
  'auth-proxy.log',
  'bootstrap.log',
];
const LOG_TRUNCATE_LINES = 2000;
const LOG_TRUNCATE_SIZE_THRESHOLD = 5 * 1024 * 1024; // 5MB

// Dirs to clear contents (keep the dirs themselves)
const CLEAR_DIRS = ['temp', 'tmp', 'scratch'];

// ── Helpers ────────────────────────────────────────────────────────────────

function formatBytes(bytes) {
  if (bytes === 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  return (bytes / Math.pow(1024, i)).toFixed(2) + ' ' + units[i];
}

function isLogFile(name) {
  // Match: *.log, *-err.log, *.err, *.out
  return /\.(log|err|out)$/.test(name);
}

function isProtectedLog(name) {
  return PROTECTED_LOGS.includes(name);
}

function getMtimeMs(filePath) {
  try {
    return statSync(filePath).mtimeMs;
  } catch {
    return 0;
  }
}

function getFileSize(filePath) {
  try {
    return statSync(filePath).size;
  } catch {
    return 0;
  }
}

function truncateLog(filePath) {
  try {
    const content = readFileSync(filePath, 'utf-8');
    const lines = content.split('\n');
    if (lines.length <= LOG_TRUNCATE_LINES) return false;
    const truncated = lines.slice(-LOG_TRUNCATE_LINES).join('\n');
    writeFileSync(filePath, truncated, 'utf-8');
    return true;
  } catch {
    return false;
  }
}

// ── Core logic (exported for testing) ──────────────────────────────────────

/**
 * Run janitor logic against a base directory.
 * Returns a report object for assertions.
 */
export function runJanitor({ base, apply = false } = {}) {
  const dataDir = join(base, 'data');
  const now = Date.now();

  const report = {
    flagsDeleted: 0,
    flagsKept: 0,
    logsDeleted: 0,
    logsTruncated: 0,
    logsKept: 0,
    tempCleared: 0,
    bytesReclaimed: 0,
  };

  // ── Rule 1: Stale MEMORY_TRIGGER_FLAG files ────────────────────────────
  try {
    const files = readdirSync(dataDir);
    for (const f of files) {
      if (!f.startsWith('MEMORY_TRIGGER_FLAG.')) continue;
      const fp = join(dataDir, f);
      const age = now - getMtimeMs(fp);
      if (age > FLAG_TTL_MS) {
        report.bytesReclaimed += getFileSize(fp);
        if (apply) {
          try { unlinkSync(fp); } catch { /* already gone */ }
        }
        report.flagsDeleted++;
      } else {
        report.flagsKept++;
      }
    }
  } catch {
    // data/ doesn't exist — nothing to do
  }

  // ── Rule 2: Old logs ──────────────────────────────────────────────────
  try {
    const files = readdirSync(dataDir);
    for (const f of files) {
      if (!isLogFile(f)) continue;

      const fp = join(dataDir, f);
      const age = now - getMtimeMs(fp);

      if (isProtectedLog(f)) {
        // Protected logs: truncate if >5MB, never delete
        const size = getFileSize(fp);
        if (size > LOG_TRUNCATE_SIZE_THRESHOLD && age > LOG_TTL_MS) {
          if (apply) truncateLog(fp);
          report.logsTruncated++;
        } else {
          report.logsKept++;
        }
        continue;
      }

      // Non-protected logs: delete if older than 7 days
      if (age > LOG_TTL_MS) {
        report.bytesReclaimed += getFileSize(fp);
        if (apply) {
          try { unlinkSync(fp); } catch { /* already gone */ }
        }
        report.logsDeleted++;
      } else {
        report.logsKept++;
      }
    }
  } catch {
    // data/ doesn't exist
  }

  // ── Rule 3: Clear temp/tmp/scratch contents ────────────────────────────
  for (const d of CLEAR_DIRS) {
    const dirPath = join(dataDir, d);
    if (!existsSync(dirPath)) {
      if (apply) mkdirSync(dirPath, { recursive: true });
      continue;
    }
    try {
      const items = readdirSync(dirPath);
      for (const item of items) {
        const itemPath = join(dirPath, item);
        try {
          const st = statSync(itemPath);
          if (st.isDirectory()) {
            // Skip directories inside temp/tmp — only clear files
            continue;
          }
          report.bytesReclaimed += st.size;
          report.tempCleared++;
          if (apply) {
            try { unlinkSync(itemPath); } catch { /* already gone */ }
          }
        } catch {
          // skip
        }
      }
    } catch {
      // can't read dir
    }
  }

  return report;
}

// ── Memory encoding check ──────────────────────────────────────────────────
// Memory files (user/**/*.md) are written by several processes. A write in a
// non-UTF-8 encoding (editor or shell on a non-UTF-8 codepage) turns em dashes,
// bullets and checkmarks into U+FFFD; any later read-as-utf8 + whole-file
// rewrite (compaction-diary heartbeat, janitor truncation) bakes the damage in
// permanently. Detect it on every run so it cannot accumulate silently again.
function checkMemoryEncoding(userDir) {
  const issues = [];
  if (!existsSync(userDir)) return issues;

  const walk = (dir, depth) => {
    if (depth > 4) return;
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.name === '.git' || entry.name === 'node_modules') continue;
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full, depth + 1);
        continue;
      }
      if (!entry.name.endsWith('.md')) continue;
      try {
        // Buffer -> toString('utf8') flags BOTH real U+FFFD characters and
        // bytes that are not valid UTF-8 at all.
        const text = readFileSync(full).toString('utf8');
        const count = (text.match(/\uFFFD/g) || []).length;
        if (count > 0) issues.push({ file: full, count });
      } catch {
        // unreadable file - skip
      }
    }
  };

  walk(userDir, 0);
  return issues;
}

// ── CLI entrypoint ─────────────────────────────────────────────────────────

function main() {
  const report = runJanitor({ base: baseDir, apply: isApply });

  const totalRemoved = report.flagsDeleted + report.logsDeleted + report.tempCleared;
  const totalTruncated = report.logsTruncated;
  const totalBytes = report.bytesReclaimed;

  // Memory encoding drift (never silent, never auto-fixed here).
  // baseDir is the repo root; the memory profile lives at <repo>/user.
  const encodingIssues = checkMemoryEncoding(join(baseDir, 'user'));

  // Exit silently when nothing to do
  if (totalRemoved === 0 && totalTruncated === 0 && encodingIssues.length === 0) {
    process.exit(0);
  }

  console.log(`[janitor] ${isApply ? 'APPLY' : 'DRY-RUN'} — base: ${baseDir}`);

  if (encodingIssues.length > 0) {
    console.log(`  Memory encoding: ${encodingIssues.length} file(s) contain U+FFFD / invalid UTF-8`);
    for (const issue of encodingIssues) {
      console.log(`    ${issue.count} x ${issue.file}`);
    }
    console.log('    Repair: replace U+FFFD with "-" in those files and re-run.');
  }

  if (report.flagsDeleted > 0) {
    console.log(`  Stale flags: ${report.flagsDeleted} deleted, ${report.flagsKept} kept`);
  }
  if (report.logsDeleted > 0 || report.logsTruncated > 0) {
    console.log(`  Logs: ${report.logsDeleted} deleted, ${report.logsTruncated} truncated, ${report.logsKept} kept`);
  }
  if (report.tempCleared > 0) {
    console.log(`  Temp files: ${report.tempCleared} cleared`);
  }

  console.log(`[janitor] ${isApply ? 'removed' : 'would remove'} ${totalRemoved} files (${formatBytes(totalBytes)}), truncated ${totalTruncated} logs`);
}

// Only run CLI when executed directly (not imported for testing)
const isDirectRun = process.argv[1] && (
  process.argv[1].endsWith('janitor.mjs') ||
  process.argv[1].endsWith('janitor.js')
);
if (isDirectRun) {
  main();
}
