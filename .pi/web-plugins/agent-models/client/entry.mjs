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
const PLUGIN_VERSION = "0.6.1";
/**
 * Render cap. Deliberately above any realistic catalog size: the catalog is ~500
 * entries and these are plain DOM rows, not a virtual list.
 *
 * Capping this at 60 is exactly what made the picker look like "commandcode only":
 * ids sort alphabetically and "commandcode/" sorts before "nvidia/" and
 * "openrouter/", so the visible window was 59 commandcode models plus one nvidia.
 */
const PICKER_LIMIT = 600;

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

/**
 * The stylesheet is a module constant so injectStyles() can compare it by CONTENT.
 *
 * The style ELEMENT outlives a mount: it is appended to <head> and stays there
 * across remounts, plugin reloads and SPA navigation. An id-only "already
 * injected?" check therefore kept the FIRST deploy's CSS for the life of the page,
 * and every later stylesheet change was silently ignored - new DOM, stale CSS.
 * That is exactly how a bug looked here: the row toggle was full-bleed in the
 * markup but rendered 11px inset with the host's default button padding (1px 6px),
 * because the old .am-row padding rule was still the only one that existed.
 */
const STYLE_CSS = `
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
/**
 * flex:none is THE property that prevents "expanding one card squashes the others":
 * the rows sit in a flex column whose box (flex:1;min-height:0) has a fixed height,
 * and with the default flex-shrink:1 the container DISTRIBUTES the deficit across
 * every item instead of scrolling - a 770px expanded row gets allocated ~390px and
 * clips its own picker (the row is overflow:hidden for the rounded corners), while
 * the other rows squish and the list never scrolls because scrollHeight never
 * exceeds clientHeight. Measured live: rowFlexShrink "1", list scrollHeight ===
 * clientHeight, options box bottom 87px past the list bottom. With flex:none the
 * items keep their natural height and the container does what overflow-y:auto is
 * there for: scroll.
 */
.am-row{border:1px solid var(--border-soft);border-radius:8px;background:var(--bg-elev2);display:flex;flex-direction:column;overflow:hidden;flex:none;transition:background-color .08s ease-out,border-color .08s ease-out}
.am-row.am-selected{border-color:var(--accent);background:var(--accent-soft)}
.am-select-box{flex:none;margin:0;width:14px;height:14px;accent-color:var(--accent);cursor:pointer}
.am-row-line{display:flex;align-items:center;gap:8px;padding:0 8px;min-height:28px}
.am-bulk-bar{display:flex;flex-wrap:wrap;align-items:center;gap:8px;padding:6px 8px;border:1px solid var(--border-soft);border-radius:8px;background:var(--bg-elev2)}
.am-bulk-count{color:var(--text-dim);font-size:13px;font-family:inherit}
.am-bulk-note{flex:1 0 100%;padding:0;margin:0;align-self:center;font-family:var(--mono, monospace);font-size:11px;line-height:1.4;color:var(--green);text-align:center;word-break:break-word}
.am-bulk-picker{flex:1 0 100%;margin-top:4px}
.am-row.am-open{border-color:var(--accent)}
.am-row-toggle{display:flex;flex-direction:row;align-items:center;gap:8px;text-align:left;flex:1;min-width:0;padding:4px 0;margin:0;box-sizing:border-box;background:0 0;border:none;color:var(--text);font:inherit;cursor:pointer}
.am-row-toggle:hover{background:var(--bg-elev)}
.am-row-toggle:focus-visible{outline:2px solid var(--accent);outline-offset:-2px}
.am-name{font-family:var(--mono, monospace);font-size:12px;font-weight:500;flex:0 0 auto;max-width:22%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.am-badge{font-size:11px;font-weight:500;letter-spacing:normal;border:1px solid currentColor;border-radius:4px;padding:0 4px;flex:none;white-space:nowrap}
.am-caret{color:var(--text-faint);font-size:10px;line-height:1;flex:none;transition:transform .15s}
.am-row.am-open .am-caret{transform:rotate(180deg)}
.am-models{font-family:var(--mono, monospace);font-size:11.5px;color:var(--text-dim);display:flex;align-items:center;gap:8px;flex:1;min-width:0;overflow:hidden}
.am-arrow{color:var(--text-faint);flex:none}
.am-model{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-width:0}
.am-model.am-pin{color:var(--text-faint)}
.am-model.am-effective{color:var(--text)}
.am-issues{font-size:11px;flex:0 1 auto;max-width:28%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;cursor:help}
.am-note{font-size:11px;color:var(--text-faint)}
.am-note.am-warn{color:var(--amber)}
.am-saved{padding:0 8px 8px;font-size:11px;color:var(--green);font-family:var(--mono, monospace);word-break:break-all}
.am-picker{border-top:1px solid var(--border-soft);padding:8px 10px;display:flex;flex-direction:column;gap:6px}
.am-picker-input{flex:1;min-width:0;background:var(--bg);border:1px solid var(--border);color:var(--text);border-radius:7px;outline:none;padding:6px 9px;font-size:12px;font-family:var(--mono, monospace)}
.am-picker-input:focus{border-color:var(--accent)}
.am-picker-head{display:flex;gap:8px;align-items:center;width:100%}
.am-picker-count{color:var(--text-faint);font-size:11px;flex:none}
.am-providers{display:flex;gap:6px;flex-wrap:wrap;align-items:center}
.am-provider{height:24px;padding:0 8px;font-size:11px;border-radius:6px;border:1px solid var(--border);background:var(--bg-elev2);color:var(--text-dim);cursor:pointer;font-family:var(--mono, monospace);display:inline-flex;align-items:center}
.am-provider:hover{border-color:var(--accent);color:var(--text)}
.am-provider[aria-pressed="true"]{border-color:var(--accent);color:var(--text);background:var(--bg-elev)}
.am-provider-count{color:var(--text-faint);margin-left:5px}
.am-option-cost{margin-left:auto;flex:none;color:var(--text-faint);font-size:10.5px;font-family:var(--mono, monospace);padding-left:10px}
.am-option-tier{flex:none;color:var(--text-faint);font-size:10px;border:1px solid var(--border-soft);border-radius:4px;padding:0 4px;margin-left:6px}
.am-option-tier.am-tier-free{color:var(--green);border-color:var(--green)}
.am-option-tier.am-tier-budget{color:var(--text-dim);border-color:var(--text-faint)}
.am-option-tier.am-tier-mid{color:var(--amber);border-color:var(--amber)}
.am-option-tier.am-tier-premium{color:var(--red);border-color:var(--red)}
.am-option-cap{flex:none;color:var(--text-faint);font-size:10px;margin-left:6px}
.am-rollback{margin-top:2px}
.am-option.am-current .am-option-cost{color:var(--accent)}
.am-cost{font-family:var(--mono, monospace);font-size:10.5px;font-variant-numeric:tabular-nums;color:var(--text-faint);border:1px solid var(--border-soft);border-radius:4px;padding:0 4px;flex:none;white-space:nowrap}
.am-cost.am-free{color:var(--green);border-color:var(--green)}
.am-cost.am-paid{color:var(--amber);border-color:var(--amber)}
.am-cost-note{color:var(--text-faint);font-size:10.5px}
.am-options{max-height:min(72vh,780px);overflow-y:auto;overscroll-behavior:contain;border:1px solid var(--border-soft);border-radius:7px;background:var(--bg);display:flex;flex-direction:column}
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
/* Configs bar: preset dropdown + save/apply/delete, between the header and the row list */
.am-configs-bar{display:flex;align-items:center;gap:6px;flex-wrap:wrap;padding:4px 0;border-bottom:1px solid var(--border-soft);margin-bottom:6px}
.am-config-dropdown{position:relative;flex:1;min-width:120px}
/* Chip styling matches the agent drop-down chip (agent-switcher) exactly: same
 * chip-bg var (semi-transparent in the host theme), border, radius 8, 25px metrics,
 * caret ::after with the open-state rotation. Verified by computed-style capture. */
.am-config-dropdown-btn{background:var(--chip-bg,var(--bg-elev2));border:1px solid var(--border);border-radius:8px;color:var(--text);cursor:pointer;white-space:nowrap;align-items:center;gap:4px;padding:4px 10px;font-size:13px;font-weight:400;line-height:15px;box-sizing:border-box;font-family:inherit;display:inline-flex;transition:border-color .15s,background .15s}
.am-config-dropdown-btn:hover{border-color:var(--accent);background:var(--accent-soft)}
.am-config-dropdown-btn:focus{outline:none}
.am-config-dropdown-btn::after{content:"\\25BE";color:var(--text-faint);margin-left:auto;font-size:10px;line-height:1;transition:transform .15s}
.am-config-dropdown-btn[aria-expanded="true"]::after{transform:rotate(180deg)}
/* Menu clones the agent drop-down menu (.agent-switcher-menu): same surface, radius 10,
 * padding 6, shadow, z-index 1000, compact 340-480px width, max-height + scroll. */
.am-config-options{position:absolute;top:100%;left:0;z-index:1000;min-width:340px;max-width:480px;max-height:min(360px,100vh - 240px);overflow-y:auto;background:var(--menu-bg,var(--bg-elev2));border:1px solid var(--border);border-radius:10px;padding:6px;box-shadow:0 12px 40px #00000080;color:var(--text)}
.am-config-menu-header{letter-spacing:.6px;text-transform:uppercase;color:var(--text-faint);padding:6px 10px 4px;font-size:11px;font-weight:700}
.am-config-option{width:100%;color:var(--text-dim);text-align:left;cursor:pointer;background:0 0;border:none;border-radius:7px;padding:7px 10px;font-size:13px;font-family:inherit;display:flex;align-items:center;gap:10px;line-height:1.4}
.am-config-option:hover{background:var(--bg-elev);color:var(--text)}
.am-config-option.am-current{color:var(--text);background:var(--accent-soft)}
.am-config-option:disabled{opacity:.4;cursor:not-allowed}
.am-config-option-label{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-width:0;flex:1}
.am-config-option-desc{color:var(--text-faint);font-size:11px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:60%}
.am-config-option-check{color:var(--accent);font-weight:700;margin-left:auto}
.am-config-form{display:flex;flex-direction:column;gap:6px;width:100%}
.am-config-input{width:100%;font-size:12px;font-family:var(--mono, monospace);border:1px solid var(--border);border-radius:7px;background:var(--bg);color:var(--text);padding:5px 8px;box-sizing:border-box}
.am-config-input:focus{border-color:var(--accent);outline:none}
.am-config-form-btns{display:flex;gap:6px}
.am-config-err{border:1px solid var(--red);background:var(--red-soft, transparent);border-radius:6px;padding:6px 8px;font-size:11.5px;color:var(--text)}
/* Chat-bar button (server entry registers kind:"view", label "Agent Models").
   Sized to the native composer dropdowns: 25x25 at desktop (the host renders
   .composer-tools .chip with 4px vertical padding and a 13px font -> text box
   15px, total 25px with the 1px borders) and 30x30 under the host's own
   <=560px chip rules; width matches the height so the button stays square.
   The glyph comes from the HOST icon set (same Feather-style 24x24 sprite the model chip's
   cpu and the thinking chip's zap come from): "list" - the roster this page shows. It is
   painted with a CSS mask, not an inline SVG, for two reasons: the host's composer renderer
   only maps mic/camera to SVG components (a plugin cannot request a glyph through "icon"),
   and an injected SVG node would be wiped by React on the next re-render. The mask keeps
   background-color:currentColor, so the icon follows the theme and the hover accent.
   font-size:0 hides the item label (the renderer puts it in the button as text); it stays
   in aria-label/title for screen readers.
   Specificity (0,3,1) beats the host ".inputbox .btn.composer-plugin-action" (0,2,1). */
.inputbox .btn.composer-plugin-action[aria-label="Agent Models"]{width:25px;min-width:25px;height:25px;box-sizing:border-box;flex:none;justify-content:center;align-items:center;gap:0;padding:0;border:1px solid var(--border);border-radius:8px;background:var(--chip-bg,var(--bg-elev2));color:var(--text);font-size:0;line-height:1;white-space:nowrap;user-select:none;-webkit-user-select:none}
.inputbox .btn.composer-plugin-action[aria-label="Agent Models"]::before{content:"";display:block;width:15px;height:15px;flex:none;background-color:currentColor;-webkit-mask:url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='%23fff' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'%3E%3Cline x1='8' y1='6' x2='21' y2='6'/%3E%3Cline x1='8' y1='12' x2='21' y2='12'/%3E%3Cline x1='8' y1='18' x2='21' y2='18'/%3E%3Cline x1='3' y1='6' x2='3.01' y2='6'/%3E%3Cline x1='3' y1='12' x2='3.01' y2='12'/%3E%3Cline x1='3' y1='18' x2='3.01' y2='18'/%3E%3C/svg%3E") center/contain no-repeat;mask:url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='%23fff' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'%3E%3Cline x1='8' y1='6' x2='21' y2='6'/%3E%3Cline x1='8' y1='12' x2='21' y2='12'/%3E%3Cline x1='8' y1='18' x2='21' y2='18'/%3E%3Cline x1='3' y1='6' x2='3.01' y2='6'/%3E%3Cline x1='3' y1='12' x2='3.01' y2='12'/%3E%3Cline x1='3' y1='18' x2='3.01' y2='18'/%3E%3C/svg%3E") center/contain no-repeat}
.inputbox .btn.composer-plugin-action[aria-label="Agent Models"]:hover{border-color:var(--accent);background:var(--accent-soft);color:var(--accent)}
@media (max-width:560px){.inputbox .btn.composer-plugin-action[aria-label="Agent Models"]{width:30px;min-width:30px;height:30px}.inputbox .btn.composer-plugin-action[aria-label="Agent Models"]::before{width:16px;height:16px}}
`;

