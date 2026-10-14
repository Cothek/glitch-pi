/**
 * subagent-watchdog-logic.test.mjs — node --test suite for the subagent
 * watchdog pure logic module.
 *
 * Run: node --test .pi/lib/subagent-watchdog-logic.test.mjs
 */
import test from "node:test";
import assert from "node:assert/strict";

import {
  HANG_THRESHOLD_MS,
  WARN_THRESHOLD_MS,
  DIRECTIVE_COOLDOWN_MS,
  INACTIVE_SWEEP_MS,
  MAX_AGE_MS,
  createEmptyState,
  recordSpawn,
  recordObservation,
  evaluate,
  sweep,
  buildDirective,
  parseRunIdFromResult,
  extractSpawnInfo,
  extractRunStatus,
  resolveEntryKey,
  filterLiveDirectives,
} from "./subagent-watchdog-logic.mts";

const MIN = 60_000;
const NOW = 1_700_000_000_000;

// --- Constants sanity ---

test("constants: HANG > WARN, both positive", () => {
  assert.ok(HANG_THRESHOLD_MS > WARN_THRESHOLD_MS);
  assert.ok(WARN_THRESHOLD_MS > 0);
  assert.equal(HANG_THRESHOLD_MS, 12 * MIN);
  assert.equal(WARN_THRESHOLD_MS, 5 * MIN);
});

// --- Spawn → no action ---

test("spawn with immediate evaluate → no directives", () => {
  const s = createEmptyState();
  recordSpawn(s, "sa-aa001", "explore", NOW);
  const d = evaluate(s, NOW);
  assert.equal(d.length, 0);
});

test("spawn shortly before evaluate → no directives", () => {
  const s = createEmptyState();
  recordSpawn(s, "sa-aa001", "explore", NOW - 2 * MIN);
  const d = evaluate(s, NOW);
  assert.equal(d.length, 0);
});

// --- Silent 6m → warn once ---

test("silent for WARN_THRESHOLD + 1m → warn directive", () => {
  const s = createEmptyState();
  recordSpawn(s, "sa-bb001", "coder", NOW - 6 * MIN);
  const d = evaluate(s, NOW);
  assert.equal(d.length, 1);
  assert.equal(d[0].action, "warn");
  assert.equal(d[0].runId, "sa-bb001");
  assert.equal(d[0].template, "coder");
  assert.ok(d[0].silentForMs >= WARN_THRESHOLD_MS);
});

// --- Warn cooldown ---

test("warn directive has cooldown — second evaluate within window → no re-fire", () => {
  const s = createEmptyState();
  recordSpawn(s, "sa-bb001", "coder", NOW - 6 * MIN);
  const d1 = evaluate(s, NOW);
  assert.equal(d1.length, 1);

  // 2 minutes later, still silent, still in warn range — but cooldown active
  const d2 = evaluate(s, NOW + 2 * MIN);
  assert.equal(d2.length, 0, "cooldown should suppress re-fire");
});

test("warn cooldown expires → can fire again", () => {
  const s = createEmptyState();
  // Spawn 2m before NOW so first warn fires at NOW+3m (5m total silence).
  recordSpawn(s, "sa-bb001", "coder", NOW - 2 * MIN);

  // At NOW: only 2m silent → no directive
  assert.equal(evaluate(s, NOW).length, 0);

  // At NOW+3m: 5m silent → warn fires
  const d1 = evaluate(s, NOW + 3 * MIN);
  assert.equal(d1.length, 1);
  assert.equal(d1[0].action, "warn");

  // After cooldown expires (NOW+3m+COOLDOWN+1), total silence = COOLDOWN+3m+1.
  // Must stay below hang threshold (12m). COOLDOWN=10m, so 13m > 12m — too late.
  // Instead, use a shorter gap: evaluate at NOW+8m (8m since warn, cooldown
  // still active → no fire), then at NOW+13m+1 (cooldown passed, 15m+1s silent,
  // which is past hang). So for a WARN re-fire test we need a different layout:
  // spawn closer to the eval point.
  // Simpler: spawn at NOW, first warn at NOW+5m, cooldown expires at NOW+15m,
  // hang threshold at NOW+12m. At NOW+15m+1, action is hang not warn.
  // This is correct behavior — warn escalates to hang after cooldown.
  // To test warn→warn specifically, the agent must get new activity in between.
  // Reset: spawn fresh, warn, output changes to reset clock, warn again after cooldown.
  const s2 = createEmptyState();
  recordSpawn(s2, "sa-bb001b", "coder", NOW);

  // 5m silent → warn
  const w1 = evaluate(s2, NOW + 5 * MIN);
  assert.equal(w1.length, 1);

  // Output change at 8m resets the clock
  recordObservation(s2, "sa-bb001b", undefined, "Progress!", NOW + 8 * MIN);

  // At 13m: 5m since last output change, cooldown still active (13m-8m=5m < 10m)
  // Actually cooldown is from lastDirectiveAt (NOW+5m). 13m - 5m = 8m < 10m → blocked
  assert.equal(evaluate(s2, NOW + 13 * MIN).length, 0);

  // At 16m: 8m since output change (>5m warn), 11m since directive (>10m cooldown)
  const w2 = evaluate(s2, NOW + 16 * MIN);
  assert.equal(w2.length, 1);
  assert.equal(w2[0].action, "warn");
});

