#!/usr/bin/env node
/**
 * init-project — scaffold a project to the Glitch baseline
 * (docs/engineering-standards.md §5). Idempotent: never overwrites existing
 * files; reports created vs skipped.
 *
 * Creates in the target repo:
 *   - AGENTS.md          (if absent) linking to engineering standards +
 *                        the GitNexus "Always Do / Never Do" block
 *   - ARCHITECTURE.md    (if absent) the project's driving structure document
 *   - .gitignore         (baseline entries appended if missing)
 *   - .editorconfig      (if absent)
 *   - .gitnexus index    (when --with-gitnexus and the repo has code files)
 *   - data/scratch/      disposable scratch dir (gitignored)
 *
 * Usage:
 *   node scripts/init-project.mjs <project-path> [--with-gitnexus] [--dry-run]
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync, appendFileSync, readdirSync } from 'fs';
import { join, resolve } from 'path';
import { execFileSync } from 'child_process';
import { fileURLToPath } from 'url';
import { dirname } from 'path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const targetArg = args.find(a => !a.startsWith('--'));
const WITH_GITNEXUS = args.includes('--with-gitnexus');
const DRY_RUN = args.includes('--dry-run');

if (!targetArg) {
  console.error('Usage: node scripts/init-project.mjs <project-path> [--with-gitnexus] [--dry-run]');
  process.exit(1);
}
const TARGET = resolve(targetArg);
if (!existsSync(TARGET)) { console.error(`Path does not exist: ${TARGET}`); process.exit(1); }

const created = [], appended = [], skipped = [], warnings = [];
function writeIfAbsent(rel, content) {
  const p = join(TARGET, rel);
  if (existsSync(p)) { skipped.push(rel); return; }
  if (!DRY_RUN) writeFileSync(p, content, 'utf8');
  created.push(rel);
}
function appendMissing(rel, lines) {
  const p = join(TARGET, rel);
  if (!existsSync(p)) { if (!DRY_RUN) writeFileSync(p, lines.join('\n') + '\n', 'utf8'); created.push(rel); return; }
  const cur = readFileSync(p, 'utf8');
  const missing = lines.filter(l => !cur.split('\n').some(x => x.trim() === l));
  if (!missing.length) { skipped.push(rel); return; }
  if (!DRY_RUN) appendFileSync(p, '\n# --- glitch baseline ---\n' + missing.join('\n') + '\n', 'utf8');
  appended.push(`${rel} (+${missing.length} entries)`);
}

const AGENTS_MD = `# Project Instructions (Glitch)

Standards: follow **Glitch Engineering Standards** (glitch-pi \`docs/engineering-standards.md\`).
Structure: read **ARCHITECTURE.md** first. It is the driving structure document for this project.
Definition of done: runs, reviewed (fresh PASS marker before commit), tested when a test setup exists, conventional commit, docs updated.

## Always Do

- MUST run GitNexus \`impact\` before editing a symbol in an indexed repo; \`detect_changes\` before committing.
- MUST treat impact \`risk: UNKNOWN\` as unresolved — confirm by text search before proceeding.
- Keep the file-category rule: engine (committed) / scratch (\`data/scratch/\`, disposable) / logs (\`data/logs/\`, disposable).

## Never Do

- NEVER commit secrets, tokens, or \`*.key\` files.
- NEVER use \`git commit --no-verify\` unless the user explicitly accepts the risk.
- NEVER leave dead code — delete it; git remembers.
`;

// Sibling driving doc: AGENTS.md points readers here for project structure.
const ARCHITECTURE_TEMPLATE = `# <Project Name> Architecture

Parent standard: glitch-pi \`docs/engineering-standards.md\`. Replace <Project Name> with this repo's name.

## Purpose

What this project is for and who it serves. Two sentences maximum.

## Goals

Numbered list. Short, measurable statements of what success means.

## Non-Goals

What this project deliberately does not do, and why. One item per line.

## System Shape

The main components and how they connect. A short text diagram is fine.

## Data and State

Where data lives, what persists, and what is disposable.

## Invariants

Rules that must never break. One rule per line, no exceptions.

## Key Decisions

Add one row per decision that shaped this architecture.

| Date | Decision | Why |
| ---- | -------- | --- |

## Change Log

One row per structural change to this architecture.

| Date | Change | Why |
| ---- | ------ | --- |
|      |        |     |
`;

const GITIGNORE_BASELINE = [
  'node_modules/', '.env', '.env.*', '*.key', '*.pem', 'auth.json',
  'data/logs/', 'data/scratch/', 'data/*.log', '*.bak-*', '*.tmp', '*.orig',
  'Thumbs.db', '.DS_Store', '.vscode/', '.idea/',
];

const EDITORCONFIG = `root = true

[*]
charset = utf-8
end_of_line = lf
insert_final_newline = true
trim_trailing_whitespace = true
indent_style = space
indent_size = 2
`;

writeIfAbsent('AGENTS.md', AGENTS_MD);
writeIfAbsent('ARCHITECTURE.md', ARCHITECTURE_TEMPLATE);
appendMissing('.gitignore', GITIGNORE_BASELINE);
writeIfAbsent('.editorconfig', EDITORCONFIG);
const scratchGitkeep = join(TARGET, 'data', 'scratch', '.gitkeep');
if (!existsSync(scratchGitkeep)) {
  if (!DRY_RUN) {
    mkdirSync(dirname(scratchGitkeep), { recursive: true });
    writeFileSync(scratchGitkeep, '', 'utf8');
  }
  created.push('data/scratch/');
}

// GitNexus: index code-heavy repos when asked (or warn when clearly code-heavy but flag omitted)
function looksCodeHeavy() {
  try {
    const out = execFileSync('git', ['ls-files'], { cwd: TARGET, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    return out.split('\n').filter(f => /\.(ts|tsx|js|jsx|mjs|py|go|rs)$/.test(f)).length >= 10;
  } catch { return false; }
}
if (WITH_GITNEXUS) {
  if (!DRY_RUN) {
    try {
      execFileSync('npx', ['--yes', 'gitnexus@latest', 'analyze', '--index-only'], { cwd: TARGET, stdio: 'inherit', shell: process.platform === 'win32' });
      created.push('.gitnexus/ (index)');
    } catch (e) { warnings.push(`gitnexus analyze failed: ${e.message}`); }
  } else {
    created.push('.gitnexus/ (index, dry-run)');
  }
} else if (looksCodeHeavy()) {
  warnings.push('Repo looks code-heavy (>=10 code files) but --with-gitnexus was not passed. Re-run with it to enable impact/detect_changes gates.');
}

console.log(`\ninit-project ${DRY_RUN ? '(dry-run) ' : ''}→ ${TARGET}`);
if (created.length) console.log('  created:   ' + created.join(', '));
if (appended.length) console.log('  appended:  ' + appended.join(', '));
if (skipped.length) console.log('  unchanged: ' + skipped.join(', '));
for (const w of warnings) console.log('  ! ' + w);
if (!created.length && !appended.length) console.log('  already at baseline');
