#!/usr/bin/env node
// query-session-tokens.mjs — read token usage for opencode sessions from the
// SQLite DB. Used by the mulahazah plugin's token-based memory trigger.
//
// Usage:
//   node scripts/query-session-tokens.mjs [--db <path>] <sessionID> [sessionID...]
//
// Output: JSON object keyed by sessionID:
//   { [id]: { input, output, reasoning, cacheRead, cacheWrite, cost } }
//
// DB resolution order:
//   1. --db <path> (explicit, used by tests)
//   2. $OPENCODE_DB_PATH
//   3. $XDG_DATA_HOME/opencode/opencode.db
//   4. ~/.local/share/opencode/opencode.db (default)
import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";
import { homedir } from "node:os";
import { existsSync } from "node:fs";

function resolveDbPath(explicit) {
  if (explicit && existsSync(explicit)) return explicit;
  if (process.env.OPENCODE_DB_PATH && existsSync(process.env.OPENCODE_DB_PATH)) {
    return process.env.OPENCODE_DB_PATH;
  }
  if (process.env.XDG_DATA_HOME) {
    const p = join(process.env.XDG_DATA_HOME, "opencode", "opencode.db");
    if (existsSync(p)) return p;
  }
  return join(homedir(), ".local", "share", "opencode", "opencode.db");
}

const args = process.argv.slice(2);
let dbPathArg;
const ids = [];
for (let i = 0; i < args.length; i++) {
  if (args[i] === "--db" && i + 1 < args.length) {
    dbPathArg = args[++i];
  } else {
    ids.push(args[i]);
  }
}

if (ids.length === 0) {
  console.error("Usage: node query-session-tokens.mjs [--db <path>] <sessionID> [sessionID...]");
  process.exit(1);
}

const dbPath = resolveDbPath(dbPathArg);
if (!existsSync(dbPath)) {
  console.error(`DB not found: ${dbPath}`);
  process.exit(2);
}

let db;
try {
  db = new DatabaseSync(dbPath, { readOnly: true });
} catch (err) {
  console.error(`Failed to open DB: ${err.message}`);
  process.exit(3);
}

const result = {};
try {
  const stmt = db.prepare(
    "SELECT id, tokens_input, tokens_output, tokens_reasoning, tokens_cache_read, tokens_cache_write, cost FROM session WHERE id = ?"
  );
  for (const id of ids) {
    const row = stmt.get(id);
    if (row) {
      result[id] = {
        input: row.tokens_input || 0,
        output: row.tokens_output || 0,
        reasoning: row.tokens_reasoning || 0,
        cacheRead: row.tokens_cache_read || 0,
        cacheWrite: row.tokens_cache_write || 0,
        cost: row.cost || 0,
      };
    }
  }
} catch (err) {
  console.error(`Query failed: ${err.message}`);
  process.exit(4);
} finally {
  try { db.close(); } catch {}
}

console.log(JSON.stringify(result));