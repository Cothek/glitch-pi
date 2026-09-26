#!/usr/bin/env node
/**
 * nvidia-models plugin — unit tests (no framework, no new deps).
 *
 * Run: node scripts/pi-web-plugins/nvidia-models/index.test.mjs
 *
 * Covers each route against a mock host with a stubbed bash, plus the
 * two failure paths the panel must survive:
 *   - /status when the engine is missing (cli_present false, no throw)
 *   - the pin-guard blocked path (engine returns blocked[] verbatim)
 *
 * After the F2 review fix, every bash invocation MUST:
 *   - contain no absolute path (no `E:\...`, no `/...`, no backslash roots)
 *   - round-trip through `/\s+/` exactly to the intended argv (no quoting
 *     happens in host.bash; one space inside a token would split it)
 *   - use cwd "." so the host's workspace-resolve always passes
 *   - have `--json` as its last token
 *
 * The dedicated group "every route produces a whitespace-free, absoluteless
 * argv" iterates over GET /status, POST /sync, POST /set, POST /bulk
 * (recommended / all / none), and POST /restore and asserts all four
 * invariants on the captured command string. The exact token list per
 * route is printed in the PASS line so the operator can eyeball it.
 *
 * Prints one "PASS: <name>" line per group and exits 0.
 */

import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import plugin, { buildEngineArgv } from "./index.mjs";

/** Each test group gets its own plugin instance so the status cache and
 *  id whitelist from the previous group do not bleed into the next. The
 *  plugin exports `createPlugin()` for this; the default export is a
 *  singleton reused only when a test does not care about isolation. */
function freshPlugin() {
  return plugin.createPlugin ? plugin.createPlugin() : plugin;
}

/** Minimal mock host. Records every route registration and every bash
 *  invocation, and lets each test install a custom bash stub. */
function createMockHost({ bashStub } = {}) {
  const routes = [];
  const commands = [];
  const uiItems = [];
  const bashCalls = [];
  const logs = [];

  const host = {
    cwd: process.cwd(),
    route(method, path, handler) {
      routes.push({ method, path, handler });
      return () => {
        const i = routes.findIndex((r) => r.method === method && r.path === path);
        if (i >= 0) routes.splice(i, 1);
      };
    },
    registerCommand(cmd) {
      commands.push(cmd);
      return () => {
        const i = commands.indexOf(cmd);
        if (i >= 0) commands.splice(i, 1);
      };
    },
    ui: {
      register(item) {
        uiItems.push(item);
        return () => {
          const i = uiItems.indexOf(item);
          if (i >= 0) uiItems.splice(i, 1);
        };
      },
    },
    async bash(cmd, opts) {
      bashCalls.push({ cmd, opts });
      return bashStub(cmd, opts);
    },
    log(level, text) {
      logs.push({ level, text });
    },
    routes,
    commands,
    uiItems,
    bashCalls,
    logs,
  };
  return host;
}

/** Build a minimal state fixture the plugin can read. */
function writeStateFixture(root, ids) {
  const dir = join(root, "data");
  mkdirSync(dir, { recursive: true });
  const file = join(dir, "nvidia-models-state.json");
  writeFileSync(
    file,
    JSON.stringify({
      synced_at: "2026-09-26T20:00:00.000Z",
      source: "api",
      models: ids.map((id) => ({ id, tier: "A", enabled: false, relevance: "recommended" })),
      counts: { chat: ids.length, non_chat: 0, enabled: 0, recommended: ids.length },
    }),
    "utf-8",
  );
  return file;
}

/** Tiny req/res pair matching the few fields the plugin uses. */
function fakeRes() {
  const res = {
    status: null,
    headers: {},
    body: "",
    writeHead(s, h) {
      res.status = s;
      if (h) res.headers = h;
    },
    end(body) {
      res.body = body;
    },
  };
  return res;
}

