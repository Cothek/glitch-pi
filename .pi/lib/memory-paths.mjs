/**
 * memory-paths.mjs — session-scoped scratchpad paths + clobber-guarded merge.
 *
 * WHY THIS MODULE EXISTS: user/current-session.md used to be ONE shared live
 * scratchpad for every concurrent session (inverted from the plan-file problem
 * fixed by plan-paths.mjs: there, one shared PLAN got session dirs; here, one
 * shared SCRATCHPAD gets them). Every session appended during work (R2), the
 * compaction diary rewrote the heartbeat unconditionally, and the mechanical
 * trimmer rewrote the whole file — no lock, no ownership, no mtime guard
 * (plan 01a0e0c4: out-of-order timestamps, duplicate blocks, interleaved
 * recaps, and a 2026-10-06 close mixed into a September file).
 *
 * The rules now (mirrors the plan-file fix that already worked):
 *   1. Each session owns exactly one scratchpad:
 *        user/sessions/<sessionID>/current-session.md
 *     Live sessions append THERE during work. The file carries its own
 *     "## Last Memory Update" heartbeat as line 1.
 *   2. The shared file user/current-session.md is written by exactly TWO
 *     guarded paths: the compaction merge below (compaction-diary.ts calls
 *     mergeSessionIntoShared) and the trimmer (scripts/run-compaction.mjs,
 *     mtime re-check before its write). Agents never append to it directly
 *     anymore; AGENTS.md keeps importing it so every session still sees the
 *     merged recent-context view.
 *   3. Merge is idempotent via an in-file marker line: only session content
 *     AFTER the last `<!-- merged:... -->` marker is appended, so a second
 *     compaction in the same session cannot duplicate the same block.
 *   4. The merge is clobber-guarded: stat before read, re-stat before write;
 *     a changed mtime triggers ONE fresh-read retry, a second change aborts
 *     with reason "clobbered" (the shared file is left untouched — losing a
 *     merge is recoverable at the next compaction; losing a rival write is
 *     not).
 *
 * Dependency policy: node:fs/node:path only. The extension imports it
 * (TS → local .mjs, same pattern as routing.ts → plan-paths.mjs), and
 * memory-paths.test.mjs runs under node --test against temp dirs.
 */
import { promises as fs } from "node:fs";
import { join } from "node:path";

/** Repo-relative dir holding one scratchpad subdir per live session. */
export const MEMORY_SESSIONS_DIR = "user/sessions";

/** The one scratchpad file name inside a session directory. */
export const SCRATCHPAD_FILE_NAME = "current-session.md";

/** The shared merged view every session still imports via AGENTS.md. */
export const SHARED_SCRATCHPAD_REL = "user/current-session.md";

/** Where stale (>7d) session scratchpad dirs get moved by the trimmer. */
export const SESSION_ARCHIVE_DIR = "user/sessions/archive";

/** A session scratchpad dir with no write for 7 days is stale. */
export const STALE_SESSION_DIR_MS = 7 * 24 * 60 * 60 * 1000;

/** The heartbeat heading every scratchpad carries as its first line. */
const HEARTBEAT_RE = /^## Last Memory Update: [^\r\n]*$/m;
export const HEARTBEAT_LINE_PREFIX = "## Last Memory Update: ";
const MERGED_MARKER_RE = /^<!-- merged:[^\r\n]* -->$/m;

/** Same sanitization as plan-paths.mjs sessionPlanPath. */
export function sanitizeSessionId(sessionId) {
	return String(sessionId || "default").replace(/[^a-zA-Z0-9._-]/g, "-");
}

/** Absolute session scratchpad path under a user dir. */
export function sessionScratchpadPath(userDir, sessionId) {
	return join(userDir, "sessions", sanitizeSessionId(sessionId), SCRATCHPAD_FILE_NAME);
}

