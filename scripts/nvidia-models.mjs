#!/usr/bin/env node

// NVIDIA free-model curator (engine).
// Fetches the live NVIDIA catalog, classifies every model into chat /
// non-chat and Tier A/B/C/X, scores relevance from
// config/nvidia-relevance.json, writes a state snapshot, and rewrites
// ~/.pi/agent/models.json safely on request. The pi-web plugin in
// scripts/pi-web-plugins/nvidia-models/ is a thin view over this CLI;
// this file is the only writer of models.json.
//
// Frozen CLI (consumed by the plugin):
//   --sync [--json]                fetch API, classify, snapshot state
//   --status [--json]              read last state, never exits 1
//   --apply-recommended [--json]   rewrite models.json with Tier A enabled
//   --enable id1,id2 [--json]      enable specific ids (pin-guarded)
//   --disable id1,id2 [--json]     disable specific ids (pin-guarded)
//   --restore-backup [--json]      restore most recent backup
//
// Diagnostics (not used by the plugin; useful for tests and manual probes):
//   --models-file <path>           override models.json path (use a copy)
//   --state-file  <path>           override state file path
//   --catalog     <path>           use a fixture catalog instead of the API
//   --keys-file   <path>           override provider-keys.json path
//   --dry-run                      parse and report, never write
//
// Style: ESM, node: prefixed imports, no new dependencies, explicit
// timeout on every external call, Windows-safe paths via node:path.

import { readFileSync, writeFileSync, copyFileSync, renameSync, mkdirSync, existsSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';
import { request as httpsRequest } from 'node:https';

const __filename = fileURLToPath(import.meta.url);
const __dirname  = dirname(__filename);
const REPO_ROOT  = resolve(__dirname, '..');

const DEFAULT_RELEVANCE_PATH = join(REPO_ROOT, 'config', 'nvidia-relevance.json');
const DEFAULT_MODELS_FILE    = join(homedir(), '.pi', 'agent', 'models.json');
const DEFAULT_STORE_FILE     = join(homedir(), '.pi', 'agent', 'models-store.json');
const DEFAULT_KEYS_FILE      = join(homedir(), '.pi', 'agent', 'provider-keys.json');
const DEFAULT_STATE_FILE     = join(REPO_ROOT, 'data', 'nvidia-models-state.json');
const DEFAULT_BACKUP_DIR     = join(REPO_ROOT, 'data', 'backups', 'nvidia-models');
const DEFAULT_STORE_BACKUP_DIR = join(REPO_ROOT, 'data', 'backups', 'nvidia-models-store');
const API_HOST               = 'integrate.api.nvidia.com';
const API_PATH               = '/v1/models';
const API_TIMEOUT_MS         = 20_000;

// Hard-pinned ids are the SEED for the state file's `pins` array, not a
// permanent guard. On the first state write after this change the seed is
// persisted (HARD_PINNED_IDS ∪ every model: nvidia/... line in .pi/agents/*.md);
// from then on the persisted list is the only guard source and the panel's
// PIN toggle edits it directly.
const HARD_PINNED_IDS = [
  'z-ai/glm-5.3',
  'moonshotai/kimi-k3',
  'moonshotai/kimi-k2.6',
  'deepseek-ai/deepseek-v4.1-flash'
];

const TIER_WHY = {
  A: 'frontier chat model in active use, enabled by default',
  B: 'chat-capable, off by default, opt-in via the panel',
  C: 'tiny, superseded, narrow, or non-conversational, off by default',
  X: 'non-chat (embedding/guard/reward/parser/retrieval/vision utility), excluded from the panel'
};

const VERBS = ['--sync', '--status', '--apply-recommended', '--enable', '--disable', '--pin', '--unpin', '--restore-backup'];

function parseArgs(argv) {
  const args = {
    json: false,
    dryRun: false,
    modelsFile: null,
    stateFile: null,
    storeFile: null,
    catalog: null,
    keysFile: null,
    backupDir: null,
    verb: null,
    ids: [],
    help: false
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--json') args.json = true;
    else if (a === '--dry-run') args.dryRun = true;
    else if (a === '--models-file') { args.modelsFile = argv[++i]; }
    else if (a === '--state-file')  { args.stateFile  = argv[++i]; }
    else if (a === '--store-file')  { args.storeFile  = argv[++i]; }
    else if (a === '--catalog')     { args.catalog    = argv[++i]; }
    else if (a === '--keys-file')   { args.keysFile   = argv[++i]; }
    else if (a === '--backup-dir')  { args.backupDir  = argv[++i]; }
    else if (a === '--help' || a === '-h') { args.help = true; }
    else if (VERBS.includes(a)) {
      if (args.verb) throw new Error(`only one verb allowed, got ${args.verb} and ${a}`);
      args.verb = a;
      if (['--enable', '--disable', '--pin', '--unpin'].includes(a)) {
        // Ids may arrive as one comma-joined token or as separate argv
        // tokens (the plugin's bulk path passes one token per id). Consume
        // every non-flag token that follows; a flag token stops the scan.
        const fragments = [];
        while (i + 1 < argv.length && !argv[i + 1].startsWith('--')) {
          fragments.push(argv[++i]);
        }
        args.ids = fragments.flatMap((s) => s.split(',')).map((s) => s.trim()).filter(Boolean);
        if (args.ids.length === 0) throw new Error(`${a} requires at least one id`);
      }
    } else {
      throw new Error(`unknown argument: ${a}`);
    }
  }
  if (args.help) return args;
  if (!args.verb) throw new Error('no verb given; expected one of ' + VERBS.join(', '));
  return args;
}

function printUsage() {
  const lines = [
    'Usage: node scripts/nvidia-models.mjs <verb> [--json] [--dry-run]',
    '  --sync                  fetch API, classify, snapshot state',
    '  --status                read last state, never exits 1',
    '  --apply-recommended     rewrite models.json with Tier A enabled',
    '  --enable id1,id2        enable specific ids (pin-guarded)',
    '  --disable id1,id2       disable specific ids (pin-guarded)',
    '  --pin id1,id2           pin ids: the guard then refuses to disable them',
    '  --unpin id1,id2         unpin ids: they become freely disableable',
    '  --restore-backup        restore the most recent backup',
    '  --help, -h              print this help and exit 0',
    '',
    'Diagnostics (not used by the plugin):',
    '  --models-file <path>    override models.json path (use a copy)',
    '  --state-file  <path>    override state file path',
    '  --store-file  <path>    override models-store.json path (use a copy)',
    '  --catalog     <path>    use a fixture catalog instead of the API',
    '  --keys-file   <path>    override provider-keys.json path',
    '  --backup-dir  <path>    override backup directory'
  ];
  process.stdout.write(lines.join('\n') + '\n');
}

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

function writeJsonAtomic(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  const tmpPath = join(dirname(path), `.${Date.now()}.${process.pid}.${Math.random().toString(36).slice(2, 8)}.tmp`);
  writeFileSync(tmpPath, JSON.stringify(value, null, 2) + '\n', 'utf8');
  renameSync(tmpPath, path);
  return tmpPath;
}

function ensureDir(path) {
  mkdirSync(path, { recursive: true });
}

// Set of ids currently present in providers.nvidia.models. The single
// source of truth for "enabled" everywhere in the engine: a row's
// enabled flag, the toggle baseline for --enable/--disable, and the
// baseline for --sync must all come from the live file. Using
// prevState as the baseline made --sync report every row as disabled
// on a first run.
function liveEnabledSet(modelsJson) {
  const list = modelsJson && modelsJson.providers && modelsJson.providers.nvidia && Array.isArray(modelsJson.providers.nvidia.models)
    ? modelsJson.providers.nvidia.models
    : [];
  return new Set(list.map((m) => m && m.id).filter(Boolean));
}

function loadApiKey(keysFile) {
  if (!existsSync(keysFile)) throw new Error(`provider-keys.json not found at ${keysFile}`);
  const data = readJson(keysFile);
  if (!data || typeof data !== 'object' || !data.nvidia) throw new Error('provider-keys.json has no nvidia block');
  const block = data.nvidia;
  if (!Array.isArray(block.keys) || block.keys.length === 0) throw new Error('provider-keys.json nvidia.keys is empty');
  const active = block.keys.find((k) => k && k.name === block.activeKeyName) || block.keys[0];
  if (!active || !active.apiKey) throw new Error('provider-keys.json nvidia has no usable apiKey');
  return active.apiKey;
}

function fetchCatalog(apiKey) {
  return new Promise((resolveP, rejectP) => {
    const req = httpsRequest({
      hostname: API_HOST,
      path: API_PATH,
      method: 'GET',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        Accept: 'application/json'
      }
    }, (res) => {
      let buf = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { buf += c; });
      res.on('end', () => {
        if (res.statusCode !== 200) {
          return rejectP(new Error(`NVIDIA API HTTP ${res.statusCode}: ${buf.slice(0, 200)}`));
        }
        let body;
        try { body = JSON.parse(buf); }
        catch (e) { return rejectP(new Error(`NVIDIA API returned non-JSON: ${e.message}`)); }
        if (!body || !Array.isArray(body.data)) return rejectP(new Error('NVIDIA API response missing data[]'));
        resolveP(body.data);
      });
    });
    req.on('error', (e) => rejectP(new Error(`NVIDIA API request failed: ${e.message}`)));
    req.setTimeout(API_TIMEOUT_MS, () => {
      req.destroy(new Error(`NVIDIA API request timed out after ${API_TIMEOUT_MS}ms`));
    });
    req.end();
  });
}