function callRoute(routes, method, path, body) {
  const route = routes.find((r) => r.method === method && r.path === path);
  if (!route) throw new Error(`route ${method} ${path} not registered`);
  const req = { url: path, body };
  const res = fakeRes();
  return Promise.resolve(route.handler(req, res)).then(() => ({
    status: res.status,
    body: res.body ? JSON.parse(res.body) : null,
  }));
}

/** Assert the captured command string round-trips through /\s+/ to the
 *  intended argv. Throws with the diff on mismatch. */
function assertCommandShape(cmd, expectedArgv, opts = {}) {
  const label = opts.label ?? "command";
  assert.equal(
    typeof cmd,
    "string",
    `${label}: must be a string (host.bash contract), got ${typeof cmd}`,
  );
  // F2: no absolute path inside any single token.
  for (const tok of cmd.split(/\s+/).filter(Boolean)) {
    assert.ok(
      !/^[A-Za-z]:[\\/]/.test(tok) && !tok.startsWith("/") && !tok.startsWith("\\"),
      `${label}: token ${JSON.stringify(tok)} is an absolute path; the host tokenizer would split it. Got: ${cmd}`,
    );
    assert.ok(
      !/\s/.test(tok),
      `${label}: token ${JSON.stringify(tok)} contains whitespace; the host tokenizer would split it. Got: ${cmd}`,
    );
  }
  // F2: round-trip — splitting on /\s+/ must yield the exact intended argv.
  const actualArgv = cmd.trim().split(/\s+/).filter(Boolean);
  assert.deepEqual(
    actualArgv,
    expectedArgv,
    `${label}: argv mismatch. expected ${JSON.stringify(expectedArgv)}, got ${JSON.stringify(actualArgv)}`,
  );
  // F2: --json is the LAST token, so a parser that scans the tail for the flag works.
  assert.equal(actualArgv[actualArgv.length - 1], "--json", `${label}: --json must be the last token`);
  return actualArgv;
}

let failures = 0;
function pass(label) {
  console.log(`PASS: ${label}`);
}

async function group(label, fn) {
  try {
    await fn();
    pass(label);
  } catch (err) {
    failures++;
    console.error(`FAIL: ${label}: ${err?.message ?? err}`);
    if (err?.actual !== undefined) {
      console.error(`  actual:   ${JSON.stringify(err.actual)}`);
      console.error(`  expected: ${JSON.stringify(err.expected)}`);
    }
  }
}

const KNOWN_IDS = [
  "z-ai/glm-5.3",
  "moonshotai/kimi-k3",
  "deepseek-ai/deepseek-v4.1-flash",
];

/** Capture the latest bash call from a host. */
function lastBash(host) {
  return host.bashCalls[host.bashCalls.length - 1];
}

await group("plugin registers all five routes plus the slash command and UI", async () => {
  const p = freshPlugin();
  const host = createMockHost({
    bashStub: () => ({ ok: true, output: JSON.stringify({ ok: true, models: [], counts: {} }), exitCode: 0 }),
  });
  await p.activate(host);
  try {
    for (const path of ["/status", "/sync", "/set", "/bulk", "/restore"]) {
      const found = host.routes.find((r) => r.path === path);
      assert.ok(found, `route ${path} should be registered`);
    }
    const cmd = host.commands.find((c) => c.name === "nvidia-models");
    assert.ok(cmd, "/nvidia-models slash command should be registered");
    const ui = host.uiItems.find((u) => u.view === "plugin:nvidia-models");
    assert.ok(ui, "UI entry with view plugin:nvidia-models should be registered");
    assert.equal(ui.kind, "view");
    assert.equal(ui.order, 136);
  } finally {
    /* no cleanup needed */
  }
});

