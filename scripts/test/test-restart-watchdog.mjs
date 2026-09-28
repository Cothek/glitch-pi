#!/usr/bin/env node
/**
 * Pure-Node tests for scripts/restart-watchdog.mjs.
 *
 * Imports only the named exports so importing stays side-effect-free (the
 * watchdog's entry guard guarantees no probes, no recovery, no restart).
 * probeHttp / probeTcp are verified against REAL throwaway local servers on
 * ephemeral ports - no mocking of internals.
 */
import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import net from "node:net";
import {
  parseArgs,
  probeHttp,
  probeTcp,
  parseNetstat,
  tailLines,
  buildRecoveryCommand,
  buildReport,
  buildMarker,
} from "../restart-watchdog.mjs";

const NETSTAT_SAMPLE = [
  "",
  "Active Connections",
  "",
  "  Proto  Local Address          Foreign Address        State           PID",
  "  TCP    127.0.0.1:8787         0.0.0.0:0              LISTENING       12345",
  "  TCP    0.0.0.0:4103           0.0.0.0:0              LISTENING       678",
  "  TCP    [::]:8787              [::]:0                 LISTENING       12345",
  "  TCP    127.0.0.1:8787         127.0.0.1:52000        ESTABLISHED     12345",
  "  TCP    10.0.0.5:9999          0.0.0.0:0              LISTENING       42",
  "",
].join("\r\n");

test("parseNetstat: extracts LISTENING PIDs for the requested ports only", () => {
  const out = parseNetstat(NETSTAT_SAMPLE, [8787, 4103]);
  assert.deepEqual(out["8787"].sort((a, b) => a - b), [12345]);
  assert.deepEqual(out["4103"], [678]);
});

test("parseNetstat: handles IPv6 local addresses", () => {
  const out = parseNetstat("TCP    [::]:8787              [::]:0                 LISTENING       555", [8787]);
  assert.deepEqual(out["8787"], [555]);
});

test("parseNetstat: ignores ESTABLISHED lines and ports not requested", () => {
  const out = parseNetstat(NETSTAT_SAMPLE, [9999]);
  // 9999 is requested but its line IS listening - included.
  assert.deepEqual(out["9999"], [42]);
  const out2 = parseNetstat(NETSTAT_SAMPLE, [1234]);
  assert.deepEqual(out2["1234"], []);
});

test("parseNetstat: dedupes PIDs and survives empty input", () => {
  const dup = "TCP    0.0.0.0:8787    0.0.0.0:0    LISTENING    9\r\nTCP    [::]:8787    [::]:0    LISTENING    9";
  assert.deepEqual(parseNetstat(dup, [8787])["8787"], [9]);
  assert.deepEqual(parseNetstat("", [8787]), { "8787": [] });
  assert.deepEqual(parseNetstat(null, [8787]), { "8787": [] });
});

test("tailLines: last N non-empty lines, each capped at 500 chars", () => {
  const text = ["a", "", "b", "c", "d"].join("\n");
  assert.deepEqual(tailLines(text, 2), ["c", "d"]);
  const long = "x".repeat(900);
  const out = tailLines(`${long}\ny`, 5);
  assert.equal(out[0].length, 500);
  assert.equal(out[1], "y");
  assert.deepEqual(tailLines(null), []);
  assert.deepEqual(tailLines(""), []);
});

test("parseArgs: defaults", () => {
  const out = parseArgs([]);
  assert.equal(out.delay, 0);
  assert.equal(out.downWait, 45);
  assert.equal(out.timeout, 180);
  assert.equal(out.webPort, 8787);
  assert.equal(out.authPort, 4103);
  assert.equal(out.noRecovery, false);
  assert.equal(out.error, null);
});

test("parseArgs: accepts flags and --no-recovery", () => {
  const out = parseArgs([
    "--delay", "10", "--down-wait", "8", "--timeout", "60",
    "--web-port", "9000", "--auth-port", "9001",
    "--note", "test trigger", "--no-recovery", "--json",
  ]);
  assert.equal(out.delay, 10);
  assert.equal(out.downWait, 8);
  assert.equal(out.timeout, 60);
  assert.equal(out.webPort, 9000);
  assert.equal(out.authPort, 9001);
  assert.equal(out.noRecovery, true);
  assert.equal(out.json, true);
  assert.equal(out.error, null);
});