// --- Silent 13m → hang ---

test("silent for HANG_THRESHOLD + 1m → hang directive", () => {
  const s = createEmptyState();
  recordSpawn(s, "sa-cc001", "explore", NOW - 13 * MIN);
  const d = evaluate(s, NOW);
  assert.equal(d.length, 1);
  assert.equal(d[0].action, "hang");
  assert.ok(d[0].silentForMs >= HANG_THRESHOLD_MS);
});

test("hang directive after warn cooldown expires", () => {
  const s = createEmptyState();
  recordSpawn(s, "sa-cc001", "explore", NOW - 6 * MIN);

  // Warn at NOW (6m silent)
  const d1 = evaluate(s, NOW);
  assert.equal(d1[0].action, "warn");

  // At NOW+7m: 13m total silence (past hang), but cooldown still active
  // (7m < 10m cooldown) → no directive
  assert.equal(evaluate(s, NOW + 7 * MIN).length, 0);

  // At NOW+10m+1: cooldown expired, 16m+1s total silence → hang fires
  const d2 = evaluate(s, NOW + DIRECTIVE_COOLDOWN_MS + 1);
  assert.equal(d2.length, 1);
  assert.equal(d2[0].action, "hang");
});

// --- Output change resets clock ---

test("output change resets silence clock — no directive after reset", () => {
  const s = createEmptyState();
  recordSpawn(s, "sa-dd001", "coder", NOW - 6 * MIN);

  // Output changes at NOW-1m — resets the clock
  recordObservation(s, "sa-dd001", undefined, "New output content here", NOW - MIN);

  const d = evaluate(s, NOW);
  assert.equal(d.length, 0, "clock reset means only 1m silent");
});

test("output change then silence again → warn after threshold", () => {
  const s = createEmptyState();
  recordSpawn(s, "sa-dd002", "coder", NOW - 10 * MIN);

  // Output changes at NOW-3m — resets clock to 3m ago
  recordObservation(s, "sa-dd002", undefined, "Some progress", NOW - 3 * MIN);

  // At NOW, only 3m silent → no directive
  const d1 = evaluate(s, NOW);
  assert.equal(d1.length, 0);

  // At NOW+3m, 6m silent → warn
  const d2 = evaluate(s, NOW + 3 * MIN);
  assert.equal(d2.length, 1);
  assert.equal(d2[0].action, "warn");
});

test("same output does NOT reset clock", () => {
  const s = createEmptyState();
  recordSpawn(s, "sa-dd003", "coder", NOW - 6 * MIN);

  // Observation with same output — should NOT reset clock
  recordObservation(s, "sa-dd003", undefined, "Same output", NOW - MIN);
  // The sig was "" from spawn, "Same output" is different → first obs resets
  // Second identical obs should not reset again
  recordObservation(s, "sa-dd003", undefined, "Same output", NOW);

  // lastActivityAt was set to NOW-MIN by first obs (different from ""),
  // then NOW by second obs (different length from "" — wait, both are "Same output")
  // Actually: spawn sig="", first obs sig="11|Same output" → reset to NOW-MIN.
  // Second obs sig="11|Same output" == entry.lastOutputSig → no reset.
  // So silentForMs = NOW - (NOW-MIN) = MIN → no directive (below threshold)
  const d = evaluate(s, NOW);
  assert.equal(d.length, 0);

  // But after WARN threshold from the FIRST reset
  const d2 = evaluate(s, NOW - MIN + WARN_THRESHOLD_MS + 1);
  assert.equal(d2.length, 1);
});