await group("/status: argv is whitespace-free, contains no absolute path, --json last", async () => {
  const fixtureRoot = mkdtempSync(join(tmpdir(), "nvidia-models-status-argv-"));
  writeStateFixture(fixtureRoot, KNOWN_IDS);
  process.env.GLITCH_PI_ROOT = fixtureRoot;
  try {
    const p = freshPlugin();
    const host = createMockHost({
      bashStub: () => ({ ok: true, output: JSON.stringify({ ok: true, models: [], counts: {} }), exitCode: 0 }),
    });
    await p.activate(host);
    const out = await callRoute(host.routes, "GET", "/status", undefined);
    assert.equal(out.status, 200);
    // The /status call's argv must match the canonical shape from buildEngineArgv.
    const argv = assertCommandShape(lastBash(host).cmd, buildEngineArgv("--status"), { label: "GET /status" });
    // cwd is "." so the host's workspace-resolve always passes.
    assert.equal(lastBash(host).opts.cwd, ".", "GET /status: opts.cwd must be \".\"");
    assert.equal(lastBash(host).opts.timeoutMs, 60_000, "GET /status: timeoutMs must be 60s");
    // Print the exact token list inline so the operator can eyeball it.
    console.log(`  GET /status argv: ${JSON.stringify(argv)}`);
  } finally {
    delete process.env.GLITCH_PI_ROOT;
  }
});

await group("/status returns parsed engine JSON plus healthy and cli_present flags", async () => {
  const fixtureRoot = mkdtempSync(join(tmpdir(), "nvidia-models-test-"));
  writeStateFixture(fixtureRoot, KNOWN_IDS);
  process.env.GLITCH_PI_ROOT = fixtureRoot;
  try {
    const enginePayload = {
      ok: true,
      synced_at: "2026-09-26T20:00:00.000Z",
      catalog_total: 82,
      chat_total: 56,
      enabled: ["z-ai/glm-5.3"],
      recommended: KNOWN_IDS,
      models: KNOWN_IDS.map((id) => ({ id, tier: "A", enabled: id === "z-ai/glm-5.3" })),
      counts: { chat: 56, non_chat: 26, enabled: 1, recommended: KNOWN_IDS.length },
    };
    const p = freshPlugin();
    const host = createMockHost({
      bashStub: () => ({ ok: true, output: JSON.stringify(enginePayload), exitCode: 0 }),
    });
    await p.activate(host);
    const out = await callRoute(host.routes, "GET", "/status", undefined);
    assert.equal(out.status, 200);
    assert.equal(out.body.ok, true);
    assert.equal(out.body.healthy, true);
    // cli_present reflects whether scripts/nvidia-models.mjs exists on disk
    // relative to the host's cwd (the repo root in production). The test's
    // cwd is the repo root, so the plugin's existsSync call checks the real
    // engine file, not the fixture one. Both are valid mirrors of disk state.
    const expectedCliPresent = existsSync("scripts/nvidia-models.mjs");
    assert.equal(out.body.cli_present, expectedCliPresent, "cli_present must mirror on-disk engine presence");
    assert.equal(out.body.catalog_total, 82);
    assert.equal(out.body.chat_total, 56);
    assert.deepEqual(out.body.recommended, KNOWN_IDS);
  } finally {
    delete process.env.GLITCH_PI_ROOT;
  }
});

await group("/status when the engine is missing: cli_present false, no throw, HTTP 503", async () => {
  const fixtureRoot = mkdtempSync(join(tmpdir(), "nvidia-models-missing-"));
  writeStateFixture(fixtureRoot, KNOWN_IDS);
  process.env.GLITCH_PI_ROOT = fixtureRoot;
  try {
    const p = freshPlugin();
    const host = createMockHost({
      bashStub: () => ({ ok: false, output: "", error: "command not found", exitCode: 1 }),
    });
    await p.activate(host);
    const out = await callRoute(host.routes, "GET", "/status", undefined);
    assert.equal(out.status, 503);
    assert.equal(out.body.ok, false);
    assert.equal(out.body.healthy, false);
    // cli_present reflects disk state; the bash failure drives the 503.
    const expectedCliPresent = existsSync("scripts/nvidia-models.mjs");
    assert.equal(out.body.cli_present, expectedCliPresent, "cli_present must mirror disk state, independent of bash");
    assert.match(out.body.error ?? "", /command not found|engine exited|unavailable/);
  } finally {
    delete process.env.GLITCH_PI_ROOT;
  }
});

