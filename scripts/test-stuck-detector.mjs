// test-stuck-detector.mjs — Unit tests for the REFINED stuck detector logic.
//
// Run: node scripts/test-stuck-detector.mjs
// (Node >= 23.6 loads .ts via native type stripping; repo ships node 24.)
//
// v2: imports .pi/extensions/stuck-detector-logic.mts (the OLD import path
// .opencode/plugins/stuck-detector.js was the deleted OpenCode location —
// the Pi port had zero coverage). Tests below cover the refinement:
//   - args are real (fingerprinted), not the literal "{}"
//   - polling tools (browser_page, todo_list, subagent_*) get threshold 6
//   - tool_repetition needs an ONGOING similar cluster, not one stale pair
//   - error_cascade needs 4 diverse errors or 3 identical failing calls
//   - command_repetition must be ongoing
//   - argsKnown=false entries never trigger similarity rules (fail-safe)

import { detectStuck, isGenuineProgress, isClockCommand } from "../.pi/extensions/stuck-detector-logic.mts";
import assert from "node:assert";

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    passed++;
    console.log(`  \u2713 ${name}`);
  } catch (e) {
    failed++;
    console.error(`  \u2717 ${name}`);
    console.error(`    ${e.message}`);
  }
}

function entry(tool, args, error = false, argsKnown = true) {
  return { tool, args: args || {}, argsKnown, error, timestamp: Date.now() };
}

// Pad with reads of DIFFERENT files so pads are inert: read is excluded from
// rule 1, breaks any readonly consecutive run at the front, and is not shell.
function padHistory(history, minLen = 4) {
  let i = 0;
  while (history.length < minLen) {
    history.unshift(entry("read", { filePath: `E:\\pad\\pad-file-${i++}.json` }));
  }
  return history;
}

// ============================================================
console.log("\nFALSE POSITIVE tests (must return null):");
// ============================================================

test("6 reads of DIFFERENT files in same directory \u2192 no readonly_repetition", () => {
  const history = [];
  for (let i = 0; i < 6; i++) {
    history.push(entry("read", { filePath: `E:\\Glitch AI\\glitch-pi\\data\\file${i}.json` }));
  }
  const result = detectStuck(history);
  assert.strictEqual(result, null, `Expected null, got: ${JSON.stringify(result)}`);
});

test("8 sequential edits to same file \u2192 no tool_repetition (edit excluded)", () => {
  const history = [];
  for (let i = 0; i < 8; i++) {
    history.push(entry("edit", {
      filePath: "E:\\Glitch AI\\glitch-pi\\scripts\\install.ps1",
      oldText: `old ${i}`,
      newText: `new ${i}`,
    }));
  }
  const result = detectStuck(history);
  assert.strictEqual(result, null, `Expected null, got: ${JSON.stringify(result)}`);
});

test("6 task() calls with DIFFERENT prompts \u2192 no tool_repetition (task excluded)", () => {
  const history = [];
  for (let i = 0; i < 6; i++) {
    history.push(entry("task", {
      subagent_type: "@coder",
      prompt: `Implement feature ${i} with completely different requirements and scope`,
    }));
  }
  const result = detectStuck(history);
  assert.strictEqual(result, null, `Expected null, got: ${JSON.stringify(result)}`);
});

test("5 sequential different bash git commands \u2192 no tool_repetition, no command_repetition", () => {
  const history = padHistory([
    entry("bash", { command: "git add scripts/install.ps1" }),
    entry("bash", { command: "git status" }),
    entry("bash", { command: "git commit -m 'fix: something'" }),
    entry("bash", { command: "git push origin develop" }),
    entry("bash", { command: "git log --oneline -5" }),
  ]);
  const result = detectStuck(history);
  assert.strictEqual(result, null, `Expected null, got: ${JSON.stringify(result)}`);
});

test("6 different grep calls with different patterns \u2192 no readonly_repetition", () => {
  const history = [];
  const patterns = ["function foo", "function bar", "const baz", "import.*react", "export default", "class Handler"];
  for (const p of patterns) {
    history.push(entry("grep", { pattern: p, include: "*.ts" }));
  }
  const result = detectStuck(history);
  assert.strictEqual(result, null, `Expected null, got: ${JSON.stringify(result)}`);
});

