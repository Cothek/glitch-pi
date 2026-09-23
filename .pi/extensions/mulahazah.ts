/**
 * mulahazah.ts — Pi extension: per-session memory trigger (Phase 1 port)
 *
 * Ported from glitch-ai .opencode/plugins/mulahazah.js (627 ln) → Pi ExtensionAPI.
 * Formats UNCHANGED (Plan 2 Phase 1 contract):
 *   data/MEMORY_TRIGGER_FLAG.<sessionID>  — short text summary, deleted after dispatch
 *   data/mulahazah/state.json             — per-session map keyed by sessionID
 *   data/mulahazah/observations.jsonl     — append-only tool-call log
 *
 * Trigger model (same as OpenCode plugin, Troy 2026-08-19):
 *   1. HEARTBEAT (15 min): background timer every 60s; fires once 15 min after
 *      last write IF activity (or always at quiet-session mark — session-end capture).
 *   2. TOKEN BURST (1M new tokens): SKIPPED in this port — OpenCode SQLite session
 *      table not available under Pi. Revisit when Pi exposes token totals per session.
 *   3. TRIGGER PHRASES: immediate fire on tool-arg scan (5-min cooldown).
 *   4. 24h stale reset + startup orphan-flag sweep + 24h flag TTL sweep.
 *
 * Consumption: OpenCode used experimental.chat.messages.transform to inject into
 * last message.parts. Pi equivalent: `context` event (mutates messages before LLM).
 * Directive text copied verbatim from OpenCode plugin (P0-1 gate + P1-2 hardening).
 *
 * Flag-capable gate: OpenCode checked DB agent column / successful task() dispatch.
 * Pi has no task() tool and no opencode.db — this port treats ALL primary sessions
 * as flag-capable (glitch-omni self-fulfillment is the default Pi posture per
 * Plan 2). Sub-agent concern does not apply: Pi extensions run in one process /
 * one session; there is no dispatch fan-out. If multi-session emerges later,
 * re-gate via sessionManager metadata.
 *
 * Load: placed in glitch-pi/.pi/extensions/mulahazah.ts (project extensions path
 * per configuration.md). Dev: pi --extension ./mulahazah.ts
 *
 * Install note (Plan 2 A12.3): no timers in factory — heartbeat starts on session_start.
 */

import { promises as fs, readFileSync, writeFileSync, statSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionAPI, AgentMessage, TextContent } from "@earendil-works/pi-coding-agent";

// --- Constants (mirrors scripts/lib/mulahazah-helpers.mjs) ---
const HEARTBEAT_INTERVAL_MS = 15 * 60 * 1000; // 15 min (Troy 2026-08-19)
const TIMER_CHECK_MS = 60 * 1000;              // 60s tick
const COOLDOWN_MS = 5 * 60 * 1000;             // phrase-trigger cooldown
const STALE_RESET_MS = 24 * 60 * 60 * 1000;    // 24h stale reset
const FLAG_TTL_MS = 24 * 60 * 60 * 1000;       // flag TTL sweep
const OBSERVATIONS_MAX_BYTES = 5 * 1024 * 1024;
const OBSERVATIONS_MAX_LINES = 1000;

const TRIGGER_PHRASES = [
  "remember that",
  "i prefer",
  "from now on",
  "always do",
  "never do",
  "i want",
  "make sure to",
  "don't forget",
];

const HEARTBEAT_TIMER_KEY = "__mulahazah_heartbeat_timer__";

interface SessionEntry {
  sessionStartTime: number;
  lastTriggerTime: number | null;
  lastActivityTime: number | null;
  toolCallCount: number;
  toolCounts: Record<string, number>;
  agent: string | null;
  isDispatcher: boolean;
}

function createSessionEntry(now = Date.now()): SessionEntry {
  return {
    sessionStartTime: now,
    lastTriggerTime: null,
    lastActivityTime: now,
    toolCallCount: 0,
    toolCounts: {},
    agent: null,
    isDispatcher: true, // Pi primary sessions are flag-capable (see header)
  };
}

function formatToolCounts(counts: Record<string, number>): string {
  const parts = Object.entries(counts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 8)
    .map(([k, v]) => `${k}=${v}`);
  return parts.length ? parts.join(", ") : "(none)";
}

function formatDuration(ms: number): string {
  const m = Math.floor(ms / 60000);
  if (m < 60) return `${m}min`;
  const h = Math.floor(m / 60);
  return `${h}h${m % 60}m`;
}

