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
