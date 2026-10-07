#!/usr/bin/env node
/**
 * Glitch AI -- Root Record Writer
 *
 * Records WHERE the install root is, INSIDE the root, so diagnostics and
 * humans can find this Glitch install without guessing. Writes
 * data/config/root.json: { root, writtenAt, node }.
 *
 * Run: node scripts/write-root-record.mjs [rootDir]
 *   [rootDir]  Install root to record. Default: the parent of this
 *              script's directory (the repo root when run in place).
 *
 * Uses node:fs and node:path only -- no dependencies.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

// Install root: CLI arg wins; default is the parent of the script's directory.
const rootArg = process.argv[2];
const scriptDir = dirname(resolve(process.argv[1] || '.'));
const ROOT_DIR = rootArg ? resolve(rootArg) : resolve(scriptDir, '..');

const configDir = join(ROOT_DIR, 'data', 'config');
const record = {
  root: ROOT_DIR.replace(/\\/g, '/'),
  writtenAt: new Date().toISOString(),
  node: process.version,
};

mkdirSync(configDir, { recursive: true });
writeFileSync(join(configDir, 'root.json'), `${JSON.stringify(record, null, 2)}\n`, 'utf8');

console.log('  root recorded at data/config/root.json');