test("3 different webfetch calls with different URLs \u2192 no tool_repetition", () => {
  const history = padHistory([
    entry("webfetch", { url: "https://example.com/api/users/list" }),
    entry("webfetch", { url: "https://github.com/Cothek/glitch-ai/issues" }),
    entry("webfetch", { url: "https://docs.google.com/spreadsheets/d/abc123" }),
  ]);
  const result = detectStuck(history);
  assert.strictEqual(result, null, `Expected null, got: ${JSON.stringify(result)}`);
});

// ============================================================
console.log("\nPOLLING-TOOL false-positive tests (v2 refinement, the 56 browser_page firings):");
// ============================================================

test("3 identical browser_page polls \u2192 null (polling tool, threshold 6)", () => {
  const history = padHistory([
    entry("browser_page", { op: "read", what: "text", selector: "#status" }),
    entry("browser_page", { op: "read", what: "text", selector: "#status" }),
    entry("browser_page", { op: "read", what: "text", selector: "#status" }),
  ]);
  const result = detectStuck(history);
  assert.strictEqual(result, null, `Expected null, got: ${JSON.stringify(result)}`);
});

test("5 identical browser_page polls \u2192 null (below polling threshold 6)", () => {
  const history = [
    entry("browser_page", { op: "read", what: "text", selector: "#status" }),
    entry("browser_page", { op: "read", what: "text", selector: "#status" }),
    entry("browser_page", { op: "read", what: "text", selector: "#status" }),
    entry("browser_page", { op: "read", what: "text", selector: "#status" }),
    entry("browser_page", { op: "read", what: "text", selector: "#status" }),
  ];
  const result = detectStuck(history);
  assert.strictEqual(result, null, `Expected null, got: ${JSON.stringify(result)}`);
});

test("6 identical browser_page polls, most recent identical \u2192 tool_repetition (genuine tight loop)", () => {
  const history = [];
  for (let i = 0; i < 6; i++) {
    history.push(entry("browser_page", { op: "read", what: "text", selector: "#status" }));
  }
  const result = detectStuck(history);
  assert.notStrictEqual(result, null, "Expected a signal for 6 identical polls, got null");
  assert.strictEqual(result.type, "tool_repetition");
  assert.strictEqual(result.tool, "browser_page");
  assert.strictEqual(result.similarCalls, 6);
});

test("3 identical todo_list status checks \u2192 null (the 01a0d591 firing class)", () => {
  const history = padHistory([
    entry("todo_list", { action: "list" }),
    entry("todo_list", { action: "list" }),
    entry("todo_list", { action: "list" }),
  ]);
  const result = detectStuck(history);
  assert.strictEqual(result, null, `Expected null, got: ${JSON.stringify(result)}`);
});

test("4 identical subagent_get_result polls (same runId) \u2192 null (by-design wait loop)", () => {
  const history = padHistory([
    entry("subagent_get_result", { runId: "c3" }),
    entry("subagent_get_result", { runId: "c3" }),
    entry("subagent_get_result", { runId: "c3" }),
    entry("subagent_get_result", { runId: "c3" }),
  ]);
  const result = detectStuck(history);
  assert.strictEqual(result, null, `Expected null, got: ${JSON.stringify(result)}`);
});

test("8 distinct-URL webfetch sweep (RDAP pattern) \u2192 null", () => {
  const domains = [
    "scoutforge.com", "playforge.com", "swarmline.com", "verdictforge.com",
    "opsforge.com", "scoutworks.com", "playworks.com", "opsworks.com",
  ];
  const history = domains.map(d =>
    entry("webfetch", { url: `https://rdap.verisign.com/com/v1/domain/${d}` })
  );
  const result = detectStuck(history);
  assert.strictEqual(result, null, `Expected null for distinct-URL sweep, got: ${JSON.stringify(result)}`);
});

