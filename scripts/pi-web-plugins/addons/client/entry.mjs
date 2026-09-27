/**
 * addons — pi-web-ui plugin (client entry) — v0.1.0
 *
 * Right-panel "Add-ons" tab. Renders one row per registered add-on with a state
 * indicator, Start/Stop, auto-start checkbox, and (when applicable) a deep link
 * to the add-on's own web UI.
 *
 * PATTERN SOURCES (read both before changing this file):
 *   - .pi/web-plugins/agent-switcher/client/entry.mjs — bridge + once-only
 *     registration discipline (inlined onUiAction stub, retry poll, never throw).
 *   - .pi/web-plugins/agent-models/client/entry.mjs    — tab/view rendering
 *     (mount(container, ctx), per-container WeakMap so a re-mount in the SAME
 *     container replaces the prior instance, fetch -> render cycle, el(tag,cls,text)
 *     helper, diag line at the bottom, stylesheet compared by content).
 *
 * WHY ZERO IMPORTS: the host serves plugin files only from /plugins/<id>/client/*,
 * so a relative import (../sdk/index.mjs, ./resolver.mjs) would land on the SPA
 * fallback and break the module. Same constraint as agent-switcher / agent-models.
 *
 * DATA: server entry (scripts/pi-web-plugins/addons/index.mjs) proxies to
 * scripts/addon-control.mjs, which now exposes a richer `state` field:
 *   - up        : pid alive AND every port listening
 *   - starting  : pid alive AND not all ports listening AND within bootGraceMs
 *   - down      : otherwise
 * `up` is preserved exactly as it was before so the Background-task panel still
 * reads it the same way; `state` is additive.
 *
 * ACTIONS go through the same /plugins-api/addons/* routes the slash command uses:
 *   GET    /plugins-api/addons/state   -> { addons: [...] }
 *   POST   /plugins-api/addons/start   { id }
 *   POST   /plugins-api/addons/stop    { id }
 *   POST   /plugins-api/addons/autostart { id, on: boolean }
 *
 * THEME TOKENS reused from the host stylesheet (same set agent-models uses):
 * --border, --border-soft, --text, --text-dim, --text-faint, --bg, --bg-elev,
 * --bg-elev2, --accent, --accent-soft, --green, --amber, --red, --mono, --sans.
 */

const API_BASE = "/plugins-api/addons";
const POLL_MS = 10_000;
const STYLE_ID = "addons-style";
const MOUNT_LABEL = "addons";
const PLUGIN_VERSION = "0.1.0";

/**
 * Per-container instances — direct lift from agent-models.
 *
 * A module-level singleton was the wrong shape there (a second mount in a
 * DIFFERENT container tore the first one down). Here the right-panel slot is the
 * primary surface, but the host may also surface this plugin in a hidden pane
 * during preload — same trade-off, same fix.
 */
const instancesByContainer = new WeakMap();

/**
 * Deep links to each add-on's own web UI. Kept client-side on purpose: the
 * server entry stays a thin proxy and we don't have to teach addon-control.mjs
 * a new field just to render a hyperlink.
 *
 * `webUi` is intentionally a flat object, NOT a per-add-on property fetched
 * from the server — the list of which add-ons have a UI is a property of THIS
 * plugin, not of the lifecycle owner.
 */
const WEB_UI = {
  money: { url: "http://localhost:4110", label: "Open Money Dashboard" },
  trader: { url: "http://localhost:3000", label: "Open Glitch Trader web" },
  "browser-use": { url: "http://localhost:4105", label: "Open Browser Use UI" },
};

const STATE_COLOR = {
  up: "var(--green)",
  starting: "var(--amber)",
  down: "var(--red, var(--text-faint))",
};

const STATE_LABEL = {
  up: "up",
  starting: "starting",
  down: "down",
};