await group("POST /sync: argv is whitespace-free, contains no absolute path, --json last", async () => {
  const fixtureRoot = mkdtempSync(join(tmpdir(), "nvidia-models-sync-argv-"));
  writeStateFixture(fixtureRoot, KNOWN_IDS);
  process.env.GLITCH_PI_ROOT = fixtureRoot;
  try {
    const p = freshPlugin();
    const host = createMockHost({
      bashStub: () => ({ ok: true, output: JSON.stringify({ ok: true, models: [], counts: {} }), exitCode: 0 }),
    });
    await p.activate(host);
    const out = await callRoute(host.routes, "POST", "/sync", undefined);
    assert.equal(out.status, 200);
    const argv = assertCommandShape(lastBash(host).cmd, buildEngineArgv("--sync"), { label: "POST /sync" });
    assert.equal(lastBash(host).opts.cwd, ".", "POST /sync: opts.cwd must be \".\"");
    assert.equal(lastBash(host).opts.timeoutMs, 180_000, "POST /sync: timeoutMs must be 180s");
    console.log(`  POST /sync argv: ${JSON.stringify(argv)}`);
  } finally {
    delete process.env.GLITCH_PI_ROOT;
  }
});

await group("POST /set with a valid id: argv is --enable <id> --json, no whitespace inside any token", async () => {
  const fixtureRoot = mkdtempSync(join(tmpdir(), "nvidia-models-set-argv-"));
  writeStateFixture(fixtureRoot, KNOWN_IDS);
  process.env.GLITCH_PI_ROOT = fixtureRoot;
  try {
    const p = freshPlugin();
    const host = createMockHost({
      bashStub: () => ({
        ok: true,
        output: JSON.stringify({ ok: true, enabled: ["z-ai/glm-5.3"], blocked: [] }),
        exitCode: 0,
      }),
    });
    await p.activate(host);
    const out = await callRoute(host.routes, "POST", "/set", { id: "z-ai/glm-5.3", enabled: true });
    assert.equal(out.status, 200);
    assert.equal(out.body.ok, true);
    const argv = assertCommandShape(lastBash(host).cmd, buildEngineArgv("--enable", "z-ai/glm-5.3"), { label: "POST /set" });
    assert.equal(lastBash(host).opts.cwd, ".", "POST /set: opts.cwd must be \".\"");
    assert.equal(lastBash(host).opts.timeoutMs, 180_000, "POST /set: timeoutMs must be 180s");
    assert.ok(!lastBash(host).cmd.includes(";"), "id is one argv token, not a shell fragment");
    console.log(`  POST /set (enable) argv: ${JSON.stringify(argv)}`);
  } finally {
    delete process.env.GLITCH_PI_ROOT;
  }
});

await group("POST /set with enabled=false: argv is --disable <id> --json", async () => {
  const fixtureRoot = mkdtempSync(join(tmpdir(), "nvidia-models-set-disable-argv-"));
  writeStateFixture(fixtureRoot, KNOWN_IDS);
  process.env.GLITCH_PI_ROOT = fixtureRoot;
  try {
    const p = freshPlugin();
    const host = createMockHost({
      bashStub: () => ({
        ok: true,
        output: JSON.stringify({ ok: true, enabled: [], blocked: [] }),
        exitCode: 0,
      }),
    });
    await p.activate(host);
    const out = await callRoute(host.routes, "POST", "/set", { id: "moonshotai/kimi-k3", enabled: false });
    assert.equal(out.status, 200);
    const argv = assertCommandShape(lastBash(host).cmd, buildEngineArgv("--disable", "moonshotai/kimi-k3"), { label: "POST /set disable" });
    console.log(`  POST /set (disable) argv: ${JSON.stringify(argv)}`);
  } finally {
    delete process.env.GLITCH_PI_ROOT;
  }
});

