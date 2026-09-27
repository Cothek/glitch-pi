#!/usr/bin/env node
/**
 * free-pool.mjs — Glitch Free state helper.
 *
 * WHY: registry.md and queue.md are hand-editable markdown. LLM edits rot
 * tables; this script owns parsing + rendering so the router (and Troy)
 * can trust the state files.
 *
 * Subcommands:
 *   status                                   render pool + projects + queue
 *   add <project> <instruction...> [model]   append a queued item (auto id)
 *   claim <id>                                mark a queue item running
 *   done <id>                                mark a queue item done
 *   cooldown <model> [minutes] [reason...]   cool a model down (default 10)
 *   pool                                     enabled models, cooldowns,
 *                                            registry projects on disabled models
 *
 * Env overrides (for tests): FREE_POOL_DIR, NVIDIA_STATE_FILE.
 * Paths are resolved per call, so tests can point them at temp dirs.
 *
 * Importable: every command is an exported function; CLI runs via main().
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..");

function poolDir() {
	return process.env.FREE_POOL_DIR || join(ROOT, "data", "free-pool");
}
function nvidiaStateFile() {
	return process.env.NVIDIA_STATE_FILE || join(ROOT, "data", "nvidia-models-state.json");
}
function registryPath() {
	return join(poolDir(), "registry.md");
}
function queuePath() {
	return join(poolDir(), "queue.md");
}

// ---------------------------------------------------------------------------
// Markdown table parsing (tolerant)
// ---------------------------------------------------------------------------

/** Split raw markdown into { title, body } sections by "## " headers. */
export function sections(md) {
	const out = { "": "" };
	let current = "";
	for (const line of md.split(/\r?\n/)) {
		const m = line.match(/^##\s+(.*)$/);
		if (m) {
			current = m[1].trim();
			out[current] = "";
			continue;
		}
		out[current] += line + "\n";
	}
	return out;
}

/** Parse a table body into { header: string[], rows: string[][] }. */
export function parseTable(body) {
	const rows = [];
	for (const line of body.split(/\r?\n/)) {
		const trimmed = line.trim();
		if (!trimmed.startsWith("|")) continue;
		const cells = trimmed
			.split("|")
			.slice(1, -1)
			.map((c) => c.trim());
		if (cells.every((c) => /^:?-{2,}:?$/.test(c))) continue; // separator row
		rows.push(cells);
	}
	if (rows.length === 0) return { header: [], rows: [] };
	return { header: rows[0], rows: rows.slice(1) };
}

/** Render a table: header row, separator, then rows padded to header width. */
export function renderTable(header, rows) {
	const width = Math.max(header.length, ...rows.map((r) => r.length));
	const norm = (r) => {
		const copy = r.slice();
		while (copy.length < width) copy.push("");
		return copy;
	};
	const line = (cells) => "| " + norm(cells).join(" | ") + " |";
	const sep = "| " + Array.from({ length: width }, () => "---").join(" | ") + " |";
	return [line(header), sep, ...rows.map((r) => line(norm(r)))].join("\n");
}

// ---------------------------------------------------------------------------
// State read/write
// ---------------------------------------------------------------------------

const PROJECT_HEADER = ["project", "convId", "cwd", "model", "scope", "state", "lastTouch"];
const COOLDOWN_HEADER = ["model", "until (UTC)", "reason"];
const QUEUE_HEADER = ["id", "project", "instruction", "model", "state"];

export function readRegistry() {
	if (!existsSync(registryPath())) return { projects: [], cooldowns: [] };
	const md = readFileSync(registryPath(), "utf-8");
	const sec = sections(md);
	return {
		projects: parseTable(sec["Projects"] ?? "").rows,
		cooldowns: parseTable(sec["Cooldowns"] ?? "").rows,
	};
}

export function writeRegistry(projects, cooldowns) {
	if (!existsSync(poolDir())) mkdirSync(poolDir(), { recursive: true });
	const md =
		"# Glitch Free Registry\n\n" +
		"Source of truth for the router. Update via `node scripts/free-pool.mjs` (status / cooldown) or careful hand edit. Never holds chat history — only routing state.\n\n" +
		"## Projects\n\n" +
		renderTable(PROJECT_HEADER, projects) +
		"\n\n## Cooldowns\n\n" +
		renderTable(COOLDOWN_HEADER, cooldowns) +
		"\n";
	writeFileSync(registryPath(), md, "utf-8");
}

export function readQueue() {
	if (!existsSync(queuePath())) return [];
	const md = readFileSync(queuePath(), "utf-8");
	const sec = sections(md);
	return parseTable(sec["Queue"] ?? "").rows;
}

export function writeQueue(rows) {
	if (!existsSync(poolDir())) mkdirSync(poolDir(), { recursive: true });
	const md =
		"# Glitch Free Queue\n\n" +
		"Hand-editable by Troy. The router picks rows up as-is. Combine happens on the router side before steering. Never merge an item that already ran.\n\n" +
		"## Queue\n\n" +
		renderTable(QUEUE_HEADER, rows) +
		"\n";
	writeFileSync(queuePath(), md, "utf-8");
}

export function enabledModels() {
	if (!existsSync(nvidiaStateFile())) return [];
	const raw = JSON.parse(readFileSync(nvidiaStateFile(), "utf-8"));
	const models = Array.isArray(raw.models) ? raw.models : [];
	return models.filter((m) => m.enabled === true);
}

export function activeCooldowns(registry) {
	const now = Date.now();
	return (registry?.cooldowns ?? []).filter((row) => {
		const until = Date.parse(row[1] || "");
		return Number.isFinite(until) && until > now;
	});
}

// ---------------------------------------------------------------------------
// Commands (pure: take state, return strings; IO wrappers below)
// ---------------------------------------------------------------------------

export function nextQueueId(rows) {
	let max = 0;
	for (const row of rows) {
		const m = (row[0] || "").match(/^Q(\d+)$/);
		if (m) max = Math.max(max, parseInt(m[1], 10));
	}
	return `Q${max + 1}`;
}

export function cmdAdd(rows, project, instruction, model) {
	if (!project || !instruction) throw new Error("usage: add <project> <instruction...> [model]");
	const id = nextQueueId(rows);
	const state = model ? "queued" : "queued";
	const copy = rows.map((r) => r.slice());
	copy.push([id, project, instruction, model || "", state]);
	return { rows: copy, id };
}

export function setQueueState(rows, id, state) {
	const copy = rows.map((r) => r.slice());
	const row = copy.find((r) => (r[0] || "").trim() === id);
	if (!row) throw new Error(`unknown queue id "${id}"`);
	row[4] = state;
	return copy;
}

/** Upsert a project row by project name. Re-registering updates state/scope. */
export function cmdRegister(projects, project, convId, cwd, model, state, scope) {
	if (!project) throw new Error("usage: register <project> <convId> <cwd> <model> <state> <scope...>");
	const row = [project, convId || "", cwd || "", model || "", scope || "", state || "active", new Date().toISOString()];
	const rest = projects.filter((r) => (r[0] || "").trim() !== project);
	rest.push(row);
	rest.sort((a, b) => String(a[0]).localeCompare(String(b[0])));
	return rest;
}

export function cmdCooldown(cooldowns, model, minutes, reason) {
	if (!model) throw new Error("usage: cooldown <model> [minutes] [reason...]");
	const mins = Number.isFinite(Number(minutes)) && Number(minutes) > 0 ? Number(minutes) : 10;
	const until = new Date(Date.now() + mins * 60_000).toISOString();
	const rest = cooldowns.filter((r) => (r[0] || "").trim() !== model);
	rest.push([model, until, reason || "rate-limited"]);
	return rest;
}

/** Pi-qualified "nvidia/<nim-id>" → bare "<nim-id>" for state-file comparisons. */
export function nimId(id) {
	const s = (id || "").trim();
	return s.startsWith("nvidia/") ? s.slice("nvidia/".length) : s;
}

export function renderStatus() {
	const registry = readRegistry();
	const queue = readQueue();
	const pool = enabledModels();
	const cooldowns = activeCooldowns(registry);
	const cooldownIds = new Set(cooldowns.map((r) => nimId(r[0])));
	const enabledIds = new Set(pool.map((m) => m.id));

	const lines = [];
	lines.push("== Pool ==");
	lines.push(`enabled: ${pool.length} model(s)` + (cooldowns.length ? `, cooldown: ${cooldowns.length}` : ""));
	for (const m of pool) {
		const hot = cooldownIds.has(m.id) ? "  [COOLDOWN]" : "";
		lines.push(`  nvidia/${m.id} | tier ${m.tier} | ctx ${m.contextWindow}${hot}`);
	}
	lines.push("");
	lines.push("== Projects ==");
	if (registry.projects.length === 0) lines.push("  (none)");
	for (const r of registry.projects) {
		const flag = enabledIds.has(nimId(r[3])) ? "" : "  [MODEL DISABLED]";
		lines.push(`  ${r[0] || "?"} | ${r[3] || "?"} | ${r[5] || "?"} | ${r[6] || ""}${flag}`);
	}
	lines.push("");
	lines.push("== Queue ==");
	if (queue.length === 0) lines.push("  (empty)");
	for (const r of queue) {
		lines.push(`  ${r[0]} | ${r[1]} | ${(r[2] || "").slice(0, 60)} | ${r[3] || "auto"} | ${r[4] || "?"}`);
	}
	return lines.join("\n");
}

export function renderPool() {
	const registry = readRegistry();
	const pool = enabledModels();
	const cooldowns = activeCooldowns(registry);
	const enabledIds = new Set(pool.map((m) => m.id));
	const cooldownIds = new Set(cooldowns.map((r) => nimId(r[0])));

	const lines = [];
	if (pool.length === 0) {
		lines.push("no enabled models found (state file missing or empty): " + nvidiaStateFile());
	} else {
		lines.push(`enabled models: ${pool.length}`);
		for (const m of pool) {
			const hot = cooldownIds.has(m.id) ? " [COOLDOWN]" : "";
			lines.push(`  nvidia/${m.id} | tier ${m.tier} | ctx ${m.contextWindow} | reasoning ${m.reasoning}${hot}`);
		}
	}
	if (cooldowns.length) {
		lines.push("active cooldowns:");
		for (const r of cooldowns) lines.push(`  ${r[0]} until ${r[1]} (${r[2] || "rate-limited"})`);
	}
	const flagged = registry.projects.filter((r) => r[3] && !enabledIds.has(nimId(r[3])));
	if (flagged.length) {
		lines.push("FLAGGED (project model not in enabled set):");
		for (const r of flagged) lines.push(`  ${r[0]} uses ${r[3]}`);
	} else {
		lines.push("no registry project uses a disabled model");
	}
	return lines.join("\n");
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function usage() {
	return [
		"usage: node scripts/free-pool.mjs <command> [args]",
		"  status                                  render pool + projects + queue",
		"  add <project> <instruction...> [model]  append a queued item",
		"  register <project> <convId> <cwd> <model> <state> <scope...>",
		"                                           upsert a project registry row",
		"  claim <id>                              mark a queue item running",
		"  done <id>                               mark a queue item done",
		"  cooldown <model> [minutes] [reason...]  cool a model down (default 10 min)",
		"  pool                                    enabled models + flags",
	].join("\n");
}

export function main(argv) {
	const [cmd, ...rest] = argv;
	switch (cmd) {
		case "status":
			return renderStatus();
		case "pool":
			return renderPool();
		case "add": {
			const rows = readQueue();
			const project = rest[0];
			const maybeModel = rest[rest.length - 1];
			const hasModel = maybeModel && /^nvidia\//.test(maybeModel) && rest.length >= 3;
			const instruction = (hasModel ? rest.slice(1, -1) : rest.slice(1)).join(" ");
			const model = hasModel ? maybeModel : "";
			const result = cmdAdd(rows, project, instruction, model);
			writeQueue(result.rows);
			return `queued ${result.id} for ${project}${model ? ` on ${model}` : ""}`;
		}
		case "claim":
		case "done": {
			const id = rest[0];
			const rows = setQueueState(readQueue(), id, cmd === "claim" ? "running" : "done");
			writeQueue(rows);
			return `${id} -> ${cmd === "claim" ? "running" : "done"}`;
		}
		case "register": {
			const [project, convId, cwd, model, state, ...scopeParts] = rest;
			const registry = readRegistry();
			registry.projects = cmdRegister(registry.projects, project, convId, cwd, model, state, scopeParts.join(" "));
			writeRegistry(registry.projects, registry.cooldowns);
			return `registered ${project}`;
		}
		case "cooldown": {
			const [model, minutes, ...reason] = rest;
			const registry = readRegistry();
			registry.cooldowns = cmdCooldown(registry.cooldowns, model, minutes, reason.join(" "));
			writeRegistry(registry.projects, registry.cooldowns);
			return `${model} on cooldown`;
		}
		default:
			throw new Error(usage());
	}
}

// Run as CLI only when invoked directly (not imported by tests).
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
	try {
		const out = main(process.argv.slice(2));
		console.log(out);
	} catch (err) {
		console.error(String(err?.message ?? err));
		process.exit(1);
	}
}
