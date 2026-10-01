/**
 * test-rename-guard.mjs — functional test of the R17 rename guard v4 + enforcer
 * in .pi/extensions/routing.ts, loaded through the same jiti pipeline pi uses.
 *
 * Run directly (node --test is broken in this repo):
 *   node scripts/test/test-rename-guard.mjs
 *
 * No live pi session needed: the extension factory is driven with a mock
 * ExtensionAPI and mock ctx objects; transcript state is a temp JSONL file.
 */
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createJiti } from "../../data/node/node_modules/@earendil-works/pi-coding-agent/node_modules/jiti/lib/jiti.mjs";

const jiti = createJiti(import.meta.url);
const mod = await jiti.import(
  pathToFileURL(fileURLToPath(new URL("../../.pi/extensions/routing.ts", import.meta.url))).href,
);

let passed = 0;
let failed = 0;
function check(name, cond, extra = "") {
  if (cond) {
    passed++;
    console.log(`  PASS ${name}`);
  } else {
    failed++;
    console.log(`  FAIL ${name}${extra ? " — " + extra : ""}`);
  }
}

function makeHarness() {
  const handlers = {};
  const calls = { appendEntry: [], sendMessage: [] };
  const pi = {
    on: (ev, fn) => (handlers[ev] = fn),
    appendEntry: (t, d) => calls.appendEntry.push({ t, d }),
    sendMessage: (m, o) => calls.sendMessage.push({ m, o }),
  };
  mod.default(pi);
  return { handlers, calls };
}

const dir = mkdtempSync(join(tmpdir(), "rename-guard-"));
function makeCtx(file, { name, branch = [] } = {}) {
  return {
    sessionManager: {
      getSessionFile: () => file,
      getSessionName: () => name,
      getBranch: () => branch,
    },
  };
}
function assistantMessage(text) {
  return { role: "assistant", stopReason: "stop", content: [{ type: "text", text }] };
}
function textOf(result) {
  const c = result?.message?.content;
  return Array.isArray(c) ? c.map((p) => p.text).join(" ") : c;
}

// --- Guard v4 ---
console.log("guard v4:");

{
  // 1. Unnamed session: a good marker passes.
  const { handlers } = makeHarness();
  const f = join(dir, "unnamed.jsonl");
  writeFileSync(f, JSON.stringify({ type: "session", id: "x" }) + "\n");
  const r = await handlers["message_end"]({ message: assistantMessage("Here you go. [[conv:rename:Fix login bug]]") }, makeCtx(f));
  check("good marker kept while unnamed", textOf(r).includes("[[conv:rename:Fix login bug]]"), JSON.stringify(textOf(r)));
}

{
  // 2. Junk markers are stripped even while unnamed.
  const { handlers } = makeHarness();
  const f = join(dir, "junk.jsonl");
  writeFileSync(f, "");
  const cases = [
    "[[conv:rename:<title>]]",
    "[[conv:rename:<3-6 word title>]]",
    "[[conv:rename:...]]",
    "[[conv:rename:]]",
    "[[conv:rename:new title]]",
  ];
  for (const junk of cases) {
    const r = await handlers["message_end"]({ message: assistantMessage("note " + junk) }, makeCtx(f));
    check(`junk stripped: ${junk}`, !textOf(r).includes("conv:rename"), JSON.stringify(textOf(r)));
  }
}

{
  // 3. Named session (session_info in the transcript file): every marker is stripped.
  const { handlers } = makeHarness();
  const f = join(dir, "named-file.jsonl");
  writeFileSync(f, JSON.stringify({ type: "session_info", name: "Existing Title" }) + "\n");
  const r = await handlers["message_end"]({ message: assistantMessage("[[conv:rename:Something Else]]") }, makeCtx(f));
  check("marker stripped once named (file scan)", !textOf(r).includes("conv:rename"), JSON.stringify(textOf(r)));
}

{
  // 4. Named session (pi-side name only): marker stripped too.
  const { handlers } = makeHarness();
  const f = join(dir, "named-mem.jsonl");
  writeFileSync(f, "");
  const r = await handlers["message_end"]({ message: assistantMessage("[[conv:rename:Something Else]]") }, makeCtx(f, { name: "Existing" }));
  check("marker stripped once named (getSessionName)", !textOf(r).includes("conv:rename"), JSON.stringify(textOf(r)));
}

