# tooltip-overflow-fix

Removes the phantom horizontal scrollbar at the bottom of the Pi web UI.

## Symptom

The page was a few pixels wider than the viewport. A bottom scrollbar let you
scroll right into empty space — nothing visibly there.

## Root cause

Topbar tooltips are `::after` boxes with `content: attr(data-tip)` that the
host stylesheet generates **permanently at `opacity: 0`** (transparent until
`:hover`). An invisible box still occupies layout.

Right-side chips (`.topbar .topbar-flow > .tb-spacer ~ [data-tip]`) get
**centered** tooltips (`left: 50%; transform: translate(-50%)`). A wide tip —
the background-tasks chip ("Servers the AI started in the background (npm
run …)", ~640 px) or the browser-bridge status chip with a long dynamic
message — centered on a chip near the right edge crosses the viewport edge
and inflates `documentElement.scrollWidth` by 7-13 px. Result: a horizontal
scrollbar whose overflow area contains only the invisible tooltip that caused
it.

Proven live (Playwright, `data/tmp/overflow-probe5.mjs`): disabling all pseudo
content dropped `scrollWidth` to exactly `clientWidth` (1613 -> 1600);
restoring it brought the overflow back.

## Fix (CSS only)

1. **Box only while hovered.** Idle: `content: none` (no box, no layout, no
   overflow). Hover: `content: attr(data-tip)` — every visual property still
   comes from the host stylesheet, so the 90 ms fade-in is unchanged.
2. **Right-anchor right-side tooltips** (`right: 0; transform: none` — they
   grow left, away from the viewport edge) instead of centering them across
   it, so a hovered tooltip can never re-trigger the scrollbar either.

Verified against the live stack (`data/tmp/overflow-probe6.mjs`): overflow
13 px -> 0 px at 1280/1440/1600, 7 px -> 0 px at 1920; tooltips still render
on hover, right-anchored, 0 px overflow while hovered.

## Why a web-plugin

The host stylesheet lives in the built bundle
(`data/node/node_modules/pi-web-ui/web/dist/assets/index-*.css`), which every
`npm install pi-web-ui` overwrites. This plugin injects the override CSS from
`client/entry.mjs` on every page boot (`view: false, preload: true`), so the
fix survives package upgrades with no patch scripts to re-run. Selectors
mirror the upstream rules 1:1; the sheet loads after the host stylesheet, so
cascade order wins without specificity fights.

If upstream ever ships its own fix, disable this plugin in Settings ->
Extensions (no harm in leaving it on either — its rules then simply match
upstream behavior).

## Files

- `manifest.json` — `view: false`, `preload: true` (client bundle stays
  resident; no topbar button, no panel)
- `client/entry.mjs` — injects the override `<style>` once per page load
