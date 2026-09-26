/**
 * restart-stack - pi-web-ui plugin (client entry) - v0.1.0
 *
 * Right-panel "Restart Stack" tab. Renders the current state of pi-web-ui
 * (:8787) and auth-proxy (:4103) plus one button that always issues a PLAIN
 * restart. The UI never passes a resume field or a continuation note: a user
 * has no good way to compose one, and a stray value here is the difference
 * between "reboot the page" and "reboot and inject a prompt into a different
 * conversation". Agents use the CLI or the slash command for resume.
 *
 * PATTERN SOURCES (read both before changing this file):
 *   - .pi/web-plugins/agent-switcher/client/entry.mjs - bridge + once-only
 *     registration discipline (inlined onUiAction stub, retry poll, never throw).
 *   - scripts/pi-web-plugins/addons/client/entry.mjs - tab/view rendering
 *     (mount(container, ctx), per-container WeakMap so a re-mount in the SAME
 *     container replaces the prior instance, fetch -> render cycle, el(tag,cls,text)
 *     helper, diag line at the bottom, stylesheet compared by content).
 *
 * WHY ZERO IMPORTS: the host serves plugin files only from /plugins/<id>/client/*,
 * so a relative import (../sdk/index.mjs, ./resolver.mjs) would land on the SPA
 * fallback and break the module. Same constraint as addons / agent-switcher /
 * agent-models.
 *
 * ACTIONS go through the plugin's HTTP routes:
 *   GET    /plugins-api/restart-stack/state    -> { ok, up, webPid, authPid, ... }
 *   POST   /plugins-api/restart-stack/restart  -> {} (always plain restart)
 *
 * THEME TOKENS reused from the host stylesheet (same set addons uses):
 * --border, --border-soft, --text, --text-dim, --text-faint, --bg, --bg-elev,
 * --bg-elev2, --accent, --accent-soft, --green, --amber, --red, --mono, --sans.
 */

const API_BASE = "/plugins-api/restart-stack";
const POLL_MS = 10_000;
const FAST_POLL_MS = 2_000;
const STUCK_AFTER_MS = 5 * 60 * 1000;
const STYLE_ID = "restart-stack-style";
const MOUNT_LABEL = "restart-stack";
const PLUGIN_VERSION = "0.1.0";

/**
 * Per-container instances - direct lift from addons / agent-models.
 *
 * A module-level singleton was the wrong shape there (a second mount in a
 * DIFFERENT container tore the first one down). The right-panel slot is the
 * primary surface here, but preload may also surface this plugin in a hidden
 * pane - same trade-off, same fix.
 */
const instancesByContainer = new WeakMap();

/**
 * The stylesheet is a module constant so injectStyles() compares it by CONTENT.
 *
 * Why a content check, not id-only? A plain `id` flag keeps the FIRST deploy's
 * CSS for the lifetime of the page; every later tweak was silently ignored.
 * That is exactly the failure addons hit when padding rules went stale across
 * reloads. Same fix here.
 */
