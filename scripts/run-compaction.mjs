#!/usr/bin/env node

import { execSync, execFileSync } from "child_process";
import { existsSync } from "fs";
import { readFile, writeFile, readdir, stat, rename, mkdir } from "fs/promises";
import path from "path";
import { fileURLToPath, pathToFileURL } from "url";
import { archiveStaleSessionDirs } from "../.pi/lib/memory-paths.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CWD = path.resolve(__dirname, "..");
const isWin = process.platform === "win32";
const today = new Date();
const todayStr = formatDate(today);

function warn(msg) {
  console.error(`[compaction] ${msg}`);
}

// On Windows, .cmd/.bat launchers cannot be exec'd directly via execFileSync
// (EINVAL/ENOENT). Wrap them through cmd.exe, mirroring the run() helper used
// across scripts/ (launch.mjs, check-install.mjs safeExec, lib/git-sync.mjs).
function wrapCmdForExec(cmd, args) {
  if (isWin && (cmd.endsWith(".cmd") || cmd.endsWith(".bat"))) {
    return { cmd: "cmd.exe", args: ["/d", "/s", "/c", cmd, ...args] };
  }
  return { cmd, args };
}

// Execute a command with the same semantics as execFileSync, but handling the
// Windows spaced-.cmd path bug. When a .cmd/.bat path contains a space (e.g.
// "E:\Glitch AI\glitch-ai\data\node\npm.cmd"), execFileSync passes it as an
// arg to "cmd.exe /d /s /c" — Node quotes the spaced arg, but /s strips the
// outer quotes, leaving an unquoted spaced path that cmd.exe misparses.
// Fix: for spaced .cmd/.bat paths, use execSync with a manually-built command
// string. execSync wraps the string in "cmd /d /s /c \"...\"" and /s strips
// execSync's outer quotes, leaving our quoted path intact. For non-spaced and
// non-.cmd cases, fall through to the normal execFileSync + wrapCmdForExec path.
function execWrapped(cmd, args, opts) {
  if (isWin && (cmd.endsWith(".cmd") || cmd.endsWith(".bat")) && cmd.includes(" ")) {
    // Build a command string for execSync: "cmd" arg1 "arg with space" arg2
    // execSync runs cmd.exe /d /s /c "<commandString>"; /s strips execSync's
    // outer quotes, leaving our string intact for cmd.exe to parse.
    const quoteIfNeeded = (a) => (a.includes(" ") ? `"${a}"` : a);
    const commandString = `"${cmd}" ${args.map(quoteIfNeeded).join(" ")}`;
    return execSync(commandString, opts);
  }
  const { cmd: wrappedCmd, args: wrappedArgs } = wrapCmdForExec(cmd, args);
  return execFileSync(wrappedCmd, wrappedArgs, opts);
}

function formatDate(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function daysSince(d) {
  const now = Date.now();
  const then = d.getTime();
  return Math.floor((now - then) / 86400000);
}

// --- Heavy-check throttling (2026-08-18) ---
// The expensive checks (image GC, data audit, data review, memory index) spawn
// node subprocesses. They ran on EVERY compaction (~13-24x/day), wasting tokens
// and CPU. They now run at most once per 24h, tracked in data/last-heavy-check.json.
const HEAVY_CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;
const heavyCheckStateFile = path.join(CWD, "data", "last-heavy-check.json");

async function shouldRunHeavyChecks() {
  try {
    const raw = await readFile(heavyCheckStateFile, "utf-8");
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed.lastRun === "number") {
      const ageMs = Date.now() - parsed.lastRun;
      if (ageMs < HEAVY_CHECK_INTERVAL_MS) {
        return { due: false, lastRun: parsed.lastRun };
      }
    }
  } catch (e) {
    // ENOENT or parse error — first run, heavy checks are due
  }
  return { due: true, lastRun: null };
}

async function markHeavyChecksRun() {
  try {
    const tmpFile = heavyCheckStateFile + ".tmp";
    await writeFile(tmpFile, JSON.stringify({ lastRun: Date.now() }, null, 2), "utf-8");
    await rename(tmpFile, heavyCheckStateFile);
  } catch (e) {
    warn(`Failed to save heavy-check state: ${e.message}`);
  }
}

function heavySkipMessage(name, lastRun) {
  const hoursAgo = lastRun ? Math.floor((Date.now() - lastRun) / 3600000) : null;
  return `✓ ${name}: skipped (heavy checks ran ${hoursAgo !== null ? `${hoursAgo}h ago` : "recently"})`;
}

// --- Step 1: Update timestamp in current-session.md ---
async function updateTimestamp() {
  const fp = path.join(CWD, "user", "current-session.md");
  try {
    let content = await readFile(fp, "utf-8");
    const ts = `${todayStr}T${String(today.getHours()).padStart(2, "0")}:${String(today.getMinutes()).padStart(2, "0")}:00Z`;
    content = content.replace(
      /^(\*\*Last Memory Update\*\*: ).*/m,
      `$1${ts}`
    );
    await writeFile(fp, content, "utf-8");
    return `✓ Last Memory Update: ${ts}`;
  } catch (e) {
    warn(`Failed to update timestamp: ${e.message}`);
    return `✗ Last Memory Update: FAILED (${e.message})`;
  }
}

