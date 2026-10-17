/**
 * agent-models — pi-web-ui plugin (server entry)
 *
 * WHAT IT ANSWERS: "which model does each `.pi/agents/*.md` actually run on?"
 * The one thing this adds over a plain list is the STATUS: a pin that the
 * dispatcher drops (opencode/*) or that is missing from the live model catalog
 * means the sub-agent silently runs on the MAIN conversation model.
 *
 * WHERE THE DATA COMES FROM
 *   agents  : host.fs.list(".pi/agents") + readText  (workspace-relative, fs:read)
 *   catalog : host.models.list() -> [{id:"provider/model", provider, vision}]
 *             from the live runtime, so it means "authenticated and usable"
 *
 * CROSS-PROJECT FALLBACK: when the workspace has no .pi/agents/*.md files, the
 * plugin falls back to the glitch-pi repo's agents directory at
 * E:/Glitch AI/glitch-pi/.pi/agents using host.fs.requestAccess. The grant is
 * requested LAZILY (only when the workspace roster is empty) and cached per
 * activation. If denied, the page keeps the empty state with a fallbackHint
 * explaining how to grant access. Write paths (/set-model, /set-models, /restore)
 * resolve through the same helper so validation and backups work under the fallback.
 *
 * SURFACES
 *   0. composer button (chat bar, right of the thinking chip) -> opens the page
 *      via kind:"view": the stock client navigates to view:"plugin:agent-models"
 *      on click, so no client handler is involved.
 *   1. right-panel tab (manifest "view": true) -> client fetches GET /state
 *   2. GET  /plugins-api/agent-models/state     -> JSON report (catalog, models, facets, configs)
 *   3. POST /plugins-api/agent-models/set-model  -> rewrite ONE agent's model pin
 *   3b. POST /plugins-api/agent-models/set-models -> rewrite MANY agents' model pin
 *       in one round trip (multi-select in the panel; same validation + per-agent
 *       backup as /set-model, per-agent results so a partial failure is visible)
 *   4. POST /plugins-api/agent-models/restore   -> restore an agent's newest backup
 *   5. GET  /plugins-api/agent-models/configs    -> full saved-config list (with pins)
 *   6. POST /plugins-api/agent-models/configs/save   -> snapshot current pins under a name
 *   7. POST /plugins-api/agent-models/configs/apply  -> batch-set all pins from a saved config
 *   8. POST /plugins-api/agent-models/configs/delete -> remove a saved config
 *   9. /agent-models slash command -> same table as text, no browser needed
 *
 * WRITE PATH SAFETY (POST /set-model): the agent name is validated against the
 * files actually discovered in .pi/agents (never interpolated blindly), the
 * requested model must exist in the live catalog or be an explicit "inherit",
 * the file is backed up before the first byte changes, and the edit itself only
 * rewrites the `model:` line so comments and key order survive untouched.
 *
 * SURFACES
 *   0. composer button (chat bar, right of the thinking chip) -> opens the page
 *      via kind:"view": the stock client navigates to view:"plugin:agent-models"
 *      on click, so no client handler is involved.
 *   1. right-panel tab (manifest "view": true) -> client fetches GET /state
 *   2. GET  /plugins-api/agent-models/state     -> JSON report (catalog, models, facets, configs)
 *   3. POST /plugins-api/agent-models/set-model  -> rewrite ONE agent's model pin
 *   3b. POST /plugins-api/agent-models/set-models -> rewrite MANY agents' model pin
 *       in one round trip (multi-select in the panel; same validation + per-agent
 *       backup as /set-model, per-agent results so a partial failure is visible)
 *   4. POST /plugins-api/agent-models/restore   -> restore an agent's newest backup
 *   5. GET  /plugins-api/agent-models/configs    -> full saved-config list (with pins)
 *   6. POST /plugins-api/agent-models/configs/save   -> snapshot current pins under a name
 *   7. POST /plugins-api/agent-models/configs/apply  -> batch-set all pins from a saved config
 *   8. POST /plugins-api/agent-models/configs/delete -> remove a saved config
 *   9. /agent-models slash command -> same table as text, no browser needed
 */

import { definePlugin } from "./sdk/index.mjs";

/**
 * NESTED-IMPORT CACHE (found the hard way, live): the host re-imports THIS entry
 * with a cache-busting query on every reload, but nested relative imports are
 * cached by the Node ESM loader for the life of the process. After adding an
 * export to resolver.mjs, the re-activated plugin kept the OLD module and died
 * with "does not provide an export named 'setModelInFrontmatter'" - a plugin that
 * then shows up as failed in the UI while the file on disk looks perfect.
 *
 * So nested imports are cache-busted here too, with a per-activation nonce.
 * Trade-off: the loader keeps one small extra copy of resolver.mjs per activation
 * (a few hundred bytes, a pure function module). Correctness over micro-efficiency:
 * a fixed version tag would rot the moment someone edits a helper without bumping it.
 */