test("parseArgs: range checks exit cleanly", () => {
  assert.match(parseArgs(["--timeout", "5"]).error, /--timeout/); // below 30
  assert.match(parseArgs(["--timeout", "9999"]).error, /--timeout/); // above 600
  assert.match(parseArgs(["--down-wait", "9999"]).error, /--down-wait/);
  assert.match(parseArgs(["--web-port", "0"]).error, /--web-port/);
  assert.match(parseArgs(["--auth-port", "70000"]).error, /--auth-port/);
  assert.match(parseArgs(["--note"]).error, /--note/);
  assert.match(parseArgs(["--bogus"]).error, /unknown flag/);
});

test("buildRecoveryCommand: engine with -SkipUpdates, real ports, no port overrides", () => {
  const cmd = buildRecoveryCommand({ root: "E:\\Glitch AI\\glitch-pi" });
  assert.match(cmd, /restart-pi-stack\.ps1/);
  assert.match(cmd, /-DelaySec 0/);
  assert.match(cmd, /-SkipUpdates/);
  assert.doesNotMatch(cmd, /-WebPort/);
  assert.doesNotMatch(cmd, /-AuthPort/);
  assert.doesNotMatch(cmd, /-ApplyUpdates/);
});

test("probeHttp: ok against a real local server, fail on a closed port", async () => {
  const server = http.createServer((req, res) => {
    res.end("ok");
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const port = server.address().port;
  try {
    const good = await probeHttp(`http://127.0.0.1:${port}/`, null);
    assert.equal(good.ok, true);
    assert.equal(good.status, 200);
    assert.ok(good.latencyMs >= 0);

    const withToken = await probeHttp(`http://127.0.0.1:${port}/`, "secret-token");
    assert.equal(withToken.ok, true);

    const closed = await probeHttp("http://127.0.0.1:1/", null, 1500);
    assert.equal(closed.ok, false);
    assert.ok(closed.error);
  } finally {
    server.close();
  }
});

test("probeHttp: any status counts as up (401 gate answered is still listening)", async () => {
  const server = http.createServer((req, res) => {
    res.statusCode = 401;
    res.end("denied");
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  try {
    const out = await probeHttp(`http://127.0.0.1:${server.address().port}/`, null);
    assert.equal(out.ok, true);
    assert.equal(out.status, 401);
  } finally {
    server.close();
  }
});

test("probeTcp: ok against a real local listener, fail on a closed port", async () => {
  const server = net.createServer(() => {});
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const port = server.address().port;
  try {
    const good = await probeTcp(port);
    assert.equal(good.ok, true);
    assert.ok(good.latencyMs >= 0);

    const closed = await probeTcp(1, 1500);
    assert.equal(closed.ok, false);
  } finally {
    server.close();
  }
});

test("buildReport and buildMarker: shapes", () => {
  const report = buildReport({
    startedAt: "2026-01-01T00:00:00.000Z",
    finishedAt: "2026-01-01T00:01:00.000Z",
    outcome: "success",
    triggerNote: "test",
    delaySec: 0,
    downWaitSec: 45,
    timeoutSec: 180,
    webPort: 8787,
    authPort: 4103,
    poll: {
      attempts: 3,
      firstDownAt: "2026-01-01T00:00:05.000Z",
      webUpAt: "2026-01-01T00:00:20.000Z",
      authUpAt: "2026-01-01T00:00:20.000Z",
      lastProbe: { at: "2026-01-01T00:00:20.000Z", web: { ok: true, status: 200, latencyMs: 12, error: null }, auth: { ok: true, latencyMs: 5, error: null } },
    },
  });
  assert.equal(report.outcome, "success");
  assert.equal(report.version, 1);
  assert.equal(report.recovery.attempted, false);

  const marker = buildMarker(report);
  assert.equal(marker.outcome, "success");
  assert.equal(marker.webUp, true);
  assert.equal(marker.authUp, true);
  assert.equal(marker.webLatencyMs, 12);
  assert.equal(marker.recoveryAttempted, false);
  assert.equal(marker.note, "test");
  assert.equal(marker.timestamp, "2026-01-01T00:01:00.000Z");
});

test("buildMarker: tolerates a missing lastProbe", () => {
  const marker = buildMarker({
    finishedAt: "2026-01-01T00:00:00.000Z",
    outcome: "failed",
    config: { webPort: 8787, authPort: 4103 },
    poll: {},
    recovery: {},
  });
  assert.equal(marker.webUp, false);
  assert.equal(marker.authUp, false);
});
