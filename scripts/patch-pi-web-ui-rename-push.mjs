// Reapplies the glitch-pi local patch: conversation renames must re-push the
// conversations list to OTHER client sessions (elsewhere rows), not just the
// owning one. Upstream pi-web-ui (<=0.96.1) only pokes on streaming-set
// changes. Run after any `npm install pi-web-ui` upgrade.
// Usage: node scripts/patch-pi-web-ui-rename-push.mjs
import { readFileSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const MARK = "glitch-pi local patch: title changes must re-push";

const targets = [
  {
    file: "data/node/node_modules/pi-web-ui/dist/server/agent-service.js",
    anchor:
      "            this.emitConversations();\n            this.invalidateSessionInfos();\n            await this.refreshSessions();",
    inject:
      "            this.emitConversations();\n            // " +
      MARK +
      "\n            this.onRunningChanged?.();\n            this.invalidateSessionInfos();\n            await this.refreshSessions();",
  },
  {
    file: "data/node/node_modules/pi-web-ui/dist/server/dsh/dsh-agent-service.js",
    anchor: null, // matched by regex below (class body differs in indent)
    regex: /(conv\.title = trimmed;\n\s*this\.emitConversations\(\);\n)(\s*\}\n\s*async deleteSession)/,
    inject: (m, p1, p2) =>
      `${p1}        // ${MARK}\n        this.onRunningChanged?.();\n${p2}`,
  },
];

let failed = false;
for (const t of targets) {
  const path = join(root, t.file);
  let src;
  try {
    src = readFileSync(path, "utf8");
  } catch {
    console.error(`SKIP (missing): ${t.file}`);
    failed = true;
    continue;
  }
  if (src.includes(MARK)) {
    console.log(`OK (already patched): ${t.file}`);
    continue;
  }
  let out;
  if (t.anchor) {
    if (!src.includes(t.anchor)) {
      console.error(`ANCHOR NOT FOUND: ${t.file} — upstream changed; patch manually`);
      failed = true;
      continue;
    }
    out = src.replace(t.anchor, t.inject);
  } else {
    if (!t.regex.test(src)) {
      console.error(`REGEX NOT FOUND: ${t.file} — upstream changed; patch manually`);
      failed = true;
      continue;
    }
    out = src.replace(t.regex, t.inject);
  }
  writeFileSync(path, out);
  console.log(`PATCHED: ${t.file}`);
}
process.exit(failed ? 1 : 0);
