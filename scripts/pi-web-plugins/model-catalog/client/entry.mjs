/**
 * model-catalog — pi-web-ui plugin (client entry) — SELF-CONTAINED, ZERO IMPORTS
 *
 * WHY ZERO IMPORTS: the host serves plugin files only from /plugins/<id>/client/*,
 * so a relative import (./sdk/*, ../index.mjs) would land on the SPA fallback
 * and kill the whole module. All data arrives as JSON from
 * /plugins-api/model-catalog/{status,sync,set,bulk,restore}.
 *
 * WHY THE DEFENSIVE SHAPE (learned from the agent-models reference): if mount()
 * throws the host replaces the pane with a bare fallback and the user sees a
 * permanent "loading" box. So this file:
 *   1. never throws out of mount (the body is wrapped; failures render in-panel)
 *   2. is per-container (a WeakMap keyed by the container element), so a second
 *      mount in the same container replaces the first; a different container
 *      lives alongside
 *   3. guards async work with a generation counter
 *   4. renders its own diagnostic line, so a future "nothing works" report carries
 *      data instead of needing a human to describe the screen
 *
 * TOKENS: only variables that exist in the shipped stylesheet are used
 * (--border, --border-soft, --text, --text-dim, --text-faint, --bg, --bg-elev,
 * --bg-elev2, --mono, --accent, --green, --red, --red-soft, --amber).
 */

const API_BASE = "/plugins-api/model-catalog";
const POLL_MS = 15_000;
const STYLE_ID = "model-catalog-style";
const MOUNT_LABEL = "nvidia-models";
/** Keep in sync with manifest.json version (shown in the diag line). */
const PLUGIN_VERSION = "0.2.2";

/** Per-container instance store. A module-level singleton was wrong: the host
 *  mounts the same module in more than one place (main view pane, Settings
 *  plugin page, right-panel slot tabs). A repeat mount in the SAME container
 *  is a real remount (epoch change) and replaces; a different container is
 *  an additional surface, left alone. */
const instancesByContainer = new WeakMap();

const TIERS = [
  { id: "A", label: "Recommended", defaultOpen: true },
  { id: "B", label: "Optional", defaultOpen: true },
  { id: "C", label: "Not relevant", defaultOpen: true },
  { id: "X", label: "Non-chat", defaultOpen: false },
];

/** Stylesheet compared by CONTENT, not by id-only "already injected?".
 *  The <style> element outlives a mount; an id-only check pinned the
 *  FIRST deploy's CSS for the life of the page. */
