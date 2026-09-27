/**
 * free-pool.test.mjs — unit tests for scripts/free-pool.mjs
 * Run: node --test scripts/free-pool.test.mjs
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

// Fresh pool dir + state file per test group; env is read per call.
let tmp;
let seq = 0;

function freshEnv() {
	seq += 1;
	tmp = mkdtempSync(join(tmpdir(), `free-pool-test-${seq}-`));
	process.env.FREE_POOL_DIR = tmp;
	process.env.NVIDIA_STATE_FILE = join(tmp, "nvidia-state.json");
	return tmp;
}

function seedState(models) {
	writeFileSync(
		process.env.NVIDIA_STATE_FILE,
		JSON.stringify({ models }),
		"utf-8",
	);
}

const mod = await import("./free-pool.mjs");

test("add assigns sequential ids and stores rows", () => {
	freshEnv();
	mod.writeQueue([]);
	const a = mod.cmdAdd(mod.readQueue(), "proj-a", "do the thing", "nvidia/x");
	assert.equal(a.id, "Q1");
	const b = mod.cmdAdd(a.rows, "proj-b", "do another", "");
	assert.equal(b.id, "Q2");
	assert.equal(b.rows[1][1], "proj-b");
	assert.equal(b.rows[1][4], "queued");
});

test("add parses model only when it looks like a model id", () => {
	const rows = [];
	const r = mod.cmdAdd(rows, "proj", "read the file nvidia/readme.md", "nvidia/x");
	// trailing arg that is a model id gets stripped from the instruction
	assert.equal(r.rows[0][2], "read the file nvidia/readme.md");
	assert.equal(r.rows[0][3], "nvidia/x");
});

test("claim and done update state, unknown id throws", () => {
	freshEnv();
	const seeded = mod.cmdAdd([], "proj", "task", "");
	assert.deepEqual(mod.setQueueState(seeded.rows, "Q1", "running")[0][4], "running");
	assert.throws(() => mod.setQueueState(seeded.rows, "Q9", "done"), /unknown queue id/);
});

test("cooldown upserts and expires", () => {
	freshEnv();
	let cds = mod.cmdCooldown([], "nvidia/a", 10, "429");
	assert.equal(cds.length, 1);
	const until = Date.parse(cds[0][1]);
	assert.ok(until > Date.now());
	// upsert replaces, not appends
	cds = mod.cmdCooldown(cds, "nvidia/a", 5, "degraded");
	assert.equal(cds.length, 1);
	// expired cooldown is not active
	const expired = [["nvidia/b", new Date(Date.now() - 1000).toISOString(), "old"]];
	const registry = { cooldowns: expired };
	assert.equal(mod.activeCooldowns(registry).length, 0);
});

test("pool lists enabled models and flags disabled-in-use", () => {
	freshEnv();
	seedState([
		{ id: "openai/gpt-oss-20b", enabled: true, tier: "A", contextWindow: 131072, reasoning: true },
		{ id: "z-ai/foo", enabled: false, tier: "A", contextWindow: 128000, reasoning: true },
	]);
	// registry stores pi-qualified ids; the state file uses bare NIM ids
	mod.writeRegistry(
		[["proj-x", "c1", "/tmp", "nvidia/openai/gpt-oss-20b", "scope", "active", "now"]],
		[],
	);
	let out = mod.renderPool();
	assert.match(out, /enabled models: 1/);
	assert.match(out, /nvidia\/openai\/gpt-oss-20b/);
	assert.match(out, /no registry project uses a disabled model/);
	// disable the in-use model -> flagged
	seedState([
		{ id: "openai/gpt-oss-20b", enabled: false, tier: "A", contextWindow: 131072, reasoning: true },
		{ id: "z-ai/foo", enabled: false, tier: "A", contextWindow: 128000, reasoning: true },
	]);
	out = mod.renderPool();
	assert.match(out, /FLAGGED/);
	assert.match(out, /proj-x uses nvidia\/openai\/gpt-oss-20b/);
});

test("cooldown display works with pi-qualified registry ids", () => {
	freshEnv();
	seedState([{ id: "openai/gpt-oss-20b", enabled: true, tier: "A", contextWindow: 131072, reasoning: true }]);
	mod.writeRegistry([], mod.cmdCooldown([], "nvidia/openai/gpt-oss-20b", 10, "429"));
	const out = mod.renderStatus();
	assert.match(out, /ctx 131072 {2}\[COOLDOWN\]/);
});

test("status renders pool, projects, queue sections", () => {
	freshEnv();
	seedState([{ id: "nvidia/a", enabled: true, tier: "A", contextWindow: 262144, reasoning: true }]);
	mod.writeRegistry([["proj-x", "c1", "/tmp", "nvidia/a", "scope", "active", "now"]], []);
	mod.writeQueue(mod.cmdAdd([], "proj-x", "stand by", "").rows);
	const out = mod.renderStatus();
	assert.match(out, /== Pool ==/);
	assert.match(out, /enabled: 1 model\(s\)/);
	assert.match(out, /== Projects ==/);
	assert.match(out, /proj-x/);
	assert.match(out, /== Queue ==/);
	assert.match(out, /Q1/);
});

test("parser tolerates hand edits: missing cells, extra spaces", () => {
	const body = "| id   | project | instruction | model | state |\n" +
		"| --- | --- | --- | --- | --- |\n" +
		"| Q1 |  proj  | short note  |\n";
	const t = mod.parseTable(body);
	assert.equal(t.rows.length, 1);
	assert.equal(t.rows[0][0], "Q1");
	assert.equal(t.rows[0][1], "proj");
	assert.equal(t.rows[0].length, 3); // padded later, not here
	const rendered = mod.renderTable(["id", "project", "instruction", "model", "state"], t.rows);
	assert.match(rendered, /\| Q1 \| proj \| short note \|  \|  \|/);
});

test("write/read roundtrip preserves rows", () => {
	freshEnv();
	const rows = mod.cmdAdd([], "proj", "instruction with | pipe char", "nvidia/a").rows;
	mod.writeQueue(rows);
	const back = mod.readQueue();
	assert.equal(back.length, 1);
	assert.equal(back[0][1], "proj");
});

test("sections splits on ## headers", () => {
	const md = "# Title\n\n## Projects\n\nrow-a\n\n## Cooldowns\n\nrow-b\n";
	const s = mod.sections(md);
	assert.ok(s["Projects"].includes("row-a"));
	assert.ok(s["Cooldowns"].includes("row-b"));
});

test("cli main dispatches add and done", () => {
	freshEnv();
	const msg = mod.main(["add", "proj-cli", "hello task"]);
	assert.match(msg, /queued Q1 for proj-cli/);
	const doneMsg = mod.main(["done", "Q1"]);
	assert.equal(doneMsg, "Q1 -> done");
	assert.equal(mod.readQueue()[0][4], "done");
});

test("register upserts project rows and renders in status", () => {
	freshEnv();
	seedState([{ id: "nvidia/a", enabled: true, tier: "A", contextWindow: 128000, reasoning: true }]);
	let msg = mod.main(["register", "proj", "c1", "/tmp", "nvidia/a", "active", "test project"]);
	assert.equal(msg, "registered proj");
	let rows = mod.readRegistry().projects;
	assert.equal(rows.length, 1);
	assert.equal(rows[0][0], "proj");
	// upsert: same project updates, does not append
	mod.main(["register", "proj", "c1", "/tmp", "nvidia/a", "done", "test project"]);
	rows = mod.readRegistry().projects;
	assert.equal(rows.length, 1);
	assert.equal(rows[0][5], "done");
	// a second project appends
	mod.main(["register", "proj2", "c2", "/tmp", "nvidia/a", "active", "second"]);
	rows = mod.readRegistry().projects;
	assert.equal(rows.length, 2);
	assert.match(mod.renderStatus(), /proj \| nvidia\/a \| done/);
});
