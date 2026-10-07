/**
 * extension-event-contracts.test.mjs — pins the event-payload contract that the
 * review gate depends on.
 *
 * WHY THIS EXISTS: @earendil-works/pi-coding-agent emits `tool_execution_end`
 * with ONLY { type, toolCallId, toolName, result, isError } — no `args`
 * (verified in dist/core/agent-session.js, lines 947-956). routing.ts used to
 * read the agent name out of `event.args` on that event, so extractAgentName()
 * always returned "unknown", `pendingReview` was never set to true, and
 * writeReviewPassMarker() was never called. The review gate silently never fired:
 * commits passed with a stale marker and the older reminders' "no review-pass
 * marker exists yet" complaint was really this bug.
 *
 * The fix recovers the args from the matching `tool_execution_start`, which DOES
 * carry them (lines 928-936). These assertions fail loudly if anyone puts the
 * read back onto the END event.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROUTING_PATH = join(HERE, "..", "extensions", "routing.ts");
const ROUTING = readFileSync(ROUTING_PATH, "utf-8");

test("routing.ts subscribes to tool_execution_start", () => {
	assert.match(
		ROUTING,
		/tool_execution_start/,
		"must subscribe to tool_execution_start: the END event carries no args, so the dispatch agent name is unrecoverable without it",
	);
});

test("routing.ts joins dispatch args by toolCallId", () => {
	assert.match(
		ROUTING,
		/dispatchArgsByCallId/,
		"must keep the toolCallId -> args map between the START and END events",
	);
	assert.match(
		ROUTING,
		/dispatchArgsByCallId\.get\(\s*callId\s*\)/,
		"the tool_execution_end handler must read the args from the map, not from event.args (which is always undefined there)",
	);
});
