#!/usr/bin/env node

// Pure-Node self-test for scripts/check-updates.mjs. No test framework,
// no new dependencies. Prints one `PASS: <name>` line per assertion group,
// exits 0 on success or 1 on failure.

import assert from 'node:assert';
import { spawnSync } from 'node:child_process';
import { readFileSync, existsSync, rmSync, mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { tmpdir } from 'node:os';

const __filename = fileURLToPath(import.meta.url);
const __dirname  = dirname(__filename);
const SCRIPTS_DIR = join(__dirname, '..');
const REPO_ROOT = join(SCRIPTS_DIR, '..');
const MANIFEST = join(REPO_ROOT, 'config', 'tools.json');
const CHECK_UPDATES = pathToFileURL(join(SCRIPTS_DIR, 'check-updates.mjs')).href;
const CHECK_UPDATES_FILE = join(SCRIPTS_DIR, 'check-updates.mjs');
const LAUNCHER_FILE = join(SCRIPTS_DIR, 'launch-unified.mjs');
const RESTART_PS1_FILE = join(SCRIPTS_DIR, 'restart-pi-stack.ps1');

// Explicit timeout for every child process this suite spawns. The apply paths
// used here match no manifest tool, so they never touch npm or GitHub and
// finish in seconds. --check-only may legitimately reach npm and GitHub and
// must be allowed to fail slowly (per-call timeouts inside the checker) when
// the network is gone; its bound is generous on purpose.
const CHILD_TIMEOUT_MS = 90_000;
const CHECK_ONLY_TIMEOUT_MS = 600_000;

function runCli(args, timeoutMs) {
  return spawnSync(process.execPath, [CHECK_UPDATES_FILE, ...args], {
    encoding: 'utf8',
    timeout: timeoutMs,
    windowsHide: true
  });
}

function readSourceLines(absPath) {
  return readFileSync(absPath, 'utf8').split(/\r?\n/);
}

// 0-based index of the first line matching re. Throws with a readable label
// so a failing static assertion names the file and the construct it missed.
function lineOf(lines, re, file, label) {
  const i = lines.findIndex((l) => re.test(l));
  if (i === -1) throw new Error(`${file}: expected a line matching ${label || re}`);
  return i;
}

const REQUIRED_TOOLS = ['pi-coding-agent', 'pi-web-ui', 'gitnexus', 'cloudflared'];

let failed = 0;
function pass(name) {
  console.log(`PASS: ${name}`);
}
function fail(name, err) {
  failed++;
  console.error(`FAIL: ${name}`);
  if (err && err.message) console.error(`  ${err.message}`);
}

async function run(name, fn) {
  try {
    const detail = await fn();
    // Groups may return evidence text (line numbers, counts) that is appended
    // to the PASS line so the proof stays visible without opening the source.
    console.log(`PASS: ${name}${detail ? ` [${detail}]` : ''}`);
  } catch (err) {
    fail(name, err);
  }
}

// ── (a) manifest shape ──────────────────────────────────────────────────────

async function testManifestShape() {
  await run('manifest parses and has 4 required entries with required fields', async () => {
    assert.ok(existsSync(MANIFEST), `missing ${MANIFEST}`);
    const manifest = JSON.parse(readFileSync(MANIFEST, 'utf8'));
    assert.ok(Array.isArray(manifest.tools), 'manifest.tools must be an array');

    const byName = new Map();
    for (const tool of manifest.tools) byName.set(tool.name, tool);

    for (const name of REQUIRED_TOOLS) {
      const t = byName.get(name);
      assert.ok(t, `manifest is missing entry ${name}`);
      assert.strictEqual(typeof t.name, 'string');
      assert.ok(['npm', 'binary'].includes(t.type), `bad type for ${name}`);
      assert.strictEqual(typeof t.restartRequired, 'boolean', `restartRequired missing/bad for ${name}`);
      assert.ok(['sync', 'manual', 'none'].includes(t.updateType), `updateType bad for ${name}`);
    }

    const pi = byName.get('pi-coding-agent');
    assert.strictEqual(pi.type, 'npm');
    assert.strictEqual(pi.package, '@earendil-works/pi-coding-agent');
    assert.strictEqual(pi.binary, 'pi');
    assert.strictEqual(pi.restartRequired, true);
    assert.strictEqual(pi.updateType, 'sync');

    const ui = byName.get('pi-web-ui');
    assert.strictEqual(ui.type, 'npm');
    assert.strictEqual(ui.package, 'pi-web-ui');
    assert.strictEqual(ui.restartRequired, true);
    assert.strictEqual(ui.updateType, 'sync');

    const gn = byName.get('gitnexus');
    assert.strictEqual(gn.type, 'npm');
    assert.strictEqual(gn.package, 'gitnexus');
    assert.strictEqual(gn.restartRequired, false);
    assert.strictEqual(gn.updateType, 'sync');

    const cf = byName.get('cloudflared');
    assert.strictEqual(cf.type, 'binary');
    assert.strictEqual(cf.binary, 'cloudflared.exe');
    assert.strictEqual(cf.restartRequired, true);
    assert.strictEqual(cf.updateType, 'sync');
    assert.strictEqual(cf.latestUrl, 'https://github.com/cloudflare/cloudflared/releases/latest');
    assert.ok(cf.platforms?.win32?.url, 'missing win32 url');
    assert.deepStrictEqual(cf.platforms.win32.extract, ['cloudflared.exe']);
    assert.ok(cf.platforms?.linux?.url, 'missing linux url');
    assert.ok(cf.platforms?.darwin?.url, 'missing darwin url');

    // Top-level $schema and description preserved.
    assert.strictEqual(typeof manifest.$schema, 'string');
    assert.strictEqual(typeof manifest.description, 'string');
  });
}

// ── (b) status file shape after a mocked check ──────────────────────────────

async function importModule() {
  // dynamic import so any throw shows up in the runner
  return import(CHECK_UPDATES);
}

async function testStatusFileShape() {
  await run('status file shape after a mocked check', async () => {
    const mod = await importModule();
    // Build a fake cwd that has a manifest and a fake node_modules tree.
    const fakeRoot = mkdtempSync(join(tmpdir(), 'check-updates-test-'));
    const fakeManifestPath = join(fakeRoot, 'config', 'tools.json');
    mkdirSync(dirname(fakeManifestPath), { recursive: true });
    writeFileSync(fakeManifestPath, JSON.stringify({
      "$schema": "config/tools-schema.json",
      "description": "test",
      "tools": [
        {
          name: 'fake-tool',
          type: 'npm',
          package: 'fake-tool',
          binary: 'fake',
          version: '',
          platforms: {},
          restartRequired: false,
          updateType: 'manual'  // short-circuits the network path
        }
      ]
    }, null, 2));

    // Patch readNpmInstalledVersion behavior by stubbing the manifest to use
    // updateType 'manual' so no network call fires for a missing pkg.
    const status = await mod.checkUpdatesOnly({ cwd: fakeRoot });

    assert.ok(status && typeof status === 'object', 'status returned');
    assert.strictEqual(typeof status.checked_at, 'string');
    assert.ok(status.checked_at.length > 0, 'checked_at is non-empty');
    assert.strictEqual(status.checked, true);
    assert.strictEqual(typeof status.updates_available, 'number');
    assert.ok(Array.isArray(status.items), 'items is an array');
    assert.ok(Array.isArray(status.errors), 'errors is an array');

    const item = status.items[0];
    assert.ok(item, 'first item exists');
    for (const key of [
      'name', 'current', 'latest', 'update_available',
      'update_type', 'restart_required', 'status'
    ]) {
      assert.ok(key in item, `missing key ${key}`);
    }
    assert.strictEqual(item.name, 'fake-tool');
    assert.strictEqual(typeof item.update_available, 'boolean');
    assert.ok(['none', 'sync', 'manual'].includes(item.update_type));

    // Status file must exist on disk.
    const statusFile = join(fakeRoot, 'data', 'update-status.json');
    assert.ok(existsSync(statusFile), `missing ${statusFile}`);
    const onDisk = JSON.parse(readFileSync(statusFile, 'utf8'));
    assert.strictEqual(onDisk.checked, true);
    assert.strictEqual(typeof onDisk.checked_at, 'string');

    try { rmSync(fakeRoot, { recursive: true, force: true }); } catch {}
  });
}

// ── (c) semver-ish comparison helper ───────────────────────────────────────

async function testIsHigher() {
  await run('isHigher handles equal/higher/lower/prerelease and false for null/unknown', async () => {
    const mod = await importModule();
    const isHigher = mod.isHigher;

    assert.strictEqual(isHigher('1.2.3', '1.2.2'), true, 'patch up');
    assert.strictEqual(isHigher('1.3.0', '1.2.99'), true, 'minor up');
    assert.strictEqual(isHigher('2.0.0', '1.99.0'), true, 'major up');
    assert.strictEqual(isHigher('1.2.3', '1.2.3'), false, 'equal');
    assert.strictEqual(isHigher('1.2.2', '1.2.3'), false, 'lower');
    assert.strictEqual(isHigher('v1.2.3', 'v1.2.2'), true, 'leading v');
    assert.strictEqual(isHigher('1.2.3', '1.2.4'), false, 'current newer');
    assert.strictEqual(isHigher('1.2.3-rc', '1.2.3'), false, 'prerelease < stable');
    assert.strictEqual(isHigher('1.2.3', '1.2.3-rc'), true, 'stable > prerelease');
    assert.strictEqual(isHigher('1.2.3-rc.2', '1.2.3-rc.1'), true, 'prerelease higher');
    assert.strictEqual(isHigher(null, '1.2.3'), false, 'null latest');
    assert.strictEqual(isHigher('1.2.3', null), false, 'null current');
    assert.strictEqual(isHigher(undefined, undefined), false, 'both undefined');
    assert.strictEqual(isHigher('not.a.version', '1.2.3'), false, 'garbage latest');
    assert.strictEqual(isHigher('1.2.3', 'garbage'), false, 'garbage current');
  });
}

// ── (d) --check-only path returns without applying ──────────────────────────

async function testCheckOnlyNoApply() {
  await run('--check-only path returns without applying', async () => {
    // We invoke the real CLI. The 4 entries in the real manifest are npm
    // packages installed locally, plus a binary with a github latestUrl.
    // Without mocking, this exercises the "everything already up to date or
    // current" path which is exactly what --check-only should do: read,
    // report, never write to anything except data/update-status.json.
    const fakeRoot = mkdtempSync(join(tmpdir(), 'check-updates-checkonly-'));
    const fakeManifestPath = join(fakeRoot, 'config', 'tools.json');
    mkdirSync(dirname(fakeManifestPath), { recursive: true });
    writeFileSync(fakeManifestPath, JSON.stringify({
      "$schema": "config/tools-schema.json",
      "description": "test",
      "tools": [
        // Manual entries never trigger an apply.
        { name: 'no-apply-1', type: 'npm',  package: 'fake-pkg-1', binary: 'fake1', version: '', platforms: {}, restartRequired: false, updateType: 'manual' },
        { name: 'no-apply-2', type: 'binary', binary: 'fake2.exe', version: '', platforms: {}, restartRequired: false, updateType: 'manual', latestUrl: '' }
      ]
    }, null, 2));

    // Dynamic import and direct invocation - no shell, no apply.
    const mod = await importModule();
    const status = await mod.checkUpdatesOnly({ cwd: fakeRoot });
    assert.ok(status, 'status returned');
    assert.strictEqual(status.checked, true);
    assert.strictEqual(status.updates_available, 0);
    assert.strictEqual(status.items.length, 2);

    // And applyAllUpdates on a manual-only manifest is a no-op.
    const applied = await mod.applyAllUpdates({ cwd: fakeRoot });
    assert.deepStrictEqual(applied, { applied: [], failed: [] });

    try { rmSync(fakeRoot, { recursive: true, force: true }); } catch {}
  });
}

// ── (e) CLI contract: --apply --json with a filter that matches nothing ──────

// Safety note for every CLI group below: the only invocations allowed are
// --check-only and --apply with a --filter that matches no real tool.
// 'nosuchtool' matches nothing in the real manifest, and both the pre-flight
// loop and applyAllUpdates skip every entry before any version lookup, so
// these runs make no network call and can never install anything.

async function testApplyJsonNothingToApply() {
  await run('--apply --json --filter nosuchtool exits 0 with empty applied and failed arrays', async () => {
    const res = runCli(['--apply', '--json', '--filter', 'nosuchtool'], CHILD_TIMEOUT_MS);
    if (res.error) throw new Error(`child failed to run: ${res.error}`);
    assert.strictEqual(res.status, 0, `expected exit 0, got ${res.status}; stderr: ${res.stderr || '(empty)'}`);
    assert.ok(res.stdout.trim().length > 0, 'stdout must contain the JSON result');
    const parsed = JSON.parse(res.stdout);
    assert.ok(Array.isArray(parsed.applied), 'result.applied must be an array');
    assert.ok(Array.isArray(parsed.failed), 'result.failed must be an array');
    assert.strictEqual(parsed.applied.length, 0, 'nothing matched the filter, applied must be empty');
    assert.strictEqual(parsed.failed.length, 0, 'nothing matched the filter, failed must be empty');
  });
}

// ── (f) CLI contract: human-readable --apply with no filter match ────────────

async function testApplyHumanNothingToApply() {
  await run('--apply --filter nosuchtool without --json exits 0 and prints only the Nothing-to-update line', async () => {
    const res = runCli(['--apply', '--filter', 'nosuchtool'], CHILD_TIMEOUT_MS);
    if (res.error) throw new Error(`child failed to run: ${res.error}`);
    assert.strictEqual(res.status, 0, `expected exit 0, got ${res.status}; stderr: ${res.stderr || '(empty)'}`);
    // Documented contract: with a non-matching filter and no --json, stdout is
    // exactly the one human-readable line naming the filter.
    assert.match(
      res.stdout,
      /^ {2}Nothing to update \(filter: nosuchtool\)\.\r?\n?$/,
      `stdout was: ${JSON.stringify(res.stdout)}`
    );
  });
}

// ── (g) CLI contract: --check-only JSON shape, network-tolerant ──────────────

async function testCheckOnlyCliShape() {
  await run('--check-only --json exits 0 and every item carries the full contract shape', async () => {
    const res = runCli(['--check-only', '--json'], CHECK_ONLY_TIMEOUT_MS);
    if (res.error) throw new Error(`child failed to run: ${res.error}`);
    // Shape and contract only: when npm or GitHub is unreachable the checker
    // reports empty latest strings and no updates, so these assertions must
    // still hold rather than failing on connectivity.
    assert.strictEqual(res.status, 0, `expected exit 0 even when npm/github are unreachable, got ${res.status}; stderr: ${res.stderr || '(empty)'}`);
    assert.ok(res.stdout.trim().length > 0, 'stdout must contain the status JSON');
    const parsed = JSON.parse(res.stdout);
    assert.strictEqual(parsed.checked, true, 'status.checked must be true');
    assert.ok(Array.isArray(parsed.items), 'status.items must be an array');
    const names = new Set(parsed.items.map((i) => i.name));
    for (const required of REQUIRED_TOOLS) {
      assert.ok(names.has(required), `--check-only items must include ${required}`);
    }
    for (const item of parsed.items) {
      const where = `item ${item.name}`;
      assert.strictEqual(typeof item.name, 'string', `${where}: name must be a string`);
      assert.ok(item.name.length > 0, `${where}: name must be non-empty`);
      assert.ok('current' in item && 'latest' in item, `${where}: current/latest keys must exist`);
      assert.strictEqual(typeof item.current, 'string', `${where}: current must be a string (may be empty offline)`);
      assert.strictEqual(typeof item.latest, 'string', `${where}: latest must be a string (may be empty offline)`);
      assert.strictEqual(typeof item.update_available, 'boolean', `${where}: update_available must be boolean`);
      assert.ok(['none', 'sync', 'manual'].includes(item.update_type), `${where}: bad update_type ${item.update_type}`);
      assert.strictEqual(typeof item.restart_required, 'boolean', `${where}: restart_required must be boolean`);
      assert.strictEqual(typeof item.status, 'string', `${where}: status must be a string`);
      assert.ok(item.status.length > 0, `${where}: status must be non-empty`);
    }
    return `exit 0, ${parsed.items.length} items, values of latest/update_available left unchecked so an offline run passes`;
  });
}

// ── (h) static: the --check-only branch of main() must never exit non-zero ───

async function testCheckOnlyNeverExitsNonZero() {
  await run('exit-code rule: check-only branch of main() only ever exits 0', async () => {
    const lines = readSourceLines(CHECK_UPDATES_FILE);
    const start = lineOf(lines, /if \(opts\.checkOnly\)/, 'check-updates.mjs', 'check-only branch');
    const end = lineOf(lines, /if \(opts\.apply\)/, 'check-updates.mjs', 'apply branch');
    assert.ok(start < end, `branch markers out of order: checkOnly at line ${start + 1}, apply at line ${end + 1}`);
    const slice = lines.slice(start, end);
    const exits = [];
    slice.forEach((l, i) => {
      const m = l.match(/process\.exit\(([^)]*)\)/);
      if (m) exits.push({ line: start + i + 1, arg: m[1].trim() });
    });
    assert.ok(exits.length >= 1, 'check-only branch must terminate with a process.exit(0)');
    for (const e of exits) {
      assert.strictEqual(
        Number(e.arg), 0,
        `non-zero exit in check-only branch: process.exit(${e.arg}) at check-updates.mjs:${e.line}`
      );
    }
    slice.forEach((l, i) => {
      const m = l.match(/process\.exitCode\s*=\s*(-?\d+)/);
      assert.ok(!m || Number(m[1]) === 0, `non-zero process.exitCode at check-updates.mjs:${start + i + 1}`);
    });
    return `branch spans check-updates.mjs lines ${start + 1}-${end + 1}, exit calls at ${exits.map((e) => `line ${e.line} exit(${e.arg})`).join(', ')}`;
  });
}

