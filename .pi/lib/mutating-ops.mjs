/**
 * mutating-ops.mjs — strict dispatch-gate classifier for tool + bash calls.
 *
 * WHY THIS MODULE EXISTS: routing.ts's old dispatch-first gate had two holes:
 *   1. It only fired on edit/write of files with code extensions AND on the
 *      small set of destructive verbs in DESTRUCTIVE_BASH_COMMANDS. That left
 *      read-only-named tools (read/grep/glob/ls — fine) but also every OTHER
 *      mutating surface ungated: write to non-code files, patch / multi_edit /
 *      apply_patch / notebook_edit, browser_page clicks/typing, mv, sed -i,
 *      mkdir, touch, chmod, output redirection (echo hi > f), piping through
 *      tee, and shell-script interpreters like `node script.mjs` /
 *      `python x.py` / `npm test`. The primary could do all of that itself.
 *   2. The 120s window opened by one dispatch let the primary edit freely for
 *      two minutes afterwards. Plenty of time to silently make a dozen
 *      unrelated changes without dispatching again.
 *
 * The fix:
 *   - isMutatingToolCall classifies EVERY mutating tool by name, with a
 *     per-op override for browser_page (some ops are reads).
 *   - isMutatingBashCommand fails closed: only commands provably composed of
 *     read-only segments AND free of mutation markers can return false.
 *   - explainMutatingCall gives a short, human-readable classification reason
 *     for the dispatch-first block message (kept under 120 chars).
 *
 * Dependency-free on purpose: the extension imports it, `node --test`
 * imports it (.pi/lib/mutating-ops.test.mjs). Same pattern as plan-paths.mjs
 * and dispatch-plan.mjs.
 */

/** Tool names whose calls always mutate state. */
export const MUTATING_TOOL_NAMES = new Set([
	"edit",
	"write",
	"patch",
	"multi_edit",
	"apply_patch",
	"notebook_edit",
]);

/** Tool names whose calls never mutate state (default policy). browser_page is
 *  listed here for membership testing but isMutatingToolCall overrides it
 *  per-op because some ops (click / type / eval / goto) do mutate. Dispatch
 *  tools (task / delegate_task / subagent_spawn) are listed here too — they
 *  spawn sub-agents, they don't directly mutate the user's filesystem. */
export const READ_ONLY_TOOL_NAMES = new Set([
	"read",
	"grep",
	"glob",
	"ls",
	"find",
	"todo_list",
	"plan_update",
	"claim_files",
	"conversation_read",
	"present_files",
	"schedule_task",
	"schedule_list",
	"schedule_cancel",
	"recall",
	"verify_claim",
	"skill",
	"eval",
	"lsp",
	"desktop_screenshot",
	"ask_user_question",
	"compact_context",
	"browser_page",
	"task",
	"delegate_task",
	"subagent_spawn",
]);

/** Bash command prefixes (lower-cased, trimmed, startsWith-matched) that
 *  are provably read-only. A command whose first segment starts with one of
 *  these AND whose full string contains no MUTATION_MARKERS substring is
 *  judged read-only — every other command fails closed as mutating. */
export const READ_ONLY_BASH_COMMANDS = new Set([
	"git status",
	"git diff",
	"git log",
	"git show",
	"git branch",
	"git remote",
	"git config",
	"git rev-parse",
	"git ls-files",
	"git blame",
	"git grep",
	"ls",
	"dir",
	"cat",
	"type",
	"head",
	"tail",
	"grep",
	"rg",
	"find",
	"echo",
	"pwd",
	"whoami",
	"date",
	"time",
	"wc",
	"stat",
	"which",
	"sort",
	"uniq",
	"diff",
	"basename",
	"dirname",
	"realpath",
	"sed",
	"node --version",
	"node -v",
	"node --test",
]);

/** Plain substring markers: if any appears anywhere in the raw command, the
 *  command is treated as mutating regardless of the verb. This is the tripwire
 *  for redirection (`>` / `>>`), pipes to `tee`, in-place edits (`sed -i`),
 *  and the rest of the common shell mutation surface that doesn't survive
 *  startsWith matching. */
