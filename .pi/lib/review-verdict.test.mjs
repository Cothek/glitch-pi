/**
 * review-verdict.test.mjs — node --test suite for Review Gate verdict parsing
 * and async dispatch classification.
 * Run: node --test .pi/lib/review-verdict.test.mjs
 *
 * Fixtures marked REAL are verbatim from the live session that exposed the bug:
 * the ack carried no verdict token, so isPassVerdict(ack) was false and the
 * reviewer's genuine PASS was recorded as FAIL (routing.ts:~924-946).
 */
import test from "node:test";
import assert from "node:assert/strict";

import {
	classifyReviewDispatch,
	extractRunId,
	extractRunSection,
	isDispatchAck,
	isPassVerdict,
} from "./review-verdict.mjs";

// REAL delegate_task ack from the live session (verdict arrives later).
const ACK_REAL = `Delegated: sa-ed5e1e55
Template: reviewer · Title: # reviewer: Review the uncommitted cloud…
The subagent is in the left running list. Use subagent(action="wait_all") to wait for all at once (no polling), subagent(action="get_result") for a single result; continue follow-ups in the SAME subagent session (subagent(action="steer")), do not delegate again. Verify the result before reporting.`;

// REAL wait_all collection result from the same session — run id TRUNCATED
// to 8 chars, verdict inside the run section.
const WAIT_ALL_REAL = `All 1 subagent(s) collected:
- sa-ed5e1（delegate · done · # reviewer: Review the uncommitted cloud…）:
The review is complete. Here's the evidence:

**Diff analysis** — ...

**REVIEW: PASS**`;

// Synthetic TWO-run wait_all result: one PASS run, one FAIL run. Sections
// are separated by lines starting "- ".
const WAIT_ALL_TWO_RUNS = `All 2 subagent(s) collected:
- sa-aaaa11（delegate · done · reviewer）:
The first review is complete. Minor notes inline.

**REVIEW: PASS**
- sa-bbbb22（delegate · done · reviewer-alt）:
The second review is complete. Found a real defect in the diff.

**REVIEW: FAIL**`;

// --- extractRunId ---

test("extractRunId pulls the full run id from the real ack", () => {
	assert.equal(extractRunId(ACK_REAL), "sa-ed5e1e55");
});

test("extractRunId returns empty string for non-ack text", () => {
	assert.equal(extractRunId(WAIT_ALL_REAL), "");
	assert.equal(extractRunId(""), "");
	assert.equal(extractRunId(undefined), "");
	assert.equal(extractRunId("A plain verdict: PASS"), "");
});

// --- isDispatchAck ---

test("isDispatchAck is true for the real delegate ack", () => {
	assert.equal(isDispatchAck(ACK_REAL), true);
});

test("isDispatchAck is false for the wait_all header — it is a COLLECTION, not an ack", () => {
	// "All 1 subagent(s) collected:" carries the verdict below it; treating it
	// as an ack would defer judgement forever.
	assert.equal(isDispatchAck("All 1 subagent(s) collected:\n- sa-ed5e1（delegate · done · reviewer):\nREVIEW: PASS"), false);
	assert.equal(isDispatchAck(WAIT_ALL_REAL), false);
	assert.equal(isDispatchAck(WAIT_ALL_TWO_RUNS), false);
});

test("isDispatchAck is false for verdict text and empty input", () => {
	assert.equal(isDispatchAck("REVIEW: PASS"), false);
	assert.equal(isDispatchAck(""), false);
	assert.equal(isDispatchAck(null), false);
});

// --- extractRunSection ---

test("extractRunSection isolates a run on the two-run wait_all fixture", () => {
	const passSection = extractRunSection(WAIT_ALL_TWO_RUNS, "sa-aaaa11");
	assert.match(passSection, /REVIEW: PASS/);
	assert.doesNotMatch(passSection, /REVIEW: FAIL/);

	const failSection = extractRunSection(WAIT_ALL_TWO_RUNS, "sa-bbbb22");
	assert.match(failSection, /REVIEW: FAIL/);
	// The FAIL run's section must not bleed the earlier PASS token back in...
	assert.doesNotMatch(failSection, /REVIEW: PASS/);
	// ...and judging each section gives the run's own verdict.
	assert.equal(isPassVerdict(passSection), true);
	assert.equal(isPassVerdict(failSection), false);
});

