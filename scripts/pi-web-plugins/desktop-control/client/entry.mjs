'use strict';
/**
 * desktop-control — pi-web-ui plugin (client entry) — v0.1.0
 *
 * Right-panel "Desktop Control" tab: daemon state (installed / enabled /
 * running / MCP-wired) + one toggle button. The flag written is
 * glitch-pi/data/config/desktop-control.json — the same file the launcher
 * reads, so the toggle survives stack restarts by construction.
 *
 * Zero imports (host serves plugin files only from /plugins/<id>/client/*).
 * Theme tokens reused from the host stylesheet (--border, --text, ...).
 *
 * Routes used:
 *   GET  /plugins-api/desktop-control/state
 *   POST /plugins-api/desktop-control/toggle {enabled}
 */
const API_BASE = '/plugins-api/desktop-control';
const POLL_MS = 10_000;
const STYLE_ID = 'desktop-control-style';
const ACTION_TOGGLE = 'desktop-control:toggle';
const instancesByContainer = new WeakMap();

// inlined SDK bridge helper (host only serves /plugins/<id>/client/*)
function onUiAction(action, handler) {
  try {
    const bridge = globalThis.window?.__piWebUiHost;
    if (bridge && typeof bridge.onUiAction === 'function') return bridge.onUiAction(action, handler);
  } catch { /* bridge not ready */ }
  return () => {};
}

// Header button state: poll /state and stamp data-dc-state on the button.
// The host re-renders topbar items on any ui update, so the stamp is
// reapplied every tick rather than assumed stable.
const BTN_SEL = 'button.plugin-topbar-item[data-tip^="Desktop control"]';
async function paintHeader() {
  try {
    const s = await fetch(API_BASE + '/state').then(r => r.json());
    const on = !!(s && s.ok && s.enabled);
    for (const b of document.querySelectorAll(BTN_SEL)) {
      b.setAttribute('data-dc-state', on ? 'on' : 'off');
    }
  } catch { /* next tick retries */ }
}

// Header toggle: bind once per page lifetime; click -> POST /toggle with the
// inverse of the last polled state. The header pill re-checks on next poll.
let headerBound = false;
function bindHeaderOnce() {
  if (headerBound) return;
  const bridge = globalThis.window?.__piWebUiHost;
  if (!bridge || typeof bridge.onUiAction !== 'function') return;
  headerBound = true;
  onUiAction(ACTION_TOGGLE, async () => {
    // Optimistic paint: flip the icon immediately so the click feels live,
    // then let the polls reconcile with the server's truth.
    try {
      const cur = await fetch(API_BASE + '/state').then(r => r.json());
      const turningOn = !(cur && cur.enabled);
      for (const b of document.querySelectorAll(BTN_SEL)) {
        b.setAttribute('data-dc-state', turningOn ? 'on' : 'off');
      }
      await fetch(API_BASE + '/toggle', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled: turningOn }),
      }).then(r => r.json());
    } catch { /* next poll reconciles */ }
    paintHeader();
  });
  paintHeader();
  setInterval(paintHeader, 5000);
}
try { bindHeaderOnce(); } catch {}
try { setInterval(() => { if (!headerBound) bindHeaderOnce(); }, 1500); } catch {}

const STYLE_CSS = `
.dc-wrap{font:13px/1.5 var(--sans,system-ui,sans-serif);color:var(--text);padding:12px;display:flex;flex-direction:column;gap:12px;height:100%;box-sizing:border-box}
/* Header button: icon-only, colored by plugin state.
   The host renders plugin topbar actions as button.plugin-topbar-item with
   data-tip = hint ?? label, so the stable "Desktop control" prefix targets only
   our button. Inside it the icon is ALSO a span (.plugin-icon-svg), so the hide
   rule keys on the class-less LABEL span only - a bare span selector collapsed
   the icon too and the button rendered as an empty pill. */
button.plugin-topbar-item[data-tip^="Desktop control"] span:not([class]){position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap}
button.plugin-topbar-item[data-tip^="Desktop control"][data-dc-state="on"]{color:var(--green);border-color:var(--green);background:color-mix(in srgb,var(--green) 12%,transparent)}
button.plugin-topbar-item[data-tip^="Desktop control"][data-dc-state="off"]{color:var(--text-faint)}
.dc-title{font-weight:600}
.dc-sub{color:var(--text-faint);font-size:11px}
.dc-card{border:1px solid var(--border-soft);border-radius:8px;background:var(--bg-elev2);padding:10px 12px;display:flex;flex-direction:column;gap:6px;font-family:var(--mono,monospace);font-size:11.5px;color:var(--text-dim)}
.dc-row{display:flex;gap:8px;align-items:baseline}
.dc-label{min-width:120px;color:var(--text-faint)}
.dc-state{display:inline-flex;align-items:center;gap:5px;font-size:11px;font-weight:600;letter-spacing:.3px;text-transform:uppercase;border:1px solid var(--border);border-radius:5px;padding:1px 6px;color:var(--text-dim)}
.dc-dot{width:7px;height:7px;border-radius:50%;background:currentColor}
.dc-on{color:var(--green);border-color:var(--green)}
.dc-off{color:var(--red,var(--text-faint));border-color:var(--red,var(--border))}
.dc-btn{height:28px;padding:0 10px;font-size:12px;border-radius:7px;border:1px solid var(--border);background:var(--bg-elev2);color:var(--text-dim);cursor:pointer}
.dc-btn:hover{color:var(--text);border-color:var(--accent)}
.dc-btn:disabled{opacity:.5;cursor:default}
.dc-msg{font-size:11px;color:var(--amber)}
`;

