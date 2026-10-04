/**
 * subagent-session.test.mjs - proves the sub-agent predicate can never exempt
 * the primary session.
 *
 * isSubAgentSession decides whether routing.ts's workflow gates (plan-first,
 * dispatch-first, review) apply to a session. A false positive (the primary
 * misread as a sub-agent) silently disables every gate, which is the worst
 * possible outcome, so every test here pins a branch that could produce one.
 * env is always passed explicitly: these tests never touch process.env, which
 * is the whole reason the module takes ctx, env and underPiWebUi as parameters
 * instead of reading globals.
 */

import test from "node:test";
import assert from "node:assert/strict";

import { isSubAgentSession } from "./subagent-session.mjs";

/**
 * Classify `ctx` with caller-overridable env and underPiWebUi, defaulting to
 * the sub-agent-favourable shape: under pi-web-ui with no env signals. Every
 * test overrides exactly the signals it asserts, so each branch stays pinned
 * even when unrelated defaults change.
 */
function check(ctx, { env = {}, underPiWebUi = true } = {}) {
	return isSubAgentSession({ ctx, env, underPiWebUi });
}

/** A sessionManager whose getSessionFile returns `file` (default: a real transcript). */
function manager(file = "C:/x/session.jsonl") {
	return { getSessionFile: () => file };
}

test("a null or undefined ctx is never a sub-agent", () => {
	assert.equal(check(undefined), false);
	assert.equal(check(null), false);
	// Even the strongest sub-agent signal cannot rescue a missing ctx: the
	// fail-closed branch runs before every signal.
	assert.equal(check(undefined, { env: { GLITCH_SUBAGENT: "1" } }), false);
});

test("a call with no argument bag at all fails closed instead of throwing", () => {
	// routing.ts's tool_call catch fails OPEN, so a throw here would silently
	// skip every gate. The default must collapse to the ctx-less branch.
	assert.equal(isSubAgentSession(), false);
	assert.equal(isSubAgentSession(undefined), false);
});

test("a ctx with no sessionManager fails closed even under pi-web-ui", () => {
	assert.equal(check({}), false);
	assert.equal(check({ sessionID: "sess-1" }), false);
});

test("a missing getSessionFile is 'cannot determine', never an exemption", () => {
	// The defect this extraction fixes: the old inline predicate treated a
	// missing getSessionFile as "no transcript" and exempted the session.
	assert.equal(check({ sessionManager: {} }), false);
	assert.equal(check({ sessionManager: { sessionId: "sess-1" } }), false);
	// Present but not callable: same verdict, cannot determine.
	assert.equal(check({ sessionManager: { getSessionFile: "C:/x/session.jsonl" } }), false);
});

test("a getSessionFile that throws fails closed", () => {
	const ctx = {
		sessionManager: {
			getSessionFile() {
				throw new Error("boom");
			},
		},
	};
	assert.equal(check(ctx), false);
});

test("a real transcript path means primary", () => {
	assert.equal(check({ sessionManager: manager("C:/x/session.jsonl") }), false);
	assert.equal(check({ sessionID: "sess-1", sessionManager: manager() }), false);
});

test("a session id matching PI_SESSION_ID is primary even with an empty transcript", () => {
	const ctx = {
		sessionID: "sess-primary",
		sessionManager: manager(""),
	};
	// The positive primary guard must fire before the transcript test AND
	// before the GLITCH_SUBAGENT flag: a positively identified primary is
	// never exempted, whatever the heuristics would say.
	const env = { PI_SESSION_ID: "sess-primary", GLITCH_SUBAGENT: "1" };
	assert.equal(check(ctx, { env, underPiWebUi: false }), false);
});

test("the primary guard finds the session id through every lookup path", () => {
	// ctx.sessionID is covered above; these pin the sessionManager fallbacks.
	assert.equal(
		check({ sessionManager: { sessionId: "s-manager", getSessionFile: () => "" } }, { env: { PI_SESSION_ID: "s-manager" } }),
		false,
	);
	assert.equal(
		check({ sessionManager: { id: "s-sm", getSessionFile: () => "" } }, { env: { PI_SESSION_ID: "s-sm" } }),
		false,
	);
	// A NON-matching PI_SESSION_ID must not block a genuine sub-agent.
	assert.equal(check({ sessionID: "sess-other", sessionManager: manager("") }, { env: { PI_SESSION_ID: "sess-primary" } }), true);
});

test("GLITCH_SUBAGENT=1 flags the legacy task() child process", () => {
	// The task() child is a real session with a transcript, running outside
	// pi-web-ui: the flag must outrank both the transcript and the web guard.
	const ctx = { sessionManager: manager("C:/x/child-session.jsonl") };
	assert.equal(check(ctx, { env: { GLITCH_SUBAGENT: "1" }, underPiWebUi: false }), true);
});

test("outside pi-web-ui an empty transcript is not a sub-agent signal", () => {
	// TUI primaries must keep every gate: without the web guard a TUI session
	// with an empty transcript would be silently exempted.
	assert.equal(check({ sessionManager: manager("") }, { env: {}, underPiWebUi: false }), false);
	assert.equal(check({ sessionManager: { getSessionFile: () => undefined } }, { env: {}, underPiWebUi: false }), false);
});

test("an in-memory pi-web-ui sub-agent reports an empty transcript path", () => {
	assert.equal(check({ sessionManager: manager("") }), true);
});

test("an in-memory pi-web-ui sub-agent may report undefined", () => {
	// The rename enforcer in routing.ts documents both shapes: pi-web-ui
	// in-process sub-agents report "" OR undefined from getSessionFile.
	assert.equal(check({ sessionManager: { getSessionFile: () => undefined } }), true);
});

test("a whitespace-only transcript path is an in-memory session, not a primary", () => {
	assert.equal(check({ sessionManager: manager("   \n\t ") }), true);
});