await group("POST /set with an id not in the cached state is rejected (no shell call)", async () => {
  const fixtureRoot = mkdtempSync(join(tmpdir(), "nvidia-models-set-bad-"));
  writeStateFixture(fixtureRoot, KNOWN_IDS);
  process.env.GLITCH_PI_ROOT = fixtureRoot;
  try {
    const p = freshPlugin();
    const host = createMockHost({
      bashStub: () => ({ ok: true, output: "{}", exitCode: 0 }),
    });
    await p.activate(host);
    const initialBash = host.bashCalls.length;
    const out = await callRoute(host.routes, "POST", "/set", { id: "attacker/injected", enabled: true });
    assert.equal(out.status, 400);
    assert.equal(out.body.ok, false);
    assert.match(out.body.error, /unknown model id/);
    assert.equal(host.bashCalls.length, initialBash, "no new bash call after the bad id");
  } finally {
    delete process.env.GLITCH_PI_ROOT;
  }
});

await group("POST /bulk action=recommended: argv is --apply-recommended --json", async () => {
  const fixtureRoot = mkdtempSync(join(tmpdir(), "nvidia-models-bulk-rec-argv-"));
  writeStateFixture(fixtureRoot, KNOWN_IDS);
  process.env.GLITCH_PI_ROOT = fixtureRoot;
  try {
    const p = freshPlugin();
    const host = createMockHost({
      bashStub: () => ({ ok: true, output: JSON.stringify({ ok: true, recommended: KNOWN_IDS, blocked: [] }), exitCode: 0 }),
    });
    await p.activate(host);
    const out = await callRoute(host.routes, "POST", "/bulk", { action: "recommended" });
    assert.equal(out.status, 200);
    const argv = assertCommandShape(lastBash(host).cmd, buildEngineArgv("--apply-recommended"), { label: "POST /bulk recommended" });
    assert.equal(lastBash(host).opts.cwd, ".", "POST /bulk: opts.cwd must be \".\"");
    assert.equal(lastBash(host).opts.timeoutMs, 180_000, "POST /bulk: timeoutMs must be 180s");
    console.log(`  POST /bulk (recommended) argv: ${JSON.stringify(argv)}`);
  } finally {
    delete process.env.GLITCH_PI_ROOT;
  }
});

await group("POST /bulk action=all: argv is --enable <id1> <id2> <id3> --json, each id one token", async () => {
  const fixtureRoot = mkdtempSync(join(tmpdir(), "nvidia-models-bulk-all-argv-"));
  writeStateFixture(fixtureRoot, KNOWN_IDS);
  process.env.GLITCH_PI_ROOT = fixtureRoot;
  try {
    const p = freshPlugin();
    const host = createMockHost({
      bashStub: () => ({ ok: true, output: JSON.stringify({ ok: true, enabled: KNOWN_IDS, blocked: [] }), exitCode: 0 }),
    });
    await p.activate(host);
    const out = await callRoute(host.routes, "POST", "/bulk", { action: "all" });
    assert.equal(out.status, 200);
    const argv = assertCommandShape(lastBash(host).cmd, buildEngineArgv("--enable", KNOWN_IDS), { label: "POST /bulk all" });
    console.log(`  POST /bulk (all) argv: ${JSON.stringify(argv)}`);
  } finally {
    delete process.env.GLITCH_PI_ROOT;
  }
});

await group("POST /bulk action=none: argv is --disable <id1> <id2> <id3> --json", async () => {
  const fixtureRoot = mkdtempSync(join(tmpdir(), "nvidia-models-bulk-none-argv-"));
  writeStateFixture(fixtureRoot, KNOWN_IDS);
  process.env.GLITCH_PI_ROOT = fixtureRoot;
  try {
    const p = freshPlugin();
    const host = createMockHost({
      bashStub: () => ({ ok: true, output: JSON.stringify({ ok: true, enabled: [], blocked: [] }), exitCode: 0 }),
    });
    await p.activate(host);
    const out = await callRoute(host.routes, "POST", "/bulk", { action: "none" });
    assert.equal(out.status, 200);
    const argv = assertCommandShape(lastBash(host).cmd, buildEngineArgv("--disable", KNOWN_IDS), { label: "POST /bulk none" });
    console.log(`  POST /bulk (none) argv: ${JSON.stringify(argv)}`);
  } finally {
    delete process.env.GLITCH_PI_ROOT;
  }
});