function matchTierX(id, patterns) {
  if (!Array.isArray(patterns)) return null;
  const lower = id.toLowerCase();
  for (const p of patterns) {
    if (typeof p !== 'string' || p.length === 0) continue;
    if (lower.includes(p.toLowerCase())) return p;
  }
  return null;
}

function categoryForPattern(pattern, categoryMap) {
  return (categoryMap && categoryMap[pattern]) || 'other';
}

function tierForChatId(id, rules) {
  if (Array.isArray(rules.tierA) && rules.tierA.includes(id)) return 'A';
  if (Array.isArray(rules.tierB) && rules.tierB.includes(id)) return 'B';
  if (Array.isArray(rules.tierC) && rules.tierC.includes(id)) return 'C';
  return (rules.default && rules.default.tier) || 'C';
}

function relevanceForTier(tier, rules) {
  if (tier === 'A') return 'recommended';
  if (tier === 'B') return 'optional';
  if (tier === 'C') return 'not-relevant';
  return (rules.default && rules.default.relevance) || 'not-relevant';
}

function whyForTier(tier) {
  return TIER_WHY[tier] || TIER_WHY.C;
}

function resolveMetadata(id, modelsJson, modelsStore, defaults) {
  const mjList = (modelsJson && modelsJson.providers && modelsJson.providers.nvidia && Array.isArray(modelsJson.providers.nvidia.models))
    ? modelsJson.providers.nvidia.models
    : [];
  const mj = mjList.find((m) => m && m.id === id) || null;
  if (mj && Number.isFinite(mj.contextWindow) && Number.isFinite(mj.maxTokens)) {
    return {
      contextWindow: mj.contextWindow,
      maxTokens: mj.maxTokens,
      reasoning: Boolean(mj.reasoning),
      input: Array.isArray(mj.input) ? mj.input.slice() : defaults.input.slice(),
      name: mj.name || id,
      metadataSource: 'models.json'
    };
  }
  const storeList = (modelsStore && modelsStore.nvidia && Array.isArray(modelsStore.nvidia.models)) ? modelsStore.nvidia.models : [];
  const store = storeList.find((m) => m && m.id === id) || null;
  if (store && Number.isFinite(store.contextWindow) && Number.isFinite(store.maxTokens)) {
    return {
      contextWindow: store.contextWindow,
      maxTokens: store.maxTokens,
      reasoning: Boolean(store.reasoning),
      input: Array.isArray(store.input) ? store.input.slice() : defaults.input.slice(),
      name: store.name || id,
      metadataSource: 'models-store.json'
    };
  }
  return {
    contextWindow: defaults.contextWindow,
    maxTokens: defaults.maxTokens,
    reasoning: Boolean(defaults.reasoning),
    input: defaults.input.slice(),
    name: id,
    metadataSource: 'inferred'
  };
}

function buildModelRows(catalogIds, rules, modelsJson, modelsStore, enabledSet) {
  const rows = [];
  for (const id of catalogIds) {
    const tierX = matchTierX(id, rules.tierX);
    let tier, category, relevance;
    if (tierX) {
      tier = 'X';
      category = categoryForPattern(tierX, rules.category);
      relevance = 'excluded';
    } else {
      tier = tierForChatId(id, rules);
      category = 'chat';
      relevance = relevanceForTier(tier, rules);
    }
    const meta = resolveMetadata(id, modelsJson, modelsStore, rules.metadataDefaults);
    const inModelsJson = Boolean((modelsJson && modelsJson.providers && modelsJson.providers.nvidia && modelsJson.providers.nvidia.models || []).find((m) => m && m.id === id));
    const inStore = Boolean((modelsStore && modelsStore.nvidia && modelsStore.nvidia.models || []).find((m) => m && m.id === id));
    rows.push({
      id,
      name: meta.name,
      category,
      tier,
      relevance,
      enabled: enabledSet ? enabledSet.has(id) : false,
      in_models_json: inModelsJson,
      in_store: inStore,
      contextWindow: meta.contextWindow,
      maxTokens: meta.maxTokens,
      reasoning: meta.reasoning,
      input: meta.input,
      metadata: meta.metadataSource,
      why: whyForTier(tier)
    });
  }
  return rows;
}

function summarize(rows) {
  const counts = { chat: 0, non_chat: 0, enabled: 0, recommended: 0 };
  for (const r of rows) {
    if (r.category === 'chat') counts.chat += 1;
    else counts.non_chat += 1;
    if (r.enabled) counts.enabled += 1;
    if (r.tier === 'A') counts.recommended += 1;
  }
  return counts;
}