export const MUTATION_MARKERS = [
	">",
	">>",
	"|",
	"tee",
	"sed -i",
	"mv",
	"cp",
	"mkdir",
	"touch",
	"chmod",
	"install",
	"xcopy",
	"robocopy",
	"del",
	"rm",
	"ln",
	"dd",
	"truncate",
];

/** Per-op override for browser_page: pages / read / wait / scroll / shot are
 *  reads; click / type / eval / goto mutate the loaded page. Used by
 *  isMutatingToolCall when the tool name is browser_page. */
export const BROWSER_MUTATING_OPS = new Set(["click", "type", "eval", "goto"]);

/** Strip a balanced pair of surrounding quotes (single, double, backtick)
 *  off a token if both ends match. Otherwise return the token unchanged. */
function stripQuotes(s) {
	if (typeof s !== "string" || s.length < 2) return s;
	const first = s.charAt(0);
	const last = s.charAt(s.length - 1);
	if ((first === '"' && last === '"') ||
		(first === "'" && last === "'") ||
		(first === "`" && last === "`")) {
		return s.slice(1, -1);
	}
	return s;
}

/** Last path component, accepting both / and \ separators. */
function basename(s) {
	const i = Math.max(s.lastIndexOf("/"), s.lastIndexOf("\\"));
	return i >= 0 ? s.slice(i + 1) : s;
}

const STRIP_EXTS = /\.(exe|com|bat|cmd|ps1|sh)$/i;

/**
 * Reduce one shell segment to its executable name, handling:
 *   - surrounding quotes
 *   - a trailing .exe/.bat/.cmd/.ps1/.sh extension
 *   - Windows forms: `cmd /c VERB`, `cmd /k VERB` → the VERB is the real exe
 *   - leading VAR=value assignment prefixes (stripped by the caller before
 *     tokenization — see isMutatingBashCommand below)
 */
function segmentCommandName(seg) {
	const tokens = seg.split(/\s+/).filter((t) => t.length > 0);
	if (tokens.length === 0) return "";
	let name0 = stripQuotes(tokens[0]).replace(STRIP_EXTS, "").toLowerCase();
	let cmdName = basename(name0);
	if ((cmdName === "cmd" || cmdName === "cmd.exe") && tokens.length >= 3) {
		const flag = tokens[1].toLowerCase();
		if (flag === "/c" || flag === "/k") {
			cmdName = basename(
				stripQuotes(tokens[2]).replace(STRIP_EXTS, "").toLowerCase(),
			);
		}
	}
	return cmdName;
}

/** Strip a leading `VAR=value cmd ...` assignment prefix and return the rest.
 *  Multiple assignments may chain: `FOO=1 BAR=2 cmd`. The trimmed command
 *  always re-trims; an all-assignments line returns "". */
function stripAssignmentPrefix(command) {
	const re = /^\s*(?:[A-Za-z_][A-Za-z0-9_]*=[^\s]*\s+)+/;
	const m = command.match(re);
	if (!m) return command.trim();
	return command.slice(m[0].length).trim();
}

/** True iff the segment, after normalization, startsWith-matches some entry
 *  in READ_ONLY_BASH_COMMANDS. Returns false on empty segments so an empty
 *  `&&` or `||` chain slot fails closed. Windows `cmd /c VERB` / `cmd /k VERB`
 *  wrappers are NEVER classified read-only here, because cmd.exe can be told
 *  anything — there's no static proof the inner verb is benign. */

function isCmdWrapper(seg) {
	const tokens = seg.trim().split(/\s+/).filter((t) => t.length > 0);
	if (tokens.length < 3) return false;
	const name = stripQuotes(tokens[0]).replace(STRIP_EXTS, "").toLowerCase();
	const base = basename(name);
	const flag = tokens[1].toLowerCase();
	return (base === "cmd" || base === "cmd.exe") && (flag === "/c" || flag === "/k");
}

