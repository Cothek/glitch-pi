#!/usr/bin/env node
/**
 * Pure-Node tests for scripts/pi-web-plugins/restart-stack/index.mjs.
 *
 * No host, no network, no spawning. Imports only `parseNetstatPids` so the
 * test stays fast and deterministic even when pi-web-ui is down.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { parseNetstatPids, originOk } from "./index.mjs";

test("parseNetstatPids: returns the single PID for a LISTENING line", () => {
  const sample = [
    "Active Connections",
    "",
    "  Proto  Local Address          Foreign Address        State           PID",
    "  TCP    0.0.0.0:8787           0.0.0.0:0              LISTENING       1234",
    "  TCP    [::]:8787              [::]:0                 LISTENING       1234",
  ].join("\n");
  // Both lines are LISTENING and on the same port; dedupe keeps one.
  assert.deepEqual(parseNetstatPids(sample, 8787), [1234]);
});

test("parseNetstatPids: dedupes repeated PIDs across many LISTENING lines", () => {
  const sample = [
    "  TCP    0.0.0.0:8787           0.0.0.0:0              LISTENING       4321",
    "  TCP    [::]:8787              [::]:0                 LISTENING       4321",
    "  TCP    0.0.0.0:8787           192.168.0.1:50000      ESTABLISHED     4321",
    "  TCP    [::]:8787              [::]:0                 LISTENING       4321",
  ].join("\n");
  assert.deepEqual(parseNetstatPids(sample, 8787), [4321]);
});

test("parseNetstatPids: ignores a non-LISTENING line", () => {
  const sample = [
    "  TCP    0.0.0.0:8787           192.168.0.1:50000      ESTABLISHED     9999",
    "  TCP    0.0.0.0:8787           192.168.0.1:50001      TIME_WAIT       8888",
  ].join("\n");
  assert.deepEqual(parseNetstatPids(sample, 8787), []);
});

test("parseNetstatPids: ignores a different port", () => {
  const sample = [
    "  TCP    0.0.0.0:4103           0.0.0.0:0              LISTENING       5555",
    "  TCP    0.0.0.0:8787           0.0.0.0:0              LISTENING       1234",
  ].join("\n");
  assert.deepEqual(parseNetstatPids(sample, 4103), [5555]);
  assert.deepEqual(parseNetstatPids(sample, 8787), [1234]);
});

test("parseNetstatPids: tolerates an empty / garbage input", () => {
  assert.deepEqual(parseNetstatPids("", 8787), []);
  assert.deepEqual(parseNetstatPids(null, 8787), []);
  assert.deepEqual(parseNetstatPids("not a netstat dump", 8787), []);
});

// ---------------------------------------------------------------------------
// originOk — Origin / Host admission for the POST route. The host's WS rule
// (originAllowed in pi-web-ui/dist/server/index.js) is NOT applied to HTTP
// routes, so this plugin has to do the check itself.
// ---------------------------------------------------------------------------

test("originOk: allows a missing Origin header (non-browser client)", () => {
  assert.equal(originOk({ host: "127.0.0.1:8787", origin: undefined }), true);
  assert.equal(originOk({ host: "127.0.0.1:8787", origin: "" }), true);
  assert.equal(originOk({ host: "127.0.0.1:8787", origin: null }), true);
});

test("originOk: allows a matching hostname and port", () => {
  assert.equal(
    originOk({ host: "127.0.0.1:8787", origin: "http://127.0.0.1:8787" }),
    true,
  );
  assert.equal(
    originOk({ host: "localhost:8787", origin: "http://localhost:8787" }),
    true,
  );
});

test("originOk: refuses a different hostname", () => {
  assert.equal(
    originOk({ host: "127.0.0.1:8787", origin: "https://evil.example" }),
    false,
  );
});

test("originOk: refuses a matching hostname on a different port", () => {
  assert.equal(
    originOk({ host: "127.0.0.1:8787", origin: "http://127.0.0.1:9000" }),
    false,
  );
});

test("originOk: refuses the literal string 'null'", () => {
  assert.equal(originOk({ host: "127.0.0.1:8787", origin: "null" }), false);
});
