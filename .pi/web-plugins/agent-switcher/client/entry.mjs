/**
 * agent-switcher — pi-web-ui plugin (client entry) — SELF-CONTAINED, ZERO IMPORTS
 *
 * Why no imports: the host serves plugin files only from
 * /plugins/<id>/client/*. A relative import of a sibling SDK directory gets
 * URL-normalized into /plugins/<id>/sdk/… , misses that route, falls into the
 * SPA fallback and comes back as text/html — and a module graph rejects
 * non-JS, killing the ENTIRE entry module (no CSS, no handlers, "plugin does
 * not handle this action"). Keeping this file dependency-free removes that
 * whole failure class; the two SDK helpers it used are inlined below.
 *
 * Action names: the host dispatcher looks up registry keys
 * `<pluginId>:<action>` then `<action>` for the exact action string the ITEM
 * carries. The server item uses "agent-switcher:menu". We register BOTH
 * "agent-switcher:menu" (chip click → dropdown) and "agent-switcher:switch"
 * (legacy / select-style items; with a value → direct switch), so a mismatch
 * between server item and client registration can never dead-end again.
 *
 * Styling: the chip is cloned from the host's native `.chip` (same surface,
 * border, hover, icon slot, caret) and the popup clones `.dd-menu`.
 */

// --- inlined SDK helper (was ./sdk/index.mjs) --------------------------------
function onUiAction(action, handler) {
	try {
		const bridge = globalThis.window?.__piWebUiHost;
		if (bridge && typeof bridge.onUiAction === "function") return bridge.onUiAction(action, handler);
	} catch {
		/* bridge not ready / non-browser */
	}
	return () => {};
}

const ACTION_MENU = "agent-switcher:menu";
const ACTION_SWITCH = "agent-switcher:switch";
const API_BASE = "/plugins-api/agent-switcher";
const BUTTON_SELECTOR = 'button.composer-plugin-action[aria-label^="Agent:"]';
const OPEN_BODY_CLASS = "agent-switcher-menu-open";

// --- diagnostics (never throws; also proves the module executed) ------------
const diag = (globalThis.__agentSwitcherClient = globalThis.__agentSwitcherClient ?? {
	registered: [],
	errors: [],
	version: "0.3.0",
	importedAt: new Date().toISOString(),
});

function registerHandlers(scope) {
	const ok = (name, fn) => {
		try {
			const off = onUiAction(name, fn);
			diag.registered.push(`${name} @ ${scope}${typeof off === "function" ? "" : " (no-op: bridge missing)"}`);
		} catch (err) {
			diag.errors.push(`register(${name}@${scope}): ${err?.message ?? err}`);
		}
	};
	const openMenu = () => {
		const button = document.querySelector(BUTTON_SELECTOR);
		if (button) openMenuNearButton(button);
	};
	ok(ACTION_MENU, () => openMenu());
	ok(ACTION_SWITCH, (_itemId, value) => {
		if (typeof value === "string" && value) void requestSwitch(value);
		else openMenu();
	});
}

registerHandlers("import");
if (typeof window !== "undefined") {
	let tries = 0;
	const retry = () => {
		const bridge = window.__piWebUiHost;
		if (bridge && typeof bridge.onUiAction === "function") return registerHandlers("poll");
		if (tries++ < 50) setTimeout(retry, 200);
	};
	retry();
}

