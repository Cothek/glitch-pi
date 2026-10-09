/**
 * dispatch-plan.test.mjs — the rules that decide what a sub-agent actually runs on.
 *
 * Run: node --test .pi/lib/dispatch-plan.test.mjs
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { planDispatch, DROPPED_MODEL_RE } from "./dispatch-plan.mjs";

describe("dispatch plan: model", () => {
	it("uses a real pin, and the chain is the pin", () => {
		const p = planDispatch({ agentModel: "commandcode/z-ai/glm-5.3-flash", parentModel: "nvidia/moonshotai/kimi-k3" });
		assert.equal(p.model, "commandcode/z-ai/glm-5.3-flash");
		assert.deepEqual(p.chain, ["commandcode/z-ai/glm-5.3-flash"]);
		assert.equal(p.inherits, false);
		assert.deepEqual(p.dropped, []);
	});

	it("inherits the parent model when there is no pin", () => {
		const p = planDispatch({ parentModel: "nvidia/moonshotai/kimi-k3" });
		assert.equal(p.model, "nvidia/moonshotai/kimi-k3");
		assert.deepEqual(p.chain, ["nvidia/moonshotai/kimi-k3"]);
		assert.equal(p.inherits, true);
	});

	it("drops an opencode/opencode-go pin and reports it in the dropped list", () => {
		for (const pin of ["opencode/mimo-v2.5-free", "opencode-go/qwen3.6-plus"]) {
			const p = planDispatch({ agentModel: pin, parentModel: "nvidia/moonshotai/kimi-k3" });
			assert.equal(p.model, "nvidia/moonshotai/kimi-k3", pin);
			assert.deepEqual(p.chain, ["nvidia/moonshotai/kimi-k3"]);
			assert.deepEqual(p.dropped, [pin]);
		}
		assert.ok(DROPPED_MODEL_RE.test("opencode/x"));
		assert.ok(!DROPPED_MODEL_RE.test("commandcode/x"));
	});

	it("survives an empty pin and an absent parent model", () => {
		const p = planDispatch({ agentModel: "   ", parentModel: null });
		assert.equal(p.model, undefined);
		assert.deepEqual(p.chain, []);
		assert.equal(p.inherits, true);
	});
});

describe("dispatch plan: fallback chain", () => {
	it("orders pin then fallbacks, deduplicates, and keeps the pin first", () => {
		const p = planDispatch({
			agentModel: "commandcode/poolside/laguna-s-2.1-free",
			agentFallbacks: ["commandcode/z-ai/glm-5.3-flash", "nvidia/llama-3.1-nemotron-51b-instruct", "commandcode/z-ai/glm-5.3-flash"],
			parentModel: "nvidia/moonshotai/kimi-k3",
		});
		assert.deepEqual(p.chain, [
			"commandcode/poolside/laguna-s-2.1-free",
			"commandcode/z-ai/glm-5.3-flash",
			"nvidia/llama-3.1-nemotron-51b-instruct",
		]);
		assert.equal(p.inherits, false);
		assert.deepEqual(p.dropped, []);
	});

	it("filters dead-provider entries out of the chain, not silently into it", () => {
		const p = planDispatch({
			agentModel: "opencode/mimo-v2.5-free",
			agentFallbacks: "commandcode/z-ai/glm-5.3-flash, opencode-go/qwen3.6-plus, nvidia/llama-3.1-nemotron-51b-instruct",
			parentModel: "nvidia/moonshotai/kimi-k3",
		});
		assert.deepEqual(p.chain, ["commandcode/z-ai/glm-5.3-flash", "nvidia/llama-3.1-nemotron-51b-instruct"]);
		assert.deepEqual(p.dropped, ["opencode/mimo-v2.5-free", "opencode-go/qwen3.6-plus"]);
		assert.equal(p.inherits, false, "the first hop is a declared fallback, not the parent");
	});

	it("uses the parent only when nothing usable was declared (pin dead, no fallbacks)", () => {
		const p = planDispatch({
			agentModel: "opencode/mimo-v2.5-free",
			parentModel: "nvidia/moonshotai/kimi-k3",
		});
		assert.deepEqual(p.chain, ["nvidia/moonshotai/kimi-k3"]);
		assert.equal(p.inherits, true);
	});

	it("accepts a bracketed fallback list too", () => {
		const p = planDispatch({
			agentModel: "commandcode/a",
			agentFallbacks: "[commandcode/b, nvidia/c]",
			parentModel: "nvidia/x",
		});
		assert.deepEqual(p.chain, ["commandcode/a", "commandcode/b", "nvidia/c"]);
	});
});

describe("dispatch plan: thinking level", () => {
	it("forwards the parent level only when the agent inherits the parent model", () => {
		const p = planDispatch({ parentModel: "nvidia/kimi-k3", parentThinking: "high" });
		assert.equal(p.thinking, "high");
	});

	it("does NOT forward the parent level onto a pinned model", () => {
		const p = planDispatch({ agentModel: "commandcode/Qwen/Qwen3.6-Plus", parentModel: "nvidia/kimi-k3", parentThinking: "high" });
		assert.equal(p.thinking, undefined);
	});

	it("does NOT forward the parent level onto a declared fallback either", () => {
		// A declared fallback is a declared model: same rule, same reason.
		const p = planDispatch({
			agentModel: "opencode/mimo-v2.5-free",
			agentFallbacks: ["commandcode/z-ai/glm-5.3-flash"],
			parentModel: "nvidia/kimi-k3",
			parentThinking: "high",
		});
		assert.equal(p.thinking, undefined);
		assert.equal(p.inherits, false);
	});

	it("lets a declared thinkingLevel win, pinned or not, and keeps it through a fall", () => {
		const pinned = planDispatch({ agentModel: "commandcode/Qwen/Qwen3.6-Plus", agentThinking: "minimal", parentThinking: "high" });
		assert.equal(pinned.thinking, "minimal");
		const inherited = planDispatch({ agentThinking: "minimal", parentModel: "nvidia/kimi-k3", parentThinking: "high" });
		assert.equal(inherited.thinking, "minimal");
	});
});

describe("dispatch plan: availableModels validation", () => {
	const catalog = new Set([
		"commandcode/z-ai/glm-5.3-flash",
		"nvidia/moonshotai/kimi-k3",
		"nvidia/llama-3.1-nemotron-51b-instruct",
		"commandcode/poolside/laguna-s-2.1-free",
	]);

	it("is backward compatible when availableModels is omitted", () => {
		const p = planDispatch({ agentModel: "fake/provider/model", parentModel: "nvidia/kimi-k3" });
		assert.equal(p.model, "fake/provider/model");
		assert.deepEqual(p.unresolved, []);
	});

	it("is backward compatible when availableModels is an empty Set", () => {
		const p = planDispatch({ agentModel: "fake/provider/model", parentModel: "nvidia/kimi-k3", availableModels: new Set() });
		assert.equal(p.model, "fake/provider/model");
		assert.deepEqual(p.unresolved, []);
	});

	it("keeps a pin that is in the catalog", () => {
		const p = planDispatch({ agentModel: "commandcode/z-ai/glm-5.3-flash", parentModel: "nvidia/kimi-k3", availableModels: catalog });
		assert.equal(p.model, "commandcode/z-ai/glm-5.3-flash");
		assert.deepEqual(p.chain, ["commandcode/z-ai/glm-5.3-flash"]);
		assert.deepEqual(p.unresolved, []);
	});

	it("rejects a pin not in the catalog and falls through to fallbacks", () => {
		const p = planDispatch({
			agentModel: "fake/unavailable/model",
			agentFallbacks: ["commandcode/z-ai/glm-5.3-flash", "nvidia/llama-3.1-nemotron-51b-instruct"],
			parentModel: "nvidia/kimi-k3",
			availableModels: catalog,
		});
		assert.equal(p.model, "commandcode/z-ai/glm-5.3-flash");
		assert.deepEqual(p.chain, ["commandcode/z-ai/glm-5.3-flash", "nvidia/llama-3.1-nemotron-51b-instruct"]);
		assert.deepEqual(p.unresolved, ["fake/unavailable/model"]);
		assert.equal(p.inherits, false);
	});

	it("filters unavailable fallbacks out of the chain", () => {
		const p = planDispatch({
			agentModel: "commandcode/z-ai/glm-5.3-flash",
			agentFallbacks: ["fake/gone/model", "nvidia/llama-3.1-nemotron-51b-instruct"],
			parentModel: "nvidia/kimi-k3",
			availableModels: catalog,
		});
		assert.deepEqual(p.chain, ["commandcode/z-ai/glm-5.3-flash", "nvidia/llama-3.1-nemotron-51b-instruct"]);
		assert.deepEqual(p.unresolved, ["fake/gone/model"]);
	});

	it("inherits the parent when pin and all fallbacks are unavailable", () => {
		const p = planDispatch({
			agentModel: "fake/pin/gone",
			agentFallbacks: ["fake/fb1/gone", "fake/fb2/gone"],
			parentModel: "nvidia/moonshotai/kimi-k3",
			availableModels: catalog,
		});
		assert.deepEqual(p.chain, ["nvidia/moonshotai/kimi-k3"]);
		assert.equal(p.inherits, true);
		assert.deepEqual(p.unresolved, ["fake/pin/gone", "fake/fb1/gone", "fake/fb2/gone"]);
	});

	it("rejects the parent model too when inheriting and parent is unavailable", () => {
		const p = planDispatch({
			agentModel: "fake/pin/gone",
			parentModel: "fake/parent/gone",
			availableModels: catalog,
		});
		assert.deepEqual(p.chain, []);
		assert.equal(p.model, undefined);
		assert.equal(p.inherits, true);
		assert.deepEqual(p.unresolved, ["fake/pin/gone", "fake/parent/gone"]);
	});

	it("combines dropped (dead provider) and unresolved (not in catalog) independently", () => {
		const p = planDispatch({
			agentModel: "opencode/mimo-v2.5-free",
			agentFallbacks: ["fake/gone/model", "commandcode/z-ai/glm-5.3-flash"],
			parentModel: "nvidia/kimi-k3",
			availableModels: catalog,
		});
		assert.deepEqual(p.chain, ["commandcode/z-ai/glm-5.3-flash"]);
		assert.deepEqual(p.dropped, ["opencode/mimo-v2.5-free"]);
		assert.deepEqual(p.unresolved, ["fake/gone/model"]);
	});
});
