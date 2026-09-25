#!/usr/bin/env node
/**
 * agent-model-costs.mjs — build the model table the agent-models picker shows:
 * prices, tiers, context windows and capabilities.
 *
 * WHY A FILE AT ALL: a pi-web-ui plugin can only read inside the workspace without a
 * directory grant, and the host's plugin API carries id/provider/vision only. So the
 * data is collected here (this script can read the user's config) and dropped into
 * `.pi/agent-models/costs.json` inside the workspace, where the plugin and the CLI
 * both read it. Both then format labels the same way, because the labels are computed
 * here and shipped in the payload.
 *
 * SOURCES, lowest precedence first (a later source overwrites an earlier one):
 *   1. <agent-dir>/models-store.json          official catalog cache (openrouter + nvidia)
 *   2. <agent-dir>/models.json                configured providers (nvidia, commandcode)
 *   3. config/commandcode-prices.json         Command Code's published GOAT plan rates,
 *                                             scraped by scripts/commandcode-prices.mjs
 *   4. .pi/agent-models/prices.json           manual overrides; wins over everything
 * Then, for any model still unpriced: an ESTIMATE from an openrouter entry with the
 * same normalized slug. Estimates are marked (`estimated: true`, `estimatedFrom`) and
 * rendered with a "~" so an inferred number is never mistaken for a published one.
 *
 * TIERS are derived, not published: blended = 0.75*in + 0.25*out (input-weighted, the
 * same shape Command Code uses for its own blendedCostPerMTok), then
 *   0 -> free, <1 -> budget, <5 -> mid, >=5 -> premium.
 * Thresholds live here so changing them is a one-line edit; the tier is data in the
 * output file, so the UI never recomputes it.
 *
 * USAGE
 *   node scripts/agent-model-costs.mjs [--agent-dir <path>] [--out <path>] [--json]
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(join(HERE, ".."));
const DEFAULT_OUT = join(REPO, ".pi", "agent-models", "costs.json");
const MANUAL_PATH = join(REPO, ".pi", "agent-models", "prices.json");
const COMMANDCODE_PATH = join(REPO, "config", "commandcode-prices.json");
/** A 200K window is the boundary Command Code's own catalog calls large context. */
const LARGE_CONTEXT = 200_000;

function parseArgs(argv) {
	const opts = { agentDir: null, out: DEFAULT_OUT, json: false, help: false };
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
		return JSON.parse(readFileSync(path, "utf8").replace(/^\uFEFF/, ""));
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
		const models = Array.isArray(entry.models) ? entry.models : Object.values(entry.models ?? {});
		for (const m of models) {
			if (typeof m === "string") {
				fn(`${provider}/${m}`, {}, provider);
				continue;
			}
			if (!m || typeof m !== "object" || typeof m.id !== "string") continue;
			fn(`${provider}/${m.id}`, m, provider);
		}
	}
}

/** Include an id in the catalog even when it carries no pricing at all. */
function eachId(doc, fn) {
	eachModel(doc, (id, m) => fn(id, m));
}

function num(v) {
	return typeof v === "number" && Number.isFinite(v) ? v : null;
}