// --- Status done → no directives ---

test("status done deactivates entry → no directives", () => {
  const s = createEmptyState();
  recordSpawn(s, "sa-ee001", "coder", NOW - 15 * MIN);
  recordObservation(s, "sa-ee001", "done", "Task complete", NOW);

  const d = evaluate(s, NOW);
  assert.equal(d.length, 0);
});

test("status error deactivates entry → no directives", () => {
  const s = createEmptyState();
  recordSpawn(s, "sa-ee002", "coder", NOW - 15 * MIN);
  recordObservation(s, "sa-ee002", "error", "Provider 404", NOW);

  const d = evaluate(s, NOW);
  assert.equal(d.length, 0);
});

test("status stopped deactivates entry → no directives", () => {
  const s = createEmptyState();
  recordSpawn(s, "sa-ee003", "coder", NOW - 15 * MIN);
  recordObservation(s, "sa-ee003", "stopped", undefined, NOW);

  const d = evaluate(s, NOW);
  assert.equal(d.length, 0);
});

test("observation after done status is ignored", () => {
  const s = createEmptyState();
  recordSpawn(s, "sa-ee004", "coder", NOW - 15 * MIN);
  recordObservation(s, "sa-ee004", "done", "Complete", NOW - MIN);
  recordObservation(s, "sa-ee004", "done", "Complete still", NOW);

  const entry = s.entries["sa-ee004"];
  assert.equal(entry.active, false);
  assert.equal(entry.status, "done");
});

// --- Sweep ---

test("sweep: inactive done entry swept after INACTIVE_SWEEP_MS", () => {
  const s = createEmptyState();
  recordSpawn(s, "sa-ff001", "coder", NOW - 60 * MIN);
  recordObservation(s, "sa-ff001", "done", "Done", NOW - 45 * MIN);

  sweep(s, NOW);
  assert.equal(s.entries["sa-ff001"], undefined);
});

test("sweep: inactive error entry swept after INACTIVE_SWEEP_MS", () => {
  const s = createEmptyState();
  recordSpawn(s, "sa-ff002", "coder", NOW - 60 * MIN);
  recordObservation(s, "sa-ff002", "error", "Failed", NOW - 35 * MIN);

  sweep(s, NOW);
  assert.equal(s.entries["sa-ff002"], undefined);
});

test("sweep: active entry preserved even after long time", () => {
  const s = createEmptyState();
  recordSpawn(s, "sa-ff003", "coder", NOW - 60 * MIN);
  // Still active, never observed as done/error

  sweep(s, NOW);
  assert.ok(s.entries["sa-ff003"], "active entry should survive sweep");
});

test("sweep: 24h hard TTL removes everything", () => {
  const s = createEmptyState();
  recordSpawn(s, "sa-ff004", "coder", NOW - MAX_AGE_MS - MIN);
  // Still active, but age > 24h

  sweep(s, NOW);
  assert.equal(s.entries["sa-ff004"], undefined);
});

test("sweep: recently inactive entry preserved", () => {
  const s = createEmptyState();
  recordSpawn(s, "sa-ff005", "coder", NOW - 20 * MIN);
  recordObservation(s, "sa-ff005", "done", "Done", NOW - 10 * MIN);

  // Inactive for only 10m — below INACTIVE_SWEEP_MS
  sweep(s, NOW);
  assert.ok(s.entries["sa-ff005"], "recently done should survive");
});

// --- buildDirective ---

