/**
 * subagent-watchdog-logic.mts — Pure logic for detecting hung sub-agents.
 * ZERO runtime dependencies (only globalThis.process for env override) so both
 * the Pi extension loader (jiti) and node --test (native type stripping) can
 * import it directly.
 *
 * Lifecycle tracked per runId:
 *   spawn → active (lastActivityAt = now)
 *   observation with output change → clock reset (lastActivityAt = now)
 *   observation with same output → clock untouched (silence accumulates)
 *   status done/error → inactive (exempt from evaluate, eligible for sweep)
 *   evaluate → warn at WARN_THRESHOLD_MS, hang at HANG_THRESHOLD_MS
 *   sweep → drop inactive > INACTIVE_SWEEP_MS, all > MAX_AGE_MS
 *
 * Cheap output signature: `${output.length}|${last80chars}`. Detects real
 * progress (new text in result) without storing the full output.
 */

// --- Constants ---

export const HANG_THRESHOLD_MS =
  (typeof process !== "undefined" && Number(process.env.GLITCH_AGENT_HANG_MS)) ||
  12 * 60 * 1000;

export const WARN_THRESHOLD_MS = 5 * 60 * 1000;

/** One directive per runId per this window — prevents re-fire spam. */
export const DIRECTIVE_COOLDOWN_MS = 10 * 60 * 1000;

/** Inactive entries (done/error/stopped) swept after this age. */
export const INACTIVE_SWEEP_MS = 30 * 60 * 1000;

/** Hard TTL: every entry swept after this regardless of status. */
export const MAX_AGE_MS = 24 * 60 * 60 * 1000;

// --- Types ---

export interface WatchdogEntry {
  runId: string;
  template: string;
  spawnedAt: number;
  lastActivityAt: number;
  /** Cheap signature: `${length}|${last80}` of last observed output. */
  lastOutputSig: string;
  lastDirectiveAt: number;
  lastDirectiveAction: "" | "warn" | "hang";
  active: boolean;
  /** Terminal status if inactive. */
  status: "running" | "done" | "error" | "stopped";
}

export interface WatchdogState {
  entries: Record<string, WatchdogEntry>;
}

export interface WatchdogDirective {
  runId: string;
  template: string;
  action: "warn" | "hang";
  silentForMs: number;
}

// --- Core functions ---

export function createEmptyState(): WatchdogState {
  return { entries: {} };
}

export function recordSpawn(
  state: WatchdogState,
  runId: string,
  template: string,
  now: number,
): void {
  state.entries[runId] = {
    runId,
    template,
    spawnedAt: now,
    lastActivityAt: now,
    lastOutputSig: "",
    lastDirectiveAt: 0,
    lastDirectiveAction: "",
    active: true,
    status: "running",
  };
}

export function recordObservation(
  state: WatchdogState,
  runId: string,
  statusText: string | undefined,
  outputText: string | undefined,
  now: number,
): void {
  const entry = state.entries[runId];
  if (!entry) return;

  // Terminal status transitions deactivate the entry.
  const st = (statusText || "").toLowerCase();
  if (st === "done" || st === "error" || st === "stopped") {
    entry.active = false;
    entry.status = st as "done" | "error" | "stopped";
    return;
  }

  // Build cheap output signature; reset clock only when output actually changes.
  const sig = outputText
    ? `${outputText.length}|${outputText.slice(-80)}`
    : "";
  if (sig && sig !== entry.lastOutputSig) {
    entry.lastOutputSig = sig;
    entry.lastActivityAt = now;
  }
}

export function evaluate(
  state: WatchdogState,
  now: number,
): WatchdogDirective[] {
  const directives: WatchdogDirective[] = [];

  for (const entry of Object.values(state.entries)) {
    if (!entry.active) continue;

    // Per-runId cooldown prevents repeated directives.
    if (
      entry.lastDirectiveAt > 0 &&
      now - entry.lastDirectiveAt < DIRECTIVE_COOLDOWN_MS
    ) {
      continue;
    }

    const silentForMs = now - entry.lastActivityAt;
    let action: "warn" | "hang" | null = null;

    if (silentForMs >= HANG_THRESHOLD_MS) {
      action = "hang";
    } else if (silentForMs >= WARN_THRESHOLD_MS) {
      action = "warn";
    }

    if (action) {
      entry.lastDirectiveAt = now;
      entry.lastDirectiveAction = action;
      directives.push({
        runId: entry.runId,
        template: entry.template,
        action,
        silentForMs,
      });
    }
  }

  return directives;
}

export function sweep(state: WatchdogState, now: number): void {
  for (const [runId, entry] of Object.entries(state.entries)) {
    const age = now - entry.spawnedAt;
    if (age > MAX_AGE_MS) {
      delete state.entries[runId];
      continue;
    }
    if (!entry.active && now - entry.lastActivityAt > INACTIVE_SWEEP_MS) {
      delete state.entries[runId];
    }
  }
}

export function buildDirective(entry: WatchdogDirective): string {
  const shortId = entry.runId.slice(0, 8);
  const mins = Math.round(entry.silentForMs / 60_000);
  if (entry.action === "hang") {
    return (
      `\u23F1 Agent ${shortId} (${entry.template}) silent for ${mins}m \u2014 hung. ` +
      `Call subagent(action="stop", runId="${entry.runId}"), then retry or switch template. ` +
      `Never shut the conversation down over this.`
    );
  }
  return (
    `\u23F1 Agent ${shortId} (${entry.template}) silent for ${mins}m \u2014 possibly stalled. ` +
    `Check subagent(action="get_result", runId="${entry.runId}") for status. ` +
    `If hung, stop and retry.`
  );
}

// --- RunId extraction from tool results ---

export function parseRunIdFromResult(result: unknown): string | null {
  let text = "";
  if (typeof result === "string") {
    text = result;
  } else if (result && typeof result === "object") {
    const r = result as Record<string, unknown>;
    if (typeof r.content === "string") {
      text = r.content;
    } else if (Array.isArray(r.content)) {
      text = r.content
        .filter((c: unknown) => typeof (c as Record<string, unknown>)?.text === "string")
        .map((c: unknown) => (c as Record<string, string>).text)
        .join(" ");
    }
    if (!text && typeof r.output === "string") {
      text = r.output;
    }
  }
  if (!text) return null;

  // "Subagent started ... : sa-xxxxxxxx"
  // "Delegated: sa-xxxxxxxx"
  const match = text.match(/(?:started|Delegated)[^.]*?(sa-[0-9a-f]+)/i);
  if (match) return match[1];

  // Generic sa-<hex> anywhere
  const fallback = text.match(/(sa-[0-9a-f]{4,})/i);
  return fallback ? fallback[1] : null;
}
