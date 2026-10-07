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

function querySessionTokens(hoursBack = 6) {
  const db = openDB();
  if (!db) return { error: 'DB not found', path: DB_PATH };

  try {
    const cutoff = Date.now() - hoursBack * 3600 * 1000;
    const sessions = db.prepare(
      `SELECT id, parent_id, agent, model, cost,
              tokens_input, tokens_output, tokens_cache_read, tokens_cache_write,
              time_created, time_updated, title
       FROM session
       WHERE time_created > ?
       ORDER BY time_created DESC`
    ).all(cutoff);

    return sessions.map(s => {
      let modelId = 'unknown';
      try { modelId = JSON.parse(s.model).id || 'unknown'; } catch {}

      return {
        sessionId: s.id,
        parentId: s.parent_id,
        agent: s.agent || 'unknown',
        model: modelId,
        cost: s.cost || 0,
        tokensInput: s.tokens_input || 0,
        tokensOutput: s.tokens_output || 0,
        tokensCacheRead: s.tokens_cache_read || 0,
        tokensCacheWrite: s.tokens_cache_write || 0,
        timeCreated: s.time_created,
        timeUpdated: s.time_updated,
        title: (s.title || '').slice(0, 120)
      };
    });
  } catch (err) {
    return { error: err.message };
  } finally {
    try { db.close(); } catch {}
  }
}

function queryAggregateTokens(hoursBack = 24) {
  const db = openDB();
  if (!db) return null;

  try {
    const cutoff = Date.now() - hoursBack * 3600 * 1000;
    const rows = db.prepare(
      `SELECT agent,
              COUNT(*) as sessionCount,
              SUM(tokens_input) as totalInput,
              SUM(tokens_output) as totalOutput,
              SUM(tokens_cache_read) as totalCacheRead,
              SUM(tokens_cache_write) as totalCacheWrite,
              SUM(cost) as totalCost
       FROM session
       WHERE time_created > ?
       GROUP BY agent
       ORDER BY totalCost DESC`
    ).all(cutoff);

    return rows.map(r => ({
      agent: r.agent || 'unknown',
      sessionCount: r.sessionCount,
      totalInput: r.totalInput || 0,
      totalOutput: r.totalOutput || 0,
      totalCacheRead: r.totalCacheRead || 0,
      totalCacheWrite: r.totalCacheWrite || 0,
      totalCost: r.totalCost || 0
    }));
  } catch { return null; }
  finally { try { db.close(); } catch {} }
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, '/'))) {
  const hours = parseInt(process.argv[2], 10) || 6;
  console.log(`=== OpenCode Token Usage (last ${hours}h) ===\n`);
  const sessions = querySessionTokens(hours);
  if (sessions.error) {
    console.error('Error:', sessions.error);
    process.exit(1);
  }
  for (const s of sessions) {
    console.log(`  ${s.sessionId} | ${s.agent} | ${s.model}`);
    console.log(`    cost: $${s.cost.toFixed(4)} | in: ${s.tokensInput} out: ${s.tokensOutput} cache-r: ${s.tokensCacheRead} cache-w: ${s.tokensCacheWrite}`);
    console.log(`    title: ${s.title}`);
    console.log();
  }
  console.log(`--- Aggregate (24h) ---`);
  const agg = queryAggregateTokens(24);
  if (agg) {
    for (const a of agg) {
      console.log(`  ${a.agent}: ${a.sessionCount} sessions, $${a.totalCost.toFixed(4)}, ${a.totalInput + a.totalOutput} tokens`);
    }
  }
}

export { querySessionTokens, queryAggregateTokens };
