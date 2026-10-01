#!/usr/bin/env node
// wire-mcp.mjs — add/update ONE MCP server entry in ~/.pi/agent/mcp.json.
//
// Dependency-free. Used by the install scripts (cua-driver step) and runnable
// standalone. JSON read-modify-write: never clobbers existing servers; writes a
// backup beside the file before the change; validates the result parses before
// exiting 0.
//
// Usage:
//   node wire-mcp.mjs --id cua-driver --command "C:\\...\\cua-driver.exe" --args mcp
//   node wire-mcp.mjs --id cua-driver --remove
//   node wire-mcp.mjs --json          (machine-readable result)
//
// --args takes the remaining flags after it, space-separated, e.g. --args mcp
// or --args --config foo.json.

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const argv = process.argv.slice(2);
const asJson = argv.includes("--json");

function out(msg) {
  if (!asJson) console.log(msg);
}

function fail(msg) {
  if (asJson) console.log(JSON.stringify({ ok: false, error: msg }));
  else console.error("wire-mcp: " + msg);
  process.exit(1);
}

// --- parse args (two-pass: known flags consumed everywhere; --args takes the rest) ---
let id = null;
let command = null;
let args = [];
let remove = false;
const KNOWN = new Set(["--id", "--command", "--remove", "--json", "--args"]);
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === "--id") id = argv[++i];
  else if (a === "--command") command = argv[++i];
  else if (a === "--remove") remove = true;
  else if (a === "--args") {
    // Everything after --args belongs to the server entry — EXCEPT known flags
    // (a trailing --json would otherwise become a server arg; caught by test).
    for (let j = i + 1; j < argv.length; j++) {
      if (!KNOWN.has(argv[j])) args.push(argv[j]);
    }
    break;
  }
}

if (!id) fail("no --id given (usage: node wire-mcp.mjs --id <name> --command <exe> --args <args...>)");
if (!remove && !command) fail(`no --command given for server "${id}"`);

// --- resolve the config file: ~/.pi/agent/mcp.json (override for tests) ---
const configPath = process.env.GLITCH_MCP_JSON || join(homedir(), ".pi", "agent", "mcp.json");

// --- read current (missing file or bad JSON = empty config, never crash) ---
let config = { mcpServers: {} };
if (existsSync(configPath)) {
  try {
    const parsed = JSON.parse(readFileSync(configPath, "utf8"));
    if (parsed && typeof parsed === "object" && parsed.mcpServers && typeof parsed.mcpServers === "object") {
      config = parsed;
    } else if (parsed && typeof parsed === "object") {
      // mcp.json exists but has no mcpServers key — keep the other keys, add ours.
      config = { ...parsed, mcpServers: {} };
    }
  } catch (err) {
    fail(`existing ${configPath} does not parse as JSON (${err.message}) — refusing to touch it`);
  }
}

const before = config.mcpServers[id] ? "updated" : "added";
const action = remove ? "removed" : before;
const hadOtherServers = Object.keys(config.mcpServers).filter((k) => k !== id);

// --- apply ---
if (remove) {
  if (!config.mcpServers[id]) {
    out(`wire-mcp: server "${id}" not present in ${configPath} — nothing to remove`);
    if (asJson) console.log(JSON.stringify({ ok: true, action: "absent", path: configPath }));
    process.exit(0);
  }
  delete config.mcpServers[id];
} else {
  config.mcpServers[id] = { command, args: args.length > 0 ? args : [] };
}

const after = JSON.stringify(config, null, "\t") + "\n";
try {
  JSON.parse(after);
} catch (err) {
  fail(`result does not parse (${err.message}) — aborting without writing`);
}

// --- backup + write (atomic rename; the rename IS the backup) ---
mkdirSync(join(configPath, ".."), { recursive: true });
if (existsSync(configPath)) {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  renameSync(configPath, `${configPath}.bak-${stamp}`);
}
writeFileSync(configPath, after);

// --- verify on disk ---
try {
  const check = JSON.parse(readFileSync(configPath, "utf8"));
  if (remove && check.mcpServers[id]) fail("verify failed: entry still present after remove");
  if (!remove && !check.mcpServers[id]) fail("verify failed: entry missing after write");
} catch (err) {
  fail(`verify failed: ${err.message}`);
}

out(`wire-mcp: ${action} "${id}" in ${configPath} (${hadOtherServers.length} other server(s) preserved)`);
if (asJson) {
  console.log(JSON.stringify({ ok: true, action, id, path: configPath, preserved: hadOtherServers }));
}
