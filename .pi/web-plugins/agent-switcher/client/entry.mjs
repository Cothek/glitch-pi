/**
 * agent-switcher — pi-web-ui plugin (client entry)
 *
 * The composer control is styled to MATCH the native thinking chip:
 *   - the registered kind:"action" button (rendered by the host as
 *     button.composer-plugin-action) is restyled via injected CSS to the exact
 *     .chip surface (border/bg/radius/height/hover) with chip-sub text and a
 *     dd-caret chevron;
 *   - clicking it opens OUR OWN dropdown, a clone of the host dd-menu
 *     (dd-header + dd-item rows, active state, same shadows/radii) — the
 *     native <select> menu could not be styled, which is why the item is an
 *     action button and not kind:"select".
 *
 * Registration happens at module top level with a short poll for the host
 * bridge (the module import is guaranteed by the plugin loader; the tab view
 * is optional and must never be a dependency).
 */

import { defineView, onUiAction } from "../sdk/index.mjs";

const ACTION_MENU = "agent-switcher:menu";
const API_BASE = "/plugins-api/agent-switcher";
const BUTTON_SELECTOR = 'button.composer-plugin-action[aria-label^="Agent:"]';
const OPEN_BODY_CLASS = "agent-switcher-menu-open";

// ---------------------------------------------------------------------------
// Injected styles — clones of the host's .chip / .dd-menu / .dd-header /
// .dd-item rules (extracted from the pi-web-ui stylesheet), scoped so they
// only touch this plugin's button and menu.
// ---------------------------------------------------------------------------
{
	const style = document.createElement("style");
	style.id = "agent-switcher-style";
	style.textContent = `
/* Composer button → thinking-chip look (host .chip rules, scoped) */
button.composer-plugin-action[aria-label^="Agent:"] {
	-webkit-user-select: none;
	user-select: none;
	-webkit-touch-callout: none;
	height: 28px;
	border: 1px solid var(--border);
	background: var(--chip-bg, var(--bg-elev2));
	color: var(--text);
	cursor: pointer;
	white-space: nowrap;
	border-radius: 8px;
	align-items: center;
	gap: 4px;
	padding: 3px 8px;
	font-size: 12px;
	transition: border-color .15s, background .15s;
	display: inline-flex;
	min-width: 0;
	overflow: hidden;
	text-overflow: ellipsis;
}
button.composer-plugin-action[aria-label^="Agent:"]:hover {
	border-color: var(--accent);
	background: var(--accent-soft);
}
/* chip-sub text treatment (the thinking chip's label is faint 11px) */
button.composer-plugin-action[aria-label^="Agent:"] {
	color: var(--text-faint);
	font-size: 11px;
}
/* dd-caret clone */
button.composer-plugin-action[aria-label^="Agent:"]::after {
	content: "\\25BE";
	color: var(--text-faint);
	margin-left: 3px;
	transition: transform .15s;
	font-size: 10px;
	line-height: 1;
}
body.${OPEN_BODY_CLASS} button.composer-plugin-action[aria-label^="Agent:"]::after {
	transform: rotate(180deg);
}

/* Dropdown menu → host dd-menu clone (fixed-position variant) */
.agent-switcher-menu {
	background: var(--menu-bg, var(--bg-elev2));
	border: 1px solid var(--border);
	z-index: 60;
	border-radius: 10px;
	min-width: 340px;
	max-width: 480px;
	max-height: min(360px, 100vh - 240px);
	padding: 6px;
	position: fixed;
	overflow-y: auto;
	box-shadow: 0 12px 40px #00000080;
}
.agent-switcher-menu-header {
	letter-spacing: .6px;
	text-transform: uppercase;
	color: var(--text-faint);
	padding: 6px 10px 4px;
	font-size: 11px;
	font-weight: 700;
}
.agent-switcher-menu-item {
	width: 100%;
	color: var(--text-dim);
	text-align: left;
	cursor: pointer;
	background: 0 0;
	border: none;
	border-radius: 7px;
	justify-content: space-between;
	align-items: center;
	gap: 10px;
	padding: 7px 10px;
	font-size: 13px;
	display: flex;
}
.agent-switcher-menu-item:hover {
	background: var(--bg-elev);
	color: var(--text);
}
.agent-switcher-menu-item.active {
	background: var(--accent-soft);
	color: var(--text);
}
.agent-switcher-menu-note {
	color: var(--text-faint);
	padding: 6px 10px 4px;
	font-size: 11px;
}
`;
	document.head.appendChild(style);
}

// ---------------------------------------------------------------------------
// Dropdown menu
// ---------------------------------------------------------------------------
let openMenu = null; // { root, close }

function closeMenu() {
	if (!openMenu) return;
	openMenu.close();
}

