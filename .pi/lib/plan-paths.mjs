/**
 * plan-paths.mjs — session-scoped plan ownership rules for the plan-first gate.
 *
 * WHY THIS MODULE EXISTS: data/plans/current-plan.md used to be ONE shared file for
 * every concurrent session. Session B "overwriting any previous plan" destroyed
 * session A's live plan; whichever session finished first archived whatever was in
 * the shared file, mid-build for the others; and the gate's mtime check could be
 * satisfied by another session's unrelated plan. Incident: user/current-session.md
 * line "data/plans/current-plan.md vanished mid-build".
 *
 * The rules now:
 *   1. Each session owns exactly one plan file:
 *        data/plans/sessions/<sessionID>/current-plan.md
 *     The write tool auto-creates the session directory. sessionID comes from the
 *     Pi extension session_start ctx (same extraction routing.ts already does).
 *   2. A path under data/plans is OWNED if it lives in this session's directory,
 *     SHARED if it lives under data/plans/archive (finished plans land there), and
 *     FOREIGN otherwise — including the legacy shared file data/plans/current-plan.md,
 *     which no session may write or move anymore.
 *   3. Reads of any plan path stay allowed. Mutations (write/edit/rename/move/delete)
 *     must target OWNED or SHARED paths only; mutating a FOREIGN plan path is the
 *     cross-session hazard this module exists to stop.
 *
 * Dependency-free on purpose: the extension imports it, `node --test` imports it
 * (.pi/lib/plan-paths.test.mjs), same pattern as dispatch-plan.mjs.
 */

/** Directory under data/plans that holds one subdirectory per live session. */
export const PLAN_SESSIONS_DIR = "sessions";

/** The single plan file name inside a session directory. */
export const PLAN_FILE_NAME = "current-plan.md";

/** The pre-session-scoped path. Kept for messages; never writable again. */
export const LEGACY_PLAN_PATH = "data/plans/current-plan.md";

/** The shared archive directory every finished plan moves into. */
export const PLAN_ARCHIVE_DIR = "data/plans/archive";

/**
 * Normalize any OS path form (forward/back slashes, absolute or repo-relative) to
 * plain forward slashes. No lowercasing: paths are case-preserving on Windows and
 * the owner check is exact-match anyway.
 */
export function normalizePath(p) {
	return String(p ?? "").replace(/\\/g, "/");
}

