/**
 * client.test.mjs — regression harness for the agent-models CLIENT half.
 *
 * WHY THIS EXISTS: every bug this plugin shipped lived in the client, and none of them
 * were caught by the 35 server-side tests:
 *   1. a picker whose tail referenced a variable removed in a refactor -> the panel
 *      rendered "Render failed" and the picker never opened;
 *   2. an id-only stylesheet guard that pinned the first deploy's CSS for the life of
 *      the page, so later style changes were silently ignored (new DOM, stale CSS);
 *   3. a flex container that squashed rows instead of scrolling, which no server test
 *      could see.
 * A fake DOM is enough to catch that class of bug: it has to mount, open a picker,
 * filter, apply and roll back without throwing, and it has to produce the right DOM.
 * It is a net for wiring mistakes, NOT a substitute for the browser check.
 *
 * Run: node --test .pi/web-plugins/agent-models/client.test.mjs
 */

import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";

// ---------------------------------------------------------------------------
// Minimal DOM. Only what the client actually touches: element tree, attributes,
// class list, text content, listeners, the few geometry calls the diag line makes.
// ---------------------------------------------------------------------------

let doc;

class FakeNode {
	constructor(tag) {
		this.tagName = String(tag || "div").toUpperCase();
		this.children = [];
		this.parentNode = null;
		this.attributes = new Map();
		this.className = "";
		this.id = "";
		this.style = {};
		this.value = "";
		this.title = "";
		this.disabled = false;
		this._text = "";
		this._listeners = new Map();
	}

	get textContent() {
		// Real DOM behaviour: a node can hold its own text AND children (setting
		// textContent wipes children, appending afterwards keeps both). The earlier
		// version returned only the children, which hid error-box text in assertions.
		return this._text + this.children.map((c) => c.textContent).join("");
	}
	set textContent(v) {
		this.children = [];
		this._text = v === undefined || v === null ? "" : String(v);
	}
	set innerHTML(v) {
		this.textContent = v;
	}

	get classList() {
		const self = this;
		// recompute each access: className is assigned directly in places
		const list = () => self.className.split(/\s+/).filter(Boolean);
		return {
			contains: (c) => list().includes(c),
			add: (c) => {
				self.className = [...new Set([...list(), c])].join(" ");
			},
			remove: (c) => {
				self.className = list().filter((x) => x !== c).join(" ");
			},
		};
	}

	appendChild(node) {
		if (node.parentNode) node.parentNode.removeChild(node);
		node.parentNode = this;
		this.children.push(node);
		return node;
	}
	append(...nodes) {
		for (const n of nodes) this.appendChild(n);
	}
	removeChild(node) {
		this.children = this.children.filter((c) => c !== node);
		node.parentNode = null;
		return node;
	}
	remove() {
		if (this.parentNode) this.parentNode.removeChild(this);
	}
	setAttribute(name, value) {
		this.attributes.set(name, String(value));
		if (name === "class") this.className = String(value);
		if (name === "id") this.id = String(value);
	}
	getAttribute(name) {
		return this.attributes.has(name) ? this.attributes.get(name) : null;
	}
	addEventListener(type, fn) {
		this._listeners.set(type, [...(this._listeners.get(type) ?? []), fn]);
	}
	removeEventListener(type, fn) {
		this._listeners.set(type, (this._listeners.get(type) ?? []).filter((f) => f !== fn));
	}
	dispatch(type, extra = {}) {
		if (type !== "click") {
			for (const fn of [...(this._listeners.get(type) ?? [])]) fn({ type, target: this, stopPropagation() {}, preventDefault() {}, ...extra });
			return;
		}
		// click events BUBBLE up the parentNode chain like the real DOM, unless a
		// listener calls stopPropagation() — this is what makes the outside-click
		// closer testable: without propagation the fixture never ran onDocumentClick,
		// which is why the dropdown-closed-in-same-tick bug was invisible to tests.
		const ev = { type, target: this, _stopped: false, stopPropagation() { ev._stopped = true; }, preventDefault() {}, ...extra };
		let node = this;
		while (node) {
			for (const fn of [...(node._listeners.get(type) ?? [])]) {
				fn(ev);
				if (ev._stopped) return;
			}
			node = node.parentNode;
		}
	}
	/** Browser-shaped event dispatch: accepts an "input"/"change" string or {type}. */
	dispatchEvent(event) {
		const type = typeof event === "string" ? event : String(event?.type ?? "");
		this.dispatch(type, { detail: event?.detail });
		return true;
	}
	click() {
		this.dispatch("click");
	}
	/** Node.contains(child): identity check by subtree walk (the entry's outside-click
	 * closer calls configBar.contains(target) — the classList contains is NOT this). */
	contains(child) {
		if (child === this) return true;
		return this.children.some((c) => c.contains(child));
	}
	focus() {
		doc.activeElement = this;
	}
	setSelectionRange() {}
	getBoundingClientRect() {
		return { width: 100, height: 20, top: 0, left: 0, bottom: 20, right: 100, x: 0, y: 0 };
	}
	getClientRects() {
		return [this.getBoundingClientRect()];
	}
	get isConnected() {
		let n = this;
		while (n.parentNode) n = n.parentNode;
		return n === doc;
	}
	querySelector(sel) {
		return queryAll(this, sel)[0] ?? null;
	}
	querySelectorAll(sel) {
		return queryAll(this, sel);
	}
	/** Test helper: walk the subtree, return every node matching a predicate. */
	findAll(pred, out = []) {
		for (const c of this.children) {
			if (pred(c)) out.push(c);
			c.findAll(pred, out);
		}
		return out;
	}
	/** Test helper: click the first descendant matching a predicate. */
	clickFirst(pred) {
		const hit = this.findAll(pred)[0];
		if (!hit) return false;
		hit.click();
		return true;
	}
}

function descendants(node, out = []) {
	for (const c of node.children) {
		out.push(c);
		descendants(c, out);
	}
	return out;
}

function parsePart(part) {
	const m = { tag: null, classes: [], attrs: [] };
	const re = /([a-zA-Z]+)|\.([A-Za-z0-9_-]+)|\[([A-Za-z0-9_-]+)(?:="([^"]*)")?\]/g;
	let hit;
	while ((hit = re.exec(part))) {
		if (hit[1]) m.tag = hit[1].toUpperCase();
		else if (hit[2]) m.classes.push(hit[2]);
		else if (hit[3]) m.attrs.push([hit[3], hit[4]]);
	}
	return m;
}

function matchPart(node, m) {
	if (m.tag && node.tagName !== m.tag) return false;
	for (const c of m.classes) if (!node.classList.contains(c)) return false;
	for (const [k, v] of m.attrs) {
		const val = node.getAttribute(k);
		if (v === undefined ? val === null : val !== v) return false;
	}
	return true;
}

