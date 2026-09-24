/**
 * agent-switcher — pi-web-ui plugin (server entry)
 *
 * Switches the primary Glitch agent from the web UI. Surfaces:
 *   1. A "select" next to the composer (composer.actions slot) with one
 *      option per profile in .pi/agent-profiles/*.md.
 *   2. An "Agent" top-bar tab: current mode + clickable mode list.
 *   3. /agent <mode> also works directly in the chat box (pi extension
 *      command, listed in the slash picker).
 *
 * MECHANICS: a switch sends "/agent <mode>" into the ACTIVE conversation via
 * host.prompt() → the pi extension (glitch-pi/.pi/extensions/agent-switcher.ts)
 * executes the command: swaps the system prompt mid-session, updates
 * user/agent-mode.json, stages .pi/SYSTEM.md, records session state.
 * This plugin only reads workspace files (modes + current mode marker) and
 * delivers the command — the pi extension owns the actual switch.
 *
 * ROUTES (deterministic client→server path, no view-mount dependency):
 *   POST /plugins-api/agent-switcher/switch  { mode }  → switch in active conv
 *   GET  /plugins-api/agent-switcher/state           → { modes, current }
 *
 * SYNC: re-reads user/agent-mode.json on conversation change (switches made
 * via /agent, the TUI shortcut, or another conversation reflect in the select)
 * and re-discovers profiles on workspace/cwd change.
 */

import { definePlugin } from "./sdk/index.mjs";

const PROFILES_DIR = ".pi/agent-profiles";
const MODE_FILE = "user/agent-mode.json";
const ITEM_ID = "agent-mode";
/** Composer button action — the client opens a dd-menu clone styled like the thinking chip. */
const ACTION_MENU = "agent-switcher:menu";
/** Tab panel message action. */
const ACTION_SWITCH = "agent-switcher:switch";

/** Split a profile into { description (frontmatter), body (prompt text) }. */
function parseProfile(raw) {
	const text = stripBom(raw);
	if (!text.startsWith("---")) return { description: undefined, body: text.trim() };
	const end = text.indexOf("\n---", 3);
	if (end === -1) return { description: undefined, body: text.trim() };
	const header = text.slice(3, end);
	const m = header.match(/^description:\s*(.+)$/m);
	const body = text.slice(text.indexOf("\n", end + 1) + 1).trim();
	return { description: m ? m[1].trim() : undefined, body };
}

/** Strip a possible UTF-8 BOM (PowerShell-written markers). */
function stripBom(text) {
	const s = String(text);
	return s.charCodeAt(0) === 0xfeff ? s.slice(1) : s;
}

async function readModes(host) {
	let entries = [];
	try {
		entries = await host.fs.list(PROFILES_DIR);
	} catch {
		return [];
	}
	const modes = [];
	for (const entry of entries) {
		if (entry.type !== "file" || !entry.name.endsWith(".md")) continue;
		// Full read: the body is needed to stage .pi/SYSTEM.md on a switch.
		let description;
		let body;
		try {
			const parsed = parseProfile(await host.fs.readText(`${PROFILES_DIR}/${entry.name}`));
			description = parsed.description;
			body = parsed.body;
		} catch {
			/* unreadable profile — id-only label */
		}
		modes.push({ id: entry.name.replace(/\.md$/, ""), description, body });
	}
	modes.sort((a, b) => a.id.localeCompare(b.id));
	return modes;
}

async function readCurrent(host) {
	try {
		const raw = JSON.parse(stripBom(await host.fs.readText(MODE_FILE, 512)));
		return typeof raw?.mode === "string" && raw.mode ? raw.mode : null;
	} catch {
		return null;
	}
}

/**
 * Read the request payload. The host mounts plugin routes behind express.json(),
 * so the body is ALREADY parsed and the stream is consumed — reading it with
 * req.on('data')/('end') hangs forever (the host's mount point even warns about
 * this). Use req.body, with a query-string fallback for callers that cannot
 * send a JSON body.
 */
function readPayload(req) {
	const body = req && typeof req.body === "object" && req.body !== null ? req.body : {};
	let fromQuery = "";
	try {
		fromQuery = new URL(String(req?.url ?? "/"), "http://localhost").searchParams.get("mode") ?? "";
	} catch {
		fromQuery = "";
	}
	return { mode: String(body.mode ?? fromQuery ?? "").trim() };
}

function json(res, status, payload) {
	const body = JSON.stringify(payload);
	res.writeHead(status, { "Content-Type": "application/json" });
	res.end(body);
}