// --- chip styling: clone of the host's effective composer chip rules ---------
if (typeof document !== "undefined" && document.head && !document.getElementById("agent-switcher-style")) {
	const style = document.createElement("style");
	style.id = "agent-switcher-style";
	style.textContent = [
		`button.composer-plugin-action[aria-label^="Agent:"]{`,
		`-webkit-user-select:none;user-select:none;-webkit-touch-callout:none;`,
		`height:28px;border:1px solid var(--border);background:var(--chip-bg,var(--bg-elev2));`,
		`cursor:pointer;white-space:nowrap;border-radius:8px;align-items:center;gap:4px;`,
		`padding:3px 8px;transition:border-color .15s,background .15s;display:inline-flex;`,
		`min-width:0;max-width:220px;overflow:hidden;text-overflow:ellipsis;`,
		`color:var(--text-faint);font-size:11px}`,
		`button.composer-plugin-action[aria-label^="Agent:"]:hover{border-color:var(--accent);background:var(--accent-soft)}`,
		`button.composer-plugin-action[aria-label^="Agent:"]::before{content:"\\1F916";font-size:11px;line-height:1}`,
		`button.composer-plugin-action[aria-label^="Agent:"]::after{content:"\\25BE";color:var(--text-faint);margin-left:2px;transition:transform .15s;font-size:10px;line-height:1}`,
		`body.${OPEN_BODY_CLASS} button.composer-plugin-action[aria-label^="Agent:"]::after{transform:rotate(180deg)}`,
		`.agent-switcher-menu{background:var(--menu-bg,var(--bg-elev2));border:1px solid var(--border);z-index:60;`,
		`border-radius:10px;min-width:340px;max-width:480px;max-height:min(360px,100vh - 240px);`,
		`padding:6px;position:fixed;overflow-y:auto;box-shadow:0 12px 40px #00000080}`,
		`.agent-switcher-menu-header{letter-spacing:.6px;text-transform:uppercase;color:var(--text-faint);padding:6px 10px 4px;font-size:11px;font-weight:700}`,
		`.agent-switcher-menu-item{width:100%;color:var(--text-dim);text-align:left;cursor:pointer;background:0 0;border:none;`,
		`border-radius:7px;justify-content:space-between;align-items:center;gap:10px;padding:7px 10px;font-size:13px;display:flex}`,
		`.agent-switcher-menu-item:hover{background:var(--bg-elev);color:var(--text)}`,
		`.agent-switcher-menu-item.active{background:var(--accent-soft);color:var(--text)}`,
		`.agent-switcher-menu-note{color:var(--text-faint);padding:6px 10px 4px;font-size:11px}`,
		`.agent-switcher-menu-check{color:var(--accent);font-weight:700;margin-left:auto}`,
	].join("\n");
	document.head.appendChild(style);
}

// --- dropdown (dd-menu clone, opens above the chip) --------------------------
let openMenu = null;

function closeMenu() {
	if (openMenu) openMenu.close();
}

function openMenuNearButton(button) {
	if (openMenu) {
		closeMenu();
		return;
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
		if (openMenu?.root === root) openMenu = null;
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
			empty.textContent = "No agent profiles found (.pi/agent-profiles/*.md).";
			root.appendChild(empty);
			return;
		}
		const header = document.createElement("div");
		header.className = "agent-switcher-menu-header";
		header.textContent = "Agent mode";
		root.appendChild(header);
		for (const mode of state.modes) {
			const active = mode.id === state.current;
			const item = document.createElement("button");
			item.type = "button";
			item.className = `agent-switcher-menu-item${active ? " active" : ""}`;
			item.setAttribute("role", "menuitem");
			const name = document.createElement("span");
			name.textContent = mode.id;
			item.appendChild(name);
			if (active) {
				const check = document.createElement("span");
				check.className = "agent-switcher-menu-check";
				check.textContent = "\\2713";
				item.appendChild(check);
			}
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
	};

	openMenu = { root, close };
	void render();
}

// --- HTTP helpers -------------------------------------------------------------
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

// --- Agent tab -----------------------------------------------------------------
export default {
	mount(container) {
		registerHandlers("mount");
		const root = document.createElement("div");
		root.style.padding = "16px";
		root.style.font = "13px/1.5 system-ui, sans-serif";
		root.style.color = "var(--text)";
		container.appendChild(root);
		let timer = null;

		const render = async () => {
			const state = await fetchState();
			root.textContent = "";
			if (!state) {
				root.textContent = "Agent Switcher: state unavailable.";
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
				none.style.color = "var(--text-dim)";
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
				btn.style.cssText = `text-align:left;padding:8px 10px;border-radius:7px;border:1px solid ${active ? "var(--accent)" : "var(--border)"};background:transparent;color:inherit;cursor:pointer;${active ? "font-weight:600;" : ""}`;
				btn.addEventListener("click", async () => {
					btn.disabled = true;
					const result = await requestSwitch(mode.id);
					btn.disabled = false;
					if (!result.ok) {
						const note = document.createElement("div");
						note.textContent = `Switch failed: ${result.error ?? "unknown error"}`;
						note.style.color = "var(--red)";
						root.appendChild(note);
					}
					await render();
				});
				list.appendChild(btn);
			}
			root.appendChild(list);
			const hint = document.createElement("div");
			hint.textContent = "Also: the Agent chip next to the chat input, /agents <mode> in the chat box, or just ask.";
			hint.style.marginTop = "12px";
			hint.style.color = "var(--text-dim)";
			root.appendChild(hint);
		};

		void render();
		timer = setInterval(() => void render(), 5000);

		return () => {
			if (timer) clearInterval(timer);
			root.remove();
		};
	},
};