// Advisory scan: which agent files reference which NIM model. The result
// does NOT drive the pin guard (state pins do); the panel shows it so a
// disable of an in-use model is an informed choice, not a refusal.
function agentPinUsers(repoRoot) {
  const users = new Map();
  const agentsDir = join(repoRoot, '.pi', 'agents');
  if (existsSync(agentsDir)) {
    for (const file of readdirSync(agentsDir)) {
      if (!file.endsWith('.md')) continue;
      try {
        const txt = readFileSync(join(agentsDir, file), 'utf8');
        for (const line of txt.split(/\r?\n/)) {
          const m = line.match(/^\s*model:\s*(nvidia\/[^\s]+)\s*$/);
          if (m) {
            const id = m[1].replace(/^nvidia\//, '');
            if (!users.has(id)) users.set(id, []);
            if (!users.get(id).includes(file)) users.get(id).push(file);
          }
        }
      } catch { /* unreadable agent file: skip, do not fail the scan */ }
    }
  }
  return users;
}

function normalizePinList(value) {
  const list = Array.isArray(value) ? value : [];
  return [...new Set(list.map((s) => String(s).trim()).filter(Boolean))].sort();
}

// One-time seed: HARD_PINNED_IDS ∪ every agent-file pin. Used when a state
// file has no pins key yet; the next state write persists it, and after that
// the persisted list is the only guard source.
function seedPinList(repoRoot) {
  const seeded = new Set(HARD_PINNED_IDS);
  for (const id of agentPinUsers(repoRoot).keys()) seeded.add(id);
  return normalizePinList([...seeded]);
}

// Resolve the pin set for a guard or decoration. `seeded` is true when the
// state file had no pins key and the seed was computed in memory; callers
// that write state persist it, --status never writes.
function loadPinSet(state, repoRoot) {
  if (state && Array.isArray(state.pins)) {
    return { pins: new Set(normalizePinList(state.pins)), seeded: false };
  }
  return { pins: new Set(seedPinList(repoRoot)), seeded: true };
}

function readStateOrEmpty(stateFile) {
  if (!existsSync(stateFile)) {
    // NOTE: no `pins` key here on purpose. loadPinSet() seeds when the key is
    // ABSENT; an explicit empty array would mean "user unpinned everything"
    // and would defeat the one-time seed on a fresh state file.
    return { synced_at: '', source: 'state', models: [], counts: { chat: 0, non_chat: 0, enabled: 0, recommended: 0 } };
  }
  // Distinguish "file corrupt" from "file missing". F4 requires --status
  // to surface corrupt state as ok:false + error; the runner catches
  // the thrown error and renders the failure payload.
  try {
    return readJson(stateFile);
  } catch (e) {
    const err = new Error(`state file corrupt at ${stateFile}: ${e.message}`);
    err.corruptState = true;
    throw err;
  }
}

function writeState(stateFile, state) {
  writeJsonAtomic(stateFile, state);
}

// Carry the known-dead list through any state rewrite. Verbs that do not
// probe (enable/disable/apply/restore) must not forget which ids are dead.
function carryDead(prevState) {
  return Array.isArray(prevState && prevState.dead) ? prevState.dead : [];
}

function diffFromState(prevState, currentRows) {
  const prevIds = new Set((prevState.models || []).map((m) => m.id));
  const currIds = new Set(currentRows.map((m) => m.id));
  const added_since_last_sync = [...currIds].filter((id) => !prevIds.has(id)).sort();
  const missing_from_api = [...prevIds].filter((id) => !currIds.has(id)).sort();
  const prevById = new Map((prevState.models || []).map((m) => [m.id, m]));
  const changed = currentRows.some((r) => {
    const p = prevById.get(r.id);
    if (!p) return false;
    return Boolean(p.in_models_json) !== Boolean(r.in_models_json);
  });
  return { added_since_last_sync, missing_from_api, changed };
}

function backupModelsJson(modelsFile, backupDir) {
  if (!existsSync(modelsFile)) return '';
  ensureDir(backupDir);
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const dest = join(backupDir, `models.json.${ts}`);
  copyFileSync(modelsFile, dest);
  return dest;
}

// Reconcile the picker store with panel state. The pi web picker renders the
// UNION of models.json + pi's built-in catalog + models-store.json, so an id
// that the panel disabled but the store still lists keeps showing up. Remove
// only ids that are state-tracked AND absent from the freshly written
// models.json list; user-added custom entries (not tracked) and non-nvidia
// providers survive. Backup first, atomic write, restore on failure.
function pruneStore(storeFile, backupDir, enabledIds, trackedIds, dryRun) {
  const result = { backup: '', pruned: [], written: false, error: '' };
  if (!existsSync(storeFile)) return result;
  let store;
  try { store = readJson(storeFile); } catch (e) { result.error = `cannot parse store: ${e.message}`; return result; }
  const section = store && store.nvidia && Array.isArray(store.nvidia.models) ? store.nvidia.models : null;
  if (!section) return result;
  const enabled = enabledIds instanceof Set ? enabledIds : new Set(enabledIds || []);
  const tracked = trackedIds instanceof Set ? trackedIds : new Set(trackedIds || []);
  const pruned = section.filter((m) => m && m.id && tracked.has(m.id) && !enabled.has(m.id)).map((m) => m.id);
  if (pruned.length === 0) return result;
  result.pruned = pruned;
  if (dryRun) return result;
  ensureDir(backupDir);
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const dest = join(backupDir, `models-store.json.${ts}`);
  try { copyFileSync(storeFile, dest); } catch (e) { result.error = `store backup failed: ${e.message}`; return result; }
  result.backup = dest;
  const keep = section.filter((m) => !m || !m.id || !tracked.has(m.id) || enabled.has(m.id));
  const next = JSON.parse(JSON.stringify(store));
  next.nvidia.models = keep;
  try {
    writeJsonAtomic(storeFile, next);
  } catch (e) {
    result.error = `store write failed: ${e.message}`;
    try { copyFileSync(dest, storeFile); } catch { /* restore failure ignored: original error surfaces */ }
    return result;
  }
  result.written = true;
  return result;
}

function rebuildModelsJson(modelsJson, nvidiaModels) {
  const out = JSON.parse(JSON.stringify(modelsJson));
  out.providers = out.providers || {};
  out.providers.nvidia = out.providers.nvidia || {};
  out.providers.nvidia.models = nvidiaModels;
  return out;
}

// Decide which catalog ids should be present in providers.nvidia.models.
// Tier X ids are excluded (non-chat). All other ids from the catalog are
// eligible; the engine does not silently drop ids, it just decides whether
// they are enabled.
//
// enabledSet is the set of ids CURRENTLY in providers.nvidia.models; it is
// the baseline that --enable and --disable toggle. For --apply-recommended
// the baseline is ignored because that verb is a wholesale reset.
// For --sync the baseline is the previous state so user toggles survive.
function decideEnabledRows(rows, requestedIds, verb, enabledSet, prevState) {
  const out = rows.map((r) => ({ ...r }));
  if (verb === '--apply-recommended') {
    for (const r of out) r.enabled = r.tier === 'A';
  } else if (verb === '--enable') {
    for (const r of out) r.enabled = enabledSet ? enabledSet.has(r.id) : false;
    const want = new Set(requestedIds || []);
    for (const r of out) if (want.has(r.id)) r.enabled = true;
  } else if (verb === '--disable') {
    for (const r of out) r.enabled = enabledSet ? enabledSet.has(r.id) : false;
    const want = new Set(requestedIds || []);
    for (const r of out) if (want.has(r.id)) r.enabled = false;
  } else if (verb === '--sync' && prevState && Array.isArray(prevState.models)) {
    const prevById = new Map(prevState.models.map((m) => [m.id, m]));
    for (const r of out) {
      const p = prevById.get(r.id);
      if (p) r.enabled = Boolean(p.enabled);
    }
  }
  return out;
}

function findPinConflicts(rows, verb, requestedIds, pins) {
  if (verb !== '--disable' && verb !== '--apply-recommended') return [];
  const blocked = [];
  const wantDisable = new Set(requestedIds || []);
  for (const r of rows) {
    if (!pins.has(r.id)) continue;
    let reason;
    if (verb === '--disable' && wantDisable.has(r.id)) {
      reason = `pinned model ${r.id} cannot be disabled`;
      blocked.push({ id: r.id, reason });
    } else if (verb === '--apply-recommended' && r.tier !== 'A') {
      reason = `pinned model ${r.id} would be removed by --apply-recommended (tier ${r.tier})`;
      blocked.push({ id: r.id, reason });
    }
  }
  return blocked;
}

function applyToModelsJson(modelsFile, backupDir, rows, dryRun) {
  const result = { backup: '', written: false, count: 0, restored: false, error: '' };
  if (dryRun) {
    result.count = rows.filter((r) => r.enabled).length;
    return result;
  }
  if (!existsSync(modelsFile)) {
    result.error = `models.json not found at ${modelsFile}`;
    return result;
  }
  let original;
  try { original = readJson(modelsFile); }
  catch (e) { result.error = `cannot parse models.json: ${e.message}`; return result; }

  const backup = backupModelsJson(modelsFile, backupDir);
  result.backup = backup;

  const existing = Array.isArray(original?.providers?.nvidia?.models) ? original.providers.nvidia.models : [];
  const existingById = new Map(existing.map((m) => [m.id, m]));

  const newModels = [];
  for (const r of rows) {
    if (r.tier === 'X') continue;
    if (!r.enabled) continue;
    const prev = existingById.get(r.id);
    if (prev) {
      newModels.push(prev);
    } else {
      newModels.push({
        id: r.id,
        name: r.name,
        reasoning: r.reasoning,
        input: r.input,
        contextWindow: r.contextWindow,
        maxTokens: r.maxTokens,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }
      });
    }
  }

  const next = rebuildModelsJson(original, newModels);

  try {
    writeJsonAtomic(modelsFile, next);
  } catch (e) {
    result.error = `write failed: ${e.message}`;
    if (backup) { try { copyFileSync(backup, modelsFile); result.restored = true; } catch { /* restore failure ignored: original error surfaces */ } }
    return result;
  }

  let verified;
  try { verified = readJson(modelsFile); }
  catch (e) {
    result.error = `post-write parse failed: ${e.message}`;
    if (backup) { try { copyFileSync(backup, modelsFile); result.restored = true; } catch { /* restore failure ignored: original error surfaces */ } }
    return result;
  }
  const verifiedCount = Array.isArray(verified?.providers?.nvidia?.models) ? verified.providers.nvidia.models.length : -1;
  if (verifiedCount !== newModels.length) {
    result.error = `post-write count mismatch: wrote ${newModels.length}, file has ${verifiedCount}`;
    if (backup) { try { copyFileSync(backup, modelsFile); result.restored = true; } catch { /* restore failure ignored: original error surfaces */ } }
    return result;
  }

  result.written = true;
  result.count = verifiedCount;
  return result;
}