export default definePlugin({
	async activate(host) {
		let modes = [];
		let current = null;
		let unregisterUi = null;
		const cleanup = [];
		const profilesById = new Map();

		/** (Re)discover modes + current marker, then (re)register the composer chip. */
		async function sync() {
			modes = await readModes(host);
			profilesById.clear();
			for (const m of modes) profilesById.set(m.id, m);
			current = await readCurrent(host);
			if (unregisterUi) {
				try {
					unregisterUi();
				} catch {
					/* already gone */
				}
				unregisterUi = null;
			}
			if (!modes.length) {
				host.log("no .pi/agent-profiles/*.md in this workspace — select hidden");
				return;
			}
			// kind "action": a composer button. The client bundle restyles it like the
			// native thinking chip and opens a dd-menu clone on click. (kind "select"
			// renders a native <select> whose OS menu can't be styled to match.)
			unregisterUi = host.ui.register({
				slot: "composer.actions",
				id: ITEM_ID,
				label: current && modes.some((m) => m.id === current) ? `Agent: ${current}` : `Agent: ${modes[0].id}`,
				kind: "action",
				action: ACTION_MENU,
				hint: "Switch the primary agent mode",
			});
		}

		/** Keep the composer button label in sync with the marker. */
		function syncLabel(mode) {
			try {
				host.ui.update(ITEM_ID, { label: `Agent: ${mode}` });
			} catch {
				/* UI item may be gone after a reload */
			}
		}

		/**
		 * Switch the mode by writing the marker (user/agent-mode.json) and staging
		 * .pi/SYSTEM.md. The pi extension (glitch-pi/.pi/extensions/agent-switcher.ts)
		 * reconciles from the marker at the start of the next turn, so this needs no
		 * conversation id — host.prompt()/getActiveConversation() proved ambiguous
		 * with several attached clients ("unknown conversation: c1").
		 */
		async function switchMode(mode) {
			if (!mode || !modes.some((m) => m.id === mode)) {
				host.log("warn", `switch rejected: unknown mode "${mode}" (available: ${modes.map((m) => m.id).join(", ") || "none"})`);
				return { ok: false, error: `unknown mode "${mode}" (available: ${modes.map((m) => m.id).join(", ") || "none"})` };
			}
			try {
				const previous = current;
				await host.fs.write(
					MODE_FILE,
					JSON.stringify(
						{
							mode,
							...(previous && previous !== mode ? { previous_mode: previous } : {}),
							switched_at: new Date().toISOString(),
							via: "pi-web-ui-plugin:/agents",
							note: "pi extension agent-switcher.ts reconciles from this marker each turn.",
						},
						null,
						2,
					),
				);
				// Stage the profile so a restart lands in the same mode (body only).
				const profile = profilesById.get(mode);
				if (profile?.body) {
					await host.fs.write(".pi/SYSTEM.md", profile.body);
				}
				current = mode;
				syncLabel(mode);
				host.notify("info", `Agent switched to ${mode}`, `Agent switched to ${mode}`);
				return { ok: true, mode };
			} catch (err) {
				const message = err?.message ?? String(err);
				host.log("error", `switch failed: ${message}`);
				return { ok: false, error: message };
			}
		}

			// Tab panel messages (ctx.send path)
		cleanup.push(
			host.onMessage(async (payload) => {
				if ((payload?.action === ACTION_SWITCH || payload?.action === "switch") && typeof payload?.value === "string") {
					const result = await switchMode(payload.value.trim());
					if (!result.ok) host.notify("error", `agent-switcher: ${result.error}`, `agent-switcher: ${result.error}`);
				}
			}),
		);

		// HTTP routes — the composer select posts here (no mount dependency)
		cleanup.push(
			host.route("POST", "/switch", async (req, res) => {
				try {
					const payload = readPayload(req);
					const result = await switchMode(payload.mode);
					json(res, result.ok ? 200 : 400, result);
				} catch (err) {
					json(res, 500, { ok: false, error: err?.message ?? String(err) });
				}
			}),
		);
		cleanup.push(
			host.route("GET", "/state", async (_req, res) => {
				try {
					json(res, 200, { modes, current: await readCurrent(host) });
				} catch (err) {
					json(res, 500, { ok: false, error: err?.message ?? String(err) });
				}
			}),
		);

		// Keep the select in sync with switches made elsewhere
		// (/agent typed, TUI Ctrl+Shift+A, another conversation)
		cleanup.push(
			host.onConversationChanged(() => {
				void (async () => {
					const marker = await readCurrent(host);
					if (marker && marker !== current) {
						current = marker;
						syncLabel(marker);
					}
				})();
			}),
		);
		cleanup.push(host.onCwdChange(() => void sync()));

		// Slash-picker fallback that needs NO client bundle: /agents [mode]
		// (runs server-side, so it works even if the browser bundle misbehaves).
		cleanup.push(
			host.registerCommand({
				name: "agents",
				description: "Switch the primary agent mode (glitch | glitch-omni | glitch-lightweight)",
				argumentHint: "<mode>",
				async run(args) {
					const mode = String(args ?? "").trim();
					if (!mode) {
						const marker = await readCurrent(host);
						return `Agent modes: ${modes.map((m) => m.id).join(", ") || "(none)"}. Current: ${marker ?? "unknown"}. Usage: /agents <mode>`;
					}
					const result = await switchMode(mode);
					return result.ok ? `Agent switched to ${mode}` : `Switch failed: ${result.error}`;
				},
			}),
		);

		await sync();
		host.log("activated — modes:", modes.map((m) => m.id).join(", ") || "(none)");

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
