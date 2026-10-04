/**
 * subagent-session.mjs: is this Pi session a sub-agent rather than the primary?
 *
 * WHY THIS MODULE EXISTS
 * routing.ts's workflow gates (plan-first, dispatch-first, review) apply to
 * the primary session only. A sub-agent session IS the delegate, so the gates
 * must not apply to it. Dispatch-first in particular used to regress
 * infinitely: a dispatched sub-agent that took longer than DISPATCH_WINDOW_MS
 * to reach its first edit was blocked, told to dispatch again to satisfy the
 * gate, and its delegate aged out the window and was blocked identically. The
 * window is a heuristic for quick dispatches and does not survive real work.
 *
 * WHAT IT REPLACES
 * The inline predicate routing.ts carried from commit 004454d until this
 * extraction. That version had a real defect: it read the transcript through
 * `ctx?.sessionManager?.getSessionFile?.()` and inverted the result, so when
 * getSessionFile was MISSING the optional call evaluated to undefined and the
 * inverted expression returned true, silently exempting the session from every
 * gate. A missing API is "cannot determine", and "cannot determine" must fail
 * closed. This module checks that getSessionFile is a function first and
 * returns false when it is not. The distinction matters because pi-web-ui
 * in-process sub-agents legitimately report an empty string OR undefined from
 * a PRESENT getSessionFile (same evidence the R17 rename enforcer in
 * routing.ts relies on): "determined: no transcript" is a sub-agent, while
 * "cannot determine" is not.
 *
 * THE SIGNALS, first match wins
 *   1. PI_SESSION_ID (positive primary id): when the host exports its own
 *      session id and the ctx carries the same id, this session IS the
 *      primary. Checked before every heuristic, because the transcript test
 *      below rests on the unverified invariant that a primary session always
 *      has a transcript file; if that invariant ever failed, every gate
 *      would silently switch off.
 *   2. GLITCH_SUBAGENT=1: the legacy task() path, a separate `pi -p` child
 *      process, flagged by dispatcher.ts.
 *   3. In-memory session: host sub-agents (subagent_spawn / delegate_task
 *      under pi-web-ui) run in-process with an in-memory session and no
 *      transcript file. Guarded by underPiWebUi because outside pi-web-ui a
 *      missing file must NOT read as sub-agent, or the gates would be
 *      silently off for TUI sessions.
 *
 * Fail closed everywhere: every undetermined state returns false, which keeps
 * the gates ON. A false negative (a sub-agent still gated) is recoverable; a
 * false positive (the primary exempted) silently disables every gate, which is
 * the worst possible outcome. The caller's catch fails OPEN, so this function
 * must never throw: a degenerate call with no argument bag falls back to the
 * ctx-less branch instead of throwing.
 *
 * Pure on purpose: ctx, env and underPiWebUi arrive as explicit parameters,
 * so node --test can drive every branch without touching process.env or pi
 * internals. Dependency-free, same pattern as root.mjs / plan-paths.mjs;
 * unit-tested in .pi/lib/subagent-session.test.mjs.
 */

/**
 * Classify a session. True ONLY for a positively identified sub-agent; false
 * for the primary and for every state that cannot be determined.
 *
 * @param {{
 *   ctx?: unknown,
 *   env?: Record<string, string | undefined>,
 *   underPiWebUi?: boolean,
 * }} [args]
 *   ctx: the Pi ExtensionContext to classify. env: the environment to read
 *   (routing.ts passes process.env; tests pass a literal object). underPiWebUi:
 *   precomputed answer to "are we running under pi-web-ui", passed in so this
 *   module never reads PI_WEB_PORT / PI_WEB_TOKEN itself.
 * @returns {boolean}
 */
export function isSubAgentSession({ ctx, env, underPiWebUi } = {}) {
	// Fail closed. A null or undefined ctx must never read as sub-agent: that
	// would exempt the primary and silently disable every gate in routing.ts.
	if (!ctx) return false;

	// The transcript probe below reads the session manager, so resolve it once.
	const manager = ctx.sessionManager;

	// Positive primary guard. When the host exports PI_SESSION_ID and this ctx
	// carries the same id, the session IS the primary, whatever the transcript
	// test below would say about it.
	const sid = ctx.sessionID ?? manager?.sessionId ?? manager?.id;
	if (typeof sid === "string" && sid === env?.PI_SESSION_ID) return false;

	// Signal 1: the legacy task() child process, flagged by dispatcher.ts.
	if (env?.GLITCH_SUBAGENT === "1") return true;

	// The in-memory-session signal is only trustworthy under pi-web-ui. In a
	// TUI the primary could be misread and every gate would silently go off.
	if (!underPiWebUi) return false;

	// Signal 2: no transcript. Property access AND call stay inside the try,
	// because a throwing getter must fail closed exactly like a throwing call.
	try {
		const getSessionFile = manager?.getSessionFile;
		// A missing API is "cannot determine", NOT "determined: no transcript".
		// The old inline predicate treated it as sub-agent and silently exempted
		// the session. A missing API must never exempt the primary.
		if (typeof getSessionFile !== "function") return false;
		const file = getSessionFile.call(manager);
		// A real transcript path means primary. An empty string, whitespace or
		// undefined from a PRESENT function is the in-memory session of a
		// pi-web-ui sub-agent.
		if (typeof file === "string" && file.trim()) return false;
		return true;
	} catch {
		return false;
	}
}