function listBackups(backupDir) {
  if (!existsSync(backupDir)) return [];
  return readdirSync(backupDir)
    .filter((f) => f.startsWith('models.json.'))
    .sort()
    .reverse();
}

function latestBackup(backupDir) {
  const files = listBackups(backupDir);
  return files.length === 0 ? '' : join(backupDir, files[0]);
}

function restoreLatestBackup(modelsFile, backupDir, dryRun) {
  // F5: refuse if there is no backup to restore from.
  const src = latestBackup(backupDir);
  if (!src) return { restored: false, error: 'no backup found', src: '', pre_restore_backup: '' };
  // F5: refuse if the chosen backup lives in a different directory than
  // backupDir. This stops a test run pointed at a temp backup-dir from
  // restoring an unrelated backup taken from somewhere else, or vice
  // versa.
  if (dirname(src) !== backupDir) {
    return {
      restored: false,
      error: `refusing to restore: backup ${src} is outside --backup-dir ${backupDir}`,
      src,
      pre_restore_backup: ''
    };
  }
  if (dryRun) return { restored: false, src, dryRun: true, pre_restore_backup: '' };

  // F5: take a pre-restore backup of the current models.json so the
  // restore itself is reversible.
  let pre = '';
  if (existsSync(modelsFile)) {
    const ts = new Date().toISOString().replace(/[:.]/g, '-');
    pre = join(backupDir, `models.json.pre-restore.${ts}`);
    try { copyFileSync(modelsFile, pre); } catch (e) {
      return { restored: false, error: `pre-restore backup failed: ${e.message}`, src, pre_restore_backup: '' };
    }
  }

  try {
    copyFileSync(src, modelsFile);
  } catch (e) {
    return { restored: false, error: `restore copy failed: ${e.message}`, src, pre_restore_backup: pre };
  }
  return { restored: true, src, pre_restore_backup: pre };
}

function buildBaseReport(rows, prevState) {
  const chatTotal = rows.filter((r) => r.category === 'chat').length;
  const nonChatTotal = rows.filter((r) => r.category !== 'chat').length;
  const enabled = rows.filter((r) => r.enabled).map((r) => r.id).sort();
  const recommended = rows.filter((r) => r.tier === 'A').map((r) => r.id).sort();
  const diff = prevState && Array.isArray(prevState.models) ? diffFromState(prevState, rows) : { added_since_last_sync: [], missing_from_api: [], changed: false };
  return {
    catalog_total: rows.length,
    chat_total: chatTotal,
    non_chat_total: nonChatTotal,
    enabled,
    recommended,
    added_since_last_sync: diff.added_since_last_sync,
    missing_from_api: diff.missing_from_api,
    changed: diff.changed
  };
}

