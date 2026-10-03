/**
 * blast-radius.ts — Pi extension: pre-edit blast-radius surfacing
 * Ported from glitch-ai .opencode/plugins/blast-radius.js (283 ln) → Pi ExtensionAPI.
 *
 * PURPOSE
 *   Automates Glitch's R9 "run impact analysis before editing" discipline by
 *   surfacing the blast radius BEFORE an edit/write. When the agent is about to
 *   edit or write a file, this extension runs a blast-radius query against that
 *   file and injects "what depends on this file" into the next LLM message.
 *
 * BACKEND — GitNexus:
 *   Default command: `gitnexus impact {file} --summary-only`
 *   `impact` accepts a file path as its target (resolves to a File node) and
 *   returns upstream dependants with a risk rating. `--summary-only` keeps
 *   injected text concise. Stale index → "not found" / risk UNKNOWN is itself a
 *   useful signal ("re-index needed"). Degrades gracefully; never crashes.
 *
 * MECHANISM (mirrors OpenCode plugin, remapped to Pi events):
 *   1. `tool_call` fires before every tool call (pre, mutable/blockable).
 *      When tool is `edit` or `write`, run blast-radius (fire-and-forget,
 *      non-blocking) and write result to data/blast-radius/<sessionID>.json.
 *   2. `context` fires before each LLM call. If a fresh signal exists for the
 *      session, append a synthetic text directive to the last message so the
 *      agent is FORCED to see the blast radius, then consume (delete) the signal.
 *
 * CONFIG (env vars — unchanged from OpenCode plugin):
 *   - BLAST_RADIUS_COMMAND   — full command template; `{file}` replaced with
 *     edited file path (relativized to repo root). Default:
 *     "gitnexus impact {file} --summary-only"
 *   - BLAST_RADIUS_TIMEOUT_MS — max ms to wait for command (default 8000)
 *   - BLAST_RADIUS_DISABLED  — set "1" to disable entirely
 *
 * SAFETY / NON-BLOCKING (R22):
 *   - Command runs with hard timeout; fire-and-forget in tool_call handler
 *     (never blocks the tool loop).
 *   - gitnexus missing → spawn fails fast, single warning log, no crash/retry.
 *   - Per-session per-file 30s cooldown prevents spam on multi-edit bursts.
 *   - Signal TTL 5 min (blast radius only relevant right around the edit).
 */

import { promises as fs } from "node:fs";
import { join, relative, isAbsolute } from "node:path";
import { spawn } from "node:child_process";
import type { ExtensionAPI, AgentMessage, TextContent } from "@earendil-works/pi-coding-agent";
import { guard } from "../../.pi/lib/ctx-guard.mjs";

const SIGNAL_TTL_MS = 5 * 60 * 1000; // 5 min
const COOLDOWN_MS = 30 * 1000; // per-file cooldown

const WATCHED_TOOLS = new Set(["edit", "write"]);

