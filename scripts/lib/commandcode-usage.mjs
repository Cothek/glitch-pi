#!/usr/bin/env node
/**
 * commandcode-usage.mjs — Command Code plan-usage fetcher + renderer.
 *
 * Data source: the same alpha API the command-code CLI uses (verified against
 * the CLI bundle v1.65.4). All GETs, Bearer auth with the same `user_...` key
 * Pi already uses for the commandcode provider:
 *
 *   GET /alpha/billing/credits        → monthlyCredits (remaining) + windowLimits
 *   GET /alpha/billing/subscriptions  → planId + billing period end
 *
 * Endpoints and auth verified live 2026-09-25. The web dashboard itself is
 * cookie-auth and undocumented; the CLI surface is what this mirrors.
 *
 * Consumers:
 *   - .pi/extensions/commandcode-usage.ts (imports everything below)
 *   - CLI: `node scripts/lib/commandcode-usage.mjs --render` prints the widget
 *
 * Failure policy: every public function returns data or null — never throws.
 */

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const API_BASE = "https://api.commandcode.ai";
const CREDITS_PATH = "/alpha/billing/credits";
const SUBSCRIPTIONS_PATH = "/alpha/billing/subscriptions";
const FETCH_TIMEOUT_MS = 15_000;

/** Plan caps (credits/month) and display names — command-code CLI v1.65.4 bundle. */
const PLAN_CREDITS = {
  "individual-go": 10,
  "individual-goat": 70,
  "individual-pro": 30,
  "individual-pro-v1": 80,
  "individual-provider": 15,
  "individual-max": 150,
  "individual-ultra": 300,
  "teams-pro": 40,
};
const PLAN_NAMES = {
  "individual-go": "Go",
  "individual-goat": "GOAT",
  "individual-pro": "Pro",
  "individual-pro-v1": "Pro",
  "individual-provider": "Provider",
  "individual-max": "Max",
  "individual-ultra": "Ultra",
  "teams-pro": "Teams Pro",
};

/**
 * Resolve the Command Code API key. Order:
 *   1. env COMMAND_CODE_API_KEY
 *   2. ~/.pi/agent/provider-keys.json → commandcode → activeKeyName → apiKey
 * Never logged, never embedded in rendered output.
 */
export function resolveApiKey() {
  try {
    const envKey = process.env.COMMAND_CODE_API_KEY?.trim();
    if (envKey) return envKey;
    const keysPath = join(homedir(), ".pi", "agent", "provider-keys.json");
    if (!existsSync(keysPath)) return null;
    const parsed = JSON.parse(readFileSync(keysPath, "utf8"));
    const provider = parsed?.commandcode;
    if (!provider) return null;
    const activeName = provider.activeKeyName;
    const entry = (Array.isArray(provider.keys) ? provider.keys : []).find(
      (k) => k && typeof k.apiKey === "string" && (activeName ? k.name === activeName : true),
    );
    return entry?.apiKey?.trim() || null;
  } catch {
    return null;
  }
}