function finalizeReport(partial) {
  return Object.assign({
    ok: true,
    synced_at: '',
    catalog_total: 0,
    chat_total: 0,
    enabled: [],
    recommended: [],
    added_since_last_sync: [],
    missing_from_api: [],
    non_chat_total: 0,
    changed: false,
    backup: '',
    blocked: [],
    error: '',
    models: [],
    pins: [],
    pins_changed: [],
    warnings: [],
    pruned_store: [],
    removed_dead: [],
    added_new: [],
    probe_inconclusive: [],
    probe_skipped: false,
    counts: { chat: 0, non_chat: 0, enabled: 0, recommended: 0 }
  }, partial || {});
}

// One-token inference probe. NVIDIA's /v1/models catalog keeps LISTING
// models whose deployment is gone, so the only trustworthy dead signal is
// an inference 404 ("Function not found"). Everything else (429, 5xx, 400,
// timeout, network error) is inconclusive: the model stays.
async function probeModel(apiKey, id) {
  try {
    const res = await fetch('https://integrate.api.nvidia.com/v1/chat/completions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: id, messages: [{ role: 'user', content: 'ping' }], max_tokens: 1 }),
      signal: AbortSignal.timeout(15000)
    });
    // Drain the body so the socket is released back to the pool.
    try { await res.text(); } catch { /* body read failure does not change the verdict */ }
    return { dead: res.status === 404, status: res.status };
  } catch (e) {
    return { dead: false, status: 0, error: e && e.message ? e.message : String(e) };
  }
}

// Reconcile classified rows against the previous state and a probe result:
//  - dead ids vanish from the rows entirely (state forgets them; a pin on a
//    dead id is KEPT, so the guard re-arms automatically if the id returns);
//  - ids the state has never seen are NEW: chat rows flip enabled=true so
//    they reach the picker (and only chat ids are reported as added_new -
//    tier X ids land in state rows but never in the picker),
//  - everything else keeps its decided enabled state.
// PURE: no I/O, no fetching.
function reconcileRows(rows, prevState, deadIds) {
  const dead = deadIds instanceof Set ? deadIds : new Set(deadIds || []);
  const known = new Set(((prevState && Array.isArray(prevState.models)) ? prevState.models : []).map((m) => m && m.id).filter(Boolean));
  const out = [];
  const addedIds = [];
  const removedDeadIds = [];
  for (const r of rows) {
    if (dead.has(r.id)) { removedDeadIds.push(r.id); continue; }
    const row = { ...r };
    if (!known.has(r.id)) {
      if (row.category === 'chat') {
        row.enabled = true;
        addedIds.push(r.id);
      }
    }
    out.push(row);
  }
  return { rows: out, addedIds, removedDeadIds };
}

// Probe the enabled chat models of the live models.json list. Returns
// { deadIds, inconclusive }. Concurrency-bounded so a full refresh stays
// well inside the panel's 180s engine timeout.
async function probeEnabledModels(apiKey, ids) {
  const deadIds = [];
  const aliveIds = [];
  const inconclusive = [];
  const queue = [...ids];
  const workers = [];
  const CONCURRENCY = 4;
  for (let w = 0; w < Math.min(CONCURRENCY, queue.length); w++) {
    workers.push((async () => {
      for (;;) {
        const id = queue.shift();
        if (id === undefined) break;
        const r = await probeModel(apiKey, id);
        if (r.dead) deadIds.push(id);
        else if (r.status >= 200 && r.status < 500) aliveIds.push(id);
        else inconclusive.push({ id, status: r.status, error: r.error || '' });
      }
    })());
  }
  await Promise.all(workers);
  return { deadIds: deadIds.sort(), aliveIds, inconclusive };
}

async function loadCatalog(args) {
  if (args.catalog) {
    const raw = readJson(args.catalog);
    // Accept both a raw array and the OpenAI-style {data:[...]} envelope
    // so the same fixture file works as a saved API response.
    const list = Array.isArray(raw) ? raw : (Array.isArray(raw && raw.data) ? raw.data : null);
    if (!list) throw new Error(`--catalog ${args.catalog} is not a JSON array or {data:[...]}`);
    return list;
  }
  const key = loadApiKey(args.keysFile);
  return await fetchCatalog(key);
}

async function runSync(args) {
  const out = finalizeReport();
  const rules = readJson(args.relevancePath);
  const modelsJson = existsSync(args.modelsFile) ? readJson(args.modelsFile) : { providers: { nvidia: { models: [] } } };
  const modelsStore = existsSync(args.storeFile) ? readJson(args.storeFile) : { nvidia: { models: [] } };

  let catalog;
  try {
    catalog = await loadCatalog(args);
  } catch (e) {
    out.ok = false;
    out.error = `catalog fetch failed: ${e.message}`;
    return out;
  }
  const catalogIds = catalog.map((m) => m.id).filter(Boolean);
  if (catalogIds.length === 0) {
    out.ok = false;
    out.error = 'catalog returned 0 models';
    return out;
  }

  const prevState = readStateOrEmpty(args.stateFile);
  // enabled baseline is the live models.json, not prevState, so a
  // first run on an empty state cannot report everything as disabled.
  const liveSet = liveEnabledSet(modelsJson);
  let rows = buildModelRows(catalogIds, rules, modelsJson, modelsStore, liveSet);
  const { pins: pinList } = loadPinSet(prevState, REPO_ROOT);

  // Reconciliation: the catalog keeps LISTING dead deployments, so a real
  // sync probes every currently enabled chat model and drops the ones that
  // answer 404; chat ids the state has never seen are enabled so they reach
  // the picker. Fixture syncs (--catalog, used by the offline tests) skip
  // probing entirely.
  let removedDeadIds = [];
  let addedIds = [];
  let inconclusive = [];
  let probeSkipped = false;
  // Pass 1: mark never-seen chat ids as enabled so the probe set covers
  // them too (a dead endpoint NVIDIA still lists must not sneak back in as
  // a "new" model).
  const marked = reconcileRows(rows, prevState, []);
  rows = marked.rows;
  let deadKnown = carryDead(prevState);
  if (args.catalog) {
    // Fixture mode (offline tests): skip probing, keep reconciliation so
    // the pure logic is exercised without network access.
    probeSkipped = true;
    addedIds = marked.addedIds;
  } else {
    const probeSet = rows.filter((r) => r.tier !== 'X' && r.enabled).map((r) => r.id);
    if (probeSet.length > 0) {
      const apiKey = loadApiKey(args.keysFile);
      const probe = await probeEnabledModels(apiKey, probeSet);
      inconclusive = probe.inconclusive;
      const deadSet = new Set(probe.deadIds);
      const aliveSet = new Set(probe.aliveIds);
      // Pass 2: drop the probed-dead ids; report the net new chat ids.
      const final = reconcileRows(rows, prevState, probe.deadIds);
      rows = final.rows;
      addedIds = marked.addedIds.filter((id) => !deadSet.has(id));
      // Report only removals that were actually picker-visible; ids already
      // known-dead are re-probed for revival but are not news.
      removedDeadIds = final.removedDeadIds.filter((id) => liveSet.has(id));
      // Maintain the known-dead list: add probed-dead, clear definitive
      // revivals (any non-404 HTTP answer proves the deployment exists).
      deadKnown = normalizePinList([...new Set([...carryDead(prevState), ...probe.deadIds])].filter((id) => !aliveSet.has(id)));
    } else {
      addedIds = marked.addedIds;
    }
  }

  // Write models.json only when the reconciled enabled set actually differs
  // from the live file (no backup churn on a no-op refresh). Dead removals
  // and new chat enables both surface here.
  const targetSet = new Set(rows.filter((r) => r.enabled && r.tier !== 'X').map((r) => r.id));
  const setDiffers = targetSet.size !== liveSet.size || [...targetSet].some((id) => !liveSet.has(id));
  let applied = { backup: '', written: false, count: 0, restored: false, error: '' };
  let storePrune = { pruned: [], written: false, backup: '', error: '' };
  if (setDiffers) {
    applied = applyToModelsJson(args.modelsFile, args.backupDir, rows, args.dryRun);
    if (applied.error) {
      out.ok = false;
      out.error = applied.error;
      out.removed_dead = removedDeadIds;
      out.added_new = addedIds;
      out.probe_inconclusive = inconclusive;
      out.probe_skipped = probeSkipped;
      return out;
    }
    const trackedIds = new Set([...rows.map((r) => r.id), ...removedDeadIds]);
    storePrune = pruneStore(args.storeFile, args.storeBackupDir, targetSet, trackedIds, args.dryRun);
  }

  const state = {
    synced_at: new Date().toISOString(),
    source: args.catalog ? 'fixture' : 'api',
    models: rows,
    pins: normalizePinList([...pinList]),
    dead: normalizePinList(deadKnown),
    counts: summarize(rows)
  };
  if (!args.dryRun) writeState(args.stateFile, state);

  out.synced_at = state.synced_at;
  Object.assign(out, buildBaseReport(rows, prevState));
  out.pins = normalizePinList([...pinList]);
  out.removed_dead = removedDeadIds;
  out.added_new = addedIds;
  out.probe_inconclusive = inconclusive;
  out.probe_skipped = probeSkipped;
  out.backup = applied.backup;
  out.pruned_store = storePrune.pruned;
  out.models = rows;
  out.counts = summarize(rows);
  return out;
}

