/**
 * root.test.mjs — root resolution.
 *
 * Every fixture is built in a temp dir, so these tests assert MACHINE-INDEPENDENT
 * behavior: they never hardcode an absolute Glitch path, because the whole point
 * of root.mjs is that no absolute path is baked in. A test that passed only on
 * one machine would defeat the module.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
	ROOT_MARKERS,
	findRootUpwards,
	glitchPath,
	glitchRoot,
	isGlitchRoot,
	resetRootCache,
} from "./root.mjs";

/** Build a throwaway Glitch root under the OS temp dir. Caller must clean up. */
function makeRoot(label) {
	const base = mkdtempSync(join(tmpdir(), `glitch-root-${label}-`));
	const root = join(base, "glitch-pi");
	mkdirSync(join(root, ".pi", "extensions"), { recursive: true });
	writeFileSync(join(root, ".pi", "settings.json"), "{}", "utf8");
	return { base, root };
}

/** Run `fn` with GLITCH_PI_ROOT forced to `value` (or absent when null). */
function withEnv(value, fn) {
	const prior = process.env.GLITCH_PI_ROOT;
	if (value === null) delete process.env.GLITCH_PI_ROOT;
	else process.env.GLITCH_PI_ROOT = value;
	try {
		return fn();
	} finally {
		if (prior === undefined) delete process.env.GLITCH_PI_ROOT;
		else process.env.GLITCH_PI_ROOT = prior;
		resetRootCache();
	}
}

test("ROOT_MARKERS requires both .pi/settings.json and .pi/extensions", () => {
	assert.equal(ROOT_MARKERS.length, 2);
	assert.ok(ROOT_MARKERS.includes(join(".pi", "settings.json")));
	assert.ok(ROOT_MARKERS.includes(join(".pi", "extensions")));
});

test("isGlitchRoot accepts a complete root and rejects a partial one", () => {
	const { base, root } = makeRoot("markers");
	try {
		assert.equal(isGlitchRoot(root), true);
		assert.equal(isGlitchRoot(base), false, "parent without markers is not a root");

		// A project with its own .pi/ but no settings.json must NOT match — this
		// is the code/audio-recorder shape.
		const decoy = join(base, "decoy");
		mkdirSync(join(decoy, ".pi", "skills"), { recursive: true });
		assert.equal(isGlitchRoot(decoy), false);

		assert.equal(isGlitchRoot(""), false);
		assert.equal(isGlitchRoot(null), false);
	} finally {
		rmSync(base, { recursive: true, force: true });
	}
});

test("findRootUpwards finds the root from the root and from nested dirs", () => {
	const { base, root } = makeRoot("upwards");
	try {
		assert.equal(findRootUpwards(root), root);

		const deep = join(root, "data", "plans", "sessions", "abc");
		mkdirSync(deep, { recursive: true });
		assert.equal(findRootUpwards(deep), root, "walks up from a nested dir");

		assert.equal(findRootUpwards(join(root, "..")), null, "parent has no markers");
		assert.equal(findRootUpwards(""), null);
		assert.equal(findRootUpwards(undefined), null);
	} finally {
		rmSync(base, { recursive: true, force: true });
	}
});

test("glitchRoot honors GLITCH_PI_ROOT above everything else", () => {
	const { base, root } = makeRoot("env");
	try {
		withEnv(root, () => {
			assert.equal(glitchRoot(), root);
			assert.equal(glitchPath("user", "main-memory.md"), join(root, "user", "main-memory.md"));
		});
	} finally {
		rmSync(base, { recursive: true, force: true });
	}
});

test("glitchRoot ignores a blank GLITCH_PI_ROOT", () => {
	withEnv("   ", () => {
		const root = glitchRoot();
		assert.ok(existsSync(join(root, ".pi", "settings.json")), "falls through to a real root");
	});
});

test("glitchRoot resolves this module's own root with no env var", () => {
	withEnv(null, () => {
		const root = glitchRoot();
		assert.ok(existsSync(join(root, ".pi", "settings.json")));
		assert.ok(existsSync(join(root, ".pi", "extensions")));
		assert.ok(existsSync(join(root, ".pi", "lib")), "the root contains this very module's folder");
	});
});

test("glitchRoot is stable across a cache reset", () => {
	withEnv(null, () => {
		resetRootCache();
		const first = glitchRoot();
		resetRootCache();
		assert.equal(glitchRoot(), first, "same answer when nothing changed");
	});
});

test("glitchPath anchors under the root and normalizes like join()", () => {
	const { base, root } = makeRoot("anchor");
	try {
		withEnv(root, () => {
			// Plain segments land under the root.
			assert.equal(glitchPath("data", "config"), join(root, "data", "config"));
			assert.equal(glitchPath("user"), join(root, "user"));

			// KNOWN LIMITATION, asserted rather than hidden: glitchPath is a thin
			// join(), so a caller that passes ".." escapes the root. node:path
			// normalizes the traversal away. Callers inside Glitch must not pass
			// ".."; if that ever changes, add a containment guard here rather than
			// trusting every call site.
			assert.equal(glitchPath("..", "..", "outside"), join(root, "..", "..", "outside"));
			assert.ok(!glitchPath("..", "..", "outside").startsWith(root), "documented escape, not a safety guarantee");
			assert.ok(base.length > 0);
		});
	} finally {
		rmSync(base, { recursive: true, force: true });
	}
});