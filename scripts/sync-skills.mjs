#!/usr/bin/env node
/**
 * sync-skills.mjs — engine skills tree → harness runtime trees
 *
 * SOURCE OF TRUTH:
 *   glitch-memorycore/plugins/glitch-skills/skills/   (65 skills, lives in Cothek/glitch-engine)
 *
 * TARGETS (generated; safe to overwrite):
 *   .agents/skills/     RETIRED in this fork (OpenCode runtime); --pi writes .pi/skills only
 *                       and prunes the mirror when it is a pure generated copy.
 *   .pi/skills/         Pi runtime (created only with --pi; used after glitch-pi fork)
 *
 * Usage:
 *   node scripts/sync-skills.mjs           # sync engine → .agents/skills (legacy)
 *   node scripts/sync-skills.mjs --pi      # sync engine → .pi/skills (and prune .agents/skills)
 *   node scripts/sync-skills.mjs --check   # dry-run: report drift, write nothing
 *
 * Design notes:
 * - Additive+overwrite only: files in targets that also exist in source are replaced;
 *   target-only skill dirs are REPORTED but not deleted (manual review — may be
 *   harness-specific experiments). Exit code 0 either way unless --strict.
 * - --strict: exit 1 if any drift or target-only skill found (for CI/launch gating).
 * - Migration completed: .agents/skills is gitignored + untracked + no longer generated
 *   by --pi runs. Plain (non --pi) runs still write .agents/skills for legacy callers.
 */

import { cpSync, existsSync, mkdirSync, readdirSync, rmSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const rootDir = join(dirname(fileURLToPath(import.meta.url)), '..');
const SOURCE = join(rootDir, 'glitch-memorycore', 'plugins', 'glitch-skills', 'skills');
const PI_TARGET = join(rootDir, '.pi', 'skills');
const AGENTS_TARGET = join(rootDir, '.agents', 'skills');

const args = process.argv.slice(2);
const wantPi = args.includes('--pi');
const checkOnly = args.includes('--check');
const strict = args.includes('--strict');
// --pi writes ONLY .pi/skills and prunes the retired .agents/skills mirror.
// Plain (non --pi) runs keep the legacy .agents target.
const TARGETS = wantPi ? [PI_TARGET] : [AGENTS_TARGET];

if (!existsSync(SOURCE)) {
  console.error(`FATAL: source tree missing: ${SOURCE}`);
  console.error('Is the glitch-memorycore submodule initialized? (git submodule update --init)');
  process.exit(2);
}

const listSkillDirs = (base) =>
  readdirSync(base, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
    .sort();

const sourceSkills = listSkillDirs(SOURCE);
console.log(`Source: ${SOURCE}`);
console.log(`  ${sourceSkills.length} skills`);
if (checkOnly) console.log('Mode: CHECK (dry-run, no writes)\n');
else console.log(`Mode: SYNC${strict ? ' (strict)' : ''}\n`);

let drift = 0;
let targetOnlyTotal = 0;
let wrote = 0;

for (const target of TARGETS) {
  const label = target.replace(rootDir + '\\', '').replace(rootDir + '/', '');
  console.log(`→ ${label}`);

  if (!existsSync(target)) {
    if (checkOnly) {
      console.log('  MISSING (would be created on sync)');
      drift++;
      continue;
    }
    mkdirSync(target, { recursive: true });
    console.log('  created');
  }

  const targetSkills = existsSync(target) ? listSkillDirs(target) : [];
  const targetOnly = targetSkills.filter((n) => !sourceSkills.includes(n));
  const sourceOnly = sourceSkills.filter((n) => !targetSkills.includes(n));
  const common = sourceSkills.filter((n) => targetSkills.includes(n));

  if (targetOnly.length) {
    targetOnlyTotal += targetOnly.length;
    console.log(`  target-only (kept, review manually): ${targetOnly.join(', ')}`);
  }
  if (sourceOnly.length) {
    console.log(`  will add: ${sourceOnly.join(', ')}`);
    drift += sourceOnly.length;
  }

  if (checkOnly) {
    // cheap drift probe: compare SKILL.md bytes for common skills
    for (const name of common) {
      const a = join(SOURCE, name, 'SKILL.md');
      const b = join(target, name, 'SKILL.md');
      if (!existsSync(a) || !existsSync(b)) { drift++; continue; }
      const sa = statSync(a);
      const sb = statSync(b);
      if (sa.size !== sb.size) drift++;
    }
    console.log(`  ${common.length} common, drift signals so far: ${drift}`);
    continue;
  }

  for (const name of sourceSkills) {
    cpSync(join(SOURCE, name), join(target, name), { recursive: true, force: true });
    wrote++;
  }
  console.log(`  synced ${sourceSkills.length} skill dirs (force overwrite)`);
}

console.log('');
if (checkOnly) {
  console.log(drift === 0 && targetOnlyTotal === 0
    ? 'CHECK OK: trees in sync.'
    : `CHECK: ${drift} drift signal(s), ${targetOnlyTotal} target-only dir(s).`);
} else {
  console.log(`Done: copied ${wrote} skill dir(s) across ${TARGETS.length} target(s).`);
  if (targetOnlyTotal) console.log(`Note: ${targetOnlyTotal} target-only dir(s) left in place (not in source).`);
}

// After a successful --pi sync, prune the retired .agents/skills mirror if it
// is a pure generated copy (every entry is a directory whose name also lives
// under SOURCE or .pi/skills). If any entry looks local, keep the directory and
// log a single line so the user can decide. Prune failures warn and never fail
// the sync.
if (wantPi && !checkOnly && existsSync(AGENTS_TARGET)) {
  try {
    const mirrorEntries = readdirSync(AGENTS_TARGET, { withFileTypes: true });
    const piEntries = existsSync(PI_TARGET)
      ? readdirSync(PI_TARGET, { withFileTypes: true }).map((d) => d.name)
      : [];
    const sourceNames = sourceSkills;
    let pure = true;
    let localEntry = null;
    for (const entry of mirrorEntries) {
      if (!entry.isDirectory()) { pure = false; localEntry = entry.name; break; }
      if (!sourceNames.includes(entry.name) && !piEntries.includes(entry.name)) {
        pure = false;
        localEntry = entry.name;
        break;
      }
    }
    if (pure) {
      rmSync(AGENTS_TARGET, { recursive: true, force: true });
      console.log(`pruned retired mirror .agents/skills (${mirrorEntries.length} entries)`);
    } else {
      console.log(`kept .agents/skills (not a pure mirror - ${localEntry} is local)`);
    }
  } catch (err) {
    console.warn(`warning: failed to prune .agents/skills: ${err && err.message ? err.message : err}`);
  }
}
if (strict && (drift > 0 || targetOnlyTotal > 0)) process.exit(1);
process.exit(0);
