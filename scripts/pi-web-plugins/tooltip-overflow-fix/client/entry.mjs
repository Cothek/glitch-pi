'use strict';
/**
 * tooltip-overflow-fix — pi-web-ui web plugin (client preload, view:false) — v1.0.0
 *
 * WHY THIS EXISTS
 * Upstream topbar tooltips are ::after boxes with content:attr(data-tip) that
 * are generated PERMANENTLY at opacity:0 ("content is always in the box, the
 * box is just transparent until :hover"). An invisible box still occupies
 * layout. Right-side chips (.topbar .topbar-flow > .tb-spacer ~ [data-tip])
 * get CENTERED tooltips (left:50%; transform:translate(-50%)); a wide tip —
 * e.g. the background-tasks chip ("Servers the AI started in the background
 * (npm run …)", ~640px) or the browser-bridge status chip with a long dynamic
 * message — centered on a chip near the right edge crosses the viewport's
 * right edge. That inflated documentElement.scrollWidth by 7-13px (observed
 * at 1280-1920px viewports) and produced a horizontal scrollbar whose
 * overflow area is EMPTY: the tooltip that caused it is invisible.
 *
 * THE FIX (CSS only; this sheet loads after the host stylesheet, and every
 * selector below mirrors the upstream rule it overrides 1:1, so cascade order
 * decides and upstream specificity is never fought):
 *   1. Generate the tooltip box only while hovered:
 *      idle  -> content:none   (no box, no layout, no phantom overflow)
 *      hover -> content:attr(data-tip)  (all visual props still come from
 *      the host stylesheet's base rule; opacity:1 comes from its hover rule,
 *      so the 90ms fade-in is unchanged)
 *   2. Right-anchor right-side tooltips (right:0; transform:none — they grow
 *      LEFT, away from the viewport edge) instead of centering them across
 *      it, so even a hovered tooltip can never re-trigger the scrollbar.
 *
 * VERIFIED against the live stack (Playwright, data/tmp/overflow-probe6.mjs):
 * overflow 13px->0px at 1280/1440/1600, 7px->0px at 1920; tooltips still
 * render on hover, right-anchored, 0px overflow while hovered.
 *
 * Zero imports (the host only serves plugin files from
 * /plugins/<id>/client/*). Runs as a preload plugin: the host imports this
 * module on every page boot; top-level code injects the style once.
 */

const STYLE_ID = 'tooltip-overflow-fix-style';

const CSS = `
/* == tooltip-overflow-fix ================================================
   Upstream: tooltips are always-on opacity:0 ::after boxes. Invisible boxes
   still take layout, and centered right-side tooltips crossed the right
   viewport edge -> phantom horizontal scrollbar over empty space.
   Fix: box only while hovered; right-side tips right-anchored (grow left). */

/* idle: no box at all */
.chip[data-tip]:after,
.topbar .tb-tab[data-tip]:after,
.topbar .panel-toggle[data-tip]:after,
.topbar .plugin-topbar-item[data-tip]:after,
.fp-attach:after,
.file-attach:after {
  content: none;
}

/* hovered: the box returns (background/padding/etc. come from the host
   stylesheet's base rule; opacity:1 from its hover rule) */
.chip[data-tip]:hover:after,
.topbar .tb-tab[data-tip]:hover:after,
.topbar .panel-toggle[data-tip]:hover:after,
.topbar .plugin-topbar-item[data-tip]:hover:after,
.fp-attach:hover:after,
.file-attach:hover:after {
  content: attr(data-tip);
}

/* right-side chips (everything after the topbar spacer): right-anchor
   instead of centering across the viewport's right edge */
.topbar .topbar-flow > .tb-spacer ~ [data-tip]:after,
.topbar .topbar-flow > .tb-spacer ~ .dropdown > [data-tip]:after,
.topbar .topbar-flow > .tb-spacer ~ .bc-anchor [data-tip]:after {
  left: auto;
  right: 0;
  transform: none;
}
/* == end tooltip-overflow-fix ========================================== */
`;

if (typeof document !== 'undefined' && !document.getElementById(STYLE_ID)) {
  const style = document.createElement('style');
  style.id = STYLE_ID;
  style.textContent = CSS;
  (document.head || document.documentElement).appendChild(style);
}