const STYLE_CSS = `
.nv-wrap{font:13px/1.5 var(--sans, system-ui, sans-serif);color:var(--text);padding:12px;display:flex;flex-direction:column;gap:10px;height:100%;box-sizing:border-box;min-height:0}
.nv-head{display:flex;align-items:baseline;gap:8px;flex-wrap:wrap}
.nv-title{font-weight:600}
.nv-sub{color:var(--text-faint);font-size:11px}
.nv-spacer{flex:1}
.nv-btn{height:26px;padding:0 9px;font-size:12px;border-radius:7px;border:1px solid var(--border);background:var(--bg-elev2);color:var(--text-dim);cursor:pointer}
.nv-btn:hover{border-color:var(--accent);color:var(--text)}
.nv-btn[aria-pressed="true"]{border-color:var(--accent);color:var(--text);background:var(--bg-elev)}
.nv-btn:disabled{opacity:.5;cursor:default}
.nv-btn.nv-primary{border-color:var(--accent);color:var(--text)}
.nv-bulk{display:flex;gap:6px;flex-wrap:wrap;align-items:center}
.nv-list{display:flex;flex-direction:column;gap:8px;overflow-y:auto;flex:1;min-height:0}
.nv-tier{border:1px solid var(--border-soft);border-radius:8px;background:var(--bg-elev2);display:flex;flex-direction:column;overflow:hidden;flex:none}
.nv-tier-head{display:flex;align-items:center;gap:8px;padding:8px 10px;cursor:pointer;background:0 0;border:none;color:var(--text);font:inherit;width:100%;text-align:left}
.nv-tier-head:hover{background:var(--bg-elev)}
.nv-tier-caret{color:var(--text-faint);margin-left:auto;font-size:10px;line-height:1;flex:none;transition:transform .15s}
.nv-tier.nv-open .nv-tier-caret{transform:rotate(180deg)}
.nv-tier-name{font-weight:600}
.nv-tier-count{color:var(--text-faint);font-size:11px;margin-left:6px}
.nv-rows{display:flex;flex-direction:column}
.nv-row{display:grid;grid-template-columns:64px 1fr auto;gap:8px;align-items:center;padding:8px 10px;border-top:1px solid var(--border-soft)}
.nv-row:first-child{border-top:none}
.nv-toggle-btn{display:inline-flex;align-items:center;justify-content:center;min-width:44px;height:22px;padding:0 10px;font-size:11.5px;font-weight:600;border-radius:6px;border:1px solid var(--border);background:var(--bg-elev2);color:var(--text-dim);cursor:pointer;user-select:none}
.nv-toggle-btn.nv-on{border-color:var(--green);color:var(--green)}
.nv-toggle-btn.nv-off{border-color:var(--red);color:var(--red)}
.nv-toggle-btn:hover{background:var(--bg-elev)}
.nv-name{font-family:var(--mono, monospace);font-size:11.5px;color:var(--text);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-width:0}
.nv-name .nv-meta{color:var(--text-faint);font-size:10.5px;margin-left:6px}
.nv-why{font-size:11px;color:var(--text-faint);grid-column:1 / -1;margin-top:-2px;padding-left:64px}
.nv-pills{display:flex;gap:4px;align-items:center;flex:none}
.nv-pill{font-size:10px;font-weight:700;letter-spacing:.4px;text-transform:uppercase;border:1px solid currentColor;border-radius:5px;padding:1px 5px;flex:none}
.nv-pill-A{color:var(--green)}
.nv-pill-B{color:var(--text-dim)}
.nv-pill-C{color:var(--amber)}
.nv-pill-X{color:var(--text-faint)}
.nv-pill-on{color:var(--green)}
.nv-pill-off{color:var(--text-faint)}
.nv-pill-r{color:var(--accent)}
.nv-pill-v{color:var(--amber)}
.nv-pill-pin{color:var(--amber)}
.nv-pill-picker{color:var(--text-faint)}
.nv-pill-fail{color:var(--red)}
.nv-notice{border:1px solid var(--amber);background:var(--bg-elev);border-radius:8px;padding:8px 10px;font-size:11.5px;color:var(--text);display:flex;flex-direction:column;gap:4px}
.nv-notice .nv-notice-title{font-weight:600;color:var(--amber)}
.nv-notice .nv-notice-dismiss{align-self:flex-end;height:20px;padding:0 7px;font-size:11px;border-radius:6px;border:1px solid var(--border);background:var(--bg-elev2);color:var(--text-dim);cursor:pointer}
.nv-diag{border-top:1px solid var(--border-soft);padding-top:6px;color:var(--text-faint);font-family:var(--mono, monospace);font-size:10px;word-break:break-all}
.nv-hint{font-size:11px;color:var(--text-faint);border:1px dashed var(--border);border-radius:7px;padding:6px 8px}
.nv-error{border:1px solid var(--red);background:var(--red-soft, transparent);border-radius:8px;padding:10px;font-size:12px;color:var(--text)}
.nv-blocked{border:1px solid var(--amber);background:var(--bg-elev);border-radius:8px;padding:8px 10px;font-size:11.5px;color:var(--text);display:flex;flex-direction:column;gap:4px}
.nv-blocked .nv-blocked-title{font-weight:600;color:var(--amber)}
.nv-blocked ul{margin:0;padding-left:18px}
.nv-empty{padding:14px;border:1px dashed var(--border);border-radius:8px;color:var(--text-dim);font-size:12px}
/* Chat-bar button. Same shape as agent-models: 25x25 desktop and narrow
   (the host renders .composer-tools .chip with 4px vertical padding and a
   13px font -> text box 15px, total 25px with the 1px borders).
   Glyph from the host icon set: a list, since this panel is a list. Masked
   SVG so theme + hover accent carry through. */
.inputbox .btn.composer-plugin-action[aria-label="NVIDIA Models"]{width:25px;min-width:25px;height:25px;box-sizing:border-box;flex:none;justify-content:center;align-items:center;gap:0;padding:0;border:1px solid var(--border);border-radius:8px;background:var(--chip-bg,var(--bg-elev2));color:var(--text);font-size:0;line-height:1;white-space:nowrap;user-select:none;-webkit-user-select:none}
.inputbox .btn.composer-plugin-action[aria-label="NVIDIA Models"]::before{content:"";display:block;width:15px;height:15px;flex:none;background-color:currentColor;-webkit-mask:url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='%23fff' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'%3E%3Crect x='3' y='3' width='7' height='7'/%3E%3Crect x='14' y='3' width='7' height='7'/%3E%3Crect x='3' y='14' width='7' height='7'/%3E%3Crect x='14' y='14' width='7' height='7'/%3E%3C/svg%3E") center/contain no-repeat;mask:url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='%23fff' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'%3E%3Crect x='3' y='3' width='7' height='7'/%3E%3Crect x='14' y='3' width='7' height='7'/%3E%3Crect x='3' y='14' width='7' height='7'/%3E%3Crect x='14' y='14' width='7' height='7'/%3E%3C/svg%3E") center/contain no-repeat}
.inputbox .btn.composer-plugin-action[aria-label="NVIDIA Models"]:hover{border-color:var(--accent);background:var(--accent-soft);color:var(--accent)}
@media (max-width:560px){.inputbox .btn.composer-plugin-action[aria-label="NVIDIA Models"]{width:30px;min-width:30px;height:30px}.inputbox .btn.composer-plugin-action[aria-label="NVIDIA Models"]::before{width:16px;height:16px}}
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

/** Fetch the report. Never throws: returns {ok:false, error} so the UI can say why. */
async function fetchStatus(force) {
  try {
    const res = await fetch(`${API_BASE}/status${force ? "?refresh=1" : ""}`);
    if (!res.ok) return { ok: false, error: `HTTP ${res.status}` };
    return await res.json();
  } catch (err) {
    return { ok: false, error: errorText(err) };
  }
}

async function postJson(path, body) {
  try {
    const res = await fetch(`${API_BASE}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const payload = await res.json().catch(() => null);
    if (!payload) return { ok: false, error: `HTTP ${res.status} (unparsable body)` };
    return payload;
  } catch (err) {
    return { ok: false, error: errorText(err) };
  }
}