/** Normalize a cost object from any source into the pipeline shape. */
function normalizeCost(raw, source) {
	if (!raw || typeof raw !== "object") return null;
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

/**
 * Slug for cross-vendor matching: lowercase, drop a free/batch marker, drop all
 * punctuation. "Qwen/Qwen3.6-Plus" and "qwen/qwen3.6-plus" both become
 * "qwen/qwen36plus", which is what makes the openrouter estimate fallback possible.
 */
function slugOf(id) {
	return String(id)
		.toLowerCase()
		.replace(/:(free|batch)$/, "")
		.replace(/-free$/, "")
		.replace(/[^a-z0-9/]+/g, "");
}

/** Input-weighted blended cost, the shape Command Code uses for its own display. */
function blendedOf(cost) {
	if (!cost || cost.in === null || cost.out === null) return null;
	return 0.75 * cost.in + 0.25 * cost.out;
}

function tierOf(cost) {
	if (!cost) return "unknown";
	const blended = blendedOf(cost);
	if (blended === null) return "unknown";
	if (blended === 0) return "free";
	if (blended < 1) return "budget";
	if (blended < 5) return "mid";
	return "premium";
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
	const storeDoc = readJson(join(agentDir, "models-store.json"));
	const configDoc = readJson(join(agentDir, "models.json"));
	const commandcodeDoc = readJson(COMMANDCODE_PATH);
	const manualDoc = readJson(MANUAL_PATH);

	const costs = {};
	const catalog = new Set();
	const sourceCounts = {};

	const apply = (id, cost) => {
		if (!cost) return;
		costs[id] = { ...costs[id], ...cost };
		sourceCounts[cost.source] = (sourceCounts[cost.source] ?? 0) + 1;
	};
	const note = (id, patch) => {
		costs[id] = { ...(costs[id] ?? {}), ...patch };
	};

	// 1. catalog cache, 2. configured providers: ids always, costs when present.
	for (const [file, tag] of [
		[storeDoc, "models-store.json"],
		[configDoc, "models.json"],
	]) {
		eachModel(file, (id, m, provider) => {
			catalog.add(id);
			if (provider) note(id, { provider });
			const extra = {};
			const ctx = num(m.contextWindow ?? m.context_length);
			if (ctx !== null) extra.contextWindow = ctx;
			if (typeof m.name === "string") extra.name = m.name;
			// models-store entries declare modalities as an input list.
			if (Array.isArray(m.input) && m.input.includes("image")) extra.vision = true;
			if (m.vision === true) extra.vision = true;
			if (m.reasoning === true) extra.reasoning = true;
			if (Object.keys(extra).length) note(id, extra);
			const cost = normalizeCost(m.cost ?? m.pricing, tag);
			if (cost) apply(id, cost);
		});
	}

	// 3. Command Code's published plan rates (highest-precedence automatic source).
	if (commandcodeDoc && typeof commandcodeDoc.prices === "object") {
		for (const [id, raw] of Object.entries(commandcodeDoc.prices)) {
			catalog.add(id);
			const cost = normalizeCost(raw, raw.source ?? "commandcode-docs");
			const extra = { provider: id.split("/")[0] };
			for (const key of ["name", "contextWindow", "vision", "reasoning", "minPlan", "blended"]) {
				if (raw[key] !== undefined) extra[key] = raw[key];
			}
			note(id, extra);
			apply(id, cost);
		}
	}

	// 4. manual overrides.
	if (manualDoc && typeof manualDoc === "object") {
		for (const [id, raw] of Object.entries(manualDoc)) {
			if (id.startsWith("_")) continue;
			catalog.add(id);
			apply(id, normalizeCost(raw, "manual"));
		}
	}

	// Estimate pass: same-slug openrouter price for anything still unpriced. Only a
	// NON-ZERO price is usable - a zero means "that route is free", which is a
	// different claim from "this model costs nothing".
	const openrouterBySlug = new Map();
	for (const [id, cost] of Object.entries(costs)) {
		if (!id.startsWith("openrouter/")) continue;
		const inC = num(cost.in);
		const outC = num(cost.out);
		if (!inC && !outC) continue;
		const slug = slugOf(id.slice("openrouter/".length));
		if (!openrouterBySlug.has(slug)) openrouterBySlug.set(slug, { id, in: inC, out: outC, cacheRead: num(cost.cacheRead) });
	}
	let estimated = 0;
	for (const id of catalog) {
		const existing = costs[id];
		if (existing && existing.in !== undefined && existing.out !== undefined) continue;
		const match = openrouterBySlug.get(slugOf(id.slice(id.indexOf("/") + 1)));
		if (!match) continue;
		estimated++;
		apply(id, {
			in: match.in,
			out: match.out,
			cacheRead: match.cacheRead,
			source: `estimated:openrouter-match:${match.id}`,
			estimated: true,
			estimatedFrom: match.id,
		});
	}

	// Derive tiers from whatever price each model ended up with.
	for (const [id, cost] of Object.entries(costs)) {
		if (cost.in === undefined && cost.out === undefined) continue;
		cost.blended = blendedOf(cost) ?? cost.blended ?? null;
		cost.tier = tierOf(cost);
	}

	const priced = Object.values(costs).filter((c) => c.in !== undefined && !c.estimated && !(c.in === 0 && c.out === 0)).length;
	const free = Object.values(costs).filter((c) => c.in === 0 && c.out === 0).length;
	const tiers = {};
	for (const c of Object.values(costs)) tiers[c.tier ?? "unknown"] = (tiers[c.tier ?? "unknown"] ?? 0) + 1;
	const withContext = Object.values(costs).filter((c) => typeof c.contextWindow === "number").length;
	const withVision = Object.values(costs).filter((c) => c.vision === true).length;

	const out = {
		generatedAt: new Date().toISOString(),
		unit: "usd_per_million_tokens",
		agentDir,
		sources: [
			`models-store.json: ${storeDoc ? "read" : "missing"}`,
			`models.json: ${configDoc ? "read" : "missing"}`,
			`config/commandcode-prices.json: ${commandcodeDoc ? `${commandcodeDoc.models ?? "?"} models (${commandcodeDoc.generatedAt ?? "?"})` : "missing - run scripts/commandcode-prices.mjs"}`,
			`prices.json (manual): ${manualDoc ? `${Object.keys(manualDoc).filter((k) => !k.startsWith("_")).length} entries` : "none"}`,
		],
		summary: {
			total: Object.keys(costs).length,
			catalog: catalog.size,
			priced,
			free,
			estimated,
			manual: sourceCounts.manual ?? 0,
			withContext,
			withVision,
			tiers,
			bySource: sourceCounts,
		},
		costs,
	};

	if (opts.json) {
		console.log(JSON.stringify(out, null, 1));
		return;
	}
	mkdirSync(dirname(opts.out), { recursive: true });
	writeFileSync(opts.out, `${JSON.stringify(out, null, 1)}\n`, "utf8");
	console.log(`wrote ${opts.out}`);
	const s = out.summary;
	console.log(`  total ${s.total} | priced ${s.priced} | free ${s.free} | estimated ${s.estimated} | manual ${s.manual}`);
	console.log(`  tiers ${JSON.stringify(s.tiers)} | context known ${s.withContext} | vision ${s.withVision}`);
	for (const line of out.sources) console.log(`  source ${line}`);
	if (s.estimated) {
		console.log("  note: estimated entries are openrouter-same-slug list prices, shown with a ~ prefix");
	}
	if (!existsSync(MANUAL_PATH)) {
		console.log("  hint: .pi/agent-models/prices.json overrides any of this by hand");
	}
}

main();