async function runApplyRecommended(args) {
  const out = finalizeReport();
  const rules = readJson(args.relevancePath);
  const modelsJson = existsSync(args.modelsFile) ? readJson(args.modelsFile) : null;
  if (!modelsJson) {
    out.ok = false;
    out.error = `models.json not found at ${args.modelsFile}`;
    return out;
  }
  const modelsStore = existsSync(args.storeFile) ? readJson(args.storeFile) : { nvidia: { models: [] } };
  const prevState = readStateOrEmpty(args.stateFile);

  let catalog;
  try {
    catalog = await loadCatalog(args);
  } catch (e) {
    out.ok = false;
    out.error = `catalog fetch failed: ${e.message}`;
    return out;
  }
  const catalogIds = catalog.map((m) => m.id).filter(Boolean);
  if (catalogIds.length === 0) {
    out.ok = false;
    out.error = 'catalog returned 0 models';
    return out;
  }

  const currentEnabled = liveEnabledSet(modelsJson);
  const initialRows = buildModelRows(catalogIds, rules, modelsJson, modelsStore, currentEnabled);
  const { pins } = loadPinSet(prevState, REPO_ROOT);
  const rows = decideEnabledRows(initialRows, [], '--apply-recommended', currentEnabled, prevState);

  // F3 pin guard: force-keep any pinned id that --apply-recommended would
  // otherwise drop (e.g. a Tier B/C pin that is missing from tierA).
  // Report each force-keep in blocked[] so the panel can explain it.
  const blocked = [];
  const enabledIds = new Set();
  for (const r of rows) if (r.enabled) enabledIds.add(r.id);
  for (const pinId of pins) {
    if (!enabledIds.has(pinId)) {
      const row = rows.find((r) => r.id === pinId);
      if (row) {
        row.enabled = true;
        enabledIds.add(pinId);
        blocked.push({ id: pinId, reason: `pinned model ${pinId} force-kept by --apply-recommended (tier ${row.tier})` });
      }
    }
  }

  const applied = applyToModelsJson(args.modelsFile, args.backupDir, rows, args.dryRun);
  if (applied.error) {
    out.ok = false;
    out.error = applied.error;
    return out;
  }

  // Panel state is the picker's source of truth for nvidia ids: prune
  // state-tracked store entries that this write dropped from models.json.
  const pruneSet = new Set(rows.filter((r) => r.enabled && r.tier !== 'X').map((r) => r.id));
  const trackedIds = new Set(rows.map((r) => r.id));
  const storePrune = pruneStore(args.storeFile, args.storeBackupDir, pruneSet, trackedIds, args.dryRun);

  const nextState = {
    synced_at: new Date().toISOString(),
    source: args.catalog ? 'fixture' : 'api',
    models: rows,
    pins: normalizePinList([...pins]),
    dead: carryDead(prevState),
    counts: summarize(rows)
  };
  if (!args.dryRun) writeState(args.stateFile, nextState);

  out.synced_at = nextState.synced_at;
  Object.assign(out, buildBaseReport(rows, prevState));
  out.backup = applied.backup;
  out.blocked = blocked;
  out.pins = normalizePinList([...pins]);
  out.pruned_store = storePrune.pruned;
  out.models = rows;
  out.counts = summarize(rows);
  return out;
}