const IMPORT_TAG = `${Date.now().toString(36)}`;
const resolver = await import(new URL(`./resolver.mjs?v=${IMPORT_TAG}`, import.meta.url).href);
const { buildReport, formatCostShort, formatCostTitle, formatReportTable, parseAgentFile, setModelInFrontmatter } = resolver;

const AGENTS_DIR = ".pi/agents";
/** Fallback agents directory: the glitch-pi repo's agents folder.
 *  Normalized with forward slashes for cross-platform consistency.
 *  requestAccess grants read+write outside the workspace (verified against
 *  plugins.js allowAbs which accepts paths inside the workspace OR in the
 *  plugin grants table). */
const FALLBACK_AGENTS_DIR = "E:/Glitch AI/glitch-pi/.pi/agents".replace(/\\/g, "/");
/** Backups live INSIDE the workspace on purpose: cross-directory writes would
 *  need a separate user directory grant, workspace writes do not. */
const BACKUP_DIR = ".pi/agent-models/backups";
/** Price table written by scripts/agent-model-costs.mjs. Also workspace-relative,
 *  for the same reason: the real prices live in <agent-dir>/models*.json, which a
 *  plugin may not read without a directory grant. */
const COSTS_PATH = ".pi/agent-models/costs.json";
// The NVIDIA sync engine's state file (workspace-relative, so host.fs.readText
// reaches it with the fs:read permission - no extra grant). Its enabled rows
// are the source of truth for models turned on via the sync engine or the
// built-in model manager. The runtime registry behind host.models.list() is a
// startup snapshot: a model enabled there exists in the state file long before
// the runtime registry reloads, so without this merge it never shows in the
// pickers.
const NVIDIA_STATE_PATH = "data/nvidia-models-state.json";

async function readNvidiaStateCatalog(host) {
	/** Enabled rows of the NVIDIA sync state file, flattened to
	 *  [{ id: "nvidia/<nim-id>", vision }]. NIM ids may themselves start with
	 *  "nvidia/" so a full id can be "nvidia/nvidia/<id>" - that is correct and
	 *  matches the agent pins; do not dedupe or strip. Missing, corrupt, or
	 *  unreadable file returns [] and the caller falls back to the runtime list
	 *  alone (the tests' fs mocks have no such file, keeping them isolated). */
	try {
		const doc = JSON.parse(await host.fs.readText(NVIDIA_STATE_PATH));
		const rows = Array.isArray(doc?.models) ? doc.models : [];
		const out = [];
		for (const m of rows) {
			if (typeof m?.id !== "string" || !m.id || m.enabled !== true) continue;
			out.push({ id: `nvidia/${m.id}`, vision: Array.isArray(m.input) && m.input.includes("image") });
		}
		return out;
	} catch {
		return [];
	}
}
/** Report cache: cheap to rebuild, but /state is polled by the tab. */
const STATE_TTL_MS = 5000;

/**
 * Named model configurations — snapshots of every agent's model pin that the
 * user can save and swap between (e.g. "free models", "cheaper models",
 * "premium models"). Stored workspace-relative alongside costs/backups so no
 * extra directory grant is needed beyond the fs:write the plugin already holds.
 */
const CONFIGS_PATH = ".pi/agent-models/configs.json";

const EXCLUDED_AGENTS = new Set(["glitch-omni"]);

async function listAgentFiles(host) {
	try {
		const entries = await host.fs.list(AGENTS_DIR);
		return entries
			.filter((e) => e.type === "file" && e.name.endsWith(".md"))
			.map((e) => e.name)
			.filter((name) => !EXCLUDED_AGENTS.has(name.replace(/\.md$/, "")))
			.sort((a, b) => a.localeCompare(b));
	} catch {
		return [];
	}
}

/**
 * Resolve the agents directory to use for reads and writes.
 * Workspace wins when non-empty; otherwise fallback (with lazy grant).
 * Returns { dir, fallbackHint } where fallbackHint is set when the grant
 * was denied or failed (so the UI can explain how to grant access).
 */


async function readCatalog(host) {
	try {
		const listed = await host.models.list();
		const ids = new Set();
		/** Vision comes from the LIVE runtime, so the capability filter covers every
		 *  model in the catalog and not just the ones with a price entry. */
		const vision = new Map();
		for (const m of listed ?? []) {
			if (typeof m?.id !== "string" || !m.id) continue;
			ids.add(m.id);
			if (m.vision === true) vision.set(m.id, true);
		}
		// Merge the NVIDIA sync state additively: the runtime registry is a
		// startup snapshot, so a model enabled via the sync engine is
		// visible here long before the runtime sees it.
		for (const entry of await readNvidiaStateCatalog(host)) {
			if (!ids.has(entry.id)) ids.add(entry.id);
			if (entry.vision && !vision.has(entry.id)) vision.set(entry.id, true);
		}
		return { ids, vision };
	} catch {
		return { ids: new Set(), vision: new Map() };
	}
}

