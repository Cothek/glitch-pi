/**
 * agent-switcher plugin — unit tests via the SDK's createMockHost.
 *
 * Runs against a fixture workspace (built in a temp dir) so the fs override
 * exercises the real discovery path: profiles listing, frontmatter parsing,
 * mode-marker reading, switch delivery, and the HTTP route contract.
 *
 * Run: node --test index.test.mjs
 */

import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readdirSync, readFileSync, existsSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventEmitter } from "node:events";
import plugin from "./index.mjs";
import { createMockHost } from "./sdk/index.mjs";

/** Build a fixture workspace and return its root path. */
function fixtureWorkspace() {
	const root = mkdtempSync(join(tmpdir(), "agent-switcher-test-"));
	const profiles = join(root, ".pi", "agent-profiles");
	mkdirSync(profiles, { recursive: true });
	writeFileSync(
		join(profiles, "glitch.md"),
		"---\ndescription: Full Glitch - dispatch-first workflow\n---\n\n# Glitch\nBody...",
		"utf-8",
	);
	writeFileSync(
		join(profiles, "glitch-omni.md"),
		"---\ndescription: Direct execution - no dispatching\n---\n\n# Glitch Omni\nBody...",
		"utf-8",
	);
	writeFileSync(join(profiles, "glitch-lightweight.md"), "# Glitch Lightweight\n(no frontmatter)", "utf-8");
	mkdirSync(join(root, "user"), { recursive: true });
	writeFileSync(
		join(root, "user", "agent-mode.json"),
		JSON.stringify({ mode: "glitch-omni" }),
		"utf-8",
	);
	return root;
}

/** Workspace-relative fs implementation over the fixture root. */
function fixtureFs(root) {
	const abs = (rel) => join(root, String(rel ?? "").replace(/^[/\\]+/, ""));
	return {
		async list(relDir = ".") {
			const dir = abs(relDir);
			if (!existsSync(dir)) throw new Error("ENOENT");
			return readdirSync(dir, { withFileTypes: true }).map((e) => ({
				name: e.name,
				type: e.isDirectory() ? "dir" : "file",
			}));
		},
		async readText(relPath, _maxBytes) {
			return readFileSync(abs(relPath), "utf-8");
		},
		async stat(relPath) {
			const s = statSync(abs(relPath));
			return { name: relPath, type: s.isDirectory() ? "dir" : "file", size: s.size, mtime: s.mtimeMs };
		},
	};
}

function makeHost(root, overrides = {}) {
	const promptCalls = [];
	const host = createMockHost({
		cwd: root,
		fs: fixtureFs(root),
		getActiveConversation: () => ({ conversationId: "conv-1", title: "t" }),
		prompt: async (conversationId, req) => {
			promptCalls.push({ conversationId, text: req?.text });
			return { ok: true };
		},
		...overrides,
	});
	return { host, promptCalls };
}

function registeredSelect(host) {
	const reg = host.mock.calls("ui.register")[0];
	assert.ok(reg, "ui.register should have been called");
	const item = Array.isArray(reg.args[0]) ? reg.args[0][0] : reg.args[0];
	assert.equal(item.kind, "select");
	return item;
}

describe("agent-switcher plugin", () => {
	let root;

	beforeEach(() => {
		root = fixtureWorkspace();
	});

	it("registers a composer select with all profiles and the current mode", async () => {
		const { host } = makeHost(root);
		await plugin.activate(host);
		const item = registeredSelect(host);
		assert.equal(item.slot, "composer.actions");
		assert.equal(item.value, "glitch-omni");
		const values = item.options.map((o) => o.value);
		assert.deepEqual(values, ["glitch", "glitch-lightweight", "glitch-omni"]);
		// terse labels: bare mode ids in the select (descriptions stay in the tab)
		const omni = item.options.find((o) => o.value === "glitch-omni");
		assert.equal(omni.label, "glitch-omni");
	});

	it("switches via onMessage: delivers /agent <mode> to the active conversation", async () => {
		const { host, promptCalls } = makeHost(root);
		await plugin.activate(host);
		host.mock.emit("onMessage", { action: "switch", value: "glitch" }, "client-1");
		await new Promise((r) => setTimeout(r, 20)); // switchMode is async void
		assert.equal(promptCalls.length, 1);
		assert.equal(promptCalls[0].conversationId, "conv-1");
		assert.equal(promptCalls[0].text, "/agent glitch");
	});

	it("rejects unknown modes without prompting", async () => {
		const { host, promptCalls } = makeHost(root);
		await plugin.activate(host);
		host.mock.emit("onMessage", { action: "switch", value: "nonexistent" }, "client-1");
		await new Promise((r) => setTimeout(r, 20));
		assert.equal(promptCalls.length, 0);
		assert.ok(host.logs.some((l) => l.text.includes("unknown mode")), "should log the rejection");
	});

	it("exposes POST /switch and GET /state routes with the right contract", async () => {
		const { host, promptCalls } = makeHost(root);
		await plugin.activate(host);

		const post = host.mock.routes.find((r) => r.method === "POST" && r.path === "/switch");
		const getState = host.mock.routes.find((r) => r.method === "GET" && r.path === "/state");
		assert.ok(post, "POST /switch route registered");
		assert.ok(getState, "GET /state route registered");

		// fake req/res pair
		const req = new EventEmitter();
		const res = {
			status: 0,
			body: "",
			writeHead(status, headers) {
				this.status = status;
				this.headers = headers;
			},
			end(body) {
				this.body = body;
			},
		};
		const sent = (async () => {
			await post.handler(req, res);
		})();
		req.emit("data", JSON.stringify({ mode: "glitch-lightweight" }));
		req.emit("end");
		await sent;
		assert.equal(res.status, 200);
		assert.equal(JSON.parse(res.body).ok, true);
		assert.equal(promptCalls[0]?.text, "/agent glitch-lightweight");

		const res2 = { status: 0, body: "", writeHead(s) { this.status = s; }, end(b) { this.body = b; } };
		await getState.handler(new EventEmitter(), res2);
		const state = JSON.parse(res2.body);
		assert.equal(state.current, "glitch-omni");
		assert.equal(state.modes.length, 3);
	});

	it("re-syncs the select value when the marker changes on conversation switch", async () => {
		const { host } = makeHost(root);
		await plugin.activate(host);
		// simulate an external switch writing the marker
		writeFileSync(join(root, "user", "agent-mode.json"), JSON.stringify({ mode: "glitch" }), "utf-8");
		host.mock.emit("onConversationChanged");
		await new Promise((r) => setTimeout(r, 20));
		const update = host.mock.calls("ui.update").at(-1);
		assert.ok(update, "ui.update should have been called");
		assert.equal(update.args[1]?.value, "glitch");
	});

	it("hides the select when the workspace has no profiles", async () => {
		const emptyRoot = mkdtempSync(join(tmpdir(), "agent-switcher-empty-"));
		const { host } = makeHost(emptyRoot);
		await plugin.activate(host);
		assert.equal(host.mock.calls("ui.register").length, 0);
	});
});
