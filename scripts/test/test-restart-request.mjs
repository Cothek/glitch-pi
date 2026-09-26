#!/usr/bin/env node
/**
 * Pure-Node tests for scripts/restart-request.mjs.
 *
 * Imports only the named exports (`sanitizeNote`, `buildInnerCommand`,
 * `parseArgs`) so we never touch the filesystem, the env, or PowerShell.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import {
  sanitizeNote,
  buildInnerCommand,
  parseArgs,
  resolveResumeNote,
  isSafeSessionValue,
} from "../restart-request.mjs";

test("sanitizeNote: strips shell metacharacters and collapses whitespace", () => {
  const dirty = `  "quotes"\tand %PATH% & pipe | caret ^ <redir> \r\n end  `;
  const clean = sanitizeNote(dirty);
  assert.equal(clean, "quotes and PATH pipe caret redir end");
});

test("sanitizeNote: strips CR and LF even with no surrounding whitespace", () => {
  const dirty = "line1\r\nline2\nline3";
  const clean = sanitizeNote(dirty);
  assert.equal(clean, "line1 line2 line3");
});

test("sanitizeNote: truncates past 300 chars", () => {
  const long = "a".repeat(500);
  const clean = sanitizeNote(long);
  assert.equal(clean.length, 300);
  assert.equal(clean, "a".repeat(300));
});

test("sanitizeNote: trims and collapses internal runs", () => {
  assert.equal(sanitizeNote("   hello    world   "), "hello world");
  assert.equal(sanitizeNote(null), "");
  assert.equal(sanitizeNote(""), "");
});

test("buildInnerCommand: no continuation -> -DelaySec, no -ContinuePath", () => {
  const cmd = buildInnerCommand({
    root: "E:\\Glitch AI\\glitch-pi",
    delaySec: 15,
    continuePath: "",
    continueText: "",
  });
  assert.match(cmd, /-DelaySec 15/);
  assert.doesNotMatch(cmd, /-ContinuePath/);
  assert.doesNotMatch(cmd, /-ContinueText/);
  assert.match(cmd, /-File "[^"]+restart-pi-stack\.ps1"/);
});

test("buildInnerCommand: with continuation -> -ContinuePath and -ContinueText", () => {
  const cmd = buildInnerCommand({
    root: "E:\\Glitch AI\\glitch-pi",
    delaySec: 30,
    continuePath: "C:\\x.jsonl",
    continueText: "go on",
  });
  assert.match(cmd, /-ContinuePath "C:\\x\.jsonl"/);
  assert.match(cmd, /-ContinueText "go on"/);
  assert.match(cmd, /-DelaySec 30/);
});

test("buildInnerCommand: uses the provided root in the path", () => {
  const cmd = buildInnerCommand({
    root: "C:\\repo",
    delaySec: 5,
    continuePath: "",
    continueText: "",
  });
  const ps = join("C:\\repo", "scripts", "restart-pi-stack.ps1");
  assert.ok(cmd.includes(`-File "${ps}"`), `expected cmd to include -File "${ps}", got: ${cmd}`);
});

test("parseArgs: defaults delay to 15 and picks up all the flags", () => {
  const out = parseArgs([
    "--resume",
    "--delay", "30",
    "--note", "hello",
    "--session", "C:\\x.jsonl",
    "--json",
    "--dry-run",
  ]);
  assert.equal(out.resume, true);
  assert.equal(out.delay, 30);
  assert.equal(out.note, "hello");
  assert.equal(out.session, "C:\\x.jsonl");
  assert.equal(out.json, true);
  assert.equal(out.dryRun, true);
  assert.equal(out.error, null);
});

test("parseArgs: defaults delay to 15 when --delay is omitted", () => {
  const out = parseArgs(["--resume"]);
  assert.equal(out.delay, 15);
  assert.equal(out.resume, true);
  assert.equal(out.error, null);
});

test("parseArgs: rejects out-of-range delay with an error message", () => {
  const tooBig = parseArgs(["--delay", "999"]);
  assert.match(tooBig.error, /--delay/);
  const negative = parseArgs(["--delay", "-1"]);
  assert.match(negative.error, /--delay/);
});

test("parseArgs: rejects unknown flag with an error message", () => {
  const out = parseArgs(["--bogus"]);
  assert.match(out.error, /unknown flag/);
});

test("parseArgs: rejects --note without a value", () => {
  const out = parseArgs(["--note"]);
  assert.match(out.error, /--note/);
});

test("parseArgs: picks up --session-id and --help", () => {
  const out = parseArgs(["--session-id", "abc", "--help"]);
  assert.equal(out.sessionId, "abc");
  assert.equal(out.help, true);
});


test("buildInnerCommand: with continueId -> -ContinueId and no -ContinuePath", () => {
  const cmd = buildInnerCommand({
    root: "E:\\Glitch AI\\glitch-pi",
    delaySec: 15,
    continueId: "abc",
    continueText: "go on",
  });
  assert.match(cmd, /-ContinueId "abc"/);
  assert.match(cmd, /-ContinueText "go on"/);
  assert.doesNotMatch(cmd, /-ContinuePath/);
});

test("parseArgs: accepts --session-id on its own", () => {
  const out = parseArgs(["--session-id", "01a0de39-0d2d-7411-a49b-863d934f6713"]);
  assert.equal(out.sessionId, "01a0de39-0d2d-7411-a49b-863d934f6713");
  assert.equal(out.error, null);
});

test("resolveResumeNote: empty-after-sanitize falls back to DEFAULT_NOTE (B3)", () => {
  const DEFAULT_NOTE = "Server restarted on request. Continue where you left off.";
  assert.equal(resolveResumeNote({ resume: true, note: "" }), DEFAULT_NOTE);
  assert.equal(resolveResumeNote({ resume: true, note: null }), DEFAULT_NOTE);
  assert.equal(resolveResumeNote({ resume: true, note: undefined }), DEFAULT_NOTE);
  assert.equal(resolveResumeNote({ resume: true, note: '  "  ' }), DEFAULT_NOTE);
  assert.equal(resolveResumeNote({ resume: true, note: "hello" }), "hello");
  assert.equal(resolveResumeNote({ resume: false, note: "ignored" }), "");
});

test("isSafeSessionValue: accepts a normal Windows jsonl path with backslashes", () => {
  assert.equal(isSafeSessionValue("C:\\Users\\me\\.pi\\sessions\\abc.jsonl"), true);
});

test("isSafeSessionValue: accepts a plain GUID", () => {
  assert.equal(
    isSafeSessionValue("01a0de39-0d2d-7411-a49b-863d934f6713"),
    true,
  );
});

test("isSafeSessionValue: refuses a value containing a double quote", () => {
  assert.equal(isSafeSessionValue('C:\\x" & calc.exe & echo "'), false);
});

test("isSafeSessionValue: refuses a value containing a newline", () => {
  assert.equal(isSafeSessionValue("C:\\x\ncalc"), false);
  assert.equal(isSafeSessionValue("C:\\x\rcalc"), false);
});