/**
 * Price table, best effort. Missing file is not an error: the picker then shows
 * "n/a" everywhere and a hint to generate it. Labels are computed HERE and shipped
 * in the payload so the client and the CLI cannot format the same number two ways.
 */
async function readCosts(host) {
	try {
		const doc = JSON.parse(await host.fs.readText(COSTS_PATH));
		const table = doc && typeof doc.costs === "object" && doc.costs ? doc.costs : {};
		const costs = {};
		for (const [id, cost] of Object.entries(table)) {
			costs[id] = {
				in: typeof cost?.in === "number" ? cost.in : null,
				out: typeof cost?.out === "number" ? cost.out : null,
				source: cost?.source ?? null,
				short: formatCostShort(cost),
				title: formatCostTitle(cost),
				tier: typeof cost?.tier === "string" ? cost.tier : null,
				estimated: cost?.estimated === true,
				estimatedFrom: typeof cost?.estimatedFrom === "string" ? cost.estimatedFrom : null,
				vision: cost?.vision === true,
				contextWindow: typeof cost?.contextWindow === "number" ? cost.contextWindow : null,
				name: typeof cost?.name === "string" ? cost.name : null,
				minPlan: typeof cost?.minPlan === "string" ? cost.minPlan : null,
			};
		}
		return {
			costs,
			meta: {
				path: COSTS_PATH,
				generatedAt: typeof doc?.generatedAt === "string" ? doc.generatedAt : null,
				sources: Array.isArray(doc?.sources) ? doc.sources : [],
				summary: doc?.summary ?? null,
			},
		};
	} catch {
		return { costs: {}, meta: { path: COSTS_PATH, missing: true, hint: "run: node scripts/agent-model-costs.mjs" } };
	}
}

/** Backups per agent, for the rollback affordance: one listing, counted by prefix. */
async function countBackups(host) {
	const counts = new Map();
	try {
		for (const entry of await host.fs.list(BACKUP_DIR)) {
			if (entry.type !== "file" || !entry.name.endsWith(".md")) continue;
			const dash = entry.name.indexOf("-");
			const agent = dash > 0 ? entry.name.slice(0, dash) : "";
			if (!agent) continue;
			counts.set(agent, (counts.get(agent) ?? 0) + 1);
		}
	} catch {
		/* no backups yet */
	}
	return counts;
}

/** Read saved model configurations. Returns [] if the file is absent or unreadable. */
async function readConfigs(host) {
	try {
		const doc = JSON.parse(await host.fs.readText(CONFIGS_PATH));
		return Array.isArray(doc?.configs) ? doc.configs : [];
	} catch {
		return [];
	}
}

/** Write configs back to disk (workspace-relative, no extra grant needed). */
async function writeConfigs(host, configs) {
	try {
		await host.fs.mkdir(".pi/agent-models");
	} catch {
		/* already there */
	}
	await host.fs.write(CONFIGS_PATH, JSON.stringify({ configs }, null, 1));
}

/** Stable slug from a display name: "Free Models" -> "free-models". */
function slugifyConfigId(name) {
	return String(name ?? "")
		.toLowerCase()
				.trim()
			.replace(/[^a-z0-9]+/g, "-")
			.replace(/^-+|-+$/g, "") || "config";
}

/** Summary of one config for the /state payload: no pins, just metadata. */
function configSummary(config) {
	return {
		id: config.id,
		name: config.name,
		description: config.description ?? null,
		createdAt: config.createdAt,
		updatedAt: config.updatedAt,
		agentCount: config.pins ? Object.keys(config.pins).length : 0,
	};
}

/** Every agent's current pin from a fresh report (null = inherits the main model). */
function pinsFromReport(report) {
	const pins = {};
	for (const row of report?.rows ?? []) pins[row.name] = row.pin;
	return pins;
}

