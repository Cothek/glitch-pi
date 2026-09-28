#!/usr/bin/env node
/**
 * sync-nvidia-models.mjs — NVIDIA NIM live model sync (Pi edition)
 *
 * instead of a static catalog, ping the NVIDIA servers and let the live
 * /v1/models response determine the NVIDIA model list pi offers.
 *
 * WHAT IT DOES
 *   1. Resolve the NVIDIA API key (NVIDIA_API_KEY env -> ~/.pi/agent/auth.json)
 *   2. GET https://integrate.api.nvidia.com/v1/models (Bearer auth)
 *   3. Filter out non-chat models (embeddings, rerankers, retrieval, TTS, ...)
 *   4. Merge metadata from pi's built-in NVIDIA catalog (context window, cost,
 *      compat flags, thinking level maps) so known models keep curated data;
 *      genuinely new ids get conservative defaults from name heuristics
 *   5. Apply the curated-subset filter so the picker shows a modern subset
 *      (env NVIDIA_CURATED=0 writes the full list instead)
 *   6. Write the merged list to ~/.pi/agent/models.json under providers.nvidia
 *      (atomic temp+rename; other providers and user-added nvidia entries are
 *      preserved)
 *   7. Cache the result in data/nvidia-models-cache.json (TTL-gated)
 *
 * pi re-reads models.json every time /model or the web model picker opens,
 * so an updated file is picked up without restarting pi.
 *
 * MERGE SEMANTICS (pi models.json)
 *   - Built-in catalog models are KEPT; custom models are upserted by id.
 *   - Same id as a built-in -> replaces it (this is how live metadata wins).
 *   - The web picker renders the UNION of models.json + pi's built-in catalog
 *     + models-store.json. Built-in ids always show, so the curated subset
 *     keeps them; ids only this script syncs vanish from the picker when
 *     filtered out of models.json.
 *
 * CURATED SUBSET
 *   The picker shows every modern family (nemotron, kimi-k, glm-5, deepseek-v4,
 *   gemma-3/4, gpt-oss, llama-3, muse-glimmer, laguna, cosmos-reason) plus all
 *   built-in ids. Legacy one-off models (llama2, granite-3.0, codellama,
 *   mixtral, phi-3, palmyra-*, ...) stay out. Set NVIDIA_CURATED=0 to write
 *   the full NIM list instead.
 *
 * USAGE
 *   node scripts/sync-nvidia-models.mjs              # sync if cache stale
 *   node scripts/sync-nvidia-models.mjs --force      # ignore cache TTL
 *   node scripts/sync-nvidia-models.mjs --dry-run    # print, don't write
 *
 * Triggered automatically by .pi/extensions/nvidia-model-sync.ts at
 * session_start (TTL cache keeps NIM pings to ~1 per 30 min).
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync, renameSync, statSync, unlinkSync, appendFileSync } from 'fs';
import { join, dirname, resolve } from 'path';
import { homedir } from 'os';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const ROOT_DIR = resolve(__dirname, '..');

// ---- Paths ----
const AGENT_DIR = join(homedir(), '.pi', 'agent');
const MODELS_JSON = join(AGENT_DIR, 'models.json');
const AUTH_JSON = join(AGENT_DIR, 'auth.json');
const CACHE_FILE = join(ROOT_DIR, 'data', 'nvidia-models-cache.json');
const LOCK_FILE = join(ROOT_DIR, 'data', '.nvidia-sync.lock');
const LOG_FILE = join(ROOT_DIR, 'data', 'logs', 'nvidia-model-sync.log');

const NIM_BASE_URL = 'https://integrate.api.nvidia.com/v1';
const FETCH_TIMEOUT_MS = 20000;
const LOCK_STALE_MS = 90000;

// Built-in pi-ai NVIDIA catalogs (TUI install + pi-web-ui nested install).
// Used as the metadata source so known models keep curated context windows,
// costs, compat flags and thinking level maps instead of generic defaults.
const CATALOG_PROBE_PATHS = [
  join(ROOT_DIR, 'data', 'node', 'node_modules', '@earendil-works', 'pi-coding-agent', 'node_modules', '@earendil-works', 'pi-ai', 'dist', 'providers', 'data', 'nvidia.json'),
  join(ROOT_DIR, 'data', 'node', 'node_modules', 'pi-web-ui', 'node_modules', '@earendil-works', 'pi-coding-agent', 'node_modules', '@earendil-works', 'pi-ai', 'dist', 'providers', 'data', 'nvidia.json'),
];

// Provider-wide NIM compat (mirrors what pi's generated catalog sets per model).
const NIM_PROVIDER_SECTION = {
  baseUrl: NIM_BASE_URL,
  api: 'openai-completions',
  headers: { 'NVCF-POLL-SECONDS': '3600' },
  compat: {
    supportsStore: false,
    supportsDeveloperRole: false,
    supportsReasoningEffort: false,
    maxTokensField: 'max_tokens',
    supportsStrictMode: false,
    supportsLongCacheRetention: false,
  },
};

// Categorically non-chat NIM offerings. Anything matching is dropped from
// the picker list. Kept conservative: chat-capable code / base / research
// models stay (the OpenCode flow kept everything the API returned).
const NON_CHAT_RE =
  /(?:embed|rerank|retriev|riva|translat|detector|sdxl|stable-?diffusion|instaflow|lightricks|playground-|\/pike|proteus|deplot|kosmos|paligemma|fuyu|clip|bge-|e5-|nv-embedqa|nemoretriever|nemoguard|llama-guard|guardbench|ocr|spectro|whisper|canary|parakeet|kokoro|piper|-tts|asr|speech|voice|usd-|mesh|nerf|splat|neva|vila|safety|reward|nemotron-parse|\/ising)/i;

// Heuristics for models absent from the built-in catalog.
const REASONING_RE = /nemotron|reason|kimi-k|gpt-oss|^z-ai\/glm|deepseek-v4|muse-glimmer|qwen3|magistral/i;

// Curated-subset keep filter (NVIDIA_CURATED=0 disables). A synced id survives
// if it matches a modern family; built-in catalog ids are always kept because
// pi renders them regardless of models.json (see MERGE SEMANTICS above).
const CURATED_KEEP_RE =
  /kimi-k|deepseek-v4|^z-ai\/glm|nemotron|gemma-[34]-|gpt-oss|muse-glimmer|laguna|llama-3|cosmos-reason/i;
const VISION_RE = /vision|gemma-[34]|omni|glm-.*flash|cosmos-reason|muse-glimmer|phi-3.*vision/i;
const CTX_FAMILIES = [
  [/kimi-k3/, 1048576],
  [/deepseek-v4|glm-5|nemotron-3-ultra/, 1000000],
  [/nemotron-3-super|kimi-k2|muse-glimmer|laguna/, 262144],
  [/nemotron-3-nano/, 256000],
];

// ---- Small utils ----
function log(msg, opts = {}) {
  const line = `[${new Date().toISOString()}] ${msg}`;
  if (!opts.quiet) console.log(msg);
  try {
    mkdirSync(dirname(LOG_FILE), { recursive: true });
    appendFileSync(LOG_FILE, line + '\n', 'utf-8');
  } catch { /* best-effort */ }
}

