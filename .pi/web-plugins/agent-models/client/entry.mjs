/**
 * agent-models — pi-web-ui plugin (client entry) — SELF-CONTAINED, ZERO IMPORTS
 *
 * WHY ZERO IMPORTS: the host serves plugin files only from /plugins/<id>/client/*,
 * so a relative import (../resolver.mjs, ./sdk/*) would land on the SPA fallback
 * and kill the whole module. Classification happens server-side and arrives as
 * JSON from GET /plugins-api/agent-models/state.
 *
 * WHY THE DEFENSIVE SHAPE (learned the hard way, see README "Mount contract"):
 * the host renders one hidden `.view-pane` per plugin whose client module is in
 * its loaded-modules map, and calls `module.mount(el, ctx)` inside a try/catch
 * that REPLACES the host element's content with a bare text fallback on throw.
 * If the module never lands in that map the user sees a permanent
 * "插件视图加载中…" box instead - which is indistinguishable from "the page is
 * broken". So this file:
 *   1. never throws out of mount (the body is wrapped; failures render in-panel)
 *   2. is a module-level singleton (a second mount tears the first one down
 *      instead of stacking two panels)
 *   3. guards async work with a generation counter so a stale fetch cannot render
 *      into a destroyed instance
 *   4. renders its own always-visible diagnostic line, so a future "nothing
 *      works" report carries data instead of requiring a human to describe it
 *
 * TOKENS: only variables that exist in the shipped stylesheet are used
 * (--border, --border-soft, --text, --text-dim, --text-faint, --bg-elev,
 * --bg-elev2, --mono, --accent, --green, --red, --red-soft, --amber).
 */

const API_BASE = "/plugins-api/agent-models";
const POLL_MS = 15000;
const STYLE_ID = "agent-models-style";
const MOUNT_LABEL = "agent-models";
/** Keep in sync with manifest.json version (the panel shows it in the diag line). */
const PLUGIN_VERSION = "0.1.1";

/** Module-level singleton: at most one live panel, whatever the host does. */
let singleton = null;

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
.am-filters{display:flex;gap:6px;flex-wrap:wrap}
.am-list{display:flex;flex-direction:column;gap:6px;overflow-y:auto;flex:1;min-height:0}
.am-row{border:1px solid var(--border-soft);border-radius:8px;padding:8px 10px;background:var(--bg-elev2);display:flex;flex-direction:column;gap:3px}
.am-row-top{display:flex;align-items:center;gap:8px}
.am-name{font-weight:600;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.am-badge{font-size:10px;font-weight:700;letter-spacing:.4px;text-transform:uppercase;border:1px solid currentColor;border-radius:5px;padding:1px 5px;margin-left:auto;flex:none}
.am-models{font-family:var(--mono, monospace);font-size:11px;color:var(--text-dim);display:flex;align-items:baseline;gap:6px;min-width:0}
.am-arrow{color:var(--text-faint);flex:none}
.am-model{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-width:0}
.am-model.am-pin{color:var(--text-faint)}
.am-note{font-size:11px;color:var(--text-faint)}
.am-note.am-warn{color:var(--amber)}
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

function matchesFilter(row, filter) {
	if (filter === "all") return true;
	if (filter === "problems") return row.severity > 0 || row.warnings.length > 0;
	return row.status === filter;
}

/**
 * Build one panel instance. Everything until the first `await` is synchronous, so
 * a mount failure shows up in the caller's try/catch rather than as a blank pane.
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
		diag: {
			mounts: 1,
			lastAction: "mount",
			lastAt: new Date().toLocaleTimeString(),
			lastFetch: "pending",
			agentCount: 0,
		},
	};

	const root = el("div", "am-wrap");
	container.appendChild(root);

	const head = el("div", "am-head");
	const title = el("div", "am-title", "Agent models");
	const sub = el("div", "am-sub");
	head.append(title, sub, el("div", "am-spacer"));

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

	const refresh = el("button", "am-btn", "Refresh");
	refresh.type = "button";
	refresh.title = "Re-read .pi/agents/*.md and the live model catalog";
	refresh.addEventListener("click", () => {
		state.diag.lastAction = "refresh";
		state.diag.lastAt = new Date().toLocaleTimeString();
		void load(true);
	});
	head.appendChild(refresh);

	const list = el("div", "am-list");
	const diagLine = el("div", "am-diag");
	root.append(head, filters, list, diagLine);

	function renderDiag() {
		const d = state.diag;
		diagLine.textContent =
			`${MOUNT_LABEL} v${PLUGIN_VERSION} | mounts ${d.mounts} | last ${d.lastAction} @ ${d.lastAt}` +
			` | fetch ${d.lastFetch} | agents ${d.agentCount}`;
	}

	function rowNode(row) {
		const wrap = el("div", "am-row");
		const top = el("div", "am-row-top");
		top.appendChild(el("div", "am-name", row.name));
		const badge = el("span", "am-badge", row.statusLabel);
		badge.style.color = STATUS_COLOR[row.status] ?? "var(--text-dim)";
		top.appendChild(badge);

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
		state.timer = setInterval(() => void load(false), POLL_MS);
	} catch {
		/* setInterval is optional */
	}
	try {
		ctx?.onData?.(() => {
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
				root.remove();
			} catch {
				/* already detached */
			}
		},
	};
}

export default {
	mount(container, ctx) {
		// Tear down any previous instance first: one live panel, always.
		if (singleton) {
			try {
				singleton.destroy();
			} catch {
				/* ignore */
			}
			singleton = null;
		}
		if (typeof document === "undefined" || !container) return () => {};

		let instance;
		try {
			injectStyles();
			instance = createInstance(container, ctx);
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
		singleton = instance;

		return () => {
			if (singleton === instance) singleton = null;
			try {
				instance.destroy();
			} catch {
				/* ignore */
			}
		};
	},
};
