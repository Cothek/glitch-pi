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
 *   node scripts/agent-models.mjs --save-config "<name>" [--config-desc "<desc>"] [--repo <path>]
 *   node scripts/agent-models.mjs --apply-config <id> [--repo <path>]
 *   node scripts/agent-models.mjs --list-configs [--json]
 *   node scripts/agent-models.mjs --delete-config <id> [--json]
 *   node scripts/agent-models.mjs --edit-config <id> --save-config "<new name>" [--config-desc "<desc>"] [--json]
 *
 *   --json            machine-readable report instead of the table
 *   --strict          exit 1 when any agent needs attention (dead pin, unresolved
 *                     pin, or a lint warning) - usable as a pre-commit / CI gate
 *   --agent-dir       override the Pi agent directory (default: $PI_CODING_AGENT_DIR
 *                     or ~/.pi/agent)
 *   --repo            override the repository root (default: the parent of this file)
 *   --save-config     snapshot current agent pins into a named configuration (use with
 *                     --edit-config to rename an existing config instead, keeping its pins)
 *   --config-desc     description for a saved config (used with --save-config)
 *   --apply-config    batch-set every agent pin from a saved configuration
 *   --list-configs    print saved configurations
 *   --delete-config   remove a saved configuration by id
 *   --edit-config     rename an existing config (by id); requires --save-config for the new name
 */