function injectStyles() {
	if (typeof document === "undefined" || !document.head) return;
	let style = document.getElementById(STYLE_ID);
	if (!style) {
		style = document.createElement("style");
		style.id = STYLE_ID;
		document.head.appendChild(style);
	}
	if (style.textContent !== STYLE_CSS) style.textContent = STYLE_CSS;
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

/**
 * Error for a response whose body is not JSON (the SPA fallback page). A 404 here
 * almost always means the RUNNING server predates this route - server routes
 * register at plugin activation and a page reload alone never re-activates them.
 */
function httpError(res) {
	const status = res?.status ?? 0;
	const why =
		status === 404 ? " — route missing on the running server: reload plugins in Settings (or restart pi-web-ui)"
		: status >= 500 ? " — server error, check the pi-web-ui log"
		: status === 401 || status === 403 ? " — not authorized"
		: "";
	return { ok: false, error: `HTTP ${status}${why}` };
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
		if (!payload) return httpError(res);
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

/** Restore an agent's newest backup. Never throws. */
async function postRestore(agent) {
	try {
		const res = await fetch(`${API_BASE}/restore`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ agent }),
		});
		const payload = await res.json().catch(() => null);
		if (!payload) return httpError(res);
		return payload;
	} catch (err) {
		return { ok: false, error: errorText(err) };
	}
}

