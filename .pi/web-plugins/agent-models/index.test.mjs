/**
 * agent-models plugin — unit tests (SDK createMockHost, no server needed).
 *
 * Covers the two things that would make this panel lie:
 *   1. the status truth table (ok / dropped / unresolved / inherit)
 *   2. the /state route payload shape the client renders
 *
 * Run: node --test index.test.mjs
 */

import { describe, it, before } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import plugin from "./index.mjs";
import { createMockHost } from "./sdk/index.mjs";
import {
	buildReport,
	classifyModelPin,
	formatReportTable,
	lintAgent,
	parseAgentFile,
	parseToolList,
	setModelInFrontmatter,
	STATUS,
} from "./resolver.mjs";

const CODER = `---
name: coder
description: "Senior full-stack engineer."
tools: read, edit, bash, find, grep, ls, skill
model: nvidia/nvidia/nemotron-3.5-lightning-30b-a3b
---

# @coder
Load the skill: skill("senior-developer")
`;

const REVIEWER_DEAD = `---
name: reviewer
description: "Independent code reviewer."
tools: read, find, grep
model: opencode/mimo-v2.5-free
---

# @reviewer
`;

const VISION_NO_PIN = `---
name: vision
description: "Image and visual content analysis."
tools: read, find, ls
---

# @vision
`;

const TYPO_PIN = `---
name: testing
description: "QA engineer."
tools: read, edit, bash
model: nvidia/does-not-exist
---

# @testing
`;

const LINT_CASE = `---
name: helper
description: "Helper."
tools: read
---

# @helper
skill("something")
`;

function fixtureWorkspace() {
	const root = mkdtempSync(join(tmpdir(), "agent-models-test-"));
	const dir = join(root, ".pi", "agents");
	mkdirSync(dir, { recursive: true });
	writeFileSync(join(dir, "coder.md"), CODER, "utf-8");
	writeFileSync(join(dir, "reviewer.md"), REVIEWER_DEAD, "utf-8");
	writeFileSync(join(dir, "vision.md"), VISION_NO_PIN, "utf-8");
	writeFileSync(join(dir, "testing.md"), TYPO_PIN, "utf-8");
	return root;
}

const CATALOG = new Set([
	"nvidia/nvidia/nemotron-3.5-lightning-30b-a3b",
	"nvidia/moonshotai/kimi-k3",
	"commandcode/Qwen/Qwen3.6-Plus",
]);

describe("resolver: parsing", () => {
	it("parses flat frontmatter, quoting and tools variants", () => {
		const agent = parseAgentFile(CODER, "coder.md");
		assert.equal(agent.name, "coder");
		assert.equal(agent.description, "Senior full-stack engineer.");
		assert.equal(agent.model, "nvidia/nvidia/nemotron-3.5-lightning-30b-a3b");
		assert.deepEqual(agent.tools, ["read", "edit", "bash", "find", "grep", "ls", "skill"]);
		assert.match(agent.body, /senior-developer/);
		assert.equal(agent.hasFrontmatter, true);
	});

	it("accepts bracketed tool lists and strips a BOM", () => {
		assert.deepEqual(parseToolList("[read, bash]"), ["read", "bash"]);
		const agent = parseAgentFile(`\uFEFF---\nname: x\ntools: [read]\n---\nbody`, "x.md");
		assert.equal(agent.name, "x");
		assert.deepEqual(agent.tools, ["read"]);
	});

	it("degrades to no-pin instead of throwing on a file without frontmatter", () => {
		const agent = parseAgentFile("# just a heading\n", "loose.md");
		assert.equal(agent.name, "loose");
		assert.equal(agent.model, null);
		assert.equal(agent.hasFrontmatter, false);
	});
});

