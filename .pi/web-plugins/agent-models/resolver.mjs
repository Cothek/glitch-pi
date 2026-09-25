/**
 * resolver.mjs — shared truth table for agent model pins.
 *
 * WHY THIS FILE EXISTS
 * `.pi/agents/*.md` frontmatter can pin a model, and `.pi/extensions/dispatcher.ts`
 * decides what actually runs:
 *
 *     const agentModel = agent.model && !/^opencode(-go)?\//.test(agent.model)
 *       ? agent.model : undefined;
 *     const model = agentModel ?? parentModel;
 *
 * Two ways a pin can die, and neither is reported anywhere today:
 *   1. it matches ^opencode(-go)?/ -> hard-dropped, because those providers do not
 *      exist on Pi
 *   2. it does not resolve in the live model runtime -> dropped by the spawn path
 * Either way the sub-agent silently runs on the PARENT model.
 *
 * This module is pure (no fs, no host) so the plugin server, the CLI and the unit
 * tests all classify identically. Catalog source differs per caller and is passed
 * in: the plugin passes host.models.list() (live, authenticated providers only),
 * the CLI passes a disk approximation.
 */

/** Frontmatter keys the fork's dispatcher actually reads (`.pi/lib/dispatcher-agents.ts`). */
export const DISPATCHER_KEYS = ["name", "description", "tools", "model"];

/**
 * The dispatcher's drop rule, verbatim. Kept as a regex constant so the plugin,
 * the CLI and the tests cannot drift apart from dispatcher.ts.
 */
export const DROPPED_MODEL_RE = /^opencode(-go)?\//;

export const STATUS = {
	/** Pin resolves and the dispatcher honours it. */
	OK: "ok",
	/** Pin matches the dispatcher's opencode filter: always ignored. */
	DROPPED: "dropped",
	/** Pin parses but is absent from the catalog the caller provided. */
	UNRESOLVED: "unresolved",
	/** No pin: the agent follows the main conversation model. */
	INHERIT: "inherit",
};

/** Human labels + what the reader should conclude. Severity feeds the CLI exit code. */
export const STATUS_INFO = {
	[STATUS.OK]: { label: "OK", severity: 0 },
	[STATUS.INHERIT]: { label: "INHERIT", severity: 1 },
	[STATUS.DROPPED]: { label: "DEAD PIN", severity: 2 },
	[STATUS.UNRESOLVED]: { label: "UNRESOLVED", severity: 2 },
};

/** Strip a UTF-8 BOM (PowerShell-written files carry one). */
function stripBom(text) {
	const s = String(text ?? "");
	return s.charCodeAt(0) === 0xfeff ? s.slice(1) : s;
}

/** Unquote a YAML scalar: `"x"`, `'x'` and a bare `x` all mean x. */
function unquote(value) {
	const v = value.trim();
	if (v.length >= 2) {
		const first = v[0];
		const last = v[v.length - 1];
		if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
			return v.slice(1, -1).trim();
		}
	}
	return v;
}

/**
 * Split a `---` frontmatter block from the body. Deliberately line-based rather
 * than a full YAML parse: agent frontmatter here is flat `key: value`, and a
 * malformed file must degrade to "no pin" instead of throwing during discovery.
 */
export function splitFrontmatter(rawText) {
	const text = stripBom(rawText);
	if (!text.startsWith("---")) return { data: {}, body: text.trim(), hasFrontmatter: false };
	const end = text.indexOf("\n---", 3);
	if (end === -1) return { data: {}, body: text.trim(), hasFrontmatter: false };
	const header = text.slice(3, end);
	const bodyStart = text.indexOf("\n", end + 1);
	const body = bodyStart === -1 ? "" : text.slice(bodyStart + 1).trim();
	const data = {};
	for (const line of header.split(/\r?\n/)) {
		const match = /^([A-Za-z_][\w-]*)\s*:\s*(.*)$/.exec(line);
		if (!match) continue;
		data[match[1]] = unquote(match[2]);
	}
	return { data, body, hasFrontmatter: true };
}