test("buildDirective: hang message", () => {
  const text = buildDirective({
    runId: "sa-ffce2a00",
    template: "explore",
    action: "hang",
    silentForMs: 12 * MIN,
  });
  assert.match(text, /sa-ffce2a/);
  assert.match(text, /explore/);
  assert.match(text, /hung/);
  assert.match(text, /subagent\(action="stop"/);
  assert.match(text, /Never shut the conversation down/);
});

test("buildDirective: warn message", () => {
  const text = buildDirective({
    runId: "sa-aabb1234",
    template: "coder",
    action: "warn",
    silentForMs: 6 * MIN,
  });
  assert.match(text, /sa-aabb12/);
  assert.match(text, /coder/);
  assert.match(text, /possibly stalled/);
  assert.match(text, /get_result/);
});

// --- parseRunIdFromResult ---

test("parseRunIdFromResult: Subagent started format", () => {
  const r = parseRunIdFromResult("Subagent started successfully: sa-ffce2a00");
  assert.equal(r, "sa-ffce2a00");
});

test("parseRunIdFromResult: Delegated format", () => {
  const r = parseRunIdFromResult("Delegated: sa-abcdef01");
  assert.equal(r, "sa-abcdef01");
});

test("parseRunIdFromResult: object with content string", () => {
  const r = parseRunIdFromResult({ content: "Subagent started: sa-1234abcd" });
  assert.equal(r, "sa-1234abcd");
});

test("parseRunIdFromResult: object with content array", () => {
  const r = parseRunIdFromResult({
    content: [{ type: "text", text: "Delegated: sa-deadbeef" }],
  });
  assert.equal(r, "sa-deadbeef");
});

test("parseRunIdFromResult: null for no match", () => {
  assert.equal(parseRunIdFromResult("no runid here"), null);
  assert.equal(parseRunIdFromResult(""), null);
  assert.equal(parseRunIdFromResult(null), null);
  assert.equal(parseRunIdFromResult(undefined), null);
});

// --- Multiple entries ---

test("evaluate: multiple active entries, only silent ones get directives", () => {
  const s = createEmptyState();
  recordSpawn(s, "sa-001", "coder", NOW - 13 * MIN);
  recordSpawn(s, "sa-002", "explore", NOW - 2 * MIN);
  recordSpawn(s, "sa-003", "reviewer", NOW - 7 * MIN);

  const d = evaluate(s, NOW);
  assert.equal(d.length, 2);

  const byId = Object.fromEntries(d.map((x) => [x.runId, x]));
  assert.equal(byId["sa-001"].action, "hang");
  assert.equal(byId["sa-003"].action, "warn");
  assert.equal(byId["sa-002"], undefined);
});

test("evaluate: unknown runId in observation is a no-op", () => {
  const s = createEmptyState();
  recordObservation(s, "sa-nonexistent", undefined, "hello", NOW);
  assert.equal(Object.keys(s.entries).length, 0);
});

// --- extractSpawnInfo ---

test("extractSpawnInfo: real ack shape with Template line", () => {
  const info = extractSpawnInfo(
    "Delegated: sa-ed5e1e55\nTemplate: reviewer · model: x\nUse this runId...",
  );
  assert.deepEqual(info, { runId: "sa-ed5e1e55", template: "reviewer" });
});

test("extractSpawnInfo: Spawned ack without Template", () => {
  const info = extractSpawnInfo("Spawned: sa-abc12345def");
  assert.deepEqual(info, { runId: "sa-abc12345def", template: null });
});

test("extractSpawnInfo: null on validation-error dump (phantom regression)", () => {
  const dump =
    'Validation failed for tool "delegate_task":\n' +
    "  - must_do: must be string\n\n" +
    "Received arguments:\n" +
    '{..."context": "...Delegated: sa-ed5e1e55\\nTemplate: reviewer..."...}';
  assert.equal(extractSpawnInfo(dump), null);
});

test("extractSpawnInfo: null on empty / non-verb text", () => {
  assert.equal(extractSpawnInfo(""), null);
  assert.equal(extractSpawnInfo("hello sa-abcdef01"), null);
  assert.equal(extractSpawnInfo("  no match here"), null);
});

// --- extractRunStatus ---

test("extractRunStatus: done from header line", () => {
  const text =
    "- sa-fec2e1（delegate · done · # reviewer: approved）:\n  Review body text";
  assert.equal(extractRunStatus(text, "sa-fec2e1"), "done");
});

test("extractRunStatus: error from header line", () => {
  const text = "- sa-bfdac（delegate · error · # coder: failed）:";
  assert.equal(extractRunStatus(text, "sa-bfdac"), "error");
});

test("extractRunStatus: null when status word only in body text", () => {
  const text =
    "- sa-fec2e1（delegate · running · # reviewer）:\n  The agent said it is done with the task.";
  assert.equal(extractRunStatus(text, "sa-fec2e1"), null);
});

test("extractRunStatus: null when run prefix absent", () => {
  const text = "- sa-fec2e1（delegate · done · # reviewer）:";
  assert.equal(extractRunStatus(text, "sa-zzzzzz"), null);
  assert.equal(extractRunStatus("", "sa-fec2e1"), null);
});

test("extractRunStatus: 8-char truncation wiring shape (extension pins this)", () => {
  // Collected wait_all headers truncate run ids to their first 8 CHARACTERS
  // TOTAL: "sa-fec2e（" for full id "sa-fec2e1bc". The extension calls
  // extractRunStatus(text, key.slice(0, 8)) — this test pins that contract.
  const text = "- sa-fec2e（delegate · done · # reviewer: approved）:\n  body";
  assert.equal(extractRunStatus(text, "sa-fec2e1bc".slice(0, 8)), "done");
  // 9+ chars would miss the header — guard against regression to a longer slice.
  assert.equal(extractRunStatus(text, "sa-fec2e1bc".slice(0, 9)), null);
});

// --- resolveEntryKey ---

test("resolveEntryKey: exact match", () => {
  const s = createEmptyState();
  recordSpawn(s, "sa-fec2e1bc", "coder", NOW);
  assert.equal(resolveEntryKey(s, "sa-fec2e1bc"), "sa-fec2e1bc");
});

test("resolveEntryKey: unique prefix match both directions", () => {
  const s = createEmptyState();
  recordSpawn(s, "sa-fec2e1bc", "coder", NOW);
  assert.equal(resolveEntryKey(s, "sa-fec2e1"), "sa-fec2e1bc");
  assert.equal(resolveEntryKey(s, "sa-fec2e1bc99"), "sa-fec2e1bc");
});

test("resolveEntryKey: null on ambiguous", () => {
  const s = createEmptyState();
  recordSpawn(s, "sa-aa0011", "coder", NOW);
  recordSpawn(s, "sa-aa0022", "reviewer", NOW);
  assert.equal(resolveEntryKey(s, "sa-aa"), null);
});

test("resolveEntryKey: null on absent", () => {
  const s = createEmptyState();
  recordSpawn(s, "sa-aa0011", "coder", NOW);
  assert.equal(resolveEntryKey(s, "sa-bb"), null);
  assert.equal(resolveEntryKey(s, ""), null);
});

// --- filterLiveDirectives ---

function mkDirective(runId, action = "hang") {
  return { runId, template: "coder", action, silentForMs: 20 * MIN, message: "msg" };
}

test("filterLiveDirectives: keeps active, drops done and absent", () => {
  const s = createEmptyState();
  recordSpawn(s, "sa-live01", "coder", NOW - 30 * MIN);
  recordSpawn(s, "sa-done01", "coder", NOW - 60 * MIN);
  recordObservation(s, "sa-done01", "done", "Done", NOW - 45 * MIN);

  const live = filterLiveDirectives(s, [
    mkDirective("sa-live01"),
    mkDirective("sa-done01"),
    mkDirective("sa-ghost9"),
  ]);
  assert.equal(live.length, 1);
  assert.equal(live[0].runId, "sa-live01");
});

// --- recordObservation with parsed status (wait_all shape) ---

test("recordObservation: status from extractRunStatus deactivates entry", () => {
  const s = createEmptyState();
  recordSpawn(s, "sa-fec2e1bc", "reviewer", NOW - 30 * MIN);
  const collected =
    "- sa-fec2e1（delegate · done · # reviewer: approved）:\n  LGTM";
  const status = extractRunStatus(collected, "sa-fec2e1");
  recordObservation(s, "sa-fec2e1bc", status, collected, NOW);
  assert.equal(s.entries["sa-fec2e1bc"].active, false);
  assert.equal(s.entries["sa-fec2e1bc"].status, "done");
  assert.equal(evaluate(s, NOW + 20 * MIN).length, 0);
});