function openMenuNearButton(button) {
	if (openMenu) {
		closeMenu();
		return; // second click on the chip toggles closed
	}

	const root = document.createElement("div");
	root.className = "agent-switcher-menu";
	root.setAttribute("role", "menu");
	document.body.appendChild(root);

	const close = () => {
		document.removeEventListener("mousedown", onOutside, true);
		document.removeEventListener("keydown", onKeydown, true);
		window.removeEventListener("resize", close);
		window.removeEventListener("scroll", close, true);
		document.body.classList.remove(OPEN_BODY_CLASS);
		root.remove();
		if (openMenu && openMenu.root === root) openMenu = null;
	};

	const onOutside = (event) => {
		if (!root.contains(event.target) && event.target !== button && !button.contains(event.target)) close();
	};
	const onKeydown = (event) => {
		if (event.key === "Escape") {
			event.stopPropagation();
			close();
		}
	};
	document.addEventListener("mousedown", onOutside, true);
	document.addEventListener("keydown", onKeydown, true);
	window.addEventListener("resize", close);
	window.addEventListener("scroll", close, true);

	// dd-up: open above the button, left-aligned like the thinking menu
	const rect = button.getBoundingClientRect();
	root.style.left = `${Math.max(8, rect.left)}px`;
	root.style.bottom = `${window.innerHeight - rect.top + 6}px`;
	document.body.classList.add(OPEN_BODY_CLASS);

	const render = async () => {
		const state = await fetchState();
		root.textContent = "";
		if (!state || !state.modes?.length) {
			const empty = document.createElement("div");
			empty.className = "agent-switcher-menu-note";
			empty.textContent = "No agent profiles found in this workspace (.pi/agent-profiles/*.md).";
			root.appendChild(empty);
			return;
		}
		const header = document.createElement("div");
		header.className = "agent-switcher-menu-header";
		header.textContent = "Agent mode";
		root.appendChild(header);

		for (const mode of state.modes) {
			const item = document.createElement("button");
			item.type = "button";
			item.className = `agent-switcher-menu-item${mode.id === state.current ? " active" : ""}`;
			item.setAttribute("role", "menuitem");
			item.textContent = mode.id; // terse: bare mode ids (Troy's preference)
			item.addEventListener("click", async () => {
				const result = await requestSwitch(mode.id);
				close();
				if (!result?.ok) {
					const note = document.createElement("div");
					note.className = "agent-switcher-menu-note";
					note.textContent = `Switch failed: ${result?.error ?? "unknown error"}`;
					note.style.color = "var(--red)";
					document.body.appendChild(note);
					setTimeout(() => note.remove(), 4000);
				}
			});
			root.appendChild(item);
		}

		const hint = document.createElement("div");
		hint.className = "agent-switcher-menu-note";
		hint.textContent = "Also: /agent <mode> in the chat box, or just ask.";
		root.appendChild(hint);
	};

	openMenu = { root, close };
	void render();
}

// --- Bridge registration (module scope, no mount dependency) ----------------
{
	let tries = 0;
	const tryRegister = () => {
		const bridge = globalThis.window?.__piWebUiHost;
		if (bridge && typeof bridge.onUiAction === "function") {
			bridge.onUiAction(ACTION_MENU, (_itemId, _value) => {
				const button = document.querySelector(BUTTON_SELECTOR);
				if (button) openMenuNearButton(button);
			});
		} else if (tries++ < 50) {
			setTimeout(tryRegister, 200); // bridge not ready yet — retry up to 10s
		}
	};
	tryRegister();
}

// ---------------------------------------------------------------------------
// HTTP helpers (same routes as the tab panel)
// ---------------------------------------------------------------------------
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

// ---------------------------------------------------------------------------
// Agent tab panel (optional surface — same HTTP routes)
// ---------------------------------------------------------------------------
async function fetchStateForPanel() {
	return fetchState();
}

export default defineView({
	mount(container) {
		const root = document.createElement("div");
		root.style.padding = "16px";
		root.style.font = "13px/1.5 system-ui, sans-serif";
		container.appendChild(root);

		let timer = null;

		const render = async () => {
			const state = await fetchStateForPanel();
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
				btn.style.borderRadius = "7px";
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
						note.style.color = "var(--red, #e06c75)";
						root.appendChild(note);
					}
					await render();
				});
				list.appendChild(btn);
			}
			root.appendChild(list);

			const hint = document.createElement("div");
			hint.textContent =
				"Also: the Agent chip next to the chat input, /agent <mode> in the chat box, or just ask the agent to switch.";
			hint.style.marginTop = "12px";
			hint.style.color = "var(--text-dim, #888)";
			root.style.color = "var(--text)";
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
