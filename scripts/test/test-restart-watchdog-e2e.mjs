#!/usr/bin/env node
/**
 * E2E integration test for scripts/restart-watchdog.mjs.
 *
 * A Node orchestrator starts throwaway http (web probe) + net (auth probe)
 * listeners on EPHEMERAL ports, spawns the watchdog as a child process, then
 * simulates a restart by killing and restarting the listeners:
 *
 *   scenario A ("success"): kill both listeners (down edge), bring both back
 *     ON THE SAME PORTS -> watchdog must report outcome "success" and write
 *     report + marker.
 *   scenario B ("failed"): kill both listeners, never bring them back,
 *     pass --no-recovery (a real recovery would run restart-pi-stack.ps1
 *     against the LIVE stack) -> watchdog must report outcome "failed" and
 *     write report + marker with diagnostics.
 *   scenario C ("no-restart-signal"): listeners stay up the whole time
 *     -> watchdog must report "no-restart-signal" and not touch anything.
 *
 * This test never touches the real stack: it runs the watchdog against its own
 * throwaway listeners only. Report + marker files it creates are removed again.
 * Run directly: node scripts/test/test-restart-watchdog-e2e.mjs
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import http from "node:http";
import net from "node:net";
import { existsSync, readFileSync, unlinkSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const WATCHDOG = join(ROOT, "scripts", "restart-watchdog.mjs");
const MONITOR_DIR = join(ROOT, "data", "monitor");
const MARKER = join(MONITOR_DIR, "restart-status.json");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Start a dummy http+tcp listener pair. With no args: ephemeral ports.
 * With (webPort, authPort): those exact ports (used to bring the "stack"
 * back after the simulated kill). Retries briefly on EADDRINUSE since we
 * just closed the previous listener on the same port.
 */
function startDummy(webPort = 0, authPort = 0) {
  return new Promise((resolve, reject) => {
    const attempt = (tries) => {
      const httpServer = http.createServer((req, res) => res.end("ok"));
      const netServer = net.createServer(() => {});
      const fail = (err) => {
        try { httpServer.close(); } catch {}
        try { netServer.close(); } catch {}
        if (tries > 0) {
          sleep(200).then(() => attempt(tries - 1));
          return;
        }
        reject(err);
      };
      httpServer.on("error", fail);
      netServer.on("error", fail);
      httpServer.listen(webPort, "127.0.0.1", () => {
        netServer.listen(authPort, "127.0.0.1", () => {
          resolve({
            webPort: httpServer.address().port,
            authPort: netServer.address().port,
            close: () => {
              try { httpServer.close(); } catch {}
              try { netServer.close(); } catch {}
            },
          });
        });
      });
    };
    attempt(3);
  });
}

/**
 * Run the watchdog child with the given flags; resolve on exit with the parsed
 * stdout JSON line. Hard-kills the child if it outlives the test timeout.
 */
function runWatchdog(args, timeoutMs) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [WATCHDOG, ...args], {
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    const killer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`watchdog did not exit within ${timeoutMs}ms`));
    }, timeoutMs);
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("exit", (code) => {
      clearTimeout(killer);
      let parsed = null;
      try {
        const lines = stdout.trim().split(/\r?\n/).filter((l) => l.trim().startsWith("{"));
        parsed = lines.length ? JSON.parse(lines[lines.length - 1]) : null;
      } catch {}
      resolve({ code, parsed, stdout, stderr });
    });
    child.on("error", (err) => {
      clearTimeout(killer);
      reject(err);
    });
  });
}

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function cleanupOutputs(reportPath) {
  try { if (reportPath && existsSync(reportPath)) unlinkSync(reportPath); } catch {}
  try { if (existsSync(MARKER)) unlinkSync(MARKER); } catch {}
}

// ---- scenario A: down edge then both up -> "success" --------------------------
async function scenarioSuccess() {
  const dummy = await startDummy();
  let round2 = null;
  try {
    const runPromise = runWatchdog(
      [
        "--delay", "0", "--down-wait", "6", "--timeout", "30",
        "--web-port", String(dummy.webPort), "--auth-port", String(dummy.authPort),
        "--no-recovery", "--json", "--note", "e2e success scenario",
      ],
      60_000,
    );
    await sleep(1500);
    dummy.close(); // simulated kill: down edge
    await sleep(2000);
    round2 = await startDummy(dummy.webPort, dummy.authPort); // stack back on same ports
    return await runPromise;
  } finally {
    dummy.close();
    if (round2) round2.close();
  }
}

