/**
 * compaction-diary.ts — Pi extension: Glitch compaction diary hook (Plan 2 §11 Phase 3)
 *
 * On `session_before_compact`:
 *   1. Update `Last Memory Update` in user/current-session.md (heartbeat)
 *   2. Ensure today's daily-diary file exists (skeleton if missing)
 *   3. Append a short pre-compaction note to the diary
 *
 * Does NOT replace default summarization — returns undefined so Pi's
 * default compaction runs (same fallback pattern as custom-compaction.ts).
 *
 * Paths: Glitch memory root is the glitch-ai checkout (canonical), same
 * convention as memory-tools.ts recall DB.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const GLITCH_ROOT = "E:/Glitch AI/glitch-ai";
const USER_DIR = path.join(GLITCH_ROOT, "user");
const CURRENT_SESSION = path.join(USER_DIR, "current-session.md");
const DIARY_DIR = path.join(USER_DIR, "daily-diary", "current");

function todayUtc(): string {
  return new Date().toISOString().slice(0, 10);
}

function isoNow(): string {
  return new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
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

function updateHeartbeat(): void {
  if (!fs.existsSync(CURRENT_SESSION)) return;
  const now = isoNow();
  let content = fs.readFileSync(CURRENT_SESSION, "utf8");
  const next = content.replace(
    /## Last Memory Update: [^\r\n]+/,
    `## Last Memory Update: ${now}`,
  );
  if (next !== content) {
    fs.writeFileSync(CURRENT_SESSION, next, "utf8");
  } else if (!/## Last Memory Update:/.test(content)) {
    fs.writeFileSync(
      CURRENT_SESSION,
      `## Last Memory Update: ${now}\n\n${content}`,
      "utf8",
    );
  }
}

function appendDiaryNote(diaryPath: string): void {
  const line = `\n- **${isoNow()}** — Pre-compaction checkpoint: heartbeat refreshed; default compaction proceeding.\n`;
  fs.appendFileSync(diaryPath, line, "utf8");
}

export default function (pi: ExtensionAPI) {
  pi.on("session_before_compact", async (_event, ctx) => {
    try {
      const today = todayUtc();
      updateHeartbeat();
      const diaryPath = ensureDiary(today);
      appendDiaryNote(diaryPath);
      ctx.ui.notify(`[compaction-diary] heartbeat + diary ${today} updated`, "info");
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      ctx.ui.notify(`[compaction-diary] skipped: ${msg}`, "warning");
    }
    // No return value → default compaction runs
  });
}