export default definePlugin({
	async activate(host) {
		const cleanup = [];
		let cache = null;
		let cacheAt = 0;
		let catalogSize = 0;

		// Per-activation cache for the fallback directory resolution
		let fallbackCache = null;

		/** Resolve the agents directory to use for reads and writes.
		 * Workspace wins when non-empty; otherwise fallback (with lazy grant).
		 * Returns { dir, fallbackHint } where fallbackHint is set when the grant
		 * was denied or failed (so the UI can explain how to grant access). */
		async function resolveAgentsDir(host) {
			const workspaceFiles = await listAgentFiles(host);
			if (workspaceFiles.length > 0) {
				return { dir: AGENTS_DIR, fallbackHint: null };
			}

			// Workspace is empty — try the fallback directory with lazy grant.
			// Cache the outcome per activation so requestAccess fires once, not on every poll.
			if (fallbackCache === null) {
				try {
					const granted = await host.fs.requestAccess(FALLBACK_AGENTS_DIR, "Read agent model pins from the glitch-pi repository");
					if (granted) {
						fallbackCache = { dir: FALLBACK_AGENTS_DIR, fallbackHint: null };
					} else {
						fallbackCache = { dir: FALLBACK_AGENTS_DIR, fallbackHint: `Access to the fallback agents directory (${FALLBACK_AGENTS_DIR}) was denied. Grant it in Settings > Interface Plugins > Agent Models to see the glitch-pi agent roster.` };
					}
				} catch (err) {
					fallbackCache = { dir: FALLBACK_AGENTS_DIR, fallbackHint: `Failed to request access to the fallback agents directory: ${err?.message ?? err}` };
				}
			}
			return fallbackCache;
		}

		/** Collect + classify. Always rebuilds from disk; the caller decides about caching. */
		async function collect() {
			const { dir: agentsDir, fallbackHint } = await resolveAgentsDir(host);
			const catalog = await readCatalog(host);
			catalogSize = catalog.ids.size;
			const priceData = await readCosts(host);
			const backupCounts = await countBackups(host);
			const agents = [];
			const unreadable = [];

			let files = [];
			try {
				const entries = await host.fs.list(agentsDir);
				files = entries
					.filter((e) => e.type === "file" && e.name.endsWith(".md"))
					.map((e) => e.name)
					.filter((name) => !EXCLUDED_AGENTS.has(name.replace(/\.md$/, "")))
					.sort((a, b) => a.localeCompare(b));
			} catch {
				files = [];
			}

			for (const name of files) {
				try {
					agents.push(parseAgentFile(await host.fs.readText(`${agentsDir}/${name}`), name));
				} catch {
					unreadable.push(name);
				}
			}
			const report = buildReport(
				agents,
				catalog.ids,
				`host.models.list() - ${catalog.ids.size} authenticated model${catalog.ids.size === 1 ? "" : "s"}`,
			);
			report.agentsDir = agentsDir;
			report.unreadable = unreadable;
			if (fallbackHint) report.fallbackHint = fallbackHint;
			// The picker needs the full list; 500-odd ids is a small payload locally.
			report.catalog = [...catalog.ids].sort();
			report.costs = priceData.costs;
			report.costMeta = priceData.meta;

			// One entry per catalog model with everything the picker prints, precomputed
			// here so the client cannot drift from the CLI or re-derive a label.
			const models = {};
			for (const id of report.catalog) {
				const cost = priceData.costs[id] ?? null;
				const ctx = cost?.contextWindow ?? null;
				models[id] = {
					short: cost?.short ?? "n/a",
					title: cost?.title ?? "no pricing data for this model's provider",
					tier: cost?.tier ?? "unknown",
					estimated: cost?.estimated === true,
					vision: cost?.vision === true || catalog.vision.get(id) === true,
					largeContext: typeof ctx === "number" && ctx >= 200000,
					contextWindow: ctx,
					provider: id.slice(0, Math.max(0, id.indexOf("/"))),
					name: cost?.name ?? null,
					minPlan: cost?.minPlan ?? null,
				};
			}
			report.models = models;

			// Filter facets, tallied from the same entries the rows use.
			const tally = (counts) =>
				[...counts.entries()]
					.sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
					.map(([id, count]) => ({ id, count }));
			const providers = new Map();
			const tiers = new Map();
			let visionCount = 0;
			let largeCount = 0;
			for (const m of Object.values(models)) {
				providers.set(m.provider, (providers.get(m.provider) ?? 0) + 1);
				tiers.set(m.tier, (tiers.get(m.tier) ?? 0) + 1);
				if (m.vision) visionCount++;
				if (m.largeContext) largeCount++;
			}
			report.facets = {
				providers: tally(providers),
				tiers: tally(tiers),
				capabilities: [
					...(visionCount ? [{ id: "vision", label: "Vision", count: visionCount }] : []),
					...(largeCount ? [{ id: "largeContext", label: "200K+ context", count: largeCount }] : []),
				],
			};

			// Per-row view: the price/tier of the CURRENT pin, plus how many backups exist.
			for (const row of report.rows) {
				const info = row.pin ? models[row.pin] ?? null : null;
				row.costShort = info?.short ?? (row.pin ? "n/a" : null);
				row.costTitle = info?.title ?? null;
				row.tier = info?.tier ?? null;
				row.vision = info?.vision === true;
				row.contextWindow = info?.contextWindow ?? null;
				row.backups = backupCounts.get(row.name) ?? 0;
			}
			// Saved configurations summary (no pins) — the client polls /state.
			report.configs = (await readConfigs(host)).map(configSummary);
			return report;
		}

		async function state(force = false) {
			const now = Date.now();
			if (!force && cache && now - cacheAt < STATE_TTL_MS) return cache;
			cache = await collect();
			cacheAt = now;
			return cache;
		}

		function json(res, status, payload) {
			res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
			res.end(JSON.stringify(payload));
		}

		cleanup.push(
			host.route("GET", "/state", async (req, res) => {
				try {
					const url = new URL(String(req?.url ?? "/"), "http://localhost");
					const force = url.searchParams.has("refresh");
					json(res, 200, { ok: true, ...(await state(force)) });
				} catch (err) {
					json(res, 500, { ok: false, error: err?.message ?? String(err) });
				}
			}),
		);

		/**
		 * Write path. The host mounts plugin routes behind express.json(), so the body
		 * is ALREADY parsed and the stream consumed - use req.body, never req.on('data')
		 * (which hangs forever; the host's mount point even warns about it).
		 */
		cleanup.push(
			host.route("POST", "/set-model", async (req, res) => {
				try {
					const body = req && typeof req.body === "object" && req.body !== null ? req.body : {};
					const agent = String(body.agent ?? "").trim();
					const model = body.model === null || body.model === undefined ? "" : String(body.model).trim();

					if (!/^[A-Za-z0-9._-]+$/.test(agent)) {
						return json(res, 400, { ok: false, error: `invalid agent name: ${JSON.stringify(agent)}` });
					}
					// Validate against the discovered files, never interpolate blindly.
					const { dir: agentsDir } = await resolveAgentsDir(host);
					let files = [];
					try {
						const entries = await host.fs.list(agentsDir);
						files = entries
							.filter((e) => e.type === "file" && e.name.endsWith(".md"))
							.map((e) => e.name)
							.filter((name) => !EXCLUDED_AGENTS.has(name.replace(/\.md$/, "")))
							.sort((a, b) => a.localeCompare(b));
					} catch {
						files = [];
					}
					if (!files.includes(`${agent}.md`)) {
						return json(res, 404, { ok: false, error: `unknown agent: ${agent}` });
					}

					const catalog = await readCatalog(host);
					if (model && !catalog.ids.has(model)) {
						return json(res, 400, {
							ok: false,
							error: `not an available model: ${model} (catalog has ${catalog.ids.size}; an unknown pin would silently fall back to the main model)`,
						});
					}

					const file = `${agentsDir}/${agent}.md`;
					const before = await host.fs.readText(file);
					const edit = setModelInFrontmatter(before, model || null);
					if (!edit.ok) return json(res, 400, { ok: false, error: edit.reason });

					let backup = null;
					if (edit.changed) {
						const stamp = new Date().toISOString().replace(/[:.]/g, "-");
						backup = `${BACKUP_DIR}/${agent}-${stamp}.md`;
						try {
							await host.fs.mkdir(BACKUP_DIR);
						} catch {
							/* already there */
						}
						await host.fs.write(backup, before);
						await host.fs.write(file, edit.text);
						host.log(`set ${agent} model -> ${model || "(inherit)"} (was ${edit.previous ?? "none"}); backup ${backup}`);
					}

					json(res, 200, {
						ok: true,
						agent,
						model: model || null,
						previous: edit.previous,
						changed: edit.changed,
						reason: edit.reason,
						backup,
						report: await state(true),
					});
				} catch (err) {
					json(res, 500, { ok: false, error: err?.message ?? String(err) });
				}
			}),
		);

		/**
		 * POST /set-models — apply ONE model to MANY agents in one round trip
		 * (the panel's multi-select: tick agents, pick a model, apply once).
		 *
		 * Same validation as /set-model, evaluated ONCE for the whole batch: every
		 * agent name must match the regex AND a file actually discovered in .pi/agents,
		 * and the model must be in the live catalog or be an explicit inherit — so an
		 * unknown pin can never be written. Each affected file is backed up BEFORE its
		 * first byte changes (same stamp for the whole batch, so one apply is one
		 * recognizable backup group). A per-agent failure (unreadable file, no
		 * frontmatter) does not abort the batch: it is reported in `results` and
		 * counted in `summary.failed`, matching the configs/apply behavior.
		 *
		 * The response carries the refreshed roster so the UI updates in one round trip,
		 * exactly like the single-agent write.
		 */
		cleanup.push(
			host.route("POST", "/set-models", async (req, res) => {
				try {
					const body = req && typeof req.body === "object" && req.body !== null ? req.body : {};
					const agentsRaw = Array.isArray(body.agents) ? body.agents : [];
					// Dedupe + trim: the same agent twice must not double-write.
					const agents = [...new Set(agentsRaw.map((a) => String(a ?? "").trim()).filter(Boolean))];
					const model = body.model === null || body.model === undefined ? "" : String(body.model).trim();

					if (!agents.length) {
						return json(res, 400, { ok: false, error: "no agents selected" });
					}
					if (agents.length > 100) {
						return json(res, 400, { ok: false, error: `too many agents (${agents.length}); max 100` });
					}
					for (const agent of agents) {
						if (!/^[A-Za-z0-9._-]+$/.test(agent)) {
							return json(res, 400, { ok: false, error: `invalid agent name: ${JSON.stringify(agent)}` });
						}
					}
					// Validate against the discovered files, never interpolate blindly.
					const { dir: agentsDir } = await resolveAgentsDir(host);
					let files = [];
					try {
						const entries = await host.fs.list(agentsDir);
						files = entries
							.filter((e) => e.type === "file" && e.name.endsWith(".md"))
							.map((e) => e.name)
							.filter((name) => !EXCLUDED_AGENTS.has(name.replace(/\.md$/, "")))
							.sort((a, b) => a.localeCompare(b));
					} catch {
						files = [];
					}
					const unknown = agents.filter((agent) => !files.includes(`${agent}.md`));
					if (unknown.length) {
						return json(res, 404, { ok: false, error: `unknown agent(s): ${unknown.join(", ")}` });
					}

					const catalog = await readCatalog(host);
					if (model && !catalog.ids.has(model)) {
						return json(res, 400, {
							ok: false,
							error: `not an available model: ${model} (catalog has ${catalog.ids.size}; an unknown pin would silently fall back to the main model)`,
						});
					}

					const stamp = new Date().toISOString().replace(/[:.]/g, "-");
					const results = [];
					let applied = 0;
					let unchanged = 0;
					for (const agent of agents) {
						const file = `${agentsDir}/${agent}.md`;
						try {
							const before = await host.fs.readText(file);
							const edit = setModelInFrontmatter(before, model || null);
							if (!edit.ok) {
								results.push({ agent, ok: false, changed: false, reason: edit.reason });
								continue;
							}
							let backup = null;
							if (edit.changed) {
								backup = `${BACKUP_DIR}/${agent}-${stamp}.md`;
								try {
									await host.fs.mkdir(BACKUP_DIR);
								} catch {
									/* already there */
								}
								await host.fs.write(backup, before);
								await host.fs.write(file, edit.text);
								host.log(`set ${agent} model -> ${model || "(inherit)"} (was ${edit.previous ?? "none"}); backup ${backup}`);
							}
							results.push({ agent, ok: true, model: model || null, previous: edit.previous, changed: edit.changed, reason: edit.reason, backup });
							if (edit.changed) applied++;
							else unchanged++;
						} catch (err) {
							results.push({ agent, ok: false, changed: false, reason: err?.message ?? String(err) });
						}
					}
					const failed = results.filter((r) => !r.ok).length;
					if (applied) {
						host.log(`bulk set-model: ${applied} updated, ${unchanged} unchanged, ${failed} failed (${agents.length} requested)`);
					}
					json(res, 200, {
						ok: true,
						model: model || null,
						summary: { requested: agents.length, applied, unchanged, failed },
						results,
						report: await state(true),
					});
				} catch (err) {
					json(res, 500, { ok: false, error: err?.message ?? String(err) });
				}
			}),
		);

		/**
		 * Restore the newest backup for one agent.
		 *
		 * The current content is snapshotted FIRST, so a restore is itself restorable and a
		 * second click steps back again rather than being a no-op. Only files this plugin
		 * wrote into its own backup directory are ever read as a source.
		 */
		cleanup.push(
			host.route("POST", "/restore", async (req, res) => {
				try {
					const body = req && typeof req.body === "object" && req.body !== null ? req.body : {};
					const agent = String(body.agent ?? "").trim();
					if (!/^[A-Za-z0-9._-]+$/.test(agent)) {
						return json(res, 400, { ok: false, error: `invalid agent name: ${JSON.stringify(agent)}` });
					}
					const { dir: agentsDir } = await resolveAgentsDir(host);
					let files = [];
					try {
						const entries = await host.fs.list(agentsDir);
						files = entries
							.filter((e) => e.type === "file" && e.name.endsWith(".md"))
							.map((e) => e.name)
							.filter((name) => !EXCLUDED_AGENTS.has(name.replace(/\.md$/, "")))
							.sort((a, b) => a.localeCompare(b));
					} catch {
						files = [];
					}
					if (!files.includes(`${agent}.md`)) {
						return json(res, 404, { ok: false, error: `unknown agent: ${agent}` });
					}

					let entries = [];
					try {
						entries = await host.fs.list(BACKUP_DIR);
					} catch {
						/* no backup dir yet */
					}
					// Names are <agent>-<ISO with ':' and '.' replaced by '-'>.md, so a plain
					// reverse sort is newest-first.
					const backups = entries
						.filter((e) => e.type === "file" && e.name.startsWith(`${agent}-`) && e.name.endsWith(".md"))
						.map((e) => e.name)
						.sort()
						.reverse();
					if (!backups.length) {
						return json(res, 404, { ok: false, error: `no backup exists for ${agent} - nothing to restore` });
					}

					const file = `${agentsDir}/${agent}.md`;
					const current = await host.fs.readText(file);
					const stamp = new Date().toISOString().replace(/[:.]/g, "-");
					const safety = `${BACKUP_DIR}/${agent}-${stamp}.md`;
					try {
						await host.fs.mkdir(BACKUP_DIR);
					} catch {
						/* already there */
					}
					await host.fs.write(safety, current);
					const restored = await host.fs.readText(`${BACKUP_DIR}/${backups[0]}`);
					await host.fs.write(file, restored);
					host.log(`restored ${agent} from ${backups[0]} (pre-restore state saved as ${safety})`);
					json(res, 200, { ok: true, agent, restoredFrom: backups[0], safety, report: await state(true) });
				} catch (err) {
					json(res, 500, { ok: false, error: err?.message ?? String(err) });
				}
			}),
		);

		/**
		 * GET /configs — full config list (with pins). The /state payload already
		 * ships a lightweight summary; this is for inspection and for the CLI.
		 */
		cleanup.push(
			host.route("GET", "/configs", async (_req, res) => {
				try {
					const configs = await readConfigs(host);
					json(res, 200, { ok: true, configs });
				} catch (err) {
					json(res, 500, { ok: false, error: err?.message ?? String(err) });
				}
			}),
		);

		/**
		 * POST /configs/save — snapshot every agent's current model pin under a name.
		 * The server reads the live state (not the client's cache), so the snapshot
		 * is always current regardless of when the client last polled.
		 */
		cleanup.push(
			host.route("POST", "/configs/save", async (req, res) => {
				try {
					const body = req && typeof req.body === "object" && req.body !== null ? req.body : {};
					const name = String(body.name ?? "").trim();
					const description = String(body.description ?? "").trim() || null;
					const editId = String(body.editId ?? "").trim() || null;
					if (!name || name.length > 80) {
						return json(res, 400, { ok: false, error: "name is required (max 80 chars)" });
					}

					const existing = await readConfigs(host);
					const now = new Date().toISOString();

					let config;
					if (editId) {
						// Editing an existing config: rename it AND re-capture the pins. Rename-only
						// silently dropped the models just chosen in the panel, so Edit + Update
						// looked like it saved nothing.
						const prev = existing.find((c) => c.id === editId);
						if (!prev) {
							return json(res, 404, { ok: false, error: "config not found: " + editId });
						}
						const report = await state(true);
						const pins = pinsFromReport(report);
						config = {
							...prev,
							id: editId,
							name,
							description,
							updatedAt: now,
							pins,
							agentCount: Object.keys(pins).length,
						};
						const updated = existing.filter((c) => c.id !== editId);
						updated.push(config);
						updated.sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1));
						await writeConfigs(host, updated);
						host.log("edited config: " + prev.name + " -> " + name + " (" + editId + ") - " + Object.keys(pins).length + " pins re-captured");
						// `report` was built BEFORE configs.json changed, so its configs list still
						// holds the pre-edit name. The client adopts report.configs for the dropdown
						// and the edit form, so re-read instead of shipping a stale roster.
						json(res, 200, { ok: true, config: configSummary(config), report: await state(true) });
					} else {
						// New config: capture current pins.
						const report = await state(true);
						const pins = pinsFromReport(report);
						const id = slugifyConfigId(name);
						config = {
							id,
							name,
							description,
							createdAt: existing.find((c) => c.id === id)?.createdAt ?? now,
							updatedAt: now,
							pins,
							agentCount: Object.keys(pins).length,
						};
						const updated = existing.filter((c) => c.id !== id);
						updated.push(config);
						updated.sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1));
						await writeConfigs(host, updated);
						host.log("saved config: " + name + " (" + id + ") - " + Object.keys(pins).length + " pins");
						json(res, 200, {
							ok: true,
							config: configSummary(config),
							report: await state(true),
						});
					}
				} catch (err) {
					json(res, 500, { ok: false, error: err?.message ?? String(err) });
				}
			}),
		);

		/**
		 * POST /configs/apply — batch-set every agent pin from a saved config.
		 *
		 * Each affected file is backed up first (same as the /set-model write path),
		 * so a mistaken apply is roll-back-able per-agent. Pins whose model is not
		 * in the live catalog are skipped and reported rather than failing the batch:
		 * a config saved with a key active may outlive that key's validity, and the
		 * user should still apply the pins that ARE still available.
		 */
		cleanup.push(
			host.route("POST", "/configs/apply", async (req, res) => {
				try {
					const body = req && typeof req.body === "object" && req.body !== null ? req.body : {};
					const id = String(body.id ?? "").trim();
					if (!id) {
						return json(res, 400, { ok: false, error: "config id is required" });
					}

					const configs = await readConfigs(host);
					const config = configs.find((c) => c.id === id);
					if (!config) {
						return json(res, 404, { ok: false, error: `config not found: ${id}` });
					}

					const catalog = await readCatalog(host);
					const { dir: agentsDir } = await resolveAgentsDir(host);
					let files = [];
					try {
						const entries = await host.fs.list(agentsDir);
						files = entries
							.filter((e) => e.type === "file" && e.name.endsWith(".md"))
							.map((e) => e.name)
							.filter((name) => !EXCLUDED_AGENTS.has(name.replace(/\.md$/, "")))
							.sort((a, b) => a.localeCompare(b));
					} catch {
						files = [];
					}
					const stamp = new Date().toISOString().replace(/[:.]/g, "-");

					const applied = [];
					const skipped = [];
					const invalid = [];

					for (const [agent, model] of Object.entries(config.pins ?? {})) {
						// Safety: same validation as /set-model.
						if (!/^[A-Za-z0-9._-]+$/.test(agent)) {
							skipped.push({ agent, model, reason: "invalid agent name" });
							continue;
						}
						if (!files.includes(`${agent}.md`)) {
							skipped.push({ agent, model, reason: "agent file no longer exists" });
							continue;
						}
						if (model && model !== "" && !catalog.ids.has(model)) {
							invalid.push({ agent, model, reason: "model not in live catalog" });
							continue;
						}

						const file = `${agentsDir}/${agent}.md`;
						const before = await host.fs.readText(file);
						const edit = setModelInFrontmatter(before, model || null);
						if (!edit.ok || !edit.changed) continue;

						try {
							await host.fs.mkdir(BACKUP_DIR);
						} catch {
							/* already there */
						}
						const backup = `${BACKUP_DIR}/config-apply-${config.id}-${agent}-${stamp}.md`;
						await host.fs.write(backup, before);
						await host.fs.write(file, edit.text);
						applied.push({ agent, model: model || null, previous: edit.previous, backup });
					}

					if (applied.length) {
						host.log(
							`applied config "${config.name}": ${applied.length} updated, ${invalid.length} skipped (invalid), ${skipped.length} skipped (missing)`,
						);
					}
					json(res, 200, {
						ok: true,
						id,
						name: config.name,
						summary: { applied: applied.length, invalid: invalid.length, skipped: skipped.length, invalidList: invalid, skippedList: skipped },
						report: await state(true),
					});
				} catch (err) {
					json(res, 500, { ok: false, error: err?.message ?? String(err) });
				}
			}),
		);

		/** POST /configs/delete — remove a saved configuration. */
		cleanup.push(
			host.route("POST", "/configs/delete", async (req, res) => {
				try {
					const body = req && typeof req.body === "object" && req.body !== null ? req.body : {};
					const id = String(body.id ?? "").trim();
					if (!id) {
						return json(res, 400, { ok: false, error: "config id is required" });
					}
					const configs = await readConfigs(host);
					const remaining = configs.filter((c) => c.id !== id);
					if (remaining.length === configs.length) {
						return json(res, 404, { ok: false, error: `config not found: ${id}` });
					}
					await writeConfigs(host, remaining);
					host.log(`deleted config ${id}`);
					json(res, 200, { ok: true, deleted: id, configs: remaining.map(configSummary) });
				} catch (err) {
					json(res, 500, { ok: false, error: err?.message ?? String(err) });
				}
			}),
		);

		/** Slash command: the same table in chat, so the panel is not the only way in. */
		cleanup.push(
			host.registerCommand({
				name: "agent-models",
				description: "Show each .pi/agents/*.md model pin and whether it actually resolves",
				descriptionEn: "Show each .pi/agents/*.md model pin and whether it actually resolves",
				async run() {
					try {
						return formatReportTable(await state(true));
					} catch (err) {
						return `agent-models failed: ${err?.message ?? err}`;
					}
				},
			}),
		);

		/**
		 * Chat-bar button, right of the thinking dropdown. Host composer items sort by
		 * (order, seq): model chip is 120, thinking 130, dsh-perm 140 — order 135 lands
		 * between thinking and dsh-perm. kind:"view" makes the stock client's onUiAction
		 * navigate to `view` on click (no client handler needed); the icon must be an
		 * emoji because the stock composer renderer maps only mic/camera to real SVG.
		 */
		cleanup.push(
			host.ui.register({
				slot: "composer.actions",
				id: "open-page",
				label: "Agent Models",
				hint: "Open the Agent Models page",
				kind: "view",
				view: "plugin:agent-models",
				// No emoji icon: the client entry paints a glyph from the HOST icon set
				// through a CSS mask on ::before (the host composer renderer only maps
				// mic/camera to SVG, so a plugin cannot request a real glyph here).
				// The label stays as aria-label/title.
				order: 135,
				align: "start",
			}),
		);

		// The workspace may not be readable at boot; every attach is a chance to
		// re-collect, and a dropped-in agent file shows up without a restart.
		cleanup.push(
			host.onAttach(() => {
				void state(true).catch((err) => host.log("warn", `state refresh failed: ${err?.message ?? err}`));
			}),
		);
		cleanup.push(
			host.onCwdChange(() => {
				void state(true).catch(() => {});
			}),
		);

		const first = await state(true);
		host.log(
			`activated - ${first.counts.total} agents, ${first.counts.problems} needing attention, catalog ${catalogSize} models`,
		);

		return () => {
			for (const off of cleanup) {
				try {
					off?.();
				} catch {
					/* ignore */
				}
			}
		};
	},
});