function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
}

function injectStyles() {
  const existing = document.getElementById(STYLE_ID);
  if (existing && existing.textContent === STYLE_CSS) return;
  existing?.remove();
  const s = document.createElement('style');
  s.id = STYLE_ID;
  s.textContent = STYLE_CSS;
  document.head.appendChild(s);
}

function statePill(label, on) {
  const pill = el('span', 'dc-state ' + (on ? 'dc-on' : 'dc-off'));
  pill.appendChild(el('span', 'dc-dot'));
  pill.appendChild(document.createTextNode(label));
  return pill;
}

function render(container, view) {
  container.textContent = '';
  const wrap = el('div', 'dc-wrap');
  wrap.appendChild(el('div', 'dc-title', 'Desktop Control'));
  wrap.appendChild(el('div', 'dc-sub', 'cua-driver daemon — screenshots, mouse, keyboard. Flag: data/config/desktop-control.json'));

  const card = el('div', 'dc-card');
  const s = view.state;
  if (!s) {
    card.appendChild(el('div', 'dc-row', view.error ? 'error: ' + view.error : 'loading…'));
  } else {
    const rows = [
      ['driver installed', s.installed ? 'yes' : 'no — run installer 4.8'],
      ['plugin enabled', s.enabled ? 'on' : 'off'],
      ['daemon', s.daemonRunning ? 'running' : 'stopped'],
      ['MCP wired', s.mcpWired ? 'yes' : 'no'],
    ];
    for (const [k, v] of rows) {
      const r = el('div', 'dc-row');
      r.appendChild(el('span', 'dc-label', k));
      r.appendChild(el('span', '', String(v)));
      card.appendChild(r);
    }
  }
  wrap.appendChild(card);

  const btnRow = el('div', 'dc-row');
  const toggle = el('button', 'dc-btn', view.busy ? 'working…' : (s && s.enabled ? 'Disable' : 'Enable'));
  toggle.disabled = !!view.busy || !s || !s.installed;
  toggle.onclick = async () => {
    view.busy = true; render(container, view);
    try {
      await fetch(API_BASE + '/toggle', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled: !(s && s.enabled) }),
      }).then(r => r.json());
    } catch { /* next poll reconciles */ }
    view.busy = false;
    await refresh(view);
    render(container, view);
  };
  btnRow.appendChild(toggle);
  if (s && s.installed) btnRow.appendChild(statePill(s.daemonRunning ? 'daemon running' : 'daemon stopped', s.daemonRunning));
  wrap.appendChild(btnRow);

  if (view.msg) wrap.appendChild(el('div', 'dc-msg', view.msg));
  container.appendChild(wrap);
}

async function refresh(view) {
  try {
    const r = await fetch(API_BASE + '/state').then(r => r.json());
    if (r.ok) { view.state = r; view.error = null; } else { view.error = r.error || 'state failed'; }
  } catch (err) { view.error = String(err); }
}

export default {
  mount(container /*, ctx */) {
    injectStyles();
    let view = instancesByContainer.get(container);
    if (view) { instancesByContainer.delete(container); try { view.dispose?.(); } catch {} }
    view = { state: null, error: null, busy: false, msg: null, timer: null };
    instancesByContainer.set(container, view);
    const tick = async () => { await refresh(view); render(container, view); };
    tick();
    view.timer = setInterval(tick, POLL_MS);
    view.dispose = () => { if (view.timer) clearInterval(view.timer); };
    return view.dispose;
  },
};
