#!/usr/bin/env node
/**
 * self-metrics — one-glance self-improvement metrics for the dashboard.
 *
 * Reads five sources and prints a paste-ready markdown block
 * (drop it into user/session-dashboard.md):
 *   - .pi/skills/                                    → installed skills (dirs with SKILL.md)
 *   - glitch-memorycore/plugins/glitch-skills/skills-registry.md → Auto-Created skill entries
 *   - plugins/tools/                                 → saved .mjs tools
 *   - plugins/curriculum/curriculum-state.json       → level + completed challenges
 *   - user/post-mortems.md                           → entries (## PM-NNN or ## date headings)
 *
 * Every source is read defensively: a missing or malformed file prints `n/a`
 * for its metrics — the script never crashes. Exit code is always 0.
 *
 * Usage: node scripts/self-metrics.mjs
 */

import { readdirSync, readFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/** Run a collector; any throw or null/undefined result degrades to `fallback`. */
function safe(collect, fallback = 'n/a') {
  try {
    const value = collect();
    return value === undefined || value === null ? fallback : value;
  } catch {
    return fallback;
  }
}

/** Installed skills = directories under .pi/skills/ that contain a SKILL.md. */
function countSkills() {
  const dir = join(ROOT, '.pi', 'skills');
  return readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .filter((entry) => existsSync(join(dir, entry.name, 'SKILL.md')))
    .length;
}

/** Auto-Created entries = table rows under the "## Auto-Created Skills" heading. */
function countAutoCreated() {
  const file = join(ROOT, 'glitch-memorycore', 'plugins', 'glitch-skills', 'skills-registry.md');
  const lines = readFileSync(file, 'utf8').split(/\r?\n/);
  let inSection = false;
  let rows = 0;
  for (const line of lines) {
    if (/^##\s/.test(line)) {
      inSection = /^##\s+Auto-Created/i.test(line);
      continue;
    }
    if (!inSection) continue;
    const trimmed = line.trim();
    if (!trimmed.startsWith('|')) continue;
    if (/^\|[\s:|-]+$/.test(trimmed)) continue; // separator row
    const firstCell = (trimmed.split('|')[1] ?? '').trim().toLowerCase();
    if (firstCell === 'skill') continue; // header row
    rows += 1;
  }
  return rows;
}

/** Saved tools = .mjs files in plugins/tools/. */
function countTools() {
  return readdirSync(join(ROOT, 'plugins', 'tools'))
    .filter((name) => name.endsWith('.mjs'))
    .length;
}

/** Curriculum level + completed-challenge count (state file carries a BOM). */
function readCurriculum() {
  const file = join(ROOT, 'plugins', 'curriculum', 'curriculum-state.json');
  const raw = readFileSync(file, 'utf8').replace(/^\uFEFF/, '');
  const state = JSON.parse(raw);
  const completed = Array.isArray(state.completedChallenges)
    ? state.completedChallenges.length
    : 'n/a';
  return { level: state.level ?? 'n/a', completed };
}

/** Post-mortem entries = `## PM-NNN` or `## YYYY-MM-DD` headings (excludes `## Rules`). */
function countPostMortems() {
  const file = join(ROOT, 'user', 'post-mortems.md');
  return readFileSync(file, 'utf8')
    .split(/\r?\n/)
    .filter((line) => /^##\s+(PM-\d+|\d{4}-\d{2}-\d{2})/.test(line)).length;
}

const skills = safe(countSkills);
const autoCreated = safe(countAutoCreated);
const tools = safe(countTools);
const { level, completed } = safe(readCurriculum, { level: 'n/a', completed: 'n/a' });
const postMortems = safe(countPostMortems);
const date = new Date().toISOString().slice(0, 10);

const lines = [
  `## Self-Improvement Metrics — ${date}`,
  '',
  '| Metric | Value |',
  '|---|---|',
  `| Skills installed (.pi/skills/) | ${skills} |`,
  `| Auto-created skills (registry) | ${autoCreated} |`,
  `| Tools in plugins/tools/ | ${tools} |`,
  `| Curriculum level | ${level} |`,
  `| Curriculum challenges completed | ${completed} |`,
  `| Post-mortems recorded | ${postMortems} |`,
  '',
];

console.log(lines.join('\n'));
