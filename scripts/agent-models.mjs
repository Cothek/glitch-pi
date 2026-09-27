#!/usr/bin/env node
/**
 * agent-models.mjs — print every .pi/agents/*.md model pin and whether it
 * actually resolves at dispatch time.
 *
 * WHY: `.pi/extensions/dispatcher.ts` drops any pin matching ^opencode(-go)?/
 * and falls back to the parent model when a pinned model is not available. Both
 * cases are silent, so a roster can rot without anyone noticing. This prints the
 * truth table, using the SAME classifier as the `agent-models` pi-web-ui plugin
 * (`.pi/web-plugins/agent-models/resolver.mjs`), so the CLI and the panel can
 * never disagree about what a status means.
 *
 * CATALOG, AND WHY IT IS AN APPROXIMATION HERE:
 *   - the plugin asks the live runtime (`host.models.list()`) = "authenticated
 *     and usable right now"
 *   - this CLI has no runtime, so it unions the on-disk sources:
 *       <agent-dir>/models.json        configured providers + their models
 *       <agent-dir>/models-store.json  official catalog cache, only for
 *                                      providers with saved credentials
 *   A model present here but missing from the live runtime (revoked key, pulled
 *   model) would be reported OK by the CLI and UNRESOLVED by the panel. The
 *   header names the source so nobody has to guess which one they are reading.
 *
 * USAGE
 *   node scripts/agent-models.mjs [--json] [--strict] [--agent-dir <path>] [--repo <path>]
 *
 *   --json        machine-readable report instead of the table
 *   --strict      exit 1 when any agent needs attention (dead pin, unresolved
 *                 pin, or a lint warning) - usable as a pre-commit / CI gate
 *   --agent-dir   override the Pi agent directory (default: $PI_CODING_AGENT_DIR
 *                 or ~/.pi/agent)
 *   --repo        override the repository root (default: the parent of this file)
 */

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { buildReport, formatCostShort, formatReportTable, parseAgentFile } from "../.pi/web-plugins/agent-models/resolver.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const PROJECT_AGENTS_DIR = ".pi/agents";

function parseArgs(argv) {
	const opts = { json: false, strict: false, agentDir: null, repo: null, help: false };
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		if (arg === "--json") opts.json = true;
		else if (arg === "--strict") opts.strict = true;
		else if (arg === "--agent-dir") opts.agentDir = argv[++i] ?? null;
		else if (arg === "--repo") opts.repo = argv[++i] ?? null;
		else if (arg === "--help" || arg === "-h") opts.help = true;
		else if (arg.startsWith("--")) throw new Error(`unknown flag: ${arg}`);
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

/**
 * Catalog ids from one of the two on-disk shapes:
 *   { providers: { <provider>: { models: [ {id} | "id" ] } } }   (models.json)
 *   { <provider>: { models: [ {id} | "id" ] } }                   (models-store.json)
 */
function catalogIdsFrom(document, allowedProviders) {
	const ids = new Set();
	if (!document) return ids;
	const providers = document.providers && typeof document.providers === "object" ? document.providers : document;
	for (const [provider, entry] of Object.entries(providers)) {
		if (!entry || typeof entry !== "object") continue;
		if (allowedProviders && !allowedProviders.has(provider)) continue;
		const models = Array.isArray(entry.models) ? entry.models : [];
		for (const model of models) {
			const id = typeof model === "string" ? model : model?.id;
			if (typeof id === "string" && id) ids.add(`${provider}/${id}`);
		}
	}
	return ids;
}

function buildCatalog(agentDir) {
	const auth = readJson(join(agentDir, "auth.json"));
	const authedProviders = new Set(auth && typeof auth === "object" ? Object.keys(auth) : []);

	const configured = catalogIdsFrom(readJson(join(agentDir, "models.json")), null);
	const official = catalogIdsFrom(readJson(join(agentDir, "models-store.json")), authedProviders);

	const ids = new Set([...configured, ...official]);
	const parts = [`models.json ${configured.size}`];
	if (official.size) parts.push(`models-store ${official.size} (credentialed providers only)`);
	const source = `disk approximation: ${parts.join(" + ")} = ${ids.size}. Live runtime may differ.`;
	return { ids, source, configured: configured.size, official: official.size };
}

const EXCLUDED_AGENTS = new Set(["glitch-omni", "memory-paid"]);

function readAgents(repoRoot) {
	const dir = join(repoRoot, PROJECT_AGENTS_DIR);
	if (!existsSync(dir)) return { agents: [], dir };
	const agents = [];
	for (const name of readdirSync(dir).sort()) {
		if (!name.endsWith(".md")) continue;
		const base = name.replace(/\.md$/, "");
		if (EXCLUDED_AGENTS.has(base)) continue;
		try {
			agents.push(parseAgentFile(readFileSync(join(dir, name), "utf8"), name));
		} catch {
			/* unreadable file: skipped, matching the plugin's behaviour */
		}
	}
	return { agents, dir };
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
		const source = readFileSync(fileURLToPath(import.meta.url), "utf8");
		const header = source.slice(source.indexOf("/**") + 3, source.indexOf("*/")).trim();
		console.log(header.replace(/^\s*\*\s?/gm, "").trim());
		return;
	}

	const repoRoot = resolve(opts.repo ?? join(HERE, ".."));
	const agentDir = resolve(opts.agentDir ?? process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent"));

	const { agents, dir } = readAgents(repoRoot);
	if (!agents.length) {
		console.error(`no agent files found in ${dir}`);
		process.exitCode = 2;
		return;
	}

	const catalog = buildCatalog(agentDir);
	const report = buildReport(agents, catalog.ids, catalog.source);
	report.agentsDir = PROJECT_AGENTS_DIR;
	report.repoRoot = repoRoot;
	report.agentDir = agentDir;

	// Cost table generated by scripts/agent-model-costs.mjs. Same source as the
	// panel: a file inside the workspace, so both surfaces show identical labels.
	const costsPath = join(repoRoot, ".pi", "agent-models", "costs.json");
	const costDoc = readJson(costsPath);
	const costTable = costDoc && typeof costDoc.costs === "object" && costDoc.costs ? costDoc.costs : null;
	for (const row of report.rows) {
		const cost = row.pin && costTable ? costTable[row.pin] : null;
		row.costShort = cost ? formatCostShort(cost) : row.pin ? "n/a" : null;
		row.tier = cost?.tier ?? null;
	}
	report.costMeta = costTable
		? { path: costsPath, generatedAt: costDoc.generatedAt ?? null, summary: costDoc.summary ?? null }
		: { path: costsPath, missing: true, hint: "run: node scripts/agent-model-costs.mjs" };

	if (opts.json) {
		console.log(JSON.stringify(report, null, 2));
	} else {
		console.log(formatReportTable(report));
	}

	if (opts.strict && report.counts.problems > 0) {
		if (!opts.json) console.error(`\nstrict: ${report.counts.problems} agent(s) need attention`);
		process.exitCode = 1;
	}
}

main();
