/**
 * agent-models — pi-web-ui plugin (client entry) — SELF-CONTAINED, ZERO IMPORTS
 *
 * WHY ZERO IMPORTS: the host serves plugin files only from /plugins/<id>/client/*,
 * so a relative import (../resolver.mjs, ./sdk/*) would land on the SPA fallback
 * and kill the whole module. Classification and the model catalog arrive as JSON
 * from GET /plugins-api/agent-models/state.
 *
 * WHY THE DEFENSIVE SHAPE (learned from the first broken deploy, see README
 * "Mount contract"): the host renders one hidden pane per plugin whose client
 * module is in its loaded-modules map and calls `module.mount(el, ctx)` inside a
 * try/catch that REPLACES the pane with a bare text fallback on throw. If the
 * module never lands in that map the user sees a permanent "插件视图加载中…" box,
 * with no console error and no server log. So this file:
 *   1. never throws out of mount (the body is wrapped; failures render in-panel)
 *   2. is a module-level singleton (a second mount tears the first down)
 *   3. guards async work with a generation counter
 *   4. renders its own diagnostic line, so a future "nothing works" report carries
 *      data instead of requiring a human to describe the screen
 *
 * TOKENS: only variables that exist in the shipped stylesheet are used
 * (--border, --border-soft, --text, --text-dim, --text-faint, --bg, --bg-elev,
 * --bg-elev2, --mono, --accent, --green, --red, --red-soft, --amber).
 */

const API_BASE = "/plugins-api/agent-models";
const POLL_MS = 15000;
const STYLE_ID = "agent-models-style";
const MOUNT_LABEL = "agent-models";
/** Keep in sync with manifest.json version (shown in the diag line). */
const PLUGIN_VERSION = "0.2.0";
/** How many catalog options to render at once (the catalog has ~500 entries). */
const PICKER_LIMIT = 60;

/**
 * Instances keyed by their CONTAINER.
 *
 * A module-level single instance was WRONG here and is what broke the visible
 * pane: the host mounts a plugin module in more than one place (the main view
 * pane via `nm`, the Settings plugin page and right-panel slot tabs via `Ms`).
 * With one global instance, the second mount tore the first one down and removed
 * its DOM - so the pane the user was looking at could go empty while a singleton
 * instance lived on inside some hidden container. Now only a repeat mount in the
 * SAME container replaces the previous instance.
 */
const instancesByContainer = new WeakMap();

const FILTERS = [
	{ id: "all", label: "All" },
	{ id: "problems", label: "Needs attention" },
	{ id: "ok", label: "Pinned OK" },
	{ id: "inherit", label: "Inherit" },
];

const STATUS_COLOR = {
	ok: "var(--green)",
	dropped: "var(--red)",
	unresolved: "var(--amber)",
	inherit: "var(--text-faint)",
};