/** Accept both `tools: read, bash` and `tools: [read, bash]`. */
export function parseToolList(value) {
	if (Array.isArray(value)) return value.map((t) => String(t).trim()).filter(Boolean);
	if (typeof value !== "string") return [];
	return value
		.replace(/^\[|\]$/g, "")
		.split(",")
		.map((t) => t.trim().replace(/^["']|["']$/g, ""))
		.filter(Boolean);
}

/**
 * Parse one agent file into the shape the dispatcher would see, plus the file
 * name so a name/file mismatch can be surfaced.
 */
export function parseAgentFile(rawText, fileName) {
	const { data, body, hasFrontmatter } = splitFrontmatter(rawText);
	const fileBase = String(fileName ?? "").replace(/\.md$/i, "");
	return {
		file: fileName ?? null,
		fileBase,
		name: typeof data.name === "string" && data.name ? data.name : fileBase,
		description: typeof data.description === "string" ? data.description : "",
		tools: parseToolList(data.tools),
		model: typeof data.model === "string" && data.model.trim() ? data.model.trim() : null,
		body,
		hasFrontmatter,
	};
}

/** Provider segment of a `provider/id` pin (id may itself contain slashes). */
export function providerOf(modelId) {
	const s = String(modelId ?? "");
	const slash = s.indexOf("/");
	return slash > 0 ? s.slice(0, slash) : "";
}

/**
 * Classify one pin. `catalogIds` is any iterable/Set of exact `provider/id`
 * strings the caller considers available. An empty catalog means "no catalog
 * available" (no keys configured) and yields status "unknown-catalog" rather
 * than pretending the pin is broken.
 */
export function classifyModelPin(pin, catalogIds) {
	if (!pin) {
		return {
			status: STATUS.INHERIT,
			effective: null,
			effectiveLabel: "main conversation model",
			why: "no model pin - follows the main conversation model",
		};
	}
	if (DROPPED_MODEL_RE.test(pin)) {
		return {
			status: STATUS.DROPPED,
			effective: null,
			effectiveLabel: "main conversation model",
			why: `dispatcher drops "${providerOf(pin)}/*" pins (provider not configured on Pi)`,
		};
	}
	const catalog = catalogIds instanceof Set ? catalogIds : new Set(catalogIds ?? []);
	if (catalog.size === 0) {
		return {
			status: STATUS.UNRESOLVED,
			effective: null,
			effectiveLabel: "main conversation model",
			why: "pin looks usable but no model catalog was available to confirm it (no provider keys?)",
		};
	}
	if (catalog.has(pin)) {
		return {
			status: STATUS.OK,
			effective: pin,
			effectiveLabel: pin,
			why: `resolves via provider "${providerOf(pin)}"`,
		};
	}
	return {
		status: STATUS.UNRESOLVED,
		effective: null,
		effectiveLabel: "main conversation model",
		why: "not in the available model catalog (missing key, removed model, or typo)",
	};
}

/**
 * Cheap structural lints. These exist because a broken prompt fails AT DISPATCH
 * time inside a sub-agent, where nobody sees the cause.
 */
export function lintAgent(agent) {
	const warnings = [];
	const tools = agent.tools ?? [];
	if (/\bskill\(\s*["']/.test(agent.body) && !tools.includes("skill")) {
		warnings.push('body calls skill("...") but the tools allowlist has no "skill" tool');
	}
	if (/\btask\(\s*\{/.test(agent.body) && tools.includes("task")) {
		warnings.push("sub-agent body instructs task() dispatch and tools allow it (sub-agents must not delegate)");
	}
	if (agent.fileBase && agent.name && agent.fileBase !== agent.name) {
		warnings.push(`frontmatter name "${agent.name}" differs from file name "${agent.fileBase}.md"`);
	}
	if (!agent.hasFrontmatter) warnings.push("no frontmatter block (dispatcher skips files without name + description)");
	if (!agent.tools.length) warnings.push("no tools allowlist - dispatcher passes no --tools flag");
	return warnings;
}

/**
 * Build the full report the UI and the CLI both render.
 * `agents` are parseAgentFile results; `catalogIds` as above; `catalogSource`
 * is a short string shown in the header so nobody has to guess what "available"
 * meant for this run.
 */
export function buildReport(agents, catalogIds, catalogSource = "unknown") {
	const catalog = catalogIds instanceof Set ? catalogIds : new Set(catalogIds ?? []);
	const rows = agents.map((agent) => {
		const verdict = classifyModelPin(agent.model, catalog);
		return {
			...agent,
			body: undefined,
			pin: agent.model,
			status: verdict.status,
			statusLabel: STATUS_INFO[verdict.status]?.label ?? verdict.status,
			severity: STATUS_INFO[verdict.status]?.severity ?? 0,
			effective: verdict.effective,
			effectiveLabel: verdict.effectiveLabel,
			why: verdict.why,
			warnings: lintAgent(agent),
		};
	});
	const counts = {
		total: rows.length,
		ok: rows.filter((r) => r.status === STATUS.OK).length,
		dropped: rows.filter((r) => r.status === STATUS.DROPPED).length,
		unresolved: rows.filter((r) => r.status === STATUS.UNRESOLVED).length,
		inherit: rows.filter((r) => r.status === STATUS.INHERIT).length,
		warnings: rows.reduce((n, r) => n + r.warnings.length, 0),
		problems: rows.filter((r) => r.severity > 0).length,
	};
	return { rows, counts, catalogSize: catalog.size, catalogSource, generatedAt: new Date().toISOString() };
}

/**
 * Rewrite the `model:` line inside an agent file's frontmatter.
 *
 * PRESERVES EVERYTHING ELSE BYTE-FOR-BYTE: comments, key order, blank lines, the
 * body, the BOM and the file's own line endings. This is deliberately NOT a YAML
 * re-serialisation: re-emitting the frontmatter would reorder keys, drop comments
 * and requote strings, producing a big meaningless diff in a file a human
 * maintains by hand.
 *
 * model === null | "" -> remove the pin (the agent inherits the main model).
 * Returns { ok, text, changed, previous, reason } and never throws.
 */
export function setModelInFrontmatter(rawText, model) {
	const text = String(rawText ?? "");
	if (!text.trim()) return { ok: false, changed: false, previous: null, text, reason: "empty file" };
	const bom = text.charCodeAt(0) === 0xfeff ? "\uFEFF" : "";
	const body = bom ? text.slice(1) : text;
	if (!body.startsWith("---")) {
		return {
			ok: false,
			changed: false,
			previous: null,
			text,
			reason: "no frontmatter block (the dispatcher needs name + description there anyway)",
		};
	}
	const eol = body.includes("\r\n") ? "\r\n" : "\n";
	const lines = body.split(/\r?\n/);

	let end = -1;
	for (let i = 1; i < lines.length; i++) {
		if (lines[i].trim() === "---") {
			end = i;
			break;
		}
	}
	if (end === -1) return { ok: false, changed: false, previous: null, text, reason: "unterminated frontmatter" };

	const wanted = typeof model === "string" && model.trim() ? model.trim() : null;
	let previous = null;
	let modelIndex = -1;
	for (let i = 1; i < end; i++) {
		const m = /^(\s*)model\s*:\s*(.*)$/.exec(lines[i]);
		if (!m) continue;
		modelIndex = i;
		previous = unquote(m[2]) || null;
		break;
	}

	if (modelIndex === -1) {
		if (!wanted) {
			return { ok: true, changed: false, previous: null, text, reason: "this agent has no pin to remove" };
		}
		// Insert as the last key of the block, before any trailing blank lines.
		let insertAt = end;
		while (insertAt > 1 && lines[insertAt - 1].trim() === "") insertAt--;
		lines.splice(insertAt, 0, `model: ${wanted}`);
	} else if (!wanted) {
		lines.splice(modelIndex, 1);
	} else if (previous === wanted) {
		return { ok: true, changed: false, previous, text, reason: "already pinned to that model" };
	} else {
		lines[modelIndex] = `model: ${wanted}`;
	}

	return { ok: true, changed: true, previous, text: bom + lines.join(eol), reason: null };
}

/**
 * Money, compactly: 0.25 stays 0.25, 10 stays 10, 12.5 stays 12.5, 0.005 keeps
 * three decimals instead of rounding to a meaningless 0.01.
 */
function money(n) {
	if (typeof n !== "number" || !Number.isFinite(n)) return "?";
	return Number(n)
		.toFixed(3)
		.replace(/0+$/, "")
		.replace(/\.$/, "");
}

/**
 * Cost label for the picker, in the 3 states the data actually has:
 *   free     - every field is 0 (the NVIDIA endpoints really are free)
 *   n/a      - the provider publishes no pricing anywhere on this machine
 *   $in/$out - USD per million tokens, the unit both config files use
 *
 * Formatting lives here (server side) and ships inside the payload, so the client
 * cannot drift from the CLI.
 */
export function formatCostShort(cost) {
	if (!cost) return "n/a";
	if (cost.in === 0 && cost.out === 0) return "free";
	// A tilde means ESTIMATED: the number comes from another vendor's list for the same
	// model slug, because this provider publishes nothing. Never shown as published.
	return `${cost.estimated ? "~" : ""}$${money(cost.in)}/$${money(cost.out)}`;
}

/** Hover text: what the numbers mean and where they came from. */
export function formatCostTitle(cost) {
	if (!cost) return "no pricing data for this provider (add it to .pi/agent-models/prices.json)";
	if (cost.in === 0 && cost.out === 0) return "free endpoints (every cost field is 0)";
	const parts = [`input $${money(cost.in)} / output $${money(cost.out)} USD per million tokens`];
	if (typeof cost.cacheRead === "number") parts.push(`cache read $${money(cost.cacheRead)}`);
	if (typeof cost.cacheWrite === "number") parts.push(`cache write $${money(cost.cacheWrite)}`);
	if (cost.estimated) parts.push(`ESTIMATED from ${cost.estimatedFrom ?? "a same-slug model"} (this provider publishes no price)`);
	else if (cost.source) parts.push(`source: ${cost.source}`);
	if (typeof cost.contextWindow === "number") parts.push(`context ${Math.round(cost.contextWindow / 1000)}K`);
	if (cost.tier) parts.push(`tier: ${cost.tier}`);
	return parts.join(" | ");
}

/** Fixed-width text table for the CLI and the `/agent-models` slash command. */
export function formatReportTable(report) {
	const withCost = report.rows.some((r) => r.costShort);
	const withTier = report.rows.some((r) => r.tier);
	const header = [
		"AGENT",
		"PINNED MODEL",
		...(withCost ? ["COST"] : []),
		...(withTier ? ["TIER"] : []),
		"EFFECTIVE",
		"STATUS",
		"NOTE",
	];
	const cells = report.rows.map((r) => [
		r.name,
		r.pin ?? "(none)",
		...(withCost ? [r.costShort ?? "n/a"] : []),
		...(withTier ? [r.tier ?? "unknown"] : []),
		r.effective ?? r.effectiveLabel,
		r.statusLabel,
		r.warnings.length ? r.warnings.join("; ") : r.why,
	]);
	const width = header.map((h, i) => Math.max(h.length, ...cells.map((c) => String(c[i]).length)));
	const line = (row) => row.map((c, i) => String(c).padEnd(width[i])).join("  ").trimEnd();
	const out = [line(header), width.map((w) => "-".repeat(w)).join("  ")];
	for (const row of cells) out.push(line(row));
	const c = report.counts;
	out.push("");
	out.push(
		`${c.total} agents | ${c.ok} pinned OK | ${c.dropped} dead pins | ${c.unresolved} unresolved | ${c.inherit} inherit | ${c.warnings} warnings`,
	);
	out.push(`catalog: ${report.catalogSize} available models (${report.catalogSource})`);
	return out.join("\n");
}