// --- Step 2: Diary staleness check ---
async function checkDiaryStaleness() {
  const diaryDir = path.join(CWD, "user", "daily-diary", "current");
  try {
    await stat(diaryDir);
  } catch {
    return "✓ Diary staleness: N/A (no diary directory)";
  }

  try {
    const files = await readdir(diaryDir);
    const mdFiles = files.filter((f) => f.endsWith(".md"));

    if (mdFiles.length === 0) {
      return "✓ Diary staleness: N/A (no diary files)";
    }

    const oldEntries = [];
    for (const f of mdFiles) {
      const fstat = await stat(path.join(diaryDir, f));
      const ageDays = daysSince(fstat.mtime);
      if (ageDays > 30) {
        oldEntries.push({ file: f, age: ageDays, month: `${fstat.mtime.getFullYear()}-${String(fstat.mtime.getMonth() + 1).padStart(2, "0")}` });
      }
    }

    if (oldEntries.length === 0) {
      return "✓ Diary staleness: OK (no entries >30 days old)";
    }

    const monthCounts = {};
    for (const e of oldEntries) {
      monthCounts[e.month] = (monthCounts[e.month] || 0) + 1;
    }

    const archiveFlags = Object.entries(monthCounts)
      .filter(([, count]) => count >= 3)
      .map(([month]) => `${month} (${monthCounts[month]} entries)`);

    let msg = `⚠️ Diary staleness: ${oldEntries.length} entries >30 days old`;
    if (archiveFlags.length > 0) {
      msg += ` — archive candidates: ${archiveFlags.join(", ")}`;
    }
    return msg;
  } catch (e) {
    warn(`Diary check failed: ${e.message}`);
    return `✗ Diary staleness: FAILED (${e.message})`;
  }
}

// --- Step 3: Curriculum status ---
async function checkCurriculum() {
  const fp = path.join(CWD, "glitch-memorycore", "plugins", "curriculum", "curriculum-state.json");
  try {
    const content = await readFile(fp, "utf-8");
    const data = JSON.parse(content);
    const level = data.level ?? "N/A";
    const completed = (data.completedChallenges ?? []).length;
    const toolsCreated = data.toolsCreated ?? 0;
    const startedAt = data.startedAt;
    const toolsAtStart = data.toolsAtStart ?? 0;
    const toolsNeeded = 3 - toolsCreated;
    const promotionProgress = `tools: ${toolsCreated - toolsAtStart} new (${toolsCreated}/${toolsAtStart + 3} for promotion)`;

    let startedStatus = startedAt !== null && startedAt !== undefined
      ? `started: yes (${String(startedAt)})`
      : "⚠️ started: NO — curriculum has never been started";

    return `✓ Curriculum: Level ${level} | ${completed} challenges done | ${promotionProgress} | ${startedStatus}`;
  } catch (e) {
    warn(`Curriculum check failed: ${e.message}`);
    return `✗ Curriculum: FAILED (${e.message})`;
  }
}

// --- Step 5: Image GC (opencode DB) ---
async function checkImageGC(heavyDue, lastHeavyRun) {
  if (!heavyDue) return heavySkipMessage("Image GC", lastHeavyRun);
  const scriptPath = path.join(CWD, "scripts", "cleanup-opencode-images.mjs");
  try {
    await stat(scriptPath);
  } catch {
    return "✓ Image GC: N/A (script not found)";
  }

  try {
    const output = execSync(
      `node "${scriptPath}" --stats`,
      { encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"], timeout: 15000 }
    );
    // Parse key lines
    const lines = output.trim().split("\n");
    const totalLine = lines.find(l => l.trim().startsWith("Total image parts:"));
    const sizeLine = lines.find(l => l.trim().startsWith("Total image size:"));
    const lastRunLine = lines.find(l => l.trim().startsWith("Last GC run:"));
    const gcTargetLine = lines.find(l => l.trim().includes("90+ days"));

    let msg = `✓ Image GC: ${totalLine ? totalLine.trim() : ""} | ${sizeLine ? sizeLine.trim() : ""}`;
    if (lastRunLine) msg += ` | ${lastRunLine.trim()}`;

    // Flag if any images are past the 90-day threshold
    if (gcTargetLine) {
      const match = gcTargetLine.match(/90\+\s+days:\s+(\d+)\s+parts/);
      if (match && parseInt(match[1], 10) > 0) {
        msg += `\n⚠️  IMAGE_GC_ALERT: ${match[1]} image(s) are 90+ days old — run with --apply to reclaim space`;
      }
    }

    return msg;
  } catch (e) {
    warn(`Image GC check failed: ${e.message}`);
    return `✗ Image GC: FAILED (${e.message})`;
  }
}

// --- Step 4: Git status ---
async function checkGit() {
  try {
    const output = execSync("git status --short", { cwd: CWD, encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] });
    const lines = output.trim().split("\n").filter(Boolean);
    if (lines.length === 0) {
      return "✓ Git: clean";
    }
    return `⚠️ Git: ${lines.length} file(s) uncommitted\n${lines.map((l) => `   ${l}`).join("\n")}`;
  } catch (e) {
    warn(`Git check failed: ${e.message}`);
    return `✗ Git: FAILED (${e.message})`;
  }
}

