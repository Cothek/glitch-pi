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
 *      data/plans/current-plan.md (< 6h). Bypass: "quick task" / --no-plan.
 *   2. Dispatch-First: code-file edit or destructive bash without a prior
 *      task() dispatch within 120s. glitch-omni warns instead of blocks.
 *   3. Review Gate: git commit when pendingReview && lastCode > lastReview.
 *      Bypass: --no-verify.
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
import { existsSync, mkdirSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import type { ExtensionAPI, ToolCallEvent, ToolCallEventResult } from "@earendil-works/pi-coding-agent";

// --- Paths (relative to process.cwd() = glitch-pi root when launched there) ---
const REPO_ROOT = process.cwd();
const REVIEW_PASS_SCRIPT = join(REPO_ROOT, "scripts", "write-review-pass.mjs");
const MARKER_PATH = join(REPO_ROOT, "data", ".review-pass.json");
const PLAN_MARKER_PATH = join(REPO_ROOT, "data", "plans", "current-plan.md");

const PLAN_MAX_AGE_MS = 6 * 60 * 60 * 1000; // 6h
const DISPATCH_WINDOW_MS = 120_000; // 120s

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
  "rm ", "del ", "remove-item", "rmdir ", "rd ", "deltree",
  "rmdir /s", "remove-item -recurse",
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
  const normalized = command.trim().toLowerCase();
  return [...DESTRUCTIVE_BASH_COMMANDS].some((cmd) => normalized.includes(cmd));
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

function hasValidPlanMarker(): boolean {
  try {
    if (!existsSync(PLAN_MARKER_PATH)) return false;
    const age = Date.now() - statSync(PLAN_MARKER_PATH).mtimeMs;
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
  return String(input.subagent_type || input.agent || input.subagent || "unknown");
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

// --- Extension ---

export default function (pi: ExtensionAPI) {
  const lastTaskTime = new Map<string, number>();
  let pendingReview = false;
  let lastCodeTaskTime = 0;
  let lastReviewTaskTime = 0;
  let currentSessionID: string | null = null;

  pi.on("session_start", async (_event, ctx) => {
    const sid =
      (ctx as any).sessionID ||
      (ctx as any).sessionId ||
      (ctx.sessionManager as any)?.sessionId ||
      (ctx.sessionManager as any)?.id ||
      "default";
    currentSessionID = String(sid);
  });

  // --- Pre-tool gates: plan-first + dispatch-first + review gate ---
  pi.on(
    "tool_call",
    async (event: ToolCallEvent): Promise<ToolCallEventResult | undefined> => {
      try {
        const agentName = extractAgentName((event as any).input);
        const isGlitchOmni = agentName === "glitch-omni";

        // --- dispatch tracking on task-like custom tools ---
        if (event.toolName === "task" || event.toolName === "dispatch") {
          // task dispatch itself is allowed; timestamp recorded after via tool_execution_end
        }

        // --- edit / write gates ---
        if (event.toolName === "edit" || event.toolName === "write") {
          const filePath = extractFilePath((event as any).input);
          if (!filePath) return undefined;

          // Plan-First (plan-reflex)
          if (!isExemptFile(filePath) && isCodeFile(filePath)) {
            const promptHint = String((event as any).input?.prompt || "");
            if (!promptHint.toLowerCase().includes("quick task")) {
              if (!hasValidPlanMarker()) {
                return {
                  block: true,
                  reason:
                    "⛔ Plan-First Violation: Code file edit without an up-front plan.\n" +
                    `File: ${filePath}\n` +
                    "You MUST write a plan to data/plans/current-plan.md (via the plan-first skill) before editing code files.\n" +
                    "Plan template: Goal, Approach, Files to change, Risks, Verification.\n" +
                    "Exempt: memory files (user/*.md), config files (config/*.json, opencode.json).\n" +
                    'To force-skip for an intentionally simple task: include "quick task" in the prompt.',
                };
              }
            }
          }

          // Dispatch-First (dispatch-reflex)
          if (!isExemptFile(filePath) && isCodeFile(filePath)) {
            const lastTask = lastTaskTime.get(agentName) || 0;
            const timeSinceTask = Date.now() - lastTask;
            if (timeSinceTask > DISPATCH_WINDOW_MS) {
              if (isGlitchOmni) {
                console.warn(`[routing] Warning: Agent ${agentName} editing directly — glitch-omni mode`);
              } else {
                return {
                  block: true,
                  reason:
                    `⛔ Dispatch-First Violation: Direct edit on ${filePath} without prior task() dispatch.\n` +
                    `You MUST dispatch to the appropriate sub-agent (task() with subagent_type: "coder" for code) before editing files directly.\n` +
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

          // Destructive bash → dispatch-first
          if (shouldBlockDestructiveBash(command)) {
            const lastTask = lastTaskTime.get(agentName) || 0;
            const timeSinceTask = Date.now() - lastTask;
            if (timeSinceTask > DISPATCH_WINDOW_MS) {
              if (isGlitchOmni) {
                console.warn(`[routing] Warning: Agent ${agentName} running destructive bash directly — glitch-omni mode`);
              } else {
                return {
                  block: true,
                  reason:
                    "⛔ Dispatch-First Violation: Direct destructive bash command without prior task() dispatch.\n" +
                    `Command: ${command}\n` +
                    'You MUST dispatch to the appropriate sub-agent (task() with subagent_type: "general") before running destructive commands.\n' +
                    "Exempt: read-only commands, git operations (git add, commit, push, pull).",
                };
              }
            }
          }

          // Review gate on git commit
          if (normalizedCmd.startsWith("git commit")) {
            if (normalizedCmd.includes("--no-verify")) return undefined;
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

      if (tool === "task" || tool === "dispatch") {
        const args = (event as any).args ?? (event as any).input ?? {};
        const agentName = extractAgentName(args);
        lastTaskTime.set(agentName, Date.now());

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