// ============================================================
console.log("\nONGOING-REPETITION tests (v2: moved-on patterns must NOT fire):");
// ============================================================

test("3 identical webfetch then a DIFFERENT webfetch last \u2192 null (agent moved on)", () => {
  const history = padHistory([
    entry("webfetch", { url: "https://example.com/api/data" }),
    entry("webfetch", { url: "https://example.com/api/data" }),
    entry("webfetch", { url: "https://example.com/api/data" }),
    entry("webfetch", { url: "https://example.com/api/other" }),
  ]);
  const result = detectStuck(history);
  assert.strictEqual(result, null, `Expected null (repetition not ongoing), got: ${JSON.stringify(result)}`);
});

test("same tool 3x where only 2 are similar and the LAST differs \u2192 null (cluster rule)", () => {
  const history = padHistory([
    entry("recall", { query: "Troy UI design preferences" }),
    entry("recall", { query: "Troy UI design preferences" }),
    entry("recall", { query: "completely different memory search about ports" }),
  ]);
  const result = detectStuck(history);
  assert.strictEqual(result, null, `Expected null (cluster of 2 < threshold 3), got: ${JSON.stringify(result)}`);
});

test("5 identical webfetch + 3 distinct, cluster at TAIL \u2192 tool_repetition (still repeating)", () => {
  const history = [
    entry("webfetch", { url: "https://rdap.verisign.com/com/v1/domain/scoutforge.com" }),
    entry("webfetch", { url: "https://rdap.verisign.com/com/v1/domain/playforge.com" }),
    entry("webfetch", { url: "https://rdap.verisign.com/com/v1/domain/opsforge.com" }),
    entry("webfetch", { url: "https://example.com/api/data" }),
    entry("webfetch", { url: "https://example.com/api/data" }),
    entry("webfetch", { url: "https://example.com/api/data" }),
    entry("webfetch", { url: "https://example.com/api/data" }),
    entry("webfetch", { url: "https://example.com/api/data" }),
  ];
  const result = detectStuck(history);
  assert.notStrictEqual(result, null, "Expected a signal (5 identical ongoing at tail), got null");
  assert.strictEqual(result.type, "tool_repetition");
  assert.strictEqual(result.tool, "webfetch");
  assert.strictEqual(result.similarCalls, 5);
});

// ============================================================
console.log("\nERROR-CASCADE tests (v2: diverse probing allowed, retry loops caught):");
// ============================================================

test("3 consecutive DIVERSE errored calls \u2192 null (routine probing)", () => {
  const history = padHistory([
    entry("bash", { command: "npm install" }, true),
    entry("bash", { command: "npm test" }, true),
    entry("bash", { command: "npm run build" }, true),
  ]);
  const result = detectStuck(history);
  assert.strictEqual(result, null, `Expected null (3 diverse errors are probing), got: ${JSON.stringify(result)}`);
});

test("4 consecutive DIVERSE errored calls \u2192 error_cascade", () => {
  const history = [
    entry("bash", { command: "npm install" }, true),
    entry("bash", { command: "npm test" }, true),
    entry("powershell", { command: "Get-Process node" }, true),
    entry("bash", { command: "npm run build" }, true),
  ];
  const result = detectStuck(history);
  assert.notStrictEqual(result, null, "Expected a signal (4 consecutive errors), got null");
  assert.strictEqual(result.type, "error_cascade");
});

test("3 consecutive errors of the SAME identical call \u2192 error_cascade (retry loop)", () => {
  const history = padHistory([
    entry("bash", { command: "npm test" }, true),
    entry("bash", { command: "npm test" }, true),
    entry("bash", { command: "npm test" }, true),
  ]);
  const result = detectStuck(history);
  assert.notStrictEqual(result, null, "Expected a signal (same call failed 3x), got null");
  assert.strictEqual(result.type, "error_cascade");
});

// ============================================================
console.log("\nGENUINE detection tests (must fire):");
// ============================================================

