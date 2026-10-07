import sqlite3 from 'node:sqlite';
import { join } from 'node:path';
import { homedir } from 'node:os';

const DB_PATH = join(homedir(), '.local', 'share', 'opencode', 'opencode.db');
const db = new sqlite3.DatabaseSync(DB_PATH);

console.log('=== OpenCode DB Usage Probe ===');
console.log(`DB: ${DB_PATH}\n`);

console.log('--- Session table columns (usage-related) ---');
const cols = db.prepare('PRAGMA table_info(session)').all();
const usageCols = cols.filter(c => /cost|token|usage|model|agent/.test(c.name));
console.log(usageCols.map(c => `  ${c.name} (${c.type})`).join('\n'));

console.log('\n--- Sample sessions with usage data (last 5 child sessions) ---');
const sessions = db.prepare(
  `SELECT id, agent, model, cost, tokens_input, tokens_output, tokens_reasoning,
          tokens_cache_read, tokens_cache_write, time_created, time_updated, parent_id
   FROM session
   WHERE parent_id IS NOT NULL
   ORDER BY time_created DESC LIMIT 5`
).all();

for (const s of sessions) {
  let modelId = '?';
  try { modelId = JSON.parse(s.model).id; } catch {}
  console.log(`  ${s.id}`);
  console.log(`    agent: ${s.agent}, model: ${modelId}`);
  console.log(`    cost: $${s.cost}`);
  console.log(`    tokens: input=${s.tokens_input} output=${s.tokens_output} reasoning=${s.tokens_reasoning}`);
  console.log(`    cache: read=${s.tokens_cache_read} write=${s.tokens_cache_write}`);
  console.log(`    duration: ${((s.time_updated - s.time_created) / 1000).toFixed(1)}s`);
  console.log();
}

console.log('--- Aggregate: total cost/token counts ---');
const agg = db.prepare(
  `SELECT COUNT(*) as total_sessions,
          SUM(cost) as total_cost,
          SUM(tokens_input) as total_input,
          SUM(tokens_output) as total_output,
          SUM(tokens_cache_read) as total_cache_read,
          SUM(tokens_cache_write) as total_cache_write
   FROM session WHERE cost > 0`
).all();
console.log(JSON.stringify(agg[0], null, 2));

console.log('\n--- Part table: checking for usage/token JSON ---');
const partSample = db.prepare(
  `SELECT data FROM part WHERE data LIKE '%"inputTokens"%' OR data LIKE '%"outputTokens"%' LIMIT 2`
).all();
if (partSample.length > 0) {
  for (const p of partSample) {
    const d = JSON.parse(p.data);
    console.log('  Part keys:', Object.keys(d).join(', '));
    if (d.inputTokens != null) console.log('  inputTokens:', d.inputTokens, 'outputTokens:', d.outputTokens);
    if (d.usage) console.log('  usage:', JSON.stringify(d.usage));
  }
} else {
  console.log('  No parts with inputTokens/outputTokens found');
  const partSample2 = db.prepare(
    `SELECT data FROM part WHERE data LIKE '%token%' LIMIT 2`
  ).all();
  if (partSample2.length > 0) {
    for (const p of partSample2) {
      const d = JSON.parse(p.data);
      console.log('  Part keys (token match):', Object.keys(d).join(', '));
    }
  } else {
    console.log('  No parts with "token" in data found');
  }
}

console.log('\n--- Verdict ---');
console.log('Session table has: cost, tokens_input, tokens_output, tokens_cache_read, tokens_cache_write');
console.log('Per-session cost is DIRECTLY extractable (opencode computes it).');
console.log('VERDICT: METERED — use session.cost + session.tokens_* directly.');

db.close();