/**
 * The stylesheet is a module constant so injectStyles() compares it by CONTENT.
 *
 * Why a content check, not id-only? A plain `id` flag keeps the FIRST deploy's
 * CSS for the lifetime of the page; every later tweak was silently ignored. That
 * is exactly the failure agent-models hit when padding rules went stale across
 * reloads. Same fix here.
 */
const STYLE_CSS = `
.aox-wrap{font:13px/1.5 var(--sans, system-ui, sans-serif);color:var(--text);padding:12px;display:flex;flex-direction:column;gap:10px;height:100%;box-sizing:border-box;min-height:0}
.aox-head{display:flex;align-items:baseline;gap:8px;flex-wrap:wrap}
.aox-title{font-weight:600}
.aox-sub{color:var(--text-faint);font-size:11px}
.aox-spacer{flex:1}
.aox-btn{height:26px;padding:0 9px;font-size:12px;border-radius:7px;border:1px solid var(--border);background:var(--bg-elev2);color:var(--text-dim);cursor:pointer;font-family:inherit;line-height:1.4}
.aox-btn:hover{border-color:var(--accent);color:var(--text)}
.aox-btn:disabled{opacity:.5;cursor:default}
.aox-btn.aox-primary{border-color:var(--accent);color:var(--text);background:var(--bg-elev2)}
.aox-btn.aox-danger{border-color:var(--red);color:var(--red)}
.aox-btn.aox-danger:hover{background:var(--bg-elev)}
.aox-list{display:flex;flex-direction:column;gap:6px;overflow-y:auto;flex:1;min-height:0}
.aox-row{border:1px solid var(--border-soft);border-radius:8px;background:var(--bg-elev2);padding:10px 12px;display:flex;flex-direction:column;gap:6px;flex:none}
.aox-row-top{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.aox-name{font-weight:600;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.aox-state{display:inline-flex;align-items:center;gap:5px;font-size:11px;font-weight:600;letter-spacing:.3px;text-transform:uppercase;color:var(--text-dim);border:1px solid var(--border);border-radius:5px;padding:1px 6px;flex:none}
.aox-state-dot{width:7px;height:7px;border-radius:50%;background:currentColor;flex:none}
.aox-ports{font-family:var(--mono, monospace);font-size:11px;color:var(--text-faint);display:flex;gap:6px;align-items:baseline;flex-wrap:wrap}
.aox-port{border:1px solid var(--border-soft);border-radius:4px;padding:0 5px}
.aox-port.aox-port-up{color:var(--green);border-color:var(--green)}
.aox-pid{font-family:var(--mono, monospace);font-size:10.5px;color:var(--text-faint)}
.aox-actions{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.aox-auto{display:inline-flex;align-items:center;gap:6px;font-size:11px;color:var(--text-dim);cursor:pointer;user-select:none;-webkit-user-select:none}
.aox-auto input{margin:0;accent-color:var(--accent)}
.aox-link{font-size:11px;color:var(--accent);text-decoration:none;border:1px solid var(--border);border-radius:6px;padding:2px 8px;display:inline-flex;align-items:center;gap:4px}
.aox-link:hover{background:var(--accent-soft);border-color:var(--accent)}
.aox-note{font-size:11px;color:var(--text-faint)}
.aox-note.aox-warn{color:var(--amber)}
.aox-empty{padding:14px;border:1px dashed var(--border);border-radius:8px;color:var(--text-dim);font-size:12px}
.aox-error{border:1px solid var(--red);background:transparent;border-radius:8px;padding:10px;font-size:12px;color:var(--text);display:flex;flex-direction:column;gap:6px}
.aox-diag{border-top:1px solid var(--border-soft);padding-top:6px;color:var(--text-faint);font-family:var(--mono, monospace);font-size:10px;word-break:break-all}
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

/** GET /plugins-api/addons/state. Never throws: returns {ok, addons?, error?} */
async function fetchState() {
  try {
    const res = await fetch(`${API_BASE}/state`);
    if (!res.ok) return { ok: false, error: `HTTP ${res.status}` };
    const payload = await res.json();
    if (!payload || !Array.isArray(payload.addons)) return { ok: false, error: "state.addons missing" };
    return { ok: true, addons: payload.addons };
  } catch (err) {
    return { ok: false, error: errorText(err) };
  }
}

async function postAction(path, body) {
  try {
    const res = await fetch(`${API_BASE}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body ?? {}),
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
 * We don't actually need any host-driven action today — every interaction here
 * is a direct fetch — but wiring the registration discipline keeps the file
 * consistent with the other clients and gives us a safe place to hang future
 * host-driven hooks (e.g. a "stop all" composer button).
 */