function readJson(path) {
  try {
    let content = readFileSync(path, 'utf-8');
    if (content.charCodeAt(0) === 0xFEFF) content = content.slice(1);
    return JSON.parse(content);
  } catch {
    return null;
  }
}

function writeJsonAtomic(path, data) {
  const tmp = path + '.tmp-' + process.pid;
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n', 'utf-8');
  renameSync(tmp, path);
}

function prettifyName(id) {
  const last = id.split('/').pop();
  return last
    .replace(/[-_]/g, ' ')
    .replace(/\b\w/g, (c) => c.toUpperCase())
    .trim();
}

// ---- NVIDIA API key ----
function resolveApiKey() {
  if (process.env.NVIDIA_API_KEY) return process.env.NVIDIA_API_KEY;
  const auth = readJson(AUTH_JSON);
  const key = auth && auth.nvidia && typeof auth.nvidia.key === 'string' ? auth.nvidia.key : null;
  return key || null;
}

// ---- Built-in catalog metadata ----
function loadBuiltinCatalog() {
  for (const p of CATALOG_PROBE_PATHS) {
    if (existsSync(p)) {
      const raw = readJson(p);
      if (raw && raw['openai-completions']) {
        return raw['openai-completions'];
      }
    }
  }
  return {};
}

/** Convert a pi-ai catalog entry into a models.json model entry. */
function catalogToModelsJsonEntry(entry) {
  const out = { id: entry.id };
  if (entry.name) out.name = entry.name;
  if (typeof entry.reasoning === 'boolean') out.reasoning = entry.reasoning;
  if (Array.isArray(entry.input)) out.input = entry.input;
  if (typeof entry.contextWindow === 'number') out.contextWindow = entry.contextWindow;
  if (typeof entry.maxTokens === 'number') out.maxTokens = entry.maxTokens;
  if (entry.cost) out.cost = entry.cost;
  if (entry.compat) out.compat = entry.compat;
  if (entry.thinkingLevelMap) out.thinkingLevelMap = entry.thinkingLevelMap;
  return out;
}

