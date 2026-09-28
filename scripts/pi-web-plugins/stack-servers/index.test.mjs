#!/usr/bin/env node
/**
 * Pure-Node tests for scripts/pi-web-plugins/stack-servers/index.mjs.
 *
 * No host, no network, no spawning. Imports only the pure helpers so the test
 * stays fast and deterministic even when pi-web-ui is down.
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  parseNetstatPids,
  authLabel,
  authStatus,
  rootLabel,
  buildAuthStartCommand,
  buildAuthStartArgs,
  buildRootStopArgs,
} from "./index.mjs";

// ---------------------------------------------------------------------------
// parseNetstatPids — same contract as restart-stack's helper (local copy so
// the plugin stays self-contained; test it the same way).

test("parseNetstatPids: returns the single PID for LISTENING lines", () => {
  const sample = [
    "Active Connections",
    "",
    "  Proto  Local Address          Foreign Address        State           PID",
    "  TCP    0.0.0.0:4103           0.0.0.0:0              LISTENING       26912",
    "  TCP    [::]:4103              [::]:0                 LISTENING       26912",
  ].join("\n");
  assert.deepEqual(parseNetstatPids(sample, 4103), [26912]);
});

test("parseNetstatPids: dedupes repeated PIDs and ignores other states", () => {
  const sample = [
    "  TCP    0.0.0.0:8787           0.0.0.0:0              LISTENING       27488",
    "  TCP    [::]:8787              [::]:0                 LISTENING       27488",
    "  TCP    0.0.0.0:8787           192.168.0.1:50000      ESTABLISHED     27488",
    "  TCP    0.0.0.0:4103           0.0.0.0:0              LISTENING       27488",
  ].join("\n");
  assert.deepEqual(parseNetstatPids(sample, 8787), [27488]);
  // The :4103 LISTENING line must not leak into an :8787 query.
  assert.deepEqual(parseNetstatPids(sample, 4103), [27488]);
});

test("parseNetstatPids: ignores non-LISTENING lines and wrong ports", () => {
  const sample = [
    "  TCP    0.0.0.0:4103           192.168.0.1:50000      ESTABLISHED     9999",
    "  TCP    0.0.0.0:8787           192.168.0.1:50001      TIME_WAIT       8888",
    "  TCP    0.0.0.0:41030          0.0.0.0:0              LISTENING       7777",
  ].join("\n");
  assert.deepEqual(parseNetstatPids(sample, 4103), []);
  assert.deepEqual(parseNetstatPids(sample, 8787), []);
});

test("parseNetstatPids: tolerates empty / garbage input", () => {
  assert.deepEqual(parseNetstatPids("", 8787), []);
  assert.deepEqual(parseNetstatPids(null, 8787), []);
  assert.deepEqual(parseNetstatPids("not a netstat dump", 8787), []);
});

// ---------------------------------------------------------------------------
// Labels + status derivation

test("authLabel / authStatus reflect up and down states", () => {
  assert.equal(authLabel([26912]), "Auth proxy :4103 (PID 26912)");
  assert.equal(authLabel([]), "Auth proxy :4103 (down)");
  assert.equal(authStatus([26912]), "running");
  assert.equal(authStatus([]), "stopped");
});

test("rootLabel names the port and the full-stack stop semantic", () => {
  const label = rootLabel();
  assert.ok(label.includes(":8787"), "label names the web port");
  assert.ok(label.toLowerCase().includes("stop = full stack"), "label warns about full-stack stop");
});

// ---------------------------------------------------------------------------
// buildAuthStartCommand — must mirror scripts/start-pi-stack.ps1's invocation
// (quoted node + quoted auth-proxy path, ports as bare tokens, localhost upstream).

test("buildAuthStartCommand mirrors the launcher invocation", () => {
  const cmd = buildAuthStartCommand({
    root: "E:\\Glitch AI\\glitch-pi",
    nodeExe: "E:\\Glitch AI\\glitch-pi\\data\\node\\node.exe",
    authPort: 4103,
    webPort: 8787,
  });
  assert.ok(cmd.startsWith('"E:\\Glitch AI\\glitch-pi\\data\\node\\node.exe"'), "starts with quoted node path");
  assert.ok(cmd.includes('"E:\\Glitch AI\\glitch-pi\\plugins\\auth-proxy.mjs"'), "contains quoted auth-proxy path");
  assert.ok(cmd.endsWith("4103 http://localhost:8787"), "ends with ports and upstream");
  assert.ok(!cmd.includes("  "), "no double spaces (start-detached writes this into a .cmd file)");
});

test("buildAuthStartCommand falls back to defaults when called bare", () => {
  const cmd = buildAuthStartCommand({});
  assert.ok(cmd.includes("auth-proxy.mjs"), "default root resolves the proxy script");
  assert.ok(cmd.includes("http://localhost:8787"), "default ports");
});

// ---------------------------------------------------------------------------
// Helper argvs. The spawn that uses these must NOT pass `detached: true`:
// under the pi-web-ui host that flag made this exact spawn a silent no-op
// (exit 0, no output, no side effects) on this machine.

test("buildAuthStartArgs targets start-detached.ps1 with the auth-proxy command", () => {
  const args = buildAuthStartArgs({
    root: "E:\\Glitch AI\\glitch-pi",
    nodeExe: "E:\\Glitch AI\\glitch-pi\\data\\node\\node.exe",
  });
  assert.equal(args[0], "-NoProfile");
  assert.ok(args.includes("E:\\Glitch AI\\glitch-pi\\scripts\\start-detached.ps1"));
  const cmdIdx = args.indexOf("-Command");
  assert.ok(cmdIdx > 0, "passes -Command");
  assert.ok(args[cmdIdx + 1].includes('node.exe"'), "command value quotes the node path");
  assert.equal(args[args.length - 1], "auth-proxy-pi", "log/pid file name is stable");
});

test("buildRootStopArgs targets the servers-only stop helper", () => {
  const args = buildRootStopArgs({ root: "E:\\Glitch AI\\glitch-pi" });
  assert.ok(args.includes("E:\\Glitch AI\\glitch-pi\\scripts\\stop-stack-servers.ps1"));
  assert.ok(!args.includes("-Command"), "no nested command string for the root stop");
});
