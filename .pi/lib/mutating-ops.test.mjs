/**
 * mutating-ops.test.mjs — node --test suite for the dispatch-gate classifier.
 * Run: node --test .pi/lib/mutating-ops.test.mjs
 */
import test from "node:test";
import assert from "node:assert/strict";

import {
	BROWSER_MUTATING_OPS,
	MUTATION_MARKERS,
	MUTATING_TOOL_NAMES,
	READ_ONLY_BASH_COMMANDS,
	READ_ONLY_TOOL_NAMES,
	explainMutatingCall,
	isMutatingBashCommand,
	isMutatingToolCall,
} from "./mutating-ops.mjs";

// --- Sets exist with the required names ---

test("MUTATING_TOOL_NAMES contains exactly the six mutating tool names", () => {
	assert.deepEqual([...MUTATING_TOOL_NAMES].sort(), [
		"apply_patch",
		"edit",
		"multi_edit",
		"notebook_edit",
		"patch",
		"write",
	]);
});

test("READ_ONLY_TOOL_NAMES contains the documented read-only tools", () => {
	for (const name of [
		"read", "grep", "glob", "ls", "find", "todo_list", "plan_update",
		"claim_files", "conversation_read", "present_files",
		"schedule_task", "schedule_list", "schedule_cancel",
		"recall", "verify_claim", "skill", "eval", "lsp",
		"desktop_screenshot", "ask_user_question", "compact_context", "browser_page",
	]) {
		assert.equal(READ_ONLY_TOOL_NAMES.has(name), true, `${name} should be read-only`);
	}
});

test("READ_ONLY_BASH_COMMANDS contains the documented read-only prefixes", () => {
	for (const c of [
		"git status", "git diff", "git log", "git show", "git branch",
		"git remote", "git config", "git rev-parse", "git ls-files",
		"git blame", "git grep",
		"ls", "dir", "cat", "type", "head", "tail", "grep", "rg", "find",
		"echo", "pwd", "whoami", "date", "time", "wc", "stat", "which",
		"sort", "uniq", "diff", "basename", "dirname", "realpath", "sed",
		"node --version", "node -v", "node --test",
	]) {
		assert.equal(READ_ONLY_BASH_COMMANDS.has(c), true, `${c} should be read-only`);
	}
});

test("MUTATION_MARKERS contains every documented tripwire substring", () => {
	for (const m of [
		">", ">>", "|", "tee", "sed -i", "mv", "cp", "mkdir", "touch",
		"chmod", "install", "xcopy", "robocopy", "del", "rm", "ln", "dd", "truncate",
	]) {
		assert.equal(MUTATION_MARKERS.includes(m), true, `${m} should be a mutation marker`);
	}
});

// --- isMutatingBashCommand: read-only cases → false ---

test("read-only: git status", () => {
	assert.equal(isMutatingBashCommand("git status"), false);
});

test("read-only: git diff --cached", () => {
	assert.equal(isMutatingBashCommand("git diff --cached"), false);
});

test("read-only: ls -la", () => {
	assert.equal(isMutatingBashCommand("ls -la"), false);
});

test("read-only: cat file", () => {
	assert.equal(isMutatingBashCommand("cat file"), false);
});

test("read-only: pwd", () => {
	assert.equal(isMutatingBashCommand("pwd"), false);
});

test("read-only: head -20 f", () => {
	assert.equal(isMutatingBashCommand("head -20 f"), false);
});

test("read-only: node --test .pi/lib/x.test.mjs", () => {
	assert.equal(isMutatingBashCommand("node --test .pi/lib/x.test.mjs"), false);
});

test("read-only: echo hi (bare)", () => {
	assert.equal(isMutatingBashCommand("echo hi"), false);
});

// --- isMutatingBashCommand: mutating cases → true ---

test("mutating: npm test", () => {
	assert.equal(isMutatingBashCommand("npm test"), true);
});

test("mutating: node script.mjs", () => {
	assert.equal(isMutatingBashCommand("node script.mjs"), true);
});

test("mutating: python x.py", () => {
	assert.equal(isMutatingBashCommand("python x.py"), true);
});

test("mutating: mkdir foo", () => {
	assert.equal(isMutatingBashCommand("mkdir foo"), true);
});

test("mutating: mv a b", () => {
	assert.equal(isMutatingBashCommand("mv a b"), true);
});

test("mutating: sed -i s/a/b/ f", () => {
	assert.equal(isMutatingBashCommand("sed -i s/a/b/ f"), true);
});

test("mutating: echo hi > f.txt (redirection)", () => {
	assert.equal(isMutatingBashCommand("echo hi > f.txt"), true);
});

test("mutating: rm -rf build", () => {
	assert.equal(isMutatingBashCommand("rm -rf build"), true);
});

test("read-only: cmd /c dir (Windows shell wrapper around a read-only verb)", () => {
	assert.equal(isMutatingBashCommand("cmd /c dir"), false);
});

test("mutating: cmd /c del file.txt (Windows shell wrapper on destructive verb)", () => {
	assert.equal(isMutatingBashCommand("cmd /c del file.txt"), true);
});