function registerOnce(scope) {
  if (globalThis.__addonsBound) return;
  if (typeof window === "undefined") return;
  const bridge = window.__piWebUiHost;
  if (!bridge || typeof bridge.onUiAction !== "function") return;
  globalThis.__addonsBound = true;
  const diag = (globalThis.__addonsClient = globalThis.__addonsClient ?? {
    registered: [],
    errors: [],
    version: PLUGIN_VERSION,
    importedAt: new Date().toISOString(),
  });
  try {
    // No-op action for now; left registered so the host has a known hook surface.
    bridge.onUiAction("addons:noop", () => {});
    diag.registered.push(`addons:noop (once@${scope})`);
  } catch (err) {
    diag.errors.push(`addons:noop: ${errorText(err)}`);
  }
}

registerOnce("import");
if (typeof window !== "undefined") {
  let tries = 0;
  const retry = () => {
    if (globalThis.__addonsBound) return;
    const bridge = window.__piWebUiHost;
    if (bridge && typeof bridge.onUiAction === "function") registerOnce("poll");
    else if (tries++ < 100) setTimeout(retry, 300);
  };
  retry();
}

function stateNode(row) {
  const state = STATE_LABEL[row.state] ?? "down";
  const wrap = el("span", "aox-state", state);
  wrap.style.color = STATE_COLOR[row.state] ?? STATE_COLOR.down;
  const dot = el("span", "aox-state-dot");
  wrap.appendChild(dot);
  return wrap;
}

function portsNode(row) {
  const wrap = el("div", "aox-ports");
  const ports = Array.isArray(row.ports) ? row.ports : [];
  if (!ports.length) {
    wrap.appendChild(el("span", "aox-note", "no ports"));
    return wrap;
  }
  for (const p of ports) {
    const port = el("span", `aox-port${p.listening ? " aox-port-up" : ""}`, String(p.port));
    port.title = p.listening ? `${p.port} listening` : `${p.port} not listening`;
    wrap.appendChild(port);
  }
  return wrap;
}

