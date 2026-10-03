/**
 * routing.ts — Pi extension: plan-first + dispatch-first routing
 * Ported from glitch-ai .opencode/plugins/{plan-reflex,dispatch-reflex}.js → Pi ExtensionAPI.
 *
 * PURPOSE (Plan 2 §5.1)
 *   Route simple tasks direct; force plan-before-code and dispatch-before-edit
 *   the way Glitch does today. Detection logic ports nearly line-for-line;
 *   only the hook plumbing changes.
 *
 * EVENT MAPPING
 *   OpenCode tool.execute.before     → Pi tool_call (return { block, reason })
 *   OpenCode tool.execute.after      → Pi tool_execution_end
 *
 * TOOL INPUT MAPPING (Pi vs OpenCode)
 *   edit/write path:  event.input.path   (OpenCode: filePath / path)
 *   bash command:     event.input.command
 *   task (forward):   event.input.subagent_type / agent + prompt/task
 *
 * BLOCKED BEHAVIORS (throws → tool_call returns { block: true, reason })
 *   1. Plan-First: complex task dispatch or code-file edit without a fresh
 *      SESSION-SCOPED plan (< 6h) at
 *      data/plans/sessions/<sessionID>/current-plan.md.
 *      Bypass: "quick task" / --no-plan. Ownership: a session may only
 *      mutate its own plan file and the shared data/plans/archive —
 *      cross-session plan writes/moves/deletes are blocked (plan-paths.mjs).
 *   2. Dispatch-First: code-file edit or destructive bash without a prior
 *      task() dispatch within 120s. glitch-omni warns instead of blocks.
 *   3. Review Gate: git commit when pendingReview && lastCode > lastReview.
 *      Bypass: --no-verify.
 *
 * GATE MODES (2026-09-23 fixes)
 *   - REPO_ROOT walks up from cwd to the nearest .git/.pi (sessions started
 *     in subdirectories like data/node resolved plan/marker paths wrong).
 *   - Dispatcher-spawned sub-agents (GLITCH_SUBAGENT=1) skip the primary's
 *     gates — matches the OpenCode design where sub-agents ran plugin-free.
 *   - Primary glitch-omni mode (user/agent-mode.json "mode": "glitch-omni")
 *     gets warn-only dispatch gates, same as the omni sub-agent. The mode
 *     file is re-read on every gated call, so mid-session switches via the
 *     /agent extension (agent-switcher.ts) apply immediately.
 *
 * REVIEW PASS MARKER
 *   On reviewer task result with PASS verdict → run scripts/write-review-pass.mjs
 *   (same canonical writer as OpenCode; keeps marker format in one place).
 *
 * STATE (in-memory, session-scoped — mirrors OpenCode plugin)
 *   lastTaskTime: Map<agentName, ts>
 *   pendingReview, lastCodeTaskTime, lastReviewTaskTime
 */

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { dirname, extname, join, resolve } from "node:path";
import type { ExtensionAPI, ToolCallEvent, ToolCallEventResult } from "@earendil-works/pi-coding-agent";
// Session-scoped plan ownership rules — dependency-free lib, unit-tested in
// .pi/lib/plan-paths.test.mjs (dispatch-plan.mjs pattern).
import {
  classifyPlanCommand,
  classifyPlanPath,
  hasPlanMutation,
  isPlanPath,
  sessionPlanPath,
} from "../lib/plan-paths.mjs";

