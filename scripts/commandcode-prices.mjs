#!/usr/bin/env node
/**
 * commandcode-prices.mjs — scrape Command Code's published per-model rates into a
 * curated, offline-usable file.
 *
 * WHY: the GOAT plan publishes real rates per 1M tokens for every model it includes,
 * but they exist only inside the docs page's React payload. The agent-models panel
 * needs a plain file it can read from the workspace (a plugin may not reach the
 * network or the user's config without a grant), so this fetches once and writes
 * `config/commandcode-prices.json`, which is checked in and merged by
 * scripts/agent-model-costs.mjs. Re-run it when Command Code changes prices.
 *
 * The payload carries, per model:
 *   { slug, id, name, vendor, category, contextWindow, reasoning, vision,
 *     inputCost, outputCost, cacheReadCost, blendedCostPerMTok, minPlanName,
 *     tiers: [{label, context, rates:{input,output,cacheRead}}], caps:{...} }
 * inputCost/outputCost are already USD per 1M tokens, the unit the rest of the cost
 * pipeline uses, so nothing is converted here - only extracted.
 *
 * USAGE
 *   node scripts/commandcode-prices.mjs [--url <page>] [--out <path>] [--json]
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(join(HERE, ".."));
const DEFAULT_URL = "https://commandcode.ai/docs/plans/goat";
const DEFAULT_OUT = join(REPO, "config", "commandcode-prices.json");

function parseArgs(argv) {
	const opts = { url: DEFAULT_URL, out: DEFAULT_OUT, json: false, help: false };
	for (let i = 0; i < argv.length; i++) {
		const a = argv[i];
		if (a === "--url") opts.url = argv[++i] ?? DEFAULT_URL;
		else if (a === "--out") opts.out = resolve(argv[++i] ?? DEFAULT_OUT);
		else if (a === "--json") opts.json = true;
		else if (a === "--help" || a === "-h") opts.help = true;
		else if (a.startsWith("--")) throw new Error(`unknown flag: ${a}`);
	}
	return opts;
}

/**
 * Scan a region of text for balanced {...} objects that start with the slug marker.
 *
 * `escapedMode` handles the form the docs page actually serves: the JSON is embedded
 * inside a JS string literal, so every quote arrives as \" and the backslash is
 * embedding noise, not a JSON escape. Treating it as a JSON escape makes the scanner
 * never close a string (every quote looks escaped), which is how the first version of
 * this script found zero models.
 */