/** Descendant-combinator selector support: ".a .b[attr=v]" and single parts. */
function queryAll(root, selector) {
	const parts = String(selector).trim().split(/\s+/).map(parsePart);
	const last = parts[parts.length - 1];
	return descendants(root).filter((node) => {
		if (!matchPart(node, last)) return false;
		let i = parts.length - 2;
		let cur = node.parentNode;
		while (i >= 0 && cur && cur !== root) {
			if (matchPart(cur, parts[i])) i--;
			cur = cur.parentNode;
		}
		return i < 0;
	});
}

function makeDocument() {
	const document = new FakeNode("#document");
	document.head = document.appendChild(new FakeNode("head"));
	document.body = document.appendChild(new FakeNode("body"));
	document.activeElement = null;
	document.createElement = (tag) => new FakeNode(tag);
	document.getElementById = (id) =>
		descendants(document).find((n) => n.id === id || n.getAttribute("id") === id) ?? null;
	return document;
}

// ---------------------------------------------------------------------------
// Fixtures: a state payload with one OK/priced agent, one dead pin, one inherit.
// ---------------------------------------------------------------------------

const STATE = {
	ok: true,
	agentsDir: ".pi/agents",
	counts: { total: 3, ok: 1, dropped: 1, unresolved: 0, inherit: 1, warnings: 0, problems: 2 },
	rows: [
		{
			name: "coder",
			pin: "commandcode/Qwen/Qwen3.6-Plus",
			status: "ok",
			statusLabel: "OK",
			severity: 0,
			effective: "commandcode/Qwen/Qwen3.6-Plus",
			effectiveLabel: "commandcode/Qwen/Qwen3.6-Plus",
			why: "resolves via provider commandcode",
			warnings: [],
			costShort: "$0.5/$3",
			costTitle: "input $0.5 / output $3 USD per million tokens",
			tier: "mid",
			vision: true,
			contextWindow: 200000,
			backups: 2,
		},
		{
			name: "reviewer",
			pin: "opencode/mimo-v2.5-free",
			status: "dropped",
			statusLabel: "DEAD PIN",
			severity: 2,
			effective: null,
			effectiveLabel: "main conversation model",
			why: 'dispatcher drops "opencode/*" pins',
			warnings: [],
			costShort: "n/a",
			costTitle: null,
			tier: null,
			backups: 0,
		},
		{
			name: "vision",
			pin: null,
			status: "inherit",
			statusLabel: "INHERIT",
			severity: 1,
			effective: null,
			effectiveLabel: "main conversation model",
			why: "no model pin",
			warnings: [],
			costShort: null,
			costTitle: null,
			tier: null,
			backups: 1,
		},
	],
	catalog: [
		"commandcode/Qwen/Qwen3.6-Plus",
		"commandcode/z-ai/glm-5.3-flash",
		"nvidia/meta/llama-3.2-90b-vision-instruct",
		"opencode/legacy-model",
	],
	models: {
		"commandcode/Qwen/Qwen3.6-Plus": { short: "$0.5/$3", title: "src commandcode-docs", tier: "mid", vision: true, largeContext: true, contextWindow: 200000, provider: "commandcode" },
		"commandcode/z-ai/glm-5.3-flash": { short: "$0.15/$0.5", title: "src commandcode-docs", tier: "budget", vision: true, largeContext: true, contextWindow: 1048576, provider: "commandcode" },
		"nvidia/meta/llama-3.2-90b-vision-instruct": { short: "free", title: "free endpoints", tier: "free", vision: true, largeContext: false, contextWindow: 128000, provider: "nvidia" },
		"opencode/legacy-model": { short: "n/a", title: "no pricing data", tier: "unknown", vision: false, largeContext: false, contextWindow: null, provider: "opencode" },
	},
	facets: {
		providers: [
			{ id: "commandcode", count: 2 },
			{ id: "nvidia", count: 1 },
			{ id: "opencode", count: 1 },
		],
		tiers: [
			{ id: "mid", count: 1 },
			{ id: "budget", count: 1 },
			{ id: "free", count: 1 },
			{ id: "unknown", count: 1 },
		],
		capabilities: [
			{ id: "vision", label: "Vision", count: 3 },
			{ id: "largeContext", label: "200K+ context", count: 2 },
		],
	},
	costMeta: { path: ".pi/agent-models/costs.json", generatedAt: "2026-09-25T00:00:00.000Z", summary: { total: 530, priced: 451, free: 79 } },
	configs: [],
};

/** STATE variant that has a saved configuration, for apply/delete tests. */
const STATE_WITH_CONFIG = { ...STATE, configs: [{ id: "free-tier", name: "Free Tier", description: "All free models", createdAt: "2026-09-25T00:00:00.000Z", updatedAt: "2026-09-25T12:00:00.000Z", agentCount: 3 }] };

/** Deterministic fetch stand-in. Records every call into the array it is given. */
function makeFetch(calls) {
	const impl = async (url, init = {}) => {
		const method = init.method ?? "GET";
		const body = init.body ? JSON.parse(init.body) : null;
		calls.push({ url: String(url), method, body });
		if (String(url).includes("/set-model")) {
			return { ok: true, status: 200, json: async () => ({ ok: true, agent: body.agent, model: body.model, previous: "commandcode/z-ai/glm-5.3-flash", changed: true, backup: ".pi/agent-models/backups/coder-1.md", report: STATE }) };
		}
		if (String(url).includes("/restore")) {
			return { ok: true, status: 200, json: async () => ({ ok: true, agent: body.agent, restoredFrom: "coder-1.md", safety: ".pi/agent-models/backups/coder-2.md", report: STATE }) };
		}
		return { ok: true, status: 200, json: async () => STATE };
	};
	return { impl, calls };
}

let client;
let fetchCalls = [];

beforeEach(async () => {
	doc = makeDocument();
	globalThis.document = doc;
	globalThis.window = { __piWebUiHost: {} };
	// The poll interval would keep node alive and fire mid-test; stub it out.
	globalThis.setInterval = () => 0;
	globalThis.clearInterval = () => {};
	fetchCalls = [];
	globalThis.fetch = makeFetch(fetchCalls).impl;
	globalThis.confirm = () => true;
	if (!client) client = (await import("./client/entry.mjs")).default;
});

function mountFresh() {
	const container = doc.body.appendChild(new FakeNode("div"));
	container.className = "plugin-view";
	const cleanup = client.mount(container, { send() {}, onData() {} });
	return { container, cleanup };
}

const rowOf = (container, agent) => container.querySelector(`.am-row[data-am-agent="${agent}"]`);
const pickerOf = (container, agent) => container.querySelector(`.am-row[data-am-agent="${agent}"] .am-picker`);
const optionIds = (container) => container.querySelectorAll(".am-option").map((o) => o.getAttribute("data-am-option"));