// ---- scenario B: down edge, never back -> "failed" (no recovery) --------------
async function scenarioFailed() {
  const dummy = await startDummy();
  try {
    const runPromise = runWatchdog(
      [
        "--delay", "0", "--down-wait", "4", "--timeout", "30",
        "--web-port", String(dummy.webPort), "--auth-port", String(dummy.authPort),
        "--no-recovery", "--json", "--note", "e2e failed scenario",
      ],
      60_000,
    );
    await sleep(1200);
    dummy.close(); // down edge, never comes back
    return await runPromise;
  } finally {
    dummy.close();
  }
}

// ---- scenario C: listeners stay up -> "no-restart-signal" ---------------------
async function scenarioNoSignal() {
  const dummy = await startDummy();
  try {
    return await runWatchdog(
      [
        "--delay", "0", "--down-wait", "3", "--timeout", "30",
        "--web-port", String(dummy.webPort), "--auth-port", String(dummy.authPort),
        "--no-recovery", "--json",
      ],
      60_000,
    );
  } finally {
    dummy.close();
  }
}

const results = [];
let failed = 0;
async function check(name, fn) {
  try {
    await fn();
    results.push(`PASS ${name}`);
  } catch (err) {
    failed++;
    results.push(`FAIL ${name}: ${err?.message ?? err}`);
    process.exitCode = 1;
  }
  // NOTE: cleanupOutputs runs ONCE per scenario, after all of that scenario's
  // checks. A per-check finally would delete the report and marker files
  // mid-scenario and fail the remaining checks.
}

// ---- A ----
{
  const r = await scenarioSuccess();
  await check("A: exit code 0", () => assert.equal(r.code, 0));
  await check("A: outcome success", () => assert.equal(r.parsed?.outcome, "success"));
  await check("A: report file written", () => assert.ok(r.parsed?.reportPath && existsSync(r.parsed.reportPath)));
  await check("A: marker file written", () => assert.ok(existsSync(MARKER)));
  if (r.parsed?.reportPath && existsSync(r.parsed.reportPath)) {
    const report = readJson(r.parsed.reportPath);
    await check("A: report outcome success", () => assert.equal(report.outcome, "success"));
    await check("A: report recorded down edge", () => assert.ok(report.poll.firstDownAt));
    await check("A: report recorded web up", () => assert.ok(report.poll.webUpAt));
    await check("A: report attempts sane", () => assert.ok(report.poll.attempts >= 2));
    await check("A: no diagnostics on success", () => assert.equal(report.diagnostics, null));
    await check("A: note recorded", () => assert.equal(report.triggerNote, "e2e success scenario"));
    await check("A: marker outcome success and webUp true", () => {
      const m = readJson(MARKER);
      assert.equal(m.outcome, "success");
      assert.equal(m.webUp, true);
    });
  }
  cleanupOutputs(r.parsed?.reportPath);
}

// ---- B ----
{
  const r = await scenarioFailed();
  await check("B: exit code 0", () => assert.equal(r.code, 0));
  await check("B: outcome failed", () => assert.equal(r.parsed?.outcome, "failed"));
  await check("B: report file written", () => assert.ok(r.parsed?.reportPath && existsSync(r.parsed.reportPath)));
  if (r.parsed?.reportPath && existsSync(r.parsed.reportPath)) {
    const report = readJson(r.parsed.reportPath);
    await check("B: report outcome failed", () => assert.equal(report.outcome, "failed"));
    await check("B: report has diagnostics", () => assert.ok(report.diagnostics));
    await check("B: diagnostics netstat parsed", () => assert.ok(report.diagnostics.netstat));
    await check("B: diagnostics has engine log tail entry", () => assert.ok(report.diagnostics.logs["restart-stack.out.log"]));
    await check("B: recovery not attempted", () => assert.equal(report.recovery.attempted, false));
    await check("B: marker outcome failed and webUp false", () => {
      const m = readJson(MARKER);
      assert.equal(m.outcome, "failed");
      assert.equal(m.webUp, false);
    });
  }
  cleanupOutputs(r.parsed?.reportPath);
}

// ---- C ----
{
  const r = await scenarioNoSignal();
  await check("C: exit code 0", () => assert.equal(r.code, 0));
  await check("C: outcome no-restart-signal", () => assert.equal(r.parsed?.outcome, "no-restart-signal"));
  if (r.parsed?.reportPath && existsSync(r.parsed.reportPath)) {
    const report = readJson(r.parsed.reportPath);
    await check("C: report has diagnostics", () => assert.ok(report.diagnostics));
    await check("C: no down edge recorded", () => assert.equal(report.poll.firstDownAt, null));
    await check("C: last probe shows ports up", () => assert.equal(report.poll.lastProbe.web.ok, true));
  }
  cleanupOutputs(r.parsed?.reportPath);
}

console.log(results.join("\n"));
console.log(failed ? `E2E: ${failed} FAILURES` : "E2E: ALL PASS");
