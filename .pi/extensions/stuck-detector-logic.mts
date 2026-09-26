/**
 * stuck-detector-logic.ts — Pure detection logic for the stuck-detector extension.
 * ZERO imports (erasable-syntax TS only) so both runtimes can load it:
 *   - Pi's extension loader (jiti) imports it from stuck-detector.ts
 *   - scripts/test-stuck-detector.mjs imports it via Node's native type stripping
 *
 * REFINED RULES (v2 — fixes the overzealous detector, see plan 01a0da70):
 * The v1 Pi port read args from tool_execution_end, which carries NO args, so
 * every fingerprint was the literal "{}" and ANY tool called 3x fired. v2
 * joins args via tool_execution_start (see stuck-detector.ts) and marks entries
 * whose args were never captured as argsKnown=false. Similarity-based rules
 * NEVER fire on unknown-args entries (fail-safe: unprovable similarity must not
 * signal). Error-based rules still work — isError is reliable on its own.
 *
 * Rules (per session, evaluated over the last 8 calls):
 *   1. tool_repetition: a mutually-similar CLUSTER of >= threshold calls of
 *      one non-progress tool, where the cluster includes the tool's MOST
 *      RECENT call (repetition is ongoing — the agent is still doing it).
 *      Polling/status tools (browser_page, subagent_*, conversation_read,
 *      schedule_list, todo_list) get threshold 6; webfetch 5; default 3.
 *   2. error_cascade: 4 consecutive errored calls, OR 3 consecutive errored
 *      calls of the SAME tool with IDENTICAL fingerprints (same failing
 *      attempt retried). Diverse 3-error probing does NOT fire.
 *   3. command_repetition: same bash/powershell command (first 60 chars)
 *      5+ times AND the most recent bash/powershell call is that command
 *      (ongoing). Clock commands excluded.
 *   4. readonly_repetition: 6+ CONSECUTIVE same readonly tool (read/glob/
 *      grep/find) with IDENTICAL non-empty fingerprints. Different files
 *      never count.
 *   5. permission_loop: 2+ consecutive denied/invalid calls.
 *
 * Unstuck (clear signal) ONLY on genuine progress by THAT session:
 *   successful write / edit / bash(git commit) / task / todowrite.
 */

// --- Constants ---

