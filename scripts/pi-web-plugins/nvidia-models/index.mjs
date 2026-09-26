/**
 * nvidia-models — pi-web-ui plugin (server entry).
 *
 * Source of truth lives HERE (repo: scripts/pi-web-plugins/nvidia-models/).
 * The live location (~/.pi-web/plugins/nvidia-models) is a junction to this
 * folder, created by scripts/install-pi-web-plugins.mjs — edit here only.
 *
 * WHAT IT DOES: lists every NVIDIA free model, marks the relevant ones
 * with a tier (A recommended, B optional, C not relevant, X non-chat), and
 * lets Troy turn each on or off without ever touching models.json by hand.
 *
 * WHERE THE DATA COMES FROM: this plugin is a thin view over a frozen
 * engine CLI (scripts/nvidia-models.mjs, owned by another coder). Every
 * route shells out to that engine via host.bash and parses its single
 * JSON object from stdout. We never read or write models.json ourselves
 * — that is the engine's job, with its own pin guard and atomic write.
 *
 * SURFACES
 *   1. right-panel "NVIDIA Models" tab (manifest "view": true)
 *   2. composer button (host.ui.register, kind "view") opens the page
 *   3. GET  /plugins-api/nvidia-models/status     -> parsed engine JSON + healthy/cli_present flags
 *   4. POST /plugins-api/nvidia-models/sync       -> resync from the live catalog
 *   5. POST /plugins-api/nvidia-models/set        -> toggle one model on/off
 *   6. POST /plugins-api/nvidia-models/bulk       -> apply recommended / enable all / disable all
 *   7. POST /plugins-api/nvidia-models/restore    -> restore the last backup
 *   8. /nvidia-models slash command               -> same data as text in chat
 *
 * WRITE PATH SAFETY (POST /set and POST /bulk): the id (or ids) in the body
 * is validated against the cached state ids BEFORE it reaches a command
 * line, and passed as a separate argv token to host.bash. The engine
 * itself owns the backup-before-write, pin-guard refusal (returned in
 * blocked[]) and read-back verification — we only relay that.
 *
 * TESTABILITY: state (status cache, known-id whitelist, timeouts) lives
 * inside the activate() closure, NOT at module top level. This means each
 * host activation gets its own state and the unit tests can call
 * plugin.activate(host) twice without bleeding cache between groups.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Engine entry. The engine itself lives in scripts/nvidia-models.mjs and
 * is owned by a different coder.
 *
 * host.bash parses its first argument with `String(cmd).trim().split(/\s+/)`
 * and runs execFile(parts[0], parts.slice(1), ...). There is NO quote
 * handling, NO shell, NO escaping. That means every token we build must
 * be whitespace-free, and the absolute repo path "E:\Glitch AI\glitch-pi"
 * would split into 3 tokens and silently break every route.
 *
 * Solution: build the command only from space-free relative tokens:
 *   <node> scripts/nvidia-models.mjs <verb> [id...] --json
 * where <node> is `data/node/node.exe` (relative, no whitespace). The host
 * resolves opts.cwd against the workspace; setting cwd to "." (the
 * workspace root, which IS the repo root here) keeps every path relative.
 *
 * ROOT is resolved lazily on every call so the plugin honors a
 * GLITCH_PI_ROOT change made by tests (or by a launcher script) without
 * needing a module reload. The default matches the agent's repo path.
 */
function repoRoot() {
  return process.env.GLITCH_PI_ROOT || "E:\\Glitch AI\\glitch-pi";
}
function engineRelativePath() {
  // POSIX-style relative path; Windows accepts forward slashes in execFile.
  // Stays valid regardless of where the repo lives on disk.
  return "scripts/nvidia-models.mjs";
}
function nodeRelativePath() {
  // The bundled node runtime ships inside the repo at data/node/node.exe.
  // Both halves are space-free, so the tokenizer cannot split this.
  return "data/node/node.exe";
}
function nodeFallback() {
  // When the bundled runtime is unavailable (sandbox without data/node),
  // fall back to a bare `node` on PATH. The host's tokenizer splits on
  // whitespace, so a bare word is the only safe fallback.
  return "node";
}
function stateFile() {
  return join(repoRoot(), "data", "nvidia-models-state.json");
}

