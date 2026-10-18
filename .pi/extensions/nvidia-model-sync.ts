/**
 * nvidia-model-sync.ts — Pi extension: live NVIDIA model list from the NIM API
 *
 * Keeps the NVIDIA model list live by running the sync engine
 * (scripts/nvidia-models.mjs) on session start and on demand. The engine
 * fetches the NIM catalog, probes enabled chat models (removes endpoints
 * that answer 404, auto-enables new chat ids), maintains the pin guard and
 * the state file that the Agent Models panel merges into its pickers.
 *
 * HOW IT WORKS
 *   session_start -> check state-file TTL (default 30 min, env NVIDIA_SYNC_TTL_MIN)
 *     fresh  -> do nothing (most sessions cost a stat())
 *     stale  -> spawn the engine (--sync --json) detached, fire-and-forget.
 *               Results land in ~/.pi/agent/models.json + the state file.
 *   costs.json   -> if missing or older than 24 h, spawn the pricing-table
 *               generator detached (moved here from the retired
 *               model-catalog panel schedule).
 *
 *   /nvidia-sync -> on-demand refresh (runs the engine with --sync --json in
 *                   the foreground and reports a human-readable line).
 *
 * Design notes:
 *   - Fire-and-forget on session_start: never block or delay session startup.
 *   - The engine owns locking (data/.nvidia-sync.lock), so multiple
 *     concurrent session starts coalesce into a single NIM ping.
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

const COSTS_TTL_MS = 24 * 60 * 60_000;

function engineCommand(root: string): { node: string; script: string } | null {
  const script = join(root, "scripts", "nvidia-models.mjs");
  if (!existsSync(script)) return null;
  const bundledNode = join(root, "data", "node", process.platform === "win32" ? "node.exe" : "node");
  const node = existsSync(bundledNode) ? bundledNode : process.execPath;
  return { node, script };
}

/** The engine's state file doubles as the freshness marker: every sync,
 *  enable/disable, or pin write touches it. */
function stateFilePath(root: string): string {
  return join(root, "data", "nvidia-models-state.json");
}

function costsFilePath(root: string): string {
  return join(root, ".pi", "agent-models", "costs.json");
}

/** State fresh enough to skip the sync entirely? */
function stateFresh(root: string): boolean {
  const state = stateFilePath(root);
  if (!existsSync(state)) return false;
  try {
    return Date.now() - statSync(state).mtimeMs < ttlMs();
  } catch {
    return false;
  }
}

/** Pricing table missing or older than a day? */
function costsStale(root: string): boolean {
  const costs = costsFilePath(root);
  if (!existsSync(costs)) return true;
  try {
    return Date.now() - statSync(costs).mtimeMs > COSTS_TTL_MS;
  } catch {
    return false;
  }
}

function spawnDetached(node: string, args: string[], root: string): void {
  const child = spawn(node, args, {
    cwd: root,
    detached: true,
    stdio: "ignore",
    windowsHide: true,
  });
  child.unref();
}

export default function (pi: ExtensionAPI) {
  pi.on("session_start", async () => {
    try {
      const root = resolveRepoRoot();
      const cmd = engineCommand(root);
      if (!cmd) return;
      if (!stateFresh(root)) {
        spawnDetached(cmd.node, [cmd.script, "--sync", "--json"], root);
      }
      if (costsStale(root)) {
        spawnDetached(cmd.node, [join("scripts", "agent-model-costs.mjs"), "--json"], root);
      }
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
        ctx.ui.notify("nvidia-sync: scripts/nvidia-models.mjs not found", "error");
        return;
      }
      // The engine knows --dry-run and --help; anything else it would refuse.
      const passThrough = (args || "").trim().split(/\s+/).filter((a) => a === "--dry-run" || a === "--help");
      const engineArgs = ["--sync", "--json", ...passThrough];
      const resultLine = await new Promise<string>((resolvePromise) => {
        execFile(
          cmd.node,
          [cmd.script, ...engineArgs],
          { cwd: root, timeout: 180_000, windowsHide: true, maxBuffer: 2 * 1024 * 1024 },
          (error: Error | null, stdout: string | Buffer) => {
            const text = (stdout || "").toString().trim();
            if (error && !text) {
              resolvePromise(`nvidia-sync failed: ${(error as Error & { message?: string }).message || error}`);
              return;
            }
            try {
              const report = JSON.parse(text.split(/\r?\n/).filter((l: string) => l.trim()).pop() || "{}");
              if (report.ok === false) {
                resolvePromise(`nvidia-sync failed: ${report.error || "unknown error"}`);
                return;
              }
              const counts = report.counts ?? {};
              const parts = [
                `${report.catalog_total ?? "?"} models (${counts.enabled ?? "?"} enabled)`,
                `removed ${report.removed_dead?.length ?? 0} dead`,
                `added ${report.added_new?.length ?? 0} new`,
              ];
              if ((report.probe_inconclusive?.length ?? 0) > 0) {
                parts.push(`${report.probe_inconclusive.length} probes inconclusive (kept)`);
              }
              resolvePromise(`nvidia-sync: ${parts.join(", ")}`);
            } catch {
              const lastLine = text ? text.split(/\r?\n/).filter((l: string) => l.trim()).pop() : "";
              resolvePromise(lastLine || (error ? `nvidia-sync failed: ${error.message}` : "nvidia-sync: done"));
            }
          }
        );
      });
      const isError = /failed/i.test(resultLine);
      ctx.ui.notify(resultLine, isError ? "warning" : "info");
    },
  });
}
