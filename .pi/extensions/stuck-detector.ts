/**
 * stuck-detector.ts — Pi extension: detects stuck patterns in tool calls.
 * Ported from glitch-ai .opencode/plugins/stuck-detector.js → Pi ExtensionAPI.
 *
 * FORMATS (unchanged contract):
 *   data/.stuck-signal.<sessionID>.json  — per-session signal
 *   data/.stuck-signal.json              — global mirror (most recent active; R21)
 *
 * v2 REFINEMENT (fixes the overzealous detector — plan 01a0da70):
 *   - ROOT CAUSE of false positives: Pi's tool_execution_end event carries
 *     ONLY {toolCallId, toolName, result, isError} — NO args. v1 read
 *     event.args anyway, so every fingerprint was "{}" and any tool called 3x
 *     fired. v2 captures args from tool_execution_start (which has them) and
 *     joins by toolCallId. Entries with never-captured args are marked
 *     argsKnown=false and NEVER trigger similarity-based rules.
 *   - Detection rules refined (see stuck-detector-logic.ts): polling tools
 *     get threshold 6, tool_repetition requires an ONGOING similar cluster
 *     (not one stale pair), error_cascade needs 4 diverse errors or 3
 *     identical failing calls, command_repetition must be ongoing.
 *   - 10-minute per-session per-type signal cooldown: v1 re-fired every turn
 *     (signal consumed on inject, next call re-detected) — one session got 8
 *     directives in a row.
 *   - Directive text softened to match R21: self-check first, continue when
 *     progressing, stop only when genuinely stuck.
 *
 * Injection: Pi `context` event appends directive to last message (one-shot,
 * flag deleted after inject).
 *
 * Pi tool mapping:
 *   OpenCode tool.execute.before → Pi tool_call (pre, for bash-repetition warn)
 *   OpenCode tool.execute.after  → Pi tool_execution_start (args) + tool_execution_end (result)
 *   OpenCode chat.messages.transform → Pi context
 */

import {
  writeFileSync,
  unlinkSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
} from "node:fs";
import { join } from "node:path";
import type { ExtensionAPI, AgentMessage, TextContent } from "@earendil-works/pi-coding-agent";
import {
  detectStuck,
  isGenuineProgress,
  isClockCommand,
  type HistoryEntry,
  type StuckSignal,
} from "./stuck-detector-logic.mts";
import { guard } from "../../.pi/lib/ctx-guard.mjs";

const SIGNAL_TTL_MS = 15 * 60 * 1000;
const SIGNAL_COOLDOWN_MS = 10 * 60 * 1000;
const MAX_PENDING_ARGS = 128;

function sweepStaleSignals(dataDir: string, ttlMs: number): void {
  const now = Date.now();
  let swept = 0;
  try {
    const files = readdirSync(dataDir);
    for (const file of files) {
      if (!file.startsWith(".stuck-signal") || !file.endsWith(".json")) continue;
      const fullPath = join(dataDir, file);
      try {
        const raw = readFileSync(fullPath, "utf-8");
        const parsed = JSON.parse(raw);
        const detectedAt = new Date(parsed.detected_at).getTime();
        if (isNaN(detectedAt) || now - detectedAt > ttlMs) {
          unlinkSync(fullPath);
          swept++;
        }
      } catch {
        // ignore
      }
    }
  } catch {
    // ignore
  }
  if (swept > 0) {
    console.log(`[stuck-detector] 🧹 Swept ${swept} stale signal file(s) on init`);
  }
}

function isSignalFresh(signalPath: string, ttlMs: number): boolean {
  try {
    const raw = readFileSync(signalPath, "utf-8");
    const parsed = JSON.parse(raw);
    const detectedAt = new Date(parsed.detected_at).getTime();
    if (isNaN(detectedAt)) return false;
    return Date.now() - detectedAt <= ttlMs;
  } catch {
    return false;
  }
}