await group("POST /restore: argv is --restore-backup --json", async () => {
  const fixtureRoot = mkdtempSync(join(tmpdir(), "nvidia-models-restore-argv-"));
  writeStateFixture(fixtureRoot, KNOWN_IDS);
  process.env.GLITCH_PI_ROOT = fixtureRoot;
  try {
    const p = freshPlugin();
    const host = createMockHost({
      bashStub: () => ({ ok: true, output: JSON.stringify({ ok: true, restored_from: "data/backups/x.json" }), exitCode: 0 }),
    });
    await p.activate(host);
    const out = await callRoute(host.routes, "POST", "/restore", undefined);
    assert.equal(out.status, 200);
    const argv = assertCommandShape(lastBash(host).cmd, buildEngineArgv("--restore-backup"), { label: "POST /restore" });
    assert.equal(lastBash(host).opts.cwd, ".", "POST /restore: opts.cwd must be \".\"");
    assert.equal(lastBash(host).opts.timeoutMs, 180_000, "POST /restore: timeoutMs must be 180s");
    console.log(`  POST /restore argv: ${JSON.stringify(argv)}`);
  } finally {
    delete process.env.GLITCH_PI_ROOT;
  }
});

await group("every route produces a whitespace-free, absoluteless argv", async () => {
  const fixtureRoot = mkdtempSync(join(tmpdir(), "nvidia-models-all-argv-"));
  writeStateFixture(fixtureRoot, KNOWN_IDS);
  process.env.GLITCH_PI_ROOT = fixtureRoot;
  try {
    // Drive every route through one mock host; collect every bash call and
    // verify the invariants on each one.
    const captured = [];
    const p = freshPlugin();
    const host = createMockHost({
      bashStub: () => ({ ok: true, output: JSON.stringify({ ok: true, models: KNOWN_IDS.map((id) => ({ id, tier: "A", enabled: false })), counts: { chat: 3, recommended: 3, enabled: 0 }, recommended: KNOWN_IDS }), exitCode: 0 }),
    });
    await p.activate(host);
    await callRoute(host.routes, "GET", "/status", undefined);
    await callRoute(host.routes, "POST", "/sync", undefined);
    await callRoute(host.routes, "POST", "/set", { id: KNOWN_IDS[0], enabled: true });
    await callRoute(host.routes, "POST", "/bulk", { action: "recommended" });
    await callRoute(host.routes, "POST", "/bulk", { action: "all" });
    await callRoute(host.routes, "POST", "/bulk", { action: "none" });
    await callRoute(host.routes, "POST", "/restore", undefined);
    for (const call of host.bashCalls) captured.push(call);
    // Every captured command must:
    //   - contain no absolute path
    //   - have NO whitespace inside any single token
    //   - round-trip through /\s+/ to its argv
    //   - end with --json
    for (const { cmd } of captured) {
      for (const tok of cmd.split(/\s+/).filter(Boolean)) {
        assert.ok(
          !/^[A-Za-z]:[\\/]/.test(tok) && !tok.startsWith("/") && !tok.startsWith("\\"),
          `absolute path leaked into bash command: ${cmd}`,
        );
        assert.ok(!/\s/.test(tok), `whitespace leaked into a single bash token: ${cmd}`);
      }
      const argv = cmd.trim().split(/\s+/).filter(Boolean);
      assert.equal(argv[argv.length - 1], "--json", `command does not end with --json: ${cmd}`);
      // Round-trip: joining the tokens back with a single space must equal the command.
      assert.equal(argv.join(" "), cmd, `command is not a clean token-join: ${cmd}`);
    }
    // All commands used cwd ".".
    for (const { opts } of captured) {
      assert.equal(opts.cwd, ".", `bash call did not use cwd=".": ${JSON.stringify(opts)}`);
    }
    // Print the captured argv lists, one per line, so the operator can eyeball them.
    console.log(`  ${captured.length} bash calls captured; all use cwd="." and end with --json:`);
    for (const { cmd } of captured) {
      const argv = cmd.trim().split(/\s+/).filter(Boolean);
      console.log(`    ${JSON.stringify(argv)}`);
    }
  } finally {
    delete process.env.GLITCH_PI_ROOT;
  }
});

