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
 *
 * Ack parsing (extractSpawnInfo): ONLY the ack's first line is parsed, and
 * only when that line starts with a known dispatch verb. A schema-validation
 * error echoes the full arguments JSON of a failed delegate_task, and that
 * JSON can contain fixture text like "Delegated: sa-ed5e1e55" — parsing the
 * whole dump seeds phantom entries (live incident, 2026-10 session). Anchor
 * strict, or the phantom returns.
 *
 * Result status (extractRunStatus): wait_all collections carry per-run
 * status in HEADER LINES ("- sa-fec2e1（delegate · done · # reviewer）:"),
 * never in a result.status field. Header-line tokens only — the body text
 * below can say "done" without the run being done.
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

// --- Spawn ack parsing (phantom-spawn guard) ---

/**
 * Parse a spawn acknowledgement into {runId, template}.
 *
 * Returns null unless the text's FIRST LINE starts with a known dispatch
 * verb (Delegated / Spawned / Dispatched / started) followed by the run id
 * on the SAME line. The template comes from "Template: <name>" in the ack
 * when present. Anything else — notably the validation-error dump of a
 * failed delegate_task that echoes arguments JSON containing fixture ack
 * text — returns null.
 */
export function extractSpawnInfo(
  text: string,
): { runId: string; template: string | null } | null {
  if (!text || typeof text !== "string") return null;
  const firstLine = text.split("\n", 1)[0]?.trim() ?? "";
  const m = firstLine.match(
    /^(?:Delegated|Spawned|Dispatched|started)\b[^\n]*?(sa-[0-9a-f]{4,})/i,
  );
  if (!m) return null;
  const runId = m[1];
  const tm = text.match(/Template:\s*([^\n·]+)/);
  return { runId, template: tm ? tm[1].trim() : null };
}

// --- Per-run status from collected result text ---

/**
 * Extract a terminal status for one run from wait_all / get_result collected
 * text. Collected results truncate run ids to their first 8 chars and put
 * per-run status in a header line, e.g.
 *   "- sa-fec2e1（delegate · done · # reviewer: ...）:"
 * Only header lines (lines mentioning the run-id prefix) are inspected for
 * the tokens "done" / "error" — never the body text below them, which can
 * legitimately contain the words "done" or "error" mid-sentence while the
 * run is still working.
 */
export function extractRunStatus(
  collectedText: string,
  runIdPrefix: string,
): "done" | "error" | null {
  if (!collectedText || !runIdPrefix) return null;
  for (const line of collectedText.split("\n")) {
    if (!line.includes(runIdPrefix)) continue;
    const m = line.match(/\b(done|error)\b/);
    if (m) return m[1] as "done" | "error";
  }
  return null;
}

// --- Entry key resolution ---

/**
 * Resolve a (possibly truncated) runId to an exact state key. Exact match
 * wins; otherwise a unique prefix match in either direction (collected
 * results show 8-char prefixes; user input may be shorter than stored).
 * Ambiguous or absent → null.
 */
export function resolveEntryKey(
  state: WatchdogState,
  runId: string,
): string | null {
  if (!runId) return null;
  if (state.entries[runId]) return runId;
  const matches = Object.keys(state.entries).filter(
    (k) => k.startsWith(runId) || runId.startsWith(k),
  );
  return matches.length === 1 ? matches[0] : null;
}

// --- Directive validation ---

export interface WatchdogDirectiveFile {
  timestamp?: string;
  directives?: Array<WatchdogDirective & { message: string }>;
}

/**
 * Keep only directives whose runId resolves to an entry that is still
 * ACTIVE. Stale directive files (one-shot injection consumed late, or a
 * leftover from a crash) keep re-flagging entries that finished long ago —
 * validate at init and at injection; when nothing survives, the caller
 * deletes the file.
 */
export function filterLiveDirectives(
  state: WatchdogState,
  directives: Array<WatchdogDirective & { message: string }>,
): Array<WatchdogDirective & { message: string }> {
  return directives.filter((d) => {
    const key = resolveEntryKey(state, d.runId);
    return key !== null && state.entries[key].active;
  });
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
