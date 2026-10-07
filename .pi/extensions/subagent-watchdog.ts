/**
 * subagent-watchdog.ts — Pi extension: detects hung sub-agents (silent ≥12 min)
 * and injects one-shot directives so Glitch stops just that agent instead of
 * the whole conversation.
 *
 * STATE FILES:
 *   data/.agent-watchdog.json            — persisted watchdog state
 *   data/.agent-watchdog-directive.json  — one-shot directive flag (consumed
 *                                          on `context` event, then deleted)
 *
 * HOW IT WORKS:
 *   1. tool_execution_start captures args by toolCallId for `subagent` and
 *      `delegate_task` tools (the end event carries no args — same pattern as
 *      stuck-detector.ts v2).
 *   2. tool_execution_end joins by toolCallId:
 *      - Spawn results → parse runId via parseRunIdFromResult, recordSpawn
 *      - get_result/wait_all → recordObservation (output + status)
 *      - stop → mark stopped
 *   3. setInterval (2 min) calls evaluate() → writes directive file
 *   4. `context` event: if directive file exists, appends directive text to
 *      last message, deletes file (one-shot)
 *
 * CONSTRAINT: this extension NEVER calls the host's subagent tool. It only
 * detects + writes directives. Glitch acts on them.
 */

import {
  writeFileSync,
  readFileSync,
  existsSync,
  mkdirSync,
  unlinkSync,
} from "node:fs";
import { join } from "node:path";
import type { ExtensionAPI, AgentMessage, TextContent } from "@earendil-works/pi-coding-agent";
import {
  createEmptyState,
  recordSpawn,
  recordObservation,
  evaluate,
  sweep,
  buildDirective,
  parseRunIdFromResult,
  type WatchdogState,
  type WatchdogDirective,
} from "../lib/subagent-watchdog-logic.mts";

const EVAL_INTERVAL_MS = 2 * 60 * 1000;
const MAX_PENDING_ARGS = 64;
const WATCHDOG_TOOLS = new Set(["subagent", "delegate_task"]);

// Dispatch actions that spawn agents (vs bookkeeping).
const SPAWN_ACTIONS = new Set(["spawn"]);
// Actions that fetch agent output/status.
const OBSERVE_ACTIONS = new Set(["get_result", "wait_all"]);

function safeReadJson<T = unknown>(path: string): T | null {
  try {
    if (!existsSync(path)) return null;
    return JSON.parse(readFileSync(path, "utf-8")) as T;
  } catch {
    return null;
  }
}

function safeWriteJson(path: string, data: unknown): void {
  try {
    writeFileSync(path, JSON.stringify(data, null, 2), "utf-8");
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error(`[subagent-watchdog] Failed to write ${path}: ${msg}`);
  }
}