/** Conservative metadata for models the built-in catalog doesn't know. */
function heuristicsEntry(id) {
  const reasoning = REASONING_RE.test(id);
  const vision = VISION_RE.test(id);
  let contextWindow = 128000;
  for (const [re, ctx] of CTX_FAMILIES) {
    if (re.test(id)) { contextWindow = ctx; break; }
  }
  // Ids carrying an explicit context token ("...-8k-instruct", "...-32k") win over guesses.
  const kToken = String(id).match(/(?:^|-)(\d+)k(?:-|$)/i);
  if (kToken) contextWindow = Math.min(contextWindow, parseInt(kToken[1], 10) * 1024);
  const entry = {
    id,
    name: prettifyName(id),
    reasoning,
    input: vision ? ['text', 'image'] : ['text'],
    contextWindow,
    maxTokens: Math.min(contextWindow, 16384),
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  };
  if (reasoning && /deepseek/i.test(id)) {
    // NIM serves DeepSeek family with reasoning_content replay like pi's catalog entry.
    entry.compat = { requiresReasoningContentOnAssistantMessages: true, thinkingFormat: 'deepseek' };
  }
  return entry;
}

// ---- Fetch live model ids ----
async function fetchLiveModelIds(apiKey) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(`${NIM_BASE_URL}/models`, {
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: controller.signal,
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const body = await res.json();
    const ids = Array.isArray(body.data) ? body.data.map((m) => m.id).filter(Boolean) : [];
    return ids;
  } finally {
    clearTimeout(timer);
  }
}

// ---- Lock (concurrent session starts) ----
function acquireLock() {
  try {
    if (existsSync(LOCK_FILE)) {
      const age = Date.now() - statSync(LOCK_FILE).mtimeMs;
      if (age < LOCK_STALE_MS) return false; // another sync is in flight
      unlinkSync(LOCK_FILE); // stale lock
    }
    writeFileSync(LOCK_FILE, String(process.pid), 'utf-8');
    return true;
  } catch {
    return false; // cannot manage locks -> behave like "in flight" and skip
  }
}
function releaseLock() {
  try { if (existsSync(LOCK_FILE)) unlinkSync(LOCK_FILE); } catch { /* best-effort */ }
}