/** Save current agent pins as a named configuration. If editId is provided, renames the existing config instead of capturing fresh pins. Never throws. */
async function postSaveConfig(name, description, editId) {
	try {
		const res = await fetch(`${API_BASE}/configs/save`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ name, description, editId }),
		});
		const payload = await res.json().catch(() => null);
		if (!payload) return httpError(res);
		return payload;
	} catch (err) {
		return { ok: false, error: errorText(err) };
	}
}

/** Apply ONE model to MANY agents in one round trip (bulk apply). Never throws. */
async function postSetModels(agents, model) {
	try {
		const res = await fetch(`${API_BASE}/set-models`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ agents, model }),
		});
		const payload = await res.json().catch(() => null);
		if (!payload) return httpError(res);
		return payload;
	} catch (err) {
		return { ok: false, error: errorText(err) };
	}
}

/** Apply a saved configuration (batch-set all pins). Never throws. */
async function postApplyConfig(id) {
	try {
		const res = await fetch(`${API_BASE}/configs/apply`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ id }),
		});
		const payload = await res.json().catch(() => null);
		if (!payload) return httpError(res);
		return payload;
	} catch (err) {
		return { ok: false, error: errorText(err) };
	}
}

/** Delete a saved configuration. Never throws. */
async function postDeleteConfig(id) {
	try {
		const res = await fetch(`${API_BASE}/configs/delete`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ id }),
		});
		const payload = await res.json().catch(() => null);
		if (!payload) return httpError(res);
		return payload;
	} catch (err) {
		return { ok: false, error: errorText(err) };
	}
}

