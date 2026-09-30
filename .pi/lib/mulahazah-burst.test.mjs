/**
 * mulahazah-burst.test.mjs — node --test suite for the Pi-native token-burst helpers.
 * Run: node --test .pi/lib/mulahazah-burst.test.mjs
 */
import test from "node:test";
import assert from "node:assert/strict";

import {
	DEFAULT_BURST_TOKENS,
	burstThresholdFromEnv,
	computeTurnTokens,
	formatTokenCount,
	shouldFireBurst,
} from "./mulahazah-burst.mjs";

test("default threshold is 1M new tokens", () => {
	assert.equal(DEFAULT_BURST_TOKENS, 1_000_000);
});

test("burstThresholdFromEnv: valid override wins", () => {
	assert.equal(burstThresholdFromEnv({ MULAHAZAH_BURST_TOKENS: "100" }), 100);
	assert.equal(burstThresholdFromEnv({ MULAHAZAH_BURST_TOKENS: " 5000 " }), 5000);
});

test("burstThresholdFromEnv: invalid/zero/negative falls back to default", () => {
	assert.equal(burstThresholdFromEnv({ MULAHAZAH_BURST_TOKENS: "abc" }), DEFAULT_BURST_TOKENS);
	assert.equal(burstThresholdFromEnv({ MULAHAZAH_BURST_TOKENS: "0" }), DEFAULT_BURST_TOKENS);
	assert.equal(burstThresholdFromEnv({ MULAHAZAH_BURST_TOKENS: "-5" }), DEFAULT_BURST_TOKENS);
	assert.equal(burstThresholdFromEnv({}), DEFAULT_BURST_TOKENS);
	assert.equal(burstThresholdFromEnv(undefined), DEFAULT_BURST_TOKENS);
});

test("computeTurnTokens: input+output+reasoning, cache excluded", () => {
	// Real shape from a live session jsonl (2026-09-29): cacheRead 233856 with
	// only 1489 input tokens — counting cache would fire the burst instantly.
	const usage = { input: 1489, output: 925, cacheRead: 233856, cacheWrite: 0, reasoning: 658, totalTokens: 236270 };
	assert.equal(computeTurnTokens(usage), 1489 + 925 + 658);
});

test("computeTurnTokens: missing fields count as zero", () => {
	assert.equal(computeTurnTokens({ input: 10 }), 10);
	assert.equal(computeTurnTokens({ output: 5, reasoning: 5 }), 10);
	assert.equal(computeTurnTokens({}), 0);
	assert.equal(computeTurnTokens(null), 0);
	assert.equal(computeTurnTokens("nope"), 0);
});

test("formatTokenCount: human forms", () => {
	assert.equal(formatTokenCount(950), "950");
	assert.equal(formatTokenCount(12_400), "12.4K");
	assert.equal(formatTokenCount(2_300_000), "2.3M");
	assert.equal(formatTokenCount(0), "0");
});

test("shouldFireBurst: fires only past threshold AND off cooldown", () => {
	assert.equal(shouldFireBurst(1_000_000, 1_000_000, true), true);
	assert.equal(shouldFireBurst(1_000_001, 1_000_000, true), true);
	assert.equal(shouldFireBurst(999_999, 1_000_000, true), false);
	assert.equal(shouldFireBurst(2_000_000, 1_000_000, false), false, "cooldown blocks double-fire");
	assert.equal(shouldFireBurst(2_000_000, 1_000_000, undefined), false, "cooldown must be explicit true");
});
