/**
 * agent-switcher plugin — unit tests via the SDK's createMockHost.
 *
 * The switch is marker-based: switchMode() writes user/agent-mode.json and nothing
 * else. The pi extension reconciles from the marker each turn, and it installs the
 * profile as the system prompt in memory, so no tracked file is ever staged.
 * No host.prompt()/conversation id is involved — that path proved ambiguous with
 * several attached clients ("unknown conversation: c1").
 *
 * HERMETICITY: beforeEach sets AGENT_SWITCHER_ROOT to the fixture workspace. The
 * plugin deliberately anchors on glitchRoot() in production (see the note in
 * index.mjs), so without that override a test run reads and WRITES the real repo's
 * user/agent-mode.json and .pi/agent-profiles. The "never writes the live repo
 * marker or system prompt" test below is the guard against that regressing.
 *
 * Run: node --test index.test.mjs
 */

import { describe, it, beforeEach, afterEach } from "node:test";
import { createHash } from "node:crypto";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readdirSync, readFileSync, existsSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import plugin from "./index.mjs";
import { createMockHost } from "./sdk/index.mjs";

/** Build a fixture workspace and return its root path. */
function fixtureWorkspace() {
	const root = mkdtempSync(join(tmpdir(), "agent-switcher-test-"));
	const profiles = join(root, ".pi", "agent-profiles");
	mkdirSync(profiles, { recursive: true });
	writeFileSync(
		join(profiles, "glitch.md"),
		"---\ndescription: Full Glitch - dispatch-first workflow\n---\n\n# Glitch\nBody one...",
		"utf-8",
	);
	writeFileSync(
		join(profiles, "glitch-omni.md"),
		"---\ndescription: Direct execution - no dispatching\n---\n\n# Glitch Omni\nBody two...",
		"utf-8",
	);
	writeFileSync(join(profiles, "glitch-lightweight.md"), "# Glitch Lightweight\n(no frontmatter)", "utf-8");
	mkdirSync(join(root, "user"), { recursive: true });
	writeFileSync(join(root, "user", "agent-mode.json"), JSON.stringify({ mode: "glitch-omni" }), "utf-8");
	return root;
}