test("6 consecutive reads of SAME file \u2192 readonly_repetition", () => {
  const history = [];
  for (let i = 0; i < 6; i++) {
    history.push(entry("read", { filePath: "E:\\Glitch AI\\glitch-pi\\data\\same-file.json" }));
  }
  const result = detectStuck(history);
  assert.notStrictEqual(result, null, "Expected a signal, got null");
  assert.strictEqual(result.type, "readonly_repetition");
  assert.strictEqual(result.tool, "read");
});

test("6 consecutive globs of SAME pattern \u2192 readonly_repetition", () => {
  const history = [];
  for (let i = 0; i < 6; i++) {
    history.push(entry("glob", { pattern: "**/*.ts" }));
  }
  const result = detectStuck(history);
  assert.notStrictEqual(result, null, "Expected a signal, got null");
  assert.strictEqual(result.type, "readonly_repetition");
  assert.strictEqual(result.tool, "glob");
});

test("5 identical webfetch with different format param \u2192 tool_repetition (format ignored)", () => {
  const history = padHistory([
    entry("webfetch", { url: "https://example.com/api/data", format: "markdown" }),
    entry("webfetch", { url: "https://example.com/api/data", format: "text" }),
    entry("webfetch", { url: "https://example.com/api/data", format: "html" }),
    entry("webfetch", { url: "https://example.com/api/data", format: "markdown" }),
    entry("webfetch", { url: "https://example.com/api/data", format: "text" }),
  ]);
  const result = detectStuck(history);
  assert.notStrictEqual(result, null, "Expected a signal (format ignored, same URL = similar), got null");
  assert.strictEqual(result.type, "tool_repetition");
  assert.strictEqual(result.tool, "webfetch");
});

test("5+ identical bash command, most recent is that command \u2192 command_repetition", () => {
  const history = padHistory([
    entry("bash", { command: "git status" }),
    entry("bash", { command: "git status" }),
    entry("bash", { command: "git status" }),
    entry("bash", { command: "git status" }),
    entry("bash", { command: "git status" }),
  ]);
  const result = detectStuck(history);
  assert.notStrictEqual(result, null, "Expected a signal, got null");
  assert.strictEqual(result.type, "command_repetition");
});

test("4 identical bash commands \u2192 no command_repetition (threshold 5)", () => {
  const history = padHistory([
    entry("bash", { command: "npm test" }),
    entry("bash", { command: "npm test" }),
    entry("bash", { command: "npm test" }),
    entry("bash", { command: "npm test" }),
  ]);
  const result = detectStuck(history);
  assert.strictEqual(result, null, `Expected null (4 repeats below threshold 5), got: ${JSON.stringify(result)}`);
});

test("5+ identical Get-Date clock commands \u2192 no command_repetition (clock excluded)", () => {
  const history = padHistory([
    entry("bash", { command: "Get-Date -Format \"yyyy-MM-ddTHH:mm:ssZ\"" }),
    entry("bash", { command: "Get-Date -Format \"yyyy-MM-ddTHH:mm:ssZ\"" }),
    entry("bash", { command: "Get-Date -Format \"yyyy-MM-ddTHH:mm:ssZ\"" }),
    entry("bash", { command: "Get-Date -Format \"yyyy-MM-ddTHH:mm:ssZ\"" }),
    entry("bash", { command: "Get-Date -Format \"yyyy-MM-ddTHH:mm:ssZ\"" }),
  ]);
  const result = detectStuck(history);
  assert.strictEqual(result, null, `Expected null (clock command excluded), got: ${JSON.stringify(result)}`);
});

test("5+ identical DateTimeOffset conversion commands \u2192 no command_repetition (clock excluded)", () => {
  const history = padHistory([
    entry("bash", { command: "$start = [DateTimeOffset]::FromUnixTimeMilliseconds(1787021476896); $start.ToString()" }),
    entry("bash", { command: "$start = [DateTimeOffset]::FromUnixTimeMilliseconds(1787021476896); $start.ToString()" }),
    entry("bash", { command: "$start = [DateTimeOffset]::FromUnixTimeMilliseconds(1787021476896); $start.ToString()" }),
    entry("bash", { command: "$start = [DateTimeOffset]::FromUnixTimeMilliseconds(1787021476896); $start.ToString()" }),
    entry("bash", { command: "$start = [DateTimeOffset]::FromUnixTimeMilliseconds(1787021476896); $start.ToString()" }),
  ]);
  const result = detectStuck(history);
  assert.strictEqual(result, null, `Expected null (clock conversion excluded), got: ${JSON.stringify(result)}`);
});

