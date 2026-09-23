/**
 * stuck-detector.ts — Pi extension: detects stuck patterns in tool calls
 * Ported from glitch-ai .opencode/plugins/stuck-detector.js (544 ln) → Pi ExtensionAPI.
 *
 * Formats UNCHANGED (Plan 2 Phase 1 contract):
 *   data/.stuck-signal.<sessionID>.json  — per-session signal
 *   data/.stuck-signal.json              — global mirror (most recent active; R21)
 *
 * Detection rules (per session) — IDENTICAL to OpenCode plugin:
 *   1. tool_repetition: 3+ same tool (excluding progress tools) with >75%-similar
 *      args in last 8. Excluded: edit, write, bash, read, glob, grep, task,
 *      todowrite, skill, question. webfetch: exact-URL, threshold 5.
 *   2. error_cascade: 3+ consecutive errors (invalid counts as an error)
 *   3. command_repetition: same bash command 5+ times in last 8 (first 60 chars).
 *      Clock/time commands EXCLUDED (Get-Date, date, time, w32tm, etc.).
 *   4. readonly_repetition: 6+ CONSECUTIVE same readonly tool (read/glob/grep)
 *      with IDENTICAL fingerprints. Different files/patterns NEVER count.
 *   5. permission_loop: 2+ consecutive "invalid" tool calls (denied dispatch)
 *
 * Similarity: read/glob exact filePath; grep exact pattern; webfetch exact URL;
 * task fingerprint subagent_type+description; generic JSON.slice(0,80) >0.75.
 *
 * Unstuck (clear signal) ONLY on genuine progress by THAT session:
 *   successful write / edit / bash(git commit) / task / todowrite.
 *   Never clear on read/glob/grep.
 *
 * Signal freshness: SIGNAL_TTL_MS = 15 min. Sweep on init.
 * Injection: Pi `context` event appends directive to last message (one-shot,
 * flag deleted after inject — mirrors OpenCode transform+consume).
 *
 * Pi tool mapping:
 *   OpenCode tool.execute.after → Pi tool_execution_end
 *   OpenCode tool.execute.before → Pi tool_call (pre, for bash-repetition warn)
 *   OpenCode experimental.chat.messages.transform → Pi context
 *
 * Progress tools note: Pi has no `task` tool by default; keep `task` in
 * PROGRESS_TOOLS set for forward-compat if subagent extension registers it.
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

// --- Pure helpers (verbatim from stuck-detector.js) ---

function levenshtein(a: string, b: string): number {
  const m = a.length;
  const n = b.length;
  const dp: number[][] = Array.from({ length: m + 1 }, () => Array(n + 1).fill(0));
  for (let i = 0; i <= m; i++) dp[i][0] = i;
  for (let j = 0; j <= n; j++) dp[0][j] = j;
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      dp[i][j] = a[i - 1] === b[j - 1] ? dp[i - 1][j - 1] : 1 + Math.min(dp[i - 1][j], dp[i][j - 1], dp[i - 1][j - 1]);
    }
  }
  return dp[m][n];
}

function genericFingerprint(args: any): string {
  if (!args) return "";
  try {
    return JSON.stringify(args).slice(0, 80);
  } catch {
    return "";
  }
}

function toolFingerprint(tool: string, args: any): string {
  if (!args) return "";
  if (tool === "read" || tool === "glob" || tool === "find") {
    return args.filePath || args.path || "";
  }
  if (tool === "grep") {
    return args.pattern || "";
  }
  if (tool === "webfetch") {
    return args.url || "";
  }
  if (tool === "task") {
    const subagent = args.subagent_type || args.subagent || "";
    const desc = args.description || "";
    if (subagent || desc) return `${subagent}|${desc}`.slice(0, 80);
    return (args.prompt || "").trim().slice(0, 40);
  }
  return genericFingerprint(args);
}

const EXACT_FINGERPRINT_TOOLS = new Set(["read", "glob", "grep", "webfetch", "find"]);

function readonlyFingerprintsMatch(_tool: string, fp1: string, fp2: string): boolean {
  if (!fp1 && !fp2) return true;
  if (!fp1 || !fp2) return false;
  return fp1 === fp2;
}

function genericSimilar(a: string, b: string, threshold: number): boolean {
  if (!a && !b) return true;
  if (!a || !b) return false;
  if (a === b) return true;
  const maxLen = Math.max(a.length, b.length);
  if (maxLen === 0) return true;
  return 1 - levenshtein(a, b) / maxLen > threshold;
}

function isClockCommand(cmd: unknown): boolean {
  if (typeof cmd !== "string") return false;
  const trimmed = cmd.trim();
  if (/^(Get-Date|date|time|w32tm|hwclock|timedatectl|ntpdate)(\s|$)/i.test(trimmed)) return true;
  if (/\[DateTimeOffset\]|\[DateTime\]|Get-Date|\.ToUniversalTime\(|\.ToLocalTime\(|GetSystemTime|GetTickCount/i.test(trimmed)) return true;
  return false;
}

const PROGRESS_TOOLS = new Set([
  "edit",
  "write",
  "bash",
  "read",
  "glob",
  "grep",
  "task",
  "todowrite",
  "skill",
  "question",
  "find",
  "ls",
  "powershell",
]);

const READONLY_TOOLS = new Set(["read", "glob", "grep", "find"]);

const TOOL_REPETITION_THRESHOLDS: Record<string, number> = {
  webfetch: 5,
};

interface HistoryEntry {
  tool: string;
  args: any;
  error: boolean;
  timestamp: number;
}

interface StuckSignal {
  type: string;
  tool?: string;
  command?: string;
  count?: number;
  similarCalls?: number;
  detail: string;
}

function detectStuck(history: HistoryEntry[], options: Record<string, number> = {}): StuckSignal | null {
  const STUCK_THRESHOLD = options.STUCK_THRESHOLD ?? 3;
  const ERROR_THRESHOLD = options.ERROR_THRESHOLD ?? 3;
  const READONLY_THRESHOLD = options.READONLY_THRESHOLD ?? 6;
  const INVALID_THRESHOLD = options.INVALID_THRESHOLD ?? 2;
  const GENERIC_SIMILARITY_THRESHOLD = options.GENERIC_SIMILARITY_THRESHOLD ?? 0.75;

  if (history.length < 4) return null;

  const recent = history.slice(-8);

  // Check 5 (priority): permission_loop — 2+ consecutive denied calls.
  const tail = history.slice(-INVALID_THRESHOLD);
  if (
    tail.length >= INVALID_THRESHOLD &&
    tail.every((e) => {
      const t = e.tool || "";
      if (t === "invalid") return true;
      if (t === "task" && e.error) return true;
      return false;
    })
  ) {
    return {
      type: "permission_loop",
      count: tail.length,
      detail: `${tail.length} consecutive denied tool calls. The agent is repeatedly attempting tools it is not allowed to use, or a denied dispatch (task) attempt.`,
    };
  }

  // Check 1: tool_repetition — 3+ same non-excluded tool with similar args
  const toolCounts: Record<string, number> = {};
  const toolFps: Record<string, string[]> = {};
  for (const entry of recent) {
    const tool = entry.tool || "unknown";
    if (PROGRESS_TOOLS.has(tool)) continue;
    toolCounts[tool] = (toolCounts[tool] || 0) + 1;
    if (!toolFps[tool]) toolFps[tool] = [];
    const fp = toolFingerprint(tool, entry.args);
    if (fp) toolFps[tool].push(fp);
  }

  for (const [tool, count] of Object.entries(toolCounts)) {
    const threshold = TOOL_REPETITION_THRESHOLDS[tool] ?? STUCK_THRESHOLD;
    if (count < threshold) continue;
    const fps = toolFps[tool] || [];
    if (fps.length < threshold) continue;

    const useExact = EXACT_FINGERPRINT_TOOLS.has(tool);
    let similarCount = 0;
    for (let i = 0; i < fps.length; i++) {
      for (let j = i + 1; j < fps.length; j++) {
        const similar = useExact
          ? readonlyFingerprintsMatch(tool, fps[i], fps[j])
          : genericSimilar(fps[i], fps[j], GENERIC_SIMILARITY_THRESHOLD);
        if (similar) similarCount++;
      }
    }
    if (similarCount >= 1) {
      return {
        type: "tool_repetition",
        tool,
        count,
        similarCalls: similarCount + 1,
        detail: `${tool} called ${count} times in last ${recent.length} calls with similar arguments`,
      };
    }
  }

  // Check 4: readonly_repetition — 6+ CONSECUTIVE same readonly tool, ALL with
  // fingerprints identical to the FIRST call.
  const tailN = history.slice(-READONLY_THRESHOLD);
  if (tailN.length >= READONLY_THRESHOLD) {
    const tool = tailN[0].tool || "";
    if (READONLY_TOOLS.has(tool) && tailN.every((e) => (e.tool || "") === tool)) {
      const firstFp = toolFingerprint(tool, tailN[0].args);
      const allMatchFirst = tailN.every((e) => {
        const fp = toolFingerprint(tool, e.args);
        return readonlyFingerprintsMatch(tool, firstFp, fp);
      });
      if (allMatchFirst) {
        return {
          type: "readonly_repetition",
          tool,
          count: tailN.length,
          detail: `${tool} called ${tailN.length} consecutive times with identical arguments (tight read-only loop)`,
        };
      }
    }
  }

  // Check 2: error_cascade — 3+ consecutive errors
  const lastFew = recent.slice(-ERROR_THRESHOLD);
  if (lastFew.length >= ERROR_THRESHOLD && lastFew.every((e) => e.error)) {
    return {
      type: "error_cascade",
      count: lastFew.length,
      detail: `${lastFew.length} consecutive tool calls returned errors`,
    };
  }

  // Check 3: command_repetition — same bash command 5+ times.
  const bashCommands = recent.filter((e) => e.tool === "bash" || e.tool === "powershell");
  if (bashCommands.length >= 5) {
    const cmdTexts = bashCommands.map((e) => e.args?.command || "");
    const cmdCounts: Record<string, number> = {};
    for (const cmd of cmdTexts) {
      if (isClockCommand(cmd)) continue;
      const shortCmd = String(cmd).slice(0, 60);
      cmdCounts[shortCmd] = (cmdCounts[shortCmd] || 0) + 1;
    }
    for (const [cmd, count] of Object.entries(cmdCounts)) {
      if (count >= 5 && cmd.length > 5) {
        return {
          type: "command_repetition",
          command: cmd.slice(0, 80),
          count,
          detail: `bash command "${cmd.slice(0, 60)}..." repeated ${count} times`,
        };
      }
    }
  }

  return null;
}

const SIGNAL_TTL_MS = 15 * 60 * 1000;

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

  function writeSignal(sessionID: string, signal: StuckSignal): void {
    try {
      const payload = {
        detected_at: new Date().toISOString(),
        stuck: true,
        sessionID,
        type: signal.type,
        detail: signal.detail,
        tool: signal.tool || signal.command || "unknown",
        recommendation: 'You appear to be stuck in a loop. Load skill("breakthrough") to reframe the problem using a different approach.',
      };
      const content = JSON.stringify(payload, null, 2);

      writeFileSync(sessionSignalPath(sessionID), content, "utf-8");
      writeFileSync(GLOBAL_SIGNAL_FILE, content, "utf-8");

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

  function isGenuineProgress(tool: string, args: any, hasError: boolean): boolean {
    if (hasError) return false;
    if (tool === "write" || tool === "edit") return true;
    if (tool === "task") return true;
    if (tool === "todowrite") return true;
    if (tool === "bash" || tool === "powershell") {
      const cmd = args?.command || "";
      if (typeof cmd === "string" && /\bgit\s+commit\b/.test(cmd)) return true;
    }
    return false;
  }

  // --- Event wiring ---

  pi.on("session_start", async (_event, ctx) => {
    const sid =
      (ctx as any).sessionID ||
      (ctx as any).sessionId ||
      (ctx.sessionManager as any)?.sessionId ||
      (ctx.sessionManager as any)?.id ||
      "default";
    currentSessionID = String(sid);
    getHistory(currentSessionID);
  });

  // Post-tool: build history, detect, clear on progress.
  pi.on("tool_execution_end", async (event) => {
    try {
      const now = Date.now();
      const tool = event.toolName || "unknown";
      const args = (event as any).args ?? (event as any).input ?? {};
      const sessionID = currentSessionID || "default";

      const hasError = Boolean(event.isError);

      const history = getHistory(sessionID);
      history.push({
        tool,
        args,
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
        if (signal && !existsSync(sessionSignalPath(sessionID))) {
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
        const recentBash = history.filter((e) => e.tool === "bash" || e.tool === "powershell").slice(-3);
        const similarCmd = recentBash.some((e) => {
          const prevCmd = e.args?.command || "";
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
        `⚠️ STUCK DETECTED (type: ${signal.type}): ${signal.detail}\n` +
        `If you are a SUB-AGENT: pause and check — are you repeating the SAME failing action with no progress? ` +
        `If yes (genuinely stuck), stop and return partial findings plus a note about this blocker to the parent agent. ` +
        `If you are making progress (e.g., reading different files, dispatching different tasks, sequential successful steps), ` +
        `this is likely a false positive — CONTINUE your task normally.\n` +
        `If you are the PRIMARY agent (including glitch-omni, which is primary AND executor): STOP. ` +
        `Do NOT re-run the flagged command or tool. Deliver your current findings to the user now and wait for direction. ` +
        `In glitch-omni mode there is no parent agent to return to — the loop ends with you. ` +
        `Only load skill("breakthrough") if you have genuinely exhausted your current approach.`;

      const content = (lastMessage as any).content as Array<{ type: string; text?: string }>;
      const lastPart = content[content.length - 1];
      if (lastPart && lastPart.type === "text" && typeof lastPart.text === "string") {
        lastPart.text += `\n\n${directive}`;
      } else {
        content.push({ type: "text", text: directive } as TextContent);
      }

      // Consume the signal so it isn't re-injected every message (matches OpenCode one-shot).
      try {
        unlinkSync(sp);
      } catch {
        // ignore
      }

      console.log(`[stuck-detector] injected stuck directive for session ${sessionID}`);
    } catch (e: any) {
      console.error(`[stuck-detector] context inject failed: ${e.message}`);
    }
  });
}