{
  // 5. Unnamed session: two good markers → only the first is kept.
  const { handlers } = makeHarness();
  const f = join(dir, "dup.jsonl");
  writeFileSync(f, "");
  const r = await handlers["message_end"](
    { message: assistantMessage("[[conv:rename:First Title]] then [[conv:rename:Second Title]]") },
    makeCtx(f),
  );
  const t = textOf(r);
  check("first good marker kept", t.includes("[[conv:rename:First Title]]"), t);
  check("second good marker dropped", !t.includes("Second Title"), t);
}

{
  // 6. Unnamed session: junk first, good second → good one kept.
  const { handlers } = makeHarness();
  const f = join(dir, "junk-then-good.jsonl");
  writeFileSync(f, "");
  const r = await handlers["message_end"](
    { message: assistantMessage("[[conv:rename:<title>]] [[conv:rename:Real Title]]") },
    makeCtx(f),
  );
  const t = textOf(r);
  check("good marker survives junk in same message", t.includes("[[conv:rename:Real Title]]") && !t.includes("<title>"), t);
}

// --- Enforcer ---
console.log("enforcer:");
process.env.PI_WEB_PORT = "8787";
delete process.env.GLITCH_SUBAGENT;

{
  // 7. Unnamed session settles → one nudge (appendEntry + sendMessage with triggerTurn).
  const { handlers, calls } = makeHarness();
  const f = join(dir, "nudge.jsonl");
  writeFileSync(f, "");
  await handlers["agent_settled"]({}, makeCtx(f));
  await new Promise((res) => setTimeout(res, 120));
  check("nudge entry appended", calls.appendEntry.length === 1);
  check("nudge message sent", calls.sendMessage.length === 1);
  check("nudge triggers a turn", calls.sendMessage[0]?.o?.triggerTurn === true, JSON.stringify(calls.sendMessage[0]?.o));
  check("nudge is invisible (display:false)", calls.sendMessage[0]?.m?.display === false);
}

{
  // 8. Named session settles → no nudge.
  const { handlers, calls } = makeHarness();
  const f = join(dir, "nudge-named.jsonl");
  writeFileSync(f, JSON.stringify({ type: "session_info", name: "Named" }) + "\n");
  await handlers["agent_settled"]({}, makeCtx(f));
  await new Promise((res) => setTimeout(res, 120));
  check("no nudge when named", calls.sendMessage.length === 0 && calls.appendEntry.length === 0);
}

{
  // 9. Subagent session → no nudge.
  const { handlers, calls } = makeHarness();
  process.env.GLITCH_SUBAGENT = "1";
  const f = join(dir, "nudge-sub.jsonl");
  writeFileSync(f, "");
  await handlers["agent_settled"]({}, makeCtx(f));
  delete process.env.GLITCH_SUBAGENT;
  check("no nudge for subagents", calls.sendMessage.length === 0 && calls.appendEntry.length === 0);
}

{
  // 10. Attempt cap: a transcript that already holds 2 nudge entries → no more.
  const { handlers, calls } = makeHarness();
  const f = join(dir, "nudge-capped.jsonl");
  writeFileSync(f, "");
  const branch = [
    { type: "custom", customType: "glitch-rename-nudge" },
    { type: "custom", customType: "glitch-rename-nudge" },
  ];
  await handlers["agent_settled"]({}, makeCtx(f, { branch }));
  await new Promise((res) => setTimeout(res, 120));
  check("attempt cap stops the nudging", calls.sendMessage.length === 0 && calls.appendEntry.length === 0);
}

{
  // 11. Aborted run → no nudge.
  const { handlers, calls } = makeHarness();
  const f = join(dir, "nudge-aborted.jsonl");
  writeFileSync(f, "");
  await handlers["message_end"]({ message: { role: "assistant", stopReason: "aborted", content: [{ type: "text", text: "partial" }] } }, makeCtx(f));
  await handlers["agent_settled"]({}, makeCtx(f));
  await new Promise((res) => setTimeout(res, 120));
  check("no nudge after aborted run", calls.sendMessage.length === 0);
}

{
  // 12. File-less session (pi-web-ui in-process subagent) → no nudge.
  const { handlers, calls } = makeHarness();
  await handlers["agent_settled"]({}, { sessionManager: { getSessionFile: () => undefined, getSessionName: () => undefined, getBranch: () => [] } });
  await new Promise((res) => setTimeout(res, 120));
  check("no nudge for file-less (subagent) sessions", calls.sendMessage.length === 0 && calls.appendEntry.length === 0);
}

delete process.env.PI_WEB_PORT;
rmSync(dir, { recursive: true, force: true });

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