export default function (pi: ExtensionAPI) {
  const dataDir = join(process.cwd(), "data");
  const signalDir = join(dataDir, "blast-radius");

  const disabled = process.env.BLAST_RADIUS_DISABLED === "1";
  const commandTemplate = process.env.BLAST_RADIUS_COMMAND || "gitnexus impact {file} --summary-only";
  const timeoutMs = Number(process.env.BLAST_RADIUS_TIMEOUT_MS) || 8000;

  // Per-session in-memory state: last time we queried each file (cooldown).
  const lastQuery = new Map<string, number>(); // key: `${sessionID}:${filePath}` -> timestamp
  let currentSessionID: string | null = null;

  try {
    fs.mkdir(signalDir, { recursive: true }).catch(() => {});
  } catch (err: any) {
    console.error(`[blast-radius] failed to create signal dir: ${err.message}`);
  }

  function signalPath(sessionID: string): string {
    return join(signalDir, `${sessionID}.json`);
  }

  /** Extract the edited file path from tool args (edit/write both use filePath / path). */
  function extractFilePath(args: any): string | null {
    if (!args || typeof args !== "object") return null;
    const fp = args.filePath || args.path || args.file;
    if (typeof fp === "string" && fp.trim()) return fp.trim();
    return null;
  }

  /**
   * Relativize an absolute path to the repo root (cwd), normalizing to
   * forward slashes. Strips the repo root prefix so the path survives
   * cmd.exe /c argv splitting on Windows.
   */
  function relativize(filePath: string): string {
    if (isAbsolute(filePath)) {
      const rel = relative(process.cwd(), filePath);
      if (rel && !rel.startsWith("..")) return rel.replace(/\\/g, "/");
    }
    return filePath.replace(/\\/g, "/");
  }

  /**
   * Run the blast-radius command. Returns trimmed stdout, or null on any
   * failure (missing binary, timeout). Never throws. Non-empty stdout accepted
   * regardless of exit code.
   */
  function runBlastRadius(filePath: string): Promise<string | null> {
    return new Promise((resolve) => {
      const rel = relativize(filePath);

      // Split template into argv FIRST, then substitute {file} into each token.
      const tokens = commandTemplate.split(/\s+/).filter(Boolean);
      const argv = tokens.map((t) => t.replaceAll("{file}", rel));
      const [bin, ...rest] = argv;

      let child;
      try {
        // Windows: gitnexus is a .cmd/.ps1 shim — route through cmd.exe /c.
        if (process.platform === "win32") {
          child = spawn("cmd.exe", ["/c", bin, ...rest], {
            cwd: process.cwd(),
            shell: false,
            windowsHide: true,
          });
        } else {
          child = spawn(bin, rest, {
            cwd: process.cwd(),
            shell: false,
          });
        }
      } catch (err: any) {
        console.warn(`[blast-radius] failed to spawn "${bin}": ${err.message}`);
        return resolve(null);
      }

      let stdout = "";
      let stderr = "";
      let settled = false;

      const finish = (result: string | null) => {
        if (settled) return;
        settled = true;
        try {
          child.kill();
        } catch {
          // ignore
        }
        resolve(result);
      };

      const timer = setTimeout(() => {
        console.warn(`[blast-radius] timed out after ${timeoutMs}ms: ${commandTemplate}`);
        finish(null);
      }, timeoutMs);

      child.stdout.on("data", (d) => {
        stdout += d.toString();
      });
      child.stderr.on("data", (d) => {
        stderr += d.toString();
      });

      child.on("error", (err: any) => {
        console.warn(
          `[blast-radius] command unavailable (${bin}): ${err.code === "ENOENT" ? "not installed" : err.message}`
        );
        clearTimeout(timer);
        finish(null);
      });

      child.on("close", (code) => {
        clearTimeout(timer);
        const out = stdout.trim();
        if (out) {
          finish(out);
        } else {
          if (stderr.trim()) {
            console.warn(`[blast-radius] command exited ${code} with no stdout: ${stderr.trim().slice(0, 200)}`);
          }
          finish(null);
        }
      });
    });
  }

  async function writeSignal(sessionID: string, filePath: string, result: string): Promise<void> {
    const payload = {
      sessionID,
      filePath,
      result,
      ts: Date.now(),
    };
    try {
      await fs.writeFile(signalPath(sessionID), JSON.stringify(payload, null, 2), "utf8");
    } catch (err: any) {
      console.error(`[blast-radius] failed to write signal: ${err.message}`);
    }
  }

  // --- Event wiring ---

  pi.on("session_start", async (_event, ctx) => {
    await guard("blast-radius", async () => {
      const sid =
        (ctx as any).sessionID ||
        (ctx as any).sessionId ||
        (ctx.sessionManager as any)?.sessionId ||
        (ctx.sessionManager as any)?.id ||
        "default";
      currentSessionID = String(sid);
    });
  });

  // Pre-tool: capture blast radius for edit/write (fire-and-forget, non-blocking).
  pi.on("tool_call", async (event) => {
    if (disabled) return;
    try {
      const tool = event.toolName || "unknown";
      if (!WATCHED_TOOLS.has(tool)) return;

      const filePath = extractFilePath((event as any).input);
      if (!filePath) return;

      const sessionID = currentSessionID || "default";
      const key = `${sessionID}:${filePath}`;
      const now = Date.now();
      if (lastQuery.has(key) && now - (lastQuery.get(key) as number) < COOLDOWN_MS) return;
      lastQuery.set(key, now);

      // Fire-and-forget: do NOT await — never block the tool loop (R22).
      runBlastRadius(filePath).then((result) => {
        if (result) {
          writeSignal(sessionID, filePath, result);
          console.log(`[blast-radius] blast radius captured for ${filePath} (session ${sessionID})`);
        }
      });
    } catch (err: any) {
      console.error(`[blast-radius] tool_call failed: ${err.message}`);
    }
  });

  // Inject blast radius into messages before LLM (one-shot consume, 5m TTL).
  pi.on("context", async (event) => {
    if (disabled) return;
    try {
      const sessionID = currentSessionID || "default";
      const sp = signalPath(sessionID);

      let raw: string;
      try {
        raw = await fs.readFile(sp, "utf8");
      } catch (err: any) {
        if (err.code === "ENOENT") return;
        throw err;
      }

      let payload: any;
      try {
        payload = JSON.parse(raw);
      } catch {
        return;
      }

      // Stale signal — drop it, don't inject.
      if (!payload.ts || Date.now() - payload.ts > SIGNAL_TTL_MS) {
        try {
          await fs.unlink(sp);
        } catch {
          // ignore
        }
        return;
      }

      const messages = event.messages as AgentMessage[];
      if (!messages || messages.length === 0) return;
      const lastMessage = messages[messages.length - 1];
      if (!lastMessage || !Array.isArray((lastMessage as any).content)) return;

      const directive =
        `[BLAST RADIUS] You are about to edit ${payload.filePath}. What depends on it:\n` +
        `---\n${payload.result}\n---\n` +
        `Consider whether these dependents need updating before you make the change.`;

      const content = (lastMessage as any).content as Array<{ type: string; text?: string }>;
      const lastPart = content[content.length - 1];
      if (lastPart && lastPart.type === "text" && typeof lastPart.text === "string") {
        lastPart.text += `\n\n${directive}`;
      } else {
        content.push({ type: "text", text: directive } as TextContent);
      }

      // Consume the signal so it isn't re-injected on every subsequent message.
      try {
        await fs.unlink(sp);
      } catch {
        // ignore
      }

      console.log(`[blast-radius] injected blast radius for ${payload.filePath} (session ${sessionID})`);
    } catch (err: any) {
      if (err.code !== "ENOENT") {
        console.error(`[blast-radius] context inject failed: ${err.message}`);
      }
    }
  });
}
