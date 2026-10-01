#!/usr/bin/env node
/**
 * install-pi-web-plugins.mjs — link repo pi-web-ui plugins into the live dir.
 *
 * WHY: pi-web-ui loads plugins from <dataDir>/plugins/ (default ~/.pi-web).
 * Plugin sources live in THIS repo (scripts/pi-web-plugins/<id>/) so they are
 * version-controlled. This script junction-links each one:
 *
 *   scripts/pi-web-plugins/<id>/  <==>  ~/.pi-web/plugins/<id>/
 *
 * Junctions need no admin on Windows, and editing the repo copy edits the live
 * copy (one truth, no install-on-change). Run once after a fresh clone of the
 * repo. Idempotent: an existing correct junction is left alone; a stray real
 * directory is only replaced after its contents are moved into the repo copy.
 *
 * USAGE: node scripts/install-pi-web-plugins.mjs
 */
import { existsSync, mkdirSync, readdirSync, cpSync, rmSync, lstatSync, realpathSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";
import { execFileSync } from "node:child_process";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");
const SRC_DIR = join(ROOT, "scripts", "pi-web-plugins");
const LIVE_DIR = join(process.env.PI_WEB_DATA_DIR ?? join(homedir(), ".pi-web"), "plugins");

if (!existsSync(SRC_DIR)) {
  console.log(`nothing to install (${SRC_DIR} missing)`);
  process.exit(0);
}

const isWin = process.platform === "win32";

/** Returns "linked" | "already" | "copied-linked" for one plugin id. */
function linkPlugin(id) {
  const src = join(SRC_DIR, id);
  const dst = join(LIVE_DIR, id);
  mkdirSync(LIVE_DIR, { recursive: true });

  if (existsSync(dst)) {
    // Already a junction pointing at src?
    try {
      if (lstatSync(dst).isSymbolicLink() && resolve(realpathSync(dst)) === resolve(realpathSync(src))) {
        return "already";
      }
    } catch {}
    // Real directory sitting in the live location: adopt its contents into the
    // repo copy (first-one-wins per file), then replace with the junction.
    const intoSrc = cpSync(dst, src, { recursive: true, force: false, errorOnExist: false });
    void intoSrc;
    rmSync(dst, { recursive: true, force: true });
    link(src, dst);
    return "copied-linked";
  }
  link(src, dst);
  return "linked";
}

function link(src, dst) {
  if (isWin) {
    // mklink is a cmd builtin; /J = directory junction (no admin required).
    execFileSync("cmd", ["/c", "mklink", "/J", dst, src], { stdio: ["ignore", "pipe", "pipe"] });
    return;
  }
  execFileSync("ln", ["-s", src, dst]);
}

const ids = readdirSync(SRC_DIR, { withFileTypes: true })
  .filter((d) => d.isDirectory() && existsSync(join(SRC_DIR, d.name, "manifest.json")))
  .map((d) => d.name);

if (ids.length === 0) {
  console.log("no plugin dirs with manifest.json under scripts/pi-web-plugins/");
  process.exit(0);
}

let failed = 0;
for (const id of ids) {
  try {
    const how = linkPlugin(id);
    console.log(`${id}: ${how}`);
  } catch (e) {
    failed++;
    console.error(`${id}: FAILED — ${e.message || e}`);
  }
}
process.exit(failed ? 1 : 0);
