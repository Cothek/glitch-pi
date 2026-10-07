// Shared helper for review-pass marker file validation.
// Used by both write-review-pass.mjs and check-review-pass.mjs.

import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { execSync } from 'node:child_process';

/**
 * Check if a file exists on disk or on a git branch ref.
 * @param {string} file - relative file path
 * @param {string} rootDir - repo root directory
 * @param {string|null} branchRef - git ref (e.g. "origin/main") or null for disk-only
 * @returns {{ exists: boolean, source: 'disk' | 'branch' | null }}
 */
export function fileExistsOnDiskOrBranch(file, rootDir, branchRef = null) {
  const absolute = resolve(rootDir, file);
  if (existsSync(absolute)) {
    return { exists: true, source: 'disk' };
  }
  if (branchRef) {
    try {
      const output = execSync(`git rev-parse "${branchRef}:${file}"`, {
        cwd: rootDir,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      }).trim();
      if (/^[0-9a-f]{40}$/.test(output)) {
        return { exists: true, source: 'branch' };
      }
    } catch {
      // file doesn't resolve on the branch
    }
  }
  return { exists: false, source: null };
}
