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
		for (const fn of [...(this._listeners.get(type) ?? [])]) fn({ type, target: this, ...extra });
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
	costMeta: { path: ".pi/agent-models/costs.json", generatedAt: "2026-09-25T00:00:00Z", summary: { total: 530, priced: 451, free: 79 } },
};

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
