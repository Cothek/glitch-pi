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
	formatCostShort,
	formatCostTitle,
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

	it("parses a CRLF file, INCLUDING its last frontmatter key", () => {
		// Regression: git normalizes these agent files to CRLF on checkout, and the last
		// header line then carries a lone \r. Because "." does not match \r in JS, the
		// key regex failed silently and a pinned agent reported as unpinned. Caught when
		// the CLI claimed ten agents had no model after a checkout.
		const crlf = `---\r\nname: pentester\r\ndescription: "d"\r\ntools: read, bash\r\nmodel: commandcode\/z-ai\/glm-5\.3-flash\r\n---\r\n\r\nbody\r\n`;
		const agent = parseAgentFile(crlf, "pentester.md");
		assert.equal(agent.model, "commandcode/z-ai/glm-5.3-flash", "last key must survive CRLF");
		assert.equal(agent.name, "pentester");
		assert.deepEqual(agent.tools, ["read", "bash"]);
		assert.match(agent.body, /^body/);
	});

	it("parses the thinkingLevel key (and leaves it null when absent)", () => {
		const withLevel = parseAgentFile(`---\nname: memory\ndescription: "d"\nmodel: nvidia/x\nthinkingLevel: minimal\n---\nbody\n`, "memory.md");
		assert.equal(withLevel.thinkingLevel, "minimal");
		assert.equal(parseAgentFile(`---\nname: coder\ndescription: "d"\nmodel: nvidia/x\n---\nbody\n`, "coder.md").thinkingLevel, null);
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

describe("resolver: cost labels", () => {
	it("calls an all-zero cost free", () => {
		assert.equal(formatCostShort({ in: 0, out: 0, source: "models.json" }), "free");
	});

	it("prints USD per million tokens compactly", () => {
		assert.equal(formatCostShort({ in: 0.25, out: 12.5 }), "$0.25/$12.5");
		assert.equal(formatCostShort({ in: 10, out: 50 }), "$10/$50");
		assert.equal(formatCostShort({ in: 0.005, out: 0.005 }), "$0.005/$0.005");
	});

	it("says n/a when a provider publishes nothing", () => {
		assert.equal(formatCostShort(null), "n/a");
		assert.equal(formatCostShort(undefined), "n/a");
		assert.match(formatCostTitle(null), /no pricing data/);
	});

	it("names the source and the cache prices in the hover text", () => {
		const title = formatCostTitle({ in: 0.25, out: 12.5, cacheRead: 0.1, source: "models-store.json" });
		assert.match(title, /input \$0\.25 \/ output \$12\.5/);
		assert.match(title, /cache read \$0\.1/);
		assert.match(title, /source: models-store\.json/);
		assert.match(formatCostTitle({ in: 0, out: 0 }), /free endpoints/);
	});

	it("omits the COST column when no row has a price", () => {
		const report = buildReport([parseAgentFile(VISION_NO_PIN, "vision.md")], CATALOG, "test");
		assert.ok(!formatReportTable(report).includes("COST"));
	});

	it("adds the COST column when rows carry prices", () => {
		const report = buildReport([parseAgentFile(TYPO_PIN, "testing.md")], CATALOG, "test");
		report.rows[0].costShort = "$1/$2";
		assert.match(formatReportTable(report), /COST/);
		assert.match(formatReportTable(report), /\$1\/\$2/);
	});
});

describe("plugin: cost table in the payload", () => {
	async function hostWith(costsDoc) {
		const { readdirSync, readFileSync } = await import("node:fs");
		const root = fixtureWorkspace();
		const dir = join(root, ".pi", "agents");
		writeFileSync(
			join(dir, "priced.md"),
			`---\nname: priced\ndescription: "d"\ntools: read\nmodel: openrouter/test/model\n---\n\nbody\n`,
			"utf-8",
		);
		return createMockHost({
			cwd: root,
			fs: {
				list: async () => readdirSync(dir, { withFileTypes: true }).map((e) => ({ name: e.name, type: e.isDirectory() ? "dir" : "file" })),
				readText: async (rel) => {
					if (rel === ".pi/agent-models/costs.json") {
						if (!costsDoc) throw new Error("ENOENT costs.json");
						return JSON.stringify(costsDoc);
					}
					return readFileSync(join(dir, rel.split("/").pop()), "utf-8");
				},
			},
			models: {
				list: async () => [...CATALOG, "openrouter/test/model"].map((id) => ({ id, provider: id.split("/")[0] })),
			},
		});
	}

	function stateRoute(host) {
		return host.mock.routes.find((r) => r.method === "GET" && r.path === "/state");
	}

	function call(route, url = "/state") {
		return new Promise((resolve) => {
			route.handler({ url, headers: {}, body: undefined }, {
				writeHead() {},
				end(body) {
					resolve(JSON.parse(body));
				},
			});
		});
	}

	it("labels each model and each row from the generated table", async () => {
		const host = await hostWith({
			generatedAt: "2026-09-24T21:00:00Z",
			summary: { total: 2, priced: 1, free: 1, manual: 0 },
			costs: {
				"openrouter/test/model": { in: 1, out: 2, source: "models-store.json" },
				"nvidia/nvidia/nemotron-3.5-lightning-30b-a3b": { in: 0, out: 0, source: "models.json" },
			},
		});
		await plugin.activate(host);
		const payload = await call(stateRoute(host));

		assert.equal(payload.costs["openrouter/test/model"].short, "$1/$2");
		assert.equal(payload.costs["nvidia/nvidia/nemotron-3.5-lightning-30b-a3b"].short, "free");
		assert.match(payload.costs["openrouter/test/model"].title, /per million tokens/);
		const priced = payload.rows.find((r) => r.name === "priced");
		assert.equal(priced.costShort, "$1/$2");
		assert.equal(payload.costMeta.summary.free, 1);
		assert.equal(payload.costMeta.missing, undefined);
	});

	it("degrades to n/a with a hint when no table exists", async () => {
		const host = await hostWith(null);
		await plugin.activate(host);
		const payload = await call(stateRoute(host));
		assert.deepEqual(payload.costs, {});
		assert.equal(payload.costMeta.missing, true);
		assert.match(payload.costMeta.hint, /agent-model-costs\.mjs/);
		const priced = payload.rows.find((r) => r.name === "priced");
		// A pin whose provider has no price data now says n/a explicitly (it used to show
		// nothing at all, which read as "no information" rather than "no price known").
		assert.equal(priced.costShort, "n/a");
		assert.equal(priced.tier, "unknown");
		assert.equal(priced.backups, 0);
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


describe("plugin: config routes", () => {
	let host;
	let writes;
	let configsData;
	let getConfigsRoute;
	let saveConfigRoute;
	let applyConfigRoute;
	let deleteConfigRoute;
	let stateRoute;

	before(async () => {
		const { readdirSync, readFileSync } = await import("node:fs");
		const root = fixtureWorkspace();
		const dir = join(root, ".pi", "agents");
		const files = new Map();
		for (const name of readdirSync(dir)) files.set(name, readFileSync(join(dir, name), "utf-8"));
		configsData = null;
		writes = [];

		host = createMockHost({
			cwd: root,
			fs: {
				list: async (rel) => {
					if (rel === ".pi/agents") {
						return [...files.keys()].sort().map((name) => ({ name, type: "file" }));
					}
					if (rel === ".pi/agent-models/backups") {
						return [];
					}
					return [];
				},
				readText: async (rel) => {
					if (rel === ".pi/agent-models/configs.json") {
						if (!configsData) throw new Error("ENOENT configs.json");
						return configsData;
					}
					const name = rel.split("/").pop();
					if (!files.has(name)) throw new Error("ENOENT " + rel);
					return files.get(name);
				},
				write: async (rel, data) => {
					writes.push({ rel, data: String(data) });
					if (rel.startsWith(".pi/agents/")) files.set(rel.split("/").pop(), String(data));
					if (rel === ".pi/agent-models/configs.json") configsData = String(data);
				},
				mkdir: async () => {},
			},
			models: { list: async () => [...CATALOG].map((id) => ({ id, provider: id.split("/")[0] })) },
		});

		await plugin.activate(host);
		getConfigsRoute = host.mock.routes.find((r) => r.method === "GET" && r.path === "/configs");
		saveConfigRoute = host.mock.routes.find((r) => r.method === "POST" && r.path === "/configs/save");
		applyConfigRoute = host.mock.routes.find((r) => r.method === "POST" && r.path === "/configs/apply");
		deleteConfigRoute = host.mock.routes.find((r) => r.method === "POST" && r.path === "/configs/delete");
		stateRoute = host.mock.routes.find((r) => r.path === "/state");
	});

	function callGetConfigs() {
		return new Promise((resolve) => {
			const res = { writeHead() {}, end(b) { try { resolve(JSON.parse(b)); } catch (err) { resolve({ parseError: String(err), raw: b }); } } };
			getConfigsRoute.handler({ url: "/configs", headers: {}, body: undefined }, res);
		});
	}

	function callPost(body, route) {
		return new Promise((resolve) => {
			const res = { writeHead() {}, end(b) { try { resolve(JSON.parse(b)); } catch (err) { resolve({ parseError: String(err), raw: b }); } } };
			route.handler({ url: "", headers: {}, body }, res);
		});
	}

	function callState(url = "/state") {
		return new Promise((resolve) => {
			const res = { writeHead() {}, end(b) { try { resolve(JSON.parse(b)); } catch (err) { resolve({ parseError: String(err), raw: b }); } } };
			stateRoute.handler({ url, headers: {}, body: undefined }, res);
		});
	}

	it("registers GET /configs", () => {
		assert.ok(getConfigsRoute, "GET /configs should be registered");
	});

	it("returns ok:true with an empty config list when no file exists", async () => {
		const p = await callGetConfigs();
		assert.equal(p.ok, true);
		assert.deepEqual(p.configs, []);
	});

	it("includes config summaries in the /state payload", async () => {
		// Save a config first
		const saved = await callPost({ name: "free-models", description: "All on free endpoints" }, saveConfigRoute);
		assert.equal(saved.ok, true);
		const state = await callState("/state?refresh=1");
		assert.ok(state.configs, "state.payload should include configs");
		assert.equal(state.configs.length, 1);
		assert.equal(state.configs[0].id, "free-models");
		assert.equal(state.configs[0].agentCount, 4);
		// Summary must NOT include pins
		assert.equal(state.configs[0].pins, undefined);
		});

	it("POST /configs/save captures all current agent pins", async () => {
		writes.length = 0;
		configsData = null;
		const p = await callPost({ name: "free-models", description: "All on free endpoints" }, saveConfigRoute);
		assert.equal(p.ok, true, p.error ?? "");
		assert.equal(p.config.id, "free-models");
		assert.equal(p.config.name, "free-models");
		assert.equal(p.config.description, "All on free endpoints");
		assert.equal(p.config.agentCount, 4);

		// Verify configs.json was written with pins
		const configWrite = writes.filter((w) => w.rel === ".pi/agent-models/configs.json").pop();
		assert.ok(configWrite, "configs.json must be written");
		const doc = JSON.parse(configWrite.data);
		assert.equal(doc.configs.length, 1);
		const cfg = doc.configs[0];
		assert.equal(cfg.pins.coder, "nvidia/nvidia/nemotron-3.5-lightning-30b-a3b");
		assert.equal(cfg.pins.reviewer, "opencode/mimo-v2.5-free");
		assert.equal(cfg.pins.vision, null);
		assert.equal(cfg.pins.testing, "nvidia/does-not-exist");
		assert.ok(cfg.createdAt, "createdAt should be set");
		assert.equal(cfg.createdAt, cfg.updatedAt, "createdAt === updatedAt on first save");
		});

	it("POST /configs/save upserts when the same name is saved again", async () => {
		configsData = null;
		writes.length = 0;
		// First save
		await callPost({ name: "My Config", description: "v1" }, saveConfigRoute);
		// Second save with same name but different pins (we changed coder first)
		const p = await callPost({ name: "My Config", description: "v2" }, saveConfigRoute);
		assert.equal(p.ok, true);
		const write = writes.filter((w) => w.rel === ".pi/agent-models/configs.json").pop();
		const doc = JSON.parse(write.data);
		assert.equal(doc.configs.length, 1, "should still be 1 (upsert, not append)");
		assert.equal(doc.configs[0].description, "v2");
		});

	it("POST /configs/save rejects an empty name", async () => {
		configsData = null;
		const p = await callPost({ name: "", description: "" }, saveConfigRoute);
		assert.equal(p.ok, false);
		assert.match(p.error, /name is required/);
		});

	it("POST /configs/apply batch-sets all pins from a saved config", async () => {
		// Set up: save a config where reviewer is pinned to a valid catalog model
		configsData = JSON.stringify({
			configs: [{
				id: "fix-all",
				name: "Fix All",
				description: null,
				createdAt: "2026-10-01T00:00:00.000Z",
				updatedAt: "2026-10-01T00:00:00.000Z",
				pins: {
					coder: "commandcode/Qwen/Qwen3.6-Plus",
					reviewer: "commandcode/z-ai/glm-5.3-flash",
					vision: null,
					testing: "nvidia/moonshotai/kimi-k3",
				},
			}],
		});
		writes.length = 0;
		const p = await callPost({ id: "fix-all" }, applyConfigRoute);
		assert.equal(p.ok, true, p.error ?? "");
		assert.equal(p.summary.applied, 2);
		assert.equal(p.summary.invalid, 1);

		// Verify each agent file was updated and backed up
		const configApplyBackups = writes.filter((w) => w.rel.includes("config-apply-fix-all"));
		assert.equal(configApplyBackups.length, 2, "each changed agent should get a backup");
		// reviewer's model is not in the catalog, so it should be skipped (invalid) and NOT written
		const reviewerFile = writes.find((w) => w.rel === ".pi/agents/reviewer.md");
		assert.equal(reviewerFile, undefined, "reviewer.md must NOT be written (model not in catalog)");
		});

	it("POST /configs/apply skips pins whose model is not in the live catalog", async () => {
		configsData = JSON.stringify({
			configs: [{
				id: "partial",
				name: "Partial",
				description: null,
				createdAt: "2026-10-01T00:00:00.000Z",
				updatedAt: "2026-10-01T00:00:00.000Z",
				pins: {
					coder: "nvidia/nvidia/nemotron-3.5-lightning-30b-a3b",
					reviewer: "openrouter/missing-seller/ghost-model",
				},
			}],
		});
		writes.length = 0;
		const p = await callPost({ id: "partial" }, applyConfigRoute);
		assert.equal(p.ok, true);
		assert.equal(p.summary.applied, 1, "only coder should be applied");
		assert.equal(p.summary.invalid, 1, "reviewer's model is not in the catalog");
		assert.equal(p.summary.invalidList[0].agent, "reviewer");
		});

	it("POST /configs/apply returns 404 for an unknown config id", async () => {
		configsData = JSON.stringify({ configs: [] });
		const p = await callPost({ id: "nope" }, applyConfigRoute);
		assert.equal(p.ok, false);
		assert.match(p.error, /not found/);
		});

	it("POST /configs/apply returns 400 for an empty id", async () => {
		const p = await callPost({ id: "" }, applyConfigRoute);
		assert.equal(p.ok, false);
		assert.match(p.error, /config id is required/);
		});

	it("POST /configs/delete removes a saved config", async () => {
		configsData = JSON.stringify({
			configs: [{
				id: "to-delete",
				name: "Delete Me",
				description: null,
				createdAt: "2026-10-01T00:00:00.000Z",
				updatedAt: "2026-10-01T00:00:00.000Z",
				pins: { coder: "nvidia/nvidia/nemotron-3.5-lightning-30b-a3b" },
			}],
		});
		writes.length = 0;
		const p = await callPost({ id: "to-delete" }, deleteConfigRoute);
		assert.equal(p.ok, true);
		assert.equal(p.deleted, "to-delete");
		assert.equal(p.configs.length, 0);
		const configWrite = writes.find((w) => w.rel === ".pi/agent-models/configs.json");
		assert.ok(configWrite, "configs.json must be rewritten");
		const doc = JSON.parse(configWrite.data);
		assert.equal(doc.configs.length, 0);
		});

	it("POST /configs/delete returns 404 for an unknown id", async () => {
		configsData = JSON.stringify({
			configs: [{ id: "exists", name: "Exists", description: null, createdAt: "2026-10-01T00:00:00.000Z", updatedAt: "2026-10-01T00:00:00.000Z", pins: {} }],
		});
		const p = await callPost({ id: "nope" }, deleteConfigRoute);
		assert.equal(p.ok, false);
		assert.match(p.error, /not found/);
		});

	it("GET /configs returns full configs with pins", async () => {
		configsData = JSON.stringify({
			configs: [{
				id: "full",
				name: "Full",
				description: "has pins",
				createdAt: "2026-10-01T00:00:00.000Z",
				updatedAt: "2026-10-01T00:00:00.000Z",
				pins: { coder: "nvidia/nvidia/nemotron-3.5-lightning-30b-a3b" },
			}],
		});
		const p = await callGetConfigs();
		assert.equal(p.ok, true);
		assert.equal(p.configs.length, 1);
		assert.equal(p.configs[0].pins.coder, "nvidia/nvidia/nemotron-3.5-lightening-30b-a3b".replace("-lightening", "-lightning"));
		});
		it("POST /configs/save with editId renames an existing config, preserving pins", async () => {
			// Pre-populate configsData with a saved config
			const originalPins = { coder: "nvidia/nvidia/nemotron-3.5-lightning-30b-a3b", reviewer: "opencode/mimo-v2.5-free" };
			configsData = JSON.stringify({
				configs: [{
					id: "old-id",
					name: "Old Name",
					description: "old desc",
					createdAt: "2026-10-01T00:00:00.000Z",
					updatedAt: "2026-10-01T00:00:00.000Z",
					pins: originalPins,
				}],
			});
			writes.length = 0;
			// Edit: rename to "New Name" with new description, keep the same id and pins
			const p = await callPost({ name: "New Name", description: "new desc", editId: "old-id" }, saveConfigRoute);
			assert.equal(p.ok, true, p.error ?? "");
			assert.equal(p.config.id, "old-id", "config id is preserved");
			assert.equal(p.config.name, "New Name", "name is updated");
			// Verify the written configs.json has the renamed config with original pins
			const configWrite = writes.filter((w) => w.rel === ".pi/agent-models/configs.json").pop();
			assert.ok(configWrite, "configs.json must be written");
			const doc = JSON.parse(configWrite.data);
			assert.equal(doc.configs.length, 1);
			const cfg = doc.configs[0];
			assert.equal(cfg.id, "old-id", "id preserved in written file");
			assert.equal(cfg.name, "New Name", "name updated in written file");
			assert.deepEqual(cfg.pins, originalPins, "pins preserved (not re-captured)");
		});

		it("POST /configs/save with editId returns 404 for unknown id", async () => {
			configsData = JSON.stringify({ configs: [] });
			writes.length = 0;
			const p = await callPost({ name: "New Name", editId: "does-not-exist" }, saveConfigRoute);
			assert.equal(p.ok, false);
			assert.equal(p.error, "config not found: does-not-exist");
		});
});

describe("plugin: POST /set-models (bulk write path)", () => {
	let host;
	let files;
	let writes;
	let route;

	before(async () => {
		const { readdirSync, readFileSync } = await import("node:fs");
		const root = fixtureWorkspace();
		const dir = join(root, ".pi", "agents");
		files = new Map();
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
		route = host.mock.routes.find((r) => r.method === "POST" && r.path === "/set-models");
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
			route.handler({ url: "/set-models", headers: {}, body }, res);
		});
	}

	it("registers POST /set-models", () => {
		assert.ok(route, "POST /set-models should be registered");
	});

	it("applies ONE model to MANY agents and backs each one up", async () => {
		const model = [...CATALOG].find((id) => !id.startsWith("opencode/"));
		writes.length = 0;
		const p = await post({ agents: ["coder", "reviewer", "testing"], model });
		assert.equal(p.ok, true, p.error ?? "");
		assert.equal(p.model, model);
		assert.equal(p.summary.requested, 3);
		assert.equal(p.summary.failed, 0);
		assert.ok(p.summary.applied >= 1, "at least one agent changed");
		assert.equal(p.results.length, 3);
		for (const r of p.results) {
			assert.equal(r.ok, true, r.reason ?? "");
			if (r.changed) {
				assert.equal(r.model, model);
				assert.ok(r.backup, "a changed file must carry a backup path");
			}
		}
		// Every changed agent file carries the pin on disk.
		const onDisk = [...files.entries()].filter(([, body]) => body.includes(`model: ${model}`)).map(([n]) => n);
		assert.ok(onDisk.length >= 1, "at least one agent file now pins the model");
		// A backup was written for each changed agent (same stamp = one group).
		const backups = writes.filter((w) => w.rel.includes("/backups/"));
		assert.equal(backups.length, p.summary.applied, "one backup per changed agent");
	});

	it("dedupes repeated agent names instead of double-writing", async () => {
		const model = [...CATALOG].find((id) => !id.startsWith("opencode/"));
		const p = await post({ agents: ["vision", "vision", " vision "], model });
		assert.equal(p.ok, true, p.error ?? "");
		assert.equal(p.summary.requested, 1, "duplicates collapse to one agent");
		assert.equal(p.results.length, 1);
	});

	it("treats an empty model as inherit for every selected agent", async () => {
		const p = await post({ agents: ["coder"], model: null });
		assert.equal(p.ok, true, p.error ?? "");
		assert.equal(p.model, null);
		const r = p.results[0];
		assert.equal(r.ok, true, r.reason ?? "");
		if (r.changed) assert.ok(!files.get("coder.md").includes("model:"), "inherit removes the pin line");
	});

	it("returns 400 when no agent is selected", async () => {
		const p = await post({ agents: [], model: CATALOG[0] });
		assert.equal(p.ok, false);
		assert.equal(p.error, "no agents selected");
	});

	it("rejects a path-traversal agent name before touching the filesystem", async () => {
		writes.length = 0;
		const p = await post({ agents: ["../../secrets"], model: CATALOG[0] });
		assert.equal(p.ok, false);
		assert.match(p.error, /invalid agent name/);
		assert.equal(writes.length, 0, "nothing is written on a rejected name");
	});

	it("returns 404 for an agent with no file", async () => {
		const p = await post({ agents: ["coder", "nope"], model: CATALOG[0] });
		assert.equal(p.ok, false);
		assert.match(p.error, /unknown agent\(s\): nope/);
	});

	it("rejects a model that is not in the live catalog", async () => {
		const p = await post({ agents: ["coder"], model: "nobody/no-such-model" });
		assert.equal(p.ok, false);
		assert.match(p.error, /not an available model/);
	});

	it("rejects a batch over the 100-agent cap", async () => {
		const many = Array.from({ length: 101 }, (_, i) => `a${i}`);
		const p = await post({ agents: many, model: CATALOG[0] });
		assert.equal(p.ok, false);
		assert.match(p.error, /too many agents/);
	});
});