async function runEnableDisable(args) {
  const out = finalizeReport();
  const verb = args.verb;
  const rules = readJson(args.relevancePath);
  const modelsJson = existsSync(args.modelsFile) ? readJson(args.modelsFile) : null;
  if (!modelsJson) {
    out.ok = false;
    out.error = `models.json not found at ${args.modelsFile}`;
    return out;
  }
  const modelsStore = existsSync(args.storeFile) ? readJson(args.storeFile) : { nvidia: { models: [] } };
  const prevState = readStateOrEmpty(args.stateFile);

  const currentEnabled = liveEnabledSet(modelsJson);
  let initialRows;
  // State-first fast path: a panel toggle only needs rows the engine has
  // already classified and snapshotted. When the state file knows every
  // requested id we skip the live NVIDIA API entirely, so toggles are
  // instant and keep working during API outages (the old path died here:
  // ok:false, no write, and the UI silently flipped the checkbox back).
  // `--catalog` (test/diagnostic fixture) forces the catalog path, and an
  // id the state has never seen falls back to the live API as before.
  const stateKnowsAllIds =
    !args.catalog &&
    Array.isArray(prevState.models) &&
    prevState.models.length > 0 &&
    args.ids.every((id) => prevState.models.some((m) => m && m.id === id));
  if (stateKnowsAllIds) {
    initialRows = prevState.models.map((r) => ({
      ...r,
      enabled: currentEnabled.has(r.id),
      in_models_json: currentEnabled.has(r.id)
    }));
  } else {
    let catalog;
    try {
      catalog = await loadCatalog(args);
    } catch (e) {
      out.ok = false;
      out.error = `catalog fetch failed: ${e.message}`;
      return out;
    }
    const catalogIds = catalog.map((m) => m.id).filter(Boolean);
    if (catalogIds.length === 0) {
      out.ok = false;
      out.error = 'catalog returned 0 models';
      return out;
    }
    initialRows = buildModelRows(catalogIds, rules, modelsJson, modelsStore, currentEnabled);
  }
  const pins = loadPinSet(prevState, REPO_ROOT).pins;
  const blocked = findPinConflicts(initialRows, verb, args.ids, pins);

  const rows = decideEnabledRows(initialRows, args.ids, verb, currentEnabled, prevState);
  if (blocked.length > 0 && verb === '--disable') {
    const blockedIds = new Set(blocked.map((b) => b.id));
    for (const r of rows) {
      if (blockedIds.has(r.id)) r.enabled = true;
    }
  }

  const applied = applyToModelsJson(args.modelsFile, args.backupDir, rows, args.dryRun);
  if (applied.error) {
    out.ok = false;
    out.error = applied.error;
    return out;
  }

  // Panel state is the picker's source of truth for nvidia ids: prune
  // state-tracked store entries that this write dropped from models.json.
  const pruneSet = new Set(rows.filter((r) => r.enabled && r.tier !== 'X').map((r) => r.id));
  const trackedIds = new Set(rows.map((r) => r.id));
  const storePrune = pruneStore(args.storeFile, args.storeBackupDir, pruneSet, trackedIds, args.dryRun);

  const nextState = {
    synced_at: new Date().toISOString(),
    source: args.catalog ? 'fixture' : 'api',
    models: rows,
    pins: normalizePinList([...pins]),
    dead: carryDead(prevState),
    counts: summarize(rows)
  };
  if (!args.dryRun) writeState(args.stateFile, nextState);

  out.synced_at = nextState.synced_at;
  Object.assign(out, buildBaseReport(rows, prevState));
  out.backup = applied.backup;
  out.blocked = blocked;
  out.pins = normalizePinList([...pins]);
  out.pruned_store = storePrune.pruned;
  out.models = rows;
  out.counts = summarize(rows);
  return out;
}

async function runStatus(args) {
  const out = finalizeReport();
  // F4: --status must always exit 0. A missing or corrupt relevance
  // config or state file is reported via ok:false + error, not via
  // process.exit(1).
  let prevState;
  try {
    prevState = readStateOrEmpty(args.stateFile);
  } catch (e) {
    out.ok = false;
    out.error = `state file corrupt: ${e.message}`;
    return out;
  }
  if (!prevState || !prevState.models || prevState.models.length === 0) {
    out.synced_at = '';
    out.error = '';
    return out;
  }
  const rows = prevState.models;
  out.synced_at = prevState.synced_at || '';
  Object.assign(out, buildBaseReport(rows, prevState));
  out.pins = normalizePinList(prevState.pins);
  out.dead = normalizePinList(prevState.dead);
  // Decorate pin state and advisory agent usage at read time so pin and
  // agent-profile changes reflect immediately without a resync. Shallow
  // copies: the diff in buildBaseReport above must keep comparing the raw
  // state rows. READ-ONLY: a missing pins key seeds in memory, never writes.
  try {
    const { pins } = loadPinSet(prevState, REPO_ROOT);
    const users = agentPinUsers(REPO_ROOT);
    out.models = rows.map((r) => ({ ...r, pinned: pins.has(r.id), agentUsers: users.get(r.id) || [] }));
  } catch {
    out.models = rows;
  }
  out.counts = prevState.counts || summarize(rows);

  // Read live models.json to report enabled models from the NVIDIA provider.
  // This replaces the stale state-file base for the panel, so model toggles
  // made in the built-in model manager appear immediately.
  try {
    if (existsSync(args.modelsFile)) {
      const modelsJson = readJson(args.modelsFile);
      const nvidiaModels = (modelsJson && modelsJson.providers && modelsJson.providers.nvidia && Array.isArray(modelsJson.providers.nvidia.models))
        ? modelsJson.providers.nvidia.models
        : [];
      out.models_json = nvidiaModels.map((m) => ({
        id: m.id,
        vision: Array.isArray(m.input) && m.input.includes('image')
      }));
    } else {
      out.models_json = [];
    }
  } catch {
    out.models_json = [];
  }

  return out;
}

// Pin/unpin runner: edits the state file's `pins` array (sorted, deduped).
// A seed is persisted when the state file had no pins key yet. Pinned ids
// drive findPinConflicts(); the panel's PIN toggle calls these verbs.
async function runPinToggle(args) {
  const out = finalizeReport();
  const prevState = readStateOrEmpty(args.stateFile);
  const { pins, seeded } = loadPinSet(prevState, REPO_ROOT);
  const adding = args.verb === '--pin';
  const knownIds = new Set((prevState.models || []).map((m) => m && m.id).filter(Boolean));
  const users = agentPinUsers(REPO_ROOT);
  const warnings = [];
  for (const id of args.ids) {
    if (adding && !knownIds.has(id)) {
      warnings.push(`${id} is not in the synced catalog; pinning anyway (it will guard once the id appears)`);
    }
    if (adding) pins.add(id);
    else if (!pins.has(id)) warnings.push(`${id} was not pinned; no change`);
    else pins.delete(id);
  }
  const pinList = normalizePinList([...pins]);
  if (!args.dryRun) {
    // Persist pins. When the state file has no rows yet (never synced), keep
    // the empty shell and attach the pins so they survive until the next sync.
    const base = (prevState && Array.isArray(prevState.models) && prevState.models.length > 0)
      ? prevState
      : { synced_at: '', source: 'state', models: [], counts: { chat: 0, non_chat: 0, enabled: 0, recommended: 0 } };
    writeState(args.stateFile, { ...base, pins: pinList });
  }
  out.synced_at = prevState.synced_at || '';
  out.pins = pinList;
  out.pins_changed = args.ids.map((id) => ({ id, pinned: pins.has(id), agentUsers: users.get(id) || [] }));
  out.warnings = warnings;
  out.models = (prevState.models || []).map((r) => ({ ...r, pinned: pins.has(r.id), agentUsers: users.get(r.id) || [] }));
  out.counts = prevState.counts || summarize(prevState.models || []);
  return out;
}

