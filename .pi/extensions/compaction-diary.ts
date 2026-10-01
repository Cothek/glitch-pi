/**
 * compaction-diary.ts — Pi extension: Glitch compaction diary hook (Plan 2 §11 Phase 3)
 *
 * On `session_before_compact`:
 *   1. Refresh the heartbeat in THIS session's scratchpad
 *      (user/sessions/<sessionID>/current-session.md — created if missing)
 *   2. Merge the session scratchpad into the shared user/current-session.md
 *      via the clobber-guarded, idempotent merge (memory-paths.mjs)
 *   3. Ensure today's daily-diary file exists (skeleton if missing)
 *   4. Append a short pre-compaction note to the diary
 *
 * Does NOT replace default summarization — returns undefined so Pi's
 * default compaction runs (same fallback pattern as custom-compaction.ts).
 *
 * Scratchpad ownership (2026-09-30, plan 01a0e0c4): live sessions append to
 * their OWN session scratchpad during work; the shared file is written ONLY
 * by this guarded merge and the trimmer (run-compaction.mjs). This ends the
 * many-writer churn (out-of-order heartbeats, interleaved recaps, duplicate
 * blocks) that one shared scratchpad produced under parallel sessions.
 *
 * Paths: Glitch memory root is the glitch-pi checkout (unified 2026-09-29:
 * glitch-pi/user is the live memory repo, also junction-aliased at
 * ~/.pi/agent/user). glitch-ai/user is the frozen legacy backup — do not
 * write there.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { ensureSessionScratchpad, mergeSessionIntoShared } from "../lib/memory-paths.mjs";

const GLITCH_ROOT = "E:/Glitch AI/glitch-pi";
const USER_DIR = path.join(GLITCH_ROOT, "user");
const DIARY_DIR = path.join(USER_DIR, "daily-diary", "current");

function todayUtc(): string {
  return new Date().toISOString().slice(0, 10);
}

function isoNow(): string {
  return new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
}

/** Session id extraction — identical chain to mulahazah.ts (proven in live runs). */
function sessionIDFromCtx(ctx: any): string {
  return String(
    ctx?.sessionID ||
    ctx?.sessionId ||
    ctx?.sessionManager?.sessionId ||
    ctx?.sessionManager?.id ||
    "default"
  );
}

function ensureDiary(today: string): string {
  fs.mkdirSync(DIARY_DIR, { recursive: true });
  const file = path.join(DIARY_DIR, `${today}.md`);
  if (!fs.existsSync(file)) {
    const skeleton = [
      "---",
      "type: DailyDiary",
      `title: Daily Diary — ${today}`,
      `description: Session observations and work log for ${today}.`,
      "tags: [troy, diary]",
      `timestamp: ${today}T00:00:00Z`,
      "---",
      "",
      `# Daily Diary — ${today}`,
      "",
      "## Session Notes",
      "",
    ].join("\n");
    fs.writeFileSync(file, skeleton, "utf8");
  }
  return file;
}

function appendDiaryNote(diaryPath: string): void {
  const line = `\n- **${isoNow()}** — Pre-compaction checkpoint: session scratchpad heartbeat refreshed; guarded merge into shared file; default compaction proceeding.\n`;
  fs.appendFileSync(diaryPath, line, "utf8");
}

export default function (pi: ExtensionAPI) {
  pi.on("session_before_compact", async (_event, ctx) => {
    try {
      const today = todayUtc();
      const iso = isoNow();
      const sid = sessionIDFromCtx(ctx as any);

      // 1. Session scratchpad heartbeat (creates the file with a skeleton
      //    on first compaction of the session).
      await ensureSessionScratchpad({ userDir: USER_DIR, sessionId: sid, isoNow: iso });

      // 2. Clobber-guarded, idempotent merge into the shared view. A rival
      //    session's concurrent write never gets overwritten: the merge aborts
      //    (reason "clobbered") and retries naturally at the next compaction.
      const merge = await mergeSessionIntoShared({ userDir: USER_DIR, sessionId: sid, isoNow: iso });

      // 3-4. Daily diary.
      const diaryPath = ensureDiary(today);
      appendDiaryNote(diaryPath);

      const suffix = merge.merged ? "" : ` (merge skipped: ${merge.reason})`;
      ctx.ui.notify(`[compaction-diary] scratchpad + diary ${today} updated${suffix}`, "info");
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      ctx.ui.notify(`[compaction-diary] skipped: ${msg}`, "warning");
    }
    // No return value → default compaction runs
  });
}