function scanObjects(text, marker, escapedMode) {
	const out = [];
	let from = 0;
	while (true) {
		const start = text.indexOf(marker, from);
		if (start === -1) break;
		let depth = 0;
		let inString = false;
		let escaped = false;
		let end = -1;
		for (let i = start; i < text.length; i++) {
			const ch = text[i];
			if (escapedMode) {
				if (ch === '"') inString = !inString;
				else if (!inString) {
					if (ch === "{") depth++;
					else if (ch === "}") {
						depth--;
						if (depth === 0) {
							end = i + 1;
							break;
						}
					}
				}
				continue;
			}
			if (inString) {
				if (escaped) escaped = false;
				else if (ch === "\\") escaped = true;
				else if (ch === '"') inString = false;
				continue;
			}
			if (ch === '"') inString = true;
			else if (ch === "{") depth++;
			else if (ch === "}") {
				depth--;
				if (depth === 0) {
					end = i + 1;
					break;
				}
			}
		}
		if (end === -1) break;
		const chunk = text.slice(start, end);
		const candidate = escapedMode ? chunk.replace(/\\"/g, '"') : chunk;
		try {
			const obj = JSON.parse(candidate);
			if (obj && typeof obj.id === "string") out.push(obj);
		} catch {
			/* truncated or unrelated object: skip it and keep scanning */
		}
		from = end;
	}
	return out;
}

/** Extract model objects from either the plain or the JS-escaped payload form. */
export function extractModelObjects(text) {
	const plain = scanObjects(text, '{"slug":"', false);
	if (plain.length) return plain;
	return scanObjects(text, '{\\"slug\\":\\"', true);
}

/** Numbers only: the payload uses the literal string "$undefined" for unknown fields. */
function num(v) {
	return typeof v === "number" && Number.isFinite(v) ? v : null;
}

async function main() {
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

	const res = await fetch(opts.url, { headers: { "user-agent": "glitch-agent-models/1.0" } }).catch((err) => {
		console.error(`fetch failed: ${err?.message ?? err}`);
		return null;
	});
	if (!res) {
		process.exitCode = 1;
		return;
	}
	if (!res.ok) {
		console.error(`fetch failed: HTTP ${res.status}`);
		process.exitCode = 1;
		return;
	}

	const html = await res.text();
	const objects = extractModelObjects(html);
	if (!objects.length) {
		console.error("no model objects found - the docs markup probably changed; the existing curated file was left alone");
		process.exitCode = 1;
		return;
	}

	const prices = {};
	const plans = {};
	for (const m of objects) {
		const inCost = num(m.inputCost);
		const outCost = num(m.outputCost);
		if (inCost === null && outCost === null) continue;
		const plan = typeof m.minPlanName === "string" ? m.minPlanName : null;
		if (plan) plans[plan] = (plans[plan] ?? 0) + 1;
		prices[`commandcode/${m.id}`] = {
			in: inCost,
			out: outCost,
			cacheRead: num(m.cacheReadCost),
			source: "commandcode-docs",
			...(typeof m.name === "string" ? { name: m.name } : {}),
			...(typeof m.blendedCostPerMTok === "number" ? { blended: m.blendedCostPerMTok } : {}),
			...(plan ? { minPlan: plan } : {}),
			...(typeof m.contextWindow === "number" ? { contextWindow: m.contextWindow } : {}),
			...(m.caps?.vision || m.vision ? { vision: true } : {}),
			...(m.caps?.reasoning || m.reasoning ? { reasoning: true } : {}),
		};
	}

	const doc = {
		generatedAt: new Date().toISOString(),
		source: opts.url,
		unit: "usd_per_million_tokens",
		models: Object.keys(prices).length,
		plans,
		prices,
	};

	if (opts.json) {
		console.log(JSON.stringify(doc, null, 1));
		return;
	}
	mkdirSync(dirname(opts.out), { recursive: true });
	writeFileSync(opts.out, `${JSON.stringify(doc, null, 1)}\n`, "utf8");
	console.log(`wrote ${opts.out}`);
	console.log(`  models ${doc.models} | plans ${JSON.stringify(plans)}`);

	// Coverage against the models pi actually has configured: a gap should be visible
	// here rather than as "n/a" in the UI.
	try {
		// Intentional external read: this is the Pi harness's own config dir, not Glitch state.
		const agentDir = resolve(process.env.PI_CODING_AGENT_DIR ?? join(process.env.USERPROFILE ?? "", ".pi", "agent"));
		const cfg = JSON.parse(readFileSync(join(agentDir, "models.json"), "utf8").replace(/^\uFEFF/, ""));
		// models is an ARRAY of {id,...} in models.json (Object.keys on it yields indices).
		const list = cfg?.providers?.commandcode?.models;
		const rows = Array.isArray(list) ? list : Object.values(list ?? {});
		const ids = rows.map((m) => (typeof m === "string" ? m : m?.id)).filter(Boolean);
		const covered = ids.filter((id) => prices[`commandcode/${id}`]);
		console.log(`  pi commandcode models: ${ids.length} | priced by this scrape: ${covered.length}`);
		const missing = ids.filter((id) => !prices[`commandcode/${id}`]);
		if (missing.length) {
			console.log(`  unpriced (falls back to an openrouter estimate): ${missing.slice(0, 12).join(", ")}${missing.length > 12 ? ` ... +${missing.length - 12}` : ""}`);
		}
	} catch (err) {
		console.log(`  (could not read the pi model config for coverage: ${err?.message ?? err})`);
	}
}

main();
