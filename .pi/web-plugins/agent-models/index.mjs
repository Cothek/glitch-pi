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
 * WHY NOTHING ELSE IS READ: user-scope agents (~/.pi/agent/agents) live outside
 * the workspace and would need an access grant; phase 1 covers the project
 * roster and says so instead of silently omitting them.
 *
 * SURFACES
 *   0. composer button (chat bar, right of the thinking chip) -> opens the page
 *      via kind:"view": the stock client navigates to view:"plugin:agent-models"
 *      on click, so no client handler is involved.
 *   1. right-panel tab (manifest "view": true) -> client fetches GET /state
 *   2. GET  /plugins-api/agent-models/state     -> JSON report (catalog, models, facets)
 *   3. POST /plugins-api/agent-models/set-model -> rewrite one agent's model pin
 *   4. POST /plugins-api/agent-models/restore   -> restore an agent's newest backup
 *   5. /agent-models slash command -> same table as text, no browser needed
 *
 * WRITE PATH SAFETY (POST /set-model): the agent name is validated against the
 * files actually discovered in .pi/agents (never interpolated blindly), the
 * requested model must exist in the live catalog or be an explicit "inherit",
 * the file is backed up before the first byte changes, and the edit itself only
 * rewrites the `model:` line so comments and key order survive untouched.
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
/** Backups live INSIDE the workspace on purpose: cross-directory writes would
 *  need a separate user directory grant, workspace writes do not. */
const BACKUP_DIR = ".pi/agent-models/backups";
/** Price table written by scripts/agent-model-costs.mjs. Also workspace-relative,
 *  for the same reason: the real prices live in <agent-dir>/models*.json, which a
 *  plugin may not read without a directory grant. */
const COSTS_PATH = ".pi/agent-models/costs.json";
/** Report cache: cheap to rebuild, but /state is polled by the tab. */
const STATE_TTL_MS = 5000;

async function listAgentFiles(host) {
	try {
		const entries = await host.fs.list(AGENTS_DIR);
		return entries
			.filter((e) => e.type === "file" && e.name.endsWith(".md"))
			.map((e) => e.name)
			.sort((a, b) => a.localeCompare(b));
	} catch {
		return [];
	}
}

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

export default definePlugin({
	async activate(host) {
		const cleanup = [];
		let cache = null;
		let cacheAt = 0;
		let catalogSize = 0;

		/** Collect + classify. Always rebuilds from disk; the caller decides about caching. */
		async function collect() {
			const files = await listAgentFiles(host);
			const catalog = await readCatalog(host);
			catalogSize = catalog.ids.size;
			const priceData = await readCosts(host);
			const backupCounts = await countBackups(host);
			const agents = [];
			const unreadable = [];
			for (const name of files) {
				try {
					agents.push(parseAgentFile(await host.fs.readText(`${AGENTS_DIR}/${name}`), name));
				} catch {
					unreadable.push(name);
				}
			}
			const report = buildReport(
				agents,
				catalog.ids,
				`host.models.list() - ${catalog.ids.size} authenticated model${catalog.ids.size === 1 ? "" : "s"}`,
			);
			report.agentsDir = AGENTS_DIR;
			report.unreadable = unreadable;
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
					const files = await listAgentFiles(host);
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

					const file = `${AGENTS_DIR}/${agent}.md`;
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
					const files = await listAgentFiles(host);
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

					const file = `${AGENTS_DIR}/${agent}.md`;
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