async function runRestoreBackup(args) {
  const out = finalizeReport();
  const applied = restoreLatestBackup(args.modelsFile, args.backupDir, args.dryRun);
  if (!applied.restored && !applied.dryRun) {
    out.ok = false;
    out.error = applied.error || 'restore failed';
    return out;
  }
  if (args.dryRun) {
    // Dry-run: report what would happen, write nothing.
    out.backup = applied.src || '';
    out.error = '';
    return out;
  }
  out.backup = applied.src || '';
  out.pre_restore_backup = applied.pre_restore_backup || '';

  // F6: write a state reflecting the restored models.json so the next
  // --status is truthful. Read the restored file and reclassify rows
  // using the same logic as a sync (without writing anything else).
  try {
    const rules = JSON.parse(readFileSync(args.relevancePath, 'utf8'));
    const restored = readJson(args.modelsFile);
    const store = existsSync(args.storeFile) ? readJson(args.storeFile) : { nvidia: { models: [] } };
    const liveSet = liveEnabledSet(restored);
    // We don't have a fresh catalog here, so we derive rows from the
    // restored models.json ids only. This is enough to give --status a
    // truthful snapshot after a restore.
    const rows = (restored && restored.providers && restored.providers.nvidia && Array.isArray(restored.providers.nvidia.models)
      ? restored.providers.nvidia.models
      : []).map((m) => ({
        id: m.id,
        name: m.name || m.id,
        category: 'chat',
        tier: tierForChatId(m.id, rules),
        relevance: relevanceForTier(tierForChatId(m.id, rules), rules),
        enabled: true,
        in_models_json: true,
        in_store: Boolean((store.nvidia && store.nvidia.models || []).find((s) => s.id === m.id)),
        contextWindow: Number.isFinite(m.contextWindow) ? m.contextWindow : rules.metadataDefaults.contextWindow,
        maxTokens: Number.isFinite(m.maxTokens) ? m.maxTokens : rules.metadataDefaults.maxTokens,
        reasoning: Boolean(m.reasoning),
        input: Array.isArray(m.input) ? m.input : rules.metadataDefaults.input,
        metadata: 'models.json',
        why: whyForTier(tierForChatId(m.id, rules))
      }));
    // Apply Tier X classification: a restored id may still match a tierX
    // substring; mark it but keep enabled (it was already on disk).
    for (const r of rows) {
      const m = matchTierX(r.id, rules.tierX);
      if (m) { r.tier = 'X'; r.category = categoryForPattern(m, rules.category); r.relevance = 'excluded'; r.why = whyForTier('X'); }
    }
    const stateBeforeWrite = readStateOrEmpty(args.stateFile);
    const state = {
      synced_at: new Date().toISOString(),
      source: 'restore',
      models: rows,
      pins: loadPinSet(stateBeforeWrite, REPO_ROOT).pins,
      dead: carryDead(stateBeforeWrite),
      counts: summarize(rows)
    };
    writeState(args.stateFile, state);
    out.synced_at = state.synced_at;
    out.models = rows;
    out.counts = state.counts;
  } catch (e) {
    // State re-write is best-effort; the restore itself succeeded.
    out.error = out.error || `state re-write after restore failed: ${e.message}`;
  }
  return out;
}

async function main() {
  let args;
  try { args = parseArgs(process.argv.slice(2)); }
  catch (e) {
    process.stderr.write(`error: ${e.message}\n`);
    printUsage();
    process.exit(1);
  }

  if (args.help) {
    printUsage();
    process.exit(0);
  }

  args.relevancePath = DEFAULT_RELEVANCE_PATH;
  args.modelsFile    = args.modelsFile ? resolve(args.modelsFile) : DEFAULT_MODELS_FILE;
  args.stateFile     = args.stateFile  ? resolve(args.stateFile)  : DEFAULT_STATE_FILE;
  args.storeFile     = args.storeFile  ? resolve(args.storeFile)  : DEFAULT_STORE_FILE;
  args.storeBackupDir = join(dirname(args.backupDir ? resolve(args.backupDir) : DEFAULT_BACKUP_DIR), 'nvidia-models-store');
  args.keysFile      = args.keysFile   ? resolve(args.keysFile)   : DEFAULT_KEYS_FILE;
  args.backupDir     = args.backupDir  ? resolve(args.backupDir)  : DEFAULT_BACKUP_DIR;

  if (!existsSync(args.relevancePath)) {
    const msg = `relevance config not found at ${args.relevancePath}`;
    if (args.json) {
      process.stdout.write(JSON.stringify(finalizeReport({ ok: false, error: msg })) + '\n');
    } else {
      process.stderr.write(`error: ${msg}\n`);
    }
    process.exit(1);
  }

  let report;
  try {
    if (args.verb === '--sync') report = await runSync(args);
    else if (args.verb === '--status') report = await runStatus(args);
    else if (args.verb === '--apply-recommended') report = await runApplyRecommended(args);
    else if (args.verb === '--enable' || args.verb === '--disable') report = await runEnableDisable(args);
    else if (args.verb === '--pin' || args.verb === '--unpin') report = await runPinToggle(args);
    else if (args.verb === '--restore-backup') report = await runRestoreBackup(args);
    else throw new Error(`unknown verb ${args.verb}`);
  } catch (e) {
    const msg = e && e.message ? e.message : String(e);
    report = finalizeReport({ ok: false, error: msg });
    if (args.json) {
      process.stdout.write(JSON.stringify(report) + '\n');
    } else {
      process.stderr.write(`error: ${msg}\n`);
    }
    // F4: --status must always exit 0 even on an unexpected throw.
    process.exit(args.verb === '--status' ? 0 : 1);
  }

  if (args.json) {
    process.stdout.write(JSON.stringify(report) + '\n');
  } else {
    process.stdout.write(JSON.stringify(report, null, 2) + '\n');
  }
  process.exit(args.verb === '--status' ? 0 : (report.ok ? 0 : 1));
}

const invokedDirectly = (() => {
  try {
    if (!process.argv[1]) return false;
    return resolve(process.argv[1]) === __filename;
  } catch { return false; }
})();
if (invokedDirectly) {
  main().catch((e) => {
    process.stderr.write(`fatal: ${e && e.message ? e.message : e}\n`);
    process.exit(1);
  });
}

export {
  parseArgs,
  matchTierX,
  tierForChatId,
  relevanceForTier,
  categoryForPattern,
  whyForTier,
  resolveMetadata,
  buildModelRows,
  summarize,
  buildBaseReport,
  diffFromState,
  decideEnabledRows,
  findPinConflicts,
  agentPinUsers,
  loadPinSet,
  seedPinList,
  pruneStore,
  reconcileRows,
  probeModel,
  liveEnabledSet,
  HARD_PINNED_IDS,
  TIER_WHY,
  DEFAULT_RELEVANCE_PATH,
  DEFAULT_MODELS_FILE,
  DEFAULT_STATE_FILE,
  DEFAULT_BACKUP_DIR,
  DEFAULT_STORE_BACKUP_DIR,
  readJson,
  writeJsonAtomic,
  rebuildModelsJson,
  applyToModelsJson,
  backupModelsJson,
  latestBackup,
  restoreLatestBackup,
  listBackups,
  writeState,
  readStateOrEmpty,
  loadApiKey,
  runSync,
  runStatus,
  runApplyRecommended,
  runEnableDisable,
  runRestoreBackup
};
