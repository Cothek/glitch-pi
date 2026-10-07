/**
 * root.mjs — the single source of truth for WHERE the Glitch root is.
 *
 * WHY THIS MODULE EXISTS
 * Glitch's root is the folder that owns .pi/extensions, .pi/skills, scripts/,
 * config/, data/ and user/. Nine consumers used to hardcode one machine's
 * absolute path, so on any other machine they either failed or, worse, silently
 * pointed at a folder that does not exist. Two more resolved the root
 * differently from each other (process.cwd() versus ctx.cwd), which made
 * routing.ts and agent-switcher.ts read DIFFERENT user/agent-mode.json files.
 * That disagreement inverted every mode-dependent gate on 2026-10-03.
 *
 * THE RULE
 * Every consumer lives INSIDE the root (.pi/extensions/*.ts, .pi/lib/*.mjs,
 * scripts/pi-web-plugins/<plugin>/index.mjs). So the most reliable anchor is the
 * consumer's own module location: it needs no cwd, no env var and no config
 * file, and it cannot be wrong unless the file itself was moved out of the root.
 * That is why module location outranks cwd here.
 *
 * PRECEDENCE (first hit wins)
 *   1. GLITCH_PI_ROOT env var — the installer's explicit override.
 *   2. Walk up from this module's own location (inside the root).
 *   3. Walk up from process.cwd() — for a bare `node script.mjs` run from
 *      elsewhere that still wants root-relative behaviour.
 *   4. Throw with an actionable message. Never guess, never silently fall back
 *      to a hardcoded path.
 *
 * Dependency-free on purpose: extensions import it, and `node --test` imports
 * it (.pi/lib/root.test.mjs). Same pattern as plan-paths.mjs and mutating-ops.mjs.
 */

import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Root markers. BOTH must be present, which is what distinguishes the Glitch
 * root from a project that merely has a .pi/ folder of its own (for example
 * code/audio-recorder, which carries an untracked .pi/ and user/).
 */
export const ROOT_MARKERS = [join(".pi", "settings.json"), join(".pi", "extensions")];

/** True when `dir` carries every root marker. */
export function isGlitchRoot(dir) {
	if (typeof dir !== "string" || !dir.trim()) return false;
	return ROOT_MARKERS.every((marker) => existsSync(join(dir, marker)));
}

/**
 * Walk up from `startDir` to the nearest Glitch root.
 * Returns null when no ancestor qualifies — callers decide whether that is an
 * error, because a probe for "is this a root?" wants null while a consumer
 * wants a thrown error.
 */
export function findRootUpwards(startDir) {
	if (typeof startDir !== "string" || !startDir.trim()) return null;
	let dir = resolve(startDir);
	for (;;) {
		if (isGlitchRoot(dir)) return dir;
		const parent = dirname(dir);
		if (parent === dir) return null;
		dir = parent;
	}
}

// Memoized only for the non-env paths. The env branch deliberately bypasses the
// cache so a restart script (or a test) can change GLITCH_PI_ROOT and see it.
let cachedRoot = null;

/**
 * Resolve the Glitch root. Throws rather than guessing.
 *
 * @param {{from?: string}} [options] — `from` seeds the upward walk; used by
 *   tests and by callers that know their own project dir.
 * @returns {string} absolute path to the Glitch root
 */
export function glitchRoot(options = {}) {
	const env = process.env.GLITCH_PI_ROOT;
	if (typeof env === "string" && env.trim()) return resolve(env.trim());
	if (cachedRoot) return cachedRoot;

	const here = dirname(fileURLToPath(import.meta.url)); // <root>/.pi/lib
	const seeds = [];
	if (options && typeof options.from === "string" && options.from.trim()) {
		seeds.push(resolve(options.from));
	}
	seeds.push(here, process.cwd());

	for (const seed of seeds) {
		const found = findRootUpwards(seed);
		if (found) {
			cachedRoot = found;
			return found;
		}
	}

	throw new Error(
		"Glitch root not found. Looked upward from " +
			seeds.join(", ") +
			". A Glitch root contains .pi/settings.json and .pi/extensions. " +
			"Set GLITCH_PI_ROOT to the folder that holds them.",
	);
}

/**
 * Join a path relative to the Glitch root. The only sanctioned way for code
 * inside Glitch to build an absolute path, so nothing needs a machine-specific
 * literal.
 *
 * KNOWN LIMITATION: this is a thin join(), so a caller passing ".." escapes the
 * root. node:path normalizes the traversal away. Callers must not pass "..".
 *
 * @param {...string} segments
 * @returns {string}
 */
export function glitchPath(...segments) {
	return join(glitchRoot(), ...segments);
}

/** Test seam: forget the memoized root. */
export function resetRootCache() {
	cachedRoot = null;
}