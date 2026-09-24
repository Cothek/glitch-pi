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
 *   1. right-panel tab (manifest "view": true) -> client fetches GET /state
 *   2. GET /plugins-api/agent-models/state -> JSON report
 *   3. /agent-models slash command -> same table as text, no browser needed
 *
 * READ-ONLY BY CONSTRUCTION: the manifest does not request fs:write, so this
 * plugin cannot modify an agent file even by accident.
 */

import { definePlugin } from "./sdk/index.mjs";
import { buildReport, formatReportTable, parseAgentFile } from "./resolver.mjs";

const AGENTS_DIR = ".pi/agents";
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
		for (const m of listed ?? []) {
			if (typeof m?.id === "string" && m.id) ids.add(m.id);
		}
		return ids;
	} catch {
		return new Set();
	}
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
			catalogSize = catalog.size;
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
				catalog,
				`host.models.list() - ${catalog.size} authenticated model${catalog.size === 1 ? "" : "s"}`,
			);
			report.agentsDir = AGENTS_DIR;
			report.unreadable = unreadable;
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