describe("resolver: status truth table", () => {
	it("ok when the pin is in the catalog", () => {
		const v = classifyModelPin("nvidia/nvidia/nemotron-3.5-lightning-30b-a3b", CATALOG);
		assert.equal(v.status, STATUS.OK);
		assert.equal(v.effective, "nvidia/nvidia/nemotron-3.5-lightning-30b-a3b");
	});

	it("dropped for the dispatcher's opencode filter (any of them, catalog or not)", () => {
		for (const pin of ["opencode/mimo-v2.5-free", "opencode-go/qwen3.6-plus"]) {
			const v = classifyModelPin(pin, CATALOG);
			assert.equal(v.status, STATUS.DROPPED, pin);
			assert.equal(v.effective, null);
			assert.match(v.why, /dispatcher drops/);
		}
	});

	it("unresolved when the pin is absent from the catalog", () => {
		assert.equal(classifyModelPin("nvidia/does-not-exist", CATALOG).status, STATUS.UNRESOLVED);
	});

	it("inherit when there is no pin at all", () => {
		assert.equal(classifyModelPin(null, CATALOG).status, STATUS.INHERIT);
		assert.equal(classifyModelPin("", CATALOG).status, STATUS.INHERIT);
	});

	it("an empty catalog does not fake an OK verdict", () => {
		const v = classifyModelPin("nvidia/moonshotai/kimi-k3", new Set());
		assert.equal(v.status, STATUS.UNRESOLVED);
		assert.match(v.why, /no model catalog/);
	});

	it("providerOf keeps slashed model ids intact", () => {
		assert.equal(classifyModelPin("opencode-go/qwen3.6-plus", CATALOG).why.includes("opencode-go"), true);
	});
});

describe("resolver: lint + report", () => {
	it("flags skill() used without the skill tool", () => {
		const warnings = lintAgent(parseAgentFile(LINT_CASE, "helper.md"));
		assert.equal(warnings.length, 1);
		assert.match(warnings[0], /no "skill" tool/);
	});

	it("flags a name/file mismatch and a missing tools list", () => {
		const warnings = lintAgent(parseAgentFile(`---\nname: other\ndescription: "d"\n---\nbody`, "helper.md"));
		assert.ok(warnings.some((w) => /differs from file name/.test(w)));
		assert.ok(warnings.some((w) => /no tools allowlist/.test(w)));
	});

	it("counts the fixture the way the live roster counts", () => {
		const report = buildReport(
			[
				parseAgentFile(CODER, "coder.md"),
				parseAgentFile(REVIEWER_DEAD, "reviewer.md"),
				parseAgentFile(VISION_NO_PIN, "vision.md"),
				parseAgentFile(TYPO_PIN, "testing.md"),
			],
			CATALOG,
			"test",
		);
		assert.deepEqual(
			{
				total: report.counts.total,
				ok: report.counts.ok,
				dropped: report.counts.dropped,
				unresolved: report.counts.unresolved,
				inherit: report.counts.inherit,
			},
			{ total: 4, ok: 1, dropped: 1, unresolved: 1, inherit: 1 },
		);
		assert.match(formatReportTable(report), /DEAD PIN/);
	});
});

describe("plugin: /state route", () => {
	let host;
	let route;
	let dir;

	before(async () => {
		const { readdirSync, readFileSync } = await import("node:fs");
		const root = fixtureWorkspace();
		dir = join(root, ".pi", "agents");
		// createMockHost returns the MockHost itself, not a wrapper.
		host = createMockHost({
			cwd: root,
			fs: {
				list: async (rel) => {
					assert.equal(rel, ".pi/agents");
					return readdirSync(dir, { withFileTypes: true }).map((e) => ({
						name: e.name,
						type: e.isDirectory() ? "dir" : "file",
					}));
				},
				readText: async (rel) => readFileSync(join(dir, rel.split("/").pop()), "utf-8"),
			},
			models: { list: async () => [...CATALOG].map((id) => ({ id, provider: id.split("/")[0] })) },
		});

		await plugin.activate(host);
		route = host.mock.routes.find((r) => r.path === "/state");
	});

	/** Call the route handler with a minimal express-like req/res pair. */
	function callRoute(url = "/state") {
		return new Promise((resolve) => {
			const res = {
				writeHead() {},
				end(body) {
					try {
						resolve(JSON.parse(body));
					} catch (err) {
						resolve({ parseError: String(err), body });
					}
				},
			};
			route.handler({ url, headers: {}, body: undefined }, res);
		});
	}

	it("registers GET /state", () => {
		assert.ok(route, "GET /state should be registered");
	});

	it("returns ok:true with the report and the catalog source", async () => {
		const payload = await callRoute("/state?refresh=1");
		assert.equal(payload.ok, true);
		assert.equal(payload.counts.total, 4);
		assert.equal(payload.counts.dropped, 1);
		assert.match(payload.catalogSource, /host\.models\.list\(\)/);
		assert.equal(payload.rows[0].body, undefined, "body must not be serialized into the payload");
	});

	it("registers the /agent-models slash command", () => {
		const cmd = host.mock.commands.find((c) => c.name === "agent-models");
		assert.ok(cmd, "/agent-models command should be registered");
	});
});