/** Skeleton for a fresh session scratchpad. */
export function scratchpadSkeleton(sessionId, isoNow) {
	return (
		[
			`# Session ${sanitizeSessionId(sessionId)} — working memory (scratchpad)`,
			``,
			`${HEARTBEAT_LINE_PREFIX}${isoNow}`,
			``,
		].join("\n") + "\n"
	);
}

/**
 * Replace (or prepend) the heartbeat line in scratchpad content.
 * Prepends BEFORE any frontmatter would corrupt it, so only prepend when the
 * content has no `---` frontmatter at the top; otherwise insert after it.
 */
export function updateScratchpadHeartbeat(content, isoNow) {
	const line = `${HEARTBEAT_LINE_PREFIX}${isoNow}`;
	if (HEARTBEAT_RE.test(content)) {
		return content.replace(HEARTBEAT_RE, line);
	}
	if (/^---\s*$/m.test(content.split("\n")[0] ?? "")) {
		const end = content.indexOf("\n---");
		if (end >= 0) {
			const after = end + 4; // past the closing fence
			return content.slice(0, after) + `\n${line}\n` + content.slice(after);
		}
	}
	return `${line}\n\n${content}`;
}

/** Keep only the FIRST heartbeat line; drop later duplicates (historical churn). */
export function dedupeLastMemoryUpdate(content) {
	const lines = content.split("\n");
	const seen = Object.create(null);
	const out = [];
	for (const l of lines) {
		if (HEARTBEAT_RE.test(l)) {
			if (seen.first) continue;
			seen.first = true;
		}
		out.push(l);
	}
	// Any line matching the heartbeat pattern with list prefixes ("- Last Memory
	// Update: ..." in old merged bodies) stays — only true headings dedupe.
	return out.join("\n");
}

/** Session content after the last merge marker (or the whole body if none). */
export function contentSinceLastMerge(sessionContent) {
	const marker = "<!-- merged:";
	let idx = -1;
	let searchFrom = 0;
	// Find the LAST marker line's end.
	for (;;) {
		const at = sessionContent.indexOf(marker, searchFrom);
		if (at === -1) break;
		const lineEnd = sessionContent.indexOf("\n", at);
		idx = lineEnd === -1 ? sessionContent.length : lineEnd + 1;
		searchFrom = idx;
	}
	if (idx === -1) return sessionContent;
	return sessionContent.slice(idx);
}

/** Read helper returning { content, mtimeMs } or null when absent. */
async function statRead(file) {
	try {
		const [st, content] = await Promise.all([fs.stat(file), fs.readFile(file, "utf8")]);
		return { content, mtimeMs: st.mtimeMs };
	} catch (e) {
		if (e && e.code === "ENOENT") return null;
		throw e;
	}
}

async function atomicWrite(file, content) {
	const tmp = file + ".merge-tmp";
	await fs.writeFile(tmp, content, "utf8");
	await fs.rename(tmp, file);
}

/**
 * Ensure the session scratchpad exists (skeleton if missing) and return its
 * current content with a refreshed heartbeat line.
 */
export async function ensureSessionScratchpad({ userDir, sessionId, isoNow }) {
	const file = sessionScratchpadPath(userDir, sessionId);
	let content = (await statRead(file))?.content ?? null;
	if (content === null) {
		await fs.mkdir(join(file, ".."), { recursive: true });
		content = scratchpadSkeleton(sessionId, isoNow);
	}
	content = updateScratchpadHeartbeat(content, isoNow);
	await atomicWrite(file, content);
	return { path: file, content };
}

/**
 * Merge the session scratchpad's un-merged content into the shared file.
 * Clobber-guarded + idempotent (see module header). Never throws for the
 * common race — returns { merged:false, reason } instead.
 *
 * hooks.beforeWrite(ctx) may be supplied by tests to simulate a rival write
 * landing between this function's read and its write.
 */