/** True when a path points anywhere under data/plans (case-insensitive match). */
export function isPlanPath(p) {
	const n = normalizePath(p);
	// `data/plans` must appear as its own segment: preceded by start-of-string,
	// a slash, or shell separation (space/quote/equals — so `mv data/plans/...`
	// and `--path=data/plans` match), and followed by a slash or end — so
	// `data/plans-backup` does NOT match.
	return /(^|[\/\s"'`=])data\/plans(\/|$)/i.test(n);
}

/**
 * The plan file path (repo-relative, forward slashes) owned by a session.
 * sessionId "default" is the routing.ts fallback when the id is not known yet.
 */
export function sessionPlanPath(sessionId) {
	const sid = String(sessionId || "default").replace(/[^a-zA-Z0-9._-]/g, "-");
	return `data/plans/${PLAN_SESSIONS_DIR}/${sid}/${PLAN_FILE_NAME}`;
}

/**
 * Reduce any absolute or prefixed path to the `data/plans/...` part, so ownership
 * is judged on the same repo-relative form regardless of where it sits on disk.
 * Case-insensitive because Windows paths are; takes the LAST occurrence so a repo
 * path like `E:/Glitch AI/glitch-pi/data/plans/...` trims correctly.
 */
export function stripToPlansRoot(p) {
	const n = normalizePath(p);
	const idx = n.toLowerCase().lastIndexOf("data/plans");
	if (idx === -1) return n;
	return n.slice(idx);
}

/**
 * Classify one plan path from the point of view of `sessionId`.
 *
 * @returns {"owned"|"shared"|"foreign"} — owned: this session's own file/dir;
 * shared: data/plans/archive (any session may write a NEW archive file, moving
 * one there is the designed archive flow); foreign: anything else under
 * data/plans, including the legacy shared file and other sessions' dirs.
 */
export function classifyPlanPath(p, sessionId) {
	const n = stripToPlansRoot(p);
	const mine = sessionPlanPath(sessionId);
	const myDir = mine.slice(0, mine.lastIndexOf("/"));
	if (n === mine || n.startsWith(myDir + "/")) return "owned";
	// data/plans/archive or data/plans/archive/... (and nothing longer after).
	const archiveRe = new RegExp(`(^|/)${PLAN_ARCHIVE_DIR}(/|$)`, "i");
	if (archiveRe.test(n)) return "shared";
	return "foreign";
}

/**
 * Extract every plan-ish path token mentioned in a shell command. Handles both
 * slash styles, quoted segments, and absolute paths with a drive letter or a
 * repo-root prefix. Deliberately greedy on the path body so "mv a b" yields both
 * refs, then classifyPlanPath decides ownership per ref.
 */
export function extractPlanRefs(command) {
	const text = normalizePath(command);
	// Lazy prefix so the match starts as late as possible: shell args are
	// space-separated, so a slash immediately before `data/plans` only occurs
	// inside a real path (quotes and newlines stop the prefix, spaces inside a
	// path like "E:/Glitch AI/..." are allowed).
	const re = /(?:(?:[\w@.]:)?[^\r\n"'`]*?[\/\\])?data\/plans(?:\/[\w.-]+)*/gi;
	const out = [];
	for (const m of text.matchAll(re)) out.push(m[0]);
	return out;
}

/** Shell verbs (git-bash + powershell) that mutate files. Reads are unaffected. */
const MUTATION_VERB_RE =
	/\b(mv|move|ren|rename|rm|del|erase|rmdir|rd|deltree|cp|copy|copy-item|move-item|remove-item|rename-item|tee|shred|truncate)\b/i;

/**
 * Remove heredoc BODIES only (they are data, never commands). Quoted strings are
 * deliberately KEPT: a verb inside quotes is still a verb when the quotes are a
 * wrapper argument (`bash -c "mv a b"`). Stripping quotes here would blind the
 * ownership gate — a false negative is worse than the false positive this
 * replaced.
 */
export function stripHeredocs(command) {
	let s = String(command ?? "");
	s = s.replace(/<<-?\s*(['"]?)([A-Za-z_][A-Za-z0-9_]*)\1([\s\S]*?)^\s*\2\s*$/gm, " ");
	return s;
}

/** git subcommands that provably cannot modify FILE CONTENTS in the working
 *  tree, so their free-text arguments (commit messages, refs) are not scanned
 *  for mutation verbs. Deliberately SHORT: anything not listed is treated as
 *  potentially writing, because a false negative in an ownership gate is worse
 *  than a false positive. Notably ABSENT, all of which CAN change or delete
 *  working-tree files: checkout, restore, clean, reset, switch, stash, worktree,
 *  submodule, pull, merge, rebase, cherry-pick, revert, am, apply, rm, mv,
 *  sparse-checkout. A curated "cannot write" list rots silently; an allowlist
 *  fails loud. */
const GIT_READONLY = new Set(["status","diff","log","show","add","fetch","push","branch","tag","rev-parse","ls-files","ls-remote","blame","grep","config","remote","describe","shortlog","reflog","cat-file","hash-object","check-ignore","symbolic-ref","rev-list","whatchanged","notes","archive","verify-commit","verify-tag","name-rev","count-objects","commit","merge-base","show-ref","for-each-ref","diff-tree","diff-files"]);

/** Shell verbs that take free-text arguments and never mutate files. */
const TEXT_ONLY_VERBS = new Set(["echo","printf","write-host","write-output","write-warning","write-error","write-verbose","console.log","console.error","console.warn","console.info","console.debug"]);

/** First bare command token of a segment, lowercased, path and .exe stripped. */
function segmentVerb(seg) {
	const s = String(seg).replace(/^\s*(?:[A-Za-z_][A-Za-z0-9_]*=[^\s]*\s+)+/, "");
	const tok = (s.trim().split(/\s+/)[0] || "");
	return tok.replace(/^.*[\\/]/, "").replace(/\.exe$/i, "").toLowerCase();
}

/** Second token of a segment (the git subcommand), lowercased. */
function segmentSubVerb(seg) {
	const s = String(seg).replace(/^\s*(?:[A-Za-z_][A-Za-z0-9_]*=[^\s]*\s+)+/, "");
	const toks = s.trim().split(/\s+/);
	return (toks[1] || "").replace(/^.*[\\/]/, "").replace(/\.exe$/i, "").toLowerCase();
}

/** True when the command both mutates and touches plan paths.
 *  Path test: RAW command. Verb test: heredoc bodies stripped, quotes kept, and
 *  segments whose verb provably cannot write a file (git commit/log/...,
 *  echo) are exempt so a plan path mentioned in a commit message is not a
 *  mutation. */
export function hasPlanMutation(command) {
	const raw = String(command ?? "");
	if (!isPlanPath(raw)) return false;
	const stripped = stripHeredocs(raw);
	const segments = stripped.split(/&&|\|\||;|\||\r?\n/).map((s) => s.trim()).filter(Boolean);
	if (segments.length === 0) return MUTATION_VERB_RE.test(stripped);
	for (const seg of segments) {
		const verb = segmentVerb(seg);
		if (TEXT_ONLY_VERBS.has(verb)) continue;
		if (verb === "git") {
			// Fail closed: only a PROVEN read-only subcommand is skipped.
			if (GIT_READONLY.has(segmentSubVerb(seg))) continue;
			return true;
		}
		if (MUTATION_VERB_RE.test(seg)) return true;
	}
	return false;
}

/**
 * Ownership verdict for a mutating command from the point of view of sessionId.
 *
 * @returns {{
 *   allowed: boolean,
 *   reason: string,        // human-readable, shown in the block reason
 *   offending: string[],   // the foreign plan paths the command touches
 * }}
 * Reads are never judged here (caller only asks when hasPlanMutation is true).
 * The legacy shared file counts as foreign: sessions may read it (migration
 * reference) but never write/move/delete it.
 */
export function classifyPlanCommand(command, sessionId) {
	const refs = extractPlanRefs(command);
	// Report offenders in canonical data/plans/... form: block reasons read
	// cleaner and match what the classification actually judged.
	const offending = refs
		.map(stripToPlansRoot)
		.filter((r) => classifyPlanPath(r, sessionId) === "foreign");
	if (offending.length === 0) {
		return { allowed: true, reason: "", offending: [] };
	}
	const isLegacy = offending.every((r) => r.toLowerCase() === LEGACY_PLAN_PATH);
	const reason = isLegacy
		? `data/plans/current-plan.md is the LEGACY shared plan file. Your session-scoped plan is ${sessionPlanPath(
				sessionId,
			)} — write it there and archive it to ${PLAN_ARCHIVE_DIR}/ yourself when done. Never move or delete the legacy file.`
		: `Those plan files belong to another session (or the shared file), not this one. Your session-scoped plan is ${sessionPlanPath(
				sessionId,
			)}. Only mutate your own plan file (${sessionPlanPath(sessionId)}) and the shared archive (${PLAN_ARCHIVE_DIR}/).`;
	return { allowed: false, reason, offending };
}