test("5+ identical non-clock bash mixed with clock \u2192 command_repetition fires", () => {
  const history = padHistory([
    entry("bash", { command: "Get-Date -Format \"HH:mm\"" }),
    entry("bash", { command: "npm test" }),
    entry("bash", { command: "npm test" }),
    entry("bash", { command: "npm test" }),
    entry("bash", { command: "npm test" }),
    entry("bash", { command: "npm test" }),
  ]);
  const result = detectStuck(history);
  assert.notStrictEqual(result, null, "Expected a signal (non-clock repeats ongoing), got null");
  assert.strictEqual(result.type, "command_repetition");
});

test("5 identical bash commands then a DIFFERENT bash last \u2192 null (moved on)", () => {
  const history = [
    entry("bash", { command: "npm test" }),
    entry("bash", { command: "npm test" }),
    entry("bash", { command: "npm test" }),
    entry("bash", { command: "npm test" }),
    entry("bash", { command: "npm test" }),
    entry("bash", { command: "git status" }),
  ];
  const result = detectStuck(history);
  assert.strictEqual(result, null, `Expected null (repetition not ongoing), got: ${JSON.stringify(result)}`);
});

test("2 consecutive denied task calls \u2192 permission_loop", () => {
  const history = padHistory([
    entry("task", { prompt: "do something" }, true),
    entry("task", { prompt: "do something else" }, true),
  ]);
  const result = detectStuck(history);
  assert.notStrictEqual(result, null, "Expected a signal, got null");
  assert.strictEqual(result.type, "permission_loop");
});

test("2 consecutive invalid tool calls \u2192 permission_loop", () => {
  const history = padHistory([
    entry("invalid", {}),
    entry("invalid", {}),
  ]);
  const result = detectStuck(history);
  assert.notStrictEqual(result, null, "Expected a signal, got null");
  assert.strictEqual(result.type, "permission_loop");
});

test("stale repetition cluster followed by failing bash tail \u2192 error_cascade, not tool_repetition", () => {
  const history = [
    entry("recall", { query: "same" }),
    entry("recall", { query: "same" }),
    entry("recall", { query: "same" }),
    entry("recall", { query: "same" }),
    entry("bash", { command: "cmd-a" }, true),
    entry("bash", { command: "cmd-b" }, true),
    entry("bash", { command: "cmd-c" }, true),
    entry("bash", { command: "cmd-d" }, true),
  ];
  const result = detectStuck(history);
  assert.notStrictEqual(result, null, "Expected error_cascade at the tail, got null");
  assert.strictEqual(result.type, "error_cascade", `Expected error_cascade, got: ${result.type}`);
});

// ============================================================
console.log("\nUNKNOWN-ARGS fail-safe tests (v2: argsKnown=false never triggers similarity rules):");
// ============================================================

test("6 consecutive reads with UNKNOWN args \u2192 null (identity unprovable)", () => {
  const history = [];
  for (let i = 0; i < 6; i++) {
    history.push(entry("read", { filePath: `E:\\x\\f${i}.json` }, false, false));
  }
  const result = detectStuck(history);
  assert.strictEqual(result, null, `Expected null (unknown args), got: ${JSON.stringify(result)}`);
});

test("4 same-tool calls with UNKNOWN args \u2192 null (similarity unprovable)", () => {
  const history = [];
  for (let i = 0; i < 4; i++) {
    history.push(entry("recall", { query: "same query" }, false, false));
  }
  const result = detectStuck(history);
  assert.strictEqual(result, null, `Expected null (unknown args), got: ${JSON.stringify(result)}`);
});

