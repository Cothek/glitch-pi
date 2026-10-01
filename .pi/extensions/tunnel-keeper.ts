/**
 * tunnel-keeper.ts — Cloudflare tunnel watchdog for Pi sessions.
 *
 * Fires once when a session starts and then every 5 minutes: if cloudflared
 * is not running, it spawns scripts/lib/tunnel.mjs (detached) which starts the
 * tunnel and waits until the remote URL answers. That covers the two cases the
 * launcher alone cannot:
 *   1. cloudflared dying MID-session (observed twice on this machine), and
 *   2. Pi started directly (not via launch-glitch.bat).
 *
 * Design notes:
 *   - Fire-and-forget: the check runs in a detached child, so a slow or down
 *     tunnel never delays a session. The timer is unref'd.
 *   - Sub-agents (GLITCH_SUBAGENT=1) skip entirely — the primary session owns
 *     the tunnel; N parallel agents must not each run a watchdog.
 *   - Nothing here may ever throw: a tunnel problem must never break Pi.
 *   - Registered in .pi/settings.json (that list GATES project extension
 *     loading — an unlisted extension is never loaded).
 */

import { spawn, execFile } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const KEEPER_INTERVAL_MS = 5 * 60 * 1000;
// Cross-session lease: only one session spawns the tunnel script at a time.
// If a lease exists and is fresh (younger than the window), this session
// skips silently — the other session is CURRENTLY doing the work.
const LEASE_FRESH_MS = 4 * 60 * 1000;
const extensionDir = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(extensionDir, "..", "..");
const TUNNEL_SCRIPT = join(REPO_ROOT, "scripts", "lib", "tunnel.mjs");
const LEASE_FILE = join(REPO_ROOT, "data", ".tunnel-keeper.lease");

/**
 * CHEAP in-process cloudflared check: one tasklist.exe call (~10ms) instead of
 * booting a whole node child for tunnel.mjs (~300ms + module loads). This gate
 * eliminates the node churn: when the tunnel is healthy (the common case),
 * this session spawns NOTHING at all.
 */
function isCloudflaredRunningCheap(): Promise<boolean> {
  return new Promise((res) => {
    execFile(
      "tasklist",
      ["/NH", "/FI", "IMAGENAME eq cloudflared.exe"],
      { timeout: 5_000, windowsHide: true },
      (err, stdout) => res(!err && String(stdout ?? "").includes("cloudflared.exe")),
    );
  });
}

/** Read the lease. returns true if it's fresh. */
function isLeaseFresh(): boolean {
  try {
    if (!existsSync(LEASE_FILE)) return false;
    const raw = readFileSync(LEASE_FILE, "utf-8");
    const parsed = JSON.parse(raw);
    if (typeof parsed.t !== "string") return false;
    const delta = Date.now() - new Date(parsed.t).getTime();
    return delta >= 0 && delta < LEASE_FRESH_MS;
  } catch {
    return false;
  }
}

/** Claim the lease. Atomically for this process only. */
function tryClaimLease(): boolean {
  try {
    mkdirSync(dirname(LEASE_FILE), { recursive: true });
    writeFileSync(
      LEASE_FILE,
      JSON.stringify({ t: new Date().toISOString(), pid: process.pid }),
      "utf-8",
    );
    return true;
  } catch {
    return false;
  }
}

async function ensureTunnelProcess(reason: string): Promise<void> {
  try {
    if (!existsSync(TUNNEL_SCRIPT)) return;
    // 1. Cheap in-process check first: tunnel healthy => spawn NOTHING at all
    //    (the common case; this is what eliminates the node churn).
    if (await isCloudflaredRunningCheap()) return;
    // 2. Cross-session lease: only one session repairs at a time.
    if (isLeaseFresh()) return;
    if (!tryClaimLease()) return;
    const child = spawn(process.execPath, [TUNNEL_SCRIPT, "--reason", reason], {
      detached: true,
      stdio: "ignore",
      windowsHide: true,
    });
    child.unref();
  } catch {
    // Never surface tunnel bookkeeping as a session error.
  }
}

export default function tunnelKeeperExtension(_pi: ExtensionAPI) {
  // Sub-agents inherit the primary session's keeper — skip to avoid watchdog stampedes.
  if (process.env.GLITCH_SUBAGENT === "1") return;

  void ensureTunnelProcess("session-start");

  const timer = setInterval(() => void ensureTunnelProcess("periodic"), KEEPER_INTERVAL_MS);
  if (typeof timer.unref === "function") timer.unref();
}