/** Workspace-relative fs implementation over the fixture root. */
function fixtureFs(root) {
	const abs = (rel) => join(root, String(rel ?? "").replace(/^[/\\]+/, "").replace(/\//g, "\\"));
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
		async write(relPath, data) {
			writeFileSync(abs(relPath), typeof data === "string" ? data : Buffer.from(data));
		},
		async stat(relPath) {
			const s = statSync(abs(relPath));
			return { name: relPath, type: s.isDirectory() ? "dir" : "file", size: s.size, mtime: s.mtimeMs };
		},
	};
}

function makeHost(root, overrides = {}) {
	const host = createMockHost({
		cwd: root,
		fs: fixtureFs(root),
		...overrides,
	});
	return { host };
}

function readMarker(root) {
	try {
		return JSON.parse(readFileSync(join(root, "user", "agent-mode.json"), "utf-8"));
	} catch {
		return null;
	}
}

function registeredChip(host) {
	const reg = host.mock.calls("ui.register")[0];
	assert.ok(reg, "ui.register should have been called");
	const item = Array.isArray(reg.args[0]) ? reg.args[0][0] : reg.args[0];
	assert.equal(item.kind, "action");
	assert.equal(item.action, "agent-switcher:menu");
	return item;
}

describe("agent-switcher plugin", () => {
	let root;
	let globalRoot;

	beforeEach(() => {
		root = fixtureWorkspace();
		// Isolate the plugin's whole root per test. Without this the plugin (correctly)
		// anchors on glitchRoot() and a test run reads and WRITES the real
		// user/agent-mode.json plus the real .pi/agent-profiles — which is what made
		// this suite red and left the repo dirty.
		process.env.AGENT_SWITCHER_ROOT = root;
		// Isolate the global fallback dir per test (env override; empty by default).
		globalRoot = mkdtempSync(join(tmpdir(), "agent-switcher-global-"));
		process.env.AGENT_SWITCHER_GLOBAL_DIR = globalRoot;
	});

	afterEach(() => {
		rmSync(globalRoot, { recursive: true, force: true });
		delete process.env.AGENT_SWITCHER_GLOBAL_DIR;
		delete process.env.AGENT_SWITCHER_ROOT;
	});

	it("registers a composer action chip with the current mode label", async () => {
		const { host } = makeHost(root);
		await plugin.activate(host);
		const item = registeredChip(host);
		assert.equal(item.slot, "composer.actions");
		assert.equal(item.label, "Agent: glitch-omni");
		assert.equal(item.options, undefined);
	});

	it("leaves .pi/SYSTEM.md untouched and carries the mode only in the marker", async () => {
		const { host } = makeHost(root);
		await plugin.activate(host);
		// Sentinel in the tracked file: a switch must NOT rewrite it.
		const sentinel = "# SENTINEL - do not overwrite\n";
		writeFileSync(join(root, ".pi", "SYSTEM.md"), sentinel, "utf-8");
		host.mock.emit("onMessage", { action: "agent-switcher:switch", value: "glitch" }, "c1");
		await new Promise((r) => setTimeout(r, 30));
		assert.equal(readMarker(root)?.mode, "glitch", "marker carries the mode");
		assert.equal(readMarker(root)?.previous_mode, "glitch-omni");
		assert.equal(
			readFileSync(join(root, ".pi", "SYSTEM.md"), "utf-8"),
			sentinel,
			".pi/SYSTEM.md must not be rewritten on a switch",
		);
	});

	it("switches by writing the marker only, never .pi/SYSTEM.md (onMessage path)", async () => {
		const { host } = makeHost(root);
		await plugin.activate(host);
		const sentinel = "# SENTINEL - do not overwrite\n";
		writeFileSync(join(root, ".pi", "SYSTEM.md"), sentinel, "utf-8");
		host.mock.emit("onMessage", { action: "agent-switcher:switch", value: "glitch-lightweight" }, "c1");
		await new Promise((r) => setTimeout(r, 30));
		const marker = readMarker(root);
		assert.equal(marker?.mode, "glitch-lightweight");
		assert.equal(marker?.previous_mode, "glitch-omni");
		assert.equal(
			readFileSync(join(root, ".pi", "SYSTEM.md"), "utf-8"),
			sentinel,
			"a switch must not dirty the tracked system prompt",
		);
	});

	it("never writes the live repo marker or system prompt", async () => {
		// The regression guard for the bug that made this suite both red and dangerous:
		// AGENT_SWITCHER_ROOT is set to a fixture above, so a switch must land there
		// and nowhere near the real glitchRoot() paths.
		const { glitchRoot } = await import("../../lib/root.mjs");
		const liveRoot = glitchRoot();
		const sha = async (p) => {
			try {
				return createHash("sha256").update(readFileSync(p)).digest("hex");
			} catch {
				return "(absent)";
			}
		};
		const liveMarker = join(liveRoot, "user", "agent-mode.json");
		const liveSystem = join(liveRoot, ".pi", "SYSTEM.md");
		const before = { marker: await sha(liveMarker), system: await sha(liveSystem) };

		const { host } = makeHost(root);
		await plugin.activate(host);
		host.mock.emit("onMessage", { action: "agent-switcher:switch", value: "glitch-lightweight" }, "c1");
		await new Promise((r) => setTimeout(r, 30));
		// Sanity: the switch DID happen, in the fixture.
		assert.equal(readMarker(root)?.mode, "glitch-lightweight");

		assert.equal(await sha(liveMarker), before.marker, "live user/agent-mode.json must not be written");
		assert.equal(await sha(liveSystem), before.system, "live .pi/SYSTEM.md must not be written");
	});

	it("rejects unknown modes and leaves the marker untouched", async () => {
		const { host } = makeHost(root);
		await plugin.activate(host);
		host.mock.emit("onMessage", { action: "agent-switcher:switch", value: "nonexistent" }, "c1");
		await new Promise((r) => setTimeout(r, 30));
		assert.equal(readMarker(root)?.mode, "glitch-omni");
		assert.ok(host.logs.some((l) => l.text.includes("unknown mode")), "should log the rejection");
	});

	it("exposes POST /switch and GET /state routes with the right contract", async () => {
		const { host } = makeHost(root);
		await plugin.activate(host);

		const post = host.mock.routes.find((r) => r.method === "POST" && r.path === "/switch");
		const getState = host.mock.routes.find((r) => r.method === "GET" && r.path === "/state");
		assert.ok(post, "POST /switch route registered");
		assert.ok(getState, "GET /state route registered");

		// The host mounts plugin routes behind express.json(): the body is
		// pre-parsed at req.body, so the handler must NOT read the stream.
		const res = {
			status: 0,
			body: "",
			writeHead(status) {
				this.status = status;
			},
			end(body) {
				this.body = body;
			},
		};
		await post.handler({ body: { mode: "glitch" }, url: "/switch" }, res);
		assert.equal(res.status, 200);
		assert.equal(JSON.parse(res.body).ok, true);
		assert.equal(readMarker(root)?.mode, "glitch");

		// query-string fallback (callers that cannot send a JSON body)
		await post.handler({ body: {}, url: "/switch?mode=glitch-omni" }, res);
		assert.equal(readMarker(root)?.mode, "glitch-omni");

		const res2 = { status: 0, body: "", writeHead(s) { this.status = s; }, end(b) { this.body = b; } };
		await getState.handler({ body: {}, url: "/state" }, res2);
		const state = JSON.parse(res2.body);
		assert.equal(state.current, "glitch-omni");
		assert.equal(state.modes.length, 3);
	});

	it("re-syncs the chip label when the marker changes on conversation switch", async () => {
		const { host } = makeHost(root);
		await plugin.activate(host);
		writeFileSync(join(root, "user", "agent-mode.json"), JSON.stringify({ mode: "glitch" }), "utf-8");
		host.mock.emit("onConversationChanged");
		await new Promise((r) => setTimeout(r, 30));
		const update = host.mock.calls("ui.update").at(-1);
		assert.ok(update, "ui.update should have been called");
		assert.equal(update.args[1]?.label, "Agent: glitch");
	});

	it("falls back to global profiles when the workspace has none", async () => {
		writeFileSync(join(globalRoot, "glitch.md"), "---\ndescription: Global glitch\n---\n\n# Glitch\nGlobal body...", "utf-8");
		writeFileSync(join(globalRoot, "glitch-free.md"), "# Glitch Free\n(no frontmatter)", "utf-8");
		const bareRoot = mkdtempSync(join(tmpdir(), "agent-switcher-bare-"));
		mkdirSync(join(bareRoot, ".pi"), { recursive: true });
		mkdirSync(join(bareRoot, "user"), { recursive: true });
		// This test's workspace is bareRoot, not the beforeEach fixture.
		process.env.AGENT_SWITCHER_ROOT = bareRoot;
		try {
			const { host } = makeHost(bareRoot);
			await plugin.activate(host);
			const item = registeredChip(host);
			assert.equal(item.label, "Agent: glitch");
			const getState = host.mock.routes.find((r) => r.method === "GET" && r.path === "/state");
			const res = { status: 0, body: "", writeHead(s) { this.status = s; }, end(b) { this.body = b; } };
			await getState.handler({ body: {}, url: "/state" }, res);
			const state = JSON.parse(res.body);
			assert.deepEqual(state.modes.map((m) => m.id), ["glitch", "glitch-free"]);
			// Switching from a global profile must not stage .pi/SYSTEM.md either.
			const sentinel = "# SENTINEL bare\n";
			writeFileSync(join(bareRoot, ".pi", "SYSTEM.md"), sentinel, "utf-8");
			host.mock.emit("onMessage", { action: "agent-switcher:switch", value: "glitch" }, "c1");
			await new Promise((r) => setTimeout(r, 30));
			assert.equal(readMarker(bareRoot)?.mode, "glitch", "marker carries the mode in the bare workspace");
			assert.equal(
				readFileSync(join(bareRoot, ".pi", "SYSTEM.md"), "utf-8"),
				sentinel,
				"a switch in a workspace with no local profiles must not stage the system prompt",
			);
		} finally {
			rmSync(bareRoot, { recursive: true, force: true });
		}
	});

	it("lets a same-id workspace profile override the global one", async () => {
		writeFileSync(join(globalRoot, "glitch.md"), "---\ndescription: STALE global\n---\n\n# Glitch\nStale body", "utf-8");
		writeFileSync(join(globalRoot, "extra-global.md"), "---\ndescription: Extra\n---\n\n# Extra\nBody", "utf-8");
		const { host } = makeHost(root);
		await plugin.activate(host);
		const getState = host.mock.routes.find((r) => r.method === "GET" && r.path === "/state");
		const res = { status: 0, body: "", writeHead(s) { this.status = s; }, end(b) { this.body = b; } };
		await getState.handler({ body: {}, url: "/state" }, res);
		const modes = JSON.parse(res.body).modes;
		assert.equal(modes.length, 4);
		assert.equal(modes.find((m) => m.id === "glitch")?.description, "Full Glitch - dispatch-first workflow");
		assert.equal(modes.find((m) => m.id === "extra-global")?.description, "Extra");
	});

	it("hides the chip when the workspace has no profiles", async () => {
		const emptyRoot = mkdtempSync(join(tmpdir(), "agent-switcher-empty-"));
		// Point the plugin at the empty dir, not the beforeEach fixture.
		process.env.AGENT_SWITCHER_ROOT = emptyRoot;
		const { host } = makeHost(emptyRoot);
		await plugin.activate(host);
		assert.equal(host.mock.calls("ui.register").length, 0);
	});
});
