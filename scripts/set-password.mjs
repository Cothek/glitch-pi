#!/usr/bin/env node
// scripts/set-password.mjs - DEPRECATED forwarder.
//
// The login is now username + password, so this moved to set-credentials.mjs.
// Kept as a shim because the old command is documented and habitual.
//
// Behaviour is preserved: no arguments rotates the password (random), which is
// exactly what `node scripts/set-credentials.mjs` does.
//
// Use instead:
//   node scripts/set-credentials.mjs                        rotate the password
//   node scripts/set-credentials.mjs --username <name>      change the username
//   node scripts/set-credentials.mjs --show                 show current state

import { spawnSync } from 'child_process';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const here = dirname(fileURLToPath(import.meta.url));
const target = join(here, 'set-credentials.mjs');

console.error('  note: set-password.mjs is now set-credentials.mjs (username + password). Forwarding...');

const result = spawnSync(process.execPath, [target, ...process.argv.slice(2)], { stdio: 'inherit' });
process.exit(result.status ?? 1);