test("5 identical bash commands with UNKNOWN args \u2192 null (command identity unprovable)", () => {
  const history = [];
  for (let i = 0; i < 5; i++) {
    history.push(entry("bash", { command: "npm test" }, false, false));
  }
  const result = detectStuck(history);
  assert.strictEqual(result, null, `Expected null (unknown args), got: ${JSON.stringify(result)}`);
});

test("4 consecutive errors with UNKNOWN args \u2192 error_cascade still fires (isError is reliable)", () => {
  const history = [
    entry("bash", { command: "a" }, true, false),
    entry("bash", { command: "b" }, true, false),
    entry("bash", { command: "c" }, true, false),
    entry("bash", { command: "d" }, true, false),
  ];
  const result = detectStuck(history);
  assert.notStrictEqual(result, null, "Expected error_cascade (4 errors, args irrelevant), got null");
  assert.strictEqual(result.type, "error_cascade");
});

// ============================================================
console.log("\nEDGE CASE tests:");
// ============================================================

test("history shorter than 4 \u2192 null", () => {
  const history = [
    entry("read", { filePath: "a.json" }),
    entry("read", { filePath: "a.json" }),
    entry("read", { filePath: "a.json" }),
  ];
  const result = detectStuck(history);
  assert.strictEqual(result, null, `Expected null for short history, got: ${JSON.stringify(result)}`);
});

test("empty history \u2192 null", () => {
  const result = detectStuck([]);
  assert.strictEqual(result, null, `Expected null for empty history, got: ${JSON.stringify(result)}`);
});

test("exactly 4 entries, no pattern \u2192 null", () => {
  const history = [
    entry("read", { filePath: "a.json" }),
    entry("write", { filePath: "b.json" }),
    entry("bash", { command: "ls" }),
    entry("edit", { filePath: "c.json" }),
  ];
  const result = detectStuck(history);
  assert.strictEqual(result, null, `Expected null, got: ${JSON.stringify(result)}`);
});

test("skill calls are never stuck (excluded from tool_repetition)", () => {
  const history = padHistory([
    entry("skill", { name: "debugging" }),
    entry("skill", { name: "debugging" }),
    entry("skill", { name: "debugging" }),
  ]);
  const result = detectStuck(history);
  assert.strictEqual(result, null, `Expected null, got: ${JSON.stringify(result)}`);
});

test("question calls are never stuck (excluded from tool_repetition)", () => {
  const history = padHistory([
    entry("question", { questions: [{ question: "q1" }] }),
    entry("question", { questions: [{ question: "q1" }] }),
    entry("question", { questions: [{ question: "q1" }] }),
  ]);
  const result = detectStuck(history);
  assert.strictEqual(result, null, `Expected null, got: ${JSON.stringify(result)}`);
});

test("todowrite calls are never stuck (excluded from tool_repetition)", () => {
  const history = padHistory([
    entry("todowrite", { todos: [] }),
    entry("todowrite", { todos: [] }),
    entry("todowrite", { todos: [] }),
  ]);
  const result = detectStuck(history);
  assert.strictEqual(result, null, `Expected null, got: ${JSON.stringify(result)}`);
});

// ============================================================
console.log("\nBOUNDARY tests:");
// ============================================================

test("exactly 2 identical bash commands \u2192 no command_repetition (gate: >= 5)", () => {
  const history = padHistory([
    entry("bash", { command: "npm test" }),
    entry("bash", { command: "npm test" }),
  ]);
  const result = detectStuck(history);
  assert.strictEqual(result, null, `Expected null (2 identical bash calls below gate), got: ${JSON.stringify(result)}`);
});

test("exactly 5 identical webfetch calls \u2192 tool_repetition fires (threshold 5)", () => {
  const history = [
    entry("read", { filePath: "E:\\src\\a.ts" }),
    entry("read", { filePath: "E:\\src\\b.ts" }),
    entry("read", { filePath: "E:\\src\\c.ts" }),
    entry("webfetch", { url: "https://example.com/api/data" }),
    entry("webfetch", { url: "https://example.com/api/data" }),
    entry("webfetch", { url: "https://example.com/api/data" }),
    entry("webfetch", { url: "https://example.com/api/data" }),
    entry("webfetch", { url: "https://example.com/api/data" }),
  ];
  const result = detectStuck(history);
  assert.notStrictEqual(result, null, "Expected a signal, got null");
  assert.strictEqual(result.type, "tool_repetition");
  assert.strictEqual(result.tool, "webfetch");
});