function injectStyles() {
	if (typeof document === "undefined" || !document.head) return;
	if (document.getElementById(STYLE_ID)) return;
	const style = document.createElement("style");
	style.id = STYLE_ID;
	style.textContent = `
.am-wrap{font:13px/1.5 var(--sans, system-ui, sans-serif);color:var(--text);padding:12px;display:flex;flex-direction:column;gap:10px;height:100%;box-sizing:border-box;min-height:0}
.am-head{display:flex;align-items:baseline;gap:8px;flex-wrap:wrap}
.am-title{font-weight:600}
.am-sub{color:var(--text-faint);font-size:11px}
.am-spacer{flex:1}
.am-btn{height:26px;padding:0 9px;font-size:12px;border-radius:7px;border:1px solid var(--border);background:var(--bg-elev2);color:var(--text-dim);cursor:pointer}
.am-btn:hover{border-color:var(--accent);color:var(--text)}
.am-btn[aria-pressed="true"]{border-color:var(--accent);color:var(--text);background:var(--bg-elev)}
.am-btn:disabled{opacity:.5;cursor:default}
.am-btn.am-primary{border-color:var(--accent);color:var(--text)}
.am-filters{display:flex;gap:6px;flex-wrap:wrap}
.am-list{display:flex;flex-direction:column;gap:6px;overflow-y:auto;flex:1;min-height:0}
.am-row{border:1px solid var(--border-soft);border-radius:8px;padding:8px 10px;background:var(--bg-elev2);display:flex;flex-direction:column;gap:3px}
.am-row.am-open{border-color:var(--accent)}
.am-row-top{display:flex;align-items:center;gap:8px}
.am-name{font-weight:600;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.am-badge{font-size:10px;font-weight:700;letter-spacing:.4px;text-transform:uppercase;border:1px solid currentColor;border-radius:5px;padding:1px 5px;flex:none}
.am-actions{margin-left:auto;display:flex;gap:6px;align-items:center;flex:none}
.am-models{font-family:var(--mono, monospace);font-size:11px;color:var(--text-dim);display:flex;align-items:baseline;gap:6px;min-width:0}
.am-arrow{color:var(--text-faint);flex:none}
.am-model{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-width:0}
.am-model.am-pin{color:var(--text-faint)}
.am-note{font-size:11px;color:var(--text-faint)}
.am-note.am-warn{color:var(--amber)}
.am-saved{font-size:11px;color:var(--green);font-family:var(--mono, monospace);word-break:break-all}
.am-picker{margin-top:6px;border-top:1px solid var(--border-soft);padding-top:8px;display:flex;flex-direction:column;gap:6px}
.am-picker-input{background:var(--bg);border:1px solid var(--border);color:var(--text);border-radius:7px;outline:none;padding:6px 9px;font-size:12px;font-family:var(--mono, monospace)}
.am-picker-input:focus{border-color:var(--accent)}
.am-picker-head{display:flex;gap:8px;align-items:center}
.am-picker-count{color:var(--text-faint);font-size:11px;flex:none}
.am-options{max-height:220px;overflow-y:auto;border:1px solid var(--border-soft);border-radius:7px;background:var(--bg);display:flex;flex-direction:column}
.am-option{text-align:left;background:0 0;border:none;border-bottom:1px solid var(--border-soft);color:var(--text-dim);cursor:pointer;padding:5px 9px;font-size:11.5px;font-family:var(--mono, monospace);display:flex;gap:8px;align-items:center;min-width:0}
.am-option:last-child{border-bottom:none}
.am-option:hover{background:var(--bg-elev);color:var(--text)}
.am-option.am-current{color:var(--accent)}
.am-option.am-inherit{font-family:var(--sans, system-ui, sans-serif)}
.am-option-label{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-width:0;flex:1}
.am-option-mark{color:var(--accent);flex:none}
.am-empty-opt{padding:10px;color:var(--text-faint);font-size:11.5px}
.am-picker-err{color:var(--red);font-size:11.5px;border:1px solid var(--red);border-radius:6px;padding:6px 8px;background:var(--red-soft, transparent)}
.am-empty{padding:14px;border:1px dashed var(--border);border-radius:8px;color:var(--text-dim);font-size:12px}
.am-error{border:1px solid var(--red);background:var(--red-soft, transparent);border-radius:8px;padding:10px;font-size:12px;color:var(--text)}
.am-diag{border-top:1px solid var(--border-soft);padding-top:6px;color:var(--text-faint);font-family:var(--mono, monospace);font-size:10px;word-break:break-all}
`;
	document.head.appendChild(style);
}

function el(tag, cls, text) {
	const node = document.createElement(tag);
	if (cls) node.className = cls;
	if (text !== undefined && text !== null) node.textContent = String(text);
	return node;
}

function errorText(err) {
	if (err instanceof Error) return err.message;
	return String(err ?? "unknown error");
}

/** Fetch the report. Never throws: returns {ok:false, error} so the UI can say why. */
async function fetchState(force) {
	try {
		const res = await fetch(`${API_BASE}/state${force ? "?refresh=1" : ""}`);
		if (!res.ok) return { ok: false, error: `HTTP ${res.status}` };
		return await res.json();
	} catch (err) {
		return { ok: false, error: errorText(err) };
	}
}

/** Write one agent's model pin. Never throws. */
async function postSetModel(agent, model) {
	try {
		const res = await fetch(`${API_BASE}/set-model`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ agent, model: model || null }),
		});
		const payload = await res.json().catch(() => null);
		if (!payload) return { ok: false, error: `HTTP ${res.status} (unparsable body)` };
		return payload;
	} catch (err) {
		return { ok: false, error: errorText(err) };
	}
}

function matchesFilter(row, filter) {
	if (filter === "all") return true;
	if (filter === "problems") return row.severity > 0 || row.warnings.length > 0;
	return row.status === filter;
}

/**
 * Build one panel instance. Everything up to the first `await` is synchronous, so
 * a mount failure surfaces in the caller's try/catch rather than as a blank pane.
 */
