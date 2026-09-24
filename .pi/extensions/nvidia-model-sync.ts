/**
 * nvidia-model-sync.ts — Pi extension: live NVIDIA model list from the NIM API
 *
 * Pi replacement for the OpenCode-era startup behavior where check-models.ps1
 * pinged https://integrate.api.nvidia.com/v1/models to determine the NVIDIA
 * model list. Pi ships a static catalog; this extension keeps it live.
 *
 * HOW IT WORKS
 *   session_start -> check cache TTL (default 30 min, env NVIDIA_SYNC_TTL_MIN)
 *     fresh  -> do nothing (most sessions cost a stat())
 *     stale  -> spawn scripts/sync-nvidia-models.mjs detached, fire-and-forget:
 *               the engine pings NIM, merges metadata from pi's built-in
 *               catalog, and rewrites ~/.pi/agent/models.json atomically.
 *               pi re-reads models.json when /model or the web picker opens,
 *               so results land without restarting anything.
 *
 *   /nvidia-sync -> on-demand refresh (runs the engine with --force and
 *                   reports the result line). Extra args pass through,
 *                   e.g. "/nvidia-sync --dry-run".
 *
 * Design notes:
 *   - Fire-and-forget on session_start: never block or delay session startup.
 *   - The engine owns locking + TTL + failure backoff, so multiple concurrent
 *     session starts (web UI) coalesce into a single NIM ping.
 *   - Never throws: a failed sync must not break the session.
 */

import { spawn, execFile } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/** Walk up from cwd to the repo root (same pattern as routing.ts). */
function resolveRepoRoot(): string {
  let dir = process.cwd();
  for (;;) {
    if (existsSync(join(dir, ".git")) || existsSync(join(dir, ".pi"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return process.cwd();
    dir = parent;
  }
}

function ttlMs(): number {
  const minutes = parseInt(process.env.NVIDIA_SYNC_TTL_MIN || "30", 10);
  return (Number.isFinite(minutes) && minutes > 0 ? minutes : 30) * 60_000;
}

function engineCommand(root: string): { node: string; script: string } | null {
  const script = join(root, "scripts", "sync-nvidia-models.mjs");
  if (!existsSync(script)) return null;
  const bundledNode = join(root, "data", "node", process.platform === "win32" ? "node.exe" : "node");
  const node = existsSync(bundledNode) ? bundledNode : process.execPath;
  return { node, script };
}

/** Cache fresh enough to skip the sync entirely? */
function cacheFresh(root: string): boolean {
  const cache = join(root, "data", "nvidia-models-cache.json");
  if (!existsSync(cache)) return false;
  try {
    return Date.now() - statSync(cache).mtimeMs < ttlMs();
  } catch {
    return false;
  }
}

export default function (pi: ExtensionAPI) {
  pi.on("session_start", async () => {
    try {
      const root = resolveRepoRoot();
      if (cacheFresh(root)) return;
      const cmd = engineCommand(root);
      if (!cmd) return;
      const child = spawn(cmd.node, [cmd.script], {
        cwd: root,
        detached: true,
        stdio: "ignore",
        windowsHide: true,
      });
      child.unref();
    } catch {
      // Never block session start on a failed sync spawn.
    }
  });

  pi.registerCommand("nvidia-sync", {
    description: "Refresh the NVIDIA model list from the live NIM API (pass --dry-run to preview)",
    handler: async (args, ctx) => {
      const root = resolveRepoRoot();
      const cmd = engineCommand(root);
      if (!cmd) {
        ctx.ui.notify("nvidia-sync: scripts/sync-nvidia-models.mjs not found", "error");
        return;
      }
      const passThrough = (args || "").trim();
      if (passThrough && !/^--[\w-]+(\s+--[\w-]+)*$/.test(passThrough)) {
        ctx.ui.notify(`nvidia-sync: ignoring unexpected args "${passThrough}"`, "warning");
      }
      const engineArgs = ["--force", ...(passThrough ? passThrough.split(/\s+/) : [])];
      const resultLine = await new Promise<string>((resolvePromise) => {
        execFile(
          cmd.node,
          [cmd.script, ...engineArgs],
          { cwd: root, timeout: 60_000, windowsHide: true, maxBuffer: 2 * 1024 * 1024 },
          (error: Error | null, stdout: string | Buffer) => {
            const text = (stdout || "").toString().trim();
            const lastLine = text ? text.split(/\r?\n/).filter((l: string) => l.trim()).pop() : "";
            if (error && !lastLine) {
              resolvePromise(`nvidia-sync failed: ${(error as Error & { message?: string }).message || error}`);
            } else {
              resolvePromise(lastLine || (error ? `nvidia-sync failed: ${error.message}` : "nvidia-sync: done"));
            }
          }
        );
      });
      const isError = /failed|fatal|no API key/i.test(resultLine);
      ctx.ui.notify(resultLine, isError ? "warning" : "info");
    },
  });
}