test("exactly 4 identical webfetch calls \u2192 no tool_repetition (count < 5)", () => {
  const history = [
    entry("read", { filePath: "E:\\src\\a.ts" }),
    entry("read", { filePath: "E:\\src\\b.ts" }),
    entry("read", { filePath: "E:\\src\\c.ts" }),
    entry("read", { filePath: "E:\\src\\d.ts" }),
    entry("webfetch", { url: "https://example.com/api/data" }),
    entry("webfetch", { url: "https://example.com/api/data" }),
    entry("webfetch", { url: "https://example.com/api/data" }),
    entry("webfetch", { url: "https://example.com/api/data" }),
  ];
  const result = detectStuck(history);
  assert.strictEqual(result, null, `Expected null (4 webfetch below threshold), got: ${JSON.stringify(result)}`);
});

test("6 reads of SAME file with varying offset/limit \u2192 readonly_repetition fires", () => {
  const history = [];
  for (let i = 0; i < 6; i++) {
    history.push(entry("read", {
      filePath: "E:\\Glitch AI\\glitch-pi\\scripts\\install.ps1",
      offset: i * 100,
      limit: 100,
    }));
  }
  const result = detectStuck(history);
  assert.notStrictEqual(result, null, "Expected a signal, got null");
  assert.strictEqual(result.type, "readonly_repetition");
  assert.strictEqual(result.tool, "read");
});

test("5 reads of different files + 1 write + 1 read \u2192 no readonly_repetition", () => {
  const history = [
    entry("read", { filePath: "E:\\src\\a.ts" }),
    entry("read", { filePath: "E:\\src\\b.ts" }),
    entry("read", { filePath: "E:\\src\\c.ts" }),
    entry("read", { filePath: "E:\\src\\d.ts" }),
    entry("read", { filePath: "E:\\src\\e.ts" }),
    entry("write", { filePath: "E:\\src\\f.ts", content: "x" }),
    entry("read", { filePath: "E:\\src\\g.ts" }),
  ];
  const result = detectStuck(history);
  assert.strictEqual(result, null, `Expected null (write breaks readonly run), got: ${JSON.stringify(result)}`);
});

// ============================================================
console.log("\nHELPER tests (isGenuineProgress / isClockCommand):");
// ============================================================

test("isGenuineProgress: successful bash git commit \u2192 true (was dead in v1)", () => {
  assert.strictEqual(isGenuineProgress("bash", { command: "cd x && git commit -m 'wip'" }, false), true);
});

test("isGenuineProgress: failed bash git commit \u2192 false", () => {
  assert.strictEqual(isGenuineProgress("bash", { command: "git commit -m 'wip'" }, true), false);
});

test("isGenuineProgress: plain bash \u2192 false, write \u2192 true, read \u2192 false", () => {
  assert.strictEqual(isGenuineProgress("bash", { command: "ls" }, false), false);
  assert.strictEqual(isGenuineProgress("write", { path: "x" }, false), true);
  assert.strictEqual(isGenuineProgress("read", { path: "x" }, false), false);
});

test("isClockCommand: Get-Date and DateTimeOffset \u2192 true; npm test \u2192 false", () => {
  assert.strictEqual(isClockCommand("Get-Date -Format o"), true);
  assert.strictEqual(isClockCommand("$x=[DateTimeOffset]::Now"), true);
  assert.strictEqual(isClockCommand("npm test"), false);
});

// ============================================================
// Summary
// ============================================================

console.log(`\n${"=".repeat(50)}`);
console.log(`Results: ${passed} passed, ${failed} failed, ${passed + failed} total`);
console.log(`${"=".repeat(50)}\n`);

process.exit(failed > 0 ? 1 : 0);