export async function mergeSessionIntoShared({ userDir, sessionId, isoNow, hooks }) {
	const sessionFile = sessionScratchpadPath(userDir, sessionId);
	const sharedFile = join(userDir, "current-session.md");
	const sessionRead = await statRead(sessionFile);
	if (!sessionRead) return { merged: false, reason: "no-session-scratchpad" };

	const newBlock = contentSinceLastMerge(sessionRead.content).replace(HEARTBEAT_RE, "").trim();
	if (!newBlock) return { merged: false, reason: "nothing-new" };

	for (let attempt = 1; attempt <= 2; attempt++) {
		const sharedRead = (await statRead(sharedFile)) ?? {
			content: `${HEARTBEAT_LINE_PREFIX}${isoNow}\n\n`,
			mtimeMs: -1,
		};
		const base = dedupeLastMemoryUpdate(sharedRead.content);
		const heartbeat = updateScratchpadHeartbeat(base, isoNow);
		const merged = `${heartbeat.replace(/\n+$/, "")}\n\n${newBlock.replace(/\n+$/, "")}\n`;

		if (hooks && typeof hooks.beforeWrite === "function") {
			await hooks.beforeWrite({ attempt, sharedFile });
		}
		// Clobber detection is CONTENT-based, not mtime-based: same-content
		// rewrites (benign) must not abort, and on Windows a rewrite can land in
		// the same mtime tick anyway. Only a genuinely different shared file
		// counts as a rival write.
		const recheck = await statRead(sharedFile);
		if (recheck && recheck.content !== sharedRead.content) {
			continue; // rival write landed mid-merge — retry once with fresh read
		}
		await atomicWrite(sharedFile, merged);
		// Stamp the session file so this block is never re-merged.
		const stamped =
			sessionRead.content.replace(/\n+$/, "") + `\n<!-- merged:${isoNow} -->\n`;
		await atomicWrite(sessionFile, stamped);
		return { merged: true, sharedPath: sharedFile };
	}
	return { merged: false, reason: "clobbered" };
}

/** True when a session scratchpad dir is stale (no write within 7 days). */
export function isStaleSessionDir(mtimeMs, now = Date.now()) {
	return now - mtimeMs > STALE_SESSION_DIR_MS;
}

/**
 * Move session scratchpad dirs with no recent write into user/sessions/archive.
 * Returns the moved dir names. The archive dir itself is never a candidate.
 */
export async function archiveStaleSessionDirs(userDir, now = Date.now()) {
	const sessionsDir = join(userDir, "sessions");
	const archiveDir = join(sessionsDir, "archive");
	let entries;
	try {
		entries = await fs.readdir(sessionsDir, { withFileTypes: true });
	} catch (e) {
		if (e && e.code === "ENOENT") return [];
		throw e;
	}
	const moved = [];
	for (const ent of entries) {
		if (!ent.isDirectory()) continue;
		if (ent.name === "archive") continue;
		const dir = join(sessionsDir, ent.name);
		try {
			// Dir mtime only moves on entry create/rename — appends to the
			// scratchpad never touch it. The scratchpad FILE mtime is the real
			// activity signal; take the max of both.
			const stDir = await fs.stat(dir);
			let mtimeMs = stDir.mtimeMs;
			try {
				const stFile = await fs.stat(join(dir, SCRATCHPAD_FILE_NAME));
				mtimeMs = Math.max(mtimeMs, stFile.mtimeMs);
			} catch {
				/* no scratchpad inside — dir mtime alone decides */
			}
			if (!isStaleSessionDir(mtimeMs, now)) continue;
			await fs.mkdir(archiveDir, { recursive: true });
			let dest = join(archiveDir, ent.name);
			try {
				await fs.rename(dir, dest);
			} catch {
				dest = join(archiveDir, `${ent.name}-${new Date(now).toISOString().slice(0, 10)}`);
				await fs.rename(dir, dest);
			}
			moved.push(ent.name);
		} catch {
			// one bad dir never blocks the rest
		}
	}
	return moved;
}
