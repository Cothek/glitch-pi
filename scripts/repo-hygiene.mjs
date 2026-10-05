#!/usr/bin/env node
/**
 * repo-hygiene — report-only cleanliness audit across the three-repo system:
 *   1. glitch (main)  : glitch-pi/
 *   2. user           : glitch-pi/user/  (own git repo)
 *   3. memory core    : glitch-pi/glitch-memorycore/  (submodule)
 *
 * Checks per repo:
 *   A. Untracked files (excluding gitignored) — clutter candidates.
 *   B. Backup/temp litter in files on disk (*.bak*, *.tmp, *.orig,
 *      *.old.*, "Copy of", "~*", .pi-tmp).
 *   C. Tracked files untouched in git for > STALE_DAYS (dead-file candidates).
 *   D. Memory frontmatter staleness (user repo): frontmatter `timestamp` older
 *      than the file's last git commit by > 7 days.
 *   E. Orphaned skills (memory core): skill dirs not referenced by any agent
 *      profile in glitch-pi/.pi/agent-profiles/.
 *   F. Janitor dry-run summary (data/ junk) — shells out to scripts/janitor.mjs.
 *
 * NEVER deletes anything. Print, then Troy confirms, then janitor/human acts.
 *
 * Usage: node scripts/repo-hygiene.mjs [--json] [--stale-days N]
 */

import { execFileSync } from 'child_process';
import { readdirSync, readFileSync, existsSync } from 'fs';
import { join, relative, sep, dirname } from 'path';
import { fileURLToPath } from 'url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const ARGS = process.argv.slice(2);
const AS_JSON = ARGS.includes('--json');
const staleIdx = ARGS.indexOf('--stale-days');
const STALE_DAYS = staleIdx !== -1 ? Number(ARGS[staleIdx + 1]) : 180;
const STALE_SEC = STALE_DAYS * 86400;
const NOW = Math.floor(Date.now() / 1000);

const REPOS = [
  { key: 'glitch', path: ROOT },
  { key: 'user', path: join(ROOT, 'user') },
  { key: 'memorycore', path: join(ROOT, 'glitch-memorycore') },
];
const LITTER_RX = /(\.bak[-.]|\.tmp$|\.orig$|\.old\.|Copy of |~$|\.pi-tmp)/i;

function git(cwd, args) {
  try {
    return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch { return ''; }
}

// Skip dirs that are huge, generated, or other repos' business.
const SKIP_DIRS = new Set(['.git', 'node_modules', 'data', 'dist', 'build', '.gitnexus', '.next', 'coverage']);
function walk(dir, base, out = []) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.name.startsWith('.') && e.name !== '.pi') continue;
    const full = join(dir, e.name);
    if (e.isDirectory()) {
      if (SKIP_DIRS.has(e.name)) continue;
      // Do not descend into nested git repos (user/, glitch-memorycore/ audited separately)
      if (existsSync(join(full, '.git')) && full !== base) continue;
      walk(full, base, out);
    } else if (e.isFile()) out.push(full);
  }
  return out;
}