/**
 * Build one panel instance. Everything up to the first `await` is synchronous, so
 * a mount failure surfaces in the caller's try/catch rather than as a blank pane.
 */
function createInstance(container, ctx) {
  const state = {
    payload: null,
    error: null,
    loading: true,
    busy: null, // "sync" | "bulk:recommended" | "bulk:all" | "bulk:none" | "restore"
    openTiers: new Set(),
    modelEnabledOverride: new Map(), // id -> boolean (optimistic, reconciled by /set response)
    notice: null, // sticky action result notice; survives polls, cleared by the next successful action
    noticeKind: "warn", // "warn" | "error"
    rowMarks: new Map(), // id -> reason; per-row failure marker pill, cleared on that row's next success
    lastRenderKey: "", // signature of the last full DOM rebuild; identical payloads skip rebuilding
    destroyed: false,
    generation: 0,
    timer: null,
    diag: {
      mounts: 1,
      lastAction: "mount",
      lastAt: new Date().toLocaleTimeString(),
      lastFetch: "pending",
      lastWrite: "none",
      modelCount: 0,
    },
  };
  // Default tier-open map: A/B/C open, X (non-chat) collapsed.
  for (const t of TIERS) {
    if (t.defaultOpen) state.openTiers.add(t.id);
  }

  const root = el("div", "nv-wrap");
  container.appendChild(root);

  const head = el("div", "nv-head");
  const title = el("div", "nv-title", "NVIDIA models");
  const sub = el("div", "nv-sub");
  const refresh = el("button", "nv-btn", "Resync");
  refresh.type = "button";
  refresh.title = "Re-read the NVIDIA catalog via the engine";
  refresh.addEventListener("click", () => {
    state.diag.lastAction = "sync";
    state.diag.lastAt = new Date().toLocaleTimeString();
    // v0.2.1: doBulk's sync branch compares the STRING "sync". Passing null
    // fell to the /bulk branch with action null -> the server answered 400
    // "unknown bulk action" and Resync never synced. Pass the action string.
    void doBulk("sync", "sync");
  });
  head.append(title, sub, el("div", "nv-spacer"), refresh);

  const bulkRow = el("div", "nv-bulk");
  const hint = el("div", "nv-hint", "Changes here take effect after the engine writes them. Pi may need a restart or a page reload before a model appears in the picker.");
  bulkRow.append(hint);

  const bulkButtons = [];
  for (const [label, action, primary] of [
    ["Apply recommended", "recommended", true],
    ["Enable all", "all", false],
    ["Disable all", "none", false],
    ["Restore backup", "restore", false],
  ]) {
    const btn = el("button", primary ? "nv-btn nv-primary" : "nv-btn", label);
    btn.type = "button";
    btn.title = action === "restore" ? "Restore the previous models.json from the engine's backup" : `${label} (${action})`;
    btn.addEventListener("click", () => {
      state.diag.lastAction = `bulk:${action}`;
      state.diag.lastAt = new Date().toLocaleTimeString();
      void doBulk(action, action);
    });
    bulkButtons.push({ btn, action });
    bulkRow.append(btn);
  }

  const list = el("div", "nv-list");
  // Fixed notice slot ABOVE the scrollable list. v0.1.1 rendered notices
  // inside .nv-list at its top — a user scrolled down to the rows never saw
  // the failure box, so a failed toggle looked like an unexplained revert.
  const noticeSlot = el("div");
  noticeSlot.style.display = "flex";
  noticeSlot.style.flexDirection = "column";
  noticeSlot.style.gap = "8px";
  noticeSlot.style.flex = "none";
  const diagLine = el("div", "nv-diag");
  root.append(head, bulkRow, noticeSlot, list, diagLine);

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
      ` | fetch ${d.lastFetch} | write ${d.lastWrite} | models ${d.modelCount}`;
  }

  /** Apply a bulk action or trigger /sync. */
  async function doBulk(action, label) {
    state.busy = label;
    state.diag.lastAction = `bulk:${action ?? "sync"}`;
    state.diag.lastAt = new Date().toLocaleTimeString();
    render();
    let payload;
    if (action === "restore") {
      payload = await postJson("/restore", {});
    } else if (action === "sync") {
      payload = await postJson("/sync", {});
    } else {
      payload = await postJson("/bulk", { action });
    }
    if (state.destroyed) return;
    state.busy = null;
    if (!payload || payload.ok === false) {
      state.error = payload?.error ?? "unknown error";
      state.notice = `Failed: ${state.error}. Nothing was written.`;
      state.noticeKind = "error";
      state.diag.lastWrite = `${label} FAILED`;
      render();
      return;
    }
    // Refresh the status payload from the route after a mutation.
    state.diag.lastWrite = `${label} @ ${new Date().toLocaleTimeString()}`;
    state.notice = null;
    state.rowMarks.clear();
    if (Array.isArray(payload.models)) {
      state.payload = payload;
      state.error = null;
      state.diag.modelCount = payload.counts?.chat ?? payload.models.length;
      render();
    } else {
      void load(true);
    }
  }

  /** Toggle one model on/off. Optimistic update; reconciled by the response. */
  async function toggle(id, next) {
    // Optimistic: snapshot the previous enabled state and flip it locally.
    const prevOverride = state.modelEnabledOverride.get(id);
    state.modelEnabledOverride.set(id, next);
    state.diag.lastAction = `set:${id}=${next}`;
    state.diag.lastAt = new Date().toLocaleTimeString();
    render();
    const payload = await postJson("/set", { id, enabled: next });
    if (state.destroyed) return;
    if (!payload || payload.ok === false) {
      // Revert the optimistic flip.
      if (prevOverride === undefined) state.modelEnabledOverride.delete(id);
      else state.modelEnabledOverride.set(id, prevOverride);
      state.error = payload?.error ?? "unknown error";
      state.notice = `Could not ${next ? "enable" : "disable"} ${id}: ${state.error}. The checkbox was restored to the engine's current state.`;
      state.noticeKind = "error";
      state.rowMarks.set(id, state.error);
      state.diag.lastWrite = `${id} FAILED`;
    } else {
      // Engine is source of truth: drop the override and refresh from the
      // fresh payload so counts and the blocked[] list reconcile together.
      state.modelEnabledOverride.delete(id);
      if (Array.isArray(payload.models)) {
        state.payload = payload;
      }
      state.error = null;
      // A pin-guard refusal comes back ok:true with blocked[] naming this
      // id. Keep it visible as a sticky notice (the payload's blocked box
      // is wiped by the next poll) so the flip-back is explained, not silent.
      const refused = (Array.isArray(payload.blocked) ? payload.blocked : []).find((b) => b && b.id === id);
      if (refused) {
        state.notice = `Refused for ${id}: ${refused.reason ?? "pin guard"}. The engine kept its current state.`;
        state.noticeKind = "warn";
        state.rowMarks.set(id, refused.reason ?? "pin guard refusal");
      } else {
        state.notice = null;
        state.rowMarks.delete(id);
      }
      state.diag.lastWrite = `${id} @ ${new Date().toLocaleTimeString()}`;
    }
    render();
  }

  function rowNode(model) {
    const id = model.id;
    const effectiveEnabled = state.modelEnabledOverride.has(id)
      ? state.modelEnabledOverride.get(id)
      : !!model.enabled;
    const row = el("div", "nv-row");
    row.setAttribute("data-nv-id", id);
    row.setAttribute("data-nv-tier", model.tier ?? "X");

    // Toggle button (v0.2.1). TWO defects fixed here:
    //   1. The old label+checkbox block declared `const toggle = el("label",...)`
    //      which SHADOWED the async function toggle(id, next). The change
    //      handler called the LABEL ELEMENT as a function -> TypeError -> no
    //      POST ever fired -> the poll's reconcile healed the checkbox back.
    //      Clicking a model did nothing, silently.
    //   2. Desktop control (cua-driver UIA) cannot reach a web checkbox:
    //      posted synthetic clicks on web content are dropped by Chromium, and
    //      UIA TogglePattern sets checked WITHOUT firing change (verified:
    //      the flip was healed back, no server write, no backup). A plain
    //      <button> (no aria-pressed) exposes UIA InvokePattern, which DOES
    //      reach web content in background mode — the Resync button's click
    //      fired its handler and POSTed (proven by the server's 400 notice).
    //      The button text carries the state; clicking toggles.
    // v0.2.2: nv-on/nv-off classes color the button green/red so the state is
    // readable at a glance, idle and hover alike (hover only brightens bg).
    const toggleBtn = el("button", `nv-toggle-btn ${effectiveEnabled ? "nv-on" : "nv-off"}`, effectiveEnabled ? "On" : "Off");
    toggleBtn.type = "button";
    toggleBtn.setAttribute("aria-label", `Enable ${id}`);
    toggleBtn.disabled = state.busy !== null;
    toggleBtn.addEventListener("click", () => {
      void toggle(id, !effectiveEnabled);
    });
    row.appendChild(toggleBtn);

    // Name + meta.
    const name = el("div", "nv-name", id);
    if (model.contextWindow) {
      name.appendChild(el("span", "nv-meta", `${model.contextWindow} ctx`));
    }
    if (model.category && model.category !== "chat") {
      name.appendChild(el("span", "nv-meta", model.category));
    }
    row.appendChild(name);

    // Pills (tier, pin, picker, reasoning, vision).
    const pills = el("div", "nv-pills");
    pills.appendChild(el("span", `nv-pill nv-pill-${model.tier ?? "X"}`, model.tier ?? "?"));
    if (model.pinned) {
      const pin = el("span", "nv-pill nv-pill-pin", "PIN");
      pin.title = "Pinned: the engine's pin guard refuses to disable this model";
      pills.appendChild(pin);
    }
    if (state.rowMarks.has(id)) {
      const fail = el("span", "nv-pill nv-pill-fail", "!");
      fail.title = `Last toggle failed: ${state.rowMarks.get(id)}`;
      pills.appendChild(fail);
    }
    if (model.in_store) {
      const picker = el("span", "nv-pill nv-pill-picker", "PICKER");
      picker.title = "pi lists built-in models in the picker even when disabled here; disable still removes it from models.json and the free pool";
      pills.appendChild(picker);
    }
    if (effectiveEnabled) pills.appendChild(el("span", "nv-pill nv-pill-on", "ON"));
    if (model.reasoning) pills.appendChild(el("span", "nv-pill nv-pill-r", "R"));
    if (model.vision === true || model.vision === "image") pills.appendChild(el("span", "nv-pill nv-pill-v", "V"));
    row.appendChild(pills);

    // Why line (full-width subrow).
    if (model.why) {
      row.appendChild(el("div", "nv-why", model.why));
    }
    row.title = model.why ? `${id}\n${model.why}` : id;
    return row;
  }

  function tierNode(tier, models) {
    const open = state.openTiers.has(tier.id);
    const wrap = el("div", open ? "nv-tier nv-open" : "nv-tier");
    const head = el("button", "nv-tier-head");
    head.type = "button";
    head.setAttribute("aria-expanded", String(open));
    head.appendChild(el("span", "nv-tier-name", tier.label));
    head.appendChild(el("span", "nv-tier-count", `${models.length}`));
    head.appendChild(el("span", "nv-tier-caret", "▾"));
    head.addEventListener("click", () => {
      if (open) state.openTiers.delete(tier.id);
      else state.openTiers.add(tier.id);
      render();
    });
    wrap.appendChild(head);
    if (open) {
      const rows = el("div", "nv-rows");
      for (const m of models) rows.appendChild(rowNode(m));
      wrap.appendChild(rows);
    }
    return wrap;
  }

  function noticeNode() {
    const wrap = el("div", "nv-notice");
    const title = el("div", "nv-notice-title", state.noticeKind === "error" ? "Action failed" : "Engine refused");
    wrap.appendChild(title);
    wrap.appendChild(el("div", undefined, state.notice));
    const dismiss = el("button", "nv-notice-dismiss", "dismiss");
    dismiss.type = "button";
    dismiss.addEventListener("click", () => {
      state.notice = null;
      render();
    });
    wrap.appendChild(dismiss);
    return wrap;
  }
  function blockedNode(blocked) {
    const wrap = el("div", "nv-blocked");
    wrap.appendChild(el("div", "nv-blocked-title", `Pin guard refused ${blocked.length} change${blocked.length === 1 ? "" : "s"}`));
    const ul = document.createElement("ul");
    for (const b of blocked) {
      const li = document.createElement("li");
      li.textContent = `${b.id}: ${b.reason ?? ""}`;
      ul.appendChild(li);
    }
    wrap.appendChild(ul);
    return wrap;
  }

  /**
   * Signature of everything the full DOM rebuild depends on. Identical
   * signatures mean the rebuild would paint the exact same tree, so the
   * poll path skips it entirely. v0.1.1 wiped and rebuilt list on every
   * 15s poll; a rebuild landing between mousedown and change destroyed
   * the checkbox mid-click, the change event never fired, no POST was
   * sent, and the next render painted the engine state again — a silent
   * revert with no server-side trace anywhere. With the key, unchanged
   * payloads cause zero DOM churn and clicks always land.
   */
  function renderKey() {
    const p = state.payload;
    const models = p && Array.isArray(p.models) ? p.models : [];
    return JSON.stringify([
      state.loading && !p ? 1 : 0,
      state.busy,
      state.error || "",
      state.notice || "",
      [...state.openTiers].sort(),
      p ? String(p.synced_at || "") : "no-payload",
      (p && Array.isArray(p.blocked) ? p.blocked : []).map((b) => `${b?.id}:${b?.reason ?? ""}`).join("|"),
      models
        .map((m) => `${m.id}|${m.tier ?? ""}|${m.enabled ? 1 : 0}|${m.pinned ? 1 : 0}|${state.modelEnabledOverride.has(m.id) ? (state.modelEnabledOverride.get(m.id) ? 1 : 2) : 0}`)
        .join(";"),
      models.length,
      [...state.rowMarks.entries()].map(([k, v]) => `${k}:${v}`).join("|"),
    ]);
  }

  /**
   * Heal checkbox states to the expected engine/override truth without
   * rebuilding any node. Runs in the render-skip path: the label and pills
   * are already correct there (state unchanged since the last rebuild), so
   * only the checkbox itself can have drifted (browser form restoration
   * on reload, applied after the render without a change event).
   */
  function reconcileChecks() {
    try {
      const rows = list.querySelectorAll("[data-nv-id]");
      for (const row of rows) {
        const id = row.getAttribute("data-nv-id");
        const model = state.payload && Array.isArray(state.payload.models)
          ? state.payload.models.find((m) => m && m.id === id)
          : null;
        if (!model) continue;
        const expected = state.modelEnabledOverride.has(id)
          ? state.modelEnabledOverride.get(id)
          : !!model.enabled;
        const box = row.querySelector("input[type=checkbox]");
        if (box && box.checked !== expected) box.checked = expected;
      }
    } catch {
      /* best effort — the next full rebuild corrects anyway */
    }
  }

  function render() {
    if (state.destroyed) return;
    try {
      // Fixed notice area first: always rendered fresh (cheap), always in view.
      noticeSlot.textContent = "";
      if (state.notice) noticeSlot.appendChild(noticeNode());
      const payloadForBlocked = state.payload;
      const blockedNow = payloadForBlocked && Array.isArray(payloadForBlocked.blocked) ? payloadForBlocked.blocked : [];
      if (blockedNow.length) noticeSlot.appendChild(blockedNode(blockedNow));

      const key = renderKey();
      if (key === state.lastRenderKey) {
        // Rebuild skipped (nothing changed in state), but the DOM may still
        // have drifted: browser form restoration on reload sets checkbox
        // state without firing change. Heal checkbox states in place —
        // programmatic assignment fires no change and rebuilds no nodes.
        reconcileChecks();
        renderDiag();
        return;
      }
      state.lastRenderKey = key;
      for (const { btn, action } of bulkButtons) {
        btn.disabled = state.busy !== null;
        if (state.busy === action) btn.setAttribute("aria-pressed", "true");
        else btn.setAttribute("aria-pressed", "false");
      }
      refresh.disabled = state.busy !== null;
      list.textContent = "";

      if (state.error && !state.payload) {
        const box = el("div", "nv-error", `Status unavailable: ${state.error}`);
        const note = el("div", "nv-sub");
        note.style.paddingTop = "6px";
        // F16: hint matches actual behavior — the 15s poll retries on its own,
        // and the Retry button here triggers an immediate attempt.
        note.textContent = `Auto-retries every ${Math.round(POLL_MS / 1000)}s. Click Retry for an immediate attempt.`;
        box.appendChild(document.createElement("br"));
        box.appendChild(note);
        const retry = el("button", "nv-btn", "Retry");
        retry.type = "button";
        retry.style.marginTop = "8px";
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

      if (state.loading && !state.payload) {
        sub.textContent = "loading...";
        renderDiag();
        return;
      }

      const payload = state.payload;
      if (!payload) {
        renderDiag();
        return;
      }

      const counts = payload.counts ?? {};
      const cli_present = !!payload.cli_present;
      const synced = payload.synced_at ? `synced ${payload.synced_at}` : "no sync yet";
      const cli_note = cli_present ? "" : " (engine missing on disk)";
      sub.textContent = `${counts.chat ?? "?"} chat | ${counts.enabled ?? "?"} enabled | ${counts.recommended ?? "?"} recommended | ${synced}${cli_note}`;
      sub.title = payload.engine_path ?? "";

      const models = Array.isArray(payload.models) ? payload.models : [];
      const groups = { A: [], B: [], C: [], X: [] };
      for (const m of models) {
        const t = m.tier ?? "X";
        (groups[t] ?? (groups[t] = [])).push(m);
      }
      if (!models.length) {
        list.appendChild(el("div", "nv-empty", cli_present ? "No models yet. Click Resync to fetch the live NVIDIA catalog." : "Engine not installed at scripts/nvidia-models.mjs. Install it then click Resync."));
        renderDiag();
        return;
      }
      for (const tier of TIERS) {
        const tierModels = groups[tier.id] ?? [];
        if (!tierModels.length) continue;
        list.appendChild(tierNode(tier, tierModels));
      }
      if (state.busy) {
        const busy = el("div", "nv-sub");
        busy.style.padding = "4px 0";
        busy.textContent = `working: ${state.busy}...`;
        list.appendChild(busy);
      }
      renderDiag();
    } catch (err) {
      list.textContent = "";
      list.appendChild(el("div", "nv-error", `Render failed: ${errorText(err)}`));
      renderDiag();
    }
  }

  async function load(force) {
    if (state.destroyed) return;
    const generation = ++state.generation;
    state.loading = true;
    render();
    const payload = await fetchStatus(force);
    if (state.destroyed || generation !== state.generation) return;
    state.loading = false;
    if (payload && payload.ok) {
      state.payload = payload;
      state.error = null;
      state.diag.modelCount = payload.counts?.chat ?? payload.models?.length ?? 0;
      state.diag.lastFetch = `ok ${new Date().toLocaleTimeString()}`;
    } else {
      // F16: do NOT keep showing the last good payload after a failure —
      // it is stale relative to the engine's current state. Clear it so the
      // panel renders the error branch and the auto-retry kicks in cleanly.
      const hadPayload = state.payload !== null;
      state.payload = null;
      state.error = payload?.error ?? "unknown error";
      state.diag.lastFetch = `fail: ${state.error}${hadPayload ? " (cleared stale)" : ""}`;
    }
    render();
  }

  try {
    state.timer = setInterval(() => {
      // Never yank the DOM out from under an in-flight mutation.
      if (state.busy) return;
      void load(false);
    }, POLL_MS);
  } catch {
    /* setInterval is optional in non-browser hosts */
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

// Inject at import time, not only inside mount(): the manifest sets
// "preload": true, so this module is imported when the first browser
// attaches, while mount() runs only when the page actually opens. Without
// this, the chat-bar button would be unstyled until the page had been
// opened once.
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
      try {
        const box = el("div", "nv-error", `nvidia-models failed to mount: ${errorText(err)}`);
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