function rowNode(row, state, actions) {
  const r = el("div", "aox-row");
  r.setAttribute("data-aox-id", row.id);

  const top = el("div", "aox-row-top");
  top.appendChild(el("div", "aox-name", row.label || row.id));
  top.appendChild(stateNode(row));
  if (row.pid != null) {
    const pid = el("div", "aox-pid", `pid ${row.pid}`);
    pid.title = row.logPath || "";
    top.appendChild(pid);
  }
  r.appendChild(top);

  r.appendChild(portsNode(row));

  const actionRow = el("div", "aox-actions");
  // Start/Stop — exactly one, whichever applies to the current state.
  // "starting" gets a "Stop" button too so Troy can cancel a stuck boot.
  if (row.state === "up") {
    const stop = el("button", "aox-btn aox-danger", "Stop");
    stop.type = "button";
    stop.title = `Stop ${row.label}`;
    stop.disabled = actions.busy === row.id;
    stop.addEventListener("click", async () => {
      actions.busy = row.id;
      state.diag.lastAction = `stop:${row.id}`;
      state.diag.lastAt = new Date().toLocaleTimeString();
      await actions.runAction(row.id, "stop", () => postAction("/stop", { id: row.id }));
    });
    actionRow.appendChild(stop);
  } else {
    const start = el("button", "aox-btn aox-primary", row.state === "starting" ? "Starting..." : "Start");
    start.type = "button";
    start.title = `Start ${row.label}`;
    start.disabled = actions.busy === row.id || row.state === "starting";
    start.addEventListener("click", async () => {
      actions.busy = row.id;
      state.diag.lastAction = `start:${row.id}`;
      state.diag.lastAt = new Date().toLocaleTimeString();
      await actions.runAction(row.id, "start", () => postAction("/start", { id: row.id }));
    });
    actionRow.appendChild(start);
  }

  // Auto-start checkbox.
  const autoLabel = el("label", "aox-auto");
  const autoBox = document.createElement("input");
  autoBox.type = "checkbox";
  autoBox.checked = !!row.autostart;
  autoBox.disabled = actions.busy === row.id;
  autoBox.addEventListener("change", async () => {
    actions.busy = row.id;
    const wanted = autoBox.checked;
    state.diag.lastAction = `autostart:${row.id}:${wanted ? "on" : "off"}`;
    state.diag.lastAt = new Date().toLocaleTimeString();
    await actions.runAction(row.id, "autostart", () => postAction("/autostart", { id: row.id, on: wanted }));
    // Re-read so we reflect the server's verdict (it always wins).
    autoBox.checked = wanted;
  });
  autoLabel.appendChild(autoBox);
  autoLabel.appendChild(document.createTextNode("auto-start"));
  actionRow.appendChild(autoLabel);

  // Web-UI link — only when one is registered for this add-on.
  const link = WEB_UI[row.id];
  if (link) {
    const a = el("a", "aox-link", link.label);
    a.href = link.url;
    a.target = "_blank";
    a.rel = "noopener noreferrer";
    a.title = link.url;
    actionRow.appendChild(a);
  }

  r.appendChild(actionRow);

  // Per-row note: last action's outcome (success or error).
  if (state.rowNote?.id === row.id) {
    const note = el("div", state.rowNote.kind === "error" ? "aox-note aox-warn" : "aox-note", state.rowNote.text);
    r.appendChild(note);
  }

  return r;
}

/**
 * Build one panel instance. Lifted verbatim from agent-models' createInstance
 * shape (state record + generation guard + WeakMap-driven re-mount).
 */
