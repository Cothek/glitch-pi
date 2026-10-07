#!/usr/bin/env node
// sync-freetoken-limit.mjs -- Detect the real FreeToken KV cache budget and apply it to opencode.json.
//
// The FreeToken server advertises max_model_len=262144 in /v1/models, but the ACTUAL
// KV cache budget is much smaller (observed 65536 tokens). OpenCode trusts the
// configured limit.context, so if it's set too high, OpenCode never compacts early
// enough and the server rejects with "prompt is too long: N tokens > M maximum".
//
// This script:
//   1. Runs probe-freetoken-limit.mjs to binary-search the real budget
//   2. Backs up opencode.json
//   3. Writes the detected safe context/output into the freetoken model limit
//   4. Sets compaction.reserved to leave room for the compaction summary
//
// Usage:
//   node scripts/sync-freetoken-limit.mjs [--dry-run] [--base-url ...] [--model ...]
//
// Exit codes: 0 = applied, 1 = error, 2 = no change needed

import { readFileSync, writeFileSync, copyFileSync, existsSync, mkdirSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { spawnSync } from "child_process";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = join(SCRIPT_DIR, "..");
const CONFIG_PATH = join(ROOT_DIR, "opencode.json");
const PROBE_PATH = join(SCRIPT_DIR, "probe-freetoken-limit.mjs");

const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const baseUrlIdx = args.indexOf("--base-url");
const baseUrl = baseUrlIdx !== -1 ? args[baseUrlIdx + 1] : undefined;
const modelIdx = args.indexOf("--model");
const model = modelIdx !== -1 ? args[modelIdx + 1] : undefined;

function log(msg) { console.log(msg); }

function readConfig() {
  let raw = readFileSync(CONFIG_PATH, "utf-8");
  if (raw.charCodeAt(0) === 0xFEFF) raw = raw.slice(1);
  return JSON.parse(raw);
}

function writeConfig(config) {
  const json = JSON.stringify(config, null, 2) + "\n";
  writeFileSync(CONFIG_PATH, json, "utf-8");
}

function main() {
  if (!existsSync(CONFIG_PATH)) {
    log(`ERROR: Config not found: ${CONFIG_PATH}`);
    process.exit(1);
  }
  if (!existsSync(PROBE_PATH)) {
    log(`ERROR: Probe script not found: ${PROBE_PATH}`);
    process.exit(1);
  }

  // 1. Run the probe
  log("==> Probing FreeToken server for real KV cache budget...");
  const probeArgs = [];
  if (baseUrl) probeArgs.push("--base-url", baseUrl);
  if (model) probeArgs.push("--model", model);
  const probe = spawnSync("node", [PROBE_PATH, ...probeArgs], {
    encoding: "utf-8",
    timeout: 300000,
  });
  if (probe.status !== 0) {
    log(`ERROR: Probe failed:\n${probe.stderr || probe.stdout}`);
    process.exit(1);
  }
  let detected;
  try {
    detected = JSON.parse(probe.stdout.trim());
  } catch (e) {
    log(`ERROR: Could not parse probe output:\n${probe.stdout}`);
    process.exit(1);
  }
  log(`  Advertised: ${detected.advertised} tokens`);
  log(`  Detected:   ${detected.detected} tokens (real KV cache budget)`);
  log(`  Safe:       context=${detected.safe_context}, output=${detected.safe_output}`);

  // 2. Read current config
  const config = readConfig();
  const freetoken = config.provider?.freetoken;
  if (!freetoken) {
    log("ERROR: No 'freetoken' provider in config.");
    process.exit(1);
  }
  const modelKey = model || Object.keys(freetoken.models || {})[0];
  const modelCfg = freetoken.models?.[modelKey];
  if (!modelCfg) {
    log(`ERROR: Model '${modelKey}' not found in freetoken provider.`);
    process.exit(1);
  }

  const currentContext = modelCfg.limit?.context;
  const currentOutput = modelCfg.limit?.output;
  const currentReserved = config.compaction?.reserved;

  const newContext = detected.safe_context;
  const newOutput = detected.safe_output;
  const newReserved = Math.min(8192, Math.floor(detected.detected * 0.15));

  const changed =
    currentContext !== newContext ||
    currentOutput !== newOutput ||
    currentReserved !== newReserved;

  if (!changed) {
    log("  No change needed (config already matches detected limit).");
    process.exit(2);
  }

  // 3. Back up
  const backupPath = join(ROOT_DIR, "data", "backups", `opencode-freetoken-${Date.now()}.json`);
  if (!dryRun) {
    const backupDir = join(ROOT_DIR, "data", "backups");
    if (!existsSync(backupDir)) {
      mkdirSync(backupDir, { recursive: true });
    }
    copyFileSync(CONFIG_PATH, backupPath);
    log(`  Backup: ${backupPath}`);
  }

  // 4. Apply
  if (!modelCfg.limit) modelCfg.limit = {};
  modelCfg.limit.context = newContext;
  modelCfg.limit.output = newOutput;
  if (!config.compaction) config.compaction = {};
  config.compaction.reserved = newReserved;

  if (dryRun) {
    log("  [DRY RUN] Would apply:");
    log(`    freetoken.${modelKey}.limit.context = ${newContext} (was ${currentContext})`);
    log(`    freetoken.${modelKey}.limit.output  = ${newOutput} (was ${currentOutput})`);
    log(`    compaction.reserved                 = ${newReserved} (was ${currentReserved})`);
    process.exit(0);
  }

  writeConfig(config);
  log("  Applied:");
  log(`    freetoken.${modelKey}.limit.context = ${newContext} (was ${currentContext})`);
  log(`    freetoken.${modelKey}.limit.output  = ${newOutput} (was ${currentOutput})`);
  log(`    compaction.reserved                 = ${newReserved} (was ${currentReserved})`);
  log("  Done. Restart opencode for changes to take effect.");
  process.exit(0);
}

main();