/**
 * Build the argv that runs the engine for a given verb.
 *
 * Returns an array of single, whitespace-free tokens. Joining on " " and
 * splitting on /\s+/ MUST round-trip the same array (verified by the test
 * suite). The shape:
 *   [node, "scripts/nvidia-models.mjs", ...verbTokens, ...ids, "--json"]
 *
 * `--json` is always last so a stray parser that scans the tail for the
 * flag keeps working. `ids` may be a single string, an array of strings,
 * or undefined; in every case each id must end up as exactly one token.
 */
export function buildEngineArgv(verb, ids) {
  const verbTokens = Array.isArray(verb) ? verb : [verb];
  let idTokens;
  if (ids === undefined || ids === null) idTokens = [];
  else if (Array.isArray(ids)) idTokens = ids;
  else idTokens = [ids];
  return [nodeRelativePath(), engineRelativePath(), ...verbTokens, ...idTokens, "--json"];
}

/**
 * Pick the node binary token. The bundled path is preferred; a bare `node`
 * is the fallback when the sandbox hides `data/node/node.exe`. The host
 * surface only reports ENOENT / sandbox errors via `error` on the result
 * object — never throws — so we check existence beforehand and use the
 * bundled path when we can prove it is readable.
 */
function pickNodeToken() {
  try {
    if (existsSync(nodeRelativePath())) return nodeRelativePath();
  } catch {
    /* fall through */
  }
  return nodeFallback();
}

/**
 * Parse exactly one JSON object from a stdout string. The engine contract
 * says --json prints ONE object on stdout with nothing else; we slice from
 * the first "{" to the last "}" so a stray warning line before the object
 * cannot corrupt the parse.
 */
function parseEngineJson(text) {
  if (typeof text !== "string" || !text.trim()) {
    return { ok: false, error: "engine produced no output" };
  }
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) {
    return { ok: false, error: "engine output is not a JSON object", raw: text.slice(0, 500) };
  }
  let parsed;
  try {
    parsed = JSON.parse(text.slice(start, end + 1));
  } catch (err) {
    return { ok: false, error: `engine output is not valid JSON: ${err?.message ?? err}`, raw: text.slice(0, 500) };
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { ok: false, error: "engine output is not a JSON object", raw: text.slice(0, 500) };
  }
  return parsed;
}

/**
 * Format the status object as plain text for the slash command. The
 * server entry is the single source of truth for labels so the CLI
 * (/nvidia-models) and the web tab cannot drift.
 */
function formatStatusText(payload) {
  if (!payload || !payload.ok) {
    return `nvidia-models: ${payload?.error ?? "engine status unavailable"}`;
  }
  const counts = payload.counts ?? {};
  const models = Array.isArray(payload.models) ? payload.models : [];
  const lines = [];
  lines.push(`NVIDIA models: ${payload.catalog_total ?? "?"} total | ${counts.chat ?? "?"} chat | ${counts.enabled ?? "?"} enabled | ${counts.recommended ?? "?"} recommended`);
  if (payload.synced_at) lines.push(`last sync: ${payload.synced_at}`);
  if (Array.isArray(payload.blocked) && payload.blocked.length) {
    lines.push(`blocked by pin guard:`);
    for (const b of payload.blocked) lines.push(`  - ${b.id ?? "?"}: ${b.reason ?? ""}`);
  }
  const tiers = { A: "Recommended", B: "Optional", C: "Not relevant", X: "Non-chat" };
  const grouped = { A: [], B: [], C: [], X: [] };
  for (const m of models) grouped[m.tier]?.push(m);
  for (const tier of ["A", "B", "C", "X"]) {
    if (!grouped[tier].length) continue;
    lines.push("");
    lines.push(`${tiers[tier]} (${grouped[tier].length}):`);
    for (const m of grouped[tier]) {
      const on = m.enabled ? "[x]" : "[ ]";
      const reasoning = m.reasoning ? " R" : "  ";
      const vision = m.vision === "image" || m.vision === true ? " V" : "  ";
      const ctx = m.contextWindow ? ` ${m.contextWindow}` : "";
      lines.push(`  ${on}${reasoning}${vision} ${m.id}${ctx}  ${m.why ?? ""}`.trimEnd());
    }
  }
  return lines.join("\n");
}