// --- Step 4d: Memory file staleness check ---
async function checkMemoryStaleness() {
  const userDir = path.join(CWD, "user");
  const filesToCheck = [
    { name: "patterns.md", path: path.join(userDir, "patterns.md") },
    { name: "forge-log.md", path: path.join(userDir, "forge-log.md") },
    { name: "external-sources.md", path: path.join(userDir, "library", "external-sources.md") },
  ];

  const results = [];
  const staleFiles = [];

  for (const file of filesToCheck) {
    try {
      const content = await readFile(file.path, "utf-8");
      const match = content.match(/^\s*timestamp:\s*(.+)$/m);
      if (match) {
        const tsStr = match[1].trim();
        const ts = new Date(tsStr);
        if (isNaN(ts.getTime())) {
          results.push(`⚠ ${file.name} — invalid timestamp format: ${tsStr}`);
        } else {
          const days = daysSince(ts);
          const dateStr = formatDate(ts);
          if (days > 14) {
            results.push(`⚠ ${file.name} — last updated ${dateStr} (${days} days ago) — review for promotion`);
            staleFiles.push(file.name);
          } else {
            results.push(`✓ ${file.name} — current (${days} days ago)`);
          }
        }
      } else {
        results.push(`⚠ ${file.name} — not found or no timestamp`);
        staleFiles.push(file.name);
      }
    } catch (e) {
      if (e.code === "ENOENT") {
        results.push(`⚠ ${file.name} — not found or no timestamp`);
        staleFiles.push(file.name);
      } else {
        warn(`Memory staleness check failed for ${file.name}: ${e.message}`);
        results.push(`✗ ${file.name}: FAILED (${e.message})`);
      }
    }
  }

  return { lines: results, hasStale: staleFiles.length > 0 };
}

// --- Step 4e: Session dashboard staleness check ---
// The dashboard is loaded at every session start (instructions array), so it must
// stay live-only for context efficiency. Flags workstream sections where EVERY
// status row is ✅ (done) or ❌ (abandoned) — those should be archived to
// daily-diary/archived/. Sections with any 🔲/🔄/🔧/⏳ row are still active.

