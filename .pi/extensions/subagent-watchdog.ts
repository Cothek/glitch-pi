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
 *      - Spawn results → extractSpawnInfo on the ack TEXT (first-line verb
 *        anchor; isError results are skipped so echoed error dumps cannot
 *        seed phantom entries), recordSpawn
 *      - get_result (args.runId) AND wait_all (args.runIds array, fallback:
 *        all active keys) → per-entry resolveEntryKey + per-run
 *        extractRunStatus from the collected header lines → recordObservation
 *        (done/error deactivate the entry immediately)
 *      - stop → resolveEntryKey, mark stopped
 *   3. setInterval (2 min) calls evaluate() → writes directive file
 *   4. `context` event: if directive file exists, validates directives
 *      against ACTIVE state entries (filterLiveDirectives, same at init),
 *      appends surviving directive text to last message, deletes file
 *      (one-shot). Nothing surviving → file deleted without injecting.
 *
 * CONSTRAINT: this extension NEVER calls the host's subagent tool. It only
 * detects + writes directives. Glitch acts on them.
 *
 * STATE ROOT: resolveStateDir() with GLITCH_WATCHDOG_STATE_DIR env override;
 * default join(glitchRoot(), "data"). process.cwd() was the 2026-10-03
 * two-root incident class — a pi launched from another folder reads/writes a
 * different state file than the one the running session uses.
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
  extractSpawnInfo,
  extractRunStatus,
  resolveEntryKey,
  filterLiveDirectives,
  type WatchdogState,
  type WatchdogDirective,
  type WatchdogDirectiveFile,
} from "../lib/subagent-watchdog-logic.mts";
import { glitchRoot } from "../lib/root.mjs";

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
  // 2026-10-03 incident class: never root state at process.cwd(). Same fix
  // as routing.ts — git checkout 07b0343 of this file regressed it to cwd
  // and is restored here.
  const dataDir = resolveStateDir();
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

  // Remove stale directive file on init (leftover from a crash), after
  // validating its directives against live entries — stale entries' files
  // are deleted outright; partially stale files are written back reduced.
  pruneDirectiveFile(DIRECTIVE_FILE, state);

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

      // --- Spawn: parse runId from the ack text, record in state ---
      if (SPAWN_ACTIONS.has(action) || tool === "delegate_task") {
        // Skip failed executions: a delegate_task that fails schema
        // validation echoes its arguments JSON in the error result, and
        // that JSON can quote a fixture ack ("Delegated: sa-xxxx") —
        // parsing it seeds a phantom entry (live incident, this fix).
        if ((event as any).isError) return;
        const info = extractSpawnInfo(resultText);
        if (info) {
          const template =
            info.template ??
            String(args.template ?? args.agent ?? args.type ?? "unknown");
          recordSpawn(state, info.runId, template, Date.now());
          safeWriteJson(STATE_FILE, state);
        }
        return;
      }

      // --- Observe: get_result / wait_all → update observations ---
      // wait_all passes runIds (array); get_result passes runId. For each
      // run, resolve the live entry key (collected text truncates ids to
      // 8 chars), parse per-run status from the collected header line, and
      // record an observation — done/error deactivate the entry so finished
      // agents stop accruing "silent for Xm".
      if (OBSERVE_ACTIONS.has(action)) {
        const explicitStatus = extractStatusFromResult(event.result);
        const rawIds: string[] = [];
        if (typeof args.runId === "string" && args.runId) {
          rawIds.push(args.runId);
        }
        if (Array.isArray(args.runIds)) {
          for (const id of args.runIds) {
            if (typeof id === "string" && id) rawIds.push(id);
          }
        }
        // wait_all without runIds collects everything → touch all active.
        if (rawIds.length === 0 && action === "wait_all") {
          rawIds.push(
            ...Object.values(state.entries)
              .filter((e) => e.active)
              .map((e) => e.runId),
          );
        }
        const now = Date.now();
        let changed = false;
        for (const rawId of rawIds) {
          const key = resolveEntryKey(state, rawId);
          if (!key) continue;
          const statusText =
            explicitStatus ?? extractRunStatus(resultText, key.slice(0, 8)) ??
            extractRunStatus(resultText, rawId);
          recordObservation(state, key, statusText, resultText, now);
          changed = true;
        }
        if (changed) safeWriteJson(STATE_FILE, state);
        return;
      }

      // --- Stop: mark as stopped ---
      if (action === "stop") {
        const key = resolveEntryKey(state, String(args.runId ?? ""));
        if (key) {
          recordObservation(state, key, "stopped", undefined, Date.now());
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
      const payload = safeReadJson<WatchdogDirectiveFile>(DIRECTIVE_FILE);
      if (!payload?.directives?.length) return;

      // Validate against live entries before injecting: a stale file keeps
      // re-flagging agents that finished long ago. Nothing surviving →
      // delete the file and inject nothing.
      const live = filterLiveDirectives(state, payload.directives);
      if (live.length === 0) {
        try {
          unlinkSync(DIRECTIVE_FILE);
        } catch {
          // ignore
        }
        return;
      }
      if (live.length !== payload.directives.length) {
        payload.directives = live;
        safeWriteJson(DIRECTIVE_FILE, payload);
      }

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

/**
 * State directory root. GLITCH_WATCHDOG_STATE_DIR overrides (tests,
 * side-by-side debugging). Default join(glitchRoot(), "data") — never
 * process.cwd(): the 2026-10-03 two-root incident class (see root.mjs
 * header), which routing.ts fixed and this file regressed on.
 */
export function resolveStateDir(
  env: NodeJS.ProcessEnv = process.env,
): string {
  const override = env.GLITCH_WATCHDOG_STATE_DIR;
  if (override) return override;
  return join(glitchRoot(), "data");
}

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

/**
 * Validate a directive file against live entries. All-stale or empty →
 * delete the file (it must never inject again). Partially stale → rewrite
 * with only the survivors.
 */
function pruneDirectiveFile(
  directiveFile: string,
  state: WatchdogState,
): void {
  const payload = safeReadJson<WatchdogDirectiveFile>(directiveFile);
  if (!payload?.directives?.length) {
    try {
      if (existsSync(directiveFile)) unlinkSync(directiveFile);
    } catch {
      // ignore
    }
    return;
  }
  const live = filterLiveDirectives(state, payload.directives);
  try {
    if (live.length === 0) {
      unlinkSync(directiveFile);
      return;
    }
    if (live.length !== payload.directives.length) {
      payload.directives = live;
      safeWriteJson(directiveFile, payload);
    }
  } catch {
    // ignore — a failed prune is harmless; the injection path re-validates
  }
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
