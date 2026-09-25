/**
 * dispatch-plan.test.mjs — the rules that decide what a sub-agent actually runs on.
 *
 * These are the two failure modes this project has already been bitten by:
 *   - a pin to a provider that does not exist on pi (silently running the parent model),
 *   - a thinking level that either does not reach the child or overrides a pinned model's
 *     own default when it should not.
 * Both are decided here rather than inside the extension so they can be tested without
 * the pi runtime.
 *
 * Run: node --test .pi/lib/dispatch-plan.test.mjs
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { planDispatch, DROPPED_MODEL_RE } from "./dispatch-plan.mjs";

describe("dispatch plan: model", () => {
	it("uses a real pin", () => {
		const p = planDispatch({ agentModel: "commandcode/z-ai/glm-5.3-flash", parentModel: "nvidia/moonshotai/kimi-k3" });
		assert.equal(p.model, "commandcode/z-ai/glm-5.3-flash");
		assert.equal(p.inherits, false);
		assert.equal(p.droppedPin, false);
	});

	it("inherits the parent model when there is no pin", () => {
		const p = planDispatch({ parentModel: "nvidia/moonshotai/kimi-k3" });
		assert.equal(p.model, "nvidia/moonshotai/kimi-k3");
		assert.equal(p.inherits, true);
		assert.equal(p.droppedPin, false);
	});

	it("treats an opencode/opencode-go pin as dead and inherits instead", () => {
		for (const pin of ["opencode/mimo-v2.5-free", "opencode-go/qwen3.6-plus"]) {
			const p = planDispatch({ agentModel: pin, parentModel: "nvidia/moonshotai/kimi-k3" });
			assert.equal(p.model, "nvidia/moonshotai/kimi-k3", pin);
			assert.equal(p.inherits, true, pin);
			assert.equal(p.droppedPin, true, pin);
		}
		assert.ok(DROPPED_MODEL_RE.test("opencode/x"));
		assert.ok(!DROPPED_MODEL_RE.test("commandcode/x"));
	});

	it("survives an empty pin and an absent parent model", () => {
		const p = planDispatch({ agentModel: "   ", parentModel: null });
		assert.equal(p.model, undefined);
		assert.equal(p.inherits, true);
		assert.equal(p.droppedPin, false);
	});
});

describe("dispatch plan: thinking level", () => {
	it("forwards the parent level when the agent inherits the model", () => {
		const p = planDispatch({ parentModel: "nvidia/kimi-k3", parentThinking: "high" });
		assert.equal(p.thinking, "high");
	});

	it("does NOT forward the parent level to a pinned model", () => {
		// A pinned model has its own default effort; inheriting the parent's would be a
		// surprising override, which is the behaviour this rule preserves.
		const p = planDispatch({ agentModel: "commandcode/Qwen/Qwen3.6-Plus", parentModel: "nvidia/kimi-k3", parentThinking: "high" });
		assert.equal(p.thinking, undefined);
	});

	it("lets a declared thinkingLevel win, pinned or not", () => {
		const pinned = planDispatch({ agentModel: "commandcode/Qwen/Qwen3.6-Plus", agentThinking: "minimal", parentThinking: "high" });
		assert.equal(pinned.thinking, "minimal");
		const inherited = planDispatch({ agentThinking: "minimal", parentModel: "nvidia/kimi-k3", parentThinking: "high" });
		assert.equal(inherited.thinking, "minimal");
	});

	it("still applies a declared level when the pin was dropped", () => {
		const p = planDispatch({ agentModel: "opencode/mimo-v2.5-free", agentThinking: "low", parentModel: "nvidia/kimi-k3", parentThinking: "high" });
		assert.equal(p.model, "nvidia/kimi-k3");
		assert.equal(p.thinking, "low");
		assert.equal(p.droppedPin, true);
	});
});