// Pure section parser — testable without touching the real file.
// Returns titles of workstream sections where every status row is ✅ or ❌.
export function findStaleDashboardSections(content) {
  const lines = content.split("\n");
  const sections = [];
  let current = null;

  for (const line of lines) {
    const headingMatch = line.match(/^###\s+(.+)/);
    if (headingMatch) {
      if (current) sections.push(current);
      current = { title: headingMatch[1].trim(), rows: [] };
      continue;
    }
    if (current && line.trim().startsWith("|")) {
      // Skip table header (| Status | ...) and separator (|----|) rows.
      if (/^\|\s*(Status|[-]+)\s*\|/.test(line.trim())) continue;
      current.rows.push(line.trim());
    }
  }
  if (current) sections.push(current);

  return sections
    .filter((s) => s.rows.length > 0 && s.rows.every((r) => /^\|\s*(✅|❌)/.test(r)))
    .map((s) => s.title);
}

async function checkDashboardStaleness() {
  const fp = path.join(CWD, "user", "session-dashboard.md");
  try {
    const content = await readFile(fp, "utf-8");
    const stale = findStaleDashboardSections(content);
    if (stale.length === 0) {
      return { lines: ["✓ Dashboard: all workstreams active"], hasStale: false };
    }

    return {
      lines: [
        `⚠️ Dashboard: ${stale.length} workstream(s) fully done/abandoned — archive to daily-diary/archived/`,
        ...stale.map((s) => `   - ${s}`),
      ],
      hasStale: true,
    };
  } catch (e) {
    if (e.code === "ENOENT") {
      return { lines: ["✓ Dashboard: not found (no session-dashboard.md)"], hasStale: false };
    }
    warn(`Dashboard staleness check failed: ${e.message}`);
    return { lines: [`✗ Dashboard: FAILED (${e.message})`], hasStale: false };
  }
}

// --- Step 5.5: Skill improvement review ---
async function checkSkillImprovements() {
  const fp = path.join(CWD, "user", "pending-skill-improvements.md");
  try {
    const content = await readFile(fp, "utf-8");

    const skillCounts = {};
    const lines = content.split("\n");
    let currentSkill = null;
    let totalEntries = 0;

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];

      const headingMatch = line.match(/^###\s+(.+)/);
      if (headingMatch) {
        currentSkill = headingMatch[1].trim();
        continue;
      }

      const entryMatch = line.match(/^- \[(\d{4}-\d{2}-\d{2})\]/);
      if (entryMatch && currentSkill) {
        totalEntries++;

        let significance = "minor";
        let status = "pending";
        for (let j = i + 1; j < Math.min(i + 5, lines.length); j++) {
          const meta = lines[j];
          if (meta.includes("→ Significance:")) {
            const sigMatch = meta.match(/→ Significance:\s*(\S+)/i);
            if (sigMatch) significance = sigMatch[1].toLowerCase();
          } else if (meta.includes("→ Status:")) {
            const statMatch = meta.match(/→ Status:\s*(\S+)/i);
            if (statMatch) status = statMatch[1].toLowerCase();
          }
          if (meta.match(/^- \[|^###/)) break;
        }

        if (!skillCounts[currentSkill]) {
          skillCounts[currentSkill] = { total: 0, pending: 0, major: 0, critical: 0, notable: 0 };
        }
        skillCounts[currentSkill].total++;
        if (status === "pending") {
          skillCounts[currentSkill].pending++;
        }
        if (significance === "major") skillCounts[currentSkill].major++;
        else if (significance === "critical") skillCounts[currentSkill].critical++;
        else if (significance === "notable") skillCounts[currentSkill].notable++;
      }
    }

    if (totalEntries === 0) {
      return { lines: ["✓ Skill improvements: none pending"], hasPending: false, skills: {} };
    }

    const resultLines = [];
    let totalPending = 0;
    for (const [skill, counts] of Object.entries(skillCounts)) {
      if (counts.pending > 0) {
        let signal = "minor";
        if (counts.critical >= 1) signal = "CRITICAL — present immediately";
        else if (counts.major >= 1) signal = "SIGNIFICANT — present at next compaction";
        else if (counts.pending >= 2) signal = "SIGNIFICANT — 2+ entries";
        else if (counts.notable >= 1) signal = "notable — needs 2nd occurrence";

        resultLines.push(
          `  ${skill}: ${counts.pending} pending (${counts.total} total)` +
          (counts.critical > 0 ? `, ${counts.critical} critical` : "") +
          (counts.major > 0 ? `, ${counts.major} major` : "") +
          ` — ${signal}`
        );
        totalPending += counts.pending;
      }
    }

    if (totalPending === 0) {
      return { lines: ["✓ Skill improvements: all applied or rejected"], hasPending: false, skills: {} };
    }

    return {
      lines: [
        `📋 Skill improvements: ${totalPending} pending across ${Object.keys(skillCounts).filter(s => skillCounts[s].pending > 0).length} skills`,
        ...resultLines,
        "  → Load forge skill (`skill \"forge\"`) to review and apply level-ups",
      ],
      hasPending: true,
      skills: skillCounts,
    };
  } catch (e) {
    if (e.code === "ENOENT") {
      return { lines: ["✓ Skill improvements: N/A (no pending-skill-improvements.md)"], hasPending: false, skills: {} };
    }
    warn(`Skill improvement check failed: ${e.message}`);
    return { lines: [`⚠ Skill improvements: check failed (${e.message})`], hasPending: false, skills: {} };
  }
}

function humanSizeCompact(bytes) {
  if (!bytes || bytes === 0) return "0 B";
  const u = ["B", "KB", "MB", "GB"];
  const i = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), u.length - 1);
  const v = bytes / Math.pow(1024, i);
  return `${i === 0 ? v : v.toFixed(1)} ${u[i]}`;
}

// --- Step 6: Audit data/ directory (single --json call covers both gate + report) ---
async function runDataAudit(heavyDue, lastHeavyRun) {
  if (!heavyDue) {
    return { dataAudit: heavySkipMessage("Data audit", lastHeavyRun), quarantineScan: heavySkipMessage("Quarantine scan", lastHeavyRun) };
  }
  const scriptPath = path.join(CWD, "scripts", "audit-data.mjs");
  try {
    await stat(scriptPath);
  } catch {
    return { dataAudit: "✓ Data audit: N/A (script not found)", quarantineScan: "✓ Quarantine scan: N/A (script not found)" };
  }

  try {
    const output = execSync(
      `node "${scriptPath}" --json`,
      { encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"], timeout: 30000 }
    );
    const parsed = JSON.parse(output.trim());
    const s = parsed.summary || {};

    let dataAudit;
    if (s.readyCount === 0 && s.newCount === 0) {
      dataAudit = "✓ Data audit: clean";
    } else {
      const parts = [];
      if (s.readyCount > 0) parts.push(`${s.readyCount} ready (${humanSizeCompact(s.readyBytes)})`);
      if (s.newCount > 0) parts.push(`${s.newCount} new`);
      dataAudit = `⚠️ Data audit: ${parts.join(", ")} — run \`node scripts/audit-data.mjs\` to review`;
    }

    const totalTracked = s.totalTracked || 0;
    const quarantineScan = totalTracked > 0
      ? `✓ Quarantine scan: ${totalTracked} tracked, ${s.newCount || 0} new, ${s.readyCount || 0} ready (${s.readyBytesHuman || "0 B"})`
      : "✓ Quarantine scan: no candidates tracked";

    return { dataAudit, quarantineScan };
  } catch (e) {
    warn(`Data audit failed: ${e.message}`);
    return { dataAudit: `✗ Data audit: FAILED (${e.message})`, quarantineScan: `✗ Quarantine scan: FAILED (${e.message})` };
  }
}

// --- Step 6b: Monthly data/ review check ---
async function checkDataReview(heavyDue, lastHeavyRun) {
  if (!heavyDue) return heavySkipMessage("Data review", lastHeavyRun);
  const reviewScript = path.join(CWD, "scripts", "audit-data-review.mjs");
  try {
    await stat(reviewScript);
  } catch {
    return "✓ Data review: N/A (script not found)";
  }

  const reviewedFile = path.join(CWD, "data", "last-data-review.json");
  let lastReview = null;
  try {
    const raw = await readFile(reviewedFile, "utf-8");
    const parsed = JSON.parse(raw);
    if (parsed.lastReview) lastReview = new Date(parsed.lastReview);
  } catch (e) {
    if (e.code !== "ENOENT") warn(`Data review timestamp read failed: ${e.message}`);
  }

  const daysSinceReview = lastReview ? daysSince(lastReview) : null;
  const isDue = daysSinceReview === null || daysSinceReview >= 30;

  let summaryLine = "";
  try {
    const output = execSync(
      `node "${reviewScript}" --json`,
      { encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"], timeout: 30000 }
    );
    const parsed = JSON.parse(output.trim());
    const cands = parsed.candidateCount || 0;
    const reclaim = parsed.reclaimableHuman || "0 B";
    summaryLine = `${cands} candidate(s) (~${reclaim} reclaimable)`;
  } catch (e) {
    warn(`Data review summary failed: ${e.message}`);
    summaryLine = "summary unavailable";
  }

  if (isDue) {
    const lastStr = lastReview ? formatDate(lastReview) : "never";
    return `⚠️ DATA_REVIEW_DUE: Monthly data/ review is due (last: ${lastStr}) — run \`node scripts/audit-data-review.mjs\` | ${summaryLine}`;
  }

  return `✓ Data review: current (last ${formatDate(lastReview)}, ${daysSinceReview}d ago) | ${summaryLine}`;
}

// --- Step 6c: Memory index health (FTS5) ---
// Rebuilds glitch-memorycore/plugins/embed-search/memory-search.db when missing or stale (>24h).
// The DB is gitignored and lives outside protected data/ paths, so it silently disappears
// on fresh clones, git clean, or submodule resets. This check makes the compaction run
// self-healing per PM-023. Idempotent: skips all work when the index is healthy and fresh.
async function checkMemoryIndex(heavyDue, lastHeavyRun) {
  if (!heavyDue) return heavySkipMessage("Memory index", lastHeavyRun);
  const embedDir = path.join(CWD, "glitch-memorycore", "plugins", "embed-search");
  const indexerScript = path.join(embedDir, "index-memory.mjs");
  const dbPath = path.join(embedDir, "memory-search.db");
  const nodeModulesPath = path.join(embedDir, "node_modules");

  // Resolve the node binary: prefer bundled portable node, fall back to system node.
  const bundledNode = isWin
    ? path.join(CWD, "data", "node", "node.exe")
    : path.join(CWD, "data", "node", "bin", "node");
  const nodeBin = existsSync(bundledNode) ? bundledNode : "node";

  // Resolve npm: prefer bundled npm.cmd/bin, fall back to system npm.
  const bundledNpm = isWin
    ? path.join(CWD, "data", "node", "npm.cmd")
    : path.join(CWD, "data", "node", "bin", "npm");
  const npmBin = existsSync(bundledNpm) ? bundledNpm : (isWin ? "npm.cmd" : "npm");

  const STALE_MS = 24 * 60 * 60 * 1000; // 24h

  try {
    // 1. Does the indexer script exist?
    if (!existsSync(indexerScript)) {
      return "✓ Memory index: N/A (indexer script not found)";
    }

    // 2. Is the DB present and fresh?
    let dbExists = false;
    let dbStale = false;
    try {
      const dbStat = await stat(dbPath);
      dbExists = true;
      const ageMs = Date.now() - dbStat.mtimeMs;
      dbStale = ageMs > STALE_MS;
    } catch {
      // ENOENT — DB missing
    }

    // Fast path: DB exists, is fresh, AND node_modules is present — nothing to do.
    // If node_modules is missing, readIndexChunkCount would throw on require('better-sqlite3'),
    // so fall through to the rebuild path (which runs npm install first).
    if (dbExists && !dbStale && existsSync(nodeModulesPath)) {
      // Read chunk count from the existing DB so the status line is informative.
      const chunkCount = readIndexChunkCount(dbPath, nodeBin);
      if (chunkCount !== null) {
        return `✓ Memory index: OK (${chunkCount} chunks)`;
      }
      return "✓ Memory index: OK (DB present, chunk count unavailable)";
    }

    // 3. Rebuild path — ensure node_modules is installed first.
    if (!existsSync(nodeModulesPath)) {
      const installOk = runNpmInstall(npmBin, embedDir);
      if (!installOk) {
        return `⚠️ Memory index: rebuild skipped (npm install failed in ${path.relative(CWD, embedDir)})`;
      }
    }

    // 4. Run the indexer.
    const indexOutput = runIndexer(nodeBin, indexerScript, embedDir);
    if (indexOutput === null) {
      return "⚠️ Memory index: rebuild failed (indexer exited non-zero)";
    }

    // 5. Parse chunk counts from indexer output.
    const chunkMatch = indexOutput.match(/Total chunks:\s+(\d+)/);
    const chunkCount = chunkMatch ? parseInt(chunkMatch[1], 10) : 0;
    const newMatch = indexOutput.match(/New chunks:\s+(\d+)/);
    const newChunks = newMatch ? parseInt(newMatch[1], 10) : 0;
    const updatedMatch = indexOutput.match(/Updated:\s+(\d+)/);
    const updatedChunks = updatedMatch ? parseInt(updatedMatch[1], 10) : 0;
    // Distinguish "rebuilt" (work happened: missing DB or new/updated chunks) from
    // "refreshed" (DB was stale but no memory files changed — re-scan was a no-op).
    const didWork = !dbExists || newChunks > 0 || updatedChunks > 0;
    const reason = !dbExists ? "was missing" : "was stale (>24h)";
    if (didWork) {
      return `✓ Memory index: rebuilt (${chunkCount} chunks, ${reason})`;
    }
    return `✓ Memory index: refreshed (${chunkCount} total, 0 new, 0 updated)`;
  } catch (e) {
    warn(`Memory index check failed: ${e.message}`);
    return `✗ Memory index: FAILED (${e.message})`;
  }
}

// Read the chunk count from an existing FTS5 DB without invoking the full indexer.
// Returns null if the DB can't be opened or the table is missing.
function readIndexChunkCount(dbPath, nodeBin) {
  // Use a tiny inline script so we don't depend on better-sqlite3 in run-compaction.mjs's
  // own context (it lives in the embed-search folder's node_modules). We spawn the bundled
  // node with a short script that requires better-sqlite3 from the embed-search folder.
  const script = `
    const Database = require('better-sqlite3');
    try {
      const db = new Database(${JSON.stringify(dbPath)}, { readonly: true });
      const count = db.prepare('SELECT COUNT(*) FROM memory_chunks').pluck().get();
      db.close();
      process.stdout.write(String(count));
    } catch (e) {
      process.stdout.write('ERROR:' + e.message);
    }
  `;
  try {
    const out = execFileSync(nodeBin, ["-e", script], {
      cwd: path.dirname(dbPath),
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
      timeout: 10000,
    });
    const trimmed = out.trim();
    if (/^\d+$/.test(trimmed)) return parseInt(trimmed, 10);
    return null;
  } catch {
    return null;
  }
}

// Run `npm install` in the embed-search folder. Returns true on success.
function runNpmInstall(npmBin, embedDir) {
  try {
    execWrapped(npmBin, ["install", "--no-audit", "--no-fund"], {
      cwd: embedDir,
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
      timeout: 120000,
    });
    return true;
  } catch (e) {
    warn(`Memory index: npm install failed: ${e.message}`);
    return false;
  }
}

// Run the indexer. Returns stdout string on success (exit 0), null on failure.
function runIndexer(nodeBin, indexerScript, embedDir) {
  try {
    const out = execWrapped(nodeBin, [indexerScript], {
      cwd: embedDir,
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
      timeout: 120000,
    });
    return out;
  } catch (e) {
    warn(`Memory index: indexer failed: ${e.message}`);
    return null;
  }
}

// --- Step 4b: Touch timestamps on all user memory files ---
async function touchAllTimestamps() {
  const userDir = path.join(CWD, "user");
  const files = [
    "main-memory.md",
    "decisions.md",
    "patterns.md",
    "post-mortems.md",
    "reminders.md",
    "forge-log.md",
    "projects/project-list.md",
    "session-dashboard.md",
    "daily-diary",
  ];
  const todayISO = `${todayStr}T00:00:00Z`;
  const results = [];

  for (const f of files) {
    try {
      if (f === "daily-diary") {
        // For diary, try the current date file
        const diaryPath = path.join(userDir, "daily-diary", "current", `${todayStr}.md`);
        try {
          await stat(diaryPath);
          let content = await readFile(diaryPath, "utf-8");
          if (content.includes("timestamp:")) {
            content = content.replace(
              /^(\s*timestamp:\s*).*/m,
              `$1${todayISO}`
            );
            await writeFile(diaryPath, content, "utf-8");
            results.push(`✓ ${f}/current/${todayStr}.md`);
          }
        } catch {
          // diary file doesn't exist yet — skip
        }
        continue;
      }

      const fp = path.join(userDir, f);
      try {
        await stat(fp);
      } catch {
        results.push(`✗ ${f}: not found`);
        continue;
      }

      let content = await readFile(fp, "utf-8");
      if (content.includes("timestamp:")) {
        content = content.replace(
          /^(\s*timestamp:\s*).*/m,
          `$1${todayISO}`
        );
        await writeFile(fp, content, "utf-8");
        results.push(`✓ ${f}`);
      } else {
        results.push(`⚠ ${f}: no timestamp field found`);
      }
    } catch (e) {
      warn(`touchAllTimestamps: ${f} failed: ${e.message}`);
      results.push(`✗ ${f}: ${e.message}`);
    }
  }

  return results;
}

// --- Step 2b: Trim current-session.md (mechanical RAM budget) ---
// The 500-line auto-reset was documented (master-memory.md, session-format.md) but
// never implemented — current-session.md only shrank when Glitch remembered to trim
// it manually. This step makes it mechanical (2026-08-20): archive recaps from past
// sessions, drop ✅ COMPLETED scratchpad entries, enforce a line budget.
const SESSION_RAM_MAX_LINES = 150;

// Pure trim logic — testable without touching the real file.
// Returns { content, archived: [{date, text}], originalCount, newCount, droppedCompleted }
function trimSessionRam(content) {
  const lines = content.split("\n");
  const originalCount = lines.length;

  // Split into top-level sections by "## " headings. Lines before the first
  // "## " heading (title, preamble) are preserved separately.
  const sections = [];
  const preamble = [];
  let current = null;
  for (const line of lines) {
    const m = line.match(/^## (.+)$/);
    if (m) {
      current = { heading: m[1], body: [] };
      sections.push(current);
    } else if (current) {
      current.body.push(line);
    } else {
      preamble.push(line);
    }
  }
  if (sections.length === 0) {
    return { content, archived: [], originalCount, newCount: originalCount, droppedCompleted: 0 };
  }

  // 1. Archive recaps from past sessions — keep only the most recent.
  const recaps = sections.filter((s) => /^Session Recap \((\d{4}-\d{2}-\d{2})\)$/.test(s.heading));
  const archived = [];
  if (recaps.length > 1) {
    recaps.sort((a, b) => {
      const da = a.heading.match(/\((\d{4}-\d{2}-\d{2})\)/)[1];
      const db = b.heading.match(/\((\d{4}-\d{2}-\d{2})\)/)[1];
      return da < db ? 1 : -1;
    });
    for (const r of recaps.slice(1)) {
      const text = [`## ${r.heading}`, ...r.body].join("\n").trim();
      if (text) archived.push({ date: r.heading.match(/\((\d{4}-\d{2}-\d{2})\)/)[1], text });
      sections.splice(sections.indexOf(r), 1);
    }
  }

  // 2. Collapse the scratchpad: drop ✅ COMPLETED entries, keep the rest.
  let droppedCompleted = 0;
  const scratch = sections.find((s) => s.heading.startsWith("Working Memory"));
  if (scratch) {
    const kept = [];
    let inCompleted = false;
    for (const line of scratch.body) {
      if (/^#### ✅ COMPLETED:/.test(line)) {
        inCompleted = true;
        droppedCompleted++;
        continue;
      }
      if (/^#### /.test(line)) {
        inCompleted = false;
      }
      if (!inCompleted) kept.push(line);
    }
    scratch.body = kept;
  }

  // 3. Rebuild — preamble first, then sections.
  const body = sections.map((s) => [`## ${s.heading}`, ...s.body].join("\n")).join("\n\n");
  const rebuilt = preamble.length > 0 ? `${preamble.join("\n")}\n\n${body}` : body;
  const newCount = rebuilt.split("\n").length;
  return { content: rebuilt, archived, originalCount, newCount, droppedCompleted };
}

async function trimCurrentSession() {
  const fp = path.join(CWD, "user", "current-session.md");
  const archiveDir = path.join(CWD, "user", "daily-diary", "archived");
  try {
    const content = await readFile(fp, "utf-8");
    const originalCount = content.split("\n").length;
    if (originalCount <= SESSION_RAM_MAX_LINES) {
      return `✓ Session RAM: ${originalCount} lines (under ${SESSION_RAM_MAX_LINES} budget)`;
    }

    const result = trimSessionRam(content);
    if (result.newCount >= originalCount && result.archived.length === 0) {
      return `⚠️ Session RAM: ${originalCount} lines — trim produced no reduction, review manually`;
    }

    // Clobber guard (2026-09-30, plan 01a0e0c4): the shared scratchpad is now
    // also written by the guarded compaction merge (compaction-diary.ts). Re-read
    // before the trim write; a rival's change aborts this trim (marker left
    // behind; the next compaction retries). Content-based: same-content
    // rewrites are benign, mtime is twitchy on Windows.
    const recheckContent = await readFile(fp, "utf-8");
    if (recheckContent !== content) {
      await mkdir(path.join(CWD, "data"), { recursive: true });
      await writeFile(
        path.join(CWD, "data", "compaction-trim-requeued.txt"),
        `trim skipped: shared scratchpad changed mid-trim at ${new Date().toISOString()}\n`,
        "utf-8"
      );
      return `⚠️ Session RAM: trim requeued — shared file changed mid-trim (marker written)`;
    }

    await writeFile(fp, result.content.replace(/\n+$/, "") + "\n", "utf-8");
    try {
      await rename(path.join(CWD, "data", "compaction-trim-requeued.txt"), path.join(CWD, "data", "compaction-trim-requeued.done.txt"));
    } catch {
      // marker absent on the happy path — nothing to clear
    }

    if (result.archived.length > 0) {
      await mkdir(archiveDir, { recursive: true });
      for (const a of result.archived) {
        const month = a.date.slice(0, 7);
        const archiveFile = path.join(archiveDir, `${month}-session-recaps.md`);
        let archiveContent = "";
        try {
          archiveContent = await readFile(archiveFile, "utf-8");
        } catch {
          // new file
        }
        archiveContent += `\n\n${a.text}\n`;
        await writeFile(archiveFile, archiveContent, "utf-8");
      }
    }

    const parts = [`✓ Session RAM: trimmed ${result.originalCount} → ${result.newCount} lines`];
    if (result.archived.length > 0) parts.push(`archived ${result.archived.length} past recap(s)`);
    if (result.droppedCompleted > 0) parts.push(`dropped ${result.droppedCompleted} completed scratchpad entry(ies)`);
    return parts.join(" | ");
  } catch (e) {
    warn(`Session RAM trim failed: ${e.message}`);
    return `✗ Session RAM: FAILED (${e.message})`;
  }
}

// Stale session-scratchpad dirs (>7d no write) move to user/sessions/archive.
async function archiveStaleScratchpads() {
  try {
    const moved = await archiveStaleSessionDirs(path.join(CWD, "user"));
    return moved.length
      ? `✓ Scratchpads: archived ${moved.length} stale session dir(s): ${moved.slice(0, 3).join(", ")}${moved.length > 3 ? ", …" : ""}`
      : `✓ Scratchpads: no stale session dirs`;
  } catch (e) {
    return `✗ Scratchpads: archive failed (${e.message})`;
  }
}

// --- Main ---
async function main() {
  // ---- Janitor: clean stale flags, old logs, temp dirs (non-blocking) ----
  try {
    const { execFileSync: execSyncFE } = await import("child_process");
    const janitorPath = path.join(__dirname, "janitor.mjs");
    if (existsSync(janitorPath)) {
      execSyncFE(process.execPath, [janitorPath, "--apply"], {
        timeout: 15000,
        stdio: "ignore",
      });
    }
  } catch {
    // janitor failure must never block compaction
  }

  const { due: heavyDue, lastRun: lastHeavyRun } = await shouldRunHeavyChecks();
  const auditResult = await runDataAudit(heavyDue, lastHeavyRun);
  const dataReviewResult = await checkDataReview(heavyDue, lastHeavyRun);
  const memoryIndexResult = await checkMemoryIndex(heavyDue, lastHeavyRun);
  if (heavyDue) {
    await markHeavyChecksRun();
  }
  const results = {
    timestamp: await updateTimestamp(),
    ram: await trimCurrentSession(),
    scratchpads: await archiveStaleScratchpads(),
    diary: await checkDiaryStaleness(),
    curriculum: await checkCurriculum(),
    gc: await checkImageGC(heavyDue, lastHeavyRun),
    git: await checkGit(),
    touches: await touchAllTimestamps(),
    staleness: await checkMemoryStaleness(),
    dashboard: await checkDashboardStaleness(),
    skillImp: await checkSkillImprovements(),
    dataAudit: auditResult.dataAudit,
    quarantineScan: auditResult.quarantineScan,
    dataReview: dataReviewResult,
    memoryIndex: memoryIndexResult,
  };

  // Split GC result into main line + potential alert
  const gcLines = results.gc.split("\n");
  const gcMain = gcLines[0];
  const gcAlert = gcLines.length > 1 ? gcLines.slice(1) : [];

  const lines = [
    "",
    `📋 Compaction Run — ${todayStr}`,
    "",
    "=== Auto-Completed ===",
    results.timestamp,
    results.ram,
    results.scratchpads,
    ...results.touches,
    results.diary,
    results.curriculum,
    gcMain,
    ...results.git.split("\n"),
    results.dataAudit,
    ...results.quarantineScan.split("\n"),
    results.dataReview,
    results.memoryIndex,
    "",
    "=== Action Required ===",
    "⚠️ Step 6 — Pattern scan: Check scratchpad for 3x+ repeated workflows",
    "⚠️ Step 7 — Self-review: Load self-review skill, scan system files",
    "⚠️ Step 8 — Curriculum: Verify next challenge or check cooldown",
    "⚠️ Step 9 — Staleness: Scan main-memory.md for stale refs",
    ...gcAlert,
    "",
    "=== Memory File Staleness ===",
    ...results.staleness.lines,
    ...(results.staleness.hasStale
      ? ["", "📋 Action: Review stale memory files above — promote scratchpad entries, update patterns/forge-log as needed"]
      : []),
    "",
    "=== Dashboard Staleness ===",
    ...results.dashboard.lines,
    ...(results.dashboard.hasStale
      ? ["", "📋 Action: Archive fully-done workstreams to daily-diary/archived/2026-08-session-dashboard-archive.md"]
      : []),
    ...(results.skillImp.hasPending
      ? ["", "=== Skill Improvements Pending ===", ...results.skillImp.lines]
      : []),
    "",
    "=== Suggested Command ===",
    `git add -A && git commit -m "memory: compaction ${todayStr}"`,
    "",
  ];

  console.log(lines.join("\n"));
  process.exit(0);
}

// Only run main() when executed directly — importing for tests must not trigger
// a full compaction run (findStaleDashboardSections is exported for testing).
const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  main().catch((e) => {
    warn(`Fatal: ${e.message}`);
    process.exit(1);
  });
}