// ---- Engine disable-state (user intent) ----
// data/nvidia-models-state.json is the NVIDIA Models panel's source of
// truth for "the user turned this model off". This sync re-adds every
// curated live catalog id to models.json, so without this check it
// silently re-enables models the user disabled (they reappear in the
// picker, and the next engine verb re-marks them enabled in the state —
// the checkbox rechecks itself). Fail-open: missing or corrupt state =
// no exclusions (first-run behavior).
const ENGINE_STATE_FILE = join(ROOT_DIR, 'data', 'nvidia-models-state.json');

function disabledModelIds() {
  try {
    const raw = readJson(ENGINE_STATE_FILE);
    const models = raw && Array.isArray(raw.models) ? raw.models : [];
    return new Set(models.filter((m) => m && m.id && m.enabled === false).map((m) => m.id));
  } catch {
    return new Set();
  }
}

// ---- Main ----
async function main() {
  const args = process.argv.slice(2);
  if (args.includes('--help') || args.includes('-h')) {
    console.log(`Usage: node scripts/sync-nvidia-models.mjs [--force] [--dry-run] [--ttl-min N]
  --force     Ignore the cache TTL and re-ping NVIDIA
  --dry-run   Print the merged result without writing models.json
  --ttl-min N Cache TTL in minutes (default 30, env NVIDIA_SYNC_TTL_MIN)

  NVIDIA_CURATED=0 disables the curated subset (writes the full NIM list).`);
    process.exit(0);
  }
  const force = args.includes('--force');
  const dryRun = args.includes('--dry-run');
  const ttlMin = parseInt(
    args.find((_, i, a) => a[i - 1] === '--ttl-min') || process.env.NVIDIA_SYNC_TTL_MIN || '30',
    10
  );
  const quiet = process.env.NVIDIA_SYNC_QUIET === '1';
  const logOpts = { quiet };

  // 1. TTL check — the extension spawns this on session_start, so a fresh
  //    cache means "nothing to do" for most sessions.
  const cache = readJson(CACHE_FILE) || {};
  const ttlMs = (Number.isFinite(ttlMin) && ttlMin > 0 ? ttlMin : 30) * 60 * 1000;
  if (!force && cache.fetchedAt && Date.now() - cache.fetchedAt < ttlMs) {
    // Refresh mtime so the extension's spawn gate (mtime-based) stays in
    // lockstep with this TTL check instead of re-spawning every session.
    try { writeJsonAtomic(CACHE_FILE, { ...cache, checkedAt: Date.now() }); } catch { /* best-effort */ }
    log(`NVIDIA: cache fresh (${cache.count || 'unknown count'} models, pinged ${new Date(cache.fetchedAt).toISOString()}) - skipping`, logOpts);
    process.exit(0);
  }

  // 2. Key
  const apiKey = resolveApiKey();
  if (!apiKey) {
    log(`NVIDIA: no API key found (NVIDIA_API_KEY env or ${AUTH_JSON} nvidia.key) - skipping sync`, logOpts);
    process.exit(1);
  }

  // 3. Lock — only one ping/write at a time across pi sessions
  if (!acquireLock()) {
    log('NVIDIA: sync already in progress (lock held) - skipping', logOpts);
    process.exit(0);
  }

  try {
    // 4. Ping NVIDIA
    let liveIds;
    try {
      liveIds = await fetchLiveModelIds(apiKey);
    } catch (e) {
      // On failure keep models.json as-is; bump cache so failing endpoints
      // aren't hammered on every session start (TTL acts as backoff).
      const failedCache = { ...cache, lastErrorAt: Date.now(), lastError: e.message || String(e) };
      writeJsonAtomic(CACHE_FILE, failedCache);
      log(`NVIDIA: ping failed (${e.message || e}) - keeping existing model list`, logOpts);
      releaseLock();
      process.exit(1);
    }
    if (liveIds.length === 0) {
      log('NVIDIA: /v1/models returned no models - keeping existing list', logOpts);
      releaseLock();
      process.exit(1);
    }

    // 5. Filter non-chat models
    const chatIds = liveIds.filter((id) => !NON_CHAT_RE.test(id)).sort();

    // 6. Merge metadata: built-in catalog first, heuristics for new ids
    const catalog = loadBuiltinCatalog();
    const liveEntries = chatIds.map((id) => {
      const known = catalog[id] ? catalogToModelsJsonEntry(catalog[id]) : null;
      return known || heuristicsEntry(id);
    });

    // 6.5 Curated subset: modern families + all built-in ids (they render in
    //     the picker regardless, so keeping them keeps the count honest).
    //     Ids the user disabled in the NVIDIA Models panel are excluded in
    //     BOTH modes (curated and full): user intent beats the catalog.
    const disabledIds = disabledModelIds();
    const curated = process.env.NVIDIA_CURATED !== '0';
    const builtinIds = new Set(Object.keys(catalog));
    const visibleEntries = liveEntries.filter(
      (e) =>
        !disabledIds.has(e.id) &&
        (curated ? builtinIds.has(e.id) || CURATED_KEEP_RE.test(e.id) : true)
    );

    // 7. Merge into models.json, preserving other providers and user-added
    //    nvidia entries (ids this script has never synced = user-owned).
    const modelsJson = readJson(MODELS_JSON) || { providers: {} };
    if (!modelsJson.providers || typeof modelsJson.providers !== 'object') modelsJson.providers = {};
    const prevNvidia = modelsJson.providers.nvidia || {};
    const prevCustomIds = new Set((Array.isArray(prevNvidia.models) ? prevNvidia.models : []).map((m) => m.id));
    const syncedBefore = new Set(Array.isArray(cache.syncedIds) ? cache.syncedIds : []);
    const liveIdSet = new Set(chatIds);

    const keepUserEntries = (Array.isArray(prevNvidia.models) ? prevNvidia.models : []).filter(
      (m) => m && m.id && !liveIdSet.has(m.id) && !syncedBefore.has(m.id) && !disabledIds.has(m.id)
    );

    const mergedModels = [...visibleEntries, ...keepUserEntries].sort((a, b) => String(a.id).localeCompare(String(b.id)));

    // New = live ids that weren't in the previous sync
    const newCount = chatIds.filter((id) => !syncedBefore.has(id)).length;

    const newNvidiaSection = { ...prevNvidia, ...NIM_PROVIDER_SECTION, models: mergedModels };
    const newModelsJson = { ...modelsJson, providers: { ...modelsJson.providers, nvidia: newNvidiaSection } };

    if (dryRun) {
      console.log(`Dry run - would write ${mergedModels.length} NVIDIA models (${newCount} new, ${curated ? 'curated subset' : 'full list'}) to ${MODELS_JSON}`);
      if (curated) console.log(mergedModels.map((m) => m.id).join('\n'));
      else console.log(JSON.stringify(newModelsJson.providers.nvidia, null, 2).slice(0, 4000));
      releaseLock();
      process.exit(0);
    }

    writeJsonAtomic(MODELS_JSON, newModelsJson);

    // 8. Update cache (also serves as failure backoff via mtime)
    writeJsonAtomic(CACHE_FILE, {
      fetchedAt: Date.now(),
      count: chatIds.length,
      ids: chatIds,
      syncedIds: chatIds,
      ...(curated ? { curatedCount: visibleEntries.length, curatedIds: visibleEntries.map((m) => m.id) } : {}),
      baseUrl: NIM_BASE_URL,
    });

    log(`NVIDIA: ${chatIds.length} live models (${newCount} new) - ${curated ? `${visibleEntries.length} curated` : 'full list'} written to models.json${disabledIds.size ? ` (${disabledIds.size} panel-disabled kept out)` : ''}`, logOpts);
  } finally {
    releaseLock();
  }
}

main().catch((e) => {
  log(`NVIDIA: sync fatal (${e.message || e})`, { quiet: false });
  releaseLock();
  process.exit(1);
});
