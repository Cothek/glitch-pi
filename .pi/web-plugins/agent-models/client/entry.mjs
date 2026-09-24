/**
 * agent-models — pi-web-ui plugin (client entry) — SELF-CONTAINED, ZERO IMPORTS
 *
 * The host serves plugin files only from /plugins/<id>/client/*, so any relative
 * import (../resolver.mjs, ./sdk/*) would land on the SPA fallback and kill the
 * module. Everything here is inlined on purpose; the classification lives on the
 * server and arrives as JSON from GET /plugins-api/agent-models/state.
 *
 * LAYOUT CHOICE: the right panel is narrow, so this is NOT a 5-column table. Each
 * agent is a row: name + status badge, then pin -> effective on one mono line,
 * then the note. Legible at 320px, no horizontal scroll.
 *
 * TOKENS: only variables that exist in the shipped stylesheet are used
 * (--border, --border-soft, --text, --text-dim, --text-faint, --bg-elev,
 * --bg-elev2, --mono, --accent, --green, --red, --red-soft, --amber).
 */

const API_BASE = "/plugins-api/agent-models";
const POLL_MS = 15000;
const STYLE_ID = "agent-models-style";

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
.am-wrap{font:13px/1.5 var(--sans, system-ui, sans-serif);color:var(--text);padding:12px;display:flex;flex-direction:column;gap:10px;height:100%;box-sizing:border-box}
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
.am-error{border:1px solid var(--red);background:var(--red-soft, transparent);border-radius:8px;padding:10px;font-size:12px}
.am-code{font-family:var(--mono, monospace);font-size:11px;color:var(--text-faint)}
`;
	document.head.appendChild(style);
}

function el(tag, cls, text) {
	const node = document.createElement(tag);
	if (cls) node.className = cls;
	if (text !== undefined && text !== null) node.textContent = String(text);
	return node;
}

/** Fetch the report. Never throws: returns {ok:false, error} so the UI can say why. */
async function fetchState(force) {
	try {
		const res = await fetch(`${API_BASE}/state${force ? "?refresh=1" : ""}`);
		if (!res.ok) return { ok: false, error: `HTTP ${res.status}` };
		return await res.json();
	} catch (err) {
		return { ok: false, error: err?.message ?? "network error" };
	}
}

function matchesFilter(row, filter) {
	if (filter === "all") return true;
	if (filter === "problems") return row.severity > 0 || row.warnings.length > 0;
	return row.status === filter;
}

export default {
	mount(container, ctx) {
		injectStyles();
		const root = el("div", "am-wrap");
		container.appendChild(root);

		let report = null;
		let error = null;
		let loading = true;
		let filter = "all";
		let timer = null;
		let disposed = false;

		const head = el("div", "am-head");
		const title = el("div", "am-title", "Agent models");
		const sub = el("div", "am-sub");
		const spacer = el("div", "am-spacer");
		const refresh = el("button", "am-btn", "Refresh");
		refresh.type = "button";
		refresh.title = "Re-read .pi/agents/*.md and the live model catalog";
		head.append(title, sub, spacer, refresh);

		const filters = el("div", "am-filters");
		const filterButtons = new Map();
		for (const f of FILTERS) {
			const btn = el("button", "am-btn", f.label);
			btn.type = "button";
			btn.addEventListener("click", () => {
				filter = f.id;
				render();
			});
			filterButtons.set(f.id, btn);
			filters.appendChild(btn);
		}

		const list = el("div", "am-list");
		root.append(head, filters, list);

		function rowNode(row) {
			const wrap = el("div", "am-row");
			const top = el("div", "am-row-top");
			top.appendChild(el("div", "am-name", row.name));
			const badge = el("span", "am-badge", row.statusLabel);
			badge.style.color = STATUS_COLOR[row.status] ?? "var(--text-dim)";
			top.appendChild(badge);

			const models = el("div", "am-models");
			const pin = el("span", `am-model am-pin`, row.pin ?? "(no pin)");
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
			for (const [id, btn] of filterButtons) btn.setAttribute("aria-pressed", String(id === filter));
			list.textContent = "";

			if (error) {
				const box = el("div", "am-error", `State unavailable: ${error}`);
				const retry = el("button", "am-btn", "Retry");
				retry.type = "button";
				retry.style.marginTop = "8px";
				retry.addEventListener("click", () => void load(true));
				box.appendChild(document.createElement("br"));
				box.appendChild(retry);
				list.appendChild(box);
				sub.textContent = "";
				return;
			}
			if (loading && !report) {
				sub.textContent = "loading...";
				return;
			}
			if (!report) return;

			const c = report.counts;
			sub.textContent = `${c.total} agents | ${c.ok} ok | ${c.dropped} dead | ${c.unresolved} unresolved | ${c.inherit} inherit`;
			sub.title = report.catalogSource ?? "";

			const rows = report.rows.filter((r) => matchesFilter(r, filter));
			if (!rows.length) {
				const msg = report.rows.length
					? "No agents match this filter."
					: `No agent files in ${report.agentsDir ?? ".pi/agents"}/. Create one to see it here.`;
				list.appendChild(el("div", "am-empty", msg));
				return;
			}
			for (const row of rows) list.appendChild(rowNode(row));
		}

		async function load(force) {
			loading = true;
			render();
			const payload = await fetchState(force);
			if (disposed) return;
			loading = false;
			if (payload?.ok) {
				report = payload;
				error = null;
			} else {
				error = payload?.error ?? "unknown error";
			}
			render();
		}

		refresh.addEventListener("click", () => void load(true));
		void load(false);
		timer = setInterval(() => {
			// Poll, but never fight a user who is mid-read: silent refresh only.
			void load(false);
		}, POLL_MS);
		try {
			ctx?.onData?.(() => void load(true));
		} catch {
			/* ctx is optional */
		}

		return () => {
			disposed = true;
			if (timer) clearInterval(timer);
			root.remove();
		};
	},
};