export default function (pi: ExtensionAPI) {
  const dataDir = join(process.cwd(), "data");
  const STATE_FILE = join(dataDir, ".agent-watchdog.json");
  const DIRECTIVE_FILE = join(dataDir, ".agent-watchdog-directive.json");

  try {
    mkdirSync(dataDir, { recursive: true });
  } catch {
    // ignore
  }

  // Load state (or start fresh) + sweep stale entries on init.
  const state: WatchdogState =
    safeReadJson<WatchdogState>(STATE_FILE) ?? createEmptyState();
  if (!state.entries) state.entries = {};
  sweep(state, Date.now());
  safeWriteJson(STATE_FILE, state);

  // Remove stale directive file on init (leftover from a crash).
  try {
    if (existsSync(DIRECTIVE_FILE)) unlinkSync(DIRECTIVE_FILE);
  } catch {
    // ignore
  }

  // toolCallId → args captured at tool_execution_start.
  const pendingArgs = new Map<string, Record<string, unknown>>();

  // --- Event wiring ---

  // Capture args at execution start (tool_execution_end does not carry them).
  pi.on("tool_execution_start", async (event) => {
    try {
      if (!event.toolCallId) return;
      const tool = (event as any).toolName as string | undefined;
      if (!tool || !WATCHDOG_TOOLS.has(tool)) return;

      if (pendingArgs.size >= MAX_PENDING_ARGS) {
        const firstKey = pendingArgs.keys().next().value;
        if (firstKey !== undefined) pendingArgs.delete(firstKey);
      }
      pendingArgs.set(
        event.toolCallId,
        ((event as any).args ?? {}) as Record<string, unknown>,
      );
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      console.error(`[subagent-watchdog] tool_execution_start failed: ${msg}`);
    }
  });

  // Post-tool: join args, parse runId, record events.
  pi.on("tool_execution_end", async (event) => {
    try {
      const tool = event.toolName || "unknown";
      if (!WATCHDOG_TOOLS.has(tool)) {
        pendingArgs.delete(event.toolCallId);
        return;
      }

      const args = pendingArgs.get(event.toolCallId) ?? {};
      pendingArgs.delete(event.toolCallId);

      const action = String(args.action ?? "");
      const resultText = extractResultText(event.result);

      // --- Spawn: parse runId from result, record in state ---
      if (SPAWN_ACTIONS.has(action) || tool === "delegate_task") {
        const runId = parseRunIdFromResult(event.result) ??
          parseRunIdFromResult(resultText);
        if (runId) {
          const template = String(
            args.template ?? args.agent ?? args.type ?? "unknown",
          );
          recordSpawn(state, runId, template, Date.now());
          safeWriteJson(STATE_FILE, state);
        }
        return;
      }

      // --- Observe: get_result / wait_all → update observation ---
      if (OBSERVE_ACTIONS.has(action)) {
        const runId = String(args.runId ?? "");
        const statusText = extractStatusFromResult(event.result);
        if (runId && state.entries[runId]) {
          recordObservation(state, runId, statusText, resultText, Date.now());
          safeWriteJson(STATE_FILE, state);
        }
        return;
      }

      // --- Stop: mark as stopped ---
      if (action === "stop") {
        const runId = String(args.runId ?? "");
        if (runId && state.entries[runId]) {
          recordObservation(state, runId, "stopped", undefined, Date.now());
          safeWriteJson(STATE_FILE, state);
        }
        return;
      }
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      console.error(`[subagent-watchdog] tool_execution_end failed: ${msg}`);
    }
  });

  // --- Periodic evaluation (2 min) ---
  setInterval(() => {
    try {
      const now = Date.now();
      sweep(state, now);
      const directives = evaluate(state, now);

      if (directives.length > 0) {
        // Write one directive file with all current directives.
        const payload = {
          timestamp: new Date().toISOString(),
          directives: directives.map((d) => ({
            ...d,
            message: buildDirective(d),
          })),
        };
        safeWriteJson(DIRECTIVE_FILE, payload);
        safeWriteJson(STATE_FILE, state);
        console.log(
          `[subagent-watchdog] ⏱ ${directives.length} directive(s) written`,
        );
      } else {
        safeWriteJson(STATE_FILE, state);
      }
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      console.error(`[subagent-watchdog] periodic eval failed: ${msg}`);
    }
  }, EVAL_INTERVAL_MS);

  // --- Context event: inject directive into last message (one-shot) ---
  pi.on("context", async (event) => {
    try {
      const payload = safeReadJson<{
        directives: Array<WatchdogDirective & { message: string }>;
      }>(DIRECTIVE_FILE);
      if (!payload?.directives?.length) return;

      const messages = event.messages as AgentMessage[];
      if (!messages?.length) return;
      const lastMessage = messages[messages.length - 1];
      if (!lastMessage || !Array.isArray((lastMessage as any).content)) return;

      const allDirectives = payload.directives
        .map((d) => d.message)
        .join("\n\n");
      const directive =
        `⏱ SUBAGENT WATCHDOG (${payload.directives.length} agent${payload.directives.length > 1 ? "s" : ""} flagged):\n\n${allDirectives}`;

      const content = (lastMessage as any).content as Array<{
        type: string;
        text?: string;
      }>;
      const lastPart = content[content.length - 1];
      if (lastPart && lastPart.type === "text" && typeof lastPart.text === "string") {
        lastPart.text += `\n\n${directive}`;
      } else {
        content.push({ type: "text", text: directive } as TextContent);
      }

      // Consume the one-shot file.
      try {
        unlinkSync(DIRECTIVE_FILE);
      } catch {
        // ignore
      }

      console.log(
        `[subagent-watchdog] injected directive for ${payload.directives.length} agent(s)`,
      );
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      console.error(`[subagent-watchdog] context inject failed: ${msg}`);
    }
  });

  // Timer cleanup happens naturally on process exit (Pi manages extension
  // lifecycle). No explicit unload handler needed.
}

// --- Helpers ---

function extractResultText(result: unknown): string {
  if (!result) return "";
  if (typeof result === "string") return result;
  if (typeof result === "object" && result !== null) {
    const r = result as Record<string, unknown>;
    if (typeof r.content === "string") return r.content;
    if (Array.isArray(r.content)) {
      return r.content
        .filter((c: unknown) => typeof (c as Record<string, unknown>)?.text === "string")
        .map((c: unknown) => (c as Record<string, string>).text)
        .join(" ");
    }
    if (typeof r.output === "string") return r.output;
  }
  return String(result);
}

function extractStatusFromResult(result: unknown): string | undefined {
  if (!result || typeof result !== "object") return undefined;
  const r = result as Record<string, unknown>;
  // Only trust an explicit status field — never infer from output text.
  // A get_result response may contain "done" in the agent's output without
  // the agent actually being finished; inferring status would deactivate the
  // watchdog entry prematurely.
  const status = r.status;
  if (typeof status === "string") return status;
  return undefined;
}