describe("agent-models client: mount", () => {
	it("mounts without throwing and renders one row per agent", async () => {
		const { container } = mountFresh();
		await new Promise((r) => setTimeout(r, 5));
		assert.equal(container.querySelectorAll(".am-row").length, 3);
		assert.ok(container.querySelector('.am-row[data-am-agent="coder"]'), "coder row exists");
		assert.ok(container.querySelector('.am-row[data-am-agent="reviewer"]'), "reviewer row exists");
	});

	it("shows the status, the pin and a cost chip per row", async () => {
		const { container } = mountFresh();
		await new Promise((r) => setTimeout(r, 5));
		const coder = rowOf(container, "coder");
		assert.match(coder.textContent, /commandcode\/Qwen\/Qwen3\.6-Plus/);
		assert.equal(coder.querySelector(".am-badge").textContent, "OK");
		assert.equal(coder.querySelector(".am-cost").textContent, "$0.5/$3");
		assert.equal(coder.getAttribute("data-am-status"), "ok");
	});

	it("reports its own state in the diagnostic line (visible, mounts, fetch ok)", async () => {
		const { container } = mountFresh();
		await new Promise((r) => setTimeout(r, 5));
		const diag = container.querySelector(".am-diag").textContent;
		assert.match(diag, /mounts 1/);
		assert.match(diag, /visible/);
		assert.match(diag, /fetch ok/);
		assert.match(diag, /agents 3/);
	});
});

describe("agent-models client: the picker", () => {
	it("opens when the ROW is clicked (not just a button), and closes on a second click", async () => {
		const { container } = mountFresh();
		await new Promise((r) => setTimeout(r, 5));
		assert.equal(pickerOf(container, "coder"), null, "closed initially");

		rowOf(container, "coder").querySelector('[data-am-action="pick"]').click();
		await new Promise((r) => setTimeout(r, 5));
		assert.ok(pickerOf(container, "coder"), "picker opened by the row click");
		assert.ok(pickerOf(container, "coder").querySelector('[data-am-action="search"]'), "search box present");

		rowOf(container, "coder").querySelector('[data-am-action="pick"]').click();
		await new Promise((r) => setTimeout(r, 5));
		assert.equal(pickerOf(container, "coder"), null, "second click closed it");
	});

	it("renders each agent row as ONE vertically centered line (no stacked sub-rows)", async () => {
		const { container } = mountFresh();
		await new Promise((r) => setTimeout(r, 5));
		const row = container.querySelector('[data-am-agent="coder"]');
		const line = row.querySelector(".am-row-line");
		const toggle = line.querySelector('[data-am-action="pick"]');
		// The toggle must be a single horizontal flex line: no .am-row-top wrapper, no
		// .am-note / .am-warn block children that would stack the row taller.
		assert.equal(row.querySelector(".am-row-top"), null, "no stacked top-line wrapper");
		assert.equal(toggle.querySelector(".am-note"), null, "notes do not stack the row");
		assert.equal(toggle.querySelector(".am-warn"), null, "warnings do not stack the row");
		// Everything meaningful lives directly on that one line, in reading order.
		const kids = toggle.children;
		assert.ok(kids.length >= 4, "line carries name, badge, models, caret");
		assert.ok(kids[0].className.includes("am-name"), "name first");
		assert.ok(kids[1].className.includes("am-badge"), "status badge second");
		assert.ok(kids[2].className.includes("am-models"), "pin -> effective third");
		assert.equal(kids[kids.length - 1].className, "am-caret", "caret last");
		// Warnings collapse to an inline truncating marker with the full text as a tooltip.
		const reviewer = container.querySelector('[data-am-agent="reviewer"]');
		const mark = reviewer.querySelector(".am-issues");
		assert.ok(mark, "a row with warnings shows an inline issues marker");
		assert.ok(mark.title.length > 0, "full warning text lives in the title tooltip");
		assert.match(mark.textContent, /issue|warn|pin|model/i, "marker is short plain text, not a warning block");
	});

	it("renders the selection checkbox inline LEFT of the title (no extra row height)", async () => {
		const { container } = mountFresh();
		await new Promise((r) => setTimeout(r, 5));
		const row = container.querySelector('[data-am-agent="coder"]');
		const box = row.querySelector('[data-am-select="coder"]');
		const toggle = row.querySelector('[data-am-action="pick"]');
		// Both must share ONE horizontal line container, and the checkbox must come first,
		// so the checkbox costs no vertical height.
		const line = row.querySelector(".am-row-line");
		assert.ok(line, "row has an .am-row-line container");
		assert.equal(line.children[0], box, "checkbox is the FIRST child (left of the title)");
		assert.equal(line.children[1], toggle, "row toggle follows the checkbox on the same line");
		// The picker still stacks BELOW the line (full width) when the row is open.
		line.querySelector('[data-am-action="pick"]').click();
		await new Promise((r) => setTimeout(r, 5));
		const row2 = container.querySelector('[data-am-agent="coder"]');
		assert.ok(row2.querySelector(".am-picker"), "picker renders under the compact line");
		assert.equal(row2.querySelector(".am-row-line").contains(row2.querySelector(".am-picker")), false, "picker is NOT inside the line");
		// Ticking the checkbox must not OPEN the picker: close the row first, then tick.
		// Re-query: render() rebuilt the row, so the old node's closure is stale.
		container.querySelector('[data-am-agent="coder"]').querySelector('[data-am-action="pick"]').click();
		await new Promise((r) => setTimeout(r, 5));
		assert.equal(pickerOf(container, "coder"), null, "row closed again");
		const box2 = container.querySelector('[data-am-select="coder"]');
		box2.checked = true;
		box2.dispatchEvent("change");
		await new Promise((r) => setTimeout(r, 5));
		assert.equal(pickerOf(container, "coder"), null, "ticking the checkbox does not open the row picker");
		assert.equal(container.querySelector("[data-am-bulk-count]").getAttribute("data-am-bulk-count"), "1", "but it does select the agent");
	});

	it("lists every catalog model plus the inherit option, with tier and cost badges", async () => {
		const { container } = mountFresh();
		await new Promise((r) => setTimeout(r, 5));
		rowOf(container, "coder").querySelector('[data-am-action="pick"]').click();
		await new Promise((r) => setTimeout(r, 5));

		const ids = optionIds(container);
		assert.equal(ids[0], "__inherit__", "inherit sits first");
		assert.equal(ids.length, STATE.catalog.length + 1);
		const priced = container.querySelector('[data-am-option="commandcode/Qwen/Qwen3.6-Plus"]');
		assert.equal(priced.querySelector(".am-option-cost").textContent, "$0.5/$3");
		assert.match(priced.querySelector(".am-option-tier").textContent, /mid/);
		assert.ok(priced.querySelectorAll(".am-option-cap").length >= 1, "vision/large-context badges");
	});

	it("filters by provider, by tier and by capability", async () => {
		const { container } = mountFresh();
		await new Promise((r) => setTimeout(r, 5));
		rowOf(container, "coder").querySelector('[data-am-action="pick"]').click();
		await new Promise((r) => setTimeout(r, 5));

		container.querySelector('[data-am-provider="nvidia"]').click();
		assert.deepEqual(optionIds(container), ["__inherit__", "nvidia/meta/llama-3.2-90b-vision-instruct"]);
		assert.equal(container.querySelector('[data-am-provider="nvidia"]').getAttribute("aria-pressed"), "true");

		container.querySelector('[data-am-provider="all"]').click();
		container.querySelector('[data-am-tier="budget"]').click();
		assert.deepEqual(optionIds(container), ["__inherit__", "commandcode/z-ai/glm-5.3-flash"]);

		container.querySelector('[data-am-tier="all"]').click();
		container.querySelector('[data-am-capability="vision"]').click();
		assert.deepEqual(optionIds(container), [
			"__inherit__",
			"commandcode/Qwen/Qwen3.6-Plus",
			"commandcode/z-ai/glm-5.3-flash",
			"nvidia/meta/llama-3.2-90b-vision-instruct",
		]);

		container.querySelector('[data-am-capability="all"]').click();
		container.querySelector('[data-am-capability="largeContext"]').click();
		assert.deepEqual(optionIds(container), ["__inherit__", "commandcode/Qwen/Qwen3.6-Plus", "commandcode/z-ai/glm-5.3-flash"]);
	});

	it("narrows with the search box without rebuilding the whole row set", async () => {
		const { container } = mountFresh();
		await new Promise((r) => setTimeout(r, 5));
		rowOf(container, "coder").querySelector('[data-am-action="pick"]').click();
		await new Promise((r) => setTimeout(r, 5));

		const input = pickerOf(container, "coder").querySelector('[data-am-action="search"]');
		input.click();
		input.value = "glm";
		input.dispatchEvent("input");
		assert.deepEqual(optionIds(container), ["__inherit__", "commandcode/z-ai/glm-5.3-flash"]);
		assert.equal(container.querySelector(".am-picker-count").textContent, "1");
	});
});