// ── (i) static: launch-unified.mjs must gate every update behind REUSE_SAVED ─

async function testLauncherRestartSkipPolicy() {
  await run('restart-skip policy: launch-unified.mjs runs update calls only below the REUSE_SAVED gate', async () => {
    const lines = readSourceLines(LAUNCHER_FILE);
    const defLine = lineOf(lines, /const REUSE_SAVED\s*=/, 'launch-unified.mjs', 'REUSE_SAVED declaration');
    const gateLine = lineOf(lines, /if \(!REUSE_SAVED\)/, 'launch-unified.mjs', 'if (!REUSE_SAVED) gate');
    assert.ok(
      defLine < gateLine,
      `REUSE_SAVED (line ${defLine + 1}) must be defined before the dependency-update block (line ${gateLine + 1})`
    );
    const callRe = /\b(checkUpdatesOnly|checkAndPromptUpdates|applyAllUpdates)\s*\(/;
    const callLines = [];
    lines.forEach((l, i) => { if (callRe.test(l)) callLines.push(i + 1); });
    assert.ok(callLines.length > 0, 'expected at least one dependency-update call in launch-unified.mjs');
    for (const n of callLines) {
      assert.ok(
        n > gateLine + 1,
        `dependency-update call at line ${n} appears at or above the REUSE_SAVED gate at line ${gateLine + 1}`
      );
    }
    return `REUSE_SAVED defined line ${defLine + 1}, gate line ${gateLine + 1}, update calls at lines ${callLines.join(', ')}`;
  });
}

// ── (j) static: restart-pi-stack.ps1 default policy and checker-before-kill ──

async function testRestartScriptPolicy() {
  await run('restart script: updates are opt-in and the checker runs before the stack kill', async () => {
    const lines = readSourceLines(RESTART_PS1_FILE);
    const applyDecl = lineOf(lines, /\[switch\]\$ApplyUpdates/, 'restart-pi-stack.ps1', '$ApplyUpdates param');
    const skipDecl = lineOf(lines, /\[switch\]\$SkipUpdates/, 'restart-pi-stack.ps1', '$SkipUpdates param');
    const bothWin = lineOf(lines, /Stamp\s+"-ApplyUpdates and -SkipUpdates both passed/, 'restart-pi-stack.ps1', 'both-switches-passed Stamp');
    // Anchor on the executable Join-Path line so .PARAMETER help text that
    // merely mentions check-updates.mjs cannot satisfy this assertion.
    const checkerPathLine = lines.findIndex((l) => /check-updates\.mjs/.test(l) && /Join-Path/.test(l) && !/^\s*#/.test(l));
    assert.ok(checkerPathLine !== -1, 'restart-pi-stack.ps1: no non-comment reference to check-updates.mjs');
    const invLine = lineOf(lines, /&\s*\$NodeExe\s+@checkerArgs/, 'restart-pi-stack.ps1', 'checker invocation');
    const killBegin = lineOf(lines, /# ---- 1\. Stop the stack/, 'restart-pi-stack.ps1', 'kill phase header');
    const stopProc = lineOf(lines, /Stop-Process\s+-Id/, 'restart-pi-stack.ps1', 'Stop-Process call');
    assert.ok(invLine < killBegin, `checker invocation (line ${invLine + 1}) must run before the kill phase (line ${killBegin + 1})`);
    assert.ok(checkerPathLine < killBegin, `check-updates.mjs reference (line ${checkerPathLine + 1}) must precede the kill phase (line ${killBegin + 1})`);
    assert.ok(invLine < stopProc, `checker invocation (line ${invLine + 1}) must run before Stop-Process (line ${stopProc + 1})`);
    // Default branch (neither switch passed): must not invoke the checker.
    const defaultStart = lineOf(lines, /dependency updates skipped \(default restart policy/, 'restart-pi-stack.ps1', 'default-branch Stamp');
    const defaultSlice = lines.slice(defaultStart, killBegin).join('\n');
    assert.ok(!/check-updates/.test(defaultSlice), 'default branch must not reference check-updates.mjs');
    assert.ok(!/\$NodeExe/.test(defaultSlice), 'default branch must not invoke the checker');
    assert.ok(applyDecl < bothWin, 'switch declarations must precede the both-passed branch');
    return `params lines ${applyDecl + 1}/${skipDecl + 1}, checker path line ${checkerPathLine + 1}, invocation line ${invLine + 1}, kill phase starts line ${killBegin + 1}, Stop-Process line ${stopProc + 1}`;
  });
}

// ── (k) isHigher edge cases beyond the base group ────────────────────────────

async function testIsHigherEdgeCases() {
  await run('isHigher edge cases: bumps, longer vs shorter, prerelease vs release, empty/null', async () => {
    const mod = await importModule();
    const isHigher = mod.isHigher;

    // Equal versions.
    assert.strictEqual(isHigher('2.5.0', '2.5.0'), false, 'equal full triple');
    assert.strictEqual(isHigher('1.2', '1.2.0'), false, 'two-part vs zero-filled triple');
    assert.strictEqual(isHigher('1.2.0', '1.2'), false, 'zero-filled triple vs two-part');

    // Patch, minor, major bumps in both directions.
    assert.strictEqual(isHigher('1.0.1', '1.0.0'), true, 'patch bump');
    assert.strictEqual(isHigher('1.0.0', '1.0.1'), false, 'patch behind');
    assert.strictEqual(isHigher('1.1.0', '1.0.99'), true, 'minor bump');
    assert.strictEqual(isHigher('1.0.99', '1.1.0'), false, 'minor behind');
    assert.strictEqual(isHigher('2.0.0', '1.99.99'), true, 'major bump');
    assert.strictEqual(isHigher('1.99.99', '2.0.0'), false, 'major behind');

    // A longer version string against a shorter one: numeric compare, not
    // string compare, must decide ('1.10' is a higher version than '1.9').
    assert.strictEqual(isHigher('1.10.0', '1.9.5'), true, 'longer token wins numerically');
    assert.strictEqual(isHigher('1.9.5', '1.10.0'), false, 'shorter token loses numerically');
    assert.strictEqual(isHigher('1.10', '1.9'), true, 'two-part longer token wins');

    // A prerelease suffix against its own release.
    assert.strictEqual(isHigher('1.2.3-beta.1', '1.2.3'), false, 'prerelease below its release');
    assert.strictEqual(isHigher('1.2.3', '1.2.3-beta.1'), true, 'release above its prerelease');
    assert.strictEqual(isHigher('1.2.3-rc.1', '1.2.3-rc.1'), false, 'identical prerelease is not an upgrade');
    assert.strictEqual(isHigher('1.2.3+build.7', '1.2.3'), false, 'build metadata is not an upgrade');

    // null / undefined / empty inputs must return false so call sites skip.
    assert.strictEqual(isHigher('', '1.2.3'), false, 'empty latest');
    assert.strictEqual(isHigher('1.2.3', ''), false, 'empty current');
    assert.strictEqual(isHigher('', ''), false, 'both empty');
    assert.strictEqual(isHigher(null, null), false, 'both null');
    assert.strictEqual(isHigher(undefined, '1.0.0'), false, 'undefined latest');
    assert.strictEqual(isHigher('   ', '1.2.3'), false, 'whitespace latest');
  });
}

// ── runner ─────────────────────────────────────────────────────────────────

// ── (l) static: every download/install step must emit progress on stderr ──
//
// The Sep-29/Sep-30 incidents: npm installs of 440-675MB packages ran with
// ZERO console output for minutes, the window looked hung, and the window
// was killed mid-install. This group pins the fix structurally: every apply
// path emits feedback, and no apply-path feedback ever touches stdout
// (stdout is the machine contract: --json purity + exact human summary lines).
async function testUpdateFeedbackContract() {
  await run('feedback contract: every apply step reports progress on stderr, never stdout', async () => {
    const lines = readSourceLines(CHECK_UPDATES_FILE);
    const idx = (re, label) => {
      const i = lines.findIndex((l) => re.test(l));
      assert.ok(i !== -1, `check-updates.mjs: expected ${label}`);
      return i;
    };

    // 1. The note helpers exist and route through process.stderr.write only.
    const helperBlock = idx(/function emitLine/, 'emitLine helper');
    assert.match(lines[helperBlock + 1], /process\.stderr\.write/, 'emitLine must write to stderr');
    const helpers = ['noteDim', 'noteCyan', 'noteGreen', 'noteYellow', 'noteRed', 'progressInPlace', 'progressDone'];
    for (const h of helpers) {
      assert.ok(
        lines.some((l) => new RegExp(`const ${h}\\s*=`).test(l) || new RegExp(`function ${h}\\(`).test(l)),
        `missing progress helper ${h}`
      );
    }

    // 2. npm applies stream child output + heartbeat and use the dedicated
    // install timeout (a 120s kill mid-install of a 440MB package is the
    // worst outcome; rollback never fires on a killed process).
    const installTimeout = idx(/const INSTALL_TIMEOUT_MS\s*=/, 'INSTALL_TIMEOUT_MS constant');
    const npmApply = idx(/async function applyNpmUpdate/, 'applyNpmUpdate');
    const npmApplyEnd = idx(/async function applyBinaryUpdate/, 'applyBinaryUpdate (bounds applyNpmUpdate)');
    const npmBody = lines.slice(npmApply, npmApplyEnd).join('\n');
    assert.ok(npmApply > installTimeout, 'INSTALL_TIMEOUT_MS must be declared before applyNpmUpdate');
    assert.match(npmBody, /Updating \$\{tool\.name\}/, 'applyNpmUpdate must announce the update before running npm');
    assert.match(npmBody, /onOutput/, 'applyNpmUpdate must stream npm output live');
    assert.match(npmBody, /onHeartbeat/, 'applyNpmUpdate must emit heartbeat ticks while npm runs');
    assert.match(npmBody, /timeout: INSTALL_TIMEOUT_MS/, 'applyNpmUpdate must bound installs with INSTALL_TIMEOUT_MS, not the 120s query cap');
    assert.ok(!/timeout: NPM_TIMEOUT_MS/.test(npmBody), 'applyNpmUpdate must not use NPM_TIMEOUT_MS for installs');

    // 3. Binary applies show download progress (bytes + percent) and the
    // node-swap restore shows per-package feedback.
    const binApply = idx(/async function applyBinaryUpdate/, 'applyBinaryUpdate');
    const binApplyEnd = idx(/async function applyDirectBinaryUpdate/, 'applyDirectBinaryUpdate');
    const binBody = lines.slice(binApply, binApplyEnd).join('\n');
    assert.match(binBody, /downloadToTemp\(url, 0,/, 'applyBinaryUpdate must pass a progress callback to downloadToTemp');
    assert.match(binBody, /progressInPlace/, 'download progress must render in place');
    assert.match(binBody, /fmtBytes/, 'download progress must show byte counts');
    const dlFn = idx(/function downloadToTemp\(url, depth = 0, onProgress/, 'downloadToTemp with onProgress parameter');
    const dlBody = lines.slice(dlFn, dlFn + 60).join('\n');
    assert.match(dlBody, /onProgress\(loaded, total\)/, 'downloadToTemp must report loaded/total bytes');
    assert.match(dlBody, /depth \+ 1, onProgress/, 'downloadToTemp must thread progress through redirect hops');
    const restoreFn = idx(/async function restoreNpmGlobals/, 'restoreNpmGlobals');
    const restoreBody = lines.slice(restoreFn, restoreFn + 40).join('\n');
    assert.match(restoreBody, /restoring \$\{spec\}/, 'restoreNpmGlobals must announce each package restore');
    assert.match(restoreBody, /onHeartbeat/, 'restoreNpmGlobals must heartbeat during long installs');

    // 4. The check phase reports per-tool liveness (the old dead air between
    // "Checking dependency updates..." and the prompt list).
    const collectFn = idx(/async function collectStatuses/, 'collectStatuses');
    const collectBody = lines.slice(collectFn, collectFn + 25).join('\n');
    assert.match(collectBody, /checking \$\{tool\.name\}/, 'collectStatuses must report per-tool checking lines');

    // 5. Apply-path feedback NEVER goes to stdout: console.log inside the
    // apply functions would corrupt the --json / exact-line stdout contracts.
    for (const pair of [
      ['async function applyNpmUpdate', 'async function applyBinaryUpdate'],
      ['async function applyBinaryUpdate', 'async function applyDirectBinaryUpdate'],
      ['async function applyDirectBinaryUpdate', 'function extractZip'],
      ['async function restoreNpmGlobals', 'function emptyItem']
    ]) {
      const start = idx(new RegExp(pair[0].replace(/\(/g, '\\(')), `${pair[0]} (start)`);
      const stop = idx(new RegExp(pair[1].replace(/\(/g, '\\(')), `${pair[1]} (end anchor)`);
      const body = lines.slice(start, stop).join('\n');
      assert.ok(
        !/console\.log/.test(body),
        `${pair[0]} must not console.log (stdout is a machine contract); use the note* helpers`
      );
    }

    return `emitLine@${helperBlock + 1}, applyNpmUpdate@${npmApply + 1}, applyBinaryUpdate@${binApply + 1}, downloadToTemp@${dlFn + 1}`;
  });
}

(async () => {
  await testManifestShape();
  await testStatusFileShape();
  await testIsHigher();
  await testCheckOnlyNoApply();
  await testApplyJsonNothingToApply();
  await testApplyHumanNothingToApply();
  await testCheckOnlyCliShape();
  await testCheckOnlyNeverExitsNonZero();
  await testLauncherRestartSkipPolicy();
  await testRestartScriptPolicy();
  await testIsHigherEdgeCases();
  await testUpdateFeedbackContract();
  if (failed > 0) {
    console.error(`\n${failed} group(s) failed.`);
    process.exit(1);
  }
  console.log('\nAll checks passed.');
  process.exit(0);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