function segmentIsReadOnly(seg) {
	const trimmed = seg.trim();
	if (!trimmed) return false;
	if (isCmdWrapper(trimmed)) {
		// Unwrap `cmd /c VERB ...` to the inner verb and re-judge that.
		const tokens = trimmed.split(/\s+/).filter((t) => t.length > 0);
		const rest = tokens.slice(2).join(" ");
		return segmentIsReadOnly(rest);
	}
	const lower = trimmed.toLowerCase();
	for (const allowed of READ_ONLY_BASH_COMMANDS) {
		if (lower.startsWith(allowed)) return true;
	}
	return false;
}

/**
 * Classify a tool call. Returns true when the call can change state, false
 * when it cannot. Fails closed on unknown tool names — a new tool the
 * classifier doesn't recognize is treated as mutating until it's been audited
 * and explicitly added to one of the sets.
 *
 * Per-op override: browser_page is read-only by default (its name is in
 * READ_ONLY_TOOL_NAMES) but click / type / eval / goto are judged mutating.
 *
 * @param {string} toolName
 * @param {unknown} input — the tool's input object; only browser_page reads it
 * @returns {boolean}
 */
export function isMutatingToolCall(toolName, input) {
	if (MUTATING_TOOL_NAMES.has(toolName)) return true;
	if (toolName === "browser_page") {
		const op = input && typeof input === "object" ? input.op : undefined;
		if (typeof op === "string" && BROWSER_MUTATING_OPS.has(op)) return true;
		return false;
	}
	if (READ_ONLY_TOOL_NAMES.has(toolName)) return false;
	// Unknown tool — fail closed.
	return true;
}

/**
 * Classify a shell command. Returns false ONLY when the command is provably
 * read-only. Returns true in every other case (fail closed).
 *
 * Provably read-only requires ALL of:
 *     (a) every segment, split on `&&`, `||`, `;`, `|`, newline, is non-empty
 *         AND its normalized first token startsWith-matches an entry in
 *         READ_ONLY_BASH_COMMANDS. Windows `cmd /c` / `cmd /k` forms unwrap
 *         to the real verb.
 *     (b) the raw command contains NO MUTATION_MARKERS substring (catches
 *         output redirection, `tee`, `sed -i`, etc.)
 *     (c) any leading `VAR=value` assignment prefix is acceptable and still
 *         read-only.
 *
 * @param {string} command
 * @returns {boolean}
 */
export function isMutatingBashCommand(command) {
	if (typeof command !== "string" || !command.trim()) return true;

	// (b) raw-string mutation tripwire — runs first because it's cheap and
	// catches `ls | tee f.txt`, `echo hi > f.txt`, `sed -i s/a/b/ f`, etc.
	for (const marker of MUTATION_MARKERS) {
		if (command.includes(marker)) return true;
	}

	// (c) strip a leading VAR=value prefix from the WHOLE command before
	// segmenting. Assignments aren't a shell separator, so splitting on `;`
	// afterwards is still safe.
	const withoutAssign = stripAssignmentPrefix(command);
	if (!withoutAssign) return true;

	// (a) every segment must be provably read-only.
	const segments = withoutAssign.split(/&&|\|\||;|\||\n/);
	for (const seg of segments) {
		if (!segmentIsReadOnly(seg)) return true;
	}
	return false;
}

/**
 * Short human-readable classification reason, kept under 120 characters, for
 * the dispatch-first block message. The exact tool/command/binding context
 * belongs in the caller — this only states WHY the call was judged mutating.
 *
 * @param {string} toolName
 * @param {unknown} input
 * @returns {string}
 */
export function explainMutatingCall(toolName, input) {
	if (toolName === "browser_page") {
		const op = input && typeof input === "object" ? input.op : undefined;
		if (typeof op === "string" && BROWSER_MUTATING_OPS.has(op)) {
			return `browser_page op "${op}" changes page state.`;
		}
		return `browser_page op "${String(op)}" is read-only.`;
	}
	if (MUTATING_TOOL_NAMES.has(toolName)) {
		return `tool "${toolName}" writes or rewrites files.`;
	}
	if (READ_ONLY_TOOL_NAMES.has(toolName)) {
		return `tool "${toolName}" is read-only.`;
	}
	// bash / powershell / unknown — the caller passes the command separately;
	// we just say it's been classified as mutating (failing closed).
	return `tool "${toolName}" has no read-only policy — failing closed as mutating.`;
}