describe("agent-models client: writes", () => {
	it("POSTs the chosen model and shows the backup in the saved note", async () => {
		const { container } = mountFresh();
		await new Promise((r) => setTimeout(r, 5));
		rowOf(container, "coder").querySelector('[data-am-action="pick"]').click();
		await new Promise((r) => setTimeout(r, 5));

		container.querySelector('[data-am-option="commandcode/z-ai/glm-5.3-flash"]').click();
		await new Promise((r) => setTimeout(r, 10));

		const post = fetchCalls.find((c) => c.url.includes("/set-model"));
		assert.ok(post, "a POST /set-model call was made");
		assert.equal(post.method, "POST");
		assert.deepEqual(post.body, { agent: "coder", model: "commandcode/z-ai/glm-5.3-flash" });
		const note = rowOf(container, "coder").querySelector(".am-saved");
		assert.ok(note, "a saved note appeared");
		assert.match(note.textContent, /backup .*coder-1\.md/);
		assert.match(container.querySelector(".am-diag").textContent, /write coder @/);
	});

	it("offers rollback only when a backup exists, and POSTs /restore with the agent", async () => {
		const { container } = mountFresh();
		await new Promise((r) => setTimeout(r, 5));

		rowOf(container, "reviewer").querySelector('[data-am-action="pick"]').click();
		await new Promise((r) => setTimeout(r, 5));
		assert.equal(pickerOf(container, "reviewer").querySelector('[data-am-action="restore"]'), null, "no backups -> no rollback");

		rowOf(container, "reviewer").querySelector('[data-am-action="pick"]').click();
		rowOf(container, "coder").querySelector('[data-am-action="pick"]').click();
		await new Promise((r) => setTimeout(r, 5));
		const rollback = pickerOf(container, "coder").querySelector('[data-am-action="restore"]');
		assert.ok(rollback, "coder has 2 backups -> rollback offered");
		assert.match(rollback.textContent, /2 backups/);

		rollback.click();
		await new Promise((r) => setTimeout(r, 10));
		const post = fetchCalls.find((c) => c.url.includes("/restore"));
		assert.ok(post, "a POST /restore call was made");
		assert.deepEqual(post.body, { agent: "coder" });
		const note = rowOf(container, "coder").querySelector(".am-saved");
		assert.ok(note, "a rollback note appeared");
		assert.match(note.textContent, /rolled back to coder-1\.md/);
		assert.match(container.querySelector(".am-diag").textContent, /coder rollback @/);
	});
});

describe("agent-models client: stylesheet guard (the stale-CSS regression)", () => {
	it("replaces a stale style element instead of skipping injection", async () => {
		mountFresh();
		await new Promise((r) => setTimeout(r, 5));
		const style = doc.getElementById("agent-models-style");
		assert.ok(style, "the stylesheet was injected");
		assert.match(style.textContent, /am-row-toggle\{/, "current CSS present");

		// Simulate the old bug: a page carrying an older stylesheet with the same id.
		style.textContent = "/* stale rules from a previous deploy */";
		mountFresh();
		await new Promise((r) => setTimeout(r, 5));
		const after = doc.getElementById("agent-models-style");
		assert.match(after.textContent, /am-row-toggle\{/, "content compare rewrote the stale sheet");
		assert.ok(!after.textContent.includes("stale rules"), "stale content gone");
	});

	it("ships a vertically centered rule for the bulk note (no inherited row padding)", async () => {
		mountFresh();
		await new Promise((r) => setTimeout(r, 5));
		const css = doc.getElementById("agent-models-style").textContent;
		// The bulk summary must NOT reuse .am-saved, whose padding:0 8px 8px was sized
		// for the per-row saved line and pushes the text off the bar's vertical center.
		const rule = css.match(/\.am-bulk-note\{[^}]*\}/);
		assert.ok(rule, "a dedicated .am-bulk-note rule ships");
		assert.match(rule[0], /align-self:center/, "the note is centered vertically");
		assert.match(rule[0], /line-height:1\.4/, "an explicit line-height centers the glyphs in the box");
		assert.ok(!/padding:[^;]*8px/.test(rule[0]), "no row-oriented bottom padding leaks in");
	});
});

describe("agent-models client: robustness", () => {
	it("mount() survives a payload with no facets, models or costs map", async () => {
		globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => ({ ...STATE, models: undefined, facets: undefined, costs: undefined, costMeta: undefined }) });
		const { container } = mountFresh();
		await new Promise((r) => setTimeout(r, 5));
		assert.equal(container.querySelectorAll(".am-row").length, 3);
		rowOf(container, "coder").querySelector('[data-am-action="pick"]').click();
		await new Promise((r) => setTimeout(r, 5));
		assert.ok(pickerOf(container, "coder"), "picker still opens without facets");
		assert.ok(optionIds(container).length >= 1);
	});

	it("surfaces a fetch failure in the panel instead of rendering nothing", async () => {
		globalThis.fetch = async () => ({ ok: false, status: 503, json: async () => ({}) });
		const { container } = mountFresh();
		await new Promise((r) => setTimeout(r, 5));
		const box = container.querySelector(".am-error");
		assert.ok(box, "an error box is shown");
		assert.match(box.textContent, /503/);
	});
});