export default function (pi: ExtensionAPI) {
  // Resolve data dir from cwd (glitch-pi root) — matches OpenCode `directory` semantics.
  let dataDir = join(process.cwd(), "data");
  let mulahazahDir = join(dataDir, "mulahazah");
  let stateFile = join(mulahazahDir, "state.json");
  let observationsFile = join(mulahazahDir, "observations.jsonl");

  const sessionStates = new Map<string, SessionEntry>();
  let currentSessionID: string | null = null;

  function triggerFlagPath(sessionID: string) {
    return join(dataDir, `MEMORY_TRIGGER_FLAG.${sessionID}`);
  }

  function getSessionState(sessionID: string): SessionEntry {
    if (!sessionStates.has(sessionID)) {
      sessionStates.set(sessionID, createSessionEntry());
    }
    return sessionStates.get(sessionID)!;
  }

  async function saveState() {
    try {
      const now = Date.now();
      for (const [sid, entry] of sessionStates) {
        const lastActivity = entry.lastActivityTime ?? entry.sessionStartTime;
        if (now - lastActivity > STALE_RESET_MS) {
          sessionStates.delete(sid);
          try {
            await fs.unlink(triggerFlagPath(sid));
          } catch (e: any) {
            if (e?.code !== "ENOENT") {
              console.warn(`[mulahazah] Failed to delete stale flag for session ${sid}: ${e.message}`);
            }
          }
        }
      }
      const obj = Object.fromEntries(sessionStates);
      const tmpFile = stateFile + ".tmp";
      await fs.writeFile(tmpFile, JSON.stringify(obj, null, 2), "utf8");
      await fs.rename(tmpFile, stateFile);
    } catch (err: any) {
      console.error(`[mulahazah] Failed to save state: ${err.message}`);
    }
  }

  async function appendObservation(tool: string, sessionID: string) {
    try {
      const entry = {
        ts: new Date().toISOString(),
        tool,
        sessionID: sessionID || "unknown",
      };
      await fs.appendFile(observationsFile, JSON.stringify(entry) + "\n", "utf8");
      try {
        const stat = statSync(observationsFile);
        if (stat.size > OBSERVATIONS_MAX_BYTES) {
          const content = readFileSync(observationsFile, "utf8");
          const lines = content.split("\n").filter((l) => l.length > 0);
          const kept = lines.slice(-OBSERVATIONS_MAX_LINES);
          writeFileSync(observationsFile, kept.join("\n") + "\n", "utf8");
        }
      } catch {
        // best-effort truncation
      }
    } catch (err: any) {
      console.error(`[mulahazah] Failed to append observation: ${err.message}`);
    }
  }

  function buildTriggerSummary(sessionState: SessionEntry, reason: string): string {
    return [
      `Mulahazah memory trigger: ${reason}.`,
      `Tool calls since last write: ${sessionState.toolCallCount}. Tool breakdown: ${formatToolCounts(sessionState.toolCounts)}`,
      `Session window since last write: ${formatDuration(Date.now() - (sessionState.lastTriggerTime ?? sessionState.sessionStartTime))}.`,
      `Trigger @memory to record session observations (or self-fulfill per your mode).`,
    ].join("\n");
  }

  function buildPhraseSummary(phrase: string, sessionState: SessionEntry): string {
    const anchor = sessionState.lastTriggerTime ?? sessionState.sessionStartTime;
    const elapsed = Date.now() - anchor;
    return [
      `Mulahazah trigger phrase detected: "${phrase}"`,
      `Tool calls since last trigger: ${sessionState.toolCallCount}`,
      `Session window: ${formatDuration(elapsed)}`,
      `Trigger @memory to record this preference/decision.`,
    ].join("\n");
  }

  function isCooldownElapsed(sessionState: SessionEntry): boolean {
    if (sessionState.lastTriggerTime === null) return true;
    return Date.now() - sessionState.lastTriggerTime >= COOLDOWN_MS;
  }

  function detectTriggerPhrase(args: unknown): string | null {
    if (!args) return null;
    let argStr: string;
    try {
      if (typeof args === "string") {
        argStr = args;
      } else {
        argStr = JSON.stringify(args);
      }
      if (argStr.length > 2000) {
        argStr = argStr.substring(0, 2000);
      }
    } catch {
      return null;
    }
    const lower = argStr.toLowerCase();
    for (const phrase of TRIGGER_PHRASES) {
      if (lower.includes(phrase)) return phrase;
    }
    return null;
  }

  async function fireTrigger(sessionID: string, summary: string) {
    try {
      const ss = sessionStates.get(sessionID);
      if (!ss) return;

      ss.lastTriggerTime = Date.now();
      ss.toolCallCount = 0;
      ss.toolCounts = {};

      const flagPath = triggerFlagPath(sessionID);
      await fs.writeFile(flagPath, summary + "\n", "utf8");
      await saveState();
      if (process.env.MULAHAZAH_DEBUG) {
        console.log(`[mulahazah] trigger fired for session ${sessionID}, flag written`);
      }
    } catch (err: any) {
      console.error(`[mulahazah] Failed to write trigger flag: ${err.message}`);
    }
  }

  async function sweepStaleFlags() {
    try {
      const entries = await fs.readdir(dataDir);
      const now = Date.now();
      for (const name of entries) {
        if (!name.startsWith("MEMORY_TRIGGER_FLAG.")) continue;
        const flagPath = join(dataDir, name);
        try {
          const st = await fs.stat(flagPath);
          if (now - st.mtimeMs > FLAG_TTL_MS) {
            await fs.unlink(flagPath);
            if (process.env.MULAHAZAH_DEBUG) {
              console.log(`[mulahazah] TTL sweep: deleted stale flag ${name}`);
            }
          }
        } catch (err: any) {
          if (err.code !== "ENOENT") {
            console.error(`[mulahazah] TTL sweep: failed to process ${name}: ${err.message}`);
          }
        }
      }
    } catch (err: any) {
      if (err.code !== "ENOENT") {
        console.error(`[mulahazah] TTL sweep failed: ${err.message}`);
      }
    }
  }

  async function runHeartbeatCheck() {
    await sweepStaleFlags();
    const now = Date.now();
    let dirty = false;
    for (const [sid, ss] of sessionStates) {
      if (!ss) continue;
      const lastActivity = ss.lastTriggerTime ?? ss.sessionStartTime;
      if (now - lastActivity > STALE_RESET_MS) continue;

      // Heartbeat: fire if HEARTBEAT_INTERVAL_MS elapsed since last write.
      // Quiet sessions get their session-end capture here too (always fires at mark).
      if (ss.lastTriggerTime !== null && now - lastActivity >= HEARTBEAT_INTERVAL_MS) {
        if (isCooldownElapsed(ss)) {
          await fireTrigger(sid, buildTriggerSummary(ss, "heartbeat"));
          dirty = true;
        }
      } else if (ss.lastTriggerTime === null && now - ss.sessionStartTime >= HEARTBEAT_INTERVAL_MS) {
        // First write never happened; session-end capture at 15 min mark.
        if (isCooldownElapsed(ss)) {
          await fireTrigger(sid, buildTriggerSummary(ss, "session-end heartbeat"));
          dirty = true;
        }
      }
    }
    if (dirty) await saveState();
  }

  function startHeartbeatTimer() {
    if ((globalThis as any)[HEARTBEAT_TIMER_KEY]) return;
    (globalThis as any)[HEARTBEAT_TIMER_KEY] = setInterval(() => {
      runHeartbeatCheck().catch((err) =>
        console.error(`[mulahazah] heartbeat check failed: ${err.message}`)
      );
    }, TIMER_CHECK_MS);
    if ((globalThis as any)[HEARTBEAT_TIMER_KEY].unref) {
      (globalThis as any)[HEARTBEAT_TIMER_KEY].unref();
    }
    if (process.env.MULAHAZAH_DEBUG) {
      console.log(`[mulahazah] heartbeat timer started (${TIMER_CHECK_MS}ms cadence)`);
    }
  }

  // Load persisted state (called async after dirs ready — factory must not block).
  async function loadState() {
    try {
      await fs.mkdir(mulahazahDir, { recursive: true });
    } catch (err: any) {
      console.error(`[mulahazah] Failed to create directory: ${err.message}`);
    }

    try {
      const raw = await fs.readFile(stateFile, "utf8");
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        const now = Date.now();
        for (const [sid, rawEntry] of Object.entries(parsed as Record<string, SessionEntry>)) {
          const e = rawEntry;
          if (e.lastTriggerTime !== null && now - e.lastTriggerTime > STALE_RESET_MS) {
            e.toolCallCount = 0;
            e.toolCounts = {};
          }
          if (now - e.sessionStartTime > STALE_RESET_MS) {
            e.toolCallCount = 0;
            e.toolCounts = {};
            e.sessionStartTime = now;
            e.lastTriggerTime = null;
          }
          e.isDispatcher = true; // force flag-capable on load (Pi primary)
          sessionStates.set(sid, e);
        }
      }
    } catch (err: any) {
      if (err.code !== "ENOENT") {
        console.error(`[mulahazah] Failed to load state: ${err.message}`);
      }
    }

    // Startup orphan-flag sweep (P1-3)
    try {
      const entries = await fs.readdir(dataDir);
      const now = Date.now();
      for (const name of entries) {
        if (!name.startsWith("MEMORY_TRIGGER_FLAG.")) continue;
        const sid = name.slice("MEMORY_TRIGGER_FLAG.".length);
        if (!sid) continue;
        const flagPath = join(dataDir, name);
        let stale = !sessionStates.has(sid);
        if (!stale) {
          try {
            const st = await fs.stat(flagPath);
            if (now - st.mtimeMs > STALE_RESET_MS) stale = true;
          } catch {
            stale = true;
          }
        }
        if (stale) {
          try {
            await fs.unlink(flagPath);
          } catch {
            // ignore
          }
        }
      }
    } catch {
      // ignore
    }
  }

  // --- Event wiring ---

  pi.on("session_start", async (_event, ctx) => {
    // Prefer ctx session id if available; fallback to stable "default".
    const sid =
      (ctx as any).sessionID ||
      (ctx as any).sessionId ||
      (ctx.sessionManager as any)?.sessionId ||
      (ctx.sessionManager as any)?.id ||
      "default";
    currentSessionID = String(sid);
    getSessionState(currentSessionID);

    await loadState();
    startHeartbeatTimer();

    if (process.env.MULAHAZAH_DEBUG && ctx.hasUI) {
      ctx.ui.notify(`[mulahazah] active session=${currentSessionID}`, "info");
    }
  });

  pi.on("tool_execution_end", async (event) => {
    const sessionID = currentSessionID || "default";
    const tool = event.toolName || "unknown";

    const ss = getSessionState(sessionID);
    ss.toolCallCount++;
    ss.toolCounts[tool] = (ss.toolCounts[tool] || 0) + 1;
    ss.lastActivityTime = Date.now();

    appendObservation(tool, sessionID).catch((err) =>
      console.error(`[mulahazah] background task failed: ${err.message}`)
    );

    if (!isCooldownElapsed(ss)) {
      if (ss.toolCallCount % 10 === 0) {
        await saveState();
      }
      return;
    }

    // Phrase scan on tool args (matches OpenCode tool.execute.after scan)
    const phrase = detectTriggerPhrase(event.args ?? (event as any).input);
    if (phrase) {
      if (process.env.MULAHAZAH_DEBUG) {
        console.log(`[mulahazah] trigger phrase detected: "${phrase}" in session ${sessionID}`);
      }
      await fireTrigger(sessionID, buildPhraseSummary(phrase, ss));
      return;
    }

    if (ss.toolCallCount % 10 === 0) {
      await saveState();
    }
  });

  // Inject flag directive into messages before LLM (Pi equivalent of
  // experimental.chat.messages.transform). One-shot: read flag, append
  // synthetic text to last message's text content, delete flag after inject.
  pi.on("context", async (event) => {
    const sessionID = currentSessionID || "default";
    const flagPath = triggerFlagPath(sessionID);

    let flagContent: string;
    try {
      flagContent = await fs.readFile(flagPath, "utf8");
    } catch (err: any) {
      if (err.code === "ENOENT") return;
      throw err;
    }
    if (!flagContent || !flagContent.trim()) return;

    const messages = event.messages as AgentMessage[];
    if (!messages || messages.length === 0) return;

    const lastMessage = messages[messages.length - 1];
    if (!lastMessage || !Array.isArray((lastMessage as any).content)) return;

    const directive =
      `[MEMORY TRIGGER PENDING] data/MEMORY_TRIGGER_FLAG.${sessionID} exists:\n` +
      `---\n${flagContent.trim()}\n---\n` +
      `⚠️ IMPORTANT: If you are a SUB-AGENT and CANNOT call task()/@memory (task denied): DO NOT attempt to dispatch. Do NOT try to delete this flag with file tools if you cannot. Instead, include any notable observations in your final report to the parent agent, then continue your task normally.\n` +
      `If you CAN dispatch: dispatch @memory to record session observations, then delete the flag file (data/MEMORY_TRIGGER_FLAG.${sessionID}).\n` +
      `If you are glitch-omni (self-fulfillment mode, task denied but memory-capable): record the observations yourself per the save-memory skill, then delete the flag file (data/MEMORY_TRIGGER_FLAG.${sessionID}).`;

    const content = (lastMessage as any).content as Array<{ type: string; text?: string }>;
    const lastPart = content[content.length - 1];
    if (lastPart && lastPart.type === "text" && typeof lastPart.text === "string") {
      lastPart.text += `\n\n${directive}`;
    } else {
      content.push({ type: "text", text: directive } as TextContent);
    }

    // Consume the flag so it injects once (same as OpenCode: flag deleted by
    // consumer after write, but defensive one-shot here too).
    try {
      await fs.unlink(flagPath);
    } catch {
      // ignore ENOENT
    }

    if (process.env.MULAHAZAH_DEBUG) {
      console.log(`[mulahazah] injected memory trigger directive for session ${sessionID}`);
    }
  });

  pi.on("session_shutdown", async () => {
    await saveState();
    const t = (globalThis as any)[HEARTBEAT_TIMER_KEY];
    if (t) {
      clearInterval(t);
      delete (globalThis as any)[HEARTBEAT_TIMER_KEY];
    }
  });
}