function createInstance(container, ctx) {
  const state = {
    addons: [],
    error: null,
    loading: true,
    destroyed: false,
    generation: 0,
    timer: null,
    busy: null,
    rowNote: null,
    diag: {
      mounts: 1,
      lastAction: "mount",
      lastAt: new Date().toLocaleTimeString(),
      lastFetch: "pending",
      lastWrite: "none",
      addonCount: 0,
    },
  };

  const actions = {
    get busy() { return state.busy; },
    set busy(v) { state.busy = v; },
    runAction: async (id, kind, doCall) => {
      // Optimistic: blank the note, render, fire, then re-render with the result.
      state.rowNote = null;
      render();
      const payload = await doCall();
      if (state.destroyed) return;
      state.busy = null;
      if (payload?.ok) {
        state.rowNote = { id, kind: "ok", text: `${kind}: ok` };
        state.diag.lastWrite = `${id} ${kind} @ ${new Date().toLocaleTimeString()}`;
      } else {
        state.rowNote = { id, kind: "error", text: `${kind} failed: ${payload?.error ?? "unknown error"}` };
        state.diag.lastWrite = `${id} ${kind} FAILED`;
      }
      // Re-fetch so the new authoritative state wins over the optimistic render.
      await load();
    },
  };

  const root = el("div", "aox-wrap");
  container.appendChild(root);

  const head = el("div", "aox-head");
  const title = el("div", "aox-title", "Add-ons");
  const sub = el("div", "aox-sub");
  const refresh = el("button", "aox-btn", "Refresh");
  refresh.type = "button";
  refresh.title = "Re-poll the lifecycle owner (start/stop a row directly from this panel)";
  refresh.addEventListener("click", () => {
    state.diag.lastAction = "refresh";
    state.diag.lastAt = new Date().toLocaleTimeString();
    void load(true);
  });
  head.append(title, sub, el("div", "aox-spacer"), refresh);

  const list = el("div", "aox-list");
  const diagLine = el("div", "aox-diag");
  root.append(head, list, diagLine);

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
      ` | fetch ${d.lastFetch} | write ${d.lastWrite} | addons ${d.addonCount}`;
  }

  function render() {
    if (state.destroyed) return;
    try {
      list.textContent = "";

      if (state.error && !state.addons.length) {
        const box = el("div", "aox-error");
        box.appendChild(el("div", undefined, `State unavailable: ${state.error}`));
        const retry = el("button", "aox-btn", "Retry");
        retry.type = "button";
        retry.addEventListener("click", () => {
          state.diag.lastAction = "retry";
          state.diag.lastAt = new Date().toLocaleTimeString();
          void load(true);
        });
        box.appendChild(retry);
        list.appendChild(box);
        sub.textContent = "";
        renderDiag();
        return;
      }

      if (state.loading && !state.addons.length) {
        sub.textContent = "loading...";
        renderDiag();
        return;
      }

      const addons = state.addons;
      const counts = { up: 0, starting: 0, down: 0 };
      for (const a of addons) {
        if (counts[a.state] != null) counts[a.state] += 1;
      }
      sub.textContent = `${addons.length} add-ons | ${counts.up} up | ${counts.starting} starting | ${counts.down} down`;

      if (!addons.length) {
        list.appendChild(el("div", "aox-empty", "No add-ons registered."));
        renderDiag();
        return;
      }

      for (const row of addons) list.appendChild(rowNode(row, state, actions));
      if (state.error) {
        // Error after a successful first load: keep showing the cached rows
        // but add a non-blocking banner so Troy knows the next refresh failed.
        const box = el("div", "aox-error");
        box.appendChild(el("div", undefined, `Last refresh failed: ${state.error}`));
        const retry = el("button", "aox-btn", "Retry");
        retry.type = "button";
        retry.addEventListener("click", () => {
          state.diag.lastAction = "retry";
          state.diag.lastAt = new Date().toLocaleTimeString();
          void load(true);
        });
        box.appendChild(retry);
        list.appendChild(box);
      }
      renderDiag();
    } catch (err) {
      // Never let a render error produce a blank pane.
      list.textContent = "";
      list.appendChild(el("div", "aox-error", `Render failed: ${errorText(err)}`));
      renderDiag();
    }
  }

  async function load(force) {
    if (state.destroyed) return;
    const generation = ++state.generation;
    state.loading = true;
    if (force) render();
    const payload = await fetchState();
    if (state.destroyed || generation !== state.generation) return;
    state.loading = false;
    if (payload?.ok) {
      state.addons = payload.addons;
      state.error = null;
      state.diag.addonCount = payload.addons.length;
      state.diag.lastFetch = `ok ${new Date().toLocaleTimeString()}`;
    } else {
      state.error = payload?.error ?? "unknown error";
      state.diag.lastFetch = `fail: ${state.error}`;
    }
    render();
  }

  try {
    state.timer = setInterval(() => {
      if (state.busy) return; // never poll while a start/stop is in flight
      void load(false);
    }, POLL_MS);
  } catch {
    /* setInterval is optional */
  }
  try {
    ctx?.onData?.(() => {
      if (state.busy) return;
      state.diag.lastAction = "data push";
      state.diag.lastAt = new Date().toLocaleTimeString();
      void load(true);
    });
  } catch {
    /* ctx is optional */
  }

  void load(false);

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
  /* headless / missing document — mount() retries */
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
        const box = el("div", "aox-error", `addons failed to mount: ${errorText(err)}`);
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
