#!/usr/bin/env node
/**
 * agent-model-costs.mjs — build the price table the agent-models picker shows.
 *
 * WHY THIS EXISTS: a pi-web-ui plugin can only read inside the workspace without
 * asking for a directory grant, and the live model API the host exposes to plugins
 * (`host.models.list()`) carries id/provider/vision only - no pricing. The prices
 * live in <agent-dir>/models.json and <agent-dir>/models-store.json, outside the
 * workspace. So this script reads them here (no plugin involved) and drops a plain
 * JSON table inside the workspace for the plugin to read.
 *
 * COVERAGE IS WHAT IT IS. On this machine:
 *   openrouter : 392 models, real prices (USD per million tokens)
 *   nvidia     : 56 models, every field 0 = genuinely free endpoints
 *   commandcode: 59 models, NO pricing data in any config file
 * Unknown prices are reported as unknown rather than guessed. If a provider
 * publishes nothing, add the numbers you know by hand to
 * `.pi/agent-models/prices.json` and they win over everything else, e.g.
 *   { "commandcode/Qwen/Qwen3.6-Plus": { "in": 0.4, "out": 2.0 } }
 *
 * USAGE
 *   node scripts/agent-model-costs.mjs [--agent-dir <path>] [--out <path>] [--json]
 *
 *   --agent-dir  Pi agent directory (default: $PI_CODING_AGENT_DIR or ~/.pi/agent)
 *   --out        output path (default: <repo>/.pi/agent-models/costs.json)
 *   --json       print the table to stdout instead of writing the file + summary
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(join(HERE, ".."));
const DEFAULT_OUT = join(REPO, ".pi", "agent-models", "costs.json");
const MANUAL_PATH = join(REPO, ".pi", "agent-models", "prices.json");

function parseArgs(argv) {
	const opts = { agentDir: null, out: DEFAULT_OUT, json: false };
	for (let i = 0; i < argv.length; i++) {
		const a = argv[i];
		if (a === "--agent-dir") opts.agentDir = argv[++i] ?? null;
		else if (a === "--out") opts.out = resolve(argv[++i] ?? DEFAULT_OUT);
		else if (a === "--json") opts.json = true;
		else if (a === "--help" || a === "-h") opts.help = true;
		else if (a.startsWith("--")) throw new Error(`unknown flag: ${a}`);
	}
	return opts;
}

function readJson(path) {
	try {
		return JSON.parse(readFileSync(path, "utf8"));
	} catch {
		return null;
	}
}

/** Flatten { providers: { p: { models: [...] } } } or { p: { models: [...] } }. */
function eachModel(doc, fn) {
	if (!doc) return;
	const providers = doc.providers && typeof doc.providers === "object" ? doc.providers : doc;
	for (const [provider, entry] of Object.entries(providers)) {
		if (!entry || typeof entry !== "object") continue;
		const models = Array.isArray(entry.models) ? entry.models : [];
		for (const m of models) {
			if (typeof m !== "object" || !m) continue;
			const id = typeof m.id === "string" ? m.id : null;
			if (id) fn(`${provider}/${id}`, m, provider);
		}
	}
}

/** Normalize a raw cost object into the shape the picker prints. */
function normalizeCost(raw, source) {
	if (!raw || typeof raw !== "object") return null;
	const num = (v) => (typeof v === "number" && Number.isFinite(v) ? v : null);
	const cost = {
		in: num(raw.input ?? raw.in),
		out: num(raw.output ?? raw.out),
		cacheRead: num(raw.cacheRead ?? raw.cache_read),
		cacheWrite: num(raw.cacheWrite ?? raw.cache_write),
		source,
	};
	if (cost.in === null && cost.out === null) return null;
	return cost;
}

function main() {
	let opts;
	try {
		opts = parseArgs(process.argv.slice(2));
	} catch (err) {
		console.error(String(err.message ?? err));
		process.exitCode = 2;
		return;
	}
	if (opts.help) {
		const src = readFileSync(fileURLToPath(import.meta.url), "utf8");
		console.log(src.slice(src.indexOf("/**") + 3, src.indexOf("*/")).replace(/^\s*\* ?/gm, "").trim());
		return;
	}

	const agentDir = resolve(opts.agentDir ?? process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent"));
	const costs = {};
	const sources = [];
	let fromConfig = 0;
	let fromStore = 0;
	let fromManual = 0;

	// Precedence, lowest first: catalog cache, then the live config, then manual.
	for (const [file, tag] of [
		["models-store.json", "models-store.json"],
		["models.json", "models.json"],
	]) {
		const path = join(agentDir, file);
		const doc = readJson(path);
		if (!doc) {
			sources.push(`${file}: missing`);
			continue;
		}
		let n = 0;
		eachModel(doc, (id, model, provider) => {
			const cost = normalizeCost(model.cost, tag);
			if (!cost) return;
			costs[id] = cost;
			n++;
			if (tag === "models.json") fromConfig++;
			else fromStore++;
		});
		sources.push(`${file}: ${n} priced`);
	}

	const manual = readJson(MANUAL_PATH);
	if (manual && typeof manual === "object") {
		for (const [id, raw] of Object.entries(manual)) {
			const cost = normalizeCost(raw, "manual");
			if (!cost) continue;
			costs[id] = cost;
			fromManual++;
		}
		sources.push(`prices.json (manual): ${fromManual} entries`);
	} else {
		sources.push("prices.json (manual): none");
	}

	const free = Object.values(costs).filter((c) => c.in === 0 && c.out === 0).length;
	const priced = Object.keys(costs).length - free;
	const out = {
		generatedAt: new Date().toISOString(),
		unit: "usd_per_million_tokens",
		agentDir,
		sources,
		summary: { total: Object.keys(costs).length, priced, free, manual: fromManual },
		costs,
	};

	if (opts.json) {
		console.log(JSON.stringify(out, null, 2));
	} else {
		mkdirSync(dirname(opts.out), { recursive: true });
		writeFileSync(opts.out, `${JSON.stringify(out, null, 1)}\n`, "utf8");
		console.log(`wrote ${opts.out}`);
		console.log(`  total ${out.summary.total} | paid ${priced} | free ${free} | manual ${fromManual}`);
		for (const s of out.sources) console.log(`  source ${s}`);
		if (fromManual === 0 && priced + free < 100) {
			console.log("  hint: add prices for unpriced providers to .pi/agent-models/prices.json");
		}
	}
}

main();