const STYLE_CSS = `
.rs-wrap{font:13px/1.5 var(--sans, system-ui, sans-serif);color:var(--text);padding:12px;display:flex;flex-direction:column;gap:12px;height:100%;box-sizing:border-box;min-height:0}
.rs-head{display:flex;align-items:baseline;gap:8px;flex-wrap:wrap}
.rs-title{font-weight:600}
.rs-sub{color:var(--text-faint);font-size:11px}
.rs-spacer{flex:1}
.rs-status{border:1px solid var(--border-soft);border-radius:8px;background:var(--bg-elev2);padding:10px 12px;display:flex;flex-direction:column;gap:6px;font-family:var(--mono, monospace);font-size:11.5px;color:var(--text-dim)}
.rs-row{display:flex;align-items:baseline;gap:8px;flex-wrap:wrap}
.rs-label{min-width:120px;color:var(--text-faint)}
.rs-pid{color:var(--text)}
.rs-state{display:inline-flex;align-items:center;gap:5px;font-size:11px;font-weight:600;letter-spacing:.3px;text-transform:uppercase;color:var(--text-dim);border:1px solid var(--border);border-radius:5px;padding:1px 6px}
.rs-state-dot{width:7px;height:7px;border-radius:50%;background:currentColor}
.rs-state.rs-up{color:var(--green);border-color:var(--green)}
.rs-state.rs-down{color:var(--red, var(--text-faint));border-color:var(--red, var(--border))}
.rs-actions{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.rs-btn{height:28px;padding:0 10px;font-size:12px;border-radius:7px;border:1px solid var(--border);background:var(--bg-elev2);color:var(--text-dim);cursor:pointer;font-family:inherit;line-height:1.4}
.rs-btn:hover{border-color:var(--accent);color:var(--text)}
.rs-btn:disabled{opacity:.55;cursor:default}
.rs-btn.rs-primary{border-color:var(--accent);color:var(--text);background:var(--bg-elev2)}
.rs-btn.rs-primary:hover{background:var(--accent-soft)}
.rs-banner{border:1px solid var(--amber);background:transparent;border-radius:8px;padding:10px;font-size:12px;color:var(--text);display:flex;flex-direction:column;gap:6px}
.rs-banner.rs-error{border-color:var(--red)}
.rs-error{border:1px solid var(--red);background:transparent;border-radius:8px;padding:10px;font-size:12px;color:var(--text)}
.rs-last{border:1px solid var(--border-soft);border-radius:8px;padding:8px 10px;font-size:11.5px;color:var(--text-faint);display:flex;flex-direction:column;gap:4px}
.rs-banner:empty,.rs-last:empty{display:none}
.rs-diag{border-top:1px solid var(--border-soft);padding-top:6px;color:var(--text-faint);font-family:var(--mono, monospace);font-size:10px;word-break:break-all}
`;

function injectStyles() {
  if (typeof document === "undefined" || !document.head) return;
  let style = document.getElementById(STYLE_ID);
  if (!style) {
    style = document.createElement("style");
    style.id = STYLE_ID;
    document.head.appendChild(style);
  }
  if (style.textContent !== STYLE_CSS) style.textContent = STYLE_CSS;
}

function el(tag, cls, text) {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  if (text !== undefined && text !== null) node.textContent = String(text);
  return node;
}

function errorText(err) {
  if (err instanceof Error) return err.message;
  return String(err ?? "unknown error");
}

/**
 * GET /plugins-api/restart-stack/state. Never throws: returns
 * {ok, state?, error?} so the caller can keep polling during the restart
 * window without surfacing a dialog. A fetch failure while the stack is
 * down is the EXPECTED state and must not alarm the user.
 */
async function fetchState() {
  try {
    const res = await fetch(`${API_BASE}/state`);
    if (!res.ok) return { ok: false, error: `HTTP ${res.status}` };
    const payload = await res.json();
    if (!payload || typeof payload !== "object") return { ok: false, error: "state missing" };
    return { ok: true, state: payload };
  } catch (err) {
    return { ok: false, error: errorText(err) };
  }
}

/**
 * POST /plugins-api/restart-stack/restart. Always sends {}: the UI must
 * never resume. A resume field would let a tab ask the launcher to inject
 * a prompt into whichever conversation PI_SESSION_FILE happens to name -
 * the wrong default for a button. That rule is documented in the README
 * too; the test for the plugin server asserts it via the body shape.
 */
