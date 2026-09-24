/**
 * agent-switcher — pi-web-ui plugin (client entry)
 *
 * Two jobs:
 *   1. Bridge the composer "Agent" select to the server. The host fires the
 *      select's action here via window.__piWebUiHost.onUiAction; we POST the
 *      choice to the plugin's own HTTP route (/plugins-api/agent-switcher/switch)
 *      so switching works even if the Agent tab has never been opened.
 *      Registration happens at module top level with a short poll for the host
 *      bridge — the module import itself is guaranteed by the plugin loader.
 *   2. Render the "Agent" tab panel: current mode + clickable mode list.
 *      Same HTTP routes; refreshes on a light interval and after each switch.
 */

import { defineView, onUiAction } from "../sdk/index.mjs";

const ACTION = "agent-switcher:switch";
const API_BASE = "/plugins-api/agent-switcher";

// --- Composer select bridge (module scope, no mount dependency) ------------
{
	let tries = 0;
	const tryRegister = () => {
		const bridge = globalThis.window?.__piWebUiHost;
		if (bridge && typeof bridge.onUiAction === "function") {
			bridge.onUiAction(ACTION, (_itemId, value) => {
				if (typeof value === "string" && value) {
					void fetch(`${API_BASE}/switch`, {
						method: "POST",
						headers: { "Content-Type": "application/json" },
						body: JSON.stringify({ mode: value }),
					});
				}
			});
		} else if (tries++ < 50) {
			setTimeout(tryRegister, 200); // bridge not ready yet — retry up to 10s
		}
	};
	tryRegister();
}

// --- Agent tab panel ----------------------------------------------------------
async function fetchState() {
	try {
		const res = await fetch(`${API_BASE}/state`);
		if (!res.ok) return null;
		return await res.json();
	} catch {
		return null;
	}
}

async function requestSwitch(mode) {
	try {
		const res = await fetch(`${API_BASE}/switch`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ mode }),
		});
		return await res.json();
	} catch {
		return { ok: false, error: "network error" };
	}
}

export default defineView({
	mount(container, ctx) {
		const root = document.createElement("div");
		root.style.padding = "16px";
		root.style.font = "13px/1.5 system-ui, sans-serif";
		container.appendChild(root);

		let timer = null;

		const render = async () => {
			const state = await fetchState();
			root.textContent = "";
			if (!state) {
				root.textContent = "Agent Switcher: state unavailable (no active server route?)";
				return;
			}
			const title = document.createElement("div");
			title.textContent = `Current agent: ${state.current ?? "(unknown)"}`;
			title.style.marginBottom = "10px";
			title.style.fontWeight = "600";
			root.appendChild(title);

			if (!state.modes?.length) {
				const none = document.createElement("div");
				none.textContent = "No .pi/agent-profiles/*.md found in this workspace.";
				none.style.color = "var(--text-dim, #888)";
				root.appendChild(none);
				return;
			}

			const list = document.createElement("div");
			list.style.display = "grid";
			list.style.gap = "6px";
			for (const mode of state.modes) {
				const btn = document.createElement("button");
				btn.type = "button";
				const active = mode.id === state.current;
				btn.textContent = mode.description ? `${mode.id} — ${mode.description}` : mode.id;
				btn.style.textAlign = "left";
				btn.style.padding = "8px 10px";
				btn.style.borderRadius = "6px";
				btn.style.border = active ? "1px solid var(--accent, #4a9eff)" : "1px solid var(--border, #333)";
				btn.style.background = "transparent";
				btn.style.color = "inherit";
				btn.style.cursor = "pointer";
				if (active) btn.style.fontWeight = "600";
				btn.addEventListener("click", async () => {
					btn.disabled = true;
					const result = await requestSwitch(mode.id);
					btn.disabled = false;
					if (!result.ok) {
						const note = document.createElement("div");
						note.textContent = `Switch failed: ${result.error ?? "unknown error"}`;
						note.style.color = "var(--error, #e06c75)";
						root.appendChild(note);
					}
					await render();
				});
				list.appendChild(btn);
			}
			root.appendChild(list);

			const hint = document.createElement("div");
			hint.textContent = "Also: the select next to the chat input, /agent <mode> in the chat box, or just ask the agent to switch.";
			hint.style.marginTop = "12px";
			hint.style.color = "var(--text-dim, #888)";
			root.appendChild(hint);
		};

		void render();
		timer = setInterval(() => void render(), 5000);

		return () => {
			if (timer) clearInterval(timer);
			root.remove();
		};
	},
});