async function getJson(key, path) {
  try {
    const res = await fetch(`${API_BASE}${path}`, {
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

/**
 * Fetch a usage snapshot. Returns null when anything is missing so callers can
 * keep their last good data.
 */
export async function fetchUsageSnapshot() {
  const key = resolveApiKey();
  if (!key) return null;

  const credits = await getJson(key, CREDITS_PATH);
  if (!credits?.windowLimits) return null;

  // Subscription (plan name + billing period end) is slow-changing; fetch it
  // every call anyway — one extra cheap GET keeps the widget self-contained.
  const subs = await getJson(key, SUBSCRIPTIONS_PATH);
  const planId = subs?.data?.planId ?? null;
  const periodEnd = subs?.data?.currentPeriodEnd ?? null;

  const monthlyRemaining = Math.max(
    0,
    (credits.credits?.monthlyCredits ?? 0) +
      (credits.credits?.purchasedCredits ?? 0) +
      (credits.credits?.freeCredits ?? 0),
  );

  return {
    fetchedAt: Date.now(),
    planId,
    planName: planId ? (PLAN_NAMES[planId] ?? planId) : null,
    planCredits: planId ? (PLAN_CREDITS[planId] ?? null) : null,
    periodEnd,
    monthlyRemaining,
    fiveHour: normalizeWindow(credits.windowLimits.fiveHour),
    weekly: normalizeWindow(credits.windowLimits.weekly),
  };
}

function normalizeWindow(w) {
  if (!w || typeof w !== "object") return null;
  return {
    used: Number(w.used) || 0,
    cap: Number(w.cap) || 0,
    exceeded: Boolean(w.exceeded),
    resetAt: Number(w.resetAt) || 0,
  };
}

// ---- rendering ------------------------------------------------------------

const BAR_WIDTH = 18;

function bar(used, cap) {
  if (!cap || cap <= 0) return "[" + "·".repeat(BAR_WIDTH) + "]";
  const filled = Math.min(BAR_WIDTH, Math.round((used / cap) * BAR_WIDTH));
  return "[" + "#".repeat(filled) + "-".repeat(BAR_WIDTH - filled) + "]";
}

function pct(used, cap) {
  if (!cap || cap <= 0) return "?%";
  return `${Math.min(100, Math.round((used / cap) * 100))}%`;
}

function money(n) {
  return `$${n.toFixed(2)}`;
}

/** "Oct 23" from an ISO timestamp. UTC parts, so the local timezone cannot shift the day. */
function shortDate(iso) {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  return `${months[d.getUTCMonth()]} ${d.getUTCDate()}`;
}

/** "4h 58m" / "2d 23h" / "<1m" / "—" */
function countdown(msRemaining, now) {
  if (!msRemaining || msRemaining <= 0) return "—";
  const mins = Math.floor(msRemaining / 60_000);
  if (mins < 1) return "<1m";
  if (mins < 60) return `${mins}m`;
  const hours = Math.floor(mins / 60);
  if (hours < 48) return `${hours}h ${mins % 60}m`;
  const days = Math.floor(hours / 24);
  return `${days}d ${hours % 24}h`;
}

function ageText(fetchedAt, now) {
  const mins = Math.max(0, Math.floor((now - fetchedAt) / 60_000));
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  return `${Math.floor(mins / 60)}h ${mins % 60}m ago`;
}

function windowLine(label, w, now) {
  if (!w) return `${label.padEnd(3)}  unavailable`;
  const resets = `resets in ${countdown(w.resetAt - now, now)}`;
  return [
    `${label.padEnd(3)} ${pct(w.used, w.cap).padStart(4)}`,
    bar(w.used, w.cap),
    `${money(w.used)} / ${money(w.cap)}`,
    resets,
    w.exceeded ? "EXCEEDED" : "",
  ]
    .filter(Boolean)
    .join("  ");
}

/**
 * Widget lines for ctx.ui.setWidget (web UI panel under the file tree; TUI
 * above the editor). Plain ASCII only — the web UI strips ANSI, and block
 * glyphs render inconsistently across terminals.
 */
export function renderWidgetLines(snap, now = new Date()) {
  const nowMs = now.getTime();
  const title =
    `Command Code usage${snap.planName ? ` — ${snap.planName} plan` : ""}` +
    `  (updated ${ageText(snap.fetchedAt, nowMs)})`;
  const lines = [title];

  lines.push(windowLine("5h", snap.fiveHour, nowMs));
  lines.push(windowLine("wk", snap.weekly, nowMs));

  if (snap.planCredits) {
    const used = Math.max(0, snap.planCredits - snap.monthlyRemaining);
    const endDate = shortDate(snap.periodEnd);
    const line = [
      `mo  ${pct(used, snap.planCredits).padStart(4)}`,
      bar(used, snap.planCredits),
      `${money(used)} / ${money(snap.planCredits)}`,
      endDate ? `period ends ${endDate}` : "",
    ]
      .filter(Boolean)
      .join("  ");
    lines.push(line);
    lines.push(
      `    ${pct(snap.monthlyRemaining, snap.planCredits)} remaining (${money(snap.monthlyRemaining)} credits)`,
    );
  } else {
    lines.push(`mo  ${money(snap.monthlyRemaining)} credits remaining this period`);
  }

  return lines;
}

/** Short text for ctx.ui.setStatus (status bar chip).
 * Percent-led: the chip answers "how much of my limit is gone?" at a glance.
 * All three figures are percent USED, matching the dashboard bars.
 */
export function renderStatusText(snap, now = new Date()) {
  const nowMs = now.getTime();
  const usedPct = (used, cap) => (cap > 0 ? `${Math.min(100, Math.round((used / cap) * 100))}%` : "?");

  const fiveHour = snap.fiveHour
    ? `5h ${usedPct(snap.fiveHour.used, snap.fiveHour.cap)} (${countdown(snap.fiveHour.resetAt - nowMs, nowMs)})`
    : "5h ?";
  const weekly = snap.weekly
    ? `wk ${usedPct(snap.weekly.used, snap.weekly.cap)} (${countdown(snap.weekly.resetAt - nowMs, nowMs)})`
    : "wk ?";
  const monthlyEnd = shortDate(snap.periodEnd);
  const monthly = snap.planCredits
    ? `mo ${usedPct(Math.max(0, snap.planCredits - snap.monthlyRemaining), snap.planCredits)}${monthlyEnd ? ` (${monthlyEnd})` : ""}`
    : "mo ?";

  return `CC ${fiveHour} · ${weekly} · ${monthly}`;
}

/**
 * One-line detail for the /cc-usage toast: percent first, dollars and reset
 * times as context. This is the surface that replaced the widget panel.
 */
export function renderDetailText(snap, now = new Date()) {
  const nowMs = now.getTime();
  const fmtWindow = (label, w) => {
    if (!w) return `${label} ?`;
    const p = w.cap > 0 ? `${Math.min(100, Math.round((w.used / w.cap) * 100))}%` : "?";
    return `${label} ${p} (${money(w.used)}/${money(w.cap)}, resets ${countdown(w.resetAt - nowMs, nowMs)})`;
  };

  const parts = [fmtWindow("5h", snap.fiveHour), fmtWindow("wk", snap.weekly)];
  if (snap.planCredits) {
    const used = Math.max(0, snap.planCredits - snap.monthlyRemaining);
    const p = Math.min(100, Math.round((used / snap.planCredits) * 100));
    const endDate = shortDate(snap.periodEnd);
    parts.push(`mo ${p}% (${money(used)}/${money(snap.planCredits)}${endDate ? `, ends ${endDate}` : ""})`);
  } else {
    parts.push(`mo ${money(snap.monthlyRemaining)} credits left`);
  }
  return parts.join(" · ");
}

// ---- CLI mode ---------------------------------------------------------------

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const snapshot = await fetchUsageSnapshot();
  if (!snapshot) {
    console.error("commandcode-usage: no data (missing key or API unreachable)");
    process.exit(1);
  }
  console.log(renderWidgetLines(snapshot).join("\n"));
  console.log();
  console.log(renderStatusText(snapshot));
  console.log(renderDetailText(snapshot));
}
