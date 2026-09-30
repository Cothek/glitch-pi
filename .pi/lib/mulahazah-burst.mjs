/**
 * mulahazah-burst.mjs — pure helpers for the Pi-native token-burst trigger arm.
 *
 * Mirrors the OpenCode semantics from glitch-ai scripts/lib/mulahazah-helpers.mjs:43:
 * "TOKEN_THRESHOLD = 1_000_000 // new tokens (in+out+reasoning) since last write".
 * Cache traffic (cacheRead/cacheWrite) is deliberately EXCLUDED — a cache read is
 * the SAME context re-read, not new information, and counting it would make the
 * burst fire on the first couple of turns of any long session.
 *
 * The threshold is overridable via MULAHAZAH_BURST_TOKENS so tests and E2E runs
 * can fire the arm without burning a real million tokens.
 *
 * Dependency-free on purpose: mulahazah.ts imports it (TS → local .mjs, same
 * pattern as routing.ts → plan-paths.mjs), and .pi/lib/mulahazah-burst.test.mjs
 * imports it for node:test.
 */

/** Default: 1M new tokens (input+output+reasoning) since the last memory write. */
export const DEFAULT_BURST_TOKENS = 1_000_000;

/**
 * Parse the effective burst threshold from an env-like object.
 * Invalid, zero, or negative values fall back to the default (never disables
 * the arm silently — an explicit "0" means "use default", matching the
 * conservative posture of the trigger model).
 */
export function burstThresholdFromEnv(env = process.env, fallback = DEFAULT_BURST_TOKENS) {
	const raw = env && typeof env.MULAHAZAH_BURST_TOKENS === "string" ? env.MULAHAZAH_BURST_TOKENS.trim() : "";
	if (!raw) return fallback;
	const n = Number(raw);
	if (!Number.isFinite(n) || n <= 0) return fallback;
	return Math.floor(n);
}

/**
 * New tokens contributed by one assistant turn, from Pi's usage object
 * `{ input, output, cacheRead, cacheWrite, reasoning, totalTokens, cost }`.
 * Missing fields count as 0; cacheRead/cacheWrite are ignored by design.
 */
export function computeTurnTokens(usage) {
	if (!usage || typeof usage !== "object") return 0;
	const input = Number(usage.input) || 0;
	const output = Number(usage.output) || 0;
	const reasoning = Number(usage.reasoning) || 0;
	return input + output + reasoning;
}

/** Human token count: 950 → "950", 12_400 → "12.4K", 2_300_000 → "2.3M". */
export function formatTokenCount(n) {
	const v = Number(n) || 0;
	if (v >= 1_000_000) return `${(v / 1_000_000).toFixed(1)}M`;
	if (v >= 1_000) return `${(v / 1_000).toFixed(1)}K`;
	return `${v}`;
}

/**
 * Burst fire decision for one session entry.
 * Fires IFF the accumulated-since-write total crosses the threshold AND the
 * shared phrase/heartbeat cooldown has elapsed (a recent write already captured
 * this session's state; do not double-fire within the window).
 */
export function shouldFireBurst(tokensSinceWrite, threshold, cooldownElapsed) {
	return tokensSinceWrite >= threshold && cooldownElapsed === true;
}