/** Factory that builds a self-contained plugin instance. Exported so tests
 *  can spin up a fresh instance with its own cache between groups. */
export function createPlugin() {
  const STATUS_TTL_MS = 5_000;
  const STATUS_TIMEOUT_MS = 60_000;
  const APPLY_TIMEOUT_MS = 180_000;

  /** In-memory state id whitelist. Populated from STATE_FILE and refreshed after
   *  every successful engine call that returns a fresh models[]. */
  const knownIds = new Set();
  let knownIdsAt = 0;

  /** Status JSON cache (the parsed engine object + healthy + cli_present). */
  let statusCache = null;
  let statusCachedAt = 0;

  function refreshKnownIds(force = false) {
    const now = Date.now();
    if (!force && now - knownIdsAt < STATUS_TTL_MS && knownIds.size > 0) return knownIds;
    knownIds.clear();
    try {
      const STATE_FILE = stateFile();
      if (existsSync(STATE_FILE)) {
        const doc = JSON.parse(readFileSync(STATE_FILE, "utf-8"));
        const models = Array.isArray(doc?.models) ? doc.models : [];
        for (const m of models) {
          if (m && typeof m.id === "string" && m.id) knownIds.add(m.id);
        }
      }
    } catch {
      /* swallow — caller will log */
    }
    knownIdsAt = now;
    return knownIds;
  }

  /**
   * Run the engine with explicit argv tokens (no string interpolation from
   * request text). host.bash never throws — it returns { ok, output, exitCode, error }.
   *
   * host.bash tokenizes on whitespace with NO quote handling. The command
   * is built by buildEngineArgv() from space-free relative tokens and the
   * runtime tries the bundled node first, then falls back to a bare `node`.
   * Each call invokes the engine twice if the first try was a sandbox
   * / ENOENT on the bundled runtime.
   */
  /**
   * Run the engine. host.bash tokenizes on whitespace with NO quote handling,
   * so the command must be built from space-free tokens. The argv layout is
   *   [node, "scripts/nvidia-models.mjs", ...verbTokens, ...ids, "--json"]
   * with `--json` always last. The bundled node tries first; on ENOENT or a
   * sandbox error we fall back to a bare `node` once. cwd is "." (workspace
   * root), which is the only path that resolves inside the workspace.
   */
  async function runEngine(verbTokens, ids, timeoutMs, hostRef) {
    const idsArr = Array.isArray(ids) ? ids : ids ? [ids] : [];
    const baseArgv = [pickNodeToken(), engineRelativePath(), ...verbTokens, ...idsArr, "--json"];
    let cmd = baseArgv.join(" ");
    let res = await hostRef.bash(cmd, { cwd: ".", timeoutMs });
    if (!res?.ok && /ENOENT|no such file|not found|sandbox/i.test(res?.error ?? "")) {
      // Bundled runtime hidden: try the PATH fallback once.
      const fallbackArgv = [nodeFallback(), engineRelativePath(), ...verbTokens, ...idsArr, "--json"];
      cmd = fallbackArgv.join(" ");
      res = await hostRef.bash(cmd, { cwd: ".", timeoutMs });
    }
    if (!res || !res.ok) {
      return {
        ok: false,
        error: res?.error ?? `engine exited with code ${res?.exitCode ?? "unknown"}`,
        exitCode: res?.exitCode ?? null,
      };
    }
    const parsed = parseEngineJson(res.output ?? "");
    if (parsed.ok === false) {
      return { ok: false, error: parsed.error, raw: parsed.raw ?? null, exitCode: res.exitCode ?? 0 };
    }
    refreshKnownIds(true);
    return parsed;
  }

  function json(res, status, payload) {
    res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
    res.end(JSON.stringify(payload));
  }

  return {
    STATUS_TTL_MS,
    STATUS_TIMEOUT_MS,
    APPLY_TIMEOUT_MS,
    formatStatusText,
    parseEngineJson,
    activate(host) {
      const cleanup = [];
      // Per-activation cache mirrors: the host reloads this module on every
      // plugin reload and each activation should be self-contained. The
      // closure-level state from createPlugin() is shared across the lifetime
      // of the plugin module, which matches the production process — host.bash
      // runs every poll and the cache survives between requests.
      const localStatusCache = { value: null, at: 0 };
      const localKnownIds = new Set();
      let localKnownIdsAt = 0;

      function localRefreshIds(force = false) {
        const now = Date.now();
        if (!force && now - localKnownIdsAt < STATUS_TTL_MS && localKnownIds.size > 0) return localKnownIds;
        localKnownIds.clear();
        try {
          const STATE_FILE = stateFile();
          if (existsSync(STATE_FILE)) {
            const doc = JSON.parse(readFileSync(STATE_FILE, "utf-8"));
            const models = Array.isArray(doc?.models) ? doc.models : [];
            for (const m of models) {
              if (m && typeof m.id === "string" && m.id) localKnownIds.add(m.id);
            }
          }
        } catch {
          /* swallow */
        }
        localKnownIdsAt = now;
        return localKnownIds;
      }

      /**
       * GET /status. Engine call:
       *   `data/node/node.exe scripts/nvidia-models.mjs --status --json`
       * (or `node scripts/nvidia-models.mjs --status --json` on fallback).
       * 60s timeout. Returns the parsed engine object plus healthy + cli_present
       * flags. Cached for STATUS_TTL_MS to keep the polled tab calm.
       */
      async function status(force = false) {
        const now = Date.now();
        if (!force && localStatusCache.value && now - localStatusCache.at < STATUS_TTL_MS) {
          return localStatusCache.value;
        }
        const result = await runEngine(["--status"], [], STATUS_TIMEOUT_MS, host);
        const cli_present = existsSync(engineRelativePath());
        const healthy = result.ok === true;
        const payload = {
          ok: healthy,
          healthy,
          cli_present,
          engine_path: engineRelativePath(),
          ...result,
        };
        if (Array.isArray(result.models)) {
          localKnownIds.clear();
          for (const m of result.models) {
            if (m && typeof m.id === "string" && m.id) localKnownIds.add(m.id);
          }
          localKnownIdsAt = now;
        } else {
          localRefreshIds(true);
        }
        localStatusCache.value = payload;
        localStatusCache.at = now;
        return payload;
      }

      cleanup.push(
        host.route("GET", "/status", async (_req, res) => {
          try {
            const payload = await status(false);
            json(res, payload.ok ? 200 : 503, payload);
          } catch (err) {
            json(res, 500, { ok: false, error: err?.message ?? String(err) });
          }
        }),
      );

      /**
       * POST /sync. Engine call:
       *   `data/node/node.exe scripts/nvidia-models.mjs --sync --json`
       * 180s timeout. Bypasses the cache and invalidates it on the way out.
       */
      cleanup.push(
        host.route("POST", "/sync", async (_req, res) => {
          try {
            const result = await runEngine(["--sync"], [], APPLY_TIMEOUT_MS, host);
            localStatusCache.value = null;
            json(res, result.ok ? 200 : 502, { ok: result.ok, ...result });
          } catch (err) {
            json(res, 500, { ok: false, error: err?.message ?? String(err) });
          }
        }),
      );

      /**
       * POST /set. Body: { id, enabled }.
       * Engine call (when id is whitelisted):
       *   `data/node/node.exe scripts/nvidia-models.mjs --{enable|disable} <id> --json`.
       * 180s timeout. The id is validated against the cached whitelist BEFORE
       * it reaches a command line — nothing the request supplies is interpolated
       * into the shell. The argv is a fixed array with one token for the id.
       */
      cleanup.push(
        host.route("POST", "/set", async (req, res) => {
          try {
            const body = req && typeof req.body === "object" && req.body !== null ? req.body : {};
            const id = typeof body.id === "string" ? body.id.trim() : "";
            const enabled = body.enabled === true;
            if (!id) return json(res, 400, { ok: false, error: "id is required" });
            localRefreshIds();
            if (!localKnownIds.has(id)) {
              return json(res, 400, {
                ok: false,
                error: `unknown model id: ${id} (engine has not synced this id; resync first)`,
              });
            }
            const verb = enabled ? "--enable" : "--disable";
            const result = await runEngine([verb], [id], APPLY_TIMEOUT_MS, host);
            localStatusCache.value = null;
            // blocked[] from the engine (pin-guard refusals) passes through verbatim.
            json(res, result.ok ? 200 : 502, { ok: result.ok, ...result });
          } catch (err) {
            json(res, 500, { ok: false, error: err?.message ?? String(err) });
          }
        }),
      );

      /**
       * POST /bulk. Body: { action: "recommended" | "all" | "none" }.
       * Engine call:
       *   - `data/node/node.exe scripts/nvidia-models.mjs --apply-recommended --json`
       *   - `data/node/node.exe scripts/nvidia-models.mjs --{enable|disable} <id1> <id2> ... --json`
       * Every id in an "all" / "none" call is taken from the cached whitelist
       * (whatever the engine itself classified in its last sync). The request
       * body cannot inject new ids.
       */
      cleanup.push(
        host.route("POST", "/bulk", async (req, res) => {
          try {
            const body = req && typeof req.body === "object" && req.body !== null ? req.body : {};
            const action = typeof body.action === "string" ? body.action.trim() : "";
            localRefreshIds();
            let verb;
            let ids;
            if (action === "recommended") {
              verb = "--apply-recommended";
              ids = [];
            } else if (action === "all" || action === "none") {
              const cached = [...localKnownIds];
              if (cached.length === 0) {
                return json(res, 409, { ok: false, error: "no known ids; run /sync first" });
              }
              verb = action === "all" ? "--enable" : "--disable";
              ids = cached;
            } else {
              return json(res, 400, {
                ok: false,
                error: `unknown bulk action: ${JSON.stringify(action)} (expected: recommended | all | none)`,
              });
            }
            const result = await runEngine([verb], ids, APPLY_TIMEOUT_MS, host);
            localStatusCache.value = null;
            json(res, result.ok ? 200 : 502, { ok: result.ok, ...result });
          } catch (err) {
            json(res, 500, { ok: false, error: err?.message ?? String(err) });
          }
        }),
      );

      /**
       * POST /restore. Engine call:
       *   `data/node/node.exe scripts/nvidia-models.mjs --restore-backup --json`
       * 180s timeout. No body is read.
       */
      cleanup.push(
        host.route("POST", "/restore", async (_req, res) => {
          try {
            const result = await runEngine(["--restore-backup"], [], APPLY_TIMEOUT_MS, host);
            localStatusCache.value = null;
            json(res, result.ok ? 200 : 502, { ok: result.ok, ...result });
          } catch (err) {
            json(res, 500, { ok: false, error: err?.message ?? String(err) });
          }
        }),
      );

      /**
       * Slash command. Same data as text, no browser needed.
       */
      cleanup.push(
        host.registerCommand({
          name: "nvidia-models",
          description: "Show NVIDIA free model tier list and current enable state",
          descriptionEn: "Show NVIDIA free model tier list and current enable state",
          async run() {
            try {
              const payload = await status(true);
              return formatStatusText(payload);
            } catch (err) {
              return `nvidia-models failed: ${err?.message ?? err}`;
            }
          },
        }),
      );

      /**
       * UI contribution. Pinned tab entry. Order 136 so it sits next to
       * agent-models (135) and below the model chip itself (120).
       */
      cleanup.push(
        host.ui.register({
          slot: "composer.actions",
          id: "open-page",
          label: "NVIDIA Models",
          hint: "Open the NVIDIA Models page",
          kind: "view",
          view: "plugin:nvidia-models",
          order: 136,
          align: "start",
        }),
      );

      // Kick the cache so the first /status call is warm. A failing engine
      // must not block activation, so we swallow the rejection.
      status(true).catch((err) => {
        host.log?.("warn", `nvidia-models initial status failed: ${err?.message ?? err}`);
      });
      cleanup.push(() => {
        localStatusCache.value = null;
      });

      host.log?.(
        "info",
        "activated - engine at " + engineRelativePath() + ", state file " + (existsSync(stateFile()) ? "present" : "missing (run /sync after engine lands)"),
      );

      return () => {
        for (const off of cleanup) {
          try {
            off?.();
          } catch {
            /* ignore */
          }
        }
      };
    },
  };
}

const defaultPlugin = createPlugin();
export default defaultPlugin;
