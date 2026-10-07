import sqlite3 from 'node:sqlite';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { existsSync } from 'node:fs';

const DB_PATH = join(homedir(), '.local', 'share', 'opencode', 'opencode.db');

function openDB() {
  if (!existsSync(DB_PATH)) return null;
  try {
    return new sqlite3.DatabaseSync(DB_PATH);
  } catch { return null; }
}

function queryRecentSessions(hoursBack = 6) {
  const db = openDB();
  if (!db) return { error: 'DB not found', path: DB_PATH };

  try {
    const cutoff = Date.now() - hoursBack * 3600 * 1000;
    const sessions = db.prepare(
      `SELECT id, parent_id, agent, model, cost,
              tokens_input, tokens_output,
              time_created, time_updated, title
       FROM session
       WHERE time_created > ?
       ORDER BY time_created DESC
       LIMIT 100`
    ).all(cutoff);

    const sessionMap = new Map();
    const roots = [];

    for (const s of sessions) {
      let modelId = 'unknown';
      try { modelId = JSON.parse(s.model).id || 'unknown'; } catch {}

      const entry = {
        id: s.id,
        parentId: s.parent_id,
        agent: s.agent || 'unknown',
        model: modelId,
        cost: s.cost || 0,
        tokensInput: s.tokens_input || 0,
        tokensOutput: s.tokens_output || 0,
        timeCreated: s.time_created,
        timeUpdated: s.time_updated,
        title: (s.title || '').slice(0, 120),
        children: []
      };

      sessionMap.set(s.id, entry);
    }

    for (const s of sessions) {
      const entry = sessionMap.get(s.id);
      if (s.parent_id && sessionMap.has(s.parent_id)) {
        sessionMap.get(s.parent_id).children.push(entry);
      } else if (!s.parent_id) {
        roots.push(entry);
      }
    }

    const orphans = [];
    for (const s of sessions) {
      if (s.parent_id && !sessionMap.has(s.parent_id)) {
        orphans.push(sessionMap.get(s.id));
      }
    }

    return {
      sessions: roots,
      orphans,
      total: sessions.length,
      period: `${hoursBack}h`,
      generatedAt: new Date().toISOString()
    };
  } catch (err) {
    return { error: err.message };
  } finally {
    try { db.close(); } catch {}
  }
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, '/'))) {
  const hours = parseInt(process.argv[2], 10) || 6;
  console.log(`=== OpenCode Recent Sessions (last ${hours}h) ===\n`);
  const result = queryRecentSessions(hours);
  if (result.error) {
    console.error('Error:', result.error);
    process.exit(1);
  }
  console.log(`Total: ${result.total} sessions\n`);

  function printTree(node, depth = 0) {
    const indent = '  '.repeat(depth);
    const age = Math.round((Date.now() - node.timeUpdated) / 60000);
    console.log(`${indent}${node.agent} | ${node.model} | $${node.cost.toFixed(4)} | ${age}m ago`);
    console.log(`${indent}  ${node.title}`);
    for (const child of node.children) {
      printTree(child, depth + 1);
    }
  }

  for (const root of result.sessions) {
    printTree(root);
    console.log();
  }
  if (result.orphans.length > 0) {
    console.log(`--- Orphans (parent outside window) ---`);
    for (const o of result.orphans) {
      printTree(o);
    }
  }
}

export { queryRecentSessions };