describe("agent-models client: config bar", () => {
	it("renders the presets bar with select + save/apply/delete buttons when no configs exist", async () => {
		const { container } = mountFresh();
		await new Promise((r) => setTimeout(r, 5));
		const bar = container.querySelector(".am-configs-bar");
		assert.ok(bar, "config bar exists");
		assert.ok(bar.querySelector('[data-am-config-btn]'), "dropdown button exists");
		assert.ok(bar.querySelector('.am-options') === null, "options panel not open initially");
		assert.ok(bar.querySelector('[data-am-config-save]'), "save-current button exists");
		assert.ok(bar.querySelector('[data-am-config-apply]'), "apply button exists");
		assert.ok(bar.querySelector('[data-am-config-delete]'), "delete button exists");
		// When no configs exist, the select prompt says "No saved presets"
		const btn = bar.querySelector('[data-am-config-btn]');
		assert.match(btn.textContent, /No saved presets/);
	});

	it("keeps the presets dropdown open when the toggle click bubbles to the document (regression: the old code closed it in the same tick)", async () => {
		const { container } = mountFresh();
		await new Promise((r) => setTimeout(r, 5));
		const bar = container.querySelector(".am-configs-bar");
		const btn = bar.querySelector('[data-am-config-btn]');
		btn.click();
		// The FakeNode now models real click bubbling: without the toggle's
		// stopPropagation() the document-level outside-click handler would see the
		// ORIGINAL (rebuilt-away) button node as "outside" and close the menu in the
		// same tick. Found live via the CDP UI drive; this test pins the fix.
		await new Promise((r) => setTimeout(r, 5));
		assert.ok(bar.querySelector('[data-am-config-options]'), "options panel stays open after the toggle click");
		// a click OUTSIDE the bar still closes it
		doc.body.click();
		await new Promise((r) => setTimeout(r, 5));
		assert.equal(bar.querySelector('[data-am-config-options]'), null, "outside click closes the dropdown");
	});

	it("enables the save button when a name is typed, even without a description", async () => {
		const { container } = mountFresh();
		await new Promise((r) => setTimeout(r, 5));
		const bar = container.querySelector(".am-configs-bar");
		bar.querySelector('[data-am-config-save]').click();
		await new Promise((r) => setTimeout(r, 5));
		// Save button should be disabled initially (empty name)
		const saveSubmit = bar.querySelector('[data-am-config-save-submit]');
		assert.ok(saveSubmit, "save-submit is visible");
		assert.equal(saveSubmit.disabled, true, "save-submit is disabled when name is empty");
		// Type a name — should enable the button immediately
		const nameInput = bar.querySelector('[data-am-config-name]');
		nameInput.value = "Free Tier";
		nameInput.dispatchEvent("input");
		await new Promise((r) => setTimeout(r, 5));
		const saveSubmit2 = bar.querySelector('[data-am-config-save-submit]');
		assert.equal(saveSubmit2.disabled, false, "save-submit is enabled when name is filled, no description needed");
		// Typing must NOT rebuild the bar DOM: the input node we typed into must still be
		// the same node in the DOM (a re-render would replace it and steal focus).
		assert.equal(bar.querySelector('[data-am-config-name]'), nameInput, "name input node survives typing (no re-render, focus kept)");
		const descInput = bar.querySelector('[data-am-config-desc]');
		descInput.value = "optional desc";
		descInput.dispatchEvent("input");
		await new Promise((r) => setTimeout(r, 5));
		assert.equal(bar.querySelector('[data-am-config-desc]'), descInput, "desc textarea node survives typing (no re-render, focus kept)");
		assert.equal(bar.querySelector('[data-am-config-name]').value, "Free Tier", "typed name is preserved");
	});

	it("opens the inline save form when 'Save current' is clicked", async () => {
		const { container } = mountFresh();
		await new Promise((r) => setTimeout(r, 5));
		const bar = container.querySelector(".am-configs-bar");
		bar.querySelector('[data-am-config-save]').click();
		await new Promise((r) => setTimeout(r, 5));
		assert.ok(bar.querySelector('[data-am-config-name]'), "name input is visible");
		assert.ok(bar.querySelector('[data-am-config-desc]'), "desc textarea is visible");
		assert.ok(bar.querySelector('[data-am-config-save-submit]'), "save-submit button is visible");
	});

	it("edits a selected config: Edit button opens save form with current name/desc", async () => {
		globalThis.fetch = async (url, init = {}) => {
			const method = init.method ?? "GET";
			const body = init.body ? JSON.parse(init.body) : null;
			fetchCalls.push({ url: String(url), method, body });
			if (String(url).includes("/state")) return { ok: true, status: 200, json: async () => STATE_WITH_CONFIG };
			if (String(url).includes("/configs/save")) return { ok: true, status: 200, json: async () => ({ ok: true, config: { id: "free-tier", name: body.name, description: body.description, agentCount: 3 }, report: { ...STATE_WITH_CONFIG, configs: [{ id: "free-tier", name: body.name, description: body.description, createdAt: "2026-09-25T12:00:00Z", updatedAt: "2026-09-25T12:00:00Z", agentCount: 3 }] } }) };
			return { ok: true, status: 200, json: async () => STATE_WITH_CONFIG };
		};
		const { container } = mountFresh();
		await new Promise((r) => setTimeout(r, 5));
		const bar = container.querySelector(".am-configs-bar");
		// Open dropdown and select a preset
		bar.querySelector('[data-am-config-btn]').click();
		await new Promise((r) => setTimeout(r, 5));
		bar.querySelector('[data-am-config-option="free-tier"]').click();
		await new Promise((r) => setTimeout(r, 5));
		// Click Edit
		bar.querySelector('[data-am-config-edit]').click();
		await new Promise((r) => setTimeout(r, 5));
		// Form should be open with the config's name/description pre-filled
		const nameInput = bar.querySelector('[data-am-config-name]');
		assert.ok(nameInput, "name input is visible in edit form");
		assert.equal(nameInput.value, "Free Tier", "name is pre-filled with current config name");
		// Change the name
		nameInput.value = "Budget Tier";
		nameInput.dispatchEvent("input");
		await new Promise((r) => setTimeout(r, 5));
		// Save
		bar.querySelector('[data-am-config-save-submit]').click();
		await new Promise((r) => setTimeout(r, 10));
		// Verify POST includes editId
		const saveCall = fetchCalls.find((c) => c.url.includes("/configs/save"));
		assert.ok(saveCall, "POST /configs/save was made");
		assert.equal(saveCall.body.name, "Budget Tier");
		assert.equal(saveCall.body.editId, "free-tier", "editId is sent when editing");
	});

	it("saves a named config via POST /configs/save and closes the form", async () => {
		const { container } = mountFresh();
		await new Promise((r) => setTimeout(r, 5));
		const bar = container.querySelector(".am-configs-bar");
		bar.querySelector('[data-am-config-save]').click();
		await new Promise((r) => setTimeout(r, 5));
		// Type a name
		const nameInput = bar.querySelector('[data-am-config-name]');
		nameInput.value = "My Setup";
		nameInput.dispatchEvent("input");
		await new Promise((r) => setTimeout(r, 5));
		// Save
		bar.querySelector('[data-am-config-save-submit]').click();
		await new Promise((r) => setTimeout(r, 10));
		// Verify POST
		const saveCall = fetchCalls.find((c) => c.url.includes("/configs/save"));
		assert.ok(saveCall, "POST /configs/save was made");
		assert.equal(saveCall.body.name, "My Setup");
		// Form is closed, dropdown is shown
		assert.equal(bar.querySelector('[data-am-config-name]'), null, "name input is gone (form closed)");
		assert.ok(bar.querySelector('[data-am-config-select]'), "select is back after save");
		// Diag records the write
		assert.match(container.querySelector(".am-diag").textContent, /save-config/);
	});

	it("does not save when the name is empty", async () => {
		const { container } = mountFresh();
		await new Promise((r) => setTimeout(r, 5));
		const bar = container.querySelector(".am-configs-bar");
		bar.querySelector('[data-am-config-save]').click();
		await new Promise((r) => setTimeout(r, 5));
		// Type and then clear
		const nameInput = bar.querySelector('[data-am-config-name]');
		nameInput.value = "";
		nameInput.dispatchEvent("input");
		await new Promise((r) => setTimeout(r, 5));
		bar.querySelector('[data-am-config-save-submit]').click();
		await new Promise((r) => setTimeout(r, 10));
		const saveCall = fetchCalls.find((c) => c.url.includes("/configs/save"));
		assert.equal(saveCall, undefined, "no POST /configs/save when name is empty");
	});

	it("applies a selected preset via POST /configs/apply", async () => {
		// Override fetch so /state returns a config list
		globalThis.fetch = async (url, init = {}) => {
			const method = init.method ?? "GET";
			const body = init.body ? JSON.parse(init.body) : null;
			fetchCalls.push({ url: String(url), method, body });
			if (String(url).includes("/state")) return { ok: true, status: 200, json: async () => STATE_WITH_CONFIG };
			if (String(url).includes("/configs/apply")) return { ok: true, status: 200, json: async () => ({ ok: true, id: body.id, name: "Free Tier", summary: { applied: 3, invalid: 0 }, report: STATE_WITH_CONFIG }) };
			return { ok: true, status: 200, json: async () => STATE_WITH_CONFIG };
		};
		const { container } = mountFresh();
		await new Promise((r) => setTimeout(r, 5));
		const bar = container.querySelector(".am-configs-bar");
		// Open the dropdown and select a preset
		const btn = bar.querySelector('[data-am-config-btn]');
		assert.ok(btn, "dropdown button exists");
		btn.click();
		await new Promise((r) => setTimeout(r, 5));
		const option = bar.querySelector('[data-am-config-option="free-tier"]');
		assert.ok(option, "free-tier option is visible in dropdown");
		option.click();
		await new Promise((r) => setTimeout(r, 5));
		// Apply
		bar.querySelector('[data-am-config-apply]').click();
		await new Promise((r) => setTimeout(r, 10));
		// Verify POST
		const applyCall = fetchCalls.find((c) => c.url.includes("/configs/apply"));
		assert.ok(applyCall, "POST /configs/apply was made");
		assert.deepEqual(applyCall.body, { id: "free-tier" });
		// Diag records the write
		assert.match(container.querySelector(".am-diag").textContent, /write apply:free-tier/);
	});

	it("adopts the roster returned by a preset apply WITHOUT waiting for the next poll", async () => {
		// The server rebuilds the roster inside the apply response. If the client throws
		// that away, the rows stay stale until the 15s POLL_MS tick - the bug this guards.
		const before = STATE.rows[0].pin;
		const after = "commandcode/z-ai/glm-5.3-flash";
		const APPLIED = { ...STATE_WITH_CONFIG, rows: STATE.rows.map((r) => (r.name === STATE.rows[0].name ? { ...r, pin: after, status: "ok" } : r)) };
		globalThis.fetch = async (url, init = {}) => {
			const method = init.method ?? "GET";
			const body = init.body ? JSON.parse(init.body) : null;
			fetchCalls.push({ url: String(url), method, body });
			if (String(url).includes("/state")) return { ok: true, status: 200, json: async () => STATE_WITH_CONFIG };
			if (String(url).includes("/configs/apply")) return { ok: true, status: 200, json: async () => ({ ok: true, id: body.id, name: "Free Tier", summary: { applied: 1, invalid: 0 }, report: APPLIED }) };
			return { ok: true, status: 200, json: async () => STATE_WITH_CONFIG };
		};
		const { container } = mountFresh();
		await new Promise((r) => setTimeout(r, 5));
		const bar = container.querySelector(".am-configs-bar");
		bar.querySelector('[data-am-config-btn]').click();
		await new Promise((r) => setTimeout(r, 5));
		bar.querySelector('[data-am-config-option="free-tier"]').click();
		await new Promise((r) => setTimeout(r, 5));
		const target = STATE.rows[0].name;
		assert.equal(rowOf(container, target).querySelector(".am-pin").textContent, before, "starts on the old pin");
		bar.querySelector('[data-am-config-apply]').click();
		await new Promise((r) => setTimeout(r, 10));
		// Rows already show the NEW pin, with no further /state request.
		assert.equal(rowOf(container, target).querySelector(".am-pin").textContent, after, "rows updated straight from the apply response");
		const stateFetches = fetchCalls.filter((c) => c.url.includes("/state"));
		assert.equal(stateFetches.length, 1, "no extra /state fetch was needed (the poll did not mask this)");
	});

	it("shows an error when apply returns an error payload", async () => {
		globalThis.fetch = async (url, init = {}) => {
			const method = init.method ?? "GET";
			const body = init.body ? JSON.parse(init.body) : null;
			fetchCalls.push({ url: String(url), method, body });
			if (String(url).includes("/state")) return { ok: true, status: 200, json: async () => STATE_WITH_CONFIG };
			if (String(url).includes("/configs/apply")) return { ok: false, status: 500, json: async () => ({ ok: false, error: "server exploded" }) };
			return { ok: true, status: 200, json: async () => STATE_WITH_CONFIG };
		};
		const { container } = mountFresh();
		await new Promise((r) => setTimeout(r, 5));
		const bar = container.querySelector(".am-configs-bar");
		const btn = bar.querySelector('[data-am-config-btn]');
		btn.click();
		await new Promise((r) => setTimeout(r, 5));
		bar.querySelector('[data-am-config-option="free-tier"]').click();
		await new Promise((r) => setTimeout(r, 5));
		bar.querySelector('[data-am-config-apply]').click();
		await new Promise((r) => setTimeout(r, 10));
		const err = bar.querySelector(".am-config-err");
		assert.ok(err, "an error is shown in the config bar");
		assert.match(err.textContent, /server exploded/);
	});

	it("deletes a selected preset via POST /configs/delete after confirmation", async () => {
		globalThis.fetch = async (url, init = {}) => {
			const method = init.method ?? "GET";
			const body = init.body ? JSON.parse(init.body) : null;
			fetchCalls.push({ url: String(url), method, body });
			if (String(url).includes("/state")) return { ok: true, status: 200, json: async () => STATE_WITH_CONFIG };
			if (String(url).includes("/configs/delete")) return { ok: true, status: 200, json: async () => ({ ok: true, deleted: body.id, configs: [] }) };
			return { ok: true, status: 200, json: async () => STATE_WITH_CONFIG };
		};
		const { container } = mountFresh();
		await new Promise((r) => setTimeout(r, 5));
		const bar = container.querySelector(".am-configs-bar");
		const btn = bar.querySelector('[data-am-config-btn]');
		btn.click();
		await new Promise((r) => setTimeout(r, 5));
		bar.querySelector('[data-am-config-option="free-tier"]').click();
		await new Promise((r) => setTimeout(r, 5));
		bar.querySelector('[data-am-config-delete]').click();
		await new Promise((r) => setTimeout(r, 10));
		// Verify POST
		const delCall = fetchCalls.find((c) => c.url.includes("/configs/delete"));
		assert.ok(delCall, "POST /configs/delete was made");
		assert.deepEqual(delCall.body, { id: "free-tier" });
		// Config removed: dropdown button shows "No saved presets" (configs is now empty)
		const newBar = container.querySelector(".am-configs-bar");
		const newBtn = newBar.querySelector('[data-am-config-btn]');
		assert.match(newBtn.textContent, /No saved presets/);
	});


it("bulk: ticking checkboxes selects agents and the bulk bar counts them", async () => {
		const { container } = mountFresh();
		await new Promise((r) => setTimeout(r, 5));
		const boxes = container.querySelectorAll('[data-am-select]');
		assert.ok(boxes.length >= 3, "every row has a selection checkbox");
		assert.equal(container.querySelector("[data-am-bulk-count]").getAttribute("data-am-bulk-count"), "0");
		boxes[0].checked = true;
		boxes[0].dispatchEvent("change");
		await new Promise((r) => setTimeout(r, 5));
		assert.equal(container.querySelector("[data-am-bulk-count]").getAttribute("data-am-bulk-count"), "1", "one agent selected");
		const box2 = container.querySelectorAll('[data-am-select]')[1];
		box2.checked = true;
		box2.dispatchEvent("change");
		await new Promise((r) => setTimeout(r, 5));
		assert.equal(container.querySelector("[data-am-bulk-count]").getAttribute("data-am-bulk-count"), "2", "two agents selected");
		// Unticking removes it again.
		const box1 = container.querySelectorAll('[data-am-select]')[0];
		box1.checked = false;
		box1.dispatchEvent("change");
		await new Promise((r) => setTimeout(r, 5));
		assert.equal(container.querySelector("[data-am-bulk-count]").getAttribute("data-am-bulk-count"), "1", "unticking decrements");
	});

	it("bulk: Select all selects every visible row, Clear empties the selection", async () => {
		const { container } = mountFresh();
		await new Promise((r) => setTimeout(r, 5));
		const total = container.querySelectorAll('[data-am-select]').length;
		container.querySelector("[data-am-bulk-all]").click();
		await new Promise((r) => setTimeout(r, 5));
		assert.equal(container.querySelector("[data-am-bulk-count]").getAttribute("data-am-bulk-count"), String(total), "Select all ticks every row");
		container.querySelector("[data-am-bulk-clear]").click();
		await new Promise((r) => setTimeout(r, 5));
		assert.equal(container.querySelector("[data-am-bulk-count]").getAttribute("data-am-bulk-count"), "0", "Clear empties the selection");
	});

	it("bulk: opening the bulk picker needs a selection and lists models", async () => {
		const { container } = mountFresh();
		await new Promise((r) => setTimeout(r, 5));
		assert.equal(container.querySelector("[data-am-bulk-open]").disabled, true, "disabled with no selection");
		container.querySelector("[data-am-bulk-all]").click();
		await new Promise((r) => setTimeout(r, 5));
		container.querySelector("[data-am-bulk-open]").click();
		await new Promise((r) => setTimeout(r, 5));
		assert.ok(container.querySelector("[data-am-bulk-search]"), "bulk search box is rendered");
		assert.ok(container.querySelectorAll("[data-am-bulk-option]").length > 1, "inherit + catalog models are listed");
	});

	it("bulk: quick-filter chips (provider / tier / capability) render in the bulk picker", async () => {
		const { container } = mountFresh();
		await new Promise((r) => setTimeout(r, 5));
		container.querySelector("[data-am-bulk-all]").click();
		await new Promise((r) => setTimeout(r, 5));
		container.querySelector("[data-am-bulk-open]").click();
		await new Promise((r) => setTimeout(r, 5));
		const picker = container.querySelector(".am-bulk-picker");
		assert.ok(picker, "bulk picker is open");
		assert.ok(picker.querySelector('[data-am-bulk-provider="all"]'), "provider chips present");
		assert.ok(picker.querySelector('[data-am-bulk-tier="all"]'), "tier chips present");
		assert.ok(picker.querySelector('[data-am-bulk-capability="all"]'), "capability chips present");
		// "All" is the pressed default on all three rows.
		assert.equal(picker.querySelector('[data-am-bulk-provider="all"]').getAttribute("aria-pressed"), "true");
		assert.equal(picker.querySelector('[data-am-bulk-tier="all"]').getAttribute("aria-pressed"), "true");
		assert.equal(picker.querySelector('[data-am-bulk-capability="all"]').getAttribute("aria-pressed"), "true");
		// Counts come from the same facets the single-agent picker uses.
		const nvidiaChip = picker.querySelector('[data-am-bulk-provider="nvidia"]');
		assert.ok(nvidiaChip, "facet-derived provider chip (nvidia) is rendered");
		assert.match(nvidiaChip.textContent, /\d/, "chip carries the facet count");
	});

	it("bulk: a provider chip narrows the bulk option list in place", async () => {
		const { container } = mountFresh();
		await new Promise((r) => setTimeout(r, 5));
		container.querySelector("[data-am-bulk-all]").click();
		await new Promise((r) => setTimeout(r, 5));
		container.querySelector("[data-am-bulk-open]").click();
		await new Promise((r) => setTimeout(r, 5));
		const before = container.querySelectorAll("[data-am-bulk-option]").length;
		container.querySelector('.am-bulk-picker [data-am-bulk-provider="nvidia"]').click();
		await new Promise((r) => setTimeout(r, 5));
		const options = [...container.querySelectorAll("[data-am-bulk-option]")];
		const modelOptions = options.filter((o) => o.getAttribute("data-am-bulk-option") !== "__inherit__");
		assert.ok(modelOptions.length > 0, "nvidia models remain");
		assert.ok(modelOptions.length < before - 1, `filtered from ${before} (got ${modelOptions.length + 1})`);
		for (const o of modelOptions) assert.match(o.getAttribute("data-am-bulk-option"), /^nvidia\//, "only nvidia models listed");
		// The picker stays open (in-place update, not a full re-render).
		assert.ok(container.querySelector(".am-bulk-picker"), "picker still open after filtering");
		assert.equal(container.querySelector('.am-bulk-picker [data-am-bulk-provider="nvidia"]').getAttribute("aria-pressed"), "true", "chosen chip is pressed");
		assert.equal(container.querySelector('.am-bulk-picker [data-am-bulk-provider="all"]').getAttribute("aria-pressed"), "false", "All is no longer pressed");
		// Search still composes with the chip.
		const search = container.querySelector("[data-am-bulk-search]");
		search.value = "llama";
		search.dispatchEvent("input");
		await new Promise((r) => setTimeout(r, 5));
		const narrowed = [...container.querySelectorAll("[data-am-bulk-option]")].filter((o) => o.getAttribute("data-am-bulk-option") !== "__inherit__");
		assert.equal(narrowed.length, 1, "provider chip + search compose");
		assert.equal(narrowed[0].getAttribute("data-am-bulk-option"), "nvidia/meta/llama-3.2-90b-vision-instruct");
	});

	it("bulk: quick filters RESET when the bulk picker is reopened", async () => {
		const { container } = mountFresh();
		await new Promise((r) => setTimeout(r, 5));
		container.querySelector("[data-am-bulk-all]").click();
		await new Promise((r) => setTimeout(r, 5));
		container.querySelector("[data-am-bulk-open]").click();
		await new Promise((r) => setTimeout(r, 5));
		container.querySelector('.am-bulk-picker [data-am-bulk-provider="nvidia"]').click();
		await new Promise((r) => setTimeout(r, 5));
		container.querySelector("[data-am-bulk-open]").click(); // close
		await new Promise((r) => setTimeout(r, 5));
		container.querySelector("[data-am-bulk-open]").click(); // reopen
		await new Promise((r) => setTimeout(r, 5));
		const picker = container.querySelector(".am-bulk-picker");
		assert.ok(picker, "reopened");
		assert.equal(picker.querySelector('[data-am-bulk-provider="all"]').getAttribute("aria-pressed"), "true", "provider filter reset to All");
		const options = [...container.querySelectorAll("[data-am-bulk-option]")].filter((o) => o.getAttribute("data-am-bulk-option") !== "__inherit__");
		assert.equal(options.length, 4, "full catalog is back after reset");
	});

it("bulk: apply POSTs every selected agent and shows the summary", async () => {
		globalThis.fetch = async (url, init = {}) => {
			const method = init.method ?? "GET";
			const body = init.body ? JSON.parse(init.body) : null;
			fetchCalls.push({ url: String(url), method, body });
			if (String(url).includes("/state")) return { ok: true, status: 200, json: async () => STATE };
			if (String(url).includes("/set-models")) {
				return { ok: true, status: 200, json: async () => ({ ok: true, model: body.model, summary: { requested: body.agents.length, applied: body.agents.length, unchanged: 0, failed: 0 }, results: body.agents.map((a) => ({ agent: a, ok: true, changed: true })), report: STATE }) };
			}
			return { ok: true, status: 200, json: async () => STATE };
		};
		const { container } = mountFresh();
		await new Promise((r) => setTimeout(r, 5));
		const total = container.querySelectorAll('[data-am-select]').length;
		container.querySelector("[data-am-bulk-all]").click();
		await new Promise((r) => setTimeout(r, 5));
		container.querySelector("[data-am-bulk-open]").click();
		await new Promise((r) => setTimeout(r, 5));
		const target = "commandcode/Qwen/Qwen3.6-Plus";
		container.querySelector(`[data-am-bulk-option="${target}"]`).click();
		await new Promise((r) => setTimeout(r, 10));
		const call = fetchCalls.find((c) => c.url.includes("/set-models"));
		assert.ok(call, "POST /set-models was called");
		assert.equal(call.method, "POST");
		assert.equal(call.body.model, target);
		assert.equal(call.body.agents.length, total, "every selected agent is in the POST body");
		// Selection cleared + a summary note is shown.
		assert.equal(container.querySelector("[data-am-bulk-count]").getAttribute("data-am-bulk-count"), "0", "selection cleared after apply");
		assert.match(container.querySelector(".am-bulk-bar").textContent, /bulk: .*updated/, "summary note is shown");
		// The note gets its own centered class, not .am-saved (row-oriented padding).
		const note = container.querySelector(".am-bulk-note");
		assert.ok(note, "the summary note uses .am-bulk-note");
		assert.equal(container.querySelector(".am-bulk-bar .am-saved"), null, "no row-oriented .am-saved in the bulk bar");
	});

	it("bulk: an error payload is surfaced and the selection is kept", async () => {
		globalThis.fetch = async (url, init = {}) => {
			const method = init.method ?? "GET";
			const body = init.body ? JSON.parse(init.body) : null;
			fetchCalls.push({ url: String(url), method, body });
			if (String(url).includes("/state")) return { ok: true, status: 200, json: async () => STATE };
			if (String(url).includes("/set-models")) return { ok: true, status: 400, json: async () => ({ ok: false, error: "not an available model: nope" }) };
			return { ok: true, status: 200, json: async () => STATE };
		};
		const { container } = mountFresh();
		await new Promise((r) => setTimeout(r, 5));
		container.querySelector("[data-am-bulk-all]").click();
		await new Promise((r) => setTimeout(r, 5));
		container.querySelector("[data-am-bulk-open]").click();
		await new Promise((r) => setTimeout(r, 5));
		container.querySelector('[data-am-bulk-option="commandcode/Qwen/Qwen3.6-Plus"]').click();
		await new Promise((r) => setTimeout(r, 10));
		assert.match(container.querySelector(".am-bulk-bar").textContent, /not an available model/, "server error is surfaced");
		assert.notEqual(container.querySelector("[data-am-bulk-count]").getAttribute("data-am-bulk-count"), "0", "selection is kept on failure");
	});

	it("bulk: a non-JSON 404 (SPA fallback) names the stale-running-server fix, not just the status", async () => {
		// The running server predating the /set-models route returns the SPA fallback:
		// 404 + HTML. The error must say how to fix it, not just "HTTP 404".
		globalThis.fetch = async (url, init = {}) => {
			fetchCalls.push({ url: String(url), method: init.method ?? "GET" });
			if (String(url).includes("/state")) return { ok: true, status: 200, json: async () => STATE };
			if (String(url).includes("/set-models")) return { ok: false, status: 404, statusText: "Not Found", json: async () => { throw new SyntaxError("Unexpected token '<'"); } };
			return { ok: true, status: 200, json: async () => STATE };
		};
		const { container } = mountFresh();
		await new Promise((r) => setTimeout(r, 5));
		container.querySelector("[data-am-bulk-all]").click();
		await new Promise((r) => setTimeout(r, 5));
		container.querySelector("[data-am-bulk-open]").click();
		await new Promise((r) => setTimeout(r, 5));
		container.querySelector('[data-am-bulk-option="commandcode/Qwen/Qwen3.6-Plus"]').click();
		await new Promise((r) => setTimeout(r, 10));
		const err = container.querySelector(".am-bulk-bar .am-config-err");
		assert.ok(err, "error is surfaced in the bulk bar");
		assert.match(err.textContent, /HTTP 404/, "status is shown");
		assert.match(err.textContent, /reload plugins|restart/i, "the fix (reload plugins / restart) is named");
	});
});