function createInstance(container, ctx) {
	const state = {
		report: null,
		error: null,
		loading: true,
		filter: "all",
		destroyed: false,
		generation: 0,
		timer: null,
		openFor: null, // agent whose picker is open (survives re-renders)
		query: "",
		saving: null,
		pickerError: null,
		savedNote: null,
		diag: {
			mounts: 1,
			lastAction: "mount",
			lastAt: new Date().toLocaleTimeString(),
			lastFetch: "pending",
			lastWrite: "none",
			agentCount: 0,
		},
	};

	const root = el("div", "am-wrap");
	container.appendChild(root);

	const head = el("div", "am-head");
	const title = el("div", "am-title", "Agent models");
	const sub = el("div", "am-sub");
	const refresh = el("button", "am-btn", "Refresh");
	refresh.type = "button";
	refresh.title = "Re-read .pi/agents/*.md and the live model catalog";
	refresh.addEventListener("click", () => {
		state.diag.lastAction = "refresh";
		state.diag.lastAt = new Date().toLocaleTimeString();
		void load(true);
	});
	head.append(title, sub, el("div", "am-spacer"), refresh);

	const filters = el("div", "am-filters");
	const filterButtons = new Map();
	for (const f of FILTERS) {
		const btn = el("button", "am-btn", f.label);
		btn.type = "button";
		btn.addEventListener("click", () => {
			state.filter = f.id;
			state.diag.lastAction = `filter:${f.id}`;
			state.diag.lastAt = new Date().toLocaleTimeString();
			render();
		});
		filterButtons.set(f.id, btn);
		filters.appendChild(btn);
	}

	const list = el("div", "am-list");
	const diagLine = el("div", "am-diag");
	root.append(head, filters, list, diagLine);

	document.addEventListener?.("keydown", onKeydown);

	function onKeydown(event) {
		if (event.key !== "Escape" || !state.openFor) return;
		state.openFor = null;
		state.query = "";
		state.pickerError = null;
		render();
	}

	function renderDiag() {
		const d = state.diag;
		// Visibility is part of the diagnostic on purpose: a panel can be mounted,
		// connected and fetching while sitting in a hidden pane, which looks exactly
		// like a dead page. `hidden`/`detached` here says which of the two it is.
		let visibility = "unknown";
		try {
			visibility = !root.isConnected
				? "detached"
				: typeof root.getClientRects === "function" && root.getClientRects().length === 0
					? "hidden"
					: "visible";
		} catch {
			/* leave unknown */
		}
		diagLine.textContent =
			`${MOUNT_LABEL} v${PLUGIN_VERSION} | mounts ${d.mounts} | ${visibility} | last ${d.lastAction} @ ${d.lastAt}` +
			` | fetch ${d.lastFetch} | write ${d.lastWrite} | agents ${d.agentCount}`;
	}

	/** Apply a pin (model "" = inherit). */
	async function applyModel(agent, model) {
		state.saving = agent;
		state.pickerError = null;
		state.diag.lastAction = `set-model:${agent}`;
		state.diag.lastAt = new Date().toLocaleTimeString();
		render();
		const payload = await postSetModel(agent, model);
		if (state.destroyed) return;
		state.saving = null;
		if (payload?.ok) {
			if (payload.report) {
				state.report = payload.report;
				state.diag.agentCount = payload.report.counts?.total ?? state.diag.agentCount;
			}
			const backupName = payload.backup ? ` | backup ${String(payload.backup).split("/").pop()}` : "";
			state.savedNote = {
				agent,
				text: payload.changed
					? `saved: ${payload.previous ?? "(none)"} -> ${payload.model ?? "(inherit)"}${backupName}`
					: `no change needed (${payload.reason})`,
			};
			state.diag.lastWrite = `${agent} @ ${new Date().toLocaleTimeString()}`;
			state.openFor = null;
			state.query = "";
		} else {
			state.pickerError = payload?.error ?? "unknown error";
			state.diag.lastWrite = `${agent} FAILED`;
		}
		render();
	}

	/** The inline model picker for one row. */
	function pickerNode(row) {
		const wrap = el("div", "am-picker");

		const headRow = el("div", "am-picker-head");
		const input = el("input", "am-picker-input");
		input.type = "search";
		input.placeholder = "Search models, or leave empty for the first 60";
		input.value = state.query;
		input.setAttribute("data-am-action", "search");
		input.setAttribute("aria-label", `Model for ${row.name}`);
		input.addEventListener("input", () => {
			state.query = input.value;
			const focusBack = true;
			render();
			if (focusBack) reopenFocus(row.name);
		});
		const count = el("div", "am-picker-count");
		headRow.append(input, count);
		wrap.appendChild(headRow);

		if (state.pickerError) wrap.appendChild(el("div", "am-picker-err", state.pickerError));

		const options = el("div", "am-options");
		const catalog = Array.isArray(state.report?.catalog) ? state.report.catalog : [];
		const q = state.query.trim().toLowerCase();
		const matches = q ? catalog.filter((m) => m.toLowerCase().includes(q)) : catalog;
		count.textContent = `${matches.length}${matches.length > PICKER_LIMIT ? ` (showing ${PICKER_LIMIT})` : ""}`;

		const saving = state.saving === row.name;
		const inheritBtn = el("button", "am-option am-inherit");
		inheritBtn.type = "button";
		inheritBtn.disabled = saving;
		inheritBtn.setAttribute("data-am-option", "__inherit__");
		inheritBtn.appendChild(el("span", "am-option-label", "Inherit (no pin) - follow the main conversation model"));
		if (!row.pin) inheritBtn.appendChild(el("span", "am-option-mark", "✓"));
		inheritBtn.addEventListener("click", () => void applyModel(row.name, ""));
		options.appendChild(inheritBtn);

		if (!catalog.length) {
			options.appendChild(el("div", "am-empty-opt", "No model catalog available (no provider keys configured)."));
		} else if (!matches.length) {
			options.appendChild(el("div", "am-empty-opt", `No model matches "${state.query}".`));
		} else {
			for (const model of matches.slice(0, PICKER_LIMIT)) {
				const btn = el("button", "am-option");
				btn.type = "button";
				btn.disabled = saving;
				btn.setAttribute("data-am-option", model);
				if (model === row.pin) btn.className = "am-option am-current";
				btn.appendChild(el("span", "am-option-label", model));
				if (model === row.pin) btn.appendChild(el("span", "am-option-mark", "✓"));
				btn.addEventListener("click", () => void applyModel(row.name, model));
				options.appendChild(btn);
			}
		}
		wrap.appendChild(options);

		if (saving) wrap.appendChild(el("div", "am-note", `saving ${row.name}...`));
		const hint = el("div", "am-note", "Click a model to apply it. The file is edited in place and backed up first. Escape closes.");
		wrap.appendChild(hint);
		return wrap;
	}

	/** Put the caret back in the picker's search box after a re-render. */
	function reopenFocus(agent) {
		if (typeof document === "undefined") return;
		const nodes = list.querySelectorAll?.(".am-row");
		if (!nodes) return;
		for (const node of nodes) {
			const name = node.querySelector?.(".am-name")?.textContent;
			if (name !== agent) continue;
			const input = node.querySelector?.(".am-picker-input");
			if (input) {
				input.focus();
				if (typeof input.setSelectionRange === "function") {
					try {
						input.setSelectionRange(input.value.length, input.value.length);
					} catch {
						/* search inputs may refuse */
					}
				}
			}
			return;
		}
	}

	function rowNode(row) {
		const open = state.openFor === row.name;
		const wrap = el("div", open ? "am-row am-open" : "am-row");
		// Stable hooks: let a human (or a browser-driving agent) address one row
		// without guessing at DOM order.
		wrap.setAttribute("data-am-agent", row.name);
		wrap.setAttribute("data-am-status", row.status);
		const top = el("div", "am-row-top");
		top.appendChild(el("div", "am-name", row.name));
		const badge = el("span", "am-badge", row.statusLabel);
		badge.style.color = STATUS_COLOR[row.status] ?? "var(--text-dim)";
		top.appendChild(badge);

		const actions = el("div", "am-actions");
		const change = el("button", "am-btn", open ? "Close" : "Change");
		change.type = "button";
		change.setAttribute("data-am-action", "pick");
		change.setAttribute("aria-expanded", String(open));
		change.addEventListener("click", () => {
			state.openFor = open ? null : row.name;
			state.query = "";
			state.pickerError = null;
			state.savedNote = null;
			state.diag.lastAction = open ? "picker:close" : `picker:${row.name}`;
			state.diag.lastAt = new Date().toLocaleTimeString();
			render();
			if (!open) reopenFocus(row.name);
		});
		actions.appendChild(change);
		top.appendChild(actions);

		const models = el("div", "am-models");
		const pin = el("span", "am-model am-pin", row.pin ?? "(no pin)");
		pin.title = row.pin ?? "no model: in frontmatter";
		models.appendChild(pin);
		models.appendChild(el("span", "am-arrow", "->"));
		const eff = el("span", "am-model", row.effective ?? row.effectiveLabel);
		eff.title = row.effective ?? row.why;
		models.appendChild(eff);

		wrap.append(top, models);
		if (row.warnings.length) {
			for (const warning of row.warnings) wrap.appendChild(el("div", "am-note am-warn", `warning: ${warning}`));
		} else if (row.status !== "ok") {
			wrap.appendChild(el("div", "am-note", row.why));
		}
		if (state.savedNote?.agent === row.name) wrap.appendChild(el("div", "am-saved", state.savedNote.text));
		if (open) wrap.appendChild(pickerNode(row));
		return wrap;
	}

	function render() {
		if (state.destroyed) return;
		try {
			for (const [id, btn] of filterButtons) btn.setAttribute("aria-pressed", String(id === state.filter));
			list.textContent = "";

			if (state.error) {
				const box = el("div", "am-error", `State unavailable: ${state.error}`);
				const retry = el("button", "am-btn", "Retry");
				retry.type = "button";
				retry.style.marginTop = "8px";
				retry.addEventListener("click", () => {
					state.diag.lastAction = "retry";
					state.diag.lastAt = new Date().toLocaleTimeString();
					void load(true);
				});
				box.appendChild(document.createElement("br"));
				box.appendChild(retry);
				list.appendChild(box);
				sub.textContent = "";
				renderDiag();
				return;
			}
			if (state.loading && !state.report) {
				sub.textContent = "loading...";
				renderDiag();
				return;
			}
			if (!state.report) {
				renderDiag();
				return;
			}

			const c = state.report.counts;
			sub.textContent = `${c.total} agents | ${c.ok} ok | ${c.dropped} dead | ${c.unresolved} unresolved | ${c.inherit} inherit`;
			sub.title = state.report.catalogSource ?? "";

			const rows = (state.report.rows ?? []).filter((r) => matchesFilter(r, state.filter));
			if (!rows.length) {
				const msg = state.report.rows?.length
					? "No agents match this filter."
					: `No agent files in ${state.report.agentsDir ?? ".pi/agents"}/. Create one to see it here.`;
				list.appendChild(el("div", "am-empty", msg));
				renderDiag();
				return;
			}
			for (const row of rows) list.appendChild(rowNode(row));
			renderDiag();
		} catch (err) {
			// Never let a render error produce a blank pane.
			list.textContent = "";
			list.appendChild(el("div", "am-error", `Render failed: ${errorText(err)}`));
			renderDiag();
		}
	}

	async function load(force) {
		if (state.destroyed) return;
		const generation = ++state.generation;
		state.loading = true;
		render();
		const payload = await fetchState(force);
		// A stale response must not touch a newer instance (or a destroyed one).
		if (state.destroyed || generation !== state.generation) return;
		state.loading = false;
		if (payload?.ok) {
			state.report = payload;
			state.error = null;
			state.diag.agentCount = payload.counts?.total ?? 0;
			state.diag.lastFetch = `ok ${new Date().toLocaleTimeString()}`;
		} else {
			state.error = payload?.error ?? "unknown error";
			state.diag.lastFetch = `fail: ${state.error}`;
		}
		render();
	}

	try {
		state.timer = setInterval(() => {
			// Never yank the DOM out from under an open picker or a save in flight.
			if (state.openFor || state.saving) return;
			void load(false);
		}, POLL_MS);
	} catch {
		/* setInterval is optional */
	}
	try {
		ctx?.onData?.(() => {
			if (state.openFor || state.saving) return;
			state.diag.lastAction = "data push";
			state.diag.lastAt = new Date().toLocaleTimeString();
			void load(true);
		});
	} catch {
		/* ctx is optional */
	}

	void load(false);

	return {
		destroy() {
			state.destroyed = true;
			if (state.timer) clearInterval(state.timer);
			try {
				document.removeEventListener?.("keydown", onKeydown);
			} catch {
				/* ignore */
			}
			try {
				root.remove();
			} catch {
				/* already detached */
			}
		},
	};
}

export default {
	mount(container, ctx) {
		if (typeof document === "undefined" || !container) return () => {};

		let instance;
		try {
			// Same container mounting twice = a real remount (epoch change): replace it.
			// A DIFFERENT container = an additional surface, left alone.
			const previous = instancesByContainer.get(container);
			if (previous) {
				try {
					previous.destroy();
				} catch {
					/* ignore */
				}
				instancesByContainer.delete(container);
			}
			injectStyles();
			instance = createInstance(container, ctx);
			instancesByContainer.set(container, instance);
		} catch (err) {
			// The host would otherwise replace the pane with an opaque fallback;
			// render the real reason here instead.
			try {
				const box = el("div", "am-error", `agent-models failed to mount: ${errorText(err)}`);
				container.appendChild(box);
			} catch {
				/* nothing left to do */
			}
			return () => {};
		}

		return () => {
			if (instancesByContainer.get(container) === instance) instancesByContainer.delete(container);
			try {
				instance.destroy();
			} catch {
				/* ignore */
			}
		};
	},
};