/** A cost chip: green for free, amber for priced, faint for unknown. */
function costChipNode(short, title) {
	const cls = short === "free" ? "am-cost am-free" : String(short).startsWith("$") ? "am-cost am-paid" : "am-cost";
	const chip = el("span", cls, short);
	if (title) chip.title = title;
	return chip;
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
		provider: "all",
		tier: "all",
		capability: "all",
		destroyed: false,
		generation: 0,
		timer: null,
		openFor: null, // agent whose picker is open (survives re-renders)
		query: "",
		saving: null,
		pickerError: null,
		savedNote: null,
		configs: [],
		selectedConfig: null,
		configFormOpen: false,
		configDropdownOpen: false,
		editingConfigId: null,
		configName: "",
		configDesc: "",
		configError: null,
		savingConfig: false,
		selected: new Set(),
		bulkOpen: false,
		bulkQuery: "",
		bulkProvider: "all",
		bulkTier: "all",
		bulkCapability: "all",
		bulkError: null,
		savingBulk: false,
		bulkNote: null,
		diag: {
			mounts: 1,
			lastAction: "mount",
			lastAt: new Date().toLocaleTimeString(),
			lastFetch: "pending",
			lastWrite: "none",
			agentCount: 0,
		},
	};

	/** Live option-area nodes of the open picker, so filtering can update in place. */
	let pickerRefs = null;

	/** Same idea for the bulk picker's filter chips. */
	let bulkChipRefs = null;

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

	const bulkBar = el("div", "am-bulk-bar");
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
	const configBar = el("div", "am-configs-bar");
	const diagLine = el("div", "am-diag");
	root.append(head, configBar, bulkBar, filters, list, diagLine);

	document.addEventListener?.("keydown", onKeydown);
		document.addEventListener?.("click", onDocumentClick);

		function onDocumentClick(event) {
			if (state.configDropdownOpen) {
				const target = event.target;
				if (!configBar.contains(target)) {
					state.configDropdownOpen = false;
					state.configError = null;
					render();
				}
			}
		}

	function onKeydown(event) {
		if (event.key !== "Escape") return;
		if (state.openFor) { state.openFor = null; state.query = ""; state.pickerError = null; render(); return; }
		if (state.configDropdownOpen) { state.configDropdownOpen = false; state.configError = null; render(); return; }
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

	/** Restore the newest backup for an agent (rollback). */
	async function applyRestore(agent) {
		state.saving = agent;
		state.pickerError = null;
		state.diag.lastAction = `restore:${agent}`;
		state.diag.lastAt = new Date().toLocaleTimeString();
		render();
		const payload = await postRestore(agent);
		if (state.destroyed) return;
		state.saving = null;
		if (payload?.ok) {
			if (payload.report) {
				state.report = payload.report;
				state.diag.agentCount = payload.report.counts?.total ?? state.diag.agentCount;
			}
			state.savedNote = {
				agent,
				text: `rolled back to ${payload.restoredFrom} | pre-rollback state saved as ${String(payload.safety ?? "").split("/").pop()}`,
			};
			state.diag.lastWrite = `${agent} rollback @ ${new Date().toLocaleTimeString()}`;
			state.openFor = null;
			state.query = "";
		} else {
			state.pickerError = payload?.error ?? "unknown error";
			state.diag.lastWrite = `${agent} rollback FAILED`;
		}
		render();
	}

	/**
	 * Facet counts for the quick-filter chips, shared by both pickers.
	 * Server facets are the source of truth; providers fall back to counting the
	 * catalog when an older payload has none.
	 */
	function modelFacets() {
		const facets = state.report?.facets ?? {};
		const total = Array.isArray(state.report?.catalog) ? state.report.catalog.length : 0;
		let providers = Array.isArray(facets.providers) ? facets.providers : [];
		if (!providers.length && total) {
			const counts = new Map();
			for (const id of state.report.catalog) {
				const slash = id.indexOf("/");
				const name = slash > 0 ? id.slice(0, slash) : "(none)";
				counts.set(name, (counts.get(name) ?? 0) + 1);
			}
			providers = [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([id, count]) => ({ id, count }));
		}
		return {
			providers,
			tiers: Array.isArray(facets.tiers) ? facets.tiers : [],
			capabilities: Array.isArray(facets.capabilities) ? facets.capabilities : [],
			total,
		};
	}

	/** The inline model picker for one row. */
	function pickerNode(row) {
		const wrap = el("div", "am-picker");

		const headRow = el("div", "am-picker-head");
		const input = el("input", "am-picker-input");
		input.type = "search";
		input.placeholder = "Search all providers (name or provider/name), or filter with the chips below";
		input.value = state.query;
		input.setAttribute("data-am-action", "search");
		input.setAttribute("aria-label", `Model for ${row.name}`);
		input.addEventListener("input", () => {
			// Update the option list IN PLACE. A full render() here would rebuild every
			// row (and steal the caret) on each keystroke.
			state.query = input.value;
			renderOptions();
		});
		const count = el("div", "am-picker-count");
		headRow.append(input, count);
		wrap.appendChild(headRow);

		if (state.pickerError) wrap.appendChild(el("div", "am-picker-err", state.pickerError));

		// Filter chips: provider, tier, capability. Counts come from the server's facets so
	// every surface agrees; providers fall back to counting the catalog if an older
		// payload has no facets. Shared by the row picker and the bulk picker so the two
	// can never report different numbers.
	const { providers: providerFacet, tiers: tierFacet, capabilities: capabilityFacet, total } = modelFacets();
		const chips = [];
		const chipRow = (attr, allLabel, items, isActive, pick) => {
			const rowEl = el("div", "am-providers");
			const mk = (id, label, n) => {
				const chip = el("button", "am-provider");
				chip.type = "button";
				chip.setAttribute("aria-pressed", String(isActive(id)));
				chip.setAttribute(attr, id);
				chip.appendChild(el("span", undefined, label));
				if (typeof n === "number") chip.appendChild(el("span", "am-provider-count", String(n)));
				chip.addEventListener("click", () => {
					pick(id);
					renderOptions();
				});
				chips.push({ attr, id, el: chip });
				rowEl.appendChild(chip);
			};
			mk("all", allLabel, total);
			for (const it of items) mk(it.id, it.label ?? it.id, it.count);
			return rowEl;
		};
		wrap.appendChild(
			chipRow("data-am-provider", "All providers", providerFacet, (id) => state.provider === id, (id) => { state.provider = id; }),
		);
		wrap.appendChild(chipRow("data-am-tier", "All tiers", tierFacet, (id) => state.tier === id, (id) => { state.tier = id; }));
		wrap.appendChild(
			chipRow("data-am-capability", "Any capability", capabilityFacet, (id) => state.capability === id, (id) => { state.capability = id; }),
		);

		const options = el("div", "am-options");
		pickerRefs = { agent: row.name, pin: row.pin ?? null, options, count, chips };
		renderOptions();
		wrap.appendChild(options);

		// Say what the numbers mean, and how to fill them in when a provider is silent.
		const costMeta = state.report?.costMeta ?? {};
		wrap.appendChild(
			el(
				"div",
				"am-cost-note",
				costMeta.missing
					? "no cost table yet - run: node scripts/agent-model-costs.mjs"
					: "costs are USD per million tokens (input/output). n/a = the provider publishes no pricing.",
			),
		);

		if (row.backups > 0) {
			const rollback = el("button", "am-btn am-rollback", `Rollback this agent (${row.backups} backup${row.backups === 1 ? "" : "s"})`);
			rollback.type = "button";
			rollback.setAttribute("data-am-action", "restore");
			rollback.disabled = state.saving === row.name;
			rollback.title = "Restore this agent file's newest backup. The current content is saved first, so clicking again steps back one more state.";
			rollback.addEventListener("click", () => void applyRestore(row.name));
			wrap.appendChild(rollback);
		}

		if (state.saving === row.name) wrap.appendChild(el("div", "am-note", `saving ${row.name}...`));
		const hint = el("div", "am-note", "Click a model to apply it. The file is edited in place and backed up first. Escape closes.");
		wrap.appendChild(hint);
		return wrap;
	}

	/**
	 * Fill the option area: called when the picker opens, on every keystroke, and on a
	 * provider switch. Kept separate from render() so typing does not rebuild the panel.
	 */
	function renderOptions() {
		const refs = pickerRefs;
		if (!refs || state.destroyed) return;
		const catalog = Array.isArray(state.report?.catalog) ? state.report.catalog : [];
		const q = state.query.trim().toLowerCase();
		const info = (id) => state.report?.models?.[id] ?? null;
		let matches = catalog;
		if (state.provider !== "all") matches = matches.filter((m) => m.startsWith(`${state.provider}/`));
		if (state.tier !== "all") matches = matches.filter((m) => info(m)?.tier === state.tier);
		if (state.capability === "vision") matches = matches.filter((m) => info(m)?.vision === true);
		else if (state.capability === "largeContext") matches = matches.filter((m) => info(m)?.largeContext === true);
		if (q) matches = matches.filter((m) => m.toLowerCase().includes(q));

		refs.count.textContent = `${matches.length}${matches.length > PICKER_LIMIT ? ` (showing ${PICKER_LIMIT})` : ""}`;
		for (const chip of refs.chips) {
			const active =
				chip.attr === "data-am-provider" ? state.provider : chip.attr === "data-am-tier" ? state.tier : state.capability;
			chip.el.setAttribute("aria-pressed", String(chip.id === active));
		}

		const saving = state.saving === refs.agent;
		refs.options.textContent = "";

		const inheritBtn = el("button", "am-option am-inherit");
		inheritBtn.type = "button";
		inheritBtn.disabled = saving;
		inheritBtn.setAttribute("data-am-option", "__inherit__");
		inheritBtn.appendChild(el("span", "am-config-option-label", "Inherit (no pin) - follow the main conversation model"));
		if (!refs.pin) inheritBtn.appendChild(el("span", "am-option-mark", "✓"));
		inheritBtn.addEventListener("click", () => void applyModel(refs.agent, ""));
		refs.options.appendChild(inheritBtn);

		if (!catalog.length) {
			refs.options.appendChild(el("div", "am-empty-opt", "No model catalog available (no provider keys configured)."));
			return;
		}
		if (!matches.length) {
			const where = state.provider !== "all" ? ` in ${state.provider}` : "";
			refs.options.appendChild(el("div", "am-empty-opt", `No model matches "${state.query}"${where}.`));
			return;
		}
		for (const model of matches.slice(0, PICKER_LIMIT)) {
			const btn = el("button", "am-option");
			btn.type = "button";
			btn.disabled = saving;
			btn.setAttribute("data-am-option", model);
			if (model === refs.pin) btn.className = "am-option am-current";
			btn.appendChild(el("span", "am-config-option-label", model));
			const meta = info(model);
			if (meta?.tier && meta.tier !== "unknown") {
				btn.appendChild(el("span", `am-option-tier am-tier-${meta.tier}`, meta.tier));
			}
			if (meta?.vision) btn.appendChild(el("span", "am-option-cap", "vision"));
			if (meta?.largeContext) btn.appendChild(el("span", "am-option-cap", "200K+"));
			const costChip = el("span", "am-option-cost", meta?.short ?? "n/a");
			costChip.setAttribute("data-am-cost", meta?.short ?? "n/a");
			if (meta?.title) costChip.title = meta.title;
			btn.appendChild(costChip);
			if (model === refs.pin) btn.appendChild(el("span", "am-option-mark", "✓"));
			btn.addEventListener("click", () => void applyModel(refs.agent, model));
			refs.options.appendChild(btn);
		}
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
		const wrap = el("div", `${open ? "am-row am-open" : "am-row"}${state.selected.has(row.name) ? " am-selected" : ""}`);
		// Stable hooks: let a human (or a browser-driving agent) address one row
		// without guessing at DOM order.
		wrap.setAttribute("data-am-agent", row.name);
		wrap.setAttribute("data-am-status", row.status);

		// The WHOLE row toggles the picker (no separate Change button). It is a real
		// <button> rather than a div with a click handler, so focus, Enter/Space and
		// screen readers work for free. The picker is a SIBLING of this button, never
		// a child: nesting its option buttons inside would be invalid HTML.
		const toggle = el("button", "am-row-toggle");
		toggle.type = "button";
		toggle.setAttribute("data-am-action", "pick");
		toggle.setAttribute("aria-expanded", String(open));
		toggle.title = open ? `Close the model picker for ${row.name}` : `Change the model for ${row.name}`;

		// ONE dense line: everything sits on a single vertically centered row
		// (name, status, pin -> effective, cost/tier, issues, caret). Anything that used
		// to push the row taller is now a truncating inline marker with a title tooltip.
		toggle.appendChild(el("span", "am-name", row.name));
		const badge = el("span", "am-badge", row.statusLabel);
		badge.style.color = STATUS_COLOR[row.status] ?? "var(--text-dim)";
		badge.title = row.why ?? "";
		toggle.appendChild(badge);

		const models = el("div", "am-models");
		const pin = el("span", "am-model am-pin", row.pin ?? "(no pin)");
		pin.title = row.pin ?? "no model: in frontmatter";
		models.appendChild(pin);
		models.appendChild(el("span", "am-arrow", "→"));
		const eff = el("span", "am-model am-effective", row.effective ?? row.effectiveLabel);
		eff.title = row.effective ?? row.why;
		models.appendChild(eff);
		if (row.costShort) models.appendChild(costChipNode(row.costShort, row.costTitle));
		if (row.tier && row.tier !== "unknown") models.appendChild(el("span", "am-cost", row.tier));
		if (row.thinkingLevel) models.appendChild(el("span", "am-cost", `think ${row.thinkingLevel}`));
		toggle.appendChild(models);

		// Issues never get their own line: a count (or the reason) truncates in place,
		// with the full text in the title tooltip.
		const issues = [];
		if (row.warnings.length) issues.push(...row.warnings.map((w) => `warning: ${w}`));
		if (row.status !== "ok" && row.why) issues.push(row.why);
		if (issues.length) {
			const mark = el("span", "am-issues", row.warnings.length ? `${row.warnings.length} issue${row.warnings.length === 1 ? "" : "s"}` : row.why);
			mark.title = issues.join("\n");
			mark.style.color = row.warnings.length ? "var(--amber)" : "var(--text-faint)";
			toggle.appendChild(mark);
		}

		toggle.appendChild(el("span", "am-caret", "▾"));

		toggle.addEventListener("click", () => {
			state.openFor = open ? null : row.name;
			state.query = "";
			state.pickerError = null;
			state.savedNote = null;
			state.diag.lastAction = open ? "row:collapse" : `row:expand:${row.name}`;
			state.diag.lastAt = new Date().toLocaleTimeString();
			render();
			if (!open) reopenFocus(row.name);
		});

		// Selection checkbox: a SIBLING of the row toggle button (never a child - nesting
		// an input inside a button is invalid HTML). Both sit in one horizontal line so
		// the checkbox costs NO extra row height; the picker/note stack below it.
		const line = el("div", "am-row-line");
		const box = el("input", "am-select-box");
		box.type = "checkbox";
		box.checked = state.selected.has(row.name);
		box.setAttribute("data-am-select", row.name);
		box.setAttribute("aria-label", `Select ${row.name} for a bulk model change`);
		box.addEventListener("click", (event) => event.stopPropagation());
		box.addEventListener("change", () => {
			if (box.checked) state.selected.add(row.name);
			else state.selected.delete(row.name);
			state.diag.lastAction = `${box.checked ? "select" : "deselect"}:${row.name}`;
			state.diag.lastAt = new Date().toLocaleTimeString();
			render();
		});
		line.appendChild(box);
		line.appendChild(toggle);
		wrap.appendChild(line);
		if (state.savedNote?.agent === row.name) wrap.appendChild(el("div", "am-saved", state.savedNote.text));
		if (open) wrap.appendChild(pickerNode(row));
		return wrap;
	}


	/**
	 * Bulk toolbar: tick agents on the rows, then apply ONE model to all of them.
	 * Renders its own inline picker (same option markup as a single row's) so the
	 * multi-agent path is one POST /set-models instead of N posts.
	 */
	function renderBulkBar() {
		bulkBar.textContent = "";
		bulkBar.setAttribute("data-am-bulk", "1");
		const visible = (state.report?.rows ?? []).filter((r) => matchesFilter(r, state.filter));
		const count = state.selected.size;

		const allBtn = el("button", "am-btn", "Select all");
		allBtn.type = "button";
		allBtn.setAttribute("data-am-bulk-all", "1");
		allBtn.disabled = !visible.length || state.savingBulk;
		allBtn.addEventListener("click", () => {
			for (const r of visible) state.selected.add(r.name);
			state.diag.lastAction = `bulk select-all (${visible.length})`;
			state.diag.lastAt = new Date().toLocaleTimeString();
			render();
		});

		const clearBtn = el("button", "am-btn", "Clear");
		clearBtn.type = "button";
		clearBtn.setAttribute("data-am-bulk-clear", "1");
		clearBtn.disabled = !count || state.savingBulk;
		clearBtn.addEventListener("click", () => {
			state.selected.clear();
			state.bulkOpen = false;
			state.bulkError = null;
			state.bulkNote = null;
			render();
		});

		const label = el("span", "am-bulk-count", count ? `${count} selected` : "no agents selected");
		label.setAttribute("data-am-bulk-count", String(count));
		bulkBar.append(allBtn, clearBtn, label);

		if (state.bulkNote) bulkBar.appendChild(el("div", "am-bulk-note", state.bulkNote));
		if (state.bulkError) bulkBar.appendChild(el("div", "am-config-err", state.bulkError));

		const openBtn = el("button", "am-btn am-primary", "Set model on selected…");
		openBtn.type = "button";
		openBtn.disabled = !count || state.savingBulk;
		openBtn.setAttribute("data-am-bulk-open", "1");
		openBtn.addEventListener("click", () => {
			state.bulkOpen = !state.bulkOpen;
			// Reset the filters on every open/close: a stale provider/tier narrowing must
			// never silently shape the next bulk apply.
			state.bulkQuery = "";
			state.bulkProvider = "all";
			state.bulkTier = "all";
			state.bulkCapability = "all";
			bulkChipRefs = null;
			state.bulkError = null;
			// Never leave the single-row picker and the bulk picker open at once.
			if (state.bulkOpen) state.openFor = null;
			render();
		});
		bulkBar.appendChild(openBtn);

		if (!state.bulkOpen || !count) {
			bulkChipRefs = null;
			return;
		}

		const wrap = el("div", "am-picker am-bulk-picker");
		const headRow = el("div", "am-picker-head");
		const input = el("input", "am-picker-input");
		input.type = "search";
		input.placeholder = `Search all providers — applies to ${count} selected agent${count === 1 ? "" : "s"}`;
		input.value = state.bulkQuery;
		input.setAttribute("data-am-bulk-search", "1");
		input.setAttribute("aria-label", `Model for ${count} selected agents`);
		input.addEventListener("input", () => {
			// Update options IN PLACE: a full render() would steal the caret.
			state.bulkQuery = input.value;
			renderBulkOptions();
		});
		const countEl = el("div", "am-picker-count");
		headRow.append(input, countEl);
		wrap.appendChild(headRow);

		// Quick-filter chips, identical to the single-agent picker: provider, tier,
		// capability. A chip click calls renderBulkOptions() (in place) rather than
		// render(), so the open picker and the search caret both survive.
		const facets = modelFacets();
		const bulkChips = [];
		const bulkChipRow = (attr, allLabel, items, getActive, setActive) => {
			const rowEl = el("div", "am-providers");
			const mk = (id, label, n) => {
				const chip = el("button", "am-provider");
				chip.type = "button";
				chip.setAttribute("aria-pressed", String(getActive(id)));
				chip.setAttribute(attr, id);
				chip.appendChild(el("span", undefined, label));
				if (typeof n === "number") chip.appendChild(el("span", "am-provider-count", String(n)));
				chip.addEventListener("click", () => {
					setActive(id);
					state.diag.lastAction = `bulk filter ${attr.replace("data-am-", "")}:${id}`;
					state.diag.lastAt = new Date().toLocaleTimeString();
					renderBulkOptions();
				});
				bulkChips.push({ attr, id, el: chip });
				rowEl.appendChild(chip);
			};
			mk("all", allLabel, facets.total);
			for (const it of items) mk(it.id, it.label ?? it.id, it.count);
			return rowEl;
		};
		wrap.appendChild(bulkChipRow("data-am-bulk-provider", "All providers", facets.providers, (id) => state.bulkProvider === id, (id) => { state.bulkProvider = id; }));
		wrap.appendChild(bulkChipRow("data-am-bulk-tier", "All tiers", facets.tiers, (id) => state.bulkTier === id, (id) => { state.bulkTier = id; }));
		wrap.appendChild(bulkChipRow("data-am-bulk-capability", "Any capability", facets.capabilities, (id) => state.bulkCapability === id, (id) => { state.bulkCapability = id; }));
		bulkChipRefs = bulkChips;

		const options = el("div", "am-options");
		wrap.appendChild(options);

		const cancel = el("button", "am-btn am-rollback", "Cancel bulk change");
		cancel.type = "button";
		cancel.setAttribute("data-am-bulk-cancel", "1");
		cancel.addEventListener("click", () => { state.bulkOpen = false; state.bulkProvider = "all"; state.bulkTier = "all"; state.bulkCapability = "all"; render(); });
		wrap.appendChild(cancel);
		wrap.appendChild(el("div", "am-note", "Click a model to apply it to every selected agent. Each file is backed up first."));

		bulkBar.appendChild(wrap);
		renderBulkOptions();
	}

	/** Fill the bulk picker's option area (typing re-enters here). */
	function renderBulkOptions() {
		if (!bulkBar.querySelector("[data-am-bulk-search]")) return;
		const options = bulkBar.querySelector(".am-bulk-picker .am-options");
		if (!options) return;
		const catalog = Array.isArray(state.report?.catalog) ? state.report.catalog : [];
		const info = (id) => state.report?.models?.[id] ?? null;
		const q = state.bulkQuery.trim().toLowerCase();
		let matches = catalog;
		// Quick filters and the search box compose, exactly like the single-agent picker.
		if (state.bulkProvider !== "all") matches = matches.filter((m) => m.startsWith(`${state.bulkProvider}/`));
		if (state.bulkTier !== "all") matches = matches.filter((m) => info(m)?.tier === state.bulkTier);
		if (state.bulkCapability === "vision") matches = matches.filter((m) => info(m)?.vision === true);
		else if (state.bulkCapability === "largeContext") matches = matches.filter((m) => info(m)?.largeContext === true);
		if (q) matches = matches.filter((m) => m.toLowerCase().includes(q));
		// Chips stay in sync with the state that filtered them.
		for (const chip of bulkChipRefs ?? []) {
			const active =
				chip.attr === "data-am-bulk-provider" ? state.bulkProvider : chip.attr === "data-am-bulk-tier" ? state.bulkTier : state.bulkCapability;
			chip.el.setAttribute("aria-pressed", String(chip.id === active));
		}
		const countEl = bulkBar.querySelector(".am-bulk-picker .am-picker-count");
		if (countEl) countEl.textContent = `${matches.length}${matches.length > PICKER_LIMIT ? ` (showing ${PICKER_LIMIT})` : ""}`;

		options.textContent = "";
		const inheritBtn = el("button", "am-option am-inherit");
		inheritBtn.type = "button";
		inheritBtn.disabled = state.savingBulk;
		inheritBtn.setAttribute("data-am-bulk-option", "__inherit__");
		inheritBtn.appendChild(el("span", "am-config-option-label", "Inherit (no pin) - all selected follow the main conversation model"));
		inheritBtn.addEventListener("click", () => void applyBulk(""));
		options.appendChild(inheritBtn);
		if (!matches.length) {
			const what = matches.length === catalog.length ? `"${state.bulkQuery}"` : "the current filters";
			options.appendChild(el("div", "am-empty-opt", `No model matches ${what}.`));
			return;
		}
		for (const model of matches.slice(0, PICKER_LIMIT)) {
			const btn = el("button", "am-option");
			btn.type = "button";
			btn.disabled = state.savingBulk;
			btn.setAttribute("data-am-bulk-option", model);
			btn.appendChild(el("span", "am-config-option-label", model));
			const meta = info(model);
			if (meta?.tier && meta.tier !== "unknown") btn.appendChild(el("span", `am-option-tier am-tier-${meta.tier}`, meta.tier));
			if (meta?.vision) btn.appendChild(el("span", "am-option-cap", "vision"));
			if (meta?.largeContext) btn.appendChild(el("span", "am-option-cap", "200K+"));
			const costChip = el("span", "am-option-cost", meta?.short ?? "n/a");
			costChip.setAttribute("data-am-cost", meta?.short ?? "n/a");
			if (meta?.title) costChip.title = meta.title;
			btn.appendChild(costChip);
			btn.addEventListener("click", () => void applyBulk(model));
			options.appendChild(btn);
		}
	}

	/** POST /set-models for every ticked agent, then refresh from the returned report. */
	async function applyBulk(model) {
		const agents = [...state.selected];
		if (!agents.length) return;
		state.savingBulk = true;
		state.bulkError = null;
		state.diag.lastAction = `bulk set-model (${agents.length} agents)`;
		state.diag.lastAt = new Date().toLocaleTimeString();
		render();
		const payload = await postSetModels(agents, model);
		if (state.destroyed) return;
		state.savingBulk = false;
		if (payload?.ok) {
			if (payload.report) state.report = payload.report;
			const s = payload.summary ?? {};
			state.bulkNote = `bulk: ${model || "(inherit)"} -> ${s.applied ?? 0} updated, ${s.unchanged ?? 0} unchanged, ${s.failed ?? 0} failed (${s.requested ?? agents.length} agents)`;
			state.bulkError = null;
			state.bulkOpen = false;
			state.bulkQuery = "";
			state.selected.clear();
			state.diag.lastWrite = `bulk set-model @ ${new Date().toLocaleTimeString()}`;
		} else {
			state.bulkError = payload?.error ?? "unknown error";
			state.diag.lastWrite = "bulk set-model FAILED";
		}
		render();
	}

	/**
	 * Render the configuration bar: preset dropdown + save/apply/delete buttons.
	 * Inserted between the header and the filter row so it stays visible
	 * while scrolling the agent roster.
	 */
	function renderConfigBar() {
		configBar.textContent = "";
		configBar.setAttribute("data-am-configs", "1");
		if (state.configError) {
			const err = el("div", "am-config-err", state.configError);
			const retry = el("button", "am-btn", "Retry");
			retry.type = "button";
			retry.addEventListener("click", () => { state.configError = null; render(); });
			err.appendChild(retry);
			configBar.appendChild(err);
		}
		if (state.configFormOpen) {
			const form = el("div", "am-config-form");
			const nameInput = el("input");
			nameInput.type = "text";
			nameInput.className = "am-config-input";
			nameInput.placeholder = "Configuration name";
			nameInput.setAttribute("maxlength", "80");
			nameInput.setAttribute("data-am-config-name", "1");
			nameInput.value = state.configName;
			nameInput.addEventListener("input", () => { state.configName = nameInput.value.trim(); const b = nameInput.parentNode && nameInput.parentNode.querySelector('[data-am-config-save-submit]'); if (b) b.disabled = !state.configName || state.savingConfig; });
			nameInput.addEventListener("keydown", (e) => {
				if (e.key === "Enter") { e.preventDefault(); void saveConfig(); }
				if (e.key === "Escape") { state.configFormOpen = false; state.editingConfigId = null; state.configName = ""; state.configDesc = ""; render(); }
			});
			const descInput = el("textarea");
			descInput.className = "am-config-input";
			descInput.placeholder = "Description (optional)";
			descInput.setAttribute("rows", "2");
			descInput.setAttribute("data-am-config-desc", "1");
			descInput.value = state.configDesc;
			descInput.addEventListener("input", () => { state.configDesc = descInput.value.trim(); });
			const saveBtn = el("button", "am-btn am-primary");
			saveBtn.type = "button";
			saveBtn.textContent = state.editingConfigId ? "Update" : "Save";
			saveBtn.setAttribute("data-am-config-save-submit", "1");
			saveBtn.disabled = !state.configName || state.savingConfig;
			saveBtn.addEventListener("click", () => void saveConfig());
			const cancelBtn = el("button", "am-btn");
			cancelBtn.type = "button";
			cancelBtn.textContent = "Cancel";
			cancelBtn.addEventListener("click", () => { state.configFormOpen = false; state.editingConfigId = null; state.configName = ""; state.configDesc = ""; render(); });
			const btns = el("div", "am-config-form-btns");
			btns.append(saveBtn, cancelBtn);
			form.append(nameInput, descInput, btns);
			if (state.savingConfig) form.appendChild(el("span", "am-note", "saving…"));
			configBar.appendChild(form);
			return;
		}
		const selectWrap = el("div", "am-config-dropdown");
		selectWrap.setAttribute("data-am-config-select", "1");
		const selectBtn = el("button", "am-config-dropdown-btn");
		selectBtn.type = "button";
		selectBtn.disabled = state.savingConfig;
		const selected = state.configs.find((c) => c.id === state.selectedConfig);
		selectBtn.textContent = selected ? selected.name + " (" + selected.agentCount + ")" : (state.configs.length ? "Select a preset…" : "No saved presets");
		selectBtn.setAttribute("data-am-config-btn", "1");
		// aria-expanded drives the caret rotation (same as the agent drop-down chip)
		selectBtn.setAttribute("aria-expanded", state.configDropdownOpen ? "true" : "false");
		selectBtn.addEventListener("click", (event) => {
			// stopPropagation is REQUIRED: renderConfigBar() below rebuilds the bar DOM
			// synchronously during this click dispatch, so the bubbling document-level
			// outside-click handler (onDocumentClick) would see the original button node
			// as detached ("outside") and close the dropdown in the same tick - the menu
			// could never stay open. Found live via the CDP UI drive.
			event.stopPropagation();
			state.configDropdownOpen = !state.configDropdownOpen;
			state.configError = null;
			renderConfigBar();
		});
		selectWrap.appendChild(selectBtn);
		if (state.configDropdownOpen) {
			const panel = el("div", "am-options am-config-options");
			panel.setAttribute("data-am-config-options", "1");
			// header matches the agent drop-down menu header (uppercase 11px)
			panel.appendChild(el("div", "am-config-menu-header", "Saved presets"));
			const noneOpt = el("button", "am-config-option");
			noneOpt.type = "button";
			noneOpt.setAttribute("data-am-config-option", "");
			noneOpt.textContent = "None";
			noneOpt.disabled = !state.selectedConfig;
			noneOpt.addEventListener("click", () => {
				state.selectedConfig = null;
				state.configDropdownOpen = false;
				state.configError = null;
				render();
			});
			panel.appendChild(noneOpt);
			for (const c of state.configs) {
				const opt = el("button", "am-config-option");
				opt.type = "button";
				opt.setAttribute("data-am-config-option", c.id);
				if (c.id === state.selectedConfig) opt.className = "am-config-option am-current";
				const label = el("span", "am-config-option-label", c.name + " (" + c.agentCount + ")");
				opt.appendChild(label);
				if (c.description) opt.appendChild(el("span", "am-config-option-desc", c.description));
				// check mark on the current preset (same as the agent drop-down menu)
				if (c.id === state.selectedConfig) opt.appendChild(el("span", "am-config-option-check", "\u2713"));
				opt.addEventListener("click", () => {
					state.selectedConfig = c.id;
					state.configDropdownOpen = false;
					state.configError = null;
					render();
				});
				panel.appendChild(opt);
			}
			selectWrap.appendChild(panel);
		}
		const saveBtn = el("button", "am-btn");
		saveBtn.type = "button";
		saveBtn.textContent = "Save current";
		saveBtn.setAttribute("data-am-config-save", "1");
		saveBtn.title = "Snapshot all agent model pins into a named configuration";
		saveBtn.addEventListener("click", () => {
			state.configFormOpen = true;
			// "Save current" ALWAYS captures a fresh snapshot - never a rename of the
			// config an earlier Edit session left behind. A stale editingConfigId made a
			// save-current-after-edit silently RENAME the old config (pins never
			// re-captured) instead of creating the new one the name asked for.
			state.editingConfigId = null;
			state.configName = "";
			state.configDesc = "";
			state.configError = null;
			renderConfigBar();
		});
		const applyBtn = el("button", "am-btn am-primary");
		applyBtn.type = "button";
		applyBtn.textContent = "Apply";
		applyBtn.setAttribute("data-am-config-apply", "1");
		applyBtn.disabled = !state.selectedConfig || state.savingConfig;
		applyBtn.title = state.selectedConfig ? "Apply " + ((state.configs.find((c) => c.id === state.selectedConfig) || {}).name || state.selectedConfig) : "Select a preset to apply";
		applyBtn.addEventListener("click", () => void applyConfig());
		const editBtn = el("button", "am-btn");
		editBtn.type = "button";
		editBtn.disabled = !state.selectedConfig || state.savingConfig;
		editBtn.setAttribute("data-am-config-edit", "1");
		editBtn.title = "Rename this preset (keeps its pins)";
		editBtn.textContent = "Edit";
		editBtn.addEventListener("click", () => editConfig());
		const deleteBtn = el("button", "am-btn");
		deleteBtn.type = "button";
		deleteBtn.disabled = !state.selectedConfig || state.savingConfig;
		deleteBtn.setAttribute("data-am-config-delete", "1");
		deleteBtn.title = "Delete the selected preset";
		deleteBtn.innerHTML = "\u00d7";
		deleteBtn.addEventListener("click", () => void deleteConfig());
		configBar.append(selectWrap, saveBtn, applyBtn, editBtn, deleteBtn);
	}

	function editConfig() {
		const cfg = state.configs.find((c) => c.id === state.selectedConfig);
		if (!cfg) return;
		state.editingConfigId = cfg.id;
		state.configFormOpen = true;
		state.configName = cfg.name;
		state.configDesc = cfg.description || "";
		state.configError = null;
		renderConfigBar();
	}

	async function saveConfig() {
		if (!state.configName) return;
		state.savingConfig = true;
		renderConfigBar();
		const payload = await postSaveConfig(state.configName, state.configDesc, state.editingConfigId);
		if (state.destroyed) return;
		state.savingConfig = false;
		if (payload && payload.ok) {
			state.configFormOpen = false;
			// The edit session is done - a fresh save or a rename must never leak its
			// editId into the NEXT "Save current", which would rename-or-404 instead of
			// creating the new config.
			state.editingConfigId = null;
			state.configName = "";
			state.configDesc = "";
			state.configError = null;
			if (payload.report) {
				state.report = payload.report;
				state.diag.agentCount = payload.report.counts?.total ?? state.diag.agentCount;
			}
			if (payload.report && payload.report.configs) state.configs = payload.report.configs;
			state.selectedConfig = (payload.config && payload.config.id) || null;
			state.diag.lastWrite = "save-config:" + (state.selectedConfig || "?") + " @ " + new Date().toLocaleTimeString();
			state.diag.lastAction = "save-config";
			state.diag.lastAt = new Date().toLocaleTimeString();
		} else {
			state.configError = (payload && payload.error) || "unknown error";
			state.diag.lastWrite = "save-config FAILED";
			// Drop the edit session on failure too: a retry from the still-open form
			// must honor the VISIBLE name (save as new / upsert), never re-send a stale
			// editId that points at a config that may already be gone (perpetual 404).
			state.editingConfigId = null;
		}
		render();
	}

	async function applyConfig() {
		const id = state.selectedConfig;
		if (!id) return;
		state.savingConfig = true;
		state.configError = null;
		renderConfigBar();
		const cfgName = (state.configs.find((c) => c.id === id) || {}).name || id;
		const payload = await postApplyConfig(id);
		if (state.destroyed) return;
		state.savingConfig = false;
		if (payload && payload.ok) {
			// Adopt the roster the server just rebuilt for this response. Without this the
			// rows keep rendering the PREVIOUS report until the next 15s poll, which is
			// what made a preset apply look like it hung after the writes finished.
			if (payload.report) {
				state.report = payload.report;
				state.diag.agentCount = payload.report.counts?.total ?? state.diag.agentCount;
			}
			if (payload.report && payload.report.configs) state.configs = payload.report.configs;
			state.diag.lastWrite = "apply:" + id + " @ " + new Date().toLocaleTimeString();
			state.diag.lastAction = "apply:" + cfgName;
			state.diag.lastAt = new Date().toLocaleTimeString();
			const s = payload.summary || {};
			const skipped = s.invalid ? ", " + s.invalid + " skipped (unavailable)" : "";
			state.savedNote = { agent: "(all)", text: "applied " + (payload.name || id) + ": " + (s.applied || 0) + " agents updated" + skipped };
			state.openFor = null;
			state.query = "";
		} else {
			state.configError = (payload && payload.error) || "unknown error";
			state.diag.lastWrite = "apply:" + id + " FAILED";
		}
		render();
	}

	async function deleteConfig() {
		const id = state.selectedConfig;
		if (!id) return;
		const cfgName = (state.configs.find((c) => c.id === id) || {}).name || id;
		if (!confirm("Delete preset: " + cfgName + "? This cannot be undone.")) return;
		state.savingConfig = true;
		renderConfigBar();
		const payload = await postDeleteConfig(id);
		if (state.destroyed) return;
		state.savingConfig = false;
		if (payload && payload.ok) {
			state.configs = payload.configs || [];
			state.selectedConfig = null;
			// If the deleted config was the one being edited, the edit session is dead:
			// keeping its id made the NEXT save POST a stale editId and 404 with
			// "config not found" instead of saving the new config.
			if (state.editingConfigId === id) state.editingConfigId = null;
			state.diag.lastWrite = "delete:" + id + " @ " + new Date().toLocaleTimeString();
			state.diag.lastAction = "delete-config";
			state.diag.lastAt = new Date().toLocaleTimeString();
		} else {
			state.configError = (payload && payload.error) || "unknown error";
		}
		render();
	}


	function render() {
		if (state.destroyed) return;
		// Every full render rebuilds the open picker (or closes it), so the cached
		// option nodes must be re-pointed in pickerNode() or dropped entirely.
		pickerRefs = null;
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
			const costMeta = state.report.costMeta ?? {};
			if (costMeta.summary) {
				sub.textContent += ` | cost: ${costMeta.summary.total} known (${costMeta.summary.priced} priced, ${costMeta.summary.free} free)`;
			} else if (costMeta.missing) {
				sub.textContent += " | cost: no table";
			}
			sub.title = [state.report.catalogSource ?? "", costMeta.missing ? costMeta.hint : "", costMeta.generatedAt ? `costs generated ${costMeta.generatedAt}` : ""]
				.filter(Boolean)
				.join(" | ");
			renderConfigBar();
			renderBulkBar();

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
			state.configs = payload.configs ?? [];
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

// Inject at import time, not only inside mount(): the manifest sets "preload": true,
// so this module is imported when the first browser attaches, while mount() runs
// only when the page actually opens. Without this, the chat-bar button would be
// unstyled (host pill default) until the page had been opened once.
// Never throws: a broken injection must not kill module load (the host would
// replace the plugin pane with an opaque fallback on the next mount attempt).
try {
	injectStyles();
} catch {
	/* headless / missing document — mount() retries */
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