// --- Paths (resolve repo root by walking up from cwd to the nearest .git/.pi) ---
function resolveRepoRoot(startDir: string): string {
  let dir = startDir;
  while (true) {
    if (existsSync(join(dir, ".git")) || existsSync(join(dir, ".pi"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return startDir;
    dir = parent;
  }
}
// SEEDING CONTRACT (2026-10-03 incident):
// This root MUST resolve exactly like agent-switcher.ts's root, or the gate reads
// a different user/agent-mode.json than the prompt was built from.
// agent-switcher.ts seeds from ctx.cwd. Seeding from process.cwd() instead made
// the pi server resolve E:/Glitch AI/glitch-pi (it owns .git AND .pi) while the
// session resolved E:/Glitch AI (owns .pi only) — two roots, two markers, and the
// gate read a 5-day-stale "glitch-omni". Consequences: the primary in glitch mode
// was HARD BLOCKED from dispatching (no-dispatch gate) yet only WARNED when
// editing code, and non-destructive bash went ungated entirely.
// process.cwd() is kept only as the pre-session fallback; session_start re-seeds
// from ctx.cwd before any gated call can happen.
let REPO_ROOT = resolveRepoRoot(process.cwd());
let REVIEW_PASS_SCRIPT = join(REPO_ROOT, "scripts", "write-review-pass.mjs");
let MARKER_PATH = join(REPO_ROOT, "data", ".review-pass.json");
// Plan files are SESSION-SCOPED: data/plans/sessions/<sessionID>/current-plan.md
// (built by planMarkerPath() below, canonical form in ../lib/plan-paths.mjs).
// The old shared data/plans/current-plan.md let concurrent sessions overwrite
// and archive each other's live plans — incident logged in user/current-session.md.
let AGENT_MODE_PATH = join(REPO_ROOT, "user", "agent-mode.json");

/** Re-seed the root and every path derived from it. Called once on session_start
 *  with the session cwd, so the root and its four dependants stay consistent. */
function setRepoRoot(root: string): void {
  REPO_ROOT = root;
  REVIEW_PASS_SCRIPT = join(REPO_ROOT, "scripts", "write-review-pass.mjs");
  MARKER_PATH = join(REPO_ROOT, "data", ".review-pass.json");
  AGENT_MODE_PATH = join(REPO_ROOT, "user", "agent-mode.json");
}

const PLAN_MAX_AGE_MS = 6 * 60 * 60 * 1000; // 6h
const DISPATCH_WINDOW_MS = 120_000; // 120s
const QUALITY_PASS_MAX_AGE_MS = 30 * 60 * 1000; // 30 min — review marker freshness for direct-exec commits

// --- Primary agent mode (user/agent-mode.json, re-read per call so mid-session
// switches via the /agent extension take effect immediately) ---
function readAgentMode(): string {
  try {
    if (!existsSync(AGENT_MODE_PATH)) return "glitch";
    let text = readFileSync(AGENT_MODE_PATH, "utf-8");
    // PowerShell Set-Content writes a UTF-8 BOM — strip it before parsing.
    if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
    const raw = JSON.parse(text);
    if (typeof raw?.mode === "string" && raw.mode) return raw.mode;
  } catch { /* ignore */ }
  return "glitch";
}
function isOmniPrimaryMode(): boolean {
  return readAgentMode() === "glitch-omni";
}

// Direct-execution primary modes (omni, lightweight) must NEVER dispatch
// sub-agents — they do everything themselves by design. Enforced as a hard
// block (not a system-prompt request) because the model ignores the prose.
function isDirectExecPrimaryMode(): boolean {
  const mode = readAgentMode();
  return mode === "glitch-omni" || mode === "glitch-lightweight";
}

// --- Quality gate helpers (direct-exec commit gate, docs/engineering-standards.md §4) ---
// Dispatch-based Review Gate can't fire in omni/lightweight modes (sub-agent
// dispatch is hard-blocked there), so staged code requires a fresh self-review
// marker instead: `node scripts/write-review-pass.mjs --agent self-review`.
function getStagedCodeFiles(): string[] {
  try {
    const out = execFileSync("git", ["diff", "--cached", "--name-only"], {
      cwd: REPO_ROOT,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    return out
      .split("\n")
      .map((l) => l.trim())
      .filter(
        (f) =>
          f.length > 0 &&
          CODE_EXTENSIONS.has(extname(f).toLowerCase()) &&
          !MEMORY_PATHS.some((p) => f.startsWith(p)),
      );
  } catch {
    return []; // not a git repo / git failure → don't block on a broken probe
  }
}
function hasFreshPassMarker(): boolean {
  try {
    if (!existsSync(MARKER_PATH)) return false;
    const raw = JSON.parse(readFileSync(MARKER_PATH, "utf-8"));
    return (
      raw?.verdict === "PASS" &&
      Date.now() - Number(raw?.epoch_ms ?? 0) < QUALITY_PASS_MAX_AGE_MS
    );
  } catch {
    return false;
  }
}

// --- Detection sets (verbatim from OpenCode plugins) ---

const COMPLEXITY_KEYWORDS = [
  "feature", "build", "migration", "refactor", "integrate",
  "architecture", "auth", "database", "api route", "multi-file",
  "5+ files", "multiple files", "complex", "design system",
  "security", "end-to-end", "full-stack",
];

const CODE_EXTENSIONS = new Set([
  ".ts", ".tsx", ".js", ".jsx", ".py", ".go", ".rs", ".rb", ".java",
  ".kt", ".swift", ".css", ".scss", ".sass", ".less", ".html", ".vue",
  ".svelte", ".astro", ".mjs", ".cjs", ".mts", ".cts",
  ".bat", ".ps1", ".sh",
]);

const MEMORY_PATHS = ["user/", "glitch-memorycore/"];

const CONFIG_FILES = new Set([
  "opencode.json",
  "config/opencode-normal.json",
  "config/opencode-free.json",
  "config/opencode-local.json",
  "config/opencode-safe.json",
]);

const GIT_OPERATIONS = new Set([
  "git add", "git commit", "git push", "git pull", "git fetch",
  "git merge", "git rebase", "git checkout", "git switch",
  "git stash", "git reset", "git restore",
]);

const READ_ONLY_BASH_COMMANDS = new Set([
  "git status", "git diff", "git log", "git show", "git branch",
  "git remote", "git config", "ls", "dir", "cat", "type", "grep",
  "rg", "find", "echo", "pwd", "whoami", "date", "time",
]);

const DESTRUCTIVE_BASH_COMMANDS = new Set([
  "rm", "del", "remove-item", "rmdir", "rd", "deltree",
]);

const CODE_WRITING_AGENTS = new Set([
  "coder", "coder-paid", "ui-designer", "ui-designer-paid",
  "testing", "testing-paid", "pentester", "pentester-paid",
]);

const REVIEW_AGENTS = new Set(["reviewer", "reviewer-paid"]);

// --- Pure helpers ---

function isCodeFile(filePath: string): boolean {
  const dotIndex = filePath.lastIndexOf(".");
  if (dotIndex === -1) return false;
  return CODE_EXTENSIONS.has(filePath.substring(dotIndex).toLowerCase());
}

function isMemoryFile(filePath: string): boolean {
  const normalized = filePath.replace(/\\/g, "/");
  return MEMORY_PATHS.some((p) => normalized.startsWith(p)) && normalized.endsWith(".md");
}

function isConfigFile(filePath: string): boolean {
  const normalized = filePath.replace(/\\/g, "/");
  return CONFIG_FILES.has(normalized) || (normalized.startsWith("config/") && normalized.endsWith(".json"));
}

function isExemptFile(filePath: string): boolean {
  return isMemoryFile(filePath) || isConfigFile(filePath);
}

function isGitOperation(command: string): boolean {
  const normalized = command.trim().toLowerCase();
  return [...GIT_OPERATIONS].some((cmd) => normalized.startsWith(cmd));
}

function isReadOnlyBashCommand(command: string): boolean {
  const normalized = command.trim().toLowerCase();
  return [...READ_ONLY_BASH_COMMANDS].some((cmd) => normalized.startsWith(cmd));
}

function isDestructiveBashCommand(command: string): boolean {
  const segments = command.split(/&&|\|\||;|\||\n/);
  const STRIP_EXTS = /\.(exe|com|bat|cmd|ps1)$/i;
  for (const rawSeg of segments) {
    const seg = rawSeg.trim();
    if (!seg) continue;
    const tokens = seg.split(/\s+/);
    const stripQuotes = (s: string): string =>
      s.length >= 2 &&
      ((s.startsWith('"') && s.endsWith('"')) ||
        (s.startsWith("'") && s.endsWith("'")) ||
        (s.startsWith("`") && s.endsWith("`")))
        ? s.slice(1, -1)
        : s;
    const basename = (s: string): string => {
      const i = Math.max(s.lastIndexOf("/"), s.lastIndexOf("\\"));
      return i >= 0 ? s.slice(i + 1) : s;
    };
    const name0 = stripQuotes(tokens[0])
      .replace(STRIP_EXTS, "")
      .toLowerCase();
    let cmdName = basename(name0);
    if ((cmdName === "cmd" || cmdName === "cmd.exe") && tokens.length >= 3) {
      const flag = tokens[1].toLowerCase();
      if (flag === "/c" || flag === "/k") {
        cmdName = basename(
          stripQuotes(tokens[2]).replace(STRIP_EXTS, "").toLowerCase(),
        );
      }
    }
    if (DESTRUCTIVE_BASH_COMMANDS.has(cmdName)) return true;
  }
  return false;
}

function shouldBlockDestructiveBash(command: string): boolean {
  if (isReadOnlyBashCommand(command)) return false;
  if (isGitOperation(command)) return false;
  return isDestructiveBashCommand(command);
}

function isComplexTask(prompt: string, filePath?: string): boolean {
  const lower = prompt.toLowerCase();
  if (lower.includes("quick task") || lower.includes("--no-plan")) return false;

  for (const kw of COMPLEXITY_KEYWORDS) {
    if (lower.includes(kw)) return true;
  }

  // ≥3 path-like tokens in prompt
  const pathPattern = /(?:[\w.-]+\/){1,}[\w.-]+\.\w+/g;
  const matches = lower.match(pathPattern) || [];
  if (matches.length >= 3) return true;

  const allPaths = lower.match(/\S+\.\w+/g) || [];
  if (allPaths.length >= 3) return true;

  if (filePath && isCodeFile(filePath)) return true;
  return false;
}

function planMarkerPath(sessionId: string | null): string {
  // Session-scoped: data/plans/sessions/<sid>/current-plan.md under REPO_ROOT.
  // sessionPlanPath is the single canonical builder (it sanitizes the id too).
  return join(REPO_ROOT, sessionPlanPath(sessionId));
}

function hasValidPlanMarker(sessionId: string | null): boolean {
  try {
    const marker = planMarkerPath(sessionId);
    if (!existsSync(marker)) return false;
    const age = Date.now() - statSync(marker).mtimeMs;
    return age <= PLAN_MAX_AGE_MS;
  } catch {
    return false;
  }
}

function getNodeExecutable(): string {
  // glitch-pi may not ship its own portable node; fall back to glitch-ai's then PATH.
  const candidates = [
    join(REPO_ROOT, "data", "node", "node.exe"),
    join(REPO_ROOT, "data", "node", "bin", "node"),
    "E:/Glitch AI/glitch-ai/data/node/node.exe",
    "E:/Glitch AI/glitch-ai/data/node/bin/node",
  ];
  for (const p of candidates) {
    try {
      if (existsSync(p)) return p;
    } catch { /* ignore */ }
  }
  return "node";
}

function extractResultText(result: any): string {
  if (!result) return "";
  if (typeof result === "string") return result;
  if (typeof result.content === "string") return result.content;
  if (Array.isArray(result.content)) {
    return result.content
      .map((c: any) => (typeof c?.text === "string" ? c.text : ""))
      .filter(Boolean)
      .join("\n");
  }
  try {
    return JSON.stringify(result);
  } catch {
    return "";
  }
}

function isPassVerdict(text: string): boolean {
  if (!text) return false;
  // Fail signals trump everything ("FIX THEN SHIP" contains "SHIP").
  const fail = /FIX THEN SHIP|FIX AND RESHIP|REJECTED|\bFAILED\b|\bREJECT\b|\bDENIED\b|\bPASS\b\s+(?:with|but)\b/i.test(text);
  if (fail) return false;
  return /\bPASSED\b|\bPASS\b|\bPROCEED\b|verdict\s*:\s*✅|\bSHIP\b|\bAPPROVED\b/i.test(text);
}

function extractFilePath(input: any): string {
  if (!input || typeof input !== "object") return "";
  // Pi uses `path`; OpenCode used filePath/path — accept both for safety
  const fp = input.filePath || input.path || input.file || "";
  return typeof fp === "string" ? fp : "";
}

function extractAgentName(input: any): string {
  if (!input || typeof input !== "object") return "unknown";
  return String(input.subagent_type || input.agent || input.subagent || input.template || input.type || "unknown");
}

function writeReviewPassMarker(agentName: string): void {
  try {
    const markerDir = dirname(MARKER_PATH);
    if (!existsSync(markerDir)) mkdirSync(markerDir, { recursive: true });
    const nodeBin = getNodeExecutable();
    execFileSync(nodeBin, [REVIEW_PASS_SCRIPT, "--verdict", "PASS", "--agent", agentName], {
      cwd: REPO_ROOT,
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 30_000,
    });
    console.log(`[routing] ✅ Review PASS (${agentName}) — review-pass marker written`);
  } catch (e: any) {
    console.warn(`[routing] ⚠️ Could not write review-pass marker: ${e?.message || e}`);
  }
}

const RENAME_MARKER_RE = /\[\[\s*conv\s*:\s*rename\s*:/;

function hasRenameMarker(content: any): boolean {
  if (typeof content === "string") return RENAME_MARKER_RE.test(content);
  if (Array.isArray(content)) {
    return content.some(
      (p: any) => p?.type === "text" && typeof p.text === "string" && RENAME_MARKER_RE.test(p.text),
    );
  }
  return false;
}

/** Junk-title detection: placeholder echoes must never rename a chat.
 *  Born from the 2026-09-30 incident (chats renamed to "<title>", "...",
 *  "<composed title>"). rename.js only rejects empty/>80; this runs BEFORE
 *  pi-web-ui's marker scan, so junk markers never reach it. */
function isJunkRenameTitle(raw: string): boolean {
  const t = (raw ?? "").trim();
  if (!t) return true;
  if (t.length > 80) return true;
  if (/^<[^>]*>$/.test(t)) return true; // <title>, <new title>, <3-6 word title>
  if (/^\{[^}]*\}$/.test(t)) return true; // {title}
  if (/^[.\u2026_-]+$/.test(t)) return true; // "...", "…", "---"
  if (/^(new\s+|succinct\s+|composed\s+)*(chat\s+)?(session\s+)?title$/i.test(t)) return true;
  if (/conv\s*:\s*rename/i.test(t)) return true; // echoes the marker syntax itself
  return false;
}

// --- R17 rename state (per conversation, keyed by session file) ---
// pi-web-ui runs every conversation in ONE process, so module-level state
// must be keyed, never global. Forks/restarts get a fresh entry and re-derive
// from the transcript (session_info entries survive everything).
type RenameState = {
  named: boolean; // once true, never re-checked — names are never un-set
  lastScan: number; // throttle for the raw transcript scan while unnamed
  lastStop?: string; // stopReason of the most recent assistant message
};
const renameStates = new Map<string, RenameState>();

function renameStateFor(ctx: any): RenameState {
  let key = "default";
  try {
    const f = ctx?.sessionManager?.getSessionFile?.();
    if (typeof f === "string" && f) key = f;
  } catch {
    /* best-effort */
  }
  let s = renameStates.get(key);
  if (!s) {
    s = { named: false, lastScan: 0 };
    renameStates.set(key, s);
  }
  return s;
}

/** True when this conversation already carries a name. Two sources:
 *  1. pi-side session_info (the /name command, ctx.setSessionName) via the
 *     live sessionManager's own memory;
 *  2. a raw scan of the transcript file — pi-web-ui's marker rename and its
 *     renameSession append session_info through a SEPARATE SessionManager
 *     handle, invisible to the live one's memory. */
function sessionIsNamed(ctx: any, state: RenameState): boolean {
  if (state.named) return true;
  try {
    const name = ctx?.sessionManager?.getSessionName?.();
    if (typeof name === "string" && name.trim()) {
      state.named = true;
      return true;
    }
  } catch {
    /* best-effort */
  }
  try {
    const now = Date.now();
    if (now - state.lastScan < 5_000) return false; // throttle: big files, hot path
    state.lastScan = now;
    const file = ctx?.sessionManager?.getSessionFile?.();
    if (typeof file === "string" && file && existsSync(file)) {
      if (readFileSync(file, "utf-8").includes('"type":"session_info"')) {
        state.named = true;
      }
    }
  } catch {
    /* best-effort — treat as unnamed */
  }
  return state.named;
}

// --- Extension ---

export default function (pi: ExtensionAPI) {
  const lastTaskTime = new Map<string, number>();
  // Global "any dispatch" stamp. edit/bash calls carry no agent key, so the
  // per-agent map alone can never satisfy their window check.
  let lastDispatchTime = 0;
  let pendingReview = false;
  let lastCodeTaskTime = 0;
  let lastReviewTaskTime = 0;
  let currentSessionID: string | null = null;
  // Host-subagent detection (2026-10-03). See the SUBAGENT EXEMPTION note at
  // the tool_call early-return below. Only ever true under pi-web-ui, where an
  // in-memory session with no transcript file is the signature of a delegated
  // sub-agent conversation.
  let isHostSubagent = false;

  pi.on("session_start", async (_event, ctx) => {
    // Identify host sub-agents (pi-web-ui delegated conversations) BEFORE any
    // gate runs. They are in-process conversations with an in-memory session:
    // no transcript file, no session_info. The rename enforcer below already
    // relies on exactly this distinction, so it is a proven detector.
    try {
      const f = (ctx as any)?.sessionManager?.getSessionFile?.();
      const underWebUi = Boolean(process.env.PI_WEB_PORT || process.env.PI_WEB_TOKEN);
      isHostSubagent = underWebUi && !(typeof f === "string" && f);
    } catch {
      isHostSubagent = false;
    }

    const sid =
      (ctx as any).sessionID ||
      (ctx as any).sessionId ||
      (ctx.sessionManager as any)?.sessionId ||
      (ctx.sessionManager as any)?.id ||
      "default";
    currentSessionID = String(sid);
  });

  // R17 rename guard v4 (conversation-scoped). The invariant is "named",
  // not "first reply": a conversation may be renamed by ANY assistant text
  // while it is still UNNAMED, and NEVER once it has a name. "Named" comes
  // from the conversation itself — pi-side session_info plus a raw scan of
  // the transcript — so forks, retries, restarts, and cross-instance renames
  // (pi-web-ui's marker service appends session_info via its own
  // SessionManager handle) all agree. v3's "first assistant text" heuristic
  // is gone: it blocked the enforcer's follow-up replies below, and it let a
  // resumed conversation's first reply rename an already-named chat.
  // Junk-title markers are stripped even while unnamed — the 2026-09-30
  // incident saw chats renamed to "<title>", "...", and "<composed title>".
  pi.on("message_end", async (event, ctx) => {
    try {
      const mm = (event as any).message;
      if (mm?.role !== "assistant") return undefined;
      const state = renameStateFor(ctx);
      state.lastStop = mm.stopReason;
      if (!hasRenameMarker(mm.content)) return undefined;
      const named = sessionIsNamed(ctx, state);
      let kept = 0;
      const filterText = (text: string): string => {
        let out = "";
        let last = 0;
        const re = /\[\[\s*conv\s*:\s*rename\s*:(.*?)\s*\]\]/g;
        let m: RegExpExecArray | null;
        while ((m = re.exec(text)) !== null) {
          const keep = !named && kept === 0 && !isJunkRenameTitle(m[1] ?? "");
          if (keep) kept = 1;
          out += text.slice(last, m.index);
          if (keep) out += m[0];
          last = m.index + m[0].length;
        }
        out += text.slice(last);
        return kept === 0 ? out.trim() : out;
      };
      const rebuild = (content: any): any => {
        if (typeof content === "string") return filterText(content);
        if (Array.isArray(content)) {
          return content.map((p: any) =>
            p?.type === "text" && typeof p.text === "string"
              ? { ...p, text: filterText(p.text) }
              : p,
          );
        }
        return content;
      };
      const content = rebuild(mm.content);
      if (kept === 1) state.named = true; // a rename is now in flight for this conversation
      return { message: { ...mm, content } } as any;
    } catch (e: any) {
      console.error(`[routing] rename guard failed: ${e?.message || e}`);
      return undefined;
    }
  });

  // --- R17 enforcer: rename even when the model forgets the marker ---
  // Models routinely skip the R17 instruction (verified 2026-10-01: most
  // recent sessions emitted no marker at all; the 3 that did all renamed
  // fine — the plumbing works, the emission is the failure). So after a run
  // settles on an UNNAMED conversation, ask once (invisible custom message,
  // triggerTurn) for a marker-only reply. The guard above lets exactly that
  // reply through. Self-limiting: attempts are persisted in the transcript
  // via appendEntry (survives restarts; counted from getBranch), capped at 2.
  const RENAME_NUDGE_ENTRY = "glitch-rename-nudge";
  const underPiWebUi = () => Boolean(process.env.PI_WEB_PORT || process.env.PI_WEB_TOKEN);

  pi.on("agent_settled", async (_event, ctx) => {
    try {
      if (process.env.GLITCH_SUBAGENT === "1") return; // dispatcher subagents: separate process, flagged
      // pi-web-ui's own subagents are in-process conversations with an
      // in-memory session (no transcript file, no session_info to write) and
      // no GLITCH_SUBAGENT flag — detect them by the missing file instead.
      let sessionFile: string | undefined;
      try {
        sessionFile = (ctx as any).sessionManager?.getSessionFile?.();
      } catch {
        /* best-effort */
      }
      if (typeof sessionFile !== "string" || !sessionFile) return;
      if (!underPiWebUi()) return; // the marker executor lives in pi-web-ui; TUI has /name
      const state = renameStateFor(ctx);
      if (state.lastStop === "aborted" || state.lastStop === "error") return; // don't chase a dead run
      if (sessionIsNamed(ctx, state)) return;
      let attempts = 0;
      try {
        const branch = (ctx as any).sessionManager?.getBranch?.() ?? [];
        attempts = (branch as any[]).filter(
          (e: any) => e?.type === "custom" && e?.customType === RENAME_NUDGE_ENTRY,
        ).length;
      } catch {
        /* best-effort */
      }
      if (attempts >= 2) return;
      pi.appendEntry(RENAME_NUDGE_ENTRY, { at: new Date().toISOString() });
      // Deferred: let settle fully complete before starting the nudge turn
      // (same mechanism as the restart-stack continuation injection).
      setTimeout(() => {
        try {
          pi.sendMessage(
            {
              customType: RENAME_NUDGE_ENTRY,
              display: false,
              content:
                "This conversation still has no title. Reply with ONLY the rename marker: " +
                "[[conv:rename:<3-6 word title>]] — compose the title from the user's goal " +
                "(never their raw words, never a placeholder like <title>). No other text, no tools.",
            },
            { triggerTurn: true },
          );
        } catch (e: any) {
          console.error(`[routing] rename nudge failed: ${e?.message || e}`);
        }
      }, 50);
    } catch (e: any) {
      console.error(`[routing] rename enforcer failed: ${e?.message || e}`);
    }
  });
  // --- Pre-tool gates: plan-first + dispatch-first + review gate ---
  pi.on(
    "tool_call",
    async (event: ToolCallEvent): Promise<ToolCallEventResult | undefined> => {
      try {
        // Sub-agent sessions (dispatcher-spawned, GLITCH_SUBAGENT=1) run without
        // the primary's workflow gates — matches the OpenCode design where
        // sub-agents were plugin-free.
        // SUBAGENT EXEMPTION (2026-10-03). Dispatching to a sub-agent is the
        // whole point of the gate, so the delegate must be able to do the work.
        // Two spawn paths exist and BOTH must skip the primary's gates:
        //   - legacy dispatcher.ts `task()` → separate `pi -p` process, flagged
        //     GLITCH_SUBAGENT=1. Always worked.
        //   - R6 host sub-agents (delegate_task / subagent_spawn) → in-process
        //     conversations under pi-web-ui, env flag NOT set. These were gated
        //     like a primary, so a delegated coder got Plan-First + Dispatch-First
        //     blocks on its own writes and deadlocked: the only bypass phrase
        //     (`self-execute`) is defined by the very gate that was blocking it.
        // Exempting them restores the OpenCode design this file was ported from
        // ("sub-agents ran plugin-free"). `underWebUi` is required so a TUI
        // primary that somehow lacks a transcript file is never exempted.
        if (process.env.GLITCH_SUBAGENT === "1") return undefined;
        if (isHostSubagent) return undefined;

        const agentName = extractAgentName((event as any).input);
        const isGlitchOmni = agentName === "glitch-omni" || isOmniPrimaryMode();

        // --- dispatch tracking on task-like custom tools ---
        if (event.toolName === "task" || event.toolName === "dispatch" || event.toolName === "subagent_spawn" || event.toolName === "delegate_task") {
          // Hard no-dispatch gate for direct-execution modes (omni/lightweight).
          // The mode file is re-read per call, so mid-session /agent switches
          // take effect immediately.
          if (isDirectExecPrimaryMode()) {
            return {
              block: true,
              reason:
                `⛔ No-Dispatch Violation: ${event.toolName} is forbidden in ${readAgentMode()} mode.\n` +
                "Glitch Omni / Glitch Lightweight execute everything directly — no sub-agent dispatch, ever.\n" +
                "Do the work yourself with edit/write/bash/read. If the task needs a capability you lack, tell Troy directly.\n" +
                "To use sub-agents, ask Troy to switch modes: /agent glitch.",
            };
          }
          // task dispatch itself is allowed in dispatch-first modes; timestamp recorded after via tool_execution_end
        }

        // --- edit / write gates ---
        if (event.toolName === "edit" || event.toolName === "write") {
          const filePath = extractFilePath((event as any).input);
          if (!filePath) return undefined;

          // Plan-ownership gate: a session may only write its own plan file
          // (data/plans/sessions/<mysid>/...) or the shared archive. Foreign
          // plan paths — other sessions' files, the legacy shared file — are
          // blocked so concurrent sessions can't clobber each other's plans.
          if (isPlanPath(filePath) && classifyPlanPath(filePath, currentSessionID) === "foreign") {
            return {
              block: true,
              reason:
                `⛔ Plan Ownership Violation: ${filePath} is not this session's plan file.\n` +
                `Your session-scoped plan is ${sessionPlanPath(currentSessionID)}; the shared archive is data/plans/archive/.\n` +
                `Write plans only to your own file. Reading another session's plan is fine — mutating it is not.`,
            };
          }

          // Plan-First (plan-reflex)
          if (!isExemptFile(filePath) && isCodeFile(filePath)) {
            const promptHint = String((event as any).input?.prompt || "");
            if (!promptHint.toLowerCase().includes("quick task")) {
              if (!hasValidPlanMarker(currentSessionID)) {
                return {
                  block: true,
                  reason:
                    "⛔ Plan-First Violation: Code file edit without an up-front plan.\n" +
                    `File: ${filePath}\n` +
                    `You MUST write a plan to ${sessionPlanPath(currentSessionID)} (via the plan-first skill) before editing code files.\n` +
                    "Plan template: Goal, Approach, Files to change, Risks, Verification.\n" +
                    "Exempt: memory files (user/*.md), config files (config/*.json, opencode.json).\n" +
                    'To force-skip for an intentionally simple task: include "quick task" in the prompt.',
                };
              }
            }
          }

          // Dispatch-First (dispatch-reflex)
          if (!isExemptFile(filePath) && isCodeFile(filePath)) {
            const lastTask = Math.max(lastTaskTime.get(agentName) || 0, lastDispatchTime);
            const timeSinceTask = Date.now() - lastTask;
            if (timeSinceTask > DISPATCH_WINDOW_MS) {
              if (isGlitchOmni) {
                console.warn(`[routing] Warning: Agent ${agentName} editing directly — glitch-omni mode`);
              } else {
                return {
                  block: true,
                  reason:
                    `⛔ Dispatch-First Violation: Direct edit on ${filePath} without prior subagent dispatch.\n` +
                    `You MUST dispatch to a sub-agent first (delegate_task or subagent_spawn, e.g. delegate_task with agent: "coder" for code) before editing files directly.\n` +
                    "Exempt: memory files (user/*.md), config files (opencode.json), and git operations.",
                };
              }
            }
          }
        }

        // --- bash gates ---
        if (event.toolName === "bash" || event.toolName === "powershell") {
          const command = String((event as any).input?.command || "");
          if (!command) return undefined;
          const normalizedCmd = command.trim().toLowerCase();

          // Plan-ownership gate: mutating shell commands (mv/rm/move-item/...)
          // may only touch this session's own plan file or the shared archive.
          // Reads (cat/ls/type) are never judged here.
          if (hasPlanMutation(command)) {
            const verdict = classifyPlanCommand(command, currentSessionID);
            if (!verdict.allowed) {
              return {
                block: true,
                reason:
                  "⛔ Plan Ownership Violation in shell command.\n" +
                  `Offending plan path(s): ${verdict.offending.join(", ")}\n` +
                  verdict.reason,
              };
            }
          }

          // Destructive bash → dispatch-first
          if (shouldBlockDestructiveBash(command)) {
            const lastTask = Math.max(lastTaskTime.get(agentName) || 0, lastDispatchTime);
            const timeSinceTask = Date.now() - lastTask;
            if (timeSinceTask > DISPATCH_WINDOW_MS) {
              if (isGlitchOmni) {
                console.warn(`[routing] Warning: Agent ${agentName} running destructive bash directly — glitch-omni mode`);
              } else {
                return {
                  block: true,
                  reason:
                    "⛔ Dispatch-First Violation: Direct destructive bash command without prior subagent dispatch.\n" +
                    `Command: ${command}\n` +
                    'You MUST dispatch to a sub-agent first (delegate_task or subagent_spawn, e.g. delegate_task with agent: "general") before running destructive commands.\n' +
                    "Exempt: read-only commands, git operations (git add, commit, push, pull).",
                };
              }
            }
          }

          // Review gate on git commit
          if (normalizedCmd.startsWith("git commit")) {
            if (normalizedCmd.includes("--no-verify")) return undefined; // Troy accepts the risk by naming it
            if (pendingReview && lastCodeTaskTime > lastReviewTaskTime) {
              return {
                block: true,
                reason:
                  "⛔ Review Gate: Code was written by a sub-agent but no review has been performed since.\n" +
                  "Dispatch @reviewer first and get a PASS before committing.\n" +
                  "Reviewer agents: @reviewer (free), @reviewer-paid (paid fallback)\n" +
                  "To bypass: git commit --no-verify (only if you understand the risk)",
              };
            }
            // Quality gate for direct-execution primaries (omni/lightweight):
            // the dispatch-based gate above can never fire there, so staged
            // code files require a fresh PASS marker from a self-review
            // against docs/engineering-standards.md (code-review + testing).
            if (isDirectExecPrimaryMode() || isOmniPrimaryMode()) {
              const staged = getStagedCodeFiles();
              if (staged.length > 0 && !hasFreshPassMarker()) {
                return {
                  block: true,
                  reason:
                    "⛔ Quality Gate: staged code files without a fresh review-pass marker (<30 min).\n" +
                    `Staged code files: ${staged.slice(0, 10).join(", ")}${staged.length > 10 ? ` … +${staged.length - 10} more` : ""}\n` +
                    "Self-review the diff with the code-review skill, run/verify tests (testing skill), then:\n" +
                    "  node scripts/write-review-pass.mjs --agent self-review --verdict PASS\n" +
                    "Standard: docs/engineering-standards.md §1 (definition of done).\n" +
                    "Bypass: git commit --no-verify (only if Troy explicitly accepts the risk).",
                };
              }
            }
          }
        }

        return undefined;
      } catch (e: any) {
        console.error(`[routing] tool_call failed: ${e?.message || e}`);
        return undefined; // never hard-crash the tool loop from routing
      }
    },
  );

  // --- Post-tool: track dispatches + review verdicts ---
  pi.on("tool_execution_end", async (event) => {
    try {
      const tool = event.toolName || "unknown";

      if (tool === "task" || tool === "dispatch" || tool === "subagent_spawn" || tool === "delegate_task") {
        const args = (event as any).args ?? (event as any).input ?? {};
        const agentName = extractAgentName(args);
        lastTaskTime.set(agentName, Date.now());
        lastDispatchTime = Date.now();

        if (CODE_WRITING_AGENTS.has(agentName)) {
          pendingReview = true;
          lastCodeTaskTime = Date.now();
        }

        if (REVIEW_AGENTS.has(agentName)) {
          pendingReview = false;
          lastReviewTaskTime = Date.now();
          const text = extractResultText(event.result);
          if (isPassVerdict(text)) {
            writeReviewPassMarker(agentName);
          } else {
            console.warn(`[routing] Review verdict for ${agentName} not PASS — marker not written`);
          }
        }
      }
    } catch (e: any) {
      console.error(`[routing] tool_execution_end failed: ${e?.message || e}`);
    }
  });
}
