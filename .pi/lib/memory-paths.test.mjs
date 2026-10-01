/**
 * memory-paths.test.mjs — node --test suite for session-scoped scratchpads.
 * Run: node --test .pi/lib/memory-paths.test.mjs
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
	sanitizeSessionId,
	sessionScratchpadPath,
	scratchpadSkeleton,
	updateScratchpadHeartbeat,
	dedupeLastMemoryUpdate,
	contentSinceLastMerge,
	ensureSessionScratchpad,
	mergeSessionIntoShared,
	isStaleSessionDir,
	archiveStaleSessionDirs,
	STALE_SESSION_DIR_MS,
} from "./memory-paths.mjs";

function freshUserDir() {
	return mkdtempSync(join(tmpdir(), "memory-paths-test-"));
}

const NOW = "2026-09-30T12:00:00Z";

test("sanitizeSessionId mirrors plan-paths rules", () => {
	assert.equal(sanitizeSessionId("01a0eb1b-c90e-7268-9966-fc16e8bd1239"), "01a0eb1b-c90e-7268-9966-fc16e8bd1239");
	assert.equal(sanitizeSessionId("bad/id with spaces"), "bad-id-with-spaces");
	assert.equal(sanitizeSessionId(undefined), "default");
});

test("scratchpad skeleton shape", () => {
	const s = scratchpadSkeleton("s1", NOW);
	assert.ok(s.startsWith("# Session s1 — working memory (scratchpad)"));
	assert.ok(s.includes(`## Last Memory Update: ${NOW}`));
});

test("updateScratchpadHeartbeat: replaces in place, prepends when missing", () => {
	const replaced = updateScratchpadHeartbeat(`## Last Memory Update: 2020-01-01T00:00:00Z\n\nbody`, NOW);
	assert.ok(replaced.startsWith(`## Last Memory Update: ${NOW}`));
	assert.ok(replaced.includes("body"));

	const prepended = updateScratchpadHeartbeat("body line", NOW);
	assert.ok(prepended.startsWith(`## Last Memory Update: ${NOW}`));
	assert.ok(prepended.includes("body line"));

	// frontmatter stays first when prepending into a frontmattered file
	const fm = updateScratchpadHeartbeat("---\ntype: X\n---\nbody", NOW);
	assert.ok(fm.startsWith("---"));
	assert.ok(fm.includes(`## Last Memory Update: ${NOW}`));
	assert.ok(fm.includes("body"));
});

test("dedupeLastMemoryUpdate keeps only the first heartbeat heading", () => {
	const out = dedupeLastMemoryUpdate(
		`## Last Memory Update: A\n\nx\n\n## Last Memory Update: B\n\n- Last Memory Update: list-item stays\n`
	);
	assert.equal((out.match(/## Last Memory Update:/g) || []).length, 1);
	assert.ok(out.includes("A"));
	assert.ok(!out.includes("## Last Memory Update: B"));
	assert.ok(out.includes("- Last Memory Update: list-item stays"), "list items are not headings");
});

test("contentSinceLastMerge returns only content after the last marker", () => {
	const c = `old\n<!-- merged:2026-09-29T00:00:00Z -->\nmid\n<!-- merged:2026-09-30T00:00:00Z -->\nnew\n`;
	assert.equal(contentSinceLastMerge(c), "new\n");
	assert.equal(contentSinceLastMerge("no markers here"), "no markers here");
});

test("ensureSessionScratchpad creates then refreshes", async () => {
	const userDir = freshUserDir();
	const s1 = await ensureSessionScratchpad({ userDir, sessionId: "s1", isoNow: NOW });
	assert.ok(existsSync(s1.path));
	assert.ok(s1.content.includes(`## Last Memory Update: ${NOW}`));
	const later = "2026-09-30T13:00:00Z";
	const s2 = await ensureSessionScratchpad({ userDir, sessionId: "s1", isoNow: later });
	assert.equal((s2.content.match(/## Last Memory Update:/g) || []).length, 1);
	assert.ok(s2.content.includes(later));
});

test("merge: appends new block to shared, idempotent on second merge, only-new after append", async () => {
	const userDir = freshUserDir();
	const shared = join(userDir, "current-session.md");
	writeFileSync(shared, `## Last Memory Update: 2020-01-01T00:00:00Z\n\nshared base\n`, "utf8");

	const sess = sessionScratchpadPath(userDir, "s1");
	mkdirSync(join(sess, ".."), { recursive: true });
	writeFileSync(sess, `## Last Memory Update: 2020-01-01T00:00:00Z\n\nobservation one\n`, "utf8");

	const r1 = await mergeSessionIntoShared({ userDir, sessionId: "s1", isoNow: NOW });
	assert.ok(r1.merged, `first merge should succeed: ${JSON.stringify(r1)}`);
	const after1 = readFileSync(shared, "utf8");
	assert.ok(after1.includes("observation one"));
	assert.ok(after1.includes("shared base"));
	assert.equal((after1.match(/## Last Memory Update:/g) || []).length, 1, "heartbeat deduped");
	assert.ok(after1.startsWith(`## Last Memory Update: ${NOW}`));

	// second merge with nothing new → no-op
	const r2 = await mergeSessionIntoShared({ userDir, sessionId: "s1", isoNow: NOW });
	assert.equal(r2.reason, "nothing-new");

	// append more, merge again → only the new part lands
	const fh = await import("node:fs/promises");
	await fh.appendFile(sess, "observation two\n", "utf8");
	const r3 = await mergeSessionIntoShared({ userDir, sessionId: "s1", isoNow: NOW });
	assert.ok(r3.merged);
	const after3 = readFileSync(shared, "utf8");
	assert.ok(after3.includes("observation two"));
	assert.equal((after3.match(/observation one/g) || []).length, 1, "no duplicate of first block");
});

test("merge: rival write mid-merge → one retry succeeds", async () => {
	const userDir = freshUserDir();
	const shared = join(userDir, "current-session.md");
	writeFileSync(shared, `## Last Memory Update: 2020-01-01T00:00:00Z\n\nbase\n`, "utf8");
	const sess = sessionScratchpadPath(userDir, "s1");
	mkdirSync(join(sess, ".."), { recursive: true });
	writeFileSync(sess, `note A\n`, "utf8");

	const r = await mergeSessionIntoShared({
		userDir,
		sessionId: "s1",
		isoNow: NOW,
		hooks: {
			beforeWrite: async () => {
				// rival session appends between our read and write
				writeFileSync(shared, `## Last Memory Update: 2020-01-01T00:00:00Z\n\nbase\nrival line\n`, "utf8");
			},
		},
	});
	assert.ok(r.merged, "retry with fresh read should win");
	const out = readFileSync(shared, "utf8");
	assert.ok(out.includes("rival line"), "rival write must survive");
	assert.ok(out.includes("note A"));
});

test("merge: rival writes on BOTH attempts → aborts untouched", async () => {
	const userDir = freshUserDir();
	const shared = join(userDir, "current-session.md");
	writeFileSync(shared, `## Last Memory Update: 2020-01-01T00:00:00Z\n\nbase\n`, "utf8");
	const sess = sessionScratchpadPath(userDir, "s1");
	mkdirSync(join(sess, ".."), { recursive: true });
	writeFileSync(sess, `note A\n`, "utf8");

	let calls = 0;
	const r = await mergeSessionIntoShared({
		userDir,
		sessionId: "s1",
		isoNow: NOW,
		hooks: {
			beforeWrite: async () => {
				calls++;
				writeFileSync(shared, `## Last Memory Update: 2020-01-01T00:00:00Z\n\nbase attempt-${calls}\n`, "utf8");
			},
		},
	});
	assert.equal(r.merged, false);
	assert.equal(r.reason, "clobbered");
	assert.equal(calls, 2, "exactly one retry");
	const out = readFileSync(shared, "utf8");
	assert.ok(out.includes("attempt-2") && !out.includes("note A"), "shared file left to the rival, our merge dropped");
});

test("merge: missing session scratchpad → clean no-op", async () => {
	const userDir = freshUserDir();
	const r = await mergeSessionIntoShared({ userDir, sessionId: "ghost", isoNow: NOW });
	assert.equal(r.merged, false);
	assert.equal(r.reason, "no-session-scratchpad");
});

test("stale session dir detection + archive move", async () => {
	const userDir = freshUserDir();
	const oldDir = join(userDir, "sessions", "old-sess");
	mkdirSync(oldDir, { recursive: true });
	writeFileSync(join(oldDir, "current-session.md"), "old\n", "utf8");
	const freshDir = join(userDir, "sessions", "fresh-sess");
	mkdirSync(freshDir, { recursive: true });
	writeFileSync(join(freshDir, "current-session.md"), "new\n", "utf8");

	assert.ok(isStaleSessionDir(Date.now() - STALE_SESSION_DIR_MS - 1000));
	assert.ok(!isStaleSessionDir(Date.now()));

	const now = Date.now();
	const mtime = now - STALE_SESSION_DIR_MS - 60_000;
	const fh = await import("node:fs/promises");
	// Age BOTH the scratchpad file and the directory — a session dir with no
	// activity for 7+ days has both old (real flow: nothing writes either).
	await fh.utimes(join(oldDir, "current-session.md"), mtime / 1000, mtime / 1000);
	await fh.utimes(oldDir, mtime / 1000, mtime / 1000);

	const moved = await archiveStaleSessionDirs(userDir, now);
	assert.deepEqual(moved, ["old-sess"]);
	assert.ok(!existsSync(oldDir), "stale dir moved out");
	assert.ok(existsSync(join(userDir, "sessions", "archive", "old-sess", "current-session.md")));
	assert.ok(existsSync(freshDir), "fresh dir untouched");
});