async function postRestart() {
  try {
    const res = await fetch(`${API_BASE}/restart`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    const payload = await res.json().catch(() => null);
    if (!payload) return { ok: false, error: `HTTP ${res.status} (unparsable body)` };
    return payload;
  } catch (err) {
    return { ok: false, error: errorText(err) };
  }
}

/**
 * Bridge pattern, lifted from agent-switcher. The host exposes
 * globalThis.window.__piWebUiHost.onUiAction(action, handler); a client may be
 * imported BEFORE the bridge exists (preload) so we retry-poll until it does.
 *
 * We don't actually need any host-driven action today - every interaction here
 * is a direct fetch - but wiring the registration discipline keeps the file
 * consistent with the other clients and gives us a safe place to hang future
 * host-driven hooks (e.g. a "Restart" composer button).
 */
function registerOnce(scope) {
  if (globalThis.__restartStackBound) return;
  if (typeof window === "undefined") return;
  const bridge = window.__piWebUiHost;
  if (!bridge || typeof bridge.onUiAction !== "function") return;
  globalThis.__restartStackBound = true;
  const diag = (globalThis.__restartStackClient = globalThis.__restartStackClient ?? {
    registered: [],
    errors: [],
    version: PLUGIN_VERSION,
    importedAt: new Date().toISOString(),
  });
  try {
    bridge.onUiAction("restart-stack:noop", () => {});
    diag.registered.push(`restart-stack:noop (once@${scope})`);
  } catch (err) {
    diag.errors.push(`restart-stack:noop: ${errorText(err)}`);
  }
}

registerOnce("import");
if (typeof window !== "undefined") {
  let tries = 0;
  const retry = () => {
    if (globalThis.__restartStackBound) return;
    const bridge = window.__piWebUiHost;
    if (bridge && typeof bridge.onUiAction === "function") registerOnce("poll");
    else if (tries++ < 100) setTimeout(retry, 300);
  };
  retry();
}

function fmtTime(ms) {
  if (!ms) return "n/a";
  try {
    const d = new Date(ms);
    return d.toLocaleTimeString();
  } catch {
    return String(ms);
  }
}

/**
 * Build one panel instance. Lifted from addons' createInstance shape (state
 * record + generation guard + WeakMap-driven re-mount).
 */
function createInstance(container, ctx) {
  const state = {
    snapshot: null,
    error: null,
    loading: true,
    destroyed: false,
    generation: 0,
    timer: null,
    busy: false,
    restarting: false,
    restartStartedAt: 0,
    // True once we observe the stack actually went away during a restart:
    // either a fetch failed while restarting, or a snapshot arrived with
    // up === false. Required before reloading, because the OLD server keeps
    // answering /state with pending:true and a live webPid for the full
    // 8s kill window. A live PID alone is not proof the stack came back.
    sawDown: false,
    // Holds the last failure message so renderBanner can render it AFTER
    // clearing the banner element. Storing it in state survives the
    // banner.textContent = "" that renderBanner does first.
    failMessage: null,
    diag: {
      mounts: 1,
      lastAction: "mount",
      lastAt: new Date().toLocaleTimeString(),
      lastFetch: "pending",
      lastWrite: "none",
    },
  };

  const root = el("div", "rs-wrap");
  container.appendChild(root);

  const head = el("div", "rs-head");
  const title = el("div", "rs-title", "Restart Stack");
  const sub = el("div", "rs-sub", "loading...");
  head.append(title, sub);

  const status = el("div", "rs-status");
  const actions = el("div", "rs-actions");
  const last = el("div", "rs-last");
  const banner = el("div", "rs-banner");
  const diagLine = el("div", "rs-diag");
  root.append(head, status, actions, banner, last, diagLine);

  function renderDiag() {
    const d = state.diag;
    let visibility = "unknown";
    try {
      visibility = !root.isConnected
        ? "detached"
        : typeof root.getClientRects === "function" && root.getClientRects().length === 0
          ? "hidden"
          : "visible";
    } catch {
      /* leave unknown */
    }
    diagLine.textContent =
      `${MOUNT_LABEL} v${PLUGIN_VERSION} | mounts ${d.mounts} | ${visibility} | last ${d.lastAction} @ ${d.lastAt}` +
      ` | fetch ${d.lastFetch} | write ${d.lastWrite}`;
  }

  function renderStatus() {
    status.textContent = "";
    const snap = state.snapshot;
    if (!snap) {
      status.appendChild(el("div", "rs-row", "no state yet"));
      return;
    }
    const upTag = el("span", `rs-state ${snap.up ? "rs-up" : "rs-down"}`, snap.up ? "up" : "down");
    const dot = el("span", "rs-state-dot");
    upTag.appendChild(dot);
    const head2 = el("div", "rs-row");
    head2.appendChild(el("span", "rs-label", "stack"));
    head2.appendChild(upTag);
    status.appendChild(head2);

    const webRow = el("div", "rs-row");
    webRow.appendChild(el("span", "rs-label", `pi-web-ui :${snap.webPort}`));
    webRow.appendChild(el("span", "rs-pid", snap.webPid != null ? `PID ${snap.webPid}` : "(no listener)"));
    status.appendChild(webRow);

    const authRow = el("div", "rs-row");
    authRow.appendChild(el("span", "rs-label", `auth-proxy :${snap.authPort}`));
    authRow.appendChild(el("span", "rs-pid", snap.authPid != null ? `PID ${snap.authPid}` : "(no listener)"));
    status.appendChild(authRow);
  }

  function renderLast() {
    last.textContent = "";
    const snap = state.snapshot;
    if (!snap || !snap.lastRestartAt) return;
    last.appendChild(el("div", undefined, `last restart: ${fmtTime(snap.lastRestartAt)} (${snap.lastMode ?? "(n/a)"})`));
    if (snap.logPaths?.outLog) {
      last.appendChild(el("div", undefined, `log: ${snap.logPaths.outLog}`));
    }
  }

  function renderBanner() {
    banner.textContent = "";
    banner.classList.remove("rs-error");
    if (state.failMessage) {
      banner.classList.add("rs-error");
      banner.appendChild(el("div", undefined, state.failMessage));
      return;
    }
    if (!state.restarting) return;
    const since = Date.now() - state.restartStartedAt;
    banner.appendChild(el("div", undefined, "restarting, this page reconnects on its own"));
    if (since > STUCK_AFTER_MS) {
      banner.classList.add("rs-error");
      banner.appendChild(el("div", undefined, "restart looks stuck, check data/logs/restart-stack.out.log"));
    }
  }

  function renderActions() {
    actions.textContent = "";
    const button = el("button", "rs-btn rs-primary", "Restart stack");
    button.type = "button";
    button.title = "Restart pi-web-ui and the auth proxy. Plain restart, no resume.";
    button.disabled = state.busy || state.restarting;
    button.addEventListener("click", async () => {
      const ok = window.confirm(
        "Restart the Glitch web stack? This page will disconnect for about a minute.",
      );
      if (!ok) return;
      state.diag.lastAction = "click";
      state.diag.lastAt = new Date().toLocaleTimeString();
      await runRestart();
    });
    actions.appendChild(button);
  }

  function render() {
    if (state.destroyed) return;
    try {
      if (state.error && !state.snapshot) {
        // No snapshot yet and the very first fetch failed - show a real error
        // box. After we have a snapshot, transient failures stay silent.
        const box = el("div", "rs-error", `State unavailable: ${state.error}`);
        status.textContent = "";
        status.appendChild(box);
      } else {
        renderStatus();
      }
      renderActions();
      renderBanner();
      renderLast();
      if (state.snapshot) {
        sub.textContent = state.snapshot.up
          ? "stack is up"
          : (state.snapshot.pending ? "restart pending" : "stack is down");
      } else if (state.loading) {
        sub.textContent = "loading...";
      }
      renderDiag();
    } catch (err) {
      // Never let a render error produce a blank pane.
      status.textContent = "";
      status.appendChild(el("div", "rs-error", `Render failed: ${errorText(err)}`));
      renderDiag();
    }
  }

  async function runRestart() {
    state.busy = true;
    state.restarting = true;
    state.restartStartedAt = Date.now();
    // Clear any prior failure before this attempt's banner state is rendered.
    state.failMessage = null;
    render();
    const payload = await postRestart();
    if (state.destroyed) return;
    state.busy = false;
    if (payload?.ok) {
      state.diag.lastWrite = `restart @ ${new Date().toLocaleTimeString()}`;
      // The server answers 200 BEFORE the actual kill happens (the kill is
      // detached). Stay in restarting mode and poll /state every 2s until
      // the snapshot answers again - then reload to land the new bundle.
      startFastPoll();
    } else {
      state.diag.lastWrite = `restart FAILED: ${payload?.error ?? "unknown"}`;
      // Roll back the banner; let the user try again. Store the message in
      // state instead of appending to the banner element: renderBanner()
      // does banner.textContent = "" first and would erase an inline
      // appendChild.
      state.restarting = false;
      state.sawDown = false;
      state.failMessage = `Restart failed: ${payload?.error ?? "unknown"}`;
    }
    render();
  }

  function startFastPoll() {
    if (state.timer) clearInterval(state.timer);
    state.timer = setInterval(() => {
      if (state.destroyed) return;
      void load(false, true);
    }, FAST_POLL_MS);
  }

  function startSlowPoll() {
    if (state.timer) clearInterval(state.timer);
    state.timer = setInterval(() => {
      if (state.destroyed) return;
      void load(false, false);
    }, POLL_MS);
  }

  async function load(force, fast) {
    if (state.destroyed) return;
    const generation = ++state.generation;
    state.loading = true;
    if (force) render();
    const payload = await fetchState();
    if (state.destroyed || generation !== state.generation) return;
    state.loading = false;
    if (payload?.ok) {
      const snap = payload.state;
      // Track that the stack actually went down during this restart. A live
      // webPid alone is NOT proof: the OLD server keeps answering /state
      // with pending:true and a live PID until the kill lands (about 8s).
      if (snap && snap.up === false) state.sawDown = true;
      // The fast poll exists for one reason: when the stack comes back, this
      // is the first fetch that answers successfully again, and that is our
      // signal to reload the page so the SPA picks up the new bundle.
      // We require sawDown AND !snap.pending: without !pending, a transient
      // fetch blip on the OLD server (which still answers /state with
      // pending:true while its own in-memory guard is set) could set
      // sawDown and trigger a reload before the NEW process answers.
      // The new process reports pending:false because its guard is reset.
      if (state.restarting && fast && snap && snap.webPid != null && state.sawDown && snap.pending === false) {
        state.diag.lastFetch = `ok ${new Date().toLocaleTimeString()} (reloading)`;
        try { location.reload(); } catch { /* headless */ }
        return;
      }
      state.snapshot = snap;
      state.error = null;
      state.diag.lastFetch = `ok ${new Date().toLocaleTimeString()}`;
      // If the server says a restart is no longer in flight, drop the banner
      // and slow the poll back to the regular cadence.
      if (state.restarting && snap && !snap.pending) {
        // The kill has finished and the engine cleared the guard; the next
        // snapshot with a live webPid triggers the reload in the branch above.
      }
      if (state.restarting && !snap?.pending && !fast) {
        startFastPoll();
      }
    } else {
      // During the restart window a failing fetch is expected - keep the
      // banner, do NOT show an error. A failing fetch IS proof the server
      // is down: remember it so the next successful fetch can reload.
      if (state.restarting) state.sawDown = true;
      if (!state.restarting) state.error = payload?.error ?? "unknown error";
      state.diag.lastFetch = `fail: ${payload?.error ?? "unknown"}`;
    }
    render();
  }

  try {
    startSlowPoll();
  } catch {
    /* setInterval is optional */
  }
  try {
    ctx?.onData?.(() => {
      if (state.busy) return;
      state.diag.lastAction = "data push";
      state.diag.lastAt = new Date().toLocaleTimeString();
      void load(true, false);
    });
  } catch {
    /* ctx is optional */
  }

  void load(false, false);

  return {
    destroy() {
      state.destroyed = true;
      if (state.timer) clearInterval(state.timer);
      try {
        root.remove();
      } catch {
        /* already detached */
      }
    },
  };
}

// Inject at import time, not only inside mount(): the manifest sets preload so
// this module is imported when the first browser attaches, while mount() runs
// only when the page actually opens. Never throws: a broken injection must not
// kill module load (the host would replace the plugin pane with an opaque
// fallback on the next mount attempt).
try {
  injectStyles();
} catch {
  /* headless / missing document - mount() retries */
}

export default {
  mount(container, ctx) {
    if (typeof document === "undefined" || !container) return () => {};

    let instance;
    try {
      // Same container mounted twice = a real remount: replace it.
      // A DIFFERENT container = an additional surface, left alone.
      const previous = instancesByContainer.get(container);
      if (previous) {
        try {
          previous.destroy();
        } catch {
          /* ignore */
        }
        instancesByContainer.delete(container);
      }
      injectStyles();
      instance = createInstance(container, ctx);
      instancesByContainer.set(container, instance);
    } catch (err) {
      // The host would otherwise replace the pane with an opaque fallback;
      // render the real reason here instead.
      try {
        const box = el("div", "rs-error", `restart-stack failed to mount: ${errorText(err)}`);
        container.appendChild(box);
      } catch {
        /* nothing left to do */
      }
      return () => {};
    }

    return () => {
      if (instancesByContainer.get(container) === instance) instancesByContainer.delete(container);
      try {
        instance.destroy();
      } catch {
        /* ignore */
      }
    };
  },
};