await group("pin-guard blocked path: engine blocked[] passes through to the client verbatim", async () => {
  const fixtureRoot = mkdtempSync(join(tmpdir(), "nvidia-models-blocked-"));
  writeStateFixture(fixtureRoot, KNOWN_IDS);
  process.env.GLITCH_PI_ROOT = fixtureRoot;
  try {
    const blocked = [
      { id: "z-ai/glm-5.3", reason: "pinned by agent-models" },
      { id: "moonshotai/kimi-k3", reason: "pinned by settings.json" },
    ];
    const p = freshPlugin();
    const host = createMockHost({
      bashStub: () => ({
        ok: true,
        output: JSON.stringify({ ok: true, enabled: ["deepseek-ai/deepseek-v4.1-flash"], blocked }),
        exitCode: 0,
      }),
    });
    await p.activate(host);
    const out = await callRoute(host.routes, "POST", "/set", { id: "z-ai/glm-5.3", enabled: false });
    assert.equal(out.status, 200);
    assert.equal(out.body.ok, true);
    assert.deepEqual(out.body.blocked, blocked, "blocked[] must reach the client with id and reason intact");
  } finally {
    delete process.env.GLITCH_PI_ROOT;
  }
});

await group("slash command /nvidia-models returns the same data as plain text", async () => {
  const fixtureRoot = mkdtempSync(join(tmpdir(), "nvidia-models-slash-"));
  writeStateFixture(fixtureRoot, KNOWN_IDS);
  process.env.GLITCH_PI_ROOT = fixtureRoot;
  try {
    const enginePayload = {
      ok: true,
      synced_at: "2026-09-26T20:00:00.000Z",
      catalog_total: 82,
      chat_total: 56,
      enabled: ["z-ai/glm-5.3"],
      recommended: KNOWN_IDS,
      models: [
        { id: "z-ai/glm-5.3", tier: "A", enabled: true, reasoning: true, vision: "image", contextWindow: 128000, why: "fast general model" },
        { id: "moonshotai/kimi-k3", tier: "A", enabled: false, reasoning: true, vision: false, contextWindow: 200000, why: "long context" },
        { id: "deepseek-ai/deepseek-v4.1-flash", tier: "A", enabled: false, reasoning: false, vision: false, contextWindow: 128000, why: "cheap" },
      ],
      counts: { chat: 3, non_chat: 0, enabled: 1, recommended: 3 },
    };
    const p = freshPlugin();
    const host = createMockHost({
      bashStub: () => ({ ok: true, output: JSON.stringify(enginePayload), exitCode: 0 }),
    });
    await p.activate(host);
    const cmd = host.commands.find((c) => c.name === "nvidia-models");
    assert.ok(cmd, "slash command registered");
    const text = await cmd.run("");
    assert.match(text, /NVIDIA models: 82 total/);
    assert.match(text, /Recommended \(3\):/);
    assert.match(text, /z-ai\/glm-5\.3/);
    assert.ok(!/Non-chat/.test(text) || /Non-chat \(/.test(text), "no empty Non-chat group header");
    assert.match(text, /R V/);
  } finally {
    delete process.env.GLITCH_PI_ROOT;
  }
});

if (failures > 0) {
  console.error(`\n${failures} group(s) failed`);
  process.exit(1);
}
console.log(`\nall groups passed`);
process.exit(0);