test("mutating: ls && rm -rf x (chain with one mutator)", () => {
	assert.equal(isMutatingBashCommand("ls && rm -rf x"), true);
});

test("mutating: echo hi | tee f.txt (pipe to tee)", () => {
	assert.equal(isMutatingBashCommand("echo hi | tee f.txt"), true);
});

test("mutating: VAR=value cmd ... assignment prefixes don't help when cmd mutates", () => {
	assert.equal(isMutatingBashCommand("FOO=1 BAR=2 rm -rf build"), true);
});

test("read-only: VAR=value cmd ... assignment prefixes are allowed for read-only cmd", () => {
	assert.equal(isMutatingBashCommand("FOO=1 BAR=2 ls -la"), false);
});

// --- isMutatingToolCall ---

test("tool: edit mutates", () => {
	assert.equal(isMutatingToolCall("edit", { path: "x.ts" }), true);
});

test("tool: write mutates", () => {
	assert.equal(isMutatingToolCall("write", { path: "x.ts" }), true);
});

test("tool: patch mutates", () => {
	assert.equal(isMutatingToolCall("patch", { path: "x.ts" }), true);
});

test("tool: multi_edit mutates", () => {
	assert.equal(isMutatingToolCall("multi_edit", {}), true);
});

test("tool: apply_patch mutates", () => {
	assert.equal(isMutatingToolCall("apply_patch", {}), true);
});

test("tool: notebook_edit mutates", () => {
	assert.equal(isMutatingToolCall("notebook_edit", {}), true);
});

test("tool: read is read-only", () => {
	assert.equal(isMutatingToolCall("read", { path: "x" }), false);
});

test("tool: grep is read-only", () => {
	assert.equal(isMutatingToolCall("grep", { pattern: "x" }), false);
});

test("tool: glob is read-only", () => {
	assert.equal(isMutatingToolCall("glob", { pattern: "x" }), false);
});

test("tool: ls is read-only", () => {
	assert.equal(isMutatingToolCall("ls", { path: "x" }), false);
});

test("tool: delegate_task is not in mutating sets", () => {
	assert.equal(isMutatingToolCall("delegate_task", { agent: "coder" }), false);
});

test("tool: task is not in mutating sets", () => {
	assert.equal(isMutatingToolCall("task", { subagent_type: "coder" }), false);
});

test("tool: subagent_spawn is not in mutating sets", () => {
	assert.equal(isMutatingToolCall("subagent_spawn", { template: "coder" }), false);
});

test("tool: unknown name fails closed (mutating)", () => {
	assert.equal(isMutatingToolCall("frobnicate", {}), true);
});

// --- browser_page per-op override ---

test("browser_page: op read is read-only", () => {
	assert.equal(isMutatingToolCall("browser_page", { op: "read" }), false);
});

test("browser_page: op click is mutating", () => {
	assert.equal(isMutatingToolCall("browser_page", { op: "click" }), true);
});

test("browser_page: op type is mutating", () => {
	assert.equal(isMutatingToolCall("browser_page", { op: "type" }), true);
});

test("browser_page: op eval is mutating", () => {
	assert.equal(isMutatingToolCall("browser_page", { op: "eval" }), true);
});

test("browser_page: op goto is mutating", () => {
	assert.equal(isMutatingToolCall("browser_page", { op: "goto" }), true);
});

test("browser_page: op pages is read-only", () => {
	assert.equal(isMutatingToolCall("browser_page", { op: "pages" }), false);
});

test("browser_page: op wait is read-only", () => {
	assert.equal(isMutatingToolCall("browser_page", { op: "wait" }), false);
});

test("browser_page: op scroll is read-only", () => {
	assert.equal(isMutatingToolCall("browser_page", { op: "scroll" }), false);
});

test("browser_page: op shot is read-only", () => {
	assert.equal(isMutatingToolCall("browser_page", { op: "shot" }), false);
});

// --- explainMutatingCall: short, under 120 chars, sensible ---

test("explainMutatingCall: edit mentions the tool name", () => {
	const s = explainMutatingCall("edit", { path: "x.ts" });
	assert.ok(s.includes("edit"));
	assert.ok(s.length < 120);
});

test("explainMutatingCall: read-only tool says read-only", () => {
	const s = explainMutatingCall("read", { path: "x" });
	assert.match(s, /read-only/);
	assert.ok(s.length < 120);
});

test("explainMutatingCall: browser_page op click calls out the op", () => {
	const s = explainMutatingCall("browser_page", { op: "click" });
	assert.ok(s.includes("click"));
	assert.ok(s.length < 120);
});

test("explainMutatingCall: unknown tool fails closed", () => {
	const s = explainMutatingCall("frobnicate", {});
	assert.match(s, /failing closed|mutating|unknown/i);
	assert.ok(s.length < 120);
});

test("BROWSER_MUTATING_OPS contains the four browser mutating ops", () => {
	assert.deepEqual([...BROWSER_MUTATING_OPS].sort(), ["click", "eval", "goto", "type"]);
});