describe("resolver: setModelInFrontmatter", () => {
	const FILE = `---
name: reviewer
description: "Independent code reviewer."
# a hand-written comment that must survive
tools: read, find, grep
model: opencode/mimo-v2.5-free
---

# @reviewer
Body stays untouched.
`;

	it("replaces only the model line, preserving comments, order and body", () => {
		const r = setModelInFrontmatter(FILE, "commandcode/z-ai/glm-5.3-flash");
		assert.equal(r.ok, true);
		assert.equal(r.changed, true);
		assert.equal(r.previous, "opencode/mimo-v2.5-free");
		assert.match(r.text, /# a hand-written comment that must survive/);
		assert.match(r.text, /model: commandcode\/z-ai\/glm-5\.3-flash/);
		assert.ok(!r.text.includes("opencode/mimo-v2.5-free"), "the old pin must be gone");
		assert.ok(r.text.endsWith("Body stays untouched.\n"), "the body must be intact");
		// lines 1-4 (name, description, comment, tools) keep their exact order
		assert.deepEqual(r.text.split("\n").slice(1, 5), FILE.split("\n").slice(1, 5));
	});

	it("adds a pin as the last key when the agent has none", () => {
		const noPin = `---\nname: vision\ndescription: "d"\ntools: read\n---\n\nbody\n`;
		const r = setModelInFrontmatter(noPin, "nvidia/x");
		assert.equal(r.ok, true);
		assert.equal(r.changed, true);
		assert.equal(r.previous, null);
		assert.match(r.text, /tools: read\nmodel: nvidia\/x\n---/);
	});

	it("removes the pin for inherit", () => {
		const r = setModelInFrontmatter(FILE, null);
		assert.equal(r.changed, true);
		assert.equal(r.previous, "opencode/mimo-v2.5-free");
		assert.ok(!/^model:/m.test(r.text), "no model line should remain");
		assert.match(r.text, /tools: read, find, grep/);
	});

	it("is a no-op when the pin already matches", () => {
		const r = setModelInFrontmatter(FILE, "opencode/mimo-v2.5-free");
		assert.equal(r.ok, true);
		assert.equal(r.changed, false);
		assert.equal(r.text, FILE);
	});

	it("keeps CRLF files CRLF", () => {
		const crlf = FILE.replace(/\n/g, "\r\n");
		const r = setModelInFrontmatter(crlf, "nvidia/x");
		assert.match(r.text, /model: nvidia\/x\r\n/);
		assert.ok(!/(^|[^\r])\n/.test(r.text.replace(/\r\n/g, "")), "no bare LF introduced");
	});

	it("refuses a file with no frontmatter instead of inventing one", () => {
		const r = setModelInFrontmatter("# just a heading\n", "nvidia/x");
		assert.equal(r.ok, false);
		assert.match(r.reason, /no frontmatter/);
		assert.equal(r.text, "# just a heading\n");
	});
});

describe("plugin: POST /set-model (write path)", () => {
	let host;
	let writes;
	let route;

	before(async () => {
		const { readdirSync, readFileSync } = await import("node:fs");
		const root = fixtureWorkspace();
		const dir = join(root, ".pi", "agents");
		// In-memory overlay seeded from the fixture, so a write is visible to the
		// next read - otherwise the route's report refresh would not see the edit.
		const files = new Map();
		for (const name of readdirSync(dir)) files.set(name, readFileSync(join(dir, name), "utf-8"));
		writes = [];

		host = createMockHost({
			cwd: root,
			fs: {
				list: async () => [...files.keys()].sort().map((name) => ({ name, type: "file" })),
				readText: async (rel) => {
					const name = rel.split("/").pop();
					if (!files.has(name)) throw new Error(`ENOENT ${rel}`);
					return files.get(name);
				},
				write: async (rel, data) => {
					writes.push({ rel, data: String(data) });
					if (rel.startsWith(".pi/agents/")) files.set(rel.split("/").pop(), String(data));
				},
				mkdir: async () => {},
			},
			models: { list: async () => [...CATALOG].map((id) => ({ id, provider: id.split("/")[0] })) },
		});
		await plugin.activate(host);
		route = host.mock.routes.find((r) => r.method === "POST" && r.path === "/set-model");
	});

	function post(body) {
		return new Promise((resolve) => {
			const res = {
				writeHead() {},
				end(b) {
					try {
						resolve(JSON.parse(b));
					} catch (err) {
						resolve({ parseError: String(err), raw: b });
					}
				},
			};
			route.handler({ url: "/set-model", headers: {}, body }, res);
		});
	}

	it("registers POST /set-model", () => {
		assert.ok(route, "POST /set-model should be registered");
	});

	it("rejects an unknown agent", async () => {
		const p = await post({ agent: "does-not-exist", model: "commandcode/Qwen/Qwen3.6-Plus" });
		assert.equal(p.ok, false);
		assert.match(p.error, /unknown agent/);
	});

	it("rejects a path-traversal agent name before touching the filesystem", async () => {
		const p = await post({ agent: "../../evil", model: "commandcode/Qwen/Qwen3.6-Plus" });
		assert.equal(p.ok, false);
		assert.match(p.error, /invalid agent name/);
	});

	it("rejects a model that is not in the live catalog", async () => {
		const p = await post({ agent: "reviewer", model: "opencode/mimo-v2.5-free" });
		assert.equal(p.ok, false);
		assert.match(p.error, /not an available model/);
	});

	it("writes the file plus a backup and returns a refreshed report", async () => {
		writes.length = 0;
		const p = await post({ agent: "reviewer", model: "commandcode/Qwen/Qwen3.6-Plus" });
		assert.equal(p.ok, true, p.error ?? "");
		assert.equal(p.changed, true);
		assert.equal(p.previous, "opencode/mimo-v2.5-free");
		assert.match(p.backup, /^\.pi\/agent-models\/backups\/reviewer-/);

		const fileWrite = writes.find((w) => w.rel === ".pi/agents/reviewer.md");
		const backupWrite = writes.find((w) => w.rel === p.backup);
		assert.ok(fileWrite, "the agent file must be written");
		assert.ok(backupWrite, "a backup must be written before the edit");
		assert.match(fileWrite.data, /model: commandcode\/Qwen\/Qwen3\.6-Plus/);
		assert.match(backupWrite.data, /model: opencode\/mimo-v2\.5-free/, "the backup must hold the original");

		// The refreshed report must reflect the edit: reviewer is no longer dead.
		const reviewer = p.report.rows.find((r) => r.name === "reviewer");
		assert.equal(reviewer.status, STATUS.OK);
		assert.equal(p.report.counts.dropped, 0);
		assert.equal(p.report.counts.ok, 2);
	});

	it("can clear a pin back to inherit", async () => {
		const p = await post({ agent: "coder", model: null });
		assert.equal(p.ok, true, p.error ?? "");
		assert.equal(p.previous, "nvidia/nvidia/nemotron-3.5-lightning-30b-a3b");
		const coder = p.report.rows.find((r) => r.name === "coder");
		assert.equal(coder.status, STATUS.INHERIT);
		assert.equal(coder.pin, null);
	});
});
