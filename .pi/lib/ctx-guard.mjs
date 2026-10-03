// ctx-guard.mjs — swallow pi's stale ExtensionContext errors
//
// WHY THIS EXISTS
//   The pi engine invalidates an ExtensionContext after session replacement or
//   reload (AgentSession.dispose() at core/agent-session.js:984 for
//   newSession/fork/switchSession, and AgentSession.reload() at
//   core/agent-session.js:2899). Once invalidated, every ExtensionContext
//   property (ui, cwd, sessionManager, model, mode, hasUI, signal, isIdle,
//   …) and every wrapped pi action method throws:
//     "This extension ctx is stale after session replacement or reload."
//   pi clears tracked event-bus subscriptions on invalidate but does NOT cancel
//   raw setTimeout/setInterval or pending promises, so an extension that keeps
//   a ctx across an await (long-running session_start work, /command handlers
//   that spawn detached child processes, background timers that touch ctx.ui)
//   can still hit a stale ctx on a later event loop tick.
//
//   This helper gives every extension one place to (a) detect the engine's
//   exact stale message, (b) wrap a handler so a stale throw never reaches pi,
//   and (c) substitute a no-op ui object so post-await UI calls stay safe.

const STALE_FRAGMENT = "This extension ctx is stale";

/** True iff `err` matches the engine's stale-ctx throw (see header). */
export function isStaleCtxError(err) {
  if (!err) return false;
  // The engine message is the only stable marker; pi never throws this for any
  // other reason. A defensive substring check is enough and survives minor
  // engine wording changes.
  const msg = err instanceof Error ? err.message : String(err);
  return typeof msg === "string" && msg.includes(STALE_FRAGMENT);
}

/**
 * Run `fn` and swallow a stale-ctx throw. Any other error rethrows so real
 * bugs still surface.
 *
 *   await guard("agent-switcher", async () => {
 *     repoRoot = ctx.cwd;            // may throw stale
 *     for (const e of ctx.sessionManager.getEntries()) { ... }
 *   });
 *
 * Logs at most once per site via console.error with the extension's own log
 * prefix so the swallowed error is greppable but never reaches pi.
 */
export async function guard(name, fn) {
  try {
    return await fn();
  } catch (err) {
    if (isStaleCtxError(err)) {
      console.error(`[${name}] stale ctx ignored: ${err instanceof Error ? err.message : String(err)}`);
      return;
    }
    throw err;
  }
}

/**
 * Return a ui object whose methods are no-ops safe to call after the ctx went
 * stale. Mirrors the subset of pi's noOpUIContext (core/extensions/runner.js
 * ~line 131) the extensions in this repo actually use: setStatus, setWidget,
 * notify, select. When ctx.ui is missing or throws stale on the first call, a
 * silent shim is returned for the rest of the call site's lifetime.
 *
 *   const ui = safeUi(ctx);
 *   ui.setStatus("agent", `agent:${mode}`);   // works whether ctx is live or stale
 *   ui.notify(`switched to ${mode}`, "info");
 */
export function safeUi(ctx) {
  const noop = () => {};
  const noopAsync = async () => undefined;
  const shim = {
    setStatus: noop,
    setWidget: noop,
    notify: noop,
    select: noopAsync,
  };

  // Read ctx.ui exactly once. The getter itself is guarded by the engine
  // (runner.assertActive), so on a stale ctx it throws the exact stale
  // message. Catch that here and return the shim so the rest of the call
  // site is silent. Any other read failure (e.g. ctx is null, ctx.ui throws
  // for a non-stale reason) must rethrow so real bugs still surface.
  let live = null;
  if (ctx) {
    try {
      live = ctx.ui || null;
    } catch (err) {
      if (isStaleCtxError(err)) return shim;
      throw err;
    }
  }
  if (!live) return shim;

  // Wrap live.ui so a stale throw on a later call is caught and the call
  // becomes a no-op. `fallback` already encodes the right contract per
  // method (select returns a promise via noopAsync, the rest return
  // undefined via noop), so no per-prop dispatch is needed. The wrapper
  // awaits the live call so a rejected Promise from an async method is
  // also caught here.
  return new Proxy(shim, {
    get(_target, prop) {
      const fallback = shim[prop];
      if (fallback) {
        return async (...args) => {
          try {
            return await live[prop]?.apply(live, args);
          } catch (err) {
            if (isStaleCtxError(err)) {
              return fallback();
            }
            throw err;
          }
        };
      }
      // Unknown methods: return undefined silently (don't even try the live one).
      return undefined;
    },
  });
}