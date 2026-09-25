/**
 * plan-paths.test.mjs — node --test suite for the session-scoped plan ownership rules.
 * Run: node --test .pi/lib/plan-paths.test.mjs
 */
import test from "node:test";
import assert from "node:assert/strict";

import {
	PLAN_ARCHIVE_DIR,
	PLAN_FILE_NAME,
	PLAN_SESSIONS_DIR,
	LEGACY_PLAN_PATH,
	classifyPlanCommand,
	classifyPlanPath,
	extractPlanRefs,
	hasPlanMutation,
	isPlanPath,
	normalizePath,
	sessionPlanPath,
} from "./plan-paths.mjs";

const SID_A = "01a0d4ef-4af5-7576-bf49-cd5d688b52e42b";
const SID_B = "01a0d900-1c06-7576-bf49-cd6d7aff0472";

// --- normalizePath + isPlanPath ---

test("normalizePath converts backslashes, tolerates null", () => {
	assert.equal(normalizePath("E:\\Glitch AI\\glitch-pi\\data\\plans"), "E:/Glitch AI/glitch-pi/data/plans");
	assert.equal(normalizePath(undefined), "");
	assert.equal(normalizePath("data/plans/current-plan.md"), "data/plans/current-plan.md");
});

test("isPlanPath matches relative, absolute, both slash styles, case-insensitive", () => {
	assert.equal(isPlanPath("data/plans/sessions/x/current-plan.md"), true);
	assert.equal(isPlanPath("E:/repo/data/plans/x.md"), true);
	assert.equal(isPlanPath("E:\\repo\\data\\Plans\\x.md"), true);
	assert.equal(isPlanPath("data/plans"), true);
	assert.equal(isPlanPath("mv data/plans/a.md data/plans/b.md"), true);
	assert.equal(isPlanPath("--path=data/plans/a.md"), true);
	assert.equal(isPlanPath("data/plans-backup/x.md"), false);
	assert.equal(isPlanPath("node_modules/data/plans"), true); // conservative: still a plans path
	assert.equal(isPlanPath("docs/plans.md"), false);
	assert.equal(isPlanPath("data/blast-radius/x.json"), false);
});

// --- sessionPlanPath ---

test("sessionPlanPath builds the session-scoped path, sanitizes ids, defaults", () => {
	assert.equal(sessionPlanPath(SID_A), `data/plans/${PLAN_SESSIONS_DIR}/${SID_A}/${PLAN_FILE_NAME}`);
	assert.equal(sessionPlanPath("default"), `data/plans/${PLAN_SESSIONS_DIR}/default/${PLAN_FILE_NAME}`);
	assert.equal(sessionPlanPath(null), `data/plans/${PLAN_SESSIONS_DIR}/default/${PLAN_FILE_NAME}`);
	// A hostile / weird id cannot escape the session dir.
	assert.equal(sessionPlanPath("../evil"), `data/plans/${PLAN_SESSIONS_DIR}/..-evil/${PLAN_FILE_NAME}`);
});

// --- classifyPlanPath ---

test("classifyPlanPath: own session dir is owned (file and deeper paths)", () => {
	assert.equal(classifyPlanPath(sessionPlanPath(SID_A), SID_A), "owned");
	assert.equal(classifyPlanPath(`data/plans/${PLAN_SESSIONS_DIR}/${SID_A}/notes.md`, SID_A), "owned");
	assert.equal(
		classifyPlanPath(`E:/Glitch AI/glitch-pi/data/plans/${PLAN_SESSIONS_DIR}/${SID_A}/${PLAN_FILE_NAME}`, SID_A),
		"owned",
	);
});

test("classifyPlanPath: other session dirs, legacy file, stray plans are foreign", () => {
	assert.equal(classifyPlanPath(sessionPlanPath(SID_B), SID_A), "foreign");
	assert.equal(classifyPlanPath(LEGACY_PLAN_PATH, SID_A), "foreign");
	assert.equal(classifyPlanPath("data/plans/some-random.md", SID_A), "foreign");
	assert.equal(classifyPlanPath(`data\\plans\\current-plan.md`, SID_A), "foreign");
});

test("classifyPlanPath: archive is shared regardless of session", () => {
	assert.equal(classifyPlanPath(`${PLAN_ARCHIVE_DIR}/2026-09-25-fix.md`, SID_A), "shared");
	assert.equal(classifyPlanPath(`${PLAN_ARCHIVE_DIR}`, SID_B), "shared");
	assert.equal(classifyPlanPath(`E:/repo/data/plans/archive/2026-09-25-fix.md`, SID_B), "shared");
});

