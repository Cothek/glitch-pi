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

import { definePlugin, selectOptions } from "./sdk/index.mjs";

const PROFILES_DIR = ".pi/agent-profiles";
const MODE_FILE = "user/agent-mode.json";
const ITEM_ID = "agent-mode";
const ACTION = "agent-switcher:switch";

/** Pull `description:` out of a profile's frontmatter head (first ~2KB). */
function parseDescription(head) {
	if (!head.startsWith("---")) return undefined;
	const end = head.indexOf("\n---", 3);
	if (end === -1) return undefined;
	const m = head.slice(3, end).match(/^description:\s*(.+)$/m);
	return m ? m[1].trim() : undefined;
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
		let description;
		try {
			const head = await host.fs.readText(`${PROFILES_DIR}/${entry.name}`, 2048);
			description = parseDescription(head);
		} catch {
			/* no frontmatter — id-only label */
		}
		modes.push({ id: entry.name.replace(/\.md$/, ""), description });
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

/** Read a JSON body off a raw Node request (plugin routes get req/res as-is). */
function readBody(req) {
	return new Promise((resolve, reject) => {
		let data = "";
		req.on("data", (chunk) => {
			data += chunk;
			if (data.length > 8192) reject(new Error("body too large"));
		});
		req.on("end", () => {
			try {
				resolve(data ? JSON.parse(data) : {});
			} catch (err) {
				reject(err);
			}
		});
		req.on("error", reject);
	});
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

		/** (Re)discover modes + current marker, then (re)register the select. */
		async function sync() {
			modes = await readModes(host);
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
			unregisterUi = host.ui.register({
				slot: "composer.actions",
				id: ITEM_ID,
				label: "Agent",
				kind: "select",
				action: ACTION,
				hint: "Switch the primary agent mode",
				value: modes.some((m) => m.id === current) ? current : modes[0].id,
				options: selectOptions(
					modes.map((m) => ({
						value: m.id,
						label: m.description ? `${m.id} — ${m.description}` : m.id,
					})),
				),
			});
		}

		/** Deliver the switch command to the active conversation. */
		async function switchMode(mode) {
			if (!mode || !modes.some((m) => m.id === mode)) {
				host.log("warn", `switch rejected: unknown mode "${mode}" (available: ${modes.map((m) => m.id).join(", ") || "none"})`);
				return { ok: false, error: `unknown mode "${mode}" (available: ${modes.map((m) => m.id).join(", ") || "none"})` };
			}
			const conv = typeof host.getActiveConversation === "function" ? host.getActiveConversation() : null;
			const convId = conv?.conversationId;
			if (!convId) {
				host.log("warn", "switch rejected: no active conversation");
				return { ok: false, error: "no active conversation — open a chat first" };
			}
			const res = await host.prompt(convId, { text: `/agent ${mode}` });
			if (res?.ok) {
				current = mode;
				try {
					host.ui.update(ITEM_ID, { value: mode });
				} catch {
					/* UI item may be gone after a reload */
				}
				host.notify("info", `Agent switched to ${mode}`, `Agent switched to ${mode}`);
				return { ok: true, mode };
			}
			return {
				ok: false,
				error: res?.error ?? "prompt delivery failed (agent may be streaming — try again when idle)",
			};
		}

			// Tab panel messages (ctx.send path)
		cleanup.push(
			host.onMessage(async (payload) => {
				if (payload?.action === "switch" && typeof payload?.value === "string") {
					const result = await switchMode(payload.value.trim());
					if (!result.ok) host.notify("error", `agent-switcher: ${result.error}`, `agent-switcher: ${result.error}`);
				}
			}),
		);

		// HTTP routes — the composer select posts here (no mount dependency)
		cleanup.push(
			host.route("POST", "/switch", async (req, res) => {
				try {
					const body = await readBody(req);
					const result = await switchMode(String(body?.mode ?? "").trim());
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
						try {
							host.ui.update(ITEM_ID, { value: marker });
						} catch {
							/* ignore */
						}
					}
				})();
			}),
		);
		cleanup.push(host.onCwdChange(() => void sync()));

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