export const PROGRESS_TOOLS = new Set([
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

export const READONLY_TOOLS = new Set(["read", "glob", "grep", "find"]);

// Tools whose job is to fetch CURRENT state. Repeating them with similar args
// is by-design polling, not stuckness — they get the same tolerance as
// readonly_repetition (6) instead of the default 3.
export const TOOL_REPETITION_THRESHOLDS: Record<string, number> = {
  webfetch: 5,
  browser_page: 6,
  subagent_get_result: 6,
  subagent_list: 6,
  subagent_wait_all: 6,
  subagent_steer: 6,
  conversation_read: 6,
  schedule_list: 6,
  todo_list: 6,
};

// Default similarity for generic (non-exact-fingerprint) tools.
const GENERIC_SIMILARITY_THRESHOLD = 0.75;

// --- Types ---

export interface HistoryEntry {
  tool: string;
  args: any;
  /** false when args were never captured (missed tool_execution_start). */
  argsKnown?: boolean;
  error: boolean;
  timestamp: number;
}

export interface StuckSignal {
  type: string;
  tool?: string;
  command?: string;
  count?: number;
  similarCalls?: number;
  detail: string;
}

export interface DetectOptions {
  STUCK_THRESHOLD?: number;
  ERROR_THRESHOLD?: number;
  READONLY_THRESHOLD?: number;
  INVALID_THRESHOLD?: number;
  GENERIC_SIMILARITY_THRESHOLD?: number;
}

// --- Fingerprinting ---

function levenshtein(a: string, b: string): number {
  const m = a.length;
  const n = b.length;
  const dp: number[][] = Array.from({ length: m + 1 }, () => Array(n + 1).fill(0));
  for (let i = 0; i <= m; i++) dp[i][0] = i;
  for (let j = 0; j <= n; j++) dp[0][j] = j;
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      dp[i][j] = a[i - 1] === b[j - 1] ? dp[i - 1][j - 1] : 1 + Math.min(dp[i - 1][j - 1], dp[i - 1][j], dp[i][j - 1]);
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

export function toolFingerprint(tool: string, args: any): string {
  if (!args) return "";
  if (tool === "read") {
    return args.filePath || args.path || args.file_path || "";
  }
  // Pi's glob/find take `pattern` (OpenCode took a path) — support both shapes.
  if (tool === "glob" || tool === "find") {
    return args.filePath || args.path || args.pattern || "";
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

function readonlyFingerprintsMatch(fp1: string, fp2: string): boolean {
  if (!fp1 || !fp2) return false; // empty fingerprint is never "identical" (v2: "" == "" was a false positive)
  return fp1 === fp2;
}

function genericSimilar(a: string, b: string, threshold: number): boolean {
  if (!a && !b) return false; // v2: two unknown/empty fingerprints prove nothing
  if (!a || !b) return false;
  if (a === b) return true;
  const maxLen = Math.max(a.length, b.length);
  if (maxLen === 0) return false;
  return 1 - levenshtein(a, b) / maxLen > threshold;
}

function isSimilar(tool: string, fp1: string, fp2: string, threshold: number): boolean {
  if (!fp1 || !fp2) return false;
  if (EXACT_FINGERPRINT_TOOLS.has(tool)) return fp1 === fp2;
  return genericSimilar(fp1, fp2, threshold);
}

export function isClockCommand(cmd: unknown): boolean {
  if (typeof cmd !== "string") return false;
  const trimmed = cmd.trim();
  if (/^(Get-Date|date|time|w32tm|hwclock|timedatectl|ntpdate)(\s|$)/i.test(trimmed)) return true;
  if (/\[DateTimeOffset\]|\[DateTime\]|Get-Date|\.ToUniversalTime\(|\.ToLocalTime\(|GetSystemTime|GetTickCount/i.test(trimmed)) return true;
  return false;
}

/**
 * Genuine progress = a successful action that changes state. Clears a signal.
 * (v1 bug: bash git commit never matched because args were always empty.)
 */
export function isGenuineProgress(tool: string, args: any, hasError: boolean): boolean {
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

// Fingerprinted entry used by tool_repetition clustering.
interface ToolEntry {
  entry: HistoryEntry;
  fp: string;
}

// --- Detection ---

export function detectStuck(history: HistoryEntry[], options: DetectOptions = {}): StuckSignal | null {
  const STUCK_THRESHOLD = options.STUCK_THRESHOLD ?? 3;
  const ERROR_THRESHOLD = options.ERROR_THRESHOLD ?? 4;
  const READONLY_THRESHOLD = options.READONLY_THRESHOLD ?? 6;
  const INVALID_THRESHOLD = options.INVALID_THRESHOLD ?? 2;
  const GENERIC_SIMILARITY = options.GENERIC_SIMILARITY_THRESHOLD ?? GENERIC_SIMILARITY_THRESHOLD;

  if (history.length < 4) return null;

  const recent = history.slice(-8);

  const isKnown = (e: HistoryEntry) => e.argsKnown !== false;

  // Check 5 (priority): permission_loop — 2+ consecutive denied calls.
  const invTail = history.slice(-INVALID_THRESHOLD);
  if (
    invTail.length >= INVALID_THRESHOLD &&
    invTail.every((e) => {
      const t = e.tool || "";
      if (t === "invalid") return true;
      if (t === "task" && e.error) return true;
      return false;
    })
  ) {
    return {
      type: "permission_loop",
      count: invTail.length,
      detail: `${invTail.length} consecutive denied tool calls. The agent is repeatedly attempting tools it is not allowed to use, or a denied dispatch (task) attempt.`,
    };
  }

  // Check 1: tool_repetition — an ONGOING similar cluster of >= threshold
  // calls of one non-progress tool. "Ongoing" = the cluster contains the
  // tool's most recent call. "Cluster" = every member is similar to the seed
  // (star clustering; for exact fingerprints this is mutual identity).
  {
    const byTool: Record<string, ToolEntry[]> = {};
    for (const entry of recent) {
      const tool = entry.tool || "unknown";
      if (PROGRESS_TOOLS.has(tool)) continue;
      if (!byTool[tool]) byTool[tool] = [];
      byTool[tool].push({ entry, fp: isKnown(entry) ? toolFingerprint(tool, entry.args) : "" });
    }
    for (const [tool, entries] of Object.entries(byTool)) {
      const threshold = TOOL_REPETITION_THRESHOLDS[tool] ?? STUCK_THRESHOLD;
      if (entries.length < threshold) continue;

      // The repetition must be at the TAIL of the window: the most recent
      // call overall must belong to this tool. A cluster that ended earlier
      // (the agent moved on, e.g. to failing bash calls) is history, not a
      // stuck loop — and must not mask the rule that fits the tail.
      if ((recent[recent.length - 1].tool || "") !== tool) continue;

      // The last call's fingerprint must be usable, else repetition cannot
      // be proven ongoing — never fire (fail-safe).
      const lastFp = entries[entries.length - 1].fp;
      if (!lastFp) continue;

      // Largest star-cluster that contains the most recent call.
      let bestCluster = 0;
      for (let i = 0; i < entries.length; i++) {
        if (!entries[i].fp) continue;
        if (!isSimilar(tool, entries[i].fp, lastFp, GENERIC_SIMILARITY)) continue;
        let size = 1;
        for (let j = 0; j < entries.length; j++) {
          if (j === i || !entries[j].fp) continue;
          if (isSimilar(tool, entries[i].fp, entries[j].fp, GENERIC_SIMILARITY)) size++;
        }
        if (size > bestCluster) bestCluster = size;
      }
      if (bestCluster >= threshold) {
        return {
          type: "tool_repetition",
          tool,
          count: entries.length,
          similarCalls: bestCluster,
          detail: `${tool} called ${bestCluster} times in the last ${recent.length} calls with similar arguments, still repeating`,
        };
      }
    }
  }

  // Check 4: readonly_repetition — 6+ CONSECUTIVE same readonly tool with
  // IDENTICAL non-empty fingerprints. Unknown-args entries never count
  // (v1 bug: "" == "" made six reads of DIFFERENT files look identical).
  const roTail = history.slice(-READONLY_THRESHOLD);
  if (roTail.length >= READONLY_THRESHOLD) {
    const tool = roTail[0].tool || "";
    if (READONLY_TOOLS.has(tool) && roTail.every((e) => (e.tool || "") === tool && isKnown(e))) {
      const firstFp = toolFingerprint(tool, roTail[0].args);
      if (firstFp && roTail.every((e) => readonlyFingerprintsMatch(firstFp, toolFingerprint(tool, e.args)))) {
        return {
          type: "readonly_repetition",
          tool,
          count: roTail.length,
          detail: `${tool} called ${roTail.length} consecutive times with identical arguments (tight read-only loop)`,
        };
      }
    }
  }

  // Check 2: error_cascade — 4 consecutive errored calls, OR 3 consecutive
  // errored calls of the SAME tool with IDENTICAL fingerprints (the same
  // failing attempt retried). Three DIVERSE errors (probing) do NOT fire.
  {
    const last4 = history.slice(-4);
    if (last4.length >= 4 && last4.every((e) => e.error)) {
      return {
        type: "error_cascade",
        count: 4,
        detail: `4 consecutive tool calls returned errors`,
      };
    }
    const last3 = history.slice(-3);
    if (last3.length >= 3 && last3.every((e) => e.error)) {
      const t0 = last3[0].tool || "";
      const sameTool = last3.every((e) => (e.tool || "") === t0);
      const allKnown = last3.every((e) => isKnown(e));
      if (sameTool && allKnown) {
        const fp0 = toolFingerprint(t0, last3[0].args);
        if (fp0 && last3.every((e) => readonlyFingerprintsMatch(fp0, toolFingerprint(t0, e.args)))) {
          return {
            type: "error_cascade",
            count: 3,
            detail: `the same ${t0} call failed 3 consecutive times (identical arguments)`,
          };
        }
      }
    }
  }

  // Check 3: command_repetition — same bash/powershell command 5+ times in
  // the window AND the most recent bash/powershell call is that command
  // (ongoing). Clock commands excluded. (v1 bug: args.command was always
  // undefined, so this rule never fired at all.)
  {
    const shellEntries = recent.filter(
      (e) => (e.tool === "bash" || e.tool === "powershell") && isKnown(e)
    );
    if (shellEntries.length >= 5) {
      const lastCmd = String(shellEntries[shellEntries.length - 1].args?.command || "");
      if (lastCmd.length > 5 && !isClockCommand(lastCmd)) {
        const lastKey = lastCmd.slice(0, 60);
        let count = 0;
        for (const e of shellEntries) {
          const cmd = String(e.args?.command || "");
          if (isClockCommand(cmd)) continue;
          if (cmd.slice(0, 60) === lastKey) count++;
        }
        if (count >= 5) {
          return {
            type: "command_repetition",
            command: lastKey.slice(0, 80),
            count,
            detail: `bash command "${lastKey}..." repeated ${count} times, most recently`,
          };
        }
      }
    }
  }

  return null;
}