// --- extractPlanRefs ---

test("extractPlanRefs pulls every plans path out of a command, both slash styles", () => {
	assert.deepEqual(extractPlanRefs(`mv data/plans/sessions/${SID_A}/current-plan.md data/plans/archive/x.md`), [
		`data/plans/sessions/${SID_A}/current-plan.md`,
		"data/plans/archive/x.md",
	]);
	assert.deepEqual(extractPlanRefs(`move "data\\plans\\sessions\\s1\\current-plan.md" archive`), [
		"data/plans/sessions/s1/current-plan.md",
	]);
	assert.deepEqual(extractPlanRefs("cat data/plans/sessions/other/plan.md"), [
		"data/plans/sessions/other/plan.md",
	]);
	assert.deepEqual(extractPlanRefs("ls data/plans"), ["data/plans"]);
	assert.deepEqual(extractPlanRefs("grep -r plans/ src/"), []);
});

// --- hasPlanMutation ---

test("hasPlanMutation: verb + plans path, not reads", () => {
	assert.equal(hasPlanMutation(`mv data/plans/sessions/x/a.md data/plans/archive/b.md`), true);
	assert.equal(hasPlanMutation("Move-Item data\\plans\\a.md b.md"), true);
	assert.equal(hasPlanMutation("rm -f data/plans/current-plan.md"), true);
	assert.equal(hasPlanMutation("cat data/plans/current-plan.md"), false);
	assert.equal(hasPlanMutation("ls data/plans/archive"), false);
	assert.equal(hasPlanMutation("rm -f docs/other.md"), false);
	assert.equal(hasPlanMutation("git status"), false);
});

// --- classifyPlanCommand (the ownership verdict) ---

test("archive move of the session's own plan is allowed", () => {
	const v = classifyPlanCommand(
		`mv data/plans/${PLAN_SESSIONS_DIR}/${SID_A}/current-plan.md ${PLAN_ARCHIVE_DIR}/2026-09-25-own-task.md`,
		SID_A,
	);
	assert.equal(v.allowed, true);
	assert.deepEqual(v.offending, []);
});

test("archiving ANOTHER session's plan is blocked", () => {
	const v = classifyPlanCommand(
		`mv data/plans/${PLAN_SESSIONS_DIR}/${SID_B}/current-plan.md ${PLAN_ARCHIVE_DIR}/2026-09-25-not-mine.md`,
		SID_A,
	);
	assert.equal(v.allowed, false);
	assert.equal(v.offending.length, 1);
	assert.match(v.reason, /another session/);
});

test("overwriting the legacy shared file is blocked with the legacy message", () => {
	const v = classifyPlanCommand(`mv data/plans/current-plan.md ${PLAN_ARCHIVE_DIR}/x.md`, SID_A);
	assert.equal(v.allowed, false);
	assert.match(v.reason, /LEGACY/);
	assert.match(v.reason, new RegExp(PLAN_SESSIONS_DIR));
});

test("mixed command (own file + foreign file) is blocked on the foreign ref", () => {
	const v = classifyPlanCommand(
		`mv data/plans/${PLAN_SESSIONS_DIR}/${SID_A}/current-plan.md data/plans/sessions/${SID_B}/hijack.md`,
		SID_A,
	);
	assert.equal(v.allowed, false);
	assert.equal(v.offending[0], `data/plans/sessions/${SID_B}/hijack.md`);
});

test("powerShell move-item on a foreign plan is blocked", () => {
	const v = classifyPlanCommand(
		`Move-Item "E:/Glitch AI/glitch-pi/data/plans/sessions/${SID_B}/current-plan.md" "E:/tmp/x.md"`,
		SID_A,
	);
	assert.equal(v.allowed, false);
	// offending refs are reported in canonical data/plans/... form
	assert.equal(v.offending[0], `data/plans/sessions/${SID_B}/current-plan.md`);
});

test("absolute own-session path mutation is allowed", () => {
	const v = classifyPlanCommand(
		`Move-Item "E:/repo/data/plans/${PLAN_SESSIONS_DIR}/${SID_A}/current-plan.md" "E:/repo/${PLAN_ARCHIVE_DIR}/a.md"`,
		SID_A,
	);
	assert.equal(v.allowed, true);
});