test("extractRunSection isolates the single real run by its truncated id", () => {
	const section = extractRunSection(WAIT_ALL_REAL, "sa-ed5e1");
	assert.match(section, /REVIEW: PASS/);
	assert.equal(isPassVerdict(section), true);
	// The section starts at the run header, not the "All … collected:" line.
	assert.match(section, /^- sa-ed5e1/);
});

test("extractRunSection returns empty string when the run is absent", () => {
	assert.equal(extractRunSection(WAIT_ALL_REAL, "sa-zzzz99"), "");
	assert.equal(extractRunSection("", "sa-ed5e1"), "");
	assert.equal(extractRunSection(WAIT_ALL_REAL, ""), "");
});

// --- classifyReviewDispatch ---

test("classifyReviewDispatch: the real ack is an ack with its run id", () => {
	assert.deepEqual(classifyReviewDispatch(ACK_REAL), { kind: "ack", runId: "sa-ed5e1e55" });
});

test("classifyReviewDispatch: synchronous verdicts (pass and fail) are sync-verdict", () => {
	assert.deepEqual(classifyReviewDispatch("REVIEW: PASS"), { kind: "sync-verdict" });
	assert.deepEqual(classifyReviewDispatch(WAIT_ALL_REAL), { kind: "sync-verdict" });
	assert.deepEqual(classifyReviewDispatch("**FAIL**\n\nI looked for PASS or FAIL"), { kind: "sync-verdict" });
	assert.deepEqual(classifyReviewDispatch("Verdict: REJECTED"), { kind: "sync-verdict" });
	assert.deepEqual(classifyReviewDispatch("FIX THEN SHIP"), { kind: "sync-verdict" });
});

test("classifyReviewDispatch: prose without an ack or a verdict token is unknown", () => {
	assert.deepEqual(classifyReviewDispatch("no verdict word at all here"), { kind: "unknown" });
	assert.deepEqual(classifyReviewDispatch(""), { kind: "unknown" });
	assert.deepEqual(classifyReviewDispatch(undefined), { kind: "unknown" });
});

// --- isPassVerdict (ported verbatim from routing.ts; cases from
// data/scratch/routing-behavior-check.mjs, run against the OLD copy) ---

test("isPassVerdict: deadlock case — PASS body that mentions FAIL is a PASS", () => {
	assert.equal(isPassVerdict("**PASS**\n\nEvidence: a previous attempt would FAIL here."), true);
});

test("isPassVerdict: a qualified pass is not a pass", () => {
	assert.equal(isPassVerdict("**PASS** with minor notes"), false);
});

test("isPassVerdict: old misread case — FAIL leads, body mentions PASS", () => {
	assert.equal(isPassVerdict("**FAIL**\n\nI looked for PASS or FAIL"), false);
});

test("isPassVerdict: plain pass", () => {
	assert.equal(isPassVerdict("PASS — all criteria satisfied"), true);
});

test("isPassVerdict: no verdict word at all", () => {
	assert.equal(isPassVerdict("no verdict word at all here"), false);
});

test("isPassVerdict: FIX THEN SHIP is an explicit fail signal", () => {
	assert.equal(isPassVerdict("FIX THEN SHIP"), false);
});

test("isPassVerdict: the real ack itself yields no pass (the live bug's premise)", () => {
	// The ack is NOT for judging — classifyReviewDispatch routes it to the ack
	// path — but if it ever were judged, it must not pass: it has no verdict.
	assert.equal(isPassVerdict(ACK_REAL), false);
});

test("isPassVerdict: the real collected review is a PASS", () => {
	assert.equal(isPassVerdict(WAIT_ALL_REAL), true);
});
