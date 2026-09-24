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

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const KEEPER_INTERVAL_MS = 5 * 60 * 1000;

const extensionDir = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(extensionDir, "..", "..");
const TUNNEL_SCRIPT = join(REPO_ROOT, "scripts", "lib", "tunnel.mjs");

function ensureTunnelProcess(reason: string): void {
  try {
    if (!existsSync(TUNNEL_SCRIPT)) return;
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

  ensureTunnelProcess("session-start");

  const timer = setInterval(() => ensureTunnelProcess("periodic"), KEEPER_INTERVAL_MS);
  if (typeof timer.unref === "function") timer.unref();
}