function checkRepo({ key, path }) {
  const r = { repo: key, untracked: [], litter: [], stale: [], frontmatterStale: [], orphanedSkills: [], skillDrift: [], skillRuntimeOnly: [] };
  if (!existsSync(join(path, '.git'))) { r.error = 'not a git repo'; return r; }

  // A. untracked
  const untracked = git(path, ['ls-files', '--others', '--exclude-standard']);
  for (const f of untracked ? untracked.split('\n') : []) {
    if (f.includes('data/')) continue;
    if (key === 'glitch' && (f.startsWith('user/') || f.startsWith('glitch-memorycore/'))) continue;
    r.untracked.push(f);
  }

  // B. litter (scan filesystem, skip heavy dirs)
  for (const f of walk(path, path)) {
    const rel = relative(path, f).split(sep).join('/');
    if (LITTER_RX.test(rel)) r.litter.push(rel);
  }

  // C. stale tracked files (last commit touch per file; skip noisy artifact types)
  const tracked = git(path, ['ls-files']);
  const files = tracked ? tracked.split('\n') : [];
  for (const f of files) {
    if (f.endsWith('.lock') || /\.(png|exe|zip|dll)$/.test(f)) continue;
    const ts = Number(git(path, ['log', '-1', '--format=%ct', '--', f]) || 0);
    if (ts && NOW - ts > STALE_SEC) r.stale.push(`${f} (last touched ${Math.round((NOW - ts) / 86400)}d ago)`);
  }

  // D. frontmatter staleness (user repo memory files)
  if (key === 'user') {
    for (const f of ['main-memory.md', 'decisions.md', 'patterns.md', 'reminders.md', 'post-mortems.md', 'current-session.md']) {
      const p = join(path, f);
      if (!existsSync(p)) continue;
      const head = readFileSync(p, 'utf8').slice(0, 800);
      const m = head.match(/^timestamp:\s*(.+)$/m) || head.match(/Last Memory Update:\s*(.+)$/m);
      if (!m) { r.frontmatterStale.push(`${f} (no timestamp found)`); continue; }
      const ft = Date.parse(m[1].trim());
      const ct = Number(git(path, ['log', '-1', '--format=%ct', '--', f]) || 0) * 1000;
      if (!isNaN(ft) && ct && ct - ft > 7 * 86400 * 1000) {
        r.frontmatterStale.push(`${f} (frontmatter ${Math.round((ct - ft) / 86400000)}d older than last commit)`);
      }
    }
  }

  // E. Orphaned skills: skill dir in memorycore whose name is never referenced
  // anywhere in repo text (agent profiles, AGENTS.md, plugins, scripts, user/)
  // outside the skills source dir itself. Zero references = orphan candidate.
  if (key === 'memorycore') {
    const skillsDir = join(path, 'plugins', 'glitch-skills', 'skills');
    if (existsSync(skillsDir)) {
      let corpus = '';
      const corpusRoots = [
        join(ROOT, '.pi', 'agent-profiles'), join(ROOT, 'AGENTS.md'), join(ROOT, 'scripts'),
        join(ROOT, 'plugins'), join(ROOT, 'user'),
        join(path, 'plugins'), // includes skills dir; filtered below
        join(path, 'README.md'), join(path, 'core'),
      ];
      for (const cr of corpusRoots) {
        if (!existsSync(cr)) continue;
        const files = cr.endsWith('.md') ? [cr] : walk(cr, cr);
        for (const f of files) {
          if (f.startsWith(skillsDir)) continue;
          if (!/\.(md|mjs|ts|tsx|json)$/.test(f)) continue;
          try { corpus += readFileSync(f, 'utf8') + '\n'; } catch {}
        }
      }
      for (const d of readdirSync(skillsDir, { withFileTypes: true })) {
        if (!d.isDirectory()) continue;
        if (!corpus.includes(d.name)) r.orphanedSkills.push(d.name);
      }
    }

    // F. Skills drift: canonical engine source vs the generated runtime tree.
    // `.pi/skills/` is gitignored and rewritten by sync-skills.mjs --pi, so an
    // edit made only there is silently lost on the next sync. Report it instead.
    const runtimeDir = join(ROOT, '.pi', 'skills');
    if (!existsSync(skillsDir) || !existsSync(runtimeDir)) {
      r.skillDrift.push('n/a (engine source or runtime tree missing)');
    } else {
      for (const d of readdirSync(runtimeDir, { withFileTypes: true })) {
        if (!d.isDirectory()) continue;
        const src = join(skillsDir, d.name, 'SKILL.md');
        const tgt = join(runtimeDir, d.name, 'SKILL.md');
        if (!existsSync(src)) { r.skillRuntimeOnly.push(d.name); continue; }
        try {
          if (!readFileSync(src).equals(readFileSync(tgt))) r.skillDrift.push(d.name);
        } catch { r.skillDrift.push(`${d.name} (unreadable)`); }
      }
    }
  }
  return r;
}

function janitorDryRun() {
  try {
    return execFileSync(process.execPath, [join(ROOT, 'scripts', 'janitor.mjs')], { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch (e) { return `janitor failed: ${e.message}`; }
}

const report = { generatedAt: new Date().toISOString(), staleDays: STALE_DAYS, repos: REPOS.map(checkRepo), janitor: janitorDryRun() };

if (AS_JSON) {
  console.log(JSON.stringify(report, null, 2));
} else {
  console.log(`# Repo Hygiene Report — ${report.generatedAt} (stale threshold: ${STALE_DAYS}d)\n`);
  for (const r of report.repos) {
    console.log(`## ${r.repo}`);
    if (r.error) { console.log(`  ! ${r.error}\n`); continue; }
    const rows = [
      ['Untracked files', r.untracked], ['Backup/temp litter', r.litter],
      [`Stale tracked files (>${STALE_DAYS}d)`, r.stale],
      ['Frontmatter staleness', r.frontmatterStale], ['Orphaned skills (unreferenced)', r.orphanedSkills],
      ['Skills: source/tree drift (edit the engine source, never .pi/skills)', r.skillDrift],
      ['Skills: in runtime tree only (would be lost on sync)', r.skillRuntimeOnly],
    ];
    let any = false;
    for (const [label, items] of rows) {
      if (!items.length) continue;
      any = true;
      console.log(`  ${label} (${items.length}):`);
      for (const i of items.slice(0, 25)) console.log(`    - ${i}`);
      if (items.length > 25) console.log(`    … +${items.length - 25} more`);
    }
    if (!any) console.log('  clean');
    console.log();
  }
  console.log('## Janitor dry-run (data/)');
  console.log(report.janitor.split('\n').map(l => '  ' + l).join('\n'));
  console.log('\nReport-only. Nothing was deleted.');
}