export default function (pi: ExtensionAPI) {
  const MAX_HISTORY = 20;
  const dataDir = join(process.cwd(), "data");
  const GLOBAL_SIGNAL_FILE = join(dataDir, ".stuck-signal.json");

  try {
    mkdirSync(dataDir, { recursive: true });
  } catch {
    // ignore
  }

  sweepStaleSignals(dataDir, SIGNAL_TTL_MS);

  const histories = new Map<string, HistoryEntry[]>();
  // Args captured at tool_execution_start, joined at tool_execution_end by
  // toolCallId (the end event has no args — see header note).
  const pendingArgs = new Map<string, any>();
  // `${sessionID}|${type}` → last write timestamp. Prevents re-fire spam.
  const lastSignalAt = new Map<string, number>();
  let currentSessionID: string | null = null;

  function getHistory(sessionID: string): HistoryEntry[] {
    if (!histories.has(sessionID)) {
      histories.set(sessionID, []);
    }
    return histories.get(sessionID)!;
  }

  function sessionSignalPath(sessionID: string): string {
    return join(dataDir, `.stuck-signal.${sessionID}.json`);
  }

  function cooldownActive(sessionID: string, type: string): boolean {
    const key = `${sessionID}|${type}`;
    const at = lastSignalAt.get(key);
    if (!at) return false;
    if (Date.now() - at < SIGNAL_COOLDOWN_MS) return true;
    lastSignalAt.delete(key);
    return false;
  }

  function writeSignal(sessionID: string, signal: StuckSignal): void {
    try {
      const payload = {
        detected_at: new Date().toISOString(),
        stuck: true,
        sessionID,
        type: signal.type,
        detail: signal.detail,
        tool: signal.tool || signal.command || "unknown",
        recommendation: 'Stuck-pattern detected. Self-check: if you are making progress, continue normally and this will clear on your next successful step. If genuinely stuck, load skill("breakthrough") to reframe the problem using a different approach.',
      };
      const content = JSON.stringify(payload, null, 2);

      writeFileSync(sessionSignalPath(sessionID), content, "utf-8");
      writeFileSync(GLOBAL_SIGNAL_FILE, content, "utf-8");
      lastSignalAt.set(`${sessionID}|${signal.type}`, Date.now());

      console.log(`[stuck-detector] ⚠️ Stuck detected (session=${sessionID}): ${signal.type} — ${signal.detail}`);
    } catch (e: any) {
      console.error(`[stuck-detector] Failed to write signal: ${e.message}`);
    }
  }

  function clearSignal(sessionID: string): void {
    try {
      const sp = sessionSignalPath(sessionID);
      if (existsSync(sp)) {
        unlinkSync(sp);
      }
      try {
        if (existsSync(GLOBAL_SIGNAL_FILE)) {
          const raw = readFileSync(GLOBAL_SIGNAL_FILE, "utf-8");
          const parsed = JSON.parse(raw);
          if (parsed && parsed.sessionID === sessionID) {
            unlinkSync(GLOBAL_SIGNAL_FILE);
          }
        }
      } catch {
        // ignore
      }
      console.log(`[stuck-detector] ✅ Unstuck detected (session=${sessionID}) — cleared signal`);
    } catch (e: any) {
      console.error(`[stuck-detector] Failed to clear signal: ${e.message}`);
    }
  }

  // --- Event wiring ---

  pi.on("session_start", async (_event, ctx) => {
    await guard("stuck-detector", async () => {
      const sid =
        (ctx as any).sessionID ||
        (ctx as any).sessionId ||
        (ctx.sessionManager as any)?.sessionId ||
        (ctx.sessionManager as any)?.id ||
        "default";
      currentSessionID = String(sid);
      getHistory(currentSessionID);
    });
  });

  // Capture args at execution start (tool_execution_end does not carry them).
  pi.on("tool_execution_start", async (event) => {
    try {
      if (!event.toolCallId) return;
      if (pendingArgs.size >= MAX_PENDING_ARGS) {
        // Trim the oldest entries so a leak of orphaned starts stays bounded.
        const firstKey = pendingArgs.keys().next().value;
        if (firstKey !== undefined) pendingArgs.delete(firstKey);
      }
      pendingArgs.set(event.toolCallId, event.args ?? {});
    } catch (e: any) {
      console.error(`[stuck-detector] tool_execution_start failed: ${e.message}`);
    }
  });

  // Post-tool: build history, detect, clear on progress.
  pi.on("tool_execution_end", async (event) => {
    try {
      const now = Date.now();
      const tool = event.toolName || "unknown";
      const sessionID = currentSessionID || "default";

      const capturedArgs = pendingArgs.get(event.toolCallId);
      pendingArgs.delete(event.toolCallId);
      const argsKnown = capturedArgs !== undefined;
      const args = argsKnown ? capturedArgs : {};

      const hasError = Boolean(event.isError);

      const history = getHistory(sessionID);
      history.push({
        tool,
        args,
        argsKnown,
        error: hasError,
        timestamp: now,
      });

      while (history.length > MAX_HISTORY) {
        history.shift();
      }

      if (isGenuineProgress(tool, args, hasError)) {
        if (existsSync(sessionSignalPath(sessionID))) {
          clearSignal(sessionID);
        }
      }

      if (history.length % 2 === 0) {
        const signal = detectStuck(history);
        if (
          signal &&
          !existsSync(sessionSignalPath(sessionID)) &&
          !cooldownActive(sessionID, signal.type)
        ) {
          writeSignal(sessionID, signal);
        }
      }
    } catch (e: any) {
      console.error(`[stuck-detector] tool_execution_end failed: ${e.message}`);
    }
  });

  // Pre-tool: warn on bash repetition when signal active (matches OpenCode tool.execute.before).
  pi.on("tool_call", async (event) => {
    try {
      const sessionID = currentSessionID || "default";
      if ((event.toolName === "bash" || event.toolName === "powershell") && existsSync(sessionSignalPath(sessionID))) {
        const cmd = (event as any).input?.command || "";
        const history = getHistory(sessionID);
        const recentShell = history
          .filter((e) => e.tool === "bash" || e.tool === "powershell")
          .slice(-3);
        const similarCmd = recentShell.some((e) => {
          const prevCmd = e.args?.command || "";
          if (typeof prevCmd !== "string" || !prevCmd) return false;
          return String(prevCmd).slice(0, 40) === String(cmd).slice(0, 40);
        });

        if (similarCmd) {
          console.warn(
            `[stuck-detector] ⚠️ Warning (session=${sessionID}): Command "${String(cmd).slice(0, 60)}..." was already executed recently. If stuck, try skill("breakthrough") for a fresh approach.`
          );
        }
      }
    } catch (e: any) {
      console.error(`[stuck-detector] tool_call failed: ${e.message}`);
    }
  });

  // Inject stuck directive into messages before LLM (one-shot consume).
  pi.on("context", async (event) => {
    try {
      const sessionID = currentSessionID || "default";
      const sp = sessionSignalPath(sessionID);
      if (!existsSync(sp)) return;

      if (!isSignalFresh(sp, SIGNAL_TTL_MS)) {
        try {
          unlinkSync(sp);
        } catch {
          // ignore
        }
        try {
          if (existsSync(GLOBAL_SIGNAL_FILE)) {
            const raw = readFileSync(GLOBAL_SIGNAL_FILE, "utf-8");
            const parsed = JSON.parse(raw);
            if (parsed && parsed.sessionID === sessionID) {
              unlinkSync(GLOBAL_SIGNAL_FILE);
            }
          }
        } catch {
          // ignore
        }
        return;
      }

      let signal: any;
      try {
        signal = JSON.parse(readFileSync(sp, "utf-8"));
      } catch {
        return;
      }
      if (!signal || !signal.stuck) return;

      const messages = event.messages as AgentMessage[];
      if (!messages || messages.length === 0) return;
      const lastMessage = messages[messages.length - 1];
      if (!lastMessage || !Array.isArray((lastMessage as any).content)) return;

      const directive =
        `⚠️ STUCK-PATTERN CHECK (type: ${signal.type}): ${signal.detail}\n` +
        `Self-check FIRST: are you actually repeating the same action with no progress? ` +
        `If you are making progress (different files or patterns, results changing between calls, sequential successful steps), ` +
        `CONTINUE your task normally — this is a false positive and the signal clears on your next successful step.\n` +
        `If genuinely stuck: STOP repeating the flagged call. Summarize what you have tried and the current blocker. ` +
        `If you are the PRIMARY agent (including glitch-omni), deliver your findings to the user and wait for direction. ` +
        `Only load skill("breakthrough") if you have genuinely exhausted your current approach.`;

      const content = (lastMessage as any).content as Array<{ type: string; text?: string }>;
      const lastPart = content[content.length - 1];
      if (lastPart && lastPart.type === "text" && typeof lastPart.text === "string") {
        lastPart.text += `\n\n${directive}`;
      } else {
        content.push({ type: "text", text: directive } as TextContent);
      }

      // Consume the signal so it isn't re-injected every message (one-shot),
      // and remember the write so the same type won't re-fire within the
      // cooldown window.
      try {
        unlinkSync(sp);
      } catch {
        // ignore
      }
      lastSignalAt.set(`${sessionID}|${signal.type}`, Date.now());

      console.log(`[stuck-detector] injected stuck directive for session ${sessionID}`);
    } catch (e: any) {
      console.error(`[stuck-detector] context inject failed: ${e.message}`);
    }
  });
}