import { existsSync, readFileSync, readdirSync, writeFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { buildReport, formatCostShort, formatReportTable, parseAgentFile, setModelInFrontmatter } from "../.pi/web-plugins/agent-models/resolver.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const PROJECT_AGENTS_DIR = ".pi/agents";
const CONFIGS_PATH = join(HERE, "..", ".pi", "agent-models", "configs.json");

function parseArgs(argv) {
	const opts = { json: false, strict: false, agentDir: null, repo: null, help: false, saveConfig: null, configDesc: null, applyConfig: null, listConfigs: false, deleteConfig: null, editConfig: null };
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		if (arg === "--json") opts.json = true;
		else if (arg === "--strict") opts.strict = true;
		else if (arg === "--agent-dir") opts.agentDir = argv[++i] ?? null;
		else if (arg === "--repo") opts.repo = argv[++i] ?? null;
		else if (arg === "--save-config") opts.saveConfig = argv[++i] ?? null;
		else if (arg === "--config-desc") opts.configDesc = argv[++i] ?? null;
		else if (arg === "--apply-config") opts.applyConfig = argv[++i] ?? null;
		else if (arg === "--list-configs") opts.listConfigs = true;
		else if (arg === "--delete-config") opts.deleteConfig = argv[++i] ?? null;
		else if (arg === "--edit-config") opts.editConfig = argv[++i] ?? null;
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

function readConfigs(repoRoot) {
	try {
		const raw = readFileSync(join(repoRoot, ".pi", "agent-models", "configs.json"), "utf8");
		const doc = JSON.parse(raw.replace(/^\uFEFF/, ""));
		return Array.isArray(doc?.configs) ? doc.configs : [];
	} catch {
		return [];
	}
}

function writeConfigs(repoRoot, configs) {
	const dir = join(repoRoot, ".pi", "agent-models");
	if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
	writeFileSync(join(dir, "configs.json"), JSON.stringify({ configs }, null, 1), "utf8");
}

function slugifyConfigId(name) {
	return String(name ?? "")
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "") || "config";
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

	// --- Config operations: save / apply / list / delete -----------------------
	if (opts.listConfigs) {
		const configs = readConfigs(repoRoot);
		if (opts.json) {
			console.log(JSON.stringify(configs.map((c) => ({ id: c.id, name: c.name, description: c.description, createdAt: c.createdAt, updatedAt: c.updatedAt, agentCount: Object.keys(c.pins || {}).length })), null, 2));
		} else {
			if (!configs.length) console.log("No saved configurations. Save one with: node scripts/agent-models.mjs --save-config \"name\"");
			else { console.log(`${"ID".padEnd(20)} NAME  AGENTS  UPDATED`); for (const c of configs) console.log(`${c.id.padEnd(20)} ${c.name}  ${Object.keys(c.pins || {}).length}  ${c.updatedAt}`); }
		}
		return;
	}

	if (opts.deleteConfig) {
		const configs = readConfigs(repoRoot);
		const remaining = configs.filter((c) => c.id !== opts.deleteConfig);
		if (remaining.length === configs.length) {
			console.error(`config not found: ${opts.deleteConfig}`);
			process.exitCode = 1;
			return;
		}
		writeConfigs(repoRoot, remaining);
		if (opts.json) console.log(JSON.stringify({ ok: true, deleted: opts.deleteConfig, count: remaining.length }, null, 2));
		else console.log(`deleted config: ${opts.deleteConfig}`);
		return;
	}

	if (opts.editConfig) {
		// Rename an existing config (keep its pins, change name/description).
		const existing = readConfigs(repoRoot);
		const prev = existing.find((c) => c.id === opts.editConfig);
		if (!prev) { console.error(`config not found: ${opts.editConfig}`); process.exitCode = 1; return; }
		const newName = opts.saveConfig || prev.name;
		if (!newName || newName.length > 80) { console.error("name is required (max 80 chars)"); process.exitCode = 2; return; }
		const config = { ...prev, name: newName, description: opts.configDesc || null, updatedAt: new Date().toISOString() };
		const updated = existing.filter((c) => c.id !== opts.editConfig);
		updated.push(config);
		updated.sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1));
		writeConfigs(repoRoot, updated);
		if (opts.json) console.log(JSON.stringify({ ok: true, config: { id: config.id, name: newName, description: config.description, createdAt: config.createdAt, updatedAt: config.updatedAt, agentCount: Object.keys(config.pins || {}).length } }, null, 2));
		else console.log(`renamed config "${prev.name}" -> "${newName}" (${config.id})`);
		return;
	}

	if (opts.saveConfig) {
		const { agents, dir } = readAgents(repoRoot);
		if (!agents.length) { console.error(`no agent files found in ${dir}`); process.exitCode = 2; return; }
		const catalog = buildCatalog(agentDir);
		const report = buildReport(agents, catalog.ids, catalog.source);
		const pins = {};
		for (const row of report.rows) pins[row.name] = row.pin;
		const id = slugifyConfigId(opts.saveConfig);
		const now = new Date().toISOString();
		const existing = readConfigs(repoRoot);
		const prev = existing.find((c) => c.id === id);
		const config = { id, name: opts.saveConfig, description: opts.configDesc || null, createdAt: prev?.createdAt ?? now, updatedAt: now, pins };
		const updated = existing.filter((c) => c.id !== id);
		updated.push(config);
		updated.sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1));
		writeConfigs(repoRoot, updated);
		if (opts.json) console.log(JSON.stringify({ ok: true, config: { id, name: opts.saveConfig, description: config.description, createdAt: config.createdAt, updatedAt: now, agentCount: Object.keys(pins).length } }, null, 2));
		else console.log(`saved config "${opts.saveConfig}" (${id}) with ${Object.keys(pins).length} agent pins`);
		return;
	}

	if (opts.applyConfig) {
		const configs = readConfigs(repoRoot);
		const config = configs.find((c) => c.id === opts.applyConfig);
		if (!config) { console.error(`config not found: ${opts.applyConfig}`); process.exitCode = 1; return; }
		const catalog = buildCatalog(agentDir);
		const agentFiles = readAgents(repoRoot).agents.map((a) => a.file);
		let applied = 0;
		let skipped = 0;
		const stamp = new Date().toISOString().replace(/[:.]/g, "-")
		const backupDir = join(repoRoot, ".pi", "agent-models", "backups");
		if (!existsSync(backupDir)) mkdirSync(backupDir, { recursive: true });
		for (const [agent, model] of Object.entries(config.pins || {})) {
			const file = join(PROJECT_AGENTS_DIR, `${agent}.md`);
			if (!agentFiles.includes(`${agent}.md`)) { skipped++; continue; }
			if (model && model !== "" && !catalog.ids.has(model)) { skipped++; continue; }
			const before = readFileSync(join(repoRoot, file), "utf8");
			const edit = setModelInFrontmatter(before, model || null);
			if (!edit.ok || !edit.changed) continue;
			writeFileSync(join(backupDir, `config-apply-${config.id}-${agent}-${stamp}.md`), before, "utf8");
			writeFileSync(join(repoRoot, file), edit.text, "utf8");
			applied++;
		}
		if (opts.json) console.log(JSON.stringify({ ok: true, id: opts.applyConfig, name: config.name, applied, skipped }, null, 2));
		else console.log(`applied config "${config.name}": ${applied} agents updated, ${skipped} skipped`);
		return;
	}

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
